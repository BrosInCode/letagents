import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LocalChatMessage = {
  id: string;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  timestamp: string;
  attachments: [];
  reply_to: {
    id: string;
    sender: string;
    text: string;
    source: string | null;
    timestamp: string;
  } | null;
};

export type LocalChatMessagePage = {
  messages: LocalChatMessage[];
  has_more: boolean;
  room_id: string;
};

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
  sync_key: string | null;
  sync_started_at: string | null;
};

type LocalChatInput = {
  sender: string;
  text: string;
  source?: string | null;
  agent_prompt_kind?: string | null;
  reply_to?: string | null;
};

const require = createRequire(import.meta.url);
const chatStorageSettingsPath =
  process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH?.trim() ||
  join(homedir(), ".letagents", "chat-storage.json");
const localChatDatabasePath =
  process.env.LETAGENTS_LOCAL_CHAT_DB?.trim() ||
  join(homedir(), ".letagents", "local-chat.sqlite");
let db: SqliteDatabase | null = null;

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
    sync_key: typeof row.sync_key === "string" ? row.sync_key : null,
    sync_started_at:
      typeof row.sync_started_at === "string" ? row.sync_started_at : null,
  };
}

function visibleMessageClause(includePromptOnly?: boolean): string {
  return includePromptOnly
    ? "1 = 1"
    : "NOT (agent_prompt_kind = 'auto' AND TRIM(text) = '')";
}

function toMessage(row: LocalMessageRow, replyTo?: LocalMessageRow | null): LocalChatMessage {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    agent_prompt_kind: row.agent_prompt_kind,
    source: row.source,
    timestamp: row.timestamp,
    attachments: [],
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

async function hydrateRows(
  database: SqliteDatabase,
  rows: LocalMessageRow[],
): Promise<LocalChatMessage[]> {
  if (rows.length === 0) return [];
  const roomId = rows[0]?.room_id || "";
  const replies = new Map<number, LocalMessageRow>();
  const replyNumbers = [
    ...new Set(
      rows
        .map((row) => row.reply_to_number)
        .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0),
    ),
  ];

  for (const number of replyNumbers) {
    const reply = database
      .prepare("SELECT * FROM local_chat_messages WHERE room_id = ? AND number = ?")
      .get(roomId, number);
    if (reply) {
      const row = mapRow(reply);
      replies.set(row.number, row);
    }
  }

  return rows.map((row) =>
    toMessage(row, row.reply_to_number ? replies.get(row.reply_to_number) ?? null : null),
  );
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

export async function isLocalChatStorageEnabled(): Promise<boolean> {
  const envMode = process.env.LETAGENTS_CHAT_STORAGE?.trim().toLowerCase();
  if (envMode === "local") return true;
  if (envMode === "cloud") return false;

  try {
    const raw = await readFile(chatStorageSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "local";
  } catch {
    return false;
  }
}

export async function addLocalChatMessage(
  roomId: string,
  input: LocalChatInput,
): Promise<LocalChatMessage & { room_id: string }> {
  const trimmedRoomId = roomId.trim();
  const sender = input.sender.trim();
  if (!trimmedRoomId) throw new Error("No room is available for this request.");
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
      text: input.text,
      agent_prompt_kind: input.agent_prompt_kind || null,
      source: input.source || null,
      timestamp,
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

  return {
    room_id: trimmedRoomId,
    ...toMessage(row, replyTarget),
  };
}

export async function getLocalChatMessages(
  roomId: string,
  options?: {
    limit?: number;
    after?: string | null;
    include_prompt_only?: boolean;
  },
): Promise<LocalChatMessagePage> {
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
    room_id: roomId,
    messages: await hydrateRows(database, bounded),
    has_more: hasMore,
  };
}

export async function waitForLocalChatMessages(
  roomId: string,
  options: {
    after?: string | null;
    timeoutMs: number;
    limit?: number;
    include_prompt_only?: boolean;
  },
): Promise<LocalChatMessagePage> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  for (;;) {
    const page = await getLocalChatMessages(roomId, {
      after: options.after,
      limit: options.limit,
      include_prompt_only: options.include_prompt_only,
    });
    if (page.messages.length > 0 || Date.now() >= deadline) {
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  }
}
