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

/** The parts of `local` a credential keeps for its later sessions. */
const CREDENTIAL_LOCAL_KEYS = ["mcp_workers", "agent_sessions", "current_agent_session_ids", "room_sessions"] as const;
/**
 * Workers one credential keeps, with their agent sessions and pinned
 * connections; the least recently seen go first. `LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS`, default 32.
 */
export function credentialMaxWorkers(): number {
  return positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS", 32);
}
const CREDENTIAL_MAX_LEGACY_SESSIONS = 32;
const CREDENTIAL_MAX_ROOM_CURSORS = 32;

function isEnded(entry: unknown): boolean {
  return isRecord(entry) && Boolean(entry.ended_at);
}

/** JSON with sorted keys, so two equal entries compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => (isRecord(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
    : inner));
}

/**
 * What a credential keeps of a session: its worker handles, the live agent
 * sessions and pinned connections those handles (or legacy registrations)
 * point at, and its read cursors. Never the joined room, the prompt flag or
 * an identity: a new chat joins its own room, and identities are per instance.
 * Bounded, so the credential state cannot grow with every call: the least
 * recently seen workers and legacy sessions go first.
 */
export function projectCredentialState(state: McpSessionPersistentState, maxWorkers = credentialMaxWorkers()): McpSessionPersistentState {
  const local = state.local;
  const agentSessions = local.agent_sessions ?? {};
  const pinned = state.pinnedConnections ?? {};
  const seen = (id: string | undefined): string => (id ? String(agentSessions[id]?.last_seen_at ?? agentSessions[id]?.updated_at ?? "") : "");
  const live = (id: string | undefined): id is string => Boolean(id && agentSessions[id] && !agentSessions[id]!.ended_at);

  const workers = Object.values(local.mcp_workers ?? {})
    .map((worker) => ({ worker, seen: Object.values(worker.rooms).map((room) => seen(room.session_id)).sort().at(-1) ?? "" }))
    .sort((a, b) => b.seen.localeCompare(a.seen))
    .slice(0, Math.max(0, maxWorkers))
    .map((entry) => entry.worker);
  const legacy = Object.entries(local.current_agent_session_ids ?? {})
    .filter(([, id]) => live(id))
    .sort(([, a], [, b]) => seen(b).localeCompare(seen(a)))
    .slice(0, CREDENTIAL_MAX_LEGACY_SESSIONS);
  const keep = new Set<string>();
  for (const worker of workers) for (const room of Object.values(worker.rooms)) if (live(room.session_id)) keep.add(room.session_id);
  for (const [, id] of legacy) keep.add(id);
  const cursors = Object.entries(local.room_sessions ?? {})
    .sort(([, a], [, b]) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
    .slice(0, CREDENTIAL_MAX_ROOM_CURSORS);
  return {
    local: {
      ...(workers.length ? { mcp_workers: Object.fromEntries(workers.map((worker) => [worker.worker_id, worker])) } : {}),
      ...(keep.size ? { agent_sessions: Object.fromEntries([...keep].map((id) => [id, agentSessions[id]!])) } : {}),
      ...(legacy.length ? { current_agent_session_ids: Object.fromEntries(legacy) } : {}),
      ...(cursors.length ? { room_sessions: Object.fromEntries(cursors) } : {}),
    },
    currentRoom: null,
    fullPromptDelivered: false,
    pinnedConnections: Object.fromEntries([...keep].filter((id) => pinned[id] && !pinned[id]!.ended_at).map((id) => [id, pinned[id]!])),
  };
}

/**
 * Fold a session's state into its credential's. An entry the session added
 * or changed since its baseline (what it was seeded with, or last folded) wins,
 * except that an ended entry stays ended. An entry the session did not touch
 * keeps the credential's view, so a stale session cannot undo another
 * session's later change. The result is bounded like a projection.
 */
export function foldIntoCredential(credential: McpSessionPersistentState, session: McpSessionPersistentState,
  baseline: McpSessionPersistentState | null, maxWorkers = credentialMaxWorkers()): McpSessionPersistentState {
  const out: McpSessionPersistentState = structuredClone(credential);
  const foldMap = (target: JsonRecord, mine: JsonRecord | undefined, base: JsonRecord | undefined): void => {
    for (const [key, entry] of Object.entries(mine ?? {})) {
      if (base && key in base && canonical(base[key]) === canonical(entry)) continue;
      if (isEnded(target[key]) && !isEnded(entry)) continue;
      target[key] = entry;
    }
  };
  const outLocal = out.local as JsonRecord;
  for (const key of CREDENTIAL_LOCAL_KEYS) {
    outLocal[key] ??= {};
    foldMap(outLocal[key] as JsonRecord, (session.local as JsonRecord)[key] as JsonRecord | undefined,
      baseline ? (baseline.local as JsonRecord)[key] as JsonRecord | undefined : undefined);
  }
  foldMap(out.pinnedConnections as unknown as JsonRecord, session.pinnedConnections as unknown as JsonRecord,
    baseline?.pinnedConnections as unknown as JsonRecord | undefined);
  return projectCredentialState(out, maxWorkers);
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
    const seed = await this.loadCredentialState(tokenHash, deriveRemoteMcpCredentialStateKey(input.token), input.accountId);
    // The cap bounds the stateful sessions of one credential, so one sign-in's
    // churn (a client that opens a session per call) never replaces another
    // sign-in's sessions. A credential's one implicit session is bounded by
    // being one per credential, so it neither counts nor is replaced.
    const existing = (await listRemoteMcpSessionsForAccount(input.accountId))
      .filter((row) => !row.implicit && row.token_hash === tokenHash);
    const excess = implicit ? 0 : existing.length - this.limits.maxSessionsPerAccount + 1;
    if (excess > 0) {
      // Least recently used first; a session with a request in flight on this process stays.
      const victims = existing.filter((row) => !this.inFlightBySession.has(row.session_id)).slice(0, excess);
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
      state: sealRemoteMcpState(seed?.state ?? emptyState(), key, { sessionId, accountId: input.accountId }) as unknown as Record<string, unknown>,
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
    return this.adopt(row, deriveRemoteMcpStateKey(token, sessionId), deriveRemoteMcpCredentialStateKey(token));
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
    const session = this.adopt(row, deriveRemoteMcpStateKey(input.token, row.session_id), credentialKey);
    // A change this process has not yet folded into the credential would be
    // lost under a refresh; the next save folds it, and the refresh follows.
    if (session && !session.credentialDirty) {
      const credential = await this.loadCredentialState(tokenHash, credentialKey, input.accountId);
      if (credential) this.adoptCredentialView(session, credential.state);
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

  private adopt(row: RemoteMcpSessionRow, stateKey: Buffer, credentialKey: Buffer): LoadedRemoteMcpSession | null {
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
      credentialKey,
      agentInstanceId: row.agent_instance_id,
      clientName: row.client_name,
      implicit: row.implicit,
      state: incoming,
      version: row.version,
      dirty: false,
      credentialDirty: false,
      lastUsedAt: Date.now(),
      memory: new Map(),
      saving: Promise.resolve(),
    };
    // What this process starts from: later changes are this session's own.
    loaded.memory.set(BASELINE_KEY, projectCredentialState(incoming));
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
        set dirty(value: boolean) {
          session.dirty = session.dirty || value;
          session.credentialDirty = session.credentialDirty || value;
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
        session.credentialDirty = false;
        session.memory.set(BASELINE_KEY, folded);
        return;
      }
      // Not written: the row changed under us, or the credential is gone.
      if (row === null && (await getRemoteMcpCredential(session.tokenHash)) === null) {
        // The insert was refused: no live token or grant, so there is nothing to keep.
        session.credentialDirty = false;
        return;
      }
      this.counters.conflicts += 1;
    }
    throw new Error("The remote MCP credential state kept changing; retry the call.");
  }
}
