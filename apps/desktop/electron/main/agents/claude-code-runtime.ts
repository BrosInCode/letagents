import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopManagedAgentPermissionRequest,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { buildRepoStatus } from "../../repo-status.js";
import {
  looksLikeInviteCode,
} from "./codex-start-prompt.js";
import {
  shouldDeliverRoomStreamEventToManagedAgent,
} from "./codex-event-routing.js";
import { buildClaudeCodeDesktopEventPrompt } from "./claude-code-event-prompt.js";
import {
  buildManagedAgentPermissionRoomText,
  createManagedAgentPermissionRequest,
  DEFAULT_MANAGED_AGENT_PERMISSION_TIMEOUT_MS,
  isAutoAllowedManagedAgentTool,
  isManagedAgentPermissionDecisionBehavior,
  parseManagedAgentPermissionDecision,
  removeManagedAgentPermissionRequest,
  type ManagedAgentPermissionDecision,
} from "./managed-agent-permissions.js";
import {
  allowClaudeCodeToolUse,
  productionClaudeCodeRunner,
  type ClaudeCodeRunner,
  type ClaudeCodeTurnResult,
  isBlockedClaudeCodeTool,
} from "./claude-code-runner.js";
import { suggestLetAgentsCodename } from "./codenames.js";
import {
  getCurrentClaudeCodeLiveSession,
  getStoredAgentSession,
  getStoredClaudeCodeLiveSession,
  listClaudeCodeDisplayNamesForRoom,
  listDesktopManagedClaudeCodeLiveSessions,
  saveClaudeCodeLiveSession,
  toPublicClaudeCodeManagedAgentSession,
  updateClaudeCodeLiveSession,
  type DesktopClaudeCodeJoinedVia,
  type DesktopClaudeCodeLiveSessionState,
  type StoredAgentSessionState,
} from "./state.js";
import {
  assertManagedAgentPermissionProfileAvailable,
  managedAgentPermissionProfileForProvider,
} from "./managed-agent-permission-profiles.js";
import {
  normalizeManagedAgentEffortForProvider,
  normalizeManagedAgentModel,
} from "./managed-agent-models.js";
import type { DesktopManagedAgentRuntime } from "./managed-agent-runtime.js";
import {
  persistDesktopManagedAgentLocalReply,
} from "./managed-agent-local-replies.js";
import {
  runManagedAgentRoomToolLoop,
} from "./managed-agent-room-tool-loop.js";
import { cleanupAgentSessionAttachments } from "./managed-agent-attachments.js";
import { createManagedAgentEventTurnEngine } from "./managed-agent-event-turn-engine.js";
import {
  disconnectDesktopManagedWorker,
  normalizeDisplayText,
  publishDesktopManagedWorkerReply,
  registerDesktopManagedWorker,
  type ManagedAgentWorkerProvider,
} from "./managed-agent-worker.js";
import {
  clearDesktopManagedAgentReplyChangeState,
} from "./managed-agent-reply-changes.js";

const DEFAULT_CLAUDE_CODE_STOP_PHRASE = "/stop-claude-code-room";

type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;

function claudeCodeReplyChangeSessionKey(sessionId: string): string {
  return `claude-code:${sessionId}`;
}

const CLAUDE_CODE_WORKER_PROVIDER: ManagedAgentWorkerProvider = {
  ideLabel: "Claude Code",
  runtimePrefix: "claude-code",
  instancePrefix: "desktop-claude-code",
  livenessCapability: "desktop_supervised_claude_code_sdk",
  identityNameFallback: "desktop-claude-code",
  signInErrorMessage: "Sign into LetAgents Desktop before starting a supervised Claude Code agent.",
  unusableIdentityErrorMessage: "LetAgents did not return a usable agent identity for the desktop Claude Code worker.",
  missingActorKeyErrorMessage: "LetAgents desktop Claude Code identity is missing an actor key.",
  replyWarnLabel: "Claude Code",
};

interface RegisterClaudeCodeWorkerInput {
  roomIdentifier: string;
  displayName: string;
  token: string;
  repoBranch: string | null;
}

