import * as vscode from 'vscode';
import { IntellisenseProvider } from '.';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';
import { TexDocumentSymbolProvider } from './texDocumentSymbolProvider';
import { CitationMetadata, parseBibContent } from './citationMetadata';

export class CitationHoverProvider extends IntellisenseProvider implements vscode.HoverProvider {
    protected readonly contextPrefix = [];

    constructor(
        vfsm: RemoteFileSystemProvider,
        private readonly texSymbolProvider: TexDocumentSymbolProvider,
    ) {
        super(vfsm);
    }

    private findCitationKeyAtPosition(document: vscode.TextDocument, position: vscode.Position): string | undefined {
        const line = document.lineAt(position.line);
        const lineText = line.text;
        const targetOffset = position.character;
        const citationRegex = /\\(?:cite\w*|\w*cite)(?:\[[^\]]*\])*\{([^}]*)\}/g;

        let match: RegExpExecArray | null;
        while ((match = citationRegex.exec(lineText))) {
            const full = match[0];
            const keysRaw = match[1] ?? '';
            const keysStart = match.index + full.lastIndexOf('{') + 1;
            const keysEnd = keysStart + keysRaw.length;
            if (targetOffset < keysStart || targetOffset > keysEnd) {
                continue;
            }

            let cursor = 0;
            const parts = keysRaw.split(',');
            for (const part of parts) {
                const leadingSpaces = part.match(/^\s*/)?.[0].length ?? 0;
                const trailingSpaces = part.match(/\s*$/)?.[0].length ?? 0;
                const keyStart = cursor + leadingSpaces;
                const keyEnd = cursor + part.length - trailingSpaces;
                if (targetOffset >= keysStart + keyStart && targetOffset <= keysStart + keyEnd) {
                    const key = part.trim();
                    return key === '' ? undefined : key;
                }
                cursor += part.length + 1;
            }
        }

        return undefined;
    }

    private formatHover(entry: CitationMetadata): vscode.Hover {
        const escapeMarkdown = (value: string) => value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
        const markdown = new vscode.MarkdownString();
        const title = entry.title ?? entry.key;
        markdown.appendMarkdown(`### ${escapeMarkdown(title)}\n\n`);
        if (entry.author) {
            markdown.appendMarkdown(`**Authors**: ${escapeMarkdown(entry.author)}  \n`);
        }
        if (entry.year) {
            markdown.appendMarkdown(`**Year**: ${escapeMarkdown(entry.year)}  \n`);
        }
        if (entry.journal ?? entry.booktitle) {
            markdown.appendMarkdown(`**Venue**: *${escapeMarkdown(entry.journal ?? entry.booktitle ?? '')}*  \n`);
        }
        markdown.appendMarkdown(`\n---\nKey: \`${escapeMarkdown(entry.key)}\``);
        return new vscode.Hover(markdown);
    }

    private async getCitationMetadata(uri: vscode.Uri, citationKey: string): Promise<CitationMetadata | undefined> {
        const vfs = await this.vfsm.prefetch(uri);
        for (const path of this.texSymbolProvider.currentBibPathArray) {
            try {
                const raw = await vfs.openFile(vfs.pathToUri(path));
                const entries = parseBibContent(new TextDecoder().decode(raw));
                const found = entries.find(entry => entry.key === citationKey);
                if (found) {
                    return found;
                }
            } catch {
                continue;
            }
        }
        return undefined;
    }

    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        const citationKey = this.findCitationKeyAtPosition(document, position);
        if (!citationKey) {
            return undefined;
        }

        const metadata = await this.getCitationMetadata(document.uri, citationKey);
        if (!metadata) {
            return undefined;
        }

        return this.formatHover(metadata);
    }

    get triggers(): vscode.Disposable[] {
        return [
            vscode.languages.registerHoverProvider(this.selector, this),
        ];
    }
}
