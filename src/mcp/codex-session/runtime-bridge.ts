import {
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  readLocalState,
  updateCodexLiveSession,
  type CodexLiveSessionState,
  type StoredAgentSessionState,
} from "../local-state.js";
import { encodeRoomIdPath } from "../room-id.js";
import { apiCall } from "../server/runtime/api.js";
import { RpcClient, type RpcNotification } from "./rpc-client.js";
import {
  isCodexAgentSessionMarker,
  summarizeCodexRuntimeNotificationForTest,
  type CodexRuntimeReasoningSummary,
} from "./runtime-summary.js";

const CODEX_RUNTIME_STREAM_THROTTLE_MS = 750;
const CODEX_RUNTIME_STREAM_REPEAT_MS = 30_000;
const CODEX_RUNTIME_STREAM_SNAPSHOT_INTERVAL_MS = 2_000;
const CODEX_RUNTIME_STREAM_BIND_RETRY_MS = 1_000;
const CODEX_RUNTIME_STREAM_BIND_RETRY_ATTEMPTS = 30;

interface RuntimeBridgeInspection {
  session: CodexLiveSessionState;
  server_reachable: boolean;
}

export interface CodexRuntimeBridgeController {
  maybeStart(session: CodexLiveSessionState): Promise<void>;
  start(session: CodexLiveSessionState, client: RpcClient): void;
  bindForAgentSession(workerSession: StoredAgentSessionState): Promise<boolean>;
  scheduleBind(workerSession: StoredAgentSessionState, attempts?: number): void;
  stop(sessionId: string): void;
  cleanup(): void;
  postReasoningSummary(
    session: CodexLiveSessionState,
    summary: CodexRuntimeReasoningSummary
  ): Promise<void>;
}

