/**
 * Unit tests for threeWayMerge and tryTrivialMerge.
 *
 * Run via:  npx tsc && node out/test/threeWayMerge.test.js
 *
 * Tests cover the exact scenarios from issues #353 and #180:
 * local changes being silently overwritten by remote during sync.
 */

import * as assert from 'assert';
import * as DiffMatchPatch from 'diff-match-patch';
import { threeWayMerge, tryTrivialMerge, ThreeWayMergeResult } from '../src/utils/threeWayMerge';

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertNoConflict(result: ThreeWayMergeResult, expected: string, label: string) {
    assert.strictEqual(result.hasConflict, false, `${label}: expected no conflict`);
    assert.strictEqual(result.content, expected, `${label}: content mismatch`);
}

function assertConflict(result: ThreeWayMergeResult, label: string) {
    assert.strictEqual(result.hasConflict, true, `${label}: expected conflict`);
    // Verify conflict markers are present
    assert.ok(result.content.includes('<<<<<<< Local'), `${label}: missing Local marker`);
    assert.ok(result.content.includes('======='), `${label}: missing separator`);
    assert.ok(result.content.includes('>>>>>>> Remote'), `${label}: missing Remote marker`);
}

// ─── tryTrivialMerge tests ──────────────────────────────────────────────────

console.log('\n─── tryTrivialMerge ───');

{
    // base == local → use remote
    const r = tryTrivialMerge('same', 'same', 'remote');
    assert.strictEqual(r, 'remote', 'base==local should return remote');
    console.log('  ✓ base==local → remote');
}
{
    // base == remote → use local
    const r = tryTrivialMerge('same', 'local', 'same');
    assert.strictEqual(r, 'local', 'base==remote should return local');
    console.log('  ✓ base==remote → local');
}
{
    // local == remote → use local
    const r = tryTrivialMerge('base', 'same', 'same');
    assert.strictEqual(r, 'same', 'local==remote should return either');
    console.log('  ✓ local==remote → either');
}
{
    // All different → undefined (need full merge)
    const r = tryTrivialMerge('base', 'local', 'remote');
    assert.strictEqual(r, undefined, 'all different should return undefined');
    console.log('  ✓ all different → undefined');
}
{
    // All empty
    const r = tryTrivialMerge('', '', '');
    assert.strictEqual(r, '', 'all empty should return empty');
    console.log('  ✓ all empty → empty');
}

// ─── threeWayMerge: no-change cases ─────────────────────────────────────────

console.log('\n─── threeWayMerge: no-change ───');

{
    // All identical
    const r = threeWayMerge('hello\nworld', 'hello\nworld', 'hello\nworld');
    assertNoConflict(r, 'hello\nworld', 'identical content');
    console.log('  ✓ identical content');
}
{
    // Empty all around
    const r = threeWayMerge('', '', '');
    assertNoConflict(r, '', 'all empty');
    console.log('  ✓ all empty');
}

// ─── threeWayMerge: one-side changes ────────────────────────────────────────

console.log('\n─── threeWayMerge: one-side changes ───');

{
    // Only local changed
    const base = 'line1\nline2\nline3';
    const local = 'line1\nline2_MODIFIED\nline3';
    const remote = 'line1\nline2\nline3';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, local, 'only local changed');
    console.log('  ✓ only local changed');
}
{
    // Only remote changed
    const base = 'line1\nline2\nline3';
    const local = 'line1\nline2\nline3';
    const remote = 'line1\nline2_REMOTE\nline3';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, remote, 'only remote changed');
    console.log('  ✓ only remote changed');
}
{
    // Local deletes a line
    const base = 'A\nB\nC';
    const local = 'A\nC';
    const remote = 'A\nB\nC';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, local, 'local deletion');
    console.log('  ✓ local deletion');
}
{
    // Remote inserts a line
    const base = 'A\nB\nC';
    const local = 'A\nB\nC';
    const remote = 'A\nB\nINSERTED\nC';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, remote, 'remote insertion');
    console.log('  ✓ remote insertion');
}

// ─── threeWayMerge: non-overlapping changes (auto-merge) ────────────────────

console.log('\n─── threeWayMerge: non-overlapping changes (auto-merge) ───');

