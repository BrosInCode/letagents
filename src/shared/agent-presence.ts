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
export const ACTIVE_AGENT_DELIVERY_WINDOW_MS = ACTIVE_AGENT_PRESENCE_WINDOW_MS;
export const ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS = 30_000;
export const ROOM_AGENT_RECONNECT_GRACE_MS = 10_000;

export const ROOM_AGENT_DELIVERY_TRANSPORTS = [
  "long_poll",
  "sse",
] as const;

export type RoomAgentDeliveryTransport = (typeof ROOM_AGENT_DELIVERY_TRANSPORTS)[number];

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

export function getAgentPresenceFreshnessFromReachability(
  isReachable: boolean
): AgentPresenceFreshness {
  return isReachable ? "active" : "stale";
}

export function isAgentDeliverySessionReachable(input: {
  activeConnectionCount: number;
  updatedAt: string | null | undefined;
}, now = Date.now()): boolean {
  if (input.activeConnectionCount <= 0) {
    return false;
  }

  return getAgentPresenceFreshness(input.updatedAt ?? "", now) === "active";
}
