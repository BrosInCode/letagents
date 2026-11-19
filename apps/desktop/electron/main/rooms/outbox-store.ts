import { randomUUID } from "node:crypto";
import { normalizeRoomGif, type RoomGif } from "../../../../../shared/room-expressions.mjs";
import type {
  DesktopDeleteOutgoingMessageOptions,
  DesktopOutgoingMessageAttachment,
  DesktopOutgoingMessageStatus,
  DesktopPersistedOutgoingMessage,
  DesktopRoomMessageReply,
  DesktopRoomStorageState,
  DesktopSaveOutgoingMessageInput,
  DesktopUpdateOutgoingMessageInput,
} from "../../ipc-types.js";
import { readStoredAuth } from "../auth.js";
import {
  discardLocalStagedAttachments,
  pruneOrphanedLocalStagedAttachments,
  releaseCommittedLocalStagedAttachments,
} from "../attachments.js";
import { resolveRoomStorageMode } from "../chat-storage/settings.js";
import { beginImmediate, getLocalChatDatabase, rollback, type SqliteDatabase } from "./local-db.js";
import { isLocalOnlyRoomIdentifier, resolveLocalAwareRoomStorageMode } from "./local-store.js";
import { resolveLocalThreadReaderKey } from "./messages/thread-reader.js";

export const DESKTOP_OUTGOING_CLIENT_ID_PATTERN =
  /^desktop-send:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const INTERRUPTED_DELIVERY_ERROR =
  "Delivery could not be confirmed before the app closed.";

export interface DesktopOutboxScopeRecord {
  accountScope: string;
  roomIdentifier: string;
  storageMode: "local" | "cloud";
  threadRootId: string | null;
  replyTo: string | null;
}

const MAX_TRACKED_OUTBOX_SCOPES = 256;
const knownOutboxScopes = new Map<string, DesktopOutboxScopeRecord>();
const unsavedCloudFallbackScopes = new Map<string, DesktopOutboxScopeRecord>();

function rememberBoundedScope(
  map: Map<string, DesktopOutboxScopeRecord>,
  clientMessageId: string,
  scope: DesktopOutboxScopeRecord,
): void {
  map.delete(clientMessageId);
  map.set(clientMessageId, scope);
  if (map.size > MAX_TRACKED_OUTBOX_SCOPES) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
}

let currentBootId = randomUUID();
let schemaInitialized = false;
let schemaDatabase: SqliteDatabase | null = null;
let prunedStagedForBootId: string | null = null;

/** Simulate a process restart in deterministic tests. */
export function rotateDesktopOutboxBootIdForTest(): string {
  currentBootId = randomUUID();
  knownOutboxScopes.clear();
  unsavedCloudFallbackScopes.clear();
  return currentBootId;
}

/**
 * Resolve room storage mode without failing cloud rooms when local-chat.sqlite
 * is unreadable. Local-only rooms and rooms configured for local storage still
 * rethrow the database error.
 */
export async function resolveCloudSafeRoomStorageMode(
  roomIdentifier: string,
): Promise<DesktopRoomStorageState> {
  try {
    return await resolveLocalAwareRoomStorageMode(roomIdentifier);
  } catch (error) {
    const resolved = await resolveRoomStorageMode(roomIdentifier);
    const trimmed = resolved.roomIdentifier?.trim() || "";
    if (isLocalOnlyRoomIdentifier(trimmed) || resolved.effectiveMode !== "cloud") {
      throw error;
    }
    return {
      ...resolved,
      effectiveMode: "cloud",
      isLocalRoom: false,
      localRoom: null,
    };
  }
}

