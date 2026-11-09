import { and, asc, eq, exists, isNull, ne, or } from "drizzle-orm";

import { db } from "./client.js";
import { github_app_installations, github_app_repositories, github_repositories, project_admins, room_members, rooms } from "./schema.js";

export async function getConnectedOrganizationRooms(organizationId: string) {
  // The installation target's immutable ID supplies the optional company
  // association. No new room ancestry or duplicate repository identity is needed.
  return db.select({
    github_repo_id: github_repositories.github_repo_id,
    room_id: rooms.id,
    display_name: rooms.display_name,
    full_name: github_repositories.full_name,
  }).from(github_app_installations)
    .innerJoin(github_app_repositories, eq(github_app_repositories.installation_id, github_app_installations.installation_id))
    .innerJoin(github_repositories, eq(github_repositories.github_repo_id, github_app_repositories.github_repo_id))
    .innerJoin(rooms, eq(rooms.id, github_repositories.room_id))
    .where(and(
      eq(github_app_installations.target_github_id, organizationId),
      // GitHub IDs are unique across users and organizations, so the target ID
      // names the company. Do not require target_type "Organization": repository
      // webhooks used to overwrite it with "Account", and those rows stay until
      // the next webhook for that installation.
      ne(github_app_installations.target_type, "User"),
      isNull(github_app_installations.suspended_at),
      isNull(github_app_installations.uninstalled_at),
      isNull(github_app_repositories.removed_at),
      eq(rooms.kind, "main"),
    )).orderBy(asc(github_repositories.full_name));
}

// Company rooms with no repository: rooms made inside the company. Only rooms
// the person already belongs to (member or admin) are listed.
export async function getMemberOrganizationRooms(organizationId: string, accountId: string) {
  return db.select({ room_id: rooms.id, display_name: rooms.display_name })
    .from(rooms)
    .where(and(
      eq(rooms.organization_id, organizationId),
      eq(rooms.kind, "main"),
      or(
        exists(db.select({ one: room_members.room_id }).from(room_members)
          .where(and(eq(room_members.room_id, rooms.id), eq(room_members.account_id, accountId)))),
        exists(db.select({ one: project_admins.project_id }).from(project_admins)
          .where(and(eq(project_admins.project_id, rooms.id), eq(project_admins.account_id, accountId)))),
      ),
    ))
    .orderBy(asc(rooms.display_name), asc(rooms.id));
}
