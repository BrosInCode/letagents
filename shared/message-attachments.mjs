/**
 * The one client contract for staging a room message attachment.
 *
 * Every desktop process that sends a file to a cloud room (the Electron main
 * process for people, the supervisor daemon for agents) stages it the same way:
 *   1. POST {roomPath}/attachments/uploads with the file's name, type and size.
 *   2. PUT the bytes to the presigned storage URL the room returns.
 *   3. Send the message with the returned upload_id.
 * The caller supplies the transport, so this module never sees credentials.
 */

export const MESSAGE_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 4,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
});

const MIME_TYPES_BY_EXTENSION = Object.freeze({
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
});

export function guessMessageAttachmentMimeType(fileName) {
  const extension = String(fileName || "").split(".").pop()?.toLowerCase();
  return (extension && MIME_TYPES_BY_EXTENSION[extension]) || "application/octet-stream";
}

export function formatMessageAttachmentLimit(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function assertMessageAttachmentFits(fileName, byteSize) {
  if (byteSize > MESSAGE_ATTACHMENT_LIMITS.maxFileBytes) {
    throw new Error(`${fileName} is larger than ${formatMessageAttachmentLimit(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes)}.`);
  }
}

/** Read the room's upload slot strictly: the server always answers with these fields. */
export function parseMessageAttachmentUploadTarget(value) {
  const target = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const uploadId = typeof target.upload_id === "string" ? target.upload_id.trim() : "";
  const uploadUrl = typeof target.upload_url === "string" ? target.upload_url.trim() : "";
  if (!uploadId || !uploadUrl || (target.method !== undefined && target.method !== "PUT")) {
    throw new Error("The room returned an incomplete attachment upload slot.");
  }
  const headers = {};
  if (target.headers && typeof target.headers === "object" && !Array.isArray(target.headers)) {
    for (const [name, headerValue] of Object.entries(target.headers)) {
      if (typeof headerValue === "string") headers[name] = headerValue;
    }
  }
  return { uploadId, uploadUrl, headers };
}

export async function stageCloudMessageAttachment(transport, input) {
  const sizeBytes = input.bytes.byteLength;
  assertMessageAttachmentFits(input.fileName, sizeBytes);
  const target = parseMessageAttachmentUploadTarget(await transport.requestJson(`${input.roomPath}/attachments/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: input.fileName, content_type: input.mimeType, byte_size: sizeBytes }),
  }));
  const headers = new Headers(target.headers);
  if (!headers.has("content-type")) headers.set("Content-Type", input.mimeType);
  const discard = () => discardCloudMessageAttachment(transport, { roomPath: input.roomPath, uploadId: target.uploadId }).catch(() => undefined);
  let response;
  try {
    response = await (transport.fetch ?? fetch)(target.uploadUrl, { method: "PUT", headers, body: input.bytes });
  } catch (error) {
    await discard();
    throw error;
  }
  if (!response.ok) {
    await discard();
    throw new Error(`${input.fileName} upload failed with HTTP ${response.status}.`);
  }
  return { uploadId: target.uploadId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes };
}

export async function discardCloudMessageAttachment(transport, input) {
  await transport.requestJson(`${input.roomPath}/attachments/uploads/${encodeURIComponent(input.uploadId)}`, { method: "DELETE" });
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** What an agent passes to set_reply_attachments: 1 to 4 workspace paths, or null to clear its choice. */
export function validReplyAttachmentsRequest(value) {
  if (!exactKeys(value, ["files"])) return false;
  if (value.files === null) return true;
  return Array.isArray(value.files) && value.files.length >= 1 && value.files.length <= MESSAGE_ATTACHMENT_LIMITS.maxFiles
    && value.files.every((file) => typeof file === "string" && file.trim().length > 0 && file.length <= 4096 && !file.includes("\0"));
}

const RECORD_KEYS = ["spool_id", "name", "mime_type", "size_bytes", "sha256"];

/** What the daemon journals after it copies the files: no path, only the spool copy's identity. */
export function validRecordedReplyAttachments(value) {
  if (!exactKeys(value, ["files"])) return false;
  if (value.files === null) return true;
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > MESSAGE_ATTACHMENT_LIMITS.maxFiles) return false;
  let total = 0;
  for (const file of value.files) {
    if (!exactKeys(file, RECORD_KEYS)
      || typeof file.spool_id !== "string" || !/^[0-9a-f]{32}$/.test(file.spool_id)
      || typeof file.name !== "string" || !file.name || file.name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(file.name)
      || typeof file.mime_type !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(file.mime_type)
      || !Number.isInteger(file.size_bytes) || file.size_bytes <= 0 || file.size_bytes > MESSAGE_ATTACHMENT_LIMITS.maxFileBytes
      || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) return false;
    total += file.size_bytes;
  }
  return total <= MESSAGE_ATTACHMENT_LIMITS.maxTotalBytes;
}
