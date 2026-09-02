import { randomUUID } from "node:crypto";

import {
  ensureLocalThreadRoutingProjectionSchemaAsync,
  getLocalThreadRoutingAgentKeysForRoots,
  invalidateLocalThreadRoutingRoots,
  projectLocalThreadRoutingMessage,
  runLocalSqliteWriteTransactionAsync,
  scheduleLocalThreadRoutingBackfill,
  scheduleLocalThreadRoutingRootsRepair,
} from "../../../../../../shared/sqlite-thread-routing.mjs";
import {
  ensureLocalChatWriteNotificationSchema,
  getLocalChatRoomWriteSequence,
} from "../../../../../../shared/sqlite-local-write-notifications.mjs";
import {
  MESSAGE_SENDER_MAX_CODE_POINTS,
  MESSAGE_SENDER_MAX_UTF8_BYTES,
  POSTGRES_INTEGER_MAX,
  isMessageSenderWithinBounds,
  parsePositivePgIntegerScopedId,
} from "../../../../../../shared/message-contracts.mjs";

import type { RoomMessageAttachmentPayload } from "../../attachments/mappers.js";
import type { RoomMessagePayload } from "./mappers.js";
import { publishLocalChatMessageWrite } from "./local-write-notifications.js";
import {
  addColumnIfMissing,
  beginImmediate,
  getLocalChatDatabase,
  rollback,
  type SqliteDatabase,
} from "../local-db.js";

type LocalMessageRow = {
  room_id: string;
  number: number;
  reply_to_number: number | null;
  thread_root_number: number | null;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  publisher_agent_key: string | null;
  publisher_agent_session_id: string | null;
  account_agent_routing_json: string | null;
  account_agent_routing_reader_key: string | null;
  control_authorized: number | null;
  timestamp: string;
  synced_cloud_id: string | null;
  synced_at: string | null;
  sync_key: string | null;
  sync_started_at: string | null;
};

