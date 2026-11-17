/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and class export names */
import * as assert from 'assert';
import Module = require('module');

// The modules under test import 'vscode', which only exists inside the extension host.
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('socket.io-client 0.9 (the library the extension is built on)', () => {
    // Pins down the behaviour the reconnect logic has to compensate for.
    function connectedSocket() {
        const io = require('socket.io-client');
        const s = Object.create(io.Socket.prototype);
        Object.assign(s, {
            connected: true, connecting: false, open: true, reconnecting: false,
            options: { reconnect: true },
            transport: { close() {}, clearTimeouts() {} },
            onClose() {}, publish() {},
            reconnectCalls: 0,
        });
        s.reconnect = () => { s.reconnectCalls += 1; };
        return s;
    }

    it('does not auto-reconnect when the server closes the connection', () => {
        const s = connectedSocket();
        s.onDisconnect('booted');
        assert.strictEqual(s.reconnectCalls, 0);
    });

    it('does auto-reconnect after a transport failure', () => {
        const s = connectedSocket();
        s.onDisconnect('error');
        assert.strictEqual(s.reconnectCalls, 1);
    });
});

describe('SocketIOAPI.isDead', () => {
    const api = (state: any) => Object.assign(Object.create(SocketIOAPI.prototype), { socket: { socket: state } });

    it('is true when the connection is down and nothing is reconnecting it', () => {
        assert.strictEqual(api({ connected: false, connecting: false, reconnecting: false }).isDead, true);
    });
    it('is false while socket.io is reconnecting by itself', () => {
        assert.strictEqual(api({ connected: false, connecting: false, reconnecting: true }).isDead, false);
        assert.strictEqual(api({ connected: false, connecting: true, reconnecting: false }).isDead, false);
    });
    it('is false while connected', () => {
        assert.strictEqual(api({ connected: true, connecting: false, reconnecting: false }).isDead, false);
    });
});

describe('VirtualFileSystem reconnect', () => {
    function setup({ dead }: { dead: boolean }) {
        const handlers: any = {};
        const calls: string[] = [];
        const socket = {
            needsReinit: false,
            isDead: dead,
            isUsingAlternativeConnectionScheme: false,
            init() { calls.push('init'); this.isDead = false; },
            updateEventHandlers(h: any) { calls.push('updateEventHandlers'); Object.assign(handlers, h); },
            // never settles: the tests only check that the project is rejoined, and on which socket
            joinProject() { calls.push('joinProject'); return new Promise(() => {}); },
        };
        const vfs = Object.create(VirtualFileSystem.prototype);
        Object.assign(vfs, {
            socket, projectId: 'p1', serverName: 'test', notify: () => {},
            retryConnection: 0, lastDisconnectTime: 0, connections: [],
            handlersRegistered: false, reconnectingNotification: false,
        });
        return { vfs, socket, handlers, calls };
    }

    it('creates a new socket before rejoining when the server closed the old one', async () => {
        const { vfs, calls } = setup({ dead: false });
        vfs.init();                                 // first connect registers the handlers
        await sleep(0);
        vfs.root = { rootFolder: [{}] };            // connected and joined
        calls.length = 0;
        vfs.socket.isDead = true;                   // server closed the connection ("booted")
        vfs.root = undefined; vfs.initializing = undefined;
        vfs.init();
        await sleep(0);
        assert.deepStrictEqual(calls, ['init', 'joinProject'],
            'must create a new socket, and must not register the handlers a second time');
    });

    it('keeps the socket while socket.io is reconnecting it (no needless new TCP connection)', async () => {
        const { vfs, calls } = setup({ dead: false });
        vfs.init();
        await sleep(0);
        assert.ok(!calls.includes('init'));
        assert.ok(calls.includes('joinProject'));
    });

    it('still rejoins the project after a debounced disconnect and a quick reconnect', async function () {
        this.timeout(5000);
        const { vfs, handlers, calls } = setup({ dead: false });
        vfs.init();
        await sleep(0);
        vfs.root = { rootFolder: [{}] };
        calls.length = 0;

        handlers.onDisconnected();                  // the server drops the connection...
        handlers.onDisconnected();                  // ...and the event fires twice (debounced)
        handlers.onConnectionAccepted('conn2');     // socket.io reconnects within the second
        await sleep(2300);                          // 1s scheduling delay + 1s backoff

        assert.deepStrictEqual(calls, ['joinProject'],
            'the new connection must join the project again, exactly once');
    });
});
