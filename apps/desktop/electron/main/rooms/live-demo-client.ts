import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import {
  isLiveDemoKey,
  LIVE_DEMO,
  LIVE_DEMO_PROTOCOL,
  parseLiveClientFrame,
  parseLiveServerFrame,
} from "../../../../../shared/live-demo.mjs";
import type { DesktopLiveDemoClientFrame, DesktopLiveDemoEvent, DesktopLiveDemoStatus } from "../../ipc-types.js";

/**
 * Live demos: one WebSocket per room, owned by main. The chat joins the demos
 * it shows; main keeps those joins across reconnects, sends this app's cursor
 * while the person's pointer is over a demo's webview, and passes every valid
 * frame from the room to the chat. Nothing here is saved.
 */

/** A room with no joined demo keeps its socket this long, so a demo scrolled back into view joins at once. */
export const LIVE_DEMO_IDLE_CLOSE_MS = 60_000;
export const LIVE_DEMO_RETRY_BASE_MS = 1_000;
export const LIVE_DEMO_RETRY_MAX_MS = 30_000;
/** A connection that stayed up this long starts the backoff over; one the server drops at once does not. */
export const LIVE_DEMO_STABLE_MS = 30_000;
/** A socket that does not answer a ping in this time is dead (a laptop that slept, a changed network). */
export const LIVE_DEMO_PING_MS = 25_000;
/**
 * Names this app's socket for one room across its reconnects, so the server
 * can close an older socket of the same app (a half-open one after a network
 * change) instead of showing the person twice.
 */
export const LIVE_DEMO_CLIENT_HEADER = "X-LetAgents-Live-Client";
/** The server closed an older socket that a newer one with the same client id replaced. */
export const LIVE_DEMO_CLOSE_REPLACED = 4409;
/** A join the server refused for now (`rate_limited`, `unavailable`) is sent again after this time. */
export const LIVE_DEMO_REJOIN_MS = 10_000;
/** A saved stroke of LIVE_DEMO.strokePoints points is the largest frame the server sends, about 40 KB. */
export const LIVE_DEMO_MAX_INCOMING_BYTES = 256 * 1024;
const CURSOR_INTERVAL_MS = 1000 / LIVE_DEMO.cursorHz;
const RATE_WINDOW_MS = 1000;
const OPEN = 1;

/** The part of a `ws` WebSocket the live client uses, so tests can drive a fake one. */
export interface LiveDemoSocket {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "open" | "pong", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number }) => void): unknown;
}

/** A point in demo space, or null when the person's pointer left the demo. */
export type LiveDemoPointer = { x: number; y: number } | null;

export interface LiveDemoClientDeps {
  apiUrl: string;
  /** Open a room's live socket with the app's bearer token and this app's client id for the room. */
  connect(url: string, token: string, clientId: string): LiveDemoSocket;
  /** The room's identifier on the server, or null for a room kept only on this computer. */
  cloudRoom(roomIdentifier: string): Promise<string | null>;
  /** The app's own sign-in token; never an agent's. */
  token(): Promise<string | null>;
  emit(event: DesktopLiveDemoEvent): void;
  /** Follow the person's pointer over a running demo; null when no demo runs at that lease. */
  watchPointer(leaseUrl: string, listener: (pointer: LiveDemoPointer) => void): (() => void) | null;
  random?: () => number;
}

interface LiveDemo {
  key: string;
  leaseUrl: string | null;
  unwatch: (() => void) | null;
  /** Main sent a cursor from this app's pointer that others still see. */
  pointerShown: boolean;
  /** The latest cursor frame from the pointer, waiting for its turn. */
  pendingCursor: DesktopLiveDemoClientFrame | null;
  cursorTimer: ReturnType<typeof setTimeout> | null;
  cursorSentAt: number;
  /** Send times in the last second, for the server's per-demo limits. */
  cursorSends: number[];
  inkSends: number[];
  rejoinTimer: ReturnType<typeof setTimeout> | null;
}

