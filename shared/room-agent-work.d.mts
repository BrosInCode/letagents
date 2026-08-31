export const ROOM_WORK_STATES: readonly ["active", "completed", "completed_no_reply", "failed", "interrupted", "lost", "unknown"];
export const ROOM_WORK_OPERATION_OUTCOMES: readonly ["unresolved", "succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start"];
export type RoomAgentWorkSummary = {
  version: 1;
  recorded_state: typeof ROOM_WORK_STATES[number];
  evidence_incomplete: boolean;
  elapsed_ms: number | null;
  operation_counts: Record<typeof ROOM_WORK_OPERATION_OUTCOMES[number], number>;
};
// Server-issued availability marker, not a publisher-supplied execution state.
export type ClearedRoomAgentWorkSummary = { version: 1; availability: "cleared" };
export type RoomAgentWork = {
  attempt_id: string;
  room_id: string;
  source_message_id: string;
  agent_key: string;
  revision: number;
  summary: RoomAgentWorkSummary | ClearedRoomAgentWorkSummary;
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
export function isClearedRoomAgentWorkSummary(value: unknown): value is ClearedRoomAgentWorkSummary;
/** Return a canonical allowlisted copy, or reject without echoing private input. */
export function parseRoomAgentWorkSummary(value: unknown): RoomAgentWorkSummary | null;
