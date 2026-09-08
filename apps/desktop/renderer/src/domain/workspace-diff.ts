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

/** Iterate without materializing every line of a potentially large captured file. */
function* patchLines(patch: string, start: number, end: number): Generator<string> {
  while (start < end) {
    const newline = patch.indexOf('\n', start);
    const stop = newline < 0 || newline >= end ? end : newline;
    yield patch.slice(start, stop);
    start = stop + 1;
  }
}

/** Associate by actual headers; optionally materialize only the visible line window. */
export function workspaceFilePatches(patch: string, files: WorkspaceChangedFile[], window?: { offset: number; limit: number }): Map<string, WorkspaceDiffLine[]> {
  const result = new Map<string, WorkspaceDiffLine[]>();
  const boundary = /^diff --git /gm;
  let current = boundary.exec(patch);
  while (current) {
    const start = current.index;
    const next = boundary.exec(patch);
    const lines = patchLines(patch, current.index, next?.index ?? patch.length);
    current = next;
    const headers: string[] = [];
    let firstHunk: string | undefined;
    for (const line of lines) {
      if (line.startsWith('@@ ')) { firstHunk = line; break; }
      headers.push(line);
    }
    const target = headers.find(line => line.startsWith('+++ '));
    const source = headers.find(line => line.startsWith('--- '));
    const path = target && target !== '+++ /dev/null' ? unquotePath(target.slice(4)).replace(/^b\//, '')
      : source ? unquotePath(source.slice(4)).replace(/^a\//, '') : null;
    const renamed = headers.find(line => line.startsWith('rename to '));
    const file = files.find(file => file.path === path || (renamed && file.path === unquotePath(renamed.slice(10))))
      ?? files.find(file => headers[0] === `diff --git a/${file.previous_path ?? file.path} b/${file.path}`
        || headers[0] === `diff --git ${JSON.stringify(`a/${file.previous_path ?? file.path}`)} ${JSON.stringify(`b/${file.path}`)}`);
    if (!file) continue;
    let before = 0, after = 0, index = 0;
    const offset = window?.offset ?? 0;
    const limit = window?.limit ?? Infinity;
    const parsed: WorkspaceDiffLine[] = [];
    // A generator's for-of break closes it; resume body with a new iterator at
    // the hunk's actual position, rather than retaining arrays of all lines.
    if (firstHunk !== undefined) {
      const headerLength = headers.reduce((size, line) => size + line.length + 1, 0);
      const bodyStart = start + headerLength;
      for (const text of patchLines(patch, bodyStart, next?.index ?? patch.length)) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        let kind: WorkspaceDiffLine['kind'];
        let oldLine: number | null = null, newLine: number | null = null, content = text;
        if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); kind = 'hunk'; }
        else if (text.startsWith('+')) { kind = 'added'; content = text.slice(1); newLine = after++; }
        else if (text.startsWith('-')) { kind = 'deleted'; content = text.slice(1); oldLine = before++; }
        else if (text.startsWith(' ')) { kind = 'context'; content = text.slice(1); oldLine = before++; newLine = after++; }
        else if (text) kind = 'metadata';
        else continue;
        if (index++ >= offset) parsed.push({ text: content, kind, before: oldLine, after: newLine });
        if (parsed.length >= limit) break;
      }
    }
    result.set(file.path, parsed);
    if (result.size === files.length) break;
  }
  return result;
}
