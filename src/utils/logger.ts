import * as vscode from 'vscode';
import { ELEGANT_NAME } from '../consts';

let _channel: vscode.OutputChannel | undefined;

export class Logger {
    static init(): vscode.Disposable {
        _channel = vscode.window.createOutputChannel(ELEGANT_NAME);
        return _channel;
    }

    private static _log(level: string, message: string, error?: unknown): void {
        if (!_channel) { return; }
        const timestamp = new Date().toLocaleString();
        _channel.appendLine(`[${timestamp}] [${level}] ${message}`);
        if (error instanceof Error) {
            _channel.appendLine(`  ${error.message}`);
            if (error.stack) {
                _channel.appendLine(`  ${error.stack}`);
            }
        } else if (error !== undefined) {
            _channel.appendLine(`  ${String(error)}`);
        }
    }

    static info(message: string): void {
        Logger._log('INFO', message);
    }

    static warn(message: string, error?: unknown): void {
        Logger._log('WARN', message, error);
    }

    static error(message: string, error?: unknown): void {
        Logger._log('ERROR', message, error);
    }

    static show(): void {
        _channel?.show(true);
    }
}
