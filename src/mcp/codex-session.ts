import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createServer } from "net";
import { resolve } from "path";
import {
  getCurrentCodexLiveSession,
  getStoredAuth,
  getStoredCodexLiveSession,
  readLocalState,
  saveCodexLiveSession,
  updateCodexLiveSession,
  type CodexLiveSessionState,
  type StoredAgentSessionState,
} from "./local-state.js";
import { encodeRoomIdPath, type JoinedVia } from "./room-id.js";
import type { AgentPresenceStatus } from "../shared/agent-presence.js";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_STOP_PHRASE = "/stop-codex-room";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_OBSERVATION_MS = 8_000;
const STARTUP_POLL_INTERVAL_MS = 500;
const SESSION_MONITOR_INTERVAL_MS = 30_000;
const CODEX_RUNTIME_STREAM_SOURCE = "codex_app_server";
const CODEX_RUNTIME_STREAM_THROTTLE_MS = 750;
const CODEX_RUNTIME_STREAM_REPEAT_MS = 30_000;
const CODEX_RUNTIME_STREAM_SNAPSHOT_INTERVAL_MS = 2_000;

function getWebSocketCtor(): typeof WebSocket {
  const ctor = globalThis.WebSocket;
  if (!ctor) {
    throw new Error("Codex live sessions require a Node runtime with global WebSocket support (Node >= 22).");
  }
  return ctor;
}

interface RpcResultEnvelope {
  id?: number;
  method?: string;
  params?: unknown;
  error?: { message?: string } | unknown;
  result?: unknown;
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

interface ThreadStartResult {
  thread?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string };
}

interface ThreadReadTurnItem {
  type?: string;
  text?: string;
  phase?: string;
  content?: Array<{ text?: string }>;
}

interface ThreadReadTurn {
  id?: string;
  status?: string | { status?: string };
  items?: ThreadReadTurnItem[];
  output?: ThreadReadTurnItem[];
}

interface ThreadReadResult {
  thread?: {
    status?: { type?: string } | string;
    turns?: ThreadReadTurn[];
  };
}

export interface LocalCodexSessionStatus {
  session: CodexLiveSessionState;
  server_reachable: boolean;
  thread_status: unknown;
  turn_status: unknown;
  recent_items: Array<Record<string, unknown>>;
}

export interface StartLocalCodexSessionInput {
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd?: string;
  stop_phrase?: string;
  max_minutes?: number;
  server_url?: string;
  codex_bin?: string;
}

export interface StartLocalCodexSessionResult {
  session: CodexLiveSessionState;
  reused: boolean;
}

/** Track spawned server PIDs for cleanup on process exit. */
const spawnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();
const codexRuntimeBridgeClients = new Map<string, RpcClient>();
const codexRuntimeBridgeSnapshotTimers = new Map<string, ReturnType<typeof setInterval>>();
const codexRuntimeBridgeLastPost = new Map<string, { signature: string; postedAt: number }>();

type CodexRuntimeReasoningSummary = {
  summary: string;
  status: AgentPresenceStatus;
  checking: string;
  next_action: string;
};

function terminateSpawnedProcess(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      return;
    }
  } catch {
    // Fall back to the direct process below.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

let cleanupRegistered = false;
function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const timer of sessionMonitorTimers.values()) {
      clearInterval(timer);
    }
    sessionMonitorTimers.clear();

    for (const client of codexRuntimeBridgeClients.values()) {
      client.close();
    }
    codexRuntimeBridgeClients.clear();

    for (const pid of spawnedServerPids) {
      terminateSpawnedProcess(pid);
    }
    spawnedServerPids.clear();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

class RpcClient {
  private readonly serverUrl: string;
  private readonly onNotification?: (notification: RpcNotification) => void;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(serverUrl: string, onNotification?: (notification: RpcNotification) => void) {
    this.serverUrl = serverUrl;
    this.onNotification = onNotification;
  }

