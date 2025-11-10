import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { ProjectTagsResponseSchema } from '../api/base';
import { GlobalStateManager } from '../utils/globalStateManager';
import { VirtualFileSystem, parseUri } from './remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { PhantomWebview } from '../utils/phantomWebview';

class DataItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);
    }
}

class ServerItem extends DataItem {
    tags?: {name:string, tid:string}[];
    constructor(
        readonly api: any,
        public readonly name: string,
        public readonly username: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(name, collapsibleState);
        this.iconPath = new vscode.ThemeIcon('vm');
        this.contextValue = collapsibleState===vscode.TreeItemCollapsibleState.None ? 'server_no_login' : 'server_login';
        this.description = username;
        this.tooltip = api.url;
    }
}

class TagItem extends DataItem {
    constructor(
        readonly api: any,
        public readonly serverName: string,
        public readonly tid: string,
        public readonly name: string,
        readonly projects: ProjectItem[],
    ) {
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'tag';
    }
}

class ProjectItem extends DataItem {
    tag?: {name:string, tid:string};
    constructor(
        readonly api: any,
        readonly uri: string,
        readonly parent: ServerItem,
        readonly pid: string,
        readonly label: string,
        readonly status: 'normal' | 'archived' | 'trashed',
    ) {
        const _label = status==='normal' ? label : `[${status}] ${label}`;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = _label;
        this.setStatus(status);
    }

    static clone(project: ProjectItem) {
        return new ProjectItem(project.api, project.uri, project.parent, project.pid, project.label, project.status);
    }

    setStatus(status:'normal' | 'archived' | 'trashed') {
        switch (status) {
            case 'normal':
                this.contextValue = 'project';
                this.iconPath = new vscode.ThemeIcon('notebook');
                break;
            case 'archived':
                this.contextValue = 'archived_project';
                this.iconPath = new vscode.ThemeIcon('archive');
                break;
            case 'trashed':
                this.contextValue = 'trashed_project';
                this.iconPath = new vscode.ThemeIcon('trash');
        }
    }
}

export class ProjectManagerProvider implements vscode.TreeDataProvider<DataItem> {
    constructor(
        private context:vscode.ExtensionContext) {
        this.context = context;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<DataItem | undefined | void> = new vscode.EventEmitter<DataItem | undefined | void>();

    readonly onDidChangeTreeData: vscode.Event<DataItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DataItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DataItem): Thenable<DataItem[]> {
        if (element) {
            if (element instanceof ServerItem) {
                return GlobalStateManager.fetchServerProjects(this.context, element.api, element.name)
                .catch(() => {
                    // Direct logout if cookie expired
                    GlobalStateManager.logoutServer(this.context, element.api, element.name)
                    .then(success => {
                        if (success) {
                            this.refresh();
                        }
                    });
                    return Promise.reject();
                })
                .then(projects => {
                    return GlobalStateManager.authenticate(this.context, element.name)
                    .then(identity => element.api.getAllTags(identity))
                    .then(res => 
                        res.type==='success' ? res.tags as ProjectTagsResponseSchema[] : []
                    )
                    .then(tags => {
                        return {projects, tags};
                    });
                })
                .then(({projects, tags}) => {
                    const allTags:{name:string, tid:string}[] = [];
                    // get project items
                    const normalProjects = [], trashedProjects = [], archivedProjects = [];
                    for (const project of projects) {
                        const uri = `${ROOT_NAME}://${element.name}/${encodeURIComponent(project.name)}?user=${project.userId}&project=${project.id}`;
                        const status = project.archived ? 'archived' : project.trashed ? 'trashed' : 'normal';
                        const item = new ProjectItem(element.api, uri, element, project.id, project.name, status);
                        switch (status) {
                            case 'normal': normalProjects.push(item); break;
                            case 'archived': archivedProjects.push(item); break;
                            case 'trashed': trashedProjects.push(item); break;
                        }
                    }
                    const allProjectItems = [...normalProjects, ...archivedProjects, ...trashedProjects];
                    // create tag items
                    const tagProjectItems:TagItem[] = tags.map(tag => {
                        const _tag = {name:tag.name, tid:tag._id};
                        allTags.push( _tag );
                        const _projects:ProjectItem[] = tag.project_ids.map(pid => {
                            const item = allProjectItems.find(project => project.pid===pid);
                            if (item) {
                                const _item = ProjectItem.clone(item);
                                item.tag = _tag; // for filter purpose
                                _item.contextValue = 'project_in_tag';
                                _item.tag = _tag;
                                return _item;
                            }
                        }).filter(item => item) as ProjectItem[];
                        return new TagItem(element.api, element.name, tag._id, tag.name, _projects);
                    });
                    // get remaining projects
                    const remainingProjects = allProjectItems.filter(project => !project.tag);
                    // return all items
                    element.tags = allTags;
                    return [...tagProjectItems, ...remainingProjects];
                });
            } else if (element instanceof TagItem) {
                return Promise.resolve(element.projects);
            } else {
                return Promise.resolve([]);
            }
        } else {
            const persists = GlobalStateManager.getServers(this.context);
            const serverItems = Object.values(persists).map(persist => new ServerItem(
                persist.api,
                persist.server.name,
                persist.server.login?.username || '',
                persist.server.login? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            ));
            return Promise.resolve(serverItems);
        }
    }

