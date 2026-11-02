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

/** The unread badge a sidebar row shows for several rooms at once. */
export interface SidebarUnreadTotal {
  /** Unread messages the badge counts. */
  count: number;
  /** Some room in the span is unread; with nothing to count the badge is a dot. */
  markedUnread: boolean;
  /** How many rooms carry a count; the tooltip says so when it is more than one. */
  rooms: number;
  /** A counted room is folded away under the row rather than the row's own room. */
  nested: boolean;
}

/**
 * Sum the unread state of rooms that one row stands for. Rooms folded under
 * the row are skipped while muted, as Slack and Discord leave muted channels
 * out of a section total; the row's own room always counts.
 */
export function sidebarUnreadTotal(
  rooms: readonly RoomEntry[],
  options: { own?: RoomEntry | null; isMuted?: (roomIdentifier: string | null | undefined) => boolean } = {},
): SidebarUnreadTotal {
  const counted = rooms.filter((room) => room === options.own || !options.isMuted?.(room.roomIdentifier));
  const unread = counted.filter((room) => (room.unreadCount || 0) > 0);
  return {
    count: unread.reduce((total, room) => total + (room.unreadCount || 0), 0),
    markedUnread: counted.some((room) => room.hasUnread),
    rooms: unread.length,
    nested: unread.some((room) => room !== options.own),
  };
}

/**
 * Like Slack and Discord section headers: a collapsed group's parent row totals
 * the unread messages of every room folded under it, so nothing hides behind
 * the fold. Expanded, each room shows its own count and the parent shows only its.
 */
export function sidebarGroupUnread(
  project: ProjectGroup,
  collapsed: boolean,
  isMuted?: (roomIdentifier: string | null | undefined) => boolean,
): SidebarUnreadTotal {
  const folded = collapsed ? [...project.focusRooms, ...project.branchRooms] : [];
  return sidebarUnreadTotal([project.parent, ...folded], { own: project.parent, isMuted });
}

/** What a multi-room unread badge says, read aloud and in its tooltip. */
export function describeSidebarUnreadTotal(unread: SidebarUnreadTotal): string | null {
  if (unread.count <= 0) return unread.markedUnread ? "Marked unread" : null;
  const messages = `${unread.count} unread message${unread.count === 1 ? "" : "s"}`;
  if (unread.rooms > 1) return `${messages} in ${unread.rooms} rooms`;
  return unread.nested ? `${messages} in a nested room` : messages;
}
