// Room-public, host-reported evidence; never execution or approval authority.
// No free-form strings, native handles, paths, command text, or output belong
// in this version. Both the publisher and server use this strict boundary.
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
  if (!exactKeys(value, ["version", "recorded_state", "evidence_incomplete", "elapsed_ms", "operation_counts"])
    || value.version !== 1 || !ROOM_WORK_STATES.includes(value.recorded_state)
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
    version: 1, recorded_state: value.recorded_state,
    evidence_incomplete: value.evidence_incomplete, elapsed_ms: value.elapsed_ms,
    operation_counts: counts,
  };
}
