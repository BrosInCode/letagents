// Bounded daemon-inbox room turns: dispatch, terminal waiting, and result shaping.

import { cursorRoomTurnImageFolders } from "../cursor-room-turn-images.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ProviderHandle,
  ProviderRoomTurnOptions,
  ProviderRoomTurnRequest,
  ProviderRoomTurnResult,
} from "../provider-adapter.js";
import {
  checkpointCursorTurnBeforeLaneRetires,
  cursorAttemptEndingResult,
  CursorRoomTurnTerminalError,
  CursorRoomTurnRecoveryError,
} from "../cursor-turn-settlement.js";
import { redactCredentialText, type ProviderProcessExit } from "../provider-evidence.js";
import type { CursorProviderAdapter } from "../cursor-provider-adapter.js";
import {
  CursorPostDispatchCheckpointError,
  CursorProviderHandle,
  CursorRoomTurnObservationDetachedError,
  type CursorTurnTerminal,
  type LiveTurn,
} from "./lane-state.js";
import { boundedCursorRoomTurnPrompt, CURSOR_NO_ROOM_REPLY_SENTINEL } from "./launch-arguments.js";

export async function runRoomTurn(
  adapter: CursorProviderAdapter,
  providerHandle: ProviderHandle,
  request: ProviderRoomTurnRequest,
  options: ProviderRoomTurnOptions = {},
): Promise<ProviderRoomTurnResult> {
  const handle = adapter.requireHandle(providerHandle);
  if (handle.deliveryMode !== "daemon_inbox") {
    throw new Error("Cursor bounded room turns require daemon_inbox delivery.");
  }
  if (handle.terminal) throw new Error("Cursor continuation is terminal; no bounded room turn can run.");
  if (handle.state === "failed") throw new Error("Cursor continuation has failed; no bounded room turn can run.");
  if (handle.liveTurn || handle.roomTurnOperationId || handle.activeRoomTurnId) {
    throw new Error("Cursor continuation already has a bounded room turn in progress.");
  }
  if (!request.inboxItemId.trim() || !request.actionId.trim()) {
    throw new Error("Bounded Cursor room turn requires durable inbox and action ids.");
  }

  const turnId = `cursor:${randomUUID()}`;
  const turnAbortController = new AbortController();
  let settleRoomTurnOperation!: () => void;
  handle.roomTurnOperationId = turnId;
  handle.roomTurnAbortController = turnAbortController;
  handle.roomTurnOperationSettled = new Promise((resolve) => {
    settleRoomTurnOperation = resolve;
  });
  const detachDuringPreparation = () => turnAbortController.abort();
  const detachSignal = options.detachSignal;
  if (detachSignal?.aborted) detachDuringPreparation();
  else detachSignal?.addEventListener("abort", detachDuringPreparation, { once: true });
  const unlinkPreparationDetach = () => {
    detachSignal?.removeEventListener("abort", detachDuringPreparation);
  };
  const markDurableTurnStarted = () => {
    options.markDurableTurnStarted?.();
    unlinkPreparationDetach();
  };
  try {
    await (options.beforeNativeDispatch ?? options.markDispatched)?.();
    handle.activeRoomTurnId = turnId;
    let turn: LiveTurn;
    try {
      turn = await adapter.beginTurn(
        handle,
        boundedCursorRoomTurnPrompt(request, turnId, handle.spawnRequest.permissionProfileId),
        handle.providerContinuationId,
        turnId,
        options.checkpointProviderState,
        options.checkpointTurnStarted,
        options.checkpointPreparedTurn,
        turnAbortController.signal,
        markDurableTurnStarted,
        options.settleLifecycleBeforeIdle,
        cursorRoomTurnImageFolders(request),
      );
    } catch (error) {
      if (!(error instanceof CursorPostDispatchCheckpointError)) throw error;
      // This exact wrapper crossed the durable turn boundary. Handoff now
      // detaches observation instead of cancelling preparation.
      unlinkPreparationDetach();
      // Native work may have completed while its real session checkpoint
      // failed. Re-read only this exact wrapper terminal; never redispatch.
      return await adapter.recoverRoomTurn(handle, {
        inboxItemId: request.inboxItemId,
        providerTurnId: turnId,
      }, {
        detachSignal: options.detachSignal,
        checkpointProviderState: options.checkpointProviderState,
        settleLifecycleBeforeIdle: options.settleLifecycleBeforeIdle,
        checkpointTerminalResult: options.checkpointTerminalResult,
      });
    }
    let terminal = await adapter.awaitRoomTurnTerminal(turn.completion!, options.detachSignal);
    if (turn.lifecycleSettlementDeferred) {
      adapter.observeNativeRuntimeExit(handle, turn, terminal.exit);
      await options.settleLifecycleBeforeIdle?.();
      if (handle.liveTurn === turn) handle.liveTurn = null;
    }
    try {
      await options.checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection,
      });
    } catch (error) {
      // The child is already exited and its typed effects are settled, but
      // the durable manifest may still name that exact birth. Retain it so
      // recovery can retry the processless-idle compensation idempotently.
      if (turn.lifecycleSettlementDeferred && !handle.liveTurn) handle.liveTurn = turn;
      throw error;
    }
    const deferredAttemptDeath = turn.lifecycleSettlementDeferred && terminal.state === "attempt_terminal"
      ? terminal.attemptTerminal ?? adapter.synthesizeAttemptTerminal(handle, terminal.exit)
      : null;
    if (deferredAttemptDeath) terminal = { ...terminal, attemptTerminal: deferredAttemptDeath };
    const { result, disposition, attemptTerminal } = await checkpointCursorTurnBeforeLaneRetires({
      attemptDeath: deferredAttemptDeath, checkpoint: options.checkpointTerminalResult,
      result: () => adapter.providerRoomTurnResult(turnId, terminal, handle.providerContinuationId!, handle.protocolError),
      retire: (death) => adapter.commitAttemptTerminal(handle, death),
    });
    if (attemptTerminal) terminal = { ...terminal, attemptTerminal };
    const acceptedResult = disposition?.acceptedResult ?? result;
    // An unproven ending keeps its live generation receipt and journal: only
    // a successor holding trusted containment proof may reconcile them.
    const cleanupRecoveryEvidence = !terminal.authorityUnproven && (options.checkpointTerminalResult
      ? disposition === undefined
        ? result.outcome !== "unreadable"
        : disposition.cleanupRecoveryEvidence
      : false);
    if (cleanupRecoveryEvidence) {
      if (turn.workspaceGenerationManifestPath) {
        await adapter.deps.removeWorkspaceGenerationReceipt(turn.workspaceGenerationManifestPath,
          { settlementVerified: Boolean(turn.workspaceGenerationSettlement) });
      }
      // The turn journal is the only restart-readable terminal evidence.
      // Retire it last, after every fallible generation cleanup succeeds.
      adapter.removeDurableTurnJournal(handle, turnId);
    }
    // Cursor has no exact-turn read API. Keep unreadable terminal evidence
    // until the daemon performs its one result-recovery pass; replies and
    // explicit no-replies are already durably normalized and can be dropped.
    if (cleanupRecoveryEvidence || (!options.checkpointTerminalResult && result.outcome !== "unreadable")) {
      handle.roomTurnResults.delete(turnId);
    }
    return acceptedResult;
  } finally {
    unlinkPreparationDetach();
    settleRoomTurnOperation();
    if (handle.roomTurnAbortController === turnAbortController) {
      handle.roomTurnAbortController = null;
      handle.roomTurnOperationSettled = null;
    }
    if (handle.roomTurnOperationId === turnId) handle.roomTurnOperationId = null;
    if (handle.activeRoomTurnId === turnId && handle.roomTurnResults.has(turnId)) {
      handle.activeRoomTurnId = null;
    } else if (handle.activeRoomTurnId === turnId && !handle.liveTurn) {
      // Launch/init failed before a recoverable exact turn existed.
      handle.activeRoomTurnId = null;
    }
  }
}

