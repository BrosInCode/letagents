import type {
  DesktopManagedAgentSession,
  DesktopManagedAgentSessionStatus,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import {
  canDeliverDesktopEventToManagedAgent,
  isStopPhraseRoomStreamEvent,
} from "./codex-event-routing.js";
import { cleanupAgentSessionAttachments } from "./managed-agent-attachments.js";
import {
  clearDesktopManagedAgentReplyChangeState,
  desktopManagedAgentReplyChangeSignature,
} from "./managed-agent-reply-changes.js";
import {
  getStoredAgentSession,
  type DesktopManagedLiveSessionBase,
  type StoredAgentSessionState,
} from "./state.js";

type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;

// After this many consecutive failed turns the session is parked as "failed"
// (terminal) instead of "unknown", which stays deliverable: a session that
// errors on every turn (for example an unsupported model) would otherwise
// keep consuming room events forever while being hidden from every UI list.
// Providers may override this via `maxConsecutiveTurnErrors` — Codex passes
// Infinity to preserve its historical no-budget infinite-retry behavior.
const MAX_CONSECUTIVE_TURN_ERRORS = 3;

type ActiveEventTurn = {
  abortController: AbortController;
  interruptReason: "preempt" | "stop" | null;
};

export type ManagedAgentEventTurnResult = {
  sessionId: string | null;
  text: string | null;
  /** Only "error" is meaningful to the engine; success statuses vary per provider. */
  status: string;
  error?: string | null;
};

export interface ManagedAgentEventTurnEngineAdapter<
  TSession extends DesktopManagedLiveSessionBase,
  TTurn extends ManagedAgentEventTurnResult,
> {
  now(): string;
  resolveStorage(roomIdentifier: string): Promise<DesktopRoomStorageState>;
  /**
   * When true, `resolveStorage` is invoked at enqueue time and the resulting
   * storage snapshot is threaded to the delivery, so a room whose storage mode
   * flips while the event sits queued behind an active turn still publishes to
   * the destination that was in effect when the event arrived (Codex). Default
   * false: storage resolves when the delivery reaches the front of the queue
   * (claude/cursor behavior, unchanged).
   */
  resolveStorageAtEnqueue?: boolean;
  getStoredSession(sessionId: string): TSession | null;
  toPublicSession(session: TSession): DesktopManagedAgentSession;
  updateSession(
    sessionId: string,
    updater: (session: TSession) => TSession,
  ): TSession | null;
  emitSessionUpdate(session: TSession | null | undefined): void;
  publishReply(input: {
    session: TSession;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    text: string | null;
    beforeChangeSignature?: string | null;
  }): Promise<void>;
  /**
   * Optional readiness preflight, awaited after the deliverability guard but
   * BEFORE the session is marked active for the event and before the change
   * baseline (`beforeChangeSignature`) is captured. Codex moves its transport
   * readiness probe and wait-for-current-turn-to-idle here so that a previous
   * turn's working-tree changes land in the new event's baseline and the
   * session is never shown active for an event it has not started.
   *
   * Return the refreshed session to run the turn against, or null to skip the
   * delivery silently (for example the session went terminal while waiting).
   * The engine re-checks deliverability on the returned session, mirroring the
   * historical codex flow. Thrown errors route to the enqueue error handler.
   */
  beforeTurnReadiness?(input: {
    session: TSession;
    event: ManagedRoomEvent;
  }): Promise<TSession | null>;
  /** Run one full provider turn (including any room-tool loop). */
  runTurn(input: {
    active: TSession;
    event: ManagedRoomEvent;
    storage: DesktopRoomStorageState;
    abortController: AbortController;
  }): Promise<TTurn>;
  /**
   * Fold the provider-specific turn-result fields (continuation session id,
   * recent items) into the stored session. The engine owns status,
   * last_error, active_work, and updated_at.
   */
  applyTurnResult(current: TSession, result: TTurn): TSession;
  /**
   * Preemption policy for a newly enqueued event. Claude Code preempts the
   * active turn unconditionally; Cursor only preempts when the session is
   * not running in force (write) mode, so an in-flight write is never
   * interrupted. This is deliberately per-provider — do not default it.
   */
  shouldPreemptOnEnqueue(session: TSession): boolean;
  replyChangeSessionKey(sessionId: string): string;
  disconnectWorker(session: StoredAgentSessionState | null): Promise<void>;
  /**
   * Consecutive turn errors tolerated before a session is parked as "failed".
   * Defaults to 3 (claude/cursor). Codex passes Infinity so it never parks and
   * keeps retrying against "unknown", matching its historical behavior.
   */
  maxConsecutiveTurnErrors?: number;
  /**
   * Preserve providers whose stop phrase historically ended the session even
   * when the acknowledgement turn returned an error. Defaults to false so the
   * existing Claude Code and Cursor behavior is unchanged.
   */
  stopAfterTurnOnError?: boolean;
  /**
   * Optional post-turn status derivation for the error branch. When provided
   * and it returns a status, that status/last_error is persisted instead of the
   * engine's budget-based ladder. Codex uses this to preserve its richer status
   * machine (for example a "failed" session whose owned app-server exited must
   * stay terminal rather than becoming a "unknown" that retries forever). Not
   * called on preempt/abort. Return null/undefined to fall back to the ladder.
   */
  resolveErrorTurnStatus?(
    session: TSession,
    result: TTurn,
  ): { status: DesktopManagedAgentSessionStatus; lastError: string | null } | null | undefined;
  /** Extra per-provider cleanup when a session is parked as exhausted. */
  onSessionParked?(sessionId: string): void;
  /** Extra per-provider cleanup when a delivery finishes (success or not). */
  onDeliverFinally?(sessionId: string): void;
}

export interface ManagedAgentEventTurnEngine<TSession> {
  enqueueDesktopEventTurn(session: TSession, event: ManagedRoomEvent): void;
  preemptActiveTurn(sessionId: string): void;
  interruptActiveTurnForStop(sessionId: string): void;
  resetTurnErrorBudget(sessionId: string): void;
  waitForIdle(): Promise<void>;
}

export function createManagedAgentEventTurnEngine<
  TSession extends DesktopManagedLiveSessionBase,
  TTurn extends ManagedAgentEventTurnResult,
>(
  adapter: ManagedAgentEventTurnEngineAdapter<TSession, TTurn>,
): ManagedAgentEventTurnEngine<TSession> {
  const queues = new Map<string, Promise<void>>();
  const activeTurns = new Map<string, ActiveEventTurn>();
  const consecutiveTurnErrors = new Map<string, number>();
  const maxConsecutiveTurnErrors = adapter.maxConsecutiveTurnErrors ?? MAX_CONSECUTIVE_TURN_ERRORS;

  function recordConsecutiveTurnError(sessionId: string): boolean {
    const errorCount = (consecutiveTurnErrors.get(sessionId) ?? 0) + 1;
    consecutiveTurnErrors.set(sessionId, errorCount);
    return errorCount >= maxConsecutiveTurnErrors;
  }

  function exhaustedTurnError(errorText: string): string {
    return `Stopped after ${maxConsecutiveTurnErrors} consecutive turn errors. Last error: ${errorText}`;
  }

  /**
   * Parked sessions are hidden and cannot be stopped from the UI, so ending
   * the worker registration here is what releases presence and server-side
   * session state.
   */
  async function endExhaustedSessionWorker(sessionId: string): Promise<void> {
    adapter.onSessionParked?.(sessionId);
    clearDesktopManagedAgentReplyChangeState(adapter.replyChangeSessionKey(sessionId));
    cleanupAgentSessionAttachments(sessionId);
    consecutiveTurnErrors.delete(sessionId);
    const liveSession = adapter.getStoredSession(sessionId);
    await adapter.disconnectWorker(getStoredAgentSession(liveSession?.agent_session_id ?? null));
  }

  function activeWorkForEvent(
    event: ManagedRoomEvent,
    startedAt: string,
  ): NonNullable<DesktopManagedLiveSessionBase["active_work"]> {
    return {
      kind: event.type,
      event_id: event.type === "message" ? event.message.id : event.task.id,
      started_at: startedAt,
      summary: event.type === "message" ? "Reading the room message." : "Reading the task update.",
    };
  }

  function markSessionActiveForEvent(session: TSession, event: ManagedRoomEvent): TSession {
    const activeWork = activeWorkForEvent(event, adapter.now());
    const updated = adapter.updateSession(session.session_id, (current) => ({
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
    adapter.emitSessionUpdate(updated);
    return updated;
  }

  function clearSessionActiveWork(
    sessionId: string,
    updater: (session: TSession) => TSession,
  ): TSession | null {
    return adapter.updateSession(sessionId, (current) => ({
      ...updater(current),
      active_work: null,
    }));
  }

  async function stopAfterRoomStopPhrase(session: TSession): Promise<void> {
    const updated = adapter.updateSession(session.session_id, (current) => ({
      ...current,
      status: "interrupted",
      active_work: null,
      last_error: null,
      updated_at: adapter.now(),
    })) ?? session;
    adapter.emitSessionUpdate(updated);
    await adapter.disconnectWorker(getStoredAgentSession(updated.agent_session_id));
  }

  function enqueueDesktopEventTurn(session: TSession, event: ManagedRoomEvent): void {
    if (adapter.shouldPreemptOnEnqueue(session)) {
      preemptActiveTurn(session.session_id);
    }
    // Codex snapshots the room's storage destination the moment the event
    // arrives; a rejection is surfaced when the delivery awaits it, so silence
    // the interim unhandled-rejection signal only.
    const storageAtEnqueue = adapter.resolveStorageAtEnqueue
      ? adapter.resolveStorage(event.roomIdentifier)
      : null;
    storageAtEnqueue?.catch(() => undefined);
    const previous = queues.get(session.session_id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () =>
        deliverDesktopEventTurn(
          session.session_id,
          event,
          await (storageAtEnqueue ?? adapter.resolveStorage(event.roomIdentifier)),
        ))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const stored = adapter.getStoredSession(session.session_id);
        if (stored && (stored.status === "interrupted" || stored.status === "failed")) {
          return;
        }
        const exhausted = recordConsecutiveTurnError(session.session_id);
        const updated = clearSessionActiveWork(session.session_id, (current) => ({
          ...current,
          status: exhausted ? "failed" : "unknown",
          last_error: exhausted ? exhaustedTurnError(message) : message,
          updated_at: adapter.now(),
        }));
        adapter.emitSessionUpdate(updated);
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
    const session = adapter.getStoredSession(sessionId);
    if (!session || !canDeliverDesktopEventToManagedAgent(adapter.toPublicSession(session))) {
      return;
    }

    // Provider readiness preflight (codex: readiness probe + wait for the
    // current turn to go idle) runs before the session is marked active and
    // before the change baseline is captured. Mirrors the historical codex
    // flow: `if (!idleSession || !canDeliverDesktopEventToSession(idleSession))
    // return;` — the wait may end with a session that is no longer deliverable.
    let ready = session;
    if (adapter.beforeTurnReadiness) {
      const refreshed = await adapter.beforeTurnReadiness({ session, event });
      if (!refreshed || !canDeliverDesktopEventToManagedAgent(adapter.toPublicSession(refreshed))) {
        return;
      }
      ready = refreshed;
    }

    const stopAfterTurn = isStopPhraseRoomStreamEvent(ready, event);
    const active = markSessionActiveForEvent(ready, event);
    const beforeChangeSignature = await desktopManagedAgentReplyChangeSignature(
      adapter.toPublicSession(active),
    );
    const abortController = new AbortController();
    const activeTurn: ActiveEventTurn = {
      abortController,
      interruptReason: null,
    };
    activeTurns.set(session.session_id, activeTurn);
    try {
      const result = await adapter.runTurn({ active, event, storage, abortController });

      const latest = adapter.getStoredSession(sessionId) ?? active;
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
        // Let a provider that owns a richer status machine (Codex) finalize the
        // status itself. The hook is skipped on preempt/abort — those outcomes
        // are engine-owned regardless of provider.
        const stored = !wasPreempted && !aborted ? adapter.getStoredSession(sessionId) : null;
        const derived = stored
          ? adapter.resolveErrorTurnStatus?.(stored, result) ?? null
          : null;
        const exhausted = !derived && !wasPreempted && !aborted && recordConsecutiveTurnError(sessionId);
        const updated = clearSessionActiveWork(sessionId, (current) => ({
          ...adapter.applyTurnResult(current, result),
          status: derived
            ? derived.status
            : wasPreempted
              ? "completed"
              : aborted
                ? "interrupted"
                : exhausted
                  ? "failed"
                  : "unknown",
          last_error: derived
            ? derived.lastError
            : wasPreempted
              ? null
              : exhausted
                ? exhaustedTurnError(String(result.error))
                : result.error ?? null,
          updated_at: adapter.now(),
        }));
        adapter.emitSessionUpdate(updated);
        if (stopAfterTurn && adapter.stopAfterTurnOnError && updated) {
          await stopAfterRoomStopPhrase(updated);
        } else if (exhausted) {
          await endExhaustedSessionWorker(sessionId);
        }
        return;
      }

      const completed = clearSessionActiveWork(sessionId, (current) => ({
        ...adapter.applyTurnResult(current, result),
        status: "completed",
        last_error: null,
        updated_at: adapter.now(),
      })) ?? latest;
      adapter.emitSessionUpdate(completed);
      await adapter.publishReply({
        session: completed,
        event,
        storage,
        text: result.text,
        beforeChangeSignature,
      });
      // The error budget resets only after the WHOLE delivery (turn + reply
      // publication) succeeded, so persistent publish/storage failures still
      // exhaust the budget via the enqueue catch handler.
      consecutiveTurnErrors.delete(sessionId);
      if (stopAfterTurn) {
        await stopAfterRoomStopPhrase(completed);
      }
    } finally {
      adapter.onDeliverFinally?.(session.session_id);
      if (activeTurns.get(session.session_id) === activeTurn) {
        activeTurns.delete(session.session_id);
      }
    }
  }

  function preemptActiveTurn(sessionId: string): void {
    const activeTurn = activeTurns.get(sessionId);
    if (!activeTurn || activeTurn.abortController.signal.aborted) {
      return;
    }
    activeTurn.interruptReason = "preempt";
    activeTurn.abortController.abort();
  }

  function interruptActiveTurnForStop(sessionId: string): void {
    const activeTurn = activeTurns.get(sessionId);
    if (!activeTurn) {
      return;
    }
    activeTurn.interruptReason = "stop";
    activeTurn.abortController.abort();
  }

  function resetTurnErrorBudget(sessionId: string): void {
    consecutiveTurnErrors.delete(sessionId);
  }

  async function waitForIdle(): Promise<void> {
    while (queues.size > 0) {
      await Promise.allSettled([...queues.values()]);
    }
  }

  return {
    enqueueDesktopEventTurn,
    preemptActiveTurn,
    interruptActiveTurnForStop,
    resetTurnErrorBudget,
    waitForIdle,
  };
}
