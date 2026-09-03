import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopManagedAgentFailure,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import { buildRepoStatus } from "../../repo-status.js";
import { looksLikeInviteCode } from "./codex-start-prompt.js";
import {
  canDeliverCodexStopControlToManagedAgent,
  isOwnRoomStreamEventForManagedAgentAmongWorkers,
  isStopPhraseRoomStreamEvent,
  resolveDesktopRoomStreamEventRecipients,
} from "./codex-event-routing.js";
import {
  isManagedRoomStreamEvent,
  type ManagedRoomEvent,
} from "./codex-managed-agent-dispatch.js";
import {
  buildCursorDesktopEventPrompt,
  buildCursorRoomToolFormattingCorrectionPrompt,
} from "./cursor-event-prompt.js";
import { normalizeCursorMcpPolicy, prepareCursorManagedProfile } from "./cursor-managed-profile.js";
import {
  cursorLaunchOptionsForPermissionProfile,
  cursorPermissionProfileStartMessage,
} from "./cursor-permission-profile.js";
import {
  productionCursorRunner,
  type CursorRunner,
  type CursorTurnResult,
} from "./cursor-runner.js";
import {
  assertManagedAgentPermissionProfileAvailable,
} from "./managed-agent-permission-profiles.js";
import { normalizeManagedAgentModel } from "./managed-agent-models.js";
import { suggestLetAgentsCodename } from "./codenames.js";
import type {
  DesktopManagedAgentDispatchContext,
  DesktopManagedAgentRuntime,
} from "./managed-agent-runtime.js";
import {
  runManagedAgentRoomToolLoop,
} from "./managed-agent-room-tool-loop.js";
import {
  hasManagedAgentRoomToolRequestLine,
  parseManagedAgentRoomToolRequest,
} from "./managed-agent-room-tools-protocol.js";
import { cleanupAgentSessionAttachments } from "./managed-agent-attachments.js";
import { createManagedAgentEventTurnEngine } from "./managed-agent-event-turn-engine.js";
import {
  clearDesktopManagedAgentReplyChangeState,
} from "./managed-agent-reply-changes.js";
import {
  disconnectDesktopManagedWorker,
  pauseDesktopManagedWorkerDelivery,
  publishDesktopManagedWorkerFailure,
  publishDesktopManagedWorkerReply,
  registerDesktopManagedWorker,
  startDesktopManagedWorkerDeliveryHeartbeat,
  type ManagedAgentWorkerProvider,
} from "./managed-agent-worker.js";
import {
  getCurrentCursorLiveSession,
  getStoredAgentSession,
  getStoredCursorLiveSession,
  listCursorDisplayNamesForRoom,
  listDesktopManagedCursorLiveSessions,
  saveCursorLiveSession,
  toPublicCursorManagedAgentSession,
  updateCursorLiveSession,
  type DesktopCursorJoinedVia,
  type DesktopCursorLiveSessionState,
  type StoredAgentSessionState,
} from "./state.js";

const DEFAULT_CURSOR_STOP_PHRASE = "/stop-cursor-room";

function cursorReplyChangeSessionKey(sessionId: string): string {
  return `cursor:${sessionId}`;
}

const CURSOR_WORKER_PROVIDER: ManagedAgentWorkerProvider = {
  ideLabel: "Cursor",
  runtimePrefix: "cursor",
  instancePrefix: "desktop-cursor",
  livenessCapability: "desktop_supervised_cursor_readonly",
  identityNameFallback: "desktop-cursor",
  signInErrorMessage: "Sign into LetAgents Desktop before starting a supervised Cursor agent.",
  unusableIdentityErrorMessage: "LetAgents did not return a usable agent identity for the desktop Cursor worker.",
  missingActorKeyErrorMessage: "LetAgents desktop Cursor identity is missing an actor key.",
  replyWarnLabel: "Cursor",
};

interface RegisterCursorWorkerInput {
  roomIdentifier: string;
  displayName: string;
  token: string;
  repoBranch: string | null;
}

interface PublishCursorReplyInput {
  session: DesktopCursorLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  text: string | null;
  beforeChangeSignature?: string | null;
}

interface PublishCursorFailureInput {
  session: DesktopCursorLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  failure: DesktopManagedAgentFailure;
}