export function rememberRoomTurnTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
  terminal: CursorTurnTerminal,
  observeLifecycle = true,
): CursorTurnTerminal {
  if (turn.lifecycleSettlementDeferred && observeLifecycle) {
    adapter.observeValidatedTurnTerminal(handle, turn,
      terminal.state === "result" ? terminal.isError ? "failed" : "completed"
        : terminal.state === "interrupted" ? "interrupted" : "lost");
  }
  if (turn.roomTurnId) {
    handle.roomTurnResults.set(turn.roomTurnId, terminal);
    while (handle.roomTurnResults.size > 16) {
      const oldest = handle.roomTurnResults.keys().next().value;
      if (typeof oldest !== "string") break;
      handle.roomTurnResults.delete(oldest);
    }
    if (handle.activeRoomTurnId === turn.roomTurnId) handle.activeRoomTurnId = null;
  }
  return terminal;
}

export function awaitRoomTurnTerminal(
  adapter: CursorProviderAdapter,
  completion: Promise<CursorTurnTerminal>,
  detachSignal?: AbortSignal,
): Promise<CursorTurnTerminal> {
  if (!detachSignal) return completion;
  if (detachSignal.aborted) {
    return Promise.reject(new CursorRoomTurnObservationDetachedError("Cursor room-turn observation detached."));
  }
  return new Promise((resolve, reject) => {
    const detach = () => {
      detachSignal.removeEventListener("abort", detach);
      reject(new CursorRoomTurnObservationDetachedError("Cursor room-turn observation detached."));
    };
    detachSignal.addEventListener("abort", detach, { once: true });
    void completion.then(
      (terminal) => {
        detachSignal.removeEventListener("abort", detach);
        resolve(terminal);
      },
      (error) => {
        detachSignal.removeEventListener("abort", detach);
        reject(error);
      },
    );
  });
}

