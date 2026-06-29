import {
  insertGitHubRoomEvent,
  type GitHubRoomEvent,
} from "../../db.js";
import type { MaterializedGitHubRoomEvent } from "../room-events.js";

export async function persistMaterializedGitHubRoomEvent(
  event: MaterializedGitHubRoomEvent,
  input: {
    deliveryId: string;
    roomId?: string | null;
    linkedTaskId?: string | null;
  }
): Promise<{ event: GitHubRoomEvent; duplicate: boolean }> {
  const { event: persistedEvent, duplicate } = await insertGitHubRoomEvent({
    room_id: input.roomId ?? null,
    delivery_id: input.deliveryId,
    event_type: event.event_type,
    action: event.action,
    idempotency_key: event.idempotency_key,
    semantic_id: event.semantic_id,
    github_object_id: event.github_object_id,
    github_object_url: event.github_object_url,
    title: event.title,
    state: event.state,
    actor_login: event.actor_login,
    provider_event_at: event.provider_event_at,
    provider_object_updated_at: event.provider_object_updated_at,
    ref: event.ref,
    base_ref: event.base_ref,
    head_ref: event.head_ref,
    head_sha: event.head_sha,
    metadata: event.metadata,
    linked_task_id: input.linkedTaskId ?? null,
  });

  return { event: persistedEvent, duplicate };
}
