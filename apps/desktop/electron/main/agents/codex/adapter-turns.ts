/** Turn control and inspection, custodial polling activation and room turns. */
import type { ThreadReadResult, ThreadReadTurn, TurnStartResult } from "../codex-rpc-client.js";
import { nativeExecutionId } from "../provider-execution-observer.js";
import type { NativeTurnBoundary } from "../../../../shared/execution-protocol.js";
import { extractThreadStatus, extractTurnStatus, isActiveCodexTurnStatus } from "../codex-session-status.js";
import { buildCustodialPollingPrompt } from "../codex-start-prompt.js";
import { sameProviderConnectionIdentity, type ProviderHandle, type CustodialPollingActivationRequest, type CustodialPollingActivationOptions, type ProviderTurnControlResult, type ProviderTurnControlOptions, ProviderTurnControlError, type ProviderRoomTurnRequest, type RoomTurnImageDelivery, type ProviderRoomTurnRecoveryRequest, type ProviderRoomTurnResult, type ProviderRoomTurnOptions, ProviderContinuationMissingError, PROCESS_ENDED_DURING_TURN } from "../provider-adapter.js";
import { sameProcessBirthIdentity } from "../provider-evidence.js";
import { CodexAdapterPermissions } from "./adapter-permissions.js";
import { CodexRoomTurnRecoveryError, boundedRoomTurnPrompt, requireLetAgentsRoomTools, roomTurnImageInput } from "./room-tools.js";
import { exactTurnKey, isCodexThreadBetweenTurns, recordValue } from "./notifications.js";
import { isCodexRuntimeUnavailable } from "./handle.js";
import { isMissingContinuation } from "./thread-access.js";

