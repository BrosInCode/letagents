import { randomBytes } from 'node:crypto';

import {
  LIVE_DEMO,
  parseLiveClientFrame,
  type LiveDemoClientFrame,
  type LiveDemoPerson,
  type LiveDemoServerFrame,
} from '../../../shared/live-demo.mjs';

// Live demos: who is looking at which HTML demo in a room, their cursors and
// their strokes while they draw. Nothing here is stored; saved marks live in
// Postgres and only pass through `broadcast`.

/** One socket as the hub sees it. A `ws` WebSocket has this shape. */
export interface LiveDemoSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Fan-out between hubs, per room. Today one in-memory bus serves the one API
 * process. A cross-process bus (Postgres or Redis) implements the same two
 * calls; it must also hand a new subscriber the people already viewing, since
 * a hub learns its rosters only from `join` and `leave` events.
 */
export type LiveDemoBusEvent =
  | { kind: 'join'; demo: string; person: LiveDemoPerson }
  | { kind: 'leave'; demo: string; cid: string }
  | { kind: 'frame'; demo: string; frame: LiveDemoServerFrame; from: string | null };

export interface LiveDemoBus {
  publish(roomId: string, event: LiveDemoBusEvent): void;
  subscribe(roomId: string, listener: (event: LiveDemoBusEvent) => void): () => void;
}

export function createInMemoryLiveDemoBus(): LiveDemoBus {
  const listeners = new Map<string, Set<(event: LiveDemoBusEvent) => void>>();
  return {
    publish(roomId, event) {
      for (const listener of [...(listeners.get(roomId) ?? [])]) listener(event);
    },
    subscribe(roomId, listener) {
      const set = listeners.get(roomId) ?? new Set();
      set.add(listener);
      listeners.set(roomId, set);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(roomId) === set) listeners.delete(roomId);
      };
    },
  };
}

export interface LiveDemoHubLimits {
  viewersPerDemo: number;
  joins: number;
  joinWindowMs: number;
  badFrames: number;
  badFrameWindowMs: number;
  checkedDemos: number;
  slowSocketBytes: number;
  maxQueuedBytes: number;
  heldFrames: number;
  pings: number;
  pingWindowMs: number;
}

export const LIVE_DEMO_HUB_LIMITS: Readonly<LiveDemoHubLimits> = Object.freeze({
  /** A presence frame lists at most 64 people, so a demo admits 64 viewers. */
  viewersPerDemo: 64,
  /**
   * Joins per connection per window, a repeated join included. A join may cost
   * one database read and wakes every viewer, and every reply to a socket's own
   * frames comes from a join, so this also bounds those replies.
   */
  joins: 20,
  joinWindowMs: 10_000,
  /** Bad frames per connection per window; the next one closes the socket. */
  badFrames: 10,
  badFrameWindowMs: 10_000,
  /** Demo keys a connection remembers as checked. */
  checkedDemos: 256,
  /** A socket this far behind gets no cursor or ink frames until it catches up. */
  slowSocketBytes: 64 * 1024,
  /** A frame that would queue more than this for one socket closes it (1013). */
  maxQueuedBytes: 256 * 1024,
  /** Saved-mark changes kept for a held socket (and at most maxQueuedBytes); more closes it (1013). */
  heldFrames: 64,
  /** Pings from the app answered per window (the app pings every 25 s); each one more is a bad frame. */
  pings: 5,
  pingWindowMs: 10_000,
});

export interface LiveDemoHubOptions {
  /** Whether the demo key names an attachment of a message in this room. */
  demoExists(roomId: string, demo: string): Promise<boolean>;
  bus?: LiveDemoBus;
  now?: () => number;
  limits?: Partial<LiveDemoHubLimits>;
  onError?: (error: unknown) => void;
}

