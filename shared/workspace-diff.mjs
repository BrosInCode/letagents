function unquotePath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes = [];
  const source = path.slice(1, -1);
  const encoder = new TextEncoder();
  for (let i = 0; i < source.length;) {
    const octal = source[i] === '\\' ? /^\\([0-7]{1,3})/.exec(source.slice(i)) : null;
    if (octal) { bytes.push(parseInt(octal[1], 8)); i += octal[0].length; continue; }
    if (source[i] === '\\' && i + 1 < source.length) {
      const char = source[++i];
      bytes.push(...encoder.encode(({ t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' })[char] ?? char));
      i++; continue;
    }
    const char = String.fromCodePoint(source.codePointAt(i));
    bytes.push(...encoder.encode(char)); i += char.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// File boundaries and sparse line checkpoints are retained only by an open review.
export function createWorkspaceDiffIndex(patch, files) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const byHeader = new Map(files.flatMap(file => [
    [`diff --git a/${file.previous_path ?? file.path} b/${file.path}`, file],
    [`diff --git ${JSON.stringify(`a/${file.previous_path ?? file.path}`)} ${JSON.stringify(`b/${file.path}`)}`, file],
  ]));
  const result = { patch, files: new Map() };
  const boundary = /^diff --git /gm;
  let current = boundary.exec(patch);
  while (current) {
    const next = boundary.exec(patch), end = next?.index ?? patch.length;
    const headers = [];
    let position = current.index;
    while (position < end) {
      const newline = patch.indexOf('\n', position);
      const stop = newline < 0 || newline >= end ? end : newline;
      const line = patch.slice(position, stop);
      if (line.startsWith('@@ ')) break;
      headers.push(line); position = stop + 1;
    }
    const target = headers.find(line => line.startsWith('+++ '));
    const source = headers.find(line => line.startsWith('--- '));
    const path = target && target !== '+++ /dev/null' ? unquotePath(target.slice(4)).replace(/^b\//, '')
      : source ? unquotePath(source.slice(4)).replace(/^a\//, '') : null;
    const renamed = headers.find(line => line.startsWith('rename to '));
    const file = byPath.get(path) ?? (renamed ? byPath.get(unquotePath(renamed.slice(10))) : undefined) ?? byHeader.get(headers[0]);
    if (file) result.files.set(file.path, { end, checkpoints: [{ position, before: 0, after: 0 }] });
    current = next;
  }
  return result;
}

function readLines(index, path, offset, limit, textOffset, characterLimit, budget) {
  const file = index.files.get(path);
  if (!file) return { lines: [], nextOffset: null, included: false };
  const checkpointIndex = Math.min(Math.floor(offset / 500), file.checkpoints.length - 1);
  let { position, before, after } = file.checkpoints[checkpointIndex];
  let row = checkpointIndex * 500;
  const lines = [];
  while (position < file.end) {
    const newline = index.patch.indexOf('\n', position);
    const stop = newline < 0 || newline >= file.end ? file.end : newline;
    const start = position;
    position = stop + 1;
    // Only hunk headers need a regular expression; never slice a giant code line.
    const first = index.patch[start];
    const hunk = first === '@' ? /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(index.patch.slice(start, Math.min(stop, start + 256))) : null;
    let kind, oldLine = null, newLine = null, contentStart = start;
    if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); kind = 'hunk'; }
    else if (first === '+') { kind = 'added'; contentStart++; newLine = after++; }
    else if (first === '-') { kind = 'deleted'; contentStart++; oldLine = before++; }
    else if (first === ' ') { kind = 'context'; contentStart++; oldLine = before++; newLine = after++; }
    else if (stop > start) kind = 'metadata';
    else continue;
    if (row >= offset) {
      const textLength = stop - contentStart;
      let from = Math.min(textOffset, textLength), to = Math.min(textLength, from + characterLimit, from + budget);
      // Keep UTF-16 surrogate pairs intact at display-chunk boundaries.
      if (from && /[\uDC00-\uDFFF]/.test(index.patch[contentStart + from]) && /[\uD800-\uDBFF]/.test(index.patch[contentStart + from - 1])) from--;
      if (to < textLength && /[\uD800-\uDBFF]/.test(index.patch[contentStart + to - 1])) to--;
      const text = index.patch.slice(contentStart + from, contentStart + to);
      lines.push({ text, kind, before: oldLine, after: newLine, textLength, textOffset: from, nextTextOffset: to < textLength ? to : null });
      budget -= text.length;
    }
    row++;
    if (row % 500 === 0 && !file.checkpoints[row / 500]) file.checkpoints[row / 500] = { position, before, after };
    if (lines.length >= limit || budget <= 0) break;
  }
  return { lines, nextOffset: position < file.end ? row : null, included: true };
}

export function readWorkspaceDiffPage(index, path, options = {}) {
  const { offset = 0, textOffset = 0, singleLine = false } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > index.patch.length
    || !Number.isSafeInteger(textOffset) || textOffset < 0 || textOffset > index.patch.length) throw new Error('Invalid diff page.');
  return readLines(index, path, offset, singleLine ? 1 : 500, textOffset, 4096, 128 * 1024);
}

// Existing callers can still inspect a small preview without a review session.
export function workspaceFilePatches(patch, files, window) {
  const index = createWorkspaceDiffIndex(patch, files);
  return new Map([...index.files.keys()].map(path => [path,
    readLines(index, path, window?.offset ?? 0, window?.limit ?? Infinity, 0, Infinity, Infinity).lines
      .map(({ text, kind, before, after }) => ({ text, kind, before, after }))]));
}
