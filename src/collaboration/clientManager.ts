/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { ELEGANT_NAME, ROOT_NAME } from '../consts';
import { SocketIOAPI, UpdateUserSchema } from '../api/socketio';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { ChatViewProvider } from './chatViewProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { ReviewPanelProvider } from './reviewPanelProvider';

interface ExtendedUpdateUserSchema extends UpdateUserSchema {
    selection?: {
        color: UserColors,
        hoverMessage: vscode.MarkdownString,
        decoration: vscode.TextEditorDecorationType,
        ranges: vscode.DecorationOptions[],
    },
}

enum UserColors {
    ORANGE = '#ff8000',
    PURPLE = '#8000ff',
    PINK = '#ff00ff',
    BROWN = '#804000',
    GRAY = '#808080',
    LIGHT_BLUE = '#0080ff',
    LIGHT_GREEN = '#00ff80',
    LIGHT_PURPLE = '#ff80ff',
    LIGHT_PINK = '#ff80c0',
    LIGHT_YELLOW = '#ffff80',
    LIGHT_ORANGE = '#ffc080',
    LIGHT_RED = '#ff8080',
    LIGHT_GRAY = '#c0c0c0',
    LIGHT_BROWN = '#c08040',
    DARK_BLUE = '#000080',
    DARK_GREEN = '#008040',
    DARK_PURPLE = '#800080',
    DARK_PINK = '#ff0080',
    DARK_YELLOW = '#808000',
    DARK_ORANGE = '#804000',
    DARK_RED = '#800000',
    DARK_GRAY = '#808080',
    DARK_BROWN = '#804000',
}

function formatTime(timestamp:number) {
    timestamp = Math.floor(timestamp / 1000);
    const hours = Math.floor(timestamp / 3600);
    const minutes = Math.floor(timestamp / 60) % 60;
    const ten_seconds = Math.floor(timestamp % 60 / 10);
    const hoursStr = hours > 0 ? `${hours}h ` : '';
    const minutesStr = minutes > 0 ? `${minutes}m` : '';
    const secondsStr = minutesStr==='' && ten_seconds > 0 ? `${ten_seconds*10}s` : '';
    return `${hoursStr}${minutesStr}${secondsStr}`;
}

