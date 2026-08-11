import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopRoomStorageState } from "../../ipc-types.js";
import { parsePositivePgIntegerScopedId } from "../../../../../shared/message-contracts.mjs";
import { readStoredAuth } from "../auth.js";
import { apiUrl, attachmentProtocolScheme } from "../paths.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
} from "../rooms/local-store.js";
import {
  getLocalChatMessageAttachment,
  type LocalAttachmentRow,
} from "../rooms/messages/local-store.js";
import type { RoomMessageAttachmentPayload } from "../attachments.js";

export const AGENT_READABLE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const MAX_AGENT_READABLE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/**
 * Minimal attachment shape shared by DesktopRoomMessage attachments
 * (camelCase) and RoomMessageAttachmentPayload rows (snake_case) after
 * normalization.
 */
export interface AgentAttachmentSource {
  id: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface AgentMessageAttachmentDescriptor {
  id: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  image: boolean;
  read_tool?: "read_message_attachment";
  read_arguments?: { message_id: string; attachment_id: string };
}

export function normalizeAgentAttachmentSource(attachment: {
  id?: string | null;
  name?: string | null;
  fileName?: string | null;
  file_name?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  mime_type?: string | null;
  content_type?: string | null;
  sizeBytes?: number | null;
  size_bytes?: number | null;
  byte_size?: number | null;
  /* Byte-bearing fields are accepted so callers can pass full attachment
     payloads, but they never reach descriptors. */
  url?: string | null;
  download_url?: string | null;
  downloadUrl?: string | null;
  data_url?: string | null;
  dataUrl?: string | null;
  content_base64?: string | null;
  contentBase64?: string | null;
}): AgentAttachmentSource {
  return {
    id: attachment.id ?? null,
    fileName: attachment.fileName ?? attachment.file_name ?? attachment.filename ?? attachment.name ?? null,
    mimeType: attachment.mimeType ?? attachment.mime_type ?? attachment.content_type ?? null,
    sizeBytes: attachment.sizeBytes ?? attachment.size_bytes ?? attachment.byte_size ?? null,
  };
}

export function isAgentReadableImageMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() || "";
  return AGENT_READABLE_IMAGE_MIME_TYPES.has(normalized);
}

export function describeAgentMessageAttachments(
  messageId: string,
  attachments: ReadonlyArray<Parameters<typeof normalizeAgentAttachmentSource>[0]> | null | undefined,
): AgentMessageAttachmentDescriptor[] {
  return (attachments || []).map((raw) => {
    const source = normalizeAgentAttachmentSource(raw);
    const image = isAgentReadableImageMimeType(source.mimeType);
    const descriptor: AgentMessageAttachmentDescriptor = {
      id: source.id,
      file_name: source.fileName,
      mime_type: source.mimeType,
      size_bytes: source.sizeBytes,
      image,
    };
    if (image && source.id) {
      descriptor.read_tool = "read_message_attachment";
      descriptor.read_arguments = { message_id: messageId, attachment_id: source.id };
    }
    return descriptor;
  });
}

/**
 * Replaces a room message's attachments with compact descriptors so tool
 * results never inline attachment bytes (a local screenshot otherwise ships
 * megabytes of base64 into the agent prompt).
 */
export function toAgentReadableRoomMessage<
  T extends { id: string; attachments?: ReadonlyArray<Parameters<typeof normalizeAgentAttachmentSource>[0]> | null },
>(message: T): Omit<T, "attachments"> & { attachments: AgentMessageAttachmentDescriptor[] } {
  return {
    ...message,
    attachments: describeAgentMessageAttachments(message.id, message.attachments),
  };
}

const MAX_EVENT_ATTACHMENT_LINES = 8;

