/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { BaseAPI, MemberEntity, ProjectSettingsSchema } from '../api/base';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { GlobalStateManager } from '../utils/globalStateManager';
import { ClientManager } from '../collaboration/clientManager';
import { EventBus } from '../utils/eventBus';
import { SCMCollectionProvider } from '../scm/scmCollectionProvider';
import { ExtendedBaseAPI, ProjectLinkedFileProvider, UrlLinkedFileProvider } from '../api/extendedBase';

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';
const FolderKeys: {[_type:string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};

export interface FileEntity {
    _id: string,
    name: string,
    _type?: FileType,
    readonly?: boolean,
}

export interface DocumentEntity extends FileEntity {
    version?: number,
    mtime?: number,
    lastVersion?: number,
    localCache?: string,
    remoteCache?: string,
    /** Set while one of our own updates is being reconciled with the server (see writeFile). */
    sync?: {
        done: Promise<void>,
        onAck?: (v:number) => void,
        /** an ack that arrived before `reconcile` started listening */
        earlyAck?: number,
        buffered: UpdateSchema[],
        release: () => void,
    },
    /** A write whose emit failed, not known to have reached the server (see submitWrite). */
    unconfirmed?: PendingWrite,
}

interface PendingWrite {
    update: UpdateSchema,
    /** the content the update turns the server's copy into */
    mergeRes: string,
    /** the content written, i.e. what the editor holds */
    content: string,
    /** `localCache` before the write */
    base: string,
    /** `seq` of the connection current at the first attempt (see VirtualFileSystem.connections) */
    firstConnection?: number,
    /** already sent again after the server applied nothing (see reconcile) */
    resubmitted?: boolean,
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null,
    created: string, //ISO date string
}

export interface OutputFileEntity extends FileEntity {
    path: string, //output file name
    url: string, // `project/${projectId}/user/${userId}/output/${build}/output/${path}`
    type: string, //output file type (postfix)
    build: string, //build id
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
    outputs?: Array<OutputFileEntity>,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string,
    spellCheckLanguage: string,
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
    settings: ProjectSettingsSchema,
}

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
    constructor(name: string, type: vscode.FileType, ctime?: number, permissions?:vscode.FilePermission) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}

