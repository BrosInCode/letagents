import type { DesktopGitRoomInfo } from "../../../electron/ipc-types";
import type { RoomEntry } from "../components/desktop/types";
import { buildRoomPinMutation } from "./sidebar-rooms";

export type SidebarRoomMenuActionId =
  | "open-room"
  | "select-room"
  | "mark-room-read"
  | "pin-room"
  | "rename-room"
  | "copy-room-url"
  | "copy-branch-name"
  | "open-on-github"
  | "toggle-project"
  | "conclude-focus-room"
  | "archive-focus-room"
  | "archive-room";

export type SidebarRoomMenuItem = {
  id: SidebarRoomMenuActionId;
  label: string;
  danger?: boolean;
};

export type SidebarBackgroundMenuActionId =
  | "new-room"
  | "select-rooms"
  | "set-projects-collapsed";

export type SidebarBackgroundMenuItem = {
  id: SidebarBackgroundMenuActionId;
  label: string;
};

export function buildSidebarRoomContextMenuItems(input: {
  entry: RoomEntry;
  isPrimaryRoom: boolean;
  hasProjectChildren: boolean;
  projectCollapsed: boolean;
}): SidebarRoomMenuItem[][] {
  const { entry } = input;
  const selectable = Boolean(entry.roomIdentifier);
  const groups: SidebarRoomMenuItem[][] = [];

  const navigation: SidebarRoomMenuItem[] = [];
  if (selectable) {
    navigation.push({ id: "open-room", label: "Open room" });
  }
  if (selectable || buildRoomPinMutation(entry)) {
    navigation.push({ id: "select-room", label: "Select room" });
  }
  if (entry.hasUnread && selectable) {
    navigation.push({ id: "mark-room-read", label: "Mark as read" });
  }
  if (navigation.length) groups.push(navigation);

  const management: SidebarRoomMenuItem[] = [];
  if (entry.kind === "parent" && buildRoomPinMutation(entry)) {
    management.push({ id: "pin-room", label: entry.pinned ? "Unpin room" : "Pin room" });
  }
  if (entry.kind === "parent" && selectable && entry.source !== "recent") {
    management.push({ id: "rename-room", label: "Rename room..." });
  }
  if (
    entry.kind === "focus"
    && entry.focusStatus !== "concluded"
    && entry.focusKey
    && entry.parentRoomIdentifier
  ) {
    management.push({ id: "conclude-focus-room", label: "Conclude focus room..." });
  }
  if (management.length) groups.push(management);

  const clipboard: SidebarRoomMenuItem[] = [];
  if (selectable) {
    clipboard.push({ id: "copy-room-url", label: "Copy URL" });
  }
  if (entry.kind !== "parent" && entry.gitRoom?.ref.type === "branch" && entry.gitRoom.ref.name) {
    clipboard.push({ id: "copy-branch-name", label: "Copy branch name" });
  }
  if (buildGitRoomWebUrl(entry.gitRoom ?? null)) {
    clipboard.push({ id: "open-on-github", label: "Open on GitHub" });
  }
  if (clipboard.length) groups.push(clipboard);

  if (input.hasProjectChildren) {
    groups.push([{
      id: "toggle-project",
      label: input.projectCollapsed ? "Expand rooms" : "Collapse rooms",
    }]);
  }

  const destructive: SidebarRoomMenuItem[] = [];
  if (entry.kind === "focus" && entry.focusKey && entry.parentRoomIdentifier) {
    destructive.push({ id: "archive-focus-room", label: "Hide focus room", danger: true });
  }
  if (entry.kind === "parent" && selectable && !input.isPrimaryRoom) {
    destructive.push({
      id: "archive-room",
      label: entry.source === "recent" ? "Remove from my rooms" : "Hide room",
      danger: true,
    });
  }
  if (destructive.length) groups.push(destructive);

  return groups;
}

export function buildSidebarBackgroundMenuItems(input: {
  hasProjects: boolean;
  allProjectsCollapsed: boolean;
}): SidebarBackgroundMenuItem[][] {
  const groups: SidebarBackgroundMenuItem[][] = [[
    { id: "new-room", label: "New room..." },
    { id: "select-rooms", label: "Select rooms" },
  ]];
  if (input.hasProjects) {
    groups.push([{
      id: "set-projects-collapsed",
      label: input.allProjectsCollapsed ? "Expand all rooms" : "Collapse all rooms",
    }]);
  }
  return groups;
}

export function buildGitRoomWebUrl(gitRoom: DesktopGitRoomInfo | null): string | null {
  if (!gitRoom || gitRoom.host !== "github.com") return null;
  const baseRepository = repositoryUrl(gitRoom.repository.fullName);
  if (!baseRepository) return null;
  const refName = gitRoom.ref.name;
  if (!refName || gitRoom.ref.type === "default_branch") return baseRepository;
  // Pull-request bindings carry the head branch in ref.name (there is no PR
  // number in DesktopGitRoomInfo), so they get the same head-branch tree link.
  const treeRepository = repositoryUrl(gitRoom.ref.headRepository?.fullName || "") || baseRepository;
  return `${treeRepository}/tree/${refName.split("/").map(encodeURIComponent).join("/")}`;
}

function repositoryUrl(fullName: string): string | null {
  return isSafeRepositoryFullName(fullName) ? `https://github.com/${fullName}` : null;
}

function isSafeRepositoryFullName(fullName: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(fullName);
}
