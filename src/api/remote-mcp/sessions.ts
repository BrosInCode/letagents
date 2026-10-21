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
  type RemoteMcpSessionRow,
} from "../db/remote-mcp-sessions.js";
import { createLetAgentsMcpServer } from "../../mcp/server/letagents-server.js";
import {
  runInSessionScope,
  type McpSessionPersistentState,
  type McpSessionScope,
} from "../../mcp/server/runtime/session-scope.js";
import type { InProcessDispatcher } from "./in-process-dispatch.js";

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
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function remoteMcpLimitsFromEnv(): RemoteMcpLimits {
  return {
    maxSessionsPerAccount: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT", 16),
    // Each request refreshes last_seen, so this need not follow LETAGENTS_POLL_MAX_MS.
    idleTimeoutMs: positiveIntEnv("LETAGENTS_REMOTE_MCP_IDLE_TIMEOUT_MS", 30 * 60_000),
  };
}

function emptyState(): McpSessionPersistentState {
  return { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} };
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
  readonly agentInstanceId: string;
  readonly clientName: string | null;
  state: McpSessionPersistentState;
  version: number;
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
  private readonly counters = { opened: 0, evicted: 0, swept: 0 };

  constructor(options: RemoteMcpSessionsOptions) {
    this.dispatcher = options.dispatcher;
    this.limits = { ...remoteMcpLimitsFromEnv(), ...options.limits };
    this.publicBaseUrl = (options.publicBaseUrl ?? process.env.LETAGENTS_BASE_URL ?? process.env.PUBLIC_API_URL
      ?? "https://letagents.chat").replace(/\/+$/, "");
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), options.sweepIntervalMs ?? 60_000);
    this.sweepTimer.unref();
  }

  /** Sessions loaded in this process, and process-lifetime counts. */
  stats(): { loaded: number; opened: number; evicted: number; swept: number } {
    return { loaded: this.loaded.size, ...this.counters };
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
  async open(input: { accountId: string; tokenHash: string; clientName: string | null }): Promise<string> {
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
    await insertRemoteMcpSession({
      sessionId,
      accountId: input.accountId,
      tokenHash: input.tokenHash,
      agentInstanceId: randomUUID(),
      clientName: input.clientName?.slice(0, 200) ?? null,
      state: emptyState() as unknown as Record<string, unknown>,
    });
    this.counters.opened += 1;
    return sessionId;
  }

  /**
   * The session for this id, only for the token and account that opened it.
   * A wrong token and an unknown id look the same to the caller.
   */
  async find(sessionId: string, tokenHash: string, accountId: string): Promise<LoadedRemoteMcpSession | null> {
    const row = await getRemoteMcpSession(sessionId);
    if (!row) {
      this.loaded.delete(sessionId);
      return null;
    }
    const presented = Buffer.from(tokenHash, "hex");
    const stored = Buffer.from(row.token_hash, "hex");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored) || row.account_id !== accountId) {
      return null;
    }
    return this.adopt(row);
  }

  private adopt(row: RemoteMcpSessionRow): LoadedRemoteMcpSession {
    const current = this.loaded.get(row.session_id);
    // Keep this process's copy unless another replica saved a newer state.
    if (current && current.version >= row.version) return current;
    const loaded: LoadedRemoteMcpSession = {
      sessionId: row.session_id,
      accountId: row.account_id,
      tokenHash: row.token_hash,
      agentInstanceId: row.agent_instance_id,
      clientName: row.client_name,
      state: readState(row.state),
      version: row.version,
      memory: current?.memory ?? new Map(),
      saving: current?.saving ?? Promise.resolve(),
    };
    this.loaded.set(row.session_id, loaded);
    return loaded;
  }

  /** Serve one MCP HTTP request for a session, as the authenticated account. */
  async handle(session: LoadedRemoteMcpSession, account: OwnerTokenAccount, req: IncomingMessage,
    res: ServerResponse, body: unknown): Promise<void> {
    if (account.account_id !== session.accountId) throw new Error("Remote MCP session account mismatch.");
    const scope: McpSessionScope = {
      sessionId: session.sessionId,
      accountId: session.accountId,
      agentInstanceId: session.agentInstanceId,
      clientName: session.clientName,
      publicBaseUrl: this.publicBaseUrl,
      dispatch: this.dispatcher.bind({ account, remoteMcpSessionId: session.sessionId }),
      state: session.state,
      dirty: false,
      memory: session.memory,
      persist: () => this.save(session),
    };
    // Each request gets its own server object and stateless transport; the
    // session id and state live in Postgres, not in transport memory.
    const server = createLetAgentsMcpServer({ profile: "autonomous_mcp_worker", supervisedProvider: null, remote: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    res.setHeader("Mcp-Session-Id", session.sessionId);
    const finished = new Promise<void>((resolve) => res.once("close", resolve));
    try {
      await runInSessionScope(scope, () => transport.handleRequest(req, res, body));
      await finished;
    } finally {
      await server.close().catch(() => undefined);
      // Tool calls already saved before answering; this also covers other
      // requests and a call that outlived a dropped client.
      await this.save(session);
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.loaded.delete(sessionId);
    await deleteRemoteMcpSession(sessionId);
  }

  /** Delete idle sessions and sessions whose owner token was revoked. */
  async sweep(now = Date.now()): Promise<void> {
    const cutoff = new Date(now - this.limits.idleTimeoutMs).toISOString();
    const removed = [...await deleteIdleRemoteMcpSessions(cutoff), ...await deleteRevokedRemoteMcpSessions()];
    for (const id of removed) this.loaded.delete(id);
    this.counters.swept += removed.length;
  }

  /** Saves for one session run one at a time, each writing the latest state. */
  private save(session: LoadedRemoteMcpSession): Promise<void> {
    const run = session.saving.then(async () => {
      const state = session.state;
      const room = (state.currentRoom as { room_id?: unknown } | null)?.room_id;
      const roomId = typeof room === "string" ? room : null;
      // A durable worker handle (pinned) or the legacy current session for the room.
      const pinned = Object.values(state.pinnedConnections)
        .filter((connection) => !roomId || connection.room_id === roomId)
        .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
      const currentId = roomId ? state.local.current_agent_session_ids?.[roomId] : undefined;
      const cursor = roomId ? state.local.room_sessions?.[roomId]?.last_message_id ?? null : null;
      const version = await saveRemoteMcpSessionState({
        sessionId: session.sessionId,
        state: structuredClone(state) as unknown as Record<string, unknown>,
        roomId,
        workerSessionId: pinned?.session_id ?? currentId ?? null,
        readCursor: cursor,
      });
      if (version === null) this.loaded.delete(session.sessionId);
      else session.version = version;
    });
    session.saving = run.catch(() => undefined);
    return run;
  }
}