export function parseUri(uri: vscode.Uri) {
    const query:any = uri.query.split('&').reduce((acc, v) => {
        const [key,value] = v.split('=');
        return {...acc, [key]:value};
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {userId, projectId, serverName, projectName, identifier, pathParts};
}

export class VirtualFileSystem extends vscode.Disposable {
    private root?: ProjectEntity;
    private currentVersion?: number;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private publicId?: string;
    /** this client's recent connections, numbered in the order they were accepted */
    private connections: {publicId: string, seq: number}[] = [];
    /** settles once a connection is accepted again, while the socket is disconnected */
    private reconnected?: {promise: Promise<void>, resolve: () => void};
    /** How long to wait for the server's ack of our own update before re-reading the doc. */
    static ownUpdateAckTimeoutMs = 5000;
    private userId: string;
    private isDirty: boolean = true;
    private initializing?: Promise<ProjectEntity>;
    private retryConnection: number = 0;
    private retryTimer?: NodeJS.Timeout;
    /** Whether a "Reconnecting..." notification is currently shown */
    private reconnectingNotification: boolean = false;
    /** Timestamp of last disconnect for debounce */
    private lastDisconnectTime: number = 0;
    /** Whether event handlers have been registered on the current socket */
    private handlersRegistered: boolean = false;
    private outputBuildId?: string;
    private compileGroup?: string;
    private clsiServerId?: string;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly projectId: string;

    constructor(context: vscode.ExtensionContext, uri: vscode.Uri, notify: (events:vscode.FileChangeEvent[])=>void) {
        // define the dispose behavior
        super(() => {
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
            // disconnect socketio
            // this.socket.disconnect();
        });

        const {userId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;

        const res = GlobalStateManager.initSocketIOAPI(this.context, this.serverName, projectId);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
        } else {
            throw new Error( vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', {serverName}) );
        }
    }

    get _userId() {
        return this.userId;
    }

    async init() : Promise<ProjectEntity> {
        if (this.root) {
            return Promise.resolve(this.root);
        }

        if (!this.initializing) {
            this.initializing = this.initializingPromise;
        }
        return this.initializing;
    }

    private get initializingPromise(): Promise<ProjectEntity> {
        const MAX_RETRIES = 5;
        const BASE_DELAY_MS = 1000; // 1 second base delay

        // if retry connection exhausted, show error
        if (this.retryConnection >= MAX_RETRIES) {
            this.retryConnection = 0;
            this.initializing = undefined;
            this.reconnectingNotification = false;
            vscode.window.showErrorMessage(
                vscode.l10n.t('Connection lost: {serverName}', {serverName:this.serverName}),
                vscode.l10n.t('Reload'),
                vscode.l10n.t('Retry'),
            ).then((choice) => {
                if (choice === vscode.l10n.t('Reload')) {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                } else if (choice === vscode.l10n.t('Retry')) {
                    this.retryConnection = 0;
                    this.handlersRegistered = false;
                    this.socket.init(); // Recreate socket after all auto-reconnect attempts exhausted
                    this.initializing = this.initializingPromise;
                    this.init().catch(() => {});
                }
            });
            throw new Error( vscode.l10n.t('Connection lost') );
        }

        // exponential backoff delay: 1s, 2s, 4s, 8s, 16s
        const delayMs = this.retryConnection > 0 ? Math.min(BASE_DELAY_MS * Math.pow(2, this.retryConnection - 1), 16000) : 0;

        // Show reconnecting notification on first retry
        if (this.retryConnection === 1 && !this.reconnectingNotification) {
            this.reconnectingNotification = true;
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Reconnecting to {serverName}...', {serverName:this.serverName}),
                cancellable: false,
            }, async () => {
                // Keep the notification visible while reconnecting
                await new Promise<void>((resolve) => {
                    const check = () => {
                        if (this.root || this.retryConnection >= MAX_RETRIES) {
                            this.reconnectingNotification = false;
                            resolve();
                        } else {
                            setTimeout(check, 500);
                        }
                    };
                    check();
                });
            });
        }

        // Wait for backoff delay before retrying
        const attemptReconnect = async (): Promise<ProjectEntity> => {
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            // Only recreate the socket when the connection scheme has changed
            // (e.g., v1→v2 after connectionRejected). For transient disconnects,
            // socket.io's built-in auto-reconnect handles re-establishing the TCP
            // connection without creating a new one — avoiding TCP RST packets.
            if (this.socket.needsReinit) {
                this.socket.init();
                this.handlersRegistered = false;
            }

            // Register event handlers once on the current socket
            if (!this.handlersRegistered) {
                this.remoteWatch();
                this.handlersRegistered = true;
            }

            this.root = undefined;
            return this.socket.joinProject(this.projectId).then(async (project) => {
                // Reset retry counter on success
                this.retryConnection = 0;
                this.reconnectingNotification = false;
                // fetch project settings
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                project.settings = (await this.api.getProjectSettings(identity, this.projectId)).settings!;
                this.root = project;
                const activeCondition = (vscode.workspace.workspaceFolders===undefined) || (vscode.workspace.workspaceFolders?.[0].uri.scheme!==ROOT_NAME) || (vscode.workspace.workspaceFolders?.[0].uri===this.origin);
                // Register: [collaboration] ClientManager on Statusbar
                if (activeCondition) {
                    if (this.clientManagerItem?.triggers) {
                        this.clientManagerItem.triggers.forEach((trigger) => trigger.dispose());
                        delete this.clientManagerItem;
                    }
                    const clientManager = new ClientManager(this, this.context, this.publicId||'', this.socket);
                    this.clientManagerItem = {
                        manager: clientManager,
                        triggers: clientManager.triggers,
                    };
                }
                // Register: [scm] SCMCollectionProvider in explorer
                if (activeCondition) {
                    if (this.scmCollectionItem?.triggers) {
                        this.scmCollectionItem.triggers.forEach((trigger) => trigger.dispose());
                        delete this.scmCollectionItem;
                    }
                    const scmCollection = new SCMCollectionProvider(this, this.context);
                    this.scmCollectionItem = {
                        collection: scmCollection,
                        triggers: scmCollection.triggers,
                    };
                }
                // trigger the first compile
                vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
                return project;
            }).catch((err) => {
                this.retryConnection += 1;
                return this.initializingPromise;
            });
        };

        return attemptReconnect();
    }

    get isInvisibleMode() {
        return this.socket.isUsingAlternativeConnectionScheme;
    }

    toggleInvisibleMode() {
        // Clear disconnect debounce to prevent false retry trigger during mode switch
        this.lastDisconnectTime = 0;
        this.handlersRegistered = false; // Will re-register on the new socket scheme
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.socket.toggleAlternativeConnectionScheme(this.origin.toString(), this.root);
        this.socket.disconnect(); // jump to `onDisconnected` handler
    }

    async _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const {pathParts} = parseUri(uri);
            const root = await this.init();

            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length-1; i++) {
                const folderName = pathParts[i];
                const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                if (folder) {
                    currentFolder = folder;
                } else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length-1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            for (const _type of Object.keys(FolderKeys)) {
                let entity = parentFolder[ FolderKeys[_type] ]?.find((entity) => entity.name === fileName);
                if (!fileName && _type==='folder') { entity = parentFolder; }
                if (entity) {
                    return [entity, _type as FileType, entity._id];
                }
            }
            return [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    _resolveById(entityId: string, root?: FolderEntity, path?:string):{
        parentFolder: FolderEntity, fileEntity: FileEntity, fileType:FileType, path:string
    } | undefined {
        if (!this.root) {
            throw vscode.FileSystemError.FileNotFound();
        }
        root = root || this.root.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        } else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key==='folders') { continue; }
                const entity = root[key]?.find((entity) => entity._id === entityId);
                if (entity) {
                    return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path:path+entity.name};
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path+folder.name+'/');
                if (res) { return res; }
            }
        }
        return undefined;
    }

    walk(filter:(entity:FileEntity)=>boolean): {entity:FileEntity, path:string}[] {
        const result = [];
        const folders = this.root ? [{entity:this.root.rootFolder[0], path:'/'}] : [];

        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key,value] of Object.entries(FolderKeys)) {
                if (value==='folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({entity, path:folder.path+entity.name+'/'});
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key as FileType;
                    filter(entity) && result.push({ entity, path:folder.path+entity.name });
                });
            };
        }

        return result;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index===undefined || index<0) {
            parentFolder[key]?.push(entity as any);
        }
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private remoteWatch(): void {
        this.socket.updateEventHandlers({
            onDisconnected: () => {
                if (!this.reconnected) {
                    let resolve!: () => void;
                    const promise = new Promise<void>((r) => { resolve = r; });
                    this.reconnected = {promise, resolve};
                }
                if (this.root===undefined) { return; } // bypass the first initialization
                console.log("Disconnected");
                // Debounce: ignore rapid disconnect/reconnect cycles (within 2 seconds)
                const now = Date.now();
                if (now - this.lastDisconnectTime < 2000) {
                    console.log("Disconnected: debounced (too soon since last disconnect)");
                    return;
                }
                this.lastDisconnectTime = now;
                // Clear any pending retry timer
                if (this.retryTimer) {
                    clearTimeout(this.retryTimer);
                }
                // Delay reconnection attempt slightly to allow transient issues to resolve
                this.retryTimer = setTimeout(() => {
                    this.retryConnection += 1;
                    this.initializing = this.initializingPromise;
                }, 1000);
            },
            onConnectionAccepted: (publicId:string) => {
                this.retryConnection = 0;
                this.reconnectingNotification = false;
                this.lastDisconnectTime = 0;
                if (this.retryTimer) {
                    clearTimeout(this.retryTimer);
                    this.retryTimer = undefined;
                }
                this.publicId = publicId;
                this.connections.push({publicId, seq: (this.connections[this.connections.length-1]?.seq ?? 0) + 1});
                this.connections.splice(0, this.connections.length - 20);
                this.reconnected?.resolve();
                this.reconnected = undefined;
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath)}
                    ]);
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldName = fileEntity.name;
                    fileEntity.name = newName;
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(res.path.replace(oldName, newName))}
                    ]);
                }
            },
            onFileRemoved: (entityId:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)}
                    ]);
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath.path, oldPath.fileEntity.name)}
                    ]);
                }
            },
            onFileChanged: (update:UpdateSchema) => {
                const res = this._resolveById(update.doc);
                if (res===undefined) { return; }

                const doc = res.fileEntity as DocumentEntity;
                // While one of our own updates is being reconciled (see writeFile), hand
                // its ack over and hold remote ops back until the caches are settled.
                if (doc.sync) {
                    if (update.op===undefined) {
                        if (doc.sync.onAck) { doc.sync.onAck(update.v); } else { doc.sync.earlyAck = update.v; }
                    } else {
                        doc.sync.buffered.push(update);
                    }
                    return;
                }
                // An update without `op` is the ack of one of our own updates that has
                // already been reconciled: nothing left to do.
                if (update.op===undefined) { return; }
                this.applyRemoteUpdate(res.path, doc, update);
            },
            onSpellCheckLanguageUpdated: (language:string) => {
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    EventBus.fire('spellCheckLanguageUpdateEvent', {language});
                }
            },
            onCompilerUpdated: (compiler:string) => {
                if (this.root) {
                    this.root.compiler = compiler;
                    EventBus.fire('compilerUpdateEvent', {compiler});
                }
            },
            onRootDocUpdated: (rootDocId:string) => {
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }

    /** Apply a remote op for `doc` in order; resync lazily when one was missed. */
    private applyRemoteUpdate(path: string, doc: DocumentEntity, update: UpdateSchema) {
        if (doc.version===undefined || doc.remoteCache===undefined) { return; }
        // already part of the content we hold, e.g. fetched by a re-join
        if (update.v<doc.version) { return; }
        if (update.v>doc.version) {
            // an op was missed: drop the server-side copy but keep `localCache`, the
            // content the editor is based on, so the next write can still 3-way merge
            doc.remoteCache = undefined;
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)}
            ]);
            return;
        }
        doc.version += 1;
        let content = doc.remoteCache;
        update.op?.forEach((op) => {
            if (op.i) {
                content = content.slice(0, op.p) + op.i + content.slice(op.p);
            } else if (op.d) {
                const deleteUtf8 = Buffer.from(op.d, 'ascii').toString('utf-8');
                content = content.slice(0, op.p) + content.slice(op.p+deleteUtf8.length);
            }
        });
        // `localCache` is not advanced here but when the editor actually reloads the doc
        // (see openFile): if the user types before that, the reload is skipped and the
        // next write must still merge this op in rather than overwrite it.
        doc.remoteCache = content;
        this.isDirty = true;
        this.notify([
            {type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)}
        ]);
    }

    pathToUri(...path: string[]): vscode.Uri {
        return vscode.Uri.joinPath(this.origin, ...path);
    }

    async resolve(uri: vscode.Uri): Promise<File> {
        const {fileName, fileEntity, fileType} = await this._resolveUri(uri);
        const readonly = fileEntity?.readonly ? vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if ((fileEntity as FileRefEntity).linkedFileData!==null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse((fileEntity as FileRefEntity).created), readonly);
                } else {
                    return new File(fileName, vscode.FileType.File, Date.parse((fileEntity as FileRefEntity).created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }

    async list(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const {fileEntity} = await this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key==='folders'? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (fileType==='doc') {
            const doc = fileEntity as DocumentEntity;
            if (doc.remoteCache!==undefined) {
                const content = doc.remoteCache;
                // the editor is about to show this content, so it is the base of its next write
                const _doc = vscode.workspace.textDocuments.find((d) => d.uri.toString()===uri.toString());
                if (!_doc || !_doc.isDirty) { doc.localCache = content; }
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                const res = await this.socket.joinDoc(fileEntity._id);
                const content = res.docLines.join('\n');
                doc.version = res.version;
                doc.remoteCache = content;
                doc.localCache  = content;
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            }
        } else if (fileType==='outputs') {
            const {compileGroup, clsiServerId, pdfDownloadDomain} = this;
            return GlobalStateManager.authenticate(this.context, this.serverName)
            .then((identity) => {
                return this.api.getFileFromClsi(identity, (fileEntity as OutputFileEntity).url, compileGroup || 'standard', clsiServerId, pdfDownloadDomain)
                .then((res) => {
                    if (res.type==='success') {
                        EventBus.fire('fileWillOpenEvent', {uri});
                        return res.content;
                    } else {
                        return new Uint8Array(0);
                    }
                });
            });
        } else {
            const fileId = fileEntity._id;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type==='success' && res.content) {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            } else {
                return new Uint8Array(0);
            }
        }
    }

    async createFile(uri: vscode.Uri, content:Uint8Array, overwrite?:boolean) {
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity && !overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        let res = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);

        if (content.length===0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            if (_res.type==='success') {
                res = _res.entity;
            }
        } else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            if (_res.type==='success' && _res.entity!==undefined) {
                res = _res.entity;
            } else {
                if (_res.message!==undefined) {
                    vscode.window.showErrorMessage(_res.message);
                }
            }
        }
        if (res && res._type) {
            this.insertEntity(parentFolder, res._type, res);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
        }
    }

    async refreshLinkedFile(uri: vscode.Uri) {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType==='file' && fileEntity) {
            if ((fileEntity as FileRefEntity).linkedFileData===null) { return; }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {});
                
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                const res = await (this.api as ExtendedBaseAPI).refreshLinkedFile(identity, this.projectId, fileEntity._id);

                if (res.type==='success' && res.message!==undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri},
                    ]);
                    progress.report({message: vscode.l10n.t('Done')});
                } else {
                    if (res.message!==undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }

    async createLinkedFile(uri: vscode.Uri) {
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType==='folder' ? res.fileEntity as FolderEntity : res.parentFolder;

        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });

        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTags = (await this.api.getAllTags(identity)).tags || [];
            const projectId = await vscode.window.showQuickPick(
                (await this.api.userProjectsJson(identity)).projects!
                .filter(project => project.id!==this.projectId)
                .map(project => {
                    let detail = '';
                    for (const tag of allTags) {
                        if (tag.project_ids.includes(project.id)) {
                            detail += `$(tag) ${tag.name} `;
                        }
                    }
                    return {label: project.name, id: project.id, detail};
                }),
                {
                    title: vscode.l10n.t('Select a Project'),
                    ignoreFocusOut: true,
                }
            );
            const filePath = projectId && await vscode.window.showQuickPick(
                (await this.api.projectEntitiesJson(identity, projectId!.id)).entities!.map(entity => entity.path),
                {
                    title: vscode.l10n.t('Select a File'),
                    ignoreFocusOut: true,
                }
            );
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {source_entity_path: filePath!, source_project_id: projectId!.id};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {url:url!};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else {
            return;
        }

        // insert entity
        const entity = {
            _id: entityId!, name: fileName!, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data! },
            created: new Date().toISOString(),
        } as FileRefEntity;
        this.insertEntity(parentFolder, 'file', entity);
        const {path} = this._resolveById(entityId!)!;
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri.with({path:`/${this.projectName}${path}`})},
        ]);
    }

    async writeFile(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        const {fileType, fileEntity} = await this._resolveUri(uri);

        // if non-exists --> create it
        if (!fileType && create) {
            return this.createFile(uri, content, true);
        }

        // if exists but not doc --> create new
        if (fileType && fileType!=='doc' && create) {
            return this.createFile(uri, content, overwrite);
        }

        // if exists and is doc --> update
        if (fileType && fileType==='doc' && fileEntity) {
            const doc = fileEntity as DocumentEntity;
            const _content = new TextDecoder().decode(content);
            // one write per doc at a time: wait until the previous one is reconciled
            await this.syncSettled(doc);
            if (doc.unconfirmed) {
                // An earlier write failed without us knowing whether it reached the server.
                // Settle it first, so its edit is neither lost nor applied twice.
                await this.submitWrite(uri, doc, doc.unconfirmed);
                await this.syncSettled(doc);
            }
            if (doc.version===undefined || doc.remoteCache===undefined) {
                // never read, or dropped after a missed op: fetch the server's copy
                // instead of silently skipping the write
                await this.resyncDoc(doc);
            }
            const dmp = new DiffMatchPatch();
            const patches = dmp.patch_make(doc.localCache!,  doc.remoteCache!);

            const mergeResArray = dmp.patch_apply(patches, _content);
            const mergeRes = mergeResArray[0] as string;
            const update = {
                doc: doc._id,
                lastV: doc.lastVersion,
                v: doc.version!,
                // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
                hash: (()=>{
                    if (!doc.mtime || Date.now()-doc.mtime>5000) {
                        doc.mtime = Date.now();
                        return require('crypto').createHash('sha1').update(
                            "blob " + mergeRes.length + "\x00" + mergeRes
                        ).digest('hex');
                    }
                })() as string,
                op: (()=>{
                    const remoteCacheAscii = Buffer.from(doc.remoteCache!, 'utf-8').toString('utf-8');
                    const mergeResAscii = Buffer.from(mergeRes, 'utf-8').toString('utf-8');
                    let currentPos = 0;
                    return dmp.diff_main(remoteCacheAscii, mergeResAscii)
                                .map((part) => {
                                    // part[0] === -1: delete, 0: equal, 1: insert; part[1]: compared content
                                    const incCount = part[0] === -1 ? 0 : part[1].length;
                                    currentPos += incCount;
                                    // add op when content not equal
                                    if (part[0] !== 0) {
                                        return {
                                            p: currentPos - incCount,
                                            i: part[0] ===  1 ?  part[1] : undefined,
                                            d: part[0] === -1 ?  part[1] : undefined,
                                        };
                                    }
                                })
                                .filter(x => x) as any;
                })(),
            };
            this.isDirty = update.op.length>0;
            if (update.op.length===0) {
                // nothing to send: the server already holds this content
                doc.localCache = _content;
                doc.remoteCache = mergeRes;
                setTimeout(() => {
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri}
                    ]);
                }, 10);
                return;
            }
            await this.submitWrite(uri, doc, {update, mergeRes, content: _content, base: doc.localCache!});
        }
    }

    /**
     * Send one write and, once the server has taken it, hand it to `reconcile`.
     *
     * Should the emit fail, the very same update is sent again with `dupIfSource` listing
     * the connections it was sent over: if an earlier attempt did reach the server after
     * all (e.g. only the ack was lost to a reconnect), the server then acknowledges it
     * instead of applying it twice. A write that still fails is kept in `doc.unconfirmed`
     * and settled the same way before the next write of the doc.
     */
    private async submitWrite(uri: vscode.Uri, doc: DocumentEntity, write: PendingWrite) {
        let lastError: any;
        for (let attempt = 0; attempt < 2; attempt++) {
            // Do not let socket.io buffer the update for a connection whose publicId we may
            // never learn (should it drop again before accepting us): dupIfSource could not
            // name it. Wait for the connection to be accepted, as the web client does.
            if (this.reconnected) {
                await Promise.race([this.reconnected.promise, new Promise(r => setTimeout(r, 15000))]);
            }
            write.firstConnection ??= this.connections[this.connections.length-1]?.seq ?? 0;
            const resend = attempt>0 || doc.unconfirmed===write;
            // The connection current at the first attempt, or -- as socket.io buffers an emit
            // made while reconnecting -- any connection accepted since, may have carried it.
            const sentOver = this.connections.filter(c => c.seq>=write.firstConnection!).map(c => c.publicId);
            const update = resend ? {...write.update, dupIfSource: sentOver} : write.update;
            const sync = this.beginSync(doc);
            try {
                await this.socket.applyOtUpdate(doc._id, update);
            } catch (err) {
                lastError = err;
                this.endSync(doc, sync);
                continue;
            }
            doc.unconfirmed = undefined;
            // `localCache` is what the editor holds: the written content. `mergeRes` may also
            // carry ops from others merged in, which the editor only shows once it reloads.
            doc.localCache = write.content;
            doc.remoteCache = write.mergeRes;
            setTimeout(() => {
                this.notify([
                    {type: vscode.FileChangeType.Changed, uri: uri}
                ]);
            }, 10);
            if (this.socket.isUsingAlternativeConnectionScheme) {
                // this scheme sends no ack: the callback is all there is
                doc.lastVersion = write.update.v;
                doc.version = write.update.v + 1;
                this.endSync(doc, sync);
            } else {
                this.reconcile(uri, doc, sync, write);
            }
            return;
        }
        doc.unconfirmed = write;
        throw lastError;
    }

    /**
     * Settle `doc` after the server took `write`, whose update was based on version `v`.
     *
     * The emit callback only means the update was queued. Once it is applied, the server
     * sends the author an op-less `otUpdateApplied {v'}`, `v'` being the version it was
     * applied at: after any op from others applied first, which reaches us before the ack.
     * No ack arrives at all while this client is not in the doc's room, e.g. after a
     * reconnect that did not re-join the doc; every later write would then be submitted
     * at a stale version.
     */
    private async reconcile(uri: vscode.Uri, doc: DocumentEntity, sync: NonNullable<DocumentEntity['sync']>,
                            write: PendingWrite) {
        const baseVersion = write.update.v;
        let resubmit = false;
        const ackVersion = sync.earlyAck ?? await new Promise<number|undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), VirtualFileSystem.ownUpdateAckTimeoutMs);
            sync.onAck = (v:number) => { clearTimeout(timer); resolve(v); };
        });
        sync.onAck = undefined;
        try {
            if (ackVersion===baseVersion) {
                // applied as sent: our content is exactly the server's
                doc.lastVersion = baseVersion;
                doc.version = baseVersion + 1;
            } else {
                // Ops from others went first and ours was transformed against them, or there
                // was no ack. Read the doc back; joining it also puts us back in its room.
                await this.resyncDoc(doc);
                if (ackVersion===undefined && doc.version===baseVersion) {
                    // Nothing was applied, e.g. the server rejected the update. Keep the old
                    // base, so a later write still carries this edit, and do not reload the
                    // editor over it; send it once more (dupIfSource guards against a late one).
                    doc.localCache = write.base;
                    if (!write.resubmitted) {
                        write.resubmitted = true;
                        doc.unconfirmed = write;
                        resubmit = true;
                    }
                } else {
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri}
                    ]);
                }
            }
        } catch {
            doc.remoteCache = undefined; // re-read on the next read or write
        }
        this.endSync(doc, sync);
        if (resubmit && doc.unconfirmed===write && !doc.sync) {
            this.submitWrite(uri, doc, write).catch(() => {});
        }
    }

    private async syncSettled(doc: DocumentEntity) {
        while (doc.sync) { await doc.sync.done; }
    }

    private beginSync(doc: DocumentEntity) {
        let release!: () => void;
        const done = new Promise<void>((resolve) => { release = resolve; });
        const sync = {done, release, buffered: [] as UpdateSchema[]};
        doc.sync = sync;
        return sync;
    }

    /** Finish a sync: apply the remote ops held back meanwhile and let the next write go. */
    private endSync(doc: DocumentEntity, sync: NonNullable<DocumentEntity['sync']>) {
        if (doc.sync!==sync) { return; }
        doc.sync = undefined;
        const res = this._resolveById(doc._id);
        if (res) {
            sync.buffered.forEach((update) => this.applyRemoteUpdate(res.path, doc, update));
        }
        sync.release();
    }

    /** Fetch the server's copy of `doc`. `localCache` is kept: it is what the editor is based on. */
    private async resyncDoc(doc: DocumentEntity) {
        const res = await this.socket.joinDoc(doc._id);
        const content = res.docLines.join('\n');
        doc.version = res.version;
        doc.lastVersion = res.version;
        doc.remoteCache = content;
        if (doc.localCache===undefined) { doc.localCache = content; }
        doc.mtime = undefined;
    }

    async mkdir(uri: vscode.Uri) {
        const {parentFolder, fileName} = await this._resolveUri(uri);
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);

        if (res.type==='success' && res.entity!==undefined) {
            this.insertEntity(parentFolder, 'folder', res.entity as FolderEntity);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
        }
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType && fileEntity) {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            if (res.type==='success') {
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: uri},
                ]);
            } else {
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, force: boolean) {
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);

        if (oldPath.fileType && oldPath.fileEntity && oldPath.fileEntity) {
            // delete existence firstly
            if (newPath.fileType && newPath.fileEntity) {
                if (!force) { return; }
                await this.remove(newUri, true);
                this.removeEntity(newPath.parentFolder, newPath.fileType, newPath.fileEntity);
            }
            // rename or move
            let res = undefined;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            if (oldPath.parentFolder===newPath.parentFolder) {
                const [entityType, entityId, newName] = [oldPath.fileType, oldPath.fileEntity._id, newPath.fileName];
                res = await this.api.renameEntity(identity, this.projectId, entityType, entityId, newName);
            } else {
                const [entityType, entityId, newParentFolderId] = [oldPath.fileType, oldPath.fileEntity._id, newPath.parentFolder._id];
                res = await this.api.moveEntity(identity, this.projectId, entityType, entityId, newParentFolderId);
            }
            // update local cache
            if (res?.type==='success') {
                const newEntity = Object.assign(oldPath.fileEntity);
                newEntity.name = newPath.fileName;
                this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: oldUri},
                    {type: vscode.FileChangeType.Created, uri: newUri},
                ]);
            } else {
                if (res?.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }

    async compile(force:boolean=false, draft:boolean=false, stopOnFirstError:boolean=false, rootDocId?:string) {
        if (force || (this.root && this.isDirty)) {
            this.isDirty = false;
            let needCacheClearFirst = false;
            try{
                await this.resolve(this.pathToUri(OUTPUT_FOLDER_NAME, "output.log"));
            }
            catch (e) {
                needCacheClearFirst = true;
            }
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            // clear cache if needed
            if (needCacheClearFirst) {
                await this.api.deleteAuxFiles(identity, this.projectId);
            }
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath: string | null = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                } else {
                    console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
                }
            }
            const res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
            if (res.type==='success' && res.compile?.status==='success') {
                // Store CDN download info from the response for subsequent output file requests
                this.compileGroup = res.compile.compileGroup;
                this.clsiServerId = res.compile.clsiServerId;
                this.pdfDownloadDomain = res.compile.pdfDownloadDomain;
                this.updateOutputs(res.compile.outputFiles);
                return true;
            } else {
                if (res.message!==undefined) {
                    console.error('Compile failure.', res.message);
                }
                return false;
            }
        }
        return Promise.resolve(undefined);
    }

    async stopCompile() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.stopCompile(identity, this.projectId);
        if (res.type==='success') {
            return true;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }

    async updateOutputs(outputs: Array<OutputFileEntity>) {
        if (this.root) {
            // update output buildId
            // '/project/65dbfff719ad65b54b9eaed4/user/65094b5fa537faaba0bec01f/build/19620231e54-5372f67292889500/output/output.aux' --> 19620231e54-5372f67292889500'
            this.outputBuildId = outputs[0].url.match(/\/build\/([^\/]+)/)?.[1];

            const rootFolder = this.root.rootFolder[0];
            if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
                this.notify([
                    {type:vscode.FileChangeType.Deleted, uri:this.pathToUri(OUTPUT_FOLDER_NAME)}
                ]);
            }

            this.insertEntity(rootFolder, 'folder', {
                _id: __OUTPUTS_ID,
                name: OUTPUT_FOLDER_NAME,
                readonly: true,
                docs: [], fileRefs: [], folders:[],
                outputs: outputs.map((file) => {
                    file._id = __OUTPUTS_ID;
                    file.name=file.path;
                    file.readonly=true;
                    return file;
                })
            } as FolderEntity);
            this.notify([
                {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
                ...(outputs.map((file) => {
                    return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
                }))
            ]);
        }
    }

    async syncCode(filePath: string, line:number, column:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '');
        if (res.type==='success') {
            return res.syncCode;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async syncPdf(page:number, h:number, v:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '');
        if (res.type==='success') {
            return res.syncPdf;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async spellCheck(uri: vscode.Uri, words: string[]) {
        if (this.root?.spellCheckLanguage==='') { return []; }

        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc' || fileType==='file') {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            if (res?.type==='success') {
                return res.misspellings;
            }
        }
    }

    async spellLearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        if (res.type==='success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        } else {
            return false;
        }
    }

    async spellUnlearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        if (res.type==='success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w===word);
            if (index!==undefined && index>=0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        } else {
            return false;
        }
    }

    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language==='') {
            return {name:'Off', code:''};
        } else {
            return this.root?.settings.languages.find(item => item.code===language);
        }
    }

    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }

    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code===compiler);
        return compilerItem;
    }

    getAllCompilers() {
        return this.root?.settings.compilers;
    }

    getDictionary() {
        return this.root?.settings.learnedWords;
    }

    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id!)?.path ?? '';
    }

    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type==='doc' && entity.name.match(/\.tex$/g)!==null;
        });
    }

    getProjectSCMPersist(scmKey: string) {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.serverName, this.projectId);
        return scmPersists[scmKey];
    }

    setProjectSCMPersist(scmKey: string, persist: any) {
        GlobalStateManager.updateServerProjectSCMPersist(this.context, this.serverName, this.projectId, scmKey, persist);
    }

    async updateSettings(setting: any) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
        if (res.type==='success') {
            const keys = Object.keys(setting);
            if (keys.includes('spellCheckLanguage')) {
                this.root!.spellCheckLanguage = setting.spellCheckLanguage;
            }
            if (keys.includes('compiler')) {
                this.root!.compiler = setting.compiler;
            }
            if (keys.includes('rootDocId')) {
                this.root!.rootDoc_id = setting.rootDocId;
            }
        }
        return res.type==='success'? true : false;
    }

    async metadata() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMetadata(identity, this.projectId);
        if (res.type==='success') {
            return res.meta?.projectMeta;
        } else {
            return undefined;
        }
    }

    async getUpdates(before?: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        if (res.type==='success') {
            return res.updates;
        } else {
            return undefined;
        }
    }

    async getFileDiff(pathname:string, from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        if (res.type==='success') {
            return res.diff;
        } else {
            return undefined;
        }
    }

    async getFileTreeDiff(from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        if (res.type==='success') {
            return res.treeDiff;
        } else {
            return undefined;
        }
    }

    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base+2**4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base+1, base+1);
        if (res===undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base+2, base+2);
        if (res2===undefined) {
            this.currentVersion = base+1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res!==undefined) {
                rb = lb + (rb-lb)*2;
            } else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb<rb) {
            const mid = Math.floor((lb+rb)/2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res!==undefined) {
                lb = mid+1;
            } else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb-1;
        return this.currentVersion;
    }

    async createLabel(comment: string, version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }

    async downloadProjectArchive(version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        return res.content;
    }

    async getMessages() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMessages(identity, this.projectId);
        if (res.type==='success') {
            return res.messages;
        } else {
            return undefined;
        }
    }

    async sendMessage(publicId:string, content: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.sendMessage(identity, this.projectId, publicId, content);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        const vfs = this.vfss[ uri.query ];
        if (vfs) {
            return Promise.resolve(vfs);
        } else {
            const vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this));
            this.vfss[ uri.query ] = vfs;
            return Promise.resolve(vfs);
        }
    }

    prefetch(uri: vscode.Uri): Promise<VirtualFileSystem> {
        return this.getVFS(uri).then((vfs) => {return vfs;});
    }

    notify(events :vscode.FileChangeEvent[]) {
        this._emitter.fire(events);
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.openFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.writeFile(uri, content, options.create, options.overwrite) );
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) {
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage( vscode.l10n.t('Cannot rename across servers') );
            return;
        } else {
            return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
        }
    }

    get triggers() {
        return [
            // register file system provider
            vscode.workspace.registerFileSystemProvider(ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri: vscode.Uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri?: vscode.Uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri!));
                }                
            }),
            vscode.commands.registerCommand('remoteFileSystem.prefetch', (uri: vscode.Uri) => {
                return this.prefetch(uri);
            }),
        ];
    }
}
