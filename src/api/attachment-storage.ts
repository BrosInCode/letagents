import crypto from "node:crypto";

import {
  formatAttachmentContentDisposition,
  MESSAGE_ATTACHMENT_UPLOAD_TTL_SECONDS,
} from "./message-attachments.js";

interface AttachmentStorageConfig {
  provider: "s3";
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  uploadExpiresSeconds: number;
  downloadExpiresSeconds: number;
}

export interface AttachmentObjectDescriptor {
  object_key: string;
  filename: string;
  content_type: string;
  byte_size: number;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getAttachmentStorageConfig(): AttachmentStorageConfig {
  const bucket = env("ATTACHMENT_S3_BUCKET") ?? env("S3_BUCKET");
  const accessKeyId = env("ATTACHMENT_S3_ACCESS_KEY_ID") ?? env("AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("ATTACHMENT_S3_SECRET_ACCESS_KEY") ?? env("AWS_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("attachment object storage is not configured");
  }

  const endpoint = env("ATTACHMENT_S3_ENDPOINT");
  const forcePathStyleRaw = env("ATTACHMENT_S3_FORCE_PATH_STYLE");
  return {
    provider: "s3",
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env("ATTACHMENT_S3_REGION") ?? env("AWS_REGION") ?? "us-east-1",
    endpoint,
    forcePathStyle: forcePathStyleRaw
      ? ["1", "true", "yes"].includes(forcePathStyleRaw.toLowerCase())
      : Boolean(endpoint),
    uploadExpiresSeconds: envNumber(
      "ATTACHMENT_S3_UPLOAD_EXPIRES_SECONDS",
      MESSAGE_ATTACHMENT_UPLOAD_TTL_SECONDS
    ),
    downloadExpiresSeconds: envNumber("ATTACHMENT_S3_DOWNLOAD_EXPIRES_SECONDS", 5 * 60),
  };
}

export function isAttachmentStorageConfigured(): boolean {
  try {
    getAttachmentStorageConfig();
    return true;
  } catch {
    return false;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodePathSegment).join("/");
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function signingKey(config: AttachmentStorageConfig, date: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function resolveObjectUrl(config: AttachmentStorageConfig, objectKey: string): { url: URL; canonicalUri: string } {
  const encodedKey = encodeObjectKey(objectKey);
  if (config.endpoint) {
    const endpoint = new URL(config.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    if (config.forcePathStyle) {
      endpoint.pathname = `${basePath}/${encodePathSegment(config.bucket)}/${encodedKey}`;
    } else {
      endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `${basePath}/${encodedKey}`;
    }
    return { url: endpoint, canonicalUri: endpoint.pathname || "/" };
  }

  const url = new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`);
  return { url, canonicalUri: url.pathname };
}

function amzTimestamp(date: Date): { dateStamp: string; dateTime: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    dateStamp: iso.slice(0, 8),
    dateTime: iso,
  };
}

function presignS3Url(input: {
  method: "GET" | "PUT";
  objectKey: string;
  expiresSeconds: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}): string {
  const config = getAttachmentStorageConfig();
  const { dateStamp, dateTime } = amzTimestamp(new Date());
  const { url, canonicalUri } = resolveObjectUrl(config, input.objectKey);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const query = new Map<string, string>([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", dateTime],
    ["X-Amz-Expires", String(input.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ]);
  if (input.responseContentDisposition) {
    query.set("response-content-disposition", input.responseContentDisposition);
  }
  if (input.responseContentType) {
    query.set("response-content-type", input.responseContentType);
  }

  const sortedQuery = [...query.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeQueryValue(key)}=${encodeQueryValue(value)}`)
    .join("&");
  const canonicalHeaders = `host:${url.host}\n`;
  const canonicalRequest = [
    input.method,
    canonicalUri,
    sortedQuery,
    canonicalHeaders,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(config, dateStamp))
    .update(stringToSign, "utf8")
    .digest("hex");

  url.search = `${sortedQuery}&X-Amz-Signature=${signature}`;
  return url.toString();
}

export function createAttachmentObjectKey(input: {
  roomId: string;
  uploadId: string;
  filename: string;
}): string {
  const safeRoom = input.roomId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
  const safeFilename = input.filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || "attachment";
  return `rooms/${safeRoom}/uploads/${input.uploadId}/${safeFilename}`;
}

export function createPresignedAttachmentUpload(input: AttachmentObjectDescriptor): {
  upload_url: string;
  headers: Record<string, string>;
  storage_provider: "s3";
  bucket: string;
  expires_at: string;
} {
  const config = getAttachmentStorageConfig();
  const upload_url = presignS3Url({
    method: "PUT",
    objectKey: input.object_key,
    expiresSeconds: config.uploadExpiresSeconds,
  });
  return {
    upload_url,
    headers: {
      "Content-Type": input.content_type,
    },
    storage_provider: config.provider,
    bucket: config.bucket,
    expires_at: new Date(Date.now() + config.uploadExpiresSeconds * 1000).toISOString(),
  };
}

export function createPresignedAttachmentDownload(input: {
  object_key: string;
  filename: string;
  content_type: string;
}): string {
  const config = getAttachmentStorageConfig();
  return presignS3Url({
    method: "GET",
    objectKey: input.object_key,
    expiresSeconds: config.downloadExpiresSeconds,
    responseContentDisposition: formatAttachmentContentDisposition(input.filename),
    responseContentType: input.content_type,
  });
}
