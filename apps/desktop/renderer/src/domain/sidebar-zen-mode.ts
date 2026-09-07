import type { ProjectGroup, RoomEntry } from '../components/desktop/types';
import { orderedSidebarChildRooms } from './sidebar-room-order';
import { searchSidebarRooms } from './sidebar-room-search';

export function sidebarProjectForEntry(projects: readonly ProjectGroup[], entryId: string): ProjectGroup | null {
  return projects.find((project) => project.parent.id === entryId
    || project.branchRooms.some((room) => room.id === entryId)
    || project.focusRooms.some((room) => room.id === entryId)) || null;
}

export type SidebarRoomSwitchOption = {
  entry: RoomEntry;
  projectId: string;
  title: string;
  detail: string;
};

export function sidebarRoomSwitchOptions(projects: ProjectGroup[], query: string): SidebarRoomSwitchOption[] {
  if (query.trim()) {
    return searchSidebarRooms(projects, query).map(({ entry, context }) => ({
      entry,
      projectId: sidebarProjectForEntry(projects, entry.id)!.id,
      title: entry.title,
      detail: context,
    }));
  }
  return projects.flatMap((project) => {
    const children = orderedSidebarChildRooms(project);
    // A repo heading without a default room cannot be opened. Offer its real rooms.
    const entries = project.parent.roomIdentifier ? [project.parent] : children;
    return entries.filter((entry) => entry.roomIdentifier).map((entry) => ({
      entry,
      projectId: project.id,
      title: entry === project.parent ? project.roomName : entry.title,
      detail: entry === project.parent
        ? [project.parent.meta, children.length ? `${children.length} ${children.length === 1 ? 'room' : 'rooms'}` : ''].filter(Boolean).join(' · ')
        : project.roomName,
    }));
  });
}
