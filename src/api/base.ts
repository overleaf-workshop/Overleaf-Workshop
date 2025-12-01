/* eslint-disable @typescript-eslint/naming-convention */
import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
import * as FormData from 'form-data';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { FileEntity, FileType, FolderEntity, OutputFileEntity } from '../core/remoteFileSystemProvider';

export interface Identity {
    csrfToken: string;
    cookies: string;
}

export interface NewProjectResponseSchema {
    project_id: string,
    owner_ref: string,
    owner: MemberEntity
}

export interface CompileResponseSchema {
    status: 'success' | 'failure' | 'error';
    compileGroup: string;
    outputFiles: Array<OutputFileEntity>;
    stats: {
        "latexmk-errors":number, "pdf-size":number,
        "latex-runs":number, "latex-runs-with-errors":number,
        "latex-runs-0":number, "latex-runs-with-error-0s":number,
    };
    timings: {
        "sync":number, "compile":number, "output":number, "compileE2E":number,
    };
    enableHybridPdfDownload: boolean;
}

export interface SyncPdfResponseSchema {
    file: string,
    line: number,
    column: number
}

export interface SyncCodeResponseSchema {
    pdf: Array<{
        page: number,
        h: number,
        v: number,
        width: number,
        height: number,
    }>
}

export interface SnippetItemSchema {
    meta: string,
    score: number,
    caption: string,
    snippet: string,
}

export interface MisspellingItemSchema {
    index: number,
    suggestions: string[]
}

export interface UserInfoSchema {
    id: string,
    first_name: string,
    last_name?: string,
    email: string,
}

export interface MemberEntity {
    _id: string,
    first_name: string,
    last_name?: string,
    email: string,
    privileges?: string,
    signUpDate?: string,
}

export interface MetadataResponseScheme {
    projectId: string,
    projectMeta: {
        [id:string]: {
            labels: string[],
            packages: {[K:string]: SnippetItemSchema[]}
        }
    }
}

export interface ProjectPersist {
    id: string;
    userId: string;
    name: string;
    lastUpdated?: string;
    lastUpdatedBy?: MemberEntity;
    source?: 'owner' | 'collaborator' | 'readOnly';
    accessLevel: 'owner' | 'collaborator' | 'readOnly';
    archived?: boolean;
    trashed?: boolean;
    scm?: any; //injected by SCMCollectionProvider
}

export interface ProjectTagsResponseSchema {
    __v: number,
    _id: string,
    name: string,
    user_id: string,
    project_ids: string[],
}

export interface ProjectLabelResponseSchema {
    id: string,
    comment: string,
    version: string,
    user_id: string,
    created_at: number,
    user_display_name?: string,
}

export interface ProjectUpdateMeta {
    users: UserInfoSchema[],
    start_ts: number,
    end_ts: number,
}

export interface ProjectHistoryResponseSchema {
    fromV: number,
    toV: number,
    meta: ProjectUpdateMeta,
    labels: ProjectLabelResponseSchema[],
    pathnames: string[],
    project_ops:{
        add?: {pathname:string},
        remove?: {pathname:string},
        atV: number,
    }[],
}

export interface ProjectUpdateResponseSchema {
    updates: ProjectHistoryResponseSchema[],
    nextBeforeTimestamp: number,
}

export interface ProjectFileDiffResponseSchema {
    diff: {
        u?: string, d?: string, i?: string,
        meta?: ProjectUpdateMeta,
    }[]
}

export interface ProjectFileTreeDiffResponseSchema {
    diff: {
        pathname: string,
        newPathname?: string,
        operation?: 'edited' | 'added' | 'removed' | 'renamed',
        deletedAtV?: number,
    }[]
}

export interface ProjectMessageResponseSchema {
    id: string,
    content: string,
    timestamp: number,
    user_id: string,
    user: UserInfoSchema,
    clientId: string,
}

export interface ProjectSettingsSchema {
    learnedWords: string[],
    languages: {code:string, name:string}[],
    compilers: {code:string, name:string}[],
}

