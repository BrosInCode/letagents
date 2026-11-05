import { randomBytes } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { LIVE_DEMO, LIVE_DEMO_PROTOCOL, liveDemoColor } from '../../../shared/live-demo.mjs';
import { parseBearerAuthorization } from '../request/bearer-authorization.js';
import type { LiveDemoAccess, LiveRoomDecision } from './access.js';
import type { LiveDemoConnection, LiveDemoHub, LiveDemoSocket } from './hub.js';

// `GET /rooms/<room>/live`: one WebSocket per desktop app per room. Every
// refusal is a plain HTTP answer before the upgrade, so a refused app never
// holds a socket. Auth is the app-session bearer in the Authorization header:
// browsers cannot set that header on a WebSocket, and any Origin header (a web
// page, an extension) is refused as well.

const LIVE_PATH = /^\/rooms\/(.+)\/live$/;

/** The desktop app's id for one app run and room; a new socket with it replaces the old one. */
export const LIVE_DEMO_CLIENT_HEADER = 'x-letagents-live-client';
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface LiveDemoSocketLimits {
  perAccountRoom: number;
  perAccount: number;
  perProcess: number;
  pingMs: number;
  recheckMs: number;
  handshakeMs: number;
  closeGraceMs: number;
  maxPayload: number;
}

export const LIVE_DEMO_SOCKET_LIMITS: Readonly<LiveDemoSocketLimits> = Object.freeze({
  /** Open sockets per account per room: one app, plus room for a second device. */
  perAccountRoom: 4,
  /** Open sockets per account in this process, over all rooms. */
  perAccount: 16,
  /** Open and closing sockets, and handshakes in flight, in this process. */
  perProcess: 2_000,
  pingMs: 30_000,
  recheckMs: 60_000,
  handshakeMs: 10_000,
  /** A socket the server closed is cut off if the peer has not finished closing by then. */
  closeGraceMs: 5_000,
  /** `ws` closes with 1009 above this; the hub drops anything over LIVE_DEMO.frameBytes. */
  maxPayload: 64 * 1024,
});

/** Closed because the session ended or the person lost access to the room. */
export const LIVE_DEMO_CLOSE_REVOKED = 4403;
/** The same app opened a newer socket for this room. */
export const LIVE_DEMO_CLOSE_REPLACED = 4409;
/** The access check could not finish (database or GitHub); reconnect later. */
export const LIVE_DEMO_CLOSE_RETRY = 1013;
export const LIVE_DEMO_CLOSE_GOING_AWAY = 1001;

/** Checks whose "allow" a newer invalidation made stale, before the socket is closed to be safe. */
const STALE_CHECK_ROUNDS = 3;

export interface LiveDemoSocketOptions {
  access: LiveDemoAccess;
  hub: LiveDemoHub;
  limits?: Partial<LiveDemoSocketLimits>;
  onError?: (error: unknown) => void;
}

export interface LiveDemoSockets {
  /**
   * Re-checks at once the sockets whose access room or login matches (both
   * lowercase). They get no frames until the check allows them again.
   */
  recheckWhere(match: { accessRoomName?: string | null; login?: string | null }): void;
  /** `queuedBytes`: bytes waiting to be sent, over all sockets. */
  stats(): { sockets: number; handshakes: number; queuedBytes: number };
  /** Closes every socket with 1001 and stops taking upgrades. */
  close(): Promise<void>;
}

interface LiveSocket {
  ws: WebSocket;
  connection: LiveDemoConnection;
  token: string;
  accountId: string;
  login: string;
  roomId: string;
  accessRoomName: string;
  clientId: string | null;
  alive: boolean;
  /** The payload of the last ping; only a pong that echoes it counts. */
  pingId: Buffer | null;
  recheck: ReturnType<typeof setInterval>;
  /** Bumped by every check request; an "allow" for an older one is stale. */
  generation: number;
  checking: Promise<void> | null;
  counted: boolean;
  /** The server sent its close frame. */
  closing: boolean;
  /** The socket is gone. */
  closed: boolean;
  grace: ReturnType<typeof setTimeout> | null;
}

function offeredProtocols(req: IncomingMessage): Set<string> {
  return new Set(String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim()).filter(Boolean));
}

