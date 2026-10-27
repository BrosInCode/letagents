import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { NO_REPLY_FAILURE } from "../../../../../../shared/room-turn-no-reply.mjs";
import type { ClaudePermissionObservation, ClaudeNativePermissionRequest, ProviderPermissionDispatchOptions } from "../../../../shared/provider-permissions.js";
import { sameProviderConnectionIdentity, PROCESS_ENDED_DURING_TURN, type ProviderActivityEvent, type ProviderAdapter, type ProviderAdapterCapabilities, type ProviderAttachTerminal, type ProviderContinuationRef, type ProviderHandle, type ProviderRoomTurnOptions, type ProviderRoomTurnRecoveryRequest, type ProviderRoomTurnRequest, type RoomTurnImageDelivery, type RoomTurnFileAccess, type ProviderRoomTurnResult, type ProviderSpawnRequest, type ProviderStopOptions, type ProviderTurnControlResult, ProviderTurnControlError, type ProviderTurnControlOptions, type ProviderStreamEvent, type ProviderTerminalPayload, type NativeExecutionObservation, type NativeExecutionSubscription, type ControlProbeResult } from "../provider-adapter.js";
import { nativeExecutionId } from "../provider-execution-observer.js";
import { delay, sameProcessBirthIdentity } from "../provider-evidence.js";
import { exactClaudeStreamTerminal, recoverExactClaudeTurnFromSession, recoverExactClaudeTurnFailureFromSession } from "../claude-room-turn-evidence.js";
import { ClaudeAdapterLaunch } from "./adapter-launch.js";
import { CLAUDE_BACKGROUND_WORK_TEXT } from "./background-work-text.js";
import { ClaudeRoomTurnRecoveryError } from "./errors.js";
import { BASE_CLAUDE_CAPABILITIES } from "./launch-args.js";
import { ClaudeProviderHandle } from "./provider-handle.js";
import { boundedClaudeRoomTurnPrompt, sessionIdOf, streamMethod, userStreamJsonLine } from "./stream-messages.js";
import type { ClaudeRoomTurnTerminal } from "./types.js";

// Claude Code through its native headless CLI. The daemon owns room ingress,
// exact-turn dispatch, retry, credentials, and publication; this adapter owns
// only the native process/session boundary. The Add Agent launch policy is
// forwarded verbatim, while LetAgents MCP effects borrow the daemon's exact
// generation grant instead of inheriting desktop owner authority.

export class ClaudeCodeProviderAdapter extends ClaudeAdapterLaunch implements ProviderAdapter {
  runtimeCustody(workAttemptId: string, providerHandle?: ProviderHandle): "absent" | "owned" | "unknown" {
    const handle = this.handles.get(workAttemptId);
    return this.processCustody.state(workAttemptId, handle === providerHandle ? handle?.child : undefined);
  }

  async readUsage(providerHandle: ProviderHandle): Promise<import("../../../../shared/provider-usage.js").ProviderUsage | null> {
    const handle = this.handles.get(providerHandle.workAttemptId);
    if (!handle || handle !== providerHandle) return null;
    const tracker = this.usage.get(handle);
    return tracker?.snapshot(handle.providerContinuationId) ?? null;
  }

  compactionProgress(workAttemptId: string): { state: "compacting"; startedAt: string } | null {
    return this.compactions.get(workAttemptId)?.progress() ?? null;
  }

