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
    await tx
      .insert(project_admins)
      .values({
        project_id: projectId,
        account_id: accountId,
        assigned_at: new Date().toISOString(),
      })
      .onConflictDoNothing();
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
