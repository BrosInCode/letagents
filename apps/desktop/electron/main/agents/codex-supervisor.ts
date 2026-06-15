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
  type ThreadReadResult,
  type ThreadStartResult,
  type TurnStartResult,
} from "./codex-rpc-client.js";
import { DEFAULT_CODEX_DELIVERY_MODE } from "./defaults.js";
import {
  deriveCodexLiveSessionStatus,
  extractThreadStatus,
  extractTurnStatus,
  codexSessionStatusAfterInspectFailure,
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

const spawnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();
const desktopEventQueues = new Map<string, Promise<void>>();
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
  const existing = getStoredAgentIdentity();
  if (isUsableAgentIdentity(existing)) {
    return existing;
  }

  const storedAuth = await readStoredAuth();
  if (!storedAuth.token) {
    throw new Error("Sign into LetAgents Desktop before starting a supervised Codex agent.");
  }

  const name = normalizeAgentIdentityName(displayName);
  const ownerLabel = normalizeDisplayText(
    storedAuth.account?.displayName || storedAuth.account?.login,
    "Desktop",
  );
  const registered = await apiFetch<AgentIdentityCreateResponse>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      display_name: displayName,
      owner_label: ownerLabel,
    }),
  });
  const canonicalKey = normalizeDisplayText(registered.canonical_key, "");
  if (!canonicalKey) {
    throw new Error("LetAgents did not return a usable agent identity for the desktop worker.");
  }

  const resolvedDisplayName = normalizeDisplayText(registered.display_name, displayName);
  const resolvedOwnerLabel = normalizeDisplayText(registered.owner_label, ownerLabel);
  const now = new Date().toISOString();
  return saveStoredAgentIdentity({
    name: normalizeDisplayText(registered.name, name),
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
    runtime_key: "desktop-codex",
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
      status: "running",
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
      updateCodexLiveSession(session.session_id, (current) =>
        managedAgentDeliveryMode(current) === "desktop_events" && turnStatus === "completed"
          ? statusAfterDesktopEventCompletedTurn(current)
          : {
            ...current,
            status: deriveCodexLiveSessionStatus(current.status, true, threadStatus, turnStatus),
            last_error: null,
            updated_at: new Date().toISOString(),
          }
      ) ?? session;

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
