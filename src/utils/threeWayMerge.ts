import * as DiffMatchPatch from 'diff-match-patch';

/**
 * Result of a three-way merge operation.
 */
export interface ThreeWayMergeResult {
    /** The merged content. If hasConflict is true, contains <<<<<<<, =======, >>>>>>> markers. */
    content: string;
    /** Whether conflicts were detected during the merge. */
    hasConflict: boolean;
}

/**
 * Represents a contiguous changed region (hunk) in a diff.
 * All indices are line numbers (0-based).
 */
interface DiffHunk {
    /** Start line in base (0-based, inclusive). */
    baseStart: number;
    /** End line in base (0-based, exclusive). */
    baseEnd: number;
    /** Start line in the modified version (0-based, inclusive). */
    modifiedStart: number;
    /** End line in the modified version (0-based, exclusive). */
    modifiedEnd: number;
    /** The lines that replace base[baseStart..baseEnd] in the modified version. */
    modifiedLines: string[];
}

/**
 * Compute line-level diff hunks between base and modified text.
 *
 * Uses diff-match-patch's line-mode diff internally for robust line-level comparison,
 * then converts the raw diffs into structured hunks.
 */
function computeHunks(baseLines: string[], modifiedLines: string[]): DiffHunk[] {
    const dmp = new DiffMatchPatch();
    const baseText = baseLines.join('\n');
    const modText = modifiedLines.join('\n');

    // Use DMP's line-mode diff: each line is encoded as a single character,
    // then diffed at character level, then decoded back to lines.
    const lineData = (dmp as any).diff_linesToChars_(baseText, modText);
    const rawDiffs: Array<[number, string]> = dmp.diff_main(lineData.chars1, lineData.chars2, false);
    (dmp as any).diff_charsToLines_(rawDiffs, lineData.lineArray);

    const hunks: DiffHunk[] = [];
    let basePos = 0;
    let modPos = 0;

    for (const [op, text] of rawDiffs) {
        // The text from diff_charsToLines_ is a concatenation of lines each ending with '\n'.
        // Split and remove the trailing empty entry.
        const lines = text.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }
        const lineCount = lines.length;

        if (op === 0) {
            // Equal: advance both positions
            basePos += lineCount;
            modPos += lineCount;
        } else if (op === -1) {
            // Delete from base: base has these lines, modified does not
            hunks.push({
                baseStart: basePos,
                baseEnd: basePos + lineCount,
                modifiedStart: modPos,
                modifiedEnd: modPos,
                modifiedLines: [],
            });
            basePos += lineCount;
        } else if (op === 1) {
            // Insert into modified: base does not have these lines, modified does
            hunks.push({
                baseStart: basePos,
                baseEnd: basePos,
                modifiedStart: modPos,
                modifiedEnd: modPos + lineCount,
                modifiedLines: lines,
            });
            modPos += lineCount;
        }
    }

    return hunks;
}

/**
 * Check whether two hunks overlap in the base in a way that could cause conflict.
 *
 * Returns true if:
 * 1. The hunk base ranges intersect (they touch the same lines), OR
 * 2. One hunk is a pure insert (baseStart === baseEnd) at a position
 *    that the other hunk touches or deletes.
 */
function hunksOverlap(a: DiffHunk, b: DiffHunk): boolean {
    // Standard range intersection: the hunks share at least one base line
    if (a.baseStart < b.baseEnd && b.baseStart < a.baseEnd) {
        return true;
    }
    // Pure insert at a position inside the other hunk's affected range.
    // Example: local inserts at line 5 while remote deletes/modifies lines 4-6.
    if (a.baseStart === a.baseEnd && a.baseStart >= b.baseStart && a.baseStart <= b.baseEnd) {
        return true;
    }
    if (b.baseStart === b.baseEnd && b.baseStart >= a.baseStart && b.baseStart <= a.baseEnd) {
        return true;
    }
    return false;
}

/**
 * Merge two adjacent or overlapping hunks from the same side into one.
 */
