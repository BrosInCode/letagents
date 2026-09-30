import { readStoredAuth } from "./auth.js";
import { apiUrl } from "./paths.js";
import { emitToMainWindow } from "./window.js";
import type { DesktopAccountActivityState, DesktopAccountRoomActivity } from "../ipc-types/account-activity.js";

/** A frame larger than this is not activity; drop the connection and reconnect. */
const MAX_FRAME_BYTES = 1024 * 1024;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
export const accountActivityTiming = {
  /** A server without this stream is asked again this rarely, in case it is upgraded. */
  missingStreamRetryMs: 5 * 60_000,
  /**
   * The server sends a heartbeat every 15 s. Nothing at all for this long means
   * the connection is dead without having closed (sleep, a network switch).
   */
  idleTimeoutMs: 45_000,
};
export const ACCOUNT_ACTIVITY_CHANNEL = "desktop:account-activity:changed";

type Stream = { abort: AbortController; retryTimer: NodeJS.Timeout | null; retryMs: number };

let stream: Stream | null = null;
let state: DesktopAccountActivityState = { connected: false, rooms: {} };

export function getAccountActivityState(): DesktopAccountActivityState {
  return state;
}

function publish(next: DesktopAccountActivityState): void {
  state = next;
  emitToMainWindow(ACCOUNT_ACTIVITY_CHANNEL, state);
}

/**
 * Keeps one server-sent event stream open for the signed-in account and hands
 * the renderer each room's activity as it changes. Restarting replaces the
 * stream, which is how a changed set of rooms is picked up.
 */
export function restartAccountActivityStream(): void {
  stopAccountActivityStream();
  const next: Stream = { abort: new AbortController(), retryTimer: null, retryMs: FIRST_RETRY_MS };
  stream = next;
  void connect(next);
}

export function stopAccountActivityStream(): void {
  if (!stream) return;
  stream.abort.abort();
  if (stream.retryTimer) clearTimeout(stream.retryTimer);
  stream = null;
  publish({ connected: false, rooms: {} });
}

async function connect(current: Stream): Promise<void> {
  try {
    const auth = await readStoredAuth();
    if (stream !== current) return;
    if (!auth.token) {
      // Signed out: nothing to watch until the next restart.
      publish({ connected: false, rooms: {} });
      return;
    }
    const response = await fetch(`${apiUrl}/account/activity/stream`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${auth.token}` },
      signal: current.abort.signal,
    });
    if (response.status === 401) {
      // The token is refused: signing in again restarts the stream.
      publish({ connected: false, rooms: {} });
      return;
    }
    if (response.status === 404) {
      // A server without this stream: the sidebar polls, and asks again rarely.
      publish({ connected: false, rooms: {} });
      current.retryTimer = setTimeout(() => {
        current.retryTimer = null;
        void connect(current);
      }, accountActivityTiming.missingStreamRetryMs);
      return;
    }
    if (!response.ok || !response.body) throw new Error(`Account activity stream failed with HTTP ${response.status}.`);
    await read(current, response.body);
  } catch (error) {
    if (stream !== current || current.abort.signal.aborted) return;
    console.warn("[account activity]", error instanceof Error ? error.message : error);
  }
  if (stream !== current || current.abort.signal.aborted) return;
  publish({ ...state, connected: false });
  const delay = current.retryMs;
  current.retryMs = Math.min(current.retryMs * 2, MAX_RETRY_MS);
  current.retryTimer = setTimeout(() => {
    current.retryTimer = null;
    void connect(current);
  }, delay);
}

async function read(current: Stream, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idle: NodeJS.Timeout | null = null;
  let timedOut = false;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      void reader.cancel("Account activity stream went quiet").catch(() => undefined);
    }, accountActivityTiming.idleTimeoutMs);
  };
  try {
    armIdle();
    while (stream === current) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error("Account activity stream went quiet.");
      if (done || stream !== current) break;
      armIdle();
      readChunk(value);
    }
  } finally {
    if (idle) clearTimeout(idle);
  }

  function readChunk(value: Uint8Array): void {
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handleFrame(current, frame);
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      void reader.cancel("Account activity frame exceeded bounded size").catch(() => undefined);
      throw new Error("Account activity frame exceeded bounded size.");
    }
  }
}

function handleFrame(current: Stream, frame: string): void {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return;
  let payload: unknown;
  try { payload = JSON.parse(data.join("\n")); } catch { return; }
  if (event === "snapshot") {
    const rooms = (payload as { rooms?: unknown }).rooms;
    if (!Array.isArray(rooms)) return;
    current.retryMs = FIRST_RETRY_MS;
    const next: Record<string, DesktopAccountRoomActivity> = {};
    for (const room of rooms) {
      const parsed = parseRoom(room);
      if (parsed) next[parsed.roomId] = parsed;
    }
    publish({ connected: true, rooms: next });
  } else if (event === "room") {
    const parsed = parseRoom(payload);
    if (parsed) publish({ connected: true, rooms: { ...state.rooms, [parsed.roomId]: parsed } });
  }
}

function parseRoom(value: unknown): DesktopAccountRoomActivity | null {
  if (!value || typeof value !== "object") return null;
  const room = value as Record<string, unknown>;
  if (typeof room.room_id !== "string" || !room.room_id) return null;
  const working = Array.isArray(room.working) ? room.working : [];
  return {
    roomId: room.room_id,
    latestMessageId: typeof room.latest_message_id === "string" ? room.latest_message_id : null,
    latestMessageAt: typeof room.latest_message_at === "string" ? room.latest_message_at : null,
    working: working.flatMap((agent) => {
      const displayName = (agent as { display_name?: unknown } | null)?.display_name;
      return typeof displayName === "string" && displayName ? [{ displayName }] : [];
    }),
  };
}
