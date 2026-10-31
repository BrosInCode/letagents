import { isMcpWorkerId } from "./mcp-worker.js";

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

/**
 * A session whose client never opened a process connection offers no
 * evidence, only silence, and an agent that is working is often silent: it
 * is heard only when it writes to the room. So silence is believed only
 * after this long, several times the window that evidence allows.
 */
export const AGENT_WITHOUT_EVIDENCE_GONE_AFTER_MS = 60 * 60_000;
/**
 * After its agent's last request closes, the server holds a delivery
 * connection as open for this long, in case the agent asks again.
 */
export const AGENT_DELIVERY_LINGERS_MS = ROOM_AGENT_RECONNECT_GRACE_MS + 2_000;

/** Recorded in place of a connection id when a process says it is exiting. */
export const AGENT_PROCESS_EXITED = "exited";

export interface AgentProcessEvidence {
  /** Null when the client never opened a process connection. */
  process_seen_at?: string | null;
  process_connection_id?: string | null;
  process_disconnected_at?: string | null;
  /**
   * The machine the process runs on, as the process itself derived it. Only
   * a client that knows of process connections sends one.
   */
  process_host_id?: string | null;
  /** When the agent itself last made a room call. */
  agent_heard_at?: string | null;
  /** Also moved by the server's own bookkeeping for the session. */
  last_seen_at?: string | null;
  /** The session holds a delivery connection open right now. */
  delivery_connected?: boolean;
  /** Set once the session has ended; its name may still be reserved. */
  ended_at?: string | null;
  agent_instance_id?: string | null;
}

interface AgentProcessObserver {
  now_ms: number;
  process_host_id?: string | null;
}

function readEvidence(session: AgentProcessEvidence) {
  const time = (value: string | null | undefined): number | null => {
    const ms = Date.parse(value ?? "");
    return Number.isFinite(ms) ? ms : null;
  };
  const seenMs = time(session.last_seen_at) ?? 0;
  return {
    processSeenMs: time(session.process_seen_at),
    disconnectedMs: time(session.process_disconnected_at),
    seenMs,
    // A session registered before the agent's calls were recorded apart has
    // only the one time, and it is read the cautious way.
    heardMs: time(session.agent_heard_at) ?? seenMs,
  };
}

/**
 * Whether the process behind a session is known to have exited: it said so,
 * or its connection closed and a process on the same machine, which shares
 * its network, finds that it has not come back. And nothing has been heard
 * from the agent since.
 *
 * This is the evidence that an agent's work may be moved on. Silence, however
 * long, is not: a name taken from an agent that was only quiet costs it a
 * name, and work taken from it could not be given back.
 */
export function hasAgentProcessExited(session: AgentProcessEvidence, observer: AgentProcessObserver): boolean {
  if (session.delivery_connected) return false;
  const { processSeenMs, disconnectedMs, heardMs } = readEvidence(session);
  if (processSeenMs === null || disconnectedMs === null || heardMs > disconnectedMs) return false;
  // A connection that closed after the session ended was let go of, not
  // lost: the process had nothing left to hold it for.
  const endedMs = Date.parse(session.ended_at ?? "");
  if (Number.isFinite(endedMs) && disconnectedMs > endedMs) return false;
  // The process said so itself, on its way out.
  if (session.process_connection_id === AGENT_PROCESS_EXITED) return true;
  return Boolean(observer.process_host_id) && session.process_host_id === observer.process_host_id
    && observer.now_ms - disconnectedMs >= AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS;
}

/**
 * Whether the process behind a session is gone, for the purpose of letting
 * its name pass on.
 *
 * Activity cannot answer this: an agent that is busy, or waiting between room
 * calls, is unseen yet alive. Only the process connection can.
 *
 * The agent can refute it, though. One that made a room call after its
 * connection closed, or that holds a delivery connection open now, is there,
 * whatever the process connection says: that connection may have been
 * refused, or be stalled, while the agent's other requests get through. Only
 * what the agent did counts for this. The server's own bookkeeping for the
 * session, which also moves `last_seen_at`, says nothing of the agent.
 *
 * A session whose client never opened a process connection offers only
 * silence. That is believed after a much longer window, and never of a
 * session that could not recover if it was wrong: a live durable worker on
 * an older client answers from the session it holds until its process is
 * restarted, and a name is not worth leaving an agent unable to work.
 */
export function isAgentProcessGone(session: AgentProcessEvidence, observer: AgentProcessObserver): boolean {
  if (session.delivery_connected) return false;
  if (hasAgentProcessExited(session, observer)) return true;
  const { processSeenMs, seenMs, heardMs } = readEvidence(session);
  const silentForMs = observer.now_ms - Math.max(processSeenMs ?? 0, seenMs, heardMs);
  if (processSeenMs !== null) return silentForMs >= AGENT_PROCESS_GONE_AFTER_MS;
  // An ended session has nothing left to end: only its reservation lapses.
  if (session.ended_at) return silentForMs >= AGENT_PROCESS_GONE_AFTER_MS;
  const recovers = Boolean(session.process_host_id) || !isMcpWorkerId(session.agent_instance_id);
  return recovers && silentForMs >= AGENT_WITHOUT_EVIDENCE_GONE_AFTER_MS;
}

/**
 * When the process behind a session will be taken for gone, if that is
 * moments away and nothing more is heard from it. Null when it is not: the
 * process is there, or only a long silence could show that it is not.
 *
 * A process that restarts registers within seconds of the one it replaces.
 * The room knows by then that the old connection closed, and knows the
 * moment from which that will count. Registration waits for that moment
 * instead of handing the agent another name that it would then keep.
 */
export function agentProcessGoneSoonAtMs(
  session: AgentProcessEvidence,
  observer: AgentProcessObserver,
): number | null {
  const { processSeenMs, disconnectedMs, heardMs } = readEvidence(session);
  if (processSeenMs === null || disconnectedMs === null || heardMs > disconnectedMs) return null;
  const exited = session.process_connection_id === AGENT_PROCESS_EXITED;
  const sameMachine = Boolean(observer.process_host_id) && session.process_host_id === observer.process_host_id;
  if (!exited && !sameMachine) return null;
  const closedLongEnoughAt = exited ? disconnectedMs : disconnectedMs + AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS;
  // The agent's last request for messages closed when its process did.
  const deliveryLapsesAt = session.delivery_connected ? disconnectedMs + AGENT_DELIVERY_LINGERS_MS : 0;
  const at = Math.max(closedLongEnoughAt, deliveryLapsesAt);
  return at - observer.now_ms <= AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS ? at : null;
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
