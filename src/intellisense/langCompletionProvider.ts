import * as vscode from 'vscode';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { SnippetItemSchema } from '../api/base';
import { fuzzyFilter, IntellisenseProvider } from '.';
import { RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { TexDocumentSymbolProvider } from './texDocumentSymbolProvider';
import { CitationMetadata, parseBibContent } from './citationMetadata';

type SnippetItemMap = {[K:string]: SnippetItemSchema};
type FilePathCompletionType = 'text' | 'image' | 'bib';

export class CommandCompletionProvider extends IntellisenseProvider implements vscode.CompletionItemProvider {
    protected readonly contextPrefix = [['']];
    private constantData?: SnippetItemMap;
    private customData: {
        [K:string]: {
            metadata: SnippetItemMap,
            commands: Map<string, SnippetItemMap>,
        }
    } = {};

    constructor(
        protected readonly vfsm: RemoteFileSystemProvider,
        private readonly extensionUri: vscode.Uri) {
        super(vfsm);
    }

    protected get contextRegex() {
        return /\\\w*/;
    }

    private async loadJson(path: string) {
        const uri = vscode.Uri.joinPath(this.extensionUri, path);
        const data = (await vscode.workspace.fs.readFile(uri)).toString();
        return JSON.parse(data);
    }

    private async loadMetadata(uri: vscode.Uri): Promise<SnippetItemMap> {
        const vfs = await this.vfsm.prefetch(uri);
        const res = await vfs.metadata();
        if (res===undefined) { return {}; };

        let metadata:SnippetItemMap = {};
        Object.values(res).forEach((data) => {
            Object.values(data.packages).forEach((items) => {
                items.forEach(item => {
                    const {caption,snippet,meta,score} = item;
                    metadata[caption] = {caption, snippet, meta, score};
                });
            });
        });

        return metadata;
    }

    private async loadCommands(uri: vscode.Uri): Promise<SnippetItemMap> {
        const regex = /\\(?:newcommand|renewcommand)\{\\(\w+)\}(\[(\d)\])?(\[(\d)\])?/g;
        const vfs = await this.vfsm.prefetch(uri);
        const content = new TextDecoder().decode( await vfs.openFile(uri) );

        let commands: SnippetItemMap = {};
        let match: RegExpExecArray | null;
        while (match = regex.exec(content)) {
            const caption = match[1];
            const argc = Number(match[3]) || 0;
            let args = '';
            for (let i=1; i<=argc; i++) {
                args += `{$${i}}`;
            }
            const title = `\\${caption}${'{}'.repeat(argc)}`;
            const snippet = `\\${caption}${args}`;
            const meta = 'cmd';
            const score = 0.1;
            commands[title] = {caption, snippet, meta, score};
        }

        return commands;
    }

    private async reloadCommands(uri: vscode.Uri): Promise<Map<string, SnippetItemMap>> {
        const vfs = await this.vfsm.prefetch(uri);
        const rootFiles = await vfs.list(vfs.pathToUri('/'));

        let commands: Map<string, SnippetItemMap> = new Map();
        for (const [name, type] of rootFiles) {
            if (type===vscode.FileType.File && name.endsWith('.tex')) {
                const _commands = await this.loadCommands(vfs.pathToUri(name));
                commands.set(name, _commands);
            }
        }
        return commands;
    }

    private async load(uri: vscode.Uri, force: boolean = false) {
        if (this.constantData===undefined) {
            this.constantData = {};
            const snippetsArray = await this.loadJson('data/latex/top-hundred-snippets.json') as any[];
            for (const item of snippetsArray) {
                const {caption,snippet,meta,score} = item;
                this.constantData[caption] = {caption, snippet, meta, score};
            }
        }

        const {identifier} = parseUri(uri);
        if (this.customData[identifier]===undefined || force) {
            this.customData[identifier] = {
                metadata: await this.loadMetadata(uri) || {},
                commands: await this.reloadCommands(uri) || {},
            };
        }
    }

    private async getCompletionItems(uri:vscode.Uri, partial:string, wholeRange:vscode.Range): Promise<vscode.CompletionItem[]> {
        await this.load(uri);
        const {identifier} = parseUri(uri);

        let commands:SnippetItemMap = {};
        this.customData[identifier].commands.forEach((item) => {
            commands = {...item, ...commands};
        });

        const snippets = {
                    ...this.constantData,
                    ...this.customData[identifier].metadata,
                    ...commands,
                };
        return Object.entries(snippets)
                .map(([key, value]) => {
                    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Method);
                    item.insertText = new vscode.SnippetString(value.snippet);
                    item.additionalTextEdits = [vscode.TextEdit.delete(wholeRange)];
                    item.detail = value.meta;
                    item.sortText = value.score.toFixed(15).toString();
                    return item;
                });
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[]> {
        const wordRange = document.getWordRangeAtPosition(position, this.contextRegex);
        if (wordRange) {
            const partial = document.getText(wordRange);
            const pos = partial.search(/\\/); 
            const delRange = pos !== -1 ? new vscode.Range(wordRange.start.translate(0,pos), wordRange.start.translate(0, pos + 1)) : wordRange;
            return this.getCompletionItems(document.uri, partial, delRange);
        }
        return Promise.resolve([]);
    }

    get triggers(): vscode.Disposable[] {
        return [
            vscode.languages.registerCompletionItemProvider(this.selector, this, '\\'),
            // trigger on document save
            vscode.workspace.onDidSaveTextDocument(async doc => {
                if (doc.uri.scheme === ROOT_NAME && doc.uri.path.endsWith('.tex')) {
                    const {identifier} = parseUri(doc.uri);
                    const commands = await this.loadCommands(doc.uri);
                    this.customData[identifier]?.commands.set(doc.uri.path, commands);
                }
            }),
        ];
    }
}

export class ConstantCompletionProvider extends IntellisenseProvider implements vscode.CompletionItemProvider {
    private readonly constantData = new Array(4);
    protected readonly contextPrefix = [
        // group 0, class names
        ['documentclass'],
        // group 1, bibliography styles
        ['bibliographystyle'],
        // group 2, environments
        ['begin'],
        // group 3, package names
        ['usepackage'],
    ];

    constructor(
        protected readonly vfsm: RemoteFileSystemProvider,
        private readonly extensionUri: vscode.Uri) {
        super(vfsm);
    }

    private async loadJson(path: string) {
        const uri = vscode.Uri.joinPath(this.extensionUri, path);
        const data = (await vscode.workspace.fs.readFile(uri)).toString();
        return JSON.parse(data);
    }

    private async load(idx: number, force: boolean = false) {
        if (!force && this.constantData[idx]!==undefined) { return; }
        switch (idx) {
            case 0:
                const classNames = await this.loadJson('data/latex/class-names.json') as string[];
                this.constantData[0] = classNames;
                break;
            case 1:
                const bibStyles = (await this.loadJson('data/latex/bibliography-styles.json') as any)['biblatex'] as string[];
                this.constantData[1] = bibStyles;
                break;
            case 3:
                const packageNames = await this.loadJson('data/latex/package-names.json') as string[];
                this.constantData[3] = packageNames;
                break;
            case 2:
                const environments = await this.loadJson('data/latex/environments.json') as any;
                this.constantData[2] = environments['expanded'] as {[K:string]:string};
                (environments['common'] as string[]).forEach(x => {
                    this.constantData[2][x] = `\\begin{${x}}\n\t$1\n\\end{${x}}`;
                });
                break;
            default:
                break;
        }
    }

    private parseMatch(match: RegExpMatchArray) {
        const keywords = match.slice(1, -1);
        const partial = match.at(-1) as string;
        const index = keywords.findIndex(x => x!==undefined);
        const length = match[0].length;
        return {index, partial, length};
    }

    private async getCompletionItems(idx: number, partial:string, wordRange:vscode.Range, wholeRange:vscode.Range): Promise<vscode.CompletionItem[]> {
        await this.load(idx);
        const constants = this.constantData[idx];
        switch (idx) {
            case 0:case 1:case 3:
                return (constants as string[])
                        .map(x => new vscode.CompletionItem(x, vscode.CompletionItemKind.Module));
            case 2:
                return Object.entries(constants as {[K:string]:string})
                        .filter(([key, value]) => key.startsWith(partial))
                        .map(([key, value]) => {
                            const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Snippet);
                            item.insertText = new vscode.SnippetString(value);
                            item.range = wordRange;
                            item.additionalTextEdits = [vscode.TextEdit.delete(wholeRange)];
                            return item;
                        });
            default:
                return [];
        }
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[]> {
        const wordRange = document.getWordRangeAtPosition(position, this.contextRegex);
        if (wordRange) {
            const match = document.getText(wordRange).match(this.contextRegex);
            const {index, partial, length} = this.parseMatch(match as RegExpMatchArray);
            const afterRange = new vscode.Range(position, wordRange.end);
            const wholeRange = new vscode.Range(wordRange.start, wordRange.start.translate(0, length-1));
            return this.getCompletionItems(index, partial, afterRange, wholeRange);
        }
        return Promise.resolve([]);
    }

    get triggers(): vscode.Disposable[] {
        return [
            vscode.languages.registerCompletionItemProvider(this.selector, this, '{'),
        ];
    }
}

export class FilePathCompletionProvider extends IntellisenseProvider implements vscode.CompletionItemProvider, vscode.DocumentLinkProvider {
    private readonly fileRegex:{[K in FilePathCompletionType]:RegExp} = {
        'text': /\.(?:tex|txt)$/,
        'image': /\.(eps|jpe?g|gif|png|tiff?|pdf|svg)$/,
        'bib': /\.bib$/
    };
    protected readonly contextPrefix = [
        // group 0: text file
        ['include', 'input'],
        // group 1: image file
        ['includegraphics'],
        // group 2: bib file
        ['bibliography', 'addbibresource'],
    ];

    private parseMatch(match: RegExpMatchArray) {
        const keywords = match.slice(1, -1);
        const path = match.at(-1) as string;
        const [type,postfix]: [FilePathCompletionType,string] = (()=>{
            if (keywords[0]) {
                return path.endsWith('.tex') ? ['text', ''] : ['text', '.tex'];
            }
            if (keywords[2]) {
                return path.endsWith('.bib') ? ['bib', ''] : ['bib', '.bib'];
            }
            return ['image', ''];
        })();
        const offset = '\\'.length
                        + (keywords[0]||keywords[1]||keywords[2]||'').length
                        + (keywords.at(-1)||'').length
                        +'{'.length;
        return {path, type, offset, postfix};
    }

    private async getCompletionItems(uri:vscode.Uri, path: string, type: FilePathCompletionType): Promise<vscode.CompletionItem[]> {
        const matches = path.split(/(.*)\/([^\/]*)/);
        const [parent, child] = (()=>{
            if (matches.length === 1) {
                return ['', matches[0]];
            } else {
                return [matches[1], matches[2]];
            }
        })();
        const _regex = this.fileRegex[type];

        const vfs = await this.vfsm.prefetch(uri);
        const parentUri = vfs.pathToUri( ...parent.split('/') );
        const files = await vfs.list(parentUri);

        return files.map(([name, _type]) => {
            if (_type===vscode.FileType.Directory && name!==OUTPUT_FOLDER_NAME) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Folder);
                item.sortText = '\0' + name;
                return item;
            } else if (_regex.test(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.File);
                item.sortText = '\0' + name;
                return item;
            }
        }).filter(x => x) as vscode.CompletionItem[];
    }

    private async getDocumentLinks(uri:vscode.Uri, document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const regex = new RegExp(this.contextRegex, 'mg');
        const vfs = await this.vfsm.prefetch(uri);

        const links:vscode.DocumentLink[] = [];
        let match: RegExpExecArray | null;
        while (match = regex.exec(text)) {
            const {path,offset,postfix} = this.parseMatch(match);
            const uri = vfs.pathToUri(path + postfix);
            try {
                await vfs.resolve(uri);
                const range = new vscode.Range(
                    document.positionAt(match.index + offset),
                    document.positionAt(match.index + offset + path.length)
                );
                links.push(new vscode.DocumentLink(range, uri));
            } catch {}
        }
        return links;
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[]> {
        const wordRange = document.getWordRangeAtPosition(position, this.contextRegex);
        if (wordRange) {
            const match = document.getText(wordRange).match(this.contextRegex);
            const {path, type} = this.parseMatch(match as RegExpMatchArray);
            return this.getCompletionItems(document.uri, path, type);
        }
        return Promise.resolve([]);
    }

    provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentLink[]> {
        return this.getDocumentLinks(document.uri, document);
    }

    get triggers(): vscode.Disposable[] {
        const selector = {...this.selector, pattern: '**/*.{tex,txt}'};
        return [
            // register completion provider
            vscode.languages.registerCompletionItemProvider(selector, this, '{', '/'),
            // register document link provider
            vscode.languages.registerDocumentLinkProvider(selector, this),
        ];
    }
}

