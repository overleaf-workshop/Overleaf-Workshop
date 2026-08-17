import type * as Ast from '@unified-latex/unified-latex-types';
import * as unifiedLaTeXParse from '@unified-latex/unified-latex-util-parse';
import { error } from '../utils/outputChannel';

// eslint-disable-next-line @typescript-eslint/naming-convention
export enum TeXElementType { Environment, Command, Section, SectionAst, SubFile, BibItem, BibField, BibFile};

export type TeXElement = {
    readonly type: TeXElementType,
    readonly name: string,
    label: string,
    readonly lineFr: number,
    lineTo: number,
    children: TeXElement[],
    parent?: TeXElement,
    appendix?: boolean,
};

// Initialize the parser
const unifiedParser: { parse: (content: string) => Ast.Root } = unifiedLaTeXParse.getParser({ 
    flags: { autodetectExpl3AndAtLetter: true },
    macros: {
        addbibresource: {  // Takes one mandatory argument for biblatex
            signature: 'm',
        }
    }
});

// Env that matches the defaultStructure will be treated as a section with top-down order
const defaultStructure = ["book", "part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];


// Match label command
const defaultCMD = ["label"];

/* 
    * Convert a macro to string
    * 
    * @param macro: the macro to be converted
    * @return: the string representation of the macro
*/
// reference: https://github.com/James-Yu/LaTeX-Workshop/blob/9cb158f57b73f3e506b2874ffe9dbce6a24127b8/src/utils/parser.ts#L3
function macroToStr(macro: Ast.Macro): string {
    if (macro.content === 'texorpdfstring') {
        return (macro.args?.[1].content[0] as Ast.String | undefined)?.content || '';
    }
    return `\\${macro.content}` + (macro.args?.map(arg => `${arg.openMark}${argContentToStr(arg.content)}${arg.closeMark}`).join('') ?? '');
}

/*
    * Convert an environment to string
    * 
    * @param env: the environment to be converted
    * @return: the string representation of the environment
*/
// reference: https://github.com/James-Yu/LaTeX-Workshop/blob/9cb158f57b73f3e506b2874ffe9dbce6a24127b8/src/utils/parser.ts#L10
function envToStr(env: Ast.Environment | Ast.VerbatimEnvironment): string {
    return `\\environment{${env.env}}`;
}

/*
    * Convert the content of an argument to string
    * 
    * @param argContent: the content of the argument
    * @param preserveCurlyBrace: whether to preserve the curly brace '{'
    * @return: the string representation of the argument
*/
// reference: https://github.com/James-Yu/LaTeX-Workshop/blob/9cb158f57b73f3e506b2874ffe9dbce6a24127b8/src/utils/parser.ts#L14
function argContentToStr(argContent: Ast.Node[], preserveCurlyBrace: boolean = false): string {
    return argContent.map(node => {
        // Verb
        switch (node.type) {
            case 'string':
                return node.content;
            case 'whitespace':
            case 'parbreak':
            case 'comment':
                return ' ';
            case 'macro':
                return macroToStr(node);
            case 'environment':
            case 'verbatim':
            case 'mathenv':
                return envToStr(node);
            case 'inlinemath':
                return `$${argContentToStr(node.content)}$`;
            case 'displaymath':
                return `\\[${argContentToStr(node.content)}\\]`;
            case 'group':
                return preserveCurlyBrace ? `{${argContentToStr(node.content)}}` : argContentToStr(node.content);
            case 'verb':
                return node.content;
            default:
                return '';
        }
    }).join('');
}

/*
    * Parse a node and generate a TeXElement, this function travel each node recursively (Here children is referenced by `.content`),
    * if the node is a macro and matches the defaultStructure, it will be treated as a section;
    * if the node is a macro and matches the defaultCMD, it will be treated as a command;
    * if the node is an environment, it will be treated as an environment;
    * 
    * @param node: the node to be parsed
    * @param root: the root TeXElement
*/
// reference: https://github.com/James-Yu/LaTeX-Workshop/blob/9cb158f57b73f3e506b2874ffe9dbce6a24127b8/src/outline/structure/latex.ts#L86
async function parseNode(
    node: Ast.Node,
    root: { children: TeXElement[] }
) {
    const attributes = {
        lineFr: (node.position?.start.line ?? 1) - 1,
        lineTo: (node.position?.end.line ?? 1) - 1,
        children: []
    };
    let element: TeXElement | undefined;
    let caption = '';
    switch (node.type) {
        case 'macro':
            let caseType = '';
            if (defaultStructure.includes(node.content) && node.args?.[node.args?.length - 1].openMark === '{') {
                caseType = 'section';
            } else if (defaultCMD.includes(node.content)) {
                caseType = 'label';
            } else if (node.content === 'input') {
                caseType = 'subFile';
            } else if (node.content === 'bibliography' || node.content === 'addbibresource') {
                caseType = 'bibFile';
            }
            let argStr = '';
            switch (caseType) {
                case 'section':
                    element = {
                        type: node.args?.[0]?.content[0]
                            ? TeXElementType.SectionAst
                            : TeXElementType.Section,
                        name: node.content,
                        label: argContentToStr(
                            ((node.args?.[1]?.content?.length ?? 0) > 0
                                ? node.args?.[1]?.content
                                : node.args?.[node.args?.length - 1]?.content) || []
                        ),
                        ...attributes
                    };
                    break;
                case 'label':
                    argStr = argContentToStr(node.args?.[2]?.content || []);
                    element = {
                        type: TeXElementType.Command,
                        name: node.content,
                        label: `${node.content}` + (argStr ? `: ${argStr}` : ''),
                        ...attributes
                    };
                    break;
                case 'subFile':
                    argStr = argContentToStr(node.args?.[0]?.content || []);
                    element = {
                        type: TeXElementType.SubFile,
                        name: node.content,
                        label: argStr ? `${argStr}` : '',
                        ...attributes
                    };
                    break;
                case 'bibFile':
                    argStr = argContentToStr(node.args?.[0]?.content || []);
                    element = {
                        type: TeXElementType.BibFile,
                        name: node.content,
                        label: argStr ? `${argStr}` : '',
                        ...attributes
                    };
                    break;
                }
            break;
        case 'environment':
            switch (node.env) {
                case 'frame':
                    const frameTitleMacro: Ast.Macro | undefined = node.content.find(
                        sub => sub.type === 'macro' && sub.content === 'frametitle'
                    ) as Ast.Macro | undefined;
                    caption = argContentToStr(node.args?.[3]?.content || []) ||
                        argContentToStr(frameTitleMacro?.args?.[3]?.content || []);
                    element = {
                        type: TeXElementType.Environment,
                        name: node.env,
                        label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` +
                            (caption ? `: ${caption}` : ''),
                        ...attributes
                    };
                    break;

                case 'figure':
                case 'figure*':
                case 'table':
                case 'table*':
                    const captionMacro: Ast.Macro | undefined = node.content.find(
                        sub => sub.type === 'macro' && sub.content === 'caption'
                    ) as Ast.Macro | undefined;
                    caption = argContentToStr(captionMacro?.args?.[1]?.content || []);
                    if (node.env.endsWith('*')) {
                        node.env = node.env.slice(0, -1);
                    }
                    element = {
                        type: TeXElementType.Environment,
                        name: node.env,
                        label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` +
                            (caption ? `: ${caption}` : ''),
                        ...attributes
                    };
                    break;

                case 'macro':
                case 'environment':
                default:
                    if (defaultStructure.includes(node.env)) {
                        const caption = (node.content[0] as Ast.Group | undefined)?.content[0] as Ast.String | undefined;
                        element = {
                            type: TeXElementType.Environment,
                            name: node.env,
                            label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` +
                                (caption ? `: ${caption.content}` : ''),
                            ...attributes
                        };
                    } else {
                        element = {
                            type: TeXElementType.Environment,
                            name: node.env,
                            label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}`,
                            ...attributes
                        };
                    }
                    break;
            }
            break;
        case 'mathenv':
            switch (node.env) {
                case 'string':
                    element = {
                        type: TeXElementType.Environment,
                        name: node.env,
                        label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}`,
                        ...attributes
                    };
                    break;
            }
            break;
    }

    if (element !== undefined) {
        root.children.push(element);
        root = element;
    }

    if ('content' in node && typeof node.content !== 'string') {
        for (const sub of node.content) {
            if (['string', 'parbreak', 'whitespace'].includes(sub.type)) {
                continue;
            }
            await parseNode(sub, root);
        }
    }
}

/*
    * Recursively format a tree-like TeXElement[] structure based on the given order in defaultStructure
    * 
    * @param parentStruct: the parent TeXElement[] structure
    * @return: the formatted TeXElement[] structure with children fulfilled
*/
function hierarchyStructFormat(parentStruct: TeXElement[]): TeXElement[] {
    const resStruct: TeXElement[] = [];
    const orderFromDefaultStructure = new Map<string, number>();
    for (const [i, section] of defaultStructure.entries()) {
        orderFromDefaultStructure.set(section, i);
    }

    let prev: TeXElement | undefined;
    for (const section of parentStruct) {
        // Root Node
        if (prev === undefined) {
            resStruct.push(section);
            prev = section;
            continue;
        }
        // Comparing the order of current section and previous section from defaultStructure
        if ((orderFromDefaultStructure.get(section.name) ?? defaultStructure.length) > (orderFromDefaultStructure.get(prev.name) ?? defaultStructure.length)) {
            prev.children.push(section);
        } else {
            resStruct.push(section);
            prev.children = hierarchyStructFormat(prev.children);
            prev = section;
        }
    }

    if (prev !== undefined) {
        prev.children = hierarchyStructFormat(prev.children);
    }
    return resStruct;
}

/*
    * Generate a tree-like structure from a LaTeX file
    * 
    * @param document: the LaTeX file
    * @return: the tree-like TeXElement[] structure
*/
// reference: https://github.com/James-Yu/LaTeX-Workshop/blob/master/src/outline/structurelib/latex.ts#L30
export async function genTexElements(documentText: string): Promise<TeXElement[]> {
    const resElement = { children: [] as TeXElement[] };
    let ast = unifiedParser.parse(documentText);
    for (const node of ast.content) {
        if (['string', 'parbreak', 'whitespace'].includes(node.type)) {
            continue;
        }
        try {
            await parseNode(node, resElement);
        }
        catch (e) {
            error(e);
        }
    }

    const rootStruct = resElement.children;
    const documentTextLines = documentText.split('\n');
    const hierarchyStruct = hierarchyStructFormat(rootStruct);
    updateSecMacroLineTo(hierarchyStruct, documentTextLines.length , documentTextLines);
    return hierarchyStruct;
}

/*
    * Update the lineTo of each section element in the TeXElement[] structure
    * 
    * @param texElements: the TeXElement[] structure
    * @param lastLine: the last lineTo of given TeXElement[] structure
    * @param documentTextLines: the content of the LaTeX file used to refine the lineTo
    * @return: the updated TeXElement[] structure
*/
function updateSecMacroLineTo(texElements: TeXElement[], lastLine: number, documentTextLines: string[]) {
    const secTexElements = texElements.filter(element => element.type === TeXElementType.Section || element.type === TeXElementType.SectionAst);
    for (let index = 1; index <= secTexElements.length; index++) {
        // LineTo of the previous section is the lineFr of the current section OR the last document line
        let lineTo = secTexElements[index]?.lineFr ?? lastLine;

        // Search the non-empty line before the next section
        while (lineTo > 1 && documentTextLines[lineTo - 1].trim() === '') {
            lineTo--;
        }
        secTexElements[index - 1].lineTo = lineTo;
        if (secTexElements[index - 1].children.length > 0 ){
            updateSecMacroLineTo(secTexElements[index - 1].children, lineTo, documentTextLines);
        }
    }
}
