import { createHash } from "node:crypto";

import {
  parseExecutionApprovalProjectionV1,
  serializeExecutionApprovalProjectionV1,
} from "./execution-approval-projection.mjs";

export const EXECUTION_APPROVAL_PUBLICATION_VERSION = 1;
export const EXECUTION_APPROVAL_PUBLICATION_MAX_JSON_BYTES = 24 * 1024;

const INPUT_KEYS = [
  "version",
  "room_id",
  "source_message_id",
  "delegation_instance_id",
  "delegation_revision",
  "request_id",
  "request_version",
  "request_sha256",
  "projection_sha256",
  "projection_json",
  "produced_at",
  "expires_at",
];
const ITEM_KEYS = [
  "publication_id",
  "room_id",
  "agent_key",
  "delegation_instance_id",
  "delegation_revision",
  "request_id",
  "request_version",
  "request_sha256",
  "projection_sha256",
  "published_at",
  "expires_at",
];
const RECEIPT_KEYS = ["status", "publication_digest", "publication"];
const CLOSE_INPUT_KEYS = ["publication_digest"];
const CLOSE_RECEIPT_KEYS = ["status", "publication_id", "publication_digest", "closed_at"];

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function isExecutionApprovalPublicationIdentity(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isExecutionApprovalPublicationDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isExecutionApprovalPublicationVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function sourceMessage(value) {
  return typeof value === "string"
    && /^msg_[1-9]\d{0,9}$/.test(value)
    && Number(value.slice(4)) <= 2_147_483_647;
}

function canonicalProjection(value) {
  if (typeof value !== "string"
    || new TextEncoder().encode(value).byteLength > EXECUTION_APPROVAL_PUBLICATION_MAX_JSON_BYTES) return false;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return false; }
  const projection = parseExecutionApprovalProjectionV1(parsed);
  return projection !== null && serializeExecutionApprovalProjectionV1(projection) === value;
}

/** Parse exact daemon-to-server publication bytes; digest verification remains the receiver's job. */
export function parseExecutionApprovalPublicationInput(value) {
  if (!exactKeys(value, INPUT_KEYS)
    || value.version !== EXECUTION_APPROVAL_PUBLICATION_VERSION
    || !isExecutionApprovalPublicationIdentity(value.room_id)
    || !sourceMessage(value.source_message_id)
    || !isExecutionApprovalPublicationIdentity(value.delegation_instance_id)
    || !isExecutionApprovalPublicationVersion(value.delegation_revision)
    || !isExecutionApprovalPublicationIdentity(value.request_id)
    || !isExecutionApprovalPublicationVersion(value.request_version)
    || !isExecutionApprovalPublicationDigest(value.request_sha256)
    || !isExecutionApprovalPublicationDigest(value.projection_sha256)
    || !canonicalProjection(value.projection_json)) return null;
  const producedAt = canonicalTimestamp(value.produced_at);
  const expiresAt = canonicalTimestamp(value.expires_at);
  if (producedAt === null || expiresAt === null || expiresAt <= producedAt) return null;
  return Object.fromEntries(INPUT_KEYS.map((key) => [key, value[key]]));
}

export function parseExecutionApprovalPublicationItem(value) {
  if (!exactKeys(value, ITEM_KEYS)
    || !isExecutionApprovalPublicationIdentity(value.publication_id)
    || !isExecutionApprovalPublicationIdentity(value.room_id)
    || !isExecutionApprovalPublicationIdentity(value.agent_key)
    || !isExecutionApprovalPublicationIdentity(value.delegation_instance_id)
    || !isExecutionApprovalPublicationVersion(value.delegation_revision)
    || !isExecutionApprovalPublicationIdentity(value.request_id)
    || !isExecutionApprovalPublicationVersion(value.request_version)
    || !isExecutionApprovalPublicationDigest(value.request_sha256)
    || !isExecutionApprovalPublicationDigest(value.projection_sha256)) return null;
  const publishedAt = canonicalTimestamp(value.published_at);
  const expiresAt = canonicalTimestamp(value.expires_at);
  if (publishedAt === null || expiresAt === null || expiresAt <= publishedAt) return null;
  return Object.fromEntries(ITEM_KEYS.map((key) => [key, value[key]]));
}

export function parseExecutionApprovalPublicationReceipt(value) {
  if (!exactKeys(value, RECEIPT_KEYS)
    || !["created", "replayed"].includes(value.status)
    || !isExecutionApprovalPublicationDigest(value.publication_digest)) return null;
  const publication = parseExecutionApprovalPublicationItem(value.publication);
  return publication ? {
    status: value.status,
    publication_digest: value.publication_digest,
    publication,
  } : null;
}

/** Parse the content-free host acknowledgement that a publication is no longer actionable. */
export function parseExecutionApprovalPublicationCloseInput(value) {
  return exactKeys(value, CLOSE_INPUT_KEYS)
    && isExecutionApprovalPublicationDigest(value.publication_digest)
    ? { publication_digest: value.publication_digest }
    : null;
}

export function parseExecutionApprovalPublicationCloseReceipt(value) {
  if (!exactKeys(value, CLOSE_RECEIPT_KEYS)
    || !["closed", "replayed"].includes(value.status)
    || !isExecutionApprovalPublicationIdentity(value.publication_id)
    || !isExecutionApprovalPublicationDigest(value.publication_digest)
    || canonicalTimestamp(value.closed_at) === null) return null;
  return Object.fromEntries(CLOSE_RECEIPT_KEYS.map((key) => [key, value[key]]));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest exact, validated publication input with the server's stable-key wire algorithm. */
export function executionApprovalPublicationSha256(value) {
  const publication = parseExecutionApprovalPublicationInput(value);
  return publication === null
    ? null
    : createHash("sha256").update(stableJson(publication), "utf8").digest("hex");
}
