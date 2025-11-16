import * as vscode from 'vscode';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { IntellisenseProvider } from '.';
import { TeXElement, TeXElementType, genTexElements } from './texDocumentParseUtility';
import { ROOT_NAME } from '../consts';

type TexFileStruct = {
    texElements: TeXElement[],
    childrenPaths: string[],
    bibFilePaths: string[],
};

function elementsTypeCast(section: TeXElement): vscode.SymbolKind {
    switch (section.type) {
        case TeXElementType.Section:
        case TeXElementType.SectionAst:
            return vscode.SymbolKind.Struct;
        case TeXElementType.Environment:
            return vscode.SymbolKind.Package;
        case TeXElementType.Command:
            return vscode.SymbolKind.Number;
        case TeXElementType.SubFile:
            return vscode.SymbolKind.File;
        case TeXElementType.BibItem:
            return vscode.SymbolKind.Class;
        case TeXElementType.BibField:
            return vscode.SymbolKind.Constant;
        default:
            return vscode.SymbolKind.String;
    }
}

function elementsToSymbols(sections: TeXElement[]): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = [];
    sections.forEach(section => {
        const range = new vscode.Range(section.lineFr, 0, section.lineTo, 65535);
        const symbol = new vscode.DocumentSymbol(
            section.label || 'empty',
            '',
            elementsTypeCast(section),
            range, range);
        symbols.push(symbol);
        if (section.children.length > 0) {
            symbol.children = elementsToSymbols(section.children);
        }
    });
    return symbols;
}

function elementsToFoldingRanges(sections: TeXElement[]): vscode.FoldingRange[] {
    const foldingRanges: vscode.FoldingRange[] = [];
    sections.forEach(section => {
        foldingRanges.push(new vscode.FoldingRange(section.lineFr, section.lineTo - 1)); // without the last line, e.g \end{document}
        if (section.children.length > 0) {
            foldingRanges.push(...elementsToFoldingRanges(section.children));
        }
    });
    return foldingRanges;
}

// Reference: https://github.com/James-Yu/LaTeX-Workshop/commit/d1a078d9b63a34c9cda9ff5d1042c8999030e6e1
function getEnvironmentFoldingRange(document: vscode.TextDocument){
    const ranges: vscode.FoldingRange[] = [];
    const opStack: { keyword: string, index: number }[] = [];
    const text: string =  document.getText();
    const envRegex: RegExp = /(\\(begin){(.*?)})|(\\(end){(.*?)})/g; //to match one 'begin' OR 'end'

    let match = envRegex.exec(text); // init regex search
    while (match) {
        //for 'begin': match[2] contains 'begin', match[3] contains keyword
        //fro 'end':   match[5] contains 'end',   match[6] contains keyword
        const item = {
            keyword: match[2] ? match[3] : match[6],
            index: match.index
        };
        const lastItem = opStack[opStack.length - 1];

        if (match[5] && lastItem && lastItem.keyword === item.keyword) { // match 'end' with its 'begin'
            opStack.pop();
            ranges.push(new vscode.FoldingRange(
                document.positionAt(lastItem.index).line,
                document.positionAt(item.index).line - 1
            ));
        } else {
            opStack.push(item);
        }

        match = envRegex.exec(text); //iterate regex search
    }
    //TODO: if opStack still not empty
    return ranges;
}

/*
    * Convert the file into the struct by:
    * 1. Construct child, named as Uri.path, from TeXElementType.SubFile
    * 2. Construct bibFile from TeXElementType.BibFile
    * 
    * @param fileContent: file content 
*/
async function parseTexFileStruct(fileContent:string): Promise<TexFileStruct>{ 
    const childrenPaths = [];
    const bibFilePaths = [];
    const texSymbols = await genTexElements(fileContent);

    // BFS: Traverse the texElements and build fileSymbol
    const queue: TeXElement[] = [...texSymbols];
    while (queue.length > 0) {
        const symbol = queue.shift();
        switch (symbol?.type) {
            case TeXElementType.BibFile:
                bibFilePaths.push(symbol.label);
                break;
            case TeXElementType.SubFile:
                const subFilePath = symbol.label?.endsWith('.tex') ? symbol.label : `${symbol.label}.tex`;
                childrenPaths.push(subFilePath);
                break;
            default:
                break;
        }
        // append children to queue
        symbol?.children.forEach( child => {
            queue.push(child);
        });
    }

    return {
        texElements: texSymbols,
        childrenPaths: childrenPaths,
        bibFilePaths: bibFilePaths,
    };
}