async function getOutboxDb(): Promise<SqliteDatabase> {
  const database = await getLocalChatDatabase();
  if (!schemaInitialized || schemaDatabase !== database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS desktop_message_outbox (
        client_message_id TEXT PRIMARY KEY NOT NULL,
        account_scope TEXT NOT NULL,
        room_identifier TEXT NOT NULL,
        message_namespace TEXT,
        storage_mode TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to TEXT,
        thread_root_id TEXT,
        attachments_json TEXT NOT NULL,
        gif_json TEXT,
        reply_preview_json TEXT,
        sender TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        boot_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS desktop_message_outbox_account_idx
        ON desktop_message_outbox (account_scope, created_at);
    `);
    schemaInitialized = true;
    schemaDatabase = database;
  }
  return database;
}

function normalizeAttachments(
  attachments: readonly DesktopOutgoingMessageAttachment[] | null | undefined,
): DesktopOutgoingMessageAttachment[] {
  if (!Array.isArray(attachments)) return [];
  const seen = new Set<string>();
  const normalized: DesktopOutgoingMessageAttachment[] = [];
  for (const item of attachments) {
    const uploadId = typeof item?.upload_id === "string" ? item.upload_id.trim() : "";
    if (!uploadId || seen.has(uploadId)) continue;
    seen.add(uploadId);
    normalized.push({
      upload_id: uploadId,
      ...(item.fileName ? { fileName: String(item.fileName) } : {}),
      ...(item.mimeType ? { mimeType: String(item.mimeType) } : {}),
      ...(typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes) ? { sizeBytes: item.sizeBytes } : {}),
    });
  }
  return normalized;
}

function parseJsonOrNull<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): DesktopOutgoingMessageStatus {
  if (value === "pending" || value === "refused") return value;
  return "uncertain";
}

function mapOutboxRow(row: Record<string, unknown>): DesktopPersistedOutgoingMessage {
  const status = normalizeStatus(row.status);
  const storageMode = row.storage_mode === "local" ? "local" : "cloud";
  const parsedAttachments = parseJsonOrNull<DesktopOutgoingMessageAttachment[]>(row.attachments_json);
  const parsedGif = parseJsonOrNull<RoomGif>(row.gif_json);
  const parsedReplyPreview = parseJsonOrNull<DesktopRoomMessageReply>(row.reply_preview_json);
  return {
    clientMessageId: String(row.client_message_id),
    accountScope: String(row.account_scope),
    roomIdentifier: String(row.room_identifier),
    messageNamespace: typeof row.message_namespace === "string" ? row.message_namespace : null,
    storageMode,
    text: String(row.text ?? ""),
    replyTo: typeof row.reply_to === "string" ? row.reply_to : null,
    threadRootId: typeof row.thread_root_id === "string" ? row.thread_root_id : null,
    attachments: normalizeAttachments(parsedAttachments),
    ...(parsedGif ? { gif: normalizeRoomGif(parsedGif) } : {}),
    replyPreview: parsedReplyPreview,
    sender: String(row.sender || "You"),
    status,
    error: typeof row.error === "string" ? row.error : null,
    timestamp: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function saveDesktopOutgoingMessage(
  input: DesktopSaveOutgoingMessageInput,
): Promise<DesktopPersistedOutgoingMessage> {
  const clientMessageId = input.clientMessageId?.trim() || "";
  if (!DESKTOP_OUTGOING_CLIENT_ID_PATTERN.test(clientMessageId)) {
    throw new Error("Invalid outgoing message identity.");
  }
  const roomIdentifier = input.roomIdentifier?.trim() || "";
  if (!roomIdentifier) {
    throw new Error("Choose a room before sending a message.");
  }
  const text = (input.text ?? "").trim();
  const attachments = normalizeAttachments(input.attachments);
  const gif = input.gif ? normalizeRoomGif(input.gif) : null;
  if (!text && !gif && attachments.length === 0) {
    throw new Error("Write a message before sending.");
  }

  const storedAuth = await readStoredAuth();
  const accountScope = await resolveLocalThreadReaderKey(storedAuth);
  const storage = await resolveCloudSafeRoomStorageMode(roomIdentifier);
  const expectedNamespace = [
    roomIdentifier,
    storage.effectiveMode,
    storage.localRoom?.roomIdentifier || "cloud",
  ].join(":");
  if (input.messageNamespace && input.messageNamespace !== expectedNamespace) {
    throw new Error("This message belongs to a different room storage mode. Switch back to its original mode before retrying.");
  }
  if (storage.effectiveMode === "local" && gif) {
    throw new Error("GIFs require a cloud room.");
  }

  const now = new Date().toISOString();
  const createdAt = input.timestamp?.trim() || now;
  const messageNamespace = input.messageNamespace ?? expectedNamespace;
  const replyTo = input.replyTo?.trim() || null;
  const threadRootId = input.threadRootId?.trim() || null;
  const scopeRecord: DesktopOutboxScopeRecord = {
    accountScope,
    roomIdentifier,
    storageMode: storage.effectiveMode,
    threadRootId,
    replyTo,
  };
  let database: SqliteDatabase;
  try {
    database = await getOutboxDb();
  } catch (error) {
    if (storage.effectiveMode === "cloud" && storedAuth.account?.id) {
      rememberBoundedScope(unsavedCloudFallbackScopes, clientMessageId, scopeRecord);
    }
    throw error;
  }

  beginImmediate(database);
  try {
    const existing = database
      .prepare("SELECT account_scope FROM desktop_message_outbox WHERE client_message_id = ?")
      .get(clientMessageId);
    if (existing && String(existing.account_scope) !== accountScope) {
      throw new Error("Outgoing message identity belongs to a different account.");
    }
    database
      .prepare(`
        INSERT OR REPLACE INTO desktop_message_outbox (
          client_message_id, account_scope, room_identifier, message_namespace, storage_mode,
          text, reply_to, thread_root_id, attachments_json, gif_json, reply_preview_json,
          sender, status, error, boot_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        clientMessageId,
        accountScope,
        roomIdentifier,
        messageNamespace,
        storage.effectiveMode,
        text,
        replyTo,
        threadRootId,
        JSON.stringify(attachments),
        gif ? JSON.stringify(gif) : null,
        input.replyPreview ? JSON.stringify(input.replyPreview) : null,
        "You",
        "pending",
        null,
        currentBootId,
        createdAt,
        now,
      );
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    const isAccountCollision = error instanceof Error && error.message.includes("different account");
    if (!isAccountCollision && storage.effectiveMode === "cloud" && storedAuth.account?.id) {
      rememberBoundedScope(unsavedCloudFallbackScopes, clientMessageId, scopeRecord);
    }
    throw error;
  }
  unsavedCloudFallbackScopes.delete(clientMessageId);
  rememberBoundedScope(knownOutboxScopes, clientMessageId, scopeRecord);

  return {
    clientMessageId,
    accountScope,
    roomIdentifier,
    messageNamespace,
    storageMode: storage.effectiveMode,
    text,
    replyTo,
    threadRootId,
    attachments,
    ...(gif ? { gif } : {}),
    replyPreview: input.replyPreview ?? null,
    sender: "You",
    status: "pending",
    error: null,
    timestamp: createdAt,
    updatedAt: now,
  };
}

export async function updateDesktopOutgoingMessage(
  clientMessageId: string,
  input: DesktopUpdateOutgoingMessageInput,
): Promise<void> {
  const trimmedId = clientMessageId?.trim() || "";
  if (!DESKTOP_OUTGOING_CLIENT_ID_PATTERN.test(trimmedId)) return;
  const accountScope = await resolveLocalThreadReaderKey();
  const database = await getOutboxDb();
  const existing = database
    .prepare("SELECT * FROM desktop_message_outbox WHERE client_message_id = ? AND account_scope = ?")
    .get(trimmedId, accountScope);
  if (!existing) return;

  const nextStatus = input.status ?? normalizeStatus(existing.status);
  const nextError = input.error !== undefined ? input.error : (typeof existing.error === "string" ? existing.error : null);
  const nextGifJson = input.gif !== undefined
    ? (input.gif ? JSON.stringify(normalizeRoomGif(input.gif)) : null)
    : (typeof existing.gif_json === "string" ? existing.gif_json : null);
  const now = new Date().toISOString();

  database
    .prepare(`
      UPDATE desktop_message_outbox
      SET status = ?, error = ?, gif_json = ?, boot_id = ?, updated_at = ?
      WHERE client_message_id = ? AND account_scope = ?
    `)
    .run(nextStatus, nextError, nextGifJson, currentBootId, now, trimmedId, accountScope);
}

export async function deleteDesktopOutgoingMessage(
  clientMessageId: string,
  options: DesktopDeleteOutgoingMessageOptions = {},
): Promise<void> {
  const trimmedId = clientMessageId?.trim() || "";
  if (!DESKTOP_OUTGOING_CLIENT_ID_PATTERN.test(trimmedId)) return;
  const accountScope = await resolveLocalThreadReaderKey();
  const database = await getOutboxDb();
  const existing = database
    .prepare("SELECT attachments_json FROM desktop_message_outbox WHERE client_message_id = ? AND account_scope = ?")
    .get(trimmedId, accountScope);
  if (!existing) return;
  database
    .prepare("DELETE FROM desktop_message_outbox WHERE client_message_id = ? AND account_scope = ?")
    .run(trimmedId, accountScope);
  knownOutboxScopes.delete(trimmedId);
  unsavedCloudFallbackScopes.delete(trimmedId);
  const attachments = normalizeAttachments(
    parseJsonOrNull<DesktopOutgoingMessageAttachment[]>(existing.attachments_json),
  );
  if (attachments.length > 0) {
    if (options.discardAttachments) {
      await discardLocalStagedAttachments(attachments);
    } else {
      await releaseCommittedLocalStagedAttachments(attachments);
    }
  }
}

/**
 * Remove persisted cloud-room outbox rows for an account that explicitly signed
 * out so cloud message text does not linger on disk. Local-profile entries are
 * unaffected.
 */
export async function clearCloudDesktopOutgoingMessagesForAccount(accountId: string): Promise<void> {
  const trimmedId = accountId?.trim() || "";
  if (!trimmedId) return;
  const scope = `account:${trimmedId}`;
  for (const [id, record] of knownOutboxScopes) {
    if (record.accountScope === scope && record.storageMode === "cloud") knownOutboxScopes.delete(id);
  }
  for (const [id, record] of unsavedCloudFallbackScopes) {
    if (record.accountScope === scope && record.storageMode === "cloud") unsavedCloudFallbackScopes.delete(id);
  }
  const database = await getOutboxDb();
  database
    .prepare("DELETE FROM desktop_message_outbox WHERE account_scope = ? AND storage_mode = 'cloud'")
    .run(scope);
}

export async function listDesktopOutgoingMessages(): Promise<DesktopPersistedOutgoingMessage[]> {
  const accountScope = await resolveLocalThreadReaderKey();
  const database = await getOutboxDb();
  if (prunedStagedForBootId !== currentBootId) {
    prunedStagedForBootId = currentBootId;
    void pruneOrphanedLocalStagedAttachments().catch(() => undefined);
  }
  const rows = database
    .prepare("SELECT * FROM desktop_message_outbox WHERE account_scope = ? ORDER BY created_at ASC")
    .all(accountScope);
  if (rows.length === 0) return [];

  const now = new Date().toISOString();
  const interruptedStmt = database.prepare(`
    UPDATE desktop_message_outbox
    SET status = 'uncertain', error = ?, boot_id = ?, updated_at = ?
    WHERE client_message_id = ? AND account_scope = ?
  `);

  const results: DesktopPersistedOutgoingMessage[] = [];
  for (const row of rows) {
    const mapped = mapOutboxRow(row);
    if (mapped.status === "pending" && String(row.boot_id || "") !== currentBootId) {
      const error = mapped.error || INTERRUPTED_DELIVERY_ERROR;
      interruptedStmt.run(error, currentBootId, now, mapped.clientMessageId, accountScope);
      results.push({
        ...mapped,
        status: "uncertain",
        error,
        updatedAt: now,
      });
      continue;
    }
    results.push(mapped);
  }
  return results;
}

export async function getDesktopOutgoingMessageByClientId(
  clientMessageId: string,
): Promise<DesktopPersistedOutgoingMessage | null> {
  const trimmedId = clientMessageId?.trim() || "";
  if (!DESKTOP_OUTGOING_CLIENT_ID_PATTERN.test(trimmedId)) return null;
  const database = await getOutboxDb();
  const row = database
    .prepare("SELECT * FROM desktop_message_outbox WHERE client_message_id = ?")
    .get(trimmedId);
  return row ? mapOutboxRow(row) : null;
}

/**
 * Look up the authoritative outbox scope for `clientMessageId` before dispatch.
 * When `local-chat.sqlite` is unreadable, falls back ONLY to an in-process scope
 * record captured during the current session (either a previously persisted row
 * or a fresh cloud fallback whose local DB write just failed), preserving strict
 * account/room/storage-mode/thread scoping while failing closed for any unknown
 * `clientMessageId`.
 */
export async function resolveOutboxScopeForSend(
  clientMessageId: string,
): Promise<DesktopOutboxScopeRecord | null> {
  const trimmedId = clientMessageId?.trim() || "";
  if (!DESKTOP_OUTGOING_CLIENT_ID_PATTERN.test(trimmedId)) return null;
  try {
    const persisted = await getDesktopOutgoingMessageByClientId(trimmedId);
    if (persisted) {
      const record: DesktopOutboxScopeRecord = {
        accountScope: persisted.accountScope,
        roomIdentifier: persisted.roomIdentifier,
        storageMode: persisted.storageMode,
        threadRootId: persisted.threadRootId,
        replyTo: persisted.replyTo,
      };
      rememberBoundedScope(knownOutboxScopes, trimmedId, record);
      return record;
    }
    return unsavedCloudFallbackScopes.get(trimmedId) ?? null;
  } catch (error) {
    const fallback = knownOutboxScopes.get(trimmedId) ?? unsavedCloudFallbackScopes.get(trimmedId);
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

export function consumeUnsavedCloudFallbackScope(clientMessageId: string | null | undefined): void {
  const trimmedId = clientMessageId?.trim() || "";
  if (trimmedId) {
    unsavedCloudFallbackScopes.delete(trimmedId);
  }
}
