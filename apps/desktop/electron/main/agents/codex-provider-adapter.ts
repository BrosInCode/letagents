import { CODEX_THREAD_HISTORY_MODE } from "../../../../../shared/codex-thread-history.mjs";
import { readCodexUsageTail } from "./provider-usage.js";
import type { ProviderUsage } from "../../../shared/provider-usage.js";
import { nativeExecutionId } from "./provider-execution-observer.js";
import type { ControlProbeResult, NativeExecutionObservation, NativeExecutionSubscription } from "../../../shared/execution-protocol.js";
import { synthesizeTerminalPayload, sameProviderConnectionIdentity, type ProviderActivityEvent, type ProviderAdapter, type ProviderAttachTerminal, type ProviderContinuationRef, type ProviderHandle, type ProviderSpawnRequest, type ProviderStopOptions, type ProviderContinuationRepairRequest, type ProviderContinuationRepairResult, type ProviderStreamEvent, type ProviderTerminalPayload } from "./provider-adapter.js";
import { DEFAULT_STOP_GRACE_MS, delay, sameProcessBirthIdentity } from "./provider-evidence.js";
import { CODEX_ACCESS_LEVEL_OPTIONS, PS_BIRTH_EVIDENCE, boundedCodexTools, boundedLaunchContract, codexTurnPolicy, normalizeLaunchPolicy } from "./codex/launch-contract.js";
import { CodexAdapterTurns } from "./codex/adapter-turns.js";
import { CodexProviderHandle, isCodexRuntimeUnavailable } from "./codex/handle.js";
import { CodexRoomTurnObservationDetachedError, isMethodNotFound } from "./codex/room-tools.js";
import { type CodexThreadResult, assertCodexReadOnlyApplied, assertCodexReviewerApplied, assertCodexThreadDirectory, codexEffortMismatchNotice, codexEffortNoticeSaidOnce, codexThreadAccess, codexThreadConfig, codexThreadEffort, isMissingContinuation } from "./codex/thread-access.js";
import { recordValue } from "./codex/notifications.js";
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



export class CodexProviderAdapter extends CodexAdapterTurns implements ProviderAdapter {
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
