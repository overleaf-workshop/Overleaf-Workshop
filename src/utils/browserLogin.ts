/**
 * Login via a real browser controlled through a remote debugging protocol.
 *
 * A browser installed on the machine is launched with a dedicated user
 * profile and the server's login page. The user signs in as usual
 * (email/password, SSO, captcha all work since the page runs on the real
 * domain). As soon as the browser reaches `/project`, which only renders for
 * logged-in users, the session cookies are read through the debugging
 * protocol and the browser is closed. The cookies are then fed into the
 * regular cookie login.
 *
 * Supported browsers, in order of preference:
 * - Chromium-based (Chrome, Edge, Brave, Chromium): Chrome DevTools Protocol
 *   over `--remote-debugging-pipe` (file descriptors 3/4), so no debugging
 *   port is ever opened.
 * - Firefox: WebDriver BiDi over a WebSocket bound to `127.0.0.1`.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { WebSocket } from 'undici';

const SESSION_COOKIE_NAMES = ['overleaf_session2', 'sharelatex.sid'];
const BROWSER_STARTUP_TIMEOUT_MS = 30_000;
const BROWSER_CLOSE_TIMEOUT_MS = 3_000;

export type BrowserKind = 'chromium' | 'firefox';

export interface BrowserExecutable {
    path: string;
    kind: BrowserKind;
}

interface Cookie {
    name: string;
    value: string;
    domain: string;
    expires?: number;
}

export class BrowserNotFoundError extends Error {
    constructor() {
        super('No supported browser (Chrome, Edge, Brave, Chromium or Firefox) was found.');
        this.name = 'BrowserNotFoundError';
    }
}

export class LoginCancelledError extends Error {
    constructor() {
        super('The browser was closed before the login completed.');
        this.name = 'LoginCancelledError';
    }
}

/**
 * Locate a supported browser executable. Chromium-based browsers are
 * preferred, Firefox is used as fallback.
 */
export function findBrowserExecutable(configuredPath?: string): BrowserExecutable | undefined {
    if (configuredPath) {
        if (!fs.existsSync(configuredPath)) { return undefined; }
        const kind: BrowserKind = path.basename(configuredPath).toLowerCase().includes('firefox') ? 'firefox' : 'chromium';
        return { path: configuredPath, kind };
    }

    const chromium: string[] = [];
    const firefox: string[] = [];
    const home = os.homedir();
    switch (process.platform) {
        case 'win32': {
            const roots = [
                process.env['PROGRAMFILES'],
                process.env['PROGRAMFILES(X86)'],
                process.env['LOCALAPPDATA'],
            ].filter((root): root is string => !!root);
            for (const root of roots) {
                chromium.push(
                    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                    path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
                    path.join(root, 'Chromium', 'Application', 'chrome.exe'),
                );
                firefox.push(path.join(root, 'Mozilla Firefox', 'firefox.exe'));
            }
            break;
        }
        case 'darwin': {
            for (const root of ['/Applications', path.join(home, 'Applications')]) {
                chromium.push(
                    path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
                    path.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
                    path.join(root, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
                    path.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                );
                firefox.push(path.join(root, 'Firefox.app', 'Contents', 'MacOS', 'firefox'));
            }
            break;
        }
        default: {
            const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(dir => dir);
            const chromiumNames = [
                'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable',
                'brave-browser', 'chromium', 'chromium-browser',
            ];
            const firefoxNames = ['firefox', 'firefox-esr'];
            for (const name of chromiumNames) {
                for (const dir of dirs) { chromium.push(path.join(dir, name)); }
            }
            for (const name of firefoxNames) {
                for (const dir of dirs) { firefox.push(path.join(dir, name)); }
            }
            break;
        }
    }

    const chromiumPath = chromium.find(candidate => fs.existsSync(candidate));
    if (chromiumPath) { return { path: chromiumPath, kind: 'chromium' }; }
    const firefoxPath = firefox.find(candidate => fs.existsSync(candidate));
    if (firefoxPath) { return { path: firefoxPath, kind: 'firefox' }; }
    return undefined;
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
    const loginUrl = new URL('/login', target.origin).toString();
    const profileDir = path.join(options.profileDir, executable.kind);
    await fs.promises.mkdir(profileDir, { recursive: true });

    const session: BrowserSession = executable.kind === 'firefox'
        ? await FirefoxSession.launch(executable.path, profileDir, loginUrl, target)
        : ChromiumSession.launch(executable.path, profileDir, loginUrl, target);

    const cancellation = options.token?.onCancellationRequested(() => session.cancel());
    try {
        return await session.waitForLogin();
    } finally {
        cancellation?.dispose();
        await session.close();
    }
}

/** Common part of the browser sessions: process lifetime and cookie handling. */
abstract class BrowserSession {
    protected exited = false;
    protected readonly exitPromise: Promise<void>;

    protected constructor(protected readonly child: ChildProcess, protected readonly target: URL) {
        child.on('error', error => console.error(`[BrowserLogin] browser process error: ${error.message}`));
        this.exitPromise = new Promise<void>(resolve => {
            child.once('exit', () => {
                this.exited = true;
                this.onExit();
                resolve();
            });
        });
    }

    abstract waitForLogin(): Promise<string>;
    protected abstract onExit(): void;
    /** Ask the browser to quit; must not throw. */
    protected abstract requestClose(): Promise<void>;

    cancel() {
        this.close().catch(() => { /* ignore */ });
    }

    async close() {
        if (this.exited) { return; }
        // ask the browser to quit gracefully, kill it if it does not comply
        const timeout = new Promise<void>(resolve => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS));
        await Promise.race([this.requestClose(), timeout]);
        await Promise.race([this.exitPromise, timeout]);
        if (!this.exited) {
            this.child.kill();
        }
    }

    /** Whether the given URL is the project list of the target server. */
    protected isProjectPage(url?: string) {
        if (!url) { return false; }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return false;
        }
        return parsed.origin === this.target.origin && parsed.pathname.replace(/\/+$/, '') === '/project';
    }

    /** Reject when the browser exits, resolve when the given promise resolves. */
    protected untilExit<T>(promise: Promise<T>): Promise<T> {
        if (this.exited) { return Promise.reject(new LoginCancelledError()); }
        const exit = this.exitPromise.then(() => { throw new LoginCancelledError(); });
        return Promise.race([promise, exit]);
    }

    /** Build the `Cookie` header for the target host and verify a session cookie is present. */
    protected cookieHeader(cookies: Cookie[]) {
        const host = this.target.hostname.toLowerCase();
        const now = Date.now() / 1000;
        const header = cookies
            .filter(cookie => cookie.expires === undefined || cookie.expires < 0 || cookie.expires > now)
            .filter(cookie => {
                const domain = cookie.domain.toLowerCase();
                return domain.startsWith('.')
                    ? (host === domain.slice(1) || host.endsWith(domain))
                    : host === domain;
            })
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        if (!SESSION_COOKIE_NAMES.some(name => header.includes(`${name}=`))) {
            throw new Error('No session cookie found after login.');
        }
        return header;
    }
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

