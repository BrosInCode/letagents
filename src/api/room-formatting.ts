import type { Project, Task } from "./db.js";
import { isAttachmentStorageConfigured } from "./attachment-storage.js";
import {
  focusRoomBlockerStateLabel,
  focusRoomParentTaskNextLabel,
  focusRoomReviewStateLabel,
  type FocusRoomConclusionDetails,
} from "./focus-room-conclusion.js";
import {
  normalizeFocusRoomSettings,
  type FocusRoomSettings,
} from "./focus-room-settings.js";

export type RoomRole = "admin" | "participant" | "anonymous";

export function getFocusRoomSettings(focusRoom: Project): FocusRoomSettings {
  return normalizeFocusRoomSettings({
    parent_visibility: focusRoom.focus_parent_visibility,
    activity_scope: focusRoom.focus_activity_scope,
    github_event_routing: focusRoom.focus_github_event_routing,
  });
}

export function toRoomResponse(
  project: Project,
  options?: {
    role?: RoomRole;
    authenticated?: boolean;
  }
): Record<string, unknown> {
  const focusSettings = project.kind === "focus" ? getFocusRoomSettings(project) : null;

  return {
    room_id: project.id,
    name: project.name ?? null,
    display_name: project.display_name,
    code: project.code,
    kind: project.kind,
    attachments_enabled: isAttachmentStorageConfigured(),
    parent_room_id: project.parent_room_id,
    focus_key: project.focus_key,
    source_task_id: project.source_task_id,
    focus_status: project.focus_status,
    focus_parent_visibility: focusSettings?.parent_visibility ?? null,
    focus_activity_scope: focusSettings?.activity_scope ?? null,
    focus_github_event_routing: focusSettings?.github_event_routing ?? null,
    focus_settings: focusSettings,
    concluded_at: project.concluded_at,
    conclusion_summary: project.conclusion_summary,
    conclusion_details: project.conclusion_details,
    created_at: project.created_at,
    ...(options?.role ? { role: options.role } : {}),
    ...(options ? { authenticated: Boolean(options.authenticated) } : {}),
  };
}

export function formatFocusRoomConclusionMessage(input: {
  focusRoom: Project;
  task?: Task;
  summary: string;
  details?: FocusRoomConclusionDetails | null;
}): string {
  const taskLabel = input.task
    ? `${input.task.id}: ${input.task.title}`
    : input.focusRoom.source_task_id || input.focusRoom.focus_key || input.focusRoom.id;
  const details = input.details ?? input.focusRoom.conclusion_details;
  const lines = [`[status] Focus Room concluded for ${taskLabel}. Result: ${input.summary}`];
  if (details) {
    lines.push(
      `Artifact: ${details.artifact}`,
      `Review: ${focusRoomReviewStateLabel(details.review_state)}`,
      `Blockers: ${focusRoomBlockerStateLabel(details.blocker_state)}`,
      `Parent task next: ${focusRoomParentTaskNextLabel(details.parent_task_next)}`,
      `Next owner: ${details.next_owner}`
    );
  }
  return lines.join("\n");
}

export function formatFocusRoomReference(focusRoom: Project): string {
  const key = focusRoom.focus_key || focusRoom.source_task_id || focusRoom.id;
  return focusRoom.display_name
    ? `${focusRoom.display_name} (${key})`
    : key;
}

export function formatFocusRoomAnchorMessage(input: {
  task: { id: string; title: string };
  focusRoom: Project;
  activity: string;
}): string {
  return `[status] ${input.activity} for ${input.task.id}: ${input.task.title} is in Focus Room ${formatFocusRoomReference(input.focusRoom)}.`;
}
