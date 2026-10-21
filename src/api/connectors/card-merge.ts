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
import { toTask } from "../db/mappers.js";
import { getTaskRowById } from "../db/tasks.js";
import type { Task, TaskRow } from "../db/types.js";
import { formatTaskId, parseScopedId } from "../db/utils.js";
import { normalizeTaskWorkflowArtifacts } from "../repo-workflow.js";

export class ImportedCardBusyError extends Error {
  readonly code = "imported_card_busy";
  constructor(readonly importedTaskId: string) {
    super(`${importedTaskId} holds this ticket and work has started on it. Use that card, or cancel it first.`);
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
type Executor = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Statuses an imported card may be merged from: no work, lease or review history yet. */
const MERGEABLE_STATUSES = new Set(["proposed", "accepted", "cancelled"]);

export async function mergeImportedCardIntoNative(input: {
  room_id: string;
  native_task_id: string;
  external_ref: string;
}, executor?: Executor): Promise<ImportedCardMerge> {
  const nativeNumber = parseScopedId(input.native_task_id, "task");
  if (!nativeNumber) return NOT_MERGED;

  const merge = async (tx: Executor): Promise<ImportedCardMerge> => {
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

    // A card someone worked on carries leases, reviews, effects and intents
    // under its id. Only an untouched imported card is folded in.
    if (!MERGEABLE_STATUSES.has(imported.status) || imported.assignee || imported.assignee_agent_key) {
      throw new ImportedCardBusyError(importedId);
    }
    const [anyLease] = await tx.select({ id: task_leases.id }).from(task_leases)
      .where(and(eq(task_leases.room_id, input.room_id), eq(task_leases.task_id, importedId)))
      .limit(1);
    if (anyLease) throw new ImportedCardBusyError(importedId);

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
  };
  // Inside a caller's transaction, the caller clears the scope memo after commit.
  if (executor) return merge(executor);
  const result = await db.transaction(merge);
  if (result.merged) invalidateRoomExternalRefScope(input.room_id);
  return result;
}

export interface TicketLinkResult<T> {
  task: T | null;
  /** The imported card folded into this one, if any. */
  merged_task_id: string | null;
}

/**
 * A card update that sets `external_ref`. When an imported card holds the
 * ticket, one transaction applies the rest of the update first (with its
 * lease fence and transition checks), then folds the imported card in. When
 * nothing is merged, the update runs as usual and a held key is a conflict.
 */
export async function updateTaskLinkingTicket<U extends { external_ref?: string | null }>(
  input: { room_id: string; task_id: string; external_ref: string; updates: U },
  update: (updates: U, tx: Executor) => Promise<Task | null>,
): Promise<TicketLinkResult<Task>> {
  const result = await db.transaction(async (tx) => {
    const [holder] = await tx.select({ number: tasks.number, created_by: tasks.created_by }).from(tasks)
      .where(and(eq(tasks.room_id, input.room_id), eq(tasks.external_ref, input.external_ref)))
      .limit(1);
    const nativeNumber = parseScopedId(input.task_id, "task");
    if (!holder || holder.number === nativeNumber || !isTrackerImportCreator(holder.created_by)) {
      return { task: await update(input.updates, tx), merged_task_id: null };
    }
    const rest = { ...input.updates };
    delete rest.external_ref;
    const written = await update(rest, tx);
    if (!written) return { task: null, merged_task_id: null };
    const merge = await mergeImportedCardIntoNative({
      room_id: input.room_id,
      native_task_id: input.task_id,
      external_ref: input.external_ref,
    }, tx);
    if (!merge.merged) {
      // The holder changed under us: let the plain write report the conflict.
      return { task: await update({ external_ref: input.external_ref } as U, tx), merged_task_id: null };
    }
    const row = await getTaskRowById(input.room_id, input.task_id, tx);
    return { task: row ? toTask(row) : null, merged_task_id: merge.imported_task_id };
  });
  invalidateRoomExternalRefScope(input.room_id);
  return result;
}
