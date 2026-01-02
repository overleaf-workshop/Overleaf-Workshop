/* eslint-disable @typescript-eslint/naming-convention */
import { BaseAPI, Identity, ResponseSchema, UserInfoSchema } from "./base";

export interface ProjectLinkedFileProvider {
    provider: 'project_file',
    source_project_id: string,
    source_entity_path: string,
}

export interface UrlLinkedFileProvider {
    provider: 'url',
    url: string,
}

export interface CommentThreadSchema {
    doc_id?: string, // to be filled in via API call
    messages: CommentThreadMessageSchema[],
    resolved?: boolean,
    resolved_at?: string, //ISO format date string
    resolved_by_user_id?: string,
    resolved_by_user?: UserInfoSchema,
}

export interface CommentThreadMessageSchema {
    id: string,
    content: string,
    timestamp: number,
    user_id: string,
    room_id?: string,
    edited_at?: number,
    user: UserInfoSchema,
}

export interface DocumentReviewSchema {
    id: string,
    metadata: {user_id:string, ts:string}, //"ts" is ISO format date string
}

export interface DocumentReviewChangeSchema extends DocumentReviewSchema {
    op: {p:number, i?:string, d?:string},
}

export interface DocumentReviewCommentSchema extends DocumentReviewSchema {
    op: {p:number, c:string, t:string}, // "c" for quoted text, "t" for thread_id
    thread?: CommentThreadSchema, // to be filled in via API call
}

export interface DocumentRangesSchema {
    changes?: DocumentReviewChangeSchema[],
    comments?: DocumentReviewCommentSchema[],
}

export interface ExtendedResponseSchema extends ResponseSchema {
    threads: {[threadId:string]: CommentThreadSchema},
    ranges: {[docId:string]: DocumentRangesSchema},
}

export class ExtendedBaseAPI extends BaseAPI {
    async refreshLinkedFile(identity:Identity, project_id:string, file_id:string) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/linked_file/${file_id}/refresh`, {shouldReindexReferences: false}, (res) => {
            const message  = JSON.parse(res!).new_file_id;
            return {message};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async createLinkedFile(identity:Identity, project_id:string, parent_folder_id:string, name:string, provider:string, data:any) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/linked_file`, {name, parent_folder_id, provider, data}, (res) => {
            const message  = JSON.parse(res!).new_file_id;
            return {message};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async getAllCommentThreads(identity: Identity,  project_id: string) {
        this.setIdentity(identity);
        return await this.request('GET', `project/${project_id}/threads`, undefined, (res) => {
            const threads = JSON.parse(res!);   
            return {threads};
        }) as ExtendedResponseSchema;
    }

    async getAllDocumentRanges(identity: Identity, project_id: string) {
        this.setIdentity(identity);
        return await this.request('GET', `project/${project_id}/ranges`, undefined, (res) => {
            const rangeList = JSON.parse(res!) as {id:string, ranges:DocumentRangesSchema}[];
            const ranges = Object.assign({}, ...rangeList.map((r) => ({[r.id]: r.ranges})));
            return {ranges};
        }) as ExtendedResponseSchema;
    }

    async resolveCommentThread(identity: Identity, project_id: string, thread_id: string) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/thread/${thread_id}/resolve`);
    }

    async reopenResolvedCommentThread(identity: Identity, project_id: string, thread_id: string) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/thread/${thread_id}/reopen`);
    }

    async deleteResolvedCommentThread(identity: Identity, project_id: string, doc_id: string, thread_id: string) {
        this.setIdentity(identity);
        return await this.request('DELETE', `project/${project_id}/doc/${doc_id}/thread/${thread_id}`);
    }

    async postCommentThreadMessage(identity: Identity, project_id: string, thread_id: string, content: string) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/thread/${thread_id}/messages`, {content});
    }

    async deleteCommentThreadMessage(identity: Identity, project_id: string, thread_id: string, message_id: string) {
        this.setIdentity(identity);
        return await this.request('DELETE', `project/${project_id}/thread/${thread_id}/messages/${message_id}`);
    }

    async editCommentThreadMessage(identity: Identity, project_id: string, thread_id: string, message_id: string, content: string) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/thread/${thread_id}/messages/${message_id}/edit`, {content});
    }

    async toggleTrackChanges(identity: Identity, project_id: string, on_for: boolean | {[userId:string]: boolean}) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/track_changes`, {on_for});
    }

    async acceptTrackChanges(identity: Identity, project_id: string, doc_id: string, change_ids: string[]) {
        this.setIdentity(identity);
        return await this.request('POST', `project/${project_id}/doc/${doc_id}/changes/accept`, {change_ids});
    }
}
