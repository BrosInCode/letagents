import { CODEX_THREAD_HISTORY_MODE } from "../../../../../shared/codex-thread-history.mjs";
import { readCodexUsageTail } from "./provider-usage.js";
import type { ProviderUsage } from "../../../shared/provider-usage.js";
import type { ThreadReadResult, ThreadReadTurn, TurnStartResult } from "./codex-rpc-client.js";
import { nativeExecutionId } from "./provider-execution-observer.js";
import type { ControlProbeResult, NativeExecutionObservation, NativeExecutionSubscription, NativeTurnBoundary } from "../../../shared/execution-protocol.js";
import { extractThreadStatus, extractTurnStatus, isActiveCodexTurnStatus } from "./codex-session-status.js";
import { buildCustodialPollingPrompt } from "./codex-start-prompt.js";
import { synthesizeTerminalPayload, sameProviderConnectionIdentity, type ProviderActivityEvent, type ProviderAdapter, type ProviderAttachTerminal, type ProviderContinuationRef, type ProviderHandle, type CustodialPollingActivationRequest, type CustodialPollingActivationOptions, type ProviderSpawnRequest, type ProviderStopOptions, type ProviderTurnControlResult, type ProviderTurnControlOptions, ProviderTurnControlError, type ProviderRoomTurnRequest, type RoomTurnImageDelivery, type ProviderRoomTurnRecoveryRequest, type ProviderRoomTurnResult, type ProviderRoomTurnOptions, type ProviderContinuationRepairRequest, type ProviderContinuationRepairResult, ProviderContinuationMissingError, PROCESS_ENDED_DURING_TURN, type ProviderStreamEvent, type ProviderTerminalPayload } from "./provider-adapter.js";
import { DEFAULT_STOP_GRACE_MS, delay, sameProcessBirthIdentity } from "./provider-evidence.js";
import { CODEX_ACCESS_LEVEL_OPTIONS, PS_BIRTH_EVIDENCE, boundedCodexTools, boundedLaunchContract, codexTurnPolicy, normalizeLaunchPolicy } from "./codex/launch-contract.js";
import { CodexAdapterPermissions } from "./codex/adapter-permissions.js";
import { CodexProviderHandle, isCodexRuntimeUnavailable } from "./codex/handle.js";
import { CodexRoomTurnObservationDetachedError, CodexRoomTurnRecoveryError, boundedRoomTurnPrompt, isMethodNotFound, requireLetAgentsRoomTools, roomTurnImageInput } from "./codex/room-tools.js";
import { type CodexThreadResult, assertCodexReadOnlyApplied, assertCodexReviewerApplied, assertCodexThreadDirectory, codexEffortMismatchNotice, codexEffortNoticeSaidOnce, codexThreadAccess, codexThreadConfig, codexThreadEffort, isMissingContinuation } from "./codex/thread-access.js";
import { exactTurnKey, isCodexThreadBetweenTurns, recordValue } from "./codex/notifications.js";
export { CODEX_READ_ONLY_CONFIG_OVERRIDES } from "./codex/thread-access.js";
export type { CodexAdapterRpc } from "./codex/types.js";
export type { CodexPermissionObservation } from "./codex/types.js";
export { CodexPermissionReplyError } from "./codex/types.js";
export type { CodexProviderAdapterDependencies } from "./codex/types.js";
export { COMMAND_OUTPUT_WINDOW_MS } from "./codex/types.js";
export type { CodexProviderAdapterOptions } from "./codex/types.js";
export { codexMcpWorkplaceConfigOverrides } from "./codex/launch-contract.js";
export { CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION } from "./codex/launch-contract.js";
export { CODEX_READ_ONLY_ROOM_TOOLS } from "./codex/launch-contract.js";