export interface LiveDemoConnection {
  readonly cid: string;
  readonly roomId: string;
  readonly accountId: string;
  /** One WebSocket message from the desktop app. */
  receive(data: string | Buffer, isBinary?: boolean): void;
  /** The socket closed: leave every demo. Safe to call more than once. */
  disconnect(): void;
  /**
   * While held (its access is being checked again) the socket gets no cursor,
   * ink or presence, and its cursor and ink go nowhere. Saved-mark changes and
   * errors wait in a small queue. On release it gets the current viewers of
   * each demo it views, then the queue; a revoke drops the queue.
   */
  hold(held: boolean): void;
  /**
   * A ping from the app, of `bytes` payload. True when the socket may answer
   * it now: within the ping budget (more is a bad frame) and the queue cap.
   */
  ping(bytes: number): boolean;
}

export interface LiveDemoHub {
  connect(input: { roomId: string; accountId: string; name: string; color: string; socket: LiveDemoSocket }): LiveDemoConnection;
  /** A saved-mark change for everyone viewing the demo (`mark` / `unmark`). */
  broadcast(roomId: string, demo: string, frame: LiveDemoServerFrame): void;
  stats(): { rooms: number; connections: number };
}

/** Bad frames close with 1008 (policy violation). */
export const LIVE_DEMO_CLOSE_BAD_FRAMES = 1008;
/** A socket that does not read its frames closes with 1013 (try again later). */
export const LIVE_DEMO_CLOSE_TOO_SLOW = 1013;

interface Window { start: number; count: number }

interface DemoView {
  cur: Window;
  ink: Window;
  cursorShown: boolean;
  stroke: { id: string; points: number } | null;
}

interface Connection extends LiveDemoConnection {
  readonly person: LiveDemoPerson;
  readonly socket: LiveDemoSocket;
  readonly demos: Map<string, DemoView>;
  readonly pending: Set<string>;
  readonly checked: Set<string>;
  readonly joins: Window;
  /** The join window in which this socket was told it is rate limited. */
  limitToldAt: number | null;
  readonly bad: Window;
  readonly pings: Window;
  closed: boolean;
  held: boolean;
  /** Frames for after the hold, and their size. */
  heldQueue: string[];
  heldBytes: number;
}

interface Room {
  readonly local: Set<Connection>;
  /** This process's viewers of each demo. */
  readonly viewers: Map<string, Set<Connection>>;
  /** Everyone viewing each demo, as the bus reported them. */
  readonly roster: Map<string, Map<string, LiveDemoPerson>>;
  unsubscribe: () => void;
}

const OPEN = 1;

/** Cursor and ink may be skipped; presence is sent again after a hold; anything else must arrive. */
type FrameClass = 'volatile' | 'presence' | 'other';

function frameClass(frame: LiveDemoServerFrame): FrameClass {
  if (frame.t === 'cur' || frame.t === 'ink') return 'volatile';
  return frame.t === 'presence' ? 'presence' : 'other';
}
/** The most people a presence frame may list (parseLiveServerFrame). */
const PRESENCE_PEOPLE = 64;

function take(window: Window, limit: number, windowMs: number, now: number): boolean {
  if (now - window.start >= windowMs) {
    window.start = now;
    window.count = 0;
  }
  if (window.count >= limit) return false;
  window.count += 1;
  return true;
}

function byteLength(data: string | Buffer): number {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.length;
}

