import { normalizeAgentAvatar } from "../../../../../shared/agent-avatar.mjs";
import { randomUUID } from "node:crypto";
import type {
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorRoomDeliveryRetryInput,
  DesktopSupervisorServiceSnapshot,
  DesktopSupervisorStateSnapshot,
  DesktopSupervisorTurnControlInput,
  DesktopSupervisorTurnControlResolutionInput,
  DesktopSupervisorTurnControlResult,
} from "../../ipc-types.js";
import {
  isDaemonAsyncRpcAccepted,
  jsonValueSchema,
  type DaemonAsyncRpcMethod,
  type DaemonAsyncRpcOutcome,
  type DaemonRpcEffectView,
  type DaemonRpcParams,
} from "#daemon-contract/index.js";
import { apiUrl } from "#provider-runtime/paths.js";
import { supervisedDeliveryModeForProvider } from "../agents/provider-registry.js";
import { SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT } from "./constants.js";
import { mapAgentConfiguration, mapAgentInspectorDetail, mapRoomMove } from "./agent-mapping.js";
import { mapActivity, mapEntry } from "./entry-mapping.js";
import { supervisorStateWatchAcceptsStatus } from "./state-watch-policy.js";
import type { DesktopSupervisorStateWatchResult } from "./types.js";
import { nonEmptyString, record, validTurnControlActionId } from "./wire-values.js";
import { SupervisorDaemonHostApprovalClient } from "./client-host-approvals.js";

const MAX_OBSERVED_RPC_EFFECTS_PER_GENERATION = 256;

export class SupervisorDaemonClient extends SupervisorDaemonHostApprovalClient {
  private readonly observedRpcEffects = new Map<number, Map<string, DaemonRpcEffectView>>();
  private readonly observedRpcEffectOrder = new Map<number, string[]>();
  private readonly rpcEffectWaiters = new Map<string, {
    generation: number;
    method: DaemonAsyncRpcMethod;
    resolve: (view: DaemonRpcEffectView) => void;
    reject: (error: Error) => void;
  }>();
  private readonly probingRpcEffects = new Set<string>();
  private rpcEffectWatchLoop: {
    generation: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;

  /** Troubleshooting observes the service without taking lifecycle ownership. */
  async getServiceSnapshot(): Promise<DesktopSupervisorServiceSnapshot> {
    const status = await this.connectIfRunning();
    let state: DesktopSupervisorStateSnapshot | null = null;
    if (status && !status.maintenanceHoldId && status.capabilities.agentStateSubscription
      && supervisorStateWatchAcceptsStatus(status)) {
      state = await this.watchState({ afterDaemonGeneration: 0, afterSequence: 0, waitMs: 0 });
      if (state.daemonGeneration !== status.generation) {
        throw new Error("The background service restarted during this read. Refresh to see its current state.");
      }
    }
    return { status, state, observedAt: this.now().toISOString() };
  }

  async list(
    roomIdentifier?: string | null,
    options: { activity?: "full" | "summary" } = {},
  ): Promise<DesktopSupervisorManifestEntry[]> {
    await this.ensureRunning();
    // Rich manifest projections open several durable stores and can be slower
    // on their first read. This must not share the tight timeout used by small
    // control requests or a healthy cold daemon is misreported as unavailable.
    // manifest.list stays the full-history read unless the caller asks for the
    // summary: it backs first load, the stale-subscription repair, and the
    // Inspector's payload detail. It is also the expensive one, so ask the
    // daemon to project and serialize only the room this caller will keep. The
    // client-side filter stays as well: a daemon that ignored the scope still
    // yields a correct answer. A caller that reads no activity history passes
    // `activity: "summary"`; the field is sent only then, so every other
    // request is the one an older daemon already understands.
    const params = {
      ...(roomIdentifier ? { room_id: roomIdentifier } : {}),
      ...(options.activity === "summary" ? { activity: "summary" as const } : {}),
    };
    const entries = await this.call(
      "manifest.list",
      Object.keys(params).length > 0 ? params : undefined,
    );
    return entries.map((entry) => mapEntry(entry)).filter((entry) => !roomIdentifier || entry.roomId === roomIdentifier);
  }

  /**
   * One entry with its full activity history, or null when the daemon has no
   * entry with this id. Reads one agent instead of the whole manifest. There is
   * no fallback to `list`: ensureRunning guarantees the daemon implementation
   * version matches this desktop, so the daemon knows the method.
   */
  async getEntry(entryId: string): Promise<DesktopSupervisorManifestEntry | null> {
    await this.ensureRunning();
    const entry = await this.call("manifest.get_entry", { entry_id: entryId });
    return entry ? mapEntry(entry) : null;
  }

  async watchState(input: {
    afterDaemonGeneration: number;
    afterSequence: number;
    waitMs?: number;
  }): Promise<DesktopSupervisorStateSnapshot> {
    const result = await this.requestStateWatch(input, false);
    if (!result.complete) throw new Error("Supervisor daemon returned state changes where the whole state was requested.");
    return { daemonGeneration: result.daemonGeneration, sequence: result.sequence, entries: result.entries };
  }

  /**
   * The state since the sequence the caller holds, when the daemon still
   * remembers that sequence: only the entries whose view changed, the ids of
   * entries that are gone, and the order of every entry now. Otherwise, and
   * from a daemon older than this request, the whole state as watchState gives it.
   */
  async watchStateChanges(input: {
    afterDaemonGeneration: number;
    afterSequence: number;
    waitMs?: number;
  }): Promise<DesktopSupervisorStateWatchResult> {
    return this.requestStateWatch(input, true);
  }

  private async requestStateWatch(
    input: { afterDaemonGeneration: number; afterSequence: number; waitMs?: number; signal?: AbortSignal },
    changedOnly: boolean,
  ): Promise<DesktopSupervisorStateWatchResult> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.call("manifest.watch_state", {
      after_daemon_generation: input.afterDaemonGeneration,
      after_sequence: input.afterSequence,
      wait_ms: waitMs,
      ...(changedOnly ? { changed_only: true } : {}),
    }, { unrefSocket: true, signal: input.signal });
    if (
      !Number.isSafeInteger(value.daemon_generation)
      || value.daemon_generation < 1
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 1
      || !Array.isArray(value.entries)
    ) {
      throw new Error("Supervisor daemon returned an invalid state snapshot.");
    }
    const isCompleteSnapshot = !("complete" in value) || value.complete !== false;
    this.observeRpcEffects(value.daemon_generation, value.rpc_effects, isCompleteSnapshot);
    const entries = value.entries.map((entry) => mapEntry(entry, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT));
    if (isCompleteSnapshot) {
      return { complete: true, daemonGeneration: value.daemon_generation, sequence: value.sequence, entries };
    }
    const ids = (list: unknown): string[] | null =>
      Array.isArray(list) && list.every((id) => typeof id === "string" && id.length > 0) ? list as string[] : null;
    const removedEntryIds = ids(value.removed_entry_ids);
    const entryOrder = ids(value.entry_order);
    if (!removedEntryIds || !entryOrder) throw new Error("Supervisor daemon returned invalid state changes.");
    return {
      complete: false,
      daemonGeneration: value.daemon_generation,
      sequence: value.sequence,
      changedEntries: entries,
      removedEntryIds,
      entryOrder,
    };
  }

