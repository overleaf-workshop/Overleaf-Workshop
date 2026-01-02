import * as vscode from 'vscode';
import { DocumentEntity, VirtualFileSystem, generateTrackId } from '../core/remoteFileSystemProvider';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { CommentThreadSchema, DocumentRangesSchema, DocumentReviewChangeSchema } from '../api/extendedBase';
import { ROOT_NAME } from '../consts';

type ReviewDecorationType = 'openComment' | 'resolvedComment' | 'insertChange' | 'deleteChange';

const reviewDecorationOptions: {[type in ReviewDecorationType]: vscode.DecorationRenderOptions} = {
    openComment: {
        // backgroundColor: 'rgba(243, 177, 17, 0.3)',
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        light: {gutterIconPath: 'resources/icons/light/gutter-comment-unresolved.svg'},
        dark: {gutterIconPath: 'resources/icons/dark/gutter-comment-unresolved.svg'},
    },
    resolvedComment: {
        backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
        light: {gutterIconPath: 'resources/icons/light/gutter-pass.svg'},
        dark: {gutterIconPath: 'resources/icons/dark/gutter-pass.svg'},
    },
    insertChange: {
        // color: 'rgba(44, 142, 48, 0.3)',
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
        light: {gutterIconPath: 'resources/icons/light/gutter-edit.svg'},
        dark: {gutterIconPath: 'resources/icons/dark/gutter-edit.svg'},
    },
    deleteChange: {
        // color: 'rgba(197, 6, 11, 1.0)',
        backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
        light: {gutterIconPath: 'resources/icons/light/gutter-edit.svg'},
        dark: {gutterIconPath: 'resources/icons/dark/gutter-edit.svg'},
    },
};

function offsetToRange(document: vscode.TextDocument, offset:number, quotedText: string): vscode.Range {
    return new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + quotedText.length),
    );
}

function genThreadMarkdownString(userId:string, threadId:string, thread: CommentThreadSchema): vscode.MarkdownString {
    const text = new vscode.MarkdownString();
    text.isTrusted = true;
    text.supportHtml = true;
    text.supportThemeIcons = true;
    // append thread message
    for (const message of thread.messages) {
        const username = `${message.user.first_name} ${message.user.last_name||''}`;
        const date = new Date(message.timestamp).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'medium'});
        text.appendMarkdown(`**[${username}]()**: ${message.content}\n\n`);
        //
        const editCommandUri = vscode.Uri.parse(`command:reviewPanel.editCommentMessage?${encodeURIComponent(JSON.stringify([ {threadId:threadId,messageId:message.id} ]))}`);
        const deleteCommandUri = vscode.Uri.parse(`command:reviewPanel.deleteCommentMessage?${encodeURIComponent(JSON.stringify([ {threadId:threadId,messageId:message.id} ]))}`);
        if (thread.resolved || message.user_id !== userId) {
            text.appendMarkdown(`<h5>${date}</h5>\n\n`);
        } else if (thread.messages.length === 1) {
            text.appendMarkdown(`<h5>${date} • <a href="${editCommandUri}">Edit</a></h5>\n\n`);
        } else if (thread.messages.length > 1) {
            text.appendMarkdown(`<h5>${date} • <a href="${editCommandUri}">Edit</a> • <a href="${deleteCommandUri}">Delete</a></h5>\n\n`);
        }
        text.appendMarkdown(`----\n\n`);
    }
    // append possible resolved message
    if (thread.resolved) {
        const username = `${thread.resolved_by_user?.first_name} ${thread.resolved_by_user?.last_name||''}`;
        const date = new Date(thread.resolved_at!).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'medium'});
        text.appendMarkdown(`**[${username}]()**: \`${vscode.l10n.t('Mark as resolved')}\`.\n\n`);
        text.appendMarkdown(`<h5>${date}</h5>\n\n`);
        text.appendMarkdown(`<hr/>\n\n`);
    }
    // append action buttons
    if (thread.resolved) {
        const reopenCommandUri = vscode.Uri.parse(`command:reviewPanel.reopenComment?${encodeURIComponent(JSON.stringify([ {threadId} ]))}`);
        const deleteCommandUri = vscode.Uri.parse(`command:reviewPanel.deleteComment?${encodeURIComponent(JSON.stringify([ {docId:thread.doc_id,threadId} ]))}`);
        text.appendMarkdown(`<table width="100%"><tr align="center">
                <td><a href="${reopenCommandUri}"><strong>Reopen</strong></a></td>
                <td><a href="${deleteCommandUri}"><strong>Delete</strong></a></td>
            </tr></table>\n\n`);
    } else {
        const resolveCommandUri = vscode.Uri.parse(`command:reviewPanel.resolveComment?${encodeURIComponent(JSON.stringify([ {threadId} ]))}`);
        const replyCommandUri = vscode.Uri.parse(`command:reviewPanel.replyComment?${encodeURIComponent(JSON.stringify([ {threadId} ]))}`);
        text.appendMarkdown(`<table width="100%"><tr align="center">
            <td><a href="${resolveCommandUri}"><strong>Resolve</strong></a></td>
            <td><a href="${replyCommandUri}"><strong>Reply</strong></a></td>
        </tr></table>\n\n`);
    }
    text.appendMarkdown(`<hr/><hr/><hr/>\n\n`);  
    return text;
}

