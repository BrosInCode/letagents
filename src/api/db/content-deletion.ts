import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { parseScopedId } from "./utils.js";
import { endRoomAgentSession, supervisorCanActSql } from "./auth/room-agent-sessions.js";
import { getSessionConnections } from "./messages/session-connections.js";

export async function isRoomDeleted(roomId: string): Promise<boolean> {
  return Boolean((await db.execute(sql`SELECT 1 FROM deleted_rooms WHERE room_id=${roomId}`)).rows.length);
}

export class ContentDeletionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockRoom(tx: Transaction, roomId: string): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${roomId}, 9510))`);
}

/** Rebuild one thread under the same fences used by projection insertion. */
async function removeThreadProjection(tx: Transaction, roomId: string, root: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${roomId}, 7880079))`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${roomId} || ':' || ${String(root)}, 7880078))`);
  await tx.execute(sql`DELETE FROM message_thread_projected_messages WHERE room_id=${roomId} AND thread_root_number=${root}`);
  await tx.execute(sql`DELETE FROM message_thread_participants WHERE room_id=${roomId} AND thread_root_number=${root}`);
  const removed = await tx.execute(sql`DELETE FROM message_thread_summaries WHERE room_id=${roomId} AND thread_root_number=${root} RETURNING 1`);
  if (removed.rows.length) await tx.execute(sql`UPDATE message_room_thread_stats SET thread_count=GREATEST(0,thread_count-1), reply_version=reply_version+1 WHERE room_id=${roomId}`);
}

async function rebuildThreadProjection(tx: Transaction, roomId: string, root: number): Promise<void> {
  const remaining = await tx.execute<{ number: number }>(sql`SELECT number FROM messages WHERE room_id=${roomId} AND thread_root_number=${root} ORDER BY number`);
  for (const row of remaining.rows) await tx.execute(sql`SELECT project_message_thread_message(${roomId}, ${row.number})`);
  await tx.execute(sql`UPDATE message_thread_reads r SET last_read_reply_count=(
    SELECT COALESCE(MAX(p.reply_ordinal),0) FROM message_thread_projected_messages p
    WHERE p.room_id=r.room_id AND p.thread_root_number=r.thread_root_number AND p.message_number<=r.last_read_message_number
  ) WHERE r.room_id=${roomId} AND r.thread_root_number=${root}`);
  await tx.execute(sql`UPDATE message_account_thread_read_stats SET cached_room_reply_version=-1 WHERE room_id=${roomId}`);
}

export async function deleteRoomMessage(input: {
  roomId: string; messageId: string; accountId: string; admin: boolean;
  thread?: boolean; attachmentId?: string;
}): Promise<{ deleted: true; message_ids: string[] }> {
  const number = parseScopedId(input.messageId, "msg");
  const attachment = input.attachmentId ? parseScopedId(input.attachmentId, "att") : null;
  if (!number || (input.attachmentId && !attachment)) throw new ContentDeletionError(400, "Invalid message or attachment identifier.");
  return db.transaction(async tx => {
    await lockRoom(tx, input.roomId);
    const { rows: [message] } = await tx.execute<{ publisher_account_id: string | null; thread_root_number: number | null }>(sql`
      SELECT publisher_account_id,thread_root_number FROM messages WHERE room_id=${input.roomId} AND number=${number} FOR UPDATE`);
    if (!message) throw new ContentDeletionError(404, "Message not found.");
    if (!input.admin && (input.thread || message.publisher_account_id !== input.accountId)) {
      throw new ContentDeletionError(403, input.thread ? "Only room admins can delete a whole thread." : "You can only delete your own messages and attachments.");
    }
    if (input.thread && message.thread_root_number) throw new ContentDeletionError(400, "Select the thread's original message.");
    const root = message.thread_root_number ?? number;
    if (!input.thread && !attachment && !message.thread_root_number) {
      const replies = await tx.execute(sql`SELECT 1 FROM messages WHERE room_id=${input.roomId} AND thread_root_number=${number} LIMIT 1`);
      if (replies.rows.length) throw new ContentDeletionError(409, "This message has replies. Delete the whole thread instead.");
    }
    const selected = input.thread ? sql`(number=${number} OR thread_root_number=${number})` : sql`number=${number}`;
    const { rows: targets } = await tx.execute<{ number: number }>(sql`SELECT number FROM messages WHERE room_id=${input.roomId} AND ${selected}`);
    const numbers = targets.map(row => row.number);
    const ids = sql.join(numbers.map(value => sql`${value}`), sql`, `);
    if (!attachment) {
      const active = await tx.execute(sql`SELECT 1 FROM message_agent_receipts WHERE message_room_id=${input.roomId} AND message_number IN (${ids}) AND receipt_state IN ('queued','responding','retrying','blocked') LIMIT 1`);
      if (active.rows.length) throw new ContentDeletionError(409, "Stop the agents working on this message before deleting it.");
    }
    const attachmentFilter = attachment ? sql`AND attachment_number=${attachment}` : sql``;
    const files = await tx.execute(sql`INSERT INTO attachment_deletion_queue(object_key)
      SELECT object_key FROM message_attachments WHERE room_id=${input.roomId} AND message_number IN (${ids}) ${attachmentFilter}
      ON CONFLICT DO NOTHING RETURNING object_key`);
    if (attachment && !files.rows.length) {
      const exists = await tx.execute(sql`SELECT 1 FROM message_attachments WHERE room_id=${input.roomId} AND message_number=${number} AND attachment_number=${attachment}`);
      if (!exists.rows.length) throw new ContentDeletionError(404, "Attachment not found.");
    }
    const removedFiles = await tx.execute<{ upload_id: string }>(sql`DELETE FROM message_attachments WHERE room_id=${input.roomId} AND message_number IN (${ids}) ${attachmentFilter} RETURNING upload_id`);
    for (const file of removedFiles.rows) await tx.execute(sql`DELETE FROM message_attachment_uploads WHERE upload_id=${file.upload_id}`);
    if (attachment) return { deleted: true, message_ids: [] };
    // Claiming and writing summaries lock this row too. Revoke any in-flight
    // summary before discarding its derived text so it cannot publish it again.
    // Keep the ingestion cursor: old text may have been posted while summaries were disabled.
    await tx.execute(sql`SELECT room_id FROM room_history_summary_state WHERE room_id=${input.roomId} FOR UPDATE`);
    await tx.execute(sql`UPDATE room_history_summary_state SET claim_token=NULL, leaf_count=0,
      failures=0,last_error=NULL,available_at=now(),updated_at=now() WHERE room_id=${input.roomId}`);
    await tx.execute(sql`DELETE FROM room_history_summary_nodes WHERE room_id=${input.roomId}`);
    const deliveries = await tx.execute<{ state: string }>(sql`SELECT state FROM wake_webhook_deliveries
      WHERE room_id=${input.roomId} AND message_number IN (${ids}) FOR UPDATE`);
    if (deliveries.rows.some(row => row.state === "processing")) throw new ContentDeletionError(409, "Wait for the notification being sent to finish before deleting this message.");
    await tx.execute(sql`DELETE FROM wake_webhook_deliveries WHERE room_id=${input.roomId} AND message_number IN (${ids})`);
    await removeThreadProjection(tx, input.roomId, root);
    await tx.execute(sql`INSERT INTO deleted_content_keys(room_id,kind,client_key)
      SELECT room_id,'message',client_message_id FROM messages WHERE room_id=${input.roomId} AND number IN (${ids}) AND client_message_id IS NOT NULL ON CONFLICT DO NOTHING`);
    await tx.execute(sql`UPDATE messages SET reply_to_number=NULL WHERE room_id=${input.roomId} AND reply_to_number IN (${ids})`);
    await tx.execute(sql`DELETE FROM messages WHERE room_id=${input.roomId} AND number IN (${ids})`);
    await rebuildThreadProjection(tx, input.roomId, root);
    return { deleted: true, message_ids: numbers.map(value => `msg_${value}`) };
  });
}

export async function deleteRoomTask(roomId: string, taskId: string): Promise<{ deleted: true }> {
  const number = parseScopedId(taskId, "task");
  if (!number) throw new ContentDeletionError(400, "Invalid task identifier.");
  return db.transaction(async tx => {
    await lockRoom(tx, roomId);
    const task = await tx.execute<{ status: string }>(sql`SELECT status FROM tasks WHERE room_id=${roomId} AND number=${number} FOR UPDATE`);
    if (!task.rows.length) throw new ContentDeletionError(404, "Task not found.");
    if (["assigned", "in_progress", "in_review", "blocked"].includes(task.rows[0].status)) throw new ContentDeletionError(409, "Cancel the task before deleting it.");
    const active = await tx.execute(sql`SELECT 1 FROM task_leases WHERE room_id=${roomId} AND task_id=${taskId} AND status='active' AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`);
    if (active.rows.length) throw new ContentDeletionError(409, "Cancel the task and release its active work or review leases before deleting it.");
    await tx.execute(sql`INSERT INTO deleted_content_keys(room_id,kind,client_key) SELECT room_id,'task',client_task_id FROM tasks WHERE room_id=${roomId} AND number=${number} AND client_task_id IS NOT NULL ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO deleted_content_keys(room_id,kind,client_key) SELECT room_id,'task_source',source_message_id FROM tasks WHERE room_id=${roomId} AND number=${number} AND client_task_id IS NULL AND source_message_id IS NOT NULL ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO deleted_content_keys(room_id,kind,client_key) SELECT room_id,'task_external',external_ref FROM tasks WHERE room_id=${roomId} AND number=${number} AND external_ref IS NOT NULL ON CONFLICT DO NOTHING`);
    await tx.execute(sql`DELETE FROM stale_task_prompt_mutes WHERE room_id=${roomId} AND task_id=${taskId}`);
    await tx.execute(sql`DELETE FROM room_shared_artifact_tasks WHERE room_id=${roomId} AND task_id=${taskId}`);
    await tx.execute(sql`UPDATE rooms SET source_task_id=NULL WHERE parent_room_id=${roomId} AND source_task_id=${taskId}`);
    await tx.execute(sql`UPDATE room_board_planning SET document=jsonb_set(document,'{tasks}',(document->'tasks') - ${taskId}),
      revision=revision+1,updated_at=now() WHERE room_id=${roomId} AND (document->'tasks') ? ${taskId}`);
    await tx.execute(sql`DELETE FROM tasks WHERE room_id=${roomId} AND number=${number}`);
    return { deleted: true };
  });
}

export async function getRoomDeletionPreview(roomId: string): Promise<{
  children: Array<{ roomIdentifier: string; displayName: string }>;
  counts: { messages: number; threads: number; tasks: number; files: number };
}> {
  const { rows: [preview] } = await db.execute<{
    children: Array<{ roomIdentifier: string; displayName: string }>;
    messages: number; threads: number; tasks: number; files: number;
  }>(sql`WITH RECURSIVE affected AS (
    SELECT id,display_name FROM rooms WHERE id=${roomId}
    UNION
    SELECT r.id,r.display_name FROM rooms r JOIN affected a ON r.parent_room_id=a.id
  ) SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('roomIdentifier',id,'displayName',display_name) ORDER BY id)
      FROM affected WHERE id<>${roomId}), '[]'::jsonb) AS children,
    (SELECT count(*)::int FROM messages WHERE room_id IN (SELECT id FROM affected)) AS messages,
    (SELECT count(*)::int FROM (SELECT DISTINCT room_id,thread_root_number FROM messages
      WHERE room_id IN (SELECT id FROM affected) AND thread_root_number IS NOT NULL) t) AS threads,
    (SELECT count(*)::int FROM tasks WHERE room_id IN (SELECT id FROM affected)) AS tasks,
    (SELECT count(*)::int FROM message_attachments WHERE room_id IN (SELECT id FROM affected)) AS files`);
  return { children: preview.children, counts: { messages: preview.messages, threads: preview.threads, tasks: preview.tasks, files: preview.files } };
}

type OpenWorkerSession = {
  session_id: string; room_id: string; display_name: string; supervised: boolean; process_live: boolean;
};
/** A running agent process refreshes its connection every 30 seconds. */
const PROCESS_LIVE_SQL = sql`(process_seen_at >= now() - interval '90 seconds'
  AND (process_disconnected_at IS NULL OR process_disconnected_at < process_seen_at)) AS process_live`;

/**
 * The open worker sessions that keep a room from being deleted: agents that
 * are there. One that waits for messages now, or whose process holds its
 * connection, is there; one run by the desktop is there until the desktop
 * retires it, and the desktop lists it while it is offline. Once the
 * desktop's grant has expired or was revoked, it can no longer retire the
 * agent, and the agent is offline like any other. Any other agent
 * is offline, and the room no longer waits for it.
 */
async function splitOpenWorkerSessions(executor: Transaction | typeof db, sessions: readonly OpenWorkerSession[]) {
  const present: OpenWorkerSession[] = [];
  const offline: OpenWorkerSession[] = [];
  const byRoom = new Map<string, OpenWorkerSession[]>();
  for (const session of sessions) byRoom.set(session.room_id, [...(byRoom.get(session.room_id) ?? []), session]);
  for (const [roomId, roomSessions] of byRoom) {
    const { reachable } = await getSessionConnections(executor, roomId, roomSessions.map(session => session.session_id));
    for (const session of roomSessions) {
      (session.supervised || session.process_live || reachable.has(session.session_id) ? present : offline).push(session);
    }
  }
  return { present, offline };
}

function presentAgentsMessage(present: readonly OpenWorkerSession[]): string {
  const names = [...new Set(present.map(session => session.display_name))];
  const shown = names.length > 3
    ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
    : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `${shown} ${names.length === 1 ? "is" : "are"} still in this room. Disconnect or retire ${names.length === 1 ? "it" : "them"} before deleting the room.`;
}

/**
 * Locks the room tree and makes every check that refuses a deletion. Open
 * worker sessions of agents that are offline do not refuse it; they are
 * returned for the caller to end.
 */
async function lockDeletableRoomTree(tx: Transaction, roomId: string) {
  // Lock each parent before discovering its children. FK checks prevent new
  // children, sessions and uploads from arriving after their parent is fenced.
  const rooms: Array<{ id: string; parent_room_id: string | null }> = [];
  const pending = [roomId];
  while (pending.length) {
    const id = pending.shift()!;
    await lockRoom(tx, id);
    const existing = await tx.execute<{ id: string; parent_room_id: string | null }>(sql`SELECT id,parent_room_id FROM rooms WHERE id=${id} FOR UPDATE`);
    if (!existing.rows.length) continue;
    rooms.push(existing.rows[0]);
    const children = await tx.execute<{ id: string }>(sql`SELECT id FROM rooms WHERE parent_room_id=${id} ORDER BY id`);
    pending.push(...children.rows.map(child => child.id));
  }
  if (!rooms.length) throw new ContentDeletionError(404, "Room not found.");
  const ids = sql.join(rooms.map(room => sql`${room.id}`), sql`, `);
  const active = await tx.execute<OpenWorkerSession>(sql`SELECT session_id,room_id,display_name,${supervisorCanActSql} AS supervised,${PROCESS_LIVE_SQL} FROM room_agent_sessions
    WHERE room_id IN (${ids}) AND ended_at IS NULL AND session_kind='worker' ORDER BY session_id FOR UPDATE`);
  const { present, offline } = await splitOpenWorkerSessions(tx, active.rows);
  if (present.length) throw new ContentDeletionError(409, presentAgentsMessage(present));
  const asks = await tx.execute(sql`SELECT 1 FROM agent_asks WHERE room_id IN (${ids}) AND state IN ('open','claimed','on_hold','active','paused') LIMIT 1`);
  if (asks.rows.length) throw new ContentDeletionError(409, "Cancel or end this room's agent requests before deleting it.");
  const deliveries = await tx.execute<{ state: string }>(sql`SELECT state FROM wake_webhook_deliveries WHERE room_id IN (${ids}) FOR UPDATE`);
  if (deliveries.rows.some(row => row.state === "processing")) throw new ContentDeletionError(409, "Wait for this room's notifications being sent to finish before deleting it.");
  const effects = await tx.execute<{ processing_token: string | null }>(sql`SELECT processing_token FROM workflow_effects WHERE room_id IN (${ids}) FOR UPDATE`);
  if (effects.rows.some(row => row.processing_token)) throw new ContentDeletionError(409, "Wait for this room's pending external actions to finish before deleting it.");
  const rentals = await tx.execute(sql`SELECT 1 FROM rental_sessions WHERE room_id IN (${ids}) OR target_room_id IN (${ids}) UNION ALL SELECT 1 FROM rental_activity_events WHERE room_id IN (${ids}) LIMIT 1`);
  if (rentals.rows.length) throw new ContentDeletionError(409, "This room has rental history and cannot be permanently deleted. Archive it to remove it from your room list.");
  return { rooms, ids, offline };
}

export async function deleteRoomData(roomId: string): Promise<{ deleted_room_ids: string[]; parent_room_id: string | null }> {
  // First make every check without changing anything: a deletion that will
  // be refused must not end anyone's session.
  const { offline } = await db.transaction(tx => lockDeletableRoomTree(tx, roomId));
  // Offline agents are ended the way they would end if they left by
  // themselves, so their credentials and open work close cleanly first.
  for (const session of offline) {
    await endRoomAgentSession({ session_id: session.session_id, room_id: session.room_id, only_if_open: true });
  }
  return db.transaction(async tx => {
    const { rooms, ids, offline: stillOpen } = await lockDeletableRoomTree(tx, roomId);
    // An agent joined, or went offline, in the moment between the two steps.
    if (stillOpen.length) throw new ContentDeletionError(409, "An agent changed in this room while it was being deleted. Try again.");
    await tx.execute(sql`INSERT INTO deleted_rooms(room_id) SELECT id FROM rooms WHERE id IN (${ids}) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO deleted_rooms(room_id) SELECT alias FROM room_aliases WHERE room_id IN (${ids}) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO attachment_deletion_queue(object_key)
      SELECT object_key FROM message_attachments WHERE room_id IN (${ids}) UNION SELECT object_key FROM message_attachment_uploads WHERE room_id IN (${ids}) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`DELETE FROM agent_asks WHERE room_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM rooms WHERE id=${roomId}`);
    return { deleted_room_ids: rooms.map(room => room.id), parent_room_id: rooms[0].parent_room_id };
  });
}
