import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  DesktopAgentProviderId,
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentEffort,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import { buildRepoStatus } from "../../repo-status.js";
import { emitPersistedLocalRoomMessage } from "../room-stream.js";
import { isDesktopSmokeCheck } from "../smoke.js";
import { emitToMainWindow } from "../window.js";
import { publishSupervisorActivity } from "../supervisor-daemon.js";
import { launchLegacyWithOwnership } from "../supervisor-ownership.js";
import {
  cloudRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "../rooms/local-store.js";
import {
  isCodexAppServerReady,
  launchCodexAppServer,
  resolveCodexAppServerUrl,
  terminateSpawnedProcess,
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
} from "./codex-event-routing.js";
import {
  isManagedRoomStreamEvent,
  listDeliverableCodexSessionsForRoomStreamEvent,
  type ManagedRoomEvent,
} from "./codex-managed-agent-dispatch.js";
import {
  buildDesktopEventPrompt,
} from "./codex-event-prompt.js";
import {
  buildManagedAgentContextResultPrompt,
  executeManagedAgentContextRequest,
  hasManagedAgentContextRequestLine,
  parseManagedAgentContextRequest,
} from "./managed-agent-context.js";
import {
  runManagedAgentRoomToolLoop,
  type ManagedAgentRoomToolLoopState,
} from "./managed-agent-room-tool-loop.js";
import {
  shouldUseCloudDesktopManagedAgentWorkerSession,
} from "./managed-agent-local-worker-session.js";
import type {
  ManagedAgentContextRequest,
  ManagedAgentContextResult,
} from "./managed-agent-context-protocol.js";
import {
  CodexRpcClient,
  type RpcNotification,
  type ThreadReadResult,
  type ThreadReadTurn,
  type ThreadReadTurnItem,
  type ThreadStartResult,
  type TurnStartResult,
} from "./codex-rpc-client.js";
import {
  CODEX_EVENT_TURN_ABSOLUTE_TIMEOUT_MS,
  CODEX_EVENT_TURN_INACTIVITY_TIMEOUT_MS,
  CodexTurnProgressTracker,
  type CodexTurnTimeoutReason,
} from "./codex-turn-progress.js";
import {
  CodexTurnLifecycleObserver,
} from "./codex-turn-lifecycle.js";
import {
  summarizeCodexRuntimeNotification,
  summarizeCodexRuntimeSnapshot,
  type CodexRuntimeReasoningSummary,
} from "./codex-runtime-reasoning.js";
import { DEFAULT_CODEX_DELIVERY_MODE } from "./defaults.js";
import {
  deriveCodexLiveSessionStatus,
  extractThreadStatus,
  extractTurnStatus,
  codexSessionStatusAfterInspectFailure,
  codexSessionStatusAfterNoActiveTurnStop,
  codexSessionStatusAfterTurnInterrupt,
  codexSessionStatusAfterStopAttempt,
  isLikelyMaterializingError,
  isActiveCodexTurnStatus,
  isTerminalCodexSessionStatus,
  finalPublicAgentMessageText,
  parseStartupObservationMs,
  shouldStopCodexSessionMonitor,
  shouldShutdownManagedAgentOnStop,
  sleep,
  STARTUP_POLL_INTERVAL_MS,
  summarizeItems,
} from "./codex-session-status.js";
import { runDesktopAgentProviderPreflight } from "./providers.js";
import {
  normalizeManagedAgentEffortForProvider,
  normalizeManagedAgentModel,
} from "./managed-agent-models.js";
import { DesktopManagedAgentRuntimeRegistry } from "./managed-agent-runtime.js";
import { cleanupAgentSessionAttachments } from "./managed-agent-attachments.js";
import {
  disconnectDesktopManagedWorker,
  endDesktopManagedWorkerSession,
  normalizeDisplayText,
  pauseDesktopManagedWorkerDelivery,
  publishDesktopManagedWorkerFailure,
  publishDesktopManagedWorkerReply,
  registerDesktopManagedWorker,
  startDesktopManagedWorkerDeliveryHeartbeat,
  type ManagedAgentWorkerProvider,
} from "./managed-agent-worker.js";
import { buildDesktopManagedAgentChangeSummary } from "./managed-agent-changes.js";
import {
  clearAllDesktopManagedAgentReplyChangeState,
  clearDesktopManagedAgentReplyChangeState,
} from "./managed-agent-reply-changes.js";
import { createDesktopCursorRuntime } from "./cursor-runtime.js";
import {
  createManagedAgentEventTurnEngine,
  type ManagedAgentEventTurnResult,
} from "./managed-agent-event-turn-engine.js";
import {
  assertManagedAgentPermissionProfileAvailable,
} from "./managed-agent-permission-profiles.js";
import {
} from "./managed-agent-local-replies.js";
import {
  bindCodexLiveSessionToWorker,
  getCurrentCodexLiveSession,
  getStoredAgentSession,
  getStoredCodexLiveSession,
  listCodexDisplayNamesForRoom,
  listDesktopManagedCodexLiveSessions,
  listDesktopManagedCodexLiveSessionsForProvider,
  listStoredCodexLiveSessions,
  managedAgentDeliveryMode,
  saveCodexLiveSession,
  toPublicManagedAgentSession,
  updateCodexLiveSession,
  type DesktopCodexJoinedVia,
  type DesktopCodexLiveSessionState,
  type StoredAgentSessionState,
} from "./state.js";

const SESSION_MONITOR_INTERVAL_MS = 30_000;
const DESKTOP_EVENT_MATERIALIZATION_RETRY_MS = 1_000;
const DESKTOP_EVENT_CONTEXT_REQUEST_LIMIT = 3;
const DESKTOP_EVENT_CONTEXT_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_RUNTIME_REASONING_THROTTLE_MS = 750;
const CODEX_RUNTIME_REASONING_REPEAT_MS = 30_000;

const spawnedServerPids = new Set<number>();
const daemonOwnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();
const rehydratedDaemonSessionIds = new Set<string>();
const codexRuntimeReasoningLastPost = new Map<string, { signature: string; postedAt: number }>();
const codexRuntimeReasoningPostQueues = new Map<string, Promise<void>>();
type ActiveCodexTurnProgress = {
  turnId: string;
  tracker: CodexTurnProgressTracker;
  lastWaitingHeartbeatAt: number | null;
};
const activeCodexTurnProgress = new Map<string, ActiveCodexTurnProgress>();
const desktopManagedAgentRuntimes = new DesktopManagedAgentRuntimeRegistry();
const CODEX_EXTERNAL_WAIT_ITEM_PATTERN = /(command|exec|tool|mcp|collab|web.?search)/i;
let cleanupRegistered = false;
const CODEX_WORKER_REGISTRATION_ERROR =
  "Codex did not get a LetAgents room worker identity. Sign into LetAgents Desktop, then try starting the agent again.";

desktopManagedAgentRuntimes.register({
  providerId: "codex",
  listSessions: listDesktopManagedCodexAgentSessions,
  start: startDesktopManagedCodexAgent,
  inspect: inspectDesktopManagedCodexAgentSession,
  stop: stopDesktopManagedCodexAgent,
  retry: retryDesktopManagedCodexAgent,
  dispatchRoomStreamEvent: dispatchRoomStreamEventToCodexManagedAgents,
});
desktopManagedAgentRuntimes.register(createDesktopCursorRuntime());

type ReasoningSessionCreateResponse = {
  session?: { id?: string };
};

function codexReplyChangeSessionKey(sessionId: string): string {
  return `codex:${sessionId}`;
}


const CODEX_WORKER_PROVIDER: ManagedAgentWorkerProvider = {
  ideLabel: "Codex",
  runtimePrefix: "codex",
  instancePrefix: "desktop-codex",
  livenessCapability: "desktop_supervised_codex_app_server",
  identityNameFallback: "desktop-codex",
  signInErrorMessage: "Sign into LetAgents Desktop before starting a supervised Codex agent.",
  unusableIdentityErrorMessage: "LetAgents did not return a usable agent identity for the desktop worker.",
  missingActorKeyErrorMessage: "LetAgents desktop agent identity is missing an actor key.",
  allowLegacyGlobalIdentity: true,
  replyWarnLabel: "Codex",
};

async function registerDesktopManagedCodexWorker(input: {
  roomIdentifier: string;
  displayName: string;
  token: string;
  repoBranch: string | null;
  ideLabel?: string;
}): Promise<StoredAgentSessionState> {
  // The runtime and instance markers stay codex-prefixed for every
  // Codex-engine provider: worker binding matches on these exact
  // per-token markers, and tokens are unique per session.
  return registerDesktopManagedWorker(CODEX_WORKER_PROVIDER, input);
}

async function disconnectDesktopManagedCodexWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  await disconnectDesktopManagedWorker(session);
}

function reasoningRoomPath(roomIdentifier: string): string {
  return `/rooms/${encodeURIComponent(roomIdentifier)}/reasoning-sessions`;
}