  protected override rememberReadyStatus(
    status: import("../../ipc-types.js").DesktopSupervisorDaemonStatus,
  ): import("../../ipc-types.js").DesktopSupervisorDaemonStatus {
    const remembered = super.rememberReadyStatus(status);
    if (!this.maintenanceRequested && !status.maintenanceHoldId) {
      this.rejectStaleRpcEffectWaiters(status.generation, false);
    }
    return remembered;
  }

  /**
   * Dispatches a long-running RPC under the short default socket timeout (which
   * returns `{ effect_id, daemon_generation }` at once) and awaits its terminal
   * outcome delivered through `manifest.watch_state` (`rpc_effects`).
   */
  private async callAsyncRpcEffect<M extends DaemonAsyncRpcMethod>(
    method: M,
    params: DaemonRpcParams<M>,
  ): Promise<DaemonAsyncRpcOutcome<M>> {
    const accepted = await this.call(method, params);
    if (!isDaemonAsyncRpcAccepted(accepted)) {
      throw new Error(`Supervisor daemon returned an invalid async effect acknowledgement for ${method}.`);
    }
    const settled = await this.awaitRpcEffect(method, accepted.effect_id, accepted.daemon_generation);
    if (settled.state === "failed" || settled.state === "uncertain") {
      this.invalidateReadyStatus();
      throw new Error(settled.error || `Supervisor daemon request failed: ${method}`);
    }
    if (settled.result === null || typeof settled.result !== "object" || Array.isArray(settled.result)) {
      throw new Error(`Supervisor daemon returned an invalid async effect outcome for ${method}.`);
    }
    return settled.result as DaemonAsyncRpcOutcome<M>;
  }

  private awaitRpcEffect(
    method: DaemonAsyncRpcMethod,
    effectId: string,
    daemonGeneration: number,
  ): Promise<DaemonRpcEffectView> {
    const existing = this.observedRpcEffects.get(daemonGeneration)?.get(effectId);
    if (existing && (existing.state === "completed" || existing.state === "failed" || existing.state === "uncertain")) {
      return Promise.resolve(existing);
    }
    return new Promise<DaemonRpcEffectView>((resolve, reject) => {
      this.rpcEffectWaiters.set(effectId, {
        generation: daemonGeneration,
        method,
        resolve,
        reject,
      });
      const watchAlreadyRunning = Boolean(
        this.rpcEffectWatchLoop
        && this.rpcEffectWatchLoop.generation === daemonGeneration
        && !this.rpcEffectWatchLoop.controller.signal.aborted,
      );
      this.ensureRpcEffectWatch(daemonGeneration);
      if (watchAlreadyRunning && !this.probingRpcEffects.has(effectId)) {
        void this.probeMissingRpcEffect(effectId, daemonGeneration);
      }
    });
  }

  private rejectStaleRpcEffectWaiters(daemonGeneration: number, invalidateOnReject: boolean): void {
    let rejectedAny = false;
    for (const [effectId, waiter] of this.rpcEffectWaiters) {
      if (waiter.generation !== daemonGeneration) {
        this.rpcEffectWaiters.delete(effectId);
        rejectedAny = true;
        waiter.reject(new Error(`Supervisor daemon generation changed while waiting for ${waiter.method}.`));
      }
    }
    if (rejectedAny && invalidateOnReject) {
      this.invalidateReadyStatus();
    }
    if (this.rpcEffectWaiters.size === 0 && this.rpcEffectWatchLoop) {
      const loop = this.rpcEffectWatchLoop;
      this.rpcEffectWatchLoop = null;
      loop.controller.abort();
    }
  }