interface PublishClaudeCodeReplyInput {
  session: DesktopClaudeCodeLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  text: string | null;
  beforeChangeSignature?: string | null;
}

interface PublishClaudeCodePermissionRequestInput {
  session: DesktopClaudeCodeLiveSessionState;
  event: ManagedRoomEvent;
  storage: DesktopRoomStorageState;
  request: DesktopManagedAgentPermissionRequest;
}

interface PublishClaudeCodePermissionRequestResult {
  roomMessageId: string | null;
}

interface ClaudeCodeRuntimeDependencies {
  runner?: ClaudeCodeRunner;
  preflight?: (
    providerId: DesktopAgentProviderId,
    input?: DesktopAgentProviderPreflightInput,
  ) => Promise<DesktopAgentProviderPreflight>;
  registerWorker?: (input: RegisterClaudeCodeWorkerInput) => Promise<StoredAgentSessionState>;
  disconnectWorker?: (session: StoredAgentSessionState | null) => Promise<void>;
  publishReply?: (input: PublishClaudeCodeReplyInput) => Promise<void>;
  publishPermissionRequest?: (
    input: PublishClaudeCodePermissionRequestInput,
  ) => Promise<PublishClaudeCodePermissionRequestResult>;
  resolveStorage?: (roomIdentifier: string) => Promise<DesktopRoomStorageState>;
  emitSessionUpdate?: (session: DesktopClaudeCodeLiveSessionState | null | undefined) => void;
  permissionTimeoutMs?: number;
  now?: () => string;
}

export type DesktopClaudeCodeRuntime = DesktopManagedAgentRuntime & {
  waitForIdle(): Promise<void>;
  resolvePermissionRequest(
    input: DesktopManagedAgentPermissionDecisionInput,
  ): Promise<DesktopManagedAgentPermissionDecisionResult>;
};

function claudeCodeRoomToolErrorResult(
  sessionId: string | null,
  recentItems: Array<Record<string, unknown>>,
  error: string,
): ClaudeCodeTurnResult {
  return {
    sessionId,
    text: null,
    status: "error",
    error,
    recentItems,
  };
}

