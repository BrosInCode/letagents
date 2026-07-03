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
  desktopEventPublicReplyText,
} from "./codex-event-prompt.js";
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
  getOrCreateDesktopHostId,
  getStoredAgentIdentityForRuntimeKey,
  getStoredAgentSession,
  getStoredClaudeCodeLiveSession,
  listClaudeCodeDisplayNamesForRoom,
  listDesktopManagedClaudeCodeLiveSessions,
  markAgentSessionEnded,
  saveAgentSession,
  saveClaudeCodeLiveSession,
  saveStoredAgentIdentity,
  toPublicClaudeCodeManagedAgentSession,
  updateClaudeCodeLiveSession,
  type DesktopClaudeCodeJoinedVia,
  type DesktopClaudeCodeLiveSessionState,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
} from "./state.js";
import {
  assertManagedAgentPermissionProfileAvailable,
  managedAgentPermissionProfileForProvider,
} from "./managed-agent-permission-profiles.js";
import type { DesktopManagedAgentRuntime } from "./managed-agent-runtime.js";
import {
  desktopManagedAgentReplyTargetForMessage,
  persistDesktopManagedAgentLocalReply,
  type DesktopManagedAgentReplyTarget,
} from "./managed-agent-local-replies.js";
import {
  buildManagedAgentRoomToolResultPrompt,
  DESKTOP_EVENT_ROOM_TOOL_REQUEST_LIMIT,
  executeManagedAgentRoomToolRequestWithTimeout,
  hasManagedAgentRoomToolRequestLine,
  parseManagedAgentRoomToolRequest,
  type ManagedAgentRoomToolCache,
} from "./managed-agent-room-tools.js";

const DEFAULT_CLAUDE_CODE_STOP_PHRASE = "/stop-claude-code-room";

type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;

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

