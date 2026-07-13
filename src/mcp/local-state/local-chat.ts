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
  attachments: LocalChatAttachment[];
  thread_root_id: string;
  thread_reply_to_id: string | null;
  reply_to: {
    id: string;
    sender: string;
    text: string;
    source: string | null;
    timestamp: string;
  } | null;
};

export type LocalChatAttachment = {
  id: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  download_url: string | null;
  data_url: string | null;
  content_base64: string | null;
};

export type LocalChatMessagePage = {
  messages: LocalChatMessage[];
  has_more: boolean;
  room_id: string;
};

export type LocalTask = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assignee_agent_key: string | null;
  assignee_agent_instance_id: string | null;
  assignee_agent_session_id: string | null;
  created_by: string | null;
  pr_url: string | null;
  workflow_artifacts: Array<Record<string, unknown>>;
  workflow_refs: Array<Record<string, unknown>>;
  active_leases?: Array<{
    id: string;
    kind: "review" | string;
    holder_label: string | null;
    agent_key: string | null;
    agent_session_id: string | null;
    status: string;
    updated_at: string | null;
  }>;
  created_at: string;
  updated_at: string;
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
  thread_root_number: number | null;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  timestamp: string;
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

type LocalChatInput = {
  sender: string;
  text: string;
  source?: string | null;
  agent_prompt_kind?: string | null;
  reply_to?: string | null;
  thread_root_id?: string | null;
};

const require = createRequire(import.meta.url);
const chatStorageSettingsPath =
  process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH?.trim() ||
  join(homedir(), ".letagents", "chat-storage.json");
const localChatDatabasePath =
  process.env.LETAGENTS_LOCAL_CHAT_DB?.trim() ||
  join(homedir(), ".letagents", "local-chat.sqlite");
let db: SqliteDatabase | null = null;