export function createDesktopClaudeCodeRuntime(
  dependencies: ClaudeCodeRuntimeDependencies = {},
): DesktopClaudeCodeRuntime {
  const runner = dependencies.runner ?? productionClaudeCodeRunner;
  const preflight = dependencies.preflight ?? runClaudeCodeProviderPreflight;
  const registerWorker = dependencies.registerWorker ?? registerDesktopManagedClaudeCodeWorker;
  const disconnectWorker = dependencies.disconnectWorker ?? disconnectDesktopManagedClaudeCodeWorker;
  const publishReply = dependencies.publishReply ?? publishDesktopManagedClaudeCodeReply;
  const publishPermissionRequest =
    dependencies.publishPermissionRequest ?? publishDesktopManagedClaudeCodePermissionRequest;
  const resolveStorage = dependencies.resolveStorage ?? resolveRoomStorageMode;
  const emitSessionUpdate = dependencies.emitSessionUpdate ?? emitClaudeCodeManagedAgentSessionUpdate;
  const permissionTimeoutMs =
    dependencies.permissionTimeoutMs ?? DEFAULT_MANAGED_AGENT_PERMISSION_TIMEOUT_MS;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const engine = createManagedAgentEventTurnEngine<DesktopClaudeCodeLiveSessionState, ClaudeCodeTurnResult>({
    now,
    resolveStorage: (roomIdentifier) => resolveStorage(roomIdentifier),
    getStoredSession: getStoredClaudeCodeLiveSession,
    toPublicSession: toPublicClaudeCodeManagedAgentSession,
    updateSession: updateClaudeCodeLiveSession,
    emitSessionUpdate: (session) => emitSessionUpdate(session),
    publishReply: (input) => publishReply(input),
    runTurn: (input) =>
      runClaudeCodeDesktopEventTurnWithRoomTools({
        active: input.active,
        event: input.event,
        storage: input.storage,
        abortController: input.abortController,
        canUseTool: buildClaudeCodePermissionHandler({
          sessionId: input.active.session_id,
          event: input.event,
          storage: input.storage,
          abortSignal: input.abortController.signal,
        }),
      }),
    applyTurnResult: (current, result) => ({
      ...current,
      claude_session_id: result.sessionId ?? current.claude_session_id ?? null,
      recent_items: result.recentItems,
    }),
    // Claude Code turns are always safe to preempt for a newer room event.
    shouldPreemptOnEnqueue: () => true,
    replyChangeSessionKey: claudeCodeReplyChangeSessionKey,
    disconnectWorker: (session) => disconnectWorker(session),
    onSessionParked: (sessionId) =>
      clearPendingPermissionRequestsForSession(
        sessionId,
        "Permission request was cancelled because the managed agent session failed.",
      ),
    onDeliverFinally: (sessionId) => clearPendingPermissionRequestsForSession(sessionId),
  });
  const verifiedStartModels = new Set<string>();
  const pendingPermissionResolvers = new Map<string, (decision: ManagedAgentPermissionDecision) => void>();

  /**
   * The Claude Code CLI has no model-list command, so the picker's static
   * entries cannot be validated ahead of time. Run one minimal turn before
   * registering the worker: an unsupported model then fails the start with
   * the CLI's own message instead of registering an agent that errors on
   * every room event. Verified models are cached for the app session, so
   * only the first start with a given model pays the probe.
   */
  async function verifySelectedClaudeCodeModel(model: string, cwd: string): Promise<void> {
    if (verifiedStartModels.has(model)) {
      return;
    }
    const probe = await runner.runTurn({
      prompt: "This is an automated model verification probe. Reply with exactly: ok",
      cwd,
      model,
      canUseTool: async () => ({
        behavior: "deny",
        message: "Model verification probes must not use tools.",
        interrupt: true,
      }),
    });
    if (probe.status === "error") {
      throw new Error(probe.error || `Claude Code could not start with model "${model}".`);
    }
    verifiedStartModels.add(model);
  }

  function listSessions(roomIdentifier?: string | null): DesktopManagedAgentSession[] {
    return listDesktopManagedClaudeCodeLiveSessions(roomIdentifier)
      .map(toPublicClaudeCodeManagedAgentSession);
  }

  async function start(input: DesktopManagedAgentStartInput): Promise<DesktopManagedAgentStartResult> {
    if (input.providerId !== "claude-code") {
      throw new Error(`Claude Code runtime cannot start provider '${input.providerId}'.`);
    }
    if (input.deliveryMode && input.deliveryMode !== "desktop_events") {
      throw new Error("Claude Code managed runtime currently supports desktop-delivered room events only.");
    }

    const roomIdentifier = normalizeRoomIdentifier(input.roomIdentifier);
    const repoRootPath = input.repoRootPath?.trim();
    if (!repoRootPath) {
      throw new Error("Choose a local repository before starting Claude Code.");
    }

    const cwd = resolve(repoRootPath);
    const repoBranch = await buildRepoStatus(cwd)
      .then((status) => status.branch)
      .catch(() => null);
    const preflightResult = await preflight("claude-code", {
      roomIdentifier,
      roomGitRoom: input.roomGitRoom,
      repoRootPath: cwd,
      model: input.model,
      modelSource: input.modelSource,
      effort: input.effort,
    });
    if (!preflightResult.canStart) {
      throw new Error(preflightResult.detail || preflightResult.message);
    }
    const permissionProfile = assertManagedAgentPermissionProfileAvailable("claude-code", input.permissionProfileId);
    const selectedModel = normalizeManagedAgentModel(input.model);
    const selectedEffort = normalizeManagedAgentEffortForProvider("claude-code", input.effort);
    if (selectedModel) {
      await verifySelectedClaudeCodeModel(selectedModel, cwd);
    }

    const token = makeClaudeCodeStopToken();
    const displayName = suggestLetAgentsCodename(listClaudeCodeDisplayNamesForRoom(roomIdentifier), token);
    const registeredWorker = await registerWorker({
      roomIdentifier,
      displayName,
      token,
      repoBranch,
    });
    const startedAt = now();
    const session = saveClaudeCodeLiveSession({
      session_id: randomUUID(),
      room_id: registeredWorker.room_id || roomIdentifier,
      room_identifier: roomIdentifier,
      room_display_name: input.roomDisplayName ?? null,
      display_name: registeredWorker.display_name || displayName,
      joined_via: joinedViaForRoomIdentifier(roomIdentifier),
      cwd,
      repo_branch: repoBranch,
      model: selectedModel,
      effort: selectedEffort,
      stop_phrase: input.stopPhrase?.trim() || DEFAULT_CLAUDE_CODE_STOP_PHRASE,
      max_minutes: coerceMaxMinutes(input.maxMinutes),
      delivery_mode: "desktop_events",
      permission_profile_id: permissionProfile.id,
      desktop_managed: true,
      deadline_utc: formatDeadlineUtc(coerceMaxMinutes(input.maxMinutes)),
      token,
      claude_session_id: null,
      claude_bin: process.env.LETAGENTS_CLAUDE_CODE_BIN ||
        process.env.LETAGENTS_CLAUDE_BIN ||
        "claude",
      agent_session_id: registeredWorker.session_id,
      active_work: null,
      status: "completed",
      last_error: null,
      recent_items: [{
        type: "system",
        text: "Claude Code worker is registered and waiting for desktop-delivered room events.",
      }],
      pending_permission_requests: [],
      started_at: startedAt,
      updated_at: startedAt,
    });
    emitSessionUpdate(session);

    return {
      session: toPublicClaudeCodeManagedAgentSession(session),
      reused: false,
      message: "Claude Code agent started with desktop-delivered room events.",
    };
  }

  async function inspect(
    sessionId?: string | null,
    roomIdentifier?: string | null,
  ): Promise<DesktopManagedAgentInspectResult | null> {
    const session = findStoredClaudeCodeSession(sessionId, roomIdentifier);
    if (!session) {
      return null;
    }

    const updated = updateClaudeCodeLiveSession(session.session_id, (current) => ({
      ...current,
      updated_at: now(),
    })) ?? session;
    emitSessionUpdate(updated);
    return {
      session: toPublicClaudeCodeManagedAgentSession(updated),
      serverReachable: true,
      recentItems: updated.recent_items ?? [],
    };
  }

  async function stop(input: DesktopManagedAgentStopInput = {}): Promise<DesktopManagedAgentSession | null> {
    const session = findStoredClaudeCodeSession(input.sessionId, input.roomIdentifier);
    if (!session) {
      return null;
    }

    engine.interruptActiveTurnForStop(session.session_id);
    clearPendingPermissionRequestsForSession(
      session.session_id,
      "Permission request was cancelled because the managed agent session stopped.",
    );
    clearDesktopManagedAgentReplyChangeState(claudeCodeReplyChangeSessionKey(session.session_id));
    cleanupAgentSessionAttachments(session.session_id);
    engine.resetTurnErrorBudget(session.session_id);
    const updated = updateClaudeCodeLiveSession(session.session_id, (current) => ({
      ...current,
      status: "interrupted",
      active_work: null,
      last_error: null,
      updated_at: now(),
    })) ?? session;
    emitSessionUpdate(updated);
    await disconnectWorker(getStoredAgentSession(updated.agent_session_id));
    return toPublicClaudeCodeManagedAgentSession(updated);
  }

  function dispatchRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    if (!isManagedRoomStreamEvent(event)) {
      return;
    }
    if (consumePermissionDecisionEvent(event)) {
      return;
    }

    const sessions = listDesktopManagedClaudeCodeLiveSessions(event.roomIdentifier)
      .filter((session) =>
        shouldDeliverRoomStreamEventToManagedAgent(
          toPublicClaudeCodeManagedAgentSession(session),
          event,
        ));
    for (const session of sessions) {
      engine.enqueueDesktopEventTurn(session, event);
    }
  }


  async function runClaudeCodeDesktopEventTurnWithRoomTools(input: {
    active: DesktopClaudeCodeLiveSessionState;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortController: AbortController;
    canUseTool: CanUseTool;
  }): Promise<ClaudeCodeTurnResult> {
    let claudeSessionId = input.active.claude_session_id ?? null;
    const result = await runner.runTurn({
      prompt: buildClaudeCodeDesktopEventPrompt(input.active, input.event),
      cwd: input.active.cwd,
      claudeSessionId,
      claudeBin: input.active.claude_bin,
      model: input.active.model ?? null,
      effort: input.active.effort ?? null,
      abortController: input.abortController,
      canUseTool: input.canUseTool,
    });
    claudeSessionId = result.sessionId ?? claudeSessionId;

    const loop = await runManagedAgentRoomToolLoop({
      providerLabel: "Claude Code",
      session: input.active,
      storage: input.storage,
      initialTurn: result,
      initialContinuationId: claudeSessionId,
      getContinuationId: (turn) => turn.sessionId,
      getLatestSession: (fallback) =>
        getStoredClaudeCodeLiveSession(input.active.session_id) ?? fallback,
      onRoomToolRequest: ({ request }) => {
        const updated = updateClaudeCodeLiveSession(input.active.session_id, (current) => ({
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
        const turn = await runner.runTurn({
          prompt,
          cwd: session.cwd,
          claudeSessionId: continuationId,
          claudeBin: session.claude_bin,
          model: session.model ?? null,
          effort: session.effort ?? null,
          abortController: input.abortController,
          canUseTool: input.canUseTool,
        });
        return {
          session: getStoredClaudeCodeLiveSession(input.active.session_id) ?? session,
          turn,
        };
      },
      onLoopError: ({ continuationId, recentItems, error }) =>
        claudeCodeRoomToolErrorResult(continuationId, recentItems, error),
    });

    return { ...loop.turn, sessionId: loop.continuationId };
  }


  async function resolvePermissionRequest(
    input: DesktopManagedAgentPermissionDecisionInput,
  ): Promise<DesktopManagedAgentPermissionDecisionResult> {
    const requestId = input.requestId.trim();
    if (!requestId) {
      return {
        requestId,
        accepted: false,
        message: "Permission request id is required.",
        session: null,
      };
    }
    const requestSession = findSessionWithPendingPermissionRequest(requestId, input.sessionId);
    if (!requestSession) {
      return {
        requestId,
        accepted: false,
        message: "Permission request is no longer pending.",
        session: null,
      };
    }
    if (!isManagedAgentPermissionDecisionBehavior(input.behavior)) {
      return {
        requestId,
        accepted: false,
        message: "Permission behavior must be allow or deny.",
        session: toPublicClaudeCodeManagedAgentSession(requestSession),
      };
    }
    resolvePendingPermissionRequest({
      requestId,
      behavior: input.behavior,
      message: input.message?.trim() || null,
      source: "desktop",
    });
    const updated = getStoredClaudeCodeLiveSession(requestSession.session_id);
    return {
      requestId,
      accepted: true,
      message: input.behavior === "allow" ? "Permission allowed." : "Permission denied.",
      session: updated ? toPublicClaudeCodeManagedAgentSession(updated) : null,
    };
  }

  return {
    providerId: "claude-code",
    listSessions,
    start,
    inspect,
    stop,
    dispatchRoomStreamEvent,
    waitForIdle: engine.waitForIdle,
    resolvePermissionRequest,
  };

  function buildClaudeCodePermissionHandler(input: {
    sessionId: string;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortSignal: AbortSignal;
  }): CanUseTool {
    return async (toolName, toolInput, options): Promise<PermissionResult> => {
      if (isBlockedClaudeCodeTool(toolName)) {
        return {
          behavior: "deny",
          message: "Managed Claude Code sessions may not call LetAgents room, rental, or provisioning tools.",
          toolUseID: options.toolUseID,
        };
      }
      if (isAutoAllowedManagedAgentTool(toolName)) {
        return allowClaudeCodeToolUse(toolInput, options.toolUseID);
      }
      const session = getStoredClaudeCodeLiveSession(input.sessionId);
      const profile = managedAgentPermissionProfileForProvider("claude-code", session?.permission_profile_id);
      if (profile.id === "read_only") {
        return {
          behavior: "deny",
          message: "This Claude Code managed agent is running with the read-only permission profile.",
          toolUseID: options.toolUseID,
        };
      }
      if (profile.id === "full_access") {
        return allowClaudeCodeToolUse(toolInput, options.toolUseID);
      }
      return await requestClaudeCodeToolPermission({
        ...input,
        toolName,
        toolInput,
        toolUseId: options.toolUseID,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        permissionSignal: options.signal,
      });
    };
  }

  async function requestClaudeCodeToolPermission(input: {
    sessionId: string;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortSignal: AbortSignal;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
    permissionSignal: AbortSignal;
  }): Promise<PermissionResult> {
    const session = getStoredClaudeCodeLiveSession(input.sessionId);
    if (!session) {
      return {
        behavior: "deny",
        message: "Claude Code session is no longer available.",
        toolUseID: input.toolUseId,
      };
    }
    const request = createManagedAgentPermissionRequest({
      providerId: "claude-code",
      sessionId: session.session_id,
      toolName: input.toolName,
      toolInput: input.toolInput,
      toolUseId: input.toolUseId,
      title: input.title,
      displayName: input.displayName,
      description: input.description,
      decisionReason: input.decisionReason,
      requestedAt: now(),
    });
    const published = addPendingPermissionRequest(session.session_id, request);
    if (published) {
      emitSessionUpdate(published);
    }

    try {
      const roomRequest = await publishPermissionRequest({
        session: published ?? session,
        event: input.event,
        storage: input.storage,
        request,
      });
      if (roomRequest.roomMessageId) {
        const withRoomMessage = updateClaudeCodeLiveSession(session.session_id, (current) => ({
          ...current,
          pending_permission_requests: (current.pending_permission_requests ?? []).map((candidate) =>
            candidate.id === request.id
              ? { ...candidate, roomMessageId: roomRequest.roomMessageId }
              : candidate
          ),
          updated_at: now(),
        }));
        emitSessionUpdate(withRoomMessage);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const updated = updateClaudeCodeLiveSession(session.session_id, (current) => ({
        ...current,
        recent_items: appendRecentItem(current.recent_items, {
          type: "permission_request",
          status: "room_publish_failed",
          requestId: request.id,
          toolName: request.toolName,
          error: detail,
        }),
        updated_at: now(),
      }));
      emitSessionUpdate(updated);
    }

    const decision = await waitForPermissionDecision({
      request,
      abortSignal: input.abortSignal,
      permissionSignal: input.permissionSignal,
    });
    const cleared = removePendingPermissionRequest(session.session_id, request.id, decision);
    emitSessionUpdate(cleared);

    if (decision.behavior === "allow") {
      return allowClaudeCodeToolUse(input.toolInput, input.toolUseId);
    }
    return {
      behavior: "deny",
      message: decision.message ||
        (decision.source === "system"
          ? "Permission request was cancelled."
          : "Permission denied by LetAgents Desktop."),
      interrupt: decision.source === "system",
      toolUseID: input.toolUseId,
    };
  }

  function consumePermissionDecisionEvent(event: ManagedRoomEvent): boolean {
    if (event.type !== "message") {
      return false;
    }
    if (event.message.source === "agent") {
      return false;
    }
    // Room messages do not currently expose a stable authenticated account id to the desktop stream.
    // Treat approval-looking room replies as handled so they cannot preempt the active turn, but never
    // resolve a permission request from public room text. The trusted approval channel is desktop IPC.
    for (const session of listDesktopManagedClaudeCodeLiveSessions(event.roomIdentifier)) {
      const pendingRequests = session.pending_permission_requests ?? [];
      if (!pendingRequests.length) {
        continue;
      }
      const decision = parseManagedAgentPermissionDecision({
        text: event.message.text,
        pendingRequests,
        replyToMessageId: event.message.replyTo?.id ?? null,
      });
      if (!decision) {
        continue;
      }
      return true;
    }
    return false;
  }

  function waitForPermissionDecision(input: {
    request: DesktopManagedAgentPermissionRequest;
    abortSignal: AbortSignal;
    permissionSignal: AbortSignal;
  }): Promise<ManagedAgentPermissionDecision> {
    if (input.abortSignal.aborted || input.permissionSignal.aborted) {
      return Promise.resolve({
        requestId: input.request.id,
        behavior: "deny",
        message: "Permission request was interrupted.",
        source: "system",
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: ManagedAgentPermissionDecision): void => {
        if (settled) {
          return;
        }
        settled = true;
        pendingPermissionResolvers.delete(input.request.id);
        clearTimeout(timeoutId);
        input.abortSignal.removeEventListener("abort", abortListener);
        input.permissionSignal.removeEventListener("abort", abortListener);
        resolve(decision);
      };
      const abortListener = (): void => {
        finish({
          requestId: input.request.id,
          behavior: "deny",
          message: "Permission request was interrupted.",
          source: "system",
        });
      };
      const timeoutId = setTimeout(() => {
        finish({
          requestId: input.request.id,
          behavior: "deny",
          message: "Permission request timed out.",
          source: "system",
        });
      }, permissionTimeoutMs);
      pendingPermissionResolvers.set(input.request.id, finish);
      input.abortSignal.addEventListener("abort", abortListener, { once: true });
      input.permissionSignal.addEventListener("abort", abortListener, { once: true });
    });
  }

  function resolvePendingPermissionRequest(decision: ManagedAgentPermissionDecision): void {
    pendingPermissionResolvers.get(decision.requestId)?.(decision);
  }

  function findSessionWithPendingPermissionRequest(
    requestId: string,
    sessionId?: string | null,
  ): DesktopClaudeCodeLiveSessionState | null {
    const sessions = listDesktopManagedClaudeCodeLiveSessions();
    return sessions.find((session) =>
      (!sessionId || session.session_id === sessionId) &&
      (session.pending_permission_requests ?? []).some((request) => request.id === requestId)
    ) ?? null;
  }

  function addPendingPermissionRequest(
    sessionId: string,
    request: DesktopManagedAgentPermissionRequest,
  ): DesktopClaudeCodeLiveSessionState | null {
    return updateClaudeCodeLiveSession(sessionId, (current) => ({
      ...current,
      active_work: current.active_work
        ? {
          ...current.active_work,
          summary: `Waiting for permission to use ${request.toolName}.`,
        }
        : current.active_work,
      pending_permission_requests: [
        ...(current.pending_permission_requests ?? []).filter((candidate) => candidate.id !== request.id),
        request,
      ],
      recent_items: appendRecentItem(current.recent_items, {
        type: "permission_request",
        status: "pending",
        requestId: request.id,
        toolName: request.toolName,
        title: request.title,
      }),
      updated_at: now(),
    }));
  }

  function removePendingPermissionRequest(
    sessionId: string,
    requestId: string,
    decision: ManagedAgentPermissionDecision,
  ): DesktopClaudeCodeLiveSessionState | null {
    return updateClaudeCodeLiveSession(sessionId, (current) => ({
      ...current,
      pending_permission_requests: removeManagedAgentPermissionRequest(
        current.pending_permission_requests,
        requestId,
      ),
      recent_items: appendRecentItem(current.recent_items, {
        type: "permission_decision",
        status: decision.behavior,
        source: decision.source,
        requestId,
      }),
      updated_at: now(),
    }));
  }

  function clearPendingPermissionRequestsForSession(
    sessionId: string,
    message = "Permission request ended with the turn.",
  ): void {
    for (const request of getStoredClaudeCodeLiveSession(sessionId)?.pending_permission_requests ?? []) {
      resolvePendingPermissionRequest({
        requestId: request.id,
        behavior: "deny",
        message,
        source: "system",
      });
    }
    const cleared = updateClaudeCodeLiveSession(sessionId, (current) => ({
      ...current,
      pending_permission_requests: [],
      updated_at: now(),
    }));
    emitSessionUpdate(cleared);
  }
}

function isManagedRoomStreamEvent(event: DesktopRoomStreamEvent): event is ManagedRoomEvent {
  return event.type === "message" || event.type === "task_update";
}


async function publishDesktopManagedClaudeCodeReply(input: PublishClaudeCodeReplyInput): Promise<void> {
  await publishDesktopManagedWorkerReply({
    provider: CLAUDE_CODE_WORKER_PROVIDER,
    sessionToken: input.session.token,
    agentSessionId: input.session.agent_session_id,
    sessionKey: claudeCodeReplyChangeSessionKey(input.session.session_id),
    publicSession: () => toPublicClaudeCodeManagedAgentSession(input.session),
    roomIdentifier: input.session.room_identifier || input.session.room_id,
    storage: input.storage,
    event: input.event,
    text: input.text,
    beforeChangeSignature: input.beforeChangeSignature ?? null,
    onMissingWorkerSession: () => {
      updateClaudeCodeLiveSession(input.session.session_id, (current) => ({
        ...current,
        status: "unknown",
        last_error: "Claude Code produced a room reply before the desktop worker session was available.",
        updated_at: new Date().toISOString(),
      }));
    },
  });
}

async function publishDesktopManagedClaudeCodePermissionRequest(
  input: PublishClaudeCodePermissionRequestInput,
): Promise<PublishClaudeCodePermissionRequestResult> {
  const workerSession = getStoredAgentSession(input.session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) {
    return { roomMessageId: null };
  }

  const roomIdentifier = input.session.room_identifier || input.session.room_id;
  const text = buildManagedAgentPermissionRoomText({
    request: input.request,
    agentDisplayName: input.session.display_name,
  });
  const localReply = await persistDesktopManagedAgentLocalReply({
    roomIdentifier,
    storage: input.storage,
    workerSession,
    replyTo: null,
    text,
  });
  if (localReply) {
    const { emitPersistedLocalRoomMessage } = await import("../room-stream.js");
    emitPersistedLocalRoomMessage(roomIdentifier, localReply);
    return { roomMessageId: localReply.id };
  }

  const { apiFetch } = await import("../auth.js");
  const { cloudRoomIdentifierForStorage } = await import("../rooms/local-store.js");
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(input.storage, roomIdentifier);
  const created = await apiFetch<{ id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        text,
        agent_session_id: workerSession.session_id,
        agent_session_token: workerSession.session_token,
      }),
    },
  );
  return {
    roomMessageId: typeof created.id === "string" ? created.id : null,
  };
}