  private observeRpcEffects(
    daemonGeneration: number,
    effects: readonly DaemonRpcEffectView[] | undefined,
    isCompleteSnapshot: boolean,
  ): void {
    this.rejectStaleRpcEffectWaiters(daemonGeneration, true);
    const presentIds = isCompleteSnapshot ? new Set<string>() : null;
    if (Array.isArray(effects) && effects.length > 0) {
      let byId = this.observedRpcEffects.get(daemonGeneration);
      if (!byId) {
        for (const oldGen of this.observedRpcEffects.keys()) {
          if (oldGen < daemonGeneration) {
            this.observedRpcEffects.delete(oldGen);
            this.observedRpcEffectOrder.delete(oldGen);
          }
        }
        byId = new Map();
        this.observedRpcEffects.set(daemonGeneration, byId);
      }
      let order = this.observedRpcEffectOrder.get(daemonGeneration);
      if (!order) {
        order = [];
        this.observedRpcEffectOrder.set(daemonGeneration, order);
      }
      for (const effect of effects) {
        if (!effect || typeof effect.effect_id !== "string" || effect.daemon_generation !== daemonGeneration) continue;
        presentIds?.add(effect.effect_id);
        const previous = byId.get(effect.effect_id);
        byId.set(effect.effect_id, effect);
        const terminal = effect.state === "completed" || effect.state === "failed" || effect.state === "uncertain";
        const wasTerminal = previous !== undefined
          && (previous.state === "completed" || previous.state === "failed" || previous.state === "uncertain");
        if (terminal && !wasTerminal) {
          order.push(effect.effect_id);
          while (order.length > MAX_OBSERVED_RPC_EFFECTS_PER_GENERATION) {
            const evicted = order.shift();
            if (evicted) byId.delete(evicted);
          }
        }
        if (terminal) {
          const waiter = this.rpcEffectWaiters.get(effect.effect_id);
          if (waiter && waiter.generation === daemonGeneration) {
            this.rpcEffectWaiters.delete(effect.effect_id);
            waiter.resolve(effect);
          }
        }
      }
    }
    if (presentIds) {
      for (const [effectId, waiter] of this.rpcEffectWaiters) {
        if (
          waiter.generation === daemonGeneration
          && !presentIds.has(effectId)
          && !this.probingRpcEffects.has(effectId)
        ) {
          void this.probeMissingRpcEffect(effectId, daemonGeneration);
        }
      }
    }
    if (this.rpcEffectWaiters.size === 0 && this.rpcEffectWatchLoop) {
      const loop = this.rpcEffectWatchLoop;
      this.rpcEffectWatchLoop = null;
      loop.controller.abort();
    }
  }

  /**
   * Durable lookup fallback when a complete state-watch snapshot omits an
   * awaited `effect_id` (for example after watch-cache eviction past 256
   * settled effects). Prevents silent hangs while keeping zero overhead on the
   * normal state-watch fast path.
   */
  private async probeMissingRpcEffect(effectId: string, daemonGeneration: number): Promise<void> {
    this.probingRpcEffects.add(effectId);
    try {
      const durable = await this.call("supervisor.get_rpc_effect", {
        effect_id: effectId,
        daemon_generation: daemonGeneration,
      });
      const waiter = this.rpcEffectWaiters.get(effectId);
      if (!waiter || waiter.generation !== daemonGeneration) return;
      if (!durable) {
        this.rpcEffectWaiters.delete(effectId);
        this.invalidateReadyStatus();
        waiter.reject(
          new Error(`Supervisor daemon has no record of async RPC effect ${effectId} for generation ${daemonGeneration}.`),
        );
        if (this.rpcEffectWaiters.size === 0 && this.rpcEffectWatchLoop) {
          const loop = this.rpcEffectWatchLoop;
          this.rpcEffectWatchLoop = null;
          loop.controller.abort();
        }
        return;
      }
      this.observeRpcEffects(daemonGeneration, [durable], false);
    } catch (error) {
      const waiter = this.rpcEffectWaiters.get(effectId);
      if (waiter && waiter.generation === daemonGeneration) {
        this.rpcEffectWaiters.delete(effectId);
        this.invalidateReadyStatus();
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        if (this.rpcEffectWaiters.size === 0 && this.rpcEffectWatchLoop) {
          const loop = this.rpcEffectWatchLoop;
          this.rpcEffectWatchLoop = null;
          loop.controller.abort();
        }
      }
    } finally {
      this.probingRpcEffects.delete(effectId);
    }
  }

  private hasWaitersForGeneration(generation: number): boolean {
    for (const waiter of this.rpcEffectWaiters.values()) {
      if (waiter.generation === generation) return true;
    }
    return false;
  }

