// Turn completion: the honest end state of a native turn and attempt-terminal synthesis.

import { synthesizeTerminalPayload, type ProviderTerminalPayload } from "../provider-adapter.js";
import { safeCursorTerminalErrorDetail } from "../cursor-provider-evidence.js";
import { CursorTerminalAuthorityUnprovenError } from "../cursor-turn-settlement.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import type { CursorProviderAdapter } from "../cursor-provider-adapter.js";
import { CursorProviderHandle, type CursorTurnTerminal, type LiveTurn } from "./lane-state.js";

// The empirically proven usage-limit signature (task_38 spike, msg_1708):
// init observed, the stream stops with NO result event, the process exits
// non-zero with no signal, and stderr carries the ActionRequiredError. This is
// an account/configuration condition, not a crash — the reconciler must not
// quarantine it and the UI can name the actual remedy.
const PROVIDER_QUOTA_STDERR = /ActionRequiredError[\s\S]*usage limit/i;

function isProviderQuotaExit(turn: LiveTurn, exit: ProviderProcessExit): boolean {
  return exit.type === "exit"
    && exit.signal === null
    && exit.code !== null
    && exit.code !== 0
    && turn.sawInit
    && !turn.sawResult
    && PROVIDER_QUOTA_STDERR.test(turn.child.stderrTail());
}

/** Await the turn's real exit and apply the honest end state. */
export async function completeTurn(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
  unsubscribe: () => void,
): Promise<CursorTurnTerminal> {
  const exit = await turn.child.exited;
  // Drain belt: even with close-gated exit evidence, give any line callbacks
  // already scheduled in this tick a chance to record the final result before
  // it is read — misreading a clean turn as !sawResult would drop the lane.
  // This drain is part of terminal correctness, not an optional background
  // timer. Keep the loop alive until it runs; an unref'd zero-delay timer can
  // otherwise strand stop()/handoff on an already-exited child.
  await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
  unsubscribe();
  // Every child exit is terminal for this turn's display lifecycle, even
  // when Cursor omits `result`, the user interrupts, or protocol validation
  // fails. The daemon stream spans turns, so leaving these entries in the
  // map would strand Inspector cards in `running` indefinitely.
  adapter.interruptLiveDisplayTools(handle, turn);
  let trustedDurableTerminal: CursorTurnTerminal | undefined;
  let authorityUnproven: { authorityUnproven: true; fileChangesLost?: true } | undefined;
  if (turn.child.requiresDurableTerminalEvidence) {
    try {
      trustedDurableTerminal = adapter.readTrustedDurableTurnTerminal(handle, turn);
    } catch (error) {
      // An unrelated stream violation outranks a merely unproven shutdown.
      if (error instanceof CursorTerminalAuthorityUnprovenError && !handle.protocolError) {
        authorityUnproven = { authorityUnproven: true, ...(turn.workspaceGeneration ? { fileChangesLost: true as const } : {}) };
      }
      handle.protocolError = true;
      adapter.publishStream(handle, "turn/terminal_invalid", {
        reason: error instanceof Error ? error.message : String(error),
      }, "error");
    }
  }
  const exactTerminalError = trustedDurableTerminal?.terminalError
    ?? safeCursorTerminalErrorDetail(turn.child.terminalError?.())
    ?? undefined;
  if (turn.workspaceGeneration && turn.child.requiresDurableTerminalEvidence
    && !trustedDurableTerminal) {
    // Do not touch the provider-authored tree until a successor can prove the
    // exact wrapper retired both process and remote authority. The generation
    // handle/receipt deliberately remains live and recoverable.
    const attemptTerminal = turn.lifecycleSettlementDeferred
      ? adapter.synthesizeAttemptTerminal(handle, exit, "protocol_error")
      : adapter.finishAttempt(handle, exit, "protocol_error");
    return adapter.rememberRoomTurnTerminal(handle, turn, {
      state: "attempt_terminal",
      exit,
      text: null,
      isError: true,
      providerRequestId: turn.providerRequestId,
      attemptTerminal,
      publicationContract: "structured_room_turn_v1",
      ...authorityUnproven,
      ...(exactTerminalError
        ? {
          terminalError: `${exactTerminalError} Its private workspace generation was retained for safe recovery because durable containment proof was unavailable.`,
        }
        : {}),
    });
  }
  await adapter.retireTurnWorkspaceGeneration(handle, turn, trustedDurableTerminal);
  if (!turn.lifecycleSettlementDeferred && handle.liveTurn === turn) handle.liveTurn = null;
  if (handle.terminal) {
    return adapter.rememberRoomTurnTerminal(handle, turn, {
      state: "attempt_terminal",
      exit,
      text: null,
      isError: true,
      providerRequestId: turn.providerRequestId,
      attemptTerminal: handle.terminal,
      publicationContract: "structured_room_turn_v1",
      ...(exactTerminalError ? { terminalError: exactTerminalError } : {}),
    });
  }

  if (turn.interruptRequested) {
    // Cursor has no in-turn channel, so the exact turn child is fenced and
    // the durable session is resumed for any correction. This is explicitly
    // TURN-terminal, never ATTEMPT-terminal.
    handle.state = "idle";
    adapter.publishActivity(handle, {
      source: "native_harness",
      method: "turn/interrupted",
      summary: "Turn interrupted; continuation preserved",
      status: "idle",
      checking: "",
      next_action: "awaiting redirected work",
    });
    return adapter.rememberRoomTurnTerminal(handle, turn, {
      state: "interrupted",
      exit,
      text: null,
      isError: true,
      providerRequestId: turn.providerRequestId,
      attemptTerminal: null,
      publicationContract: "structured_room_turn_v1",
    });
  }

  if (exit.type === "error" || handle.stopRequested || handle.protocolError || !turn.sawResult) {
    // A launch error, a requested stop, a session-identity violation, or a
    // child that died without its final result event are all ATTEMPT-level
    // terminal evidence — never silently absorbed as an idle turn. The one
    // refinement: the proven usage-limit signature is provider_quota, not a
    // crash (recoverable by model switch / spend limit, per the spike).
    const forcedCause = !handle.stopRequested && !handle.protocolError && isProviderQuotaExit(turn, exit)
      ? "provider_quota"
      : undefined;
    const attemptTerminal = turn.lifecycleSettlementDeferred
      ? adapter.synthesizeAttemptTerminal(handle, exit, forcedCause)
      : adapter.finishAttempt(handle, exit, forcedCause);
    return adapter.rememberRoomTurnTerminal(handle, turn, {
      state: "attempt_terminal",
      exit,
      text: null,
      isError: true,
      providerRequestId: turn.providerRequestId,
      attemptTerminal,
      publicationContract: "structured_room_turn_v1",
      ...authorityUnproven,
      ...(exactTerminalError ? { terminalError: exactTerminalError } : {}),
    });
  }

  // TURN-terminal, not ATTEMPT-terminal: the lane stays alive and honestly
  // idle, with the session id as its only continuation state.
  handle.state = "idle";
  adapter.publishActivity(handle, {
    source: "native_harness",
    method: "result",
    summary: turn.resultWasError ? "Turn ended with an error result" : "Turn completed",
    status: "idle",
    checking: "",
    next_action: "awaiting next boundary delivery",
  });
  return adapter.rememberRoomTurnTerminal(handle, turn, {
    state: "result",
    exit,
    text: turn.resultText,
    isError: turn.resultWasError,
    nativeFailure: turn.executionTerminalCheckpoint?.isError === true,
    providerRequestId: turn.providerRequestId,
    attemptTerminal: null,
    publicationContract: "structured_room_turn_v1",
  });
}

