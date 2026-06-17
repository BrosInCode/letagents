import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { localChatDatabasePath } from "../../chat-storage/settings.js";
import type { RoomMessageAttachmentPayload } from "../../attachments/mappers.js";
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

type LocalAttachmentRow = {
  attachment_id: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  download_url: string | null;
  data_url: string | null;
  content_base64: string | null;
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
  attachments?: RoomMessageAttachmentPayload[];
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
      CREATE TABLE IF NOT EXISTS local_chat_attachments (
        room_id TEXT NOT NULL,
        message_number INTEGER NOT NULL,
        attachment_id TEXT NOT NULL,
        file_name TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        url TEXT,
        download_url TEXT,
        data_url TEXT,
        content_base64 TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, message_number, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS local_chat_attachments_message_idx
        ON local_chat_attachments (room_id, message_number);
    `);
    addColumnIfMissing(db, "local_chat_messages", "sync_key", "TEXT");
    addColumnIfMissing(db, "local_chat_messages", "sync_started_at", "TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS local_chat_messages_sync_key_idx
        ON local_chat_messages (room_id, sync_key)
        WHERE sync_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS local_chat_messages_cloud_id_idx
        ON local_chat_messages (room_id, synced_cloud_id)
        WHERE synced_cloud_id IS NOT NULL;
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

function mapAttachmentRow(row: Record<string, unknown>): LocalAttachmentRow {
  return {
    attachment_id: String(row.attachment_id || ""),
    file_name: typeof row.file_name === "string" ? row.file_name : null,
    mime_type: typeof row.mime_type === "string" ? row.mime_type : null,
    size_bytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    url: typeof row.url === "string" ? row.url : null,
    download_url: typeof row.download_url === "string" ? row.download_url : null,
    data_url: typeof row.data_url === "string" ? row.data_url : null,
    content_base64:
      typeof row.content_base64 === "string" ? row.content_base64 : null,
  };
}

function normalizeAttachmentPayload(
  attachment: RoomMessageAttachmentPayload,
): LocalAttachmentRow {
  return {
    attachment_id: attachment.id || randomUUID(),
    file_name: attachment.file_name || attachment.filename || attachment.name || null,
    mime_type: attachment.mime_type || attachment.content_type || null,
    size_bytes: attachment.size_bytes ?? attachment.byte_size ?? null,
    url: attachment.url || null,
    download_url: attachment.download_url || attachment.url || null,
    data_url: attachment.data_url || null,
    content_base64: attachment.content_base64 || null,
  };
}

function toMessagePayload(
  row: LocalMessageRow,
  replyTo?: LocalMessageRow | null,
  attachments: LocalAttachmentRow[] = [],
): RoomMessagePayload {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    attachments: attachments.map((attachment) => ({
      id: attachment.attachment_id,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      url: attachment.url,
      download_url: attachment.download_url,
      data_url: attachment.data_url,
      content_base64: attachment.content_base64,
    })),
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
  const attachmentsByMessageNumber = new Map<number, LocalAttachmentRow[]>();
  for (const number of replyNumbers) {
    const reply = database
      .prepare("SELECT * FROM local_chat_messages WHERE room_id = ? AND number = ?")
      .get(roomId, number);
    if (reply) {
      const mapped = mapRow(reply);
      replies.set(mapped.number, mapped);
    }
  }

  const messageNumbers = rows.map((row) => row.number);
  for (const number of messageNumbers) {
    const attachments = database
      .prepare(`
        SELECT *
        FROM local_chat_attachments
        WHERE room_id = ? AND message_number = ?
        ORDER BY created_at ASC
      `)
      .all(roomId, number)
      .map(mapAttachmentRow);
    attachmentsByMessageNumber.set(number, attachments);
  }

  return rows.map((row) => toMessagePayload(
    row,
    row.reply_to_number ? replies.get(row.reply_to_number) ?? null : null,
    attachmentsByMessageNumber.get(row.number) || [],
  ));
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
  const attachmentRows = (input.attachments || []).map(normalizeAttachmentPayload);
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
    for (const attachment of attachmentRows) {
      database
        .prepare(`
          INSERT INTO local_chat_attachments (
            room_id, message_number, attachment_id, file_name, mime_type, size_bytes,
            url, download_url, data_url, content_base64, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          row.room_id,
          row.number,
          attachment.attachment_id,
          attachment.file_name,
          attachment.mime_type,
          attachment.size_bytes,
          attachment.url || null,
          attachment.download_url || attachment.url || null,
          attachment.data_url || null,
          attachment.content_base64 || null,
          row.timestamp,
        );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }

  return toMessagePayload(row, replyTarget, attachmentRows);
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

export async function searchLocalChatMessages(
  roomId: string,
  query: string,
  options?: { limit?: number; include_prompt_only?: boolean },
): Promise<LocalMessagePage> {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return getLatestLocalChatMessages(roomId, options);
  }

  const limit = clampLimit(options?.limit);
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
        AND (
          LOWER(text) LIKE ?
          OR LOWER(sender) LIKE ?
        )
      ORDER BY number DESC
      LIMIT ?
    `)
    .all(roomId, `%${trimmedQuery}%`, `%${trimmedQuery}%`, limit + 1)
    .map(mapRow);
  const hasMore = rows.length > limit;
  const bounded = (hasMore ? rows.slice(0, limit) : rows).reverse();
  return {
    messages: await hydrateMessageRows(database, bounded),
    has_more: hasMore,
  };
}

export async function getLocalChatThreadMessages(
  roomId: string,
  rootMessageId: string,
  options?: { limit?: number; include_prompt_only?: boolean },
): Promise<LocalMessagePage> {
  const rootNumber = parseMessageNumber(rootMessageId);
  if (!rootNumber) {
    return { messages: [], has_more: false };
  }

  const limit = clampLimit(options?.limit);
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
        AND (number = ? OR reply_to_number = ?)
      ORDER BY number ASC
      LIMIT ?
    `)
    .all(roomId, rootNumber, rootNumber, limit + 1)
    .map(mapRow);
  const hasMore = rows.length > limit;
  const bounded = hasMore ? rows.slice(0, limit) : rows;
  return {
    messages: await hydrateMessageRows(database, bounded),
    has_more: hasMore,
  };
}