export class CodexProviderAdapter extends CodexAdapterPermissions implements ProviderAdapter {
  async readUsage(providerHandle: ProviderHandle): Promise<ProviderUsage | null> {
    const handle = this.requireHandle(providerHandle);
    const continuation = handle.providerContinuationId;
    const connection = handle.client.currentConnectionId();
    if (this.handles.get(handle.workAttemptId) !== handle || !connection) return null;
    handle.usage.snapshot(continuation);
    const current = () => this.handles.get(handle.workAttemptId) === handle
      && handle.providerContinuationId === continuation && handle.client.currentConnectionId() === connection;
    const now = Date.parse(this.deps.now());
    const key = `${connection}:${continuation}`;
    if (handle.usageConnection !== key) {
      handle.usageReadAt = 0; handle.usageRead = null;
      if (handle.usageConnection) handle.usage.accountFailed();
      handle.usageConnection = key;
    }
    if (!handle.usageRead && (!handle.usageReadAt || now - handle.usageReadAt >= 30_000)) {
      handle.usageReadAt = now;
      const accountRevision = handle.usage.accountRevision;
      const reading = (async () => {
        await Promise.all([
          handle.client.request("account/rateLimits/read", undefined, { timeoutMs: 2_000 }).then(payload => {
            if (current()) handle.usage.account(payload, this.deps.now(), accountRevision);
          }, () => { if (current()) handle.usage.accountFailed(accountRevision); }),
          (async () => {
            if (handle.usage.snapshot(continuation).context) return;
            try {
              const read = await handle.client.request<{ thread?: { id?: string; path?: unknown } }>("thread/read", { threadId: continuation, includeTurns: false }, { timeoutMs: 2_000 });
              if (!current() || read.thread?.id !== continuation) return;
              const context = await readCodexUsageTail(read.thread.path);
              if (current()) handle.usage.seedContext(context);
            } catch { /* A not-yet-materialized thread has no previous sample. */ }
          })(),
        ]);
      })().finally(() => { if (handle.usageRead === reading) handle.usageRead = null; });
      handle.usageRead = reading;
    }
    await handle.usageRead;
    return current() ? handle.usage.snapshot(continuation) : null;
  }

  async describeManagedLaunchContract(input: { apiUrl: string; devMcpServerEntryPath?: string }): Promise<string | null> {
    // Mutable development trees have no release seal and require explicit recovery.
    if (input.devMcpServerEntryPath) return null;
    const runtime = this.deps.resolveMcpRuntime();
    const tools = boundedCodexTools(await this.deps.readMcpRuntimeContract(runtime.entryPath, input.apiUrl));
    return boundedLaunchContract(input.apiUrl, tools);
  }