const validLocalTaskTransitions: Record<string, string[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "in_review", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["in_progress", "in_review", "cancelled"],
  in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

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
    thread_root_number:
      row.thread_root_number === null || row.thread_root_number === undefined
        ? null
        : Number(row.thread_root_number),
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

function getLocalMessageRow(
  database: SqliteDatabase,
  roomId: string,
  number: number,
): LocalMessageRow | null {
  const row = database
    .prepare("SELECT * FROM local_chat_messages WHERE room_id = ? AND number = ?")
    .get(roomId, number);
  return row ? mapRow(row) : null;
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

function visibleMessageClause(includePromptOnly?: boolean): string {
  return includePromptOnly
    ? "1 = 1"
    : "(agent_prompt_kind IS NULL OR agent_prompt_kind <> 'auto' OR TRIM(text) <> '')";
}

function toMessage(
  row: LocalMessageRow,
  replyTo?: LocalMessageRow | null,
  attachments: LocalAttachmentRow[] = [],
): LocalChatMessage {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    agent_prompt_kind: row.agent_prompt_kind,
    source: row.source,
    timestamp: row.timestamp,
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
    thread_root_id: formatMessageId(row.thread_root_number ?? row.number),
    thread_reply_to_id: row.reply_to_number ? formatMessageId(row.reply_to_number) : null,
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
      thread_root_number INTEGER,
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
    CREATE TABLE IF NOT EXISTS local_rooms (
      room_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      cloud_room_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      archived_at TEXT,
      pinned_at TEXT
    );
    CREATE TABLE IF NOT EXISTS local_task_room_sequences (
      room_id TEXT PRIMARY KEY,
      next_number INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_tasks (
      room_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      assignee TEXT,
      assignee_agent_key TEXT,
      assignee_agent_instance_id TEXT,
      assignee_agent_session_id TEXT,
      created_by TEXT,
      pr_url TEXT,
      workflow_artifacts_json TEXT,
      workflow_refs_json TEXT,
      synced_cloud_id TEXT,
      sync_key TEXT,
      sync_started_at TEXT,
      sync_dirty INTEGER NOT NULL DEFAULT 0,
      review_lease_id TEXT,
      review_holder_label TEXT,
      review_agent_key TEXT,
      review_agent_session_id TEXT,
      review_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (room_id, task_id)
    );
  `);
  addColumnIfMissing(db, "local_chat_messages", "sync_key", "TEXT");
  addColumnIfMissing(db, "local_chat_messages", "sync_started_at", "TEXT");
  addColumnIfMissing(db, "local_chat_messages", "thread_root_number", "INTEGER");
  addColumnIfMissing(db, "local_rooms", "pinned_at", "TEXT");
  addColumnIfMissing(db, "local_tasks", "assignee_agent_key", "TEXT");
  addColumnIfMissing(db, "local_tasks", "assignee_agent_instance_id", "TEXT");
  addColumnIfMissing(db, "local_tasks", "assignee_agent_session_id", "TEXT");
  addColumnIfMissing(db, "local_tasks", "workflow_artifacts_json", "TEXT");
  addColumnIfMissing(db, "local_tasks", "workflow_refs_json", "TEXT");
  addColumnIfMissing(db, "local_tasks", "sync_started_at", "TEXT");
  addColumnIfMissing(db, "local_tasks", "sync_dirty", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "local_tasks", "review_lease_id", "TEXT");
  addColumnIfMissing(db, "local_tasks", "review_holder_label", "TEXT");
  addColumnIfMissing(db, "local_tasks", "review_agent_key", "TEXT");
  addColumnIfMissing(db, "local_tasks", "review_agent_session_id", "TEXT");
  addColumnIfMissing(db, "local_tasks", "review_updated_at", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS local_chat_messages_sync_key_idx
      ON local_chat_messages (room_id, sync_key)
      WHERE sync_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS local_chat_messages_sync_started_idx
      ON local_chat_messages (room_id, sync_started_at);
    CREATE INDEX IF NOT EXISTS local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
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

function resolveLocalTaskStatus(fromStatus: string, toStatus?: unknown): string {
  if (typeof toStatus !== "string" || !toStatus.trim()) return fromStatus;
  const nextStatus = toStatus.trim();
  if (!validLocalTaskTransitions[fromStatus]?.includes(nextStatus)) {
    throw new Error(
      `Invalid transition: ${fromStatus} -> ${nextStatus}. ` +
        `Allowed: ${validLocalTaskTransitions[fromStatus]?.join(", ") || "none"}`,
    );
  }
  return nextStatus;
}

async function hydrateRows(
  database: SqliteDatabase,
  rows: LocalMessageRow[],
): Promise<LocalChatMessage[]> {
  if (rows.length === 0) return [];
  const roomId = rows[0]?.room_id || "";
  const replies = new Map<number, LocalMessageRow>();
  const attachmentsByMessageNumber = new Map<number, LocalAttachmentRow[]>();
  const replyNumbers = [
    ...new Set(
      rows
        .map((row) => row.reply_to_number)
        .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0),
    ),
  ];

  for (const number of replyNumbers) {
    const reply = getLocalMessageRow(database, roomId, number);
    if (reply) {
      replies.set(reply.number, reply);
    }
  }

  for (const number of rows.map((row) => row.number)) {
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

  return rows.map((row) =>
    toMessage(
      row,
      row.reply_to_number ? replies.get(row.reply_to_number) ?? null : null,
      attachmentsByMessageNumber.get(row.number) || [],
    ),
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

export async function isLocalRoomStorageEnabled(
  roomId?: string | null,
): Promise<boolean> {
  const envMode = process.env.LETAGENTS_CHAT_STORAGE?.trim().toLowerCase();
  if (envMode === "local") return true;
  if (envMode === "cloud") return false;

  const normalizedRoomId = roomId?.trim() || "";
  let localRoom: Record<string, unknown> | undefined;
  if (normalizedRoomId) {
    try {
      const database = await getDb();
      localRoom = database
        .prepare("SELECT room_id, cloud_room_id FROM local_rooms WHERE (room_id = ? OR cloud_room_id = ?) AND archived_at IS NULL LIMIT 1")
        .get(normalizedRoomId, normalizedRoomId);
    } catch {
      localRoom = undefined;
    }
  }

  try {
    const raw = await readFile(chatStorageSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      mode?: unknown;
      defaultMode?: unknown;
      roomOverrides?: Record<string, unknown>;
    };
    const overrideKeys = [
      normalizedRoomId,
      typeof localRoom?.cloud_room_id === "string" ? localRoom.cloud_room_id : "",
      typeof localRoom?.room_id === "string" ? localRoom.room_id : "",
    ].filter((value, index, values): value is string =>
      Boolean(value && values.indexOf(value) === index)
    );
    const override = parsed.roomOverrides
      ? overrideKeys
        .map((key) => parsed.roomOverrides?.[key])
        .find((value) => value === "local" || value === "cloud")
      : null;
    if (override === "local") return true;
    if (override === "cloud") {
      const localOnlyRoom = Boolean(localRoom && !localRoom.cloud_room_id);
      return localOnlyRoom;
    }
    const requestedLocalRoom = Boolean(
      normalizedRoomId &&
        typeof localRoom?.room_id === "string" &&
        localRoom.room_id === normalizedRoomId,
    );
    const localOnlyRoom = Boolean(localRoom && !localRoom.cloud_room_id);
    if (localOnlyRoom || requestedLocalRoom) return true;
    return (parsed.defaultMode ?? parsed.mode) === "local";
  } catch {
    const requestedLocalRoom = Boolean(
      normalizedRoomId &&
        typeof localRoom?.room_id === "string" &&
        localRoom.room_id === normalizedRoomId,
    );
    const localOnlyRoom = Boolean(localRoom && !localRoom.cloud_room_id);
    return localOnlyRoom || requestedLocalRoom;
  }
}

export async function resolveLocalRoomStorageIdentifiers(
  roomId?: string | null,
): Promise<{ localRoomId: string | null; cloudRoomId: string | null }> {
  const normalizedRoomId = roomId?.trim() || "";
  if (!normalizedRoomId) return { localRoomId: null, cloudRoomId: null };
  try {
    const database = await getDb();
    const row = database
      .prepare(`
        SELECT room_id, cloud_room_id
        FROM local_rooms
        WHERE (room_id = ? OR cloud_room_id = ?) AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(normalizedRoomId, normalizedRoomId);
    return {
      localRoomId:
        typeof row?.room_id === "string" && row.room_id.trim()
          ? row.room_id
          : normalizedRoomId,
      cloudRoomId:
        typeof row?.cloud_room_id === "string" && row.cloud_room_id.trim()
          ? row.cloud_room_id
          : normalizedRoomId,
    };
  } catch {
    return { localRoomId: normalizedRoomId, cloudRoomId: normalizedRoomId };
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
  const explicitThreadRootNumber = parseMessageNumber(input.thread_root_id);
  let replyTarget: LocalMessageRow | null = null;
  if (input.reply_to && !replyToNumber) {
    throw new Error("reply_to must be a valid local message id.");
  }
  if (input.thread_root_id && !explicitThreadRootNumber) {
    throw new Error("thread_root_id must be a valid local message id.");
  }
  let replyTargetRootNumber: number | null = null;
  if (replyToNumber) {
    replyTarget = getLocalMessageRow(database, trimmedRoomId, replyToNumber);
    if (!replyTarget) {
      throw new Error("reply_to must reference an existing local message in this room.");
    }
    replyTargetRootNumber = replyTarget.thread_root_number ?? replyTarget.number;
  }
  let threadRootNumber = explicitThreadRootNumber;
  if (explicitThreadRootNumber) {
    const rootTarget = getLocalMessageRow(database, trimmedRoomId, explicitThreadRootNumber);
    if (!rootTarget) {
      throw new Error("thread_root_id must reference an existing local message in this room.");
    }
    threadRootNumber = rootTarget.thread_root_number ?? rootTarget.number;
    if (replyTargetRootNumber && replyTargetRootNumber !== threadRootNumber) {
      throw new Error("reply_to must belong to the requested local thread.");
    }
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
      thread_root_number: threadRootNumber,
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
          room_id, number, reply_to_number, thread_root_number, sender, text, agent_prompt_kind, source,
          timestamp, synced_cloud_id, synced_at, sync_key, sync_started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `)
      .run(
        row.room_id,
        row.number,
        row.reply_to_number,
        row.thread_root_number,
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

export async function getLatestLocalChatMessages(
  roomId: string,
  options?: {
    limit?: number;
    include_prompt_only?: boolean;
  },
): Promise<LocalChatMessagePage> {
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

function allocateLocalTaskId(database: SqliteDatabase, roomId: string): string {
  database
    .prepare(`
      INSERT INTO local_task_room_sequences (room_id, next_number)
      SELECT ?, COALESCE(MAX(CAST(SUBSTR(task_id, 6) AS INTEGER)), 0) + 1
      FROM local_tasks
      WHERE room_id = ? AND task_id GLOB 'task_[0-9]*'
      ON CONFLICT(room_id) DO NOTHING
    `)
    .run(roomId, roomId);
  const row = database
    .prepare("SELECT next_number FROM local_task_room_sequences WHERE room_id = ?")
    .get(roomId);
  const number = Number(row?.next_number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Local task sequence could not be allocated.");
  }
  database
    .prepare("UPDATE local_task_room_sequences SET next_number = next_number + 1 WHERE room_id = ?")
    .run(roomId);
  return `task_${number}`;
}

function mapTaskRow(row: Record<string, unknown>): LocalTask {
  const reviewLeaseId =
    typeof row.review_lease_id === "string" && row.review_lease_id.trim()
      ? row.review_lease_id
      : null;
  return {
    id: String(row.task_id || ""),
    title: String(row.title || ""),
    description: typeof row.description === "string" ? row.description : null,
    status: String(row.status || "proposed"),
    assignee: typeof row.assignee === "string" ? row.assignee : null,
    assignee_agent_key:
      typeof row.assignee_agent_key === "string" ? row.assignee_agent_key : null,
    assignee_agent_instance_id:
      typeof row.assignee_agent_instance_id === "string" ? row.assignee_agent_instance_id : null,
    assignee_agent_session_id:
      typeof row.assignee_agent_session_id === "string" ? row.assignee_agent_session_id : null,
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    pr_url: typeof row.pr_url === "string" ? row.pr_url : null,
    workflow_artifacts: parseJsonArray(row.workflow_artifacts_json, []),
    workflow_refs: parseJsonArray(row.workflow_refs_json, []),
    active_leases: reviewLeaseId
      ? [
          {
            id: reviewLeaseId,
            kind: "review",
            holder_label:
              typeof row.review_holder_label === "string"
                ? row.review_holder_label
                : null,
            agent_key:
              typeof row.review_agent_key === "string"
                ? row.review_agent_key
                : null,
            agent_session_id:
              typeof row.review_agent_session_id === "string"
                ? row.review_agent_session_id
                : null,
            status: "active",
            updated_at:
              typeof row.review_updated_at === "string"
                ? row.review_updated_at
                : null,
          },
        ]
      : [],
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

export async function addLocalTask(
  roomId: string,
  input: {
    title: string;
    description?: string | null;
    created_by?: string | null;
  },
): Promise<LocalTask> {
  const trimmedRoomId = roomId.trim();
  const title = input.title.trim();
  if (!trimmedRoomId) throw new Error("No room is available for this request.");
  if (!title) throw new Error("Task title is required.");
  const database = await getDb();
  const now = new Date().toISOString();
  let taskId = "";
  beginImmediate(database);
  try {
    taskId = allocateLocalTaskId(database, trimmedRoomId);
    database
      .prepare(`
        INSERT INTO local_tasks (
          room_id, task_id, title, description, status, assignee, assignee_agent_key,
          assignee_agent_instance_id, assignee_agent_session_id,
          created_by, pr_url, workflow_artifacts_json, workflow_refs_json,
          synced_cloud_id, sync_key, sync_started_at, sync_dirty, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'proposed', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, 1, ?, ?)
      `)
      .run(
        trimmedRoomId,
        taskId,
        title,
        input.description?.trim() || null,
        input.created_by || "agent",
        `local-task:${trimmedRoomId}:${taskId}`,
        now,
        now,
      );
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
  const task = await getLocalTask(trimmedRoomId, taskId);
  if (!task) throw new Error("Local task could not be created.");
  return task;
}

export async function listLocalTasks(
  roomId: string,
  options: { status?: string | null; openOnly?: boolean } = {},
): Promise<{ tasks: LocalTask[]; has_more: boolean }> {
  const clauses = ["room_id = ?"];
  const params: unknown[] = [roomId];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.openOnly !== false) {
    clauses.push("status NOT IN ('done', 'cancelled')");
  }
  const database = await getDb();
  const tasks = database
    .prepare(`
      SELECT *
      FROM local_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
    `)
    .all(...params)
    .map(mapTaskRow);
  return { tasks, has_more: false };
}

export async function getLocalTask(
  roomId: string,
  taskId: string,
): Promise<LocalTask | null> {
  const database = await getDb();
  const row = database
    .prepare("SELECT * FROM local_tasks WHERE room_id = ? AND task_id = ?")
    .get(roomId, taskId);
  return row ? mapTaskRow(row) : null;
}

export async function updateLocalTask(
  roomId: string,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<LocalTask> {
  const current = await getLocalTask(roomId, taskId);
  if (!current) throw new Error("Task not found.");
  const nextStatus =
    patch.skip_transition_validation === true
      ? typeof patch.status === "string" && patch.status.trim()
        ? patch.status.trim()
        : current.status
      : resolveLocalTaskStatus(current.status, patch.status);
  const assigneeAgentKey =
    patch.assignee_agent_key === undefined
      ? current.assignee_agent_key
      : typeof patch.assignee_agent_key === "string"
        ? patch.assignee_agent_key
        : null;
  const assigneeAgentInstanceId =
    patch.assignee_agent_key === undefined
      ? current.assignee_agent_instance_id
      : assigneeAgentKey && typeof patch.assignee_agent_instance_id === "string"
        ? patch.assignee_agent_instance_id
        : assigneeAgentKey && typeof patch.actor_instance_id === "string"
          ? patch.actor_instance_id
          : null;
  const assigneeAgentSessionId =
    patch.assignee_agent_key === undefined
      ? current.assignee_agent_session_id
      : assigneeAgentKey && typeof patch.assignee_agent_session_id === "string"
        ? patch.assignee_agent_session_id
        : assigneeAgentKey && typeof patch.agent_session_id === "string"
          ? patch.agent_session_id
          : null;
  const workflowArtifacts =
    patch.workflow_artifacts === undefined
      ? JSON.stringify(current.workflow_artifacts)
      : JSON.stringify(Array.isArray(patch.workflow_artifacts) ? patch.workflow_artifacts : []);
  const now = new Date().toISOString();
  const database = await getDb();
  database
    .prepare(`
      UPDATE local_tasks
      SET status = ?,
          assignee = ?,
          assignee_agent_key = ?,
          assignee_agent_instance_id = ?,
          assignee_agent_session_id = ?,
          pr_url = ?,
          workflow_artifacts_json = ?,
          sync_dirty = 1,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(
      nextStatus,
      patch.assignee === undefined ? current.assignee : patch.assignee || null,
      assigneeAgentKey,
      assigneeAgentInstanceId,
      assigneeAgentSessionId,
      patch.pr_url === undefined ? current.pr_url : patch.pr_url || null,
      workflowArtifacts,
      now,
      roomId,
      taskId,
    );
  const updated = await getLocalTask(roomId, taskId);
  if (!updated) throw new Error("Task not found.");
  return updated;
}

export async function claimLocalTaskReviewLease(
  roomId: string,
  taskId: string,
  input: {
    holder_label?: string | null;
    agent_key?: string | null;
    agent_session_id?: string | null;
  },
): Promise<{ task: LocalTask; lease: NonNullable<LocalTask["active_leases"]>[number] }> {
  const current = await getLocalTask(roomId, taskId);
  if (!current) throw new Error("Task not found.");
  const actorKey = input.agent_key?.trim() || null;
  if (
    actorKey &&
    current.assignee_agent_key &&
    current.assignee_agent_key === actorKey
  ) {
    throw new Error("A worker holding the task cannot also claim review authority.");
  }
  const currentReviewLease = current.active_leases?.find((lease) => lease.kind === "review");
  if (
    currentReviewLease?.agent_key &&
    actorKey &&
    currentReviewLease.agent_key !== actorKey
  ) {
    throw new Error("Review authority is already held by another local reviewer.");
  }
  const database = await getDb();
  const now = new Date().toISOString();
  const leaseId = currentReviewLease?.id || `local_review_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  database
    .prepare(`
      UPDATE local_tasks
      SET review_lease_id = ?,
          review_holder_label = ?,
          review_agent_key = ?,
          review_agent_session_id = ?,
          review_updated_at = ?,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(
      leaseId,
      input.holder_label?.trim() || actorKey || "Local reviewer",
      actorKey,
      input.agent_session_id?.trim() || null,
      now,
      now,
      roomId,
      taskId,
    );
  const task = await getLocalTask(roomId, taskId);
  const lease = task?.active_leases?.find((entry) => entry.id === leaseId);
  if (!task || !lease) throw new Error("Review authority could not be claimed.");
  return { task, lease };
}

export async function releaseLocalTaskReviewLease(
  roomId: string,
  taskId: string,
  input: { lease_id?: string | null } = {},
): Promise<{
  task: LocalTask;
  released_lease: NonNullable<LocalTask["active_leases"]>[number] | null;
}> {
  const current = await getLocalTask(roomId, taskId);
  if (!current) throw new Error("Task not found.");
  const currentReviewLease = current.active_leases?.find((lease) => lease.kind === "review") || null;
  if (
    input.lease_id &&
    currentReviewLease &&
    input.lease_id !== currentReviewLease.id
  ) {
    throw new Error("Review lease id did not match the active local review authority.");
  }
  const database = await getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE local_tasks
      SET review_lease_id = NULL,
          review_holder_label = NULL,
          review_agent_key = NULL,
          review_agent_session_id = NULL,
          review_updated_at = NULL,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(now, roomId, taskId);
  const task = await getLocalTask(roomId, taskId);
  if (!task) throw new Error("Task not found.");
  return {
    task,
    released_lease: currentReviewLease
      ? { ...currentReviewLease, status: "released" }
      : null,
  };
}
