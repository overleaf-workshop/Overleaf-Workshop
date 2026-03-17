import * as vscode from 'vscode';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';

import { BaseSCM, CommitItem, SettingItem } from ".";
import { LocalReplicaSCMProvider } from './localReplicaSCM';
import { LocalGitBridgeSCMProvider } from './localGitBridgeSCM'; 
import { HistoryViewProvider } from './historyViewProvider';
import { GlobalStateManager } from '../utils/globalStateManager';
import { EventBus } from '../utils/eventBus';
import { Logger } from '../utils/logger';
import { ROOT_NAME } from '../consts';

const supportedSCMs = [
    LocalReplicaSCMProvider,
    // LocalGitBridgeSCMProvider,
];
type SupportedSCM = typeof supportedSCMs[number];

class CoreSCMProvider extends BaseSCM {
    constructor(protected readonly vfs: VirtualFileSystem) {
        super(vfs, vfs.origin);
    }

    validateBaseUri() { return Promise.resolve(true); }
    async syncFromSCM() {}
    async apply(commitItem: CommitItem) {};
    get triggers() { return Promise.resolve([]); }
    get settingItems() { return[]; }

    writeFile(path: string, content: Uint8Array): Thenable<void> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(path: string): Thenable<Uint8Array> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.readFile(uri);
    }

    list(): Iterable<CommitItem> {
        return [];
    }
}

interface SCMRecord {
    scm: BaseSCM;
    enabled: boolean;
    triggers: vscode.Disposable[];
}