{
    // Local changes line 2, remote changes line 4 — separate regions
    const base = 'line1\nline2\nline3\nline4\nline5';
    const local = 'line1\nLOCAL\nline3\nline4\nline5';
    const remote = 'line1\nline2\nline3\nREMOTE\nline5';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, 'line1\nLOCAL\nline3\nREMOTE\nline5', 'non-overlapping changes');
    console.log('  ✓ non-overlapping line modifications');
}
{
    // Local adds at beginning, remote adds at end
    const base = 'A\nB\nC';
    const local = 'LOCAL_START\nA\nB\nC';
    const remote = 'A\nB\nC\nREMOTE_END';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, 'LOCAL_START\nA\nB\nC\nREMOTE_END', 'additions at both ends');
    console.log('  ✓ additions at opposite ends');
}
{
    // Local deletes line 1, remote modifies line 3
    const base = 'A\nB\nC\nD\nE';
    const local = 'B\nC\nD\nE';  // delete A
    const remote = 'A\nB\nC_MOD\nD\nE';  // modify C
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, 'B\nC_MOD\nD\nE', 'local delete + remote modify (non-overlap)');
    console.log('  ✓ local delete + remote modify (separate regions)');
}

// ─── threeWayMerge: CONFLICT cases (issue #353, #180 scenarios) ─────────────

console.log('\n─── threeWayMerge: conflicts ───');

{
    // Same line modified differently — THE CLASSIC CONFLICT
    const base = 'line1\nline2\nline3';
    const local = 'line1\nLOCAL_VERSION\nline3';
    const remote = 'line1\nREMOTE_VERSION\nline3';
    const r = threeWayMerge(base, local, remote);
    assertConflict(r, 'same line modified');
    assert.ok(r.content.includes('LOCAL_VERSION'), 'conflict should contain local version');
    assert.ok(r.content.includes('REMOTE_VERSION'), 'conflict should contain remote version');
    console.log('  ✓ same line modified differently → conflict markers');
}
{
    // Local deletes, remote modifies same line — ISSUE #353/#180
    const base = 'A\nB\nC';
    const local = 'A\nC';  // deleted B
    const remote = 'A\nB_MODIFIED\nC';  // modified B
    const r = threeWayMerge(base, local, remote);
    assertConflict(r, 'local delete vs remote modify');
    // Local side of conflict should be empty (deletion)
    console.log('  ✓ local delete vs remote modify → conflict (not silent overwrite)');
}
{
    // Both insert at same position
    const base = 'A\nB\nC';
    const local = 'A\nLOCAL_INSERT\nB\nC';
    const remote = 'A\nREMOTE_INSERT\nB\nC';
    const r = threeWayMerge(base, local, remote);
    assertConflict(r, 'both insert at same position');
    console.log('  ✓ both insert at same position → conflict');
}
{
    // Both insert at beginning of file (empty base position)
    const base = '';
    const local = 'LOCAL_CONTENT';
    const remote = 'REMOTE_CONTENT';
    const r = threeWayMerge(base, local, remote);
    assertConflict(r, 'both insert at empty base');
    console.log('  ✓ both insert at empty base → conflict');
}
{
    // Local inserts, remote deletes surrounding region
    const base = 'A\nB\nC\nD\nE';
    const local = 'A\nB\nINSERTED\nC\nD\nE';
    const remote = 'A\nE';  // deleted B,C,D
    const r = threeWayMerge(base, local, remote);
    assertConflict(r, 'local insert inside remote delete region');
    console.log('  ✓ local insert inside remote deletion → conflict');
}

// ─── threeWayMerge: edge cases ──────────────────────────────────────────────

console.log('\n─── threeWayMerge: edge cases ───');

