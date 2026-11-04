/**
 * Connection and sync events, written to the "Overleaf Workshop" output channel
 * (View > Output) as well as the console. `console.log` alone ends up nowhere a user
 * can find it, which left connection problems without any trace.
 *
 * 'vscode' is required lazily so modules that log can still be loaded outside the
 * extension host (unit tests).
 */
type Level = 'info' | 'warn' | 'error';

let channel: { info(m: string): void, warn(m: string): void, error(m: string): void } | undefined;

export function log(level: Level, message: string) {
    try {
        if (channel === undefined) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const vscode = require('vscode');
            channel = vscode.window.createOutputChannel('Overleaf Workshop', { log: true });
        }
        channel![level](message);
    } catch {
        // not running inside VS Code
    }
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(message);
}
