import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceChangedFile, WorkspaceChangeSummary } from '../../../../shared/workspace-change-summary.mjs';
import type { RoomContributionEditFile } from '../../../../shared/room-agent-work.mjs';
import type { DesktopRoomAgentWork } from '../../electron/ipc-types';
import { contributionCard, editPatchLines, editPreview } from '../src/domain/room-contribution-card';

const NOW = new Date('2026-11-12T12:00:00Z');
const file = (path: string, additions: number, deletions: number, extra: Partial<WorkspaceChangedFile> = {}): WorkspaceChangedFile =>
  ({ path, previous_path: null, status: 'modified', additions, deletions, binary: false, ...extra });
const edit = (path: string, additions: number, deletions = 0, patch = '@@ -1,1 +1,2 @@\n line\n+added', patch_truncated = false): RoomContributionEditFile =>
  ({ path, additions, deletions, patch, patch_truncated });
const snapshot = (files: WorkspaceChangedFile[], extra: Partial<WorkspaceChangeSummary> = {}): WorkspaceChangeSummary => ({
  captured_at: '2026-11-12T00:26:00Z', branch: 'feature', base_revision: 'a'.repeat(40), state: 'ready', files,
  additions: files.reduce((sum, item) => sum + item.additions, 0), deletions: files.reduce((sum, item) => sum + item.deletions, 0),
  hidden_files: 0, patch: '', patch_truncated: false, ...extra,
});
function work(changes: WorkspaceChangeSummary, contribution: { edits?: { files: RoomContributionEditFile[]; hidden_files: number } | null; start?: { committed_at: string | null; in_history: boolean | null } | null } | null): DesktopRoomAgentWork {
  return {
    attemptId: 'attempt', roomId: 'room', sourceMessageId: 'msg_1', agentKey: 'Emmy/agent', revision: 1, updatedAt: changes.captured_at,
    summary: {
      version: contribution ? 4 : 3, recorded_state: 'completed', evidence_incomplete: false, elapsed_ms: 1,
      operation_counts: { unresolved: 0, succeeded: 1, failed: 0, denied_before_start: 0, cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 },
      workspace: changes,
      contribution: contribution ? { changes, summary: 'Added two tests.', edits: contribution.edits ?? null, start: contribution.start ?? null } : { changes, summary: 'Added two tests.' },
    },
  } as DesktopRoomAgentWork;
}
const TEST = 'src/api/__tests__/coordination-policy.test.ts';
const history = (committed_at: string | null) => ({ committed_at, in_history: false });
const oldCopy = (committed_at: string | null, edits = [edit(TEST, 33)]) => work(
  snapshot([file('.env.example', 4, 0), file('ci.yml', 10, 2), file(TEST, 33, 0)], { additions: 496281, deletions: 153216, hidden_files: 3210 }),
  { edits: { files: edits, hidden_files: 0 }, start: history(committed_at) });

test('plain: a v3 record, null edits, or changes that are not ready keep the card of today', () => {
  const changes = snapshot([file('a.ts', 1, 1), file('b.ts', 2, 0, { status: 'added' }), file('c.ts', 0, 1, { status: 'deleted' }), file('d.ts', 1, 0)]);
  const v3 = contributionCard(work(changes, null), NOW)!;
  assert.equal(v3.mode, 'plain');
  assert.deepEqual(v3.rows.map(row => [row.path, row.label, row.edit]), [['a.ts', 'Updated', null], ['b.ts', 'Added', null], ['c.ts', 'Deleted', null]]);
  assert.equal(v3.remaining, '1 more file in the diff');
  assert.deepEqual(v3.button, { label: 'Review 4 files', counts: { additions: 4, deletions: 2 }, path: null });
  assert.equal(v3.comparison, null);
  assert.equal(contributionCard(work(changes, { edits: null, start: history('2026-09-20T10:00:00Z') }), NOW)!.mode, 'plain');
  const unavailable = { ...snapshot([]), state: 'unavailable' as const };
  const notReady = work(unavailable, { edits: { files: [edit('a.ts', 1)], hidden_files: 0 }, start: history('2026-09-20T10:00:00Z') });
  notReady.summary = { ...notReady.summary, workspace: changes } as typeof notReady.summary;
  const card = contributionCard(notReady, NOW)!;
  assert.equal(card.mode, 'plain');
  assert.deepEqual(card.button, { label: 'View workspace', counts: null, path: null });
});

