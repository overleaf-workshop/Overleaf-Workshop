import * as assert from 'assert';
import { createOtUpdate, mergeLocalChanges } from '../core/otUpdate';

function applyUpdate(content: string, op: NonNullable<ReturnType<typeof createOtUpdate>['op']>): string {
    let result = content;
    for (const part of op) {
        if (part.i !== undefined) {
            result = result.slice(0, part.p) + part.i + result.slice(part.p);
        } else if (part.d !== undefined) {
            result = result.slice(0, part.p) + result.slice(part.p + part.d.length);
        }
    }
    return result;
}

describe('reliable Overleaf writes', () => {
    it('preserves remote edits when applying a local save', () => {
        const base = 'first\nsecond\n';
        const remote = 'remote\nfirst\nsecond\n';
        const requested = 'first\nsecond changed\n';

        assert.strictEqual(mergeLocalChanges(base, remote, requested), 'remote\nfirst\nsecond changed\n');
    });

    it('builds an OT update that reproduces the requested content', () => {
        const remote = 'alpha\nbeta\ngamma\n';
        const requested = 'alpha\ninserted\ngamma changed\n';
        const update = createOtUpdate('doc-id', 17, remote, requested);

        assert.strictEqual(update.doc, 'doc-id');
        assert.strictEqual(update.v, 17);
        assert.ok(update.hash);
        assert.strictEqual(applyUpdate(remote, update.op || []), requested);
    });
});
