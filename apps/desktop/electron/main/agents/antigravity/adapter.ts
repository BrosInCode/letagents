/**
 * Antigravity through `agy acp`, the Agent Client Protocol server of Google's
 * Antigravity CLI. The daemon owns room ingress, exact-turn dispatch, retry,
 * credentials and publication; this adapter owns the native process and its
 * one ACP session. Each room turn is one `session/prompt`.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ClaudePermissionObservation, ProviderPermissionDispatchOptions } from "../../../../shared/provider-permissions.js";
import type { ProviderUsage } from "../../../../shared/provider-usage.js";
import type { ControlProbeResult, NativeExecutionObservation, NativeExecutionSubscription, NativeTurnBoundary } from "../../../../shared/execution-protocol.js";
import { PROCESS_ENDED_DURING_TURN, ProviderTurnControlError, type ProviderAdapter, type ProviderContinuationRef, type ProviderHandle, type ProviderRoomTurnOptions, type ProviderRoomTurnRecoveryRequest, type ProviderRoomTurnRequest, type ProviderRoomTurnResult, type ProviderSpawnRequest, type ProviderTurnControlOptions, type ProviderTurnControlResult, type RoomTurnFileAccess, type RoomTurnImageDelivery } from "../provider-adapter.js";
import { delay } from "../provider-evidence.js";
import { AcpRpcError, acpRecord, acpString } from "./acp-connection.js";
import { AntigravityAdapterBase } from "./adapter-base.js";
import type { AntigravityActiveTurn, AntigravityHandle } from "./handle.js";
import { antigravityPromptBlocks, boundedAntigravityRoomTurnPrompt, classifyAntigravityTurn } from "./turn-results.js";
import { parseAntigravityQuota } from "./usage.js";
import { antigravityPathForms, antigravityPermissionOption, type AntigravityNativePermissionRequest } from "./permissions.js";

const CONTROL_PROBE_TIMEOUT_MS = 5_000;

class AntigravityRoomTurnRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityRoomTurnRecoveryError";
  }
}

export class AntigravityProviderAdapter extends AntigravityAdapterBase implements ProviderAdapter {
  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) throw new Error("Antigravity resume ref must belong to the same work attempt.");
    return this.start(req, ref);
  }

  async poke(_handle: ProviderHandle, _message: string): Promise<void> {
    throw new Error("Antigravity mid-turn message injection is not supported; only native interruption is available.");
  }

  /**
   * The context window comes from agy's own `usage_update`s. The account's
   * limits are read with `agy -p /quota` at most every 30 seconds; a read that
   * takes longer than a moment leaves the last reading, which the window shows as stale.
   */
  async readUsage(providerHandle: ProviderHandle): Promise<ProviderUsage | null> {
    const handle = this.handles.get(providerHandle.workAttemptId);
    if (!handle || handle !== providerHandle || handle.terminal) return null;
    const now = Date.parse(this.deps.now());
    if (!handle.quotaRead && (!handle.quotaReadAt || now - handle.quotaReadAt >= 30_000)) {
      handle.quotaReadAt = now;
      const reading = this.deps.readQuota(this.agyBin).then((output) => {
        const windows = parseAntigravityQuota(output, handle.currentModel, this.deps.now());
        handle.usage = { ...handle.usage, account: windows ? { state: "available", windows }
          : { state: handle.usage.account.windows.length ? "stale" : "unavailable", windows: handle.usage.account.windows } };
      }, () => {
        handle.usage = { ...handle.usage, account: { state: handle.usage.account.windows.length ? "stale" : "unavailable", windows: handle.usage.account.windows } };
      }).finally(() => { if (handle.quotaRead === reading) handle.quotaRead = null; });
      handle.quotaRead = reading;
    }
    if (handle.quotaRead) await Promise.race([handle.quotaRead, delay(2_500)]);
    return this.handles.get(handle.workAttemptId) === handle ? structuredClone(handle.usage) : null;
  }

  /** agy takes base64 image blocks in a prompt (promptCapabilities.image). */
  roomTurnImageDelivery(): RoomTurnImageDelivery {
    return "memory";
  }

  /** agy's own read tool opens text files on this machine without asking, at every access level. */
  roomTurnFileAccess(): RoomTurnFileAccess {
    return { text: true, pdf: false };
  }

  onExecution(providerHandle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.requireHandle(providerHandle).execution.subscribe(listener);
  }

  /**
   * ACP has no ping, but any JSON-RPC answer proves agy's control loop is
   * alive: a method no server has is answered "method not found" at once,
   * and has no effect. No answer in time is degraded; a closed pipe is lost.
   */
  async probeControl(providerHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.requireHandle(providerHandle);
    let result: ControlProbeResult;
    if (handle.controlLoss) result = { state: "lost", controlEvidence: handle.controlLoss };
    else {
      try {
        await handle.connection.request("letagents/probe", {}, { timeoutMs: CONTROL_PROBE_TIMEOUT_MS });
        result = { state: "responsive" };
      } catch (error) {
        result = error instanceof AcpRpcError ? { state: "responsive" }
          : handle.controlLoss ? { state: "lost", controlEvidence: handle.controlLoss } : { state: "degraded" };
      }
    }
    if (this.handles.get(handle.workAttemptId) === handle) {
      this.emitExecution(handle, { domain: "control", kind: "state_changed", sideEffects: "none", ...result });
    }
    return result;
  }

  /** The requests agy waits on under Ask before writes, as snapshots for the daemon's approval broker. */
  async observePermissions(
    providerHandle: ProviderHandle,
    listener: (event: ClaudePermissionObservation) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const handle = this.requireHandle(providerHandle);
    if (signal.aborted) return;
    const notify = () => {
      if (signal.aborted) return;
      try {
        if (this.handles.get(handle.workAttemptId) !== handle || handle.terminal || handle.stopRequested) listener({ type: "unavailable" });
        else if (!handle.permissionControlAvailable) listener({ type: "degraded" });
        else listener({ type: "snapshot", requests: [...handle.permissionRequests.values()].map((pending) => structuredClone(pending.native)) });
      } catch { /* observer failures do not alter permission decisions */ }
    };
    const closed = (event: Extract<ClaudePermissionObservation, { type: "request_closed" }>) => {
      if (!signal.aborted) listener(event);
    };
    handle.permissionClosureListeners.add(closed);
    handle.permissionListeners.add(notify);
    notify();
    await new Promise<void>((resolve) => {
      const stop = () => { handle.permissionListeners.delete(notify); handle.permissionClosureListeners.delete(closed); resolve(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }

  async correlatePermissionTurn(providerHandle: ProviderHandle, request: AntigravityNativePermissionRequest): Promise<
    { outcome: "correlation_unproven" } | { outcome: "correlated"; providerContinuationId: string; providerTurnId: string }
  > {
    const handle = this.requireHandle(providerHandle);
    const pending = this.currentPermission(handle, request);
    return pending ? { outcome: "correlated", providerContinuationId: handle.providerContinuationId, providerTurnId: pending.turnId }
      : { outcome: "correlation_unproven" };
  }

  /** Send the owner's answer to the exact request agy still waits on. */
  async replyPermission(
    providerHandle: ProviderHandle,
    expected: AntigravityNativePermissionRequest,
    reply: "once" | "reject",
    options?: ProviderPermissionDispatchOptions,
  ): Promise<{ outcome: "sent"; scope: "request" }> {
    const handle = this.requireHandle(providerHandle);
    const refuse = () => Object.assign(new Error("Antigravity permission request is no longer pending on the exact turn."), { outcome: "not_dispatched" });
    if (!["once", "reject"].includes(reply) || !options?.beforeNativeDispatch) throw refuse();
    const pending = this.currentPermission(handle, expected);
    if (!pending || pending.dispatching) throw refuse();
    const optionId = antigravityPermissionOption(pending.options, reply);
    if (!optionId) throw refuse();
    pending.dispatching = true;
    let dispatched = false;
    try {
      await options.beforeNativeDispatch();
      if (this.currentPermission(handle, expected) !== pending) throw refuse();
      options.assertNativeDispatch?.();
      if (this.currentPermission(handle, expected) !== pending) throw refuse();
      dispatched = true;
      handle.permissionRequests.delete(expected.id);
      if (reply === "reject" && handle.activeTurn?.turnId === pending.turnId) {
        handle.activeTurn.refusedTool = true;
        (handle.activeTurn.deniedTools ??= new Set()).add(pending.toolCallId);
      }
      pending.settle({ outcome: { outcome: "selected", optionId } });
      return { outcome: "sent", scope: "request" };
    } catch (error) {
      if (dispatched) throw Object.assign(new Error("Antigravity approval dispatch cannot be confirmed."), { outcome: "uncertain" });
      pending.dispatching = false;
      throw error;
    } finally {
      if (dispatched) handle.permissionsChanged();
    }
  }

  private currentPermission(handle: AntigravityHandle, expected: AntigravityNativePermissionRequest) {
    const pending = handle.permissionRequests.get(expected.id);
    if (!pending || !isDeepStrictEqual(pending.native, expected)
      || this.handles.get(handle.workAttemptId) !== handle || handle.terminal || handle.stopRequested
      || !handle.permissionControlAvailable || handle.activeTurn?.turnId !== pending.turnId) return null;
    const identity = handle.providerConnection.processIdentity;
    return identity && this.deps.getProcessIdentity(handle.pid) === identity ? pending : null;
  }

  async inspectTurn(providerHandle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.requireHandle(providerHandle);
    if (handle.activeTurn?.turnId === turnId) return "active";
    if (handle.roomTurnResults.has(turnId) || (handle.observedTurn?.id === turnId && handle.observedTurn.terminal)) return "terminal";
    return "unknown";
  }

  async inspectTurnBoundary(providerHandle: ProviderHandle): Promise<NativeTurnBoundary> {
    const handle = this.requireHandle(providerHandle);
    const identity = handle.providerConnection.processIdentity;
    if (handle.terminal || !identity) return { state: "unknown" };
    return handle.activeTurn
      ? { state: "active", providerContinuationId: handle.providerContinuationId, nativeProcessIdentity: identity, providerTurnId: handle.activeTurn.turnId }
      : { state: "idle", providerContinuationId: handle.providerContinuationId, nativeProcessIdentity: identity, latestProviderTurnId: handle.observedTurn?.id ?? null };
  }

  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Antigravity continuation is terminal; no bounded room turn can run.");
    if (handle.state === "failed") throw new Error("Antigravity continuation has failed; no bounded room turn can run.");
    if (handle.activeTurn) throw new Error("Antigravity continuation already has a bounded room turn in progress.");
    if (!request.inboxItemId.trim() || !request.actionId.trim()) throw new Error("Bounded Antigravity room turn requires durable inbox and action ids.");

    // ACP has no turn ids of its own; this one is minted before the prompt is sent, so it is durable first.
    const turnId = randomUUID();
    await (options.beforeNativeDispatch ?? options.markDispatched)?.();
    await options.checkpointTurnStarted?.(turnId);
    const context = handle.roomContext.prepare(request, handle.providerContinuationId);
    // Hooks or plugins added to the workspace since launch would run with this prompt, unasked.
    const workspaceRefusal = handle.authority.dangerouslySkipPermissions || !handle.cwd ? null : this.deps.workspaceRefusal(handle.cwd, "turn");
    const prompt = workspaceRefusal ? Promise.resolve({ stopReason: null, error: workspaceRefusal }) : handle.connection.request<Record<string, unknown> | null>("session/prompt", {
      sessionId: handle.providerContinuationId,
      prompt: antigravityPromptBlocks(boundedAntigravityRoomTurnPrompt(request, context.lines, handle.authority), request),
    }).then(
      (result) => ({ stopReason: acpString(acpRecord(result)?.stopReason), error: null }),
      (error: unknown) => {
        // An error answer to this prompt is the agent's own ending of it. A closed
        // connection is not: the process ended, and recovery reports that.
        if (error instanceof AcpRpcError) return { stopReason: null, error: error.message.slice(0, 600) || "Antigravity failed this turn." };
        throw error;
      },
    );
    const stagedFiles = new Set((request.attachments ?? []).flatMap((attachment) =>
      attachment.status === "file" && attachment.file?.path ? antigravityPathForms(attachment.file.path) : []));
    const turn: AntigravityActiveTurn = { turnId, text: [], refusedTool: false, toolStatuses: new Map(), result: prompt,
      openCommands: new Set(), lastUpdateAt: Date.now(), lastUsageAt: 0, lastCommandEndAt: 0, stagedFiles };
    turn.settled = this.settleWholeTurn(handle, turn);
    handle.activeTurn = turn;
    handle.state = "working";
    this.emitTurnActive(handle, turnId);
    try {
      const ended = await this.awaitTurnResult(turn, options.detachSignal);
      const result = this.classify(handle, turn, ended);
      return await this.settleTurn(handle, turn, result, options, () => context.commit());
    } catch (error) {
      handle.roomContext.reset();
      throw error;
    } finally {
      if (handle.activeTurn === turn && handle.roomTurnResults.has(turnId)) handle.activeTurn = null;
    }
  }

  private classify(handle: AntigravityHandle, turn: AntigravityActiveTurn, ended: { stopReason: string | null; error: string | null }): ProviderRoomTurnResult {
    const text = turn.text.join("");
    return classifyAntigravityTurn(turn.turnId, handle.providerContinuationId, {
      stopReason: ended.stopReason, error: ended.error, refusedTool: turn.refusedTool,
      text: turn.backgroundCut && text.trim() ? `${text.trimEnd()}\n\nA command this turn started was still running when this reply was posted.` : text,
    });
  }

  /**
   * The whole room turn: the prompt's own result, then any command agy left
   * running when it returned `end_turn`. agy answers such a command by itself
   * when it ends, with no prompt open; that reply belongs to this turn. It
   * ends with a usage update, then a moment of quiet. Last, a turn that ended
   * on an error step of agy's conversation is that error, not an answer.
   */
  private async settleWholeTurn(handle: AntigravityHandle, turn: AntigravityActiveTurn): Promise<{ stopReason: string | null; error: string | null }> {
    const ended = await turn.result;
    if (ended.stopReason !== "end_turn" || ended.error) return ended;
    if (turn.openCommands.size) {
      this.emitStream(handle, { kind: "provider_event", method: "letagents/background_work",
        summary: "Waiting for a command this turn started", payload: { state: "waiting", commands: turn.openCommands.size } });
      const started = Date.now();
      for (;;) {
        if (turn.cancelRequested) return { stopReason: "cancelled", error: null };
        if (handle.terminal) throw new Error("Antigravity's process ended while the turn waited for its command.");
        const now = Date.now();
        if (!turn.openCommands.size) {
          const replied = turn.lastUsageAt >= turn.lastCommandEndAt && now - turn.lastUpdateAt >= this.backgroundQuietMs;
          if (replied || now - turn.lastCommandEndAt >= this.backgroundReplyWaitMs) break;
        } else if (now - started >= this.backgroundCommandWaitLimitMs) {
          turn.backgroundCut = true;
          break;
        }
        // A held turn is live work: its wait keeps the process up, unlike the unref'd `delay`.
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, this.backgroundQuietMs)));
      }
    }
    if (handle.geminiDir) {
      const failure = await this.deps.readLastStepError(join(handle.geminiDir, "antigravity-cli", "conversations", `${handle.providerContinuationId}.db`));
      if (failure) return { stopReason: null, error: failure };
    }
    return ended;
  }

  private async awaitTurnResult(turn: AntigravityActiveTurn, detachSignal?: AbortSignal): Promise<{ stopReason: string | null; error: string | null }> {
    const whole = turn.settled ?? turn.result;
    if (!detachSignal) return whole;
    if (detachSignal.aborted) throw new Error("Antigravity room-turn observation was detached.");
    return new Promise((resolve, reject) => {
      const detached = () => reject(new Error("Antigravity room-turn observation was detached."));
      detachSignal.addEventListener("abort", detached, { once: true });
      whole.then(resolve, reject).finally(() => detachSignal.removeEventListener("abort", detached));
    });
  }

  private async settleTurn(
    handle: AntigravityHandle,
    turn: AntigravityActiveTurn,
    result: ProviderRoomTurnResult,
    options: Pick<ProviderRoomTurnOptions, "checkpointTerminalResult">,
    commitContext: () => void,
  ): Promise<ProviderRoomTurnResult> {
    handle.cancelPendingPermissions(turn.turnId);
    handle.closePermissions((_toolCallId, turnId) => turnId === turn.turnId);
    handle.roomTurnResults.set(turn.turnId, result);
    this.emitTurnTerminal(handle, turn.turnId, result.outcome === "reply" || result.outcome === "no_reply" ? "completed"
      : result.outcome === "unreadable" ? "unreadable" : result.outcome);
    if (handle.activeTurn === turn) handle.activeTurn = null;
    if (!handle.terminal && handle.state === "working") handle.state = "idle";
    await options.checkpointTerminalResult?.(result);
    handle.roomTurnResults.delete(turn.turnId);
    if (result.outcome === "reply" || result.outcome === "no_reply") commitContext();
    else handle.roomContext.reset();
    return result;
  }

  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    handle.roomContext.reset();
    const turnId = request.providerTurnId.trim();
    if (!turnId) throw new AntigravityRoomTurnRecoveryError("Antigravity room-turn recovery requires an exact persisted turn id.");
    const kept = handle.roomTurnResults.get(turnId);
    if (kept) {
      await options.checkpointTerminalResult?.(kept);
      handle.roomTurnResults.delete(turnId);
      return kept;
    }
    const active = handle.activeTurn;
    if (active?.turnId === turnId && !handle.terminal) {
      const ended = await this.awaitTurnResult(active, options.detachSignal);
      const result = this.classify(handle, active, ended);
      return this.settleTurn(handle, active, result, options, () => undefined);
    }
    // An ACP prompt lives in the process that ran it: once that process has
    // ended, the turn can never end with an answer. agy's `session/resume`
    // continues the conversation, not the cut-off prompt.
    if (request.originProcessEnded || (handle.terminal && active?.turnId === turnId)) {
      const result: ProviderRoomTurnResult = {
        turnId,
        providerContinuationId: request.providerContinuationId ?? handle.providerContinuationId,
        outcome: "interrupted", text: null, evidence: "stream", error: PROCESS_ENDED_DURING_TURN,
      };
      if (request.recordEnding) this.emitTurnTerminal(handle, turnId, "interrupted");
      await options.checkpointTerminalResult?.(result);
      return result;
    }
    throw new AntigravityRoomTurnRecoveryError("Antigravity room-turn recovery cannot prove the persisted exact turn reached a terminal boundary.");
  }

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Antigravity continuation is terminal; no turn can be controlled.");
    if (correction?.trim()) {
      throw new ProviderTurnControlError(
        "Antigravity daemon-inbox turn control can stop the active bounded turn, but cannot start an unjournaled correction turn.",
        "not_applied",
      );
    }
    const active = handle.activeTurn;
    const expectedTurnId = options.targetTurnId?.trim() || null;
    if (!active || (expectedTurnId && active.turnId !== expectedTurnId)) {
      // A finished or superseded turn is a no-op: the retry of an old stop never reaches a newer turn.
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: active ? "working" : "idle" };
    }
    await options.checkpointTurnStarted?.(active.turnId);
    await options.markDispatched?.();
    if (handle.activeTurn !== active) {
      throw new ProviderTurnControlError("Antigravity reached a terminal turn boundary before the stop was sent.", "not_applied");
    }
    try {
      active.cancelRequested = true;
      handle.connection.notify("session/cancel", { sessionId: handle.providerContinuationId });
      // ACP: after a cancel the client answers every request it still holds with `cancelled`.
      handle.cancelPendingPermissions(active.turnId);
    } catch (error) {
      throw new ProviderTurnControlError(`Antigravity could not be told to stop: ${error instanceof Error ? error.message : String(error)}`, "not_applied");
    }
    // Only the prompt's own `cancelled` result proves the turn stopped.
    const ended = await Promise.race([
      (active.settled ?? active.result).then(value => ({ value }), (error: unknown) => ({ error })),
      delay(this.turnControlTimeoutMs).then(() => null),
    ]);
    if (!ended) {
      throw new ProviderTurnControlError("Antigravity accepted the stop, but its turn did not end in time.", "uncertain");
    }
    if ("error" in ended) {
      throw new ProviderTurnControlError("Antigravity's process ended while the turn was being stopped.", "uncertain");
    }
    return { capability: "native_interrupt", interrupted: ended.value.stopReason === "cancelled", resumed: false, state: "idle" };
  }
}
