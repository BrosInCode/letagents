import { ATTACHMENT_PREVIEW_BYTE_LIMIT, isDesktopAttachmentHref } from "../../../../../shared/message-attachments.mjs";
import type { DesktopRoomMessageAttachment } from "../../../electron/ipc-types";

const types = { txt: "Text", log: "Log", json: "JSON", jsonl: "JSONL", ndjson: "NDJSON" } as const;
export type AttachmentTextType = typeof types[keyof typeof types];
const textMimeTypes = new Set([
  "", "text/plain", "application/octet-stream", "application/json",
  "application/ndjson", "application/x-ndjson", "application/jsonl", "application/x-jsonlines",
]);

export function attachmentPreviewType(attachment: DesktopRoomMessageAttachment): AttachmentTextType | null {
  if (!isDesktopAttachmentHref(attachment.href)) return null;
  if (!textMimeTypes.has(attachment.mimeType.split(";")[0]!.trim().toLowerCase())) return null;
  if ((attachment.sizeBytes ?? 0) > ATTACHMENT_PREVIEW_BYTE_LIMIT) return null;
  const extension = /\.([a-z]+)$/i.exec(attachment.fileName)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(types, extension) ? types[extension as keyof typeof types] : null;
}

function parseRecordJson(text: string): unknown {
  // Rows must not round identifiers or turn infinite values into null.
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new Error("Use the raw view to preserve the exact number.");
    }
    return value;
  }) as unknown;
}

export function attachmentTable(type: AttachmentTextType, text: string): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (type === "Text" || type === "Log") return null;
  try {
    const source = text.replace(/^\uFEFF/, "");
    const value: unknown = type === "JSON"
      ? parseRecordJson(source)
      : source.split(/\r?\n/).filter(line => line.trim()).map(parseRecordJson);
    if (!Array.isArray(value) || !value.length || value.length > 3000 ||
      !value.every(row => row && typeof row === "object" && !Array.isArray(row))) return null;
    const rows = value as Record<string, unknown>[];
    const columns = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        columns.add(key);
        if (columns.size > 24) return null;
      }
    }
    return columns.size ? { columns: [...columns], rows } : null;
  } catch { return null; }
}

export function attachmentCell(row: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(row, key)) return "—";
  const value = row[key];
  return typeof value === "string" ? value : JSON.stringify(value) ?? "—";
}
