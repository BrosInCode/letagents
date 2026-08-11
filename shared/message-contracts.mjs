import { normalizeRoutingSender } from "./routing-aliases.mjs";

export const POSTGRES_INTEGER_MAX = 2_147_483_647;
export const MESSAGE_SENDER_MAX_CODE_POINTS = 512;
export const MESSAGE_SENDER_MAX_UTF8_BYTES = 2_048;

/** Parse the canonical `<prefix>_<positive PostgreSQL integer>` wire form. */
export function parsePositivePgIntegerScopedId(value, prefix) {
  if (typeof value !== "string" || typeof prefix !== "string" || !prefix) return null;
  const marker = `${prefix}_`;
  if (!value.startsWith(marker)) return null;
  const decimal = value.slice(marker.length);
  if (!/^[1-9]\d*$/.test(decimal)) return null;
  const parsed = Number(decimal);
  return Number.isSafeInteger(parsed) && parsed <= POSTGRES_INTEGER_MAX ? parsed : null;
}

/** Bound sender labels before routing projections duplicate their raw value. */
export function isMessageSenderWithinBounds(sender) {
  if (typeof sender !== "string") return false;
  let codePoints = 0;
  for (const _character of sender) {
    codePoints += 1;
    if (codePoints > MESSAGE_SENDER_MAX_CODE_POINTS) return false;
  }
  return new TextEncoder().encode(sender).byteLength <= MESSAGE_SENDER_MAX_UTF8_BYTES;
}

/**
 * Parse the account-scoped routing envelope shared by Desktop and MCP.
 * Undefined means an older/local message supplied no authority. Any present
 * malformed shape returns explicit invalid authority and must never fall back
 * to mutable display aliases.
 */
export function parseAccountAgentRoutingEnvelope(routing) {
  if (routing === undefined) return undefined;
  if (!routing || typeof routing !== "object" || routing.version !== 1) {
    return { version: 1, authority: "invalid" };
  }
  if (routing.authority !== "receipts" && routing.authority !== "legacy") {
    return { version: 1, authority: "invalid" };
  }
  if (
    !Array.isArray(routing.recipient_agent_keys)
    || !routing.recipient_agent_keys.every((value) => typeof value === "string")
    || !Array.isArray(routing.recipient_agent_sessions)
  ) {
    return { version: 1, authority: "invalid" };
  }
  const recipientAgentKeys = routing.recipient_agent_keys.map(normalizeRoutingSender);
  if (recipientAgentKeys.some((value) => !value)) {
    return { version: 1, authority: "invalid" };
  }
  const uniqueKeys = new Set(recipientAgentKeys);
  if (uniqueKeys.size !== recipientAgentKeys.length) {
    return { version: 1, authority: "invalid" };
  }
  const targetKeys = new Set();
  const recipientSessions = [];
  for (const value of routing.recipient_agent_sessions) {
    if (!value || typeof value !== "object") {
      return { version: 1, authority: "invalid" };
    }
    const agentKey = typeof value.agent_key === "string"
      ? normalizeRoutingSender(value.agent_key)
      : "";
    const agentSessionId = typeof value.agent_session_id === "string"
      ? value.agent_session_id.trim()
      : "";
    if (!agentKey || !agentSessionId || targetKeys.has(agentKey)) {
      return { version: 1, authority: "invalid" };
    }
    targetKeys.add(agentKey);
    if (routing.authority === "receipts") {
      const successorAgentSessionId = value.successor_agent_session_id === undefined
        ? undefined
        : typeof value.successor_agent_session_id === "string"
          ? value.successor_agent_session_id.trim()
          : "";
      if (successorAgentSessionId !== undefined && !successorAgentSessionId) {
        return { version: 1, authority: "invalid" };
      }
      recipientSessions.push({
        agentKey,
        agentSessionId,
        ...(successorAgentSessionId ? { successorAgentSessionId } : {}),
      });
    } else {
      const activationReason = typeof value.activation_reason === "string"
        ? value.activation_reason.trim()
        : "";
      if (!activationReason) return { version: 1, authority: "invalid" };
      recipientSessions.push({ agentKey, agentSessionId, activationReason });
    }
  }
  if (
    targetKeys.size !== uniqueKeys.size
    || [...uniqueKeys].some((key) => !targetKeys.has(key))
  ) {
    return { version: 1, authority: "invalid" };
  }
  return {
    version: 1,
    authority: routing.authority,
    recipientAgentKeys: [...uniqueKeys],
    recipientSessions,
    controlAuthorized: routing.control_authorized === true,
  };
}
