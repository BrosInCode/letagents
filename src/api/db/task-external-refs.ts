/**
 * Cards that name an external ticket (`tasks.external_ref`) and the room
 * messages that mention them (`task_mentions`). A room with no external ref
 * pays one indexed probe here and runs no detector.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  detectKeysInMessage,
  type KeyDetectorOptions,
  type TicketKeyMatch,
} from "../connectors/key-detectors.js";
import { db } from "./client.js";
import { toTask } from "./mappers.js";
import { visibleMessageCondition } from "./messages/visibility.js";
import { messages, task_mentions, tasks } from "./schema.js";
import { formatMessageId, formatTaskId, parseScopedId } from "./utils.js";
import type { MessageRow, Task, TaskRow } from "./types.js";

type ReadExecutor = Pick<typeof db, "select" | "execute">;
type WriteExecutor = ReadExecutor & Pick<typeof db, "insert">;

export const TASK_EXTERNAL_REF_UNIQUE_INDEX = "tasks_room_external_ref_unique_idx";

export class TaskExternalRefConflictError extends Error {
  readonly code = "task_external_ref_conflict";

  constructor(readonly externalRef: string, readonly existingTaskId: string | null) {
    super(existingTaskId
      ? `${externalRef} is already on ${existingTaskId} in this room.`
      : `${externalRef} is already on another card in this room.`);
    this.name = "TaskExternalRefConflictError";
  }
}

export function isTaskExternalRefUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23505" && (candidate.constraint === TASK_EXTERNAL_REF_UNIQUE_INDEX
      || (typeof candidate.message === "string" && candidate.message.includes(TASK_EXTERNAL_REF_UNIQUE_INDEX)))) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export interface RoomExternalRefScope {
  hasExternalRefs: boolean;
  detectorOptions: KeyDetectorOptions;
}

const NO_EXTERNAL_REFS: RoomExternalRefScope = { hasExternalRefs: false, detectorOptions: {} };

/**
 * One probe on the partial unique index. It tells whether the room has any
 * card with an external ref, and which Linear team keys its cards name: the
 * only Linear keys the detector may match until connections supply them.
 */
export async function getRoomExternalRefScope(
  roomId: string,
  executor: ReadExecutor = db,
): Promise<RoomExternalRefScope> {
  const result = await executor.execute(sql`
    SELECT DISTINCT CASE
      WHEN ${tasks.external_ref} LIKE 'linear:%'
      THEN split_part(split_part(${tasks.external_ref}, ':', 2), '-', 1)
    END AS linear_team_key
    FROM ${tasks}
    WHERE ${tasks.room_id} = ${roomId} AND ${tasks.external_ref} IS NOT NULL
    LIMIT 200
  `);
  const rows = result.rows as Array<{ linear_team_key: string | null }>;
  if (rows.length === 0) return NO_EXTERNAL_REFS;
  return {
    hasExternalRefs: true,
    detectorOptions: {
      linearTeamKeys: rows.map((row) => row.linear_team_key).filter((key): key is string => Boolean(key)),
    },
  };
}

// In-process memo of each room's scope, so a room with no ticket cards pays no
// query per message. Writes to external_ref in this process clear the room's
// entry; another API process sees a change within the TTL.
export const ROOM_EXTERNAL_REF_SCOPE_TTL_MS = 30_000;
const MAX_CACHED_ROOM_SCOPES = 5_000;
const scopeCache = new Map<string, { scope: RoomExternalRefScope; expiresAt: number }>();

/** The cached scope while it is fresh, else undefined. Never queries. */
export function peekRoomExternalRefScope(roomId: string, now = Date.now()): RoomExternalRefScope | undefined {
  const entry = scopeCache.get(roomId);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    scopeCache.delete(roomId);
    return undefined;
  }
  return entry.scope;
}

export async function getCachedRoomExternalRefScope(
  roomId: string,
  executor: ReadExecutor = db,
): Promise<RoomExternalRefScope> {
  const cached = peekRoomExternalRefScope(roomId);
  if (cached) return cached;
  const scope = await getRoomExternalRefScope(roomId, executor);
  scopeCache.delete(roomId);
  if (scopeCache.size >= MAX_CACHED_ROOM_SCOPES) {
    // Map order is insertion order: drop the oldest entry.
    const oldest = scopeCache.keys().next().value;
    if (oldest !== undefined) scopeCache.delete(oldest);
  }
  scopeCache.set(roomId, { scope, expiresAt: Date.now() + ROOM_EXTERNAL_REF_SCOPE_TTL_MS });
  return scope;
}

/** Call after a write that sets or clears a card's external_ref in the room. */
export function invalidateRoomExternalRefScope(roomId: string): void {
  scopeCache.delete(roomId);
}