/** Prompt lines describing a message's attachments in desktop event prompts. */
export function describeDesktopEventMessageAttachments(message: {
  id: string;
  attachments?: ReadonlyArray<Parameters<typeof normalizeAgentAttachmentSource>[0]> | null;
}): string[] {
  const descriptors = describeAgentMessageAttachments(message.id, message.attachments);
  if (!descriptors.length) {
    return [];
  }
  const lines = ["Attachments:"];
  for (const descriptor of descriptors.slice(0, MAX_EVENT_ATTACHMENT_LINES)) {
    const label = descriptor.file_name || descriptor.id || "attachment";
    const meta = [
      descriptor.mime_type || "unknown type",
      descriptor.size_bytes != null ? formatAttachmentBytes(descriptor.size_bytes) : null,
    ].filter(Boolean).join(", ");
    const hint = descriptor.image && descriptor.read_arguments
      ? ` — image; view it via the read_message_attachment desktop room tool with {"message_id":"${descriptor.read_arguments.message_id}","attachment_id":"${descriptor.read_arguments.attachment_id}"}`
      : "";
    lines.push(`- ${label} (${meta})${hint}`);
  }
  if (descriptors.length > MAX_EVENT_ATTACHMENT_LINES) {
    lines.push(`- (+${descriptors.length - MAX_EVENT_ATTACHMENT_LINES} more attachments)`);
  }
  return lines;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export interface ResolvedAgentAttachment {
  buffer: Buffer;
  fileName: string | null;
  mimeType: string | null;
}

export interface ResolveRoomMessageAttachmentDeps {
  fetchCloudMessageAttachments?: (
    cloudRoomIdentifier: string,
    messageId: string,
  ) => Promise<RoomMessageAttachmentPayload[] | null>;
  downloadApiAttachment?: (url: string) => Promise<Buffer>;
}

export async function resolveRoomMessageAttachment(input: {
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  messageId: string;
  attachmentId: string;
  maxBytes?: number;
  deps?: ResolveRoomMessageAttachmentDeps;
}): Promise<ResolvedAgentAttachment> {
  const maxBytes = input.maxBytes ?? MAX_AGENT_READABLE_ATTACHMENT_BYTES;
  const download = input.deps?.downloadApiAttachment ??
    ((url: string) => downloadApiAttachment(url, { maxBytes }));
  if (input.storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(input.storage, input.roomIdentifier);
    const row = await getLocalChatMessageAttachment(
      localRoomIdentifier,
      input.messageId,
      input.attachmentId,
    );
    if (!row) {
      throw new Error("That message has no attachment with this attachment_id.");
    }
    assertDeclaredSizeWithinLimit(row.size_bytes, maxBytes);
    return resolveFromLocalRow(row, download);
  }

  const fetchAttachments = input.deps?.fetchCloudMessageAttachments ?? fetchCloudMessageAttachmentPayloads;
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(input.storage, input.roomIdentifier);
  const attachments = await fetchAttachments(cloudRoomIdentifier, input.messageId);
  const attachment = (attachments || []).find((candidate) => candidate.id === input.attachmentId);
  if (!attachment) {
    throw new Error("That message has no attachment with this attachment_id.");
  }
  assertDeclaredSizeWithinLimit(attachment.size_bytes ?? attachment.byte_size ?? null, maxBytes);
  const fileName = attachment.file_name || attachment.filename || attachment.name || null;
  const mimeType = attachment.mime_type || attachment.content_type || null;
  if (attachment.content_base64) {
    return { buffer: Buffer.from(attachment.content_base64, "base64"), fileName, mimeType };
  }
  if (attachment.data_url) {
    return { buffer: bufferFromDataUrl(attachment.data_url), fileName, mimeType };
  }
  const remote = attachment.download_url || attachment.url;
  if (!remote) {
    throw new Error("Attachment content is not available for download.");
  }
  return { buffer: await download(remote), fileName, mimeType };
}

function assertDeclaredSizeWithinLimit(sizeBytes: number | null | undefined, maxBytes: number): void {
  if (sizeBytes != null && sizeBytes > maxBytes) {
    throw new Error(
      `Attachment is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB agent-readable limit.`,
    );
  }
}

function resolveFromLocalRow(
  row: LocalAttachmentRow,
  download: (url: string) => Promise<Buffer>,
): Promise<ResolvedAgentAttachment> | ResolvedAgentAttachment {
  if (row.content_base64) {
    return {
      buffer: Buffer.from(row.content_base64, "base64"),
      fileName: row.file_name,
      mimeType: row.mime_type,
    };
  }
  // The desktop staging flow stores a durable file: URL plus a downscaled
  // data_url preview, so the on-disk file must win over the preview.
  const fileUrl = [row.url, row.download_url].find((value) => value?.startsWith("file:"));
  if (fileUrl) {
    try {
      return {
        buffer: readFileSync(fileURLToPath(fileUrl)),
        fileName: row.file_name,
        mimeType: row.mime_type,
      };
    } catch {
      // Fall through to the preview/remote copies if the file was removed.
    }
  }
  if (row.data_url) {
    return {
      buffer: bufferFromDataUrl(row.data_url),
      fileName: row.file_name,
      mimeType: row.mime_type,
    };
  }
  const remote = [row.download_url, row.url].find((value) => value && !value.startsWith("file:"));
  if (!remote) {
    throw new Error("Attachment content is not available for download.");
  }
  return download(remote).then((buffer) => ({
    buffer,
    fileName: row.file_name,
    mimeType: row.mime_type,
  }));
}

function bufferFromDataUrl(dataUrl: string): Buffer {
  const match = /^data:[^;,]*(?:;charset=[^;,]*)?(;base64)?,(.*)$/s.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Attachment data URL could not be parsed.");
  }
  return match[1]
    ? Buffer.from(match[2] ?? "", "base64")
    : Buffer.from(decodeURIComponent(match[2] ?? ""), "utf8");
}

