import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
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
import { desktopEventPublicReplyText } from "./codex-event-prompt.js";
import {
  canDeliverDesktopEventToManagedAgent,
  isStopPhraseRoomStreamEvent,
  shouldDeliverRoomStreamEventToManagedAgent,
} from "./codex-event-routing.js";
import {
  isManagedRoomStreamEvent,
  type ManagedRoomEvent,
} from "./codex-managed-agent-dispatch.js";
import { buildCursorDesktopEventPrompt } from "./cursor-event-prompt.js";
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
import type { DesktopManagedAgentRuntime } from "./managed-agent-runtime.js";
import {
  desktopManagedAgentReplyTargetForMessage,
  persistDesktopManagedAgentLocalReply,
  type DesktopManagedAgentReplyTarget,
} from "./managed-agent-local-replies.js";
import {
  runManagedAgentRoomToolLoop,
} from "./managed-agent-room-tool-loop.js";
import {
  createLocalDesktopManagedAgentWorkerSession,
  shouldUseCloudDesktopManagedAgentWorkerSession,
  resolveDesktopManagedAgentWorkerRegistration,
} from "./managed-agent-local-worker-session.js";
import { cleanupAgentSessionAttachments } from "./managed-agent-attachments.js";
import {
  buildDesktopManagedAgentReplyChangeContext,
  clearDesktopManagedAgentReplyChangeState,
  desktopManagedAgentReplyChangeSignature,
  localDesktopManagedAgentReplyChangeAttachments,
  publishDesktopManagedAgentReplyChangeSummaryArtifact,
  rememberDesktopManagedAgentReplyChangeAttachment,
  stageDesktopManagedAgentReplyChangeAttachment,
} from "./managed-agent-reply-changes.js";
import {
  getCurrentCursorLiveSession,
  getOrCreateDesktopHostId,
  getStoredAgentIdentityForRuntimeKey,
  getStoredAgentSession,
  getStoredCursorLiveSession,
  listCursorDisplayNamesForRoom,
  listDesktopManagedCursorLiveSessions,
  markAgentSessionEnded,
  saveAgentSession,
  saveCursorLiveSession,
  saveStoredAgentIdentity,
  toPublicCursorManagedAgentSession,
  updateCursorLiveSession,
  type DesktopCursorJoinedVia,
  type DesktopCursorLiveSessionState,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
} from "./state.js";

const DEFAULT_CURSOR_STOP_PHRASE = "/stop-cursor-room";
// See claude-code-runtime: park always-erroring sessions as terminal instead
// of leaving them deliverable-but-invisible in status "unknown".
const MAX_CONSECUTIVE_TURN_ERRORS = 3;

function cursorReplyChangeSessionKey(sessionId: string): string {
  return `cursor:${sessionId}`;
}

type ActiveCursorTurn = {
  abortController: AbortController;
  interruptReason: "preempt" | "stop" | null;
};

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
  repo_branch?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  ended_at?: string | null;
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

interface CursorRuntimeDependencies {
  runner?: CursorRunner;
  preflight?: (
    providerId: DesktopAgentProviderId,
    input?: DesktopAgentProviderPreflightInput,
  ) => Promise<DesktopAgentProviderPreflight>;
  registerWorker?: (input: RegisterCursorWorkerInput) => Promise<StoredAgentSessionState>;
  disconnectWorker?: (session: StoredAgentSessionState | null) => Promise<void>;
  publishReply?: (input: PublishCursorReplyInput) => Promise<void>;
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
  const resolveStorage = dependencies.resolveStorage ?? resolveRoomStorageMode;
  const emitSessionUpdate = dependencies.emitSessionUpdate ?? emitCursorManagedAgentSessionUpdate;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const queues = new Map<string, Promise<void>>();
  const activeTurns = new Map<string, ActiveCursorTurn>();
  const consecutiveTurnErrors = new Map<string, number>();

  function recordConsecutiveTurnError(sessionId: string): boolean {
    const errorCount = (consecutiveTurnErrors.get(sessionId) ?? 0) + 1;
    consecutiveTurnErrors.set(sessionId, errorCount);
    return errorCount >= MAX_CONSECUTIVE_TURN_ERRORS;
  }

  function exhaustedTurnError(errorText: string): string {
    return `Stopped after ${MAX_CONSECUTIVE_TURN_ERRORS} consecutive turn errors. Last error: ${errorText}`;
  }

