import {
  AGENT_PROCESS_CONNECTION_SILENT_AFTER_MS,
  AGENT_PROCESS_RECONNECT_MAX_DELAY_MS,
} from "../../../shared/agent-presence.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../../shared/request-headers.js";
import { endStoredAgentSession, getStoredAgentSession } from "../../local-state.js";
import type { StoredAgentSessionState } from "../../local-state/types.js";
import { encodeRoomIdPath } from "../../room-id.js";
import { getApiUrl, getLetagentsToken } from "./api.js";
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";

/**
 * This process holds one connection open per worker session for as long as it
 * runs. The connection carries nothing: that it is open tells the room this
 * process exists, which nothing else can. What the agent does cannot, because
 * an agent that is busy or waiting between room calls looks the same as one
 * whose process has gone.
 *
 * The room uses it for one decision. When another of the owner's agents asks
 * for a name this session holds, the name passes on only if this process is
 * gone. So a session that holds its connection open is never mistaken for an
 * abandoned one.
 *
 * Nothing here polls. The connection is opened, and reopened only after it
 * drops.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, AGENT_PROCESS_RECONNECT_MAX_DELAY_MS] as const;
// A server that refuses the connection is asked again, but seldom: it will
// likely refuse again, and the agent's own room calls speak for it meanwhile.
const REFUSED_DELAYS_MS = [AGENT_PROCESS_RECONNECT_MAX_DELAY_MS, 15_000, 60_000] as const;
// A server that does not know the route is asked more seldom still. It may
// be one of several behind the same address, not all of them yet replaced,
// or be replaced while this process runs. A process that gave up on the
// first such answer would offer no evidence for the rest of its life.
const UNKNOWN_DELAYS_MS = [10_000, 60_000, 5 * 60_000] as const;
const ANSWER_TIMEOUT_MS = 10_000;
const EXIT_ANNOUNCEMENT_TIMEOUT_MS = 1_500;

interface HeldConnection {
  session: StoredAgentSessionState;
  controller: AbortController;
  /** The room's name for the connection now open, if one is. */
  connectionId: string | null;
}

const held = new Map<string, HeldConnection>();

/**
 * - dropped: the connection closed, or the server could not serve it.
 * - refused: the server answered, and declined.
 * - ended: the room says the session has ended.
 * - unsupported: the server does not know of process connections, for now.
 */
type Outcome = "dropped" | "refused" | "ended" | "unsupported";

async function authorization(session: StoredAgentSessionState): Promise<Record<string, string>> {
  const token = await getLetagentsToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    [LETAGENTS_AGENT_SESSION_ID_HEADER]: session.session_id,
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER]: session.session_token,
  };
}

