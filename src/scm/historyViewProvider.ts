/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { EventBus } from '../utils/eventBus';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { ProjectLabelResponseSchema, UserInfoSchema } from '../api/base';

interface HistoryRecord {
    before?: number,
    currentVersion?: number,
    keyVersions: number[], //array of all `toV` values
    revisions: {
        [toV:number]: {
            fromV: number,
            timestamp: number,
            users: UserInfoSchema[]
        }
    },
    labels: {[version:number]: ProjectLabelResponseSchema[]},
    diff: {
        [path:string] : number[] //array of version numbers
    }
}

function formatTime(timestamp:number) {
    const msPerMinute = 60 * 1000;
    const msPerHour = msPerMinute * 60;
    const msPerDay = msPerHour * 24;
    const msPerMonth = msPerDay * 30;
    const msPerYear = msPerDay * 365;

    const elapsed = Date.now() - timestamp;

    if (elapsed < msPerMinute) {
        const elapsedSeconds = Math.round(elapsed/1000);
        return elapsedSeconds===0 ? 'now' : elapsedSeconds + 's';
    } else if (elapsed < msPerHour) {
        const elapsedMinutes = Math.round(elapsed/msPerMinute);
        return elapsedMinutes===1 ? '1 min' : elapsedMinutes + ' mins';
    } else if (elapsed < msPerDay ) {
        const elapsedHours = Math.round(elapsed/msPerHour );
        return elapsedHours===1 ? '1 hour' : elapsedHours + ' hours';
    } else if (elapsed < msPerMonth) {
        const elapsedDays = Math.round(elapsed/msPerDay);
        return elapsedDays===1 ? '1 day' : elapsedDays + ' days';
    } else if (elapsed < msPerYear) {
        const elapsedMonths = Math.round(elapsed/msPerMonth);
        return elapsedMonths===1 ? '1 month' : elapsedMonths + ' months';
    } else {
        const elapsedYears = Math.round(elapsed/msPerYear );
        return elapsedYears===1 ? '1 year' : elapsedYears + ' years';
    }
}

class HistoryItem extends vscode.TreeItem {
    constructor(
        label: string,
        readonly version: number,
        readonly prevVersion: number,
        readonly tags?: ProjectLabelResponseSchema[]
    ) {
        const _tag = tags?.map(t=>t.comment).join(' | ');
        const _label = _tag? `${label} (${_tag})` : label;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = _tag?.length? new vscode.ThemeIcon('tag') : new vscode.ThemeIcon('history');
        this.contextValue = _tag ? 'historyItemLabelled' : 'historyItem';
    }
}

class HistoryDataProvider implements vscode.TreeDataProvider<HistoryItem>, vscode.TextDocumentContentProvider {
    private _path?: string;
    private _history?: HistoryRecord;

    constructor(private readonly vfs: VirtualFileSystem) {
        setInterval(this.refresh.bind(this), 30*1000);
    }

    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | void> = new vscode.EventEmitter<HistoryItem | undefined | void>();

    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    async refreshData(path?:string, force:boolean=false) {
        this._path = path;
        if (force) {
            this._history = undefined;
        }
        await this.getHistory();
        this.refresh();
    }