test('normal turn: one edited file that is the one comparison file', () => {
  const card = contributionCard(work(snapshot([file(TEST, 33, 0)]), { edits: { files: [edit(TEST, 33)], hidden_files: 0 }, start: { committed_at: '2026-11-11T10:00:00Z', in_history: true } }), NOW)!;
  assert.equal(card.mode, 'normal');
  assert.deepEqual(card.rows, [{ path: TEST, label: 'Updated', counts: { additions: 33, deletions: 0 }, edit: { patch: '@@ -1,1 +1,2 @@\n line\n+added', patch_truncated: false } }]);
  assert.deepEqual(card.button, { label: 'Review 1 file', counts: { additions: 33, deletions: 0 }, path: null });
  assert.equal(card.remaining, null);
  assert.equal(card.comparison, null);
});

test('changed by a command: a comparison file with no edit is listed after the edited file with its own counts', () => {
  const changes = snapshot([file('package.json', 2, 1), file('logo.png', 0, 0, { binary: true }), file(TEST, 33, 0, { status: 'added' })]);
  const card = contributionCard(work(changes, { edits: { files: [edit(TEST, 30)], hidden_files: 0 }, start: { committed_at: '2026-11-11T10:00:00Z', in_history: true } }), NOW)!;
  assert.equal(card.mode, 'normal');
  assert.deepEqual(card.rows.map(row => [row.path, row.label, row.counts, Boolean(row.edit)]), [
    [TEST, 'Added', { additions: 33, deletions: 0 }, true],
    ['package.json', 'Changed by a command', { additions: 2, deletions: 1 }, false],
    ['logo.png', 'Changed by a command', null, false],
  ]);
  assert.deepEqual(card.button, { label: 'Review 3 files', counts: { additions: 35, deletions: 1 }, path: null });
});

test('old copy: rows come from the edits, with both buttons and the full comparison block', () => {
  const card = contributionCard(oldCopy('2026-09-20T10:00:00Z'), NOW)!;
  assert.equal(card.mode, 'old-copy');
  assert.deepEqual(card.rows.map(row => [row.path, row.label, row.counts]), [[TEST, 'Updated', { additions: 33, deletions: 0 }]]);
  assert.deepEqual(card.button, { label: 'Review 1 file', counts: { additions: 33, deletions: 0 }, path: TEST });
  assert.equal(card.remaining, null);
  assert.deepEqual(card.comparison, {
    header: 'Compared with 20 Sep', title: '3213 files in the full comparison',
    line: 'This workspace started from a copy of the project that is 53 days old, so the comparison includes older project history.',
    counts: { additions: 496281, deletions: 153216 },
  });
});

test('old copy: the age text for 1 day, 0 days, an unknown date, and another year', () => {
  assert.equal(contributionCard(oldCopy('2026-11-11T11:00:00Z'), NOW)!.comparison!.line,
    'This workspace started from a copy of the project that is 1 day old, so the comparison includes older project history.');
  const other = 'This workspace started from a different copy of the project, so the comparison includes other project history.';
  const sameDay = contributionCard(oldCopy('2026-11-12T10:00:00Z'), NOW)!.comparison!;
  assert.equal(sameDay.line, other);
  assert.equal(sameDay.header, 'Compared with 12 Nov');
  const unknown = contributionCard(oldCopy(null), NOW)!.comparison!;
  assert.deepEqual([unknown.header, unknown.line], ['Compared with the workspace start', other]);
  assert.equal(contributionCard(oldCopy('not a date'), NOW)!.comparison!.header, 'Compared with the workspace start');
  assert.equal(contributionCard(oldCopy('2025-12-20T10:00:00Z'), NOW)!.comparison!.header, 'Compared with 20 Dec 2025');
});

test('a start outside the history with no extra comparison file, or an unknown history, stays normal', () => {
  const changes = snapshot([file(TEST, 33, 0)]);
  assert.equal(contributionCard(work(changes, { edits: { files: [edit(TEST, 33)], hidden_files: 0 }, start: history('2026-09-20T10:00:00Z') }), NOW)!.mode, 'normal');
  const wider = snapshot([file(TEST, 33, 0), file('other.ts', 1, 0)]);
  assert.equal(contributionCard(work(wider, { edits: { files: [edit(TEST, 33)], hidden_files: 0 }, start: { committed_at: '2026-09-20T10:00:00Z', in_history: null } }), NOW)!.mode, 'normal');
  assert.equal(contributionCard(work(wider, { edits: { files: [edit(TEST, 33)], hidden_files: 0 }, start: null }), NOW)!.mode, 'normal');
});