interface CursorRuntimeDependencies {
  runner?: CursorRunner;
  preflight?: (
    providerId: DesktopAgentProviderId,
    input?: DesktopAgentProviderPreflightInput,
  ) => Promise<DesktopAgentProviderPreflight>;
  registerWorker?: (input: RegisterCursorWorkerInput) => Promise<StoredAgentSessionState>;
  disconnectWorker?: (session: StoredAgentSessionState | null) => Promise<void>;
  publishReply?: (input: PublishCursorReplyInput) => Promise<void>;
  publishFailure?: (input: PublishCursorFailureInput) => Promise<void>;
  resolveStorage?: (roomIdentifier: string) => Promise<DesktopRoomStorageState>;
  emitSessionUpdate?: (session: DesktopCursorLiveSessionState | null | undefined) => void;
  now?: () => string;
}

export type DesktopCursorRuntime = DesktopManagedAgentRuntime & {
  waitForIdle(): Promise<void>;
};

function cursorRoomToolErrorResult(
  sessionId: string | null,
  recentItems: Array<Record<string, unknown>>,
  error: string,
): CursorTurnResult {
  return {
    sessionId,
    text: null,
    status: "error",
    error,
    recentItems,
  };
}

export function createDesktopCursorRuntime(
  dependencies: CursorRuntimeDependencies = {},
): DesktopCursorRuntime {
  const runner = dependencies.runner ?? productionCursorRunner;
  const preflight = dependencies.preflight ?? runCursorProviderPreflight;
  const registerWorker = dependencies.registerWorker ?? registerDesktopManagedCursorWorker;
  const disconnectWorker = dependencies.disconnectWorker ?? disconnectDesktopManagedCursorWorker;
  const publishReply = dependencies.publishReply ?? publishDesktopManagedCursorReply;
  const publishFailure = dependencies.publishFailure ?? publishDesktopManagedWorkerFailure;
  const resolveStorage = dependencies.resolveStorage ?? resolveRoomStorageMode;
  const emitSessionUpdate = dependencies.emitSessionUpdate ?? emitCursorManagedAgentSessionUpdate;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const engine = createManagedAgentEventTurnEngine<DesktopCursorLiveSessionState, CursorTurnResult>({
    now,
    resolveStorage: (roomIdentifier) => resolveStorage(roomIdentifier),
    getStoredSession: getStoredCursorLiveSession,
    toPublicSession: toPublicCursorManagedAgentSession,
    updateSession: updateCursorLiveSession,
    emitSessionUpdate: (session) => emitSessionUpdate(session),
    publishReply: (input) => publishReply(input),
    publishFailure: (input) => publishFailure(input),
    runTurn: (input) =>
      runCursorDesktopEventTurnWithRoomTools({
        active: input.active,
        event: input.event,
        storage: input.storage,
        abortController: input.abortController,
      }),
    applyTurnResult: (current, result) => ({
      ...current,
      cursor_session_id: result.sessionId ?? current.cursor_session_id ?? null,
      recent_items: result.recentItems,
    }),
    // Force-mode turns write to the working tree; never interrupt them for a
    // newer room event.
    shouldPreemptOnEnqueue: (session) =>
      !cursorLaunchOptionsForPermissionProfile(session.permission_profile_id).force,
    replyChangeSessionKey: cursorReplyChangeSessionKey,
    disconnectWorker: (session) => disconnectWorker(session),
    onSessionUnavailable: (session) => {
      const worker = getStoredAgentSession(session.agent_session_id);
      if (worker) void pauseDesktopManagedWorkerDelivery(worker, "Provider turn failed; waiting for recovery").catch(() => undefined);
    },
    onSessionResumed: (session) => {
      const worker = getStoredAgentSession(session.agent_session_id);
      if (worker) startDesktopManagedWorkerDeliveryHeartbeat(worker, session.room_identifier);
    },
  });

  function listSessions(roomIdentifier?: string | null): DesktopManagedAgentSession[] {
    return listDesktopManagedCursorLiveSessions(roomIdentifier)
      .map(toPublicCursorManagedAgentSession);
  }

  async function start(input: DesktopManagedAgentStartInput): Promise<DesktopManagedAgentStartResult> {
    if (input.providerId !== "cursor") {
      throw new Error(`Cursor runtime cannot start provider '${input.providerId}'.`);
    }
    if (input.deliveryMode && input.deliveryMode !== "desktop_events") {
      throw new Error("Cursor managed runtime currently supports desktop-delivered room events only.");
    }

    const roomIdentifier = normalizeRoomIdentifier(input.roomIdentifier);
    const repoRootPath = input.repoRootPath?.trim();
    if (!repoRootPath) {
      throw new Error("Choose a local repository before starting Cursor.");
    }

    const cwd = resolve(repoRootPath);
    const repoBranch = await buildRepoStatus(cwd)
      .then((status) => status.branch)
      .catch(() => null);
    const cursorMcpPolicy = normalizeCursorMcpPolicy(input.cursorMcpPolicy);
    const permissionProfile = assertManagedAgentPermissionProfileAvailable("cursor", input.permissionProfileId);
    const preflightResult = await preflight("cursor", {
      roomIdentifier,
      roomGitRoom: input.roomGitRoom,
      repoRootPath: cwd,
      permissionProfileId: permissionProfile.id,
      cursorMcpPolicy,
      model: input.model,
      modelSource: input.modelSource,
    });
    if (!preflightResult.canStart) {
      throw new Error(preflightResult.detail || preflightResult.message);
    }
    const selectedModel = normalizeManagedAgentModel(input.model);
    prepareCursorManagedProfile({ workspaceRoot: cwd, mcpPolicy: cursorMcpPolicy });

    const token = makeCursorStopToken();
    const displayName = suggestLetAgentsCodename(listCursorDisplayNamesForRoom(roomIdentifier), token);
    const registeredWorker = await registerWorker({
      roomIdentifier,
      displayName,
      token,
      repoBranch,
    });
    const startedAt = now();
    const session = saveCursorLiveSession({
      session_id: randomUUID(),
      room_id: registeredWorker.room_id || roomIdentifier,
      room_identifier: roomIdentifier,
      room_display_name: input.roomDisplayName ?? null,
      display_name: registeredWorker.display_name || displayName,
      joined_via: joinedViaForRoomIdentifier(roomIdentifier),
      cwd,
      repo_branch: repoBranch,
      model: selectedModel,
      stop_phrase: input.stopPhrase?.trim() || DEFAULT_CURSOR_STOP_PHRASE,
      max_minutes: coerceMaxMinutes(input.maxMinutes),
      delivery_mode: "desktop_events",
      permission_profile_id: permissionProfile.id,
      cursor_mcp_policy: cursorMcpPolicy,
      desktop_managed: true,
      deadline_utc: formatDeadlineUtc(coerceMaxMinutes(input.maxMinutes)),
      token,
      cursor_session_id: null,
      cursor_bin: process.env.LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent",
      agent_session_id: registeredWorker.session_id,
      active_work: null,
      status: "completed",
      last_error: null,
      recent_items: [{
        type: "system",
        text: `${permissionProfile.label} Cursor worker is registered and waiting for desktop-delivered room events.`,
      }],
      started_at: startedAt,
      updated_at: startedAt,
    });
    emitSessionUpdate(session);

    return {
      session: toPublicCursorManagedAgentSession(session),
      reused: false,
      message: cursorPermissionProfileStartMessage(permissionProfile.id),
    };
  }

  async function inspect(
    sessionId?: string | null,
    roomIdentifier?: string | null,
  ): Promise<DesktopManagedAgentInspectResult | null> {
    const session = findStoredCursorSession(sessionId, roomIdentifier);
    if (!session) {
      return null;
    }

    const updated = updateCursorLiveSession(session.session_id, (current) => ({
      ...current,
      updated_at: now(),
    })) ?? session;
    emitSessionUpdate(updated);
    return {
      session: toPublicCursorManagedAgentSession(updated),
      serverReachable: true,
      recentItems: updated.recent_items ?? [],
    };
  }

  async function stop(input: DesktopManagedAgentStopInput = {}): Promise<DesktopManagedAgentSession | null> {
    const session = findStoredCursorSession(input.sessionId, input.roomIdentifier);
    if (!session) {
      return null;
    }

    engine.interruptActiveTurnForStop(session.session_id);
    clearDesktopManagedAgentReplyChangeState(cursorReplyChangeSessionKey(session.session_id));
    cleanupAgentSessionAttachments(session.session_id);
    engine.resetTurnErrorBudget(session.session_id);
    const updated = updateCursorLiveSession(session.session_id, (current) => ({
      ...current,
      status: "interrupted",
      active_work: null,
      last_error: null,
      updated_at: now(),
    })) ?? session;
    emitSessionUpdate(updated);
    await disconnectWorker(getStoredAgentSession(updated.agent_session_id));
    return toPublicCursorManagedAgentSession(updated);
  }

  function dispatchRoomStreamEvent(
    event: DesktopRoomStreamEvent,
    context?: DesktopManagedAgentDispatchContext,
  ): void {
    if (!isManagedRoomStreamEvent(event)) {
      return;
    }

    const sessions = listDesktopManagedCursorLiveSessions(event.roomIdentifier);
    const publicSessions = sessions.map(toPublicCursorManagedAgentSession);
    const roomSessions = context?.roomSessions ?? publicSessions;
    const recipients = new Set(resolveDesktopRoomStreamEventRecipients(
      roomSessions,
      event,
      context?.populationComplete ?? true,
    ).map((session) => session.id));
    for (const [index, session] of sessions.entries()) {
      const publicSession = publicSessions[index];
      if (!publicSession) continue;
      if (
        isStopPhraseRoomStreamEvent(session, event)
        && canDeliverCodexStopControlToManagedAgent(publicSession)
        && !isOwnRoomStreamEventForManagedAgentAmongWorkers(
          publicSession,
          roomSessions,
          event,
        )
      ) {
        recipients.add(publicSession.id);
      }
    }
    for (const session of sessions.filter((candidate) => recipients.has(candidate.session_id))) {
      engine.enqueueDesktopEventTurn(session, event);
    }
  }


  async function runCursorDesktopEventTurnWithRoomTools(input: {
    active: DesktopCursorLiveSessionState;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortController: AbortController;
  }): Promise<CursorTurnResult> {
    let cursorSessionId = input.active.cursor_session_id ?? null;
    let result = await runCursorTurnForDesktopEvent({
      session: input.active,
      prompt: buildCursorDesktopEventPrompt(input.active, input.event),
      cursorSessionId,
      abortController: input.abortController,
    });
    cursorSessionId = result.sessionId ?? cursorSessionId;
    result = await correctMalformedCursorRoomToolTurnOnce({
      session: input.active,
      turn: result,
      cursorSessionId,
      abortController: input.abortController,
    });
    cursorSessionId = result.sessionId ?? cursorSessionId;

    const loop = await runManagedAgentRoomToolLoop({
      providerLabel: "Cursor",
      session: input.active,
      storage: input.storage,
      initialTurn: result,
      initialContinuationId: cursorSessionId,
      getContinuationId: (turn) => turn.sessionId,
      getLatestSession: (fallback) =>
        getStoredCursorLiveSession(input.active.session_id) ?? fallback,
      onRoomToolRequest: ({ request }) => {
        const updated = updateCursorLiveSession(input.active.session_id, (current) => ({
          ...current,
          active_work: {
            kind: input.event.type,
            event_id: input.event.type === "message" ? input.event.message.id : input.event.task.id,
            started_at: current.active_work?.started_at ?? now(),
            summary: `Running ${request.tool} room tool.`,
          },
          updated_at: now(),
        }));
        emitSessionUpdate(updated);
        return updated;
      },
      runContinuationTurn: async ({ prompt, session, continuationId }) => {
        let turn = await runCursorTurnForDesktopEvent({
          session,
          prompt,
          cursorSessionId: continuationId,
          abortController: input.abortController,
        });
        turn = await correctMalformedCursorRoomToolTurnOnce({
          session,
          turn,
          cursorSessionId: turn.sessionId ?? continuationId,
          abortController: input.abortController,
        });
        return {
          session: getStoredCursorLiveSession(input.active.session_id) ?? session,
          turn,
        };
      },
      onLoopError: ({ continuationId, recentItems, error }) =>
        cursorRoomToolErrorResult(continuationId, recentItems, error),
    });

    return { ...loop.turn, sessionId: loop.continuationId };
  }

  async function correctMalformedCursorRoomToolTurnOnce(input: {
    session: DesktopCursorLiveSessionState;
    turn: CursorTurnResult;
    cursorSessionId: string | null;
    abortController: AbortController;
  }): Promise<CursorTurnResult> {
    if (
      input.turn.status === "error"
      || parseManagedAgentRoomToolRequest(input.turn.text)
      || !hasManagedAgentRoomToolRequestLine(input.turn.text)
      || !input.cursorSessionId
    ) {
      return input.turn;
    }

    return await runCursorTurnForDesktopEvent({
      session: input.session,
      prompt: buildCursorRoomToolFormattingCorrectionPrompt(),
      cursorSessionId: input.cursorSessionId,
      abortController: input.abortController,
    });
  }

  async function runCursorTurnForDesktopEvent(input: {
    session: DesktopCursorLiveSessionState;
    prompt: string;
    cursorSessionId: string | null;
    abortController: AbortController;
  }): Promise<CursorTurnResult> {
    const launchOptions = cursorLaunchOptionsForPermissionProfile(input.session.permission_profile_id);
    return await runner.runTurn({
      prompt: input.prompt,
      cwd: input.session.cwd,
      cursorSessionId: input.cursorSessionId,
      cursorBin: input.session.cursor_bin,
      model: input.session.model ?? null,
      env: prepareCursorManagedProfile({
        workspaceRoot: input.session.cwd,
        mcpPolicy: input.session.cursor_mcp_policy,
      }).env,
      mode: launchOptions.mode,
      force: launchOptions.force,
      sandbox: launchOptions.sandbox,
      abortController: input.abortController,
    });
  }


  return {
    providerId: "cursor",
    listSessions,
    start,
    inspect,
    stop,
    retry: async ({ sessionId }) => {
      const resumed = engine.retryBlockedSession(sessionId);
      return resumed ? toPublicCursorManagedAgentSession(resumed) : null;
    },
    dispatchRoomStreamEvent,
    waitForIdle: engine.waitForIdle,
  };
}