  async connect(): Promise<void> {
    const WS = getWebSocketCtor();
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.serverUrl);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`WebSocket error connecting to ${this.serverUrl}`));
      ws.onmessage = (event) => this.handleMessage(String(event.data));
      ws.onclose = () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      };
    });

    await this.request("initialize", {
      clientInfo: { name: "letagents-local-codex-session", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.ws?.send(JSON.stringify({ method: "initialized" }));
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  close(): void {
    if (this.ws?.readyState === getWebSocketCtor().OPEN) {
      this.ws.close();
    }
  }

  private handleMessage(raw: string): void {
    let message: RpcResultEnvelope;

    try {
      message = JSON.parse(raw) as RpcResultEnvelope;
    } catch {
      return;
    }

    if (message.id === undefined) {
      if (typeof message.method === "string") {
        this.onNotification?.({ method: message.method, params: message.params });
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          typeof message.error === "object" && message.error && "message" in message.error
            ? String(message.error.message || JSON.stringify(message.error))
            : JSON.stringify(message.error)
        )
      );
      return;
    }

    pending.resolve(message.result);
  }
}

function readyUrlFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/readyz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function isServerReady(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(readyUrlFromServerUrl(serverUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(serverUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(serverUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function allocateLoopbackServerUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_SERVER_HOST, () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a loopback Codex app-server port.");
  }

  return `ws://${DEFAULT_SERVER_HOST}:${address.port}`;
}

async function resolveCodexServerUrl(explicitServerUrl?: string): Promise<string> {
  if (explicitServerUrl) {
    return explicitServerUrl;
  }

  const configuredServerUrl = process.env.LETAGENTS_CODEX_SERVER_URL?.trim();
  if (configuredServerUrl) {
    return configuredServerUrl;
  }

  return allocateLoopbackServerUrl();
}

function launchAppServer(serverUrl: string, codexBin: string): number | null {
  const child = spawn(codexBin, ["app-server", "--listen", serverUrl], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

function makeToken(): string {
  return `LOCAL_CODEX_ROOM_${randomUUID()}`;
}

function formatDeadline(minutes: number): { utc: string | null } {
  if (minutes <= 0) {
    return { utc: null };
  }

  const deadline = new Date(Date.now() + minutes * 60 * 1000);
  return {
    utc: deadline.toISOString().replace("T", " ").replace(".000Z", " UTC"),
  };
}

function buildJoinInstruction(joinedVia: JoinedVia, roomIdentifier: string): string {
  if (joinedVia === "join_code") {
    return `Call the LetAgents MCP tool join_code with {"code":"${roomIdentifier}","session_mode":"current"}.`;
  }

  return `Call the LetAgents MCP tool join_room with {"name":"${roomIdentifier}","session_mode":"current"}.`;
}

function buildStartPrompt(input: {
  room_identifier: string;
  joined_via: JoinedVia;
  cwd: string;
  stop_phrase: string;
  token: string;
  deadline_utc: string | null;
  max_minutes: number;
}): string {
  const deadlineInstruction =
    input.max_minutes > 0 && input.deadline_utc
      ? `Hard stop deadline: ${input.deadline_utc}. Stop when the stop phrase appears or when that deadline is reached, whichever comes first.`
      : "There is no hard deadline. Stop only when the stop phrase appears or when you are interrupted.";

  return [
    "Run as a persistent local Codex worker for a LetAgents room.",
    `Primary working directory: ${input.cwd}. Use this repository/worktree when the room asks for implementation or repo work.`,
    deadlineInstruction,
    "",
    "Instructions:",
    `1. ${buildJoinInstruction(input.joined_via, input.room_identifier)}`,
    "2. Call register_agent_session with session_kind=\"worker\" and runtime=\"codex\". Keep the returned agent_session_id.",
    "3. Pass that agent_session_id to wait_for_messages, send_message, post_status, and task tools whenever the tool accepts it.",
    "4. Do not start another live session. Join the room inline in this worker only.",
    "5. Read the room and task board before contributing so you have current context.",
    "6. Keep polling with wait_for_messages using a 30000 ms timeout and track the latest seen message id.",
    "7. When new messages arrive, contribute when useful. Be concise, thoughtful, and non-repetitive.",
    "8. When the room asks for coding work, do the work locally in this repository: inspect files, edit code, run checks, commit when asked, and push only when explicitly requested.",
    "9. Post short status updates to the room when you start meaningful work, when you are blocked, and when you finish meaningful work.",
    `10. Stop immediately if a browser/user room message text exactly equals: ${input.stop_phrase}`,
    `11. When stopping, reply in this thread with exactly: ${input.token}_DONE`,
    "",
    "Constraints:",
    "- Do not narrate hidden chain-of-thought.",
    "- Do not spam the room with keepalive messages.",
    "- Stay in the room continuously until stopped.",
  ].join("\n");
}

function extractTurnStatus(turn: ThreadReadTurn | null | undefined): string | null {
  if (!turn) {
    return null;
  }

  if (typeof turn.status === "string") {
    return turn.status;
  }

  if (turn.status && typeof turn.status === "object" && "status" in turn.status) {
    return typeof turn.status.status === "string" ? turn.status.status : null;
  }

  return null;
}

function extractThreadStatus(thread: ThreadReadResult["thread"] | undefined): string | null {
  if (!thread?.status) {
    return null;
  }

  if (typeof thread.status === "string") {
    return thread.status;
  }

  return typeof thread.status.type === "string" ? thread.status.type : null;
}

function summarizeItems(items: ThreadReadTurnItem[] | undefined): Array<Record<string, unknown>> {
  return (items ?? []).slice(-6).map((item) => {
    if (item.type === "agentMessage") {
      return { type: item.type, phase: item.phase, text: item.text ?? null };
    }

    if (item.type === "userMessage") {
      return {
        type: item.type,
        text: (item.content ?? []).map((part) => part.text ?? "").join("\n"),
      };
    }

    return { type: item.type ?? "unknown" };
  });
}

export function deriveCodexLiveSessionStatus(
  session: CodexLiveSessionState,
  serverReachable: boolean,
  threadStatus: string | null,
  turnStatus: string | null
): CodexLiveSessionState["status"] {
  if (threadStatus === "systemError" || threadStatus === "error" || turnStatus === "failed") {
    return "failed";
  }

  if (turnStatus === "completed") {
    return "completed";
  }

  if (turnStatus === "interrupted") {
    return "interrupted";
  }

  if (turnStatus === "inProgress" || threadStatus === "active") {
    return "running";
  }

  if (!serverReachable) {
    return session.status === "completed" || session.status === "interrupted"
      ? session.status
      : "unknown";
  }

  if (session.status === "starting") {
    return "starting";
  }

  return session.status;
}

function isTerminalCodexSessionStatus(status: CodexLiveSessionState["status"]): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function parseStartupObservationMs(): number {
  const parsed = Number.parseInt(process.env.LETAGENTS_CODEX_STARTUP_OBSERVATION_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STARTUP_OBSERVATION_MS;
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiUrl(): string {
  return (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");
}

function authorizationHeader(): string | null {
  const token = process.env.LETAGENTS_TOKEN || getStoredAuth()?.token || "";
  return token ? `Bearer ${token}` : null;
}

async function codexBridgeApiCall<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };
  const authorization = authorizationHeader();
  if (authorization && !headers.Authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetch(`${apiUrl()}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    throw new Error(`LetAgents API ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function codexWorkerSessionsForRoom(roomId: string): StoredAgentSessionState[] {
  const state = readLocalState();
  return Object.values(state.agent_sessions ?? {}).filter((session) =>
    session.room_id === roomId &&
    session.session_kind === "worker" &&
    isCodexAgentSessionMarker(session) &&
    Boolean(session.session_id && session.session_token) &&
    !session.ended_at
  );
}

function codexWorkerSessionForLiveSession(session: CodexLiveSessionState): StoredAgentSessionState | null {
  const state = readLocalState();
  const candidates = codexWorkerSessionsForRoom(session.room_id);
  const startedAt = Date.parse(session.started_at);
  const afterLiveSessionStart = candidates
    .filter((candidate) => {
      const createdAt = Date.parse(candidate.created_at);
      return Number.isFinite(startedAt) && Number.isFinite(createdAt) && createdAt >= startedAt - 1000;
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  if (afterLiveSessionStart.length) {
    return afterLiveSessionStart[0] ?? null;
  }

  const currentSessionId = state.current_agent_session_ids?.[session.room_id];
  const current = currentSessionId ? state.agent_sessions?.[currentSessionId] ?? null : null;
  if (current && candidates.some((candidate) => candidate.session_id === current.session_id)) {
    return current;
  }

  return candidates.sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0] ?? null;
}

export function isCodexAgentSessionMarker(session: {
  runtime?: string | null;
  ide_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
}): boolean {
  const runtime = String(session.runtime ?? "").trim().toLowerCase();
  const ideLabel = String(session.ide_label ?? "").trim().toLowerCase();
  const livenessCapability = String(session.liveness_capability ?? "").trim().toLowerCase();
  const toolBridgeId = String(session.tool_bridge_id ?? "").trim().toLowerCase();

  return runtime === "codex" ||
    ideLabel === "codex" ||
    livenessCapability.includes("codex") ||
    /(^|:)codex(:|$)/.test(toolBridgeId);
}

function statusForCodexRuntimeMethod(method: string): AgentPresenceStatus {
  if (/blocked|error|failed/i.test(method)) return "blocked";
  if (/completed|finished|done|stopped|interrupted/i.test(method)) return "idle";
  return "working";
}

function compactRuntimeParam(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const item = typeof record.item === "object" && record.item
    ? record.item as Record<string, unknown>
    : record;
  const type = typeof item.type === "string" ? item.type : null;
  const name = typeof item.name === "string"
    ? item.name
    : typeof item.command === "string"
      ? item.command
      : null;
  if (type && name) return `${type}: ${name}`;
  return type || name;
}

export function summarizeCodexRuntimeNotificationForTest(notification: RpcNotification): {
  summary: string;
  status: AgentPresenceStatus;
  checking: string;
  next_action: string;
} {
  const method = notification.method.trim();
  const detail = compactRuntimeParam(notification.params);
  const readableMethod = method.replaceAll("/", " ");
  const status = statusForCodexRuntimeMethod(method);
  const suffix = detail ? ` (${detail})` : "";

  if (/^thread\//i.test(method)) {
    return {
      summary: `Codex ${readableMethod}${suffix}`,
      status,
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
      next_action: status === "idle" ? "Waiting for the next room event." : "Continuing the Codex worker turn.",
    };
  }

  if (/^turn\//i.test(method)) {
    return {
      summary: `Codex ${readableMethod}${suffix}`,
      status,
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
      next_action: status === "idle" ? "Turn finished; waiting for room activity." : "Streaming turn progress.",
    };
  }

  if (/^item\//i.test(method)) {
    return {
      summary: `Codex ${readableMethod}${suffix}`,
      status,
      checking: detail ? `Handling ${detail}.` : `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
      next_action: status === "idle" ? "Waiting for the next runtime item." : "Continuing runtime work.",
    };
  }

  return {
    summary: `Codex runtime event: ${readableMethod}${suffix}`,
    status,
    checking: `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
    next_action: status === "idle" ? "Waiting for the next runtime event." : "Continuing runtime work.",
  };
}

export function summarizeCodexRuntimeSnapshotForTest(input: {
  turnStatus?: unknown;
  threadStatus?: unknown;
  recentItems?: Array<Record<string, unknown>>;
}): CodexRuntimeReasoningSummary | null {
  const recentItems = input.recentItems ?? [];
  const latestItem = [...recentItems].reverse().find((item) => {
    const type = String(item.type ?? "");
    return type === "agentMessage" || type === "userMessage";
  });
  const latestText = typeof latestItem?.text === "string" ? latestItem.text.trim() : "";
  const latestType = String(latestItem?.type ?? "");
  const turnStatus = typeof input.turnStatus === "string" ? input.turnStatus : "";
  const threadStatus = typeof input.threadStatus === "string" ? input.threadStatus : "";
  const status = statusForCodexRuntimeMethod(`${threadStatus} ${turnStatus} ${latestType}`);

  if (latestText) {
    return {
      summary: latestType === "agentMessage" ? latestText : "Codex worker received room input.",
      status,
      checking: latestType === "agentMessage"
        ? "Latest Codex worker message from app-server snapshot."
        : latestText,
      next_action: status === "idle" ? "Waiting for the next room event." : "Continuing the Codex worker turn.",
    };
  }

  if (turnStatus || threadStatus) {
    const statusText = [threadStatus && `thread ${threadStatus}`, turnStatus && `turn ${turnStatus}`]
      .filter(Boolean)
      .join(", ");
    return {
      summary: `Codex worker ${statusText}.`,
      status,
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: snapshot`,
      next_action: status === "idle" ? "Waiting for the next room event." : "Monitoring Codex worker progress.",
    };
  }

  return null;
}

async function postCodexRuntimeReasoningSummary(
  session: CodexLiveSessionState,
  summary: CodexRuntimeReasoningSummary
): Promise<void> {
  const workerSession = codexWorkerSessionForLiveSession(session);
  if (!workerSession) {
    return;
  }

  const signature = `${session.session_id}:${summary.summary}:${summary.status}`;
  const lastPost = codexRuntimeBridgeLastPost.get(session.session_id);
  if (
    lastPost?.signature === signature &&
    Date.now() - lastPost.postedAt < CODEX_RUNTIME_STREAM_REPEAT_MS
  ) {
    return;
  }
  if (lastPost && Date.now() - lastPost.postedAt < CODEX_RUNTIME_STREAM_THROTTLE_MS) {
    return;
  }
  codexRuntimeBridgeLastPost.set(session.session_id, { signature, postedAt: Date.now() });

  const roomPath = `/rooms/${encodeRoomIdPath(session.room_id)}/reasoning-sessions`;
  const body = {
    actor_label: workerSession.actor_label,
    agent_key: workerSession.agent_key,
    agent_session_id: workerSession.session_id,
    agent_session_token: workerSession.session_token,
    summary: summary.summary,
    goal: "Stream Codex runtime progress for this LetAgents room.",
    checking: summary.checking,
    next_action: summary.next_action,
    status: summary.status,
  };

  if (session.reasoning_session_id) {
    try {
      await codexBridgeApiCall(
        `${roomPath}/${encodeURIComponent(session.reasoning_session_id)}/updates`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      return;
    } catch {
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        reasoning_session_id: null,
        updated_at: new Date().toISOString(),
      }));
    }
  }

  const created = await codexBridgeApiCall<{
    session?: { id?: string };
  }>(roomPath, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const reasoningSessionId = created.session?.id;
  if (reasoningSessionId) {
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      reasoning_session_id: reasoningSessionId,
      updated_at: new Date().toISOString(),
    }));
  }
}

async function postCodexRuntimeReasoningUpdate(
  session: CodexLiveSessionState,
  notification: RpcNotification
): Promise<void> {
  await postCodexRuntimeReasoningSummary(
    session,
    summarizeCodexRuntimeNotificationForTest(notification)
  );
}

function startCodexRuntimeStreamBridge(session: CodexLiveSessionState, client: RpcClient): void {
  stopCodexRuntimeStreamBridge(session.session_id);
  codexRuntimeBridgeClients.set(session.session_id, client);
  void inspectLocalCodexSession(session.session_id).catch(() => {
    // The periodic snapshot bridge will retry while the session remains reachable.
  });
  const snapshotTimer = setInterval(() => {
    void inspectLocalCodexSession(session.session_id).then((status) => {
      if (
        !status ||
        !status.server_reachable ||
        isTerminalCodexSessionStatus(status.session.status)
      ) {
        stopCodexRuntimeStreamBridge(session.session_id);
      }
    }).catch(() => {
      stopCodexRuntimeStreamBridge(session.session_id);
    });
  }, CODEX_RUNTIME_STREAM_SNAPSHOT_INTERVAL_MS);
  snapshotTimer.unref?.();
  codexRuntimeBridgeSnapshotTimers.set(session.session_id, snapshotTimer);
}

async function maybeStartCodexRuntimeStreamBridge(session: CodexLiveSessionState): Promise<void> {
  if (codexRuntimeBridgeClients.has(session.session_id)) {
    return;
  }

  if (!codexWorkerSessionForLiveSession(session)) {
    return;
  }

  const client = new RpcClient(session.server_url, (notification) => {
    const latest = getStoredCodexLiveSession(session.session_id) ?? session;
    void postCodexRuntimeReasoningUpdate(latest, notification).catch(() => {
      // Runtime notifications should never break the worker turn.
    });
  });
  await client.connect();
  startCodexRuntimeStreamBridge(session, client);
}

function stopCodexRuntimeStreamBridge(sessionId: string): void {
  const client = codexRuntimeBridgeClients.get(sessionId);
  if (client) {
    client.close();
    codexRuntimeBridgeClients.delete(sessionId);
  }
  const snapshotTimer = codexRuntimeBridgeSnapshotTimers.get(sessionId);
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    codexRuntimeBridgeSnapshotTimers.delete(sessionId);
  }
  codexRuntimeBridgeLastPost.delete(sessionId);
}

function clearSessionMonitor(sessionId: string): void {
  const timer = sessionMonitorTimers.get(sessionId);
  if (!timer) {
    return;
  }

  clearInterval(timer);
  sessionMonitorTimers.delete(sessionId);
}

function killOwnedAppServer(session: CodexLiveSessionState): void {
  if (!session.launched_server || !session.server_pid) {
    return;
  }

  terminateSpawnedProcess(session.server_pid);
  spawnedServerPids.delete(session.server_pid);
}

function scheduleOwnedSessionMonitor(session: CodexLiveSessionState): void {
  if (!session.launched_server || sessionMonitorTimers.has(session.session_id)) {
    return;
  }

  const timer = setInterval(() => {
    void inspectLocalCodexSession(session.session_id)
      .then((status) => {
        if (
          !status ||
          !status.server_reachable ||
          isTerminalCodexSessionStatus(status.session.status)
        ) {
          stopCodexRuntimeStreamBridge(session.session_id);
          clearSessionMonitor(session.session_id);
          return;
        }
        void maybeStartCodexRuntimeStreamBridge(status.session).catch(() => {
          // The monitor should keep supervising even when the optional stream bridge is unavailable.
        });
      })
      .catch(() => {
        const latest = getStoredCodexLiveSession(session.session_id);
        if (latest?.launched_server) {
          killOwnedAppServer(latest);
        }
        stopCodexRuntimeStreamBridge(session.session_id);
        clearSessionMonitor(session.session_id);
      });
  }, SESSION_MONITOR_INTERVAL_MS);
  timer.unref?.();
  sessionMonitorTimers.set(session.session_id, timer);
}

async function waitForWorkerStartup(session: CodexLiveSessionState): Promise<CodexLiveSessionState> {
  const observationMs = parseStartupObservationMs();
  const deadline = Date.now() + observationMs;
  let latest = session;

  while (Date.now() < deadline) {
    await sleep(Math.min(STARTUP_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    const inspected = await inspectLocalCodexSession(session.session_id);
    if (!inspected) {
      continue;
    }

    latest = inspected.session;
    if (!inspected.server_reachable || latest.status === "unknown") {
      const reason = !inspected.server_reachable
        ? "app-server became unreachable during startup"
        : "worker status became unknown during startup";
      const failed =
        updateCodexLiveSession(session.session_id, (current) => ({
          ...current,
          status: "failed",
          last_error: reason,
          updated_at: new Date().toISOString(),
        })) ?? latest;
      throw new Error(`Codex worker exited during startup: ${failed.last_error ?? reason}`);
    }

    if (isTerminalCodexSessionStatus(latest.status)) {
      const reason = latest.status === "completed"
        ? "turn completed before entering the room polling loop"
        : `turn entered ${latest.status}`;
      const failed =
        updateCodexLiveSession(session.session_id, (current) => ({
          ...current,
          status: "failed",
          last_error: reason,
          updated_at: new Date().toISOString(),
        })) ?? latest;
      throw new Error(`Codex worker exited during startup: ${failed.last_error ?? reason}`);
    }
  }

  return latest;
}

function toSessionState(input: {
  session_id: string;
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd: string;
  stop_phrase: string;
  max_minutes: number;
  deadline_utc: string | null;
  token: string;
  thread_id: string;
  turn_id: string;
  server_url: string;
  server_pid: number | null;
  launched_server: boolean;
  codex_bin: string;
}): CodexLiveSessionState {
  const now = new Date().toISOString();
  return {
    session_id: input.session_id,
    room_id: input.room_id,
    room_identifier: input.room_identifier,
    room_code: input.room_code ?? null,
    room_display_name: input.room_display_name ?? null,
    joined_via: input.joined_via,
    cwd: input.cwd,
    stop_phrase: input.stop_phrase,
    max_minutes: input.max_minutes,
    deadline_utc: input.deadline_utc,
    token: input.token,
    thread_id: input.thread_id,
    turn_id: input.turn_id,
    server_url: input.server_url,
    server_pid: input.server_pid,
    launched_server: input.launched_server,
    codex_bin: input.codex_bin,
    status: "running",
    last_error: null,
    started_at: now,
    updated_at: now,
  };
}

function isLikelyMaterializingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not materialized yet");
}

export function toPublicCodexLiveSession(
  session: CodexLiveSessionState
): Record<string, unknown> {
  return {
    session_id: session.session_id,
    room_id: session.room_id,
    room_code: session.room_code ?? null,
    room_display_name: session.room_display_name ?? null,
    joined_via: session.joined_via,
    cwd: session.cwd,
    stop_phrase: session.stop_phrase,
    max_minutes: session.max_minutes,
    deadline_utc: session.deadline_utc ?? null,
    thread_id: session.thread_id,
    turn_id: session.turn_id,
    server_url: session.server_url,
    server_pid: session.server_pid ?? null,
    launched_server: session.launched_server,
    status: session.status,
    last_error: session.last_error ?? null,
    started_at: session.started_at,
    updated_at: session.updated_at,
  };
}

export async function inspectLocalCodexSession(
  sessionId?: string | null,
  roomId?: string | null
): Promise<LocalCodexSessionStatus | null> {
  const session = sessionId
    ? getStoredCodexLiveSession(sessionId)
    : getCurrentCodexLiveSession(roomId ?? undefined);

  if (!session) {
    return null;
  }

  const serverReachable = await isServerReady(session.server_url);
  if (!serverReachable) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: deriveCodexLiveSessionStatus(current, false, null, null),
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (updated.launched_server) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }

    return {
      session: updated,
      server_reachable: false,
      thread_status: null,
      turn_status: null,
      recent_items: [],
    };
  }

  const client = new RpcClient(session.server_url);
  try {
    await client.connect();
    let read: ThreadReadResult | null = null;
    try {
      read = await client.request<ThreadReadResult>("thread/read", {
        threadId: session.thread_id,
        includeTurns: true,
      });
    } catch (error) {
      if (!isLikelyMaterializingError(error)) {
        throw error;
      }
    }

    const turns = read?.thread?.turns ?? [];
    const turn = turns.find((candidate) => candidate.id === session.turn_id) ?? turns[turns.length - 1];
    const threadStatus = extractThreadStatus(read?.thread);
    const turnStatus = extractTurnStatus(turn);
    const recentItems = summarizeItems(turn?.items ?? turn?.output);
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: deriveCodexLiveSessionStatus(current, true, threadStatus, turnStatus),
        last_error: null,
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (isTerminalCodexSessionStatus(updated.status)) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }

    const snapshotSummary = summarizeCodexRuntimeSnapshotForTest({
      threadStatus,
      turnStatus,
      recentItems,
    });
    if (snapshotSummary) {
      void postCodexRuntimeReasoningSummary(updated, snapshotSummary).catch(() => {
        // Snapshot-derived reasoning should never break session inspection.
      });
    }

    return {
      session: updated,
      server_reachable: true,
      thread_status: read?.thread?.status ?? null,
      turn_status: turn?.status ?? null,
      recent_items: recentItems,
    };
  } catch (error) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "unknown",
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (updated.launched_server) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }

    return {
      session: updated,
      server_reachable: true,
      thread_status: null,
      turn_status: null,
      recent_items: [],
    };
  } finally {
    client.close();
  }
}

export async function startLocalCodexSession(
  input: StartLocalCodexSessionInput
): Promise<StartLocalCodexSessionResult> {
  const cwd = resolve(input.cwd || process.cwd());
  const currentSession = getCurrentCodexLiveSession(input.room_id);

  if (
    currentSession &&
    currentSession.room_id === input.room_id &&
    resolve(currentSession.cwd) === cwd
  ) {
    const inspected = await inspectLocalCodexSession(currentSession.session_id);
    if (
      inspected &&
      (inspected.session.status === "running" || inspected.session.status === "starting")
    ) {
      scheduleOwnedSessionMonitor(inspected.session);
      await maybeStartCodexRuntimeStreamBridge(inspected.session);
      return { session: inspected.session, reused: true };
    }
  }

  const serverUrl = await resolveCodexServerUrl(input.server_url);
  const stopPhrase = input.stop_phrase || DEFAULT_STOP_PHRASE;
  const maxMinutes = Number.isFinite(input.max_minutes) ? Math.max(0, input.max_minutes ?? 0) : 0;
  const codexBin = input.codex_bin || process.env.LETAGENTS_CODEX_BIN || "codex";
  const token = makeToken();
  const deadline = formatDeadline(maxMinutes);
  const launchedServer = !(await isServerReady(serverUrl));
  let serverPid: number | null = null;
  let client: RpcClient | null = null;
  let startupSucceeded = false;

  try {
    if (launchedServer) {
      serverPid = launchAppServer(serverUrl, codexBin);
      if (serverPid) {
        spawnedServerPids.add(serverPid);
        registerProcessCleanup();
      }
      const ready = await waitForServer(serverUrl);
      if (!ready) {
        throw new Error(`Timed out waiting for codex app-server at ${serverUrl}`);
      }
    }

    client = new RpcClient(serverUrl);
    await client.connect();

    const threadStart = await client.request<ThreadStartResult>("thread/start", {});
    const threadId = threadStart.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    const prompt = buildStartPrompt({
      room_identifier: input.room_identifier,
      joined_via: input.joined_via,
      cwd,
      stop_phrase: stopPhrase,
      token,
      deadline_utc: deadline.utc,
      max_minutes: maxMinutes,
    });

    const turnStart = await client.request<TurnStartResult>("turn/start", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });

    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id.");
    }

    const session = saveCodexLiveSession(
      toSessionState({
        session_id: randomUUID(),
        room_id: input.room_id,
        room_identifier: input.room_identifier,
        room_code: input.room_code ?? null,
        room_display_name: input.room_display_name ?? null,
        joined_via: input.joined_via,
        cwd,
        stop_phrase: stopPhrase,
        max_minutes: maxMinutes,
        deadline_utc: deadline.utc,
        token,
        thread_id: threadId,
        turn_id: turnId,
        server_url: serverUrl,
        server_pid: serverPid,
        launched_server: launchedServer,
        codex_bin: codexBin,
      })
    );

    try {
      const verifiedSession = await waitForWorkerStartup(session);
      scheduleOwnedSessionMonitor(verifiedSession);
      await maybeStartCodexRuntimeStreamBridge(verifiedSession);
      startupSucceeded = true;
      return { session: verifiedSession, reused: false };
    } catch (error) {
      killOwnedAppServer(session);
      throw error;
    }
  } catch (error) {
    if (!startupSucceeded && launchedServer && serverPid) {
      terminateSpawnedProcess(serverPid);
      spawnedServerPids.delete(serverPid);
    }
    throw error;
  } finally {
    client?.close();
  }
}

export async function stopLocalCodexSession(options?: {
  session_id?: string | null;
  room_id?: string | null;
  shutdown_server?: boolean;
}): Promise<CodexLiveSessionState | null> {
  const session = options?.session_id
    ? getStoredCodexLiveSession(options.session_id)
    : getCurrentCodexLiveSession(options?.room_id ?? undefined);

  if (!session) {
    return null;
  }

  // Attempt to interrupt the turn via RPC, but gracefully handle a dead server.
  const serverReachable = await isServerReady(session.server_url);
  if (serverReachable) {
    try {
      const client = new RpcClient(session.server_url);
      await client.connect();
      try {
        await client.request("turn/interrupt", {
          threadId: session.thread_id,
          turnId: session.turn_id,
        });
      } finally {
        client.close();
      }
    } catch {
      // Server may have died between the readiness check and the RPC call.
    }
  }

  const updated =
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      status: "interrupted",
      last_error: serverReachable ? null : "server unreachable at stop time",
      updated_at: new Date().toISOString(),
    })) ?? session;

  if (options?.shutdown_server || updated.launched_server) {
    killOwnedAppServer(updated);
  }
  clearSessionMonitor(updated.session_id);

  return updated;
}
