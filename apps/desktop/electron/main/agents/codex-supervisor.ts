import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import {
  isCodexAppServerReady,
  launchCodexAppServer,
  resolveCodexAppServerUrl,
  terminateSpawnedProcess,
  waitForCodexAppServer,
  waitForLaunchedCodexAppServer,
} from "./codex-app-server.js";
import {
  buildCodexStartPrompt,
  DEFAULT_CODEX_STOP_PHRASE,
  formatCodexDeadline,
  looksLikeInviteCode,
  makeCodexStopToken,
} from "./codex-start-prompt.js";
import { suggestLetAgentsCodename } from "./codenames.js";
import {
  canDeliverDesktopEventToSession,
  isStopPhraseRoomStreamEvent,
  shouldDeliverRoomStreamEventToSession,
} from "./codex-event-routing.js";
import { buildDesktopEventPrompt } from "./codex-event-prompt.js";
import { CodexRpcClient, type ThreadReadResult, type ThreadStartResult, type TurnStartResult } from "./codex-rpc-client.js";
import { DEFAULT_CODEX_DELIVERY_MODE } from "./defaults.js";
import {
  deriveCodexLiveSessionStatus,
  extractThreadStatus,
  extractTurnStatus,
  codexSessionStatusAfterTurnInterrupt,
  codexSessionStatusAfterStopAttempt,
  isLikelyMaterializingError,
  isActiveCodexTurnStatus,
  isTerminalCodexSessionStatus,
  parseStartupObservationMs,
  shouldShutdownManagedAgentOnStop,
  sleep,
  STARTUP_POLL_INTERVAL_MS,
  summarizeItems,
} from "./codex-session-status.js";
import { runDesktopAgentProviderPreflight } from "./providers.js";
import {
  bindCodexLiveSessionToWorker,
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  listCodexDisplayNamesForRoom,
  listStoredCodexLiveSessions,
  managedAgentDeliveryMode,
  saveCodexLiveSession,
  toPublicManagedAgentSession,
  updateCodexLiveSession,
  type DesktopCodexJoinedVia,
  type DesktopCodexLiveSessionState,
} from "./state.js";

const SESSION_MONITOR_INTERVAL_MS = 30_000;
const DESKTOP_EVENT_TURN_POLL_INTERVAL_MS = 1_000;
const DESKTOP_EVENT_TURN_TIMEOUT_MS = 5 * 60_000;

const spawnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();
const desktopEventQueues = new Map<string, Promise<void>>();
let cleanupRegistered = false;
const CODEX_WORKER_REGISTRATION_ERROR =
  "Codex did not register with the LetAgents MCP bridge. Complete LetAgents MCP auth with get_onboarding_status, start_device_auth, and poll_device_auth if needed, then try again.";

function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const timer of sessionMonitorTimers.values()) {
      clearInterval(timer);
    }
    sessionMonitorTimers.clear();

    for (const pid of spawnedServerPids) {
      terminateSpawnedProcess(pid);
    }
    spawnedServerPids.clear();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function registerLaunchedAppServer(pid: number): void {
  spawnedServerPids.add(pid);
  registerProcessCleanup();
}

function forgetLaunchedAppServer(pid: number): void {
  spawnedServerPids.delete(pid);
}

function killOwnedAppServer(session: DesktopCodexLiveSessionState): void {
  if (!session.launched_server || !session.server_pid) {
    return;
  }

  terminateSpawnedProcess(session.server_pid);
  spawnedServerPids.delete(session.server_pid);
}

function clearSessionMonitor(sessionId: string): void {
  const timer = sessionMonitorTimers.get(sessionId);
  if (!timer) {
    return;
  }
  clearInterval(timer);
  sessionMonitorTimers.delete(sessionId);
}

function scheduleOwnedSessionMonitor(session: DesktopCodexLiveSessionState): void {
  if (sessionMonitorTimers.has(session.session_id)) {
    return;
  }

  const timer = setInterval(() => {
    void inspectDesktopManagedAgentSession(session.session_id)
      .then((status) => {
        if (!status || !status.serverReachable || isTerminalCodexSessionStatus(status.session.status)) {
          clearSessionMonitor(session.session_id);
        }
      })
      .catch(() => {
        const latest = getStoredCodexLiveSession(session.session_id);
        if (latest?.launched_server) {
          killOwnedAppServer(latest);
        }
        clearSessionMonitor(session.session_id);
      });
  }, SESSION_MONITOR_INTERVAL_MS);
  timer.unref?.();
  sessionMonitorTimers.set(session.session_id, timer);
}

function normalizeRoomIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Choose a room before starting an agent.");
  }
  return looksLikeInviteCode(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function joinedViaForRoomIdentifier(roomIdentifier: string): DesktopCodexJoinedVia {
  return looksLikeInviteCode(roomIdentifier) ? "join_code" : "join_room";
}

function coerceMaxMinutes(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? 0)) {
    return 0;
  }
  return Math.max(0, Math.floor(Number(value ?? 0)));
}

function findStoredSession(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): DesktopCodexLiveSessionState | null {
  if (sessionId?.trim()) {
    return getStoredCodexLiveSession(sessionId.trim());
  }
  return getCurrentCodexLiveSession(roomIdentifier?.trim() || undefined);
}

function bindCodexStartupWorker(
  session: DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState | null {
  const bound = bindCodexLiveSessionToWorker(session, { allowStaleSingleCandidate: false });
  return bound.agent_session_id ? bound : null;
}

function markCodexStartupRegistered(
  session: DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState {
  return updateCodexLiveSession(session.session_id, (current) => ({
    ...current,
    status: "running",
    last_error: null,
    updated_at: new Date().toISOString(),
  })) ?? {
    ...session,
    status: "running",
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

function markCodexStartupRegistrationFailed(
  session: DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState {
  return updateCodexLiveSession(session.session_id, (current) => ({
    ...current,
    status: "failed",
    last_error: CODEX_WORKER_REGISTRATION_ERROR,
    updated_at: new Date().toISOString(),
  })) ?? {
    ...session,
    status: "failed",
    last_error: CODEX_WORKER_REGISTRATION_ERROR,
    updated_at: new Date().toISOString(),
  };
}

async function waitForWorkerStartup(
  session: DesktopCodexLiveSessionState,
  deliveryMode = managedAgentDeliveryMode(session),
): Promise<DesktopCodexLiveSessionState> {
  const observationMs = parseStartupObservationMs();
  const deadline = Date.now() + observationMs;
  let latest = session;

  while (Date.now() < deadline) {
    await sleep(Math.min(STARTUP_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    const inspected = await inspectDesktopManagedAgentSession(session.session_id);
    if (!inspected) {
      continue;
    }

    latest = getStoredCodexLiveSession(session.session_id) ?? latest;
    if (!inspected.serverReachable || latest.status === "unknown") {
      const reason = !inspected.serverReachable
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

    const bound = bindCodexStartupWorker(latest);
    if (deliveryMode === "desktop_events" && latest.status === "completed") {
      if (bound) {
        return markCodexStartupRegistered(bound);
      }
      continue;
    }

    if (isTerminalCodexSessionStatus(latest.status)) {
      const reason = latest.status === "completed"
        ? "turn completed before entering the room loop"
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

    if (bound) {
      return markCodexStartupRegistered(bound);
    }
  }

  latest = getStoredCodexLiveSession(session.session_id) ?? latest;
  const bound = bindCodexStartupWorker(latest);
  if (bound) {
    return markCodexStartupRegistered(bound);
  }

  const failed = markCodexStartupRegistrationFailed(latest);
  throw new Error(failed.last_error ?? CODEX_WORKER_REGISTRATION_ERROR);
}

export function listDesktopManagedAgentSessions(
  roomIdentifier?: string | null,
): DesktopManagedAgentSession[] {
  return listStoredCodexLiveSessions(roomIdentifier)
    .map((session) => bindCodexLiveSessionToWorker(session))
    .map(toPublicManagedAgentSession);
}

export async function startDesktopManagedAgent(
  input: DesktopManagedAgentStartInput,
): Promise<DesktopManagedAgentStartResult> {
  if (input.providerId !== "codex") {
    throw new Error("Only Codex can be started by the desktop supervisor in this version.");
  }

  const roomIdentifier = normalizeRoomIdentifier(input.roomIdentifier);
  const repoRootPath = input.repoRootPath?.trim();
  if (!repoRootPath) {
    throw new Error("Choose a local repository before starting Codex.");
  }
  const cwd = resolve(repoRootPath);
  const codexBin = input.runtimeCommand?.trim() || process.env.LETAGENTS_CODEX_BIN || "codex";
  const preflight = await runDesktopAgentProviderPreflight("codex", {
    roomIdentifier,
    repoRootPath: cwd,
    runtimeCommand: codexBin,
  });
  if (!preflight.canStart) {
    throw new Error(preflight.detail || preflight.message);
  }

  const serverUrl = await resolveCodexAppServerUrl();
  const deliveryMode = input.deliveryMode || DEFAULT_CODEX_DELIVERY_MODE;
  const stopPhrase = input.stopPhrase?.trim() || DEFAULT_CODEX_STOP_PHRASE;
  const maxMinutes = coerceMaxMinutes(input.maxMinutes);
  const token = makeCodexStopToken();
  const deadline = formatCodexDeadline(maxMinutes);
  const suggestedDisplayName = suggestLetAgentsCodename(listCodexDisplayNamesForRoom(roomIdentifier), token);
  const launchedServer = !(await isCodexAppServerReady(serverUrl));
  let serverPid: number | null = null;
  let startupSucceeded = false;
  let client: CodexRpcClient | null = null;

  try {
    if (launchedServer) {
      const launch = launchCodexAppServer(serverUrl, codexBin);
      serverPid = launch.pid;
      if (serverPid) {
        registerLaunchedAppServer(serverPid);
      }
      const ready = await waitForLaunchedCodexAppServer(serverUrl, launch);
      if (!ready) {
        throw new Error(`Timed out waiting for codex app-server at ${serverUrl}`);
      }
    }

    client = new CodexRpcClient(serverUrl);
    await client.connect();

    const threadStart = await client.request<ThreadStartResult>("thread/start", {});
    const threadId = threadStart.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    const joinedVia = joinedViaForRoomIdentifier(roomIdentifier);
    const prompt = buildCodexStartPrompt({
      roomIdentifier,
      joinedVia,
      cwd,
      deliveryMode,
      stopPhrase,
      token,
      suggestedDisplayName,
      deadlineUtc: deadline.utc,
      maxMinutes,
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

    const now = new Date().toISOString();
    const session = saveCodexLiveSession({
      session_id: randomUUID(),
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      room_display_name: input.roomDisplayName ?? null,
      display_name: suggestedDisplayName,
      joined_via: joinedVia,
      cwd,
      stop_phrase: stopPhrase,
      max_minutes: maxMinutes,
      delivery_mode: deliveryMode,
      deadline_utc: deadline.utc,
      token,
      thread_id: threadId,
      turn_id: turnId,
      server_url: serverUrl,
      server_pid: serverPid,
      launched_server: launchedServer,
      codex_bin: codexBin,
      agent_session_id: null,
      reasoning_session_id: null,
      status: "starting",
      last_error: null,
      started_at: now,
      updated_at: now,
    });

    try {
      const verifiedSession = bindCodexLiveSessionToWorker(await waitForWorkerStartup(session, deliveryMode));
      scheduleOwnedSessionMonitor(verifiedSession);
      startupSucceeded = true;
      return {
        session: toPublicManagedAgentSession(verifiedSession),
        reused: false,
        message: deliveryMode === "desktop_events"
          ? "Codex agent started with desktop-delivered room events."
          : "Codex agent started for this room.",
      };
    } catch (error) {
      killOwnedAppServer(session);
      throw error;
    }
  } catch (error) {
    if (!startupSucceeded && launchedServer && serverPid) {
      terminateSpawnedProcess(serverPid);
      forgetLaunchedAppServer(serverPid);
    }
    throw error;
  } finally {
    client?.close();
  }
}

export async function inspectDesktopManagedAgentSession(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): Promise<DesktopManagedAgentInspectResult | null> {
  const session = findStoredSession(sessionId, roomIdentifier);
  if (!session) {
    return null;
  }

  const serverReachable = await isCodexAppServerReady(session.server_url);
  if (!serverReachable) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: deriveCodexLiveSessionStatus(current.status, false, null, null),
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (updated.launched_server) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }
    const bound = bindCodexLiveSessionToWorker(updated);
    return {
      session: toPublicManagedAgentSession(bound),
      serverReachable: false,
      recentItems: [],
    };
  }

  const client = new CodexRpcClient(session.server_url);
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
        status: managedAgentDeliveryMode(current) === "desktop_events" && turnStatus === "completed"
          ? "running"
          : deriveCodexLiveSessionStatus(current.status, true, threadStatus, turnStatus),
        last_error: null,
        updated_at: new Date().toISOString(),
      })) ?? session;

    const bound = bindCodexLiveSessionToWorker(updated);

    if (isTerminalCodexSessionStatus(bound.status)) {
      killOwnedAppServer(bound);
      clearSessionMonitor(bound.session_id);
    }

    return {
      session: toPublicManagedAgentSession(bound),
      serverReachable: true,
      recentItems,
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

    const bound = bindCodexLiveSessionToWorker(updated);
    return {
      session: toPublicManagedAgentSession(bound),
      serverReachable: true,
      recentItems: [],
    };
  } finally {
    client.close();
  }
}

export function dispatchRoomStreamEventToManagedAgents(event: DesktopRoomStreamEvent): void {
  if (event.type !== "message" && event.type !== "task_update") {
    return;
  }

  const sessions = listStoredCodexLiveSessions(event.roomIdentifier)
    .map((session) => bindCodexLiveSessionToWorker(session))
    .filter((session) => shouldDeliverRoomStreamEventToSession(session, event));

  for (const session of sessions) {
    enqueueDesktopEventTurn(session, event);
  }
}

function enqueueDesktopEventTurn(
  session: DesktopCodexLiveSessionState,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): void {
  const previous = desktopEventQueues.get(session.session_id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => deliverDesktopEventTurn(session.session_id, event))
    .catch((error) => {
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "unknown",
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      }));
    });
  desktopEventQueues.set(session.session_id, next);
  void next.finally(() => {
    if (desktopEventQueues.get(session.session_id) === next) {
      desktopEventQueues.delete(session.session_id);
    }
  });
}

function stopSessionAfterRoomStopPhrase(sessionId: string): void {
  const updated = updateCodexLiveSession(sessionId, (current) => ({
    ...current,
    status: "interrupted",
    last_error: null,
    updated_at: new Date().toISOString(),
  }));
  if (!updated) {
    return;
  }
  killOwnedAppServer(updated);
  clearSessionMonitor(updated.session_id);
}

async function deliverDesktopEventTurn(
  sessionId: string,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): Promise<void> {
  const session = getStoredCodexLiveSession(sessionId);
  if (!session || !canDeliverDesktopEventToSession(session)) {
    return;
  }

  const serverReachable = await isCodexAppServerReady(session.server_url);
  if (!serverReachable) {
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      status: "unknown",
      last_error: "server unreachable while delivering room event",
      updated_at: new Date().toISOString(),
    }));
    return;
  }

  const client = new CodexRpcClient(session.server_url);
  try {
    await client.connect();
    const idleSession = await waitForCurrentTurnToIdle(client, session.session_id);
    if (!idleSession || !canDeliverDesktopEventToSession(idleSession)) {
      return;
    }

    const stopAfterTurn = isStopPhraseRoomStreamEvent(idleSession, event);
    const prompt = buildDesktopEventPrompt(bindCodexLiveSessionToWorker(idleSession), event);
    const turnStart = await client.request<TurnStartResult>("turn/start", {
      threadId: idleSession.thread_id,
      cwd: idleSession.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id for room event.");
    }

    updateCodexLiveSession(idleSession.session_id, (current) => ({
      ...current,
      turn_id: turnId,
      status: "running",
      last_error: null,
      updated_at: new Date().toISOString(),
    }));
    await waitForDesktopEventTurnCompletion(client, idleSession.session_id, turnId);
    if (stopAfterTurn) {
      stopSessionAfterRoomStopPhrase(idleSession.session_id);
    }
  } finally {
    client.close();
  }
}

async function waitForCurrentTurnToIdle(
  client: CodexRpcClient,
  sessionId: string,
): Promise<DesktopCodexLiveSessionState | null> {
  const deadline = Date.now() + DESKTOP_EVENT_TURN_TIMEOUT_MS;
  while (true) {
    const session = getStoredCodexLiveSession(sessionId);
    if (!session || !canDeliverDesktopEventToSession(session)) {
      return null;
    }

    let read: ThreadReadResult | null = null;
    try {
      read = await client.request<ThreadReadResult>("thread/read", {
        threadId: session.thread_id,
        includeTurns: true,
      });
    } catch (error) {
      if (isLikelyMaterializingError(error)) {
        if (Date.now() >= deadline) {
          updateCodexLiveSession(sessionId, (current) => ({
            ...current,
            status: "unknown",
            last_error: "previous turn could not be inspected while delivering room event",
            updated_at: new Date().toISOString(),
          }));
          return null;
        }
        await sleep(DESKTOP_EVENT_TURN_POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }

    const turns = read?.thread?.turns ?? [];
    const turn = turns.find((candidate) => candidate.id === session.turn_id);
    const turnStatus = extractTurnStatus(turn);
    if (!isActiveCodexTurnStatus(turnStatus)) {
      return session;
    }

    if (Date.now() >= deadline) {
      try {
        await client.request("turn/interrupt", {
          threadId: session.thread_id,
          turnId: session.turn_id,
        });
      } catch {
        // Best effort; the next inspect pass will reconcile the real state.
      }
      updateCodexLiveSession(sessionId, (current) => ({
        ...current,
        status: "unknown",
        last_error: "previous turn was still active while delivering room event",
        updated_at: new Date().toISOString(),
      }));
      return null;
    }

    updateCodexLiveSession(sessionId, (current) => ({
      ...current,
      status: "running",
      last_error: null,
      updated_at: new Date().toISOString(),
    }));
    await sleep(DESKTOP_EVENT_TURN_POLL_INTERVAL_MS);
  }
}

async function waitForDesktopEventTurnCompletion(
  client: CodexRpcClient,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const deadline = Date.now() + DESKTOP_EVENT_TURN_TIMEOUT_MS;
  while (true) {
    await sleep(DESKTOP_EVENT_TURN_POLL_INTERVAL_MS);
    const session = getStoredCodexLiveSession(sessionId);
    if (!session) {
      return;
    }
    if (Date.now() >= deadline) {
      try {
        await client.request("turn/interrupt", {
          threadId: session.thread_id,
          turnId,
        });
      } catch {
        // Best effort; the next inspect pass will reconcile the real state.
      }
      updateCodexLiveSession(sessionId, (current) => ({
        ...current,
        status: "unknown",
        last_error: "desktop-delivered event turn timed out",
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    let read: ThreadReadResult | null = null;
    try {
      read = await client.request<ThreadReadResult>("thread/read", {
        threadId: session.thread_id,
        includeTurns: true,
      });
    } catch (error) {
      if (isLikelyMaterializingError(error)) {
        continue;
      }
      throw error;
    }

    const turn = (read?.thread?.turns ?? []).find((candidate) => candidate.id === turnId);
    const turnStatus = extractTurnStatus(turn);
    if (!turnStatus || isActiveCodexTurnStatus(turnStatus)) {
      continue;
    }

    if (turnStatus === "completed") {
      updateCodexLiveSession(sessionId, (current) => ({
        ...current,
        status: "running",
        last_error: null,
        updated_at: new Date().toISOString(),
      }));
      return;
    }

    updateCodexLiveSession(sessionId, (current) => ({
      ...current,
      status: turnStatus === "interrupted"
        ? codexSessionStatusAfterTurnInterrupt(managedAgentDeliveryMode(current), true, false)
        : "failed",
      last_error: turnStatus === "interrupted" ? null : `event turn ended with ${turnStatus}`,
      updated_at: new Date().toISOString(),
    }));
    return;
  }
}

export async function stopDesktopManagedAgent(
  input: DesktopManagedAgentStopInput = {},
): Promise<DesktopManagedAgentSession | null> {
  const session = findStoredSession(input.sessionId, input.roomIdentifier);
  if (!session) {
    return null;
  }

  const serverReachable = await isCodexAppServerReady(session.server_url);
  let interruptError: string | null = null;
  let interruptSucceeded = false;
  if (serverReachable) {
    try {
      const client = new CodexRpcClient(session.server_url);
      await client.connect();
      try {
        await client.request("turn/interrupt", {
          threadId: session.thread_id,
          turnId: session.turn_id,
        });
        interruptSucceeded = true;
      } finally {
        client.close();
      }
    } catch (error) {
      // The app-server may die between the readiness check and interrupt RPC.
      interruptError = error instanceof Error ? error.message : String(error);
    }
  }

  const shutdownServer = shouldShutdownManagedAgentOnStop(input);
  const updated =
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      status: codexSessionStatusAfterStopAttempt(
        managedAgentDeliveryMode(current),
        serverReachable,
        shutdownServer,
        interruptSucceeded,
      ),
      last_error: serverReachable
        ? interruptError
        : "server unreachable at stop time",
      updated_at: new Date().toISOString(),
    })) ?? session;

  if (shutdownServer || updated.status !== "running") {
    killOwnedAppServer(updated);
  }
  if (updated.status !== "running") {
    clearSessionMonitor(updated.session_id);
  } else {
    scheduleOwnedSessionMonitor(updated);
  }

  return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
}
