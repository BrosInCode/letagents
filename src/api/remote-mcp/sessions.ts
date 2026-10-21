import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { LETAGENTS_REMOTE_TOOL_SURFACE_ENV } from "../../mcp/server/remote-tool-surface.js";
import { getPollTimeoutCapMs } from "../../shared/poll-timeout-cap.js";

/**
 * One remote MCP connection = one isolated MCP server child process.
 *
 * The MCP runtime keeps the joined room, the agent identity and worker
 * handles in process-wide state and a state file under HOME. Running it as a
 * child per connection, with its own empty HOME and working folder, keeps
 * those apart between callers without forking the tool registry: the child is
 * the same `src/mcp/server.ts` the npm package runs, with the remote tool
 * surface switched on.
 */

export interface RemoteMcpLimits {
  /** Sessions open at once across all accounts. */
  maxSessions: number;
  /** Sessions open at once for one account; the least recently used idle one is closed first. */
  maxSessionsPerAccount: number;
  /** A session with no call in flight and no traffic for this long is closed. */
  idleTimeoutMs: number;
  /** A session older than this is closed even when active; the client re-initializes. */
  maxLifetimeMs: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function remoteMcpLimitsFromEnv(): RemoteMcpLimits {
  return {
    maxSessions: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_SESSIONS", 32),
    maxSessionsPerAccount: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT", 4),
    // At least two long-poll windows, so a waiting agent is never "idle".
    idleTimeoutMs: positiveIntEnv("LETAGENTS_REMOTE_MCP_IDLE_TIMEOUT_MS",
      Math.max(30 * 60_000, 2 * getPollTimeoutCapMs())),
    maxLifetimeMs: positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_LIFETIME_MS", 24 * 60 * 60_000),
  };
}

export type RemoteMcpChildCommand = { command: string; args: string[] };

/** The MCP server entry next to this build: dist/mcp/server.js, or src/mcp/server.ts under tsx. */
export function defaultRemoteMcpChildCommand(): RemoteMcpChildCommand {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(`../../mcp/server.${sourceMode ? "ts" : "js"}`, import.meta.url));
  // A heap cap keeps one connection's runaway input from taking server memory
  // with it: the child aborts, its session closes, the API keeps running.
  const heap = `--max-old-space-size=${positiveIntEnv("LETAGENTS_REMOTE_MCP_CHILD_HEAP_MB", 256)}`;
  return sourceMode
    ? { command: process.execPath, args: [heap, "--import", import.meta.resolve("tsx"), entry] }
    : { command: process.execPath, args: [heap, entry] };
}

export function hashRemoteMcpToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

interface RemoteMcpSession {
  id: string;
  accountId: string;
  tokenHash: Buffer;
  http: StreamableHTTPServerTransport;
  child: StdioClientTransport;
  dir: string;
  createdAt: number;
  lastActivityAt: number;
  openRequests: number;
  closed: boolean;
}

export class RemoteMcpCapacityError extends Error {
  constructor(readonly status: 429 | 503, message: string) {
    super(message);
    this.name = "RemoteMcpCapacityError";
  }
}

export interface RemoteMcpSessionManagerOptions {
  limits?: Partial<RemoteMcpLimits>;
  childCommand?: RemoteMcpChildCommand;
  now?: () => number;
  sweepIntervalMs?: number;
}

export class RemoteMcpSessionManager {
  private readonly sessions = new Map<string, RemoteMcpSession>();
  private readonly limits: RemoteMcpLimits;
  private readonly childCommand: RemoteMcpChildCommand;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private pendingCreates = 0;

  constructor(options: RemoteMcpSessionManagerOptions = {}) {
    this.limits = { ...remoteMcpLimitsFromEnv(), ...options.limits };
    this.childCommand = options.childCommand ?? defaultRemoteMcpChildCommand();
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.sweepTimer.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * The session for this id, only when it was opened with the same token.
   * A wrong token and an unknown id look the same to the caller.
   */
  find(sessionId: string, token: string): RemoteMcpSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return null;
    const presented = hashRemoteMcpToken(token);
    return timingSafeEqual(presented, session.tokenHash) ? session : null;
  }