class ChangeRange {
    public readonly change?: DocumentReviewChangeSchema;
    constructor(private readonly _begin: number=-1, private readonly _end: number=-1) {}
    get begin() { return this._begin; }
    get end() { return this._end; }
    includes(position: number): boolean {
        return position>=this.begin && position<=this.end;
    }
    isAfter(position: number): boolean {
        return position<this.begin;
    }
}

/**
 * NOTE: text has no delete range
 */
class TextChange extends ChangeRange {
    constructor(readonly change: DocumentReviewChangeSchema) { super(); }
    get op() { return this.change.op; }
    get begin () { return this.change.op.p; }
    get end() { return this.change.op.p + (this.change.op.i?.length || 0); }
    get isInsert() { return this.change.op.i!==undefined; }
}

/**
 * NOTE: edit has no insert range
 */
class EditChange extends ChangeRange {
    constructor(readonly change: DocumentReviewChangeSchema) { super(); }
    get op() { return this.change.op; }
    get begin () { return this.change.op.p - (this.change.op.d?.length || 0); }
    get end() { return this.change.op.p; }
    get isInsert() { return this.change.op.i!==undefined; }
}

class InterleavedRange {
    private interleaved: TextChange[];

    constructor(changes: readonly DocumentReviewChangeSchema[]) {
        this.interleaved = changes.map(c => new TextChange(c));
    }

    locate(position: number): ChangeRange {
        const index = this.interleaved.findIndex(rng => rng.includes(position) || rng.isAfter(position));
        if (index===-1) {
            return new ChangeRange();
        } else {
            const text = this.interleaved[index];
            if (text.includes(position)) {
                return text;
            } else {
                const lastText = this.interleaved[index-1] || new ChangeRange(0,0);
                return new ChangeRange(lastText?.end||0, text.begin);
            }
        }
    }

    apply(start: ChangeRange, callback: (range: TextChange) => void) {
        const index = this.interleaved.findIndex(rng => rng.end<=start.begin);
        if (index!==-1) {
            for (let i=index; i<this.interleaved.length; i++) {
                callback(this.interleaved[i]);
            }
        }
    }

    insert(change: TextChange) {
        const index = this.interleaved.findIndex(rng => rng.end<=change.begin);
        if (index!==-1) {
            this.interleaved.splice(index, 0, change);
        } else {
            this.interleaved.push(change);
        }
    }

    remove(range: TextChange) {
        this.interleaved = this.interleaved.filter(rng => rng!==range);
    }

    removeBetween(start: ChangeRange, end: ChangeRange) {
        const startIndex = this.interleaved.findIndex(rng => rng.end<=start.begin);
        const endIndex = this.interleaved.findIndex(rng => rng.begin>=end.end);
        if (startIndex!==-1 && endIndex!==-1) {
            this.interleaved.splice(startIndex, endIndex-startIndex);
        }
    }

    condense(): DocumentReviewChangeSchema[] {
        return this.interleaved.map(rng => rng.change);
    }
}

class EditManager {
    private wholeText: InterleavedRange;
    /**
     * Reference: https://github.com/overleaf/overleaf/tree/main/libraries/ranges-tracker
     * 
     * Insert Edit Range Direction: (p)|------>|(end)
     * Delete Edit Range Direction: (begin)|<------|(p)
     */
    constructor(
        _changes: readonly DocumentReviewChangeSchema[],
    ) {
        this.wholeText = new InterleavedRange(_changes);
    }

