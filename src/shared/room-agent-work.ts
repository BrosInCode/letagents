// Room-public, host-reported evidence; never execution or approval authority.
// No free-form strings, native handles, paths, command text, or output belong
// in this version. Both the publisher and server use this strict boundary.
export const ROOM_WORK_STATES = [
  "active", "completed", "completed_no_reply", "failed", "interrupted", "lost", "unknown",
] as const;
export const ROOM_WORK_OPERATION_OUTCOMES = [
  "unresolved", "succeeded", "failed", "denied_before_start", "cancelled_before_start",
  "interrupted_after_start", "lost_after_start",
] as const;
export type RoomAgentWorkSummary = {
  version: 1;
  recorded_state: typeof ROOM_WORK_STATES[number];
  evidence_incomplete: boolean;
  elapsed_ms: number | null;
  operation_counts: Record<typeof ROOM_WORK_OPERATION_OUTCOMES[number], number>;
};
export type RoomAgentWork = {
  attempt_id: string;
  room_id: string;
  source_message_id: string;
  agent_key: string;
  revision: number;
  summary: RoomAgentWorkSummary;
  updated_at: string;
};
export type RoomAgentWorkSnapshot = { work: RoomAgentWork[]; truncated: boolean };
/** Synchronizes the latest-50 view, not intermediate events or complete history.
 * A changed snapshot replaces the client's bounded cache; it must not be merged.
 * The server-issued cursor is a comparison hint, never authorization. */
export type RoomAgentWorkPollResponse = { room_id: string; cursor: string } & (
  | { changed: true; snapshot: RoomAgentWorkSnapshot }
  | { changed: false; snapshot: null }
);

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/** Return a canonical allowlisted copy, or reject without echoing private input. */
export function parseRoomAgentWorkSummary(value: unknown): RoomAgentWorkSummary | null {
  if (!exactKeys(value, ["version", "recorded_state", "evidence_incomplete", "elapsed_ms", "operation_counts"])
    || value.version !== 1 || !ROOM_WORK_STATES.includes(value.recorded_state as never)
    || typeof value.evidence_incomplete !== "boolean"
    || (value.elapsed_ms !== null && (!Number.isSafeInteger(value.elapsed_ms) || Number(value.elapsed_ms) < 0))
    || !exactKeys(value.operation_counts, ROOM_WORK_OPERATION_OUTCOMES)) return null;
  const counts = {} as RoomAgentWorkSummary["operation_counts"];
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
    version: 1, recorded_state: value.recorded_state as RoomAgentWorkSummary["recorded_state"],
    evidence_incomplete: value.evidence_incomplete, elapsed_ms: value.elapsed_ms as number | null,
    operation_counts: counts,
  };
}
