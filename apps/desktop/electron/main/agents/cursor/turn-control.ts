// Exact-reference stop, boundary pokes, and restart-resume turn control.

import {
  synthesizeTerminalPayload,
  type ProviderContinuationRef,
  type ProviderHandle,
  type ProviderStopOptions,
  type ProviderTurnControlResult,
  type ProviderTurnControlOptions,
  ProviderTurnControlError,
  type ProviderTerminalPayload,
} from "../provider-adapter.js";
import { CursorRoomTurnRecoveryError } from "../cursor-turn-settlement.js";
import { delay, sameProcessBirthIdentity } from "../provider-evidence.js";
import type { CursorProviderAdapter } from "./provider-adapter.js";

export async function stopRef(
  adapter: CursorProviderAdapter,
  ref: ProviderContinuationRef,
  options: ProviderStopOptions = {},
): Promise<ProviderTerminalPayload> {
  const connection = ref.providerConnection;
  if (!connection || connection.kind !== "cursor_cli") {
    throw new Error("Cursor exact-reference stop requires a Cursor wrapper reference.");
  }
  if ((connection.pid === null) !== (connection.processIdentity == null)) {
    throw new Error("Cursor exact-reference stop requires a verified wrapper process birth.");
  }
  if (connection.pid !== null && connection.processIdentity) {
    const identity = adapter.deps.getProcessIdentity(connection.pid);
    if (identity === undefined) {
      throw new Error("Cursor exact-reference stop is ambiguous because process identity cannot be verified.");
    }
    if (identity !== null && sameProcessBirthIdentity(identity, connection.processIdentity)) {
    // The wrapper owns its native process group and performs TERM→KILL
    // escalation internally. Killing the wrapper itself could orphan Cursor.
      adapter.deps.signalProcess(connection.pid, "SIGTERM");
      const deadline = Date.now() + (options.graceMs ?? adapter.stopGraceMs);
      for (;;) {
        const current = adapter.deps.getProcessIdentity(connection.pid);
        if (current === null || (typeof current === "string"
          && !sameProcessBirthIdentity(current, connection.processIdentity))) break;
        if (current === undefined) {
          throw new Error("Cursor exact-reference stop lost process-birth visibility before absence was proved.");
        }
        if (Date.now() >= deadline) {
          throw new Error("Cursor's process-reaping wrapper has not yet proved all recorded turn descendants are gone.");
        }
        await delay(25);
      }
    }
  }
  return synthesizeTerminalPayload({
    endedAt: adapter.deps.now(),
    exitCode: 0,
    signal: null,
    providerContinuationId: ref.providerContinuationId,
    stopRequested: true,
  });
}

/**
 * Boundary delivery, not mid-turn injection: when the lane is idle the next
 * boundary is NOW, so the message runs as a fresh `--resume` turn; while a
 * turn is running there is no channel into the child and this refuses.
 */
export async function poke(adapter: CursorProviderAdapter, providerHandle: ProviderHandle, message: string): Promise<void> {
  const handle = adapter.requireHandle(providerHandle);
  if (handle.deliveryMode === "daemon_inbox") {
    throw new Error("Cursor daemon-inbox delivery is journaled as bounded room turns; poke is unavailable.");
  }
  if (handle.terminal) {
    throw new Error("Cursor lane is terminal; nothing can be delivered.");
  }
  if (handle.liveTurn) {
    throw new Error(
      "Cursor has no channel into a running turn (positional-prompt CLI); deliver at the next boundary.",
    );
  }
  await adapter.beginTurn(handle, message, handle.providerContinuationId);
}

