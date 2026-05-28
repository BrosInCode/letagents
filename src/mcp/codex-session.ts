import { randomUUID } from "crypto";
import { resolve } from "path";

import {
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  saveCodexLiveSession,
  updateCodexLiveSession,
  type CodexLiveSessionState,
  type StoredAgentSessionState,
} from "./local-state.js";
import type { JoinedVia } from "./room-id.js";
import {
  isServerReady,
  launchAppServer,
  resolveCodexServerUrl,
  terminateSpawnedProcess,
  waitForServer,
} from "./codex-session/app-server.js";
import { createCodexRuntimeBridgeController } from "./codex-session/runtime-bridge.js";
import {
  RpcClient,
  type ThreadReadResult,
  type ThreadStartResult,
  type TurnStartResult,
} from "./codex-session/rpc-client.js";
import {
  deriveCodexLiveSessionStatus,
  extractThreadStatus,
  extractTurnStatus,
  isLikelyMaterializingError,
  isTerminalCodexSessionStatus,
  parseStartupObservationMs,
  sleep,
  STARTUP_POLL_INTERVAL_MS,
  summarizeItems,
} from "./codex-session/session-status.js";
import {
  buildStartPrompt,
  DEFAULT_STOP_PHRASE,
  formatDeadline,
  makeToken,
} from "./codex-session/start-prompt.js";
import {
  isCodexAgentSessionMarker,
  summarizeCodexReasoningNotificationForTest,
  summarizeCodexRuntimeNotificationForTest,
  summarizeCodexRuntimeSnapshotForTest,
} from "./codex-session/runtime-summary.js";

export {
  deriveCodexLiveSessionStatus,
} from "./codex-session/session-status.js";
export {
  isCodexAgentSessionMarker,
  summarizeCodexReasoningNotificationForTest,
  summarizeCodexRuntimeNotificationForTest,
  summarizeCodexRuntimeSnapshotForTest,
} from "./codex-session/runtime-summary.js";

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

const SESSION_MONITOR_INTERVAL_MS = 30_000;

/** Track spawned server PIDs for cleanup on process exit. */
const spawnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();

const runtimeBridge = createCodexRuntimeBridgeController({
  inspectSession: (sessionId) => inspectLocalCodexSession(sessionId),
  isTerminalStatus: isTerminalCodexSessionStatus,
});

let cleanupRegistered = false;
function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const timer of sessionMonitorTimers.values()) {
      clearInterval(timer);
    }
    sessionMonitorTimers.clear();

    runtimeBridge.cleanup();

    for (const pid of spawnedServerPids) {
      terminateSpawnedProcess(pid);
    }
    spawnedServerPids.clear();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

export async function bindCodexRuntimeStreamBridgeForAgentSession(
  workerSession: StoredAgentSessionState
): Promise<boolean> {
  return runtimeBridge.bindForAgentSession(workerSession);
}

export function scheduleCodexRuntimeStreamBridgeBind(
  workerSession: StoredAgentSessionState,
  attempts?: number
): void {
  runtimeBridge.scheduleBind(workerSession, attempts);
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
          runtimeBridge.stop(session.session_id);
          clearSessionMonitor(session.session_id);
          return;
        }
        void runtimeBridge.maybeStart(status.session).catch(() => {
          // The monitor should keep supervising even when the optional stream bridge is unavailable.
        });
      })
      .catch(() => {
        const latest = getStoredCodexLiveSession(session.session_id);
        if (latest?.launched_server) {
          killOwnedAppServer(latest);
        }
        runtimeBridge.stop(session.session_id);
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
    agent_session_id: session.agent_session_id ?? null,
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
      void runtimeBridge.postReasoningSummary(updated, snapshotSummary).catch(() => {
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
      await runtimeBridge.maybeStart(inspected.session);
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
  let notificationSession: CodexLiveSessionState | null = null;
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

    client = new RpcClient(serverUrl, (notification) => {
      const session = notificationSession
        ? getStoredCodexLiveSession(notificationSession.session_id) ?? notificationSession
        : null;
      if (!session) return;
      void runtimeBridge.postReasoningSummary(
        session,
        summarizeCodexRuntimeNotificationForTest(notification)
      ).catch(() => {
        // Runtime notifications should never break the worker turn.
      });
    });
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
    notificationSession = session;

    try {
      const verifiedSession = await waitForWorkerStartup(session);
      scheduleOwnedSessionMonitor(verifiedSession);
      runtimeBridge.start(verifiedSession, client);
      client = null;
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