export function createLiveDemoHub(options: LiveDemoHubOptions): LiveDemoHub {
  const bus = options.bus ?? createInMemoryLiveDemoBus();
  const now = options.now ?? Date.now;
  const limits = { ...LIVE_DEMO_HUB_LIMITS, ...options.limits };
  const onError = options.onError ?? ((error: unknown) => console.error('[live demos]', error));
  const rooms = new Map<string, Room>();
  let connections = 0;

  const closeConnection = (connection: Connection, code: number, reason: string) => {
    try {
      connection.socket.close(code, reason);
    } catch (error) {
      onError(error);
    }
    disconnect(connection);
  };

  /**
   * Every frame to every socket goes through here. A slow reader skips cursor
   * and ink frames; a frame that would queue past the hard cap closes the
   * socket instead, so one socket that stops reading cannot fill the memory.
   */
  const send = (connection: Connection, text: string, kind: FrameClass, bytes = Buffer.byteLength(text)) => {
    const { socket } = connection;
    if (connection.closed || socket.readyState !== OPEN) return;
    if (connection.held) {
      if (kind !== 'other') return;
      // A held socket may still be allowed: keep what it must not miss, within bounds.
      if (connection.heldQueue.length >= limits.heldFrames || connection.heldBytes + bytes > limits.maxQueuedBytes) {
        closeConnection(connection, LIVE_DEMO_CLOSE_TOO_SLOW, 'Too far behind');
        return;
      }
      connection.heldQueue.push(text);
      connection.heldBytes += bytes;
      return;
    }
    const queued = socket.bufferedAmount;
    if (kind === 'volatile' && queued > limits.slowSocketBytes) return;
    if (queued + bytes > limits.maxQueuedBytes) {
      closeConnection(connection, LIVE_DEMO_CLOSE_TOO_SLOW, 'Too far behind');
      return;
    }
    try {
      socket.send(text);
    } catch (error) {
      onError(error);
    }
  };

  const deliver = (room: Room, demo: string, frame: LiveDemoServerFrame, from: string | null) => {
    const viewers = room.viewers.get(demo);
    if (!viewers?.size) return;
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    const kind = frameClass(frame);
    for (const viewer of [...viewers]) if (viewer.cid !== from) send(viewer, text, kind, bytes);
  };

  const presence = (room: Room, demo: string): LiveDemoServerFrame => ({
    t: 'presence',
    demo,
    people: [...(room.roster.get(demo)?.values() ?? [])].slice(0, PRESENCE_PEOPLE),
  });

  const onBusEvent = (room: Room, event: LiveDemoBusEvent) => {
    if (event.kind === 'join') {
      const roster = room.roster.get(event.demo) ?? new Map<string, LiveDemoPerson>();
      roster.set(event.person.cid, event.person);
      room.roster.set(event.demo, roster);
      deliver(room, event.demo, presence(room, event.demo), null);
      return;
    }
    if (event.kind === 'leave') {
      const roster = room.roster.get(event.demo);
      if (!roster?.delete(event.cid)) return;
      if (!roster.size) room.roster.delete(event.demo);
      deliver(room, event.demo, { t: 'cur', demo: event.demo, cid: event.cid, gone: true }, null);
      deliver(room, event.demo, presence(room, event.demo), null);
      return;
    }
    deliver(room, event.demo, event.frame, event.from);
  };

  const roomFor = (roomId: string): Room => {
    const existing = rooms.get(roomId);
    if (existing) return existing;
    const room: Room = { local: new Set(), viewers: new Map(), roster: new Map(), unsubscribe: () => {} };
    room.unsubscribe = bus.subscribe(roomId, (event) => onBusEvent(room, event));
    rooms.set(roomId, room);
    return room;
  };

  const sendError = (connection: Connection, code: string, message: string, demo?: string) => {
    // `demo` is an extra field: it tells the app which join failed.
    send(connection, JSON.stringify({ t: 'error', code, message, ...(demo ? { demo } : {}) }), 'other');
  };

  const admit = (connection: Connection, demo: string) => {
    const room = rooms.get(connection.roomId);
    if (!room || connection.closed || connection.demos.has(demo)) return;
    if ((room.roster.get(demo)?.size ?? 0) >= limits.viewersPerDemo) {
      sendError(connection, 'demo_full', 'Too many people are viewing this demo live.', demo);
      return;
    }
    connection.demos.set(demo, {
      cur: { start: 0, count: 0 },
      ink: { start: 0, count: 0 },
      cursorShown: false,
      stroke: null,
    });
    const viewers = room.viewers.get(demo) ?? new Set<Connection>();
    viewers.add(connection);
    room.viewers.set(demo, viewers);
    bus.publish(connection.roomId, { kind: 'join', demo, person: connection.person });
  };

  const drop = (connection: Connection, demo: string) => {
    if (!connection.demos.delete(demo)) return;
    const room = rooms.get(connection.roomId);
    const viewers = room?.viewers.get(demo);
    viewers?.delete(connection);
    if (room && viewers && !viewers.size) room.viewers.delete(demo);
    bus.publish(connection.roomId, { kind: 'leave', demo, cid: connection.cid });
  };

  const remember = (connection: Connection, demo: string) => {
    connection.checked.add(demo);
    if (connection.checked.size > limits.checkedDemos) {
      connection.checked.delete(connection.checked.values().next().value!);
    }
  };

  const join = (connection: Connection, demo: string) => {
    // Every join counts, a repeated one too: each may send a reply.
    if (!take(connection.joins, limits.joins, limits.joinWindowMs, now())) {
      // One reply per window, for no demo in particular: every join from here
      // to the end of the window is dropped, so the app sends again each join
      // it has not seen its own presence for, after `retry_after_ms`.
      if (connection.limitToldAt === connection.joins.start) return;
      connection.limitToldAt = connection.joins.start;
      send(connection, JSON.stringify({
        t: 'error',
        code: 'rate_limited',
        message: 'Too many demos opened at once. Trying again in a moment.',
        retry_after_ms: Math.max(0, connection.joins.start + limits.joinWindowMs - now()),
      }), 'other');
      return;
    }
    const room = rooms.get(connection.roomId);
    if (connection.demos.has(demo)) {
      // Already viewing: answer with the current viewers, to this app only.
      if (room) send(connection, JSON.stringify(presence(room, demo)), 'presence');
      return;
    }
    if (connection.pending.has(demo)) return;
    if (connection.demos.size + connection.pending.size >= LIVE_DEMO.demosPerConnection) {
      sendError(connection, 'too_many_demos', `Up to ${LIVE_DEMO.demosPerConnection} demos can be live at once.`, demo);
      return;
    }
    if (connection.checked.has(demo)) {
      admit(connection, demo);
      return;
    }
    connection.pending.add(demo);
    Promise.resolve().then(() => options.demoExists(connection.roomId, demo)).then(
      (found) => {
        // A leave or a disconnect while the check ran cancels the join.
        if (connection.closed || !connection.pending.delete(demo)) return;
        if (!found) {
          sendError(connection, 'demo_not_found', 'This demo is not in this room.', demo);
          return;
        }
        remember(connection, demo);
        admit(connection, demo);
      },
      (error) => {
        if (connection.closed || !connection.pending.delete(demo)) return;
        onError(error);
        sendError(connection, 'unavailable', 'Live view is not available right now. Try again soon.', demo);
      },
    );
  };

  const cursor = (connection: Connection, frame: Extract<LiveDemoClientFrame, { t: 'cur' }>) => {
    const view = connection.demos.get(frame.demo);
    if (!view) return;
    if ('gone' in frame) {
      // One `gone` per shown cursor, so it is never rate limited away.
      if (!view.cursorShown) return;
      view.cursorShown = false;
      bus.publish(connection.roomId, {
        kind: 'frame', demo: frame.demo, from: connection.cid,
        frame: { t: 'cur', demo: frame.demo, cid: connection.cid, gone: true },
      });
      return;
    }
    if (!take(view.cur, LIVE_DEMO.serverCursorPerSecond, 1000, now())) return;
    view.cursorShown = true;
    bus.publish(connection.roomId, {
      kind: 'frame', demo: frame.demo, from: connection.cid,
      frame: { t: 'cur', demo: frame.demo, cid: connection.cid, x: frame.x, y: frame.y },
    });
  };

  const ink = (connection: Connection, frame: Extract<LiveDemoClientFrame, { t: 'ink' }>) => {
    const view = connection.demos.get(frame.demo);
    if (!view) return;
    const open = view.stroke?.id === frame.id;
    // The end of an open stroke always passes, so no stroke is left hanging.
    if (!(frame.end && open) && !take(view.ink, LIVE_DEMO.inkFramesPerSecond, 1000, now())) return;
    if (!open) view.stroke = { id: frame.id, points: 0 };
    const stroke = view.stroke!;
    // A live stroke stops growing at the saved-stroke limit; its end still passes.
    const pts = frame.pts.slice(0, Math.max(0, LIVE_DEMO.strokePoints - stroke.points));
    if (!pts.length && !frame.end) return;
    stroke.points += pts.length;
    if (frame.end) view.stroke = null;
    bus.publish(connection.roomId, {
      kind: 'frame', demo: frame.demo, from: connection.cid,
      frame: {
        t: 'ink', demo: frame.demo, cid: connection.cid, id: frame.id, pts,
        ...(frame.end ? { end: true as const } : {}),
      },
    });
  };

  const disconnect = (connection: Connection) => {
    if (connection.closed) return;
    connection.closed = true;
    connection.pending.clear();
    connection.heldQueue = [];
    connection.heldBytes = 0;
    for (const demo of [...connection.demos.keys()]) drop(connection, demo);
    connections -= 1;
    const room = rooms.get(connection.roomId);
    if (!room) return;
    room.local.delete(connection);
    if (!room.local.size) {
      room.unsubscribe();
      rooms.delete(connection.roomId);
    }
  };

  const badFrame = (connection: Connection) => {
    if (take(connection.bad, limits.badFrames, limits.badFrameWindowMs, now())) return;
    closeConnection(connection, LIVE_DEMO_CLOSE_BAD_FRAMES, 'Too many bad frames');
  };

  const hold = (connection: Connection, held: boolean) => {
    if (connection.closed || connection.held === held) return;
    connection.held = held;
    if (held) return;
    // Back from a check: the viewers as they are now, then what was kept.
    const room = rooms.get(connection.roomId);
    if (room) for (const demo of connection.demos.keys()) send(connection, JSON.stringify(presence(room, demo)), 'presence');
    const kept = connection.heldQueue;
    connection.heldQueue = [];
    connection.heldBytes = 0;
    for (const text of kept) send(connection, text, 'other');
  };

  const ping = (connection: Connection, bytes: number): boolean => {
    if (connection.closed) return false;
    if (!take(connection.pings, limits.pings, limits.pingWindowMs, now())) {
      badFrame(connection);
      return false;
    }
    const { socket } = connection;
    if (socket.readyState !== OPEN) return false;
    // A pong is a frame like any other: 2 header bytes and the echoed payload.
    if (socket.bufferedAmount + bytes + 2 > limits.maxQueuedBytes) {
      closeConnection(connection, LIVE_DEMO_CLOSE_TOO_SLOW, 'Too far behind');
      return false;
    }
    return true;
  };

  const receive = (connection: Connection, data: string | Buffer, isBinary = false) => {
    if (connection.closed) return;
    if (isBinary || byteLength(data) > LIVE_DEMO.frameBytes) {
      badFrame(connection);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      badFrame(connection);
      return;
    }
    const frame = parseLiveClientFrame(value);
    if (!frame) {
      badFrame(connection);
      return;
    }
    switch (frame.t) {
      case 'join': join(connection, frame.demo); return;
      case 'leave':
        if (!connection.pending.delete(frame.demo)) drop(connection, frame.demo);
        return;
      case 'cur': if (!connection.held) cursor(connection, frame); return;
      case 'ink': if (!connection.held) ink(connection, frame); return;
    }
  };

  return {
    connect(input) {
      const room = roomFor(input.roomId);
      const cid = randomBytes(12).toString('base64url');
      const connection: Connection = {
        cid,
        roomId: input.roomId,
        accountId: input.accountId,
        person: { cid, name: input.name, color: input.color },
        socket: input.socket,
        demos: new Map(),
        pending: new Set(),
        checked: new Set(),
        joins: { start: 0, count: 0 },
        limitToldAt: null,
        bad: { start: 0, count: 0 },
        pings: { start: 0, count: 0 },
        closed: false,
        held: false,
        heldQueue: [],
        heldBytes: 0,
        receive: (data, isBinary) => receive(connection, data, isBinary),
        disconnect: () => disconnect(connection),
        hold: (held) => hold(connection, held),
        ping: (bytes) => ping(connection, bytes),
      };
      room.local.add(connection);
      connections += 1;
      send(connection, JSON.stringify({ t: 'hello', cid: connection.cid, name: input.name, color: input.color }), 'other');
      return connection;
    },
    broadcast(roomId, demo, frame) {
      bus.publish(roomId, { kind: 'frame', demo, frame, from: null });
    },
    stats: () => ({ rooms: rooms.size, connections }),
  };
}
