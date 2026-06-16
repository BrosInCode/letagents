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
import { apiFetch, readStoredAuth } from "../auth.js";
import { isDesktopSmokeCheck } from "../smoke.js";
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
  shouldDeliverRoomStreamEventToSession,
} from "./codex-event-routing.js";
import {
  buildDesktopEventPrompt,
  DESKTOP_EVENTS_NO_ROOM_REPLY,
} from "./codex-event-prompt.js";
import {
  CodexRpcClient,
  type RpcNotification,
  type ThreadReadResult,
  type ThreadStartResult,
  type TurnStartResult,
} from "./codex-rpc-client.js";
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
  shouldShutdownManagedAgentOnStop,
  sleep,
  STARTUP_POLL_INTERVAL_MS,
  summarizeItems,
} from "./codex-session-status.js";
import { runDesktopAgentProviderPreflight } from "./providers.js";
import {
  bindCodexLiveSessionToWorker,
  getCurrentCodexLiveSession,
  getOrCreateDesktopHostId,
  getStoredAgentIdentity,
  getStoredAgentIdentityForRuntimeKey,
  getStoredAgentSession,
  getStoredCodexLiveSession,
  listCodexDisplayNamesForRoom,
  listDesktopManagedCodexLiveSessions,
  listStoredCodexLiveSessions,
  markAgentSessionEnded,
  managedAgentDeliveryMode,
  saveAgentSession,
  saveCodexLiveSession,
  saveStoredAgentIdentity,
  toPublicManagedAgentSession,
  updateCodexLiveSession,
  type DesktopCodexJoinedVia,
  type DesktopCodexLiveSessionState,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
} from "./state.js";

const SESSION_MONITOR_INTERVAL_MS = 30_000;
const DESKTOP_EVENT_TURN_POLL_INTERVAL_MS = 1_000;
const DESKTOP_EVENT_TURN_TIMEOUT_MS = 5 * 60_000;
const CODEX_RUNTIME_REASONING_THROTTLE_MS = 750;
const CODEX_RUNTIME_REASONING_REPEAT_MS = 30_000;

const spawnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();
const desktopEventQueues = new Map<string, Promise<void>>();
const codexRuntimeReasoningLastPost = new Map<string, { signature: string; postedAt: number }>();
const codexRuntimeReasoningPostQueues = new Map<string, Promise<void>>();
let cleanupRegistered = false;
const CODEX_WORKER_REGISTRATION_ERROR =
  "Codex did not get a LetAgents room worker identity. Sign into LetAgents Desktop, then try starting the agent again.";

type AgentIdentityCreateResponse = {
  name?: string;
  display_name?: string;
  owner_label?: string;
  canonical_key?: string;
};

type AgentSessionCreateResponse = {
  session_id?: string;
  session_token?: string;
  room_id?: string;
  session_kind?: string;
  runtime?: string;
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
  actor_label?: string | null;
  agent_key?: string | null;
  agent_instance_id?: string | null;
  display_name?: string | null;
  owner_label?: string | null;
  ide_label?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  ended_at?: string | null;
};

type ReasoningSessionCreateResponse = {
  session?: { id?: string };
};

function normalizeAgentIdentityName(displayName: string): string {
  const normalized = displayName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "desktop-codex";
}