interface LiveRoom {
  identifier: string;
  demos: Map<string, LiveDemo>;
  socket: LiveDemoSocket | null;
  /** Moves on with every connect and every close main asks for, so an old socket's late events do nothing. */
  generation: number;
  /** Looking up the room and the token before the socket exists. */
  starting: boolean;
  status: DesktopLiveDemoStatus | null;
  reason: string | undefined;
  attempt: number;
  /** When the current socket opened; null before it opens. */
  openedAt: number | null;
  /** The server refused this app; no retry until the chat joins again. */
  refused: boolean;
  alive: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Electron's own WebSocket cannot set headers, so main uses `ws`. The app's
 * bearer goes only in the Authorization header of the upgrade, with no cookie
 * and no Origin, so a web page cannot open the same socket.
 */
export function connectLiveDemoSocket(url: string, token: string, clientId: string): LiveDemoSocket {
  return new WebSocket(url, LIVE_DEMO_PROTOCOL, {
    headers: { Authorization: `Bearer ${token}`, [LIVE_DEMO_CLIENT_HEADER]: clientId },
    handshakeTimeout: 15_000,
    maxPayload: LIVE_DEMO_MAX_INCOMING_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
  });
}

/** `wss://<api>/rooms/<room>/live`; the room id is one encoded path segment, as in the other room routes. */
export function liveDemoSocketUrl(apiUrl: string, cloudRoom: string): string {
  const url = new URL(`${apiUrl.replace(/\/+$/, "")}/rooms/${encodeURIComponent(cloudRoom)}/live`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Capped exponential backoff with jitter: half the step, plus up to half again at random. */
export function liveDemoRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(LIVE_DEMO_RETRY_MAX_MS, LIVE_DEMO_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempt), 16));
  return Math.round(step / 2 + (random() * step) / 2);
}

/** The wait before one more send fits in the last second; 0 when it fits now. */
function rateWait(sends: number[], limit: number, now: number): number {
  while (sends.length > 0 && sends[0]! <= now - RATE_WINDOW_MS) sends.shift();
  return sends.length < limit ? 0 : sends[0]! + RATE_WINDOW_MS - now;
}

function takeRate(sends: number[], limit: number, now: number): boolean {
  if (rateWait(sends, limit, now) > 0) return false;
  sends.push(now);
  return true;
}

function cleanRoomIdentifier(value: unknown): string {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!identifier || identifier.length > 512) throw new Error("Choose a room first.");
  return identifier;
}

function messageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return null;
}

/**
 * Why the server refused this app, in the chat's words; null when a retry may
 * work (429, 503, and the close codes 1001, 1008 and 1013 among them).
 */
function refusalReason(httpStatus: number | null, closeCode: number): string | null {
  if (httpStatus === 401 || closeCode === 4401) return "Your sign-in has expired.";
  if (httpStatus === 403 || closeCode === 4403) return "You are not a member of this room.";
  if (httpStatus === 404) return "This room is not on the server.";
  // The app and the server do not speak the same protocol; a retry gets the same answer.
  if (httpStatus === 400) return "Update LetAgents to see who is here.";
  return null;
}

/** Frames the server always passes: one `gone` after a shown cursor, and the end of a stroke. */
function alwaysPasses(frame: DesktopLiveDemoClientFrame): boolean {
  return (frame.t === "cur" && "gone" in frame) || (frame.t === "ink" && frame.end === true);
}

export class LiveDemoClient {
  private readonly rooms = new Map<string, LiveRoom>();
  /** One random id per room for this app run (a UUID: 36 of [0-9a-f-]), kept when the room's socket closes. */
  private readonly clientIds = new Map<string, string>();
  private readonly random: () => number;

  constructor(private readonly deps: LiveDemoClientDeps) {
    this.random = deps.random ?? Math.random;
  }