export abstract class CodexAdapterTurns extends CodexAdapterPermissions {
  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Codex continuation is terminal; no turn can be controlled.");
    const assertRuntimeAvailable = () => {
      if (isCodexRuntimeUnavailable(handle.state)) {
        throw new ProviderTurnControlError("Codex turn control lost live runtime authority.", "uncertain");
      }
    };
    assertRuntimeAvailable();
    const text = correction?.trim() || null;
    const turnPolicy = text ? handle.requireTurnPolicy() : null;
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    assertRuntimeAvailable();
    if (read.thread?.id !== handle.providerContinuationId) {
      throw new Error("Codex turn control resolved a different continuation thread.");
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    const selectedTurn = expectedTurnId
      ? read.thread?.turns?.find((candidate) => candidate.id === expectedTurnId)
      : read.thread?.turns?.at(-1);
    if (expectedTurnId && !selectedTurn) {
      throw new ProviderTurnControlError(
        "Codex no longer exposes the exact checkpointed turn; refusing to target a newer latest turn.",
        "uncertain",
      );
    }
    const turnId = selectedTurn?.id;
    const rawStatus = typeof selectedTurn?.status === "string"
      ? selectedTurn.status
      : selectedTurn?.status?.status;
    const terminal = /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(rawStatus ?? ""));
    const active = Boolean(turnId && isActiveCodexTurnStatus(rawStatus));
    const newerActiveTurnExists = Boolean(expectedTurnId && read.thread?.turns?.some((candidate) => {
      if (candidate.id === expectedTurnId) return false;
      const candidateStatus = typeof candidate.status === "string" ? candidate.status : candidate.status?.status;
      return isActiveCodexTurnStatus(candidateStatus);
    }));
    if (turnId && !active && !terminal) {
      throw new Error("Codex returned an unknown latest-turn state; refusing ambiguous turn control.");
    }
    if (turnId) {
      await options.checkpointTurnStarted?.(turnId);
      assertRuntimeAvailable();
    }
    if (newerActiveTurnExists) {
      if (text) {
        throw new ProviderTurnControlError(
          "Codex's checkpointed turn ended and a newer turn is active; the correction was not applied to that successor.",
          "not_applied",
        );
      }
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "working" };
    }
    if (active) {
      await options.markDispatched?.();
      assertRuntimeAvailable();
      const dispatchRead = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
      assertRuntimeAvailable();
      const dispatchTurn = dispatchRead.thread?.turns?.find((candidate) => candidate.id === turnId);
      const dispatchStatus = typeof dispatchTurn?.status === "string"
        ? dispatchTurn.status
        : dispatchTurn?.status?.status;
      if (!dispatchTurn || !isActiveCodexTurnStatus(dispatchStatus)) {
        throw new ProviderTurnControlError(
          "Codex reached a terminal turn boundary before native interrupt dispatch.",
          "not_applied",
        );
      }
      await handle.client.request("turn/interrupt", {
        threadId: handle.providerContinuationId,
        turnId,
      });
      assertRuntimeAvailable();
      await this.waitForTurnBoundary(handle, turnId!);
      assertRuntimeAvailable();
      handle.setLiveState("idle");
    }
    if (text) {
      if (!active) {
        await options.markDispatched?.();
        assertRuntimeAvailable();
      }
      const turn = await handle.client.request<TurnStartResult>("turn/start", {
        ...turnPolicy,
        threadId: handle.providerContinuationId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      assertRuntimeAvailable();
      if (!turn.turn?.id) throw new Error("Codex did not acknowledge the redirected turn.");
      await this.subscribeMaterializedThread(handle);
      handle.setLiveState("working");
    }
    assertRuntimeAvailable();
    return {
      capability: "native_interrupt",
      interrupted: active,
      resumed: Boolean(text),
      state: text ? "working" : "idle",
    };
  }

  async inspectTurn(providerHandle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.requireHandle(providerHandle);
    const exactTurnId = turnId.trim();
    if (!exactTurnId) return "unknown";
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    if (read.thread?.id !== handle.providerContinuationId) return "unknown";
    const turn = read.thread?.turns?.find((candidate) => candidate.id === exactTurnId);
    const status = typeof turn?.status === "string" ? turn.status : turn?.status?.status;
    if (!turn || !status) return "unknown";
    if (isActiveCodexTurnStatus(status)) return "active";
    return /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(status)) ? "terminal" : "unknown";
  }

  /** Discovery only: MCP waiting is still an active turn, never an idle boundary. */
  async inspectTurnBoundary(providerHandle: ProviderHandle): Promise<NativeTurnBoundary> {
    const handle = this.requireHandle(providerHandle);
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const identity = connection.processIdentity;
    const current = () => {
      if (handle.terminal || this.handles.get(handle.workAttemptId) !== handle
        || handle.providerContinuationId !== continuation
        || !sameProviderConnectionIdentity(connection, handle.providerConnection)
        || handle.pid === null || handle.pid !== connection.pid || !identity) return false;
      const actual = this.deps.getProcessIdentity(handle.pid);
      return typeof actual === "string" && sameProcessBirthIdentity(actual, identity);
    };
    try {
      if (!nativeExecutionId(continuation) || !identity || !current()) return { state: "unknown" };
      // This may read a large history: it is explicit reconciliation, not a heartbeat.
      const read = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: continuation, includeTurns: true,
      });
      if (!current() || read?.thread?.id !== continuation || !Array.isArray(read.thread.turns)) return { state: "unknown" };
      let active: string | null = null;
      let latest: string | null = null;
      const seen = new Set<string>();
      for (const turn of read.thread.turns) {
        const id = turn?.id;
        const status = extractTurnStatus(turn);
        if (!nativeExecutionId(id) || seen.has(id)) return { state: "unknown" };
        seen.add(id);
        latest = id;
        if (isActiveCodexTurnStatus(status)) {
          if (active) return { state: "unknown" };
          active = id;
        } else if (!/^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(status ?? "")) {
          return { state: "unknown" };
        }
      }
      if (active) return { state: "active", providerContinuationId: continuation, nativeProcessIdentity: identity, providerTurnId: active };
      // A cached handle state or an active thread with no visible turn cannot
      // certify idle. Even a valid empty list requires the thread itself to
      // be between turns.
      const status = extractThreadStatus(read.thread);
      if (status === "notLoaded") {
        // A handoff may find the saved thread unloaded. Do not cold-resume it
        // with process defaults just to stop the old runtime. Prove the exact
        // app-server has no loaded threads, in addition to terminal history.
        const loaded = recordValue(await handle.client.request<unknown>(
          "thread/loaded/list", { limit: 1 }, { timeoutMs: 2_000 },
        ));
        if (!current() || !Array.isArray(loaded?.data) || loaded.data.length !== 0
          || loaded.nextCursor !== null) return { state: "unknown" };
      } else if (!isCodexThreadBetweenTurns(status)) return { state: "unknown" };
      return { state: "idle", providerContinuationId: continuation, nativeProcessIdentity: identity, latestProviderTurnId: latest };
    } catch {
      // Timeouts and unavailable snapshots are uncertainty, not runtime failure.
      return { state: "unknown" };
    }
  }

  async inspectCustodialPollingActivation(providerHandle: ProviderHandle, providerTurnId: string):
    Promise<{ state: "active" | "unknown" } | { state: "terminal"; outcome: "completed" | "failed" | "interrupted" }> {
    const handle = this.requireHandle(providerHandle);
    const continuation = handle.providerContinuationId;
    const connection = structuredClone(handle.providerConnection);
    const current = () => {
      const actual = handle.pid === null ? undefined : this.deps.getProcessIdentity(handle.pid);
      return !handle.terminal && this.handles.get(handle.workAttemptId) === handle
        && handle.providerContinuationId === continuation && sameProviderConnectionIdentity(connection, handle.providerConnection)
        && handle.pid === connection.pid && typeof actual === "string" && Boolean(connection.processIdentity)
        && sameProcessBirthIdentity(actual, connection.processIdentity!);
    };
    try {
      if (!nativeExecutionId(providerTurnId) || !current()) return { state: "unknown" };
      const read = await handle.client.request<ThreadReadResult>("thread/read", { threadId: continuation, includeTurns: true });
      if (!current() || read?.thread?.id !== continuation || !Array.isArray(read.thread.turns)) return { state: "unknown" };
      const matches = read.thread.turns.filter(turn => turn?.id === providerTurnId);
      if (matches.length !== 1) return { state: "unknown" };
      const status = extractTurnStatus(matches[0])?.toLowerCase();
      if (isActiveCodexTurnStatus(status)) return { state: "active" };
      if (status === "completed" || status === "failed") return { state: "terminal", outcome: status };
      if (status === "interrupted" || status === "cancelled" || status === "stopped") return { state: "terminal", outcome: "interrupted" };
      return { state: "unknown" };
    } catch { return { state: "unknown" }; }
  }

  async activateCustodialPolling(providerHandle: ProviderHandle, request: CustodialPollingActivationRequest,
    options: CustodialPollingActivationOptions): Promise<{ providerTurnId: string }> {
    const handle = this.requireHandle(providerHandle);
    const turnPolicy = handle.requireTurnPolicy();
    const input = structuredClone(request);
    const receipt = input.launchReceipt;
    const launch = this.pollingLaunches.get(handle);
    const continuation = handle.providerContinuationId;
    const connection = structuredClone(handle.providerConnection);
    const bounded = (value: unknown, limit = 512): value is string => typeof value === "string"
      && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
    if (![input.operationId, input.roomId, input.agentDisplayName, input.workerSession?.agentSessionId].every(value => bounded(value))
      || !bounded(input.cwd, 4096) || !/^(?:msg_)?\d+$/.test(input.workerSession?.roomCursor ?? "")
      || input.workerSession.roomCursor.length > 512 || !receipt || receipt.contract !== "custodial_polling_v1"
      || !Number.isSafeInteger(receipt.configurationRevision) || receipt.configurationRevision < 1
      || receipt.workAttemptId !== handle.workAttemptId || receipt.providerContinuationId !== continuation
      || receipt.agentSessionId !== input.workerSession.agentSessionId
      || !sameProviderConnectionIdentity(receipt.providerConnection, connection)
      || (launch && (launch.roomId !== input.roomId || launch.cwd !== input.cwd || launch.agentSessionId !== input.workerSession.agentSessionId
        || launch.configurationRevision !== receipt.configurationRevision))
      || typeof options.beforeNativeDispatch !== "function" || typeof options.checkpointTurnStarted !== "function") {
      throw new Error("Custodial polling activation requires exact applied launch authority.");
    }
    // A recovered handle cannot rediscover launch env from thread/read. The
    // privileged daemon supplies the durable receipt, revalidated in its
    // beforeNativeDispatch transaction. A known noncustodial launch is rejected.
    if (this.nonPollingLaunches.has(handle)) throw new Error("This runtime was not launched for custodial polling.");
    const assertCurrent = () => {
      const actual = handle.pid === null ? undefined : this.deps.getProcessIdentity(handle.pid);
      if (options.detachSignal?.aborted || handle.terminal || this.handles.get(handle.workAttemptId) !== handle
        || handle.providerContinuationId !== continuation || !sameProviderConnectionIdentity(handle.providerConnection, connection)
        || handle.pid !== connection.pid || !connection.processIdentity || typeof actual !== "string"
        || !sameProcessBirthIdentity(actual, connection.processIdentity)) throw new Error("Custodial polling activation lost its exact native runtime.");
    };
    assertCurrent();
    if (this.pollingDispatches.has(handle)) throw new Error("Custodial polling activation is already in progress.");
    this.pollingDispatches.add(handle);
    try {
      const boundary = await this.inspectTurnBoundary(handle);
      assertCurrent();
      if (boundary.state !== "idle") throw new Error("Custodial polling activation requires native idle evidence.");
      await options.beforeNativeDispatch();
      assertCurrent();
      const result = await handle.client.request<TurnStartResult>("turn/start", {
        ...turnPolicy,
        threadId: continuation, cwd: input.cwd,
        input: [{ type: "text", text: buildCustodialPollingPrompt(input) }],
      });
      const id = result?.turn?.id;
      if (!nativeExecutionId(id)) throw new Error("Custodial polling activation returned no exact native turn ID.");
      await options.checkpointTurnStarted(id);
      await this.subscribeMaterializedThread(handle);
      return { providerTurnId: id };
    } finally { this.pollingDispatches.delete(handle); }
  }

  /**
   * Stops the one legacy polling turn selected by durable identity.  First
   * invocation discovers the latest active turn once; every replay with a
   * target id is exact and must never redirect to a newer turn.
   */
  async controlExactTurn(
    providerHandle: ProviderHandle,
    options: { targetTurnId?: string | null; checkpointTargetTurn: (turnId: string) => Promise<void>; markDispatched: () => Promise<void>; detachSignal?: AbortSignal },
  ): Promise<{ outcome: "no_active" | "terminal" | "interrupt_dispatched"; targetTurnId: string | null }> {
    const handle = this.requireHandle(providerHandle);
    const assertAttached = () => {
      if (options.detachSignal?.aborted) throw new Error("Codex exact turn control observation detached.");
    };
    assertAttached();
    const expected = options.targetTurnId?.trim() || null;
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    if (read.thread?.id !== handle.providerContinuationId) {
      throw new ProviderTurnControlError("Codex exact turn control resolved a different continuation thread.", "uncertain");
    }
    assertAttached();
    const turn = expected
      ? read.thread?.turns?.find((candidate) => candidate.id === expected)
      : read.thread?.turns?.at(-1);
    if (!turn) {
      if (!expected) return { outcome: "no_active", targetTurnId: null };
      throw new ProviderTurnControlError("Codex exact turn control cannot find the persisted target turn.", "uncertain");
    }
    const turnId = turn.id?.trim();
    const status = typeof turn.status === "string" ? turn.status : turn.status?.status;
    if (!turnId || !status) throw new ProviderTurnControlError("Codex exact turn control found an unknown target state.", "uncertain");
    // Discovery itself is durable fencing. Even a completed latest turn must
    // be recorded before returning, otherwise a crash can later rediscover a
    // newer unrelated latest turn while the cutover still says "prepared".
    await options.checkpointTargetTurn(turnId);
    assertAttached();
    if (/^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(status))) {
      return { outcome: "terminal", targetTurnId: turnId };
    }
    if (!isActiveCodexTurnStatus(status)) throw new ProviderTurnControlError("Codex exact turn control found an unknown target state.", "uncertain");
    // This is deliberately the final callback boundary before native I/O.
    await options.markDispatched();
    assertAttached();
    const dispatchRead = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    const dispatchTurn = dispatchRead.thread?.turns?.find((candidate) => candidate.id === turnId);
    const dispatchStatus = typeof dispatchTurn?.status === "string" ? dispatchTurn.status : dispatchTurn?.status?.status;
    if (!dispatchTurn || /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(dispatchStatus ?? ""))) {
      return { outcome: "terminal", targetTurnId: turnId };
    }
    if (!isActiveCodexTurnStatus(dispatchStatus)) {
      throw new ProviderTurnControlError("Codex exact turn control found an unknown target state after dispatch.", "uncertain");
    }
    assertAttached();
    await handle.client.request("turn/interrupt", { threadId: handle.providerContinuationId, turnId });
    await this.waitForTurnBoundary(handle, turnId, options.detachSignal);
    handle.setLiveState("idle");
    return { outcome: "interrupt_dispatched", targetTurnId: turnId };
  }

  /**
   * Codex's own process reads a local image and resizes it before it enters
   * the thread history; a data URL would stay there at full size.
   */
  roomTurnImageDelivery(): RoomTurnImageDelivery {
    return "file";
  }

  /** Execute one durable inbox item on this exact app-server/thread only. */
  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (!request.inboxItemId.trim() || !request.actionId.trim()) throw new Error("Bounded Codex room turn requires durable inbox and action ids.");
    const turnPolicy = handle.requireTurnPolicy();
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const rpcConnection = handle.client.currentConnectionId();
    const assertRuntimeAvailable = () => {
      if (options.detachSignal?.aborted || handle.terminal || isCodexRuntimeUnavailable(handle.state)
        || this.handles.get(handle.workAttemptId) !== handle || handle.providerContinuationId !== continuation
        || !sameProviderConnectionIdentity(handle.providerConnection, connection)
        || handle.client.currentConnectionId() !== rpcConnection) {
        throw new Error("Codex runtime is unavailable; no bounded room turn can start.");
      }
    };
    assertRuntimeAvailable();
    await requireLetAgentsRoomTools(handle.client, continuation);
    assertRuntimeAvailable();
    await options.beforeNativeDispatch?.();
    assertRuntimeAvailable();
    handle.roomTurnResults.beginTurnStart(handle.providerContinuationId);
    const context = handle.roomContext.prepare(request, continuation);
    let started: TurnStartResult;
    try {
      started = await handle.client.request<TurnStartResult>("turn/start", {
        ...turnPolicy,
        threadId: handle.providerContinuationId,
        input: [{ type: "text", text: boundedRoomTurnPrompt(request, context.lines), text_elements: [] }, ...roomTurnImageInput(request)],
      });
    } catch (error) {
      handle.roomTurnResults.abandonTurnStart(handle.providerContinuationId);
      handle.roomContext.reset();
      if (isMissingContinuation(error, handle.providerContinuationId)) {
        throw new ProviderContinuationMissingError(handle.providerContinuationId);
      }
      throw error;
    }
    const turnId = started.turn?.id?.trim();
    if (!turnId) {
      handle.roomTurnResults.abandonTurnStart(handle.providerContinuationId);
      handle.roomContext.reset();
      throw new Error("Codex did not acknowledge the bounded room turn.");
    }
    handle.roomTurnResults.bindTurnStart(handle.providerContinuationId, turnId);
    // The durable id must exist before any terminal observation can race it.
    try {
      await options.checkpointTurnStarted?.(turnId);
    } catch (error) {
      // If terminal evidence raced the checkpoint but persistence failed, do
      // not retain that completed turn for a later unrelated invocation.
      handle.terminalTurns.delete(exactTurnKey(handle.providerContinuationId, turnId));
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      handle.roomContext.reset();
      throw error;
    }
    handle.setLiveState("working");
    try {
      const terminal = await this.waitForExactRoomTurnTerminal(handle, turnId, options.detachSignal);
      const result = await this.roomTurnResultFromTerminal(handle, turnId, terminal.status, terminal.turn, options.checkpointTerminalResult);
      if ((result.outcome === "reply" || result.outcome === "no_reply")
        && handle.providerContinuationId === continuation && handle.client.currentConnectionId() === rpcConnection
        && sameProviderConnectionIdentity(handle.providerConnection, connection) && !options.detachSignal?.aborted) context.commit();
      else handle.roomContext.reset();
      return result;
    } catch (error) {
      handle.roomContext.reset();
      throw error;
    }
  }

  /** Reattach only the durable exact turn; never issue a second turn/start. */
  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    handle.roomContext.reset();
    const turnId = request.providerTurnId.trim();
    if (!turnId) throw new CodexRoomTurnRecoveryError("Codex room-turn recovery requires an exact persisted turn id.");
    handle.roomTurnResults.track(handle.providerContinuationId, turnId);
    const read = await handle.client.request<ThreadReadResult>("thread/read", { threadId: handle.providerContinuationId, includeTurns: true });
    if (read.thread?.id !== handle.providerContinuationId) throw new CodexRoomTurnRecoveryError("Codex room-turn recovery resolved a different continuation thread.");
    const turn = read.thread?.turns?.find((candidate) => candidate.id === turnId);
    // The process that ran this turn has ended, and this one runs no turn it
    // was not asked for. A turn the thread does not hold, or still shows as
    // running, was cut off by that exit: nothing will ever end it, so it is
    // reported as interrupted instead of being looked for or waited for.
    const cutOffByExit = (shown?: ThreadReadTurn): Promise<ProviderRoomTurnResult> => {
      const ended = { ...(shown ?? { id: turnId, items: [] }), status: "interrupted", error: { message: PROCESS_ENDED_DURING_TURN } } as ThreadReadTurn;
      if (request.recordEnding) {
        this.consumeNotification(handle, { method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId, turn: ended } });
      }
      handle.terminalTurns.delete(exactTurnKey(handle.providerContinuationId, turnId));
      return this.roomTurnResultFromTerminal(handle, turnId, "interrupted", ended, options.checkpointTerminalResult);
    };
    if (!turn) {
      if (request.originProcessEnded) return cutOffByExit();
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw new CodexRoomTurnRecoveryError("Codex room-turn recovery cannot find the persisted exact turn.");
    }
    const status = String(typeof turn.status === "string" ? turn.status : turn.status?.status ?? "").toLowerCase();
    if (/^(?:completed|interrupted|failed|cancelled|stopped)$/.test(status)) {
      // The runtime that ran this turn may have exited before it reported how
      // the turn ended, and this one is sent no notification for a turn that
      // ended before it started. The thread's own record is then the only
      // place the ending exists, so it is taken from there exactly as its
      // notification would have brought it. Left open, the turn refuses every
      // later turn of this agent in the execution record. Only the daemon
      // knows whether its record holds the turn open, so it says so.
      if (request.recordEnding) {
        this.consumeNotification(handle, {
          method: "turn/completed",
          params: { threadId: handle.providerContinuationId, turnId, turn: { ...turn, status } },
        });
      }
      handle.terminalTurns.delete(exactTurnKey(handle.providerContinuationId, turnId));
      return this.roomTurnResultFromTerminal(handle, turnId, status, turn, options.checkpointTerminalResult);
    }
    if (!isActiveCodexTurnStatus(status)) {
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw new CodexRoomTurnRecoveryError("Codex room-turn recovery found an unknown exact turn state.");
    }
    if (request.originProcessEnded) return cutOffByExit(turn);
    handle.setLiveState("working");
    const terminal = await this.waitForExactRoomTurnTerminal(handle, turnId, options.detachSignal);
    return this.roomTurnResultFromTerminal(handle, turnId, terminal.status, terminal.turn, options.checkpointTerminalResult);
  }
}
