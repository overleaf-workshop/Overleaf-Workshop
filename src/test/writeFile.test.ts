/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and class export names */
import * as assert from 'assert';
import Module = require('module');

// The modules under test import 'vscode', which only exists inside the extension host.
// Serve a minimal stand-in so the save path can be driven from plain Node.
function stub(): any {
    const f: any = function () { return stub(); };
    return new Proxy(f, {
        get(target, key) {
            if (key === 'then') { return undefined; }
            if (!(key in target)) { target[key] = stub(); }
            return target[key];
        },
        construct() { return stub(); },
    });
}
const withStubs = (target: any): any => new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : stub()),
});
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    workspace: withStubs({ textDocuments: [] }),
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
const { SocketIOAPI } = require('../api/socketio');
moduleAny._load = originalLoad;

/**
 * A fake real-time service that behaves like overleaf/overleaf `services/real-time`:
 * the emit callback fires once the update is queued, the op-less `otUpdateApplied`
 * ack for the author comes later (delivered by the test via `deliverAcks`), and an
 * update at a stale version is never acknowledged.
 */
function setup(initialContent: string, initialVersion: number) {
    const server = { content: initialContent, v: initialVersion, joins: 0, emitted: 0 };
    const acks: {doc: string, v: number}[] = [];
    const handlers: any = {};
    const socket = {
        updateEventHandlers(h: any) { Object.assign(handlers, h); },
        async joinDoc() {
            server.joins += 1;
            return { docLines: server.content.split('\n'), version: server.v };
        },
        async applyOtUpdate(docId: string, update: any) {
            server.emitted += 1;
            if (update.v !== server.v) {
                throw new Error(`'applyOtUpdate' timed out`);
            }
            let content = server.content;
            for (const op of update.op) {
                if (op.i) { content = content.slice(0, op.p) + op.i + content.slice(op.p); }
                else if (op.d) { content = content.slice(0, op.p) + content.slice(op.p + op.d.length); }
            }
            acks.push({ doc: docId, v: server.v });
            server.content = content;
            server.v += 1;
        },
    };

    const doc: any = { _id: 'doc1', name: 'main.tex' };
    const uri: any = { toString: () => 'overleaf-workshop://test/main.tex' };
    const vfs = Object.create(VirtualFileSystem.prototype);
    vfs.socket = socket;
    vfs.notify = () => {};
    vfs._resolveUri = async () => ({ fileType: 'doc', fileEntity: doc });
    vfs._resolveById = () => ({ path: '/main.tex', fileEntity: doc });
    vfs.pathToUri = () => uri;
    vfs.remoteWatch();

    return {
        server, doc,
        open: () => vfs.openFile(uri),
        save: (text: string) => vfs.writeFile(uri, new TextEncoder().encode(text), false, true),
        deliverAcks: () => { acks.splice(0).forEach(ack => handlers.onFileChanged(ack)); },
    };
}

describe('VirtualFileSystem.writeFile', () => {
    it('keeps saving when the server never sends the author its ack', async () => {
        const t = setup('hello', 10);
        await t.open();
        for (const text of ['hello a', 'hello a b', 'hello a b c']) {
            await t.save(text);
            assert.strictEqual(t.server.content, text);
        }
        assert.strictEqual(t.doc.version, 13);
    });

    it('keeps saving after the late op-less ack of its own update arrives', async () => {
        const t = setup('hello', 10);
        await t.open();
        for (const text of ['hello a', 'hello a b', 'hello a b c']) {
            await t.save(text);
            t.deliverAcks();
            assert.notStrictEqual(t.doc.remoteCache, undefined, 'ack must not drop the caches');
            assert.strictEqual(t.server.content, text);
        }
        assert.strictEqual(t.doc.version, 13);
    });

    it('re-joins the doc and retries once when the version has drifted', async () => {
        const t = setup('hello', 10);
        await t.open();
        t.server.v = 12;
        await t.save('hello again');
        assert.strictEqual(t.server.content, 'hello again');
        assert.strictEqual(t.server.joins, 2);
        assert.strictEqual(t.doc.version, 13);
    });
});

describe('SocketIOAPI.applyOtUpdate', () => {
    it('does not emit an update that carries no ops', async () => {
        const emitted: any[] = [];
        const api = Object.create(SocketIOAPI.prototype);
        api.emit = async (...args: any[]) => { emitted.push(args); return []; };

        await api.applyOtUpdate('doc1', { doc: 'doc1', v: 1, op: [] });
        assert.strictEqual(emitted.length, 0);

        await api.applyOtUpdate('doc1', { doc: 'doc1', v: 1, op: [{ p: 0, i: 'x' }] });
        assert.strictEqual(emitted.length, 1);
    });
});