export type LocalAttachmentRow = {
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

export type LocalMessageThreadPage = {
  root: RoomMessagePayload;
  replies: RoomMessagePayload[];
  summary: NonNullable<RoomMessagePayload["thread"]>;
  has_older: boolean;
};

export type LocalMessageThreadInboxFilter = "all" | "unread";

export type LocalMessageThreadInboxPage = {
  threads: Array<{
    root: RoomMessagePayload;
    summary: NonNullable<RoomMessagePayload["thread"]>;
  }>;
  has_more: boolean;
  unread_thread_count: number;
};

export type LocalChatMessageInput = {
  sender: string;
  text: string;
  source?: string | null;
  agent_prompt_kind?: string | null;
  reply_to?: string | null;
  thread_root_id?: string | null;
  attachments?: RoomMessageAttachmentPayload[];
  readerKey?: string | null;
  idempotency_key?: string | null;
  publisher_agent_key?: string | null;
  publisher_agent_session_id?: string | null;
  control_authorized?: boolean | null;
};

export type DeferredLocalChatMessageWrite = {
  message: RoomMessagePayload;
  publishWriteNotification: () => void;
};

export type LocalSyncMessagePayload = RoomMessagePayload & {
  sync_key: string;
};

type LocalReaderOptions = {
  readerKey?: string | null;
};

const legacyLocalThreadReaderKey = "local:legacy";
const LOCAL_THREAD_DISPLAY_PARTICIPANT_LIMIT = 50;
let schemaInitialized = false;
let schemaInitialization: Promise<void> | null = null;
let schemaInitializationObserverForTest: (() => void) | null = null;

export function setLocalMessageSchemaInitializationObserverForTest(
  observer: (() => void) | null,
): void {
  schemaInitializationObserverForTest = observer;
}

function formatMessageId(number: number): string {
  return `msg_${number}`;
}

function parseMessageNumber(messageId?: string | null): number | null {
  return parsePositivePgIntegerScopedId(messageId, "msg");
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 150;
  return Math.max(1, Math.min(500, Math.floor(Number(limit))));
}

async function getDb(): Promise<SqliteDatabase> {
  const database = await getLocalChatDatabase();
  if (!schemaInitialized) {
    schemaInitialization ??= (async () => {
      schemaInitializationObserverForTest?.();
      await runLocalSqliteWriteTransactionAsync(database, () => {
        database.exec(`
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
        publisher_agent_key TEXT,
        publisher_agent_session_id TEXT,
        account_agent_routing_json TEXT,
        account_agent_routing_reader_key TEXT,
        control_authorized INTEGER,
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
      CREATE TABLE IF NOT EXISTS local_chat_thread_reads (
        room_id TEXT NOT NULL,
        thread_root_number INTEGER NOT NULL,
        reader_key TEXT NOT NULL,
        last_read_message_number INTEGER NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (room_id, thread_root_number, reader_key)
      );
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
        addColumnIfMissing(database, "local_chat_messages", "thread_root_number", "INTEGER");
        addColumnIfMissing(database, "local_chat_messages", "sync_key", "TEXT");
        addColumnIfMissing(database, "local_chat_messages", "sync_started_at", "TEXT");
        addColumnIfMissing(database, "local_chat_messages", "publisher_agent_key", "TEXT");
        addColumnIfMissing(database, "local_chat_messages", "publisher_agent_session_id", "TEXT");
        addColumnIfMissing(database, "local_chat_messages", "account_agent_routing_json", "TEXT");
        addColumnIfMissing(database, "local_chat_messages", "account_agent_routing_reader_key", "TEXT");
        addColumnIfMissing(database, "local_chat_messages", "control_authorized", "INTEGER");
        ensureLocalThreadReadsSchema(database);
        database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS local_chat_messages_sync_key_idx
        ON local_chat_messages (room_id, sync_key)
        WHERE sync_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS local_chat_messages_cloud_id_idx
        ON local_chat_messages (room_id, synced_cloud_id)
        WHERE synced_cloud_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS local_chat_messages_sync_started_idx
        ON local_chat_messages (room_id, sync_started_at);
      CREATE INDEX IF NOT EXISTS local_chat_messages_thread_root_idx
        ON local_chat_messages (room_id, thread_root_number);
      CREATE INDEX IF NOT EXISTS local_chat_thread_reads_reader_idx
        ON local_chat_thread_reads (reader_key);
        `);
        ensureLocalChatWriteNotificationSchema(database);
      });
      await ensureLocalThreadRoutingProjectionSchemaAsync(database);
      scheduleLocalThreadRoutingBackfill(database);
      schemaInitialized = true;
    })();
    try {
      await schemaInitialization;
    } finally {
      schemaInitialization = null;
    }
  }
  return database;
}

function ensureLocalThreadReadsSchema(database: SqliteDatabase): void {
  const columns = database
    .prepare("PRAGMA table_info(local_chat_thread_reads)")
    .all();
  if (columns.some((column) => column.name === "reader_key")) return;

  database.exec(`
    ALTER TABLE local_chat_thread_reads RENAME TO local_chat_thread_reads_legacy;
    CREATE TABLE local_chat_thread_reads (
      room_id TEXT NOT NULL,
      thread_root_number INTEGER NOT NULL,
      reader_key TEXT NOT NULL,
      last_read_message_number INTEGER NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (room_id, thread_root_number, reader_key)
    );
    INSERT INTO local_chat_thread_reads (
      room_id, thread_root_number, reader_key, last_read_message_number, read_at
    )
    SELECT room_id, thread_root_number, '${legacyLocalThreadReaderKey}', last_read_message_number, read_at
    FROM local_chat_thread_reads_legacy;
    DROP TABLE local_chat_thread_reads_legacy;
  `);
}

function normalizeReaderKey(readerKey?: string | null): string {
  const trimmed = readerKey?.trim();
  return trimmed || "local:default";
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
    publisher_agent_key:
      typeof row.publisher_agent_key === "string" ? row.publisher_agent_key : null,
    publisher_agent_session_id:
      typeof row.publisher_agent_session_id === "string" ? row.publisher_agent_session_id : null,
    account_agent_routing_json:
      typeof row.account_agent_routing_json === "string" ? row.account_agent_routing_json : null,
    account_agent_routing_reader_key:
      typeof row.account_agent_routing_reader_key === "string"
        ? row.account_agent_routing_reader_key
        : null,
    control_authorized:
      row.control_authorized === null || row.control_authorized === undefined
        ? null
        : Number(row.control_authorized),
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
  thread?: RoomMessagePayload["thread"],
  readerKey?: string | null,
): RoomMessagePayload {
  const importedCloudProvenance = Boolean(row.synced_cloud_id && !row.sync_key);
  let importedAccountAgentRouting: RoomMessagePayload["account_agent_routing"];
  if (row.account_agent_routing_json) {
    const routingAudienceMatches = Boolean(
      row.account_agent_routing_reader_key
      && row.account_agent_routing_reader_key === normalizeReaderKey(readerKey),
    );
    try {
      importedAccountAgentRouting = routingAudienceMatches
        ? JSON.parse(row.account_agent_routing_json) as RoomMessagePayload["account_agent_routing"]
        : { version: 1, authority: "invalid" };
    } catch {
      importedAccountAgentRouting = { version: 1, authority: "invalid" };
    }
  } else if (importedCloudProvenance) {
    // Cloud provenance without an audience-bound envelope is an old/partial
    // response. Never reinterpret it as mutable local legacy authority.
    importedAccountAgentRouting = { version: 1, authority: "invalid" };
  }
  const importedControlAudienceMatches = Boolean(
    importedCloudProvenance
    && row.account_agent_routing_reader_key
    && row.account_agent_routing_reader_key === normalizeReaderKey(readerKey),
  );
  return {
    id: formatMessageId(row.number),
    agent_identity: row.publisher_agent_key
      ? {
          actor_label: row.sender,
          agent_key: row.publisher_agent_key,
          agent_session_id: row.publisher_agent_session_id,
        }
      : null,
    local_control_authorized: row.control_authorized === null
      ? !importedCloudProvenance
        && row.source === "browser"
        && !row.publisher_agent_key
      : importedCloudProvenance
        ? importedControlAudienceMatches && row.control_authorized === 1
        : row.control_authorized === 1,
    account_agent_routing: importedAccountAgentRouting,
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
    thread_root_id: formatMessageId(row.thread_root_number ?? row.number),
    thread_reply_to_id: row.reply_to_number ? formatMessageId(row.reply_to_number) : null,
    thread: thread ?? null,
    reply_to: replyTo
      ? {
          id: formatMessageId(replyTo.number),
          sender: replyTo.sender,
          text: replyTo.text,
          source: replyTo.source,
          timestamp: replyTo.timestamp,
          agent_identity: replyTo.publisher_agent_key
            ? {
                actor_label: replyTo.sender,
                agent_key: replyTo.publisher_agent_key,
                agent_session_id: replyTo.publisher_agent_session_id,
              }
            : null,
        }
      : null,
  };
}

function visibleMessageClause(includePromptOnly?: boolean, alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return includePromptOnly
    ? "1 = 1"
    : `(${prefix}agent_prompt_kind IS NULL OR ${prefix}agent_prompt_kind <> 'auto' OR TRIM(${prefix}text) <> '')`;
}

async function hydrateMessageRows(
  database: SqliteDatabase,
  rows: LocalMessageRow[],
  options: LocalReaderOptions = {},
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

  const threadSummaries = buildLocalThreadSummaries(
    database,
    roomId,
    rows.map((row) => row.thread_root_number ?? row.number),
    options,
  );

  return rows.map((row) => {
    const threadRootNumber = row.thread_root_number ?? row.number;
    const thread = threadSummaries.get(threadRootNumber) ?? null;
    return toMessagePayload(
      row,
      row.reply_to_number ? replies.get(row.reply_to_number) ?? null : null,
      attachmentsByMessageNumber.get(row.number) || [],
      thread && (Number(thread.reply_count || 0) > 0 || row.thread_root_number) ? thread : null,
      options.readerKey,
    );
  });
}

function buildLocalThreadSummaries(
  database: SqliteDatabase,
  roomId: string,
  rootNumbers: number[],
  options: LocalReaderOptions = {},
): Map<number, NonNullable<RoomMessagePayload["thread"]>> {
  const uniqueRootNumbers = [
    ...new Set(rootNumbers.filter((value) => Number.isInteger(value) && value > 0)),
  ];
  const summaries = new Map<number, NonNullable<RoomMessagePayload["thread"]>>();
  for (const rootNumber of uniqueRootNumbers) {
    const rootRow = database
      .prepare(`
        SELECT *
        FROM local_chat_messages
        WHERE room_id = ? AND number = ? AND ${visibleMessageClause(false)}
      `)
      .get(roomId, rootNumber);
    if (!rootRow) continue;
    const root = mapRow(rootRow);
    const replies = database
      .prepare(`
        SELECT *
        FROM local_chat_messages
        WHERE room_id = ? AND thread_root_number = ? AND ${visibleMessageClause(false)}
        ORDER BY number ASC
      `)
      .all(roomId, rootNumber)
      .map(mapRow);
    const readerKey = normalizeReaderKey(options.readerKey);
    const readRow = getLocalThreadReadRow(database, roomId, rootNumber, readerKey);
    const lastReadNumber = readRow
      ? Number(readRow.last_read_message_number)
      : null;
    const unreadCount = lastReadNumber === null
      ? replies.length
      : replies.filter((reply) => reply.number > lastReadNumber).length;
    const latestReply = replies.at(-1) ?? null;
    // The display payload is bounded independently from routing membership.
    const allParticipants = buildLocalThreadParticipants(root, replies);
    const participants = allParticipants.slice(0, LOCAL_THREAD_DISPLAY_PARTICIPANT_LIMIT);
    summaries.set(rootNumber, {
      root_message_id: formatMessageId(rootNumber),
      reply_count: replies.length,
      unread_count: unreadCount,
      has_unread: unreadCount > 0,
      latest_reply: latestReply
        ? {
            id: formatMessageId(latestReply.number),
            sender: latestReply.sender,
            text: latestReply.text,
            source: latestReply.source,
            timestamp: latestReply.timestamp,
          }
        : null,
      participants,
      participant_count: allParticipants.length,
      participants_truncated: participants.length < allParticipants.length,
      last_read_message_id: lastReadNumber ? formatMessageId(lastReadNumber) : null,
    });
  }
  return summaries;
}

function getLocalThreadReadRow(
  database: SqliteDatabase,
  roomId: string,
  rootNumber: number,
  readerKey: string,
): Record<string, unknown> | undefined {
  if (!readerKey.startsWith("local:")) {
    return database
      .prepare(`
        SELECT last_read_message_number
        FROM local_chat_thread_reads
        WHERE room_id = ? AND thread_root_number = ? AND reader_key = ?
      `)
      .get(roomId, rootNumber, readerKey);
  }

  return database
    .prepare(`
      SELECT last_read_message_number
      FROM local_chat_thread_reads
      WHERE room_id = ?
        AND thread_root_number = ?
        AND reader_key IN (?, ?)
      ORDER BY CASE WHEN reader_key = ? THEN 0 ELSE 1 END
      LIMIT 1
    `)
    .get(roomId, rootNumber, readerKey, legacyLocalThreadReaderKey, readerKey);
}

function buildLocalThreadParticipants(
  root: LocalMessageRow,
  replies: LocalMessageRow[],
): NonNullable<NonNullable<RoomMessagePayload["thread"]>["participants"]> {
  const participants = new Map<string, {
    sender: string;
    source: string | null;
    message_count: number;
    latest_message_id: string;
    latestNumber: number;
  }>();
  for (const row of [root, ...replies]) {
    const key = `${row.sender}\0${row.source ?? ""}`;
    const current = participants.get(key);
    if (!current) {
      participants.set(key, {
        sender: row.sender,
        source: row.source,
        message_count: 1,
        latest_message_id: formatMessageId(row.number),
        latestNumber: row.number,
      });
      continue;
    }
    current.message_count += 1;
    if (row.number > current.latestNumber) {
      current.latest_message_id = formatMessageId(row.number);
      current.latestNumber = row.number;
    }
  }
  return Array.from(participants.values())
    .sort((left, right) => right.latestNumber - left.latestNumber)
    .map(({ latestNumber: _latestNumber, ...participant }) => participant);
}

function syncKeyForMessage(roomId: string, number: number): string {
  return `local-chat:${roomId}:${number}`;
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
  if (!Number.isInteger(number) || number <= 0 || number > POSTGRES_INTEGER_MAX) {
    throw new Error("Local chat message sequence could not be allocated.");
  }
  database
    .prepare("UPDATE local_chat_room_sequences SET next_number = next_number + 1 WHERE room_id = ?")
    .run(roomId);
  return number;
}

export async function addLocalChatMessageWithDeferredWriteNotification(
  roomId: string,
  input: LocalChatMessageInput,
  options: {
    writeInTransaction?: (database: SqliteDatabase) => void;
  } = {},
): Promise<DeferredLocalChatMessageWrite> {
  const trimmedRoomId = roomId.trim();
  const sender = input.sender.trim();
  const text = input.text;
  if (!trimmedRoomId) throw new Error("Choose a room before sending a message.");
  if (!sender) throw new Error("Message sender is required.");
  if (!isMessageSenderWithinBounds(sender)) {
    throw new Error(
      `Message sender must not exceed ${MESSAGE_SENDER_MAX_CODE_POINTS} characters or ${MESSAGE_SENDER_MAX_UTF8_BYTES} UTF-8 bytes.`,
    );
  }

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
    replyTarget = getLocalVisibleMessageRow(database, trimmedRoomId, replyToNumber, false);
    if (!replyTarget) {
      throw new Error("reply_to must reference a visible local message in this room.");
    }
    replyTargetRootNumber = replyTarget.thread_root_number ?? replyTarget.number;
  }
  let threadRootNumber = explicitThreadRootNumber;
  if (explicitThreadRootNumber) {
    const rootTarget = getLocalVisibleMessageRow(database, trimmedRoomId, explicitThreadRootNumber, false);
    if (!rootTarget) {
      throw new Error("thread_root_id must reference a visible local message in this room.");
    }
    threadRootNumber = rootTarget.thread_root_number ?? rootTarget.number;
    if (replyTargetRootNumber && replyTargetRootNumber !== threadRootNumber) {
      throw new Error("reply_to must belong to the requested local thread.");
    }
  }

  const timestamp = new Date().toISOString();
  const attachmentRows = (input.attachments || []).map(normalizeAttachmentPayload);
  const result = await runLocalSqliteWriteTransactionAsync(database, () => {
    const idempotencyKey = input.idempotency_key?.trim() || null;
    const existing = idempotencyKey
      ? database
        .prepare("SELECT * FROM local_chat_messages WHERE room_id = ? AND sync_key = ?")
        .get(trimmedRoomId, idempotencyKey)
      : null;
    if (existing) {
      options.writeInTransaction?.(database);
      return { row: mapRow(existing), inserted: false };
    }
    const number = allocateLocalMessageNumber(database, trimmedRoomId);
    const insertedRow: LocalMessageRow = {
      room_id: trimmedRoomId,
      number,
      reply_to_number: replyToNumber,
      thread_root_number: threadRootNumber,
      sender,
      text,
      agent_prompt_kind: input.agent_prompt_kind || null,
      source: input.source || null,
      publisher_agent_key: input.publisher_agent_key?.trim() || null,
      publisher_agent_session_id: input.publisher_agent_session_id?.trim() || null,
      account_agent_routing_json: null,
      account_agent_routing_reader_key: null,
      control_authorized: input.control_authorized === undefined
        || input.control_authorized === null
        ? input.source === "browser" && !input.publisher_agent_key?.trim()
          ? 1
          : 0
        : input.control_authorized ? 1 : 0,
      timestamp,
      synced_cloud_id: null,
      synced_at: null,
      sync_key: idempotencyKey,
      sync_started_at: null,
    };

    database
      .prepare(`
        INSERT INTO local_chat_messages (
          room_id, number, reply_to_number, thread_root_number, sender, text, agent_prompt_kind, source,
          publisher_agent_key, publisher_agent_session_id, account_agent_routing_json,
          account_agent_routing_reader_key, control_authorized,
          timestamp, synced_cloud_id, synced_at, sync_key, sync_started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL)
      `)
      .run(
        insertedRow.room_id,
        insertedRow.number,
        insertedRow.reply_to_number,
        insertedRow.thread_root_number,
        insertedRow.sender,
        insertedRow.text,
        insertedRow.agent_prompt_kind,
        insertedRow.source,
        insertedRow.publisher_agent_key,
        insertedRow.publisher_agent_session_id,
        insertedRow.control_authorized,
        insertedRow.timestamp,
        insertedRow.sync_key,
      );
    projectLocalThreadRoutingMessage(database, insertedRow);
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
          insertedRow.room_id,
          insertedRow.number,
          attachment.attachment_id,
          attachment.file_name,
          attachment.mime_type,
          attachment.size_bytes,
          attachment.url || null,
          attachment.download_url || attachment.url || null,
          attachment.data_url || null,
          attachment.content_base64 || null,
          insertedRow.timestamp,
        );
    }
    options.writeInTransaction?.(database);
    return { row: insertedRow, inserted: true };
  });

  const message = (await hydrateMessageRows(
    database,
    [result.row],
    { readerKey: input.readerKey },
  ))[0]!;
  let notificationPublished = false;
  return {
    message,
    publishWriteNotification: () => {
      if (!result.inserted || notificationPublished) return;
      notificationPublished = true;
      publishLocalChatMessageWrite({
        localRoomIdentifier: trimmedRoomId,
        message,
      });
    },
  };
}

