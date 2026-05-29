import {
  insertGitHubRoomEvent,
} from "../../db.js";
import type { MaterializedGitHubRoomEvent } from "../../github-room-events.js";

export async function persistMaterializedGitHubRoomEvent(
  event: MaterializedGitHubRoomEvent,
  input: {
    deliveryId: string;
    roomId?: string | null;
    linkedTaskId?: string | null;
  }
): Promise<{ duplicate: boolean }> {
  const { duplicate } = await insertGitHubRoomEvent({
    room_id: input.roomId ?? null,
    delivery_id: input.deliveryId,
    event_type: event.event_type,
    action: event.action,
    idempotency_key: event.idempotency_key,
    github_object_id: event.github_object_id,
    github_object_url: event.github_object_url,
    title: event.title,
    state: event.state,
    actor_login: event.actor_login,
    metadata: event.metadata,
    linked_task_id: input.linkedTaskId ?? null,
  });

  return { duplicate };
}
