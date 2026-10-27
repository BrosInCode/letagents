/** The Open Model provider adapter: room turns, turn control, repair, stop, listeners, permissions and the shared instance. */
import { NO_REPLY_FAILURE } from "../../../../../../shared/room-turn-no-reply.mjs";
import { PROCESS_ENDED_DURING_TURN, sameProviderConnectionIdentity, type ProviderActivityEvent, type ProviderAdapter, type ProviderContinuationRepairRequest, type ProviderContinuationRepairResult, type ProviderHandle, type ProviderRoomTurnOptions, type ProviderRoomTurnRecoveryRequest, type ProviderRoomTurnRequest, type RoomTurnImageDelivery, type RoomTurnFileAccess, type ProviderRoomTurnResult, type ProviderStopOptions, type ProviderStreamEvent, type ProviderTerminalPayload, ProviderTurnControlError, type ProviderTurnControlOptions, type ProviderTurnControlResult } from "../provider-adapter.js";
import { delay, sameProcessBirthIdentity } from "../provider-evidence.js";
import { OPEN_MODEL_OPENCODE_PROVIDER_ID } from "../opencode-launch-contract.js";
import { nativeExecutionId } from "../provider-execution-observer.js";
import type { ControlProbeResult, NativeExecutionObservation, NativeExecutionSubscription } from "../../../../shared/execution-protocol.js";
import { assistantsFor, finalAssistantFor, messageCompleted, messageFinishReason, messageText, mintNativeUserMessageId, OpenCodePermissionReplyError, parseOpenCodePermissionEvent, turnUserMessageIds, type OpenCodePermissionRequest, type OpenCodePermissionTurnCorrelation } from "../opencode-server-client.js";
import { OpenCodeBoundedTurnError, OpenCodeTerminalTurnError, safeProviderErrorMessage } from "./errors.js";
import type { OpenCodePermissionObservation } from "./types.js";
import { OpenModelAdapterLaunch } from "./adapter-launch.js";
import { OpenModelHandle } from "./handle.js";
import { boundedRoomTurnPrompt, classifyTurn, deniedToolCall, roomTurnImageParts, unansweredCompletionReason } from "./turn-results.js";
import { terminalFromExit } from "./runtime-launch.js";

export class OpenModelProviderAdapter extends OpenModelAdapterLaunch implements ProviderAdapter {
  /** Only a runtime started with image input for its model takes images. */
  roomTurnImageDelivery(rawHandle: ProviderHandle): RoomTurnImageDelivery {
    try { return this.required(rawHandle).imageInput ? "memory" : null; } catch { return null; }
  }

  /** OpenCode's read tool opens text; a runtime that may not leave its project opens nothing staged. */
  roomTurnFileAccess(rawHandle: ProviderHandle): RoomTurnFileAccess {
    try { return this.required(rawHandle).externalReads ? { text: true, pdf: false } : null; } catch { return null; }
  }

  async runRoomTurn(
    rawHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.required(rawHandle);
    await this.assertNativelyOrderedSession(handle);
    // The turn id becomes the OpenCode user message ID, so it must be minted
    // in OpenCode's own ascending scheme; any other shape convinces its loop
    // that an unanswered user message always remains and the model is
    // re-invoked until the bounded-turn abort fires.
    const turnId = mintNativeUserMessageId(Date.now());
    await (options.beforeNativeDispatch ?? options.markDispatched)?.();
    handle.setState("working");
    await handle.client.promptAsync(handle.providerContinuationId, {
      messageID: turnId,
      model: {
        providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID,
        modelID: handle.configuredModel,
      },
      parts: [{ type: "text", text: boundedRoomTurnPrompt(request) }, ...(handle.imageInput ? roomTurnImageParts(request) : [])],
    }).catch((error) => {
      handle.setState("idle");
      throw error;
    });
    handle.activeRoomTurnId = turnId;
    handle.observedTurn = { id: turnId, terminal: null };
    this.emitTurnActive(handle, turnId);
    await options.checkpointTurnStarted?.(turnId);
    try {
      const result = await this.awaitExactTurn(handle, turnId, options.detachSignal);
      await options.checkpointTerminalResult?.(result);
      handle.setState("idle");
      handle.activeRoomTurnId = null;
      return result;
    } catch (error) {
      if (error instanceof OpenCodeTerminalTurnError && error.terminalResult) {
        try {
          await options.checkpointTerminalResult?.(error.terminalResult);
        } finally {
          if (handle.activeRoomTurnId === turnId) {
            handle.activeRoomTurnId = null;
            handle.setState("idle");
          }
        }
        throw error;
      }
      if (error instanceof OpenCodeBoundedTurnError) {
        await this.abortBoundedTurn(handle, turnId, error);
      } else if (handle.activeRoomTurnId === turnId) {
        // A non-bounded failure (network, read, or checkpoint error) must not
        // leave the handle projecting "working" with a stale active turn id.
        handle.activeRoomTurnId = null;
        handle.setState("idle");
      }
      throw error;
    }
  }