/** The first card, in the order of `refs`, whose external ref is one of them. */
export async function findTaskByExternalRefs(
  roomId: string,
  refs: readonly string[],
  executor: ReadExecutor = db,
): Promise<Task | undefined> {
  if (refs.length === 0) return undefined;
  const rows = (await executor
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), inArray(tasks.external_ref, [...refs])))) as TaskRow[];
  for (const ref of refs) {
    const row = rows.find((candidate) => candidate.external_ref === ref);
    if (row) return toTask(row);
  }
  return undefined;
}

export async function findTaskIdByExternalRef(
  roomId: string,
  externalRef: string,
  executor: ReadExecutor = db,
): Promise<string | null> {
  const [row] = await executor
    .select({ number: tasks.number })
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), eq(tasks.external_ref, externalRef)))
    .limit(1);
  return row ? formatTaskId(row.number) : null;
}

/** GitHub projections and LetAgents status notices quote PR titles; they are not threads about a ticket. */
function isSystemStatusMessage(message: Partial<Pick<MessageRow, "sender" | "source">>): boolean {
  return message.source === "github" || message.sender === "letagents";
}

/**
 * Whether the message path must open a savepoint for mention linking. False
 * only while the room is cached as having no ticket cards: then the message
 * costs no query at all.
 */
export function mayLinkTaskMentions(roomId: string): boolean {
  return peekRoomExternalRefScope(roomId)?.hasExternalRefs !== false;
}

export interface TaskMentionDeps {
  getScope?: typeof getRoomExternalRefScope;
  detect?: (text: string, options: KeyDetectorOptions) => TicketKeyMatch[];
}

/**
 * Records a `task_mentions` row for each card whose key the message names.
 * Runs in the message's transaction. Rooms with no external ref stop after the
 * scope probe and never run the detector (ticket connectors invariant 1).
 */
export async function recordTaskMentionsForMessage(
  executor: WriteExecutor,
  roomId: string,
  message: Pick<MessageRow, "number" | "text"> & Partial<Pick<MessageRow, "sender" | "source">>,
  deps: TaskMentionDeps = {},
): Promise<number> {
  if (!message.text.trim() || isSystemStatusMessage(message)) return 0;
  const scope = await (deps.getScope ?? getCachedRoomExternalRefScope)(roomId, executor);
  if (!scope.hasExternalRefs) return 0;
  const detected = (deps.detect ?? detectKeysInMessage)(message.text, scope.detectorOptions);
  if (detected.length === 0) return 0;

  const cards = await executor
    .select({ number: tasks.number, external_ref: tasks.external_ref })
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), inArray(tasks.external_ref, detected.map((match) => match.ref))));
  if (cards.length === 0) return 0;

  const rows = cards.map((card) => ({
    room_id: roomId,
    task_number: card.number,
    message_number: message.number,
    key: detected.find((match) => match.ref === card.external_ref)?.key ?? card.external_ref!,
  }));
  await executor.insert(task_mentions).values(rows).onConflictDoNothing();
  return rows.length;
}

export interface TaskMention {
  message_id: string;
  thread_root_id: string;
  key: string;
  sender: string;
  text: string;
  timestamp: string;
}

const MENTION_TEXT_PREVIEW_CHARS = 280;

/**
 * Newest first. Each entry names its thread root so the UI can open the thread.
 * Rental tags are set after a message is written, so restricted messages are
 * filtered here, at read time, as room search filters hidden prompts.
 */
export async function getTaskMentions(
  roomId: string,
  taskId: string,
  options?: { limit?: number },
  executor: ReadExecutor = db,
): Promise<TaskMention[]> {
  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) return [];
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const rows = await executor
    .select({
      message_number: task_mentions.message_number,
      key: task_mentions.key,
      sender: messages.sender,
      text: messages.text,
      display_text: messages.display_text,
      thread_root_number: messages.thread_root_number,
      timestamp: messages.timestamp,
    })
    .from(task_mentions)
    .innerJoin(messages, and(
      eq(messages.room_id, task_mentions.room_id),
      eq(messages.number, task_mentions.message_number),
    ))
    .where(and(
      eq(task_mentions.room_id, roomId),
      eq(task_mentions.task_number, taskNumber),
      visibleMessageCondition(),
      or(isNull(messages.visibility), eq(messages.visibility, "rental_visible")),
    ))
    .orderBy(desc(task_mentions.message_number), asc(task_mentions.key))
    .limit(limit);
  return rows.map((row) => {
    const text = row.display_text ?? row.text;
    return {
      message_id: formatMessageId(row.message_number),
      thread_root_id: formatMessageId(row.thread_root_number ?? row.message_number),
      key: row.key,
      sender: row.sender,
      text: text.length > MENTION_TEXT_PREVIEW_CHARS ? `${text.slice(0, MENTION_TEXT_PREVIEW_CHARS)}…` : text,
      timestamp: row.timestamp,
    };
  });
}
