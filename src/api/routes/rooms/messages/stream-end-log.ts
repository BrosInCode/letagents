const STREAM_END_LOG_WINDOW_MS = 5 * 60_000;
// One entry per (room, actor, reason). Past this many, the oldest window is
// dropped, so server memory stays bounded whatever the clients do.
const STREAM_END_LOG_MAX_KEYS = 2_048;
const MAX_LOGGED_LABEL_LENGTH = 80;

/**
 * Who a room stream belonged to. `label` comes only from a verified agent
 * identity, never from a value the client chose; `accountId` is the account
 * of the authenticated credential. Never a token, a cookie or a header value.
 */
export interface RoomStreamEndActor {
  label: string | null;
  accountId: string | null;
  kind: string;
}

export interface RoomStreamEndLog {
  (input: { logLabel: string; roomId: string; actor: RoomStreamEndActor; reason: string }): void;
}

/**
 * Logs why the server ended a room stream early, at most once per (room,
 * actor, reason) in each window. A client that reconnects in a loop hits the
 * same end every second; the next line after a window says how many were
 * suppressed.
 */
export function createRoomStreamEndLog(options: {
  now?: () => number;
  log?: (line: string) => void;
  windowMs?: number;
  maxKeys?: number;
} = {}): RoomStreamEndLog {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.warn(line));
  const windowMs = options.windowMs ?? STREAM_END_LOG_WINDOW_MS;
  const maxKeys = Math.max(1, options.maxKeys ?? STREAM_END_LOG_MAX_KEYS);
  // Insertion order is window-start order: a key is re-inserted when its
  // window restarts, so the first key is always the oldest window.
  const windows = new Map<string, { startedAt: number; suppressed: number }>();
  return ({ logLabel, roomId, actor, reason }) => {
    const label = JSON.stringify((actor.label ?? "").slice(0, MAX_LOGGED_LABEL_LENGTH));
    const account = actor.accountId ?? "none";
    const key = `${roomId}\n${actor.kind}\n${account}\n${label}\n${reason}`;
    const at = now();
    const current = windows.get(key);
    if (current && at - current.startedAt < windowMs) {
      current.suppressed += 1;
      return;
    }
    windows.delete(key);
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
    windows.set(key, { startedAt: at, suppressed: 0 });
    const suppressed = current?.suppressed
      ? ` (${current.suppressed} more suppressed in the previous ${Math.round(windowMs / 1000)}s)`
      : "";
    log(`[${logLabel}] ended stream early room=${roomId} account=${account} actor=${label} kind=${actor.kind} reason=${reason}${suppressed}`);
  };
}

export const logRoomStreamEnd: RoomStreamEndLog = createRoomStreamEndLog();