export class ReferenceCompletionProvider extends IntellisenseProvider implements vscode.CompletionItemProvider {
    protected readonly contextPrefix = [
        // group 0: reference
        ['\\w*ref'],
        // group 1: citation
        ['cite\\w*', '\\w*cite'],
    ];

    constructor(vfsm: RemoteFileSystemProvider, private readonly texSymbolProvider: TexDocumentSymbolProvider) {
        super(vfsm);
    }

    private parseMatch(match: RegExpMatchArray) {
        const keywords = match.slice(1, -1);
        const index = keywords.findIndex(x => x!==undefined);
        const _match = (match.at(-1) as string).split(/(.*),([^,]*)/);
        const partial = _match.length===1 ? _match[0] : _match[2];
        return {index, partial};
    }

    private async getCompletionItems(uri:vscode.Uri, idx: number, partial:string): Promise<vscode.CompletionItem[]> {
        const vfs = await this.vfsm.prefetch(uri);
        switch (idx) {
            case 0: // group 0: reference
                const res = await vfs.metadata();
                if (res===undefined) { return []; };
                const labels = Object.values(res).map(({labels}) => labels).flat();
                const uniqueLabels = [...new Set(labels)];
                return uniqueLabels.map(label => new vscode.CompletionItem(label, vscode.CompletionItemKind.Reference));
            case 1: // group 1: citation
                let items = await this.getReferenceCompletionItemsFromBib(vfs);
                items = items.length!==0 ? items : await this.getReferenceCompletionItemsFromBbl(vfs); //fallback option
                items = fuzzyFilter(items, partial, ['label']);
                items.forEach(item => item.filterText = `${partial} ${item.label}`);
                return items;
            default:
                return [];
        }
    }