export function providerRoomTurnResult(
  adapter: CursorProviderAdapter,
  turnId: string,
  terminal: CursorTurnTerminal,
  providerContinuationId: string,
  protocolError = false,
): ProviderRoomTurnResult {
  if (terminal.state === "interrupted") {
    return { turnId, providerContinuationId, outcome: "interrupted", text: null, evidence: "stream" };
  }
  if (terminal.state === "attempt_terminal") {
    return cursorAttemptEndingResult({ turnId, providerContinuationId, protocolError,
      cause: terminal.attemptTerminal?.terminalCause, terminalError: terminal.terminalError,
      authorityUnproven: terminal.authorityUnproven, fileChangesLost: terminal.fileChangesLost === true });
  }
  if (terminal.isError) {
    if (!terminal.nativeFailure) throw new CursorRoomTurnTerminalError("Cursor returned an unproven error result for the bounded room turn.");
    return { turnId, providerContinuationId, outcome: "failed", text: null, evidence: "stream",
      error: redactCredentialText(terminal.text || "Cursor returned an error result for the bounded room turn.").value.slice(0, 2000),
      publicationContract: terminal.publicationContract };
  }
  const text = terminal.text?.trim() || null;
  if (text === CURSOR_NO_ROOM_REPLY_SENTINEL) {
    return { turnId, outcome: "no_reply", text: null, evidence: "stream", publicationContract: terminal.publicationContract };
  }
  if (!text) return { turnId, outcome: "unreadable", text: null, evidence: "none", publicationContract: terminal.publicationContract };
  return { turnId, outcome: "reply", text, evidence: "stream", publicationContract: terminal.publicationContract };
}

export async function awaitDeferredRoomTurnSettlement(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
): Promise<void> {
  const settlement = handle.roomTurnOperationId === turn.roomTurnId
    ? handle.roomTurnOperationSettled
    : null;
  if (!settlement) {
    throw new CursorRoomTurnRecoveryError(
      "Cursor's bounded turn has no active settlement owner; retaining its exact child birth for recovery.",
    );
  }
  await settlement;
  if (handle.liveTurn === turn) {
    throw new CursorRoomTurnRecoveryError(
      "Cursor's bounded turn finished without retiring its exact child birth; recovery is required.",
    );
  }
}

export async function settlePreparedTurnIdle(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
  exit: ProviderProcessExit,
  settleLifecycleBeforeIdle?: ProviderRoomTurnOptions["settleLifecycleBeforeIdle"],
  checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"],
): Promise<void> {
  adapter.observeNativeRuntimeExit(handle, turn, exit);
  await settleLifecycleBeforeIdle?.();
  if (handle.liveTurn === turn) handle.liveTurn = null;
  handle.state = "idle";
  try {
    await checkpointProviderState?.({
      providerContinuationId: handle.providerContinuationId!,
      providerConnection: handle.providerConnection,
    });
  } catch (error) {
    if (!handle.liveTurn) handle.liveTurn = turn;
    throw error;
  }
}