    get changes() {
        return this.wholeText.condense();
    }

    generateRefreshes(update: UpdateSchema, metadata: any) {
        let refreshes:{id:string, type?:ReviewDecorationType}[] = [];

        const tcPrefix = update.meta?.tc;
        for (const [offset,editOp] of update.op!.entries()) {
            const tcIndex = offset.toString().padStart(6,'0');
            const tcId = tcPrefix ? (tcPrefix+tcIndex) : '';
            const edit = new EditChange({id:tcId, op:editOp, metadata:metadata});
            // lookup for affected edit begins/end index
            const beginText = this.wholeText.locate(edit.begin);
            const endText = editOp.i? beginText : this.wholeText.locate(edit.end);
            
            // 1a. apply insert edit
            if (editOp.i) {
                // 1a.1. to insert text range
                if (beginText instanceof TextChange && beginText.op.i) {
                    refreshes.push( ...this.applyInsertRangeWithInsertChange(beginText, edit) );
                }
                // 1a.2. to delete text range
                else if (beginText instanceof TextChange && beginText.op.d) {
                    refreshes.push( ...this.applyDeleteRangeWithInsertChange(beginText, edit) );
                }
                // 1a.3. to interleaved range
                else {
                    refreshes.push( ...this.applyInterleavedRangeWithInsertChange(beginText, edit) );   
                }
            }
            // 1b. apply delete edit
            else if (editOp.d) {
                // 1b.1. for both `beginText` and `endText` text ranges
                const [beginRemain, endRemain] = [beginText, endText].map((text,index) => {
                    const before = index===0? true : false;
                    // 1b.1a. to insert text range
                    if (text instanceof TextChange && text.op.i) {
                        return this.applyInsertRangeWithDeleteChange(text, edit, before);
                    }
                    // 1b.1b. to delete text range
                    else if (text instanceof TextChange && text.op.d) {
                        return this.applyDeleteRangeWithDeleteChange(text, edit, before);
                    }
                    // 1b.1c. to interleaved range
                    else {
                        return this.applyInterleavedRangeWithDeleteChange(text, edit, before);
                    }
                });
                // 1b.2. extend `beginRemain` with intermediate text range if is instanceof `TextChange`
                if (beginRemain instanceof TextChange) {
                    //TODO: clip the intermediate text and append
                    //TODO: calculate the offset of position
                }
                // 1b.3. notify the removal or create text range
                [ [beginText,beginRemain], [endText,endRemain] ].map(([text,remain]) => {
                    if (text instanceof TextChange && remain instanceof ChangeRange) {
                        refreshes.push({id:text.change.id});
                    }
                    if (text instanceof ChangeRange && remain instanceof TextChange) {
                        refreshes.push({id:remain.change.id, type:'deleteChange'});
                    }
                });
                // 1b.4. merge the remains of `begin` and `end` text ranges, if they are the same type (FIXME: need double check for tcId condition)
                if (beginRemain instanceof TextChange && endRemain instanceof TextChange && beginRemain.isInsert===endRemain.isInsert) {
                    const oldRemain = beginRemain < endRemain? beginRemain : endRemain;
                    const newRemain = oldRemain===beginRemain? endRemain : beginRemain;
                    oldRemain.op.p = beginRemain.op.p;
                    if (oldRemain.isInsert) {
                        oldRemain.op.i = beginRemain.op.i! + endRemain.op.i!;                        
                        refreshes.push({id:oldRemain.change.id, type:'insertChange'});
                    } else {
                        oldRemain.op.d = beginRemain.op.d! + endRemain.op.d!;
                        refreshes.push({id:oldRemain.change.id, type:'deleteChange'});
                    }
                    //
                    this.wholeText.remove(newRemain);
                    refreshes.push({id:newRemain.change.id});
                }
                // 1b.5 remove intermediate text ranges
                this.wholeText.removeBetween(beginText, endText);
            }
            // 2. update position offset for the range after `end` (FIXME: need double check for tcId condition)
            this.wholeText.apply(endText, (text) => {
                text.op.p += edit.op.i!.length - edit.op.d!.length;
            });
        }
        return refreshes;
    }