  async recoverRoomTurn(
    rawHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.required(rawHandle);
    if (request.originProcessEnded && request.providerContinuationId
      && request.providerContinuationId !== handle.providerContinuationId) {
      const result = await this.readEarlierSessionTurn(handle, request.providerContinuationId, request.providerTurnId);
      await options.checkpointTerminalResult?.(result);
      return result;
    }
    handle.activeRoomTurnId = request.providerTurnId;
    if (handle.observedTurn?.id !== request.providerTurnId) handle.observedTurn = { id: request.providerTurnId, terminal: null };
    this.emitTurnActive(handle, request.providerTurnId);
    try {
      const result = await this.awaitExactTurn(handle, request.providerTurnId, options.detachSignal, true, request.recordEnding === true);
      await options.checkpointTerminalResult?.(result);
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return result;
    } catch (error) {
      if (error instanceof OpenCodeTerminalTurnError && error.terminalResult) {
        try {
          await options.checkpointTerminalResult?.(error.terminalResult);
        } finally {
          if (handle.activeRoomTurnId === request.providerTurnId) {
            handle.activeRoomTurnId = null;
            handle.setState("idle");
          }
        }
        throw error;
      }
      if (error instanceof OpenCodeBoundedTurnError) {
        await this.abortBoundedTurn(handle, request.providerTurnId, error);
      } else if (handle.activeRoomTurnId === request.providerTurnId) {
        // Mirror runRoomTurn: a non-bounded failure must not leave a leaked
        // "working" projection with a stale active turn id.
        handle.activeRoomTurnId = null;
        handle.setState("idle");
      }
      throw error;
    }
  }

  /**
   * A turn of a session that an earlier process of this agent ran. Every
   * process starts a session of its own, and the sessions of the processes
   * before it stay in the agent's runtime directory, where this one can read
   * them. The process that ran the turn has ended, so the turn is over: this
   * only reads what its session kept of it. An answer is the answer, an
   * error is the failure, and a turn that the session shows without either
   * was cut off by the exit. Nothing is recorded for the running session.
   */
  protected async readEarlierSessionTurn(handle: OpenModelHandle, sessionId: string, turnId: string): Promise<ProviderRoomTurnResult> {
    if (!nativeExecutionId(sessionId) || !nativeExecutionId(turnId)) {
      throw new Error("Open Model turn recovery requires an exact session and turn.");
    }
    const messages = await handle.client.messages(sessionId);
    const turnUserIds = turnUserMessageIds(messages, turnId);
    const finalAssistant = finalAssistantFor(messages, turnId, turnUserIds);
    const failure = safeProviderErrorMessage(finalAssistant);
    if (failure) {
      return { turnId, providerContinuationId: sessionId, outcome: "failed", text: null, evidence: "transcript", error: failure };
    }
    // A last step that called tools is not where the turn ends: it was to go
    // on with their results, and the process ended first. What the model said
    // before the calls is not an answer. Only a call that was refused ends
    // the turn there, as the live turn does, whatever was said before it. And
    // only the turn's last step can end it: a finished step with a later one
    // begun is half-way. A last step that ended without an answer (at the
    // output limit, filtered, or empty) says why, as the live turn does.
    const last = finalAssistant !== null && finalAssistant === assistantsFor(messages, turnId, turnUserIds).at(-1);
    const refused = !last ? null
      : messageFinishReason(finalAssistant) === "tool-calls" && deniedToolCall(finalAssistant) ? NO_REPLY_FAILURE.deniedTool
        : unansweredCompletionReason(finalAssistant);
    if (refused) return { turnId, providerContinuationId: sessionId, outcome: "failed", text: null, evidence: "transcript", error: refused };
    const answered = last && messageCompleted(finalAssistant) && messageFinishReason(finalAssistant) !== "tool-calls"
      ? classifyTurn(turnId, messageText(finalAssistant)) : null;
    if (answered && answered.outcome !== "unreadable") return answered;
    return { turnId, providerContinuationId: sessionId, outcome: "interrupted", text: null, evidence: "transcript",
      error: PROCESS_ENDED_DURING_TURN };
  }