class ProjectStructRecord {
    private fileRecordMap: Map<string, TexFileStruct> = new Map<string, TexFileStruct>();

    constructor (private readonly vfs: VirtualFileSystem) {}

    get rootPath(): string {
        return this.vfs.getRootDocName();
    }

    async init() {
        const rootFileStruct = await this.refreshRecord( this.rootPath );
        const fileQueue: TexFileStruct[] = [ rootFileStruct ];

        // iteratively traverse file node tree
        while (fileQueue.length > 0) {
            const fileNode = fileQueue.shift()!;
            const subFiles = fileNode.childrenPaths;
            for (const subFile of subFiles) {
                // Get fileStruct can be failed due to file not exist
                try {
                    const fileStruct = await this.refreshRecord(subFile);
                    fileQueue.push( fileStruct );
                } catch { continue; }
            };
        }
    }

    getTexFileStruct(document: vscode.TextDocument): TexFileStruct | undefined {
        const filePath = document.fileName;
        return this.fileRecordMap.get(filePath);
    }

    async refreshRecord(source: vscode.TextDocument | string): Promise<TexFileStruct> {
        let filePath:string, content: string;
        // get file path and content
        if (typeof source === 'string') {
            const uri = this.vfs.pathToUri(source);
            filePath = source;
            content = new TextDecoder().decode( await this.vfs.openFile(uri) );
        } else {
            filePath = source.fileName;
            content = source.getText();
        }
        // update file record
        const fileStruct = await parseTexFileStruct( content );
        this.fileRecordMap.set(filePath, fileStruct);
        return fileStruct;
    }

    getAllBibFilePaths(): string[] {
        const rootStruct = this.fileRecordMap.get( this.rootPath );
        if (rootStruct === undefined) { return []; }

        const queue = [rootStruct];
        const bibFilePaths: string[] = [];
        // iteratively traverse file node tree
        while (queue.length > 0) {
            const item = queue.shift()!;
            const paths = item.bibFilePaths.flatMap( name => (name.split(',') ?? []) )
                                           .map( name => (name.endsWith('.bib') ? name : `${name}.bib`) );
            bibFilePaths.push(...paths);
            // append children to queue
            item.childrenPaths.forEach( child => {
                const childItem = this.fileRecordMap.get(child);
                childItem && queue.push(childItem);
            });
        }
        return bibFilePaths;
    }
}

export class TexDocumentSymbolProvider extends IntellisenseProvider implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider {
    protected readonly contextPrefix = [];

    private projectRecordMap = new Map<string, ProjectStructRecord>();

    async provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken): Promise<vscode.FoldingRange[]> {
        const environmentRange = getEnvironmentFoldingRange(document);

        // Try get fileStruct
        const {projectName} = parseUri(document.uri);
        let projectRecord = this.projectRecordMap.get(projectName);
        const fileStruct = projectRecord?.getTexFileStruct(document);

        return environmentRange.concat( fileStruct ? elementsToFoldingRanges(fileStruct.texElements) : [] );
    }

    async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
        const vfs = await this.vfsm.prefetch(document.uri);
        const {projectName} = parseUri(document.uri);

        // init project record if not exist
        let projectRecord = this.projectRecordMap.get(projectName);
        if (projectRecord === undefined) {
            projectRecord = new ProjectStructRecord(vfs);
            await projectRecord.init();
            this.projectRecordMap.set(projectName, projectRecord);
        }

        // return symbols
        const fileStruct = projectRecord.getTexFileStruct(document) ?? await projectRecord.refreshRecord(document);
        return elementsToSymbols( fileStruct.texElements );
    }

    get currentBibPathArray(): string[] {
        // check if supported vfs
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (uri?.scheme !== ROOT_NAME) { return []; }
        // get bib file paths
        const {projectName} = parseUri(uri);
        const projectRecord = this.projectRecordMap.get(projectName);
        return projectRecord?.getAllBibFilePaths() ?? [];
    }

    get triggers(): vscode.Disposable[] {
        const latexSelector = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave'].map((id) => {
            return {...this.selector, language: id };
        });
        return [
            // register symbol provider
            vscode.languages.registerDocumentSymbolProvider(latexSelector, this),
            // register folding range provider
            vscode.languages.registerFoldingRangeProvider(latexSelector, this),
            // register file change listener
            vscode.workspace.onDidChangeTextDocument(async (e) => {
                const {projectName} = parseUri(e.document.uri);
                const projectRecord = this.projectRecordMap.get(projectName);
                projectRecord?.refreshRecord(e.document);
            }),
        ];
    }
}
