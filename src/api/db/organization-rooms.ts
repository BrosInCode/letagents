import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "./client.js";
import { github_app_installations, github_app_repositories, github_repositories, rooms } from "./schema.js";

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
      eq(github_app_installations.target_type, "Organization"),
      isNull(github_app_installations.suspended_at),
      isNull(github_app_installations.uninstalled_at),
      isNull(github_app_repositories.removed_at),
      eq(rooms.kind, "main"),
    )).orderBy(asc(github_repositories.full_name));
}