function mergeAdjacentHunks(hunks: DiffHunk[]): DiffHunk[] {
    if (hunks.length <= 1) { return hunks; }

    const merged: DiffHunk[] = [];
    let current = hunks[0];

    for (let i = 1; i < hunks.length; i++) {
        const next = hunks[i];
        // Adjacent or overlapping in base
        if (current.baseEnd >= next.baseStart) {
            // Merge: extend base range and append modified lines
            current = {
                baseStart: Math.min(current.baseStart, next.baseStart),
                baseEnd: Math.max(current.baseEnd, next.baseEnd),
                modifiedStart: Math.min(current.modifiedStart, next.modifiedStart),
                modifiedEnd: Math.max(current.modifiedEnd, next.modifiedEnd),
                modifiedLines: current.modifiedLines.concat(next.modifiedLines),
            };
        } else {
            merged.push(current);
            current = next;
        }
    }
    merged.push(current);
    return merged;
}

/**
 * A resolved merge entry: either a clean hunk from one side, or a conflict group.
 */
type MergeEntry =
    | { kind: 'equal'; baseStart: number; baseEnd: number }
    | { kind: 'hunk'; baseStart: number; baseEnd: number; side: 'local' | 'remote'; modifiedLines: string[] }
    | { kind: 'conflict'; baseStart: number; baseEnd: number;
        localHunks: DiffHunk[]; remoteHunks: DiffHunk[] };

/**
 * Split text into lines. Unlike `String.split('\n')`, an empty input string
 * yields an empty array `[]` (not `['']`), preventing spurious empty-line
 * artifacts during merge reconstruction.
 */
function splitLines(text: string): string[] {
    if (text === '') { return []; }
    return text.split('\n');
}

/**
 * Perform a three-way merge (like Git's diff3) of `local` and `remote` changes
 * against a common `base` ancestor.
 *
 * - Non-overlapping changes are merged automatically.
 * - Overlapping changes (conflicts) are marked with standard Git conflict markers
 *   (`<<<<<<< Local`, `=======`, `>>>>>>> Remote`) that VS Code natively understands
 *   and provides a merge conflict resolution UI for.
 *
 * @param base   The common ancestor text.
 * @param local  The local (current) version of the text.
 * @param remote The remote (incoming) version of the text.
 * @returns A {@link ThreeWayMergeResult} with the merged content and conflict flag.
 */