    addServer() {
        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Overleaf server address, e.g. "https://www.overleaf.com"')})
        .then((url) => {
            if (url) {
                try {
                    // check if url is valid
                    const _url = new URL(url);
                    if (!(_url.protocol==='http:' || _url.protocol==='https:')) {
                        throw new Error( vscode.l10n.t('Invalid protocol.') );
                    }
                    if (GlobalStateManager.addServer(this.context, _url.host, _url.href)) {
                        this.refresh();
                    }
                } catch (e) {
                    vscode.window.showErrorMessage( vscode.l10n.t('Invalid server address.') );
                }
            }
        });
    }

    removeServer(name:string) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove server "{name}" ?', {name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                if (GlobalStateManager.removeServer(this.context, name)) {
                    this.refresh();
                }
            }
        });
    }

    loginServer(server: ServerItem) {
        const loginMethods = [
            // login with webview
            {
                id: 'webview',
                label: vscode.l10n.t('Login with Webview'),
                disabled: false,
                details: vscode.l10n.t(''),
                callback: () => {
                    const webview = new PhantomWebview(server.api.url);
                    webview.onCookieUpdated((cookies) => {
                        // 'overleaf_session2', 'sharelatex.sid'
                        if (cookies['overleaf_session2'] || cookies['sharelatex.sid']) {
                            const cookie = Object.entries(cookies).map(([key,value]) => `${key}=${value}`).join('; ');
                            GlobalStateManager.loginServer(this.context, server.api, server.name, {cookies:cookie})
                            .then(success => {
                                if (success) {
                                    this.refresh();
                                    webview.dispose();
                                } else {
                                    vscode.window.showErrorMessage( vscode.l10n.t('Login failed.') );
                                }
                            });
                        }
                    });
                },
            },
            // login with password
            {
                id: 'password',
                label: vscode.l10n.t('Login with Email/Password'),
                disabled: false,
                details: vscode.l10n.t(''),
                callback: () => {
                    vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Email')})
                    .then(email => email ? Promise.resolve(email) : Promise.reject())
                    .then(email =>
                        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Password'), 'password': true})
                        .then(password => {
                            return password ? Promise.resolve([email,password]) : Promise.reject();
                        })
                    )
                    .then(([email,password]) =>
                        GlobalStateManager.loginServer(this.context, server.api, server.name, {email, password})
                    )
                    .then(success => {
                        if (success) {
                            this.refresh();
                        } else {
                            vscode.window.showErrorMessage( vscode.l10n.t('Login failed.') );
                        }
                    });
                },
            },
            {
                id: 'cookies',
                label: vscode.l10n.t('Login with Cookies'),
                disabled: false,
                details: vscode.l10n.t(''),
                callback: () => {
                    vscode.window.showInputBox({
                        'placeHolder': vscode.l10n.t('Cookies, e.g., "sharelatex.sid=..." or "overleaf_session2=..."'),
                        'prompt': vscode.l10n.t('README: [How to Login with Cookies](https://github.com/iamhyc/overleaf-workshop#how-to-login-with-cookies)'),
                    })
                    .then(cookies => cookies ? Promise.resolve(cookies) : Promise.reject())
                    .then(cookies =>
                        GlobalStateManager.loginServer(this.context, server.api, server.name, {cookies})
                    )
                    .then(success => {
                        if (success) {
                            this.refresh();
                        } else {
                            vscode.window.showErrorMessage( vscode.l10n.t('Login failed.') );
                        }
                    });
                },
            },
        ];

        //NOTE: temporarily disable password-based login for `www.overleaf.com`
        if (server.name==='www.overleaf.com') {
            loginMethods.forEach(x => {
                if (x.id==='password') { x.disabled = true; }
            });
        }

        vscode.window.showQuickPick(
            loginMethods.filter(x => !x.disabled),
            { placeHolder:vscode.l10n.t('Select the login method below.') }
        ).then(selection => {
            if (selection===undefined) { return; }
            selection.callback();
        });
    }

    logoutServer(server: ServerItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Logout server "{name}" ?', {name:server.name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.logoutServer(this.context, server.api, server.name)
                .then(success => {
                    if (success) {
                        this.refresh();
                    }
                });
            }
        });
    }

    refreshServer(server: ServerItem) {
        this.refresh();
    }

    newProject(server: ServerItem) {
        // 'Blank Project', 'Example Project', 'Upload Project'
        vscode.window.showQuickPick([vscode.l10n.t('Blank Project'), vscode.l10n.t('Example Project'), vscode.l10n.t('Upload Project')])
        .then((answer) => {
            switch (answer) {
                case vscode.l10n.t('Blank Project'):
                case vscode.l10n.t('Example Project'):
                    const template = answer===vscode.l10n.t('Example Project') ? 'example' : 'none';
                    vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Project name')})
                    .then(name => {
                        if (name) {
                            GlobalStateManager.authenticate(this.context, server.name)
                            .then(identity => server.api.newProject(identity, name, template))
                            .then(res => {
                                if (res.type==='success') {
                                    this.refresh();
                                } else {
                                    vscode.window.showErrorMessage(res.message);
                                }
                            });
                        }
                    });
                    break;
                case vscode.l10n.t('Upload Project'):
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            'Archive File': ['zip'],
                        },
                        title: vscode.l10n.t('Upload Zipped Project'),
                    }).then((uri) => {
                        if (!uri) { return; }
                        vscode.workspace.fs.readFile(uri[0])
                        .then(fileContent => {
                            const filename = uri[0].path.split('/').pop();
                            if (filename) {
                                GlobalStateManager.authenticate(this.context, server.name)
                                .then(identity => server.api.uploadProject(identity, filename, fileContent))
                                .then(res => {
                                    if (res.type==='success') {
                                        this.refresh();
                                    } else {
                                        vscode.window.showErrorMessage(res.message);
                                    }
                                });
                            }
                        });
                    });
                    break;
            }
        });
    }

    copyProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': `${project.label} (Copy)`,
            'title': vscode.l10n.t('Copy Project'),
        }).then(name => {
            if (name) {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.cloneProject(identity, project.pid, name))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    renameProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': project.label,
        })
        .then(newName => {
            if (newName && newName!==project.label) {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.renameProject(identity, project.pid, newName))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    deleteProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Permanently delete project "{label}" ?', {label:project.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.deleteProject(identity, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    archiveProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Archive project "{label}" ?', {label:project.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.archiveProject(identity, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    unarchiveProject(project: ProjectItem) {
        GlobalStateManager.authenticate(this.context, project.parent.name)
        .then(identity => project.api.unarchiveProject(identity, project.pid))
        .then(res => {
            if (res.type==='success') {
                this.refresh();
            } else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }

    trashProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Move project "{label}" to trash ?', {label:project.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.trashProject(identity, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    untrashProject(project: ProjectItem) {
        GlobalStateManager.authenticate(this.context, project.parent.name)
        .then(identity => project.api.untrashProject(identity, project.pid))
        .then(res => {
            if (res.type==='success') {
                this.refresh();
            } else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }

    createTag(server: ServerItem) {
        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Tag name')})
        .then(name => {
            if (name) {
                GlobalStateManager.authenticate(this.context, server.name)
                .then(identity => server.api.createTag(identity, name))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    renameTag(tag: TagItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New tag name'),
            'value': tag.label,
        })
        .then(newName => {
            if (newName && newName!==tag.label) {
                GlobalStateManager.authenticate(this.context, tag.serverName)
                .then(identity => tag.api.renameTag(identity, tag.tid, newName))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    deleteTag(tag: TagItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Delete tag "{label}" ?', {label:tag.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, tag.serverName)
                .then(identity => tag.api.deleteTag(identity, tag.tid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    addProjectToTag(project: ProjectItem) {
        const tagNames = project.parent.tags?.map(tag => tag.name) || [];
        vscode.window.showQuickPick(tagNames, {
            canPickMany:false, placeHolder:vscode.l10n.t('Select the tag below.')})
        .then(selection => {
            if (selection===undefined) { return Promise.reject(); }
            return Promise.resolve(selection);
        })
        .then(tagName => {
            const tagId = project.parent.tags?.find(tag => tag.name===tagName)?.tid;
            GlobalStateManager.authenticate(this.context, project.parent.name)
            .then(identity => project.api.addProjectToTag(identity, tagId, project.pid))
            .then(res => {
                if (res.type==='success') {
                    this.refresh();
                } else {
                    vscode.window.showErrorMessage(res.message);
                }
            });
        });
    }

    removeProjectFromTag(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove project "{label}" from tag "{name}" ?', {label:project.label,name:project.tag?.name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.removeProjectFromTag(identity, project.tag?.tid, project.pid))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    openProjectInCurrentWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)
        .then(() => {
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    openProjectInNewWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)
        .then(() => {
            vscode.commands.executeCommand('vscode.openFolder', uri, true);
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    async openProjectLocalReplica(project: ProjectItem) {
        // should close other open vfs firstly
        const vfsFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme===ROOT_NAME);
        if (vfsFolder) {
            vscode.window.showWarningMessage( vscode.l10n.t('Please close the open remote overleaf folder firstly.') );
            return;
        }

        const uri = vscode.Uri.parse(project.uri);
        const {serverName,projectId} = parseUri(uri);
        // fetch existing local replica scm
        let scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
        let replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label===LocalReplicaSCMProvider.label);
        // if not exist, create new one
        if (replicas.length===0) {
            const vfs = (await (await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri))) as VirtualFileSystem;
            await vfs.init();
            const answer = await vscode.window.showWarningMessage( vscode.l10n.t('No local replica found, create one for project "{label}" ?', {label:project.label}), "Yes", "No");
            if (answer === "Yes") {
                await (await vscode.commands.executeCommand(`${ROOT_NAME}.projectSCM.newSCM`, LocalReplicaSCMProvider));
                // fetch local replica scm again
                scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
                replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label===LocalReplicaSCMProvider.label);
            } else {
                vfs.dispose();
                return;
            }
            vfs.dispose();
        }

        // open local replica
        const replicasPath = replicas.map(scmPersist => vscode.Uri.parse(scmPersist.baseUri).fsPath);
        if (replicasPath.length===0) { return; }
        const quickPickItems = replicasPath.map(path => {
            let label = path;
            let buttons = [{
                id: "removal",
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: vscode.l10n.t('Remove local replica'),
            }];
            return {label, buttons};
        });

        // select local replica via quick pick
        new Promise(resolve => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.placeholder = vscode.l10n.t('Select the local replica below.');
            quickPick.items = quickPickItems;
            quickPick.onDidTriggerItemButton(({button,item}) => {
                if ((button as any).id === "removal") {
                    vscode.window.showWarningMessage( vscode.l10n.t('Remove local replica "{label}" ?', {label:item.label}), 'Yes', 'No')
                    .then(answer => {
                        if (answer === 'Yes') {
                            // remove local replica from scm persists
                            const scmKey = Object.keys(scmPersists).find(key => vscode.Uri.parse(scmPersists[key].baseUri).fsPath===item.label)!;
                            GlobalStateManager.updateServerProjectSCMPersist(this.context, serverName, projectId, scmKey);
                            // remove entry from quick pick
                            quickPick.items = quickPick.items.filter(item => item.label!==item.label);
                        }
                    });
                }
            });
            quickPick.onDidAccept(() => {
                const path = quickPick.selectedItems[0]?.label;
                if (path) {
                    quickPick.dispose();
                    resolve(path);
                }
            });
            quickPick.show();
        })
        .then(path => {
            const uri = vscode.Uri.file(path as string);
            // always open in current window
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    get triggers() {
        return [
            // register tree data provider
            vscode.window.registerTreeDataProvider(`${ROOT_NAME}.projectManager`, this),
            // register server-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.addServer`, () => {
                this.addServer();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.removeServer`, (item) => {
                this.removeServer(item.name);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.loginServer`, (item) => {
                this.loginServer(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.logoutServer`, (item) => {
                this.logoutServer(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.refreshServer`, (item) => {
                this.refreshServer(item);
            }),
            // register project-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.newProject`, (item) => {
                this.newProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.copyProject`, (item) => {
                this.copyProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.renameProject`, (item) => {
                this.renameProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.deleteProject`, (item) => {
                this.deleteProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.archiveProject`, (item) => {
                this.archiveProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.unarchiveProject`, (item) => {
                this.unarchiveProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.trashProject`, (item) => {
                this.trashProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.untrashProject`, (item) => {
                this.untrashProject(item);
            }),
            // register tag-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.createTag`, (item) => {
                this.createTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.renameTag`, (item) => {
                this.renameTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.deleteTag`, (item) => {
                this.deleteTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.addProjectToTag`, (item) => {
                this.addProjectToTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.removeProjectFromTag`, (item) => {
                this.removeProjectFromTag(item);
            }),
            // register open project commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectInCurrentWindow`, (item) => {
                this.openProjectInCurrentWindow(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectInNewWindow`, (item) => {
                this.openProjectInNewWindow(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectLocalReplica`, (item) => {
                this.openProjectLocalReplica(item);
            }),
        ];
    }
}
