import type { DesktopRoomAgentWork } from '../../../electron/ipc-types';
import type { RoomContributionEditFile, RoomContributionEdits, RoomContributionStart } from '../../../../../shared/room-agent-work.mjs';
import type { WorkspaceChangedFile } from '../../../../../shared/workspace-change-summary.mjs';
import { readWorkspaceDiffPage, type WorkspaceDiffIndex, type WorkspaceDiffLine } from './workspace-diff';
import { contributionChanges } from './room-contributions';

export type ContributionCardMode = 'plain' | 'normal' | 'old-copy';
export type ContributionCardCounts = { additions: number; deletions: number };
export type ContributionCardRow = {
  path: string;
  label: string;
  /** Null when the row shows no count (a binary file, or 0/0). */
  counts: ContributionCardCounts | null;
  /** The agent's own edit of this file; null for a file that only a command changed. */
  edit: Pick<RoomContributionEditFile, 'patch' | 'patch_truncated'> | null;
};
export type ContributionCardButton = { label: string; counts: ContributionCardCounts | null; path: string | null };
/** `unedited` says how many comparison files have no edit by the agent: the block never calls a file history without that count. */
export type ContributionCardComparison = { header: string; title: string; line: string; unedited: string; counts: ContributionCardCounts };
export type ContributionCard = {
  mode: ContributionCardMode;
  rows: ContributionCardRow[];
  remaining: string | null;
  button: ContributionCardButton | null;
  comparison: ContributionCardComparison | null;
};

const ROWS = 3;
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;
const statusLabel = (status: string) => (({ added: 'Added', untracked: 'Added', deleted: 'Deleted', renamed: 'Renamed' } as Record<string, string>)[status] ?? 'Updated');
const shownCounts = (file: WorkspaceChangedFile): ContributionCardCounts | null =>
  file.binary || (!file.additions && !file.deletions) ? null : { additions: file.additions, deletions: file.deletions };

function contributionExtras(work: DesktopRoomAgentWork): { edits: RoomContributionEdits | null; start: RoomContributionStart | null } {
  const contribution = 'contribution' in work.summary ? work.summary.contribution : undefined;
  return { edits: contribution?.edits ?? null, start: contribution?.start ?? null };
}

/** `20 Sep`, or `20 Sep 2025` when the date is not in the year of `now`. */
export function contributionStartDate(value: string, now: Date): string {
  // A fixed month table: Intl's en-GB writes "Sept", and the card's copy is "Sep".
  const date = new Date(value);
  const text = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? text : `${text} ${date.getFullYear()}`;
}

/**
 * How many comparison files have no edit. The comparison names only its first files and the edits only
 * their first files, so an edited file can sit in either unnamed rest: the count is then a lower bound.
 */
function uneditedText(extra: number, edits: RoomContributionEdits, listed: readonly WorkspaceChangedFile[], unlisted: number): string {
  const named = new Set(listed.map(file => file.path));
  const maybeEdited = edits.hidden_files + Math.min(unlisted, edits.files.filter(file => !named.has(file.path)).length);
  const count = Math.max(0, extra - maybeEdited);
  return `${maybeEdited ? 'At least ' : ''}${plural(count, 'file')} in it ${count === 1 ? 'has' : 'have'} no edit from this turn.`;
}

