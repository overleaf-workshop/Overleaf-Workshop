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
const defaultWindow = withStubs({ createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
const vscodeMock = withStubs({
    window: defaultWindow,
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    workspace: withStubs({ textDocuments: [] }),
    l10n: { t: (message: string) => message },
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
const { SocketIOAPI } = require('../api/socketio');
const { GlobalStateManager } = require('../utils/globalStateManager');
const { CompileManager } = require('../compile/compileManager');
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
    // joinProject never settles unless a test says otherwise: most tests only check that
    // the project is rejoined, and on which socket
    const never = () => new Promise(() => {});
    function setup({ dead, join = never }: { dead: boolean, join?: () => Promise<any> }) {
        const handlers: any = {};
        const calls: string[] = [];
        const socket = {
            needsReinit: false,
            isDead: dead,
            isConnected: !dead,
            isUsingAlternativeConnectionScheme: false,
            init() { calls.push('init'); this.isDead = false; },
            updateEventHandlers(h: any) { calls.push('updateEventHandlers'); Object.assign(handlers, h); },
            joinProject() { calls.push('joinProject'); return join(); },
        };
        const vfs = Object.create(VirtualFileSystem.prototype);
        Object.assign(vfs, {
            socket, projectId: 'p1', serverName: 'test', notify: () => {},
            retryConnection: 0, lastDisconnectTime: 0, connections: [],
            handlersRegistered: false,
            backgroundAttempts: 0, singleAttempt: false,
            connectionLostOpen: false, offline: false, gaveUp: false, attemptCount: 0,
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

    it('does not count a rejoin as done when the project settings cannot be loaded (offline)', async () => {
        // Reproduces a 6-minute network outage: the v2 joinProject answered from the old
        // connection's record, the settings request failed, and the project counted as
        // joined -- so nothing reconnected it and every save timed out until a reload.
        let join = async () => ({ rootFolder: [{}] });
        const { vfs } = setup({ dead: false, join: () => join() });
        vfs.handlersRegistered = true;
        vfs.context = {};
        vfs.api = { getProjectSettings: async () => ({ type: 'error', message: 'fetch failed' }) };
        const authenticate = GlobalStateManager.authenticate;
        GlobalStateManager.authenticate = async () => ({});
        try {
            vfs.init().catch(() => {});
            await sleep(20);
            assert.strictEqual(vfs.root, undefined, 'a project without settings must not count as joined');
            assert.strictEqual(vfs.retryConnection, 1, 'the failed attempt must lead to another one');
            assert.strictEqual(vfs.getCompiler(), undefined);
        } finally {
            join = never as any;                    // end the retry loop
            GlobalStateManager.authenticate = authenticate;
        }
    });

    it('creates a new socket when a rejoin failed and socket.io has not brought the old one back', async function () {
        this.timeout(5000);
        const { vfs, socket, calls } = setup({ dead: false });
        vfs.handlersRegistered = true;
        socket.isConnected = false;                 // socket.io is still "reconnecting" it
        vfs.retryConnection = 2;                    // one rejoin on it already failed
        vfs.initializing = vfs.initializingPromise;
        vfs.initializing.catch(() => {});
        await sleep(2200);                          // 2 s backoff for the second attempt
        assert.deepStrictEqual(calls, ['init', 'joinProject']);
    });

    it('rejoins on a new socket when socket.io gives up reconnecting', async function () {
        this.timeout(5000);
        const { vfs, handlers, calls } = setup({ dead: false });
        vfs.init();
        await sleep(0);
        vfs.root = { rootFolder: [{}] };
        calls.length = 0;
        vfs.socket.isDead = true;                   // 'reconnect_failed': the socket is dead
        handlers.onReconnectFailed();
        await sleep(2300);                          // 1s scheduling delay + 1s backoff
        assert.deepStrictEqual(calls, ['init', 'joinProject']);
    });

    it('keeps trying in the background after the quick retries are spent', async () => {
        const { vfs, calls } = setup({ dead: false });
        vfs.handlersRegistered = true;
        const interval = VirtualFileSystem.backgroundReconnectMs;
        VirtualFileSystem.backgroundReconnectMs = 50;
        try {
            vfs.retryConnection = 5;                // all quick retries failed
            await vfs.init().then(
                () => assert.fail('init() must fail once the quick retries are spent'),
                (err: any) => assert.match(String(err), /Connection lost/));
            assert.ok(!calls.includes('joinProject'));
            await sleep(120);
            assert.deepStrictEqual(calls, ['joinProject'], 'a new round must start by itself');
        } finally {
            VirtualFileSystem.backgroundReconnectMs = interval;
        }
    });

    it('stops after the slow attempts, says so, and offers Retry again when the red item is clicked', async () => {
        const shown: string[] = [];
        const item: any = { show() {}, dispose() { item.disposed = true; } };
        vscodeMock.window = withStubs({
            showErrorMessage: (message: string) => { shown.push(message); return Promise.resolve(undefined); },
            createStatusBarItem: () => item,
        });
        const { vfs, calls } = setup({ dead: false, join: () => Promise.reject(new Error('offline')) });
        vfs.handlersRegistered = true;
        const interval = VirtualFileSystem.backgroundReconnectMs;
        const attempts = VirtualFileSystem.backgroundReconnectAttempts;
        VirtualFileSystem.backgroundReconnectMs = 20;
        const joins = () => calls.filter(c => c === 'joinProject').length;
        try {
            vfs.retryConnection = 5;                // the quick retries have failed
            await vfs.init().catch(() => {});
            assert.strictEqual(vfs.connectionStatus.state, 'reconnecting', 'reconnecting while slow attempts remain');
            await sleep(30);
            assert.strictEqual(vfs.connectionStatus.attempt, 1, 'with the attempt counter');
            await sleep(370);
            assert.strictEqual(joins(), attempts, `exactly ${attempts} slow attempts`);
            assert.strictEqual(vfs.connectionStatus.state, 'offline', 'offline (red) once all automatic attempts failed');
            assert.deepStrictEqual(shown, ['Connection lost: {serverName}'], 'the notification comes by itself');
            // the project was never joined here, so there is no collaboration item: our own one is red
            assert.match(item.text, /sync-ignored/);
            assert.strictEqual(item.color, 'red');
            assert.match(item.command, /remoteFileSystem\.reconnect$/);
            await vfs.init().then(
                () => assert.fail('init() must fail while waiting for Retry'),
                (err: any) => assert.match(String(err), /Not connected/));
            await sleep(100);
            assert.strictEqual(joins(), attempts, 'then nothing more until the user acts, file access included');
            vfs.onConnectionStatusClicked();        // the notification was closed; the red item brings it back
            assert.deepStrictEqual(shown, ['Connection lost: {serverName}', 'Connection lost: {serverName}']);
        } finally {
            VirtualFileSystem.backgroundReconnectMs = interval;
            vscodeMock.window = defaultWindow;
        }
    });

    it('shows its own status item only while there is no collaboration item (never two)', () => {
        let created = 0;
        const item: any = { show() {}, dispose() { item.disposed = true; } };
        vscodeMock.window = withStubs({ createStatusBarItem: () => { created += 1; return item; } });
        const { vfs } = setup({ dead: false });
        try {
            vfs.updateConnectionStatus('reconnecting');
            assert.strictEqual(created, 1, 'before the first join: own item');
            vfs.updateConnectionStatus('connected');
            assert.strictEqual(item.disposed, true, 'gone once joined');
            vfs.clientManagerItem = { triggers: [] };  // joined once: the collaboration item exists
            vfs.updateConnectionStatus('offline');
            assert.strictEqual(created, 1, 'the collaboration item shows it now');
        } finally {
            vscodeMock.window = defaultWindow;
        }
    });

    it('does not let file access restart the quick retries while offline', async () => {
        // Seen in a 20-minute outage: every stat/save after the quick retries started a new
        // round, the rounds ran back to back, the 30 s attempts were skipped as "a round is
        // running", and "Connection lost" never came again.
        const { vfs, calls } = setup({ dead: false, join: () => Promise.reject(new Error('offline')) });
        vfs.handlersRegistered = true;
        const interval = VirtualFileSystem.backgroundReconnectMs;
        VirtualFileSystem.backgroundReconnectMs = 100;
        const joins = () => calls.filter(c => c === 'joinProject').length;
        try {
            vfs.retryConnection = 5;                // the quick retries have failed
            await vfs.init().catch(() => {});
            for (let i = 0; i < 3; i++) {           // VS Code touching files meanwhile
                await vfs.init().then(
                    () => assert.fail('init() must fail while offline'),
                    (err: any) => assert.match(String(err), /Not connected/));
            }
            assert.strictEqual(joins(), 0, 'file access must not start attempts');
            await sleep(150);
            assert.strictEqual(joins(), 1, 'the timed attempt must still run');
        } finally {
            VirtualFileSystem.backgroundReconnectMs = interval;
            if (vfs.backgroundRetryTimer) { clearTimeout(vfs.backgroundRetryTimer); }
        }
    });

    it('starts over when the user picks Retry after giving up', async () => {
        let release!: (choice: string | undefined) => void;
        vscodeMock.window = withStubs({
            showErrorMessage: () => new Promise(resolve => { release = resolve; }),
        });
        let join = () => Promise.reject(new Error('offline'));
        const { vfs, calls } = setup({ dead: false, join: () => join() });
        vfs.handlersRegistered = true;
        const attempts = VirtualFileSystem.backgroundReconnectAttempts;
        try {
            vfs.retryConnection = 5;
            vfs.backgroundAttempts = attempts;      // the slow attempts are spent too
            await vfs.init().catch(() => {});
            assert.strictEqual(vfs.gaveUp, true);
            calls.length = 0;
            join = never as any;                    // the network is back (the join is pending)
            release('Retry');                       // in the notification shown on giving up
            await sleep(0);
            assert.deepStrictEqual(calls, ['init', 'joinProject'], 'Retry must rejoin on a new socket');
            assert.strictEqual(vfs.offline, false);
        } finally {
            vscodeMock.window = defaultWindow;
        }
    });
});

describe('CompileManager.compile', () => {
    // After a reconnect the editors may hold anything (an empty document after a revert
    // while offline): the compile that follows must not upload them by saving first.
    async function compileSaves(...args: any[]) {
        let saved = 0;
        const saveAll = vscodeMock.workspace.saveAll;
        vscodeMock.workspace.saveAll = async () => { saved += 1; };
        try {
            const manager = Object.assign(Object.create(CompileManager.prototype), {
                inCompiling: false,
                update: async () => undefined,      // no .tex file to compile: stop there
            });
            await manager.compile(...args);
        } finally {
            vscodeMock.workspace.saveAll = saveAll;
        }
        return saved > 0;
    }

    it('saves the editors first by default (Ctrl+S, the compile button)', async () => {
        assert.strictEqual(await compileSaves(true), true);
    });
    it('does not save when asked not to (the compile after a reconnect)', async () => {
        assert.strictEqual(await compileSaves(true, false), false);
    });
});

describe('SocketIOAPI v2 project record', () => {
    function v2api() {
        const listeners: Record<string, Array<(...args: any[]) => void>> = {};
        const socket = { on(event: string, fn: any) { (listeners[event] ??= []).push(fn); } };
        const api = Object.assign(Object.create(SocketIOAPI.prototype), { scheme: 'v2', socket, _handlers: [] });
        api.initInternalHandlers();
        const fire = (event: string, ...args: any[]) => (listeners[event] || []).forEach(fn => fn(...args));
        return { api, fire };
    }

    it('joinProject answers with the current connection\'s project, not an earlier one\'s', async () => {
        const { api, fire } = v2api();
        fire('joinProjectResponse', { publicId: 'c1', project: { name: 'first' } });
        assert.strictEqual((await api.joinProject('p1')).name, 'first');

        fire('disconnect', 'transport close');
        let joined: any;
        api.joinProject('p1').then((p: any) => { joined = p; }, () => { joined = 'rejected'; });
        await sleep(20);
        assert.strictEqual(joined, undefined, 'must wait for the next connection, not reuse the old project');

        fire('joinProjectResponse', { publicId: 'c2', project: { name: 'second' } });
        await sleep(0);
        assert.strictEqual((joined as any).name, 'second');
    });

    it('a reconnect that happens before anyone asks still updates the record', async () => {
        const { api, fire } = v2api();
        fire('joinProjectResponse', { publicId: 'c1', project: { name: 'first' } });
        fire('disconnect', 'transport close');
        fire('joinProjectResponse', { publicId: 'c2', project: { name: 'second' } });
        assert.strictEqual((await api.joinProject('p1')).name, 'second');
    });
});

describe('VirtualFileSystem settings', () => {
    it('getCompiler and getSpellCheckLanguage do not throw before the settings are loaded', () => {
        const vfs = Object.create(VirtualFileSystem.prototype);
        vfs.root = { compiler: 'pdflatex', spellCheckLanguage: 'en' };
        assert.strictEqual(vfs.getCompiler(), undefined);
        assert.strictEqual(vfs.getSpellCheckLanguage(), undefined);
        assert.strictEqual(vfs.getAllCompilers(), undefined);
    });
});
