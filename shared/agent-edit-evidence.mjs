// The files an agent changed with its own edit tools, read from one raw provider
// event. A summary for the room's card, never proof: a shell command leaves no
// edit event. Paths are as the provider gave them (absolute, or relative to the
// workspace); the daemon normalises them when the turn settles. Pure, no Node imports.
import { ROOM_CONTRIBUTION_EDIT_LIMITS } from './room-agent-work.mjs';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Cut a patch at a line boundary so that it holds at most `maxChars` characters. */
export function boundEditPatch(patch, maxChars = ROOM_CONTRIBUTION_EDIT_LIMITS.patchChars) {
  if (patch.length <= maxChars) return { patch, truncated: false };
  const cut = patch.lastIndexOf('\n', maxChars);
  return { patch: cut > 0 ? patch.slice(0, cut) : '', truncated: true };
}

function evidence(path, additions, deletions, lines) {
  const bounded = boundEditPatch(lines.join('\n'));
  return { path, additions, deletions, patch: bounded.patch, patch_truncated: bounded.truncated };
}

const contentLines = (text) => {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** A whole file added (or removed): one hunk of `+` (or `-`) lines. */
function wholeFile(path, text, added) {
  const lines = contentLines(text);
  if (!lines.length) return evidence(path, 0, 0, []);
  const header = added ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
  return evidence(path, added ? lines.length : 0, added ? 0 : lines.length, [header, ...lines.map((line) => `${added ? '+' : '-'}${line}`)]);
}

/**
 * The hunks of a unified diff, and their counts. Lines outside a hunk (`---`/`+++`
 * file headers, `diff --git`, Codex's `Moved to:` note) are left out; a line inside
 * a hunk is read by the hunk's own line counts, so a removed "-- x" stays a removal.
 */
function unifiedDiff(text) {
  const lines = [];
  let additions = 0, deletions = 0, oldLeft = 0, newLeft = 0;
  for (const raw of text.split('\n')) {
    const header = HEADER.exec(raw);
    if (header) {
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      lines.push(`@@ -${header[1]}${header[2] === undefined ? '' : `,${header[2]}`} +${header[3]}${header[4] === undefined ? '' : `,${header[4]}`} @@`);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      if (raw.startsWith('\\') && lines.length) lines.push(raw);
      continue;
    }
    const line = raw === '' ? ' ' : raw; // Some tools drop the space of an empty context line.
    if (line[0] === '+') { additions++; newLeft--; }
    else if (line[0] === '-') { deletions++; oldLeft--; }
    else if (line[0] === ' ') { oldLeft--; newLeft--; }
    else if (line[0] !== '\\') { oldLeft = newLeft = 0; continue; }
    lines.push(line);
  }
  return { lines, additions, deletions };
}

/** Claude Code's `structuredPatch`: jsdiff hunks whose lines carry their own prefix. */
function structuredPatch(hunks) {
  const lines = [];
  let additions = 0, deletions = 0;
  for (const value of hunks) {
    const hunk = record(value);
    if (!hunk || !Array.isArray(hunk.lines) || ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]
      .every((number) => Number.isSafeInteger(number) && number >= 0)) continue;
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (typeof line !== 'string' || line.includes('\n') || !/^[ +\-\\]/.test(line)) continue;
      if (line[0] === '+') additions++;
      else if (line[0] === '-') deletions++;
      lines.push(line);
    }
  }
  return { lines, additions, deletions };
}

/**
 * One raw Claude Code stream-json message. A tool result is a top-level `user`
 * message with a top-level `tool_use_result`; Edit, Write and MultiEdit results
 * carry `filePath` and `structuredPatch`. A failed or refused call has a string
 * result: no evidence. Subagent results (with `parent_tool_use_id`) count too.
 */
export function claudeEditEvidence(message) {
  const value = record(message);
  const result = record(value?.tool_use_result);
  if (value?.type !== 'user' || !result || typeof result.filePath !== 'string' || !result.filePath
    || !Array.isArray(result.structuredPatch)) return null;
  const content = record(value.message)?.content;
  if (Array.isArray(content) && content.some((part) => record(part)?.is_error === true)) return null;
  if (result.type === 'create' && !result.structuredPatch.length && typeof result.content === 'string') {
    return [wholeFile(result.filePath, result.content, true)];
  }
  const patch = structuredPatch(result.structuredPatch);
  return [evidence(result.filePath, patch.additions, patch.deletions, patch.lines)];
}

/**
 * One Codex app-server notification. Only `item/completed` of a `fileChange`
 * item whose status is `completed` counts. `kind` is `{ type }` or a plain
 * string. An update's `diff` is a unified diff (hunks only on Codex 0.162.1); an
 * add's or delete's is the file content, so a line of it that looks like a hunk
 * header is still content. A moved file is reported at its new path.
 */
export function codexEditEvidence(method, params) {
  const item = record(record(params)?.item);
  if (method !== 'item/completed' || item?.type !== 'fileChange' || item.status !== 'completed'
    || !Array.isArray(item.changes)) return null;
  const files = [];
  for (const value of item.changes) {
    const change = record(value);
    if (!change || typeof change.path !== 'string' || !change.path) continue;
    const kind = typeof change.kind === 'string' ? change.kind : record(change.kind)?.type;
    const movePath = record(change.kind)?.move_path ?? change.move_path;
    const path = kind === 'update' && typeof movePath === 'string' && movePath ? movePath : change.path;
    const diff = typeof change.diff === 'string' ? change.diff : '';
    if (kind === 'add' || kind === 'delete') {
      files.push(wholeFile(path, diff, kind === 'add'));
      continue;
    }
    if (kind !== 'update') continue;
    const patch = unifiedDiff(diff);
    files.push(evidence(path, patch.additions, patch.deletions, patch.lines));
  }
  return files.length ? files : null;
}

/** The evidence of one raw event from a provider that reports edits, or null. */
export function providerEditEvidence(provider, method, payload) {
  try {
    if (provider === 'claude-code') return claudeEditEvidence(payload);
    if (provider === 'codex') return codexEditEvidence(method, payload);
  } catch { /* Evidence is optional; a strange event has none. */ }
  return null;
}
