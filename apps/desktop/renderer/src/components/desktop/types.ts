export type RoomEntry = {
  id: string;
  type: "room";
  kind: "parent" | "focus";
  roomIdentifier: string | null;
  parentRoomId?: string | null;
  focusKey?: string | null;
  sourceTaskId?: string | null;
  title: string;
  meta: string;
  sectionLabel: string;
  headline: string;
  description: string;
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
  focusRooms: RoomEntry[];
};

export type SidebarMode = "expanded" | "rail" | "hidden";
