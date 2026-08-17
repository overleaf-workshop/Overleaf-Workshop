import * as vscode from 'vscode';
import { ROOT_NAME, ELEGANT_NAME } from './consts';

import { parseUri, RemoteFileSystemProvider, VirtualFileSystem } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import { LocalReplicaSCMProvider } from './scm/localReplicaSCM';
import { GlobalStateManager } from './utils/globalStateManager';
import { initOutputChannel, log, notifyError } from './utils/outputChannel';

let localReplicaActivation: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext) {
    // Keep extension diagnostics in a selectable channel in the Output view.
    initOutputChannel(context);
    log('Overleaf Workshop local sync build 2026-08-17.5 activated.');

    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    const activateLocalReplica = (forceReset=false): Promise<void> => {
        if (localReplicaActivation!==undefined) { return localReplicaActivation; }
        localReplicaActivation = (async () => {
            const setting = await LocalReplicaSCMProvider.readSettings();
            if (!setting?.uri) { return; }
            const uri = vscode.Uri.parse(setting.uri);
            if (uri.scheme!==ROOT_NAME) { return; }
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (workspaceRoot===undefined || workspaceRoot.scheme!=='file') { return; }

            const {serverName, projectId, projectName, userId} = parseUri(uri);
            const existing = GlobalStateManager.getServerProjectSCMPersists(context, serverName, projectId);
            const existingPersist = Object.values(existing).find(persist => {
                const baseUri = vscode.Uri.parse(persist.baseUri);
                return (baseUri.scheme==='' ? vscode.Uri.file(persist.baseUri) : baseUri).toString()===workspaceRoot.toString();
            });
            const restored = await GlobalStateManager.restoreLocalReplicaSCM(
                context,
                serverName,
                projectId,
                projectName,
                userId,
                workspaceRoot.toString(),
                {
                    enabled: true,
                    label: LocalReplicaSCMProvider.label,
                    baseUri: workspaceRoot.toString(),
                    settings: setting.localReplica?.settings ?? existingPersist?.settings ?? {} as JSON,
                },
            );
            if (!restored) {
                throw new Error(`Not logged in to ${serverName}`);
            }
            if (forceReset) {
                await vscode.commands.executeCommand('remoteFileSystem.reset', uri);
            }
            const vfs = (await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)) as VirtualFileSystem;
            await vfs.init();
            await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
            await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, Boolean(setting.enableCompileNPreview));
        })()
        .catch(error => {
            notifyError('The local Overleaf project could not reconnect. Please verify that you are logged in, then retry.', error, 'local-replica-reconnect');
        })
        .finally(() => { localReplicaActivation = undefined; });
        return localReplicaActivation;
    };

    context.subscriptions.push(vscode.commands.registerCommand(`${ROOT_NAME}.localReplica.activate`, (forceReset?: boolean) => {
        return activateLocalReplica(forceReset===true);
    }));
    activateLocalReplica();
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
}
