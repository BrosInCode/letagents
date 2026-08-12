import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../client.js";
import { stale_task_prompt_mutes } from "../schema.js";
import { toStaleTaskPromptMute } from "../mappers.js";
import { acquireLeaseFenceTx, LeaseFenceStaleError, type LeaseFence } from "./lease-rebind.js";
import type {
  StaleTaskPromptMute,
  StaleTaskPromptMuteRow,
} from "../types.js";

// stale-prompt mute/unmute are work-lease-scoped (routes declare
// forcedMutation leaseKind "work"). When the caller's authority is a held work
// lease, the write runs inside the fence tx (plan §4.5) so a rebind that moves
// the lease first aborts it (LeaseFenceStaleError) rather than a rebound-away
// predecessor toggling the mute state.
export async function upsertStaleTaskPromptMute(input: {
  room_id: string;
  task_id: string;
  task_updated_at: string;
  muted_by: string;
}, leaseFence?: LeaseFence | null): Promise<StaleTaskPromptMute> {
  const now = new Date().toISOString();
  const write = async (executor: Pick<typeof db, "insert">) => {
    const [row] = (await executor
      .insert(stale_task_prompt_mutes)
      .values({
        room_id: input.room_id,
        task_id: input.task_id,
        task_updated_at: input.task_updated_at,
        muted_by: input.muted_by,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [stale_task_prompt_mutes.room_id, stale_task_prompt_mutes.task_id],
        set: {
          task_updated_at: input.task_updated_at,
          muted_by: input.muted_by,
          updated_at: now,
        },
      })
      .returning()) as StaleTaskPromptMuteRow[];
    return toStaleTaskPromptMute(row);
  };
  if (leaseFence) {
    return db.transaction(async (tx) => {
      if (!(await acquireLeaseFenceTx(tx, leaseFence))) throw new LeaseFenceStaleError();
      return write(tx);
    });
  }
  return write(db);
}

export async function getStaleTaskPromptMutes(
  roomId: string,
  taskIds?: readonly string[]
): Promise<StaleTaskPromptMute[]> {
  const conditions = [eq(stale_task_prompt_mutes.room_id, roomId)];
  if (taskIds && taskIds.length > 0) {
    conditions.push(inArray(stale_task_prompt_mutes.task_id, [...taskIds]));
  }

  const rows = (await db
    .select()
    .from(stale_task_prompt_mutes)
    .where(and(...conditions))
    .orderBy(asc(stale_task_prompt_mutes.updated_at))) as StaleTaskPromptMuteRow[];

  return rows.map(toStaleTaskPromptMute);
}

export async function clearStaleTaskPromptMute(
  roomId: string,
  taskId: string,
  leaseFence?: LeaseFence | null
): Promise<boolean> {
  const write = async (executor: Pick<typeof db, "delete">) => {
    const deleted = await executor
      .delete(stale_task_prompt_mutes)
      .where(and(eq(stale_task_prompt_mutes.room_id, roomId), eq(stale_task_prompt_mutes.task_id, taskId)))
      .returning({ task_id: stale_task_prompt_mutes.task_id });
    return deleted.length > 0;
  };
  if (leaseFence) {
    return db.transaction(async (tx) => {
      if (!(await acquireLeaseFenceTx(tx, leaseFence))) throw new LeaseFenceStaleError();
      return write(tx);
    });
  }
  return write(db);
}
