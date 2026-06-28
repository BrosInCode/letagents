import {
  buildManualGitHubRepoRoomBindingInput,
  type GitRoomBinding,
  type GitRoomSummary,
  type Project,
  type Task,
} from "../db.js";
import { isAttachmentStorageConfigured } from "../messages/attachment-storage.js";
import {
  focusRoomBlockerStateLabel,
  focusRoomParentTaskNextLabel,
  focusRoomReviewStateLabel,
  type FocusRoomConclusionDetails,
} from "../focus-rooms/conclusion.js";
import {
  normalizeFocusRoomSettings,
  type FocusRoomSettings,
} from "../focus-rooms/settings.js";

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
    gitRoomBinding?: GitRoomBinding | null;
  }
): Record<string, unknown> {
  const focusSettings = project.kind === "focus" ? getFocusRoomSettings(project) : null;
  const hasGitRoomBindingOption =
    options && Object.prototype.hasOwnProperty.call(options, "gitRoomBinding");

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
    focus_archived_at: project.focus_archived_at,
    concluded_at: project.concluded_at,
    conclusion_summary: project.conclusion_summary,
    conclusion_details: project.conclusion_details,
    created_at: project.created_at,
    ...(hasGitRoomBindingOption
      ? { git_room: formatGitRoomSummary(options.gitRoomBinding ?? null) }
      : {}),
    ...(options?.role ? { role: options.role } : {}),
    ...(options ? { authenticated: Boolean(options.authenticated) } : {}),
  };
}

export function formatGitRoomSummary(
  binding: GitRoomBinding | null
): GitRoomSummary | null {
  if (!binding) {
    return null;
  }

  return {
    room_id: binding.room_id,
    provider: binding.provider,
    host: binding.host,
    repository: {
      id: binding.repository_id,
      owner: binding.repository_owner,
      name: binding.repository_name,
      full_name: binding.repository_full_name,
    },
    ref: {
      type: binding.ref_type,
      name: binding.ref_name,
      default_branch: binding.default_branch,
      base_ref: binding.base_ref,
      head_ref: binding.head_ref,
      head_repository:
        binding.head_repository_full_name &&
        binding.head_repository_owner &&
        binding.head_repository_name
          ? {
              id: binding.head_repository_id,
              owner: binding.head_repository_owner,
              name: binding.head_repository_name,
              full_name: binding.head_repository_full_name,
            }
          : null,
      is_default: binding.is_default,
    },
    visibility: binding.visibility,
    access_mode: binding.visibility,
    source: binding.source,
    updated_at: binding.updated_at,
  };
}

export function formatManualGitRoomSummaryForRoomId(
  roomId: string
): GitRoomSummary | null {
  const input = buildManualGitHubRepoRoomBindingInput(roomId);
  if (!input) {
    return null;
  }

  const visibility = input.visibility ?? "unknown";
  return {
    room_id: input.room_id,
    provider: input.provider,
    host: input.host,
    repository: {
      id: input.repository_id ?? null,
      owner: input.repository_owner,
      name: input.repository_name,
      full_name: input.repository_full_name,
    },
    ref: {
      type: input.ref_type,
      name: input.ref_name ?? null,
      default_branch: input.default_branch ?? null,
      base_ref: input.base_ref ?? null,
      head_ref: input.head_ref ?? null,
      head_repository:
        input.head_repository_full_name &&
        input.head_repository_owner &&
        input.head_repository_name
          ? {
              id: input.head_repository_id ?? null,
              owner: input.head_repository_owner,
              name: input.head_repository_name,
              full_name: input.head_repository_full_name,
            }
          : null,
      is_default: input.is_default ?? false,
    },
    visibility,
    access_mode: visibility,
    source: input.source,
    updated_at: null,
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
