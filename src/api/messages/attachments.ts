import { RequestValidationError } from "../validation-error.js";

export const MAX_MESSAGE_ATTACHMENTS = 4;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_UPLOAD_TTL_SECONDS = 15 * 60;

export interface NormalizedAttachmentUploadRequest {
  filename: string;
  content_type: string;
  byte_size: number;
}

export interface NormalizedMessageAttachmentReference {
  upload_id: string;
}

/**
 * The credential that staged an upload. Exactly one field is set: a worker
 * bearer stages as its agent session, and an app session or owner token
 * stages as its account. Only the same uploader can discard or attach it.
 */
export interface MessageAttachmentUploader {
  account_id: string | null;
  agent_session_id: string | null;
}

export function resolveMessageAttachmentUploader(input: {
  authKind?: string | null;
  sessionAccount?: { account_id?: string | null } | null;
  agentSession?: { agent_session_id?: string | null } | null;
}): MessageAttachmentUploader | null {
  if (input.authKind === "agent_session") {
    const agentSessionId = input.agentSession?.agent_session_id?.trim();
    return agentSessionId ? { account_id: null, agent_session_id: agentSessionId } : null;
  }
  const accountId = input.sessionAccount?.account_id?.trim();
  return accountId ? { account_id: accountId, agent_session_id: null } : null;
}

export function canStageMessageAttachment(input: Parameters<typeof resolveMessageAttachmentUploader>[0]): boolean {
  return resolveMessageAttachmentUploader(input) !== null;
}

function sanitizeFilename(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  const safe = trimmed
    // Control characters, and the direction marks that make "x\u202Efdp.exe" read as "xexe.pdf".
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .slice(0, 160)
    .trim();
  return safe || "attachment";
}

function normalizeContentType(value: unknown): string {
  if (typeof value !== "string") {
    return "application/octet-stream";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 120) {
    return "application/octet-stream";
  }
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function normalizeByteSize(value: unknown): number {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(size) || size <= 0) {
    throw new RequestValidationError("attachment byte_size must be a positive integer");
  }
  if (size > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new RequestValidationError(`attachment exceeds the ${MAX_MESSAGE_ATTACHMENT_BYTES} byte limit`);
  }
  return size;
}

export function normalizeAttachmentUploadRequest(value: unknown): NormalizedAttachmentUploadRequest {
  if (!value || typeof value !== "object") {
    throw new RequestValidationError("attachment upload metadata is required");
  }
  const input = value as Record<string, unknown>;
  return {
    filename: sanitizeFilename(
      typeof input.filename === "string"
        ? input.filename
        : typeof input.file_name === "string"
          ? input.file_name
          : "attachment"
    ),
    content_type: normalizeContentType(input.content_type ?? input.mime_type),
    byte_size: normalizeByteSize(input.byte_size ?? input.size_bytes),
  };
}

export function normalizeMessageAttachmentReferences(value: unknown): NormalizedMessageAttachmentReference[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RequestValidationError("attachments must be an array");
  }
  if (value.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new RequestValidationError(`messages can include at most ${MAX_MESSAGE_ATTACHMENTS} attachments`);
  }

  const seen = new Set<string>();
  return value.map((candidate) => {
    const uploadId = typeof candidate === "string"
      ? candidate
      : candidate && typeof candidate === "object"
        ? String((candidate as Record<string, unknown>).upload_id ?? "")
        : "";
    const normalized = uploadId.trim();
    if (!/^upl_[A-Za-z0-9_-]{16,}$/.test(normalized)) {
      throw new RequestValidationError("attachments must reference valid upload_id values");
    }
    if (seen.has(normalized)) {
      throw new RequestValidationError("duplicate attachment upload_id values are not allowed");
    }
    seen.add(normalized);
    return { upload_id: normalized };
  });
}

export function assertAttachmentTotalByteSize(attachments: readonly { byte_size: number }[]): void {
  const total = attachments.reduce((sum, attachment) => sum + attachment.byte_size, 0);
  if (total > MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES) {
    throw new RequestValidationError(`message attachments exceed the ${MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES} byte total limit`);
  }
}

/**
 * Passive media a browser may show in its own tab with its own type. None of
 * them can run script when opened straight from storage.
 */
const INLINE_ATTACHMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
  "application/pdf",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

/** Text files that open in the tab as plain text, which a browser never runs. */
const PLAIN_TEXT_ATTACHMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

/** Image tags need SVG's own type; an image tag never runs its script. */
const SVG_CONTENT_TYPE = "image/svg+xml";

export function formatAttachmentContentDisposition(
  filename: string,
  disposition: "inline" | "attachment" = "attachment",
): string {
  const safe = sanitizeFilename(filename).replace(/["\\]/g, "_");
  return `${disposition}; filename="${safe}"`;
}

/**
 * The headers storage sends with a download. Only passive media and plain
 * text open in the browser tab. Everything else downloads as plain bytes, so
 * a file from a room never runs as a page on the storage domain, even in a
 * browser that ignores the download hint. SVG downloads but keeps its type.
 */
export function resolveAttachmentDownloadHeaders(input: {
  filename: string;
  content_type: string;
}): { content_disposition: string; content_type: string } {
  const contentType = normalizeContentType(input.content_type);
  if (INLINE_ATTACHMENT_CONTENT_TYPES.has(contentType)) {
    return {
      content_disposition: formatAttachmentContentDisposition(input.filename, "inline"),
      content_type: contentType,
    };
  }
  if (PLAIN_TEXT_ATTACHMENT_CONTENT_TYPES.has(contentType)) {
    return {
      content_disposition: formatAttachmentContentDisposition(input.filename, "inline"),
      content_type: "text/plain; charset=utf-8",
    };
  }
  return {
    content_disposition: formatAttachmentContentDisposition(input.filename, "attachment"),
    content_type: contentType === SVG_CONTENT_TYPE ? SVG_CONTENT_TYPE : "application/octet-stream",
  };
}