    async openDiffEditor(originVersion:number, targetVersion:number) {
        if (this._path===undefined) {
            const args: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
            const {diff} = (await this.vfs.getFileTreeDiff(originVersion, targetVersion))!;
            for (const change of diff) {
                if (change.operation===undefined) { continue; }
                const newPathname = change.newPathname || change.pathname;
                let originUri: vscode.Uri | undefined = vscode.Uri.parse(`${ROOT_NAME}-diff:${change.pathname}?${originVersion}`);
                let targetUri: vscode.Uri | undefined = vscode.Uri.parse(`${ROOT_NAME}-diff:${newPathname}?${targetVersion}`);
                let labelUri = targetUri;
                // handle removed/added files
                switch (change.operation) {
                    case 'added':
                        labelUri = targetUri;
                        originUri = undefined;
                        break;
                    case 'removed':
                        labelUri = originUri;
                        targetUri = undefined;
                        break;
                    case 'edited':
                    case 'renamed':
                    default:
                        break;
                }
                args.push([labelUri, originUri, targetUri]);
            }
            vscode.commands.executeCommand('vscode.changes', `v${originVersion} vs v${targetVersion}`, args);
        } else {
            vscode.commands.executeCommand('vscode.diff',
                vscode.Uri.parse(`${ROOT_NAME}-diff:${this._path}?${originVersion}`),
                vscode.Uri.parse(`${ROOT_NAME}-diff:${this._path}?${targetVersion}`),
                `${this._path} (v${originVersion} vs v${targetVersion})`,
            );
        }
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
        if (element !== undefined) { return Promise.resolve([]); }
        if (!this._history) { return Promise.resolve([]); }

        const _history = this._history;
        const versions = this._path? this._history.diff[this._path] : this._history.keyVersions;
        const historyItems = versions?.map(v => {
            const _version = Number( Object.keys(_history.revisions).find(fromV => v<=Number(fromV)) );

            const item = new HistoryItem(
                `Version ${_version}`,
                _version,
                //prevVersion
                _history.revisions[_version].fromV || _version,
                _history.labels[_version],
            );
            const revision = _history.revisions[_version];
            item.description = '\t'+formatTime(revision.timestamp);
            item.tooltip = new vscode.MarkdownString(`$(history) ${new Date(revision.timestamp).toDateString()}\n\n`);
            item.tooltip.appendMarkdown(`**Participants**\n\n`);
            for (const user of revision.users) {
                item.tooltip.appendMarkdown(`$(account) ${user.first_name} ${user.last_name?user.last_name:''} (${user.email})\n`);
            }
            _history.labels[_version].length && item.tooltip.appendMarkdown(`\n**Comments**\n\n`);
            for (const label of _history.labels[_version]) {
                item.tooltip.appendMarkdown(`\`$(tag) ${label.comment}\` \n`);
            }
            item.tooltip.supportThemeIcons = true;
            item.command = {
                command: `projectHistory.comparePrevious`,
                title: vscode.l10n.t('Compare with Previous Version'),
                arguments: [item],
            };
            return item;
        }) || [];

        if (this._history.before) {
            const item = new HistoryItem(vscode.l10n.t('Load More ...'), NaN,NaN);
            item.iconPath = undefined;
            item.command = {
                command: `${ROOT_NAME}.projectHistory.loadMore`,
                title: vscode.l10n.t('Load More ...'),
                arguments: [this],
            };
            historyItems.push(item);
        }
        return Promise.resolve(historyItems);
    }

    provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
        const [pathname, version] = [uri.path, uri.query];
        const _uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (!_uri) { return Promise.reject(); }