export async function getLocalChatMessagesAround(
  roomId: string,
  messageId: string,
  options?: {
    before?: number;
    after?: number;
    include_prompt_only?: boolean;
  },
): Promise<LocalMessagePage> {
  const anchorNumber = parseMessageNumber(messageId);
  if (!anchorNumber) {
    return { messages: [], has_more: false };
  }

  const before = Math.max(0, Math.min(50, Math.floor(Number(options?.before ?? 10))));
  const after = Math.max(0, Math.min(50, Math.floor(Number(options?.after ?? 10))));
  const lower = Math.max(1, anchorNumber - before);
  const upper = anchorNumber + after;
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
        AND number >= ?
        AND number <= ?
      ORDER BY number ASC
    `)
    .all(roomId, lower, upper)
    .map(mapRow);
  return {
    messages: await hydrateMessageRows(database, rows),
    has_more: false,
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

export async function importLocalChatMessages(
  roomId: string,
  messages: RoomMessagePayload[],
): Promise<void> {
  const trimmedRoomId = roomId.trim();
  if (!trimmedRoomId || messages.length === 0) return;
  const database = await getDb();
  const sortedMessages = [...messages].sort(
    (left, right) =>
      Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
  );
  const cloudIdToNumber = new Map<string, number>();
  const existingRows = database
    .prepare(`
      SELECT number, synced_cloud_id
      FROM local_chat_messages
      WHERE room_id = ? AND synced_cloud_id IS NOT NULL
    `)
    .all(trimmedRoomId);
  for (const row of existingRows) {
    if (typeof row.synced_cloud_id === "string") {
      cloudIdToNumber.set(row.synced_cloud_id, Number(row.number || 0));
    }
  }

  beginImmediate(database);
  try {
    for (const message of sortedMessages) {
      if (!message.id || cloudIdToNumber.has(message.id)) continue;
      const number = allocateLocalMessageNumber(database, trimmedRoomId);
      cloudIdToNumber.set(message.id, number);
      const replyCloudId =
        typeof message.reply_to?.id === "string" ? message.reply_to.id : null;
      const replyNumber = replyCloudId
        ? cloudIdToNumber.get(replyCloudId) || null
        : null;
      database
        .prepare(`
          INSERT INTO local_chat_messages (
            room_id, number, reply_to_number, sender, text, agent_prompt_kind, source,
            timestamp, synced_cloud_id, synced_at, sync_key, sync_started_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(room_id, number) DO NOTHING
        `)
        .run(
          trimmedRoomId,
          number,
          replyNumber,
          message.sender || "unknown",
          message.text || "",
          message.agent_prompt_kind || null,
          message.source || null,
          message.timestamp || new Date().toISOString(),
          message.id,
          new Date().toISOString(),
        );
      for (const attachment of message.attachments || []) {
        database
          .prepare(`
            INSERT INTO local_chat_attachments (
              room_id, message_number, attachment_id, file_name, mime_type, size_bytes,
              url, download_url, data_url, content_base64, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(room_id, message_number, attachment_id) DO NOTHING
          `)
          .run(
            trimmedRoomId,
            number,
            attachment.id || randomUUID(),
            attachment.file_name || attachment.filename || attachment.name || null,
            attachment.mime_type || attachment.content_type || null,
            attachment.size_bytes ?? attachment.byte_size ?? null,
            attachment.url || null,
            attachment.download_url || attachment.url || null,
            attachment.data_url || null,
            attachment.content_base64 || null,
            message.timestamp || new Date().toISOString(),
          );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
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