async function publishDesktopManagedCursorReply(input: PublishCursorReplyInput): Promise<void> {
  await publishDesktopManagedWorkerReply({
    provider: CURSOR_WORKER_PROVIDER,
    sessionToken: input.session.token,
    agentSessionId: input.session.agent_session_id,
    sessionKey: cursorReplyChangeSessionKey(input.session.session_id),
    publicSession: () => toPublicCursorManagedAgentSession(input.session),
    roomIdentifier: input.session.room_identifier || input.session.room_id,
    storage: input.storage,
    event: input.event,
    text: input.text,
    beforeChangeSignature: input.beforeChangeSignature ?? null,
    onMissingWorkerSession: () => {
      updateCursorLiveSession(input.session.session_id, (current) => ({
        ...current,
        status: "unknown",
        last_error: "Cursor produced a room reply before the desktop worker session was available.",
        updated_at: new Date().toISOString(),
      }));
    },
  });
}

async function registerDesktopManagedCursorWorker(
  input: RegisterCursorWorkerInput,
): Promise<StoredAgentSessionState> {
  return registerDesktopManagedWorker(CURSOR_WORKER_PROVIDER, input);
}

async function disconnectDesktopManagedCursorWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  await disconnectDesktopManagedWorker(session);
}


function emitCursorManagedAgentSessionUpdate(
  session: DesktopCursorLiveSessionState | null | undefined,
): void {
  if (!session) {
    return;
  }
  void import("../window.js")
    .then(({ emitToMainWindow }) => {
      emitToMainWindow(
        "desktop:workers:managed-agent-session",
        toPublicCursorManagedAgentSession(session),
      );
    })
    .catch(() => undefined);
}