function normalizeDisplayText(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

function formatOwnerAttribution(ownerLabel: string): string {
  const normalized = normalizeDisplayText(ownerLabel, "Owner");
  return /s$/i.test(normalized) ? `${normalized}' agent` : `${normalized}'s agent`;
}

function buildAgentActorLabel(input: {
  displayName: string;
  ownerLabel: string;
  ideLabel: string;
}): string {
  return [
    normalizeDisplayText(input.displayName, "Agent"),
    formatOwnerAttribution(input.ownerLabel),
    normalizeDisplayText(input.ideLabel, "Agent"),
  ].join(" | ");
}

function isUsableAgentIdentity(identity: StoredAgentIdentityState | null): identity is StoredAgentIdentityState {
  return Boolean(identity?.canonical_key?.trim());
}

async function ensureDesktopManagedCodexIdentity(displayName: string): Promise<StoredAgentIdentityState> {
  const requestedName = normalizeAgentIdentityName(displayName);
  const requestedDisplayName = normalizeDisplayText(displayName, "Codex");
  const runtimeKey = `desktop-codex:${requestedName}`;
  const existingForName = getStoredAgentIdentityForRuntimeKey(runtimeKey);
  if (isUsableAgentIdentity(existingForName)) {
    return existingForName;
  }

  const existing = getStoredAgentIdentity();
  if (
    isUsableAgentIdentity(existing) &&
    normalizeAgentIdentityName(existing.display_name) === requestedName
  ) {
    return existing;
  }

  const storedAuth = await readStoredAuth();
  if (!storedAuth.token) {
    throw new Error("Sign into LetAgents Desktop before starting a supervised Codex agent.");
  }

  const ownerLabel = normalizeDisplayText(
    storedAuth.account?.displayName || storedAuth.account?.login,
    "Desktop",
  );
  const registered = await apiFetch<AgentIdentityCreateResponse>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: requestedName,
      display_name: requestedDisplayName,
      owner_label: ownerLabel,
    }),
  });
  const canonicalKey = normalizeDisplayText(registered.canonical_key, "");
  if (!canonicalKey) {
    throw new Error("LetAgents did not return a usable agent identity for the desktop worker.");
  }

  const resolvedDisplayName = normalizeDisplayText(registered.display_name, requestedDisplayName);
  const resolvedOwnerLabel = normalizeDisplayText(registered.owner_label, ownerLabel);
  const now = new Date().toISOString();
  return saveStoredAgentIdentity({
    name: normalizeDisplayText(registered.name, requestedName),
    display_name: resolvedDisplayName,
    owner_label: resolvedOwnerLabel,
    owner_attribution: formatOwnerAttribution(resolvedOwnerLabel),
    ide_label: "Codex",
    actor_label: buildAgentActorLabel({
      displayName: resolvedDisplayName,
      ownerLabel: resolvedOwnerLabel,
      ideLabel: "Codex",
    }),
    canonical_key: canonicalKey,
    runtime_key: runtimeKey,
    source: "api",
    resolved_at: now,
  });
}

function codexSessionLivenessRegistration(runtime: string, token: string): Record<string, string | null> {
  const hostId = getOrCreateDesktopHostId();
  return {
    host_id: hostId,
    host_kind: process.platform === "darwin" ? "macos" : process.platform,
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_codex_app_server",
    tool_bridge_id: `${hostId}:${runtime}:desktop:${token}`,
  };
}

function toStoredAgentSession(
  created: AgentSessionCreateResponse,
  input: {
    roomIdentifier: string;
    runtime: string;
    identity: StoredAgentIdentityState;
    agentInstanceId: string;
    displayName: string;
  },
): StoredAgentSessionState {
  const sessionId = normalizeDisplayText(created.session_id, "");
  const sessionToken = normalizeDisplayText(created.session_token, "");
  if (!sessionId || !sessionToken) {
    throw new Error("Agent session registration response was missing session credentials.");
  }

  const createdAt = normalizeDisplayText(created.created_at, new Date().toISOString());
  const updatedAt = normalizeDisplayText(created.updated_at, createdAt);
  return {
    session_id: sessionId,
    session_token: sessionToken,
    room_id: normalizeDisplayText(created.room_id, input.roomIdentifier),
    session_kind: created.session_kind === "controller" ? "controller" : "worker",
    runtime: normalizeDisplayText(created.runtime, input.runtime),
    host_id: created.host_id ?? null,
    host_kind: created.host_kind ?? null,
    host_label: created.host_label ?? null,
    liveness_capability: created.liveness_capability ?? null,
    tool_bridge_id: created.tool_bridge_id ?? null,
    actor_label: normalizeDisplayText(
      created.actor_label,
      buildAgentActorLabel({
        displayName: input.displayName,
        ownerLabel: input.identity.owner_label,
        ideLabel: "Codex",
      }),
    ),
    agent_key: normalizeDisplayText(created.agent_key, input.identity.canonical_key ?? ""),
    agent_instance_id: normalizeDisplayText(created.agent_instance_id, input.agentInstanceId),
    display_name: normalizeDisplayText(created.display_name, input.displayName),
    owner_label: normalizeDisplayText(created.owner_label, input.identity.owner_label),
    ide_label: normalizeDisplayText(created.ide_label, "Codex"),
    created_at: createdAt,
    updated_at: updatedAt,
    last_seen_at: normalizeDisplayText(created.last_seen_at, updatedAt),
    ended_at: created.ended_at ?? null,
  };
}