  /** Join a demo's live session; a join for a demo already joined only moves its pointer to `leaseUrl`. */
  join(rawRoom: unknown, demoKey: unknown, leaseUrl: unknown): void {
    const identifier = cleanRoomIdentifier(rawRoom);
    if (!isLiveDemoKey(demoKey)) throw new Error("This demo cannot go live.");
    if (leaseUrl !== null && leaseUrl !== undefined && typeof leaseUrl !== "string") throw new Error("The demo link is invalid.");
    let room = this.rooms.get(identifier);
    if (!room) {
      room = this.newRoom(identifier);
      this.rooms.set(identifier, room);
    }
    let demo = room.demos.get(demoKey);
    if (!demo) {
      if (room.demos.size >= LIVE_DEMO.demosPerConnection) {
        throw new Error(`At most ${LIVE_DEMO.demosPerConnection} demos can be live in one room at once.`);
      }
      demo = newDemo(demoKey);
      room.demos.set(demoKey, demo);
      this.sendFrame(room, { t: "join", demo: demoKey });
    }
    this.linkPointer(room, demo, leaseUrl ?? null);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = null;
    if (room.refused || (!room.socket && !room.starting && !room.retryTimer)) {
      room.refused = false;
      room.attempt = 0;
      void this.connect(room, "connecting");
    }
  }

  /** Leave a demo. The room's socket closes after a minute with no demo joined. Unknown demos are ignored. */
  leave(rawRoom: unknown, demoKey: unknown): void {
    const room = this.rooms.get(typeof rawRoom === "string" ? rawRoom.trim() : "");
    const demo = typeof demoKey === "string" ? room?.demos.get(demoKey) : undefined;
    if (!room || !demo) return;
    this.unlinkPointer(room, demo, true);
    if (demo.rejoinTimer) clearTimeout(demo.rejoinTimer);
    demo.rejoinTimer = null;
    room.demos.delete(demo.key);
    this.sendFrame(room, { t: "leave", demo: demo.key });
    if (room.demos.size === 0) this.startIdleClose(room);
  }

  /**
   * Send a frame the chat owns: a cursor or ink in draw mode, for a demo this
   * app joined. Frames past the server's rate are dropped, as the server would.
   */
  send(rawRoom: unknown, rawFrame: unknown): void {
    const frame = parseLiveClientFrame(rawFrame);
    if (!frame || (frame.t !== "cur" && frame.t !== "ink")) throw new Error("Only cursor and drawing frames can be sent.");
    const room = this.rooms.get(typeof rawRoom === "string" ? rawRoom.trim() : "");
    const demo = room?.demos.get(frame.demo);
    if (!room || !demo) throw new Error("This demo is not live in this room.");
    const now = Date.now();
    if (frame.t === "cur") {
      // The chat owns the pointer now: a cursor main still holds back is out of date.
      demo.pendingCursor = null;
      if (demo.cursorTimer) clearTimeout(demo.cursorTimer);
      demo.cursorTimer = null;
    }
    if (room.socket?.readyState !== OPEN) return;
    const sends = frame.t === "cur" ? demo.cursorSends : demo.inkSends;
    const limit = frame.t === "cur" ? LIVE_DEMO.serverCursorPerSecond : LIVE_DEMO.inkFramesPerSecond;
    if (!alwaysPasses(frame) && !takeRate(sends, limit, now)) return;
    if (frame.t === "cur") demo.cursorSentAt = now;
    this.sendFrame(room, frame);
  }

  /** Leave every demo, as when the chat page reloads; sockets close after the idle time. */
  leaveAll(): void {
    for (const room of [...this.rooms.values()]) {
      for (const key of [...room.demos.keys()]) this.leave(room.identifier, key);
    }
  }