  /** See claude-code-runtime: release worker registration when parking. */
  async function endExhaustedSessionWorker(sessionId: string): Promise<void> {
    clearDesktopManagedAgentReplyChangeState(cursorReplyChangeSessionKey(sessionId));
    cleanupAgentSessionAttachments(sessionId);
    consecutiveTurnErrors.delete(sessionId);
    const liveSession = getStoredCursorLiveSession(sessionId);
    await disconnectWorker(getStoredAgentSession(liveSession?.agent_session_id ?? null));
  }

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

    const activeTurn = activeTurns.get(session.session_id);
    if (activeTurn) {
      activeTurn.interruptReason = "stop";
      activeTurn.abortController.abort();
    }
    clearDesktopManagedAgentReplyChangeState(cursorReplyChangeSessionKey(session.session_id));
    cleanupAgentSessionAttachments(session.session_id);
    consecutiveTurnErrors.delete(session.session_id);
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

  function dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    if (!isManagedRoomStreamEvent(event)) {
      return;
    }

    const sessions = listDesktopManagedCursorLiveSessions(event.roomIdentifier)
      .filter((session) =>
        shouldDeliverRoomStreamEventToManagedAgent(
          toPublicCursorManagedAgentSession(session),
          event,
        ));
    for (const session of sessions) {
      enqueueDesktopEventTurn(session, event);
    }
  }

  function enqueueDesktopEventTurn(
    session: DesktopCursorLiveSessionState,
    event: ManagedRoomEvent,
  ): void {
    preemptActiveTurnIfSafe(session);
    const previous = queues.get(session.session_id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => deliverDesktopEventTurn(session.session_id, event, await resolveStorage(event.roomIdentifier)))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const stored = getStoredCursorLiveSession(session.session_id);
        if (stored && (stored.status === "interrupted" || stored.status === "failed")) {
          return;
        }
        const exhausted = recordConsecutiveTurnError(session.session_id);
        const updated = clearSessionActiveWork(session.session_id, (current) => ({
          ...current,
          status: exhausted ? "failed" : "unknown",
          last_error: exhausted ? exhaustedTurnError(message) : message,
          updated_at: now(),
        }));
        emitSessionUpdate(updated);
        if (exhausted) {
          await endExhaustedSessionWorker(session.session_id);
        }
      });
    queues.set(session.session_id, next);
    void next.finally(() => {
      if (queues.get(session.session_id) === next) {
        queues.delete(session.session_id);
      }
    });
  }

  async function deliverDesktopEventTurn(
    sessionId: string,
    event: ManagedRoomEvent,
    storage: DesktopRoomStorageState,
  ): Promise<void> {
    const session = getStoredCursorLiveSession(sessionId);
    if (!session || !canDeliverDesktopEventToManagedAgent(toPublicCursorManagedAgentSession(session))) {
      return;
    }

    const stopAfterTurn = isStopPhraseRoomStreamEvent(session, event);
    const active = markSessionActiveForEvent(session, event);
    const beforeChangeSignature = await desktopManagedAgentReplyChangeSignature(
      toPublicCursorManagedAgentSession(active),
    );
    const abortController = new AbortController();
    const activeTurn: ActiveCursorTurn = {
      abortController,
      interruptReason: null,
    };
    activeTurns.set(session.session_id, activeTurn);
    try {
      const result = await runCursorDesktopEventTurnWithRoomTools({
        active,
        event,
        storage,
        abortController,
      });

      const latest = getStoredCursorLiveSession(sessionId) ?? active;
      if (
        latest.status === "interrupted" &&
        abortController.signal.aborted &&
        activeTurn.interruptReason !== "preempt"
      ) {
        return;
      }

      if (result.status === "error") {
        const wasPreempted = abortController.signal.aborted && activeTurn.interruptReason === "preempt";
        const aborted = abortController.signal.aborted;
        const exhausted = !wasPreempted && !aborted && recordConsecutiveTurnError(sessionId);
        const updated = clearSessionActiveWork(sessionId, (current) => ({
          ...current,
          cursor_session_id: result.sessionId ?? current.cursor_session_id ?? null,
          status: wasPreempted
            ? "completed"
            : aborted
              ? "interrupted"
              : exhausted
                ? "failed"
                : "unknown",
          last_error: wasPreempted
            ? null
            : exhausted
              ? exhaustedTurnError(String(result.error))
              : result.error,
          recent_items: result.recentItems,
          updated_at: now(),
        }));
        emitSessionUpdate(updated);
        if (exhausted) {
          await endExhaustedSessionWorker(sessionId);
        }
        return;
      }

      const completed = clearSessionActiveWork(sessionId, (current) => ({
        ...current,
        cursor_session_id: result.sessionId ?? current.cursor_session_id ?? null,
        status: "completed",
        last_error: null,
        recent_items: result.recentItems,
        updated_at: now(),
      })) ?? latest;
      emitSessionUpdate(completed);
      await publishReply({
        session: completed,
        event,
        storage,
        text: result.text,
        beforeChangeSignature,
      });
      // Reset only after full delivery succeeds; see claude-code-runtime.
      consecutiveTurnErrors.delete(sessionId);
      if (stopAfterTurn) {
        await stopAfterRoomStopPhrase(completed);
      }
    } finally {
      if (activeTurns.get(session.session_id) === activeTurn) {
        activeTurns.delete(session.session_id);
      }
    }
  }

  async function runCursorDesktopEventTurnWithRoomTools(input: {
    active: DesktopCursorLiveSessionState;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortController: AbortController;
  }): Promise<CursorTurnResult> {
    let cursorSessionId = input.active.cursor_session_id ?? null;
    const result = await runCursorTurnForDesktopEvent({
      session: input.active,
      prompt: buildCursorDesktopEventPrompt(input.active, input.event),
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
        const turn = await runCursorTurnForDesktopEvent({
          session,
          prompt,
          cursorSessionId: continuationId,
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

  function preemptActiveTurnIfSafe(session: DesktopCursorLiveSessionState): void {
    const launchOptions = cursorLaunchOptionsForPermissionProfile(session.permission_profile_id);
    if (launchOptions.force) {
      return;
    }
    preemptActiveTurn(session.session_id);
  }

  function preemptActiveTurn(sessionId: string): void {
    const activeTurn = activeTurns.get(sessionId);
    if (!activeTurn || activeTurn.abortController.signal.aborted) {
      return;
    }
    activeTurn.interruptReason = "preempt";
    activeTurn.abortController.abort();
  }

  function markSessionActiveForEvent(
    session: DesktopCursorLiveSessionState,
    event: ManagedRoomEvent,
  ): DesktopCursorLiveSessionState {
    const activeWork = activeWorkForEvent(event, now());
    const updated = updateCursorLiveSession(session.session_id, (current) => ({
      ...current,
      status: "running",
      active_work: activeWork,
      last_error: null,
      updated_at: activeWork.started_at,
    })) ?? {
      ...session,
      status: "running",
      active_work: activeWork,
      last_error: null,
      updated_at: activeWork.started_at,
    };
    emitSessionUpdate(updated);
    return updated;
  }

  function clearSessionActiveWork(
    sessionId: string,
    updater: (session: DesktopCursorLiveSessionState) => DesktopCursorLiveSessionState,
  ): DesktopCursorLiveSessionState | null {
    return updateCursorLiveSession(sessionId, (current) => ({
      ...updater(current),
      active_work: null,
    }));
  }

  async function stopAfterRoomStopPhrase(session: DesktopCursorLiveSessionState): Promise<void> {
    const updated = updateCursorLiveSession(session.session_id, (current) => ({
      ...current,
      status: "interrupted",
      active_work: null,
      last_error: null,
      updated_at: now(),
    })) ?? session;
    emitSessionUpdate(updated);
    await disconnectWorker(getStoredAgentSession(updated.agent_session_id));
  }

  async function waitForIdle(): Promise<void> {
    while (queues.size > 0) {
      await Promise.allSettled([...queues.values()]);
    }
  }

  return {
    providerId: "cursor",
    listSessions,
    start,
    inspect,
    stop,
    dispatchRoomStreamEvent,
    waitForIdle,
  };
}

function activeWorkForEvent(
  event: ManagedRoomEvent,
  startedAt: string,
): NonNullable<DesktopCursorLiveSessionState["active_work"]> {
  return {
    kind: event.type,
    event_id: event.type === "message" ? event.message.id : event.task.id,
    started_at: startedAt,
    summary: event.type === "message" ? "Reading the room message." : "Reading the task update.",
  };
}

function replyTargetForEvent(event: ManagedRoomEvent): DesktopManagedAgentReplyTarget {
  if (event.type !== "message") {
    return { replyTo: null, threadRootId: null };
  }
  return desktopManagedAgentReplyTargetForMessage(event.message);
}

async function publishDesktopManagedCursorReply(input: PublishCursorReplyInput): Promise<void> {
  const text = desktopEventPublicReplyText(input.session.token, input.text);
  if (!text) {
    return;
  }

  const workerSession = getStoredAgentSession(input.session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) {
    updateCursorLiveSession(input.session.session_id, (current) => ({
      ...current,
      status: "unknown",
      last_error: "Cursor produced a room reply before the desktop worker session was available.",
      updated_at: new Date().toISOString(),
    }));
    return;
  }

  const roomIdentifier = input.session.room_identifier || input.session.room_id;
  const sessionKey = cursorReplyChangeSessionKey(input.session.session_id);
  const replyTarget = replyTargetForEvent(input.event);
  const changeContext = await buildDesktopManagedAgentReplyChangeContext({
    sessionKey,
    session: toPublicCursorManagedAgentSession(input.session),
    beforeSignature: input.beforeChangeSignature ?? null,
  });
  const localReply = await persistDesktopManagedAgentLocalReply({
    roomIdentifier,
    storage: input.storage,
    workerSession,
    replyTo: replyTarget.replyTo,
    threadRootId: replyTarget.threadRootId,
    text,
    attachments: localDesktopManagedAgentReplyChangeAttachments(changeContext),
  });
  if (localReply) {
    await publishDesktopManagedAgentReplyChangeSummaryArtifact({
      sessionKey,
      roomIdentifier,
      storage: input.storage,
      workerSession,
      event: input.event,
      context: changeContext,
    });
    rememberDesktopManagedAgentReplyChangeAttachment(sessionKey, changeContext.attachmentDraft);
    const { emitPersistedLocalRoomMessage } = await import("../room-stream.js");
    emitPersistedLocalRoomMessage(roomIdentifier, localReply);
    return;
  }

  const { apiFetch } = await import("../auth.js");
  const { cloudRoomIdentifierForStorage } = await import("../rooms/local-store.js");
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(input.storage, roomIdentifier);
  const attachments = await stageDesktopManagedAgentReplyChangeAttachment(
    cloudRoomIdentifier,
    changeContext.attachmentDraft,
  );
  if (changeContext.attachmentDraft && attachments.length === 0) {
    console.warn("Could not attach Cursor managed-agent working tree summary to room reply.");
  }
  await apiFetch<Record<string, unknown>>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        text,
        reply_to: replyTarget.replyTo,
        thread_root_id: replyTarget.threadRootId,
        agent_session_id: workerSession.session_id,
        agent_session_token: workerSession.session_token,
        attachments,
      }),
    },
  );
  if (changeContext.attachmentDraft && attachments.length > 0) {
    rememberDesktopManagedAgentReplyChangeAttachment(sessionKey, changeContext.attachmentDraft);
  }
  await publishDesktopManagedAgentReplyChangeSummaryArtifact({
    sessionKey,
    roomIdentifier,
    storage: input.storage,
    workerSession,
    event: input.event,
    context: changeContext,
  });
}

