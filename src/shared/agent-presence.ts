export const AGENT_PRESENCE_STATUSES = [
  "idle",
  "working",
  "reviewing",
  "blocked",
] as const;

export type AgentPresenceStatus = (typeof AGENT_PRESENCE_STATUSES)[number];

export const AGENT_PRESENCE_FRESHNESS = [
  "active",
  "stale",
] as const;

export type AgentPresenceFreshness = (typeof AGENT_PRESENCE_FRESHNESS)[number];

export const ACTIVE_AGENT_PRESENCE_WINDOW_MS = 90_000;

export function normalizeAgentPresenceStatus(value: unknown): AgentPresenceStatus | null {
  const normalized = String(value || "").trim().toLowerCase();
  return AGENT_PRESENCE_STATUSES.includes(normalized as AgentPresenceStatus)
    ? (normalized as AgentPresenceStatus)
    : null;
}

export function getAgentPresenceFreshness(
  lastHeartbeatAt: string,
  now = Date.now()
): AgentPresenceFreshness {
  const heartbeatTime = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(heartbeatTime)) {
    return "stale";
  }

  return now - heartbeatTime <= ACTIVE_AGENT_PRESENCE_WINDOW_MS
    ? "active"
    : "stale";
}