async function registerDesktopManagedCodexWorker(input: {
  roomIdentifier: string;
  displayName: string;
  token: string;
}): Promise<StoredAgentSessionState> {
  const identity = await ensureDesktopManagedCodexIdentity(input.displayName);
  const actorKey = normalizeDisplayText(identity.canonical_key, "");
  if (!actorKey) {
    throw new Error("LetAgents desktop agent identity is missing an actor key.");
  }

  const runtime = `codex:${input.token}`;
  const agentInstanceId = `desktop-codex:${input.token}`;
  const created = await apiFetch<AgentSessionCreateResponse>(
    `/rooms/${encodeURIComponent(input.roomIdentifier)}/agent-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor_key: actorKey,
        actor_label: identity.actor_label,
        ide_label: "Codex",
        agent_instance_id: agentInstanceId,
        display_name: input.displayName,
        session_kind: "worker",
        runtime,
        registration_liveness: codexSessionLivenessRegistration(runtime, input.token),
      }),
    },
  );

  return saveAgentSession(toStoredAgentSession(created, {
    roomIdentifier: input.roomIdentifier,
    runtime,
    identity,
    agentInstanceId,
    displayName: input.displayName,
  }));
}

async function disconnectDesktopManagedCodexWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  if (!session?.session_id || !session.session_token) {
    return;
  }

  try {
    await apiFetch<Record<string, unknown>>(
      `/rooms/${encodeURIComponent(session.room_id)}/agent-sessions/${encodeURIComponent(session.session_id)}/disconnect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_session_id: session.session_id,
          agent_session_token: session.session_token,
        }),
      },
    );
  } catch {
    // Local cleanup still matters; the next room snapshot will reconcile any server-side state.
  } finally {
    markAgentSessionEnded(session.session_id);
  }
}

function reasoningRoomPath(session: DesktopCodexLiveSessionState): string {
  return `/rooms/${encodeURIComponent(session.room_identifier || session.room_id)}/reasoning-sessions`;
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

  const roomPath = reasoningRoomPath(session);
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
}