  async preflightCustodialPolling(input: { devMcpServerEntryPath?: string }): Promise<void> {
    await this.resolveCustodialPollingRuntime(input.devMcpServerEntryPath);
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    ref = { ...ref, ...(ref.launchPolicy === undefined ? {} : { launchPolicy: codexTurnPolicy(ref.launchPolicy) }) };
    const authorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    const handle = this.handles.get(ref.workAttemptId);
    if (
      !handle ||
      handle.terminal ||
      handle.lifecycleAuthorityMode !== authorityMode ||
      handle.providerContinuationId !== ref.providerContinuationId ||
      !sameProviderConnectionIdentity(handle.providerConnection, ref.providerConnection)
    ) {
      if (handle) return null;
    } else {
      return this.bindFoundPolicy(handle, ref.launchPolicy);
    }
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "codex_app_server") {
      return null;
    }
    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) {
      if (
        pending.ref.providerContinuationId !== ref.providerContinuationId
        || (pending.ref.lifecycleAuthorityMode ?? "typed_shadow") !== authorityMode
        || !sameProviderConnectionIdentity(pending.ref.providerConnection, connection)
      ) return null;
      const attached = await pending.promise;
      return attached instanceof CodexProviderHandle ? this.bindFoundPolicy(attached, ref.launchPolicy) : attached;
    }
    const attaching = this.attachRunning(ref, connection).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId)?.promise === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, { ref, promise: attaching });
    return attaching;
  }

  async resume(
    ref: ProviderContinuationRef,
    req: ProviderSpawnRequest,
  ): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) {
      throw new Error("Codex resume ref must belong to the same work attempt.");
    }
    return this.start(req, ref);
  }

  async poke(_handle: ProviderHandle, _message: string): Promise<void> {
    throw new Error("Codex mid-turn injection is not enabled: P0 proved room delivery, not native poke.");
  }

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

  /**
   * Verify a missing durable conversation over a short materialization grace
   * window, then create a replacement thread on this exact live app-server.
   * The handle object is retained so process-exit and stream ownership remain
   * singular; only its fenced continuation identity changes.
   */
  async repairContinuation(
    providerHandle: ProviderHandle,
    request: ProviderContinuationRepairRequest,
    options: {
      checkpointReplacement: (providerContinuationId: string) => Promise<void>;
      detachSignal?: AbortSignal;
    },
  ): Promise<ProviderContinuationRepairResult> {
    const handle = this.requireHandle(providerHandle);
    const expected = request.expectedProviderContinuationId.trim();
    if (!expected || expected !== handle.providerContinuationId
      || request.workAttemptId !== handle.workAttemptId) {
      throw new Error("Codex continuation repair no longer targets the exact active handle.");
    }
    if (handle.terminal) throw new Error("Codex continuation repair requires a live provider process.");
    if (handle.turnWaiters.size) throw new Error("Codex continuation repair is unsafe while a provider turn is active.");
    // Loading or starting a thread makes Codex read the project's config again.
    if (handle.ownerSetup) await this.stopBeforeProjectReload(handle, request.cwd);
    // It reads its command rules again too: what the project or the machine gained since the launch would apply.
    handle.cwd = request.cwd;
    await this.stopBeforeRuleLoad(handle, request.launchPolicy, request.cwd);

    const assertAttached = () => {
      if (options.detachSignal?.aborted) {
        throw new CodexRoomTurnObservationDetachedError("Codex continuation repair detached.");
      }
      if (handle.terminal || this.handles.get(handle.workAttemptId) !== handle
        || handle.providerContinuationId !== expected || isCodexRuntimeUnavailable(handle.state)) {
        throw new Error("Codex continuation repair lost exact provider authority.");
      }
    };

    // Probe at absolute offsets 0s, 1s, 3s, and 7s. The waits are therefore
    // the differences between offsets, not 1s + 3s + 7s (which would turn the
    // advertised seven-second grace into eleven seconds).
    // A stored policy can predate the access level it was launched under. The
    // policy bound to this runtime is the one a replacement thread must keep.
    // A thread of a process with its owner's setup is given the access level's
    // own three options and nothing else the stored policy holds.
    const stored = recordValue(request.launchPolicy) ?? {};
    const policy = normalizeLaunchPolicy({
      ...(handle.ownerSetup ? Object.fromEntries(CODEX_ACCESS_LEVEL_OPTIONS.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]])) : stored),
      ...(handle.appliedTurnPolicy() ?? {}),
    });
    const effort = await codexThreadEffort(handle.client, policy, request.model, request.reasoningEffort);
    // The daemon reads launch notices when a launch returns, and it drops a line that a repair
    // streams when the repair replaces the conversation. So a repair returns its line, and the
    // daemon records it when the repair is done.
    // The line is that of the conversation the repair ends on, read as a launch reads it.
    let effortNotice = effort.notice;
    const readEffort = (thread: CodexThreadResult) => {
      effortNotice = effort.notice ?? codexEffortMismatchNotice(effort.sent, thread);
    };
    // The line is returned when it is not what the agent was last told and not what this runtime
    // last found. It counts as said when the daemon has recorded it, and not before: a repair that
    // fails, and a line that the daemon could not record, leave it to be said by the retry or by
    // the next launch. It is then kept where a launch looks, so that launch does not say it again.
    const said = (): Pick<ProviderContinuationRepairResult, "notices" | "noticesRecorded"> => {
      const line = effortNotice;
      const agent = request.supervisorEntryId;
      const unsaid = line !== null && line !== handle.effortNotice && !codexEffortNoticeSaidOnce.isLastTold(agent, line);
      return {
        ...(unsaid ? { notices: [line] } : {}),
        noticesRecorded: () => {
          handle.effortNotice = line;
          codexEffortNoticeSaidOnce.told(agent, line);
        },
      };
    };
    const probeDelays = [0, 1_000, 2_000, 4_000];
    const probe = async (threadId: string): Promise<boolean> => {
      for (const waitMs of probeDelays) {
        if (waitMs) await this.deps.sleep(waitMs);
        assertAttached();
        try {
          // A metadata-only thread/read can succeed for a persisted Codex
          // thread that the live app-server still cannot execute. thread/resume
          // is the materialization boundary: only its exact acknowledgement is
          // evidence that a following turn/start may use this continuation.
          const resumed = await handle.client.request<CodexThreadResult>("thread/resume", {
            threadId,
            cwd: request.cwd,
            ...codexThreadAccess(policy, handle.readOnlyProfile()),
            ...(request.model ? { model: request.model } : {}),
            ...codexThreadConfig(handle.readOnlyLevel, effort),
          });
          assertAttached();
          assertCodexReviewerApplied(policy, resumed);
          assertCodexReadOnlyApplied(policy, resumed, handle.readOnlyProfile());
          readEffort(resumed);
          if (resumed.thread?.id === threadId) return true;
          throw new Error("Codex continuation repair resolved a different thread.");
        } catch (error) {
          if (isMethodNotFound(error)) {
            this.resumeSupported = false;
            throw new Error("Codex app-server cannot materialize a saved conversation because thread/resume is unavailable.");
          }
          if (!isMissingContinuation(error, threadId)) throw error;
        }
      }
      return false;
    };

    const checkpointedReplacement = request.checkpointedReplacementProviderContinuationId?.trim() || null;
    if (checkpointedReplacement) {
      if (checkpointedReplacement === expected) {
        throw new Error("A checkpointed replacement must differ from the missing conversation.");
      }
      if (!await probe(checkpointedReplacement)) {
        throw new Error("The checkpointed replacement conversation is unavailable; refusing to create another orphan.");
      }
      await options.checkpointReplacement(checkpointedReplacement);
      assertAttached();
      handle.replaceContinuation(checkpointedReplacement);
      return {
        handle,
        outcome: "replaced",
        previousProviderContinuationId: expected,
        replacementProviderContinuationId: checkpointedReplacement,
        ...said(),
      };
    }

    if (!request.forceReplacement && await probe(expected)) {
      return {
        handle,
        outcome: "rematerialized",
        previousProviderContinuationId: expected,
        replacementProviderContinuationId: expected,
        ...said(),
      };
    }

    assertAttached();
    const started = await handle.client.request<CodexThreadResult>("thread/start", {
      ...codexThreadAccess(policy, handle.readOnlyProfile()),
      historyMode: CODEX_THREAD_HISTORY_MODE,
      ...(request.model ? { model: request.model } : {}),
      ...codexThreadConfig(handle.readOnlyLevel, effort),
    });
    assertCodexReviewerApplied(policy, started);
    assertCodexReadOnlyApplied(policy, started, handle.readOnlyProfile());
    assertCodexThreadDirectory(request.cwd, started);
    readEffort(started);
    const replacement = started.thread?.id?.trim();
    if (!replacement || replacement === expected) {
      throw new Error("Codex continuation repair did not return a distinct replacement thread.");
    }
    // This is the commit barrier: an uncheckpointed thread remains an idle
    // orphan and can never become authoritative.
    await options.checkpointReplacement(replacement);
    assertAttached();
    handle.replaceContinuation(replacement);
    return {
      handle,
      outcome: "replaced",
      previousProviderContinuationId: expected,
      replacementProviderContinuationId: replacement,
      ...said(),
    };
  }

  async stopRef(
    ref: ProviderContinuationRef,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    ref = { ...ref, providerConnection: ref.providerConnection && { ...ref.providerConnection } };
    const connection = ref.providerConnection;
    const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
    const force = options.force === true;
    if (!ref.workAttemptId?.trim() || !ref.providerContinuationId?.trim()
      || connection?.kind !== "codex_app_server" || !connection.url?.trim()
      || !Number.isSafeInteger(connection.pid) || connection.pid! <= 0
      || typeof connection.processIdentity !== "string" || !PS_BIRTH_EVIDENCE.test(connection.processIdentity.trim())
      || !Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("Codex exact-reference stop requires an exact continuation and process birth.");
    }
    const pid = connection.pid!;
    const birth = connection.processIdentity;
    const isGone = () => {
      const current = this.deps.getProcessIdentity(pid);
      if (current === null) return true;
      // Unequal malformed ps output is uncertainty, not PID-reuse evidence.
      if (typeof current !== "string" || !PS_BIRTH_EVIDENCE.test(current.trim())) {
        throw new Error("Codex exact-reference stop is ambiguous because process birth cannot be verified.");
      }
      return !sameProcessBirthIdentity(current, birth);
    };
    const terminal = (): ProviderTerminalPayload => ({
      ...synthesizeTerminalPayload({
        endedAt: this.deps.now(), exitCode: null, signal: null,
        providerContinuationId: ref.providerContinuationId, stopRequested: true,
      }),
      nativeRuntimeDeath: { kind: "codex_app_server", pid, processIdentity: birth },
    });
    if (isGone()) return terminal();
    const known = [...this.handles.values()].find((handle) => handle.pid === pid
      && handle.providerConnection.processIdentity
      && sameProcessBirthIdentity(handle.providerConnection.processIdentity, birth));
    if (known && (known.workAttemptId !== ref.workAttemptId
      || known.providerContinuationId !== ref.providerContinuationId
      || !sameProviderConnectionIdentity(known.providerConnection, connection))) {
      throw new Error("Codex exact-reference stop conflicts with the known native process owner.");
    }
    if (known) { known.stopRequested = true; known.state = "stopping"; known.invalidatePermissions(); }
    const awaitAbsence = async () => {
      const deadline = Date.now() + graceMs;
      for (;;) {
        if (isGone()) return true;
        if (Date.now() >= deadline) return false;
        await delay(Math.min(25, deadline - Date.now()));
      }
    };
    this.deps.signalProcess(pid, force ? "SIGKILL" : "SIGTERM");
    if (await awaitAbsence()) return terminal();
    if (!force) {
      // Never escalate into a reused PID, nor accept a cached protocol error.
      if (isGone()) return terminal();
      this.deps.signalProcess(pid, "SIGKILL");
      if (await awaitAbsence()) return terminal();
    }
    throw new Error("Codex exact-reference stop has not yet proved the recorded process birth is gone.");
  }

  /** The final reservation check and native signal run without an intervening await. */
  async stopIdle(rawHandle: ProviderHandle, assertCurrent: () => void): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(rawHandle);
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const rpcConnection = handle.client.currentConnectionId();
    const boundary = await this.inspectTurnBoundary(handle);
    if (boundary.state !== "idle" || boundary.providerContinuationId !== continuation
      || boundary.nativeProcessIdentity !== connection.processIdentity
      || this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current"
      || handle.observedState() !== "idle" || handle.client.listPendingRequests().length > 0) {
      throw Object.assign(new Error("Codex is not provably idle for configuration replacement."), { code: "MANAGED_RUNTIME_REFRESH_DEFERRED" });
    }
    assertCurrent();
    return this.stop(handle);
  }

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    if (handle.pid === null) {
      throw new Error("Cannot stop a Codex app-server without an observed process id.");
    }
    const pid = handle.pid;
    const processIdentity = handle.providerConnection.processIdentity;
    const assertProcessIdentity = () => {
      const currentIdentity = this.deps.getProcessIdentity(pid);
      if (!processIdentity || typeof currentIdentity !== "string"
        || !sameProcessBirthIdentity(currentIdentity, processIdentity)) {
        throw new Error("Cannot stop the Codex app-server because its exact process birth cannot be verified.");
      }
    };

    assertProcessIdentity();
    handle.stopRequested = true;
    handle.state = "stopping";
    handle.invalidatePermissions();
    const exitPromise = this.requireExitPromise(handle);
    if (options.force) {
      this.deps.signalProcess(pid, "SIGKILL");
      return exitPromise;
    }

    this.deps.signalProcess(pid, "SIGTERM");
    const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
    const graceful = await Promise.race([
      exitPromise.then((payload) => ({ payload })),
      delay(graceMs).then(() => null),
    ]);
    if (graceful) return graceful.payload;

    // A PID observed before the grace period may now belong to another child.
    assertProcessIdentity();
    this.deps.signalProcess(pid, "SIGKILL");
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

  onExecution(handle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.requireHandle(handle).execution.subscribe(listener);
  }

  async probeControl(providerHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.nativeRuntimeUnavailable) {
      return { state: "lost", controlEvidence: handle.nativeRuntimeUnavailable };
    }
    const proof = (): ControlProbeResult | null => {
      const expected = handle.providerConnection.processIdentity;
      if (handle.pid === null || !expected) return { state: "degraded" };
      const actual = this.deps.getProcessIdentity(handle.pid);
      if (actual === undefined) return { state: "degraded" };
      if (actual === null) return { state: "lost", controlEvidence: "process_exit" };
      if (!sameProcessBirthIdentity(actual, expected)) return { state: "lost", controlEvidence: "process_birth_changed" };
      return null;
    };
    let result = proof();
    if (!result) {
      try {
        // Pinned 0.144.1 has no ping. A single loaded-ID page is a cheap RPC
        // round trip, unlike thread/read which can serialize a whole history.
        const response = await handle.client.request<unknown>("thread/loaded/list", { limit: 1 }, { timeoutMs: 2_000 });
        const data = recordValue(response);
        result = proof() ?? (Array.isArray(data?.data) && data.data.length <= 1 && data.data.every(nativeExecutionId)
          ? { state: "responsive" } : { state: "degraded" });
      } catch (error) {
        result = proof() ?? { state: isMethodNotFound(error) ? "unprobeable" : "degraded" };
      }
    }
    if (handle.nativeRuntimeUnavailable) {
      return { state: "lost", controlEvidence: handle.nativeRuntimeUnavailable };
    }
    handle.execution.emit({ domain: "control", kind: "state_changed", sideEffects: "none", ...result },
      handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
    return result;
  }
}
