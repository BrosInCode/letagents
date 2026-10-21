/**
 * Native card link (ticket connectors PR3). When a person sets a ticket key on
 * their own card and sync already imported a card for that ticket, the two
 * become one: the native card stays, takes the imported card's ticket state,
 * pull requests, shared artifacts, events and linked threads, and the imported
 * duplicate is deleted. One transaction.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { isTrackerImportCreator } from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import {
  github_room_events,
  room_shared_artifact_tasks,
  stale_task_prompt_mutes,
  task_leases,
  task_mentions,
  tasks,
} from "../db/schema.js";
import { invalidateRoomExternalRefScope } from "../db/task-external-refs.js";
import type { TaskRow } from "../db/types.js";
import { formatTaskId, parseScopedId } from "../db/utils.js";
import { normalizeTaskWorkflowArtifacts } from "../repo-workflow.js";

export class ImportedCardBusyError extends Error {
  readonly code = "imported_card_busy";
  constructor(readonly importedTaskId: string) {
    super(`${importedTaskId} holds this ticket and an agent is working on it. Finish or release that card first.`);
    this.name = "ImportedCardBusyError";
  }
}

export interface ImportedCardMerge {
  merged: boolean;
  /** The imported card that was folded into the native card and deleted. */
  imported_task_id: string | null;
}

const NOT_MERGED: ImportedCardMerge = { merged: false, imported_task_id: null };

/**
 * Folds the imported card that holds `externalRef` into `nativeTaskId`, which
 * then holds the key. Does nothing (merged: false) when no card holds the key,
 * or when the card that holds it is not an imported card: the caller's normal
 * write then reports the usual conflict.
 */
export async function mergeImportedCardIntoNative(input: {
  room_id: string;
  native_task_id: string;
  external_ref: string;
}): Promise<ImportedCardMerge> {
  const nativeNumber = parseScopedId(input.native_task_id, "task");
  if (!nativeNumber) return NOT_MERGED;

  const result = await db.transaction(async (tx) => {
    // Lock both cards, in key order, before reading anything else about them.
    const rows = await tx.select().from(tasks)
      .where(and(eq(tasks.room_id, input.room_id), or(eq(tasks.number, nativeNumber), eq(tasks.external_ref, input.external_ref))))
      .orderBy(tasks.number)
      .for("update") as TaskRow[];
    const native = rows.find((row) => row.number === nativeNumber);
    const imported = rows.find((row) => row.number !== nativeNumber && row.external_ref === input.external_ref);
    if (!native || !imported || !isTrackerImportCreator(imported.created_by)) return NOT_MERGED;
    const importedId = formatTaskId(imported.number);
    const nativeId = formatTaskId(native.number);

    const [activeLease] = await tx.select({ id: task_leases.id }).from(task_leases)
      .where(and(eq(task_leases.room_id, input.room_id), eq(task_leases.task_id, importedId), eq(task_leases.status, "active")))
      .limit(1);
    if (activeLease) throw new ImportedCardBusyError(importedId);

    // Threads that name the key now list under the native card.
    await tx.execute(sql`
      INSERT INTO ${task_mentions} (room_id, task_number, message_number, key, created_at)
      SELECT room_id, ${native.number}, message_number, key, created_at FROM ${task_mentions}
       WHERE room_id = ${input.room_id} AND task_number = ${imported.number}
      ON CONFLICT DO NOTHING
    `);
    await tx.update(github_room_events).set({ linked_task_id: nativeId })
      .where(and(eq(github_room_events.room_id, input.room_id), eq(github_room_events.linked_task_id, importedId)));
    // Shared artifact links move unless the native card already has the same one.
    await tx.execute(sql`
      UPDATE ${room_shared_artifact_tasks} AS moving SET task_id = ${nativeId}
       WHERE moving.room_id = ${input.room_id} AND moving.task_id = ${importedId}
         AND NOT EXISTS (
           SELECT 1 FROM ${room_shared_artifact_tasks} AS kept
            WHERE kept.room_id = moving.room_id
              AND kept.artifact_identity_key = moving.artifact_identity_key
              AND kept.task_id = ${nativeId}
         )
    `);
    await tx.delete(room_shared_artifact_tasks)
      .where(and(eq(room_shared_artifact_tasks.room_id, input.room_id), eq(room_shared_artifact_tasks.task_id, importedId)));
    await tx.delete(stale_task_prompt_mutes)
      .where(and(eq(stale_task_prompt_mutes.room_id, input.room_id), inArray(stale_task_prompt_mutes.task_id, [importedId])));

    const prUrl = native.pr_url ?? imported.pr_url;
    const artifacts = normalizeTaskWorkflowArtifacts({
      artifacts: [...native.workflow_artifacts, ...imported.workflow_artifacts],
      prUrl,
    });
    // The key must leave the imported card before the native card can hold it.
    await tx.delete(tasks).where(and(eq(tasks.room_id, input.room_id), eq(tasks.number, imported.number)));
    await tx.update(tasks).set({
      external_ref: input.external_ref,
      ticket_state: imported.ticket_state,
      external_item_id: imported.external_item_id,
      pr_url: prUrl,
      workflow_artifacts: artifacts,
      updated_at: new Date().toISOString(),
    }).where(and(eq(tasks.room_id, input.room_id), eq(tasks.number, native.number)));
    return { merged: true, imported_task_id: importedId };
  });
  if (result.merged) invalidateRoomExternalRefScope(input.room_id);
  return result;
}