export async function controlTurn(
  adapter: CursorProviderAdapter,
  providerHandle: ProviderHandle,
  correction?: string | null,
  options: ProviderTurnControlOptions = {},
): Promise<ProviderTurnControlResult> {
  const handle = adapter.requireHandle(providerHandle);
  if (handle.terminal) throw new Error("Cursor continuation is terminal; no turn can be controlled.");
  const text = correction?.trim() || null;
  if (text && handle.deliveryMode === "daemon_inbox") {
    throw new ProviderTurnControlError(
      "Cursor daemon-inbox turn control can stop the active bounded turn, but cannot start an unjournaled correction turn.",
      "not_applied",
    );
  }
  const expectedTurnId = options.targetTurnId?.trim() || null;
  let turn = handle.liveTurn;
  const pendingController = turn ? null : handle.roomTurnAbortController;
  const currentTurnId = turn?.controlTurnId ?? handle.activeRoomTurnId;
  if (expectedTurnId && currentTurnId && currentTurnId !== expectedTurnId) {
    // The checkpointed wrapper/room turn A ended or was superseded. Never
    // let retry of A acquire signal authority over a later process B.
    if (text) {
      throw new ProviderTurnControlError(
        "Cursor's checkpointed turn ended and a newer turn is active; the correction was not applied to that successor.",
        "not_applied",
      );
    }
    return {
      capability: "restart_resume",
      interrupted: false,
      resumed: false,
      state: turn || pendingController ? "working" : "idle",
    };
  }
  if (turn || pendingController) {
    if (currentTurnId) await options.checkpointTurnStarted?.(currentTurnId);
    await options.markDispatched?.();
    if (!turn && pendingController) {
      turn = handle.liveTurn;
      if (!turn && handle.roomTurnAbortController === pendingController) {
        const settled = handle.roomTurnOperationSettled;
        pendingController.abort();
        await settled;
        if (handle.liveTurn) {
          throw new CursorRoomTurnRecoveryError(
            "Cursor turn control could not retire the exact child birth; recovery is required before reporting idle.",
          );
        }
        return {
          capability: "restart_resume",
          interrupted: true,
          resumed: false,
          state: "idle",
        };
      }
    }
  }
  if (turn) {
    const identity = adapter.exactProcessStatus(turn.pid, turn.processIdentity);
    if (identity !== "exact") {
      throw new Error("Cursor turn identity is stale; refusing to interrupt a different process.");
    }
    try {
      if (handle.liveTurn !== turn
        || adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM") !== "signalled") {
        throw new ProviderTurnControlError(
          "Cursor turn ended before the child interrupt was dispatched.",
          "not_applied",
        );
      }
      turn.interruptRequested = true;
    } catch (error) {
      turn.interruptRequested = false;
      throw error;
    }
    const graceful = await Promise.race([
      turn.child.exited.then(() => true),
      delay(adapter.stopGraceMs).then(() => false),
    ]);
    if (!graceful && turn.child.ownsDescendantReaping) {
      throw new Error("Cursor's process-reaping wrapper has not yet proved the interrupted turn descendants are gone.");
    }
    if (!graceful) {
      const killed = adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGKILL");
      if (killed === "ambiguous") {
        throw new Error("Cursor turn process birth became unverifiable before interrupt escalation.");
      }
    }
    await turn.child.exited;
    if (turn.lifecycleSettlementDeferred) {
      await adapter.awaitDeferredRoomTurnSettlement(handle, turn);
    } else if (turn.completion) {
      await turn.completion;
    } else {
      // A supervised Stop can race the atomic prepared checkpoint before
      // beginTurn installs its normal completion observer. Wait for the
      // whole bounded room operation so its reaper and live->idle durable
      // compensation finish before the daemon cancels the FIFO item.
      await handle.roomTurnOperationSettled;
    }
    if (handle.terminal) throw new Error("Cursor turn interruption unexpectedly ended the supervised attempt.");
  }
  if (text) {
    if (!turn) await options.markDispatched?.();
    await adapter.beginTurn(handle, text, handle.providerContinuationId);
  }
  return {
    capability: "restart_resume",
    interrupted: Boolean(turn),
    resumed: Boolean(text),
    state: text ? "working" : "idle",
  };
}

export async function stop(
  adapter: CursorProviderAdapter,
  providerHandle: ProviderHandle,
  options: ProviderStopOptions = {},
): Promise<ProviderTerminalPayload> {
  const handle = adapter.requireHandle(providerHandle);
  if (handle.terminal) return handle.terminal;
  handle.stopRequested = true;
  handle.state = "stopping";

  let turn = handle.liveTurn;
  const pendingController = turn ? null : handle.roomTurnAbortController;
  if (pendingController) {
    const settled = handle.roomTurnOperationSettled;
    pendingController.abort();
    await settled;
    turn = handle.liveTurn;
  }
  if (!turn) {
    // Idle lane: no process to signal. The attempt ends here with an honest
    // synthesized payload (no exit code exists because nothing was running).
    return adapter.finishAttempt(handle, { type: "exit", code: 0, signal: null });
  }

  if (options.force) {
    const signalled = adapter.signalExactProcess(
      turn.pid,
      turn.processIdentity,
      turn.child.ownsDescendantReaping ? "SIGTERM" : "SIGKILL",
    );
    if (signalled === "ambiguous") throw new Error("Cursor turn process birth is unverifiable; refusing force-stop.");
    if (signalled === "absent") {
      return adapter.finishAfterVerifiedWrapperAbsence(handle, turn);
    }
    if (turn.child.ownsDescendantReaping) {
      const reaped = await Promise.race([
        turn.child.exited.then(() => true),
        delay(options.graceMs ?? adapter.stopGraceMs).then(() => false),
      ]);
      if (!reaped) throw new Error("Cursor's wrapper has not yet retired its native process group.");
    }
    return adapter.awaitTurnTerminal(handle, turn);
  }
  const term = adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
  if (term === "ambiguous") throw new Error("Cursor turn process birth is unverifiable; refusing stop.");
  if (term === "absent") {
    return adapter.finishAfterVerifiedWrapperAbsence(handle, turn);
  }
  const graceMs = options.graceMs ?? adapter.stopGraceMs;
  const graceful = await Promise.race([
    turn.child.exited.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (!graceful && turn.child.ownsDescendantReaping) {
    throw new Error("Cursor's wrapper has not yet retired its native process group.");
  }
  if (!graceful) {
    const killed = adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGKILL");
    if (killed === "ambiguous") throw new Error("Cursor turn process birth became unverifiable before stop escalation.");
  }
  return adapter.awaitTurnTerminal(handle, turn);
}
