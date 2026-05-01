export type RoomEntry = {
  id: string;
  type: "room";
  kind: "parent" | "focus";
  title: string;
  meta: string;
  sectionLabel: string;
  headline: string;
  description: string;
};

export type SystemEntry = {
  id: "system:repos" | "system:workers" | "system:diagnostics";
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