async function fetchCloudMessageAttachmentPayloads(
  cloudRoomIdentifier: string,
  messageId: string,
): Promise<RoomMessageAttachmentPayload[] | null> {
  const messageNumber = parsePositivePgIntegerScopedId(messageId, "msg");
  const params = new URLSearchParams();
  params.set("limit", "1");
  if (messageNumber !== null && messageNumber > 1) {
    params.set("after", `msg_${messageNumber - 1}`);
  }
  const { apiFetch } = await import("../auth.js");
  const page = await apiFetch<{
    messages?: Array<{ id?: string; attachments?: RoomMessageAttachmentPayload[] | null }>;
  }>(`/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages?${params.toString()}`);
  const message = (page.messages || []).find((candidate) => candidate.id === messageId);
  return message?.attachments ?? (message ? [] : null);
}

/**
 * Downloads an attachment from the LetAgents API. Accepts raw API paths,
 * absolute API URLs, and the renderer's proxied letagents-attachment://
 * scheme (which encodes the raw target). Any other origin is rejected.
 */
export async function downloadApiAttachment(
  url: string,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_AGENT_READABLE_ATTACHMENT_BYTES;
  const raw = unproxyAttachmentUrl(url);
  const apiOrigin = new URL(apiUrl).origin;
  const target = raw.startsWith("/") ? new URL(raw, apiOrigin) : new URL(raw);
  if (target.origin !== apiOrigin) {
    throw new Error("Attachment download target is outside the LetAgents API.");
  }
  const storedAuth = await readStoredAuth();
  const headers = new Headers();
  if (storedAuth.token) {
    headers.set("Authorization", `Bearer ${storedAuth.token}`);
  }
  const response = await fetch(target, { headers });
  if (!response.ok) {
    throw new Error(`Attachment download failed (${response.status}).`);
  }
  const declaredLength = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(oversizeDownloadError(maxBytes));
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(oversizeDownloadError(maxBytes));
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(oversizeDownloadError(maxBytes));
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function oversizeDownloadError(maxBytes: number): string {
  return `Attachment is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB agent-readable limit.`;
}

export function unproxyAttachmentUrl(url: string): string {
  const prefix = `${attachmentProtocolScheme}://download/`;
  if (!url.startsWith(prefix)) {
    return url;
  }
  return Buffer.from(url.slice(prefix.length), "base64url").toString("utf8");
}

export function agentAttachmentsRootDir(): string {
  return process.env.LETAGENTS_AGENT_ATTACHMENTS_DIR?.trim() ||
    join(homedir(), ".letagents", "desktop-agent-attachments");
}

/**
 * Writes attachment bytes into the per-session scratch directory (outside
 * any repo worktree so agent checkouts stay clean) and returns the absolute
 * path. Content-addressed names make repeated reads idempotent.
 */
export function materializeAgentSessionAttachment(input: {
  sessionKey: string;
  messageId: string;
  attachmentId: string;
  fileName: string | null;
  mimeType: string | null;
  buffer: Buffer;
}): string {
  const directory = join(agentAttachmentsRootDir(), sanitizePathSegment(input.sessionKey));
  mkdirSync(directory, { recursive: true });
  const hash = createHash("sha256").update(input.buffer).digest("hex").slice(0, 12);
  const safeName = sanitizeAttachmentFileName(input.fileName, input.mimeType);
  const filePath = join(
    directory,
    `${sanitizePathSegment(input.messageId)}-${sanitizePathSegment(input.attachmentId)}-${hash}-${safeName}`,
  );
  if (!existsSync(filePath)) {
    writeFileSync(filePath, input.buffer);
  }
  return filePath;
}

export function cleanupAgentSessionAttachments(sessionKey: string): void {
  const segment = sanitizePathSegment(sessionKey);
  if (!segment) {
    return;
  }
  rmSync(join(agentAttachmentsRootDir(), segment), { recursive: true, force: true });
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
}

function sanitizeAttachmentFileName(fileName: string | null, mimeType: string | null): string {
  const fallbackExtension = IMAGE_EXTENSION_BY_MIME[
    (mimeType || "").split(";")[0]?.trim().toLowerCase() || ""
  ] || "";
  const base = basename(fileName?.trim() || "");
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 80);
  if (!sanitized) {
    return `attachment${fallbackExtension}`;
  }
  return /\.[a-zA-Z0-9]{1,8}$/.test(sanitized) ? sanitized : `${sanitized}${fallbackExtension}`;
}
