import type { ProjectGroup, RoomEntry } from "../components/desktop/types";
import { buildRoomPinMutation } from "./sidebar-rooms";

export type SidebarRoomBatchActionId = "mark-read" | "pin" | "conclude" | "hide";

export type SidebarRoomBatchActionResolution = {
  action: SidebarRoomBatchActionId;
  label: string;
  pinned: boolean | null;
  targets: RoomEntry[];
};

export function flattenSidebarRoomEntries(projects: readonly ProjectGroup[]): RoomEntry[] {
  return projects.flatMap((project) => [
    project.parent,
    ...project.branchRooms,
    ...project.focusRooms,
  ]);
}

export function isSidebarRoomSelectable(entry: RoomEntry): boolean {
  return Boolean(entry.roomIdentifier || buildRoomPinMutation(entry));
}

export function resolveSidebarRoomBatchAction(input: {
  action: SidebarRoomBatchActionId;
  entries: readonly RoomEntry[];
  primaryRoomId: string;
}): SidebarRoomBatchActionResolution {
  const entries = uniqueEntries(input.entries).filter(isSidebarRoomSelectable);

  if (input.action === "mark-read") {
    return {
      action: input.action,
      label: "Read",
      pinned: null,
      targets: entries.filter((entry) => Boolean(entry.roomIdentifier && entry.hasUnread)),
    };
  }

  if (input.action === "pin") {
    const eligible = entries.filter((entry) => entry.kind === "parent" && buildRoomPinMutation(entry));
    const pinned = !eligible.length || eligible.some((entry) => !entry.pinned);
    return {
      action: input.action,
      label: pinned ? "Pin" : "Unpin",
      pinned,
      targets: eligible.filter((entry) => entry.pinned !== pinned),
    };
  }

  if (input.action === "conclude") {
    return {
      action: input.action,
      label: "Conclude",
      pinned: null,
      targets: entries.filter(canConcludeSidebarRoom),
    };
  }

  return {
    action: input.action,
    label: "Hide",
    pinned: null,
    targets: entries.filter((entry) => canHideSidebarRoom(entry, input.primaryRoomId)),
  };
}

export function canConcludeSidebarRoom(entry: RoomEntry): boolean {
  return entry.kind === "focus"
    && entry.focusStatus !== "concluded"
    && Boolean(entry.focusKey && entry.parentRoomIdentifier);
}

export function canHideSidebarRoom(entry: RoomEntry, primaryRoomId: string): boolean {
  if (entry.kind === "focus") {
    return Boolean(entry.focusKey && entry.parentRoomIdentifier);
  }
  return entry.kind === "parent"
    && entry.id !== primaryRoomId
    && Boolean(entry.roomIdentifier);
}

function uniqueEntries(entries: readonly RoomEntry[]): RoomEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}