export function threeWayMerge(base: string, local: string, remote: string): ThreeWayMergeResult {
    const baseLines = splitLines(base);
    const localLines = splitLines(local);
    const remoteLines = splitLines(remote);

    // Compute edit hunks from base to each side
    const localHunks = mergeAdjacentHunks(computeHunks(baseLines, localLines));
    const remoteHunks = mergeAdjacentHunks(computeHunks(baseLines, remoteLines));

    // Build a unified, sorted list of all hunks with side tags
    type TaggedHunk = DiffHunk & { side: 'local' | 'remote' };
    const allTaggedHunks: TaggedHunk[] = [
        ...localHunks.map(h => ({ ...h, side: 'local' as const })),
        ...remoteHunks.map(h => ({ ...h, side: 'remote' as const })),
    ].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

    // --- Phase 1: Group overlapping hunks into MergeEntries ---
    const entries: MergeEntry[] = [];
    const processed = new Set<number>(); // indices into allTaggedHunks that have been consumed

    for (let i = 0; i < allTaggedHunks.length; i++) {
        if (processed.has(i)) { continue; }

        // Find all hunks (including this one) that form a connected overlap chain
        const group: TaggedHunk[] = [allTaggedHunks[i]];
        processed.add(i);

        // Expand the group transitively: any hunk that overlaps with any hunk already in the group
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (let j = i + 1; j < allTaggedHunks.length; j++) {
                if (processed.has(j)) { continue; }
                for (const gh of group) {
                    if (hunksOverlap(gh, allTaggedHunks[j])) {
                        group.push(allTaggedHunks[j]);
                        processed.add(j);
                        expanded = true;
                        break;
                    }
                }
            }
        }

        // Sort group by baseStart
        group.sort((a, b) => a.baseStart - b.baseStart);

        const localInGroup = group.filter(h => h.side === 'local');
        const remoteInGroup = group.filter(h => h.side === 'remote');

        if (localInGroup.length > 0 && remoteInGroup.length > 0) {
            // Both sides touched this region → CONFLICT
            const baseStart = Math.min(...group.map(h => h.baseStart));
            const baseEnd = Math.max(...group.map(h => h.baseEnd));
            entries.push({
                kind: 'conflict',
                baseStart,
                baseEnd,
                localHunks: localInGroup,
                remoteHunks: remoteInGroup,
            });
        } else if (localInGroup.length > 0) {
            // Only local changed → apply local hunks
            for (const h of localInGroup) {
                entries.push({
                    kind: 'hunk',
                    baseStart: h.baseStart,
                    baseEnd: h.baseEnd,
                    side: 'local',
                    modifiedLines: h.modifiedLines,
                });
            }
        } else {
            // Only remote changed → apply remote hunks
            for (const h of remoteInGroup) {
                entries.push({
                    kind: 'hunk',
                    baseStart: h.baseStart,
                    baseEnd: h.baseEnd,
                    side: 'remote',
                    modifiedLines: h.modifiedLines,
                });
            }
        }
    }

    // Sort entries by baseStart
    entries.sort((a, b) => a.baseStart - b.baseStart);

    // --- Phase 2: Walk through base, applying entries ---
    const result: string[] = [];
    let hasConflict = false;
    let baseIdx = 0;

    for (const entry of entries) {
        // Copy unchanged base lines up to this entry
        while (baseIdx < entry.baseStart && baseIdx < baseLines.length) {
            result.push(baseLines[baseIdx]);
            baseIdx++;
        }

        if (entry.kind === 'conflict') {
            // Build local version: base region with local hunks applied
            const localVersion = applyHunksToBase(
                baseLines, entry.baseStart, entry.baseEnd, entry.localHunks
            );
            // Build remote version: base region with remote hunks applied
            const remoteVersion = applyHunksToBase(
                baseLines, entry.baseStart, entry.baseEnd, entry.remoteHunks
            );

            result.push('<<<<<<< Local');
            for (const line of localVersion) { result.push(line); }
            result.push('=======');
            for (const line of remoteVersion) { result.push(line); }
            result.push('>>>>>>> Remote');

            hasConflict = true;
            baseIdx = entry.baseEnd;
        } else if (entry.kind === 'hunk') {
            // Apply the hunk: skip deleted base lines, add modified lines
            baseIdx = entry.baseEnd;
            for (const line of entry.modifiedLines) {
                result.push(line);
            }
        }
    }

    // Copy remaining base lines
    while (baseIdx < baseLines.length) {
        result.push(baseLines[baseIdx]);
        baseIdx++;
    }

    return {
        content: result.join('\n'),
        hasConflict,
    };
}

/**
 * Apply a set of hunks to a base region, returning the resulting lines.
 * Used to reconstruct local/remote versions for conflict markers.
 */
function applyHunksToBase(
    baseLines: string[],
    regionStart: number,
    regionEnd: number,
    hunks: DiffHunk[]
): string[] {
    // Sort hunks by baseStart
    const sorted = [...hunks].sort((a, b) => a.baseStart - b.baseStart);
    const result: string[] = [];
    let pos = regionStart;

    for (const hunk of sorted) {
        // Copy base lines before this hunk
        while (pos < hunk.baseStart && pos < regionEnd) {
            result.push(baseLines[pos]);
            pos++;
        }
        // Apply hunk: skip deleted base lines, insert modified lines
        for (const line of hunk.modifiedLines) {
            result.push(line);
        }
        pos = hunk.baseEnd;
    }

    // Copy remaining base lines
    while (pos < regionEnd) {
        result.push(baseLines[pos]);
        pos++;
    }

    return result;
}

/**
 * Quick check: can we do a fast trivial merge without conflict?
 * Returns the merged content if trivial, or undefined if a full three-way merge is needed.
 */
export function tryTrivialMerge(base: string, local: string, remote: string): string | undefined {
    if (base === local) {
        // Local hasn't changed; use remote
        return remote;
    }
    if (base === remote) {
        // Remote hasn't changed; use local
        return local;
    }
    if (local === remote) {
        // Both made the same changes; use either
        return local;
    }
    return undefined; // Need full three-way merge
}