{
    // Empty base, local adds content, remote unchanged
    const r = threeWayMerge('', 'new content', '');
    assertNoConflict(r, 'new content', 'empty base, local adds');
    console.log('  ✓ empty base, only local adds');
}
{
    // Empty base, remote adds content, local unchanged
    const r = threeWayMerge('', '', 'new content');
    assertNoConflict(r, 'new content', 'empty base, remote adds');
    console.log('  ✓ empty base, only remote adds');
}
{
    // single line, no newline
    const r = threeWayMerge('hello', 'hello world', 'hello');
    assertNoConflict(r, 'hello world', 'single line modification');
    console.log('  ✓ single line modification');
}
{
    // trailing newline preservation
    const base = 'A\nB\n';
    const local = 'A\nB_MOD\n';
    const remote = 'A\nB\n';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, 'A\nB_MOD\n', 'trailing newline preserved');
    console.log('  ✓ trailing newline preserved');
}
{
    // multiple non-overlapping hunks
    const base = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10';
    const local = '1\n2_LOCAL\n3\n4\n5\n6\n7\n8_LOCAL\n9\n10';
    const remote = '1\n2\n3\n4_REMOTE\n5\n6_REMOTE\n7\n8\n9\n10';
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, '1\n2_LOCAL\n3\n4_REMOTE\n5\n6_REMOTE\n7\n8_LOCAL\n9\n10', 'multiple non-overlapping hunks');
    console.log('  ✓ multiple non-overlapping hunks');
}
{
    // LaTeX-like content (realistic scenario from issues)
    const base = [
        '\\section{Introduction}',
        'This is the introduction.',
        '',
        '\\section{Methods}',
        'We used method A.',
        '',
        '\\section{Results}',
        'The results are shown.',
        '',
        '\\end{document}',
    ].join('\n');

    const local = [
        '\\section{Introduction}',
        'This is the UPDATED introduction.',
        '',
        '\\section{Methods}',
        'We used method A.',
        '',
        '\\section{Results}',
        'The results are shown.',
        '',
        '\\end{document}',
    ].join('\n');

    const remote = [
        '\\section{Introduction}',
        'This is the introduction.',
        '',
        '\\section{Methods}',
        'We used method B (improved).',
        '',
        '\\section{Results}',
        'The results are shown.',
        '',
        '\\end{document}',
    ].join('\n');

    // Non-overlapping: local changes Introduction, remote changes Methods
    const r = threeWayMerge(base, local, remote);
    assertNoConflict(r, [
        '\\section{Introduction}',
        'This is the UPDATED introduction.',
        '',
        '\\section{Methods}',
        'We used method B (improved).',
        '',
        '\\section{Results}',
        'The results are shown.',
        '',
        '\\end{document}',
    ].join('\n'), 'LaTeX non-overlapping sections');
    console.log('  ✓ LaTeX non-overlapping sections auto-merge');
}
{
    // LaTeX-like conflict: both edit the same paragraph
    const base = [
        '\\section{Abstract}',
        'This paper presents a novel approach.',
        '',
        '\\section{Introduction}',
        'The field has grown rapidly.',
    ].join('\n');

    const local = [
        '\\section{Abstract}',
        'We propose a revolutionary method for solving this problem.',
        '',
        '\\section{Introduction}',
        'The field has grown rapidly.',
    ].join('\n');

    const remote = [
        '\\section{Abstract}',
        'This work introduces an innovative framework.',
        '',
        '\\section{Introduction}',
        'The field has grown rapidly.',
    ].join('\n');

    const r = threeWayMerge(base, local, remote);
    assertConflict(r, 'LaTeX same paragraph edited');
    assert.ok(r.content.includes('revolutionary method'), 'should contain local text');
    assert.ok(r.content.includes('innovative framework'), 'should contain remote text');
    console.log('  ✓ LaTeX same paragraph conflict → markers with both versions');
}

// ─── Post-conflict resolution (writeFile flow simulation) ───────────────────

console.log('\n─── Post-conflict resolution (OT correctness) ───');