export class ClientManager {
    private activeExists?: string;
    private inactivateTask?: NodeJS.Timeout;
    private readonly status: vscode.StatusBarItem;
    private readonly onlineUsers: {[K:string]:ExtendedUpdateUserSchema} = {};
    private connectedFlag: boolean = true;
    private readonly chatViewer: ChatViewProvider;
    private readonly reviewPanel: ReviewPanelProvider;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
        private readonly publicId: string,
        private readonly socket: SocketIOAPI,
    ) {
        this.socket.updateEventHandlers({
            onClientUpdated: (user:UpdateUserSchema) => {
                if (user.id !== this.publicId) { this.setStatusActive(user.id); }
                this.updatePosition(user.id, user.doc_id, user.row, user.column, user);
            },
            onClientDisconnected: (id:string) => {
                this.removePosition(id);
            },
            onDisconnected: () => {
                this.connectedFlag = false;
            },
            onConnectionAccepted: (publicId:string) => {
                this.connectedFlag = true;
            }
        });
        this.socket.getConnectedUsers().then(users => {
            users.forEach(user => {
                const onlineUser = {
                    id: user.client_id,
                    user_id: user.user_id,
                    name: [user.first_name, user.last_name].filter(Boolean).join(' '),
                    email: user.email,
                    doc_id: user.cursorData?.doc_id || '',
                    row: user.cursorData?.row || 0,
                    column: user.cursorData?.column || 0,
                    last_updated_at: Number(user.last_updated_at),
                };
                if (user.client_id !== this.publicId) {
                    this.onlineUsers[user.client_id] = onlineUser;
                    this.updatePosition(user.client_id, onlineUser.doc_id, onlineUser.row, onlineUser.column, onlineUser);
                }
            });
        });

        this.chatViewer = new ChatViewProvider(this.vfs, this.publicId, this.context.extensionUri, this.socket);
        this.reviewPanel = new ReviewPanelProvider(this.vfs, this.context, this.socket);
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        this.updateStatus();
    }

    private async jumpToUser(id?: string) {
        if (id === undefined) {
            const onlineUsers = Object.values(this.onlineUsers);
            if (onlineUsers.length === 0) {
                vscode.window.showErrorMessage( vscode.l10n.t('No online Collaborators.') );
                return;
            }
            // select a user
            const selectedUser = await vscode.window.showQuickPick(
                Object.keys(this.onlineUsers).map(clientId => {
                    const user = this.onlineUsers[clientId];
                    const docPath = user.doc_id ? this.vfs._resolveById(user.doc_id)?.path.slice(1) : undefined;
                    const cursorInfo = user.row ? vscode.l10n.t('At {docPath}, Line {row}', {docPath, row:user.row+1}) : undefined;

                    return {
                        label: user.name,
                        description: cursorInfo,
                        clientId: clientId,
                        lastActive: user.last_updated_at!,
                    };
                }).filter(x => x).sort((a,b) => a.lastActive-b.lastActive),
            {
                placeHolder: vscode.l10n.t('Select a collaborator below to jump to.'),
            });
            if (selectedUser === undefined) { return; }
            id = selectedUser.clientId;
        }

        const user = this.onlineUsers[id];
        const docPath = this.vfs._resolveById(user.doc_id)?.path;
        if (docPath === undefined) { return; }

        const uri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                    this.vfs.pathToUri(docPath) : await LocalReplicaSCMProvider.pathToUri(docPath);
        uri && vscode.window.showTextDocument(uri, {
            selection: new vscode.Selection(user.row, user.column, user.row, user.column),
            preview: false,
        });
    }

    private async tetherToUser(id?: string) {}

    private refreshDecorations(visibleTextEditors: readonly vscode.TextEditor[]) {
        Object.values(this.onlineUsers).forEach(async user => {
            const docPath = this.vfs._resolveById(user.doc_id)?.path;
            if (docPath === undefined) { return; }

            const uri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                        this.vfs.pathToUri(docPath) : await LocalReplicaSCMProvider.pathToUri(docPath);
            const editor = uri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
            const selection = user.selection;
            selection && editor?.setDecorations(selection.decoration, selection.ranges);
        });
    }

    private async updatePosition(clientId:string, docId: string, row: number, column: number, details?:UpdateUserSchema) {
        if (clientId === this.publicId) { return; }

        // update record
        if (this.onlineUsers[clientId]===undefined) {
            if (details === undefined) { return; }
            this.onlineUsers[clientId] = {
                last_updated_at: Date.now(),
                ...details
            };
        } else {
            this.onlineUsers[clientId].doc_id = docId;
            this.onlineUsers[clientId].row = row;
            this.onlineUsers[clientId].column = column;
            this.onlineUsers[clientId].last_updated_at = Date.now();
        }

        const selection = this.onlineUsers[clientId].selection;
        // remove decoration
        const oldDoc = this.vfs._resolveById(this.onlineUsers[clientId]?.doc_id);
        if (oldDoc && oldDoc.fileEntity._id !== docId && selection) {
            const oldUri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                        this.vfs.pathToUri(oldDoc.path) : await LocalReplicaSCMProvider.pathToUri(oldDoc.path);

            const oldEditor = oldUri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === oldUri.toString());
            oldEditor && oldEditor.setDecorations(selection.decoration, []);
        }

        // update decoration
        const newDoc = this.vfs._resolveById(docId);
        if (newDoc === undefined) { return; }
        const newUri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                    this.vfs.pathToUri(newDoc.path) : await LocalReplicaSCMProvider.pathToUri(newDoc.path);
        const newEditor = newUri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === newUri.toString());
        if (selection===undefined) {
            const length = Object.keys(this.onlineUsers).length;
            const color = Object.values(UserColors)[length % Object.keys(UserColors).length];
            const decoration = vscode.window.createTextEditorDecorationType({
                outline: `1px solid ${color}`,
                overviewRulerColor: color,
                rangeBehavior: vscode.DecorationRangeBehavior.OpenClosed,
            });
            const hoverMessage = new vscode.MarkdownString(`<span style="color:${color};"><b>${this.onlineUsers[clientId].name}</b></span>`);
            hoverMessage.supportHtml = true;
            const _selection = {
                color,
                decoration,
                hoverMessage,
                ranges: [{
                    range: new vscode.Range(row, column, row, column),
                    hoverMessage: hoverMessage,
                }],
            };
            this.onlineUsers[clientId].selection = _selection;
            newEditor?.setDecorations(_selection.decoration, _selection.ranges);
        } else {
            selection.ranges = [{
                range: new vscode.Range(row, column, row, column),
                hoverMessage: selection.hoverMessage,
            }];
            newEditor?.setDecorations(selection.decoration, selection.ranges);
        }
    }

    private async removePosition(clientId:string) {
        const doc = this.vfs._resolveById(this.onlineUsers[clientId]?.doc_id);
        if (doc === undefined) { return; }
        // const uri = this.vfs.pathToUri(doc.path);
        const uri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                    this.vfs.pathToUri(doc.path) : await LocalReplicaSCMProvider.pathToUri(doc.path);

        const editor = uri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        // delete decoration
        const selection = this.onlineUsers[clientId].selection;
        selection && editor?.setDecorations(selection.decoration, []);
        // delete record
        delete this.onlineUsers[clientId];
    }

    private updateStatus() {
        const count = Object.keys(this.onlineUsers).length;
        switch (this.connectedFlag) {
            case false:
                this.status.color = 'red';
                this.status.text = '$(sync-ignored)';
                this.status.tooltip = `${ELEGANT_NAME}: ${vscode.l10n.t('Not connected')}`;
                // Kick out all users indication since the connection is lost
                Object.keys(this.onlineUsers).forEach(clientId => {
                    this.removePosition(clientId);
                });
                break;
            case true:
                let prefixText = '';
                let tooltip = new vscode.MarkdownString();

                // notify track changes state
                if (this.vfs.trackChangesState) {
                    prefixText = prefixText.concat(`$(record-small) `);
                    tooltip.appendMarkdown(`<h5 align="center">${vscode.l10n.t('Track changes is on.')}</h5><hr>\n\n`);
                }

                // notify unread messages
                if (this.chatViewer.hasUnread) {
                    prefixText = prefixText.concat(`$(bell-dot) ${this.chatViewer.hasUnread} `);
                }
                this.status.command = this.chatViewer.hasUnread? `${ROOT_NAME}.collaboration.revealChatView` : `${ROOT_NAME}.collaboration.settings`;
                this.status.backgroundColor = this.chatViewer.hasUnread? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

                // notify unSynced changes
                const unSynced = this.socket.unSyncFileChanges;
                if (unSynced) {
                    prefixText = prefixText.concat(`$(arrow-up) ${unSynced} `);
                }

                const isInvisible = this.socket.isUsingAlternativeConnectionScheme;
                const onlineIcon = isInvisible ? '$(person)' : '$(organization)';
                switch (count) {
                    case 0:
                        this.status.color = undefined;
                        this.status.text = prefixText + `${onlineIcon} 0`;
                        tooltip.appendMarkdown(`${ELEGANT_NAME}: ${vscode.l10n.t('Online')}`);
                        this.status.tooltip = tooltip;
                        break;
                    default:
                        this.status.color = this.activeExists ? this.onlineUsers[this.activeExists].selection?.color : undefined;
                        this.status.text = prefixText + `${onlineIcon} ${count}`;
                        tooltip.appendMarkdown(`${ELEGANT_NAME}: ${this.activeExists? vscode.l10n.t('Active'): vscode.l10n.t('Idle') }\n\n`);

                        Object.values(this.onlineUsers).forEach(user => {
                            const userArgs = JSON.stringify([`@[[${user.name}#${user.user_id}]] `]);
                            const userCommandUri = vscode.Uri.parse(`command:${ROOT_NAME}.collaboration.insertText?${encodeURIComponent(userArgs)}`);
                            const userInfo = `<a href=${userCommandUri}>@<span style="color:${user.selection?.color};"><b>${user.name}</b></span></a>`;

                            const jumpArgs = JSON.stringify([user.id]);
                            const jumpCommandUri = vscode.Uri.parse(`command:${ROOT_NAME}.collaboration.jumpToUser?${encodeURIComponent(jumpArgs)}`);
                            const docPath = user.doc_id ? this.vfs._resolveById(user.doc_id)?.path.slice(1) : undefined;
                            const cursorInfo = user.row ? ` at <a href="${jumpCommandUri}">${docPath}#L${user.row+1}</a>` : '';
                
                            const since_last_update = user.last_updated_at ? formatTime(Date.now() - user.last_updated_at) : '';
                            const timeInfo = since_last_update==='' ? vscode.l10n.t('Just now') : vscode.l10n.t('{since_last_update} ago', {since_last_update});
                            tooltip.appendMarkdown(`${userInfo} ${cursorInfo} ${timeInfo}\n\n`);
                        });
                        tooltip.isTrusted = true;
                        tooltip.supportHtml = true;
                        this.status.tooltip = tooltip;
                        break;
                }
                break;
        }
        
        this.status.show();
        setTimeout(this.updateStatus.bind(this), 500);
    }

    setStatusActive(clientId:string, timeout:number=10) {
        this.inactivateTask && clearTimeout(this.inactivateTask);
        this.inactivateTask = setTimeout(() => {
            this.activeExists = undefined;
        }, timeout*1000);
        this.activeExists = clientId;
    }

    collaborationSettings() {
        const isInvisible = this.socket.isUsingAlternativeConnectionScheme;
        const useAction = isInvisible ? 'Exit' : 'Enter';
        const quickPickItems = [
            {id:'jump', label:vscode.l10n.t('Jump to Collaborator ...'), detail:''},
            // {id:'tether', label:'Tether to Collaborator ...',detail:''},
            {label:'',kind:vscode.QuickPickItemKind.Separator},
        ];
        if (isInvisible && this.socket.unSyncFileChanges) {
            quickPickItems.push({id:'sync',label:vscode.l10n.t('Upload Unsaved {number} Change(s)', {number:this.socket.unSyncFileChanges}),detail:''});
        } else {
            const detail = !isInvisible ? vscode.l10n.t('Invisible Mode removes your presence from others\' view.') : vscode.l10n.t('Back to normal mode.');
            quickPickItems.push({id:'toggle',label:`${useAction} Invisible Mode`,detail});
        }
        // show quick pick
        vscode.window.showQuickPick(quickPickItems, {
            canPickMany: false,
        }).then(async item => {
            if (item === undefined) { return; }
            switch (item.id) {
                case 'jump':
                    this.jumpToUser();
                    break;
                case 'tether':
                    this.tetherToUser();
                    break;
                case 'toggle':
                    if (useAction==='Enter') {
                        vscode.window.showWarningMessage( vscode.l10n.t('(Experimental Feature) By entering Invisible Mode, the current connection to the server will be lost. Continue?'), 'Yes', 'No').then(async selection => {
                            if (selection === 'Yes') {
                                this.vfs.toggleInvisibleMode();
                            }
                        });
                    } else {
                        this.vfs.toggleInvisibleMode();
                    }
                    break;
                case 'sync':
                    await this.socket.syncFileChanges();
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
                    break;
            }
        });
    }

    get triggers() {
        return [
            this.status,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.insertText`, (text) => {
                this.chatViewer.insertText(text);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.jumpToUser`, (uid) => {
                this.jumpToUser(uid);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.revealChatView`, () => {
                this.chatViewer.insertText();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.settings`, () => {
                this.collaborationSettings();
            }),
            // register chat view provider
            ...this.chatViewer.triggers,
            // register review panel provider
            ...this.reviewPanel.triggers,
            // update this client's position
            vscode.window.onDidChangeTextEditorSelection(async e => {
                if (e.kind===undefined) { return; }
                let uri = e.textEditor.document.uri;
                // deal with local replica
                if (uri.scheme==='file') {
                    const path = await LocalReplicaSCMProvider.uriToPath(uri);
                    if (path) {
                        uri = this.vfs.pathToUri(path);
                    } else {
                        return;
                    }
                }

                const doc = uri && await this.vfs._resolveUri(uri);
                const docId = doc?.fileEntity?._id;
                if (docId) {
                    this.socket.updatePosition(docId, e.selections[0].active.line, e.selections[0].active.character);
                }
            }),
            // refresh decorations when editor is switched
            vscode.window.onDidChangeVisibleTextEditors(e => {
                this.refreshDecorations(e);
            }),
        ];
    }
}
