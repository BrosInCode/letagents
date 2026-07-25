import { createBridgedEmitter } from "./event-bridge.js";

/**
 * Invalidation-only signal for Message info projections. Carries no state:
 * consumers repair through the authoritative GET endpoint. `message_ids` is
 * null for a room-level invalidation.
 *
 * All current emitters pass null deliberately: the room stream is shared by
 * every participant, and enumerating exact ids would reveal activity on
 * concealed (prompt-only / rental-restricted) messages the info endpoint
 * itself refuses to distinguish. Per-id precision requires per-stream
 * visibility filtering and stays reserved until that exists.
 */
export interface MessageInfoUpdatedEvent {
  projectId: string;
  messageIds: string[] | null;
}

export const messageInfoEvents = createBridgedEmitter("message-info");

export const MESSAGE_INFO_COALESCE_MS = 100;
export const MESSAGE_INFO_MAX_IDS_PER_EVENT = 200;

/**
 * Merge an incoming invalidation into a pending per-room buffer. `null`
 * represents room-level invalidation and absorbs everything; exceeding the id
 * cap degrades to room-level instead of emitting an unbounded frame.
 */
export function mergeMessageInfoInvalidation(
  pending: Set<string> | null | undefined,
  incoming: readonly string[] | null,
  maxIds = MESSAGE_INFO_MAX_IDS_PER_EVENT,
): Set<string> | null {
  if (pending === null || incoming === null) return null;
  const merged = new Set(pending ?? []);
  for (const id of incoming) merged.add(id);
  return merged.size > maxIds ? null : merged;
}

const pendingByRoom = new Map<string, { ids: Set<string> | null; timer: NodeJS.Timeout }>();

/**
 * Queue a coalesced invalidation. Changes are collected per room for a short
 * window so a 100-message read batch emits one event, not 100.
 */
export function queueMessageInfoInvalidation(
  projectId: string,
  messageIds: readonly string[] | null,
): void {
  const pending = pendingByRoom.get(projectId);
  if (pending) {
    pending.ids = mergeMessageInfoInvalidation(pending.ids, messageIds);
    return;
  }
  const timer = setTimeout(() => {
    const flushed = pendingByRoom.get(projectId);
    pendingByRoom.delete(projectId);
    if (!flushed) return;
    messageInfoEvents.emit("message_info:updated", {
      projectId,
      messageIds: flushed.ids === null ? null : [...flushed.ids],
    } satisfies MessageInfoUpdatedEvent);
  }, MESSAGE_INFO_COALESCE_MS);
  timer.unref?.();
  pendingByRoom.set(projectId, {
    ids: mergeMessageInfoInvalidation(undefined, messageIds),
    timer,
  });
}
