import type { WorkspaceDiffPage } from './workspace-diff';
type WorkspaceDiffPageLine = WorkspaceDiffPage['lines'][number];

/** Keep the capture's original line numbers, even when a page starts mid-hunk. */
export function workspaceCodeLineNumber(line: WorkspaceDiffPageLine, width = 6): string {
  const sign = line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' ';
  return `${String(line.before ?? '').padStart(width)} ${String(line.after ?? '').padStart(width)} ${sign}`;
}

export function workspaceCodeText(lines: readonly WorkspaceDiffPageLine[]): string {
  return lines.map(line => line.text + (line.nextTextOffset === null ? '' : '…')).join('\n');
}