  /** Connect every room again with the current sign-in, keeping its joins. */
  reconnectAll(): void {
    for (const room of [...this.rooms.values()]) {
      this.closeSocket(room);
      if (room.demos.size === 0) {
        this.drop(room, "offline");
        continue;
      }
      if (room.retryTimer) clearTimeout(room.retryTimer);
      room.retryTimer = null;
      room.refused = false;
      room.attempt = 0;
      void this.connect(room, "connecting");
    }
  }

  private clientId(identifier: string): string {
    let id = this.clientIds.get(identifier);
    if (!id) {
      id = randomUUID();
      this.clientIds.set(identifier, id);
    }
    return id;
  }

  /** For tests and diagnostics: a room's state and joined demos. */
  inspect(rawRoom: string): { status: DesktopLiveDemoStatus | null; demos: string[]; connected: boolean } | null {
    const room = this.rooms.get(rawRoom.trim());
    return room ? { status: room.status, demos: [...room.demos.keys()], connected: room.socket?.readyState === OPEN } : null;
  }

  private newRoom(identifier: string): LiveRoom {
    return {
      identifier,
      demos: new Map(),
      socket: null,
      generation: 0,
      starting: false,
      status: null,
      reason: undefined,
      attempt: 0,
      openedAt: null,
      refused: false,
      alive: false,
      retryTimer: null,
      idleTimer: null,
      pingTimer: null,
    };
  }

  private async connect(room: LiveRoom, status: "connecting" | "reconnecting"): Promise<void> {
    const generation = ++room.generation;
    room.starting = true;
    this.setStatus(room, status);
    const current = () => this.rooms.get(room.identifier) === room && room.generation === generation;
    let cloudRoom: string | null;
    let token: string | null;
    try {
      [cloudRoom, token] = await Promise.all([this.deps.cloudRoom(room.identifier), this.deps.token()]);
    } catch {
      if (!current()) return;
      room.starting = false;
      this.scheduleRetry(room);
      return;
    }
    if (!current()) return;
    room.starting = false;
    if (cloudRoom === null) {
      // Nothing to retry: the chat joins again if the room moves to the server.
      room.refused = true;
      this.setStatus(room, "offline", "This room is only on this computer.");
      return;
    }
    if (!token) {
      room.refused = true;
      this.setStatus(room, "refused", "Sign in to see who is here.");
      return;
    }
    let socket: LiveDemoSocket;
    try {
      socket = this.deps.connect(liveDemoSocketUrl(this.deps.apiUrl, cloudRoom), token, this.clientId(room.identifier));
    } catch {
      this.scheduleRetry(room);
      return;
    }
    room.socket = socket;
    let httpStatus: number | null = null;
    socket.on("unexpected-response", (_request, response) => {
      httpStatus = typeof response.statusCode === "number" ? response.statusCode : 0;
      socket.terminate();
    });
    // A failed socket always closes after its error; the close decides what happens next.
    socket.on("error", () => undefined);
    socket.on("open", () => {
      if (!current()) return;
      room.openedAt = Date.now();
      room.alive = true;
      this.setStatus(room, "live");
      for (const key of room.demos.keys()) this.sendFrame(room, { t: "join", demo: key });
      this.startPing(room, socket);
    });
    socket.on("pong", () => {
      if (current()) room.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      if (!current()) return;
      room.alive = true;
      this.receive(room, data, isBinary);
    });
    // A socket this app already replaced may still close late, with 4409 when
    // the server saw its replacement: it changes nothing. On the current socket,
    // 4409 is an ordinary drop and the room connects again.
    socket.on("close", (code) => {
      if (current()) this.closed(room, code, httpStatus);
    });
  }