type ActiveClaudeCodeTurn = {
  abortController: AbortController;
  interruptReason: "preempt" | "stop" | null;
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
  const queues = new Map<string, Promise<void>>();
  const activeTurns = new Map<string, ActiveClaudeCodeTurn>();
  const pendingPermissionResolvers = new Map<string, (decision: ManagedAgentPermissionDecision) => void>();

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
      repoRootPath: cwd,
    });
    if (!preflightResult.canStart) {
      throw new Error(preflightResult.detail || preflightResult.message);
    }
    const permissionProfile = assertManagedAgentPermissionProfileAvailable("claude-code", input.permissionProfileId);

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

    const activeTurn = activeTurns.get(session.session_id);
    if (activeTurn) {
      activeTurn.interruptReason = "stop";
      activeTurn.abortController.abort();
    }
    clearPendingPermissionRequestsForSession(
      session.session_id,
      "Permission request was cancelled because the managed agent session stopped.",
    );
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
      .filter((session) => shouldDeliverRoomStreamEventToClaudeCodeSession(session, event));
    for (const session of sessions) {
      enqueueDesktopEventTurn(session, event);
    }
  }

  function enqueueDesktopEventTurn(
    session: DesktopClaudeCodeLiveSessionState,
    event: ManagedRoomEvent,
  ): void {
    preemptActiveTurn(session.session_id);
    const previous = queues.get(session.session_id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => deliverDesktopEventTurn(session.session_id, event, await resolveStorage(event.roomIdentifier)))
      .catch((error) => {
        const updated = clearSessionActiveWork(session.session_id, (current) => ({
          ...current,
          status: "unknown",
          last_error: error instanceof Error ? error.message : String(error),
          updated_at: now(),
        }));
        emitSessionUpdate(updated);
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
    const session = getStoredClaudeCodeLiveSession(sessionId);
    if (!session || !canDeliverDesktopEventToClaudeCodeSession(session)) {
      return;
    }

    const stopAfterTurn = isStopPhraseRoomStreamEvent(session, event);
    const active = markSessionActiveForEvent(session, event);
    const abortController = new AbortController();
    const activeTurn: ActiveClaudeCodeTurn = {
      abortController,
      interruptReason: null,
    };
    activeTurns.set(session.session_id, activeTurn);
    try {
      const result = await runClaudeCodeDesktopEventTurnWithRoomTools({
        active,
        event,
        storage,
        abortController,
        canUseTool: buildClaudeCodePermissionHandler({
          sessionId,
          event,
          storage,
          abortSignal: abortController.signal,
        }),
      });

      const latest = getStoredClaudeCodeLiveSession(sessionId) ?? active;
      if (
        latest.status === "interrupted" &&
        abortController.signal.aborted &&
        activeTurn.interruptReason !== "preempt"
      ) {
        return;
      }

      if (result.status === "error") {
        const wasPreempted = abortController.signal.aborted && activeTurn.interruptReason === "preempt";
        const updated = clearSessionActiveWork(sessionId, (current) => ({
          ...current,
          claude_session_id: result.sessionId ?? current.claude_session_id ?? null,
          status: wasPreempted ? "completed" : abortController.signal.aborted ? "interrupted" : "unknown",
          last_error: wasPreempted ? null : result.error,
          recent_items: result.recentItems,
          updated_at: now(),
        }));
        emitSessionUpdate(updated);
        return;
      }

      const completed = clearSessionActiveWork(sessionId, (current) => ({
        ...current,
        claude_session_id: result.sessionId ?? current.claude_session_id ?? null,
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
      });
      if (stopAfterTurn) {
        await stopAfterRoomStopPhrase(completed);
      }
    } finally {
      clearPendingPermissionRequestsForSession(session.session_id);
      if (activeTurns.get(session.session_id) === activeTurn) {
        activeTurns.delete(session.session_id);
      }
    }
  }

  async function runClaudeCodeDesktopEventTurnWithRoomTools(input: {
    active: DesktopClaudeCodeLiveSessionState;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortController: AbortController;
    canUseTool: CanUseTool;
  }): Promise<ClaudeCodeTurnResult> {
    const roomToolCache: ManagedAgentRoomToolCache = new Map();
    let claudeSessionId = input.active.claude_session_id ?? null;
    let result = await runner.runTurn({
      prompt: buildClaudeCodeDesktopEventPrompt(input.active, input.event),
      cwd: input.active.cwd,
      claudeSessionId,
      claudeBin: input.active.claude_bin,
      abortController: input.abortController,
      canUseTool: input.canUseTool,
    });
    claudeSessionId = result.sessionId ?? claudeSessionId;

    for (let requestCount = 0; requestCount < DESKTOP_EVENT_ROOM_TOOL_REQUEST_LIMIT; requestCount += 1) {
      if (result.status === "error") {
        return result;
      }
      const request = parseManagedAgentRoomToolRequest(result.text);
      if (!request) {
        if (hasManagedAgentRoomToolRequestLine(result.text)) {
          return claudeCodeRoomToolErrorResult(
            claudeSessionId,
            result.recentItems,
            "Claude Code emitted a malformed desktop room tool request.",
          );
        }
        return { ...result, sessionId: claudeSessionId };
      }

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

      const latest = getStoredClaudeCodeLiveSession(input.active.session_id) ?? input.active;
      const roomToolResult = await executeManagedAgentRoomToolRequestWithTimeout({
        session: latest,
        storage: input.storage,
        request,
        cache: roomToolCache,
      });
      result = await runner.runTurn({
        prompt: buildManagedAgentRoomToolResultPrompt(roomToolResult),
        cwd: latest.cwd,
        claudeSessionId,
        claudeBin: latest.claude_bin,
        abortController: input.abortController,
        canUseTool: input.canUseTool,
      });
      claudeSessionId = result.sessionId ?? claudeSessionId;
    }

    if (parseManagedAgentRoomToolRequest(result.text)) {
      return claudeCodeRoomToolErrorResult(
        claudeSessionId,
        result.recentItems,
        `Claude Code requested more than ${DESKTOP_EVENT_ROOM_TOOL_REQUEST_LIMIT} desktop room tools for one room event.`,
      );
    }
    if (hasManagedAgentRoomToolRequestLine(result.text)) {
      return claudeCodeRoomToolErrorResult(
        claudeSessionId,
        result.recentItems,
        "Claude Code emitted a malformed desktop room tool request.",
      );
    }

    return { ...result, sessionId: claudeSessionId };
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
    session: DesktopClaudeCodeLiveSessionState,
    event: ManagedRoomEvent,
  ): DesktopClaudeCodeLiveSessionState {
    const activeWork = activeWorkForEvent(event, now());
    const updated = updateClaudeCodeLiveSession(session.session_id, (current) => ({
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
    updater: (session: DesktopClaudeCodeLiveSessionState) => DesktopClaudeCodeLiveSessionState,
  ): DesktopClaudeCodeLiveSessionState | null {
    return updateClaudeCodeLiveSession(sessionId, (current) => ({
      ...updater(current),
      active_work: null,
    }));
  }

  async function stopAfterRoomStopPhrase(session: DesktopClaudeCodeLiveSessionState): Promise<void> {
    const updated = updateClaudeCodeLiveSession(session.session_id, (current) => ({
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
    waitForIdle,
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

function canDeliverDesktopEventToClaudeCodeSession(session: DesktopClaudeCodeLiveSessionState): boolean {
  const worker = toPublicClaudeCodeManagedAgentSession(session);
  return (session.delivery_mode || "desktop_events") === "desktop_events" &&
    Boolean(worker.agentSessionId) &&
    session.status !== "interrupted" &&
    session.status !== "failed";
}

function shouldDeliverRoomStreamEventToClaudeCodeSession(
  session: DesktopClaudeCodeLiveSessionState,
  event: ManagedRoomEvent,
): boolean {
  if (!canDeliverDesktopEventToClaudeCodeSession(session) || isOwnRoomStreamEvent(session, event)) {
    return false;
  }

  if (event.type !== "task_update") {
    return true;
  }

  const worker = toPublicClaudeCodeManagedAgentSession(session);
  const workerKeys = [
    worker.agentSessionId,
    specificAgentKey(worker.agentKey),
    worker.actorLabel,
    worker.displayName,
  ].map(normalizeKey).filter(Boolean);
  const taskTargetKeys = [
    specificAgentKey(event.task.assigneeAgentKey),
    event.task.assignee,
    ...event.task.activeLeases
      .filter((lease) => lease.status === "active")
      .flatMap((lease) => [lease.agentSessionId, specificAgentKey(lease.agentKey), lease.holderLabel]),
  ].map(normalizeKey).filter(Boolean);

  return !taskTargetKeys.length || workerKeys.some((key) => taskTargetKeys.includes(key));
}

function isOwnRoomStreamEvent(
  session: DesktopClaudeCodeLiveSessionState,
  event: ManagedRoomEvent,
): boolean {
  if (event.type !== "message") {
    return false;
  }

  const worker = toPublicClaudeCodeManagedAgentSession(session);
  const message = event.message;
  const messageStableKeys = [
    message.agentIdentity?.agentSessionId,
    specificAgentKey(message.agentIdentity?.agentKey),
  ].map(normalizeKey).filter(Boolean);
  const workerStableKeys = [
    worker.agentSessionId,
    specificAgentKey(worker.agentKey),
  ].map(normalizeKey).filter(Boolean);
  if (workerStableKeys.some((key) => messageStableKeys.includes(key))) {
    return true;
  }

  const messageNames = [
    message.actorLabel,
    message.agentIdentity?.actorLabel,
    message.agentIdentity?.displayName,
    message.sender,
  ].map(normalizeKey).filter(Boolean);
  const workerNames = [
    worker.actorLabel,
    worker.displayName,
  ].map(normalizeKey).filter(Boolean);
  return Boolean(messageNames.length && workerNames.some((key) => messageNames.includes(key)));
}

function isStopPhraseRoomStreamEvent(
  session: DesktopClaudeCodeLiveSessionState,
  event: ManagedRoomEvent,
): boolean {
  return event.type === "message" && event.message.text === session.stop_phrase;
}

function activeWorkForEvent(
  event: ManagedRoomEvent,
  startedAt: string,
): NonNullable<DesktopClaudeCodeLiveSessionState["active_work"]> {
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

async function publishDesktopManagedClaudeCodeReply(input: PublishClaudeCodeReplyInput): Promise<void> {
  const text = desktopEventPublicReplyText(input.session.token, input.text);
  if (!text) {
    return;
  }

  const workerSession = getStoredAgentSession(input.session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) {
    updateClaudeCodeLiveSession(input.session.session_id, (current) => ({
      ...current,
      status: "unknown",
      last_error: "Claude Code produced a room reply before the desktop worker session was available.",
      updated_at: new Date().toISOString(),
    }));
    return;
  }

  const roomIdentifier = input.session.room_identifier || input.session.room_id;
  const replyTarget = replyTargetForEvent(input.event);
  const localReply = await persistDesktopManagedAgentLocalReply({
    roomIdentifier,
    storage: input.storage,
    workerSession,
    replyTo: replyTarget.replyTo,
    threadRootId: replyTarget.threadRootId,
    text,
  });
  if (localReply) {
    const { emitPersistedLocalRoomMessage } = await import("../room-stream.js");
    emitPersistedLocalRoomMessage(roomIdentifier, localReply);
    return;
  }

  const { apiFetch } = await import("../auth.js");
  const { cloudRoomIdentifierForStorage } = await import("../rooms/local-store.js");
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(input.storage, roomIdentifier);
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
      }),
    },
  );
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
  const identity = await ensureDesktopManagedClaudeCodeIdentity(input.displayName);
  const actorKey = normalizeDisplayText(identity.canonical_key, "");
  if (!actorKey) {
    throw new Error("LetAgents desktop Claude Code identity is missing an actor key.");
  }

  const runtime = `claude-code:${input.token}`;
  const agentInstanceId = `desktop-claude-code:${input.token}`;
  const { apiFetch } = await import("../auth.js");
  const created = await apiFetch<AgentSessionCreateResponse>(
    `/rooms/${encodeURIComponent(input.roomIdentifier)}/agent-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor_key: actorKey,
        actor_label: identity.actor_label,
        ide_label: "Claude Code",
        agent_instance_id: agentInstanceId,
        display_name: input.displayName,
        session_kind: "worker",
        runtime,
        repo_branch: input.repoBranch,
        registration_liveness: claudeCodeSessionLivenessRegistration(runtime, input.token),
      }),
    },
  );

  return saveAgentSession(toStoredClaudeCodeAgentSession(created, {
    roomIdentifier: input.roomIdentifier,
    runtime,
    identity,
    agentInstanceId,
    displayName: input.displayName,
  }));
}

async function disconnectDesktopManagedClaudeCodeWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  if (!session?.session_id || !session.session_token) {
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

async function ensureDesktopManagedClaudeCodeIdentity(displayName: string): Promise<StoredAgentIdentityState> {
  const requestedName = normalizeAgentIdentityName(displayName, "desktop-claude-code");
  const requestedDisplayName = normalizeDisplayText(displayName, "Claude Code");
  const runtimeKey = `desktop-claude-code:${requestedName}`;
  const existingForName = getStoredAgentIdentityForRuntimeKey(runtimeKey);
  if (isUsableAgentIdentity(existingForName)) {
    return existingForName;
  }

  const { apiFetch, readStoredAuth } = await import("../auth.js");
  const storedAuth = await readStoredAuth();
  if (!storedAuth.token) {
    throw new Error("Sign into LetAgents Desktop before starting a supervised Claude Code agent.");
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
    throw new Error("LetAgents did not return a usable agent identity for the desktop Claude Code worker.");
  }

  const resolvedDisplayName = normalizeDisplayText(registered.display_name, requestedDisplayName);
  const resolvedOwnerLabel = normalizeDisplayText(registered.owner_label, ownerLabel);
  const now = new Date().toISOString();
  return saveStoredAgentIdentity({
    name: normalizeDisplayText(registered.name, requestedName),
    display_name: resolvedDisplayName,
    owner_label: resolvedOwnerLabel,
    owner_attribution: formatOwnerAttribution(resolvedOwnerLabel),
    ide_label: "Claude Code",
    actor_label: buildAgentActorLabel({
      displayName: resolvedDisplayName,
      ownerLabel: resolvedOwnerLabel,
      ideLabel: "Claude Code",
    }),
    canonical_key: canonicalKey,
    runtime_key: runtimeKey,
    source: "api",
    resolved_at: now,
  });
}

function toStoredClaudeCodeAgentSession(
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
        ideLabel: "Claude Code",
      }),
    ),
    agent_key: normalizeDisplayText(created.agent_key, input.identity.canonical_key ?? ""),
    agent_instance_id: normalizeDisplayText(created.agent_instance_id, input.agentInstanceId),
    display_name: normalizeDisplayText(created.display_name, input.displayName),
    owner_label: normalizeDisplayText(created.owner_label, input.identity.owner_label),
    ide_label: normalizeDisplayText(created.ide_label, "Claude Code"),
    repo_branch: normalizeDisplayText(created.repo_branch, "") || null,
    created_at: createdAt,
    updated_at: updatedAt,
    last_seen_at: normalizeDisplayText(created.last_seen_at, updatedAt),
    ended_at: created.ended_at ?? null,
  };
}

function claudeCodeSessionLivenessRegistration(runtime: string, token: string): Record<string, string | null> {
  const hostId = getOrCreateDesktopHostId();
  return {
    host_id: hostId,
    host_kind: process.platform === "darwin" ? "macos" : process.platform,
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_claude_code_sdk",
    tool_bridge_id: `${hostId}:${runtime}:desktop:${token}`,
  };
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

function normalizeKey(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function specificAgentKey(value: string | null | undefined): string {
  const normalized = normalizeKey(value);
  if (!normalized || !/[/:]/.test(normalized)) {
    return "";
  }
  return normalized;
}

function appendRecentItem(
  items: Array<Record<string, unknown>> | null | undefined,
  item: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const next = [...(items ?? []), item];
  return next.slice(Math.max(0, next.length - 12));
}
