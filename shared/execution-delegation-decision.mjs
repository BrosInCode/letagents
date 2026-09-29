export const EXECUTION_DELEGATION_DECISIONS = ["allow_once", "deny"];
export const EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS = 24 * 60 * 60 * 1000;

export function isExecutionDelegationDecision(value) {
  return EXECUTION_DELEGATION_DECISIONS.includes(value);
}

const INTENT_KEYS = [
  "decision_id",
  "delegation_instance_id",
  "delegation_revision",
  "actor_account_id",
  "request_id",
  "request_version",
  "request_sha256",
  "projection_sha256",
  "decision",
  "decided_at",
  "owner_account_id",
  "room_id",
  "agent_key",
  "approver_account_id",
  "category",
  "risk_ceiling",
  "scope_sha256",
];

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function isExecutionDelegationIdentity(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isExecutionDelegationDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isExecutionDelegationPositiveInt32(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

/** Return the exact host-delivered decision intent, or reject it as a whole. */
export function parseExecutionDelegationDecisionIntent(value) {
  if (!exactKeys(value, INTENT_KEYS)
    || !isExecutionDelegationIdentity(value.decision_id)
    || !isExecutionDelegationIdentity(value.delegation_instance_id)
    || !isExecutionDelegationPositiveInt32(value.delegation_revision)
    || !isExecutionDelegationIdentity(value.actor_account_id)
    || !isExecutionDelegationIdentity(value.request_id)
    || !isExecutionDelegationPositiveInt32(value.request_version)
    || !isExecutionDelegationDigest(value.request_sha256)
    || !isExecutionDelegationDigest(value.projection_sha256)
    || !isExecutionDelegationDecision(value.decision)
    || typeof value.decided_at !== "string" || !Number.isFinite(Date.parse(value.decided_at))
    || !isExecutionDelegationIdentity(value.owner_account_id)
    || !isExecutionDelegationIdentity(value.room_id)
    || !isExecutionDelegationIdentity(value.agent_key)
    || !isExecutionDelegationIdentity(value.approver_account_id)
    || value.actor_account_id !== value.approver_account_id
    || value.category !== "file_change"
    || value.risk_ceiling !== "low"
    || !isExecutionDelegationDigest(value.scope_sha256)) return null;

  return Object.fromEntries(INTENT_KEYS.map((key) => [key, value[key]]));
}