    applyInsertRangeWithInsertChange(text: TextChange, edit: EditChange) {
        let items:{id:string, type?:ReviewDecorationType}[] = [];
        const editOffset = edit.begin - text.begin;
        // 1a.1a. insert with `tc` --> [extend text range]
        if (edit.change.id) {
            text.op.i = text.op.i!.slice(0, editOffset) + edit.op.i + text.op.i!.slice(editOffset);
            items.push({id:text.change.id, type:'insertChange'});
        }
        // 1a.1b. insert without `tc` within (begin,end) --> [clip text range and insert new change]
        else if (text.change.id===undefined && edit.begin<text.end && edit.begin>text.begin) {
            const [beforeText, afterText] = [text.op.i!.slice(0, editOffset), text.op.i!.slice(editOffset)];
            // clip the original change
            text.op.i = beforeText;
            items.push({id:text.change.id, type:'insertChange'});
            // insert new change
            const newId = generateTrackId();
            const newText = new TextChange({
                id: newId,
                op: { p: text.end + edit.op.i!.length, i: afterText },
                metadata: edit.change.metadata,
            });
            this.wholeText.insert(newText);
            items.push({id:newId, type:'insertChange'});
        }
        return items;
    }

    applyDeleteRangeWithInsertChange(text: TextChange, edit: EditChange) {
        let items:{id:string, type?:ReviewDecorationType}[] = [];
        // 1a.2a. insert with `tc` with exact same text --> remove text range
        if (edit.change?.id && text.op.d===edit.op.i) {
            items.push({id:text.change.id});
            this.wholeText.remove(text);
        }
        else {
            // 1a.2b. insert with `tc` --> create new change
            if (edit.change?.id) {
                this.wholeText.insert(new TextChange(edit.change));
                items.push({id:edit.change.id, type:'insertChange'});
            }
            // offset the position of the text range
            text.op.p += edit.op.i!.length;
        }
        return items;
    }

    applyInterleavedRangeWithInsertChange(text: ChangeRange, edit: EditChange) {
        let items:{id:string, type?:ReviewDecorationType}[] = [];
        // 1a.3a. insert with `tc` --> create new change
        if (edit.change?.id) {
            this.wholeText.insert(new TextChange(edit.change));
            items.push({id:edit.change.id, type:'insertChange'});
        }
        return items;
    }

    applyInsertRangeWithDeleteChange(text: EditChange, edit: EditChange, before:boolean) {
        // clip the text range
        if (before) {
            const offset = text.end - edit.begin;
            text.op.i = text.op.i!.slice(0, offset);
        } else {
            const offset = edit.end - text.begin;
            text.op.p -= offset;
            text.op.i = text.op.i!.slice(offset);
        }
        // return the remain text range if it's not empty
        if (text.op.i) {
            return text;
        } else {
            return new ChangeRange();
        }
    }

    applyDeleteRangeWithDeleteChange(text: EditChange, edit: EditChange, before:boolean) {
        // do nothing
        return text;
    }

    applyInterleavedRangeWithDeleteChange(text: ChangeRange, edit: EditChange, before:boolean) {
        // create new text range with `tc`
        if (edit.change?.id) {
            const offset = before? text.end-edit.begin : edit.end-text.begin;
            const newText = new TextChange({
                id: edit.change.id,
                op: {
                    p: before? text.end : text.begin+offset,
                    d: before? edit.op.d!.slice(0, offset) : edit.op.d!.slice(edit.op.d!.length-offset),
                },
                metadata: edit.change.metadata,
            });
            this.wholeText.insert(newText);
            return newText;
        }
        // else return empty range
        else {
            return new ChangeRange();
        }
    }
}

export class ReviewPanelProvider extends vscode.Disposable implements vscode.CodeLensProvider {
    private readonly reviewDecorations: {[id:string]: vscode.TextEditorDecorationType} = {};
    private reviewRecords: {[docId:string]: DocumentRangesSchema} = {};
    private reviewThreads: {[threadId:string]: CommentThreadSchema} = {};

    constructor(
        private readonly vfs: VirtualFileSystem,
        readonly context: vscode.ExtensionContext,
        private readonly socket: SocketIOAPI,
    ) {
        super(() => {
            // this.socket.disconnect();
        });
        // init review records
        this.vfs.getAllDocumentReviews().then((records) => {
            const {ranges,threads} = records!;
            this.reviewRecords = ranges;
            this.reviewThreads = threads;
            this.refreshReviewDecorations();
            this.registerEventHandlers();
        });
    }

