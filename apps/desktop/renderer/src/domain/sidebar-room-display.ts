import type { ProjectGroup, RoomEntry } from "../components/desktop/types";

/** One agent answering a message in a room, as the sidebar shows it. */
export interface SidebarWorkingAgent {
  displayName: string;
}

export interface SidebarRoomActivity {
  working: SidebarWorkingAgent[];
}

/**
 * A focus room sits under its parent with its own icon, so the "Focus:"
 * prefix it was created with only repeats what the row already shows.
 */
export function sidebarRoomTitle(entry: Pick<RoomEntry, "kind" | "title">): string {
  if (entry.kind !== "focus") return entry.title;
  const stripped = entry.title.replace(/^focus:\s*/i, "");
  return stripped || entry.title;
}

/** What a room's working indicator says, read aloud and in its tooltip. */
export function describeSidebarRoomActivity(activity: SidebarRoomActivity | null | undefined): string | null {
  const names = activity?.working.map((agent) => agent.displayName).filter(Boolean) ?? [];
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} is working`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are working`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are working`;
}

/**
 * A collapsed room group still tells you work is happening inside it: the
 * parent row shows its own agents and those of the rooms folded under it.
 */
export function sidebarGroupActivity(project: ProjectGroup, collapsed: boolean): SidebarRoomActivity | null {
  const rooms = collapsed ? [project.parent, ...project.focusRooms, ...project.branchRooms] : [project.parent];
  const working = rooms.flatMap((room) => room.activity?.working ?? []);
  return working.length ? { working } : null;
}

/** Details that used to take a second line now live in the row's tooltip. */
export function sidebarProjectDetails(project: ProjectGroup): string {
  const parts = [project.parent.meta];
  const branchCount = project.branchRooms.length;
  const focusCount = project.focusRooms.length;
  if (branchCount) parts.push(`${branchCount} ${branchCount === 1 ? "branch" : "branches"}`);
  if (focusCount) parts.push(`${focusCount} focus ${focusCount === 1 ? "room" : "rooms"}`);
  return parts.filter(Boolean).join(" · ");
}
