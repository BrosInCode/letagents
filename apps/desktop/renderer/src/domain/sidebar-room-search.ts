import type { ProjectGroup, RoomEntry } from "../components/desktop/types";
import { orderedSidebarChildRooms } from "./sidebar-room-order";

export type SidebarRoomSearchResult = {
  entry: RoomEntry;
  context: string;
};

export function searchSidebarRooms(
  projects: ProjectGroup[],
  query: string,
  limit = 20,
): SidebarRoomSearchResult[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || limit <= 0) return [];

  const results: SidebarRoomSearchResult[] = [];
  const seen = new Set<string>();

  for (const project of projects) {
    const entries = [project.parent, ...orderedSidebarChildRooms(project)];
    for (const entry of entries) {
      if (!entry.roomIdentifier || seen.has(entry.id)) continue;
      const searchable = [
        entry.title,
        entry.meta,
        entry.sectionLabel,
        entry.headline,
        entry.description,
        entry.focusKey,
        entry.gitRoom?.repository.fullName,
        entry.gitRoom?.ref.name,
        project.roomName,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      if (!terms.every((term) => searchable.includes(term))) continue;

      seen.add(entry.id);
      results.push({
        entry,
        context: roomSearchContext(project, entry),
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

function roomSearchContext(project: ProjectGroup, entry: RoomEntry): string {
  const detail = entry.kind === "parent"
    ? entry.meta
    : entry.focusKey || entry.gitRoom?.ref.name || entry.meta;
  return detail && detail !== project.roomName
    ? `${project.roomName} · ${detail}`
    : project.roomName;
}
