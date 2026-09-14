/**
 * Login via a real browser controlled through the Chrome DevTools Protocol.
 *
 * A Chromium-based browser (Chrome, Edge, Brave, Chromium) is launched with a
 * dedicated user profile and the server's login page. The user signs in as
 * usual (email/password, SSO, captcha all work since the page runs on the
 * real domain). As soon as the browser reaches `/project`, which only renders
 * for logged-in users, the session cookies are read through CDP and the
 * browser is closed. The cookies are then fed into the regular cookie login.
 *
 * CDP is spoken over `--remote-debugging-pipe` (file descriptors 3/4), so no
 * debugging port is ever opened.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';

const SESSION_COOKIE_NAMES = ['overleaf_session2', 'sharelatex.sid'];

interface CdpCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
}

export class BrowserNotFoundError extends Error {
    constructor() {
        super('No Chromium-based browser (Chrome, Edge, Brave or Chromium) was found.');
        this.name = 'BrowserNotFoundError';
    }
}

export class LoginCancelledError extends Error {
    constructor() {
        super('The browser was closed before the login completed.');
        this.name = 'LoginCancelledError';
    }
}

/** Locate a Chromium-based browser executable. */
export function findBrowserExecutable(configuredPath?: string): string | undefined {
    if (configuredPath) {
        return fs.existsSync(configuredPath) ? configuredPath : undefined;
    }

    const candidates: string[] = [];
    const home = os.homedir();
    switch (process.platform) {
        case 'win32': {
            const roots = [
                process.env['PROGRAMFILES'],
                process.env['PROGRAMFILES(X86)'],
                process.env['LOCALAPPDATA'],
            ].filter((root): root is string => !!root);
            for (const root of roots) {
                candidates.push(
                    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                    path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
                    path.join(root, 'Chromium', 'Application', 'chrome.exe'),
                );
            }
            break;
        }
        case 'darwin': {
            for (const root of ['/Applications', path.join(home, 'Applications')]) {
                candidates.push(
                    path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
                    path.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
                    path.join(root, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
                    path.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                );
            }
            break;
        }
        default: {
            const names = [
                'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable',
                'brave-browser', 'chromium', 'chromium-browser',
            ];
            const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(dir => dir);
            for (const name of names) {
                for (const dir of dirs) {
                    candidates.push(path.join(dir, name));
                }
            }
            break;
        }
    }
    return candidates.find(candidate => fs.existsSync(candidate));
}

/** Minimal JSON-RPC client for the DevTools Protocol over the debugging pipe. */
class CdpPipeClient {
    private nextId = 1;
    private buffer = Buffer.alloc(0);
    private readonly pending = new Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>();
    private readonly eventEmitter = new vscode.EventEmitter<{ method: string, params: any }>();
    readonly onEvent = this.eventEmitter.event;

    constructor(private readonly input: Writable, output: Readable) {
        output.on('data', (chunk: Buffer) => this.onData(chunk));
    }

    send(method: string, params?: object): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.input.write(JSON.stringify({ id, method, params: params ?? {} }) + '\0', error => {
                if (error) {
                    this.pending.delete(id);
                    reject(error);
                }
            });
        });
    }

    dispose(error: Error) {
        this.pending.forEach(entry => entry.reject(error));
        this.pending.clear();
        this.eventEmitter.dispose();
    }

    private onData(chunk: Buffer) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let end = this.buffer.indexOf(0);
        while (end >= 0) {
            const raw = this.buffer.subarray(0, end).toString('utf8');
            this.buffer = this.buffer.subarray(end + 1);
            try {
                this.dispatch(JSON.parse(raw));
            } catch (error) {
                console.error(`[BrowserLogin] malformed CDP message: ${raw.slice(0, 200)}`);
            }
            end = this.buffer.indexOf(0);
        }
    }

    private dispatch(message: any) {
        if (message.id !== undefined) {
            const entry = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (entry === undefined) { return; }
            if (message.error) {
                entry.reject(new Error(message.error.message ?? 'CDP error'));
            } else {
                entry.resolve(message.result);
            }
        } else if (message.method) {
            this.eventEmitter.fire({ method: message.method, params: message.params });
        }
    }
}

