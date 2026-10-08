import * as crypto from 'crypto';
import * as DiffMatchPatch from 'diff-match-patch';
import { UpdateSchema } from '../api/socketio';

export function mergeLocalChanges(baseContent: string, remoteContent: string, requestedContent: string): string {
    const dmp = new DiffMatchPatch();
    const remoteChanges = dmp.patch_make(baseContent, remoteContent);
    return dmp.patch_apply(remoteChanges, requestedContent)[0] as string;
}

export function createOtUpdate(docId: string, version: number, remoteContent: string, content: string): UpdateSchema {
    const dmp = new DiffMatchPatch();
    let currentPos = 0;
    const op = dmp.diff_main(remoteContent, content)
        .map((part) => {
            const incCount = part[0] === -1 ? 0 : part[1].length;
            currentPos += incCount;
            if (part[0] === 0) {
                return undefined;
            }
            return {
                p: currentPos - incCount,
                i: part[0] === 1 ? part[1] : undefined,
                d: part[0] === -1 ? part[1] : undefined,
            };
        })
        .filter((part) => part !== undefined) as NonNullable<UpdateSchema['op']>;

    return {
        doc: docId,
        v: version,
        hash: crypto.createHash('sha1').update(`blob ${content.length}\x00${content}`).digest('hex'),
        op,
    };
}
