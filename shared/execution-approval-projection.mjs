export const EXECUTION_APPROVAL_PROJECTION_VERSION = 1;
export const EXECUTION_APPROVAL_PROJECTION_MAX_FILES = 128;
export const EXECUTION_APPROVAL_PROJECTION_MAX_PATH_BYTES = 4096;
export const EXECUTION_APPROVAL_PROJECTION_MAX_BYTES = 24 * 1024;

const ROOT_KEYS = ["version", "category", "path_scope", "changes", "totals"];
const CHANGE_KEYS = ["path", "kind", "move_path", "added_lines", "removed_lines", "diff_bytes"];
const TOTAL_KEYS = ["file_count", "added_lines", "removed_lines", "diff_bytes"];
const CHANGE_KINDS = ["add", "delete", "update", "move"];
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isExecutionApprovalProjectionPath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.normalize("NFC") === value
    && new TextEncoder().encode(value).byteLength <= EXECUTION_APPROVAL_PROJECTION_MAX_PATH_BYTES
    && !value.startsWith("/")
    && !value.includes("\\")
    && !UNSAFE_PATH_CHARACTERS.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function compareChanges(left, right) {
  for (const [a, b] of [[left.path, right.path], [left.kind, right.kind], [left.move_path ?? "", right.move_path ?? ""]]) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/** Return the canonical allowlisted projection, or reject it as a whole. */
export function parseExecutionApprovalProjectionV1(value) {
  if (!exactKeys(value, ROOT_KEYS)
    || value.version !== EXECUTION_APPROVAL_PROJECTION_VERSION
    || value.category !== "file_change"
    || value.path_scope !== "workspace_relative"
    || !Array.isArray(value.changes)
    || value.changes.length < 1
    || value.changes.length > EXECUTION_APPROVAL_PROJECTION_MAX_FILES
    || !exactKeys(value.totals, TOTAL_KEYS)) return null;

  const changes = [];
  for (const candidate of value.changes) {
    if (!exactKeys(candidate, CHANGE_KEYS)
      || !isExecutionApprovalProjectionPath(candidate.path)
      || !CHANGE_KINDS.includes(candidate.kind)
      || !count(candidate.added_lines)
      || !count(candidate.removed_lines)
      || !count(candidate.diff_bytes)
      || (candidate.kind === "move") !== (candidate.move_path !== null)
      || (candidate.move_path !== null && !isExecutionApprovalProjectionPath(candidate.move_path))) return null;
    changes.push({
      path: candidate.path,
      kind: candidate.kind,
      move_path: candidate.move_path,
      added_lines: candidate.added_lines,
      removed_lines: candidate.removed_lines,
      diff_bytes: candidate.diff_bytes,
    });
  }
  changes.sort(compareChanges);
  const occupied = new Set();
  for (const change of changes) {
    if (occupied.has(change.path)) return null;
    occupied.add(change.path);
    if (change.move_path !== null) {
      if (occupied.has(change.move_path)) return null;
      occupied.add(change.move_path);
    }
  }
  const totals = changes.reduce((result, change) => ({
    file_count: result.file_count + 1,
    added_lines: result.added_lines + change.added_lines,
    removed_lines: result.removed_lines + change.removed_lines,
    diff_bytes: result.diff_bytes + change.diff_bytes,
  }), { file_count: 0, added_lines: 0, removed_lines: 0, diff_bytes: 0 });
  if (!Object.values(totals).every(Number.isSafeInteger)
    || TOTAL_KEYS.some((key) => value.totals[key] !== totals[key])) return null;

  return {
    version: EXECUTION_APPROVAL_PROJECTION_VERSION,
    category: "file_change",
    path_scope: "workspace_relative",
    changes,
    totals,
  };
}

/** Serialize only the canonical, bounded bytes that a delegate may see. */
export function serializeExecutionApprovalProjectionV1(value) {
  const parsed = parseExecutionApprovalProjectionV1(value);
  if (!parsed) return null;
  const serialized = JSON.stringify(parsed);
  return new TextEncoder().encode(serialized).byteLength <= EXECUTION_APPROVAL_PROJECTION_MAX_BYTES
    ? serialized
    : null;
}
