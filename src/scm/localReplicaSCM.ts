import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ProjectFileTreeDiffResponseSchema } from '../api/base';
import { error as logError, log, notifyError, warn } from '../utils/outputChannel';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const SYNC_STATE_SCHEMA_VERSION = 1;
const SYNC_STATE_PATH = '.overleaf/sync-state.json';

type FileCache = {date:number, hash:number};

interface LocalReplicaSyncState {
    schemaVersion: number,
    projectUri: string,
    remoteVersion: number,
    files: {[path:string]: string},
}

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content===undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private syncState?: LocalReplicaSyncState;
    private syncStateWriteTimer?: NodeJS.Timeout;
    private syncStateWritePromise: Promise<void> = Promise.resolve();
    private syncStateBatchDepth = 0;
    private lastPersistedSyncState?: string;
    private ignoredLocalSymbolicLinks = new Set<string>();
    private syncQueue: Promise<void> = Promise.resolve();
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse( new TextDecoder().decode(content) );
        } catch (error) {
            return undefined;
        }
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private normalizeRelPath(path: string): string {
        const normalized = path.replace(/\\/g, '/');
        return normalized.startsWith('/') ? normalized : `/${normalized}`;
    }

    private async statOrUndefined(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
        try {
            return await vscode.workspace.fs.stat(uri);
        } catch {
            return undefined;
        }
    }

    private async findLocalSymbolicLink(uri: vscode.Uri): Promise<string | undefined> {
        const basePath = this.baseUri.path.replace(/\/$/, '');
        if (uri.scheme!==this.baseUri.scheme || uri.authority!==this.baseUri.authority ||
            (uri.path!==basePath && !uri.path.startsWith(`${basePath}/`))) {
            return undefined;
        }

        let currentUri = this.baseUri;
        let currentPath = '';
        const parts = uri.path.slice(basePath.length).split('/').filter(Boolean);
        for (const part of parts) {
            currentUri = vscode.Uri.joinPath(currentUri, part);
            currentPath = `${currentPath}/${part}`;
            const stat = await this.statOrUndefined(currentUri);
            if (stat!==undefined && (stat.type & vscode.FileType.SymbolicLink)!==0) {
                return currentPath;
            }
        }
        return undefined;
    }

    private async ignoreLocalSymbolicLink(uri: vscode.Uri, deleted: boolean = false): Promise<boolean> {
        const relPath = this.normalizeRelPath(uri.path.slice(this.baseUri.path.replace(/\/$/, '').length));
        const symbolicLink = await this.findLocalSymbolicLink(uri);
        if (symbolicLink!==undefined) {
            if (!this.ignoredLocalSymbolicLinks.has(symbolicLink)) {
                warn(`Ignoring local symbolic link "${symbolicLink}"; it will not be synchronized with Overleaf.`);
            }
            this.ignoredLocalSymbolicLinks.add(symbolicLink);
            return true;
        }

        if (deleted) {
            const rememberedLink = [...this.ignoredLocalSymbolicLinks]
                .find(path => relPath===path || relPath.startsWith(`${path}/`));
            if (rememberedLink!==undefined) {
                if (relPath===rememberedLink) {
                    this.ignoredLocalSymbolicLinks.delete(rememberedLink);
                }
                return true;
            }
        } else {
            // A regular file may intentionally replace an earlier link.
            this.ignoredLocalSymbolicLinks.delete(relPath);
        }
        return false;
    }

    private async loadSyncState(): Promise<LocalReplicaSyncState | undefined> {
        const stateUri = vscode.Uri.joinPath(this.baseUri, SYNC_STATE_PATH);
        try {
            const content = await vscode.workspace.fs.readFile(stateUri);
            const state = JSON.parse(new TextDecoder().decode(content)) as LocalReplicaSyncState;
            if (state.schemaVersion!==SYNC_STATE_SCHEMA_VERSION ||
                state.projectUri!==this.vfs.origin.toString() ||
                !Number.isInteger(state.remoteVersion) ||
                typeof state.files!=='object' || state.files===null) {
                return undefined;
            }
            this.lastPersistedSyncState = JSON.stringify(state, null, 2);
            return state;
        } catch {
            return undefined;
        }
    }

    private persistSyncState(): Promise<void> {
        if (this.syncState===undefined) { return Promise.resolve(); }
        const stateUri = vscode.Uri.joinPath(this.baseUri, SYNC_STATE_PATH);
        const serializedState = JSON.stringify(this.syncState, null, 2);
        const content = new TextEncoder().encode(serializedState);
        this.syncStateWritePromise = this.syncStateWritePromise
            .catch(() => {})
            .then(async () => {
                if (serializedState===this.lastPersistedSyncState) { return; }
                // This is a disposable cache, not user content. Writing in place
                // avoids delete/create events from the temporary-file rename.
                await vscode.workspace.fs.writeFile(stateUri, content);
                this.lastPersistedSyncState = serializedState;
            });
        return this.syncStateWritePromise;
    }

    private scheduleSyncStateWrite() {
        if (this.syncStateBatchDepth>0) {
            return;
        }
        if (this.syncStateWriteTimer!==undefined) {
            clearTimeout(this.syncStateWriteTimer);
        }
        this.syncStateWriteTimer = setTimeout(() => {
            this.syncStateWriteTimer = undefined;
            this.persistSyncState().catch(logError);
        }, 250);
    }

    private updateSyncStateFile(relPath: string, content?: Uint8Array) {
        if (this.syncState===undefined) { return; }
        const normalizedPath = this.normalizeRelPath(relPath);
        if (content===undefined) {
            for (const path of Object.keys(this.syncState.files)) {
                if (path===normalizedPath || path.startsWith(`${normalizedPath}/`)) {
                    delete this.syncState.files[path];
                }
            }
        } else {
            this.syncState.files[normalizedPath] = sha256(content);
        }
        this.scheduleSyncStateWrite();
    }

    private async scanLocalFileHashes(): Promise<Map<string,string>> {
        const files = new Map<string,string>();
        const queue: Array<[vscode.Uri,string]> = [[this.baseUri, '/']];
        while (queue.length!==0) {
            const [directoryUri, directoryPath] = queue.shift()!;
            const entries = await vscode.workspace.fs.readDirectory(directoryUri);
            for (const [name, type] of entries) {
                const relPath = this.normalizeRelPath(`${directoryPath}${name}`);
                if (this.matchIgnorePatterns(relPath)) { continue; }
                const uri = vscode.Uri.joinPath(directoryUri, name);
                if ((type & vscode.FileType.SymbolicLink)!==0) {
                    this.ignoredLocalSymbolicLinks.add(relPath);
                } else if (type===vscode.FileType.Directory) {
                    queue.push([uri, `${relPath}/`]);
                } else if (type===vscode.FileType.File) {
                    files.set(relPath, sha256(await vscode.workspace.fs.readFile(uri)));
                }
            }
        }
        return files;
    }

    private enqueueSync<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.syncQueue.then(operation, operation);
        this.syncQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async ensureParentDirectories(baseUri: vscode.Uri, relPath: string) {
        const parts = this.normalizeRelPath(relPath).split('/').filter(Boolean).slice(0, -1);
        let currentUri = baseUri;
        for (const part of parts) {
            currentUri = vscode.Uri.joinPath(currentUri, part);
            if (await this.statOrUndefined(currentUri)===undefined) {
                await vscode.workspace.fs.createDirectory(currentUri);
            }
        }
    }

    private setBypassCache(relPath: string, content?: Uint8Array, action?: 'push'|'pull') {
        const date = Date.now();
        const hash = hashCode(content);
        const cache = this.bypassCache.get(relPath) || [undefined,undefined];
        // update the push/pull cache
        if (action==='push') {
            cache[0] = {date, hash};
            cache[1] = cache[1] ?? {date, hash};
        } else if (action==='pull') {
            cache[1] = {date, hash};
            cache[0] = cache[0] ?? {date, hash};
        } else {
            cache[0] = {date, hash};
            cache[1] = {date, hash};
        }
        // write back to the cache
        this.bypassCache.set(relPath, cache as [FileCache,FileCache]);
    }

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashCode(content);
            // console.log(action, relPath, `[${cache[0].hash}, ${cache[1].hash}]`, thisHash);
            if (action==='push' && cache[0].hash===thisHash) { return false; }
            if (action==='pull' && cache[1].hash===thisHash) { return false; }
            // A remote update is mirrored to the local replica and reported by
            // the local watcher as well. Do not upload that mirror operation.
            if (action==='push' && cache[1].hash===thisHash) {
                this.setBypassCache(relPath, content, action);
                return false;
            }
            // Likewise, ignore the VFS watcher event caused by our own upload.
            if (action==='pull' && cache[0].hash===thisHash) {
                this.setBypassCache(relPath, content, action);
                return false;
            }
            if (cache[0].hash!==cache[1].hash) {
                if (action==='push' && now-cache[0].date<500 || action==='pull' && now-cache[1].date<500) {
                    this.setBypassCache(relPath, content, action);
                    return true;
                }
                this.setBypassCache(relPath, content, action);
                return false;
            }
        }
        this.setBypassCache(relPath, content, action);
        return true;
    }

    private async overwrite(remoteVersion: number, root: string='/'): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            // breadth-first search for the files
            const files: string[] = [];
            const queue: string[] = [root];
            while (queue.length!==0) {
                const nextRoot = queue.shift();
                const vfsUri = this.vfs.pathToUri(nextRoot!);
                const items = await vscode.workspace.fs.readDirectory(vfsUri);
                if (token.isCancellationRequested) { return undefined; }
                //
                for (const [name, type] of items) {
                    const relPath = nextRoot + name;
                    if (this.matchIgnorePatterns(relPath)) {
                        continue;
                    }
                    if (type === vscode.FileType.Directory) {
                        queue.push(relPath+'/');
                    } else {
                        files.push(this.normalizeRelPath(relPath));
                    }
                }
            }

            const stateFiles: {[path:string]: string} = {};
            const total = files.length;
            for (let i=0; i<total; i++) {
                const relPath = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
                if (token.isCancellationRequested) { return false; }
                progress.report({increment: total===0 ? 100 : 100/total, message: relPath});
                if (await this.ignoreLocalSymbolicLink(localUri)) { continue; }
                const localContent = await this.readFile(relPath);
                const remoteContent = await vscode.workspace.fs.readFile(vfsUri);
                this.setBypassCache(relPath, remoteContent);
                if (localContent===undefined || sha256(localContent)!==sha256(remoteContent)) {
                    await this.ensureParentDirectories(this.baseUri, relPath);
                    await this.writeFile(relPath, remoteContent);
                }
                this.baseCache[relPath] = remoteContent;
                stateFiles[relPath] = sha256(remoteContent);
            }

            this.syncState = {
                schemaVersion: SYNC_STATE_SCHEMA_VERSION,
                projectUri: this.vfs.origin.toString(),
                remoteVersion,
                files: stateFiles,
            };
            await this.persistSyncState();
            log(`Local replica full sync completed: ${files.length} remote file(s), version ${remoteVersion}.`);
            return true;
        });
    }

    private async syncRemotePath(relPath: string) {
        const normalizedPath = this.normalizeRelPath(relPath);
        const remoteUri = this.vfs.pathToUri(normalizedPath);
        const localUri = vscode.Uri.joinPath(this.baseUri, normalizedPath);
        if (await this.ignoreLocalSymbolicLink(localUri)) {
            this.updateSyncStateFile(normalizedPath, undefined);
            return;
        }
        const remoteStat = await this.statOrUndefined(remoteUri);
        const localStat = await this.statOrUndefined(localUri);

        if (remoteStat===undefined) {
            this.setBypassCache(normalizedPath, undefined);
            if (localStat!==undefined) {
                await vscode.workspace.fs.delete(localUri, {recursive:true});
            }
            delete this.baseCache[normalizedPath];
            this.updateSyncStateFile(normalizedPath, undefined);
            log(`[pull] startup delete "${normalizedPath}"`);
            return;
        }

        if (remoteStat.type===vscode.FileType.Directory) {
            if (localStat!==undefined && localStat.type!==vscode.FileType.Directory) {
                await vscode.workspace.fs.delete(localUri, {recursive:true});
            }
            await vscode.workspace.fs.createDirectory(localUri);
            this.updateSyncStateFile(normalizedPath, undefined);
            log(`[pull] startup directory "${normalizedPath}"`);
            return;
        }

        const remoteContent = await vscode.workspace.fs.readFile(remoteUri);
        const localContent = localStat?.type===vscode.FileType.File ? await vscode.workspace.fs.readFile(localUri) : undefined;
        this.setBypassCache(normalizedPath, remoteContent);
        if (localStat!==undefined && localStat.type!==vscode.FileType.File) {
            await vscode.workspace.fs.delete(localUri, {recursive:true});
        }
        if (localContent===undefined || sha256(localContent)!==sha256(remoteContent)) {
            await this.ensureParentDirectories(this.baseUri, normalizedPath);
            await vscode.workspace.fs.writeFile(localUri, remoteContent);
        }
        this.baseCache[normalizedPath] = remoteContent;
        this.updateSyncStateFile(normalizedPath, remoteContent);
        log(`[pull] startup update "${normalizedPath}"`);
    }

    private async syncLocalPath(relPath: string) {
        const normalizedPath = this.normalizeRelPath(relPath);
        const localUri = vscode.Uri.joinPath(this.baseUri, normalizedPath);
        const remoteUri = this.vfs.pathToUri(normalizedPath);
        if (await this.ignoreLocalSymbolicLink(localUri)) {
            this.updateSyncStateFile(normalizedPath, undefined);
            return;
        }
        const localStat = await this.statOrUndefined(localUri);
        const remoteStat = await this.statOrUndefined(remoteUri);

        if (localStat===undefined) {
            this.setBypassCache(normalizedPath, undefined);
            if (remoteStat!==undefined) {
                await vscode.workspace.fs.delete(remoteUri, {recursive:true});
            }
            delete this.baseCache[normalizedPath];
            this.updateSyncStateFile(normalizedPath, undefined);
            log(`[push] startup delete "${normalizedPath}"`);
            return;
        }

        if (localStat.type===vscode.FileType.Directory) {
            if (remoteStat!==undefined && remoteStat.type!==vscode.FileType.Directory) {
                await vscode.workspace.fs.delete(remoteUri, {recursive:true});
            }
            await this.ensureParentDirectories(this.vfs.origin, normalizedPath);
            await vscode.workspace.fs.createDirectory(remoteUri);
            this.updateSyncStateFile(normalizedPath, undefined);
            log(`[push] startup directory "${normalizedPath}"`);
            return;
        }

        if (remoteStat!==undefined && remoteStat.type!==vscode.FileType.File) {
            await vscode.workspace.fs.delete(remoteUri, {recursive:true});
        }
        const localContent = await vscode.workspace.fs.readFile(localUri);
        this.setBypassCache(normalizedPath, localContent);
        await this.ensureParentDirectories(this.vfs.origin, normalizedPath);
        await vscode.workspace.fs.writeFile(remoteUri, localContent);
        await vscode.workspace.fs.readFile(remoteUri);
        this.baseCache[normalizedPath] = localContent;
        this.updateSyncStateFile(normalizedPath, localContent);
        log(`[push] startup update "${normalizedPath}"`);
    }

    private decodeUtf8(content: Uint8Array): string | undefined {
        try {
            return new TextDecoder('utf-8', {fatal:true}).decode(content);
        } catch {
            return undefined;
        }
    }

    private async syncConcurrentPath(relPath: string, baseVersion: number, baseHash?: string) {
        const normalizedPath = this.normalizeRelPath(relPath);
        const localUri = vscode.Uri.joinPath(this.baseUri, normalizedPath);
        const remoteUri = this.vfs.pathToUri(normalizedPath);
        if (await this.ignoreLocalSymbolicLink(localUri)) {
            this.updateSyncStateFile(normalizedPath, undefined);
            return;
        }
        const localStat = await this.statOrUndefined(localUri);
        const remoteStat = await this.statOrUndefined(remoteUri);

        if (localStat?.type!==vscode.FileType.File || remoteStat?.type!==vscode.FileType.File || baseHash===undefined) {
            await this.syncRemotePath(normalizedPath);
            return;
        }

        const localContent = await vscode.workspace.fs.readFile(localUri);
        const remoteContent = await vscode.workspace.fs.readFile(remoteUri);
        const localHash = sha256(localContent);
        const remoteHash = sha256(remoteContent);
        if (localHash===remoteHash) {
            this.setBypassCache(normalizedPath, remoteContent);
            this.baseCache[normalizedPath] = remoteContent;
            this.updateSyncStateFile(normalizedPath, remoteContent);
            return;
        }
        if (remoteHash===baseHash) {
            await this.syncLocalPath(normalizedPath);
            return;
        }
        if (localHash===baseHash) {
            await this.syncRemotePath(normalizedPath);
            return;
        }

        const baseContentText = (await this.vfs.getFileDiff(normalizedPath, baseVersion, baseVersion))?.diff[0]?.u;
        const localContentText = this.decodeUtf8(localContent);
        const remoteContentText = this.decodeUtf8(remoteContent);
        if (baseContentText===undefined || localContentText===undefined || remoteContentText===undefined ||
            sha256(new TextEncoder().encode(baseContentText))!==baseHash) {
            await this.syncRemotePath(normalizedPath);
            return;
        }

        const dmp = new DiffMatchPatch();
        const remotePatches = dmp.patch_make(baseContentText, remoteContentText);
        const [mergedContentText, applied] = dmp.patch_apply(remotePatches, localContentText);
        if (!applied.every(Boolean)) {
            await this.syncRemotePath(normalizedPath);
            return;
        }

        const mergedContent = new TextEncoder().encode(mergedContentText);
        this.setBypassCache(normalizedPath, mergedContent);
        await vscode.workspace.fs.writeFile(localUri, mergedContent);
        if (sha256(mergedContent)!==remoteHash) {
            await vscode.workspace.fs.writeFile(remoteUri, mergedContent);
            await vscode.workspace.fs.readFile(remoteUri);
        }
        this.baseCache[normalizedPath] = mergedContent;
        this.updateSyncStateFile(normalizedPath, mergedContent);
        log(`[merge] startup update "${normalizedPath}"`);
    }

    private async incrementalSync(
        state: LocalReplicaSyncState,
        currentRemoteVersion: number,
        localHashes: Map<string,string>,
        remoteDiff?: ProjectFileTreeDiffResponseSchema,
    ): Promise<boolean> {
        this.syncState = state;
        const localChangedPaths = new Set<string>();
        const knownPaths = new Set([...Object.keys(state.files), ...localHashes.keys()]);
        for (const path of knownPaths) {
            if (state.files[path]!==localHashes.get(path)) {
                localChangedPaths.add(path);
            }
        }

        const remoteChangedPaths = new Set<string>();
        for (const change of remoteDiff?.diff || []) {
            if (change.operation===undefined) { continue; }
            const oldPath = this.normalizeRelPath(change.pathname);
            if (!this.matchIgnorePatterns(oldPath)) {
                remoteChangedPaths.add(oldPath);
            }
            if (change.operation==='renamed' && change.newPathname!==undefined) {
                const newPath = this.normalizeRelPath(change.newPathname);
                if (!this.matchIgnorePatterns(newPath)) {
                    remoteChangedPaths.add(newPath);
                }
            }
        }

        const changedPaths = [...new Set([...localChangedPaths, ...remoteChangedPaths])]
            .sort((a, b) => a.split('/').length-b.split('/').length || a.localeCompare(b));
        if (changedPaths.length===0) {
            state.remoteVersion = currentRemoteVersion;
            await this.persistSyncState();
            log(`Local replica is current: version ${currentRemoteVersion}, no file content transferred.`);
            return true;
        }

        const failedPaths: string[] = [];
        this.syncStateBatchDepth += 1;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Sync Files'),
                cancellable: true,
            }, async (progress, token) => {
                for (const relPath of changedPaths) {
                    if (token.isCancellationRequested) {
                        failedPaths.push(...changedPaths.slice(changedPaths.indexOf(relPath)));
                        break;
                    }
                    progress.report({increment: 100/changedPaths.length, message: relPath});
                    try {
                        const localChanged = localChangedPaths.has(relPath);
                        const remoteChanged = remoteChangedPaths.has(relPath);
                        if (localChanged && remoteChanged) {
                            await this.syncConcurrentPath(relPath, state.remoteVersion, state.files[relPath]);
                        } else if (localChanged) {
                            await this.syncLocalPath(relPath);
                        } else {
                            await this.syncRemotePath(relPath);
                        }
                    } catch (error) {
                        failedPaths.push(relPath);
                        logError(`Incremental sync failed for ${relPath}:`, error);
                    }
                }
            });
        } finally {
            this.syncStateBatchDepth -= 1;
        }

        if (failedPaths.length!==0) {
            await this.persistSyncState();
            notifyError(
                `Overleaf sync failed for ${failedPaths.length} path(s). The previous sync checkpoint was kept.`,
                undefined,
                'local-replica-incremental-failed'
            );
            return false;
        }

        // Checkpoint only the version used to calculate this diff. Changes
        // arriving during initialization must remain visible next time.
        state.remoteVersion = currentRemoteVersion;
        await this.persistSyncState();
        log(`Local replica incremental sync completed: ${changedPaths.length} changed path(s), version ${state.remoteVersion}.`);
        return true;
    }

    private async initializeSync() {
        const currentRemoteVersion = await this.vfs.getCurrentVersion();
        if (currentRemoteVersion===undefined) {
            return false;
        }
        const state = await this.loadSyncState();
        if (state===undefined || state.remoteVersion>currentRemoteVersion) {
            log('Local replica sync state unavailable or invalid; using full sync.');
            return this.overwrite(currentRemoteVersion);
        }

        let remoteDiff: ProjectFileTreeDiffResponseSchema | undefined;
        if (state.remoteVersion<currentRemoteVersion) {
            remoteDiff = this.vfs.getRecentFileTreeDiff(state.remoteVersion, currentRemoteVersion);
            if (remoteDiff===undefined) {
                try {
                    remoteDiff = await this.vfs.getFileTreeDiff(state.remoteVersion, currentRemoteVersion);
                } catch (error) {
                    logError('Overleaf startup sync was paused because the remote history request failed.', error);
                    return false;
                }
            }
            if (remoteDiff===undefined) {
                log('Local replica history diff unavailable; using full sync.');
                return this.overwrite(currentRemoteVersion);
            }
        }

        const localHashes = await this.scanLocalFileHashes();
        return this.incrementalSync(state, currentRemoteVersion, localHashes, remoteDiff);
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        await (async () => {
            const localUri = action==='push' ? fromUri : toUri;
            if (await this.ignoreLocalSymbolicLink(localUri, action==='push' && type==='delete')) {
                this.updateSyncStateFile(relPath, undefined);
                return;
            }
            if (type==='delete') {
                const newContent = undefined;
                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                delete this.baseCache[relPath];
                await vscode.workspace.fs.delete(toUri, {recursive:true});
                this.updateSyncStateFile(relPath, undefined);
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if ((stat.type & vscode.FileType.SymbolicLink)!==0) {
                    this.ignoredLocalSymbolicLinks.add(this.normalizeRelPath(relPath));
                }
                else if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    await vscode.workspace.fs.createDirectory(toUri);
                }
                else if (stat.type===vscode.FileType.File) {
                    try {
                        const newContent = await vscode.workspace.fs.readFile(fromUri);
                        if (this.bypassSync(action, type, relPath, newContent)) { return; }
                        await vscode.workspace.fs.writeFile(toUri, newContent);
                        this.baseCache[relPath] = newContent;
                        if (action==='push') { await vscode.workspace.fs.readFile(toUri); } // update remote cache
                        this.updateSyncStateFile(relPath, newContent);
                    } catch (error) {
                        notifyError(`Failed to ${action} "${relPath}" during live sync.`, error, `local-replica:${action}:${relPath}`);
                    }
                }
                else {
                    notifyError(`Overleaf sync encountered an unsupported file type at "${relPath}".`, undefined, `local-replica:unknown-type:${relPath}`);
                }
            }
        })();

        this.status = {status: 'idle', message: ''};
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = ('/' + pathParts.join('/'));
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        await this.applySync('pull', type, relPath, vfsUri, localUri);
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        // get relative path to baseUri
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.applySync('push', type, relPath, localUri, vfsUri);
    }

    private async initWatch() {
        // write ".overleaf/settings.json" if not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
        } catch (error) {
            await vscode.workspace.fs.writeFile(settingUri, Buffer.from(
                JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)
            ));
        }

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri.path, '**/*' )
        );
        await this.initializeSync();

        const syncStateDisposable = new vscode.Disposable(() => {
            if (this.syncStateWriteTimer!==undefined) {
                clearTimeout(this.syncStateWriteTimer);
                this.syncStateWriteTimer = undefined;
            }
            this.persistSyncState().catch(logError);
        });
        return [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(uri => this.enqueueSync(() => this.syncFromVFS(uri, 'update')).catch(logError)),
            this.vfsWatcher.onDidCreate(uri => this.enqueueSync(() => this.syncFromVFS(uri, 'update')).catch(logError)),
            this.vfsWatcher.onDidDelete(uri => this.enqueueSync(() => this.syncFromVFS(uri, 'delete')).catch(logError)),
            // sync from local to vfs, including changes made outside VS Code
            this.localWatcher.onDidChange(uri => this.enqueueSync(() => this.syncToVFS(uri, 'update')).catch(logError)),
            this.localWatcher.onDidCreate(uri => this.enqueueSync(() => this.syncToVFS(uri, 'update')).catch(logError)),
            this.localWatcher.onDidDelete(uri => this.enqueueSync(() => this.syncToVFS(uri, 'delete')).catch(logError)),
            syncStateDisposable,
        ];
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