    private registerEventHandlers() {
        this.socket.updateEventHandlers({
            onCommentThreadResolved: (threadId, userInfo) => {
                const thread = this.reviewThreads[threadId];
                if (thread) {
                    thread.resolved = true;
                    thread.resolved_by_user = userInfo;
                    thread.resolved_at = new Date().toISOString();
                    this.setReviewDecorations(undefined, thread.doc_id!, [{id:threadId, type:'resolvedComment'}]);
                }
            },
            onCommentThreadReopen: (threadId) => {
                const thread = this.reviewThreads[threadId];
                if (thread) {
                    thread.resolved = false;
                    thread.resolved_by_user = undefined;
                    thread.resolved_at = undefined;
                    this.setReviewDecorations(undefined, thread.doc_id!, [{id:threadId, type:'openComment'}]);
                }
            },
            onCommentThreadDeleted: (threadId) => {
                const thread = this.reviewThreads[threadId];
                if (thread) {
                    delete this.reviewThreads[threadId];
                    this.setReviewDecorations(undefined, thread.doc_id!, [{id:threadId}]);
                }
            },
            onCommentThreadMessageCreated: (threadId, message) => {
                const thread = this.reviewThreads[threadId];
                if (thread) {
                    // case 1: `otUpdateApplied` arrives first
                    thread.messages.push(message);
                    this.setReviewDecorations(undefined, thread.doc_id!, [{id:threadId, type:'openComment'}]);
                } else {
                    // case 2: `new-comment` arrives first
                    this.reviewThreads[threadId] = {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        doc_id: undefined, // fill in later
                        messages: [message],
                    };
                }
            },
            onCommentThreadMessageDeleted: (threadId, messageId) => {
                const thread = this.reviewThreads[threadId];
                if (thread) {
                    const index = thread.messages.findIndex((m) => m.id === messageId);
                    if (index !== -1) {
                        thread.messages.splice(index, 1);
                        this.setReviewDecorations(undefined, thread.doc_id!, [{id:threadId, type:'openComment'}]);
                    }
                }
            },
            onCommentThreadMessageEdited: (threadId, messageId, message) => {
                const thread = this.reviewThreads[threadId];
                if (thread) {
                    const index = thread.messages.findIndex((m) => m.id === messageId);
                    if (index !== -1) {
                        thread.messages[index].content = message;
                        this.setReviewDecorations(undefined, thread.doc_id!, [{id:threadId, type:'openComment'}]);
                    }
                }
            },
            onAcceptTrackChanges: (docId, tcIds) => {
                if (this.reviewRecords[docId].changes) {
                    this.reviewRecords[docId].changes = this.reviewRecords[docId].changes?.filter((c) => !tcIds.includes(c.id));
                    this.setReviewDecorations(undefined, docId, tcIds.map(id => {return {id};}));
                }
            },
            onFileChanged: (update) => {
                if (update.op) {
                    const ts = new Date(update.meta?.ts || new Date()).toISOString();
                    if (update.op[0].t !== undefined && update.op[0].c !== undefined) {
                        this.updateRecordComment(update, ts);
                    }
                    else {
                        this.updateRecordChange(update, ts);
                    }
                }
            },
        });
    }

