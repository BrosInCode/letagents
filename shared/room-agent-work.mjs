import { parseWorkspaceChangeSummary } from './workspace-change-summary.mjs';
// v1 is numeric execution evidence. v2 additionally carries a bounded,
// deliberately room-visible workspace review snapshot. v3 separates changes
// during one turn from the cumulative workspace, with an optional public summary.
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

/** Return a canonical allowlisted copy, or reject without echoing private input. */
export function parseRoomAgentWorkSummary(value) {
  const workspace = [2, 3].includes(value?.version) ? parseWorkspaceChangeSummary(value.workspace) : null;
  const keys = ["version", "recorded_state", "evidence_incomplete", "elapsed_ms", "operation_counts"];
  if ([2, 3].includes(value?.version)) keys.push("workspace");
  let contribution = null;
  if (value?.version === 3) {
    keys.push("contribution");
    const candidate = value.contribution;
    if (!exactKeys(candidate, ["changes", "summary"]) || !(candidate.summary === null
      || typeof candidate.summary === "string" && candidate.summary.length <= 400)) return null;
    const changes = parseWorkspaceChangeSummary(candidate.changes);
    if (!changes) return null;
    contribution = { changes, summary: candidate.summary };
    if (new TextEncoder().encode(JSON.stringify(value)).length > 500 * 1024) return null;
  }
  if (!exactKeys(value, keys)
    || ![1, 2, 3].includes(value.version) || (value.version >= 2 && !workspace) || !ROOM_WORK_STATES.includes(value.recorded_state)
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
