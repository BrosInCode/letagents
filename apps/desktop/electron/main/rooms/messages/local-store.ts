import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { localChatDatabasePath } from "../../chat-storage/settings.js";
import type { RoomMessagePayload } from "./mappers.js";

type SqliteStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => unknown;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

type LocalMessageRow = {
  room_id: string;
  number: number;
  reply_to_number: number | null;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  timestamp: string;
  synced_cloud_id: string | null;
  synced_at: string | null;
  sync_key: string | null;
  sync_started_at: string | null;
};

export type LocalMessagePage = {
  messages: RoomMessagePayload[];
  has_more: boolean;
};

export type LocalChatMessageInput = {
  sender: string;
  text: string;
  source?: string | null;
  agent_prompt_kind?: string | null;
  reply_to?: string | null;
};

export type LocalSyncMessagePayload = RoomMessagePayload & {
  sync_key: string;
};

const require = createRequire(import.meta.url);
let db: SqliteDatabase | null = null;
let initialized = false;

function formatMessageId(number: number): string {
  return `msg_${number}`;
}

function parseMessageNumber(messageId?: string | null): number | null {
  if (!messageId) return null;
  const match = /^msg_(\d+)$/.exec(messageId.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 150;
  return Math.max(1, Math.min(500, Math.floor(Number(limit))));
}

async function getDb(): Promise<SqliteDatabase> {
  if (db) return db;
  await mkdir(dirname(localChatDatabasePath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  db = new DatabaseSync(localChatDatabasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!initialized) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_chat_room_sequences (
        room_id TEXT PRIMARY KEY,
        next_number INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_chat_messages (
        room_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        reply_to_number INTEGER,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        agent_prompt_kind TEXT,
        source TEXT,
        timestamp TEXT NOT NULL,
        synced_cloud_id TEXT,
        synced_at TEXT,
        sync_key TEXT,
        sync_started_at TEXT,
        PRIMARY KEY (room_id, number)
      );
      CREATE INDEX IF NOT EXISTS local_chat_messages_room_time_idx
        ON local_chat_messages (room_id, timestamp);
      CREATE INDEX IF NOT EXISTS local_chat_messages_sync_idx
        ON local_chat_messages (room_id, synced_cloud_id);
    `);
    addColumnIfMissing(db, "local_chat_messages", "sync_key", "TEXT");
    addColumnIfMissing(db, "local_chat_messages", "sync_started_at", "TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS local_chat_messages_sync_key_idx
        ON local_chat_messages (room_id, sync_key)
        WHERE sync_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS local_chat_messages_sync_started_idx
        ON local_chat_messages (room_id, sync_started_at);
    `);
    initialized = true;
  }
  return db;
}

function addColumnIfMissing(
  database: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  try {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

function mapRow(row: Record<string, unknown>): LocalMessageRow {
  return {
    room_id: String(row.room_id || ""),
    number: Number(row.number || 0),
    reply_to_number:
      row.reply_to_number === null || row.reply_to_number === undefined
        ? null
        : Number(row.reply_to_number),
    sender: String(row.sender || ""),
    text: String(row.text || ""),
    agent_prompt_kind:
      typeof row.agent_prompt_kind === "string" ? row.agent_prompt_kind : null,
    source: typeof row.source === "string" ? row.source : null,
    timestamp: String(row.timestamp || ""),
    synced_cloud_id:
      typeof row.synced_cloud_id === "string" ? row.synced_cloud_id : null,
    synced_at: typeof row.synced_at === "string" ? row.synced_at : null,
    sync_key: typeof row.sync_key === "string" ? row.sync_key : null,
    sync_started_at:
      typeof row.sync_started_at === "string" ? row.sync_started_at : null,
  };
}

function toMessagePayload(
  row: LocalMessageRow,
  replyTo?: LocalMessageRow | null,
): RoomMessagePayload {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    attachments: [],
    agent_prompt_kind: row.agent_prompt_kind,
    source: row.source,
    timestamp: row.timestamp,
    reply_to: replyTo
      ? {
          id: formatMessageId(replyTo.number),
          sender: replyTo.sender,
          text: replyTo.text,
          source: replyTo.source,
          timestamp: replyTo.timestamp,
        }
      : null,
  };
}

function visibleMessageClause(includePromptOnly?: boolean): string {
  return includePromptOnly
    ? "1 = 1"
    : "NOT (agent_prompt_kind = 'auto' AND TRIM(text) = '')";
}

async function hydrateMessageRows(
  database: SqliteDatabase,
  rows: LocalMessageRow[],
): Promise<RoomMessagePayload[]> {
  if (rows.length === 0) return [];

  const roomId = rows[0]?.room_id || "";
  const replyNumbers = [
    ...new Set(
      rows
        .map((row) => row.reply_to_number)
        .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0),
    ),
  ];
  const replies = new Map<number, LocalMessageRow>();
  for (const number of replyNumbers) {
    const reply = database
      .prepare("SELECT * FROM local_chat_messages WHERE room_id = ? AND number = ?")
      .get(roomId, number);
    if (reply) {
      const mapped = mapRow(reply);
      replies.set(mapped.number, mapped);
    }
  }

  return rows.map((row) => toMessagePayload(row, row.reply_to_number ? replies.get(row.reply_to_number) ?? null : null));
}

function syncKeyForMessage(roomId: string, number: number): string {
  return `local-chat:${roomId}:${number}`;
}

function beginImmediate(database: SqliteDatabase): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollback(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may already be closed by SQLite after an error.
  }
}

function allocateLocalMessageNumber(database: SqliteDatabase, roomId: string): number {
  database
    .prepare(`
      INSERT INTO local_chat_room_sequences (room_id, next_number)
      SELECT ?, COALESCE(MAX(number), 0) + 1
      FROM local_chat_messages
      WHERE room_id = ?
      ON CONFLICT(room_id) DO NOTHING
    `)
    .run(roomId, roomId);
  const row = database
    .prepare("SELECT next_number FROM local_chat_room_sequences WHERE room_id = ?")
    .get(roomId);
  const number = Number(row?.next_number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Local chat message sequence could not be allocated.");
  }
  database
    .prepare("UPDATE local_chat_room_sequences SET next_number = next_number + 1 WHERE room_id = ?")
    .run(roomId);
  return number;
}

export async function addLocalChatMessage(
  roomId: string,
  input: LocalChatMessageInput,
): Promise<RoomMessagePayload> {
  const trimmedRoomId = roomId.trim();
  const sender = input.sender.trim();
  const text = input.text;
  if (!trimmedRoomId) throw new Error("Choose a room before sending a message.");
  if (!sender) throw new Error("Message sender is required.");

  const database = await getDb();
  const replyToNumber = parseMessageNumber(input.reply_to);
  let replyTarget: LocalMessageRow | null = null;
  if (input.reply_to && !replyToNumber) {
    throw new Error("reply_to must be a valid local message id.");
  }
  if (replyToNumber) {
    const replyRow = database
      .prepare("SELECT * FROM local_chat_messages WHERE room_id = ? AND number = ?")
      .get(trimmedRoomId, replyToNumber);
    if (!replyRow) {
      throw new Error("reply_to must reference an existing local message in this room.");
    }
    replyTarget = mapRow(replyRow);
  }

  const timestamp = new Date().toISOString();
  let row: LocalMessageRow;
  beginImmediate(database);
  try {
    const number = allocateLocalMessageNumber(database, trimmedRoomId);
    row = {
      room_id: trimmedRoomId,
      number,
      reply_to_number: replyToNumber,
      sender,
      text,
      agent_prompt_kind: input.agent_prompt_kind || null,
      source: input.source || null,
      timestamp,
      synced_cloud_id: null,
      synced_at: null,
      sync_key: null,
      sync_started_at: null,
    };

    database
      .prepare(`
        INSERT INTO local_chat_messages (
          room_id, number, reply_to_number, sender, text, agent_prompt_kind, source,
          timestamp, synced_cloud_id, synced_at, sync_key, sync_started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `)
      .run(
        row.room_id,
        row.number,
        row.reply_to_number,
        row.sender,
        row.text,
        row.agent_prompt_kind,
        row.source,
        row.timestamp,
      );
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }

  return toMessagePayload(row, replyTarget);
}

export async function getLocalChatMessages(
  roomId: string,
  options?: {
    limit?: number;
    after?: string | null;
    include_prompt_only?: boolean;
  },
): Promise<LocalMessagePage> {
  const limit = clampLimit(options?.limit);
  const afterNumber = parseMessageNumber(options?.after);
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${afterNumber ? "number > ?" : "1 = 1"}
        AND ${visibleMessageClause(options?.include_prompt_only)}
      ORDER BY number ASC
      LIMIT ?
    `)
    .all(...(afterNumber ? [roomId, afterNumber, limit + 1] : [roomId, limit + 1]))
    .map(mapRow);
  const hasMore = rows.length > limit;
  const bounded = hasMore ? rows.slice(0, limit) : rows;
  return {
    messages: await hydrateMessageRows(database, bounded),
    has_more: hasMore,
  };
}

export async function getLatestLocalChatMessages(
  roomId: string,
  options?: { limit?: number; include_prompt_only?: boolean },
): Promise<LocalMessagePage> {
  const limit = clampLimit(options?.limit);
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
      ORDER BY number DESC
      LIMIT ?
    `)
    .all(roomId, limit + 1)
    .map(mapRow);
  const hasMore = rows.length > limit;
  const bounded = (hasMore ? rows.slice(0, limit) : rows).reverse();
  return {
    messages: await hydrateMessageRows(database, bounded),
    has_more: hasMore,
  };
}

