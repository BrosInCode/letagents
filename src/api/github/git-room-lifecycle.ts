import {
  activateFocusRoom,
  archiveFocusRoom,
  claimGitRefFocusRoomLifecycleEvent,
  concludeFocusRoom,
  hasGitHubRoomActivationEventAfter,
  getProjectById,
  type Project,
} from "../db.js";
import type { MaterializedGitHubRoomEvent } from "./room-events.js";

export type GitHubRefRoomLifecycleMutation = "activate" | "archive" | "conclude";
export type GitHubRefRoomLifecycleSkipReason =
  | "stale_event"
  | "already_concluded";

export interface GitHubRefRoomLifecycleDeps {
  claimGitRefFocusRoomLifecycleEvent(
    roomId: string,
    eventOrderAt: string
  ): Promise<Project | null>;
  hasGitHubRoomActivationEventAfter?(
    roomId: string,
    eventOrderAt: string
  ): Promise<boolean>;
  getProjectById?(roomId: string): Promise<Project | undefined>;
  activateFocusRoom(
    parentRoomId: string,
    focusKey: string
  ): Promise<unknown>;
  archiveFocusRoom(
    parentRoomId: string,
    focusKey: string
  ): Promise<unknown>;
  concludeFocusRoom(
    parentRoomId: string,
    focusKey: string,
    summary: string
  ): Promise<unknown>;
}

const defaultDeps: GitHubRefRoomLifecycleDeps = {
  claimGitRefFocusRoomLifecycleEvent,
  hasGitHubRoomActivationEventAfter: (roomId, eventOrderAt) =>
    hasGitHubRoomActivationEventAfter({
      room_id: roomId,
      event_order_at: eventOrderAt,
    }),
  getProjectById,
  activateFocusRoom,
  archiveFocusRoom,
  concludeFocusRoom,
};

export function isGeneratedGitRefFocusRoom(room: Project | null | undefined): boolean {
  return Boolean(
    room?.kind === "focus" &&
    room.parent_room_id &&
    room.focus_key &&
    (room.focus_key.startsWith("git:branch:") || room.focus_key.startsWith("git:tag:"))
  );
}

export function selectGitHubRefRoomLifecycleMutation(
  event: MaterializedGitHubRoomEvent
): GitHubRefRoomLifecycleMutation | null {
  const roomEvent = event.roomEvent;
  if (!roomEvent) {
    return null;
  }

  if (roomEvent.kind === "branch_ref") {
    if (
      roomEvent.branch.refType !== "branch" &&
      roomEvent.branch.refType !== "tag"
    ) {
      return null;
    }
    return roomEvent.action === "delete" ? "archive" : "activate";
  }

  if (roomEvent.kind === "push") {
    if (
      roomEvent.push.refType !== "branch" &&
      roomEvent.push.refType !== "tag"
    ) {
      return null;
    }
    return event.state === "deleted" ? "archive" : "activate";
  }

  if (roomEvent.kind === "pull_request") {
    if (event.action === "closed" && event.state === "merged") {
      return "conclude";
    }
    if (
      event.action === "opened" ||
      event.action === "reopened" ||
      event.action === "ready_for_review" ||
      event.action === "synchronize" ||
      event.action === "converted_to_draft"
    ) {
      return "activate";
    }
  }

  return null;
}

function gitRoomLifecycleSummary(event: MaterializedGitHubRoomEvent): string {
  if (event.event_type === "pull_request" && event.github_object_id) {
    return `Pull request #${event.github_object_id} merged.`;
  }
  return event.title ? `${event.title} completed.` : "Git work completed.";
}

function lifecycleEventOrderAt(
  event: MaterializedGitHubRoomEvent,
  eventOrderAt?: string | null
): string {
  return (
    eventOrderAt ??
    event.provider_event_at ??
    event.provider_object_updated_at ??
    new Date().toISOString()
  );
}

function isConcludedGitRefRoom(room: Project): boolean {
  return room.focus_status === "concluded" || Boolean(room.concluded_at);
}

function uniqueRoomIds(roomIds: Array<string | null | undefined>): string[] {
  return [...new Set(roomIds.filter((roomId): roomId is string => Boolean(roomId)))];
}

async function hasNewerActivationEvent(input: {
  deps: GitHubRefRoomLifecycleDeps;
  roomIds: string[];
  eventOrderAt: string;
}): Promise<boolean> {
  for (const roomId of input.roomIds) {
    if (await input.deps.hasGitHubRoomActivationEventAfter?.(roomId, input.eventOrderAt)) {
      return true;
    }
  }
  return false;
}

export async function applyGitHubRefRoomLifecycle(
  room: Project | null | undefined,
  event: MaterializedGitHubRoomEvent,
  deps: GitHubRefRoomLifecycleDeps = defaultDeps,
  options: {
    eventOrderAt?: string | null;
    activationEventRoomIds?: string[];
  } = {}
): Promise<{
  mutation: GitHubRefRoomLifecycleMutation;
  applied: boolean;
  skipped?: GitHubRefRoomLifecycleSkipReason;
} | null> {
  if (!isGeneratedGitRefFocusRoom(room)) {
    return null;
  }

  const mutation = selectGitHubRefRoomLifecycleMutation(event);
  if (!mutation || !room?.parent_room_id || !room.focus_key) {
    return null;
  }

  const eventOrderAt = lifecycleEventOrderAt(event, options.eventOrderAt);
  const claimedRoom = await deps.claimGitRefFocusRoomLifecycleEvent(
    room.id,
    eventOrderAt
  );
  if (!claimedRoom) {
    const currentRoom = mutation === "conclude"
      ? await deps.getProjectById?.(room.id) ?? room
      : room;
    if (mutation === "conclude" && currentRoom.focus_archived_at) {
      const hasNewerActivation = await hasNewerActivationEvent({
        deps,
        roomIds: uniqueRoomIds([room.id, ...(options.activationEventRoomIds ?? [])]),
        eventOrderAt,
      });
      if (hasNewerActivation) {
        return { mutation, applied: false, skipped: "stale_event" };
      }
      await deps.activateFocusRoom(room.parent_room_id, room.focus_key);
      await deps.concludeFocusRoom(
        room.parent_room_id,
        room.focus_key,
        gitRoomLifecycleSummary(event)
      );
      return { mutation, applied: true };
    }
    return { mutation, applied: false, skipped: "stale_event" };
  }

  if (mutation === "activate") {
    await deps.activateFocusRoom(room.parent_room_id, room.focus_key);
    return { mutation, applied: true };
  }

  if (mutation === "archive") {
    if (isConcludedGitRefRoom(claimedRoom)) {
      return { mutation, applied: false, skipped: "already_concluded" };
    }
    await deps.archiveFocusRoom(room.parent_room_id, room.focus_key);
    return { mutation, applied: true };
  }

  if (claimedRoom.focus_archived_at) {
    await deps.activateFocusRoom(room.parent_room_id, room.focus_key);
  }
  await deps.concludeFocusRoom(
    room.parent_room_id,
    room.focus_key,
    gitRoomLifecycleSummary(event)
  );
  return { mutation, applied: true };
}