export async function addLocalChatMessage(
  roomId: string,
  input: LocalChatMessageInput,
): Promise<RoomMessagePayload> {
  const persisted = await addLocalChatMessageWithDeferredWriteNotification(roomId, input);
  persisted.publishWriteNotification();
  return persisted.message;
}

export async function getLocalChatRoomWriteSequenceValue(roomId: string): Promise<number> {
  const database = await getDb();
  return getLocalChatRoomWriteSequence(database, roomId.trim());
}

export async function getLocalChatMessages(
  roomId: string,
  options?: {
    limit?: number;
    after?: string | null;
    include_prompt_only?: boolean;
  } & LocalReaderOptions,
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
    messages: await hydrateMessageRows(database, bounded, options),
    has_more: hasMore,
  };
}

export async function getLatestLocalChatMessages(
  roomId: string,
  options?: { limit?: number; include_prompt_only?: boolean } & LocalReaderOptions,
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
    messages: await hydrateMessageRows(database, bounded, options),
    has_more: hasMore,
  };
}

export async function getLocalChatMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean } & LocalReaderOptions,
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
    messages: await hydrateMessageRows(database, bounded, options),
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
  const pattern = `%${escapeLikePattern(trimmedQuery)}%`;
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
        AND (
          LOWER(text) LIKE ? ESCAPE '\\'
          OR LOWER(sender) LIKE ? ESCAPE '\\'
        )
      ORDER BY number DESC
      LIMIT ?
    `)
    .all(roomId, pattern, pattern, limit + 1)
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
      WITH RECURSIVE thread_numbers(number) AS (
        SELECT number
        FROM local_chat_messages
        WHERE room_id = ?
          AND number = ?
          AND ${visibleMessageClause(options?.include_prompt_only)}
        UNION ALL
        SELECT child.number
        FROM local_chat_messages child
        JOIN thread_numbers parent ON child.reply_to_number = parent.number
        WHERE child.room_id = ?
          AND ${visibleMessageClause(options?.include_prompt_only, "child")}
      )
      SELECT *
      FROM local_chat_messages
      WHERE room_id = ?
        AND number IN (SELECT number FROM thread_numbers)
      ORDER BY number ASC
      LIMIT ?
    `)
    .all(roomId, rootNumber, roomId, roomId, limit + 1)
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
  const database = await getDb();
  const beforeRows = before > 0
    ? database
      .prepare(`
        SELECT * FROM local_chat_messages
        WHERE room_id = ?
          AND ${visibleMessageClause(options?.include_prompt_only)}
          AND number < ?
        ORDER BY number DESC
        LIMIT ?
      `)
      .all(roomId, anchorNumber, before + 1)
      .map(mapRow)
    : [];
  const anchorRows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND ${visibleMessageClause(options?.include_prompt_only)}
        AND number = ?
      LIMIT 1
    `)
    .all(roomId, anchorNumber)
    .map(mapRow);
  const afterRows = after > 0
    ? database
      .prepare(`
        SELECT * FROM local_chat_messages
        WHERE room_id = ?
          AND ${visibleMessageClause(options?.include_prompt_only)}
          AND number > ?
        ORDER BY number ASC
        LIMIT ?
      `)
      .all(roomId, anchorNumber, after + 1)
      .map(mapRow)
    : [];
  const hasMore = beforeRows.length > before || afterRows.length > after;
  const rows = [
    ...(beforeRows.length > before ? beforeRows.slice(0, before) : beforeRows).reverse(),
    ...anchorRows,
    ...(afterRows.length > after ? afterRows.slice(0, after) : afterRows),
  ];
  return {
    messages: await hydrateMessageRows(database, rows),
    has_more: hasMore,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function getLocalMessageThread(
  roomId: string,
  rootMessageId: string,
  options?: { limit?: number; before?: string | null; include_prompt_only?: boolean } & LocalReaderOptions,
): Promise<LocalMessageThreadPage | null> {
  const requestedNumber = parseMessageNumber(rootMessageId);
  if (!requestedNumber) {
    throw new Error("thread root must be a valid local message id.");
  }
  const database = await getDb();
  const requestedRow = getLocalVisibleMessageRow(database, roomId, requestedNumber, options?.include_prompt_only);
  if (!requestedRow) return null;
  const rootNumber = requestedRow.thread_root_number ?? requestedRow.number;
  const rootRow = requestedRow.number === rootNumber
    ? requestedRow
    : getLocalVisibleMessageRow(database, roomId, rootNumber, options?.include_prompt_only);
  if (!rootRow) return null;

  const beforeNumber = parseMessageNumber(options?.before);
  if (options?.before && !beforeNumber) {
    throw new Error("before must be a valid local message id.");
  }
  const limit = clampLimit(options?.limit);
  const rows = database
    .prepare(`
      SELECT *
      FROM local_chat_messages
      WHERE room_id = ?
        AND thread_root_number = ?
        AND ${beforeNumber ? "number < ?" : "1 = 1"}
        AND ${visibleMessageClause(options?.include_prompt_only)}
      ORDER BY number DESC
      LIMIT ?
    `)
    .all(...(beforeNumber ? [roomId, rootNumber, beforeNumber, limit + 1] : [roomId, rootNumber, limit + 1]))
    .map(mapRow);
  const hasOlder = rows.length > limit;
  const bounded = (hasOlder ? rows.slice(0, limit) : rows).reverse();
  const [root] = await hydrateMessageRows(database, [rootRow], options);
  const replies = await hydrateMessageRows(database, bounded, options);
  const summary = buildLocalThreadSummaries(database, roomId, [rootNumber], options).get(rootNumber);
  if (!root || !summary) return null;
  return {
    root,
    replies,
    summary,
    has_older: hasOlder,
  };
}

export async function getLocalMessageThreads(
  roomId: string,
  options?: {
    filter?: LocalMessageThreadInboxFilter;
    limit?: number;
    before?: string | null;
    include_prompt_only?: boolean;
  } & LocalReaderOptions,
): Promise<LocalMessageThreadInboxPage> {
  const filter = options?.filter ?? "all";
  if (filter !== "all" && filter !== "unread") {
    throw new Error("filter must be all or unread.");
  }
  const beforeNumber = parseMessageNumber(options?.before);
  if (options?.before && !beforeNumber) {
    throw new Error("before must be a valid local message id.");
  }

  const limit = clampLimit(options?.limit);
  const database = await getDb();
  const allCandidates = database
    .prepare(`
      SELECT thread_root_number, MAX(number) AS latest_reply_number
      FROM local_chat_messages
      WHERE room_id = ?
        AND thread_root_number IS NOT NULL
        AND ${visibleMessageClause(options?.include_prompt_only)}
      GROUP BY thread_root_number
      ORDER BY latest_reply_number DESC
    `)
    .all(roomId)
    .map((row) => ({
      rootNumber: Number(row.thread_root_number || 0),
      latestReplyNumber: Number(row.latest_reply_number || 0),
    }))
    .filter((row) =>
      Number.isInteger(row.rootNumber)
      && row.rootNumber > 0
      && Number.isInteger(row.latestReplyNumber)
      && row.latestReplyNumber > 0
    );
  const summaries = buildLocalThreadSummaries(
    database,
    roomId,
    allCandidates.map((row) => row.rootNumber),
    options,
  );
  const inboxItems = allCandidates
    .map((candidate) => {
      const summary = summaries.get(candidate.rootNumber);
      return summary?.latest_reply ? { ...candidate, summary } : null;
    })
    .filter((item): item is {
      rootNumber: number;
      latestReplyNumber: number;
      summary: NonNullable<RoomMessagePayload["thread"]>;
    } => Boolean(item));
  const unreadThreadCount = inboxItems.filter((item) => Number(item.summary.unread_count || 0) > 0).length;
  const filteredByCursor = beforeNumber
    ? inboxItems.filter((item) => item.latestReplyNumber < beforeNumber)
    : inboxItems;
  const filtered = filter === "unread"
    ? filteredByCursor.filter((item) => Number(item.summary.unread_count || 0) > 0)
    : filteredByCursor;
  const hasMore = filtered.length > limit;
  const bounded = hasMore ? filtered.slice(0, limit) : filtered;
  const rootRows = bounded
    .map((item) => getLocalVisibleMessageRow(database, roomId, item.rootNumber, options?.include_prompt_only))
    .filter((row): row is LocalMessageRow => Boolean(row));
  const roots = await hydrateMessageRows(database, rootRows, options);
  return {
    threads: roots
      .map((root) => ({
        root,
        summary: summaries.get(parseMessageNumber(root.id) || 0) ?? root.thread,
      }))
      .filter((item): item is { root: RoomMessagePayload; summary: NonNullable<RoomMessagePayload["thread"]> } =>
        Boolean(item.summary)
      ),
    has_more: hasMore,
    unread_thread_count: unreadThreadCount,
  };
}

export async function markLocalMessageThreadRead(
  roomId: string,
  rootMessageId: string,
  messageId?: string | null,
  options: LocalReaderOptions = {},
): Promise<NonNullable<RoomMessagePayload["thread"]> | null> {
  const requestedNumber = parseMessageNumber(rootMessageId);
  if (!requestedNumber) {
    throw new Error("thread root must be a valid local message id.");
  }
  const database = await getDb();
  const requestedRow = getLocalVisibleMessageRow(database, roomId, requestedNumber, false);
  if (!requestedRow) return null;
  const rootNumber = requestedRow.thread_root_number ?? requestedRow.number;
  if (
    requestedRow.number !== rootNumber &&
    !getLocalVisibleMessageRow(database, roomId, rootNumber, false)
  ) {
    return null;
  }

  let lastReadNumber = parseMessageNumber(messageId);
  if (messageId && !lastReadNumber) {
    throw new Error("message_id must be a valid local message id.");
  }
  if (lastReadNumber) {
    const target = getLocalVisibleMessageRow(database, roomId, lastReadNumber, false);
    if (!target || (target.number !== rootNumber && target.thread_root_number !== rootNumber)) {
      throw new Error("message_id must belong to the requested local thread.");
    }
  } else {
    const latestReply = database
      .prepare(`
        SELECT *
        FROM local_chat_messages
        WHERE room_id = ? AND thread_root_number = ? AND ${visibleMessageClause(false)}
        ORDER BY number DESC
        LIMIT 1
      `)
      .get(roomId, rootNumber);
    lastReadNumber = latestReply ? mapRow(latestReply).number : rootNumber;
  }

  const now = new Date().toISOString();
  database
    .prepare(`
      INSERT INTO local_chat_thread_reads (
        room_id, thread_root_number, reader_key, last_read_message_number, read_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id, thread_root_number, reader_key) DO UPDATE SET
        last_read_message_number = MAX(local_chat_thread_reads.last_read_message_number, excluded.last_read_message_number),
        read_at = excluded.read_at
    `)
    .run(roomId, rootNumber, normalizeReaderKey(options.readerKey), lastReadNumber, now);

  return buildLocalThreadSummaries(database, roomId, [rootNumber], options).get(rootNumber) ?? null;
}

/** Resolve exact local-thread membership without expanding display participants. */
export async function getLocalChatThreadRoutingAgentKeys(
  roomId: string,
  rootMessageId: string,
  identities: readonly {
    agentKey?: string | null;
    actorLabel?: string | null;
    displayName?: string | null;
  }[],
): Promise<Set<string>> {
  return (await getLocalChatThreadRoutingAgentKeysForRoots(
    roomId,
    [rootMessageId],
    identities,
  )).get(rootMessageId) ?? new Set();
}

/** Batch variant used by local poll pages so routing never becomes N+1. */
export async function getLocalChatThreadRoutingAgentKeysForRoots(
  roomId: string,
  rootMessageIds: readonly string[],
  identities: readonly {
    agentKey?: string | null;
    actorLabel?: string | null;
    displayName?: string | null;
  }[],
): Promise<Map<string, Set<string>>> {
  const rootIdsByNumber = new Map<number, string>();
  for (const rootMessageId of rootMessageIds) {
    const rootNumber = parseMessageNumber(rootMessageId);
    if (rootNumber) rootIdsByNumber.set(rootNumber, formatMessageId(rootNumber));
  }
  if (rootIdsByNumber.size === 0 || identities.length === 0) return new Map();
  const database = await getDb();
  const matchedNumbers = await getLocalThreadRoutingAgentKeysForRoots(
    database,
    roomId,
    [...rootIdsByNumber.keys()],
    identities,
  );
  return new Map([...matchedNumbers].map(([rootNumber, keys]) => [
    rootIdsByNumber.get(rootNumber) ?? formatMessageId(rootNumber),
    keys,
  ]));
}

function getLocalVisibleMessageRow(
  database: SqliteDatabase,
  roomId: string,
  messageNumber: number,
  includePromptOnly?: boolean,
): LocalMessageRow | null {
  const row = database
    .prepare(`
      SELECT *
      FROM local_chat_messages
      WHERE room_id = ? AND number = ? AND ${visibleMessageClause(includePromptOnly)}
    `)
    .get(roomId, messageNumber);
  return row ? mapRow(row) : null;
}

function staleSyncStartedAt(): string {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString();
}

export async function claimUnsyncedLocalChatMessages(
  roomId: string,
): Promise<LocalSyncMessagePayload[]> {
  const database = await getDb();
  const syncStartedAt = `${new Date().toISOString()}#${randomUUID()}`;
  await runLocalSqliteWriteTransactionAsync(database, () => {
    const candidates = database
      .prepare(`
        SELECT number
        FROM local_chat_messages
        WHERE room_id = ?
          AND synced_cloud_id IS NULL
          AND ${visibleMessageClause(false)}
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
  });

  const rows = database
    .prepare(`
      SELECT * FROM local_chat_messages
      WHERE room_id = ?
        AND synced_cloud_id IS NULL
        AND sync_started_at = ?
        AND sync_key IS NOT NULL
        AND ${visibleMessageClause(false)}
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
      SET synced_cloud_id = ?, synced_at = ?, sync_started_at = NULL,
          sync_key = COALESCE(sync_key, ?)
      WHERE room_id = ? AND number = ?
    `)
    .run(
      input.cloudMessageId,
      new Date().toISOString(),
      syncKeyForMessage(input.roomId, localNumber),
      input.roomId,
      localNumber,
    );
}

export async function importLocalChatMessages(
  roomId: string,
  messages: RoomMessagePayload[],
  options: LocalReaderOptions = {},
): Promise<void> {
  const trimmedRoomId = roomId.trim();
  if (!trimmedRoomId || messages.length === 0) return;
  const database = await getDb();
  const routingReaderKey = options.readerKey?.trim() || null;
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

  const rootsToRebuild = new Set<number>();

  await runLocalSqliteWriteTransactionAsync(database, () => {
    // Allocate every cloud id before resolving edges. Thread pages may arrive
    // reply-first when timestamps are equal, so parent lookup cannot depend on
    // input order.
    for (const message of sortedMessages) {
      if (!message.id || cloudIdToNumber.has(message.id)) continue;
      cloudIdToNumber.set(message.id, allocateLocalMessageNumber(database, trimmedRoomId));
    }
    const insertedNumbers = new Set<number>();
    for (const message of sortedMessages) {
      if (!message.id) continue;
      const publisherAgentKey = message.agent_identity?.agent_key?.trim() || null;
      const publisherAgentSessionId = message.agent_identity?.agent_session_id?.trim() || null;
      const accountAgentRoutingJson = message.account_agent_routing
        ? JSON.stringify(message.account_agent_routing)
        : null;
      const importedControlAuthorized = typeof message.account_agent_routing?.control_authorized === "boolean"
        ? message.account_agent_routing.control_authorized ? 1 : 0
        : null;
      const controlAuthorized = importedControlAuthorized ?? 0;
      const existingNumber = cloudIdToNumber.get(message.id);
      if (!existingNumber) continue;
      const replyCloudId =
        typeof message.reply_to?.id === "string" ? message.reply_to.id : null;
      const replyNumber = replyCloudId
        ? cloudIdToNumber.get(replyCloudId) || null
        : null;
      const threadRootCloudId =
        typeof message.thread_root_id === "string" ? message.thread_root_id : null;
      const threadRootNumber = threadRootCloudId
        ? cloudIdToNumber.get(threadRootCloudId) || replyNumber
        : replyNumber;
      const existing = database
        .prepare(`SELECT * FROM local_chat_messages WHERE room_id = ? AND number = ?`)
        .get(trimmedRoomId, existingNumber);
      if (existing) {
          const existingRow = mapRow(existing);
          const changesPublisherAuthority = Boolean(publisherAgentKey || publisherAgentSessionId)
            && (existingRow.publisher_agent_key !== publisherAgentKey
              || existingRow.publisher_agent_session_id !== publisherAgentSessionId);
          const nextThreadRootNumber = threadRootNumber && threadRootNumber !== existingNumber
            ? threadRootNumber
            : null;
          const changesThreadEdges = existingRow.reply_to_number !== replyNumber
            || existingRow.thread_root_number !== nextThreadRootNumber;
          database.prepare(`
            UPDATE local_chat_messages
               SET reply_to_number = ?,
                   thread_root_number = ?,
                   publisher_agent_key = COALESCE(?, publisher_agent_key),
                   publisher_agent_session_id = COALESCE(?, publisher_agent_session_id),
                   account_agent_routing_json = COALESCE(?, account_agent_routing_json),
                   account_agent_routing_reader_key = CASE
                     WHEN ? IS NOT NULL THEN ?
                     ELSE account_agent_routing_reader_key
                   END,
                   control_authorized = COALESCE(?, control_authorized)
             WHERE room_id = ? AND number = ?
          `).run(
            replyNumber,
            nextThreadRootNumber,
            publisherAgentKey,
            publisherAgentSessionId,
            accountAgentRoutingJson,
            accountAgentRoutingJson,
            routingReaderKey,
            importedControlAuthorized,
            trimmedRoomId,
            existingNumber,
          );
          if (changesPublisherAuthority || changesThreadEdges) {
            rootsToRebuild.add(existingRow.thread_root_number ?? existingRow.number);
            rootsToRebuild.add(nextThreadRootNumber ?? existingNumber);
          }
        continue;
      }
      const number = existingNumber;
      database
        .prepare(`
          INSERT INTO local_chat_messages (
            room_id, number, reply_to_number, thread_root_number, sender, text, agent_prompt_kind, source,
            publisher_agent_key, publisher_agent_session_id, account_agent_routing_json,
            account_agent_routing_reader_key, control_authorized,
            timestamp, synced_cloud_id, synced_at, sync_key, sync_started_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(room_id, number) DO NOTHING
        `)
        .run(
          trimmedRoomId,
          number,
          replyNumber,
          threadRootNumber && threadRootNumber !== number ? threadRootNumber : null,
          message.sender || "unknown",
          message.text || "",
          message.agent_prompt_kind || null,
          message.source || null,
          publisherAgentKey,
          publisherAgentSessionId,
          accountAgentRoutingJson,
          accountAgentRoutingJson ? routingReaderKey : null,
          controlAuthorized,
          message.timestamp || new Date().toISOString(),
          message.id,
          new Date().toISOString(),
        );
      insertedNumbers.add(number);
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
    invalidateLocalThreadRoutingRoots(database, trimmedRoomId, [...rootsToRebuild]);
    const rowsToProject = database.prepare(`
      SELECT * FROM local_chat_messages
       WHERE room_id = ?
         AND number IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
       ORDER BY CASE WHEN thread_root_number IS NULL THEN 0 ELSE 1 END, number
    `).all(
      trimmedRoomId,
      JSON.stringify([...insertedNumbers]),
    );
    for (const row of rowsToProject) {
      const messageRow = mapRow(row);
      const rootNumber = messageRow.thread_root_number ?? messageRow.number;
      if (!rootsToRebuild.has(rootNumber)) {
        projectLocalThreadRoutingMessage(database, messageRow);
      }
    }
    seedImportedThreadReads(database, trimmedRoomId, sortedMessages, cloudIdToNumber, options);
  });
  scheduleLocalThreadRoutingRootsRepair(database, trimmedRoomId, [...rootsToRebuild]);
}

function seedImportedThreadReads(
  database: SqliteDatabase,
  roomId: string,
  messages: RoomMessagePayload[],
  cloudIdToNumber: Map<string, number>,
  options: LocalReaderOptions,
): void {
  const readerKey = normalizeReaderKey(options.readerKey);
  const now = new Date().toISOString();
  const seenRoots = new Set<number>();
  for (const message of messages) {
    const rootCloudId = message.thread?.root_message_id || message.thread_root_id || message.id;
    const lastReadCloudId = message.thread?.last_read_message_id || null;
    if (!rootCloudId || !lastReadCloudId) continue;
    const rootNumber = cloudIdToNumber.get(rootCloudId);
    const lastReadNumber = cloudIdToNumber.get(lastReadCloudId);
    if (!rootNumber || !lastReadNumber || seenRoots.has(rootNumber)) continue;
    seenRoots.add(rootNumber);
    database
      .prepare(`
        INSERT INTO local_chat_thread_reads (
          room_id, thread_root_number, reader_key, last_read_message_number, read_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id, thread_root_number, reader_key) DO UPDATE SET
          last_read_message_number = MAX(local_chat_thread_reads.last_read_message_number, excluded.last_read_message_number),
          read_at = excluded.read_at
      `)
      .run(roomId, rootNumber, readerKey, lastReadNumber, now);
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

export async function getLocalChatMessageAttachment(
  roomId: string,
  messageId: string,
  attachmentId: string,
): Promise<LocalAttachmentRow | null> {
  const messageNumber = parseMessageNumber(messageId);
  const trimmedAttachmentId = attachmentId.trim();
  if (!messageNumber || !trimmedAttachmentId) {
    return null;
  }
  const database = await getDb();
  const row = database
    .prepare(`
      SELECT * FROM local_chat_attachments
      WHERE room_id = ? AND message_number = ? AND attachment_id = ?
    `)
    .get(roomId, messageNumber, trimmedAttachmentId) as Record<string, unknown> | undefined;
  return row ? mapAttachmentRow(row) : null;
}