  capabilities(): ProviderAdapterCapabilities {
    return { ...BASE_CLAUDE_CAPABILITIES };
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async resume(
    ref: ProviderContinuationRef,
    req: ProviderSpawnRequest,
  ): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) {
      throw new Error("Claude resume ref must belong to the same work attempt.");
    }
    return this.start(req, ref);
  }

  /**
   * A CLI child has no reconnectable control channel: its stdio died with the
   * supervisor that spawned it. So attach can never return a live handle for a
   * fresh adapter — it either proves the recorded child absent (null), or, when
   * the exact birth identity is verifiably still running, FENCES it per the
   * msg_1188 invariant (TERM → grace → identity recheck → KILL → await
   * identity disappearance) and then reports absent, so the reconciler proceeds
   * to bounded recovery without ever risking a second writer. Unverifiable
   * state throws ambiguous and blocks replacement.
   */
  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const handle = this.handles.get(ref.workAttemptId);
    const authorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    if (handle && !handle.terminal
      && handle.providerContinuationId === ref.providerContinuationId
      && handle.lifecycleAuthorityMode === authorityMode
      && sameProviderConnectionIdentity(handle.providerConnection, ref.providerConnection)) {
      return handle;
    }
    if (handle) return null;
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "claude_cli") return null;

    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) {
      if (pending.ref.providerContinuationId !== ref.providerContinuationId
        || (pending.ref.lifecycleAuthorityMode ?? "typed_shadow") !== authorityMode
        || !sameProviderConnectionIdentity(pending.ref.providerConnection, connection)) return null;
      return pending.promise;
    }
    const attaching = this.fenceRecordedChild(connection, ref.providerContinuationId).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId)?.promise === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, { ref, promise: attaching });
    return attaching;
  }

  async poke(_handle: ProviderHandle, _message: string): Promise<void> {
    throw new Error(
      "Claude mid-turn message injection is not supported; only native interruption is available.",
    );
  }

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Claude continuation is terminal; no turn can be controlled.");
    const text = correction?.trim() || null;
    if (text) {
      throw new ProviderTurnControlError(
        "Claude daemon-inbox turn control can stop the active bounded turn, but cannot start an unjournaled correction turn.",
        "not_applied",
      );
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    const activeTurnId = handle.activeRoomTurnId;
    if (expectedTurnId && activeTurnId !== expectedTurnId) {
      // The checkpointed A is no longer active. B, if present, is outside the
      // old action's authority and must never be interrupted by its retry.
      return {
        capability: "native_interrupt",
        interrupted: false,
        resumed: false,
        state: activeTurnId ? "working" : "idle",
      };
    }
    const active = Boolean(activeTurnId);
    if (active) {
      const resultBoundary = this.waitForNextTurnResult(handle);
      await options.checkpointTurnStarted?.(activeTurnId!);
      await options.markDispatched?.();
      if (handle.activeRoomTurnId !== activeTurnId) {
        const result = await resultBoundary;
        throw new ProviderTurnControlError(
          `Claude returned ${streamMethod(result)} before the interrupt was dispatched.`,
          "not_applied",
        );
      }
      const held = handle.heldRoomTurn;
      if (held?.turnId === activeTurnId) {
        // The command has ended with its answer, and the turn only waits for background work. The owner ends
        // that wait: the turn ends now, with the texts it has. Nothing of the turn was interrupted, so the
        // reply stands and is posted. The interrupt that ends the wait stops the answer to a task's notice,
        // and a sub-agent that still runs. A command in the background goes on (each captured).
        this.settleHeldRoomTurn(handle, held, "owner");
        return { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" };
      }
      handle.pendingInterruptTurnId = activeTurnId!;
      try {
        this.writeInterrupt(handle);
      } catch (error) {
        if (handle.pendingInterruptTurnId === activeTurnId) handle.pendingInterruptTurnId = null;
        throw error;
      }
      // A control_response acknowledgement is intentionally insufficient. The
      // subsequent result event is the only proof that the queued/live turn
      // actually reached an interrupted boundary.
      const result = await resultBoundary;
      const subtype = typeof result.subtype === "string" ? result.subtype.toLowerCase() : "";
      const resultTurnId = typeof result.user_message_uuid === "string"
        ? result.user_message_uuid.trim()
        : "";
      const contextualInterrupt = handle.contextualInterruptResults.has(result);
      if (
        !contextualInterrupt
        && (subtype !== "interrupted"
          || sessionIdOf(result) !== handle.providerContinuationId
          || resultTurnId !== activeTurnId)
      ) {
        const exactTargetTerminal = sessionIdOf(result) === handle.providerContinuationId
          && resultTurnId === activeTurnId
          && Boolean(exactClaudeStreamTerminal(result, activeTurnId!, handle.providerContinuationId));
        throw new ProviderTurnControlError(
          `Claude returned ${streamMethod(result)} instead of an exact-session interrupted boundary.`,
          exactTargetTerminal ? "not_applied" : "uncertain",
        );
      }
      handle.state = "idle";
    }
    return {
      capability: "native_interrupt",
      interrupted: active,
      resumed: false,
      state: "idle",
    };
  }

  /** Claude Code takes base64 image blocks on stdin and resizes them itself. */
  roomTurnImageDelivery(): RoomTurnImageDelivery {
    return "memory";
  }

  /** Claude Code's Read tool opens text and PDFs anywhere on this machine, at every permission level it is launched with. */
  roomTurnFileAccess(): RoomTurnFileAccess {
    return { text: true, pdf: true };
  }

  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Claude continuation is terminal; no bounded room turn can run.");
    if (handle.state === "failed") throw new Error("Claude continuation has failed; no bounded room turn can run.");
    if (handle.roomTurnOperationId || handle.activeRoomTurnId) {
      throw new Error("Claude continuation already has a bounded room turn in progress.");
    }
    if (!request.inboxItemId.trim() || !request.actionId.trim()) {
      throw new Error("Bounded Claude room turn requires durable inbox and action ids.");
    }

    const turnId = randomUUID();
    handle.roomTurnOperationId = turnId;
    handle.contextualInterruptTerminalTurnId = null;
    let terminalPromise: Promise<ClaudeRoomTurnTerminal> | null = null;
    try {
      await options.beforeNativeDispatch?.();
      // Claude accepts a caller-supplied UUID, so durability can record the
      // exact native identity before the stdin write that starts the turn.
      await options.checkpointTurnStarted?.(turnId);
      terminalPromise = this.waitForExactRoomTurn(handle, turnId, options.detachSignal);
      handle.activeRoomTurnId = turnId;
      if (handle.lifecycleAuthorityMode !== "typed") handle.state = "working";
      handle.executionTurnId = turnId;
      handle.executionTurnStarted = false;
      handle.executionTerminalCheckpoint = null;
      handle.executionTools.clear();
      const context = handle.roomContext.prepare(request, handle.providerContinuationId);
      try {
        handle.child.writeLine(userStreamJsonLine(boundedClaudeRoomTurnPrompt(request, context.lines), turnId, request.attachments));
      } catch (error) {
        // The exact id is durable, but the native write did not occur. Release
        // the local waiter and fail this continuation so recovery/reconcile can
        // proceed without leaving a permanent "turn in progress" fence.
        handle.activeRoomTurnId = null;
        handle.state = "failed";
        handle.protocolError = true;
        handle.executionTurnId = null;
        handle.executionTurnStarted = false;
        throw error;
      }
      const terminal = await terminalPromise;
      const result = this.providerRoomTurnResult(handle, terminal);
      await options.checkpointTerminalResult?.(result);
      if (!("error" in terminal) || options.checkpointTerminalResult) handle.roomTurnResults.delete(turnId);
      if ((result.outcome === "reply" || result.outcome === "no_reply")
        && handle.permissionControlAvailable && !handle.terminal && !options.detachSignal?.aborted) context.commit();
      else handle.roomContext.reset();
      return result;
    } catch (error) {
      handle.roomContext.reset();
      if (terminalPromise && handle.activeRoomTurnId !== turnId) {
        this.removeExactRoomTurnWaiters(handle, turnId, error);
        await terminalPromise.catch(() => undefined);
      }
      throw error;
    } finally {
      if (handle.roomTurnOperationId === turnId) handle.roomTurnOperationId = null;
      if (handle.activeRoomTurnId === turnId && handle.roomTurnResults.has(turnId)) {
        handle.activeRoomTurnId = null;
      }
    }
  }

  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    handle.roomContext.reset();
    const turnId = request.providerTurnId.trim();
    if (!turnId) {
      throw new ClaudeRoomTurnRecoveryError("Claude room-turn recovery requires an exact persisted turn id.");
    }

    let terminal = handle.roomTurnResults.get(turnId) ?? null;
    if (!terminal && handle.activeRoomTurnId === turnId) {
      terminal = await this.waitForExactRoomTurn(handle, turnId, options.detachSignal);
    }
    let cutOffByExit = false;
    let providerErrorInSession = false;
    if (!terminal) {
      // The turn's own result already proved that it completed, and carried
      // no answer. This read looks for the answer in the session instead.
      // The process that saw the result holds that proof in memory. The
      // daemon holds it saved, for a read after that process or the daemon
      // itself has ended.
      const completedWithoutAnswer = request.savedAsUnreadable === true || handle.roomTurnsWithoutAnswer.has(turnId);
      // With that proof a session that cannot be read changes nothing: it
      // would be read the same way again, and there is no answer to wait for.
      const rows = await this.deps.readSessionRows(handle.providerContinuationId, handle.transcriptsRoot).catch((error: unknown) => {
        if (!completedWithoutAnswer) throw error;
        return null;
      });
      // No transcript where the CLI writes it proves nothing about the turn:
      // it is left for its owner, as before, rather than settled as cut off.
      if (rows === null && !completedWithoutAnswer) {
        throw new ClaudeRoomTurnRecoveryError("Claude room-turn recovery found no transcript for the conversation where the CLI keeps it.");
      }
      terminal = rows && recoverExactClaudeTurnFromSession(rows, turnId, handle.providerContinuationId);
      // The turn started background work, and the session does not prove the reply complete. The reply says so
      // in one plain line, as a turn that is held open does when it ends before all of that work was answered.
      if (terminal && !("error" in terminal) && terminal.outcome === "reply" && terminal.backgroundWork) {
        terminal = { turnId, outcome: "reply", evidence: terminal.evidence, text: `${terminal.text}\n\n${terminal.backgroundWork === "ended_unreported"
          ? CLAUDE_BACKGROUND_WORK_TEXT.notReported : CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession}` };
      }
      // A turn that ended on a provider error has it in the session; that
      // is how it ended, and its reason is the provider's.
      if (!terminal && rows) {
        terminal = recoverExactClaudeTurnFailureFromSession(rows, turnId, handle.providerContinuationId);
        providerErrorInSession = terminal !== null;
      }
      // Neither the result nor the session holds an answer, and the turn is
      // known to have completed: there is no answer to wait for. Reporting it
      // unreadable once more would block the agent on a read that cannot
      // change. It is the settled failure every provider reports for a model
      // that wrote no reply, which task continuity knows how to follow up.
      if (completedWithoutAnswer && (!terminal || (!("error" in terminal) && terminal.outcome === "unreadable"))) {
        terminal = { turnId, nativeOutcome: "failed", error: NO_REPLY_FAILURE.emptyAnswer };
      }
      // The session holds no ending for this turn, and the process that ran
      // it has ended: no ending will ever be written. The turn was cut off by
      // that exit, and is reported as that instead of being waited for. A last
      // message with no answer in it is no ending either: the CLI goes on
      // after such a message, and only the turn's own result, which was not
      // seen here, could prove that the turn ended there.
      if ((!terminal || (!("error" in terminal) && terminal.outcome === "unreadable")) && request.originProcessEnded) {
        cutOffByExit = true;
        terminal = { turnId, nativeOutcome: "interrupted", error: PROCESS_ENDED_DURING_TURN };
      }
      // The process that ran this turn exited before it reported the turn's
      // result, and this one is sent no result for a turn that ended before
      // it started. The session's own record is then the only place the
      // ending exists. The daemon says when its execution record still holds
      // the turn open; the ending is recorded there too, or the turn would
      // refuse every later turn of this agent.
      if (terminal && request.recordEnding && nativeExecutionId(handle.providerContinuationId) && nativeExecutionId(turnId)) {
        handle.execution.emit({ domain: "turn", kind: "state_changed", state: "terminal", sideEffects: "none",
          providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
          turnOutcome: "error" in terminal ? terminal.nativeOutcome
            : terminal.outcome === "unreadable" ? "unreadable" : "completed" },
        handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.processIdentity ?? undefined : undefined,
        handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.pid ?? undefined : undefined);
      }
    }
    if (!terminal) {
      throw new ClaudeRoomTurnRecoveryError(
        "Claude room-turn recovery cannot prove the persisted exact turn reached a terminal boundary.",
      );
    }

    // What was read is the session's own record of the turn, not a stream.
    const result: ProviderRoomTurnResult = cutOffByExit
      ? { turnId, providerContinuationId: handle.providerContinuationId, outcome: "interrupted", text: null, evidence: "transcript", error: PROCESS_ENDED_DURING_TURN }
      : providerErrorInSession ? { ...this.providerRoomTurnResult(handle, terminal), evidence: "transcript" } as ProviderRoomTurnResult
        : this.providerRoomTurnResult(handle, terminal);
    await options.checkpointTerminalResult?.(result);
    if (!("error" in terminal) || options.checkpointTerminalResult) handle.roomTurnResults.delete(turnId);
    if (result.outcome !== "unreadable") handle.roomTurnsWithoutAnswer.delete(turnId);
    return result;
  }

  async stopRef(ref: ProviderContinuationRef, options: ProviderStopOptions = {}): Promise<ProviderTerminalPayload> {
    ref = { ...ref, providerConnection: ref.providerConnection && { ...ref.providerConnection } };
    const connection = ref.providerConnection;
    const graceMs = options.graceMs ?? this.stopGraceMs;
    const birthEvidence = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+\d{4}(?:\s|$)/;
    if (!ref.workAttemptId?.trim() || !ref.providerContinuationId?.trim()
      || connection?.kind !== "claude_cli" || !Number.isSafeInteger(connection.pid) || connection.pid! <= 0
      || typeof connection.processIdentity !== "string" || !birthEvidence.test(connection.processIdentity.trim())
      || !Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("Claude exact-reference stop requires an exact continuation and process birth.");
    }
    const known = [...this.handles.values()].find(handle => handle.pid === connection.pid
      && handle.providerConnection.processIdentity
      && sameProcessBirthIdentity(handle.providerConnection.processIdentity, connection.processIdentity!));
    if (known && (known.workAttemptId !== ref.workAttemptId || known.providerContinuationId !== ref.providerContinuationId
      || !sameProviderConnectionIdentity(known.providerConnection, connection))) {
      throw new Error("Claude exact-reference stop conflicts with the known native process owner.");
    }
    if (known) {
      known.stopRequested = true;
      known.clearPermissions();
      known.state = "stopping";
      known.child.markIntentionalClose();
    }
    // A cached protocol terminal is not evidence that the process stopped.
    const result = await this.fenceRecordedChild(connection, ref.providerContinuationId,
      { force: options.force === true, graceMs, birthEvidence });
    return result.terminal;
  }

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    if (handle.pid === null) {
      throw new Error("Cannot stop a Claude CLI child without an observed process id.");
    }

    handle.stopRequested = true;
    handle.clearPermissions();
    handle.state = "stopping";
    handle.child.markIntentionalClose();
    const exitPromise = this.requireExitPromise(handle);
    if (options.force) {
      this.deps.signalProcess(handle.pid, "SIGKILL");
      return exitPromise;
    }

    this.deps.signalProcess(handle.pid, "SIGTERM");
    const graceMs = options.graceMs ?? this.stopGraceMs;
    const graceful = await Promise.race([
      exitPromise.then((payload) => ({ payload })),
      delay(graceMs).then(() => null),
    ]);
    if (graceful) return graceful.payload;

    this.deps.signalProcess(handle.pid, "SIGKILL");
    return exitPromise;
  }

  onExit(
    providerHandle: ProviderHandle,
    listener: (payload: ProviderTerminalPayload) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) {
      queueMicrotask(() => listener(handle.terminal!));
      return () => {};
    }
    handle.exitListeners.add(listener);
    return () => handle.exitListeners.delete(listener);
  }

  onActivity(
    providerHandle: ProviderHandle,
    listener: (event: ProviderActivityEvent) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.activityListeners.add(listener);
    return () => handle.activityListeners.delete(listener);
  }

  onStream(
    providerHandle: ProviderHandle,
    listener: (event: ProviderStreamEvent) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.streamListeners.add(listener);
    return () => handle.streamListeners.delete(listener);
  }

  onExecution(providerHandle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.requireHandle(providerHandle).execution.subscribe(listener);
  }

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
        else listener({ type: "snapshot", requests: [...handle.permissionRequests.values()].map(value => structuredClone(value.native)) });
      } catch { /* Observer failures do not alter permission decisions. */ }
    };
    const closed = (event: Extract<ClaudePermissionObservation, { type: "request_closed" }>) => {
      if (!signal.aborted) listener(event);
    };
    handle.permissionClosureListeners.add(closed);
    handle.permissionListeners.add(notify);
    notify();
    await new Promise<void>(resolve => {
      const stop = () => { handle.permissionListeners.delete(notify); handle.permissionClosureListeners.delete(closed); resolve(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }

  async correlatePermissionTurn(providerHandle: ProviderHandle, request: ClaudeNativePermissionRequest): Promise<
    { outcome: "correlation_unproven" } | { outcome: "correlated"; providerContinuationId: string; providerTurnId: string }
  > {
    const handle = this.requireHandle(providerHandle);
    const pending = this.currentPermission(handle, request);
    return pending ? { outcome: "correlated", providerContinuationId: handle.providerContinuationId, providerTurnId: pending.turnId }
      : { outcome: "correlation_unproven" };
  }

  async replyPermission(providerHandle: ProviderHandle, expected: ClaudeNativePermissionRequest,
    reply: "once" | "reject", options?: ProviderPermissionDispatchOptions,
  ): Promise<{ outcome: "sent"; scope: "request" }> {
    const handle = this.requireHandle(providerHandle);
    const refuse = () => Object.assign(new Error("Claude permission request is no longer pending on the exact turn."), { outcome: "not_dispatched" });
    if (!["once", "reject"].includes(reply) || !options?.beforeNativeDispatch) throw refuse();
    const pending = this.currentPermission(handle, expected);
    if (!pending || pending.dispatching) throw refuse();
    pending.dispatching = true;
    let dispatched = false;
    try {
      await options.beforeNativeDispatch();
      if (this.currentPermission(handle, expected) !== pending) throw refuse();
      options.assertNativeDispatch?.();
      // The assertion may synchronously revoke or replace the runtime.
      if (this.currentPermission(handle, expected) !== pending) throw refuse();
      dispatched = true;
      handle.child.writeLine(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: pending.native.id,
        response: reply === "once" ? { behavior: "allow", updatedInput: pending.native.request.input }
          : { behavior: "deny", message: "The host rejected this action." },
      } }));
      // Remember the deny for this exact tool, so its error result can be told from any other failure.
      if (reply === "reject") {
        const denied = handle.executionTools.get(pending.native.request.tool_use_id);
        if (denied) denied.hostDenied = true;
      }
      return { outcome: "sent", scope: "request" };
    } catch (error) {
      if (dispatched) throw Object.assign(new Error("Claude approval dispatch cannot be confirmed."), { outcome: "uncertain" });
      pending.dispatching = false;
      throw error;
    } finally {
      if (dispatched) { handle.permissionRequests.delete(expected.id); handle.permissionsChanged(); }
    }
  }

  private currentPermission(handle: ClaudeProviderHandle, expected: ClaudeNativePermissionRequest) {
    const pending = handle.permissionRequests.get(expected.id);
    if (!pending || !isDeepStrictEqual(pending.native, expected)
      || this.handles.get(handle.workAttemptId) !== handle || handle.terminal || handle.stopRequested
      || !handle.permissionControlAvailable || handle.providerConnection.kind !== "claude_cli"
      || !handle.providerConnection.processIdentity
      || this.deps.getProcessIdentity(handle.pid!) !== handle.providerConnection.processIdentity
      || handle.executionTurnId !== pending.turnId || handle.activeRoomTurnId !== pending.turnId
      || !handle.executionTurnStarted || handle.pendingInterruptTurnId) return null;
    const tool = handle.executionTools.get(expected.request.tool_use_id);
    return tool && !tool.completed && tool.name === expected.request.tool_name
      && isDeepStrictEqual(tool.input, expected.request.input) ? pending : null;
  }


  async probeControl(providerHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.requireHandle(providerHandle);
    // A live PID or quiet stdout cannot prove the native control loop responds.
    const result: ControlProbeResult = handle.executionExitObserved
      ? { state: "lost", controlEvidence: "process_exit" }
      : { state: "unprobeable" };
    handle.execution.emit(
      { domain: "control", kind: "state_changed", sideEffects: "none", ...result },
      handle.providerConnection.kind === "claude_cli"
        ? handle.providerConnection.processIdentity ?? undefined
        : undefined,
      handle.providerConnection.kind === "claude_cli"
        ? handle.providerConnection.pid ?? undefined
        : undefined,
    );
    return result;
  }
}
