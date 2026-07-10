import type { DesktopGitRoomInfo } from "../../../../electron/ipc-types";

export type RoomEntry = {
  id: string;
  type: "room";
  kind: "parent" | "focus" | "branch";
  roomIdentifier: string | null;
  title: string;
  meta: string;
  sectionLabel: string;
  headline: string;
  description: string;
  gitRoom?: DesktopGitRoomInfo | null;
  focusKey?: string | null;
  parentRoomIdentifier?: string | null;
  pinTargetRoomIdentifier?: string | null;
  pinnedAccountRoomIdentifiers?: string[];
  suggestedAction?: string | null;
  currentWorkspace?: boolean;
  latestMessageId: string | null;
  latestMessageAt: string | null;
  hasUnread: boolean;
  pinned: boolean;
  source: "current" | "account" | "recent";
};

export type SystemEntry = {
  id:
    | "system:setup"
    | "system:app-agent"
    | "system:repos"
    | "system:workers"
    | "system:settings"
    | "system:diagnostics";
  type: "system";
  title: string;
  description: string;
  sectionLabel: string;
};

export type SidebarEntry = RoomEntry | SystemEntry;

export type ProjectGroup = {
  id: string;
  roomName: string;
  parent: RoomEntry;
  branchRooms: RoomEntry[];
  focusRooms: RoomEntry[];
};

export type SidebarMode = "expanded" | "rail" | "hidden";