export class SCMCollectionProvider extends vscode.Disposable {
    private readonly core: CoreSCMProvider;
    private readonly scms: SCMRecord[] = [];
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly statusListener: vscode.Disposable;
    private historyDataProvider: HistoryViewProvider;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
    ) {
        // define the dispose behavior
        super(() => {
            this.scms.forEach(scm => scm.triggers.forEach(t => t.dispose()));
        });

        this.core = new CoreSCMProvider( vfs );
        this.historyDataProvider = new HistoryViewProvider( vfs );
        this.initSCMs();

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.statusBarItem.command = `${ROOT_NAME}.projectSCM.configSCM`;
        this.statusListener = EventBus.on('scmStatusChangeEvent', () => {this.updateStatus();});
    }

    private updateStatus() {
        if (!this.statusBarItem) { return; }

        let numPush = 0, numPull = 0;
        let tooltip = new vscode.MarkdownString(`**${vscode.l10n.t('Project Source Control')}**\n\n`);
        tooltip.supportHtml = true;
        tooltip.supportThemeIcons = true;

        // update status bar item tooltip
        if (this.scms.length===0) {
            tooltip.appendMarkdown(`*${vscode.l10n.t('Click to configure.')}*\n\n`);
        } else {
            for (const {scm,enabled} of this.scms) {
                const icon = scm.iconPath.id;
                const label = (scm.constructor as any).label;
                const uri = scm.baseUri.toString();
                const slideUri = uri.length<=30? uri : uri.replace(/^(.{15}).*(.{15})$/, '$1...$2');
                tooltip.appendMarkdown(`----\n\n$(${icon}) **${label}**: [${slideUri}](${uri})\n\n`);
                //
                if (!enabled) {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Disabled')}.*\n\n`);
                } else if (scm.status.status==='idle') {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Synced')}.*\n\n`);
                } else {
                    // show status message
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;***${scm.status.message}***\n\n`);
                    // update counters
                    switch (scm.status.status) {
                        case 'push': numPush++; break;
                        case 'pull': numPull++; break;
                    }
                }
            }   
        }
        this.statusBarItem.tooltip = tooltip;

        // update status bar item text
        if (numPush!==0) {
            this.statusBarItem.text = `$(cloud-upload)`;
        } else if (numPull!==0) {
            this.statusBarItem.text = `$(cloud-download)`;
        } else {
            this.statusBarItem.text = `$(cloud)`;
        }

        this.statusBarItem.show();
    }

    private initSCMs() {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.vfs.serverName, this.vfs.projectId);
        Object.values(scmPersists).forEach(async scmPersist => {
            const scmProto = supportedSCMs.find(scm => scm.label===scmPersist.label);
            if (scmProto!==undefined) {
                const enabled = scmPersist.enabled ?? true;
                const baseUri = vscode.Uri.parse(scmPersist.baseUri);
                await this.createSCM(scmProto, baseUri, false, enabled);
            }
        });
    }

    private async createSCM(scmProto: SupportedSCM, baseUri: vscode.Uri, newSCM=false, enabled=true) {
        const scm = new scmProto(this.vfs, baseUri);
        // insert into global state
        if (newSCM) {
            this.vfs.setProjectSCMPersist(scm.scmKey, {
                enabled: enabled,
                label: scmProto.label,
                baseUri: scm.baseUri.path,
                settings: {} as JSON,
            });
        }
        // insert into collection
        try {
            const triggers = enabled ? await scm.triggers : [];
            this.scms.push({scm,enabled,triggers});
            this.updateStatus();
            return scm;
        } catch (error) {
            // permanently remove failed scm
            // this.vfs.setProjectSCMPersist(scm.scmKey, undefined);
            const errMsg = error instanceof Error ? error.message : String(error);
            Logger.error(`SCM creation failed for "${scmProto.label}" at ${baseUri.toString()}`, error);
            vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed: {msg}', {scm:scmProto.label, msg:errMsg}) );
            return undefined;
        }
    }

    private removeSCM(item: SCMRecord) {
        const index = this.scms.indexOf(item);
        if (index!==-1) {
            // remove from collection
            item.triggers.forEach(trigger => trigger.dispose());
            this.scms.splice(index, 1);
            // remove from global state
            this.vfs.setProjectSCMPersist(item.scm.scmKey, undefined);
            this.updateStatus();
        }
    }

    private createNewSCM(scmProto: SupportedSCM) {
        return new Promise(resolve => {
            const inputBox = scmProto.baseUriInputBox;
            inputBox.ignoreFocusOut = true;
            inputBox.title = vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label});
            inputBox.buttons = [{iconPath: new vscode.ThemeIcon('check')}];
            inputBox.show();
            //
            inputBox.onDidTriggerButton(() => {
                inputBox.hide();
                resolve(inputBox.value);
            });
            inputBox.onDidAccept(() => {
                if (inputBox.activeItems.length===0) {
                    inputBox.hide();
                    resolve(inputBox.value);
                }
            });
        })
        .then((uri) => scmProto.validateBaseUri(uri as string || '', this.vfs.projectName))
        .then(async (baseUri) => {
            if (baseUri) {
                const scm = await this.createSCM(scmProto, baseUri, true);
                if (scm) {
                    vscode.window.showInformationMessage( vscode.l10n.t('"{scm}" created: {uri}.', {scm:scmProto.label, uri: decodeURI(scm.baseUri.toString()) }) );
                } else {
                    vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed.', {scm:scmProto.label}) );
                }
            }
        });
    }

    private configSCM(scmItem: SCMRecord) {
        const baseUri = scmItem.scm.baseUri.toString();
        const settingItems = scmItem.scm.settingItems as SettingItem[];
        const status = scmItem.enabled? scmItem.scm.status.status : 'disabled';
        const quickPickItems = [
            {label:scmItem.enabled?'Disable':'Enable', description:`Status: ${status}`},
            {label:'Remove', description:`${baseUri}`},
            {label:'', kind:vscode.QuickPickItemKind.Separator},
            ...settingItems,
        ];

        return vscode.window.showQuickPick(quickPickItems, {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then(async (select) => {
            if (select===undefined) { return; }
            switch (select.label) {
                case 'Enable':
                case 'Disable':
                    const persist = this.vfs.getProjectSCMPersist(scmItem.scm.scmKey);
                    persist.enabled = !(persist.enabled ?? true);
                    this.vfs.setProjectSCMPersist(scmItem.scm.scmKey, persist);
                    //
                    const scmIndex = this.scms.indexOf(scmItem);
                    this.scms[scmIndex].enabled = persist.enabled;
                    if (persist.enabled) {
                        scmItem.triggers = await scmItem.scm.triggers;
                    } else {
                        scmItem.triggers.forEach(trigger => trigger.dispose());
                        scmItem.triggers = [];
                    }
                    this.updateStatus();
                    vscode.window.showWarningMessage(`"${(scmItem.scm.constructor as any).label}" ${persist.enabled?'enabled':'disabled'}: ${baseUri}.`);
                    break;
                case 'Remove':
                    vscode.window.showWarningMessage(`${vscode.l10n.t('Remove')} ${baseUri}?`, 'Yes', 'No')
                    .then((select) => {
                        if (select==='Yes') {
                            this.removeSCM(scmItem);
                        }
                    });
                    break;
                default:
                    const settingItem = settingItems.find(item => item.label===select.label);
                    settingItem?.callback();
                    break;
            }
        });
    }

    showSCMConfiguration() {
        // group 1: show existing scms
        const scmItems: vscode.QuickPickItem[] = this.scms.map((item) => {
            const { scm } = item;
            return {
                label: (scm.constructor as any).label,
                iconPath: scm.iconPath,
                description: scm.baseUri.toString(),
                item,
            };
        });
        if (scmItems.length!==0) {
            scmItems.push({kind:vscode.QuickPickItemKind.Separator, label:''});
        }
        // group 2: create new scm
        const createItems: vscode.QuickPickItem[] = supportedSCMs.map((scmProto) => {
            return {
                label: vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label}),
                scmProto,
            };
        });

        // show quick pick
        vscode.window.showQuickPick([...scmItems, ...createItems], {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then((select) => {
            if (select) {
                const _select = select as any;
                // configure existing scm
                if (_select.item) {
                    this.configSCM( _select.item as SCMRecord );
                }
                // create new scm
                if ( _select.scmProto ) {
                    this.createNewSCM(_select.scmProto as SupportedSCM );
                }
            }
        });
    }

    get triggers() {
        return [
            // Register: HistoryViewProvider
            ...this.historyDataProvider.triggers,
            // register status bar item
            this.statusBarItem,
            this.statusListener,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.configSCM`, () => {
                return this.showSCMConfiguration();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.newSCM`, (scmProto) => {
                return this.createNewSCM(scmProto);
            }),
            this as vscode.Disposable,
        ];
    }
    
}