function findStoredCursorSession(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): DesktopCursorLiveSessionState | null {
  if (sessionId?.trim()) {
    return getStoredCursorLiveSession(sessionId.trim());
  }
  return getCurrentCursorLiveSession(roomIdentifier?.trim() || undefined);
}

async function runCursorProviderPreflight(
  providerId: DesktopAgentProviderId,
  input?: DesktopAgentProviderPreflightInput,
): Promise<DesktopAgentProviderPreflight> {
  const { runDesktopAgentProviderPreflight } = await import("./providers.js");
  return runDesktopAgentProviderPreflight(providerId, input);
}

async function resolveRoomStorageMode(roomIdentifier: string): Promise<DesktopRoomStorageState> {
  const { resolveLocalAwareRoomStorageMode } = await import("../rooms/local-store.js");
  return resolveLocalAwareRoomStorageMode(roomIdentifier);
}

function normalizeRoomIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Choose a room before starting an agent.");
  }
  return looksLikeInviteCode(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function joinedViaForRoomIdentifier(roomIdentifier: string): DesktopCursorJoinedVia {
  return looksLikeInviteCode(roomIdentifier) ? "join_code" : "join_room";
}

function coerceMaxMinutes(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? 0)) {
    return 0;
  }
  return Math.max(0, Math.floor(Number(value ?? 0)));
}

function formatDeadlineUtc(minutes: number): string | null {
  if (minutes <= 0) {
    return null;
  }
  return new Date(Date.now() + minutes * 60 * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function makeCursorStopToken(): string {
  return `LOCAL_CURSOR_ROOM_${randomUUID()}`;
}