  private receive(room: LiveRoom, data: unknown, isBinary: boolean): void {
    const text = isBinary ? null : messageText(data);
    if (text === null || Buffer.byteLength(text) > LIVE_DEMO_MAX_INCOMING_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const frame = parseLiveServerFrame(value);
    if (!frame) return;
    const key = "demo" in frame ? frame.demo : undefined;
    // Frames for a demo this app has left are late; the chat no longer shows it.
    const demo = key === undefined ? undefined : room.demos.get(key);
    if (key !== undefined && !demo) return;
    if (frame.t === "error" && demo && (frame.code === "rate_limited" || frame.code === "unavailable")) this.rejoinLater(room, demo);
    this.deps.emit({ type: "frame", roomIdentifier: room.identifier, frame });
  }

  /** The server refused a join for now; ask again once, a little later, while the demo is still joined. */
  private rejoinLater(room: LiveRoom, demo: LiveDemo): void {
    if (demo.rejoinTimer) return;
    const socket = room.socket;
    demo.rejoinTimer = setTimeout(() => {
      demo.rejoinTimer = null;
      if (room.demos.get(demo.key) === demo && room.socket === socket) this.sendFrame(room, { t: "join", demo: demo.key });
    }, LIVE_DEMO_REJOIN_MS);
  }

  private closed(room: LiveRoom, code: number, httpStatus: number | null): void {
    const openedFor = room.openedAt === null ? 0 : Date.now() - room.openedAt;
    this.closeSocket(room);
    if (room.demos.size === 0) {
      this.drop(room, "offline");
      return;
    }
    const refusal = refusalReason(httpStatus, code);
    if (refusal) {
      room.refused = true;
      this.setStatus(room, "refused", refusal);
      return;
    }
    if (openedFor >= LIVE_DEMO_STABLE_MS) room.attempt = 0;
    this.setStatus(room, "reconnecting");
    this.scheduleRetry(room);
  }

  private scheduleRetry(room: LiveRoom): void {
    if (room.retryTimer) clearTimeout(room.retryTimer);
    const delay = liveDemoRetryDelayMs(room.attempt, this.random);
    room.attempt += 1;
    room.retryTimer = setTimeout(() => {
      room.retryTimer = null;
      if (this.rooms.get(room.identifier) !== room) return;
      if (room.demos.size === 0) this.drop(room, "offline");
      else void this.connect(room, "reconnecting");
    }, delay);
  }

  private startIdleClose(room: LiveRoom): void {
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      room.idleTimer = null;
      if (room.demos.size === 0 && this.rooms.get(room.identifier) === room) this.drop(room, "offline");
    }, LIVE_DEMO_IDLE_CLOSE_MS);
  }

  private startPing(room: LiveRoom, socket: LiveDemoSocket): void {
    if (room.pingTimer) clearInterval(room.pingTimer);
    room.pingTimer = setInterval(() => {
      if (room.socket !== socket || socket.readyState !== OPEN) return;
      if (!room.alive) {
        socket.terminate();
        return;
      }
      room.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, LIVE_DEMO_PING_MS);
  }

  /** Close the room's socket without hearing from it again, and stop its timers. */
  private closeSocket(room: LiveRoom): void {
    room.generation += 1;
    room.starting = false;
    const socket = room.socket;
    room.socket = null;
    room.openedAt = null;
    if (room.pingTimer) clearInterval(room.pingTimer);
    room.pingTimer = null;
    for (const demo of room.demos.values()) {
      demo.pendingCursor = null;
      for (const timer of [demo.cursorTimer, demo.rejoinTimer]) if (timer) clearTimeout(timer);
      demo.cursorTimer = null;
      demo.rejoinTimer = null;
    }
    if (!socket) return;
    try {
      if (socket.readyState === OPEN) socket.close(1000, "done");
      else socket.terminate();
    } catch {
      // Already closed.
    }
  }

  /** Forget a room: its socket, timers and joins. */
  private drop(room: LiveRoom, status: DesktopLiveDemoStatus): void {
    this.closeSocket(room);
    for (const timer of [room.retryTimer, room.idleTimer]) if (timer) clearTimeout(timer);
    room.retryTimer = null;
    room.idleTimer = null;
    for (const demo of room.demos.values()) this.unlinkPointer(room, demo, false);
    room.demos.clear();
    if (this.rooms.get(room.identifier) === room) this.rooms.delete(room.identifier);
    this.setStatus(room, status);
  }

  private setStatus(room: LiveRoom, status: DesktopLiveDemoStatus, reason?: string): void {
    if (room.status === status && room.reason === reason) return;
    room.status = status;
    room.reason = reason;
    this.deps.emit({ type: "status", roomIdentifier: room.identifier, status, ...(reason ? { reason } : {}) });
  }

  private sendFrame(room: LiveRoom, frame: DesktopLiveDemoClientFrame): boolean {
    const socket = room.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > LIVE_DEMO.frameBytes) return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private linkPointer(room: LiveRoom, demo: LiveDemo, leaseUrl: string | null): void {
    if (demo.leaseUrl === leaseUrl && (demo.unwatch || !leaseUrl)) return;
    this.unlinkPointer(room, demo, true);
    demo.leaseUrl = leaseUrl;
    if (leaseUrl) demo.unwatch = this.deps.watchPointer(leaseUrl, (pointer) => this.pointer(room, demo, pointer));
  }

  private unlinkPointer(room: LiveRoom, demo: LiveDemo, sayGone: boolean): void {
    demo.unwatch?.();
    demo.unwatch = null;
    demo.leaseUrl = null;
    demo.pendingCursor = null;
    if (demo.cursorTimer) clearTimeout(demo.cursorTimer);
    demo.cursorTimer = null;
    if (demo.pointerShown && sayGone) this.sendFrame(room, { t: "cur", demo: demo.key, gone: true });
    demo.pointerShown = false;
  }

  /** The person's pointer over the demo's webview, from main's own input events. */
  private pointer(room: LiveRoom, demo: LiveDemo, pointer: LiveDemoPointer): void {
    if (room.demos.get(demo.key) !== demo) return;
    if (pointer) {
      demo.pointerShown = true;
      this.queueCursor(room, demo, { t: "cur", demo: demo.key, x: pointer.x, y: pointer.y });
    } else if (demo.pointerShown) {
      demo.pointerShown = false;
      this.queueCursor(room, demo, { t: "cur", demo: demo.key, gone: true });
    }
  }

  /** The latest cursor goes out at most LIVE_DEMO.cursorHz times a second; older ones are replaced. */
  private queueCursor(room: LiveRoom, demo: LiveDemo, frame: DesktopLiveDemoClientFrame): void {
    demo.pendingCursor = frame;
    if (!demo.cursorTimer) this.flushCursor(room, demo);
  }

  private flushCursor(room: LiveRoom, demo: LiveDemo): void {
    const frame = demo.pendingCursor;
    if (!frame || room.demos.get(demo.key) !== demo) return;
    const now = Date.now();
    const wait = Math.max(demo.cursorSentAt + CURSOR_INTERVAL_MS - now, rateWait(demo.cursorSends, LIVE_DEMO.serverCursorPerSecond, now));
    if (wait > 0) {
      demo.cursorTimer = setTimeout(() => {
        demo.cursorTimer = null;
        this.flushCursor(room, demo);
      }, wait);
      return;
    }
    demo.pendingCursor = null;
    // Nobody sees a cursor while the socket is down; the next move after it opens goes out.
    if (room.socket?.readyState !== OPEN) return;
    demo.cursorSends.push(now);
    demo.cursorSentAt = now;
    this.sendFrame(room, frame);
  }
}

function newDemo(key: string): LiveDemo {
  return {
    key,
    leaseUrl: null,
    unwatch: null,
    pointerShown: false,
    pendingCursor: null,
    cursorTimer: null,
    cursorSentAt: Number.NEGATIVE_INFINITY,
    cursorSends: [],
    inkSends: [],
    rejoinTimer: null,
  };
}
