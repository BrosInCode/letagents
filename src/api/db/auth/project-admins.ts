import { and, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { project_admins } from "../schema.js";

export async function assignProjectAdmin(projectId: string, accountId: string): Promise<void> {
  await db
    .insert(project_admins)
    .values({
      project_id: projectId,
      account_id: accountId,
      assigned_at: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

export async function assignProjectAdminIfRoomHasNoAdmins(
  projectId: string,
  accountId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project_admin:${projectId}`}, 0))`);
    const [existing] = await tx
      .select({ account_id: project_admins.account_id })
      .from(project_admins)
      .where(eq(project_admins.project_id, projectId))
      .limit(1);
    if (existing) return;
    // A person removed from the room, or who left, takes neither it nor one
    // of its focus rooms back.
    const [removed] = (await tx.execute(sql`SELECT 1 AS removed FROM room_member_removals
      WHERE account_id = ${accountId}
        AND room_id IN (SELECT id FROM rooms WHERE id = ${projectId}
          UNION SELECT parent_room_id FROM rooms WHERE id = ${projectId} AND parent_room_id IS NOT NULL)
      LIMIT 1`)).rows;
    if (removed) return;
    await tx
      .insert(project_admins)
      .values({
        project_id: projectId,
        account_id: accountId,
        assigned_at: new Date().toISOString(),
      })
      .onConflictDoNothing();
    // The first admin of a top-level room is also its first member. A focus
    // room has no members of its own: it uses those of its parent.
    await tx.execute(sql`INSERT INTO room_members (room_id, account_id, added_via)
      SELECT id, ${accountId}, 'creator' FROM rooms WHERE id = ${projectId} AND kind = 'main'
      ON CONFLICT (room_id, account_id) DO NOTHING`);
  });
}

export async function isProjectAdmin(projectId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(project_admins)
    .where(
      and(eq(project_admins.project_id, projectId), eq(project_admins.account_id, accountId))
    );

  return (row?.count ?? 0) > 0;
}
