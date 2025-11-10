import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as url from 'url';

interface Cookies {
    [key: string]: string;
}
const cookieBroadcast = new vscode.EventEmitter<Cookies>();

class ProxyServer {
    private cookies: Cookies = {};
    private server: http.Server;

    constructor(
        private readonly parent: CORSProxy,
        readonly targetUrl: url.URL,
        private readonly agent: http.Agent | https.Agent,
    ) {
        targetUrl.port = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
        this.server = http.createServer((req, res) => this.proxyRequest(req, res));
    }

    get proxyAddress() {
        const address = this.server.address() as any;
        return `http://${address.address}:${address.port}`;
    }

    start(callback?:() => void) {
        this.server.listen(0, 'localhost', callback);
    }

    close() {
        this.server.close();
    }

    private proxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // update the request headers with the cookies
        const cookie = Object.entries(this.cookies).map(([key,value]) => `${key}=${value}`).join('; ');
        req.headers.cookie = cookie;
        // update the request host with the target host
        if (req.headers.host && req.headers.referer) {
            req.headers.referer = req.headers.referer.replace(req.headers.host, this.targetUrl.host);
        }
        req.headers.host = this.targetUrl.host;
        req.headers.origin = this.targetUrl.origin;
        // remove the `sec-fetch-*` headers
        req.headers['sec-fetch-mode'] = 'cors';
        req.headers['sec-fetch-site'] = 'same-origin';
        req.headers['sec-fetch-dest'] = 'empty';
        // proxy the request
        const options = {
            hostname: this.targetUrl.hostname,
            port: this.targetUrl.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
            agent: this.agent,
        };
        const proxy = this.targetUrl.protocol === 'https:' ? https.request(options) : http.request(options);
        req.pipe(proxy);

        proxy.on('response', async (proxyRes) => {
            // Record the cookies
            if (proxyRes.headers['set-cookie']) {
                proxyRes.headers['set-cookie'].forEach((cookie) => {
                    const [keyValue, ...rest] = cookie.split(';');
                    const [_key, _value] = keyValue.split('=');
                    const [key, value] = [_key.trim(), _value.trim()];
                    // Notify the cookie update
                    if ( req.statusCode===200 && req.method==='GET' && req.url?.endsWith('/project') ) {
                        cookieBroadcast.fire({ [key]: value });
                    }
                    this.cookies[key] = value;
                });
            }
            // Remove CORS related restrictions
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['cross-origin-opener-policy'];
            delete proxyRes.headers['cross-origin-resource-policy'],
            delete proxyRes.headers['referrer-policy'];
            delete proxyRes.headers['strict-transport-security'];
            delete proxyRes.headers['x-content-type-options'];
            delete proxyRes.headers['x-download-options'];
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['x-permitted-cross-domain-policies'];
            delete proxyRes.headers['x-served-by'];
            delete proxyRes.headers['x-xss-protection'];
            // Notify parent with 302 redirection
            if (proxyRes.statusCode === 302 && proxyRes.headers['location']?.startsWith('http')) {
                proxyRes = await this.parent.updateProxyServer(proxyRes);
            }
            // Copy the response headers
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
            // Pipe the response data
            proxyRes.pipe(res);
        });

        proxy.on('close', () => {
            res.end();
        });

        proxy.on('error', (err) => {
            console.error(`Error on proxy request: ${err.message}`);
            res.writeHead(500);
            res.end();
        });
    }
}

class CORSProxy {
    rootServer: ProxyServer;
    private proxyAgent: http.Agent | https.Agent;
    private proxyServers: { [key: string]: ProxyServer } = {};

    constructor(
        private readonly targetUrl: url.URL,
    ) {
        this.proxyAgent = this.targetUrl.protocol === 'https:' ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
        this.rootServer = new ProxyServer(this, this.targetUrl, this.proxyAgent);
        this.proxyServers[this.targetUrl.origin] = this.rootServer;
    }

    async updateProxyServer(proxyRes: http.IncomingMessage) {
        const location = proxyRes.headers['location'];
        const locationUrl = new url.URL( location! );
        if (location) {
            // Create a new proxy server for the redirection
            if (this.proxyServers[locationUrl.origin]===undefined) {
                const proxyServer = new ProxyServer(this, locationUrl, this.proxyAgent);
                this.proxyServers[locationUrl.origin] = proxyServer;
                await new Promise((resolve) => proxyServer.start(() => resolve(undefined)));
            }
            // Update the redirection location origin
            const proxyServer = this.proxyServers[locationUrl.origin];
            proxyRes.headers['location'] = location.replace(locationUrl.origin, proxyServer.proxyAddress);
        }
        return proxyRes;
    }

    close() {
        Object.values(this.proxyServers).forEach((server) => server.close());
        this.proxyAgent.destroy();
    }
}

export class PhantomWebview extends vscode.Disposable {
    private targetUrl: url.URL;
    private proxy: CORSProxy;

    private panel?: vscode.WebviewPanel;

    constructor(targetUrl: string) {
        super(() => this.dispose());
        this.targetUrl = new url.URL(targetUrl);
        // Create the root proxy server
        this.proxy = new CORSProxy(this.targetUrl);
        this.proxy.rootServer.start(() => {
            this.panel = this.createWebviewPanel();
            this.panel.onDidDispose(() => this.dispose());
        });
    }

    dispose() {
        // Close the webview panel
        this.panel?.dispose();
        this.panel = undefined;
        // Close the root proxy server
        this.proxy.close();
    }

    onCookieUpdated(listener: (cookies: Cookies) => any, thisArgs?: any, disposables?: vscode.Disposable[]) {
        return cookieBroadcast.event(listener, thisArgs, disposables);
    }

    private createWebviewPanel() {
        const proxyUrl = `${this.proxy.rootServer.proxyAddress}/login`;
        const panel = vscode.window.createWebviewPanel('phantom', this.targetUrl.hostname, vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: false,
        });
        panel.webview.html = `<!DOCTYPE html>
        <html>
        <head>
            <title>Phantom Webview</title>
            <style>
                html, body, iframe {
                    margin: 0;
                    padding: 0;
                    width: 100%;
                    height: 100%;
                    overflow: hidden;
                    border: none;
                }
            </style>
        </head>
        <body>
            <iframe src=${proxyUrl}></iframe>
        </body>
        </html>
        `;
        return panel;
    }

}