function reasoningSignature(
  session: DesktopCodexLiveSessionState,
  summary: CodexRuntimeReasoningSummary,
): string {
  return [
    session.session_id,
    summary.status,
    summary.summary,
    summary.checking,
    summary.next_action,
  ].join("\n");
}

function shouldPostCodexRuntimeReasoning(
  session: DesktopCodexLiveSessionState,
  summary: CodexRuntimeReasoningSummary,
): boolean {
  const signature = reasoningSignature(session, summary);
  const previous = codexRuntimeReasoningLastPost.get(session.session_id);
  const now = Date.now();
  if (
    previous?.signature === signature &&
    now - previous.postedAt < CODEX_RUNTIME_REASONING_REPEAT_MS
  ) {
    return false;
  }
  if (previous && now - previous.postedAt < CODEX_RUNTIME_REASONING_THROTTLE_MS) {
    return false;
  }
  codexRuntimeReasoningLastPost.set(session.session_id, { signature, postedAt: now });
  return true;
}

async function publishCodexRuntimeReasoningSummary(
  session: DesktopCodexLiveSessionState,
  summary: CodexRuntimeReasoningSummary,
): Promise<void> {
  const workerSession = getStoredAgentSession(session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) {
    return;
  }

  if (!(await shouldUseCloudDesktopManagedAgentWorkerSession(workerSession))) {
    return;
  }

  if (!shouldPostCodexRuntimeReasoning(session, summary)) {
    return;
  }

  const actorLabel = normalizeDisplayText(
    workerSession.actor_label || workerSession.display_name,
    session.display_name || "Codex",
  );
  const body = {
    actor_label: actorLabel,
    agent_key: workerSession.agent_key ?? null,
    agent_session_id: workerSession.session_id,
    agent_session_token: workerSession.session_token,
    summary: summary.summary,
    goal: "Stream Codex runtime progress for this LetAgents room.",
    checking: summary.checking,
    next_action: summary.next_action,
    status: summary.status,
  };

  const storage = await resolveLocalAwareRoomStorageMode(session.room_identifier || session.room_id);
  if (storage.effectiveMode === "local") {
    return;
  }
  const roomPath = reasoningRoomPath(
    cloudRoomIdentifierForStorage(storage, session.room_identifier || session.room_id),
  );
  if (session.reasoning_session_id) {
    try {
      await apiFetch<Record<string, unknown>>(
        `${roomPath}/${encodeURIComponent(session.reasoning_session_id)}/updates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
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

  const created = await apiFetch<ReasoningSessionCreateResponse>(roomPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

function queueCodexRuntimeReasoningSummary(
  session: DesktopCodexLiveSessionState,
  summary: CodexRuntimeReasoningSummary,
): void {
  updateActiveWorkSummary(session.session_id, summary.summary);
  if (session.supervisor_entry_id) {
    void publishSupervisorActivity({
      entryId: session.supervisor_entry_id,
      provider: "codex",
      kind: "provider_event",
      method: "codex.runtime.activity",
      summary: summary.summary,
      status: summary.status,
      payload: { checking: summary.checking, nextAction: summary.next_action },
    }).catch(() => {
      // Daemon activity persistence is retried by later native events. Never
      // terminate the provider turn because the desktop UI bridge is absent.
    });
  }
  const previous = codexRuntimeReasoningPostQueues.get(session.session_id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const latest = getStoredCodexLiveSession(session.session_id) ?? session;
      await publishCodexRuntimeReasoningSummary(latest, summary);
    })
    .catch(() => {
      // Reasoning publication is best-effort UI state.
    });
  codexRuntimeReasoningPostQueues.set(session.session_id, next);
  void next.finally(() => {
    if (codexRuntimeReasoningPostQueues.get(session.session_id) === next) {
      codexRuntimeReasoningPostQueues.delete(session.session_id);
    }
  });
}

function publishCodexRuntimeNotification(
  sessionId: string | null | undefined,
  notification: RpcNotification,
): void {
  observeCodexRuntimeNotificationProgress(sessionId, notification);
  const session = sessionId ? getStoredCodexLiveSession(sessionId) : null;
  if (!session) {
    return;
  }
  queueCodexRuntimeReasoningSummary(
    session,
    summarizeCodexRuntimeNotification(notification),
  );
}

function publishCodexRuntimeSnapshot(
  session: DesktopCodexLiveSessionState,
  input: Parameters<typeof summarizeCodexRuntimeSnapshot>[0],
): void {
  const summary = summarizeCodexRuntimeSnapshot(input);
  if (!summary) {
    return;
  }
  queueCodexRuntimeReasoningSummary(session, summary);
}

function clearCodexRuntimeReasoningState(sessionId: string): void {
  codexRuntimeReasoningLastPost.delete(sessionId);
  codexRuntimeReasoningPostQueues.delete(sessionId);
  activeCodexTurnProgress.delete(sessionId);
  clearDesktopManagedAgentReplyChangeState(codexReplyChangeSessionKey(sessionId));
  cleanupAgentSessionAttachments(sessionId);
}

function startCodexTurnProgress(
  sessionId: string,
  turnId: string,
): ActiveCodexTurnProgress {
  const tracking: ActiveCodexTurnProgress = {
    turnId,
    tracker: new CodexTurnProgressTracker({ startedAt: Date.now() }),
    lastWaitingHeartbeatAt: null,
  };
  activeCodexTurnProgress.set(sessionId, tracking);
  return tracking;
}

function stopCodexTurnProgress(sessionId: string, tracking: ActiveCodexTurnProgress): void {
  if (activeCodexTurnProgress.get(sessionId) === tracking) {
    activeCodexTurnProgress.delete(sessionId);
  }
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function runtimeItemStatus(item: ThreadReadTurnItem | null | undefined): string {
  if (typeof item?.status === "string") return item.status;
  const status = runtimeRecord(item?.status);
  return typeof status?.status === "string" ? status.status : "";
}

function isExplicitExternalWaitItem(item: ThreadReadTurnItem | null | undefined): boolean {
  return CODEX_EXTERNAL_WAIT_ITEM_PATTERN.test(String(item?.type ?? ""));
}

function runtimeItemWaitKey(item: ThreadReadTurnItem | null | undefined): string | null {
  if (!item) return null;
  const detail = item.id || item.name || item.command || item.type;
  return detail ? String(detail) : null;
}

function isActiveRuntimeItem(item: ThreadReadTurnItem): boolean {
  const status = runtimeItemStatus(item);
  return !status || isActiveCodexTurnStatus(status);
}

function notificationTurnId(notification: RpcNotification): string | null {
  const record = runtimeRecord(notification.params);
  const turn = runtimeRecord(record?.turn);
  const value = record?.turnId ?? record?.turn_id ?? turn?.id;
  return typeof value === "string" ? value : null;
}

function notificationItem(notification: RpcNotification): ThreadReadTurnItem | null {
  const item = runtimeRecord(runtimeRecord(notification.params)?.item);
  return item as ThreadReadTurnItem | null;
}

function observeCodexRuntimeNotificationProgress(
  sessionId: string | null | undefined,
  notification: RpcNotification,
): void {
  if (!sessionId || !/^item\/|^turn\//i.test(notification.method)) {
    return;
  }
  const tracking = activeCodexTurnProgress.get(sessionId);
  if (!tracking || notificationTurnId(notification) !== tracking.turnId) {
    return;
  }

  const now = Date.now();
  const fingerprint = JSON.stringify(notification.params ?? null);
  const observation = {
    source: `notification:${notification.method}`,
    fingerprint,
    observedAt: now,
  };
  const item = notificationItem(notification);
  const waitKey = runtimeItemWaitKey(item);
  if (waitKey && isExplicitExternalWaitItem(item) && notification.method === "item/started") {
    tracking.tracker.beginExplicitWait(`notification:${waitKey}`, observation);
    return;
  }
  if (waitKey && notification.method === "item/completed") {
    tracking.tracker.endExplicitWait(`notification:${waitKey}`, observation);
    return;
  }
  tracking.tracker.observeProgress(observation);
}

function observeCodexTurnSnapshot(input: {
  tracking: ActiveCodexTurnProgress;
  threadStatus: string | null;
  turnStatus: string | null;
  turn: ThreadReadTurn | null | undefined;
  observedAt: number;
}): void {
  const items = input.turn?.items ?? input.turn?.output ?? [];
  const explicitWaits = items
    .filter((item) => isExplicitExternalWaitItem(item) && isActiveRuntimeItem(item))
    .map(runtimeItemWaitKey)
    .filter((key): key is string => Boolean(key));
  input.tracking.tracker.replaceExplicitWaits("snapshot", explicitWaits, {
    source: "snapshot",
    fingerprint: JSON.stringify({
      threadStatus: input.threadStatus,
      turnStatus: input.turnStatus,
      items,
    }),
    observedAt: input.observedAt,
  });
}

function maybePublishCodexWaitingHeartbeat(
  session: DesktopCodexLiveSessionState,
  tracking: ActiveCodexTurnProgress,
  now: number,
): void {
  if (tracking.tracker.activityState(now) !== "waiting") {
    tracking.lastWaitingHeartbeatAt = null;
    return;
  }
  if (
    tracking.lastWaitingHeartbeatAt !== null &&
    now - tracking.lastWaitingHeartbeatAt < CODEX_RUNTIME_REASONING_REPEAT_MS
  ) {
    return;
  }
  tracking.lastWaitingHeartbeatAt = now;
  const explicitWait = tracking.tracker.hasExplicitWait();
  queueCodexRuntimeReasoningSummary(session, {
    summary: explicitWait
      ? "Codex is waiting for an external command or tool to finish."
      : "Codex is waiting for new runtime progress.",
    status: "working",
    checking: explicitWait
      ? "The app-server still reports an active external operation."
      : "The desktop supervisor is watching the turn's inactivity window.",
    next_action: explicitWait
      ? "Keep the worker heartbeat alive while the external operation runs."
      : "Continue waiting unless the inactivity deadline is reached.",
  });
}

function codexTurnTimeoutError(prefix: string, reason: CodexTurnTimeoutReason): string {
  if (reason === "absolute") {
    const minutes = Math.round(CODEX_EVENT_TURN_ABSOLUTE_TIMEOUT_MS / 60_000);
    return `${prefix} exceeded the ${minutes}-minute absolute limit`;
  }
  const minutes = Math.round(CODEX_EVENT_TURN_INACTIVITY_TIMEOUT_MS / 60_000);
  return `${prefix} made no observable progress for ${minutes} minutes`;
}

function emitManagedAgentSessionUpdate(session: DesktopCodexLiveSessionState | null | undefined): void {
  if (!session) {
    return;
  }
  emitToMainWindow(
    "desktop:workers:managed-agent-session",
    toPublicManagedAgentSession(bindCodexLiveSessionToWorker(session)),
  );
}

function markSpawnedCodexAppServersOffline(reason: string): void {
  const pids = new Set(spawnedServerPids);
  for (const session of listStoredCodexLiveSessions()) {
    if (!session.launched_server || !session.server_pid || !pids.has(session.server_pid)) {
      continue;
    }
    if (session.supervisor_entry_id || daemonOwnedServerPids.has(session.server_pid)) continue;
    if (!isTerminalCodexSessionStatus(session.status)) {
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "failed",
        last_error: reason,
        updated_at: new Date().toISOString(),
      }));
    }
    endDesktopManagedWorkerSession(session.agent_session_id);
    clearCodexRuntimeReasoningState(session.session_id);
  }
}

function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const timer of sessionMonitorTimers.values()) {
      clearInterval(timer);
    }
    sessionMonitorTimers.clear();

    markSpawnedCodexAppServersOffline("LetAgents Desktop stopped the local Codex app-server.");

    for (const pid of spawnedServerPids) {
      if (daemonOwnedServerPids.has(pid)) continue;
      terminateSpawnedProcess(pid);
    }
    spawnedServerPids.clear();
    daemonOwnedServerPids.clear();
    rehydratedDaemonSessionIds.clear();
    codexRuntimeReasoningLastPost.clear();
    codexRuntimeReasoningPostQueues.clear();
    clearAllDesktopManagedAgentReplyChangeState();
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

function registerLaunchedAppServer(pid: number, daemonOwned = false): void {
  spawnedServerPids.add(pid);
  if (daemonOwned) daemonOwnedServerPids.add(pid);
  registerProcessCleanup();
}

function forgetLaunchedAppServer(pid: number): void {
  spawnedServerPids.delete(pid);
  daemonOwnedServerPids.delete(pid);
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedCodexAppServerExited(session: DesktopCodexLiveSessionState): boolean {
  return Boolean(session.launched_server && !isProcessAlive(session.server_pid));
}

function offlineAppServerError(session: DesktopCodexLiveSessionState): string {
  return ownedCodexAppServerExited(session)
    ? "Codex app-server exited or is no longer reachable."
    : "server unreachable";
}

function isSmokeManagedCodexSession(session: DesktopCodexLiveSessionState): boolean {
  return isDesktopSmokeCheck() && session.server_url === "smoke://codex";
}

function smokeManagedCodexInspection(
  session: DesktopCodexLiveSessionState,
): DesktopManagedAgentInspectResult {
  const updated =
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      status: "running",
      last_error: null,
      updated_at: new Date().toISOString(),
    })) ?? session;
  const bound = bindCodexLiveSessionToWorker(updated);
  return {
    session: toPublicManagedAgentSession(bound),
    serverReachable: true,
    recentItems: [
      {
        type: "agentMessage",
        text: "Published local Codex progress for smoke verification.",
      },
    ],
  };
}

function killOwnedAppServer(session: DesktopCodexLiveSessionState): void {
  clearCodexRuntimeReasoningState(session.session_id);
  endDesktopManagedWorkerSession(session.agent_session_id);
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
  clearCodexRuntimeReasoningState(sessionId);
}

function scheduleOwnedSessionMonitor(session: DesktopCodexLiveSessionState): void {
  if (sessionMonitorTimers.has(session.session_id)) {
    return;
  }

  const timer = setInterval(() => {
    void inspectDesktopManagedCodexAgentSession(session.session_id)
      .then((status) => {
        if (
          !status ||
          shouldStopCodexSessionMonitor(
            status.session.deliveryMode,
            status.session.status,
            status.serverReachable,
          )
        ) {
          clearSessionMonitor(session.session_id);
        }
      })
      .catch(() => {
        const latest = getStoredCodexLiveSession(session.session_id);
        if (latest?.launched_server && !latest.supervisor_entry_id) {
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
    agent_session_id: session.agent_session_id ?? current.agent_session_id,
    reasoning_session_id: session.reasoning_session_id ?? current.reasoning_session_id,
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

function statusAfterDesktopEventCompletedTurn(
  session: DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState {
  const bound = bindCodexLiveSessionToWorker(session);
  if (bound.agent_session_id) {
    return {
      ...bound,
      status: "completed",
      active_work: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    };
  }
  if (session.status === "starting") {
    return {
      ...session,
      status: "starting",
      active_work: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    };
  }
  return {
    ...session,
    status: "unknown",
    active_work: null,
    last_error: "Codex completed a desktop event turn before registering with LetAgents.",
    updated_at: new Date().toISOString(),
  };
}

function isIdleCodexThreadStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return normalized === "idle" ||
    normalized === "waiting" ||
    normalized === "waiting for event" ||
    normalized === "completed" ||
    normalized === "complete";
}

function isCompletedOrIdleCodexTurnStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return normalized === "completed" ||
    normalized === "complete" ||
    normalized === "idle";
}

function statusAfterNoActiveTurnToStop(
  session: DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState {
  const status = codexSessionStatusAfterNoActiveTurnStop(
    managedAgentDeliveryMode(session),
    session.status,
  );
  if (status === "completed") {
    return statusAfterDesktopEventCompletedTurn(session);
  }

  return {
    ...session,
    status,
    active_work: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

function markCodexStartupRegistrationFailed(
  session: DesktopCodexLiveSessionState,
  reason = session.last_error || CODEX_WORKER_REGISTRATION_ERROR,
): DesktopCodexLiveSessionState {
  return updateCodexLiveSession(session.session_id, (current) => ({
    ...current,
    status: "failed",
    last_error: reason,
    updated_at: new Date().toISOString(),
  })) ?? {
    ...session,
    status: "failed",
    last_error: reason,
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
    const inspected = await inspectDesktopManagedCodexAgentSession(session.session_id);
    if (!inspected) {
      continue;
    }

    latest = getStoredCodexLiveSession(session.session_id) ?? latest;
    if (!inspected.serverReachable) {
      const reason = "app-server became unreachable during startup";
      const failed =
        updateCodexLiveSession(session.session_id, (current) => ({
          ...current,
          status: "failed",
          last_error: current.last_error || reason,
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

function listDesktopManagedCodexAgentSessions(
  roomIdentifier?: string | null,
): DesktopManagedAgentSession[] {
  return listDesktopManagedCodexLiveSessionsForProvider("codex", roomIdentifier)
    .map(rehydrateDaemonOwnedCodexSession)
    .map((session) => bindCodexLiveSessionToWorker(session))
    .map(toPublicManagedAgentSession);
}

function rehydrateDaemonOwnedCodexSession(session: DesktopCodexLiveSessionState): DesktopCodexLiveSessionState {
  if (!session.supervisor_entry_id || rehydratedDaemonSessionIds.has(session.session_id)) return session;
  rehydratedDaemonSessionIds.add(session.session_id);
  if (session.launched_server && session.server_pid && isProcessAlive(session.server_pid)) {
    registerLaunchedAppServer(session.server_pid, true);
  }
  const worker = getStoredAgentSession(session.agent_session_id);
  if (worker && !worker.ended_at) startDesktopManagedWorkerDeliveryHeartbeat(worker, session.room_identifier);
  const idleDesktopEventSession = managedAgentDeliveryMode(session) === "desktop_events" && session.status === "completed";
  if (!isTerminalCodexSessionStatus(session.status) || idleDesktopEventSession) scheduleOwnedSessionMonitor(session);
  return session;
}

export function listDesktopManagedAgentSessions(
  roomIdentifier?: string | null,
): DesktopManagedAgentSession[] {
  return desktopManagedAgentRuntimes.listSessions(roomIdentifier);
}

export async function getDesktopManagedAgentChangeSummary(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): Promise<DesktopManagedAgentChangeSummary | null> {
  const targetSessionId = String(sessionId ?? "").trim();
  if (!targetSessionId) return null;
  const session = listDesktopManagedCodexAgentSessions(roomIdentifier)
    .find((candidate) => candidate.id === targetSessionId);
  if (!session) return null;
  return buildDesktopManagedAgentChangeSummary(session);
}

interface CodexEngineProviderContext {
  providerId: DesktopAgentProviderId;
  providerName: string;
  ideLabel: string;
  model: string | null;
  effort: DesktopManagedAgentEffort | null;
  launch: {
    configOverrides?: string[];
    env?: Record<string, string>;
  };
  /** BYOK engines carry per-session launch config, so they never share an app-server. */
  dedicatedServer: boolean;
  /** Restrict to desktop-delivered events (no MCP polling mode). */
  forceDesktopEvents: boolean;
}

const CODEX_ENGINE_CONTEXT: CodexEngineProviderContext = {
  providerId: "codex",
  providerName: "Codex",
  ideLabel: "Codex",
  model: null,
  effort: null,
  launch: {},
  dedicatedServer: false,
  forceDesktopEvents: false,
};

function startDesktopManagedCodexAgent(
  input: DesktopManagedAgentStartInput,
): Promise<DesktopManagedAgentStartResult> {
  const launchContext = buildCodexManagedAgentLaunchContext(input);
  return startDesktopManagedCodexEngineAgent(input, {
    ...CODEX_ENGINE_CONTEXT,
    ...launchContext,
  });
}

export function buildCodexManagedAgentLaunchContext(
  input: Pick<DesktopManagedAgentStartInput, "model" | "effort">,
): {
  model: string | null;
  effort: DesktopManagedAgentEffort | null;
  launch: { configOverrides?: string[] };
  dedicatedServer: boolean;
} {
  const selectedModel = normalizeManagedAgentModel(input.model);
  const selectedEffort = normalizeManagedAgentEffortForProvider("codex", input.effort);
  const configOverrides = [
    ...(selectedModel ? [`model=${JSON.stringify(selectedModel)}`] : []),
    ...(selectedEffort ? [`model_reasoning_effort=${JSON.stringify(selectedEffort)}`] : []),
  ];
  return {
    model: selectedModel,
    effort: selectedEffort,
    launch: configOverrides.length ? { configOverrides } : {},
    dedicatedServer: Boolean(configOverrides.length),
  };
}

async function startDesktopManagedCodexEngineAgent(
  input: DesktopManagedAgentStartInput,
  engine: CodexEngineProviderContext,
): Promise<DesktopManagedAgentStartResult> {
  const roomIdentifier = normalizeRoomIdentifier(input.roomIdentifier);
  const repoRootPath = input.repoRootPath?.trim();
  if (!repoRootPath) {
    throw new Error(`Choose a local repository before starting ${engine.providerName}.`);
  }
  const cwd = resolve(repoRootPath);
  const repoBranch = await buildRepoStatus(cwd)
    .then((status) => status.branch)
    .catch(() => null);
  const codexBin = process.env.LETAGENTS_CODEX_BIN || "codex";
  const permissionProfile = assertManagedAgentPermissionProfileAvailable(engine.providerId, input.permissionProfileId);
  const preflight = await runDesktopAgentProviderPreflight(engine.providerId, {
    roomIdentifier,
    roomGitRoom: input.roomGitRoom,
    repoRootPath: cwd,
    model: input.model,
    modelSource: input.modelSource,
  });
  if (!preflight.canStart) {
    throw new Error(preflight.detail || preflight.message);
  }

  const serverUrl = await resolveCodexAppServerUrl(null, { dedicated: engine.dedicatedServer });
  const deliveryMode = engine.forceDesktopEvents
    ? "desktop_events"
    : input.deliveryMode || DEFAULT_CODEX_DELIVERY_MODE;
  const stopPhrase = input.stopPhrase?.trim() || DEFAULT_CODEX_STOP_PHRASE;
  const maxMinutes = coerceMaxMinutes(input.maxMinutes);
  const token = makeCodexStopToken();
  const deadline = formatCodexDeadline(maxMinutes);
  const suggestedDisplayName = suggestLetAgentsCodename(listCodexDisplayNamesForRoom(roomIdentifier), token);
  const registeredWorker = deliveryMode === "desktop_events"
    ? await registerDesktopManagedCodexWorker({
      roomIdentifier,
      displayName: suggestedDisplayName,
      token,
      repoBranch,
      ideLabel: engine.ideLabel,
    })
    : null;
  const displayName = registeredWorker?.display_name || suggestedDisplayName;
  const launchedServer = !(await isCodexAppServerReady(serverUrl));
  let serverPid: number | null = null;
  let startupSucceeded = false;
  let client: CodexRpcClient | null = null;
  let runtimeNotificationSessionId: string | null = null;

  try {
    if (launchedServer) {
      const launch = launchCodexAppServer(serverUrl, codexBin, {
        trustedProjectPath: cwd,
        configOverrides: engine.launch.configOverrides,
        env: engine.launch.env,
      });
      serverPid = launch.pid;
      if (serverPid) {
        registerLaunchedAppServer(serverPid, Boolean(input.supervisorEntryId));
      }
      const ready = await waitForLaunchedCodexAppServer(serverUrl, launch);
      if (!ready) {
        throw new Error(`Timed out waiting for codex app-server at ${serverUrl}`);
      }
    }

    client = new CodexRpcClient(serverUrl, (notification) => {
      publishCodexRuntimeNotification(runtimeNotificationSessionId, notification);
    });
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
      suggestedDisplayName: displayName,
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
      room_id: registeredWorker?.room_id ?? roomIdentifier,
      room_identifier: roomIdentifier,
      room_display_name: input.roomDisplayName ?? null,
      display_name: displayName,
      provider_id: engine.providerId === "codex" ? undefined : engine.providerId,
      model: engine.model,
      effort: engine.effort,
      joined_via: joinedVia,
      cwd,
      repo_branch: repoBranch,
      stop_phrase: stopPhrase,
      max_minutes: maxMinutes,
      delivery_mode: deliveryMode,
      permission_profile_id: permissionProfile.id,
      desktop_managed: true,
      supervisor_entry_id: input.supervisorEntryId ?? null,
      deadline_utc: deadline.utc,
      token,
      thread_id: threadId,
      turn_id: turnId,
      server_url: serverUrl,
      server_pid: serverPid,
      launched_server: launchedServer,
      codex_bin: codexBin,
      agent_session_id: registeredWorker?.session_id ?? null,
      reasoning_session_id: null,
      status: "starting",
      last_error: null,
      started_at: now,
      updated_at: now,
    });
    runtimeNotificationSessionId = session.session_id;

    queueCodexRuntimeReasoningSummary(session, {
      summary: `${engine.providerName} worker is starting and joining the room.`,
      status: "working",
      checking: "Desktop supervisor started a Codex app-server turn.",
      next_action: `Waiting for ${engine.providerName} to publish room progress.`,
    });

    try {
      const verifiedSession = bindCodexLiveSessionToWorker(await waitForWorkerStartup(session, deliveryMode));
      scheduleOwnedSessionMonitor(verifiedSession);
      startupSucceeded = true;
      return {
        session: toPublicManagedAgentSession(verifiedSession),
        reused: false,
        message: deliveryMode === "desktop_events"
          ? `${engine.providerName} agent started with desktop-delivered room events.`
          : `${engine.providerName} agent started for this room.`,
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
    if (!startupSucceeded && registeredWorker) {
      await disconnectDesktopManagedCodexWorker(registeredWorker);
    }
    throw error;
  } finally {
    client?.close();
  }
}

export async function startDesktopManagedAgent(
  input: DesktopManagedAgentStartInput,
): Promise<DesktopManagedAgentStartResult> {
  if (input.supervisorEntryId || (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1")) {
    return desktopManagedAgentRuntimes.start(input);
  }
  const { supervisorDaemonClient } = await import("../supervisor-daemon.js");
  const reservationId = `legacy_${randomUUID()}`;
  return launchLegacyWithOwnership({
    reserve: () => supervisorDaemonClient.reserveLegacyLane(input.roomIdentifier, input.providerId, reservationId).then(() => undefined),
    start: () => desktopManagedAgentRuntimes.start(input),
    activate: (started) => supervisorDaemonClient.activateLegacyLane(reservationId, started.session.id).then(() => undefined),
    stop: async (started) => {
      const stopped = await desktopManagedAgentRuntimes.stop({ sessionId: started.session.id, stopMode: "worker" });
      if (!stopped) throw new Error("Spawned legacy agent could not be stopped after ownership activation failed.");
    },
    release: () => supervisorDaemonClient.releaseLegacyLane({ reservationId }).then(() => undefined),
  });
}

async function inspectDesktopManagedCodexAgentSession(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): Promise<DesktopManagedAgentInspectResult | null> {
  const session = findStoredSession(sessionId, roomIdentifier);
  if (!session) {
    return null;
  }

  if (isSmokeManagedCodexSession(session)) {
    return smokeManagedCodexInspection(session);
  }

  const serverReachable = await isCodexAppServerReady(session.server_url);
  if (!serverReachable) {
    const ownedServerExited = ownedCodexAppServerExited(session);
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: ownedServerExited
          ? "failed"
          : deriveCodexLiveSessionStatus(current.status, false, null, null),
        last_error: offlineAppServerError(current),
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (ownedServerExited || (updated.launched_server && !updated.supervisor_entry_id)) {
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

  const client = new CodexRpcClient(session.server_url, (notification) => {
    publishCodexRuntimeNotification(session.session_id, notification);
  });
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
      updateCodexLiveSession(session.session_id, (current) =>
        managedAgentDeliveryMode(current) === "desktop_events" &&
          (isCompletedOrIdleCodexTurnStatus(turnStatus) || (!turnStatus && isIdleCodexThreadStatus(threadStatus)))
          ? statusAfterDesktopEventCompletedTurn(current)
          : {
            ...current,
            status: deriveCodexLiveSessionStatus(current.status, true, threadStatus, turnStatus),
            last_error: null,
            updated_at: new Date().toISOString(),
          }
      ) ?? session;

    const bound = bindCodexLiveSessionToWorker(updated);
    publishCodexRuntimeSnapshot(bound, {
      threadStatus,
      turnStatus,
      recentItems: turn?.items ?? turn?.output,
    });

    const idleDesktopEventSession =
      managedAgentDeliveryMode(bound) === "desktop_events" && bound.status === "completed";
    if (isTerminalCodexSessionStatus(bound.status) && !idleDesktopEventSession) {
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
        status: codexSessionStatusAfterInspectFailure(current.status),
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      })) ?? session;

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

export function inspectDesktopManagedAgentSession(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): Promise<DesktopManagedAgentInspectResult | null> {
  return desktopManagedAgentRuntimes.inspect(sessionId, roomIdentifier);
}

function dispatchRoomStreamEventToCodexManagedAgents(event: DesktopRoomStreamEvent): void {
  if (!isManagedRoomStreamEvent(event)) {
    return;
  }

  const sessions = listDeliverableCodexSessionsForRoomStreamEvent(event);

  for (const session of sessions) {
    codexEventTurnEngine.enqueueDesktopEventTurn(session, event);
  }
}

export function dispatchRoomStreamEventToManagedAgents(event: DesktopRoomStreamEvent): void {
  desktopManagedAgentRuntimes.dispatchRoomStreamEvent(event);
}

/**
 * Tear a Codex-engine session down after a room stop phrase. The shared event
 * engine drives this through its `disconnectWorker` adapter hook; Codex's
 * teardown is process-oriented (kill the owned app-server, clear the monitor)
 * rather than a cloud disconnect, matching the historical stop-phrase path.
 */
async function disconnectCodexWorkerForStopPhrase(
  worker: StoredAgentSessionState | null,
): Promise<void> {
  endDesktopManagedWorkerSession(worker?.session_id ?? null);
  const live = worker?.session_id
    ? listStoredCodexLiveSessions().find((session) => session.agent_session_id === worker.session_id) ?? null
    : null;
  if (live) {
    killOwnedAppServer(live);
    clearSessionMonitor(live.session_id);
  }
}

/**
 * Codex is ported onto the shared managed-agent event-turn engine. The engine
 * owns the per-session queue, active-turn tracking, and the completed/publish/
 * stop-phrase ladder. Codex keeps everything the engine never learns about:
 * the app-server readiness probe, the JSON-RPC client lifecycle, the wait-for-
 * idle preamble (both inside beforeTurnReadiness), and the context-request /
 * room-tool loop (inside runTurn).
 *
 * Five engine seams keep Codex's behavior byte-for-byte:
 *   - maxConsecutiveTurnErrors: Infinity  -> no error budget, no parking; a
 *     failing turn stays "unknown" and keeps retrying (Phase 3.2 deferred).
 *   - resolveErrorTurnStatus                -> Codex's turn machinery persists a
 *     precise status ("failed" when an owned app-server exits, "unknown" for
 *     malformed/capped/timed-out turns, ...); this preserves it instead of
 *     collapsing everything onto the engine's generic "unknown".
 *   - beforeTurnReadiness                    -> the readiness probe and wait-for-
 *     idle run BEFORE the engine marks the session active and captures the
 *     change baseline, so a previous turn's working-tree changes are never
 *     attributed to the new event and the session never shows active for an
 *     event it has not started.
 *   - resolveStorageAtEnqueue: true          -> the room's storage destination is
 *     snapshotted when the event arrives, so a storage-mode flip while the
 *     event waits behind an active turn cannot reroute the reply.
 *   - stopAfterTurnOnError: true              -> an explicit stop phrase still
 *     tears down the worker when its acknowledgement turn is interrupted or
 *     times out.
 */
const codexEventTurnEngine = createManagedAgentEventTurnEngine<
  DesktopCodexLiveSessionState,
  ManagedAgentEventTurnResult
>({
  now: () => new Date().toISOString(),
  resolveStorage: (roomIdentifier) => resolveLocalAwareRoomStorageMode(roomIdentifier),
  resolveStorageAtEnqueue: true,
  getStoredSession: getStoredCodexLiveSession,
  toPublicSession: toPublicManagedAgentSession,
  updateSession: updateCodexLiveSession,
  emitSessionUpdate: emitManagedAgentSessionUpdate,
  publishReply: publishDesktopManagedAgentReply,
  publishFailure: publishDesktopManagedWorkerFailure,
  beforeTurnReadiness: waitForCodexEventTurnReadiness,
  runTurn: runDesktopEventCodexTurn,
  // Codex persists thread_id/turn_id live inside runTurn (the app-server hands
  // back a new turn id per turn/start), so there is nothing to fold here.
  applyTurnResult: (current) => current,
  // A newer room event never interrupts an in-flight Codex turn: Codex waits
  // for the current turn to go idle instead of preempting it.
  shouldPreemptOnEnqueue: () => false,
  replyChangeSessionKey: codexReplyChangeSessionKey,
  disconnectWorker: disconnectCodexWorkerForStopPhrase,
  onSessionUnavailable: (session) => {
    const worker = getStoredAgentSession(session.agent_session_id);
    if (worker) void pauseDesktopManagedWorkerDelivery(worker, "Provider turn failed; waiting for recovery").catch(() => undefined);
  },
  onSessionResumed: (session) => {
    const worker = getStoredAgentSession(session.agent_session_id);
    if (worker) startDesktopManagedWorkerDeliveryHeartbeat(worker, session.room_identifier);
  },
  maxConsecutiveTurnErrors: Number.POSITIVE_INFINITY,
  // Codex historically honored the stop phrase after a non-throwing timeout
  // or interrupted acknowledgement turn; preserve that explicit stop request.
  stopAfterTurnOnError: true,
  resolveErrorTurnStatus: (session) => ({
    status: session.status,
    lastError: session.last_error ?? null,
  }),
});

function activeWorkForEvent(event: ManagedRoomEvent): NonNullable<DesktopCodexLiveSessionState["active_work"]> {
  return {
    kind: event.type,
    event_id: event.type === "message" ? event.message.id : event.task.id,
    started_at: new Date().toISOString(),
    summary: event.type === "message" ? "Reading the room message." : "Reading the task update.",
  };
}

function markSessionActiveForEvent(
  session: DesktopCodexLiveSessionState,
  event: ManagedRoomEvent,
  turnId: string,
): DesktopCodexLiveSessionState {
  const activeWork = activeWorkForEvent(event);
  const updated = updateCodexLiveSession(session.session_id, (current) => ({
    ...current,
    turn_id: turnId,
    status: "running",
    active_work: activeWork,
    last_error: null,
    updated_at: activeWork.started_at,
  })) ?? {
    ...session,
    turn_id: turnId,
    status: "running",
    active_work: activeWork,
    last_error: null,
    updated_at: activeWork.started_at,
  };
  emitManagedAgentSessionUpdate(updated);
  return updated;
}

function clearSessionActiveWork(
  sessionId: string,
  updater: (session: DesktopCodexLiveSessionState) => DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState | null {
  const updated = updateCodexLiveSession(sessionId, (current) => ({
    ...updater(current),
    active_work: null,
  }));
  emitManagedAgentSessionUpdate(updated);
  return updated;
}

function updateActiveWorkSummary(
  sessionId: string,
  summary: string | null,
): void {
  const trimmed = String(summary ?? "").trim();
  if (!trimmed) {
    return;
  }
  const session = getStoredCodexLiveSession(sessionId);
  if (!session?.active_work) {
    return;
  }
  if (session.active_work.summary === trimmed) {
    return;
  }
  const updated = updateCodexLiveSession(sessionId, (current) => {
    if (!current.active_work) {
      return current;
    }
    if (current.active_work.summary === trimmed) {
      return current;
    }
    return {
      ...current,
      active_work: {
        ...current.active_work,
        summary: trimmed,
      },
      updated_at: new Date().toISOString(),
    };
  });
  emitManagedAgentSessionUpdate(updated);
}

async function publishDesktopManagedAgentReply(input: {
  session: DesktopCodexLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  text: string | null;
  beforeChangeSignature?: string | null;
}): Promise<void> {
  await publishDesktopManagedWorkerReply({
    provider: CODEX_WORKER_PROVIDER,
    sessionToken: input.session.token,
    agentSessionId: input.session.agent_session_id,
    sessionKey: codexReplyChangeSessionKey(input.session.session_id),
    publicSession: () => toPublicManagedAgentSession(bindCodexLiveSessionToWorker(input.session)),
    roomIdentifier: input.session.room_identifier || input.session.room_id,
    storage: input.storage,
    event: input.event,
    text: input.text,
    beforeChangeSignature: input.beforeChangeSignature ?? null,
    onMissingWorkerSession: () => {
      updateCodexLiveSession(input.session.session_id, (current) => ({
        ...current,
        status: "unknown",
        last_error: "Codex produced a room reply before the desktop worker session was available.",
        updated_at: new Date().toISOString(),
      }));
    },
  });
}

async function startDesktopEventCodexTurn(input: {
  client: CodexRpcClient;
  session: DesktopCodexLiveSessionState;
  event: ManagedRoomEvent;
  prompt: string;
}): Promise<{ session: DesktopCodexLiveSessionState; turnId: string }> {
  const turnStart = await input.client.request<TurnStartResult>("turn/start", {
    threadId: input.session.thread_id,
    cwd: input.session.cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: input.prompt, text_elements: [] }],
  });
  const turnId = turnStart.turn?.id;
  if (!turnId) {
    throw new Error("Codex app-server did not return a turn id for room event.");
  }

  return {
    session: markSessionActiveForEvent(input.session, input.event, turnId),
    turnId,
  };
}

async function runDesktopEventTurnWithContext(input: {
  client: CodexRpcClient;
  lifecycle: CodexTurnLifecycleObserver;
  session: DesktopCodexLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  prompt: string;
  allowContextRequests: boolean;
}): Promise<{ session: DesktopCodexLiveSessionState; text: string | null }> {
  let started = await startDesktopEventCodexTurn(input);
  queueCodexRuntimeReasoningSummary(started.session, {
    summary: "Codex worker received a room event.",
    status: "working",
    checking: "Desktop supervisor delivered the room event into Codex.",
    next_action: "Streaming Codex runtime progress for this turn.",
  });

  let replyText = await waitForDesktopEventTurnCompletion(
    input.client,
    input.lifecycle,
    input.session.session_id,
    started.turnId,
  );
  let latest = getStoredCodexLiveSession(input.session.session_id) ?? started.session;
  if (!input.allowContextRequests) {
    return { session: latest, text: replyText };
  }

  let contextRequestCount = 0;
  let roomToolLoopState: ManagedAgentRoomToolLoopState = {
    cache: new Map(),
    requestCount: 0,
  };

  while (true) {
    const contextRequest = parseManagedAgentContextRequest(replyText);
    if (contextRequest) {
      if (contextRequestCount >= DESKTOP_EVENT_CONTEXT_REQUEST_LIMIT) {
        const capped = updateCodexLiveSession(input.session.session_id, (current) => ({
          ...current,
          status: "unknown",
          active_work: null,
          last_error: `Codex requested more than ${DESKTOP_EVENT_CONTEXT_REQUEST_LIMIT} desktop context tools for one room event.`,
          updated_at: new Date().toISOString(),
        })) ?? latest;
        emitManagedAgentSessionUpdate(capped);
        return { session: capped, text: null };
      }
      contextRequestCount += 1;

      queueCodexRuntimeReasoningSummary(latest, {
        summary: `Reading ${contextRequest.tool} context.`,
        status: "working",
        checking: "Desktop context broker is fetching room-scoped context.",
        next_action: "Injecting compact context into Codex.",
      });

      const result = await executeManagedAgentContextRequestWithTimeout(latest, contextRequest);
      const contextPrompt = buildManagedAgentContextResultPrompt(result);
      const readySession = getStoredCodexLiveSession(input.session.session_id) ?? latest;
      started = await startDesktopEventCodexTurn({
        client: input.client,
        session: readySession,
        event: input.event,
        prompt: contextPrompt,
      });
      updateActiveWorkSummary(started.session.session_id, `Reading ${contextRequest.tool} context.`);
      replyText = await waitForDesktopEventTurnCompletion(
        input.client,
        input.lifecycle,
        input.session.session_id,
        started.turnId,
      );
      latest = getStoredCodexLiveSession(input.session.session_id) ?? started.session;
      continue;
    }

    if (hasManagedAgentContextRequestLine(replyText)) {
      const malformed = updateCodexLiveSession(input.session.session_id, (current) => ({
        ...current,
        status: "unknown",
        active_work: null,
        last_error: "Codex emitted a malformed desktop context request.",
        updated_at: new Date().toISOString(),
      })) ?? latest;
      emitManagedAgentSessionUpdate(malformed);
      return { session: malformed, text: null };
    }

    const roomToolLoop = await runManagedAgentRoomToolLoop({
      providerLabel: "Codex",
      session: latest,
      storage: input.storage,
      initialTurn: { text: replyText },
      state: roomToolLoopState,
      getLatestSession: (fallback) =>
        getStoredCodexLiveSession(input.session.session_id) ?? fallback,
      onRoomToolRequest: ({ request, session }) => {
        queueCodexRuntimeReasoningSummary(session, {
          summary: `Running ${request.tool} room tool.`,
          status: "working",
          checking: "Desktop room tool bridge is executing a room-scoped action.",
          next_action: "Injecting the structured room tool result into Codex.",
        });
      },
      runContinuationTurn: async ({ prompt, request, session }) => {
        const readySession = getStoredCodexLiveSession(input.session.session_id) ?? session;
        const roomToolTurn = await startDesktopEventCodexTurn({
          client: input.client,
          session: readySession,
          event: input.event,
          prompt,
        });
        updateActiveWorkSummary(roomToolTurn.session.session_id, `Running ${request.tool} room tool.`);
        const text = await waitForDesktopEventTurnCompletion(
          input.client,
          input.lifecycle,
          input.session.session_id,
          roomToolTurn.turnId,
        );
        return {
          session: getStoredCodexLiveSession(input.session.session_id) ?? roomToolTurn.session,
          turn: { text },
        };
      },
      onLoopError: ({ error, session }) => {
        const failed = updateCodexLiveSession(input.session.session_id, (current) => ({
          ...current,
          status: "unknown",
          active_work: null,
          last_error: error,
          updated_at: new Date().toISOString(),
        })) ?? session;
        emitManagedAgentSessionUpdate(failed);
        return {
          session: failed,
          turn: { text: null },
        };
      },
    });
    roomToolLoopState = roomToolLoop.state;
    replyText = roomToolLoop.turn.text;
    latest = roomToolLoop.session;
    if (roomToolLoop.error) {
      return { session: latest, text: replyText };
    }
    if (roomToolLoop.handledRequests > 0) {
      continue;
    }
    return { session: latest, text: replyText };
  }
}

async function executeManagedAgentContextRequestWithTimeout(
  session: DesktopCodexLiveSessionState,
  request: ManagedAgentContextRequest,
): Promise<ManagedAgentContextResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      executeManagedAgentContextRequest(session, request),
      new Promise<ManagedAgentContextResult>((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            ok: false,
            tool: request.tool,
            roomIdentifier: session.room_identifier || session.room_id,
            storage: null,
            error: "Desktop context tool timed out.",
          });
        }, DESKTOP_EVENT_CONTEXT_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Run one full Codex event turn for the shared engine. Owns the transport that
 * the engine never learns about: the app-server readiness probe, the JSON-RPC
 * client lifecycle, the wait-for-idle preamble, and the context-request / room-
 * tool loop. The engine owns marking the session active, the reply publication,
 * and the final status ladder.
 *
 * The result's `status` is "error" for anything that is not a clean completion
 * so the engine does not overwrite the precise status the turn machinery already
 * persisted; `resolveErrorTurnStatus` then preserves that status.
 */
/**
 * Engine readiness preflight (`beforeTurnReadiness`): the app-server readiness
 * probe plus the wait for the session's current turn to go idle. Runs BEFORE
 * the engine marks the session active for the event and captures the change
 * baseline, preserving the historical ordering:
 *
 *   const idleSession = await waitForCurrentTurnToIdle(client, session.session_id);
 *   if (!idleSession || !canDeliverDesktopEventToSession(idleSession)) return;
 *   const stopAfterTurn = ...; const prompt = ...;
 *   const beforeChangeSignature = await desktopManagedAgentReplyChangeSignature(...);
 *
 * Returning null skips the delivery silently; the engine re-checks
 * deliverability on the returned session (the `canDeliver...` half above).
 */
async function waitForCodexEventTurnReadiness(input: {
  session: DesktopCodexLiveSessionState;
  event: ManagedRoomEvent;
}): Promise<DesktopCodexLiveSessionState | null> {
  const sessionId = input.session.session_id;
  const session = getStoredCodexLiveSession(sessionId) ?? input.session;

  const serverReachable = await isCodexAppServerReady(session.server_url);
  if (!serverReachable) {
    const ownedServerExited = ownedCodexAppServerExited(session);
    const updated = clearSessionActiveWork(session.session_id, (current) => ({
      ...current,
      status: ownedServerExited ? "failed" : "unknown",
      last_error: ownedServerExited
        ? offlineAppServerError(current)
        : "server unreachable while delivering room event",
      updated_at: new Date().toISOString(),
    }));
    if (updated && ownedServerExited) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }
    return null;
  }

  const lifecycle = new CodexTurnLifecycleObserver();
  const client = new CodexRpcClient(session.server_url, (notification) => {
    lifecycle.observe(notification);
    publishCodexRuntimeNotification(session.session_id, notification);
  });
  const removeDisconnectListener = client.onDisconnect(() => lifecycle.notifyDisconnect());
  try {
    await client.connect();
    return await waitForCurrentTurnToIdle(client, lifecycle, session.session_id);
  } finally {
    removeDisconnectListener();
    client.close();
  }
}

async function runDesktopEventCodexTurn(input: {
  active: DesktopCodexLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  abortController: AbortController;
}): Promise<ManagedAgentEventTurnResult> {
  const sessionId = input.active.session_id;
  const session = getStoredCodexLiveSession(sessionId) ?? input.active;

  const lifecycle = new CodexTurnLifecycleObserver();
  const client = new CodexRpcClient(session.server_url, (notification) => {
    lifecycle.observe(notification);
    publishCodexRuntimeNotification(session.session_id, notification);
  });
  const removeDisconnectListener = client.onDisconnect(() => lifecycle.notifyDisconnect());
  // Bridge an engine-driven abort (preempt/stop) onto a Codex turn interrupt.
  // Codex never preempts on enqueue and drives its own stop path, so this only
  // fires if a future caller aborts the engine turn directly.
  const onAbort = (): void => {
    const latest = getStoredCodexLiveSession(sessionId) ?? session;
    void client
      .request("turn/interrupt", { threadId: latest.thread_id, turnId: latest.turn_id })
      .catch(() => {
        // Best effort; the engine owns the resulting status.
      });
  };
  input.abortController.signal.addEventListener("abort", onAbort);
  try {
    await client.connect();
    const stopAfterTurn = isStopPhraseRoomStreamEvent(session, input.event);
    const prompt = buildDesktopEventPrompt(bindCodexLiveSessionToWorker(session), input.event);
    const outcome = await runDesktopEventTurnWithContext({
      client,
      lifecycle,
      session,
      event: input.event,
      storage: input.storage,
      prompt,
      allowContextRequests: !stopAfterTurn,
    });

    const latest = getStoredCodexLiveSession(sessionId) ?? outcome.session;
    const status = latest.status === "completed" ? "completed" : "error";
    return {
      sessionId,
      text: outcome.text,
      status,
      error: status === "error" ? latest.last_error ?? null : null,
    };
  } finally {
    input.abortController.signal.removeEventListener("abort", onAbort);
    removeDisconnectListener();
    client.close();
  }
}

async function waitForCurrentTurnToIdle(
  client: CodexRpcClient,
  lifecycle: CodexTurnLifecycleObserver,
  sessionId: string,
): Promise<DesktopCodexLiveSessionState | null> {
  let tracking: ActiveCodexTurnProgress | null = null;
  try {
    while (true) {
      const session = getStoredCodexLiveSession(sessionId);
      if (!session || !canDeliverDesktopEventToSession(session)) {
        return null;
      }
      if (!tracking || tracking.turnId !== session.turn_id) {
        if (tracking) stopCodexTurnProgress(sessionId, tracking);
        tracking = startCodexTurnProgress(sessionId, session.turn_id);
      }

      let read: ThreadReadResult | null = null;
      try {
        read = await client.request<ThreadReadResult>("thread/read", {
          threadId: session.thread_id,
          includeTurns: true,
        });
      } catch (error) {
        if (isLikelyMaterializingError(error)) {
          const now = Date.now();
          maybePublishCodexWaitingHeartbeat(session, tracking, now);
          const timeoutReason = tracking.tracker.timeoutReason(now);
          if (timeoutReason) {
            updateCodexLiveSession(sessionId, (current) => ({
              ...current,
              status: "unknown",
              active_work: null,
              last_error: codexTurnTimeoutError(
                "previous turn could not be inspected and",
                timeoutReason,
              ),
              updated_at: new Date().toISOString(),
            }));
            return null;
          }
          await sleep(DESKTOP_EVENT_MATERIALIZATION_RETRY_MS);
          continue;
        }
        throw error;
      }

      const turns = read?.thread?.turns ?? [];
      const turn = turns.find((candidate) => candidate.id === session.turn_id);
      const threadStatus = extractThreadStatus(read?.thread);
      const turnStatus = extractTurnStatus(turn);
      const now = Date.now();
      observeCodexTurnSnapshot({ tracking, threadStatus, turnStatus, turn, observedAt: now });
      publishCodexRuntimeSnapshot(session, {
        threadStatus,
        turnStatus,
        recentItems: turn?.items ?? turn?.output,
      });
      if (!isActiveCodexTurnStatus(turnStatus)) {
        return session;
      }

      maybePublishCodexWaitingHeartbeat(session, tracking, now);
      const timeoutReason = tracking.tracker.timeoutReason(now);
      if (timeoutReason) {
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
          active_work: null,
          last_error: codexTurnTimeoutError("previous turn", timeoutReason),
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

      while (true) {
        const signal = await lifecycle.waitForTurn(session.thread_id, session.turn_id);
        if (signal.kind === "disconnect") {
          updateCodexLiveSession(sessionId, (current) => ({
            ...current,
            status: "unknown",
            active_work: null,
            last_error: "Codex app-server disconnected while waiting for the previous turn.",
            updated_at: new Date().toISOString(),
          }));
          return null;
        }
        if (signal.kind !== "activity") {
          break;
        }

        const activeSession = getStoredCodexLiveSession(sessionId) ?? session;
        const observedAt = Date.now();
        maybePublishCodexWaitingHeartbeat(activeSession, tracking, observedAt);
        const activityTimeout = tracking.tracker.timeoutReason(observedAt);
        if (!activityTimeout) {
          continue;
        }
        try {
          await client.request("turn/interrupt", {
            threadId: activeSession.thread_id,
            turnId: activeSession.turn_id,
          });
        } catch {
          // Best effort; the final session state records the timeout.
        }
        updateCodexLiveSession(sessionId, (current) => ({
          ...current,
          status: "unknown",
          active_work: null,
          last_error: codexTurnTimeoutError("previous turn", activityTimeout),
          updated_at: new Date().toISOString(),
        }));
        return null;
      }
      // Terminal notifications and the quiet-period watchdog both reconcile
      // through exactly one authoritative thread read on the next loop pass.
    }
  } finally {
    if (tracking) stopCodexTurnProgress(sessionId, tracking);
  }
}

async function waitForDesktopEventTurnCompletion(
  client: CodexRpcClient,
  lifecycle: CodexTurnLifecycleObserver,
  sessionId: string,
  turnId: string,
): Promise<string | null> {
  const tracking = startCodexTurnProgress(sessionId, turnId);
  try {
    while (true) {
      const session = getStoredCodexLiveSession(sessionId);
      if (!session) {
        return null;
      }

      const signal = await lifecycle.waitForTurn(session.thread_id, turnId);
      if (signal.kind === "disconnect") {
        clearSessionActiveWork(sessionId, (current) => ({
          ...current,
          status: "unknown",
          last_error: "Codex app-server disconnected before the desktop event turn completed.",
          updated_at: new Date().toISOString(),
        }));
        return null;
      }
      if (signal.kind === "activity") {
        const now = Date.now();
        maybePublishCodexWaitingHeartbeat(session, tracking, now);
        const timeoutReason = tracking.tracker.timeoutReason(now);
        if (!timeoutReason) {
          continue;
        }
        try {
          await client.request("turn/interrupt", { threadId: session.thread_id, turnId });
        } catch {
          // Best effort; the final session state records the timeout.
        }
        clearSessionActiveWork(sessionId, (current) => ({
          ...current,
          status: "unknown",
          last_error: codexTurnTimeoutError("desktop-delivered event turn", timeoutReason),
          updated_at: new Date().toISOString(),
        }));
        return null;
      }

      let read: ThreadReadResult | null = null;
      while (!read) {
        try {
          // Final reply and room-tool results live on exact turn items, so this
          // remains a full read: normally once at terminal, or once per 30s
          // quiet watchdog until app-server exposes an exact-turn read API.
          read = await client.request<ThreadReadResult>("thread/read", {
            threadId: session.thread_id,
            includeTurns: true,
          });
        } catch (error) {
          if (!isLikelyMaterializingError(error)) {
            throw error;
          }
          const now = Date.now();
          maybePublishCodexWaitingHeartbeat(session, tracking, now);
          const timeoutReason = tracking.tracker.timeoutReason(now);
          if (!timeoutReason) {
            await sleep(DESKTOP_EVENT_MATERIALIZATION_RETRY_MS);
            continue;
          }
          try {
            await client.request("turn/interrupt", { threadId: session.thread_id, turnId });
          } catch {
            // Best effort; the next inspect pass will reconcile the real state.
          }
          clearSessionActiveWork(sessionId, (current) => ({
            ...current,
            status: "unknown",
            last_error: codexTurnTimeoutError("desktop-delivered event turn", timeoutReason),
            updated_at: new Date().toISOString(),
          }));
          return null;
        }
      }

      const turn = (read?.thread?.turns ?? []).find((candidate) => candidate.id === turnId);
      const threadStatus = extractThreadStatus(read?.thread);
      const turnStatus = extractTurnStatus(turn);
      const now = Date.now();
      observeCodexTurnSnapshot({ tracking, threadStatus, turnStatus, turn, observedAt: now });
      publishCodexRuntimeSnapshot(session, {
        threadStatus,
        turnStatus,
        recentItems: turn?.items ?? turn?.output,
      });

      if (turnStatus && !isActiveCodexTurnStatus(turnStatus)) {
        if (turnStatus === "completed") {
          const completed = updateCodexLiveSession(sessionId, statusAfterDesktopEventCompletedTurn);
          emitManagedAgentSessionUpdate(completed);
          return finalPublicAgentMessageText(turn?.items ?? turn?.output);
        }

        clearSessionActiveWork(sessionId, (current) => ({
          ...current,
          status: turnStatus === "interrupted"
            ? codexSessionStatusAfterTurnInterrupt(managedAgentDeliveryMode(current), true, false)
            : "failed",
          last_error: turnStatus === "interrupted" ? null : `event turn ended with ${turnStatus}`,
          updated_at: new Date().toISOString(),
        }));
        return null;
      }

      maybePublishCodexWaitingHeartbeat(session, tracking, now);
      const timeoutReason = tracking.tracker.timeoutReason(now);
      if (!timeoutReason) {
        continue;
      }
      try {
        await client.request("turn/interrupt", {
          threadId: session.thread_id,
          turnId,
        });
      } catch {
        // Best effort; the next inspect pass will reconcile the real state.
      }
      clearSessionActiveWork(sessionId, (current) => ({
        ...current,
        status: "unknown",
        last_error: codexTurnTimeoutError("desktop-delivered event turn", timeoutReason),
        updated_at: new Date().toISOString(),
      }));
      return null;
    }
  } finally {
    stopCodexTurnProgress(sessionId, tracking);
  }
}

async function stopDesktopManagedCodexAgent(
  input: DesktopManagedAgentStopInput = {},
): Promise<DesktopManagedAgentSession | null> {
  const session = findStoredSession(input.sessionId, input.roomIdentifier);
  if (!session) {
    return null;
  }

  if (isSmokeManagedCodexSession(session)) {
    if (shouldShutdownManagedAgentOnStop(input)) {
      const updated =
        updateCodexLiveSession(session.session_id, (current) => ({
          ...current,
          status: "interrupted",
          active_work: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })) ?? session;
      emitManagedAgentSessionUpdate(updated);
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
      return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
    }
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "running",
        active_work: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })) ?? session;
    emitManagedAgentSessionUpdate(updated);
    return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
  }

  const shutdownServer = shouldShutdownManagedAgentOnStop(input);
  if (shutdownServer) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "interrupted",
        active_work: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })) ?? session;
    emitManagedAgentSessionUpdate(updated);
    killOwnedAppServer(updated);
    clearSessionMonitor(updated.session_id);
    return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
  }

  const serverReachable = await isCodexAppServerReady(session.server_url);
  let interruptError: string | null = null;
  let interruptSucceeded = false;
  if (serverReachable) {
    const latest = getStoredCodexLiveSession(session.session_id) ?? session;
    try {
      const client = new CodexRpcClient(session.server_url);
      await client.connect();
      try {
        try {
          const read = await client.request<ThreadReadResult>("thread/read", {
            threadId: latest.thread_id,
            includeTurns: true,
          });
          const turns = read?.thread?.turns ?? [];
          const turn = turns.find((candidate) => candidate.id === latest.turn_id);
          const threadStatus = extractThreadStatus(read?.thread);
          const turnStatus = extractTurnStatus(turn);
          publishCodexRuntimeSnapshot(latest, {
            threadStatus,
            turnStatus,
            recentItems: turn?.items ?? turn?.output,
          });
          if (!isActiveCodexTurnStatus(turnStatus)) {
            const updated = updateCodexLiveSession(latest.session_id, statusAfterNoActiveTurnToStop) ?? latest;
            emitManagedAgentSessionUpdate(updated);
            scheduleOwnedSessionMonitor(updated);
            return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
          }
        } catch (error) {
          if (!isLikelyMaterializingError(error)) {
            throw error;
          }
        }
        await client.request("turn/interrupt", {
          threadId: latest.thread_id,
          turnId: latest.turn_id,
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

  const ownedServerExited = !serverReachable && ownedCodexAppServerExited(session);
  const updated =
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      status: ownedServerExited
        ? "failed"
        : codexSessionStatusAfterStopAttempt(
          managedAgentDeliveryMode(current),
          serverReachable,
          shutdownServer,
          interruptSucceeded,
        ),
      active_work: null,
      last_error: serverReachable
        ? interruptError
        : offlineAppServerError(current),
      updated_at: new Date().toISOString(),
    })) ?? session;
  emitManagedAgentSessionUpdate(updated);

  if (shutdownServer || ownedServerExited) {
    killOwnedAppServer(updated);
  }
  const keepMonitoring = updated.status === "running" ||
    (managedAgentDeliveryMode(updated) === "desktop_events" && updated.status === "completed");
  if (!keepMonitoring) {
    clearSessionMonitor(updated.session_id);
  } else {
    scheduleOwnedSessionMonitor(updated);
  }

  return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
}

export async function stopDesktopManagedAgent(
  input: DesktopManagedAgentStopInput = {},
): Promise<DesktopManagedAgentSession | null> {
  const owned = input.sessionId
    ? listDesktopManagedAgentSessions().find((session) => session.id === input.sessionId)
    : null;
  if (owned?.supervisorEntryId) {
    throw new Error("This agent is daemon-supervised. Change its desired state instead of using legacy stop controls.");
  }
  const stopped = await desktopManagedAgentRuntimes.stop(input);
  if (stopped && (input.stopMode === "worker" || input.shutdownServer === true)
    && (process.platform === "darwin" || process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON === "1")) {
    const { supervisorDaemonClient } = await import("../supervisor-daemon.js");
    await supervisorDaemonClient.releaseLegacyLane({
      sessionId: stopped.id,
      roomIdentifier: stopped.roomIdentifier,
      provider: stopped.providerId,
    });
  }
  return stopped;
}

export async function stopDaemonOwnedManagedAgent(sessionId: string): Promise<DesktopManagedAgentSession | null> {
  const owned = listDesktopManagedAgentSessions().find((session) => session.id === sessionId);
  if (!owned?.supervisorEntryId) throw new Error("Daemon stop bridge requires a supervised session.");
  const stopped = await desktopManagedAgentRuntimes.stop({ sessionId, stopMode: "worker" });
  rehydratedDaemonSessionIds.delete(sessionId);
  return stopped;
}

async function retryDesktopManagedCodexAgent(
  input: { sessionId: string },
): Promise<DesktopManagedAgentSession | null> {
  const resumed = codexEventTurnEngine.retryBlockedSession(input.sessionId);
  return resumed ? toPublicManagedAgentSession(resumed) : null;
}

export function retryDesktopManagedAgent(
  input: { sessionId: string },
): Promise<DesktopManagedAgentSession | null> {
  const owned = listDesktopManagedAgentSessions().find((session) => session.id === input.sessionId);
  if (owned?.supervisorEntryId) {
    throw new Error("This agent is daemon-supervised. Recovery is owned by the supervisor reconciler.");
  }
  return desktopManagedAgentRuntimes.retry(input);
}

export function resolveDesktopManagedAgentPermissionRequest(
  input: DesktopManagedAgentPermissionDecisionInput,
): Promise<DesktopManagedAgentPermissionDecisionResult> {
  return desktopManagedAgentRuntimes.resolvePermissionRequest(input);
}