{
    // SCENARIO: User resolves a conflict and saves.
    //
    // Initial state:
    //   base  = original common ancestor
    //   local = user's edit (before seeing conflict)
    //   remote = server's version
    //
    // After conflict detection, writeFile() writes markers & sets:
    //   doc.localCache = conflictedState (with <<<<<<<, =======, >>>>>>>)
    //   doc._otBase = remote (PRESERVED — server's actual state)
    //
    // User resolves by editing the file to resolvedContent and saves.
    // writeFile() sees _otBase !== undefined → skips threeWayMerge,
    // restores doc.remoteCache = _otBase, computes OT op as
    // diff(remoteCache → resolvedContent), then deletes _otBase.
    //
    // This test verifies that computing OT op from the PRESERVED server state
    // is correct, whereas computing it from the conflicted state would be WRONG.

    const base = 'line1\nline2\nline3';
    const local = 'line1\nLOCAL_EDIT\nline3';      // what user wrote
    const remote = 'line1\nREMOTE_EDIT\nline3';    // what server has

    // Simulate conflict detection
    const conflictResult = threeWayMerge(base, local, remote);
    assert.strictEqual(conflictResult.hasConflict, true);
    const conflictedState = conflictResult.content; // contains <<<<<<<, =======, >>>>>>>

    // User resolves: picks local version
    const resolvedContent = local;

    // --- CORRECT approach (what the _otBase path does) ---
    // OT op = diff(remoteCache → resolvedContent), where remoteCache was restored
    // from the preserved _otBase (server state at conflict time)
    const dmp1 = new DiffMatchPatch();
    const correctOp = (dmp1 as any).patch_make(remote, resolvedContent);
    const [correctApplyResult, correctApplyOk] = (dmp1 as any).patch_apply(correctOp, remote);
    const allCorrectApplied = (correctApplyOk as boolean[]).every((ok: boolean) => ok);
    assert.strictEqual(correctApplyResult, resolvedContent,
        'CORRECT: diff(serverState→resolved) applied to serverState yields resolved content');
    assert.ok(allCorrectApplied, 'CORRECT: all patches applied cleanly');

    // --- WRONG approach (the OLD bug: overwriting remoteCache without _otBase) ---
    // OT op = diff(conflictedState → resolvedContent), but server has remote, NOT conflicted
    const dmp2 = new DiffMatchPatch();
    const wrongOp = (dmp2 as any).patch_make(conflictedState, resolvedContent);
    const [wrongApplyResult, wrongApplyOk] = (dmp2 as any).patch_apply(wrongOp, remote);
    // This will likely produce garbled output or fail to apply cleanly
    const allWrongApplied = (wrongApplyOk as boolean[]).every((ok: boolean) => ok);
    const wrongIsCorrect = wrongApplyResult === resolvedContent && allWrongApplied;
    // In practice, applying diff(conflicted→resolved) to serverState gives garbage
    assert.strictEqual(wrongIsCorrect, false,
        'WRONG (old bug): diff(conflicted→resolved) applied to serverState does NOT yield resolved');
    console.log('  ✓ post-conflict OT op: diff(serverState→resolved) is correct');
    console.log('  ✓ post-conflict OT op: diff(conflictedState→resolved) would corrupt');
}

{
    // SCENARIO: User resolves by picking the REMOTE side
    const base = 'A\nB\nC\nD\nE';
    const local = 'A\nB_LOCAL\nC\nD\nE';
    const remote = 'A\nB_REMOTE\nC\nD\nE';

    const conflictResult = threeWayMerge(base, local, remote);
    assert.strictEqual(conflictResult.hasConflict, true);

    // User decides to keep remote version
    const resolvedContent = remote;
    const dmp = new DiffMatchPatch();
    const op = (dmp as any).patch_make(remote, resolvedContent);
    const [applyResult, applyOk] = (dmp as any).patch_apply(op, remote);
    assert.strictEqual(applyResult, resolvedContent,
        'choosing remote side: diff(remote→remote) = identity');
    console.log('  ✓ post-conflict: choosing remote side → identity OT op');
}

{
    // SCENARIO: User resolves by writing a completely new merged version
    const base = 'line1\nline2\nline3';
    const local = 'line1\nLOCAL\nline3';
    const remote = 'line1\nREMOTE\nline3';

    const conflictResult = threeWayMerge(base, local, remote);
    assert.strictEqual(conflictResult.hasConflict, true);

    // User manually writes a merged version
    const resolvedContent = 'line1\nMERGED_BY_USER\nline3';
    const dmp = new DiffMatchPatch();
    const op = (dmp as any).patch_make(remote, resolvedContent);
    const [applyResult, applyOk] = (dmp as any).patch_apply(op, remote);
    assert.strictEqual(applyResult, resolvedContent,
        'custom merge: diff(serverState→merged) applied correctly');
    console.log('  ✓ post-conflict: custom merge resolution → correct OT op');
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n─── All tests passed ✓ ───\n');
