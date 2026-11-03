import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { OwnerTokenAccount } from "../db/types/auth.js";
import {
  deleteIdleRemoteMcpSessions,
  deleteRemoteMcpSession,
  deleteRemoteMcpSessionForAccount,
  deleteRevokedRemoteMcpCredentials,
  deleteRevokedRemoteMcpSessions,
  findImplicitRemoteMcpSession,
  getRemoteMcpCredential,
  getRemoteMcpSession,
  insertRemoteMcpSession,
  isRemoteMcpCredentialLive,
  listRemoteMcpSessionsForAccount,
  saveRemoteMcpCredentialState,
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
  CREDENTIAL_LOCAL_KEYS,
  credentialMaxWorkers,
  emptyState,
  foldIntoCredential,
  mergeSessionStates,
  projectCredentialState,
  pruneState,
  readState,
  SEED_SHARE_OF_STATE_CAP,
  type JsonRecord,
} from "./credential-state.js";

export { credentialMaxWorkers, foldIntoCredential, mergeSessionStates, projectCredentialState } from "./credential-state.js";
import { IMPLICIT_CLIENT_NAME } from "./implicit-session.js";
import {
  deriveRemoteMcpCredentialStateKey,
  deriveRemoteMcpStateKey,
  hashRemoteMcpToken,
  openRemoteMcpState,
  REMOTE_MCP_CREDENTIAL_BINDING,
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
 *
 * The credential that opened a session (an owner token or an OAuth grant) also
 * has one row in `remote_mcp_credentials`: the worker handles, the agent
 * sessions and pinned connections they point at, and the read cursors of
 * every session it opened (`projectCredentialState`), folded in after each
 * session save. A new session starts from that state, and never from another
 * session's joined room. So a client that opens a new MCP session for every
 * tool call, as ChatGPT's connector does, still finds its worker handles; and
 * a client that sends no session id at all is served in the credential's one
 * implicit session, which re-reads the credential state on every request.
 */

export { IMPLICIT_CLIENT_NAME };

export interface RemoteMcpLimits {
  /** Stateful sessions one credential (sign-in) may hold; the least recently used one is replaced. */
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
/** Stateful session rows one account may hold across all its credentials, as a multiple of the per-credential cap. */
const ACCOUNT_BACKSTOP_FACTOR = 4;

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

/** Per-process memory key: the credential view this session was last seeded with or folded into. */
const BASELINE_KEY = "remote-mcp-credential-baseline";

/** One session's loaded state, shared by this process's concurrent requests. */
export interface LoadedRemoteMcpSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly tokenHash: string;
  /** Opens and seals the saved state; derived from the token, never stored. */
  readonly stateKey: Buffer;
  /** Opens and seals the credential's merged state; derived from the token, never stored. */
  readonly credentialKey: Buffer;
  readonly agentInstanceId: string;
  readonly clientName: string | null;
  state: McpSessionPersistentState;
  version: number;
  /** Set by tool calls that changed the state; cleared by a successful save. */
  dirty: boolean;
  /** Set with `dirty`; cleared only once the credential row holds the change. */
  credentialDirty: boolean;
  /** Counts changes; a fold that started before a change does not clear the flag. */
  credentialChanges: number;
  /** The credential's one session for requests sent without a session id. */
  readonly implicit: boolean;
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

  /** The credential's saved state (already a projection), or null when it has none this account can open. */
  private async loadCredentialState(tokenHash: string, credentialKey: Buffer, accountId: string): Promise<{
    state: McpSessionPersistentState; version: number;
  } | null> {
    const row = await getRemoteMcpCredential(tokenHash);
    if (!row || row.account_id !== accountId) return null;
    const opened = openRemoteMcpState(row.state, credentialKey, { sessionId: REMOTE_MCP_CREDENTIAL_BINDING, accountId });
    return opened === null ? null : { state: projectCredentialState(readState(opened)), version: row.version };
  }

  /**
   * Create a session for an authenticated initialize request, or the
   * credential's implicit session. It starts from the credential's saved
   * worker state (never from another session's room), so a worker registered
   * in an earlier session of the same credential is usable here. For an
   * implicit session that already exists, its id is returned instead.
   */
  // Two initializes for one account racing here may both see room under the
  // cap and leave it one or two over; the account's next open trims it back.
  // Rare, and bounded by the per-minute create limit.
  async open(input: { accountId: string; token: string; clientName: string | null; implicit?: boolean }): Promise<string> {
    const tokenHash = hashRemoteMcpToken(input.token);
    const implicit = input.implicit === true;
    const loaded = await this.loadCredentialState(tokenHash, deriveRemoteMcpCredentialStateKey(input.token), input.accountId);
    // The seed must leave the session room of its own under the size cap.
    let seed = loaded?.state ?? emptyState();
    for (let maxWorkers = credentialMaxWorkers();
      Buffer.byteLength(JSON.stringify(seed)) > this.limits.maxStateBytes * SEED_SHARE_OF_STATE_CAP && maxWorkers > 1;
      maxWorkers = Math.floor(maxWorkers / 2)) {
      seed = projectCredentialState(seed, Math.floor(maxWorkers / 2));
    }
    // The cap bounds the stateful sessions of one credential, so one sign-in's
    // churn (a client that opens a session per call) never replaces another
    // sign-in's sessions. A credential's one implicit session is bounded by
    // being one per credential, so it neither counts nor is replaced. An
    // account-wide backstop bounds the rows an account with many sign-ins holds.
    const stateful = (await listRemoteMcpSessionsForAccount(input.accountId)).filter((row) => !row.implicit);
    const own = stateful.filter((row) => row.token_hash === tokenHash);
    const excess = implicit ? 0 : Math.max(
      own.length - this.limits.maxSessionsPerAccount + 1,
      stateful.length - this.limits.maxSessionsPerAccount * ACCOUNT_BACKSTOP_FACTOR + 1,
    );
    if (excess > 0) {
      // This credential's least recently used first, then the account's; a
      // session with a request in flight on this process stays.
      const victims = [...own, ...stateful.filter((row) => row.token_hash !== tokenHash)]
        .filter((row) => !this.inFlightBySession.has(row.session_id))
        .slice(0, excess);
      for (const victim of victims) {
        await deleteRemoteMcpSessionForAccount(victim.session_id, input.accountId);
        this.loaded.delete(victim.session_id);
        this.counters.evicted += 1;
        // Counts only: no account id or token in server logs.
        console.info("Remote MCP session replaced at the account cap:", JSON.stringify(this.stats()));
      }
    }
    const sessionId = randomUUID();
    const key = deriveRemoteMcpStateKey(input.token, sessionId);
    const inserted = await insertRemoteMcpSession({
      sessionId,
      accountId: input.accountId,
      tokenHash,
      agentInstanceId: randomUUID(),
      clientName: implicit ? IMPLICIT_CLIENT_NAME : input.clientName?.slice(0, 200) ?? null,
      implicit,
      state: sealRemoteMcpState(seed, key, { sessionId, accountId: input.accountId }) as unknown as Record<string, unknown>,
    });
    if (!inserted) {
      // Only an implicit session can collide: another request created it first.
      const current = await findImplicitRemoteMcpSession(input.accountId, tokenHash);
      if (!current) throw new Error("The remote MCP session could not be created.");
      return current.session_id;
    }
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
    return await this.adopt(row, deriveRemoteMcpStateKey(token, sessionId), deriveRemoteMcpCredentialStateKey(token));
  }

  /**
   * The session that serves this credential's requests sent without a session
   * id, when it exists. Such a client never learns a session id, so it never
   * shares a stateful client's session either. Each request re-reads the
   * credential's worker state, so a worker another session of this credential
   * registered since is usable at once; the session's own room stays.
   */
  async findImplicit(input: { accountId: string; token: string }): Promise<LoadedRemoteMcpSession | null> {
    const tokenHash = hashRemoteMcpToken(input.token);
    const row = await findImplicitRemoteMcpSession(input.accountId, tokenHash);
    if (!row) return null;
    const credentialKey = deriveRemoteMcpCredentialStateKey(input.token);
    const session = await this.adopt(row, deriveRemoteMcpStateKey(input.token, row.session_id), credentialKey);
    // No refresh while a request of this session runs here (it would read a
    // state replaced under it), nor while a change of this process is not yet
    // folded into the credential (the refresh would drop it). The next save
    // folds it, and the next request refreshes.
    if (session && !session.credentialDirty && !this.inFlightBySession.has(session.sessionId)) {
      const credential = await this.loadCredentialState(tokenHash, credentialKey, input.accountId);
      if (credential && !session.credentialDirty && !this.inFlightBySession.has(session.sessionId)) {
        this.adoptCredentialView(session, credential.state);
      }
    }
    return session;
  }

  /** Replace the session's worker state with the credential's, and make that its baseline. */
  private adoptCredentialView(session: LoadedRemoteMcpSession, view: McpSessionPersistentState): void {
    const local = session.state.local as JsonRecord;
    for (const key of CREDENTIAL_LOCAL_KEYS) {
      if ((view.local as JsonRecord)[key] !== undefined) local[key] = structuredClone((view.local as JsonRecord)[key]);
      else delete local[key];
    }
    session.state.pinnedConnections = structuredClone(view.pinnedConnections);
    session.memory.set(BASELINE_KEY, structuredClone(view));
  }

  private async adopt(row: RemoteMcpSessionRow, stateKey: Buffer, credentialKey: Buffer): Promise<LoadedRemoteMcpSession | null> {
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
      // process's in-flight calls already hold, so none of them keeps a stale
      // copy. What it brought counts as folded: it is not this process's change.
      Object.assign(current.state, mergeSessionStates(current.state, incoming, current.dirty ? "ours" : "theirs"));
      const baseline = current.memory.get(BASELINE_KEY) as McpSessionPersistentState | undefined;
      if (baseline) current.memory.set(BASELINE_KEY, foldIntoCredential(baseline, projectCredentialState(incoming), null));
      current.version = row.version;
      current.lastUsedAt = Date.now();
      return current;
    }
    // The baseline is the credential's own view, so anything this session
    // holds beyond it (a change an earlier process did not fold) is folded on
    // the next save. Without a credential row, the session's view stands in.
    const credential = await this.loadCredentialState(row.token_hash, credentialKey, row.account_id);
    const loaded: LoadedRemoteMcpSession = {
      sessionId: row.session_id,
      accountId: row.account_id,
      tokenHash: row.token_hash,
      stateKey,
      credentialKey,
      agentInstanceId: row.agent_instance_id,
      clientName: row.client_name,
      implicit: row.implicit,
      state: incoming,
      version: row.version,
      dirty: false,
      credentialDirty: false,
      credentialChanges: 0,
      lastUsedAt: Date.now(),
      memory: new Map(),
      saving: Promise.resolve(),
    };
    loaded.memory.set(BASELINE_KEY, credential ? credential.state : projectCredentialState(incoming));
    // A process may have loaded this session before another replica's load;
    // keep the first object so no in-flight call holds a stale copy.
    return this.loaded.get(row.session_id) ?? (this.loaded.set(row.session_id, loaded), loaded);
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
        set dirty(value: boolean) {
          session.dirty = session.dirty || value;
          if (value) {
            session.credentialDirty = true;
            session.credentialChanges += 1;
          }
        },
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
    // Credential state is never idle-deleted: it is what a new session starts
    // from. It goes when its owner token or OAuth grant goes.
    await deleteRevokedRemoteMcpCredentials();
    // This process's decrypted copies go too, once unused for the idle time.
    for (const [id, session] of this.loaded) {
      if (now - session.lastUsedAt >= this.limits.idleTimeoutMs && !this.inFlightBySession.has(id)) this.loaded.delete(id);
    }
  }

  /**
   * Saves for one session run one at a time. A save writes only when a call
   * changed the state, and only over the version it started from; when another
   * replica saved in between, the two states are merged and written again.
   * After the session row, the credential's merged state is written the same
   * way, so the next session of this credential starts from it.
   */
  private save(session: LoadedRemoteMcpSession): Promise<void> {
    const run = session.saving.then(async () => {
      if (!session.dirty && !session.credentialDirty) {
        await touchRemoteMcpSession(session.sessionId).catch(() => undefined);
        return;
      }
      if (session.dirty) await this.saveSessionRow(session);
      // A credential fold that failed earlier is retried here, by the flag.
      if (session.credentialDirty) await this.saveCredential(session);
    });
    session.saving = run.catch(() => undefined);
    return run;
  }

  private async saveSessionRow(session: LoadedRemoteMcpSession): Promise<void> {
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
  }

  /**
   * Fold this session's worker state into its credential's row (see
   * `foldIntoCredential`). Written only over the version read, and retried over
   * a newer row, as the session row is. When the fold would exceed the size
   * limit, the least recently seen workers are dropped first. Nothing is
   * written for a credential that is no longer live.
   */
  private async saveCredential(session: LoadedRemoteMcpSession): Promise<void> {
    const binding = { sessionId: REMOTE_MCP_CREDENTIAL_BINDING, accountId: session.accountId };
    const baseline = (session.memory.get(BASELINE_KEY) as McpSessionPersistentState | undefined) ?? null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Changes made while the write is in flight keep the flag set.
      const changesSeen = session.credentialChanges;
      const row = await getRemoteMcpCredential(session.tokenHash);
      // A row of another account under this hash cannot happen; never write over it.
      if (row && row.account_id !== session.accountId) return;
      const theirs = row ? openRemoteMcpState(row.state, session.credentialKey, binding) : null;
      const credential = theirs === null ? emptyState() : readState(theirs);
      let folded = foldIntoCredential(credential, session.state, baseline);
      for (let maxWorkers = credentialMaxWorkers();
        Buffer.byteLength(JSON.stringify(folded)) > this.limits.maxStateBytes; maxWorkers = Math.floor(maxWorkers / 2)) {
        if (maxWorkers <= 1) throw new RemoteMcpStateTooLargeError();
        folded = foldIntoCredential(credential, session.state, baseline, Math.floor(maxWorkers / 2));
      }
      const version = await saveRemoteMcpCredentialState({
        tokenHash: session.tokenHash,
        accountId: session.accountId,
        expectedVersion: row?.version ?? null,
        state: sealRemoteMcpState(folded, session.credentialKey, binding) as unknown as Record<string, unknown>,
      });
      if (version !== null) {
        if (session.credentialChanges === changesSeen) session.credentialDirty = false;
        session.memory.set(BASELINE_KEY, folded);
        return;
      }
      // Not written: the row changed under us, or the credential is gone.
      if (!(await isRemoteMcpCredentialLive(session.tokenHash))) {
        // No live token or grant: there is nothing to keep.
        session.credentialDirty = false;
        return;
      }
      this.counters.conflicts += 1;
    }
    throw new Error("The remote MCP credential state kept changing; retry the call.");
  }
}