export function finishAttempt(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  exit: ProviderProcessExit,
  forcedCause?: ProviderTerminalPayload["terminalCause"],
): ProviderTerminalPayload {
  if (handle.terminal) return handle.terminal;
  return adapter.commitAttemptTerminal(handle, adapter.synthesizeAttemptTerminal(handle, exit, forcedCause));
}

export function synthesizeAttemptTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  exit: ProviderProcessExit,
  forcedCause?: ProviderTerminalPayload["terminalCause"],
): ProviderTerminalPayload {
  const terminal = exit.type === "error"
    ? {
      ...synthesizeTerminalPayload({
        endedAt: adapter.deps.now(),
        exitCode: null,
        signal: null,
        providerContinuationId: handle.providerContinuationId,
        stopRequested: handle.stopRequested,
      }),
      terminalCause: "protocol_error" as const,
    }
    : synthesizeTerminalPayload({
      endedAt: adapter.deps.now(),
      exitCode: exit.code,
      signal: exit.signal,
      providerContinuationId: handle.providerContinuationId,
      stopRequested: handle.stopRequested,
    });
  if (forcedCause) terminal.terminalCause = forcedCause;
  if (handle.protocolError) terminal.terminalCause = "protocol_error";
  return terminal;
}

export function commitAttemptTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  terminal: ProviderTerminalPayload,
): ProviderTerminalPayload {
  if (handle.terminal) return handle.terminal;
  handle.terminal = terminal;
  handle.liveTurn = null;
  handle.state = terminal.terminalCause === "exited" || terminal.terminalCause === "stopped"
    ? "stopped"
    : "failed";
  if (adapter.handles.get(handle.workAttemptId) === handle) {
    adapter.handles.delete(handle.workAttemptId);
  }
  for (const listener of handle.exitListeners) listener(terminal);
  handle.exitListeners.clear();
  return terminal;
}