test('hidden comparison files count as extra files', () => {
  const changes = snapshot([file(TEST, 33, 0)], { hidden_files: 2 });
  const card = contributionCard(work(changes, { edits: { files: [edit(TEST, 33)], hidden_files: 0 }, start: history('2026-09-20T10:00:00Z') }), NOW)!;
  assert.equal(card.mode, 'old-copy');
  assert.equal(card.comparison!.title, '3 files in the full comparison');
});

test('more than 3 rows show the remaining text in each mode', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
  const edits = { files: paths.map(path => edit(path, 2, 1)), hidden_files: 1 };
  const normal = contributionCard(work(snapshot(paths.map(path => file(path, 2, 1))), { edits, start: { committed_at: null, in_history: true } }), NOW)!;
  assert.equal(normal.rows.length, 3);
  assert.equal(normal.remaining, '2 more files in the diff');
  const old = contributionCard(work(snapshot([file('x.ts', 1, 0)], { hidden_files: 9 }), { edits, start: history(null) }), NOW)!;
  assert.equal(old.mode, 'old-copy');
  assert.deepEqual(old.rows.map(row => row.path), ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(old.remaining, '3 more edited files');
  assert.deepEqual(old.button, { label: 'Review 6 files', counts: { additions: 10, deletions: 5 }, path: 'a.ts' });
});

test('old copy with zero edited files has no main button and keeps the full comparison', () => {
  const card = contributionCard(oldCopy('2026-09-20T10:00:00Z', []), NOW)!;
  assert.equal(card.mode, 'old-copy');
  assert.deepEqual(card.rows, []);
  assert.equal(card.button, null);
  assert.equal(card.comparison!.title, '3213 files in the full comparison');
});

test('a command file past the listed rows is named in the remaining text', () => {
  const changes = snapshot([file('a.ts', 1, 0), file('b.ts', 1, 0), file('c.ts', 1, 0), file('d.ts', 1, 0), file('e.json', 2, 1)]);
  const card = contributionCard(work(changes, { edits: { files: ['a.ts', 'b.ts', 'c.ts'].map(path => edit(path, 1)), hidden_files: 0 }, start: null }), NOW)!;
  assert.deepEqual(card.rows.map(row => row.label), ['Updated', 'Updated', 'Updated']);
  assert.equal(card.remaining, '2 more files in the diff, 2 changed by a command');
  const allEdited = contributionCard(work(changes, { edits: { files: changes.files.map(item => edit(item.path, 1)), hidden_files: 0 }, start: null }), NOW)!;
  assert.equal(allEdited.remaining, '2 more files in the diff');
});

test('with edited files past the record limit, an unlisted file is not called a command change', () => {
  const changes = snapshot([file('a.ts', 1, 0), file('b.ts', 1, 0, { status: 'added' })]);
  const card = contributionCard(work(changes, { edits: { files: [edit('a.ts', 1)], hidden_files: 4 }, start: null }), NOW)!;
  assert.deepEqual(card.rows.map(row => [row.label, row.edit !== null]), [['Updated', true], ['Added', false]]);
});

test('edit patch lines take their numbers from the hunk headers and do not number the no-newline marker', () => {
  const lines = editPatchLines('@@ -519,2 +519,4 @@\n });\n \n+test("a", () => {\n+});\n@@ -10,2 +12,1 @@\n-old\n-gone\n\\ No newline at end of file');
  assert.deepEqual(lines.map(line => [line.kind, line.before, line.after, line.text]), [
    ['context', 519, 519, '});'], ['context', 520, 520, ''], ['added', null, 521, 'test("a", () => {'], ['added', null, 522, '});'],
    ['deleted', 10, null, 'old'], ['deleted', 11, null, 'gone'], ['metadata', null, null, '\\ No newline at end of file'],
  ]);
  assert.deepEqual(editPatchLines(''), []);
});

test('edit preview shows 14 lines and says what is left', () => {
  const patch = '@@ -0,0 +1,20 @@\n' + Array.from({ length: 20 }, (_, index) => `+line ${index + 1}`).join('\n');
  const preview = editPreview({ patch, patch_truncated: false });
  assert.equal(preview.lines.length, 14);
  assert.equal(preview.lines.at(-1)!.after, 14);
  assert.equal(preview.more, 6);
  assert.equal(preview.truncated, false);
  assert.deepEqual(editPreview({ patch: '', patch_truncated: true }), { lines: [], more: 0, truncated: true });
  assert.equal(editPreview({ patch, patch_truncated: true }).truncated, true);
});
