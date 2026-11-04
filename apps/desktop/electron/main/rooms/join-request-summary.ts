import {
  ROOM_JOIN_REQUEST_STATES,
  type RoomJoinRequestSummary,
} from "../../../../../shared/room-membership.mjs";

/** Reads a join request the API sent, keeping only the fields the app shows. */
export function readRoomJoinRequestSummary(value: unknown, fallbackRetryAfter?: unknown): RoomJoinRequestSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof state !== "string" || !(ROOM_JOIN_REQUEST_STATES as readonly string[]).includes(state)) return null;
  return {
    id: record.id,
    state: state as RoomJoinRequestSummary["state"],
    created_at: optionalText(record.created_at) ?? "",
    decided_at: optionalText(record.decided_at),
    retry_after: optionalText(record.retry_after) ?? optionalText(fallbackRetryAfter),
  };
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