        return this.vfs.getFileDiff(pathname, Number(version), Number(version))
        .then(diff => {
            const text = diff?.diff[0]?.u;
            return Promise.resolve(text);
        });
    }

    get triggers() {
        return [
            vscode.workspace.registerTextDocumentContentProvider(`${ROOT_NAME}-diff`, this),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.refresh`, async () => {
                await this.refreshData(this._path, true);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.loadMore`, async (provider: HistoryDataProvider) => {
                await provider.getHistory(provider._history?.before);
                provider.refresh();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.createLabel`, async (item: HistoryItem) => {
                const label = await vscode.window.showInputBox({
                    prompt: vscode.l10n.t('Create a new label'),
                    placeHolder: vscode.l10n.t('Enter a label name'),
                });
                if (!label) { return; }

                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }

                const res = await this.vfs.createLabel(label, item.version);
                if (res) {
                    this._history?.labels[item.version].push(res);
                    this.refresh();
                }
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.deleteLabel`, async (item: HistoryItem) => {
                const label = await vscode.window.showQuickPick(
                    item.tags?.map(t=>t.comment) || [],
                    { placeHolder: vscode.l10n.t('Select a label to delete') }
                );
                if (!label) { return; }

                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }

                const version = item.version;
                const labelId = item.tags?.find(t=>t.comment===label)?.id;
                const res = labelId && await this.vfs.deleteLabel(labelId);
                if (res) {
                    this._history?.labels[version].splice(
                        this._history?.labels[version].findIndex(t=>t.id===labelId), 1
                    );
                    this.refresh();
                }
            }),
            vscode.commands.registerCommand('projectHistory.comparePrevious', async (item: HistoryItem) => {
                vscode.commands.executeCommand(`${ROOT_NAME}.projectHistory.comparePrevious`, item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.comparePrevious`, async (item: HistoryItem) => {
                this.openDiffEditor(item.prevVersion, item.version);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.compareCurrent`, async (item: HistoryItem) => {
                this.openDiffEditor(item.version, this._history?.currentVersion || NaN);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.compareOthers`, async (item: HistoryItem) => {
                const otherVersions = this._history?.keyVersions.filter(v=>v!==item.version);
                if (!otherVersions) { return; }

                vscode.window.showQuickPick(otherVersions.map(v => {
                    return {
                        label: `version ${v}`,
                        description: formatTime(this._history?.revisions[v].timestamp || 0),
                        version: v,
                    };
                }), {
                    placeHolder: vscode.l10n.t('Select a version to compare'),
                }).then(async (select) => {
                    if (!select) { return; }
                    this.openDiffEditor(item.version, select.version);
                });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.downloadProject`, async (item:HistoryItem) => {
                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }
                const version = item.version;
                const content = await this.vfs.downloadProjectArchive(version);
                const filename = `${this.vfs.projectName}-v${version}.zip`;

                const savePath = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(filename),
                    filters: { 'Zip Archive': ['zip'] },
                });
                if (!savePath) { return; }
                await vscode.workspace.fs.writeFile(savePath, content);
                vscode.window.showInformationMessage( vscode.l10n.t('Project v{version} saved to {path}',  {version, path:savePath.fsPath}) );
            }),
        ];
    }

    private async getHistory(before?:number): Promise<HistoryRecord> {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (!uri) { return Promise.reject(); }

        if (this._history===undefined) { // first time load
            this._history = {
                before: undefined,
                keyVersions: [], revisions: {},
                labels: {}, diff: {},
            };
        } else if (before===undefined) { // don't have to load
            return Promise.resolve(this._history);
        }

        const updates = await this.vfs.getUpdates(before);
        this._history.before = updates?.nextBeforeTimestamp;
        
        // parse updates
        if (updates?.updates) {
            this._history.currentVersion = updates.updates[0].toV;
            // iterate all `toV`
            for (const update of updates.updates) {
                const version = update.toV;
                // update `keyVersions`, `revisions` and `labels`
                this._history.keyVersions.push(version);
                this._history.revisions[version] = {
                    fromV: update.fromV,
                    timestamp: update.meta.end_ts,
                    users: update.meta.users,
                };
                this._history.labels[version] = update.labels;
                // update path-related versions
                for (const path of update.pathnames) {
                    this._history.diff[path] ?
                    this._history.diff[path].push(version)
                    : this._history.diff[path] = [version];
                }
                // record updates
                for (const op of update.project_ops) {
                    if (op.add) {
                        this._history.diff[op.add.pathname] ?
                        this._history.diff[op.add.pathname].push(op.atV)
                        : this._history.diff[op.add.pathname] = [op.atV];
                    } else if (op.remove) {
                        this._history.diff[op.remove.pathname] ?
                        this._history.diff[op.remove.pathname].push(op.atV)
                        : this._history.diff[op.remove.pathname] = [op.atV];
                    }
                }
            }
        }

        return Promise.resolve(this._history);
    }
}

export class HistoryViewProvider {
    private treeDataProvider: HistoryDataProvider;
    private historyView: vscode.TreeView<HistoryItem>;

    constructor(vfs: VirtualFileSystem) {
        const treeDataProvider = new HistoryDataProvider(vfs);
        this.historyView = vscode.window.createTreeView(`${ROOT_NAME}.projectHistory`, {treeDataProvider});
        this.treeDataProvider = treeDataProvider;
        this.updateView();
    }

    updateView(pathParts?: string[]) {
        this.historyView.description = pathParts?.at(-1);
        this.treeDataProvider.refreshData( pathParts?.join('/') );
    }

    get triggers() {
        return [
            // register tree view
            ...this.treeDataProvider.triggers,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.clearSelection`, async() => {
                this.updateView(undefined);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.revealHistoryView`, async() => {
                vscode.commands.executeCommand(`${ROOT_NAME}.projectHistory.focus`);
            }),
            // on vfs file open
            EventBus.on('fileWillOpenEvent', async ({uri}) => {
                setTimeout(() => {
                    // filter noise read events
                    const activeTextUri = vscode.window.activeTextEditor?.document.uri;
                    if (activeTextUri && activeTextUri.path!==uri.path) { return; }
                    if (!activeTextUri && vscode.workspace.textDocuments.map(d=>d.uri.path).includes(uri.path)) { return; }

                    // filter output folder
                    const {pathParts} = parseUri(uri);
                    if (pathParts[0]===OUTPUT_FOLDER_NAME) { return; }

                    this.updateView( pathParts );
                }, 100);
            }),
            //FIXME: on "file://" uri open
        ];
    }
}
