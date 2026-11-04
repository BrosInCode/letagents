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
    const [claim] = (await tx.execute(sql`SELECT
        room.kind,
        EXISTS (SELECT 1 FROM room_member_removals
          WHERE room_id = room.id AND account_id = ${accountId}) AS removed,
        EXISTS (SELECT 1 FROM room_members WHERE room_id = room.id) AS has_members,
        EXISTS (SELECT 1 FROM room_members
          WHERE room_id = room.id AND account_id = ${accountId}) AS is_member
      FROM rooms AS room WHERE room.id = ${projectId}`)).rows as Array<{
        kind: string; removed: boolean; has_members: boolean; is_member: boolean;
      }>;
    // A focus room is governed by its parent's admins: nobody becomes its
    // admin by opening it. A person removed from a room, or who left, does
    // not take it back. A room that already has members takes an admin only
    // from among them.
    if (!claim || claim.kind !== "main" || claim.removed) return;
    if (claim.has_members && !claim.is_member) return;
    await tx
      .insert(project_admins)
      .values({
        project_id: projectId,
        account_id: accountId,
        assigned_at: new Date().toISOString(),
      })
      .onConflictDoNothing();
    // The first admin of a top-level room is also its first member.
    await tx.execute(sql`INSERT INTO room_members (room_id, account_id, added_via)
      VALUES (${projectId}, ${accountId}, 'creator')
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