  /** Spawn an isolated MCP child for an authenticated initialize request. */
  async create(input: { accountId: string; token: string; apiUrl: string }): Promise<RemoteMcpSession> {
    this.makeRoomFor(input.accountId);
    this.pendingCreates += 1;
    let dir: string | null = null;
    let child: StdioClientTransport | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), "letagents-remote-mcp-"));
      const workspace = join(dir, "workspace");
      const home = join(dir, "home");
      for (const folder of [workspace, home]) mkdirSync(folder, { mode: 0o700 });
      const chatSettings = join(dir, "chat-storage.json");
      // Remote callers have no local chat database; every room is a hosted room.
      writeFileSync(chatSettings, JSON.stringify({ mode: "cloud" }), { mode: 0o600 });
      child = new StdioClientTransport({
        command: this.childCommand.command,
        args: this.childCommand.args,
        cwd: workspace,
        // stdio's default inherited set is PATH, HOME, USER, SHELL, TERM, LOGNAME.
        // Nothing else from the API process (database URL, app secrets) reaches the child.
        env: {
          HOME: home,
          TMPDIR: dir,
          NODE_ENV: process.env.NODE_ENV ?? "production",
          LETAGENTS_API_URL: input.apiUrl,
          LETAGENTS_TOKEN: input.token,
          LETAGENTS_POLL_MAX_MS: String(getPollTimeoutCapMs()),
          LETAGENTS_STATE_PATH: join(dir, "mcp-state.json"),
          LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: chatSettings,
          LETAGENTS_LOCAL_CHAT_DB: join(dir, "local-chat.sqlite"),
          LETAGENTS_EXECUTION_PROFILE: "autonomous_mcp_worker",
          [LETAGENTS_REMOTE_TOOL_SURFACE_ENV]: "1",
        },
        // The child's diagnostics can quote request data; they are not copied to server logs.
        stderr: "ignore",
      });
      await child.start();
      const session: RemoteMcpSession = {
        id: randomUUID(),
        accountId: input.accountId,
        tokenHash: hashRemoteMcpToken(input.token),
        http: null as unknown as StreamableHTTPServerTransport,
        child,
        dir,
        createdAt: this.now(),
        lastActivityAt: this.now(),
        openRequests: 0,
        closed: false,
      };
      session.http = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => session.id,
        onsessioninitialized: (id) => { this.sessions.set(id, session); },
      });
      this.bridge(session);
      return session;
    } catch (error) {
      await child?.close().catch(() => undefined);
      if (dir) rmSync(dir, { recursive: true, force: true });
      throw error;
    } finally {
      this.pendingCreates -= 1;
    }
  }

  /** Hand one HTTP request to a session's transport, tracking it for idle cleanup. */
  async handle(session: RemoteMcpSession, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    // A POST carries a call (a long-poll can hold it open for minutes). The
    // GET notification stream stays open for the whole connection, so it does
    // not count as work: a client that only holds that stream goes idle.
    const counts = req.method !== "GET";
    if (counts) session.openRequests += 1;
    session.lastActivityAt = this.now();
    let settled = !counts;
    const settle = () => {
      if (settled) return;
      settled = true;
      session.openRequests -= 1;
      session.lastActivityAt = this.now();
    };
    res.once("close", settle);
    try {
      await session.http.handleRequest(req, res, body);
    } finally {
      if (res.writableEnded) settle();
      // An initialize the transport rejected never registered the session.
      if (!this.sessions.has(session.id)) void this.close(session);
    }
  }

  async close(session: RemoteMcpSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    await Promise.allSettled([session.http.close(), session.child.close()]);
    rmSync(session.dir, { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.sessions.values()].map((session) => this.close(session)));
  }

  /** Close sessions past their idle timeout or lifetime. */
  sweep(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      const idle = session.openRequests === 0 && now - session.lastActivityAt >= this.limits.idleTimeoutMs;
      if (idle || now - session.createdAt >= this.limits.maxLifetimeMs) void this.close(session);
    }
  }

  private makeRoomFor(accountId: string): void {
    const own = [...this.sessions.values()].filter((session) => session.accountId === accountId);
    if (own.length >= this.limits.maxSessionsPerAccount) {
      const idle = own.filter((session) => session.openRequests === 0)
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
      if (!idle) {
        throw new RemoteMcpCapacityError(429, "Too many open remote MCP sessions for this account. Close one and retry.");
      }
      void this.close(idle);
    }
    if (this.sessions.size + this.pendingCreates >= this.limits.maxSessions) {
      throw new RemoteMcpCapacityError(503, "The remote MCP endpoint is at capacity. Retry later.");
    }
  }

  private bridge(session: RemoteMcpSession): void {
    const { http, child } = session;
    http.onmessage = (message: JSONRPCMessage) => {
      session.lastActivityAt = this.now();
      child.send(message).catch(() => void this.close(session));
    };
    child.onmessage = (message: JSONRPCMessage) => {
      session.lastActivityAt = this.now();
      http.send(message).catch(() => undefined);
    };
    http.onclose = () => void this.close(session);
    child.onclose = () => void this.close(session);
    http.onerror = () => undefined;
    child.onerror = () => undefined;
  }
}
