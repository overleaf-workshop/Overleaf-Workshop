import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;
const notificationTimes = new Map<string, number>();
const NOTIFICATION_COOLDOWN_MS = 30000;

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function formatArgument(argument: unknown): string {
    if (argument instanceof Error) {
        return argument.stack || argument.message;
    }
    if (typeof argument === 'string') {
        return argument;
    }
    try {
        return JSON.stringify(argument);
    } catch {
        return String(argument);
    }
}

export function initOutputChannel(context: vscode.ExtensionContext): vscode.LogOutputChannel {
    if (outputChannel===undefined) {
        outputChannel = vscode.window.createOutputChannel('Overleaf Workshop', {log:true});
        context.subscriptions.push(outputChannel);
    }
    return outputChannel;
}

function writeLog(level: LogLevel, args: unknown[]) {
    const message = args.map(formatArgument).join(' ');
    if (level==='ERROR') {
        outputChannel?.error(message);
        console.error(...args);
    } else if (level==='WARN') {
        outputChannel?.warn(message);
        console.warn(...args);
    } else {
        outputChannel?.info(message);
        console.log(...args);
    }
}

export function log(...args: unknown[]) {
    writeLog('INFO', args);
}

export function warn(...args: unknown[]) {
    writeLog('WARN', args);
}

export function error(...args: unknown[]) {
    writeLog('ERROR', args);
}

export function notifyError(message: string, detail?: unknown, key: string = message) {
    writeLog('ERROR', detail===undefined ? [message] : [message, detail]);
    const now = Date.now();
    const previous = notificationTimes.get(key) || 0;
    if (now-previous<NOTIFICATION_COOLDOWN_MS) { return; }
    notificationTimes.set(key, now);
    vscode.window.showErrorMessage(message, 'Show Logs').then(choice => {
        if (choice==='Show Logs') {
            outputChannel?.show(true);
        }
    }, () => {});
}
