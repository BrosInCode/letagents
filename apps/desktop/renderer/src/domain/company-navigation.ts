import type { DesktopAccountRoomEntry } from "../../../electron/ipc-types/room.js";
import type { DesktopOrganizationRoom } from "../../../electron/ipc-types/organizations.js";
import type { ProjectGroup } from "../components/desktop/types.js";

/**
 * Add the company's rooms that the account list does not have yet, so the
 * sidebar shows repo rooms the person has not opened. A company room with no
 * repository is listed only for its members, who already have it.
 */
export function mergeCompanyRooms(existing: DesktopAccountRoomEntry[], rooms: DesktopOrganizationRoom[]): DesktopAccountRoomEntry[] {
  const known = new Set(existing.map((room) => room.roomIdentifier.toLowerCase()));
  return [...existing, ...rooms.filter((room) => !known.has(room.room_id.toLowerCase())).map((room): DesktopAccountRoomEntry => {
    const base: DesktopAccountRoomEntry = {
      roomIdentifier: room.room_id, displayName: room.display_name, name: room.room_id,
      kind: "main", parentRoomId: null, focusKey: null, sourceTaskId: null, focusStatus: null,
      role: "participant", source: "organization", pinned: false, archived: false,
      canLeave: false, canDelete: false, deleteReason: "Company repo rooms are managed through GitHub.",
      firstOpenedAt: null, lastOpenedAt: null, latestMessageId: null, latestMessageAt: null,
      focusRooms: [], gitRoom: null,
    };
    if (room.kind !== "repo" || !room.full_name || !room.github_repo_id || !room.visibility) {
      return { ...base, deleteReason: "Company rooms belong to the company." };
    }
    const [owner, name] = room.full_name.split("/");
    return {
      ...base,
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
    const ids = new Set(rooms.flatMap((room) => room.github_repo_id ? [room.github_repo_id] : []));
    const names = new Set(rooms.map((room) => room.room_id.toLowerCase()));
    // Pins are personal, so a pinned room stays in view in every company.
    return projects.filter((project) => {
      if (project.parent.pinned) return true;
      const repoId = project.parent.gitRoom?.repository.id;
      return (repoId && ids.has(repoId)) || names.has(project.parent.roomIdentifier?.toLowerCase() ?? "");
    });
  }
  // "All rooms" is the existing account view, including directly opened
  // company repos. Company setup must never hide an unconnected/shared repo.
  return projects;
}
