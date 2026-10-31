/** Notification consumption, native execution facts, transcript tails and exact-turn terminal waits. */
import { resolve } from "node:path";
import { STARTS_AGAIN_BY_ITSELF } from "../codex-home-harness.js";
import type { RpcNotification, ThreadReadResult, ThreadReadTurn } from "../codex-rpc-client.js";
import { nativeExecutionId, nativeLifecycleCheckpoint, type NativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import type { NativeExecutionFact } from "../../../../shared/execution-protocol.js";
import { summarizeCodexRuntimeNotification, summarizeCodexRuntimeSnapshot } from "../codex-runtime-reasoning.js";
import { extractTurnStatus } from "../codex-session-status.js";
import type { ProviderRoomTurnResult, ProviderRoomTurnOptions } from "../provider-adapter.js";
import { delay, safeStreamPayload } from "../provider-evidence.js";
import { CODEX_SYSTEM_ERROR_SETTLE_MS, codexErrorActivitySummary, codexLifecycleStatus, exactPermissionItemKey, exactTurnKey, hasExplicitCodexSystemError, isCodexExecutionMethod, isCodexPolicyRefusal, notificationThreadId, notificationTurnId, recordValue, streamKind, terminalTurnOutcome, transcriptLifecycleTurn } from "./notifications.js";
import { CodexAdapterBase } from "./adapter-base.js";
import { CodexProviderHandle } from "./handle.js";
import { CodexRoomTurnObservationDetachedError } from "./room-tools.js";
import { type CodexThreadResult, codexFoundNotReadOnly } from "./thread-access.js";
import { permissionFileChanges } from "./permission-requests.js";

export abstract class CodexAdapterEvents extends CodexAdapterBase {
  protected consumeNotification(
    handle: CodexProviderHandle,
    notification: RpcNotification,
    correlateLifecycle = true,
  ): void {
    handle.usage.snapshot(handle.providerContinuationId);
    handle.usage.codex(notification.method, notification.params, this.deps.now());
    const exactTurnId = notificationTurnId(notification.params);
    const exactThreadId = notificationThreadId(notification.params);
    if (exactThreadId === handle.providerContinuationId && (
      notification.method === "thread/compacted"
      || (["item/started", "item/completed"].includes(notification.method)
        && recordValue(recordValue(notification.params)?.item)?.type === "contextCompaction")
    )) handle.roomContext.reset();
    const terminalMatch = /^turn\/(completed|interrupted|failed|cancelled|stopped)$/i.exec(notification.method);
    this.observePermissionFileChangeProposal(handle, notification);
    const nativeLifecycle = this.observeNativeExecution(handle, notification, correlateLifecycle);
    handle.roomTurnResults.observe(notification.method, notification.params);
    // Record the durable in-memory terminal edge first. Stream/activity
    // observers are best-effort and must never suppress exact turn settlement.
    if (exactTurnId && exactThreadId === handle.providerContinuationId && terminalMatch) {
      const nativeStatus = recordValue(recordValue(notification.params)?.turn)?.status;
      const terminalStatus = typeof nativeStatus === "string"
        && /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(nativeStatus)
        ? nativeStatus.toLowerCase()
        : terminalMatch[1]!.toLowerCase();
      this.noteExactTurnTerminal(handle, exactTurnKey(exactThreadId, exactTurnId), terminalStatus);
    }
    if (notification.method === "thread/settings/updated" && exactThreadId === handle.providerContinuationId) {
      this.holdSettingsToReadOnly(handle, notification.params);
    }
    const threadStatus = recordValue(recordValue(notification.params)?.status)?.type
      ?? recordValue(notification.params)?.status;
    if (notification.method === "thread/status/changed" && exactThreadId === handle.providerContinuationId) {
      const status = String(threadStatus ?? "").toLowerCase();
      if (status === "idle") {
        handle.threadIdleEpoch += 1;
        this.reconcileExactTurnTerminalsAfterIdle(handle);
      } else if (status === "systemerror") this.reconcileAfterSystemError(handle);
    }
    // Build the readable summary once and attach the same value to both the
    // ordered stream and the compact activity event. In particular, Codex's
    // approved summaryTextDelta stream is accumulated here; raw reasoning
    // textDelta content remains hidden by summarizeCodexRuntimeNotification.
    // An `error` line in the ordered stream names the provider's reason.
    const summary = summarizeCodexRuntimeNotification(notification);
    this.publishStream(handle, notification.method, notification.params, streamKind(notification.method),
      codexErrorActivitySummary(notification) ?? summary.summary,
      nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
    // Execution status belongs to the item, never to the reusable app-server.
    // Exact turn settlement above remains independent of this runtime state.
    const lifecycle = isCodexExecutionMethod(notification.method) ? null
      : terminalMatch ? "idle"
      : /(?:^|\/)(?:failed|systemError)$/i.test(notification.method)
      ? "failed"
      : codexLifecycleStatus(notification.params)
        ?? (/^(?:turn|thread)\/(?:completed|interrupted|stopped)$/i.test(notification.method) ? "idle" : null)
        ?? (/^(?:turn|thread)\/(?:started|resumed)$/i.test(notification.method) ? "working" : null);
    if (handle.lifecycleAuthorityMode === "typed") {
      if (nativeLifecycle?.phase === "turn_active") handle.setLiveState("working");
      else if (nativeLifecycle?.phase === "turn_terminal") handle.setLiveState("idle");
    } else if (lifecycle === "failed") handle.state = "failed";
    else if (lifecycle) handle.setLiveState(lifecycle);
    this.publishActivity(handle, {
      source: "native_harness",
      method: notification.method,
      ...summary,
    });
    if (/^(turn\/completed|item\/completed)$/.test(notification.method)) {
      void this.emitTranscriptTail(handle);
    }
  }

  protected observePermissionFileChangeProposal(
    handle: CodexProviderHandle,
    notification: RpcNotification,
  ): void {
    const params = recordValue(notification.params);
    const threadId = notificationThreadId(params);
    const turnId = notificationTurnId(params);
    if (!params || threadId !== handle.providerContinuationId || !turnId) return;
    if (/^turn\/(?:completed|interrupted|failed|cancelled|stopped)$/i.test(notification.method)) {
      for (const [key, proposal] of handle.permissionFileChangeProposals) {
        if (proposal.threadId === threadId && proposal.turnId === turnId) {
          handle.permissionFileChangeProposals.delete(key);
        }
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") return;
    const item = recordValue(params.item);
    if (!item || !nativeExecutionId(item.id)) return;
    const key = exactPermissionItemKey(threadId, turnId, item.id);
    if (notification.method === "item/completed") {
      handle.permissionFileChangeProposals.delete(key);
      return;
    }
    const connectionId = handle.client.currentConnectionId();
    const changes = item.type === "fileChange" && item.status === "inProgress"
      ? permissionFileChanges(item.changes)
      : null;
    if (connectionId && changes) {
      handle.permissionFileChangeProposals.set(key, { connectionId, threadId, turnId, changes });
    }
    else handle.permissionFileChangeProposals.delete(key);
  }

  protected observeNativeExecution(
    handle: CodexProviderHandle,
    notification: RpcNotification,
    correlateLifecycle = true,
  ): NativeLifecycleCheckpoint | null {
    if (handle.nativeRuntimeUnavailable) return null;
    const params = recordValue(notification.params);
    // `systemError` is the status of a thread whose last turn failed: a
    // provider refusal, a rejected key, a rate limit. The app-server stays up
    // and the same thread takes the next turn. Where the daemon starts every
    // turn that is a failed turn, reported by `turn/completed`, and never the
    // end of the runtime: latching here cost the agent a usable conversation
    // for each refusal. A lane that polls for itself has no one to start its
    // next turn, so it keeps the latch and is restarted.
    const threadSystemError = notification.method === "thread/status/changed"
      && params?.threadId === handle.providerContinuationId
      && hasExplicitCodexSystemError(params);
    const explicitRuntimeFailure = notification.method === "process/systemError"
      || (threadSystemError && handle.lifecycleAuthorityMode !== "typed");
    if (explicitRuntimeFailure) {
      this.emitNativeRuntimeUnavailable(handle, "native_session_terminated");
      return null;
    }
    if (!params || params.threadId !== handle.providerContinuationId || !nativeExecutionId(params.threadId)) return null;
    const terminalMethod = /^turn\/(?:completed|failed|interrupted|cancelled|stopped)$/i.test(notification.method);
    const turn = recordValue(params.turn);
    if (params.turnId !== undefined && turn?.id !== undefined && params.turnId !== turn.id) {
      if (terminalMethod) this.markNativeExecutionUnavailable(handle);
      return null;
    }
    const providerTurnId = params.turnId ?? turn?.id;
    if (!nativeExecutionId(providerTurnId)) {
      if (terminalMethod) this.markNativeExecutionUnavailable(handle);
      return null;
    }
    const identity = { providerContinuationId: params.threadId, providerTurnId };
    const emit = (fact: NativeExecutionFact) => this.emitNativeExecution(handle, fact);
    if (notification.method === "turn/started") {
      const nativeLifecycle = correlateLifecycle ? nativeLifecycleCheckpoint({
        provider: this.id,
        workAttemptId: handle.workAttemptId,
        phase: "turn_active",
        providerContinuationId: params.threadId,
        providerTurnId,
        nativeProcessPid: handle.providerConnection.pid ?? undefined,
        nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
      }) : null;
      emit({ domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" });
      emit({ ...identity, domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
        ...(nativeLifecycle ? { nativeEventId: nativeLifecycle.nativeEventId } : {}) });
      return nativeLifecycle;
    }
    if (terminalMethod) {
      const outcome = terminalTurnOutcome(notification.method, turn);
      if (outcome) {
        const nativeLifecycle = correlateLifecycle ? nativeLifecycleCheckpoint({
          provider: this.id,
          workAttemptId: handle.workAttemptId,
          phase: "turn_terminal",
          providerContinuationId: params.threadId,
          providerTurnId,
          nativeProcessPid: handle.providerConnection.pid ?? undefined,
          nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
          terminalDiscriminator: outcome,
        }) : null;
        emit({ ...identity, domain: "turn", kind: "state_changed", state: "terminal", turnOutcome: outcome,
          sideEffects: "none", ...(nativeLifecycle ? { nativeEventId: nativeLifecycle.nativeEventId } : {}) });
        return nativeLifecycle;
      }
      this.markNativeExecutionUnavailable(handle);
      return null;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      if (nativeExecutionId(params.itemId) && typeof params.delta === "string" && params.delta.length > 0) {
        this.noteCommandOutput(handle, identity, params.itemId, Buffer.byteLength(params.delta));
      }
      return null;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") return null;
    const item = recordValue(params.item);
    if (!item || !nativeExecutionId(item.id)) return null;
    const operation = item.type === "commandExecution" ? "command"
      : item.type === "fileChange" ? "file_change" : item.type === "mcpToolCall" ? "other" : null;
    if (!operation) return null;
    const base = { ...identity, domain: "execution" as const, executionId: item.id, operation } as const;
    if (notification.method === "item/started") {
      // item/started can precede requestApproval. Only an actual PTY process
      // proves command start here; other items remain terminal-only evidence.
      if (operation === "command" && item.status === "inProgress" && nativeExecutionId(item.processId)) {
        emit({ ...base, kind: "started", sideEffects: "possible" });
      }
      return null;
    }
    if (item.status === "declined" && (operation === "command" || operation === "file_change")) {
      emit({ ...base, kind: "completed", outcome: "denied_before_start", sideEffects: "none" });
    } else if (item.status === "completed" || item.status === "failed") {
      const exitCode = operation === "command" && Number.isInteger(item.exitCode)
        && Number(item.exitCode) >= -2147483648 && Number(item.exitCode) <= 2147483647 ? Number(item.exitCode) : undefined;
      emit({ ...base, kind: "completed", outcome: item.status === "failed" || (exitCode !== undefined && exitCode !== 0) ? "failed" : "succeeded",
        sideEffects: operation === "file_change" && item.status === "completed" ? "observed" : "possible",
        ...(exitCode !== undefined ? { exitCode } : {}) });
    }
    return null;
  }

  protected markNativeExecutionUnavailable(handle: CodexProviderHandle): void {
    this.recordCommandOutput(handle);
    handle.execution.markUnavailable();
    handle.execution.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
      handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
  }

  protected emitNativeRuntimeUnavailable(
    handle: CodexProviderHandle,
    controlEvidence: "process_exit" | "native_session_terminated",
  ): void {
    if (handle.nativeRuntimeUnavailable) return;
    this.recordCommandOutput(handle);
    handle.nativeRuntimeUnavailable = controlEvidence;
    handle.permissionFileChangeProposals.clear();
    handle.state = "failed";
    const emit = (fact: NativeExecutionFact) => handle.execution.emit(fact,
      handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
    for (const fact of handle.nativeActiveOperations.values()) {
      emit({ domain: "execution", kind: "completed", executionId: fact.executionId, operation: fact.operation,
        providerContinuationId: fact.providerContinuationId, providerTurnId: fact.providerTurnId,
        outcome: "lost_after_start", sideEffects: fact.sideEffects });
    }
    handle.nativeActiveOperations.clear();
    for (const turn of handle.nativeActiveTurns.values()) {
      emit({ ...turn, domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none" });
    }
    handle.nativeActiveTurns.clear();
    emit({ domain: "control", kind: "state_changed", state: "lost", controlEvidence, sideEffects: "none" });
    emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence, sideEffects: "none" });
  }

  protected async emitTranscriptTail(handle: CodexProviderHandle): Promise<void> {
    try {
      const read = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
      const latestTurn = read.thread?.turns?.at(-1);
      this.publishStream(handle, "thread/read", {
        threadId: handle.providerContinuationId,
        threadStatus: read.thread?.status,
        latestTurn: transcriptLifecycleTurn(latestTurn),
      }, "transcript_snapshot");
      const snapshot = summarizeCodexRuntimeSnapshot({
        threadStatus: typeof read.thread?.status === "string"
          ? read.thread.status
          : read.thread?.status?.type,
        turnStatus: typeof latestTurn?.status === "string"
          ? latestTurn.status
          : latestTurn?.status?.status,
        recentItems: latestTurn?.items ?? latestTurn?.output ?? [],
      });
      if (!snapshot) return;
      this.publishActivity(handle, {
        source: "transcript_tail",
        method: "thread/read",
        ...snapshot,
      });
    } catch {
      // Runtime evidence is best effort and must never end the worker turn.
    }
  }

  protected async waitForTurnBoundary(handle: CodexProviderHandle, turnId: string, detachSignal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (detachSignal?.aborted) throw new Error("Codex exact turn control observation detached.");
      const read = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
      const turn = read.thread?.turns?.find((candidate) => candidate.id === turnId);
      const status = typeof turn?.status === "string" ? turn.status : turn?.status?.status;
      if (!turn || /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(status ?? ""))) return;
      await delay(50);
    }
    throw new Error("Codex did not prove the active turn reached an interrupted boundary.");
  }

  protected async subscribeMaterializedThread(handle: CodexProviderHandle): Promise<boolean> {
    if (!handle.subscriptionAfterMaterialization) return false;
    const threadId = handle.providerContinuationId;
    const subscribed = await handle.client.request<CodexThreadResult>("thread/resume", { threadId });
    if (subscribed.thread?.id !== threadId) throw new Error("Codex subscription resolved a different materialized thread.");
    handle.subscriptionAfterMaterialization = false;
    // A runtime that was found with no loaded conversation had no reply to hold to its level then.
    // This reply is the first word on what the conversation got, so it is held to Read-only as every other is.
    const notReadOnly = codexFoundNotReadOnly(handle.appliedTurnPolicy(), subscribed, handle.readOnlyProfile());
    if (notReadOnly) {
      handle.foundNotReadOnly ??= { reported: notReadOnly, stopped: null };
      // Its turn must not go on with what the level does not allow. The stop is not waited for here; the daemon sees the process end.
      this.stopNotReadOnly(handle)?.catch(() => undefined);
      throw new Error(`${notReadOnly}, so LetAgents stopped the agent. ${STARTS_AGAIN_BY_ITSELF}`);
    }
    return true;
  }

  /** Terminal correlation is event-driven and deliberately thread+turn exact. */
  protected async waitForExactRoomTurnTerminal(
    handle: CodexProviderHandle,
    turnId: string,
    detachSignal?: AbortSignal,
  ): Promise<{ status: string; turn: ThreadReadTurn }> {
    if (await this.subscribeMaterializedThread(handle)) {
      const snapshot = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId, includeTurns: true,
      });
      if (snapshot.thread?.id !== handle.providerContinuationId) throw new Error("Codex materialized snapshot resolved a different thread.");
      const turn = snapshot.thread.turns?.find(turn => turn.id === turnId);
      const status = typeof turn?.status === "string" ? turn.status : turn?.status?.status;
      if (turn && status && /^(?:completed|failed|interrupted|cancelled|stopped)$/i.test(status)) return { status, turn };
    }
    const status = await this.waitForExactTurnNotification(handle, exactTurnKey(handle.providerContinuationId, turnId), detachSignal);
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    if (read.thread?.id !== handle.providerContinuationId) {
      throw new Error("Codex bounded room turn read resolved a different continuation thread.");
    }
    const turn = read.thread?.turns?.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error("Codex bounded room turn is missing from its exact continuation thread.");
    const readStatus = String(typeof turn.status === "string" ? turn.status : turn.status?.status ?? "").toLowerCase();
    if (readStatus !== status || !/^(?:completed|interrupted|failed|cancelled|stopped)$/.test(readStatus)) {
      throw new Error(`Codex bounded room turn ${turnId} terminal event did not match its exact thread state.`);
    }
    return { status: readStatus, turn };
  }

  protected async roomTurnResultFromTerminal(
    handle: CodexProviderHandle,
    turnId: string,
    status: string,
    turn: ThreadReadTurn,
    checkpointTerminalResult?: ProviderRoomTurnOptions["checkpointTerminalResult"],
  ): Promise<ProviderRoomTurnResult> {
    // A terminal native turn leaves the reusable app-server at an idle turn
    // boundary even when that turn failed or was interrupted.
    handle.setLiveState("idle");
    const terminalResult: ProviderRoomTurnResult = status === "completed"
      ? { turnId, ...handle.roomTurnResults.normalize(handle.providerContinuationId, turnId, turn) }
      : { turnId, providerContinuationId: handle.providerContinuationId,
        outcome: status === "failed" ? "failed" : "interrupted", text: null, evidence: "transcript",
        error: String(safeStreamPayload(turn.error?.message || `Codex bounded room turn ended ${status}.`).payload).slice(0, 2000),
        ...(status === "failed" && isCodexPolicyRefusal(turn.error?.codexErrorInfo) ? { refusal: true as const } : {}) };
    await checkpointTerminalResult?.(terminalResult);
    handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
    return terminalResult;
  }

  protected waitForExactTurnNotification(handle: CodexProviderHandle, key: string, detachSignal?: AbortSignal): Promise<string> {
    const cached = handle.terminalTurns.get(key);
    if (cached) { handle.terminalTurns.delete(key); return Promise.resolve(cached); }
    if (handle.turnWaiters.has(key)) throw new Error("Codex bounded room turn already has a terminal waiter.");
    if (detachSignal?.aborted) return Promise.reject(new CodexRoomTurnObservationDetachedError("Codex room-turn observation detached."));
    return new Promise<string>((resolve, reject) => {
      const onDetach = () => {
        const current = handle.turnWaiters.get(key);
        if (current?.owner === owner) handle.turnWaiters.delete(key);
        reject(new CodexRoomTurnObservationDetachedError("Codex room-turn observation detached."));
      };
      const owner = Symbol(key);
      const waiter = {
        owner,
        resolve: (status: string) => {
          detachSignal?.removeEventListener("abort", onDetach);
          resolve(status);
        },
        reject: (error: Error) => {
          detachSignal?.removeEventListener("abort", onDetach);
          reject(error);
        },
      };
      handle.turnWaiters.set(key, waiter);
      detachSignal?.addEventListener("abort", onDetach, { once: true });
      this.reconcileExactTurnTerminalsAfterIdle(handle);
    });
  }

  /**
   * A failed turn puts its thread in `systemError` just before its
   * `turn/completed`. If that ending is lost, nothing else settles the turn:
   * the thread does not go idle until its next turn, and the daemon starts no
   * turn behind an open one. So read the thread once, a short stated time
   * after the status, and take a waiting turn's ending from there.
   */
  protected reconcileAfterSystemError(handle: CodexProviderHandle): void {
    if (handle.systemErrorReconciliation) return;
    const settle = () => {
      handle.systemErrorReconciliation = null;
      // Nothing waits: the ending arrived. Asking anyway would be remembered
      // and make the next turn's waiter read the thread the moment it starts.
      if (!handle.turnWaiters.size) return;
      handle.threadIdleEpoch += 1;
      this.reconcileExactTurnTerminalsAfterIdle(handle);
    };
    handle.systemErrorReconciliation = this.deps.sleep(CODEX_SYSTEM_ERROR_SETTLE_MS).then(settle, settle);
  }

  protected reconcileExactTurnTerminalsAfterIdle(handle: CodexProviderHandle): void {
    if (!handle.turnWaiters.size
      || handle.threadIdleReconciliation
      || handle.threadIdleEpoch <= handle.threadIdleReconciledEpoch) return;
    const observedEpoch = handle.threadIdleEpoch;
    handle.threadIdleReconciliation = (async () => {
      try {
        const read = await handle.client.request<ThreadReadResult>("thread/read", {
          threadId: handle.providerContinuationId,
          includeTurns: true,
        });
        if (handle.terminal
          || this.handles.get(handle.workAttemptId) !== handle
          || read.thread?.id !== handle.providerContinuationId) return;
        for (const turn of read.thread.turns ?? []) {
          if (!turn.id) continue;
          const key = exactTurnKey(handle.providerContinuationId, turn.id);
          if (!handle.turnWaiters.has(key)) continue;
          const status = String(extractTurnStatus(turn) ?? "").toLowerCase();
          if (/^(?:completed|interrupted|failed|cancelled|stopped)$/.test(status)) {
            // The ending never arrived. Take it from the thread's own record
            // exactly as its notification would have brought it: that wakes
            // the waiter and also records the turn's ending, without which the
            // agent would keep saying it is working. If the notification still
            // comes, it repeats the same native event and changes nothing.
            this.consumeNotification(handle, {
              method: "turn/completed",
              params: { threadId: handle.providerContinuationId, turnId: turn.id, turn: { ...turn, status } },
            });
          }
        }
      } catch {
        // Thread-idle is only an invalidation signal. A failed read proves
        // nothing about the exact turn, so keep waiting for native evidence.
      } finally {
        handle.threadIdleReconciledEpoch = Math.max(handle.threadIdleReconciledEpoch, observedEpoch);
        handle.threadIdleReconciliation = null;
        if (handle.threadIdleEpoch > observedEpoch) this.reconcileExactTurnTerminalsAfterIdle(handle);
      }
    })();
  }

  protected noteExactTurnTerminal(handle: CodexProviderHandle, key: string, status: string): void {
    const waiter = handle.turnWaiters.get(key);
    if (waiter) {
      handle.turnWaiters.delete(key);
      waiter.resolve(status);
      return;
    }
    handle.terminalTurns.set(key, status);
    while (handle.terminalTurns.size > 64) handle.terminalTurns.delete(handle.terminalTurns.keys().next().value!);
  }
}