export async function getLocalChatMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean },
): Promise<LocalMessagePage> {
  const beforeNumber = parseMessageNumber(beforeMessageId);
  if (!beforeNumber) return getLatestLocalChatMessages(roomId, options);

  const limit = clampLimit(options?.limit);
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND number < ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
      ORDER BY number DESC
      LIMIT ?
    `)
    .all(roomId, beforeNumber, limit + 1)
    .map(mapRow);
  const hasMore = rows.length > limit;
  const bounded = (hasMore ? rows.slice(0, limit) : rows).reverse();
  return {
    messages: await hydrateMessageRows(database, bounded),
    has_more: hasMore,
  };
}

function staleSyncStartedAt(): string {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString();
}

export async function claimUnsyncedLocalChatMessages(
  roomId: string,
): Promise<LocalSyncMessagePayload[]> {
  const database = await getDb();
  const syncStartedAt = `${new Date().toISOString()}#${randomUUID()}`;
  beginImmediate(database);
  try {
    const candidates = database
      .prepare(`
        SELECT number
        FROM local_chat_messages
        WHERE room_id = ?
          AND synced_cloud_id IS NULL
          AND NOT (agent_prompt_kind = 'auto' AND TRIM(text) = '')
          AND (sync_started_at IS NULL OR sync_started_at < ?)
        ORDER BY number ASC
      `)
      .all(roomId, staleSyncStartedAt());
    for (const candidate of candidates) {
      const number = Number(candidate.number || 0);
      if (!Number.isInteger(number) || number <= 0) continue;
      database
        .prepare(`
          UPDATE local_chat_messages
          SET sync_key = COALESCE(sync_key, ?),
              sync_started_at = ?
          WHERE room_id = ?
            AND number = ?
            AND synced_cloud_id IS NULL
        `)
        .run(syncKeyForMessage(roomId, number), syncStartedAt, roomId, number);
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }

  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND synced_cloud_id IS NULL
        AND sync_started_at = ?
        AND sync_key IS NOT NULL
        AND NOT (agent_prompt_kind = 'auto' AND TRIM(text) = '')
      ORDER BY number ASC
    `)
    .all(roomId, syncStartedAt)
    .map(mapRow);
  const hydrated = await hydrateMessageRows(database, rows);
  return hydrated.map((message, index) => {
    const syncKey = rows[index]?.sync_key;
    if (!syncKey) {
      throw new Error("Claimed local message is missing its sync key.");
    }
    return {
      ...message,
      sync_key: syncKey,
    };
  });
}

export async function markLocalChatMessageSynced(input: {
  roomId: string;
  localMessageId: string;
  cloudMessageId: string;
}): Promise<void> {
  const localNumber = parseMessageNumber(input.localMessageId);
  if (!localNumber || !input.cloudMessageId.trim()) return;
  const database = await getDb();
  database
    .prepare(`
      UPDATE local_chat_messages
      SET synced_cloud_id = ?, synced_at = ?, sync_started_at = NULL
      WHERE room_id = ? AND number = ?
    `)
    .run(input.cloudMessageId, new Date().toISOString(), input.roomId, localNumber);
}

export async function getSyncedCloudMessageId(input: {
  roomId: string;
  localMessageId: string;
}): Promise<string | null> {
  const localNumber = parseMessageNumber(input.localMessageId);
  if (!localNumber) return null;
  const database = await getDb();
  const row = database
    .prepare(`
      SELECT synced_cloud_id
      FROM local_chat_messages
      WHERE room_id = ? AND number = ?
    `)
    .get(input.roomId, localNumber);
  return typeof row?.synced_cloud_id === "string" ? row.synced_cloud_id : null;
}