/** The card shape for one contribution. Edit events are a summary, never proof: every comparison file stays reachable. */
export function contributionCard(work: DesktopRoomAgentWork, now: Date): ContributionCard | null {
  const changes = contributionChanges(work);
  if (!changes) return null;
  const { edits, start } = contributionExtras(work);
  const cTotal = changes.files.length + changes.hidden_files;
  if (!edits || changes.state !== 'ready') {
    const rows = changes.files.slice(0, ROWS).map(file => ({ path: file.path, label: statusLabel(file.status), counts: null, edit: null }));
    const rest = cTotal - rows.length;
    return {
      mode: 'plain', rows,
      remaining: rest > 0 ? `${rest} more ${rest === 1 ? 'file' : 'files'} in the diff` : null,
      button: changes.state === 'ready'
        ? { label: `Review ${plural(cTotal, 'file')}`, counts: { additions: changes.additions, deletions: changes.deletions }, path: null }
        : { label: 'View workspace', counts: null, path: null },
      comparison: null,
    };
  }
  const edited = new Map(edits.files.map(file => [file.path, file]));
  const extra = changes.files.filter(file => !edited.has(file.path)).length + changes.hidden_files;
  // The agent controls its own history, so the block is only for a comparison too large to list:
  // while the files with no edit fit in the rows, each one stays a named row.
  if (start?.in_history === false && extra > ROWS) {
    const statuses = new Map(changes.files.map(file => [file.path, file.status]));
    const rows = edits.files.slice(0, ROWS).map(file => ({
      path: file.path, label: statusLabel(statuses.get(file.path) ?? 'modified'),
      counts: { additions: file.additions, deletions: file.deletions }, edit: { patch: file.patch, patch_truncated: file.patch_truncated },
    }));
    const eTotal = edits.files.length + edits.hidden_files;
    const rest = eTotal - rows.length;
    const committed = start.committed_at && Number.isFinite(Date.parse(start.committed_at)) ? start.committed_at : null;
    const days = committed ? Math.floor((now.getTime() - Date.parse(committed)) / DAY) : 0;
    return {
      mode: 'old-copy', rows,
      remaining: rest > 0 ? `${rest} more edited ${rest === 1 ? 'file' : 'files'}` : null,
      button: edits.files.length ? {
        label: `Review ${plural(eTotal, 'file')}`,
        counts: edits.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 }),
        path: edits.files[0]!.path,
      } : null,
      comparison: {
        header: committed ? `Compared with ${contributionStartDate(committed, now)}` : 'Compared with the workspace start',
        title: `${plural(cTotal, 'file')} in the full comparison`,
        line: days >= 1
          ? `This workspace started from a copy of the project that is ${plural(days, 'day')} old, so the comparison can include older project history.`
          : 'The history of this workspace changed during the turn, so the comparison can include other work.',
        unedited: uneditedText(extra, edits, changes.files, changes.hidden_files),
        counts: { additions: changes.additions, deletions: changes.deletions },
      },
    };
  }
  const own = changes.files.filter(file => edited.has(file.path));
  const other = changes.files.filter(file => !edited.has(file.path));
  // Edited files first, but one row is kept for a file with no edit: its name matters most to a reader.
  const lead = other.length ? own.slice(0, ROWS - 1) : own;
  const ordered = [...lead, ...other, ...own.slice(lead.length)];
  // Past the listed edit files, an edited file is not told apart from a file that a command changed.
  const editsComplete = edits.hidden_files === 0;
  const rows = ordered.slice(0, ROWS).map(file => {
    const edit = edited.get(file.path);
    return { path: file.path, label: edit || !editsComplete ? statusLabel(file.status) : 'Changed by a command', counts: shownCounts(file),
      edit: edit ? { patch: edit.patch, patch_truncated: edit.patch_truncated } : null };
  });
  const rest = cTotal - rows.length;
  // A file that only a command changed stays named on the card when it is past the listed rows.
  const unlisted = editsComplete ? ordered.slice(ROWS).filter(file => !edited.has(file.path)).length : 0;
  return {
    mode: 'normal', rows,
    remaining: rest > 0 ? `${rest} more ${rest === 1 ? 'file' : 'files'} in the diff${unlisted ? `, ${unlisted} changed by a command` : ''}` : null,
    button: { label: `Review ${plural(cTotal, 'file')}`, counts: { additions: changes.additions, deletions: changes.deletions }, path: null },
    comparison: null,
  };
}

export const EDIT_PREVIEW_LINES = 14;
export type EditPreview = { lines: WorkspaceDiffLine[]; more: number; truncated: boolean };

/** Lines of one edit's hunks, parsed by the review's own diff reader (numbers come from the hunk headers). */
export function editPatchLines(patch: string): WorkspaceDiffLine[] {
  if (!patch) return [];
  const index: WorkspaceDiffIndex = { patch, files: new Map([['edit', { end: patch.length, checkpoints: [{ position: 0, before: 0, after: 0 }] }]]) };
  return readWorkspaceDiffPage(index, 'edit').lines
    .filter(line => line.kind !== 'hunk')
    .map(({ text, kind, before, after }) => ({ text, kind, before, after }));
}

export function editPreview(edit: { patch: string; patch_truncated: boolean }): EditPreview {
  const lines = editPatchLines(edit.patch);
  return { lines: lines.slice(0, EDIT_PREVIEW_LINES), more: Math.max(0, lines.length - EDIT_PREVIEW_LINES), truncated: edit.patch_truncated || !edit.patch };
}
