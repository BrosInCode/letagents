// Exact-birth process control for Cursor turn wrappers: signalling, reaping, and exit evidence.

import type { ProviderTerminalPayload } from "../provider-adapter.js";
import { CursorRoomTurnRecoveryError } from "../cursor-turn-settlement.js";
import { delay, sameProcessBirthIdentity, type ProviderProcessExit } from "../provider-evidence.js";
import type { CursorProviderAdapter } from "../cursor-provider-adapter.js";
import { CursorProviderHandle, type LiveTurn } from "./lane-state.js";

export async function terminateTurnChild(
  adapter: CursorProviderAdapter,
  pid: number,
  exited: Promise<ProviderProcessExit>,
  processIdentity?: string | null,
  ownsDescendantReaping = false,
  nativeLaunchIsDeferred = false,
): Promise<void> {
  // A daemon-inbox wrapper is born paused. While release() has not run it has
  // no native child/process group to preserve, so TERM may safely escalate to
  // KILL of the exact wrapper. After release, only the wrapper may prove its
  // separately-detached native descendants gone; killing it would discard
  // that proof, so the post-release path remains deliberately fail-closed.
  // Every PID signal is birth-fenced, including late post-release timeout and
  // protocol cleanup. `undefined` means this caller never captured a birth;
  // a later observation cannot be adopted because the original child could
  // have exited and its PID been recycled between those observations. Only a
  // previously captured identity authorizes signalling. In the ambiguous
  // case, remain attached to the exact ChildProcess exit instead.
  if (processIdentity === null) return;
  if (processIdentity === undefined) {
    await exited;
    return;
  }
  const term = adapter.signalExactProcess(pid, processIdentity, "SIGTERM");
  if (term === "absent") return;
  if (term === "ambiguous") {
    await exited;
    return;
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(adapter.stopGraceMs).then(() => false),
  ]);
  if (graceful) return;
  if (ownsDescendantReaping && !nativeLaunchIsDeferred) {
    throw new Error("Cursor's wrapper has not yet retired its native process group.");
  }
  const killed = adapter.signalExactProcess(pid, processIdentity, "SIGKILL");
  if (killed === "absent") return;
  if (killed === "ambiguous") {
    // Never let a pre-native cleanup promise settle on ambiguous liveness:
    // delivery treats settlement as proof that it may restore the FIFO.
    await exited;
    return;
  }
  await exited;
}

export async function readTerminatedTurnExit(adapter: CursorProviderAdapter, turn: LiveTurn): Promise<ProviderProcessExit> {
  if (turn.processIdentity === null) {
    return { type: "exit", code: null, signal: null };
  }
  if (turn.processIdentity !== undefined
    && adapter.exactProcessStatus(turn.pid, turn.processIdentity) === "absent") {
    // A missing exact birth is conclusive terminal evidence even when a
    // stale ChildProcess object can no longer deliver its exit callback.
    return { type: "exit", code: null, signal: null };
  }
  return turn.child.exited;
}

export function exactProcessStatus(adapter: CursorProviderAdapter, pid: number, processIdentity: string): "exact" | "absent" | "ambiguous" {
  const identity = adapter.deps.getProcessIdentity(pid);
  if (identity === undefined) return "ambiguous";
  if (identity === null || !sameProcessBirthIdentity(identity, processIdentity)) return "absent";
  return "exact";
}

export function signalExactProcess(
  adapter: CursorProviderAdapter,
  pid: number,
  processIdentity: string,
  signal: NodeJS.Signals,
): "signalled" | "absent" | "ambiguous" {
  const status = adapter.exactProcessStatus(pid, processIdentity);
  if (status !== "exact") return status;
  adapter.deps.signalProcess(pid, signal);
  return "signalled";
}

export async function awaitTurnTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
): Promise<ProviderTerminalPayload> {
  const exit = await turn.child.exited;
  if (turn.lifecycleSettlementDeferred) {
    await adapter.awaitDeferredRoomTurnSettlement(handle, turn);
  } else if (turn.completion) {
    await turn.completion;
  } else {
    await adapter.retireTurnWorkspaceGeneration(handle, turn);
    if (handle.liveTurn === turn) handle.liveTurn = null;
  }
  return handle.terminal ?? adapter.finishAttempt(handle, exit);
}

export async function finishAfterVerifiedWrapperAbsence(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
): Promise<ProviderTerminalPayload> {
  if (turn.workspaceGeneration) {
    throw new CursorRoomTurnRecoveryError(
      "Cursor's exact wrapper birth is absent, but its writable generation has no terminal retirement receipt; restart recovery is required.",
    );
  }
  if (turn.lifecycleSettlementDeferred) {
    await adapter.awaitDeferredRoomTurnSettlement(handle, turn);
  } else if (handle.liveTurn === turn) {
    handle.liveTurn = null;
  }
  return adapter.finishAttempt(handle, { type: "exit", code: null, signal: null });
}