function markSpawnedCodexAppServersOffline(reason: string): void {
  const pids = new Set(spawnedServerPids);
  for (const session of listStoredCodexLiveSessions()) {
    if (!session.launched_server || !session.server_pid || !pids.has(session.server_pid)) {
      continue;
    }
    if (!isTerminalCodexSessionStatus(session.status)) {
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "failed",
        last_error: reason,
        updated_at: new Date().toISOString(),
      }));
    }
    markAgentSessionEnded(session.agent_session_id);
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
      terminateSpawnedProcess(pid);
    }
    spawnedServerPids.clear();
    codexRuntimeReasoningLastPost.clear();
    codexRuntimeReasoningPostQueues.clear();
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
  markAgentSessionEnded(session.agent_session_id);
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
      last_error: null,
      updated_at: new Date().toISOString(),
    };
  }
  if (session.status === "starting") {
    return {
      ...session,
      status: "starting",
      last_error: null,
      updated_at: new Date().toISOString(),
    };
  }
  return {
    ...session,
    status: "unknown",
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
    const inspected = await inspectDesktopManagedAgentSession(session.session_id);
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

export function listDesktopManagedAgentSessions(
  roomIdentifier?: string | null,
): DesktopManagedAgentSession[] {
  return listDesktopManagedCodexLiveSessions(roomIdentifier)
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
  const codexBin = process.env.LETAGENTS_CODEX_BIN || "codex";
  const preflight = await runDesktopAgentProviderPreflight("codex", {
    roomIdentifier,
    repoRootPath: cwd,
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
  const registeredWorker = deliveryMode === "desktop_events"
    ? await registerDesktopManagedCodexWorker({
      roomIdentifier,
      displayName: suggestedDisplayName,
      token,
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
      });
      serverPid = launch.pid;
      if (serverPid) {
        registerLaunchedAppServer(serverPid);
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
      joined_via: joinedVia,
      cwd,
      stop_phrase: stopPhrase,
      max_minutes: maxMinutes,
      delivery_mode: deliveryMode,
      desktop_managed: true,
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
      summary: "Codex worker is starting and joining the room.",
      status: "working",
      checking: "Desktop supervisor started a Codex app-server turn.",
      next_action: "Waiting for Codex to publish room progress.",
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
    if (!startupSucceeded && registeredWorker) {
      await disconnectDesktopManagedCodexWorker(registeredWorker);
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
    if (ownedServerExited || updated.launched_server) {
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

export function dispatchRoomStreamEventToManagedAgents(event: DesktopRoomStreamEvent): void {
  if (event.type !== "message" && event.type !== "task_update") {
    return;
  }

  const sessions = listDesktopManagedCodexLiveSessions(event.roomIdentifier)
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

function publicReplyText(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === DESKTOP_EVENTS_NO_ROOM_REPLY) {
    return null;
  }
  return trimmed;
}

function replyTargetForEvent(
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): string | null {
  if (event.type !== "message") {
    return null;
  }
  return event.message.replyTo?.id ?? null;
}

async function publishDesktopManagedAgentReply(input: {
  session: DesktopCodexLiveSessionState;
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;
  text: string | null;
}): Promise<void> {
  const text = publicReplyText(input.text);
  if (!text) {
    return;
  }

  const workerSession = getStoredAgentSession(input.session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) {
    updateCodexLiveSession(input.session.session_id, (current) => ({
      ...current,
      status: "unknown",
      last_error: "Codex produced a room reply before the desktop worker session was available.",
      updated_at: new Date().toISOString(),
    }));
    return;
  }

  await apiFetch<Record<string, unknown>>(
    `/rooms/${encodeURIComponent(input.session.room_identifier || input.session.room_id)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        text,
        reply_to: replyTargetForEvent(input.event),
        agent_session_id: workerSession.session_id,
        agent_session_token: workerSession.session_token,
      }),
    },
  );
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
    const ownedServerExited = ownedCodexAppServerExited(session);
    const updated = updateCodexLiveSession(session.session_id, (current) => ({
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
    return;
  }

  const client = new CodexRpcClient(session.server_url, (notification) => {
    publishCodexRuntimeNotification(session.session_id, notification);
  });
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

    const activeSession = updateCodexLiveSession(idleSession.session_id, (current) => ({
      ...current,
      turn_id: turnId,
      status: "running",
      last_error: null,
      updated_at: new Date().toISOString(),
    })) ?? {
      ...idleSession,
      turn_id: turnId,
      status: "running",
      last_error: null,
      updated_at: new Date().toISOString(),
    };
    queueCodexRuntimeReasoningSummary(activeSession, {
      summary: "Codex worker received a room event.",
      status: "working",
      checking: "Desktop supervisor delivered the room event into Codex.",
      next_action: "Streaming Codex runtime progress for this turn.",
    });
    const replyText = await waitForDesktopEventTurnCompletion(client, idleSession.session_id, turnId);
    const latest = getStoredCodexLiveSession(idleSession.session_id) ?? idleSession;
    await publishDesktopManagedAgentReply({
      session: latest,
      event,
      text: replyText,
    });
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
    const threadStatus = extractThreadStatus(read?.thread);
    const turnStatus = extractTurnStatus(turn);
    publishCodexRuntimeSnapshot(session, {
      threadStatus,
      turnStatus,
      recentItems: turn?.items ?? turn?.output,
    });
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
): Promise<string | null> {
  const deadline = Date.now() + DESKTOP_EVENT_TURN_TIMEOUT_MS;
  while (true) {
    await sleep(DESKTOP_EVENT_TURN_POLL_INTERVAL_MS);
    const session = getStoredCodexLiveSession(sessionId);
    if (!session) {
      return null;
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
        continue;
      }
      throw error;
    }

    const turn = (read?.thread?.turns ?? []).find((candidate) => candidate.id === turnId);
    const threadStatus = extractThreadStatus(read?.thread);
    const turnStatus = extractTurnStatus(turn);
    publishCodexRuntimeSnapshot(session, {
      threadStatus,
      turnStatus,
      recentItems: turn?.items ?? turn?.output,
    });
    if (!turnStatus || isActiveCodexTurnStatus(turnStatus)) {
      continue;
    }

    if (turnStatus === "completed") {
      updateCodexLiveSession(sessionId, statusAfterDesktopEventCompletedTurn);
      return finalPublicAgentMessageText(turn?.items ?? turn?.output);
    }

    updateCodexLiveSession(sessionId, (current) => ({
      ...current,
      status: turnStatus === "interrupted"
        ? codexSessionStatusAfterTurnInterrupt(managedAgentDeliveryMode(current), true, false)
        : "failed",
      last_error: turnStatus === "interrupted" ? null : `event turn ended with ${turnStatus}`,
      updated_at: new Date().toISOString(),
    }));
    return null;
  }
}

export async function stopDesktopManagedAgent(
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
          last_error: null,
          updated_at: new Date().toISOString(),
        })) ?? session;
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
      return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
    }
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "running",
        last_error: null,
        updated_at: new Date().toISOString(),
    })) ?? session;
    return toPublicManagedAgentSession(bindCodexLiveSessionToWorker(updated));
  }

  const shutdownServer = shouldShutdownManagedAgentOnStop(input);
  if (shutdownServer) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "interrupted",
        last_error: null,
        updated_at: new Date().toISOString(),
      })) ?? session;
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
      last_error: serverReachable
        ? interruptError
        : offlineAppServerError(current),
      updated_at: new Date().toISOString(),
    })) ?? session;

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