async function registerDesktopManagedCursorWorker(
  input: RegisterCursorWorkerInput,
): Promise<StoredAgentSessionState> {
  const runtime = `cursor:${input.token}`;
  const agentInstanceId = `desktop-cursor:${input.token}`;
  const registrationLiveness = cursorSessionLivenessRegistration(runtime, input.token);
  const registration = await resolveDesktopManagedAgentWorkerRegistration({
    roomIdentifier: input.roomIdentifier,
  });
  const localSession = registration.storage.effectiveMode === "local"
    ? await createLocalDesktopManagedAgentWorkerSession({
      roomIdentifier: input.roomIdentifier,
      runtime,
      agentInstanceId,
      displayName: input.displayName,
      ideLabel: "Cursor",
      repoBranch: input.repoBranch,
      registrationLiveness,
    }, registration.storage)
    : null;
  if (localSession) {
    return localSession;
  }

  const identity = await ensureDesktopManagedCursorIdentity(input.displayName);
  const actorKey = normalizeDisplayText(identity.canonical_key, "");
  if (!actorKey) {
    throw new Error("LetAgents desktop Cursor identity is missing an actor key.");
  }

  const { apiFetch } = await import("../auth.js");
  const cloudRoomIdentifier = registration.cloudRoomIdentifier;
  const created = await apiFetch<AgentSessionCreateResponse>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/agent-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor_key: actorKey,
        actor_label: identity.actor_label,
        ide_label: "Cursor",
        agent_instance_id: agentInstanceId,
        display_name: input.displayName,
        session_kind: "worker",
        runtime,
        repo_branch: input.repoBranch,
        registration_liveness: registrationLiveness,
      }),
    },
  );

  return saveAgentSession(toStoredCursorAgentSession(created, {
    roomIdentifier: cloudRoomIdentifier,
    runtime,
    identity,
    agentInstanceId,
    displayName: input.displayName,
  }));
}

async function disconnectDesktopManagedCursorWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  if (!session?.session_id || !session.session_token) {
    return;
  }

  if (!(await shouldUseCloudDesktopManagedAgentWorkerSession(session))) {
    markAgentSessionEnded(session.session_id);
    return;
  }

  try {
    const { apiFetch } = await import("../auth.js");
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

async function ensureDesktopManagedCursorIdentity(displayName: string): Promise<StoredAgentIdentityState> {
  const requestedName = normalizeAgentIdentityName(displayName, "desktop-cursor");
  const requestedDisplayName = normalizeDisplayText(displayName, "Cursor");
  const runtimeKey = `desktop-cursor:${requestedName}`;
  const existingForName = getStoredAgentIdentityForRuntimeKey(runtimeKey);
  if (isUsableAgentIdentity(existingForName)) {
    return existingForName;
  }

  const { apiFetch, readStoredAuth } = await import("../auth.js");
  const storedAuth = await readStoredAuth();
  if (!storedAuth.token) {
    throw new Error("Sign into LetAgents Desktop before starting a supervised Cursor agent.");
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
    throw new Error("LetAgents did not return a usable agent identity for the desktop Cursor worker.");
  }

  const resolvedDisplayName = normalizeDisplayText(registered.display_name, requestedDisplayName);
  const resolvedOwnerLabel = normalizeDisplayText(registered.owner_label, ownerLabel);
  const now = new Date().toISOString();
  return saveStoredAgentIdentity({
    name: normalizeDisplayText(registered.name, requestedName),
    display_name: resolvedDisplayName,
    owner_label: resolvedOwnerLabel,
    owner_attribution: formatOwnerAttribution(resolvedOwnerLabel),
    ide_label: "Cursor",
    actor_label: buildAgentActorLabel({
      displayName: resolvedDisplayName,
      ownerLabel: resolvedOwnerLabel,
      ideLabel: "Cursor",
    }),
    canonical_key: canonicalKey,
    runtime_key: runtimeKey,
    source: "api",
    resolved_at: now,
  });
}

function toStoredCursorAgentSession(
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
        ideLabel: "Cursor",
      }),
    ),
    agent_key: normalizeDisplayText(created.agent_key, input.identity.canonical_key ?? ""),
    agent_instance_id: normalizeDisplayText(created.agent_instance_id, input.agentInstanceId),
    display_name: normalizeDisplayText(created.display_name, input.displayName),
    owner_label: normalizeDisplayText(created.owner_label, input.identity.owner_label),
    ide_label: normalizeDisplayText(created.ide_label, "Cursor"),
    repo_branch: normalizeDisplayText(created.repo_branch, "") || null,
    created_at: createdAt,
    updated_at: updatedAt,
    last_seen_at: normalizeDisplayText(created.last_seen_at, updatedAt),
    ended_at: created.ended_at ?? null,
  };
}

function cursorSessionLivenessRegistration(runtime: string, token: string): Record<string, string | null> {
  const hostId = getOrCreateDesktopHostId();
  return {
    host_id: hostId,
    host_kind: process.platform === "darwin" ? "macos" : process.platform,
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_cursor_readonly",
    tool_bridge_id: `${hostId}:${runtime}:desktop:${token}`,
  };
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

function normalizeAgentIdentityName(displayName: string, fallback: string): string {
  const normalized = displayName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
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
