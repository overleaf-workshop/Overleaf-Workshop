import * as vscode from 'vscode';
import { Identity, BaseAPI, ProjectPersist, ServerErrorType } from '../api/base';
import { SocketIOAPI } from '../api/socketio';
import { ExtendedBaseAPI } from '../api/extendedBase';

const keyServerPersists: string = 'overleaf-servers';
const keyPdfViewPersists: string = 'overleaf-pdf-viewers';

export interface ServerPersist {
    name: string;
    url: string;
    login?: {
        userId: string;
        username: string;
        identity: Identity;
        projects?: ProjectPersist[]
    };
}
type ServerPersistMap = {[name: string]: ServerPersist};

export interface ProjectSCMPersist {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}
type ProjectSCMPersistMap = {[name: string]: ProjectSCMPersist};

type PdfViewPersist = {
    frequency: number,
    state: any,
};
type PdfViewPersistMap = {[uri: string]: PdfViewPersist};

export class GlobalStateManager {

    static getServers(context:vscode.ExtensionContext): {server:ServerPersist, api:BaseAPI}[] {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const servers = Object.values(persists).map(persist => {
            return {
                server: persist,
                api: new BaseAPI(persist.url),
            };
        });

        if (servers.length===0) {
            const url = new URL('https://www.overleaf.com');
            this.addServer(context, url.host, url.href);
            return this.getServers(context);
        } else {
            return servers;
        }
    }

    // map an error category to a localized, user-facing message
    private static loginErrorMessage(errorType?:ServerErrorType, fallback?:string): string {
        switch (errorType) {
            case 'unreachable':  return vscode.l10n.t('Could not reach the server. It may be offline or the address may be wrong.');
            case 'not-overleaf': return vscode.l10n.t('The server responded but does not look like an Overleaf/ShareLaTeX server.');
            case 'unauthorized': return fallback || vscode.l10n.t('Incorrect email/password, or your session has expired.');
            default:             return fallback || vscode.l10n.t('Login failed.');
        }
    }

    // reachability + Overleaf check used before adding a server
    static async probeServer(url:string): Promise<{reachable:boolean, isOverleaf:boolean}> {
        return new BaseAPI(url).probeServer();
    }

    static addServer(context:vscode.ExtensionContext, name:string, url:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]===undefined ) {
            persists[name] = { name, url };
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static removeServer(context:vscode.ExtensionContext, name:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]!==undefined ) {
            delete persists[name];
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async loginServer(context:vscode.ExtensionContext, api:BaseAPI, name:string, auth:{[key:string]:string}): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login===undefined) {
            let res;
            try {
                res = auth.cookies ? await api.cookiesLogin(auth.cookies) : await api.passportLogin(auth.email, auth.password);
            } catch (e:any) {
                vscode.window.showErrorMessage(this.loginErrorMessage('unknown'));
                return false;
            }
            if (res.type==='success' && res.identity!==undefined && res.userInfo!==undefined) {
                server.login = {
                    userId: res.userInfo.userId,
                    username: auth.email || res.userInfo.userEmail,
                    identity: res.identity
                };
                context.globalState.update(keyServerPersists, persists);
                return true;
            } else {
                vscode.window.showErrorMessage(this.loginErrorMessage(res.errorType, res.message));
                return false;
            }
        } else {
            return false;
        }
    }

    static async logoutServer(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            await api.logout(server.login.identity);
            delete server.login;
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async fetchServerProjects(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<ProjectPersist[]> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            let res = await api.getProjectsJson(server.login.identity);
            if (res.type!=='success') {
                // fallback to `userProjectsJson`
                res = await api.userProjectsJson(server.login.identity);
            }
            if (res.type==='success' && res.projects!==undefined) {
                Object.values(res.projects).forEach(project => {
                    project.userId = (server.login as any).userId;
                });
                const projects = res.projects.map(project => {
                    const existProject = server.login?.projects?.find(p => p.id===project.id);
                    // merge existing scm
                    if (existProject) {
                        project.scm = existProject.scm;
                    }
                    return project;
                });
                server.login.projects = projects;
                context.globalState.update(keyServerPersists, persists);
                return projects;
            } else {
                // regex match for cookie expired
                const cookieExpireRegex = /^302/;
                if (res.message && cookieExpireRegex.test(res.message)) {
                    vscode.window.showErrorMessage(vscode.l10n.t('Cookie Expired. Please Re-Login'));
                    return Promise.reject();
                }
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
                return [];
            }
        } else {
            return [];
        }
    }

    static authenticate(context:vscode.ExtensionContext, name:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        return server.login!==undefined ?
                Promise.resolve(server.login.identity):
                Promise.reject();
    }

    static initSocketIOAPI(context:vscode.ExtensionContext, name:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            const api = new ExtendedBaseAPI(server.url);
            const socket = new SocketIOAPI(server.url, api, server.login.identity, projectId);
            return {api, socket};
        }
    }

    static getServerProjectSCMPersists(context:vscode.ExtensionContext, serverName:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        const scmPersists = project?.scm ? project.scm as ProjectSCMPersistMap : {};
        return scmPersists;
    }

    static updateServerProjectSCMPersist(context:vscode.ExtensionContext, serverName:string, projectId:string, scmKey:string, scmPersist?:ProjectSCMPersist) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        if (project) {
            const scmPersists = (project.scm ?? {}) as ProjectSCMPersistMap;
            if (scmPersist===undefined) {
                delete scmPersists[scmKey];
            } else {
                scmPersists[scmKey] = scmPersist;
            }
            project.scm = scmPersists;
            context.globalState.update(keyServerPersists, persists);
        }
    }

    static getPdfViewPersist(context:vscode.ExtensionContext, uri:string): any {
        return context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {})[uri]?.state;
    }

    static updatePdfViewPersist(context:vscode.ExtensionContext, uri:string, state:any) {
        const persists = context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {});

        // update record
        if (persists[uri]!==undefined) {
            persists[uri].frequency++;
            persists[uri].state = state;
        } else {
            persists[uri] = {frequency: 1, state};
        }

        // when length>=100, remove first least used record
        if (Object.keys(persists).length>=100) {
            let minFrequency = Number.MAX_SAFE_INTEGER;
            let minUri = '';
            Object.entries(persists).forEach(([uri, persist]) => {
                if (persist.frequency<minFrequency) {
                    minFrequency = persist.frequency;
                    minUri = uri;
                }
            });
            delete persists[minUri];
        }

        context.globalState.update(keyPdfViewPersists, persists);
    }

}
