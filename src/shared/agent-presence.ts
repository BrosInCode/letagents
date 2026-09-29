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

/**
 * An agent's process holds one connection open for as long as it runs. While
 * it is open the server marks the session seen at this interval.
 */
export const AGENT_PROCESS_CONNECTION_REFRESH_MS = 30_000;
/**
 * The longest a living process waits before it reopens a connection that
 * dropped, or that the server could not serve.
 */
export const AGENT_PROCESS_RECONNECT_MAX_DELAY_MS = 5_000;
/** The server writes to an open connection at least this often. */
export const AGENT_PROCESS_CONNECTION_SILENT_AFTER_MS = 45_000;
/**
 * A process whose connection was seen to close, and that has not reopened it
 * in three times its longest wait, is gone if another process on the same
 * machine is reaching the server: they share the network, so one that is
 * alive would have come back.
 */
export const AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS = 3 * AGENT_PROCESS_RECONNECT_MAX_DELAY_MS;
/**
 * Seen from anywhere else, a closed or missing connection may be a machine
 * that is asleep or off the network. It is taken for gone only after this
 * long with no connection and no activity of any kind.
 */
export const AGENT_PROCESS_GONE_AFTER_MS = 10 * 60_000;

/** Recorded in place of a connection id when a process says it is exiting. */
export const AGENT_PROCESS_EXITED = "exited";

export interface AgentProcessEvidence {
  /** Null when the client never opened a process connection. */
  process_seen_at?: string | null;
  process_connection_id?: string | null;
  process_disconnected_at?: string | null;
  /** The machine the process runs on, as the process itself derived it. */
  process_host_id?: string | null;
  /** When the agent itself last made a room call. */
  agent_heard_at?: string | null;
  /** Also moved by the server's own bookkeeping for the session. */
  last_seen_at?: string | null;
  /** The session holds a delivery connection open right now. */
  delivery_connected?: boolean;
}

/**
 * Whether the process behind a session is gone.
 *
 * Activity cannot answer this: an agent that is busy, or waiting between room
 * calls, is unseen yet alive. Only the process connection can, so a session
 * whose client never opened one is never taken for gone.
 *
 * The agent can refute it, though. One that made a room call after its
 * connection closed, or that holds a delivery connection open now, is there,
 * whatever the process connection says: that connection may have been
 * refused, or be stalled, while the agent's other requests get through. Only
 * what the agent did counts for this. The server's own bookkeeping for the
 * session, which also moves `last_seen_at`, says nothing of the agent.
 */
export function isAgentProcessGone(
  session: AgentProcessEvidence,
  observer: { now_ms: number; process_host_id?: string | null },
): boolean {
  const processSeenMs = Date.parse(session.process_seen_at ?? "");
  if (!Number.isFinite(processSeenMs)) return false;
  if (session.delivery_connected) return false;
  const lastSeenMs = Date.parse(session.last_seen_at ?? "");
  const seenMs = Number.isFinite(lastSeenMs) ? lastSeenMs : 0;
  const agentHeardMs = Date.parse(session.agent_heard_at ?? "");
  // A session registered before the agent's calls were recorded apart has
  // only the one time, and it is read the cautious way.
  const heardMs = Number.isFinite(agentHeardMs) ? agentHeardMs : seenMs;
  const disconnectedMs = Date.parse(session.process_disconnected_at ?? "");
  if (Number.isFinite(disconnectedMs) && heardMs <= disconnectedMs) {
    // The process said so itself, on its way out.
    if (session.process_connection_id === AGENT_PROCESS_EXITED) return true;
    if (
      Boolean(observer.process_host_id) && session.process_host_id === observer.process_host_id
      && observer.now_ms - disconnectedMs >= AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS
    ) return true;
  }
  return observer.now_ms - Math.max(processSeenMs, seenMs, heardMs) >= AGENT_PROCESS_GONE_AFTER_MS;
}

export const ROOM_AGENT_DELIVERY_TRANSPORTS = [
  "long_poll",
  "sse",
  "desktop_events",
] as const;

export type RoomAgentDeliveryTransport = (typeof ROOM_AGENT_DELIVERY_TRANSPORTS)[number];

export const ROOM_AGENT_SESSION_KINDS = [
  "controller",
  "worker",
] as const;

export type RoomAgentSessionKind = (typeof ROOM_AGENT_SESSION_KINDS)[number];

/** Durable proof that must still be current when a delivery lease is written. */
export type RoomAgentDeliveryCredentialFence =
  | { kind: "session_token"; token_hash: string }
  | { kind: "bearer"; bearer_id: string; generation: number; expires_at?: string | null };

export function isRoomAgentDeliveryCredentialExpired(
  fence: RoomAgentDeliveryCredentialFence | null | undefined,
  now = Date.now(),
): boolean {
  if (fence?.kind !== "bearer" || !fence.expires_at) return false;
  const expiresAt = Date.parse(fence.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function normalizeRoomAgentSessionKind(value: unknown): RoomAgentSessionKind {
  return String(value || "").trim().toLowerCase() === "worker" ? "worker" : "controller";
}

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
  reconnectGraceExpiresAt?: string | null | undefined;
}, now = Date.now()): boolean {
  if (input.activeConnectionCount > 0 && getAgentPresenceFreshness(input.updatedAt ?? "", now) === "active") {
    return true;
  }

  const graceExpiresAt = new Date(input.reconnectGraceExpiresAt ?? "").getTime();
  return Number.isFinite(graceExpiresAt) && graceExpiresAt >= now;
}
