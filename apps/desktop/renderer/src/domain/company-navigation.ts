import type { DesktopAccountRoomEntry } from "../../../electron/ipc-types/room.js";
import type { DesktopOrganizationRoom } from "../../../electron/ipc-types/organizations.js";
import type { ProjectGroup } from "../components/desktop/types.js";

export function mergeCompanyRooms(existing: DesktopAccountRoomEntry[], rooms: DesktopOrganizationRoom[]): DesktopAccountRoomEntry[] {
  const known = new Set(existing.map((room) => room.roomIdentifier.toLowerCase()));
  return [...existing, ...rooms.filter((room) => !known.has(room.room_id.toLowerCase())).map((room): DesktopAccountRoomEntry => {
    const [owner, name] = room.full_name.split("/");
    return {
      roomIdentifier: room.room_id, displayName: room.display_name, name: room.room_id,
      kind: "main", parentRoomId: null, focusKey: null, sourceTaskId: null, focusStatus: null,
      role: "participant", source: "organization", pinned: false, archived: false,
      canLeave: false, canDelete: false, deleteReason: "Company repo rooms are managed through GitHub.",
      firstOpenedAt: null, lastOpenedAt: null, latestMessageId: null, latestMessageAt: null,
      focusRooms: [],
      gitRoom: {
        provider: "github", host: "github.com", repository: { id: room.github_repo_id, fullName: room.full_name, owner, name },
        ref: { type: "default_branch", name: null, defaultBranch: null, baseRef: null, headRef: null, headRepository: null },
        visibility: room.visibility, accessMode: room.visibility, isDefault: true, source: "github_repository",
      },
    };
  })];
}

// This is navigation grouping only. Company discovery and room entry remain
// server-authorized; an owner name is never used to grant access.
export function companyProjectGroups(
  projects: ProjectGroup[], selectedId: string | null,
  rooms: DesktopOrganizationRoom[],
): ProjectGroup[] {
  if (selectedId) {
    const ids = new Set(rooms.map((room) => room.github_repo_id));
    const names = new Set(rooms.map((room) => room.room_id.toLowerCase()));
    return projects.filter((project) => {
      const repoId = project.parent.gitRoom?.repository.id;
      return (repoId && ids.has(repoId)) || names.has(project.parent.roomIdentifier?.toLowerCase() ?? "");
    });
  }
  // Personal/shared is the existing account view, including directly opened
  // company repos. Company setup must never hide an unconnected/shared repo.
  return projects;
}

/** The parts of a sidebar entry that decide whether a room list includes it. */
export interface CompanyListedEntry {
  id: string;
  type: string;
  kind?: string;
  parentRoomIdentifier?: string | null;
}

/**
 * Whether these room groups list the entry: as one of their rooms, or as a
 * focus room of a listed repo room. A new focus room is not in the groups until
 * the next refresh, and a closed one never is, but both belong to their parent.
 */
function projectsListEntry(projects: ProjectGroup[], entry: CompanyListedEntry): boolean {
  const parent = entry.kind === "focus" ? entry.parentRoomIdentifier?.toLowerCase() : null;
  return projects.some((project) =>
    [project.parent, ...project.branchRooms, ...project.focusRooms].some((room) => room.id === entry.id && room.roomIdentifier)
    || Boolean(parent && project.parent.roomIdentifier?.toLowerCase() === parent));
}

/** Whether the selected company's room groups list this sidebar entry (always true without a company). */
export function companyListsEntry(
  projects: ProjectGroup[], selectedId: string | null,
  rooms: DesktopOrganizationRoom[], entry: CompanyListedEntry,
): boolean {
  if (!selectedId) return true;
  return projectsListEntry(companyProjectGroups(projects, selectedId, rooms), entry);
}

/**
 * The company home replaces the main view while an invitation is open, or while
 * a selected company does not list the active room. Without a company the
 * sidebar is the existing account view, so an unlisted room (a closed focus
 * room) opens as it always did.
 */
export function showsCompanyHome(input: {
  pendingInvite: string | null;
  activeEntry: CompanyListedEntry;
  selectedId: string | null;
  sidebarProjects: ProjectGroup[];
}): boolean {
  if (input.pendingInvite) return true;
  if (input.activeEntry.type !== "room" || !input.selectedId) return false;
  return !projectsListEntry(input.sidebarProjects, input.activeEntry);
}
