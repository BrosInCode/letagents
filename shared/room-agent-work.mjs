import { isWorkspaceChangePath, parseWorkspaceChangeSummary } from './workspace-change-summary.mjs';
// v1 is numeric execution evidence. v2 additionally carries a bounded,
// deliberately room-visible workspace review snapshot. v3 separates changes
// during one turn from the cumulative workspace, with an optional public summary.
// v4 adds the provider's edit events (a summary, never proof) and the turn's starting commit.
export const ROOM_WORK_STATES = [
  "active", "completed", "completed_no_reply", "failed", "interrupted", "lost", "unknown",
];
export const ROOM_WORK_OPERATION_OUTCOMES = [
  "unresolved", "succeeded", "failed", "denied_before_start", "cancelled_before_start",
  "interrupted_after_start", "lost_after_start",
];

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function isClearedRoomAgentWorkSummary(value) {
  return exactKeys(value, ["version", "availability"]) && value.version === 1 && value.availability === "cleared";
}

/** Review eligibility is separate from capture/execution evidence. An unknown
 * turn may offer a real cumulative review, but a known empty turn cannot claim
 * earlier work. File metadata matters even when textual line totals are zero. */
export function hasReviewableRoomContribution(summary) {
  const changes = summary?.contribution?.changes;
  if (!changes) return false;
  const snapshot = changes.state === 'ready' ? changes : summary.workspace;
  return snapshot?.state === 'ready' && (snapshot.files.length > 0 || snapshot.hidden_files > 0
    || snapshot.additions > 0 || snapshot.deletions > 0 || snapshot.patch.length > 0 || snapshot.patch_truncated);
}

export const ROOM_CONTRIBUTION_EDIT_LIMITS = Object.freeze({ files: 20, patchChars: 8000, totalPatchChars: 48000 });
const editCount = (value) => Number.isSafeInteger(value) && value >= 0;
// Unified-diff hunks only: a header, then context, added, removed and "\\ No newline" lines.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const isEditPatch = (patch) => patch === "" || HUNK_HEADER.test(patch)
  && patch.split("\n").every((line) => HUNK_HEADER.test(line) || /^[ +\-\\]/.test(line));
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The v4 edit summary, rebuilt; undefined when invalid. */
function parseContributionEdits(value) {
  if (value === null) return null;
  if (!exactKeys(value, ["files", "hidden_files"]) || !Array.isArray(value.files)
    || value.files.length > ROOM_CONTRIBUTION_EDIT_LIMITS.files || !editCount(value.hidden_files)) return undefined;
  const files = [];
  const paths = new Set();
  let patchChars = 0;
  for (const file of value.files) {
    if (!exactKeys(file, ["path", "additions", "deletions", "patch", "patch_truncated"])
      || !isWorkspaceChangePath(file.path) || paths.has(file.path)
      || !editCount(file.additions) || !editCount(file.deletions)
      || typeof file.patch !== "string" || file.patch.length > ROOM_CONTRIBUTION_EDIT_LIMITS.patchChars
      || !isEditPatch(file.patch) || typeof file.patch_truncated !== "boolean") return undefined;
    patchChars += file.patch.length;
    paths.add(file.path);
    files.push({ path: file.path, additions: file.additions, deletions: file.deletions,
      patch: file.patch, patch_truncated: file.patch_truncated });
  }
  if (patchChars > ROOM_CONTRIBUTION_EDIT_LIMITS.totalPatchChars) return undefined;
  return { files, hidden_files: value.hidden_files };
}

/** The v4 turn start, rebuilt; undefined when invalid. */
function parseContributionStart(value) {
  if (value === null) return null;
  if (!exactKeys(value, ["committed_at", "in_history"])
    || !(value.committed_at === null || typeof value.committed_at === "string" && ISO_TIME.test(value.committed_at)
      && Number.isFinite(Date.parse(value.committed_at)))
    || !(value.in_history === null || typeof value.in_history === "boolean")) return undefined;
  return { committed_at: value.committed_at === null ? null : new Date(value.committed_at).toISOString(), in_history: value.in_history };
}

/** Return a canonical allowlisted copy, or reject without echoing private input. */
export function parseRoomAgentWorkSummary(value) {
  const workspace = [2, 3, 4].includes(value?.version) ? parseWorkspaceChangeSummary(value.workspace) : null;
  const keys = ["version", "recorded_state", "evidence_incomplete", "elapsed_ms", "operation_counts"];
  if ([2, 3, 4].includes(value?.version)) keys.push("workspace");
  let contribution = null;
  if (value?.version === 3 || value?.version === 4) {
    keys.push("contribution");
    const candidate = value.contribution;
    if (!exactKeys(candidate, value.version === 3 ? ["changes", "summary"] : ["changes", "summary", "edits", "start"])
      || !(candidate.summary === null
      || typeof candidate.summary === "string" && candidate.summary.length <= 400)) return null;
    const changes = parseWorkspaceChangeSummary(candidate.changes);
    if (!changes) return null;
    contribution = { changes, summary: candidate.summary };
    if (value.version === 4) {
      const edits = parseContributionEdits(candidate.edits);
      const start = parseContributionStart(candidate.start);
      if (edits === undefined || start === undefined) return null;
      contribution = { ...contribution, edits, start };
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 500 * 1024) return null;
  }
  if (!exactKeys(value, keys)
    || ![1, 2, 3, 4].includes(value.version) || (value.version >= 2 && !workspace) || !ROOM_WORK_STATES.includes(value.recorded_state)
    || typeof value.evidence_incomplete !== "boolean"
    || (value.elapsed_ms !== null && (!Number.isSafeInteger(value.elapsed_ms) || Number(value.elapsed_ms) < 0))
    || !exactKeys(value.operation_counts, ROOM_WORK_OPERATION_OUTCOMES)) return null;
  const counts = {};
  let total = 0;
  for (const outcome of ROOM_WORK_OPERATION_OUTCOMES) {
    const count = value.operation_counts[outcome];
    if (!Number.isSafeInteger(count) || Number(count) < 0) return null;
    counts[outcome] = Number(count);
    total += Number(count);
  }
  // A bounded evidence snapshot, not an unbounded lifetime counter.
  if (total > 10_000) return null;
  return {
    version: value.version, recorded_state: value.recorded_state,
    ...(workspace ? { workspace } : {}),
    ...(contribution ? { contribution } : {}),
    evidence_incomplete: value.evidence_incomplete, elapsed_ms: value.elapsed_ms,
    operation_counts: counts,
  };
}