function refuse(socket: Duplex, status: number, error: string, message: string, headers: Record<string, string> = {}): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error, message });
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`);
}

function personName(account: { display_name: string | null; login: string }): string {
  return (account.display_name?.trim() || account.login).slice(0, LIVE_DEMO.name);
}

export function attachLiveDemoSockets(server: Server, options: LiveDemoSocketOptions): LiveDemoSockets {
  const limits = { ...LIVE_DEMO_SOCKET_LIMITS, ...options.limits };
  const onError = options.onError ?? ((error: unknown) => console.error('[live demos]', error));
  const { access, hub } = options;
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: limits.maxPayload,
    handleProtocols: (protocols) => (protocols.has(LIVE_DEMO_PROTOCOL) ? LIVE_DEMO_PROTOCOL : false),
  });
  const sockets = new Set<LiveSocket>();
  const perAccountRoom = new Map<string, number>();
  const perAccount = new Map<string, number>();
  let handshakes = 0;
  let closing = false;

  const roomKey = (roomId: string, accountId: string) => `${roomId}\n${accountId}`;
  const bump = (map: Map<string, number>, key: string, by: number) => {
    const count = (map.get(key) ?? 0) + by;
    if (count > 0) map.set(key, count);
    else map.delete(key);
  };
  // The account caps count open sockets; one the server is closing no longer counts.
  const uncount = (entry: LiveSocket) => {
    if (!entry.counted) return;
    entry.counted = false;
    bump(perAccountRoom, roomKey(entry.roomId, entry.accountId), -1);
    bump(perAccount, entry.accountId, -1);
  };

  /** The open sockets of the same app in the same room, which a new socket replaces. */
  const replaceable = (accountId: string, roomId: string, clientId: string | null) => (clientId
    ? [...sockets].filter((entry) => entry.counted && entry.accountId === accountId && entry.roomId === roomId && entry.clientId === clientId)
    : []);

  const capRefusal = (accountId: string, roomId: string, clientId: string | null): string | null => {
    const freed = replaceable(accountId, roomId, clientId).length;
    if ((perAccountRoom.get(roomKey(roomId, accountId)) ?? 0) - freed >= limits.perAccountRoom) {
      return 'This account already has live demos open in this room.';
    }
    if ((perAccount.get(accountId) ?? 0) - freed >= limits.perAccount) {
      return 'This account has live demos open in too many rooms.';
    }
    return null;
  };

  /** The one way the server closes a socket: out of every demo now, cut off if the peer does not finish closing. */
  const end = (entry: LiveSocket, code: number, reason: string) => {
    if (entry.closing || entry.closed) return;
    entry.closing = true;
    uncount(entry);
    clearInterval(entry.recheck);
    entry.connection.disconnect();
    try {
      entry.ws.close(code, reason);
    } catch (error) {
      onError(error);
      entry.ws.terminate();
      return;
    }
    // A peer that stopped reading never answers the close frame.
    entry.grace = setTimeout(() => entry.ws.terminate(), limits.closeGraceMs);
    entry.grace.unref?.();
  };

  const decide = async (entry: LiveSocket): Promise<LiveRoomDecision> => {
    const account = await access.authenticate(entry.token);
    if (!account || account.account_id !== entry.accountId) return 'deny';
    const room = await access.findRoom(entry.roomId);
    if (!room || room.id !== entry.roomId) return 'deny';
    return (await access.canView(room, account, { fresh: true })).decision;
  };

  /**
   * Checks the socket's session and access again. An invalidation also holds
   * the socket's frames until a check that started after it allows them; a
   * request during a running check makes that check run once more.
   */
  const recheck = (entry: LiveSocket, invalidated = false) => {
    if (entry.closing || entry.closed) return;
    entry.generation += 1;
    if (invalidated) entry.connection.hold(true);
    if (entry.checking) return;
    entry.checking = (async () => {
      for (let round = 0; ; round += 1) {
        const generation = entry.generation;
        let decision: LiveRoomDecision | 'failed';
        try {
          decision = await decide(entry);
        } catch (error) {
          onError(error);
          decision = 'failed';
        }
        if (entry.closing || entry.closed) return;
        if (decision === 'allow' && generation !== entry.generation) {
          if (round < STALE_CHECK_ROUNDS) continue;
          end(entry, LIVE_DEMO_CLOSE_RETRY, 'Access check unavailable');
          return;
        }
        // A refusal is never stale: closing is the safe answer either way.
        if (decision === 'allow') entry.connection.hold(false);
        else if (decision === 'deny') end(entry, LIVE_DEMO_CLOSE_REVOKED, 'Access ended');
        else end(entry, LIVE_DEMO_CLOSE_RETRY, decision === 'failed' ? 'Access check failed' : 'Access check unavailable');
        return;
      }
    })().finally(() => { entry.checking = null; });
  };

  const start = (ws: WebSocket, input: Pick<LiveSocket, 'token' | 'accountId' | 'login' | 'roomId' | 'accessRoomName' | 'clientId'> & { name: string }) => {
    for (const old of replaceable(input.accountId, input.roomId, input.clientId)) {
      end(old, LIVE_DEMO_CLOSE_REPLACED, 'Replaced by a newer connection');
    }
    let entry: LiveSocket | null = null;
    // The hub closes a socket through `end` too (bad frames, a full queue).
    const socket: LiveDemoSocket = {
      get readyState() { return ws.readyState; },
      get bufferedAmount() { return ws.bufferedAmount; },
      send: (data) => ws.send(data),
      close: (code, reason) => (entry ? end(entry, code, reason) : ws.close(code, reason)),
    };
    const connection = hub.connect({
      roomId: input.roomId,
      accountId: input.accountId,
      name: input.name,
      color: liveDemoColor(input.accountId),
      socket,
    });
    const created: LiveSocket = {
      ws,
      connection,
      token: input.token,
      accountId: input.accountId,
      login: input.login,
      roomId: input.roomId,
      accessRoomName: input.accessRoomName,
      clientId: input.clientId,
      alive: true,
      pingId: null,
      recheck: setInterval(() => recheck(created), limits.recheckMs),
      generation: 0,
      checking: null,
      counted: true,
      closing: false,
      closed: false,
      grace: null,
    };
    entry = created;
    created.recheck.unref?.();
    sockets.add(created);
    bump(perAccountRoom, roomKey(created.roomId, created.accountId), 1);
    bump(perAccount, created.accountId, 1);
    ws.on('message', (data, isBinary) => {
      try {
        connection.receive(data as Buffer, isBinary);
      } catch (error) {
        onError(error);
      }
    });
    ws.on('pong', (data) => {
      // Only the answer to the server's own ping proves the peer reads.
      if (created.pingId && Buffer.isBuffer(data) && data.equals(created.pingId)) {
        created.alive = true;
        created.pingId = null;
      }
    });
    ws.on('error', () => { /* `close` follows */ });
    ws.on('close', () => {
      if (created.closed) return;
      created.closed = true;
      clearInterval(created.recheck);
      if (created.grace) clearTimeout(created.grace);
      sockets.delete(created);
      uncount(created);
      connection.disconnect();
    });
  };

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node hands every Upgrade request here, whatever its path.
    const match = LIVE_PATH.exec(new URL(req.url ?? '/', 'http://live.invalid').pathname);
    if (!match) {
      refuse(socket, 404, 'not_found', 'Not found.');
      return;
    }
    if (closing) {
      refuse(socket, 503, 'server_restarting', 'The server is restarting. Try again soon.', { 'Retry-After': '5' });
      return;
    }
    if (req.headers.origin !== undefined) {
      refuse(socket, 403, 'origin_refused', 'Live demos open from the LetAgents app only.');
      return;
    }
    const credential = parseBearerAuthorization(req.headers.authorization);
    if (credential.kind !== 'token') {
      refuse(socket, 401, 'auth_required', 'Sign in to LetAgents to view demos live.');
      return;
    }
    if (!offeredProtocols(req).has(LIVE_DEMO_PROTOCOL)) {
      refuse(socket, 400, 'protocol_required', `Use the ${LIVE_DEMO_PROTOCOL} subprotocol.`);
      return;
    }
    const clientHeader = req.headers[LIVE_DEMO_CLIENT_HEADER];
    if (clientHeader !== undefined && (typeof clientHeader !== 'string' || !CLIENT_ID.test(clientHeader))) {
      refuse(socket, 400, 'invalid_client_id', 'The live client id is not valid.');
      return;
    }
    const clientId = clientHeader ?? null;
    let roomId: string;
    try {
      roomId = decodeURIComponent(match[1]!);
    } catch {
      refuse(socket, 400, 'invalid_room', 'The room id is not valid.');
      return;
    }
    if (sockets.size + handshakes >= limits.perProcess) {
      refuse(socket, 503, 'live_demo_busy', 'Live demos are busy. Try again soon.', { 'Retry-After': '30' });
      return;
    }
    handshakes += 1;
    // A database that hangs must not hold the socket forever.
    const timer = setTimeout(() => socket.destroy(), limits.handshakeMs);
    try {
      const account = await access.authenticate(credential.token);
      if (!account) {
        refuse(socket, 401, 'auth_required', 'Sign in to LetAgents to view demos live.');
        return;
      }
      const room = await access.findRoom(roomId);
      if (!room) {
        refuse(socket, 404, 'room_not_found', 'Room not found.');
        return;
      }
      // Before the GitHub check, so a capped account costs no GitHub call.
      const early = capRefusal(account.account_id, room.id, clientId);
      if (early) {
        refuse(socket, 429, 'too_many_live_connections', early, { 'Retry-After': '30' });
        return;
      }
      // Fresh: a cached GitHub answer may be up to 30 minutes old.
      const view = await access.canView(room, account, { fresh: true });
      if (view.decision === 'unavailable') {
        refuse(socket, 503, 'repo_access_unavailable', 'GitHub did not answer the access check. Try again soon.', { 'Retry-After': '30' });
        return;
      }
      if (view.decision !== 'allow') {
        refuse(socket, 403, 'room_access_required', 'Only people who can open this room can view its demos live.');
        return;
      }
      if (socket.destroyed || closing) return;
      // Other upgrades ran during the checks; from here on all is synchronous.
      const late = capRefusal(account.account_id, room.id, clientId);
      if (late) {
        refuse(socket, 429, 'too_many_live_connections', late, { 'Retry-After': '30' });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => start(ws, {
        token: credential.token,
        accountId: account.account_id,
        login: account.login.trim().toLowerCase(),
        name: personName(account),
        roomId: room.id,
        accessRoomName: view.accessRoomName,
        clientId,
      }));
    } finally {
      clearTimeout(timer);
      handshakes -= 1;
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => { /* a reset during the checks */ });
    void upgrade(req, socket, head).catch((error) => {
      onError(error);
      refuse(socket, 500, 'live_demo_failed', 'Live demos could not start. Try again soon.');
    });
  };
  server.on('upgrade', onUpgrade);

  // A peer that did not answer the last ping by the next one is gone.
  const ping = setInterval(() => {
    for (const entry of sockets) {
      if (entry.closing) continue;
      if (!entry.alive) {
        entry.ws.terminate();
        continue;
      }
      entry.alive = false;
      entry.pingId = randomBytes(8);
      try {
        entry.ws.ping(entry.pingId);
      } catch (error) {
        onError(error);
      }
    }
  }, limits.pingMs);
  ping.unref?.();

  return {
    recheckWhere(match) {
      for (const entry of sockets) {
        if (match.accessRoomName && entry.accessRoomName !== match.accessRoomName) continue;
        if (match.login && entry.login !== match.login) continue;
        recheck(entry, true);
      }
    },
    stats: () => {
      let queuedBytes = 0;
      for (const entry of sockets) queuedBytes += entry.ws.bufferedAmount;
      return { sockets: sockets.size, handshakes, queuedBytes };
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(ping);
      server.off('upgrade', onUpgrade);
      for (const entry of [...sockets]) end(entry, LIVE_DEMO_CLOSE_GOING_AWAY, 'Server is restarting');
      const deadline = Date.now() + 2_000;
      while (sockets.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      for (const entry of [...sockets]) entry.ws.terminate();
      wss.close();
    },
  };
}
