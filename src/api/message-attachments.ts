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

function sanitizeFilename(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  const safe = trimmed
    .replace(/[\u0000-\u001f\u007f]/g, "")
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
    throw new Error("attachment byte_size must be a positive integer");
  }
  if (size > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds the ${MAX_MESSAGE_ATTACHMENT_BYTES} byte limit`);
  }
  return size;
}

export function normalizeAttachmentUploadRequest(value: unknown): NormalizedAttachmentUploadRequest {
  if (!value || typeof value !== "object") {
    throw new Error("attachment upload metadata is required");
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
    throw new Error("attachments must be an array");
  }
  if (value.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`messages can include at most ${MAX_MESSAGE_ATTACHMENTS} attachments`);
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
      throw new Error("attachments must reference valid upload_id values");
    }
    if (seen.has(normalized)) {
      throw new Error("duplicate attachment upload_id values are not allowed");
    }
    seen.add(normalized);
    return { upload_id: normalized };
  });
}

export function assertAttachmentTotalByteSize(attachments: readonly { byte_size: number }[]): void {
  const total = attachments.reduce((sum, attachment) => sum + attachment.byte_size, 0);
  if (total > MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES) {
    throw new Error(`message attachments exceed the ${MAX_MESSAGE_ATTACHMENT_TOTAL_BYTES} byte total limit`);
  }
}

export function formatAttachmentContentDisposition(filename: string): string {
  const safe = sanitizeFilename(filename).replace(/["\\]/g, "_");
  return `inline; filename="${safe}"`;
}
