/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import Module = require('module');

// The VFS imports 'vscode', which only exists inside the extension host. Serve the few
// parts that openFile touches.
class FileSystemError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
    static FileNotFound(message?: any) { return new FileSystemError(String(message), 'FileNotFound'); }
    static FileIsADirectory(message?: any) { return new FileSystemError(String(message), 'FileIsADirectory'); }
    static Unavailable(message?: any) { return new FileSystemError(String(message), 'Unavailable'); }
}
/** Stands in for anything else: callable, constructible, and every member is one again. */
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
    TreeItem: class {},
    FileSystemError,
    workspace: withStubs({ getConfiguration: () => ({ get: (_key: string, value: any) => value }) }),
    l10n: { t: (message: string) => message },
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { BaseAPI } = require('../api/base');
const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
moduleAny._load = originalLoad;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Serve `handlers` in turn, one per request, and return the base URL. */
async function serve(handlers: Handler[]): Promise<{url: string, requests: () => number, close: () => void}> {
    let count = 0;
    const server = http.createServer((req, res) => {
        const handler = handlers[Math.min(count, handlers.length-1)];
        count += 1;
        handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/`,
        requests: () => count,
        close: () => { server.closeAllConnections(); server.close(); },
    };
}

const identity = { cookies: 'session=1', csrfToken: 'token' };
const content = Buffer.from('\x89PNG binary content');

describe('BaseAPI.getFile', () => {
    const timeout = BaseAPI.downloadIdleTimeoutMs;
    after(() => { BaseAPI.downloadIdleTimeoutMs = timeout; });

    it('returns the file content for a 200 answer', async () => {
        const server = await serve([(_req, res) => { res.writeHead(200); res.end(content); }]);
        try {
            const res = await new BaseAPI(server.url).getFile(identity, 'p', 'f');
            assert.strictEqual(res.type, 'success');
            assert.deepStrictEqual(Buffer.from(res.content), content);
        } finally { server.close(); }
    });

    it('reports an error for a 404 instead of an empty file', async () => {
        const server = await serve([(_req, res) => { res.writeHead(404); res.end('Not found'); }]);
        try {
            const res = await new BaseAPI(server.url).getFile(identity, 'p', 'f');
            assert.strictEqual(res.type, 'error');
            assert.strictEqual(res.content, undefined);
            assert.match(res.message, /HTTP 404/);
            assert.strictEqual(server.requests(), 1, 'a 404 is not retried');
        } finally { server.close(); }
    });

    it('reports an error for a redirect, e.g. to the login page', async () => {
        const server = await serve([(_req, res) => { res.writeHead(302, {Location: '/login'}); res.end(); }]);
        try {
            const res = await new BaseAPI(server.url).getFile(identity, 'p', 'f');
            assert.strictEqual(res.type, 'error');
            assert.match(res.message, /HTTP 302/);
        } finally { server.close(); }
    });

    it('retries a transient server error', async () => {
        const server = await serve([
            (_req, res) => { res.writeHead(503); res.end('busy'); },
            (_req, res) => { res.writeHead(200); res.end(content); },
        ]);
        try {
            const res = await new BaseAPI(server.url).getFile(identity, 'p', 'f');
            assert.strictEqual(res.type, 'success');
            assert.deepStrictEqual(Buffer.from(res.content), content);
            assert.strictEqual(server.requests(), 2);
        } finally { server.close(); }
    }).timeout(10000);

    it('gives up when the server stops sending the body', async () => {
        BaseAPI.downloadIdleTimeoutMs = 200;
        const server = await serve([(_req, res) => {
            res.writeHead(200, {'Content-Length': String(content.length * 2)});
            res.write(content); // and never the rest
        }]);
        try {
            const res = await new BaseAPI(server.url).getFile(identity, 'p', 'f');
            assert.strictEqual(res.type, 'error');
        } finally {
            server.close();
            BaseAPI.downloadIdleTimeoutMs = timeout;
        }
    }).timeout(20000);
});

describe('VirtualFileSystem.openFile', () => {
    // Call openFile on a stand-in for the VFS: only the members it reads are needed.
    function fakeVfs(fileType: string, getFile: () => Promise<any>) {
        return {
            serverName: 'server', projectId: 'p',
            context: { globalState: { get: () => ({ server: { login: { identity } } }) } },
            api: { getFile },
            _resolveUri: async () => ({ fileType, fileEntity: { _id: 'f', name: 'picture.png' } }),
        };
    }
    const uri = { path: '/project/picture.png', toString: () => 'overleaf-workshop://server/project/picture.png' };

    it('throws when the download fails, instead of returning an empty file', async () => {
        const vfs = fakeVfs('file', async () => ({ type: 'error', message: 'HTTP 500' }));
        await assert.rejects(VirtualFileSystem.prototype.openFile.call(vfs, uri),
            (error: any) => error.code==='Unavailable' && /HTTP 500/.test(error.message));
    });

    it('returns the content of a successful download', async () => {
        const vfs = fakeVfs('file', async () => ({ type: 'success', content: new Uint8Array(content) }));
        const res = await VirtualFileSystem.prototype.openFile.call(vfs, uri);
        assert.deepStrictEqual(Buffer.from(res), content);
    });

    it('throws for a folder', async () => {
        const vfs = fakeVfs('folder', async () => assert.fail('a folder is not downloaded'));
        await assert.rejects(VirtualFileSystem.prototype.openFile.call(vfs, uri),
            (error: any) => error.code==='FileIsADirectory');
    });
});
