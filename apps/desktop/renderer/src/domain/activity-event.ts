import type { DesktopGitHubRoomEvent } from "../../../electron/ipc-types";
import type { ActivityEvent } from "../../../../../shared/ui/activity/model";

/** The desktop's camelCase GitHub event in the API shape the shared Activity code reads. */
export function desktopActivityEvent(event: DesktopGitHubRoomEvent): ActivityEvent {
  return {
    id: event.id, event_type: event.eventType, action: event.action, github_object_id: event.githubObjectId,
    github_object_url: event.githubObjectUrl, title: event.title, state: event.state, actor_login: event.actorLogin,
    metadata: event.metadata, linked_task_id: event.linkedTaskId, created_at: event.createdAt,
    provider_event_at: event.providerEventAt, provider_object_updated_at: event.providerObjectUpdatedAt,
    event_order_at: event.eventOrderAt, head_sha: event.headSha,
  };
}
