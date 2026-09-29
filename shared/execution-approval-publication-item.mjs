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

/** Parse the exact public inventory item shared by the API and browser. */
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