    private updateRecordComment(update: UpdateSchema, ts: string) {
        if (!(update.op && update.op[0].t !== undefined && update.op[0].c !== undefined)) {
            return;
        }

        const docId = update.doc;
        const {p,c,t} = update.op[0];
        const userId = update.meta?.user_id || '';
        // create new comment thread if not exists
        if (this.reviewRecords[docId] === undefined) {
            this.reviewRecords[docId] = {comments: [], changes: []};
        }
        let comments = this.reviewRecords[docId]?.comments;
        if (comments === undefined) {
            comments = [];
            this.reviewRecords[docId].comments = comments;
        }
        // update review records' comments
        comments.push({
            id: t,
            op: {p,c,t},
            metadata: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                user_id: userId, ts,
            }
        });
        // update review threads with `doc_id`
        const thread = this.reviewThreads[t];
        if (thread) {
            // case 2: `new-comment` arrives first
            if (thread.doc_id === undefined) {
                thread.doc_id = docId;
                this.setReviewDecorations(undefined, docId, [{id:t, type:'openComment'}]);
            }
        } else {
            // case 1: `otUpdateApplied` arrives first
            this.reviewThreads[t] = {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                doc_id: docId,
                messages: [],
            };
        }
    }

    private updateRecordChange(update: UpdateSchema, ts: string) {
        const docId = update.doc;
        const userId = update.meta?.user_id || '';
        // create new changes array if not exists
        if (this.reviewRecords[docId] === undefined) {
            this.reviewRecords[docId] = {comments: [], changes: []};
        }
        let changes = this.reviewRecords[docId]?.changes;
        if (changes === undefined) {
            changes = [];
            this.reviewRecords[docId].changes = changes;
        }
        // update review records' changes
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const metadata = { user_id: userId, ts };
        const editManager = new EditManager(changes);
        const refreshes = editManager.generateRefreshes(update, metadata);
        this.reviewRecords[docId].changes = editManager.changes; // update changes
        // debounce refresh review decorations
        setTimeout(() => {
            this.setReviewDecorations(undefined, docId, refreshes);
        }, 100);
    }

    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        return [];
    }

    private setTextEditorDecoration(type: ReviewDecorationType, editor: vscode.TextEditor, range: vscode.DecorationOptions, contentText?: string): vscode.TextEditorDecorationType {
        const decorationOption = {
            ...reviewDecorationOptions[type],
            light: {gutterIconPath: this.context.asAbsolutePath(reviewDecorationOptions[type].light!.gutterIconPath as string)},
            dark: {gutterIconPath: this.context.asAbsolutePath(reviewDecorationOptions[type].dark!.gutterIconPath as string)},
        };

        // set `after` attachment
        let after = undefined;
        switch (type) {
            case 'openComment':
            case 'resolvedComment':
            case 'insertChange':
                break;
            case 'deleteChange':
                after = {
                    contentText: contentText,
                    textDecoration: 'line-through',
                    margin: '0 0 0 1em',
                    color: new vscode.ThemeColor('diffEditor.removedTextBackground'),
                };
                break;
        }

        const decoration = vscode.window.createTextEditorDecorationType({
            ...decorationOption,
            after,
        });
        editor.setDecorations(decoration, [range]);
        return decoration;
    }

    private async setReviewDecorations(editor: vscode.TextEditor | undefined, docId: string, updates: {id: string, type?: ReviewDecorationType}[]) {
        // find associated editor
        if (!editor) {
            editor = vscode.window.visibleTextEditors.filter(async editor => {
                const {fileType, fileId} = await this.vfs._resolveUri(editor.document.uri)!;
                return fileType === 'doc' && fileId === docId;
            }).pop()!;
        }
        if (editor.document.isDirty) { return; } // skip dirty document

        // add new decoration
        for (const update of updates) {
            // remove obsolete decoration
            const obsoleteDecoration = this.reviewDecorations[update.id];
            if (obsoleteDecoration) {
                obsoleteDecoration.dispose();
                delete this.reviewDecorations[update.id];
            }
            // add new decoration
            switch (update.type) {
                case 'openComment':
                case 'resolvedComment':
                    const comment = this.reviewRecords[docId]?.comments?.find((c) => c.id === update.id);
                    if (comment) {
                        const thread = comment.thread!;
                        const range = offsetToRange(editor.document, comment.op.p, comment.op.c);
                        const hoverMessage = genThreadMarkdownString(this.vfs._userId, comment.op.t, thread);
                        const newCommentDecoration = this.setTextEditorDecoration(update.type, editor, {range,hoverMessage});
                        this.reviewDecorations[update.id] = newCommentDecoration;
                    }
                    break;
                case 'insertChange':
                case 'deleteChange':
                    const change = this.reviewRecords[docId]?.changes?.find((c) => c.id === update.id);
                    if (change) {
                        const range = offsetToRange(editor.document, change.op.p, change.op.i || change.op.d!);
                        const newChangeDecoration = this.setTextEditorDecoration(update.type, editor, {range}, change.op.d);
                        this.reviewDecorations[update.id] = newChangeDecoration;
                        //TODO: provide action via code lens for `range`
                    }
                    break;
                default:
                    break;
            }
        }
    }

    private async refreshReviewDecorations() {
        const editor = vscode.window.activeTextEditor!;
        const {fileType, fileId} = await this.vfs._resolveUri(editor.document.uri)!;
        if (fileType !== 'doc' || fileId === undefined) { return; }

        // create new decorations for comments
        for (const comment of this.reviewRecords[fileId]?.comments || []) {
            const thread = comment.thread!;
            if (thread.resolved) {
                this.setReviewDecorations(editor, fileId, [{id:comment.op.t, type:'resolvedComment'}]);
            } else {
                this.setReviewDecorations(editor, fileId, [{id:comment.op.t, type:'openComment'}]);
            }
        }

        // create new decorations for changes
        for (const change of this.reviewRecords[fileId]?.changes || []) {
            const type = change.op.i ? 'insertChange' : 'deleteChange';
            this.setReviewDecorations(editor, fileId, [{id:change.id, type}]);
        }
    }

    get triggers() {
        return [
            // register self for socket disconnection
            this as vscode.Disposable,
            // register exposed commands
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.addComment`, async () => {
                const activeTextEditor = vscode.window.activeTextEditor!;
                const doc = (await this.vfs._resolveUri(activeTextEditor.document.uri)).fileEntity as DocumentEntity;
                const quotedRange = activeTextEditor.selection;
                const quotedOffset = activeTextEditor.document.offsetAt(quotedRange.start);
                const quotedText = activeTextEditor.document.getText(quotedRange);
                //
                let slideText = quotedText.replace(/\n/g, ' ').replace(/\s+/g, ' ');
                slideText = slideText.length<=30? slideText : slideText.replace(/^(.{15}).*(.{15})$/, '$1...$2');
                vscode.window.showInputBox({
                    title: vscode.l10n.t('Reply to comment'),
                    prompt: `Quoted text: "${slideText}"`,
                    placeHolder: vscode.l10n.t('Add your comment here'),
                }).then(async (content) => {
                    if (content) {
                        await this.vfs.createCommentThread(doc._id, generateTrackId(), quotedOffset, quotedText, content);
                    }
                });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.toggleTrackChanges`, async () => {
                this.vfs.trackChangesState = !this.vfs.trackChangesState;
            }),
            // register internal commands
            vscode.commands.registerCommand('reviewPanel.resolveComment', async (args: {threadId:string}) => {
                await this.vfs.resolveCommentThread(args.threadId);
            }),
            vscode.commands.registerCommand('reviewPanel.reopenComment', async (args: {threadId:string}) => {
                await this.vfs.reopenResolvedCommentThread(args.threadId);

            }),
            vscode.commands.registerCommand('reviewPanel.deleteComment', async (args: {docId:string,threadId:string}) => {
                await this.vfs.deleteResolvedCommentThread(args.docId, args.threadId);
            }),
            vscode.commands.registerCommand('reviewPanel.replyComment', async (args: {threadId:string}) => {
                vscode.window.showInputBox({
                    title: vscode.l10n.t('Reply to comment'),
                    prompt: `${this.reviewThreads[args.threadId].messages.at(-1)?.content}`,
                }).then(async (content) => {
                    if (content) {
                        await this.vfs.postCommentThreadMessage(args.threadId, content);
                    }
                });
            }),
            vscode.commands.registerCommand('reviewPanel.editCommentMessage', async (args: {threadId:string,messageId:string}) => {
                const originMessage = this.reviewThreads[args.threadId].messages.find((m) => m.id === args.messageId)?.content;
                vscode.window.showInputBox({
                    title: vscode.l10n.t('Edit your comment'),
                    value: originMessage,
                }).then(async (content) => {
                    if (content && content !== originMessage) {
                        await this.vfs.editCommentThreadMessage(args.threadId, args.messageId, content);
                    }
                });
            }),
            vscode.commands.registerCommand('reviewPanel.deleteCommentMessage', async (args: {threadId:string,messageId:string}) => {
                const res = await vscode.window.showWarningMessage(vscode.l10n.t('Are you sure to delete this comment?'), vscode.l10n.t('Delete'), vscode.l10n.t('Cancel'));
                if (res === vscode.l10n.t('Delete')) {
                    await this.vfs.deleteCommentThreadMessage(args.threadId, args.messageId);
                }
            }),
            // register event handlers
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                editor && this.refreshReviewDecorations();
            }),
            vscode.workspace.onDidSaveTextDocument((document) => {
                this.refreshReviewDecorations();
            }),
        ];
    }
}