    private async getReferenceCompletionItemsFromBib(vfs: VirtualFileSystem): Promise<vscode.CompletionItem[]> {
        const items = new Array<vscode.CompletionItem>();
        for (const path of this.texSymbolProvider.currentBibPathArray) {
            try{
                const rawContent = await vfs.openFile( vfs.pathToUri(path) );
                const content = new TextDecoder().decode(rawContent);
                const entries = parseBibContent(content);
                for (const entry of entries) {
                    items.push(this.createCitationCompletionItem(entry));
                }
            } catch{}
        };
        return items;
    }

    private createCitationCompletionItem(entry: CitationMetadata): vscode.CompletionItem {
        const escapeMarkdown = (value: string) => value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
        const item = new vscode.CompletionItem(entry.key, vscode.CompletionItemKind.Reference);
        const subtitle = [entry.author, entry.year].filter(Boolean).join(' - ');
        if (subtitle) {
            item.detail = subtitle;
        }

        const markdown = new vscode.MarkdownString();
        const title = entry.title ?? entry.key;
        markdown.appendMarkdown(`**${escapeMarkdown(title)}**  \n`);
        if (entry.author) {
            markdown.appendMarkdown(`**Authors**: ${escapeMarkdown(entry.author)}  \n`);
        }
        if (entry.year) {
            markdown.appendMarkdown(`**Year**: ${escapeMarkdown(entry.year)}  \n`);
        }
        if (entry.journal ?? entry.booktitle) {
            markdown.appendMarkdown(`**Venue**: *${escapeMarkdown(entry.journal ?? entry.booktitle ?? '')}*  \n`);
        }
        markdown.appendMarkdown(`Key: \`${escapeMarkdown(entry.key)}\``);
        item.documentation = markdown;
        return item;
    }

    private async getReferenceCompletionItemsFromBbl(vfs: VirtualFileSystem): Promise<vscode.CompletionItem[]>{
        const regex = /\\bibitem\{([^\}]*)\}/g;
        const bibUri = vfs.pathToUri(`${OUTPUT_FOLDER_NAME}/output.bbl`);
        try {
            const content = new TextDecoder().decode( await vfs.openFile(bibUri) );
            const items = new Array<vscode.CompletionItem>();
            let match: RegExpExecArray | null;
            while (match = regex.exec(content)) {
                const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Reference);
                items.push(item);
            }
            return items;
        } catch {
            return [];
        }
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
        const wordRange = document.getWordRangeAtPosition(position, this.contextRegex);
        if (wordRange) {
            const match = document.getText(wordRange).match(this.contextRegex);
            const {index, partial} = this.parseMatch(match as RegExpMatchArray);
            return this.getCompletionItems(document.uri, index, partial);
        }
        return Promise.resolve([]);
    }

    get triggers(): vscode.Disposable[] {
        return [
            vscode.languages.registerCompletionItemProvider(this.selector, this, '{', ','),
        ];
    }
}