function processUrl(session: StoredAgentSessionState, suffix = ""): string {
  return `${getApiUrl()}/rooms/${encodeRoomIdPath(session.room_id)}/agent-sessions/`
    + `${encodeURIComponent(session.session_id)}/process${suffix}`;
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function holdOnce(
  session: StoredAgentSessionState,
  signal: AbortSignal,
  onOpen: (connectionId: string | null) => void,
): Promise<Outcome> {
  // One attempt, ended by the caller or by a server that has gone quiet. A
  // connection can die without either end being told, as when a machine
  // wakes from sleep; the server writes often enough that silence shows it.
  const attempt = new AbortController();
  const abort = () => attempt.abort();
  signal.addEventListener("abort", abort, { once: true });
  let quiet: NodeJS.Timeout | undefined;
  const expectWithin = (ms: number) => {
    clearTimeout(quiet);
    quiet = setTimeout(abort, ms);
    quiet.unref?.();
  };
  try {
    expectWithin(ANSWER_TIMEOUT_MS);
    const response = await fetch(processUrl(session), {
      headers: { Accept: "text/event-stream", ...await authorization(session) },
      signal: attempt.signal,
    });
    if (response.status === 410) {
      discard(response);
      return "ended";
    }
    // A room server that predates this connection has no such route. That
    // says nothing about the session.
    if (response.status === 404 || response.status === 405) {
      discard(response);
      return "unsupported";
    }
    if (response.status >= 500) {
      discard(response);
      return "dropped";
    }
    if (!response.ok || !response.body
      || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      discard(response);
      return "refused";
    }
    onOpen(null);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    for (;;) {
      expectWithin(AGENT_PROCESS_CONNECTION_SILENT_AFTER_MS);
      const { done, value } = await reader.read();
      if (done) return "dropped";
      // Only the last few bytes are kept: enough to see either event sent.
      tail = (tail + decoder.decode(value, { stream: true })).slice(-128);
      const named = /"connection_id":"([0-9a-f-]{36})"/.exec(tail);
      if (named) onOpen(named[1]!);
      if (tail.includes("event: ended")) {
        void reader.cancel().catch(() => undefined);
        return "ended";
      }
    }
  } finally {
    clearTimeout(quiet);
    signal.removeEventListener("abort", abort);
  }
}

function stillOurs(session: StoredAgentSessionState): boolean {
  try {
    const stored = getStoredAgentSession(session.session_id);
    return Boolean(stored && !stored.ended_at && stored.session_token === session.session_token);
  } catch {
    // A worker connection that was replaced reads as an error.
    return false;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    // Waiting to reconnect is no reason for this process to stay alive.
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function hold(connection: HeldConnection): Promise<void> {
  const { session, controller } = connection;
  let drops = 0;
  let refusals = 0;
  let unknowns = 0;
  while (!controller.signal.aborted) {
    let outcome: Outcome = "dropped";
    try {
      outcome = await holdOnce(session, controller.signal, (connectionId) => {
        drops = 0;
        refusals = 0;
        unknowns = 0;
        connection.connectionId = connectionId;
      });
    } catch {
      // A dropped network or an aborted request. The loop condition tells them apart.
    }
    connection.connectionId = null;
    if (controller.signal.aborted) return;
    if (outcome === "ended") {
      // The room ended this session. Say so locally, so the next
      // registration starts a session instead of reusing this one.
      endStoredAgentSession(session.session_id, new Date().toISOString(), session.session_token);
    }
    if (outcome === "ended") {
      if (held.get(session.session_id) === connection) held.delete(session.session_id);
      return;
    }
    if (outcome !== "dropped" && !stillOurs(session)) {
      // The session was registered again with another credential, by this
      // process or another. Whoever did that holds its connection now.
      if (held.get(session.session_id) === connection) held.delete(session.session_id);
      return;
    }
    const [delays, attempt] = outcome === "unsupported" ? [UNKNOWN_DELAYS_MS, unknowns] as const
      : outcome === "refused" ? [REFUSED_DELAYS_MS, refusals] as const
        : [RECONNECT_DELAYS_MS, drops] as const;
    await sleep(delays[Math.min(attempt, delays.length - 1)]!, controller.signal);
    if (outcome === "unsupported") unknowns += 1;
    else if (outcome === "refused") refusals += 1;
    else drops += 1;
  }
}

function holdsCredentials(session: StoredAgentSessionState | null | undefined): session is StoredAgentSessionState {
  return Boolean(session
    && session.session_kind === "worker"
    && !session.ended_at
    && session.session_token
    && !session.session_id.startsWith("local_")
    && requireValidWorkerBearerRuntime().mode === "owner");
}

/** Hold the process connection for a session this process has just registered. */
export function holdProcessConnection(session: StoredAgentSessionState | null | undefined): void {
  if (!holdsCredentials(session)) return;
  const current = held.get(session.session_id);
  if (current?.session.session_token === session.session_token) return;
  current?.controller.abort();
  const connection: HeldConnection = { session, controller: new AbortController(), connectionId: null };
  held.set(session.session_id, connection);
  void hold(connection);
}

/** Stop holding it, because this process ended the session itself. */
export function releaseProcessConnection(sessionId: string): void {
  held.get(sessionId)?.controller.abort();
  held.delete(sessionId);
}

/**
 * Tell the room this process is exiting. A connection that merely closes may
 * reopen, so the room waits before it concludes anything; a process that says
 * it is leaving spares its successor that wait. Best effort and bounded: an
 * exit is never held up by a room that does not answer.
 */
export async function announceProcessExit(): Promise<void> {
  const connections = [...held.values()];
  held.clear();
  if (connections.length === 0) return;
  const timeout = AbortSignal.timeout(EXIT_ANNOUNCEMENT_TIMEOUT_MS);
  await Promise.allSettled(connections.map(async ({ session, controller, connectionId }) => {
    // Closed first, so nothing the room sends in answer is read as news
    // about the session.
    controller.abort();
    await fetch(processUrl(session, "/exit"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...await authorization(session) },
      body: JSON.stringify({
        agent_session_id: session.session_id,
        agent_session_token: session.session_token,
        process_connection_id: connectionId,
      }),
      signal: timeout,
    });
  }));
}