class ChromiumSession extends BrowserSession {
    private readonly cdp: CdpPipeClient;

    static launch(executable: string, profileDir: string, loginUrl: string, target: URL) {
        const child = spawn(executable, [
            '--remote-debugging-pipe',
            `--user-data-dir=${profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync',
            '--new-window',
            loginUrl,
        ], {
            stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return new ChromiumSession(child, target);
    }

    private constructor(child: ChildProcess, target: URL) {
        super(child, target);
        this.cdp = new CdpPipeClient(child.stdio[3] as Writable, child.stdio[4] as Readable);
    }

    protected onExit() {
        this.cdp.dispose(new LoginCancelledError());
    }

    protected async requestClose() {
        try {
            await this.cdp.send('Browser.close');
        } catch {
            // connection already gone
        }
    }

    async waitForLogin(): Promise<string> {
        const loggedIn = new Promise<void>(resolve => {
            this.cdp.onEvent(({ method, params }) => {
                if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
                    const info = params?.targetInfo;
                    if (info?.type === 'page' && this.isProjectPage(info.url)) {
                        resolve();
                    }
                }
            });
        });
        // `targetCreated` is replayed for existing targets once discovery is enabled
        await this.untilExit(this.cdp.send('Target.setDiscoverTargets', { discover: true }));
        await this.untilExit(loggedIn);

        const { cookies } = await this.untilExit(this.cdp.send('Storage.getCookies')) as {
            cookies: { name: string, value: string, domain: string, expires: number }[]
        };
        return this.cookieHeader(cookies);
    }
}

/** Minimal WebDriver BiDi client over a WebSocket. */
class BiDiClient {
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>();
    private readonly eventEmitter = new vscode.EventEmitter<{ method: string, params: any }>();
    private readonly closeEmitter = new vscode.EventEmitter<void>();
    readonly onEvent = this.eventEmitter.event;
    readonly onClose = this.closeEmitter.event;

    private constructor(private readonly ws: WebSocket) {
        ws.addEventListener('message', event => {
            try {
                this.dispatch(JSON.parse(String(event.data)));
            } catch {
                console.error(`[BrowserLogin] malformed BiDi message: ${String(event.data).slice(0, 200)}`);
            }
        });
        ws.addEventListener('close', () => {
            this.dispose(new LoginCancelledError());
            this.closeEmitter.fire();
        });
        ws.addEventListener('error', () => { /* followed by close */ });
    }

    static connect(url: string): Promise<BiDiClient> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.addEventListener('open', () => resolve(new BiDiClient(ws)), { once: true });
            ws.addEventListener('error', () => reject(new Error(`Failed to connect to ${url}`)), { once: true });
        });
    }

    send(method: string, params?: object): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
            } catch (error: any) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    dispose(error: Error) {
        this.pending.forEach(entry => entry.reject(error));
        this.pending.clear();
        this.eventEmitter.dispose();
    }

    private dispatch(message: any) {
        if (message.id !== undefined) {
            const entry = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (entry === undefined) { return; }
            if (message.type === 'error') {
                entry.reject(new Error(message.message ?? message.error ?? 'BiDi error'));
            } else {
                entry.resolve(message.result);
            }
        } else if (message.method) {
            this.eventEmitter.fire({ method: message.method, params: message.params });
        }
    }
}

class FirefoxSession extends BrowserSession {
    private static readonly portFile = 'WebDriverBiDiServer.json';
    private static readonly userPrefs = [
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("browser.tabs.warnOnClose", false);',
        'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
    ].join('\n') + '\n';

    private bidi?: BiDiClient;

    static async launch(executable: string, profileDir: string, loginUrl: string, target: URL) {
        await fs.promises.writeFile(path.join(profileDir, 'user.js'), FirefoxSession.userPrefs);
        await fs.promises.rm(path.join(profileDir, FirefoxSession.portFile), { force: true });
        const child = spawn(executable, [
            '--remote-debugging-port=0',
            '--profile', profileDir,
            '--no-remote',
            '--new-instance',
            loginUrl,
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const session = new FirefoxSession(child, target);
        try {
            const port = await session.untilExit(session.discoverPort(profileDir));
            session.bidi = await session.untilExit(BiDiClient.connect(`ws://127.0.0.1:${port}/session`));
        } catch (error) {
            await session.close();
            throw error;
        }
        return session;
    }

    private constructor(child: ChildProcess, target: URL) {
        super(child, target);
    }

    protected onExit() {
        this.bidi?.dispose(new LoginCancelledError());
    }

    protected async requestClose() {
        try {
            await this.bidi?.send('browser.close');
        } catch {
            // connection already gone
        }
    }

    async waitForLogin(): Promise<string> {
        const bidi = this.bidi!;
        const loggedIn = new Promise<void>(resolve => {
            bidi.onEvent(({ method, params }) => {
                if (method === 'browsingContext.load' && this.isProjectPage(params?.url)) {
                    resolve();
                }
            });
        });
        const closed = new Promise<never>((_resolve, reject) => {
            bidi.onClose(() => reject(new LoginCancelledError()));
        });
        const waitFor = <T>(promise: Promise<T>) => this.untilExit(Promise.race([promise, closed]));

        await waitFor(bidi.send('session.new', { capabilities: {} }));
        await waitFor(bidi.send('session.subscribe', { events: ['browsingContext.load'] }));
        // the login may already be done, e.g. when the profile still holds a valid session
        const { contexts } = await waitFor(bidi.send('browsingContext.getTree')) as { contexts: { url: string }[] };
        if (!contexts.some(context => this.isProjectPage(context.url))) {
            await waitFor(loggedIn);
        }

        const { cookies } = await waitFor(bidi.send('storage.getCookies')) as {
            cookies: { name: string, value: { type: string, value: string }, domain: string, expiry?: number }[]
        };
        return this.cookieHeader(cookies.map(cookie => ({
            name: cookie.name,
            value: cookie.value.value,
            domain: cookie.domain,
            expires: cookie.expiry,
        })));
    }

    /** Wait for Firefox to announce its BiDi port (via output, or the file in the profile). */
    private discoverPort(profileDir: string): Promise<number> {
        const portFile = path.join(profileDir, FirefoxSession.portFile);
        return new Promise<number>((resolve, reject) => {
            let output = '';
            let done = false;
            const finish = (port: number) => {
                if (done) { return; }
                done = true;
                clearInterval(poll);
                clearTimeout(timeout);
                resolve(port);
            };
            const onData = (chunk: Buffer) => {
                output += chunk.toString('utf8');
                const match = output.match(/WebDriver BiDi listening on ws:\/\/[^:\s]+:(\d+)/);
                if (match) { finish(Number(match[1])); }
            };
            this.child.stdout?.on('data', onData);
            this.child.stderr?.on('data', onData);
            const poll = setInterval(() => {
                fs.promises.readFile(portFile, 'utf8')
                .then(content => {
                    const port = Number(JSON.parse(content)?.ws_port);
                    if (port > 0) { finish(port); }
                })
                .catch(() => { /* not written yet */ });
            }, 200);
            const timeout = setTimeout(() => {
                if (done) { return; }
                done = true;
                clearInterval(poll);
                reject(new Error('Firefox did not start its remote debugging interface in time.'));
            }, BROWSER_STARTUP_TIMEOUT_MS);
        });
    }
}
