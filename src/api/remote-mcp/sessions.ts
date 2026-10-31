import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { OwnerTokenAccount } from "../db/types/auth.js";
import {
  deleteIdleRemoteMcpSessions,
  deleteRemoteMcpSession,
  deleteRemoteMcpSessionForAccount,
  deleteRevokedRemoteMcpSessions,
  getRemoteMcpSession,
  insertRemoteMcpSession,
  listRemoteMcpSessionsForAccount,
  saveRemoteMcpSessionState,
  touchRemoteMcpSession,
  type RemoteMcpSessionRow,
} from "../db/remote-mcp-sessions.js";
import { createLetAgentsMcpServer } from "../../mcp/server/letagents-server.js";
import {
  markHostedMcpRuntime,
  runInSessionScope,
  type McpSessionPersistentState,
  type McpSessionScope,
} from "../../mcp/server/runtime/session-scope.js";
import type { InProcessDispatcher } from "./in-process-dispatch.js";
import { getPollTimeoutCapMs } from "../../shared/poll-timeout-cap.js";
import { RemoteMcpBusyError, RemoteMcpStateTooLargeError } from "./errors.js";
import {
  deriveRemoteMcpStateKey,
  hashRemoteMcpToken,
  openRemoteMcpState,
  sealRemoteMcpState,
} from "./state-crypto.js";

/**
 * Remote MCP sessions served in the API process.
 *
 * Each HTTP request builds a fresh MCP server object from the shared LetAgents
 * registry, runs it inside the session's scope (its saved state, and a
 * dispatcher bound to its account), and saves the state back to Postgres. No
 * session needs this process's memory to continue: any replica, or this one
 * after a restart, reloads it from `remote_mcp_sessions`.
 */

export interface RemoteMcpLimits {
  /** Sessions one account may hold; the least recently used one is replaced. */
  maxSessionsPerAccount: number;
  /** A session unused for this long is deleted. */
  idleTimeoutMs: number;
  /** Requests one account may have in flight at once (long-polls included). */
  maxInFlightPerAccount: number;
  /** Requests in flight at once on this process, all accounts together. */
  maxInFlight: number;
  /** Largest saved state, in bytes before sealing. */
  maxStateBytes: number;
}



const IDLE_MARGIN_MS = 5 * 60_000;

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function remoteMcpLimitsFromEnv(): RemoteMcpLimits {
  return {
    maxSessionsPerAccount: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT", 16),
    // last_seen is refreshed when a request starts, so the timeout must outlast
    // the longest request (a long-poll up to LETAGENTS_POLL_MAX_MS) plus a margin.
    idleTimeoutMs: Math.max(positiveIntEnv("LETAGENTS_REMOTE_MCP_IDLE_TIMEOUT_MS", 30 * 60_000),
      getPollTimeoutCapMs() + IDLE_MARGIN_MS),
    maxInFlightPerAccount: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT_PER_ACCOUNT", 8),
    maxInFlight: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT", 256),
    maxStateBytes: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_STATE_BYTES", 256 * 1024),
  };
}