export interface ResponseSchema {
    type: 'success' | 'error';
    raw?: ArrayBuffer;
    message?: string;
    userInfo?: {userId:string, userEmail:string};
    identity?: Identity;
    projects?: ProjectPersist[];
    entity?: FileEntity;
    entities?: {path:string, type:string}[];
    compile?: CompileResponseSchema;
    content?: Uint8Array;
    syncPdf?: SyncPdfResponseSchema;
    syncCode?: SyncCodeResponseSchema;
    meta?: MetadataResponseScheme;
    misspellings?: MisspellingItemSchema[];
    tags?: ProjectTagsResponseSchema[];
    labels?: ProjectLabelResponseSchema[];
    updates?: ProjectUpdateResponseSchema;
    diff?: ProjectFileDiffResponseSchema;
    treeDiff?: ProjectFileTreeDiffResponseSchema;
    messages?: ProjectMessageResponseSchema[];
    settings?: ProjectSettingsSchema;
}

export class BaseAPI {
    private url: string;
    private agent: http.Agent | https.Agent;
    private identity?: Identity;

    constructor(url:string) {
        this.url = url;
        this.agent = new URL(url).protocol==='http:' ? new http.Agent({keepAlive: true}) : new https.Agent({keepAlive: true});
    }

    private async getCsrfToken(): Promise<Identity> {
        const res = await fetch(this.url+'login', {
            method: 'GET', redirect: 'manual', agent: this.agent,
        });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);
        if (!match) {
            throw new Error('Failed to get CSRF token.');
        } else {
            const csrfToken = match[1];
            const cookies = res.headers.raw()['set-cookie'][0].split(';')[0];
            return { csrfToken, cookies };
        }
    }

    private async getUserId(cookies:string) {
        const res = await fetch(this.url+'project', {
            method: 'GET', redirect:'manual', agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            }
        });

        const body = await res.text();
        const userIDMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)">/);
        const userEmailMatch = body.match(/<meta\s+name="ol-usersEmail"\s+content="([^"]*)">/);
        const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/);
        if (userIDMatch!==null && csrfTokenMatch!==null) {
            const userId = userIDMatch[1];
            const csrfToken = csrfTokenMatch[1];
            const userEmail = userEmailMatch ? userEmailMatch[1] : '';
            return {userId, userEmail, csrfToken};
        } else {
            return undefined;
        }
    }

    // Reference: "github:overleaf/overleaf/services/web/frontend/js/ide/connection/ConnectionManager.js#L137"
    _initSocketV0(identity:Identity, query?:string) {
        const url = new URL(this.url).origin + (query ?? '');
        return (require('socket.io-client').connect as any)(url, {
            reconnect: false,
            'force new connection': true,
            extraHeaders: {
                'Origin': new URL(this.url).origin,
                'Cookie': identity.cookies,
            }
        });
    }

    async passportLogin(email:string, password:string): Promise<ResponseSchema> {
        const identity = await this.getCsrfToken();
        const res = await fetch(this.url+'login', {
            method: 'POST', redirect: 'manual', agent: this.agent,
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ _csrf: identity.csrfToken, email: email, password: password })
        });

        if (res.status===302) {
            const redirect = ((await res.text()).match(/Found. Redirecting to (.*)/) as any)[1];
            if (redirect==='/project') {
                const cookies = res.headers.raw()['set-cookie'][0];
                return (await this.cookiesLogin(cookies));
            } else {
                return {
                    type: 'error',
                    message: `Redirecting to /${redirect}`
                };
            }
        }
        else if (res.status===200) {
            return {
                type: 'error',
                message: (await res.json() as any).message.message
            };
        } else if (res.status===401) {
            return {
                type: 'error',
                message: (await res.json() as any).message.text
            };
        } else {
            return {
                type: 'error',
                message: `${res.status}: `+await res.text()
            };
        }
    }

    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
        const res = await this.getUserId(cookies);
        if (res) {
            const { userId, userEmail, csrfToken } = res;
            const identity: Identity =  await this.updateCookies({ cookies, csrfToken });
            return {
                type: 'success',
                userInfo: {userId, userEmail},
                identity: identity
            };
        } else {
            return {
                type: 'error',
                message: 'Failed to get User ID.'
            };
        }
    }

    async updateCookies(identity: Identity) {
        const res = await fetch(this.url + 'socket.io/socket.io.js', {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': identity.cookies,
            }
        });
        const header = res.headers.raw()['set-cookie'];
        if (header !== undefined) {
            const cookies = header[0].split(';')[0];
            if (cookies) {
                identity.cookies = `${identity.cookies}; ${cookies}`;
            }
        }
        return identity;
    };

    setIdentity(identity: Identity) {
        this.identity = identity;
        return this;
    }

    protected async request(type:'GET'|'POST'|'PUT'|'DELETE', route:string, body?:FormData|object, callback?: (res?:string)=>object|undefined, extraHeaders?:object ): Promise<ResponseSchema> {
        if (this.identity===undefined) { return Promise.reject(); }

        let res = undefined;
        switch(type) {
            case 'GET':
                res = await fetch(this.url+route, {
                    method: 'GET', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        ...extraHeaders
                    }
                });
                break;
            case 'POST':
                // if body is FormData, then it is a raw body
                const content_type = body instanceof FormData ? undefined : {'Content-Type': 'application/json'};
                const raw_body = body instanceof FormData ? body : JSON.stringify({
                    _csrf: this.identity.csrfToken,
                    ...body
                });
                res = await fetch(this.url+route, {
                    method: 'POST', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        ...content_type,
                        ...extraHeaders
                    },
                    body: raw_body
                });
                break;
            case 'PUT':
                break;
            case 'DELETE':
                res = await fetch(this.url+route, {
                    method: 'DELETE', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        'X-Csrf-Token': this.identity.csrfToken,
                        ...extraHeaders
                    }
                });
                break;
        };

        if (res && (res.status===200 || res.status===204)) {
            const _res = res.status===200 ? await res.text() : undefined;
            const response = callback && callback(_res);
            return {
                type: 'success',
                ...response
            } as ResponseSchema;
        } else {
            res = res || { status:'undefined', text:()=>'' };
            return {
                type: 'error',
                message: `${res.status}: `+await res.text()
            };
        }
    }

    protected async download(route:string) {
        if (this.identity===undefined) { return Promise.reject(); }

        let content: Buffer[] = [];
        while(true) {
            const res = await fetch(this.url+route, {
                method: 'GET', redirect: 'manual', agent: this.agent,
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                }
            });
            if (res.status===200) {
                content.push(await res.buffer());
                break;
            }
            else if (res.status===206) {
                content.push(await res.buffer());
            } else {
                break;
            }
        };

        return Buffer.concat(content);
    }

    async logout(identity:Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', 'logout');
    }

    async userProjectsJson(identity:Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', 'user/projects', undefined, (res) => {
            const projects = (JSON.parse(res!) as any).projects as any[];
            projects.forEach(project => {
                project.id = project._id;
                delete project._id;
            });
            return {projects};
        });
    }

    async getProjectsJson(identity:Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', 'api/project', {}, (res) => {
            const projects = (JSON.parse(res!) as any).projects;
            return {projects};
        });
    }

    async projectEntitiesJson(identity:Identity, projectId:string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/entities`, undefined, (res) => {
            const entities = JSON.parse(res!).entities;
            return {entities};
        });
    }

    async newProject(identity:Identity, projectName:string, template:'none'|'example') {
        this.setIdentity(identity);
        return this.request('POST', 'project/new', {projectName, template}, (res) => {
            const message = (JSON.parse(res!) as NewProjectResponseSchema).project_id;
            return {message};
        });
    }

    async cloneProject(identity:Identity, projectId:string, projectName:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/clone`, {projectName}, (res) => {
            const message = (JSON.parse(res!) as NewProjectResponseSchema).project_id;
            return {message};
        });
    }

    async renameProject(identity:Identity, projectId:string, newProjectName:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/rename`, {newProjectName});
    }

    async deleteProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}`);
    }

    async archiveProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/archive`,
                            undefined, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async unarchiveProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/archive`);
    }

    async trashProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/trash`,
                            undefined, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async untrashProject(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/trash`);
    }

    async getFile(identity:Identity, projectId:string, fileId:string) {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/file/${fileId}`);
        return {
            type: 'success',
            content: new Uint8Array( content )
        };
    }

    async addDoc(identity:Identity, projectId:string, parentFolderId:string, filename:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/doc`, {parent_folder_id:parentFolderId, name:filename}, (res) => {
            const {_id} = JSON.parse(res!) as any;
            const entity = {_type:'doc', _id, name:filename} as FileEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async uploadFile(identity:Identity, projectId:string, parentFolderId:string, filename:string, fileContent:Uint8Array) {
        const fileStream = stream.Readable.from(fileContent);
        const formData = new FormData();
        const mimeType = require('mime-types').lookup(filename);
        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType? mimeType : 'text/plain');
        formData.append('qqfile', fileStream, {filename});

        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/upload?folder_id=${parentFolderId}`, formData, (res) => {
            const {success, entity_id, entity_type} = JSON.parse(res!) as any;
            const entity = {_type:entity_type, _id:entity_id, name:filename} as FileEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async uploadProject(identity:Identity, filename:string, fileContent:Uint8Array) {
        const uuid = uuidv4();
        const fileStream = stream.Readable.from(fileContent);
        const formData = new FormData();
        formData.append('qqfile', fileStream, {filename});

        this.setIdentity(identity);
        return this.request('POST', `project/new/upload?_csrf=${identity.csrfToken}&qquuid=${uuid}&qqfilename=${filename}&qqtotalfilesize=${fileContent.length}`, formData, (res) => {
            const message = (JSON.parse(res!) as NewProjectResponseSchema).project_id;
            return {message};
        });
    }

    async addFolder(identity:Identity, projectId:string, folderName:string, parentFolderId:string) {
        const body = { name: folderName, parent_folder_id: parentFolderId };

        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/folder`, body, (res) => {
            const entity = JSON.parse(res!) as FolderEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async deleteEntity(identity:Identity, projectId:string, fileType:FileType, fileId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/${fileType}/${fileId}`);
    }

    async deleteAuxFiles(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/output`);
    }

    async renameEntity(identity:Identity, projectId:string, entityType:string, entityId:string, name:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/rename`,
                            {name}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async moveEntity(identity:Identity, projectId:string, entityType:string, entityId:string, newParentFolderId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/move`,
                            {folder_id:newParentFolderId}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async compile(identity:Identity, projectId:string, rootDoc_id:string|null,
        draft:boolean=false, stopOnFirstError:boolean=false
    ) {
        const body = {
            check: 'silent',
            draft,
            incrementalCompilesEnabled: true,
            rootDoc_id,
            stopOnFirstError
        };

        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile?auto_compile=true`, body, (res) => {
            const compile = JSON.parse(res!) as CompileResponseSchema;
            return {compile};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async stopCompile(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile/stop`, undefined, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async indexAll(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/references/indexAll`, {shouldBroadcast: false}, undefined);
    }

    async getMetadata(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/metadata`, undefined, (res) => {
            const meta = JSON.parse(res!) as MetadataResponseScheme;
            return {meta};
        });
    }

    async proxyRequestToSpellingApi(identity:Identity, language:string, userId:string, words: string[]) {
        const body = {
            language,
            skipLearnedWords: true,
            token: userId,
            words
        };

        this.setIdentity(identity);
        return this.request('POST', 'spelling/check', body, (res) => {
            const misspellings = JSON.parse(res!).misspellings as MisspellingItemSchema[];
            return {misspellings};
        });
    }

    async spellingControllerLearn(identity:Identity, userId:string, word: string) {
        const body = {
            token: userId,
            word
        };

        this.setIdentity(identity);
        return this.request('POST', 'spelling/learn', body);
    }

    async spellingControllerUnlearn(identity:Identity, word: string) {
        this.setIdentity(identity);
        return this.request('POST', 'spelling/unlearn', {word}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async getProjectSettings(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}`, undefined, (res) => {
            const body = res || '';
            // parse "ol-learnedWords"
            const learnedWordsMatch = /<meta\s+name="ol-learnedWords"\s+data-type="json"\s+content="(\[.*?\])">/.exec(body);
            const learnedWords = (learnedWordsMatch!==null) ? JSON.parse(learnedWordsMatch[1].replace(/&quot;/g, '"')) : [];
            // parse "ol-languages"
            const languagesMatch = /<meta\s+name="ol-languages"\s+data-type="json"\s+content="(\[.*?\])">/.exec(body);
            const languages = (languagesMatch!==null) ? JSON.parse(languagesMatch[1].replace(/&quot;/g, '"')) as {code:string,name:string}[] : [];
            languages.length && languages.unshift({name:'Off', code:''});
            // fill in compilers
            const compilers = [
                {code: 'pdflatex', name: 'pdfLaTex'},
                {code: 'latex',    name: 'LaTex'},
                {code: 'xelatex',  name: 'XeLaTex'},
                {code: 'lualatex', name: 'LuaLaTex'},
            ];
            // return parsed results
            const settings = {learnedWords, languages, compilers} as ProjectSettingsSchema;
            return {settings};
        });
    }

    async updateProjectSettings(identity:Identity, projectId:string, setting:any) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/settings`, setting);
    }

    async getFileFromClsi(identity:Identity, url:string, compileGroup:string) {
        url = url.replace(/^\/+/g, '');

        this.setIdentity(identity);
        const content = await this.download(url);
        return {
            type: 'success',
            content: new Uint8Array( content )
        };
    }

    async proxySyncPdf(identity:Identity, projectId:string, page:number, h:number, v:number, buildId:string) {
        this.setIdentity(identity);
        const request = `project/${projectId}/sync/pdf?page=${page}&h=${h.toFixed(2)}&v=${v.toFixed(2)}&editorId=${uuidv4()}&buildId=${buildId}`;
        return this.request('GET', `project/${projectId}/sync/pdf?page=${page}&h=${h.toFixed(2)}&v=${v.toFixed(2)}&editorId=${uuidv4()}&buildId=${buildId}`,
                            undefined, (res) => {
                                const syncPdf = (JSON.parse(res!) as any).code[0] as SyncPdfResponseSchema;
                                return {syncPdf};
                            });
    }

    async proxySyncCode(identity:Identity, projectId:string, file:string, line:number, column:number, buildId:string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/sync/code?file=${file}&line=${line}&column=${column}&editorId=${uuidv4()}&buildId=${buildId}`,
                            undefined, (res) => {
                                const syncCode = (JSON.parse(res!) as any).pdf as SyncCodeResponseSchema;
                                return {syncCode};
                            });
    }

    async getAllTags(identity:Identity) {
        this.setIdentity(identity);
        return this.request('GET', 'tag', undefined, (res) => {
            const tags = JSON.parse(res!) as ProjectTagsResponseSchema[];
            return {tags};
        });
    }

    async createTag(identity:Identity, name:string) {
        this.setIdentity(identity);
        return this.request('POST', 'tag', {name}, (res) => {
            const tags = JSON.parse(res!) as ProjectTagsResponseSchema[];
            return {tags};
        });
    }

    async renameTag(identity:Identity, tagId:string, name:string) {
        this.setIdentity(identity);
        return this.request('POST', `tag/${tagId}/rename`, {name});
    }

    async deleteTag(identity:Identity, tagId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `tag/${tagId}`);
    }

    async addProjectToTag(identity:Identity, tagId:string, projectId:string) {
        this.setIdentity(identity);
        return this.request('POST', `tag/${tagId}/project/${projectId}`);
    }

    async removeProjectFromTag(identity:Identity, tagId:string, projectId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `tag/${tagId}/project/${projectId}`);
    }

    async proxyToHistoryApiAndGetUpdates(identity:Identity, projectId:string, before?:number) {
        const beforeQuery = before? `&before=${before}` : '';

        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/updates?min_count=10${beforeQuery}`, undefined, (res) => {
            const updates = JSON.parse(res!) as ProjectUpdateResponseSchema;
            return {updates};
        });
    }

    async proxyToHistoryApiAndGetFileDiff(identity:Identity, projectId:string, pathname:string, from:number, to:number) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/diff?pathname=${pathname}&from=${from}&to=${to}`, undefined, (res) => {
            const diff = JSON.parse(res!) as ProjectFileDiffResponseSchema;
            return {diff};
        });
    }

    async proxyToHistoryApiAndGetFileTreeDiff(identity:Identity, projectId:string, from:number, to:number) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/filetree/diff?from=${from}&to=${to}`, undefined, (res) => {
            const treeDiff = JSON.parse(res!) as ProjectFileTreeDiffResponseSchema;
            return {treeDiff};
        });
    }

    async downloadZipOfVersion(identity:Identity, projectId:string, version:number) {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/version/${version}/zip`);
        return {
            type: 'success',
            content: new Uint8Array(content)
        };
    }

    async getLabels(identity:Identity, projectId:string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/labels`, undefined, (res) => {
            const labels = JSON.parse(res!) as ProjectLabelResponseSchema[];
            return {labels};
        });
    }

    async createLabel(identity:Identity, projectId:string, comment:string, version:number) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/labels`, {comment, version}, (res) => {
            const labels = [JSON.parse(res!)] as ProjectLabelResponseSchema[];
            return {labels};
        });
    }

    async deleteLabel(identity:Identity, projectId:string, labelId:string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/labels/${labelId}`);
    }

    async getMessages(identity:Identity, projectId:string, limit:number=50) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/messages?limit=${limit}`, undefined, (res) => {
            const messages = JSON.parse(res!) as ProjectMessageResponseSchema[];
            return {messages};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async sendMessage(identity:Identity, projectId:string, client_id:string, content:string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/messages`, {client_id, content}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }
}