async function registerDesktopManagedClaudeCodeWorker(
  input: RegisterClaudeCodeWorkerInput,
): Promise<StoredAgentSessionState> {
  return registerDesktopManagedWorker(CLAUDE_CODE_WORKER_PROVIDER, input);
}

async function disconnectDesktopManagedClaudeCodeWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  await disconnectDesktopManagedWorker(session);
}

function emitClaudeCodeManagedAgentSessionUpdate(
  session: DesktopClaudeCodeLiveSessionState | null | undefined,
): void {
  if (!session) {
    return;
  }
  void import("../window.js")
    .then(({ emitToMainWindow }) => {
      emitToMainWindow(
        "desktop:workers:managed-agent-session",
        toPublicClaudeCodeManagedAgentSession(session),
      );
    })
    .catch(() => undefined);
}

function findStoredClaudeCodeSession(
  sessionId?: string | null,
  roomIdentifier?: string | null,
): DesktopClaudeCodeLiveSessionState | null {
  if (sessionId?.trim()) {
    return getStoredClaudeCodeLiveSession(sessionId.trim());
  }
  return getCurrentClaudeCodeLiveSession(roomIdentifier?.trim() || undefined);
}

async function runClaudeCodeProviderPreflight(
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

function joinedViaForRoomIdentifier(roomIdentifier: string): DesktopClaudeCodeJoinedVia {
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

function makeClaudeCodeStopToken(): string {
  return `LOCAL_CLAUDE_CODE_ROOM_${randomUUID()}`;
}

function appendRecentItem(
  items: Array<Record<string, unknown>> | null | undefined,
  item: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const next = [...(items ?? []), item];
  return next.slice(Math.max(0, next.length - 12));
}