export interface BrowserLoginOptions {
    /** Explicit browser executable, otherwise auto-detected. */
    executablePath?: string;
    /** Directory holding the dedicated browser profile. */
    profileDir: string;
    /** Cancellation from the UI (e.g. progress notification). */
    token?: vscode.CancellationToken;
}

/**
 * Run the login flow in a browser and resolve with the `Cookie` header value
 * of the server once the user is logged in.
 */
export async function loginWithBrowser(serverUrl: string, options: BrowserLoginOptions): Promise<string> {
    const target = new URL(serverUrl);
    const executable = findBrowserExecutable(options.executablePath);
    if (executable === undefined) {
        throw new BrowserNotFoundError();
    }
    await fs.promises.mkdir(options.profileDir, { recursive: true });

    const child = spawn(executable, [
        '--remote-debugging-pipe',
        `--user-data-dir=${options.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--new-window',
        new URL('/login', target.origin).toString(),
    ], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const session = new BrowserSession(child, target);
    const cancellation = options.token?.onCancellationRequested(() => session.cancel());
    try {
        return await session.waitForLogin();
    } finally {
        cancellation?.dispose();
        await session.close();
    }
}

class BrowserSession {
    private readonly cdp: CdpPipeClient;
    private exited = false;
    private readonly exitPromise: Promise<void>;

    constructor(private readonly child: ChildProcess, private readonly target: URL) {
        this.cdp = new CdpPipeClient(child.stdio[3] as Writable, child.stdio[4] as Readable);
        child.on('error', error => console.error(`[BrowserLogin] browser process error: ${error.message}`));
        this.exitPromise = new Promise<void>(resolve => {
            child.once('exit', () => {
                this.exited = true;
                this.cdp.dispose(new LoginCancelledError());
                resolve();
            });
        });
    }

    async waitForLogin(): Promise<string> {
        const loggedIn = new Promise<void>((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('exit', () => reject(new LoginCancelledError()));
            if (this.exited) { reject(new LoginCancelledError()); }
            this.cdp.onEvent(({ method, params }) => {
                if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
                    if (this.isProjectPage(params?.targetInfo)) {
                        resolve();
                    }
                }
            });
        });

        // avoid an unhandled rejection if the command below fails first
        loggedIn.catch(() => { /* handled below */ });
        // `targetCreated` is replayed for existing targets once discovery is enabled
        await Promise.race([this.cdp.send('Target.setDiscoverTargets', { discover: true }), loggedIn]);
        await loggedIn;

        const { cookies } = await this.cdp.send('Storage.getCookies') as { cookies: CdpCookie[] };
        const header = BrowserSession.cookieHeader(cookies, this.target.hostname);
        if (!SESSION_COOKIE_NAMES.some(name => header.includes(`${name}=`))) {
            throw new Error('No session cookie found after login.');
        }
        return header;
    }

    cancel() {
        this.close().catch(() => { /* ignore */ });
    }

    async close() {
        if (this.exited) { return; }
        // ask the browser to quit gracefully, kill it if it does not comply
        const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
        try {
            await Promise.race([this.cdp.send('Browser.close'), timeout]);
        } catch {
            // connection already gone
        }
        await Promise.race([this.exitPromise, timeout]);
        if (!this.exited) {
            this.child.kill();
        }
    }

    private isProjectPage(targetInfo?: { type?: string, url?: string }) {
        if (targetInfo?.type !== 'page' || !targetInfo.url) { return false; }
        let url: URL;
        try {
            url = new URL(targetInfo.url);
        } catch {
            return false;
        }
        return url.origin === this.target.origin && url.pathname.replace(/\/+$/, '') === '/project';
    }

    private static cookieHeader(cookies: CdpCookie[], host: string) {
        const _host = host.toLowerCase();
        const now = Date.now() / 1000;
        return cookies
            .filter(cookie => cookie.expires < 0 || cookie.expires === undefined || cookie.expires > now)
            .filter(cookie => {
                const domain = cookie.domain.toLowerCase();
                return domain.startsWith('.')
                    ? (_host === domain.slice(1) || _host.endsWith(domain))
                    : _host === domain;
            })
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
    }
}