  async inspectTurn(rawHandle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.required(rawHandle);
    const status = await handle.client.status(handle.providerContinuationId);
    if (status === "busy") return "active";
    const messages = await handle.client.messages(handle.providerContinuationId);
    const assistants = assistantsFor(messages, turnId);
    return assistants.some(messageCompleted) ? "terminal" : assistants.length > 0 ? "active" : "unknown";
  }

  async controlTurn(
    rawHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.required(rawHandle);
    if (correction?.trim()) {
      throw new ProviderTurnControlError(
        "Open Model can stop the active bounded turn, but cannot start an unjournaled correction turn.",
        "not_applied",
      );
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    if (await handle.client.status(handle.providerContinuationId) !== "busy") {
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" };
    }
    const activeTurnId = handle.activeRoomTurnId;
    if (expectedTurnId && activeTurnId !== expectedTurnId) {
      // A completed or superseded exact turn is a no-op. Never let retry of A
      // inherit abort authority over the session's newer active B.
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "working" };
    }
    if (!activeTurnId) {
      throw new ProviderTurnControlError(
        "OpenCode has no exact active-turn identity; refusing session-wide abort authority.",
        "uncertain",
      );
    }
    if (activeTurnId) await options.checkpointTurnStarted?.(activeTurnId);
    await options.markDispatched?.();
    if (await handle.client.status(handle.providerContinuationId) !== "busy"
      || (activeTurnId !== null && handle.activeRoomTurnId !== activeTurnId)) {
      throw new ProviderTurnControlError(
        "OpenCode reached a terminal turn boundary before native abort dispatch.",
        "not_applied",
      );
    }
    await handle.client.abort(handle.providerContinuationId);
    await this.waitForSessionIdle(handle, this.turnControlTimeoutMs).catch((error) => {
      throw new ProviderTurnControlError(
        `OpenCode accepted the abort, but its turn boundary could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        "uncertain",
      );
    });
    if (activeTurnId === null || handle.activeRoomTurnId === activeTurnId) {
      handle.activeRoomTurnId = null;
    }
    handle.setState("idle");
    this.emitTurnTerminal(handle, activeTurnId, "interrupted");
    return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
  }

  async repairContinuation(
    rawHandle: ProviderHandle,
    request: ProviderContinuationRepairRequest,
    options: { checkpointReplacement: (providerContinuationId: string) => Promise<void> },
  ): Promise<ProviderContinuationRepairResult> {
    const handle = this.required(rawHandle);
    // A session poisoned by out-of-scheme user message IDs still exists but can
    // never complete another native turn, so it is not rematerializable; only a
    // fresh session restores the loop-exit invariant.
    if (request.checkpointedReplacementProviderContinuationId) {
      const sessions = await handle.client.listSessions();
      if (sessions.some((session) => session.id === request.checkpointedReplacementProviderContinuationId)
        && await this.sessionNativelyOrdered(handle.client, request.checkpointedReplacementProviderContinuationId)) {
        const replacement = this.withContinuation(handle, request.checkpointedReplacementProviderContinuationId);
        replacement.nativeOrderingVerified = true;
        return {
          handle: replacement,
          outcome: "replaced",
          previousProviderContinuationId: request.expectedProviderContinuationId,
          replacementProviderContinuationId: replacement.providerContinuationId,
        };
      }
    }
    if (!request.forceReplacement) {
      const sessions = await handle.client.listSessions();
      if (sessions.some((session) => session.id === request.expectedProviderContinuationId)
        && await this.sessionNativelyOrdered(handle.client, request.expectedProviderContinuationId)) {
        handle.nativeOrderingVerified = true;
        return {
          handle,
          outcome: "rematerialized",
          previousProviderContinuationId: request.expectedProviderContinuationId,
          replacementProviderContinuationId: request.expectedProviderContinuationId,
        };
      }
    }
    const created = await handle.client.createSession("LetAgents restored conversation");
    const replacementId = typeof created.id === "string" ? created.id : "";
    if (!replacementId) throw new Error("OpenCode continuation repair did not return a session id.");
    await options.checkpointReplacement(replacementId);
    const replacement = this.withContinuation(handle, replacementId);
    replacement.nativeOrderingVerified = true;
    return {
      handle: replacement,
      outcome: "replaced",
      previousProviderContinuationId: request.expectedProviderContinuationId,
      replacementProviderContinuationId: replacementId,
    };
  }

  async stop(rawHandle: ProviderHandle, options: ProviderStopOptions = {}): Promise<ProviderTerminalPayload> {
    const handle = this.required(rawHandle);
    if (handle.terminal) return handle.terminal;
    handle.setState("stopping");
    const identity = this.deps.getProcessIdentity(handle.pid);
    if (identity && sameProcessBirthIdentity(identity, handle.providerConnection.processIdentity!)) {
      this.deps.signalProcess(handle.pid, options.force ? "SIGKILL" : "SIGTERM");
      if (!options.force) {
        await delay(options.graceMs ?? this.stopGraceMs);
        const next = this.deps.getProcessIdentity(handle.pid);
        if (next && sameProcessBirthIdentity(next, handle.providerConnection.processIdentity!)) {
          this.deps.signalProcess(handle.pid, "SIGKILL");
        }
      }
    }
    const exit = await this.deps.observeProcessExit(handle.pid, handle.providerConnection.processIdentity!);
    const terminal = terminalFromExit(exit, handle.providerContinuationId, this.deps.now(), true);
    this.finish(handle, terminal, exit.type === "exit");
    return terminal;
  }

  onExit(rawHandle: ProviderHandle, listener: (payload: ProviderTerminalPayload) => void): () => void {
    const handle = this.required(rawHandle);
    if (handle.terminal) queueMicrotask(() => listener(handle.terminal!));
    else handle.exitListeners.add(listener);
    return () => handle.exitListeners.delete(listener);
  }

  onActivity(rawHandle: ProviderHandle, listener: (event: ProviderActivityEvent) => void): () => void {
    const handle = this.required(rawHandle);
    handle.activityListeners.add(listener);
    return () => handle.activityListeners.delete(listener);
  }

  onStream(rawHandle: ProviderHandle, listener: (event: ProviderStreamEvent) => void): () => void {
    const handle = this.required(rawHandle);
    handle.streamListeners.add(listener);
    return () => handle.streamListeners.delete(listener);
  }

  onExecution(rawHandle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.required(rawHandle).execution.subscribe(listener);
  }

  async probeControl(rawHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.required(rawHandle);
    let result = this.controlProof(handle);
    if (!result) {
      const response = await handle.client.probeControl();
      // A refused HTTP request alone is not proof that the native instance died.
      result = this.controlProof(handle) ?? { state: response.state };
    }
    if (result.state === "lost") handle.controlLoss = result.controlEvidence;
    this.emitExecution(handle, { domain: "control", kind: "state_changed", sideEffects: "none", ...result });
    return result;
  }

  /**
   * Read-only native linkage; pending-request and durable admission checks remain separate.
   * `roomTurnId` is the caller's durable turn; it is used only when the transcript proves it.
   */
  async correlatePermissionTurn(
    rawHandle: ProviderHandle,
    expectedRequest: OpenCodePermissionRequest,
    options: { roomTurnId?: string } = {},
  ): Promise<OpenCodePermissionTurnCorrelation> {
    try {
      const handle = this.required(rawHandle);
      const sessionId = handle.providerContinuationId;
      const connection = { ...handle.providerConnection };
      const assertCurrentInstance = (): void => {
        if (this.required(rawHandle) !== handle || handle.terminal || handle.observedState() === "stopping"
          || handle.providerContinuationId !== sessionId || handle.pid !== connection.pid
          || !sameProviderConnectionIdentity(connection, handle.providerConnection) || this.controlProof(handle)) {
          throw new Error("OpenCode permission correlation instance could not be verified.");
        }
      };
      const result = await handle.client.correlatePermissionTurn(sessionId, expectedRequest, assertCurrentInstance,
        options.roomTurnId);
      assertCurrentInstance();
      return result;
    } catch {
      return { outcome: "correlation_unproven" };
    }
  }

  /** Host-only native decision boundary; durable decision/retry policy belongs to the caller. */
  async replyPermission(
    rawHandle: ProviderHandle,
    expectedRequest: OpenCodePermissionRequest,
    reply: "once" | "reject",
    options?: { beforeNativeDispatch: () => Promise<void>; assertNativeDispatch?: () => void },
  ) {
    const currentHandle = (): OpenModelHandle => {
      const current = this.handles.get(rawHandle.workAttemptId);
      if (!current || current !== rawHandle || current.terminal
        || current.observedState() === "stopping" || this.controlProof(current)) {
        throw new OpenCodePermissionReplyError("not_dispatched");
      }
      return current;
    };
    const handle = currentHandle();
    let dispatched = false;
    try {
      return await handle.client.replyPermission(handle.providerContinuationId, expectedRequest, reply, () => {
        currentHandle();
        options?.assertNativeDispatch?.();
        dispatched = true;
      }, options?.beforeNativeDispatch);
    } finally {
      if (dispatched) {
        // A replacement may answer even with 404. Neither that response nor
        // loss of the original instance proves that the decision did not land.
        try { currentHandle(); } catch { throw new OpenCodePermissionReplyError("uncertain"); }
      }
    }
  }

  async observePermissions(
    rawHandle: ProviderHandle,
    listener: (event: OpenCodePermissionObservation) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const handle = this.required(rawHandle);
    const notify = (event: OpenCodePermissionObservation): void => {
      if (!signal.aborted) { try { listener(event); } catch { /* Observation never controls native work. */ } }
    };
    const available = (): boolean => {
      if (this.handles.get(handle.workAttemptId) !== handle) {
        notify({ type: "unavailable", reason: "handle_replaced" });
        return false;
      }
      const proof = this.controlProof(handle);
      if (!proof) return true;
      if (proof.state === "lost") {
        handle.controlLoss = proof.controlEvidence;
        notify({ type: "unavailable", reason: proof.controlEvidence });
      } else notify({ type: "degraded" });
      return false;
    };
    while (!signal.aborted && available()) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      let revision = 0;
      let pending = false;
      let listing = false;
      const refresh = (): void => {
        revision += 1;
        pending = true;
        if (listing) return;
        listing = true;
        void (async () => {
          try {
            while (pending && !controller.signal.aborted) {
              pending = false;
              const observedRevision = revision;
              const requests = await handle.client.listPendingPermissions(handle.providerContinuationId, controller.signal);
              if (controller.signal.aborted) return;
              if (!available()) { controller.abort(); return; }
              // SSE is consumed while the GET runs. Never publish a snapshot
              // overtaken by an ask/reply, nor resurrect a queued stale ask.
              if (observedRevision === revision) notify({ type: "snapshot", requests });
            }
          } catch {
            if (!controller.signal.aborted) { notify({ type: "degraded" }); controller.abort(); }
          } finally { listing = false; }
        })();
      };
      try {
        for await (const event of handle.client.events(controller.signal)) {
          if (controller.signal.aborted || !available()) break;
          if (event.type === "server.instance.disposed") {
            handle.controlLoss = "control_epoch_gone";
            this.emitExecution(handle, { domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "control_epoch_gone" });
            notify({ type: "unavailable", reason: "control_epoch_gone" });
            return;
          }
          if (event.type === "server.connected") refresh();
          const permission = parseOpenCodePermissionEvent(event);
          if (permission?.properties.sessionID === handle.providerContinuationId) refresh();
        }
      } catch {
        if (!signal.aborted) notify({ type: "degraded" });
      } finally {
        controller.abort();
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted || !available()) return;
      notify({ type: "degraded" });
      // Reconnect the observation channel only. No prompt replay or native abort.
      await new Promise<void>((resolve) => {
        const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 250);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
}

export const openModelProviderAdapter = new OpenModelProviderAdapter();
