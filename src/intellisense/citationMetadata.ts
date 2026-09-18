export type CitationMetadata = {
    key: string;
    title?: string;
    author?: string;
    year?: string;
    journal?: string;
    booktitle?: string;
};

const entryStartRegex = /@(?:(?!STRING\b)[^{])+\{\s*([^},]+),/gim;

function findMatchingBrace(content: string, openBraceIndex: number): number {
    let depth = 0;
    for (let i = openBraceIndex; i < content.length; i++) {
        const ch = content[i];
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function normalizeFieldValue(rawValue: string): string {
    // Normalize BibTeX formatting for UI display.
    // This strips capitalization/grouping braces (e.g. {C}omprehensive -> Comprehensive)
    // and unescapes a few common escaped characters.
    const normalized = rawValue
        .replace(/[{}]/g, '')
        .replace(/\\&/g, '&')
        .replace(/\\_/g, '_')
        .replace(/\\%/g, '%')
        .replace(/\\#/g, '#')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return normalized;
}

function extractField(entryBody: string, fieldName: string): string | undefined {
    const regex = new RegExp(`(?:^|,)\\s*${fieldName}\\s*=\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\}|\"[^\"]*\")`, 'im');
    const match = regex.exec(entryBody);
    if (!match) {
        return undefined;
    }

    let value = match[1].trim();
    if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
    }
    value = normalizeFieldValue(value);
    return value === '' ? undefined : value;
}

export function parseBibContent(content: string): CitationMetadata[] {
    const entries: CitationMetadata[] = [];
    let match: RegExpExecArray | null;

    while ((match = entryStartRegex.exec(content))) {
        const key = match[1]?.trim();
        if (!key) {
            continue;
        }

        const openBraceIndex = content.indexOf('{', match.index);
        if (openBraceIndex < 0) {
            continue;
        }
        const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
        if (closeBraceIndex < 0) {
            continue;
        }

        const entryBody = content.slice(openBraceIndex + 1, closeBraceIndex);
        const firstCommaIndex = entryBody.indexOf(',');
        if (firstCommaIndex < 0) {
            entries.push({ key });
            continue;
        }

        const fieldBody = entryBody.slice(firstCommaIndex + 1);
        entries.push({
            key,
            title: extractField(fieldBody, 'title'),
            author: extractField(fieldBody, 'author'),
            year: extractField(fieldBody, 'year'),
            journal: extractField(fieldBody, 'journal'),
            booktitle: extractField(fieldBody, 'booktitle'),
        });
    }

    return entries;
}
