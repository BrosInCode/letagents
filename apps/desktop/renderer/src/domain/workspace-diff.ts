import type { WorkspaceChangedFile } from '../../../../../shared/workspace-change-summary.mjs';

export type WorkspaceDiffLine = {
  text: string;
  kind: 'context' | 'added' | 'deleted' | 'hunk' | 'metadata';
  before: number | null;
  after: number | null;
};

// Git quotes unusual paths using C escapes, including octal UTF-8 bytes.
function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const source = path.slice(1, -1);
  const encoder = new TextEncoder();
  for (let i = 0; i < source.length;) {
    const octal = source[i] === '\\' ? /^\\([0-7]{1,3})/.exec(source.slice(i)) : null;
    if (octal) { bytes.push(parseInt(octal[1], 8)); i += octal[0].length; continue; }
    if (source[i] === '\\' && i + 1 < source.length) {
      const char = source[++i];
      bytes.push(...encoder.encode(({ t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[char] ?? char));
      i++; continue;
    }
    const char = String.fromCodePoint(source.codePointAt(i)!);
    bytes.push(...encoder.encode(char)); i += char.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Associate patches by their actual headers, never by the order of the file list. */
export function workspaceFilePatches(patch: string, files: WorkspaceChangedFile[]): Map<string, WorkspaceDiffLine[]> {
  const result = new Map<string, WorkspaceDiffLine[]>();
  for (const block of patch.split(/(?=^diff --git )/m).filter(Boolean)) {
    const lines = block.split('\n');
    const hunkStart = lines.findIndex(line => line.startsWith('@@ '));
    const headers = hunkStart < 0 ? lines : lines.slice(0, hunkStart);
    const target = headers.find(line => line.startsWith('+++ '));
    const source = headers.find(line => line.startsWith('--- '));
    const path = target && target !== '+++ /dev/null' ? unquotePath(target.slice(4)).replace(/^b\//, '')
      : source ? unquotePath(source.slice(4)).replace(/^a\//, '') : null;
    const renamed = headers.find(line => line.startsWith('rename to '));
    const file = files.find(file => file.path === path || (renamed && file.path === unquotePath(renamed.slice(10))))
      ?? files.find(file => lines[0] === `diff --git a/${file.previous_path ?? file.path} b/${file.path}`
        || lines[0] === `diff --git ${JSON.stringify(`a/${file.previous_path ?? file.path}`)} ${JSON.stringify(`b/${file.path}`)}`);
    if (!file) continue;
    let before = 0, after = 0, inHunk = false;
    const parsed: WorkspaceDiffLine[] = [];
    for (const text of (hunkStart < 0 ? [] : lines.slice(hunkStart))) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        before = Number(hunk[1]); after = Number(hunk[2]); inHunk = true;
        parsed.push({ text, kind: 'hunk', before: null, after: null });
      } else if (inHunk && text.startsWith('+')) parsed.push({ text: text.slice(1), kind: 'added', before: null, after: after++ });
      else if (inHunk && text.startsWith('-')) parsed.push({ text: text.slice(1), kind: 'deleted', before: before++, after: null });
      else if (inHunk && text.startsWith(' ')) parsed.push({ text: text.slice(1), kind: 'context', before: before++, after: after++ });
      else if (text) parsed.push({ text, kind: 'metadata', before: null, after: null });
    }
    result.set(file.path, parsed);
  }
  return result;
}
