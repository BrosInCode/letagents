const INLINE_FILE_BYTE_FIELDS = new Set(["data_url", "content_base64"]);
/**
 * A file's name, type and identity are the sender's words; they stay even when
 * they look like a data URL, but such a value is cut short, so a name cannot
 * carry a file's bytes either.
 */
const METADATA_FIELDS = new Set(["id", "name", "file_name", "filename", "mime_type", "content_type"]);
const METADATA_DATA_URL_LIMIT = 256;
const DATA_URL = /^\s*data:[^,]{0,256},/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** An attachment's metadata without a copy of its bytes; any other field stays. */
function attachmentMetadata(value: unknown): unknown {
  const file = record(value);
  if (!file) return value;
  let changed = false;
  const kept = Object.entries(file).flatMap(([key, field]): Array<[string, unknown]> => {
    const dataUrl = typeof field === "string" && DATA_URL.test(field);
    if (INLINE_FILE_BYTE_FIELDS.has(key) || (dataUrl && !METADATA_FIELDS.has(key))) {
      changed = true;
      return [];
    }
    if (dataUrl && field.length > METADATA_DATA_URL_LIMIT) {
      changed = true;
      return [[key, `${field.slice(0, METADATA_DATA_URL_LIMIT)}…`]];
    }
    return [[key, field]];
  });
  return changed ? Object.fromEntries(kept) : value;
}

/**
 * A local room message can carry its files' bytes inline, and the daemon keeps
 * that copy. As agent text it is only noise and tokens: the attachment notes
 * describe each file, and an image reaches the agent as an image. Every
 * attachment list, wherever it is nested (a reply preview, a thread's latest
 * reply, a queued peer message, a tool result), keeps its metadata only.
 * Durable data is never changed; a value that holds no inline bytes is
 * returned as it is.
 */
export function withoutInlineFileBytes(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 16) return value;
  const each = (list: unknown[], visit: (item: unknown) => unknown): unknown[] => {
    const items = list.map(visit);
    return items.some((item, index) => item !== list[index]) ? items : list;
  };
  if (Array.isArray(value)) return each(value, item => withoutInlineFileBytes(item, depth + 1));
  let copy: Record<string, unknown> | null = null;
  for (const [key, field] of Object.entries(value)) {
    const next = key === "attachments" && Array.isArray(field)
      ? each(field, item => withoutInlineFileBytes(attachmentMetadata(item), depth + 1))
      : withoutInlineFileBytes(field, depth + 1);
    if (next !== field) (copy ??= { ...value as Record<string, unknown> })[key] = next;
  }
  return copy ?? value;
}