export function createCodexRuntimeBridgeController(input: {
  inspectSession(sessionId: string): Promise<RuntimeBridgeInspection | null>;
  isTerminalStatus(status: CodexLiveSessionState["status"]): boolean;
}): CodexRuntimeBridgeController {
  const clients = new Map<string, RpcClient>();
  const snapshotTimers = new Map<string, ReturnType<typeof setInterval>>();
  const bindTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastPost = new Map<string, { signature: string; postedAt: number }>();

  async function codexBridgeApiCall<T>(path: string, options?: RequestInit): Promise<T> {
    return apiCall<T>(path, options);
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

    if (session.agent_session_id) {
      const bound = state.agent_sessions?.[session.agent_session_id] ?? null;
      if (
        bound &&
        candidates.some((candidate) => candidate.session_id === bound.session_id)
      ) {
        return bound;
      }
    }

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

  async function postReasoningSummary(
    session: CodexLiveSessionState,
    summary: CodexRuntimeReasoningSummary
  ): Promise<void> {
    const workerSession = codexWorkerSessionForLiveSession(session);
    if (!workerSession) {
      return;
    }

    const signature = `${session.session_id}:${summary.summary}:${summary.status}`;
    const previousPost = lastPost.get(session.session_id);
    if (
      previousPost?.signature === signature &&
      Date.now() - previousPost.postedAt < CODEX_RUNTIME_STREAM_REPEAT_MS
    ) {
      return;
    }
    if (previousPost && Date.now() - previousPost.postedAt < CODEX_RUNTIME_STREAM_THROTTLE_MS) {
      return;
    }
    lastPost.set(session.session_id, { signature, postedAt: Date.now() });

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

  async function postReasoningUpdate(
    session: CodexLiveSessionState,
    notification: RpcNotification
  ): Promise<void> {
    await postReasoningSummary(
      session,
      summarizeCodexRuntimeNotificationForTest(notification)
    );
  }

  function start(session: CodexLiveSessionState, client: RpcClient): void {
    stop(session.session_id);
    clients.set(session.session_id, client);
    void input.inspectSession(session.session_id).catch(() => {
      // The periodic snapshot bridge will retry while the session remains reachable.
    });
    const snapshotTimer = setInterval(() => {
      void input.inspectSession(session.session_id).then((status) => {
        if (
          !status ||
          !status.server_reachable ||
          input.isTerminalStatus(status.session.status)
        ) {
          stop(session.session_id);
        }
      }).catch(() => {
        stop(session.session_id);
      });
    }, CODEX_RUNTIME_STREAM_SNAPSHOT_INTERVAL_MS);
    snapshotTimer.unref?.();
    snapshotTimers.set(session.session_id, snapshotTimer);
  }

  async function maybeStart(session: CodexLiveSessionState): Promise<void> {
    if (clients.has(session.session_id)) {
      return;
    }

    if (!codexWorkerSessionForLiveSession(session)) {
      return;
    }

    const client = new RpcClient(session.server_url, (notification) => {
      const latest = getStoredCodexLiveSession(session.session_id) ?? session;
      void postReasoningUpdate(latest, notification).catch(() => {
        // Runtime notifications should never break the worker turn.
      });
    });
    await client.connect();
    start(session, client);
  }

  async function bindForAgentSession(workerSession: StoredAgentSessionState): Promise<boolean> {
    if (!isCodexAgentSessionMarker(workerSession) || workerSession.session_kind !== "worker") {
      return false;
    }

    const liveSession = getCurrentCodexLiveSession(workerSession.room_id);
    if (!liveSession || input.isTerminalStatus(liveSession.status)) {
      return false;
    }

    const boundSession =
      updateCodexLiveSession(liveSession.session_id, (current) => ({
        ...current,
        agent_session_id: workerSession.session_id,
        updated_at: new Date().toISOString(),
      })) ?? liveSession;

    await maybeStart(boundSession);
    return true;
  }

  function scheduleBind(
    workerSession: StoredAgentSessionState,
    attempts = CODEX_RUNTIME_STREAM_BIND_RETRY_ATTEMPTS
  ): void {
    if (!isCodexAgentSessionMarker(workerSession) || workerSession.session_kind !== "worker") {
      return;
    }

    const existing = bindTimers.get(workerSession.session_id);
    if (existing) {
      clearTimeout(existing);
    }

    const attemptBind = (remainingAttempts: number) => {
      void bindForAgentSession(workerSession)
        .then((bound) => {
          if (bound || remainingAttempts <= 1) {
            bindTimers.delete(workerSession.session_id);
            return;
          }

          const timer = setTimeout(
            () => attemptBind(remainingAttempts - 1),
            CODEX_RUNTIME_STREAM_BIND_RETRY_MS
          );
          timer.unref?.();
          bindTimers.set(workerSession.session_id, timer);
        })
        .catch(() => {
          if (remainingAttempts <= 1) {
            bindTimers.delete(workerSession.session_id);
            return;
          }

          const timer = setTimeout(
            () => attemptBind(remainingAttempts - 1),
            CODEX_RUNTIME_STREAM_BIND_RETRY_MS
          );
          timer.unref?.();
          bindTimers.set(workerSession.session_id, timer);
        });
    };

    attemptBind(attempts);
  }

  function stop(sessionId: string): void {
    const client = clients.get(sessionId);
    if (client) {
      client.close();
      clients.delete(sessionId);
    }
    const snapshotTimer = snapshotTimers.get(sessionId);
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimers.delete(sessionId);
    }
    lastPost.delete(sessionId);
  }

  function cleanup(): void {
    for (const client of clients.values()) {
      client.close();
    }
    clients.clear();

    for (const timer of snapshotTimers.values()) {
      clearInterval(timer);
    }
    snapshotTimers.clear();

    for (const timer of bindTimers.values()) {
      clearTimeout(timer);
    }
    bindTimers.clear();

    lastPost.clear();
  }

  return {
    maybeStart,
    start,
    bindForAgentSession,
    scheduleBind,
    stop,
    cleanup,
    postReasoningSummary,
  };
}