function emptyState(): McpSessionPersistentState {
  return { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Combine two saves of one session. Maps (agent sessions, workers, room
 * sessions, pinned connections, ...) are unioned key by key; where both have
 * a key, or for single values, `prefer` wins, except that an ended entry
 * stays ended. Nothing either side added is lost.
 */
export function mergeSessionStates(ours: McpSessionPersistentState, theirs: McpSessionPersistentState,
  prefer: "ours" | "theirs"): McpSessionPersistentState {
  const pick = <T>(a: T, b: T): T => (prefer === "ours" ? a : b);
  // An entry that one side ended stays ended: an ended agent session is never revived.
  const pickEntry = (a: unknown, b: unknown): unknown => {
    const endedA = isRecord(a) && Boolean(a.ended_at);
    const endedB = isRecord(b) && Boolean(b.ended_at);
    if (endedA !== endedB) return endedA ? a : b;
    return pick(a, b);
  };
  const unionMap = (a: unknown, b: unknown): unknown => {
    if (!isRecord(a) || !isRecord(b)) return pick(a, b) ?? a ?? b;
    const merged: JsonRecord = { ...a, ...b };
    for (const key of Object.keys(merged)) {
      if (key in a && key in b) merged[key] = pickEntry(a[key], b[key]);
      else merged[key] = key in a ? a[key] : b[key];
    }
    return merged;
  };
  const local: JsonRecord = {};
  for (const key of new Set([...Object.keys(ours.local), ...Object.keys(theirs.local)])) {
    const a = (ours.local as JsonRecord)[key];
    const b = (theirs.local as JsonRecord)[key];
    local[key] = a === undefined ? b : b === undefined ? a : unionMap(a, b);
  }
  return {
    local,
    currentRoom: pick(ours.currentRoom, theirs.currentRoom) ?? ours.currentRoom ?? theirs.currentRoom,
    fullPromptDelivered: ours.fullPromptDelivered || theirs.fullPromptDelivered,
    pinnedConnections: unionMap(ours.pinnedConnections, theirs.pinnedConnections) as McpSessionPersistentState["pinnedConnections"],
  };
}

/** Drop what can never be used again, so the saved state stays small. */
function pruneState(state: McpSessionPersistentState): void {
  for (const [id, connection] of Object.entries(state.pinnedConnections)) {
    if (connection.ended_at) delete state.pinnedConnections[id];
  }
  const rooms = state.local.room_sessions;
  if (rooms) {
    const keep = Object.entries(rooms)
      .sort(([, a], [, b]) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
      .slice(0, 32);
    state.local.room_sessions = Object.fromEntries(keep);
  }
}

function readState(value: unknown): McpSessionPersistentState {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<McpSessionPersistentState>;
  return {
    local: raw.local && typeof raw.local === "object" ? raw.local : {},
    currentRoom: raw.currentRoom ?? null,
    fullPromptDelivered: raw.fullPromptDelivered === true,
    pinnedConnections: raw.pinnedConnections && typeof raw.pinnedConnections === "object" ? raw.pinnedConnections : {},
  };
}

/** One session's loaded state, shared by this process's concurrent requests. */
export interface LoadedRemoteMcpSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly tokenHash: string;
  /** Opens and seals the saved state; derived from the token, never stored. */
  readonly stateKey: Buffer;
  readonly agentInstanceId: string;
  readonly clientName: string | null;
  state: McpSessionPersistentState;
  version: number;
  /** Set by tool calls that changed the state; cleared by a successful save. */
  dirty: boolean;
  lastUsedAt: number;
  readonly memory: Map<string, unknown>;
  saving: Promise<void>;
}

export interface RemoteMcpSessionsOptions {
  dispatcher: InProcessDispatcher;
  publicBaseUrl?: string;
  limits?: Partial<RemoteMcpLimits>;
  sweepIntervalMs?: number;
}

export class RemoteMcpSessions {
  private readonly loaded = new Map<string, LoadedRemoteMcpSession>();
  private readonly limits: RemoteMcpLimits;
  private readonly dispatcher: InProcessDispatcher;
  private readonly publicBaseUrl: string;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly counters = { opened: 0, evicted: 0, swept: 0, busy: 0, conflicts: 0 };
  private readonly inFlightByAccount = new Map<string, number>();
  /** Sessions with a request in flight on this process; the sweep skips them. */
  private readonly inFlightBySession = new Map<string, number>();
  private inFlight = 0;

  constructor(options: RemoteMcpSessionsOptions) {
    this.dispatcher = options.dispatcher;
    this.limits = { ...remoteMcpLimitsFromEnv(), ...options.limits };
    this.publicBaseUrl = (options.publicBaseUrl ?? process.env.LETAGENTS_BASE_URL ?? process.env.PUBLIC_API_URL
      ?? "https://letagents.chat").replace(/\/+$/, "");
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), options.sweepIntervalMs ?? 60_000);
    this.sweepTimer.unref();
    markHostedMcpRuntime();
  }

  /** Sessions loaded in this process, and process-lifetime counts. */
  stats(): { loaded: number; inFlight: number; opened: number; evicted: number; swept: number; busy: number; conflicts: number } {
    return { loaded: this.loaded.size, inFlight: this.inFlight, ...this.counters };
  }

  /** Forget this process's copies, as a restart would. Saved sessions remain. */
  dropLoaded(): void {
    this.loaded.clear();
  }

  close(): void {
    clearInterval(this.sweepTimer);
    this.loaded.clear();
  }

  /** Create a session for an authenticated initialize request. */
  // Two initializes for one account racing here may both see room under the
  // cap and leave it one or two over; the account's next open trims it back.
  // Rare, and bounded by the 10-per-minute create limit.
  async open(input: { accountId: string; token: string; clientName: string | null }): Promise<string> {
    const existing = await listRemoteMcpSessionsForAccount(input.accountId);
    const excess = existing.length - this.limits.maxSessionsPerAccount + 1;
    for (const victim of existing.slice(0, Math.max(0, excess))) {
      await deleteRemoteMcpSessionForAccount(victim.session_id, input.accountId);
      this.loaded.delete(victim.session_id);
      this.counters.evicted += 1;
      // Counts only: no account id or token in server logs.
      console.info("Remote MCP session replaced at the account cap:", JSON.stringify(this.stats()));
    }
    const sessionId = randomUUID();
    const key = deriveRemoteMcpStateKey(input.token, sessionId);
    await insertRemoteMcpSession({
      sessionId,
      accountId: input.accountId,
      tokenHash: hashRemoteMcpToken(input.token),
      agentInstanceId: randomUUID(),
      clientName: input.clientName?.slice(0, 200) ?? null,
      state: sealRemoteMcpState(emptyState(), key, { sessionId, accountId: input.accountId }) as unknown as Record<string, unknown>,
    });
    this.counters.opened += 1;
    return sessionId;
  }

  /**
   * The session for this id, only for the token and account that opened it.
   * A wrong token and an unknown id look the same to the caller.
   */
  async find(sessionId: string, token: string, accountId: string): Promise<LoadedRemoteMcpSession | null> {
    const row = await getRemoteMcpSession(sessionId);
    if (!row) {
      this.loaded.delete(sessionId);
      return null;
    }
    const presented = Buffer.from(hashRemoteMcpToken(token), "hex");
    const stored = Buffer.from(row.token_hash, "hex");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored) || row.account_id !== accountId) {
      return null;
    }
    return this.adopt(row, deriveRemoteMcpStateKey(token, sessionId));
  }

  private adopt(row: RemoteMcpSessionRow, stateKey: Buffer): LoadedRemoteMcpSession | null {
    const current = this.loaded.get(row.session_id);
    if (current && current.version >= row.version) {
      current.lastUsedAt = Date.now();
      return current;
    }
    const opened = openRemoteMcpState(row.state, stateKey, { sessionId: row.session_id, accountId: row.account_id });
    if (opened === null) return null;
    const incoming = readState(opened);
    if (current) {
      // Another replica saved newer state. Merge it into the object that this
      // process's in-flight calls already hold, so none of them keeps a stale copy.
      Object.assign(current.state, mergeSessionStates(current.state, incoming, current.dirty ? "ours" : "theirs"));
      current.version = row.version;
      current.lastUsedAt = Date.now();
      return current;
    }
    const loaded: LoadedRemoteMcpSession = {
      sessionId: row.session_id,
      accountId: row.account_id,
      tokenHash: row.token_hash,
      stateKey,
      agentInstanceId: row.agent_instance_id,
      clientName: row.client_name,
      state: incoming,
      version: row.version,
      dirty: false,
      lastUsedAt: Date.now(),
      memory: new Map(),
      saving: Promise.resolve(),
    };
    this.loaded.set(row.session_id, loaded);
    return loaded;
  }

  /** Serve one MCP HTTP request for a session, as the authenticated account. */
  async handle(session: LoadedRemoteMcpSession, account: OwnerTokenAccount, req: IncomingMessage,
    res: ServerResponse, body: unknown): Promise<void> {
    if (account.account_id !== session.accountId) throw new Error("Remote MCP session account mismatch.");
    const release = this.enter(session.accountId, session.sessionId);
    // The slot is free once the response is written ("finish") or the client
    // is gone ("close"): before the client can send its next call, and before
    // the server-side cleanup and save below.
    const responseDone = new Promise<void>((resolve) => {
      if (res.writableFinished || res.destroyed) resolve();
      res.once("finish", resolve);
      res.once("close", resolve);
    });
    void responseDone.then(release);
    // A dropped client ends the request's in-process calls (long-polls included).
    const disconnected = new AbortController();
    if (res.destroyed) disconnected.abort();
    res.once("close", () => disconnected.abort());
    try {
      // Mark the session used now, not only when a call saves: a long-poll may
      // run longer than a sweep interval.
      await touchRemoteMcpSession(session.sessionId).catch(() => undefined);
      const bound = this.dispatcher.bind({ account, tokenHash: session.tokenHash, remoteMcpSessionId: session.sessionId });
      const scope: McpSessionScope = {
        sessionId: session.sessionId,
        accountId: session.accountId,
        agentInstanceId: session.agentInstanceId,
        clientName: session.clientName,
        publicBaseUrl: this.publicBaseUrl,
        dispatch: (path, init) => bound(path, {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, disconnected.signal]) : disconnected.signal,
        }),
        state: session.state,
        get dirty() { return session.dirty; },
        set dirty(value: boolean) { session.dirty = session.dirty || value; },
        memory: session.memory,
        persist: () => this.save(session),
      };
      // Each request gets its own server object and stateless transport; the
      // session id and state live in Postgres, not in transport memory.
      const server = createLetAgentsMcpServer({ profile: "autonomous_mcp_worker", supervisedProvider: null, remote: true });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      res.setHeader("Mcp-Session-Id", session.sessionId);
      try {
        await runInSessionScope(scope, () => transport.handleRequest(req, res, body));
        await responseDone;
      } finally {
        await server.close().catch(() => undefined);
        session.lastUsedAt = Date.now();
        // Tool calls saved before answering; this saves anything a call that
        // outlived its client changed, and otherwise only marks the session used.
        await this.save(session).catch(() => undefined);
      }
    } finally {
      // Backstop for paths that never wrote a response; release is idempotent.
      release();
    }
  }

  /** Count one request in flight, or refuse it at the caps. */
  private enter(accountId: string, sessionId: string): () => void {
    const own = this.inFlightByAccount.get(accountId) ?? 0;
    if (own >= this.limits.maxInFlightPerAccount || this.inFlight >= this.limits.maxInFlight) {
      this.counters.busy += 1;
      console.warn("Remote MCP request refused at the in-flight cap:", JSON.stringify(this.stats()));
      throw own >= this.limits.maxInFlightPerAccount
        ? new RemoteMcpBusyError(429, "Too many remote MCP requests in flight for this account.")
        : new RemoteMcpBusyError(503, "The remote MCP endpoint is busy. Retry shortly.");
    }
    this.inFlightByAccount.set(accountId, own + 1);
    this.inFlightBySession.set(sessionId, (this.inFlightBySession.get(sessionId) ?? 0) + 1);
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      const sessionCount = (this.inFlightBySession.get(sessionId) ?? 1) - 1;
      if (sessionCount > 0) this.inFlightBySession.set(sessionId, sessionCount);
      else this.inFlightBySession.delete(sessionId);
      const next = (this.inFlightByAccount.get(accountId) ?? 1) - 1;
      if (next > 0) this.inFlightByAccount.set(accountId, next);
      else this.inFlightByAccount.delete(accountId);
    };
  }

  async delete(sessionId: string): Promise<void> {
    this.loaded.delete(sessionId);
    await deleteRemoteMcpSession(sessionId);
  }

  /** Delete idle sessions and sessions whose owner token was revoked. */
  async sweep(now = Date.now()): Promise<void> {
    const cutoff = new Date(now - this.limits.idleTimeoutMs).toISOString();
    // The in-flight skip only knows this process's requests. What protects a
    // session from another replica's sweep is that every request refreshes
    // last_seen when it starts and that the idle timeout is clamped above the
    // longest request (LETAGENTS_POLL_MAX_MS plus a margin).
    const busy = [...this.inFlightBySession.keys()];
    const removed = [...await deleteIdleRemoteMcpSessions(cutoff, busy), ...await deleteRevokedRemoteMcpSessions()];
    for (const id of removed) this.loaded.delete(id);
    this.counters.swept += removed.length;
    // This process's decrypted copies go too, once unused for the idle time.
    for (const [id, session] of this.loaded) {
      if (now - session.lastUsedAt >= this.limits.idleTimeoutMs && !this.inFlightBySession.has(id)) this.loaded.delete(id);
    }
  }

  /**
   * Saves for one session run one at a time. A save writes only when a call
   * changed the state, and only over the version it started from; when another
   * replica saved in between, the two states are merged and written again.
   */
  private save(session: LoadedRemoteMcpSession): Promise<void> {
    const run = session.saving.then(async () => {
      if (!session.dirty) {
        await touchRemoteMcpSession(session.sessionId).catch(() => undefined);
        return;
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const state = session.state;
        pruneState(state);
        const plain = JSON.stringify(state);
        if (Buffer.byteLength(plain) > this.limits.maxStateBytes) throw new RemoteMcpStateTooLargeError();
        const room = (state.currentRoom as { room_id?: unknown } | null)?.room_id;
        const roomId = typeof room === "string" ? room : null;
        // A durable worker handle (pinned) or the legacy current session for the room.
        const pinned = Object.values(state.pinnedConnections)
          .filter((connection) => !roomId || connection.room_id === roomId)
          .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
        const currentId = roomId ? state.local.current_agent_session_ids?.[roomId] : undefined;
        session.dirty = false;
        const version = await saveRemoteMcpSessionState({
          sessionId: session.sessionId,
          expectedVersion: session.version,
          state: sealRemoteMcpState(state, session.stateKey, { sessionId: session.sessionId, accountId: session.accountId }) as unknown as Record<string, unknown>,
          roomId,
          workerSessionId: pinned?.session_id ?? currentId ?? null,
          readCursor: roomId ? state.local.room_sessions?.[roomId]?.last_message_id ?? null : null,
        }).catch((error: unknown) => {
          session.dirty = true;
          throw error;
        });
        if (version !== null) {
          session.version = version;
          return;
        }
        // Not saved: the row is gone, or another replica saved first.
        session.dirty = true;
        const row = await getRemoteMcpSession(session.sessionId);
        if (!row) {
          this.loaded.delete(session.sessionId);
          return;
        }
        const theirs = openRemoteMcpState(row.state, session.stateKey, { sessionId: session.sessionId, accountId: session.accountId });
        if (theirs === null) return;
        this.counters.conflicts += 1;
        Object.assign(session.state, mergeSessionStates(session.state, readState(theirs), "ours"));
        session.version = row.version;
      }
      throw new Error("The remote MCP session state kept changing; retry the call.");
    });
    session.saving = run.catch(() => undefined);
    return run;
  }
}