  private ensureRpcEffectWatch(generation: number): void {
    if (
      this.rpcEffectWatchLoop
      && this.rpcEffectWatchLoop.generation === generation
      && !this.rpcEffectWatchLoop.controller.signal.aborted
    ) {
      return;
    }
    if (this.rpcEffectWatchLoop) {
      const previous = this.rpcEffectWatchLoop;
      this.rpcEffectWatchLoop = null;
      previous.controller.abort();
    }
    const controller = new AbortController();
    const loop = {
      generation,
      controller,
      promise: Promise.resolve(),
    };
    loop.promise = (async () => {
      let afterDaemonGeneration = 0;
      let afterSequence = 0;
      try {
        while (this.hasWaitersForGeneration(generation) && !controller.signal.aborted) {
          const initialSnapshot = afterDaemonGeneration === 0;
          const result = await this.requestStateWatch(
            {
              afterDaemonGeneration,
              afterSequence,
              waitMs: initialSnapshot ? 0 : 25_000,
              signal: controller.signal,
            },
            !initialSnapshot,
          );
          if (result.daemonGeneration !== generation) break;
          const noProgress = !initialSnapshot
            && result.daemonGeneration === afterDaemonGeneration
            && result.sequence === afterSequence;
          afterDaemonGeneration = result.daemonGeneration;
          afterSequence = result.sequence;
          if (noProgress && this.hasWaitersForGeneration(generation) && !controller.signal.aborted) {
            await new Promise<void>((resolveDelay) => {
              const onAbort = () => {
                clearTimeout(timer);
                resolveDelay();
              };
              const timer = setTimeout(() => {
                controller.signal.removeEventListener("abort", onAbort);
                resolveDelay();
              }, 5);
              timer.unref?.();
              controller.signal.addEventListener("abort", onAbort, { once: true });
            });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const err = error instanceof Error ? error : new Error(String(error));
          for (const [effectId, waiter] of this.rpcEffectWaiters) {
            if (waiter.generation === generation) {
              this.rpcEffectWaiters.delete(effectId);
              waiter.reject(err);
            }
          }
        }
      } finally {
        if (this.rpcEffectWatchLoop === loop) {
          this.rpcEffectWatchLoop = null;
        }
        const nextWaiter = this.rpcEffectWaiters.values().next().value as { generation: number } | undefined;
        if (nextWaiter) {
          this.ensureRpcEffectWatch(nextWaiter.generation);
        }
      }
    })();
    this.rpcEffectWatchLoop = loop;
  }

  async watchAgentStream(input: {
    entryId: string;
    afterSequence: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<{ sequence: number; streamGeneration: number; droppedEvents: number; events: import("../../ipc-types/agents.js").DesktopAgentStreamEvent[]; ended: boolean }> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.call("supervisor.watch_agent_stream", {
      entry_id: input.entryId,
      after_sequence: input.afterSequence,
      wait_ms: waitMs,
    }, { unrefSocket: true, signal: input.signal });
    return {
      sequence: Number(value.sequence ?? input.afterSequence),
      streamGeneration: Number(value.stream_generation ?? 0),
      droppedEvents: Number(value.dropped_events ?? 0),
      ended: value.ended === true,
      events: (Array.isArray(value.events) ? value.events : []).map((event) => ({
        sequence: Number(event.sequence),
        observedAt: String(event.observed_at ?? ""),
        kind: String(event.kind ?? ""),
        method: String(event.method ?? ""),
        summary: typeof event.summary === "string" ? event.summary : null,
        payload: event.payload,
        ...(typeof event.latest_key === "string" && event.latest_key ? { latestKey: event.latest_key } : {}),
      })),
    };
  }

  /** The newest values of one agent's background commands, after a version; waits for a change. */
  async watchBackgroundCommands(input: {
    entryId: string;
    afterVersion: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<import("../../ipc-types/agents.js").DesktopBackgroundCommandsBatch> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.call("supervisor.watch_background_commands", {
      entry_id: input.entryId,
      after_version: input.afterVersion,
      wait_ms: waitMs,
    }, { unrefSocket: true, signal: input.signal });
    return {
      version: Number.isSafeInteger(value.version) ? value.version : input.afterVersion,
      commands: Array.isArray(value.commands) ? value.commands.slice(0, 16) : [],
      ended: value.ended === true,
    };
  }

  /**
   * Save a new supervised entry. A normal launch is saved as `running`: the
   * daemon starts the provider only once owner authority and room delivery
   * are installed, so the entry waits durably without a separate claim step.
   * A rental launch is saved `paused` and activated after the rental server
   * acknowledges provisioning.
   */
  async create(
    input: DesktopSupervisorCreateInput,
    options: { desiredState?: "running" | "paused" } = {},
  ): Promise<DesktopSupervisorManifestEntry> {
    if (input.avatar != null && !normalizeAgentAvatar(input.avatar)) throw new Error("Invalid agent avatar.");
    if (!input.charter.trim()) throw new Error("A supervised agent initial message is required.");
    const creationRequestId = input.creationRequestId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(creationRequestId)) {
      throw new Error("A valid supervised agent creation request id is required.");
    }
    const now = this.now().toISOString();
    const entry: DaemonRpcParams<"manifest.put">["entry"] = {
      id: `supervised_${creationRequestId}`,
      room_id: input.roomIdentifier,
      ...(input.localRoomId ? { local_room_id: input.localRoomId } : {}),
      display_name: input.displayName.trim() || "Supervised agent",
      ...(input.avatar ? { avatar: normalizeAgentAvatar(input.avatar) } : {}),
      provider: input.providerId,
      model: input.model?.trim() || null,
      // The daemon refuses an effort the provider does not take.
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      charter: input.charter.trim(),
      desired_state: options.desiredState ?? "running",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: input.permissionProfileId ?? null,
      // Admission declares the durable ingress owner independently from the
      // provider's opaque native launch policy. Provider descriptors opt into
      // daemon delivery only after their bounded-turn adapter is ready.
      delivery_mode: supervisedDeliveryModeForProvider(input.providerId),
      // A caller-supplied policy belongs to the selected native provider. Do
      // not reinterpret it as a LetAgents permission profile on its way to
      // the daemon. The Codex default remains only for the existing UI that
      // has not supplied an explicit provider policy yet.
      provider_launch_policy: input.launchPolicy !== undefined
        ? jsonValueSchema.parse(input.launchPolicy)
        : (input.providerId === "codex" && (!input.permissionProfileId || input.permissionProfileId === "full_access")
          ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
          : {}),
      created_by: "desktop",
      created_at: now,
      source_repo_path: input.repoRootPath?.trim() || null,
      workspace_path: null,
      work_attempt_id: null,
      workplace_liveness: { state: "unknown", observed_at: null, detail: "Awaiting room registration." },
      native_liveness: { state: "unknown", observed_at: null, detail: "Awaiting native provider launch." },
      activity: [],
      // Creation is the one authoritative point where the desktop can prove
      // no worker session has ever been minted for this immutable entry id.
      // Legacy entries that omitted this field remain revocation-unknown.
      last_worker_binding: null,
    };
    await this.ensureRunning();
    return mapEntry(await this.call("manifest.put", { entry }));
  }

  async setDesiredState(id: string, desiredState: DesktopSupervisorDesiredState): Promise<DesktopSupervisorManifestEntry> {
    if (!nonEmptyString(id) || !["running", "paused", "stopped"].includes(desiredState)) throw new Error("Agent lifecycle requires an exact identity and desired state.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    return mapEntry(await this.call("manifest.set_desired_state", { id, desired_state: desiredState }));
  }

  async recoverAgentRuntime(id: string, recovery?: import("../../ipc-types.js").DesktopSupervisorRuntimeRecoveryInput["recovery"]): Promise<DesktopSupervisorManifestEntry> {
    if (!nonEmptyString(id) || id !== id.trim()) {
      throw new Error("Agent runtime recovery requires an exact identity.");
    }
    const status = await this.ensureRunning();
    if (recovery && !status.capabilities.agentRuntimeRecoveryV2) {
      this.invalidateReadyStatus();
      throw new Error("Update the background service to use reconnect and runtime restart controls.");
    }
    if (!status.capabilities.agentRuntimeRecovery) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor is too old for safe provider runtime recovery; rebuild the desktop daemon.");
    }
    const result = await this.callAsyncRpcEffect(
      "supervisor.recover_agent_runtime",
      recovery
        ? {
            entry_id: id,
            daemon_generation: status.generation,
            mode: recovery.mode,
            operation_id: recovery.operationId,
            room_id: recovery.roomId,
            execution_generation_id: recovery.executionGenerationId,
            runtime_generation_id: recovery.runtimeGenerationId,
          }
        : { entry_id: id, daemon_generation: status.generation },
    );
    return mapEntry(result.entry);
  }

  async setDisplayName(id: string, displayName: string): Promise<DesktopSupervisorManifestEntry> {
    const normalized = displayName.trim();
    if (!nonEmptyString(id) || !normalized || normalized.length > 120) {
      throw new Error("Agent naming requires an exact identity and display name.");
    }
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor is too old for durable agent naming; rebuild the desktop daemon.");
    }
    return mapEntry(await this.call("manifest.set_display_name", {
      id,
      display_name: normalized,
    }));
  }

  /** This call deliberately accepts only a renderer-safe exact identity tuple. */
  async retryRoomDelivery(input: DesktopSupervisorRoomDeliveryRetryInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliveryRetry) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support room delivery retry.");
    }
    await this.call("supervisor.retry_room_delivery", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    });
  }

  async restoreAgentConversation(input: import("../../ipc-types/agents.js").DesktopSupervisorConversationRestoreInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.providerContinuationRepair) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support provider conversation restoration.");
    }
    await this.call("supervisor.restore_agent_conversation", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    });
  }

  async skipRoomDelivery(input: import("../../ipc-types/agents.js").DesktopSupervisorRoomDeliverySkipInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliverySkip) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support safely skipping a blocked room message.");
    }
    await this.call("supervisor.skip_room_delivery", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    });
  }

  async compareAndSetDesiredState(
    id: string,
    expectedDesiredState: DesktopSupervisorDesiredState,
    desiredState: DesktopSupervisorDesiredState,
  ): Promise<DesktopSupervisorManifestEntry | null> {
    if (!nonEmptyString(id) || !["running", "paused", "stopped"].includes(expectedDesiredState) || !["running", "paused", "stopped"].includes(desiredState)) throw new Error("Agent lifecycle compare-and-set requires exact typed fields.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.call("manifest.compare_and_set_desired_state", {
      id,
      expected_desired_state: expectedDesiredState,
      desired_state: desiredState,
    });
    return result.applied ? mapEntry(result.entry) : null;
  }

  async controlTurn(input: DesktopSupervisorTurnControlInput): Promise<DesktopSupervisorTurnControlResult> {
    if (!input || !nonEmptyString(input.entryId) || !nonEmptyString(input.roomId)
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !nonEmptyString(input.workAttemptId) || !nonEmptyString(input.executionGenerationId)
      || !nonEmptyString(input.providerContinuationId) || !nonEmptyString(input.providerTurnId)
      || !nonEmptyString(input.inboxItemId) || !nonEmptyString(input.sourceMessageId)
      || !validTurnControlActionId(input.actionId)
      || !Number.isSafeInteger(input.actionSequence) || input.actionSequence < 1
      || (input.correction !== null && input.correction !== undefined && typeof input.correction !== "string")) {
      throw new Error("Turn control requires exact typed identity and a bounded action id.");
    }
    const status = await this.ensureRunning();
    if (status.generation !== input.daemonGeneration) {
      this.invalidateReadyStatus();
      throw new Error("The supervisor generation changed before turn control was sent.");
    }
    return this.call("manifest.control_turn", {
      id: input.entryId,
      daemon_generation: input.daemonGeneration,
      room_id: input.roomId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      provider_continuation_id: input.providerContinuationId,
      provider_turn_id: input.providerTurnId,
      inbox_item_id: input.inboxItemId,
      source_message_id: input.sourceMessageId,
      action_id: input.actionId,
      action_sequence: input.actionSequence,
      correction: input.correction ?? null,
    });
  }

  async resolveTurnControl(input: DesktopSupervisorTurnControlResolutionInput): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.call("manifest.resolve_turn_control", {
      id: input.entryId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      action_id: input.actionId,
      resolution: input.resolution,
    }));
  }

  async readAttempt(id: string): Promise<DesktopSupervisorAttemptDetail> {
    await this.ensureRunning();
    const detail = await this.call("attempt.read", { id });
    return {
      entryId: String(detail.entry_id ?? id),
      workAttemptId: typeof detail.work_attempt_id === "string" ? detail.work_attempt_id : null,
      workspacePath: typeof detail.workspace_path === "string" ? detail.workspace_path : null,
      lastTerminal: detail.last_terminal && typeof detail.last_terminal === "object" ? detail.last_terminal as Record<string, unknown> : null,
      restartCount: Number(detail.restart_count ?? 0),
      activity: Array.isArray(detail.activity) ? detail.activity.map((event) => mapActivity(event)) : [],
    };
  }
  async getAgentInspectorDetail(input: import("../../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetailInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetail> {
    if (!nonEmptyString(input.entryId) || !nonEmptyString(input.roomId) || (input.sourceMessageId !== undefined && input.sourceMessageId !== null && !nonEmptyString(input.sourceMessageId))) throw new Error("Agent inspector detail requires exact non-empty entry, room, and optional source identities.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorDetail) { this.invalidateReadyStatus(); throw new Error("This supervisor does not support agent inspector detail history."); }
    const detail = await this.call("supervisor.get_agent_inspector_detail", { entry_id: input.entryId, room_id: input.roomId, source_message_id: input.sourceMessageId ?? null });
    return mapAgentInspectorDetail(detail, input);
  }

  async getAgentConfiguration(entryId: string, daemonGeneration: number): Promise<import("../../ipc-types/agents.js").DesktopSupervisorAgentConfiguration> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1) throw new Error("Agent configuration requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const value = await this.call("supervisor.get_agent_configuration", { entry_id: entryId, daemon_generation: daemonGeneration });
    return mapAgentConfiguration(value, entryId, daemonGeneration);
  }

  async updateAgentConfiguration(input: import("../../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateResult> {
    if (!input || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !input.configuration || typeof input.configuration !== "object"
      || !Object.hasOwn(input.configuration, "model") || !Object.hasOwn(input.configuration, "reasoningEffort") || !Object.hasOwn(input.configuration, "charter") || !Object.hasOwn(input.configuration, "permissionProfileId")) throw new Error("Agent configuration update requires exact typed coordinates and fields.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const result = await this.call("supervisor.update_agent_configuration", { entry_id: input.entryId, daemon_generation: input.daemonGeneration, expected_revision: input.expectedRevision, configuration: {
      model: input.configuration.model, reasoning_effort: input.configuration.reasoningEffort, charter: input.configuration.charter,
      permission_profile_id: input.configuration.permissionProfileId,
      ...(typeof input.configuration.imageInput === "boolean" ? { image_input: input.configuration.imageInput } : {}),
    } });
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated" && result.outcome !== "conflict") throw new Error("Supervisor returned an invalid configuration update result.");
    return { outcome: result.outcome, configuration: mapAgentConfiguration(record(result.configuration) ?? {}, input.entryId, input.daemonGeneration) };
  }

  async applyAgentConfiguration(input: import("../../ipc-types/agents.js").DesktopSupervisorAgentConfigurationApplyInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorAgentConfigurationApplyResult> {
    if (!input || !nonEmptyString(input.entryId)
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !Number.isSafeInteger(input.expectedConfigurationRevision) || input.expectedConfigurationRevision < 1) {
      throw new Error("Agent configuration apply requires exact typed coordinates.");
    }
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const result = await this.callAsyncRpcEffect("supervisor.apply_agent_configuration", {
      entry_id: input.entryId,
      daemon_generation: input.daemonGeneration,
      expected_configuration_revision: input.expectedConfigurationRevision,
    });
    if (result.outcome !== "already_applied"
      && result.outcome !== "restarting"
      && result.outcome !== "busy_active_turn"
      && result.outcome !== "conflict"
      && result.outcome !== "unsupported") {
      throw new Error("Supervisor returned an invalid configuration apply result.");
    }
    return { outcome: result.outcome };
  }

  async prepareRoomMove(input: import("../../ipc-types/agents.js").DesktopSupervisorRoomMovePrepareInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.entryId) || !nonEmptyString(input.destinationRoomId) || !nonEmptyString(input.requestId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move preparation requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.call("supervisor.prepare_room_move", { entry_id: input.entryId, destination_room_id: input.destinationRoomId, request_id: input.requestId, daemon_generation: input.daemonGeneration }), input.entryId);
  }

  async commitRoomMove(input: import("../../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move commit requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.call("supervisor.commit_room_move", { operation_id: input.operationId, entry_id: input.entryId, daemon_generation: input.daemonGeneration }), input.entryId, input.operationId);
  }

  async acknowledgeRoomMoveSourceRevocation(input: import("../../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput & { sourceAgentSessionId: string }): Promise<import("../../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !nonEmptyString(input.sourceAgentSessionId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move credential acknowledgement requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.call("supervisor.acknowledge_room_move_source_revocation", {
      operation_id: input.operationId, entry_id: input.entryId, source_agent_session_id: input.sourceAgentSessionId, daemon_generation: input.daemonGeneration,
    }), input.entryId, input.operationId);
  }

  async rollbackRoomMove(input: import("../../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput & { error: string }): Promise<import("../../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !nonEmptyString(input.error) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move rollback requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.call("supervisor.rollback_room_move", {
      operation_id: input.operationId, entry_id: input.entryId, error: input.error, daemon_generation: input.daemonGeneration,
    }), input.entryId, input.operationId);
  }

  async getRoomMove(input: import("../../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move status requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.call("supervisor.get_room_move", { operation_id: input.operationId, entry_id: input.entryId, daemon_generation: input.daemonGeneration }), input.entryId, input.operationId);
  }

  async getCurrentRoomMove(input: import("../../ipc-types/agents.js").DesktopSupervisorCurrentRoomMoveInput): Promise<import("../../ipc-types/agents.js").DesktopSupervisorRoomMove | null> {
    if (!nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Current room-move discovery requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    const result = await this.call("supervisor.get_current_room_move", {
      entry_id: input.entryId,
      daemon_generation: input.daemonGeneration,
    });
    return result === null ? null : mapRoomMove(result, input.entryId);
  }

  async retireAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
  ): Promise<{
    outcome: "retired" | "invalid" | "revocation_required";
    revocationKind?: "worker_session" | "grant_only";
    agentSessionId?: string;
    error?: string;
  }> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1
      || !(revokedAgentSessionId === null || nonEmptyString(revokedAgentSessionId))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)
      || typeof grantRevokedWithoutWorkerSession !== "boolean") throw new Error("Retire requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.callAsyncRpcEffect("supervisor.retire_agent", revokedAgentSessionId !== null
      ? {
          entry_id: entryId,
          daemon_generation: daemonGeneration,
          revoked_agent_session_id: revokedAgentSessionId,
          grant_revoked_without_worker_session: false as const,
        }
      : {
          entry_id: entryId,
          daemon_generation: daemonGeneration,
          revoked_agent_session_id: null,
          grant_revoked_without_worker_session: grantRevokedWithoutWorkerSession,
        }) as Record<string, unknown>;
    if (result.outcome === "retired") return { outcome: "retired" };
    if (result.outcome === "revocation_required") {
      if (result.revocation_kind === "worker_session"
        && typeof result.agent_session_id === "string" && result.agent_session_id.trim()) {
        return { outcome: "revocation_required", revocationKind: "worker_session", agentSessionId: result.agent_session_id };
      }
      if (result.revocation_kind === "grant_only" && result.agent_session_id === undefined) {
        return { outcome: "revocation_required", revocationKind: "grant_only" };
      }
    }
    if (result.outcome === "invalid" && typeof result.error === "string" && result.error.trim()) {
      return { outcome: "invalid", error: result.error };
    }
    throw new Error("Supervisor returned an invalid retirement result.");
  }

  async purgeAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
    includeCleanupIdentity = false,
  ): Promise<{
    outcome: "purged" | "invalid" | "revocation_required";
    operationId?: string;
    revocationKind?: "worker_session" | "grant_only";
    agentSessionId?: string;
    purgedWorkAttemptId?: string;
    error?: string;
  }> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1
      || !(revokedAgentSessionId === null || nonEmptyString(revokedAgentSessionId))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)
      || typeof grantRevokedWithoutWorkerSession !== "boolean"
      || typeof includeCleanupIdentity !== "boolean") throw new Error("Purge requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.call("supervisor.purge_agent", revokedAgentSessionId !== null
      ? {
          entry_id: entryId,
          daemon_generation: daemonGeneration,
          revoked_agent_session_id: revokedAgentSessionId,
          grant_revoked_without_worker_session: false as const,
        }
      : {
          entry_id: entryId,
          daemon_generation: daemonGeneration,
          revoked_agent_session_id: null,
          grant_revoked_without_worker_session: grantRevokedWithoutWorkerSession,
        }) as Record<string, unknown>;
    if (result.outcome === "purged") {
      return {
        outcome: "purged",
        ...(includeCleanupIdentity && typeof result.purged_work_attempt_id === "string" && result.purged_work_attempt_id.trim()
          ? { purgedWorkAttemptId: result.purged_work_attempt_id }
          : {}),
      };
    }
    if (result.outcome === "revocation_required" && typeof result.operation_id === "string" && result.operation_id.trim()) {
      if (result.revocation_kind === "worker_session"
        && typeof result.agent_session_id === "string" && result.agent_session_id.trim()) {
        return {
          outcome: "revocation_required",
          operationId: result.operation_id,
          revocationKind: "worker_session",
          agentSessionId: result.agent_session_id,
        };
      }
      if (result.revocation_kind === "grant_only" && result.agent_session_id === undefined) {
        return { outcome: "revocation_required", operationId: result.operation_id, revocationKind: "grant_only" };
      }
    }
    if (result.outcome === "invalid" && typeof result.error === "string" && result.error.trim()) return { outcome: "invalid", error: result.error };
    throw new Error("Supervisor returned an invalid purge result.");
  }

  async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.call("manifest.update_workplace_liveness", {
      id,
      state,
      detail,
      observed_at: this.now().toISOString(),
    }));
  }

  /** Main-process only: a secret crosses only the owner-only local socket. */
  async installWorkerCredential(input: {
    entryId: string; roomId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; credential: string;
  }): Promise<"installed" | "stale"> {
    if (!input.credential.trim()) throw new Error("A supervised worker credential is required.");
    const status = await this.ensureRunning();
    const result = await this.call("supervisor.install_worker_credential", {
      entry_id: input.entryId, room_id: input.roomId, work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId, agent_session_id: input.agentSessionId,
      agent_session_token: input.credential, daemon_generation: status.generation,
    });
    if (result.status !== "installed") this.invalidateReadyStatus();
    return result.status === "installed" ? "installed" : "stale";
  }

  /**
   * Main-process-only Open Model credential ingress. The provider key is
   * decrypted by Electron and crosses only the owner-only daemon socket.
   */
  async installOpenModelCredential(input: {
    entryId: string;
    apiKey: string | null;
    baseUrl: string;
    model: string;
    contextWindow?: number | null;
    daemonGeneration: number;
  }): Promise<"installed" | "stale"> {
    if (!input.baseUrl.trim() || !input.model.trim()) {
      throw new Error("An Open Model endpoint and model are required.");
    }
    const status = await this.ensureRunning();
    if (status.generation !== input.daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.call(
      "supervisor.install_open_model_credential",
      {
        entry_id: input.entryId,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        model: input.model,
        ...(input.contextWindow != null ? { context_window: input.contextWindow } : {}),
        daemon_generation: input.daemonGeneration,
      },
    );
    if (result.status !== "installed") this.invalidateReadyStatus();
    return result.status === "installed" ? "installed" : "stale";
  }

  /**
   * Main-process-only grant ingress.  This is deliberately not represented in
   * IPC types: a supervisor bearer may cross only the owner-only Unix socket
   * to the exact daemon generation that will hold it in process memory.
   */
  async installHostGrant(input: {
    entryId: string;
    roomId: string;
    agentKey: string;
    grantId: string;
    supervisorGrant: string;
    grantGeneration: number;
    daemonGeneration: number;
    hostId: string;
    installationId: string;
    ownerAccountId: string | null;
    scopeKey: string | null;
    expiresAt: string;
    apiUrl?: string;
    /** Rebind only an already-live exact provider generation; never converge. */
    credentialOnly?: boolean;
    /** Install owner authority for explicit runtime replacement; never attach or converge. */
    recoveryOnly?: boolean;
  }): Promise<"installed" | "stale" | "provider_unavailable"> {
    if (input.credentialOnly && input.recoveryOnly) {
      throw new Error("Host grant installation cannot be both reconnect-only and recovery-only.");
    }
    if (!input.supervisorGrant.trim()) throw new Error("A supervised host grant is required.");
    const status = await this.ensureRunning();
    // Never let a request started against an old process install into its
    // successor. The daemon independently checks this fence too.
    if (status.generation !== input.daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.callAsyncRpcEffect("supervisor.install_host_grant", {
      entry_id: input.entryId,
      room_id: input.roomId,
      agent_key: input.agentKey,
      grant_id: input.grantId,
      supervisor_grant: input.supervisorGrant,
      grant_generation: input.grantGeneration,
      host_id: input.hostId,
      installation_id: input.installationId,
      owner_account_id: input.ownerAccountId,
      scope_key: input.scopeKey,
      grant_expires_at: input.expiresAt,
      api_url: input.apiUrl ?? apiUrl,
      daemon_generation: input.daemonGeneration,
      credential_only: Boolean(input.credentialOnly),
      ...(input.recoveryOnly ? { recovery_only: true } : {}),
    });
    if (result.status === "installed" || result.status === "provider_unavailable") return result.status;
    this.invalidateReadyStatus();
    return "stale";
  }

  /** Queue exact host-side delegation discovery; no authority crosses IPC. */
  async syncExecutionDelegations(roomId: string): Promise<"queued" | "stale"> {
    const status = await this.ensureRunning();
    const result = await this.call("supervisor.sync_execution_delegations", {
      room_id: roomId,
      daemon_generation: status.generation,
    });
    if (result.status !== "queued") this.invalidateReadyStatus();
    return result.status === "queued" ? "queued" : "stale";
  }

  /** Establish a daemon-inbox entry's one-time durable room boundary. */
  async bootstrapRoomIngress(entryId: string, daemonGeneration: number, initialMessage?: string): Promise<"bootstrapped" | "existing" | "stale"> {
    const status = await this.ensureRunning();
    if (status.generation !== daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.callAsyncRpcEffect("supervisor.bootstrap_room_ingress", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      ...(initialMessage?.trim() ? { initial_message: initialMessage.trim() } : {}),
    });
    if (result.status !== "bootstrapped" && result.status !== "existing") this.invalidateReadyStatus();
    return result.status === "bootstrapped" || result.status === "existing" ? result.status : "stale";
  }
}
