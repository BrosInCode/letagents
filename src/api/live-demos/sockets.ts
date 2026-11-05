import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { LIVE_DEMO, LIVE_DEMO_PROTOCOL, liveDemoColor } from '../../../shared/live-demo.mjs';
import { parseBearerAuthorization } from '../request/bearer-authorization.js';
import type { LiveDemoAccess, LiveRoomDecision } from './access.js';
import type { LiveDemoConnection, LiveDemoHub } from './hub.js';

// `GET /rooms/<room>/live`: one WebSocket per desktop app per room. Every
// refusal is a plain HTTP answer before the upgrade, so a refused app never
// holds a socket. Auth is the app-session bearer in the Authorization header:
// browsers cannot set that header on a WebSocket, and any Origin header (a web
// page, an extension) is refused as well.

const LIVE_PATH = /^\/rooms\/(.+)\/live$/;

export interface LiveDemoSocketLimits {
  perAccountRoom: number;
  perProcess: number;
  pingMs: number;
  recheckMs: number;
  handshakeMs: number;
  maxPayload: number;
}

export const LIVE_DEMO_SOCKET_LIMITS: Readonly<LiveDemoSocketLimits> = Object.freeze({
  /** Open sockets per account per room: one app, plus room for a reconnect and a second device. */
  perAccountRoom: 4,
  /** Open sockets and handshakes in flight in this process. */
  perProcess: 2_000,
  pingMs: 30_000,
  recheckMs: 60_000,
  handshakeMs: 10_000,
  /** `ws` closes with 1009 above this; the hub drops anything over LIVE_DEMO.frameBytes. */
  maxPayload: 64 * 1024,
});

/** Closed because the session ended or the person lost access to the room. */
export const LIVE_DEMO_CLOSE_REVOKED = 4403;
/** The access check could not finish (database or GitHub); reconnect later. */
export const LIVE_DEMO_CLOSE_RETRY = 1013;
export const LIVE_DEMO_CLOSE_GOING_AWAY = 1001;

export interface LiveDemoSocketOptions {
  access: LiveDemoAccess;
  hub: LiveDemoHub;
  limits?: Partial<LiveDemoSocketLimits>;
  onError?: (error: unknown) => void;
}

export interface LiveDemoSockets {
  /** Re-checks at once the sockets whose access room or login matches (both lowercase). */
  recheckWhere(match: { accessRoomName?: string | null; login?: string | null }): void;
  stats(): { sockets: number; handshakes: number };
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
  alive: boolean;
  recheck: ReturnType<typeof setInterval>;
  checking: Promise<void> | null;
  closed: boolean;
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
  let handshakes = 0;
  let closing = false;

  const end = (entry: LiveSocket, code: number, reason: string) => {
    if (entry.closed) return;
    // Out of every demo now, not when the closing handshake finishes.
    entry.connection.disconnect();
    try {
      entry.ws.close(code, reason);
    } catch (error) {
      onError(error);
      entry.ws.terminate();
    }
  };

  const decide = async (entry: LiveSocket): Promise<LiveRoomDecision> => {
    const account = await access.authenticate(entry.token);
    if (!account || account.account_id !== entry.accountId) return 'deny';
    const room = await access.findRoom(entry.roomId);
    if (!room || room.id !== entry.roomId) return 'deny';
    return (await access.canView(room, account, { fresh: true })).decision;
  };

  const recheck = (entry: LiveSocket) => {
    if (entry.closed || entry.checking) return;
    entry.checking = decide(entry).then(
      (decision) => {
        if (decision === 'unavailable') end(entry, LIVE_DEMO_CLOSE_RETRY, 'Access check unavailable');
        else if (decision !== 'allow') end(entry, LIVE_DEMO_CLOSE_REVOKED, 'Access ended');
      },
      (error) => {
        onError(error);
        end(entry, LIVE_DEMO_CLOSE_RETRY, 'Access check failed');
      },
    ).finally(() => { entry.checking = null; });
  };

  const start = (ws: WebSocket, input: Omit<LiveSocket, 'ws' | 'connection' | 'alive' | 'recheck' | 'checking' | 'closed'> & { name: string }) => {
    const key = `${input.roomId}\n${input.accountId}`;
    perAccountRoom.set(key, (perAccountRoom.get(key) ?? 0) + 1);
    const connection = hub.connect({
      roomId: input.roomId,
      accountId: input.accountId,
      name: input.name,
      color: liveDemoColor(input.accountId),
      socket: ws,
    });
    const entry: LiveSocket = {
      ws,
      connection,
      token: input.token,
      accountId: input.accountId,
      login: input.login,
      roomId: input.roomId,
      accessRoomName: input.accessRoomName,
      alive: true,
      recheck: setInterval(() => recheck(entry), limits.recheckMs),
      checking: null,
      closed: false,
    };
    entry.recheck.unref?.();
    sockets.add(entry);
    ws.on('message', (data, isBinary) => {
      try {
        connection.receive(data as Buffer, isBinary);
      } catch (error) {
        onError(error);
      }
    });
    ws.on('pong', () => { entry.alive = true; });
    ws.on('error', () => { /* `close` follows */ });
    ws.on('close', () => {
      if (entry.closed) return;
      entry.closed = true;
      clearInterval(entry.recheck);
      sockets.delete(entry);
      const count = (perAccountRoom.get(key) ?? 1) - 1;
      if (count > 0) perAccountRoom.set(key, count);
      else perAccountRoom.delete(key);
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
      const view = await access.canView(room, account);
      if (view.decision === 'unavailable') {
        refuse(socket, 503, 'repo_access_unavailable', 'GitHub did not answer the access check. Try again soon.', { 'Retry-After': '30' });
        return;
      }
      if (view.decision !== 'allow') {
        refuse(socket, 403, 'room_access_required', 'Only people who can open this room can view its demos live.');
        return;
      }
      if ((perAccountRoom.get(`${room.id}\n${account.account_id}`) ?? 0) >= limits.perAccountRoom) {
        refuse(socket, 429, 'too_many_live_connections', 'This account already has live demos open in this room.', { 'Retry-After': '30' });
        return;
      }
      if (socket.destroyed || closing) return;
      // Synchronous from here: no other upgrade can take the slot checked above.
      wss.handleUpgrade(req, socket, head, (ws) => start(ws, {
        token: credential.token,
        accountId: account.account_id,
        login: account.login.trim().toLowerCase(),
        name: personName(account),
        roomId: room.id,
        accessRoomName: view.accessRoomName,
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

  // A peer that missed one ping by the next one is gone.
  const ping = setInterval(() => {
    for (const entry of sockets) {
      if (!entry.alive) {
        entry.ws.terminate();
        continue;
      }
      entry.alive = false;
      try {
        entry.ws.ping();
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
        recheck(entry);
      }
    },
    stats: () => ({ sockets: sockets.size, handshakes }),
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(ping);
      server.off('upgrade', onUpgrade);
      const open = [...sockets];
      for (const entry of open) end(entry, LIVE_DEMO_CLOSE_GOING_AWAY, 'Server is restarting');
      const deadline = Date.now() + 2_000;
      while (sockets.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      for (const entry of [...sockets]) entry.ws.terminate();
      wss.close();
    },
  };
}
