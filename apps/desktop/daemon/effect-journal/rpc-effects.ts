/**
 * Asynchronous RPC effect coordinator backed by the unified `effects` journal
 * and `EffectExecutor`, publishing outcomes through `DaemonStateWatch` and
 * supporting durable lookup (`supervisor.get_rpc_effect`) after watch-cache
 * eviction.
 *
 * Long-running control-socket RPCs (`apply_agent_configuration`,
 * `recover_agent_runtime`, `bootstrap_room_ingress`, `install_host_grant`,
 * `retire_agent`) prepare an effect under the current daemon generation, start
 * execution immediately on `EffectExecutor`, and return `{ effect_id,
 * daemon_generation }` within the short default socket timeout. Outcomes arrive
 * over `manifest.watch_state` (`rpc_effects`), and any caller whose accepted
 * `effect_id` was evicted from the bounded watch cache recovers its durable
 * outcome via `supervisor.get_rpc_effect`.
 *
 * Security invariant: bearer secrets (such as `supervisor_grant` on
 * `supervisor.install_host_grant`) NEVER enter `effects.payload`, SQLite, or
 * `manifest.watch_state`. They reside strictly in process memory for the active
 * invocation and are deleted upon dequeue and on `dispose()`.
 */
import { randomUUID } from "node:crypto";
import {
  DAEMON_ASYNC_RPC_EFFECT_KINDS,
  type DaemonAsyncRpcAccepted,
  type DaemonAsyncRpcEffectKind,
  type DaemonManifestEntryView,
  type DaemonRpcEffectView,
  type JsonValue,
} from "#daemon-contract/index.js";
import { DaemonFenceLostError } from "../singleton.js";
import { projectStateWatchEntries } from "../state-watch-projection.js";
import type { EffectExecutor } from "./executor.js";
import {
  EffectFenceError,
  EffectValidationError,
  MAX_EFFECT_AGENT_ID_LENGTH,
  MAX_EFFECT_OUTCOME_BYTES,
  truncateEffectError,
  type EffectHandler,
  type EffectRecord,
} from "./types.js";

export const ASYNC_RPC_EFFECT_KINDS: readonly DaemonAsyncRpcEffectKind[] = DAEMON_ASYNC_RPC_EFFECT_KINDS;

const ASYNC_RPC_EFFECT_KIND_SET = new Set<string>(ASYNC_RPC_EFFECT_KINDS);

export function isAsyncRpcEffectKind(kind: string): kind is DaemonAsyncRpcEffectKind {
  return ASYNC_RPC_EFFECT_KIND_SET.has(kind);
}

/** Maximum number of settled RPC effects retained per daemon generation in state watch. */
export const MAX_RETAINED_SETTLED_RPC_EFFECTS = 256;

const INVALID_AGENT_PLACEHOLDER = "__invalid_entry__";

/**
 * Explicit error marker for provable pre-execution/domain refusals where no
 * external side effect was started. Unmarked throws after execution begins
 * fail closed as `uncertain` so callers never receive a false `failed` claim.
 */
export class AsyncRpcPreExecutionRefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AsyncRpcPreExecutionRefusalError";
  }
}

function isTerminalEffectState(state: EffectRecord["state"]): boolean {
  return state === "completed" || state === "failed" || state === "uncertain";
}

function sanitizeEffectAgentId(raw: string): string {
  if (
    typeof raw === "string"
    && raw.length >= 1
    && raw.length <= MAX_EFFECT_AGENT_ID_LENGTH
    && raw.trim() === raw
    && !/[\x00-\x1f\x7f]/.test(raw)
  ) {
    return raw;
  }
  return INVALID_AGENT_PLACEHOLDER;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUncertainExecutionError(detail: string): string {
  if (/uncertain|verify (?:external )?state/i.test(detail)) return detail;
  return `${detail} (Outcome is uncertain; verify external state before repeating it.)`;
}

async function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return { aborted: true };
  }
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<{ aborted: true }>((resolve) => {
    onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      operation.then((value) => ({ aborted: false as const, value })),
      abortPromise,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (signal.aborted) void operation.catch(() => undefined);
  }
}

function boundOutcomeForJournal(raw: unknown): unknown {
  if (raw === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return raw;
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") <= MAX_EFFECT_OUTCOME_BYTES) {
    return raw;
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.entry && typeof record.entry === "object" && !Array.isArray(record.entry)) {
      const projected = projectStateWatchEntries([record.entry as DaemonManifestEntryView])[0];
      return { ...record, entry: projected };
    }
  }
  return raw;
}

function effectRecordToView(effect: EffectRecord): DaemonRpcEffectView {
  return {
    effect_id: effect.id,
    agent_id: effect.agent_id,
    kind: effect.kind as DaemonAsyncRpcEffectKind,
    daemon_generation: effect.epoch,
    state: effect.state,
    ...(effect.state === "completed" ? { result: (effect.outcome ?? null) as JsonValue | null } : {}),
    ...(effect.state === "failed" || effect.state === "uncertain"
      ? { error: effect.last_error ?? null }
      : {}),
    updated_at: effect.updated_at,
  };
}

type PendingRpcInvocation = {
  run: (signal: AbortSignal) => Promise<unknown>;
  isPreExecutionRefusal?: (error: unknown) => boolean;
};

type ExecutionProgress = {
  phase: "pending" | "executing" | "completed_in_memory" | "failed_in_memory" | "uncertain_in_memory";
  executionError?: string;
};

export type AsyncRpcEffectCoordinatorOptions = {
  getExecutor: () => EffectExecutor | null;
  getEffect?: (effectId: string) => EffectRecord | null;
  notifyImmediate: () => void;
  nowIso?: () => string;
  maxRetainedSettled?: number;
};

export class AsyncRpcEffectCoordinator {
  private readonly pending = new Map<string, PendingRpcInvocation>();
  private readonly progressById = new Map<string, ExecutionProgress>();
  private readonly viewsByGeneration = new Map<number, Map<string, DaemonRpcEffectView>>();
  private readonly settledOrderByGeneration = new Map<number, string[]>();
  private readonly unrecordedTerminalByGeneration = new Map<number, Map<string, DaemonRpcEffectView>>();
  private readonly unrecordedOrderByGeneration = new Map<number, string[]>();
  private readonly evictionVersionByGeneration = new Map<number, number>();
  private readonly maxRetainedSettled: number;
  private disposed = false;

  constructor(private readonly options: AsyncRpcEffectCoordinatorOptions) {
    this.maxRetainedSettled = Math.max(1, options.maxRetainedSettled ?? MAX_RETAINED_SETTLED_RPC_EFFECTS);
  }

  /** Registers non-retryable, on-demand handlers for all 5 async RPC effect kinds. */
  registerHandlers(executor: EffectExecutor): void {
    const handler: EffectHandler = {
      retryable: false,
      autoPump: false,
      defaultMaxAttempts: 1,
      execute: async (claimed, ctx) => {
        const invocation = this.pending.get(claimed.id);
        this.pending.delete(claimed.id);
        const progress = this.progressById.get(claimed.id) ?? { phase: "executing" as const };
        progress.phase = "executing";
        this.progressById.set(claimed.id, progress);
        if (!invocation) {
          const detail = "The RPC effect invocation is no longer resident in this daemon generation.";
          progress.phase = "failed_in_memory";
          progress.executionError = detail;
          return {
            status: "failed",
            error: detail,
          };
        }
        try {
          const raced = await raceWithAbortSignal(invocation.run(ctx.signal), ctx.signal);
          if (raced.aborted) {
            const detail = "Daemon stopped or handed off while this operation was in flight.";
            progress.phase = "uncertain_in_memory";
            progress.executionError = detail;
            return {
              status: "uncertain",
              error: detail,
            };
          }
          progress.phase = "completed_in_memory";
          return {
            status: "completed",
            outcome: boundOutcomeForJournal(raced.value),
          };
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) {
            progress.phase = "uncertain_in_memory";
            progress.executionError = errorMessage(error);
            throw error;
          }
          if (ctx.signal.aborted) {
            const detail = "Daemon stopped or handed off while this operation was in flight.";
            progress.phase = "uncertain_in_memory";
            progress.executionError = detail;
            return {
              status: "uncertain",
              error: detail,
            };
          }
          const rawDetail = errorMessage(error);
          if (
            error instanceof AsyncRpcPreExecutionRefusalError
            || error instanceof EffectValidationError
            || invocation.isPreExecutionRefusal?.(error) === true
          ) {
            progress.phase = "failed_in_memory";
            progress.executionError = rawDetail;
            return {
              status: "failed",
              error: rawDetail,
            };
          }
          const detail = formatUncertainExecutionError(rawDetail);
          progress.phase = "uncertain_in_memory";
          progress.executionError = detail;
          return {
            status: "uncertain",
            error: detail,
          };
        } finally {
          // Immediately clear any in-memory invocation closure (including any
          // secret bearer captured for `rpc_install_host_grant`).
          this.pending.delete(claimed.id);
        }
      },
      settle: async (claimed, _result, defaultSettle) => {
        const settled = defaultSettle();
        this.progressById.delete(claimed.id);
        this.recordView(effectRecordToView(settled));
        this.options.notifyImmediate();
        return settled;
      },
    };
    for (const kind of ASYNC_RPC_EFFECT_KINDS) {
      executor.registerHandler(kind, handler);
    }
  }

  /**
   * Prepares an async RPC effect in the unified `effects` journal, kicks off
   * execution on `EffectExecutor`, and returns `{ effect_id, daemon_generation }`
   * immediately without blocking the caller for external I/O.
   */
  async submit<TResult>(input: {
    kind: DaemonAsyncRpcEffectKind;
    agentId: string;
    payload: Record<string, unknown>;
    run: (signal: AbortSignal) => Promise<TResult>;
    isPreExecutionRefusal?: (error: unknown) => boolean;
  }): Promise<DaemonAsyncRpcAccepted> {
    if (this.disposed) {
      throw new EffectFenceError("Supervisor daemon is shutting down.");
    }
    const executor = this.options.getExecutor();
    if (!executor || executor.isFenced) {
      throw new EffectFenceError("Supervisor daemon effect executor is unavailable.");
    }
    const effectId = `rpc:${input.kind}:${randomUUID()}`;
    const safeAgentId = sanitizeEffectAgentId(input.agentId);
    this.pending.set(effectId, {
      run: input.run,
      ...(input.isPreExecutionRefusal ? { isPreExecutionRefusal: input.isPreExecutionRefusal } : {}),
    });
    this.progressById.set(effectId, { phase: "pending" });
    let prepared: EffectRecord;
    try {
      prepared = (await executor.prepare({
        id: effectId,
        agent_id: safeAgentId,
        kind: input.kind,
        idempotency_key: effectId,
        payload: input.payload,
        retryable: false,
        max_attempts: 1,
      })).effect;
    } catch (error) {
      this.pending.delete(effectId);
      this.progressById.delete(effectId);
      throw error;
    }
    this.recordView(effectRecordToView(prepared));
    void executor.runEffect(prepared.id).then(
      (settled) => {
        this.progressById.delete(settled.id);
        const existing = this.viewsByGeneration.get(settled.epoch)?.get(settled.id);
        if (!existing || existing.state !== settled.state) {
          this.recordView(effectRecordToView(settled));
          this.options.notifyImmediate();
        }
      },
      (error) => {
        this.pending.delete(prepared.id);
        const progress = this.progressById.get(prepared.id);
        this.progressById.delete(prepared.id);
        const durable = this.safeGetDurableEffect(prepared.id);
        if (durable && isTerminalEffectState(durable.state)) {
          this.recordView(effectRecordToView(durable));
          this.options.notifyImmediate();
          return;
        }
        const rejectionDetail = errorMessage(error);
        const nowIso = this.options.nowIso?.() ?? new Date().toISOString();
        const started = (progress !== undefined && progress.phase !== "pending")
          || (durable !== null && (durable.state === "executing" || durable.attempt_count >= 1));
        if (!started) {
          this.recordUnrecordedTerminalView({
            effect_id: prepared.id,
            agent_id: prepared.agent_id,
            kind: prepared.kind as DaemonAsyncRpcEffectKind,
            daemon_generation: prepared.epoch,
            state: "failed",
            error: truncateEffectError(
              `Operation did not start before error (not recorded in effect journal): ${rejectionDetail}`,
            ),
            updated_at: nowIso,
          });
          this.options.notifyImmediate();
          return;
        }
        if (progress?.phase === "failed_in_memory") {
          const base = progress.executionError ?? rejectionDetail;
          this.recordUnrecordedTerminalView({
            effect_id: prepared.id,
            agent_id: prepared.agent_id,
            kind: prepared.kind as DaemonAsyncRpcEffectKind,
            daemon_generation: prepared.epoch,
            state: "failed",
            error: truncateEffectError(
              `${base} (Failure receipt could not be recorded in the effect journal: ${rejectionDetail}.)`,
            ),
            updated_at: nowIso,
          });
          this.options.notifyImmediate();
          return;
        }
        const uncertainError = progress?.phase === "completed_in_memory"
          ? `Action completed in memory, but its receipt could not be recorded in the effect journal (${rejectionDetail}); verify external state before repeating it.`
          : progress?.phase === "uncertain_in_memory"
            ? `${progress.executionError ?? rejectionDetail} (Outcome is uncertain and could not be recorded in the effect journal: ${rejectionDetail}; verify external state before repeating it.)`
            : `Outcome is uncertain: execution started, but its receipt could not be recorded in the effect journal (${rejectionDetail}); verify external state before repeating it.`;
        this.recordUnrecordedTerminalView({
          effect_id: prepared.id,
          agent_id: prepared.agent_id,
          kind: prepared.kind as DaemonAsyncRpcEffectKind,
          daemon_generation: prepared.epoch,
          state: "uncertain",
          error: truncateEffectError(uncertainError),
          updated_at: nowIso,
        });
        this.options.notifyImmediate();
      },
    );
    return {
      effect_id: prepared.id,
      daemon_generation: prepared.epoch,
    };
  }

  submitApplyAgentConfiguration<TResult>(
    input: { entryId: string; daemonGeneration: number; expectedConfigurationRevision: number },
    run: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<DaemonAsyncRpcAccepted> {
    return this.submit({
      kind: "rpc_apply_agent_configuration",
      agentId: input.entryId,
      payload: {
        method: "supervisor.apply_agent_configuration",
        entry_id: input.entryId,
        daemon_generation: input.daemonGeneration,
        expected_configuration_revision: input.expectedConfigurationRevision,
      },
      run,
    });
  }

  submitBootstrapRoomIngress<TResult>(
    input: { entry_id: string; daemon_generation: number; initial_message?: string },
    run: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<DaemonAsyncRpcAccepted> {
    return this.submit({
      kind: "rpc_bootstrap_room_ingress",
      agentId: input.entry_id,
      payload: {
        method: "supervisor.bootstrap_room_ingress",
        entry_id: input.entry_id,
        daemon_generation: input.daemon_generation,
        has_initial_message: input.initial_message !== undefined,
      },
      run,
    });
  }

  /**
   * Projects only non-secret grant coordinates into `effects.payload`; the
   * `supervisor_grant` bearer remains solely inside the transient `run` closure.
   */
  submitInstallHostGrant<TResult>(
    input: {
      entry_id: string;
      room_id: string;
      grant_id: string;
      grant_generation: number;
      daemon_generation: number;
      credential_only: boolean;
      recovery_only: boolean;
    },
    run: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<DaemonAsyncRpcAccepted> {
    return this.submit({
      kind: "rpc_install_host_grant",
      agentId: input.entry_id,
      payload: {
        method: "supervisor.install_host_grant",
        entry_id: input.entry_id,
        room_id: input.room_id,
        grant_id: input.grant_id,
        grant_generation: input.grant_generation,
        daemon_generation: input.daemon_generation,
        credential_only: input.credential_only,
        recovery_only: input.recovery_only,
      },
      run,
    });
  }

  submitRecoverAgentRuntime<TResult>(
    input: { entryId: string; daemonGeneration: number; mode?: string; operationId?: string },
    run: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<DaemonAsyncRpcAccepted> {
    return this.submit({
      kind: "rpc_recover_agent_runtime",
      agentId: input.entryId,
      payload: {
        method: "supervisor.recover_agent_runtime",
        entry_id: input.entryId,
        daemon_generation: input.daemonGeneration,
        ...(input.mode ? { mode: input.mode, operation_id: input.operationId } : {}),
      },
      run,
    });
  }

  submitRetireAgent<TResult>(
    input: {
      entryId: string;
      daemonGeneration: number;
      hasRevokedAgentSessionId: boolean;
      grantRevokedWithoutWorkerSession: boolean;
    },
    run: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<DaemonAsyncRpcAccepted> {
    return this.submit({
      kind: "rpc_retire_agent",
      agentId: input.entryId,
      payload: {
        method: "supervisor.retire_agent",
        entry_id: input.entryId,
        daemon_generation: input.daemonGeneration,
        has_revoked_agent_session_id: input.hasRevokedAgentSessionId,
        grant_revoked_without_worker_session: input.grantRevokedWithoutWorkerSession,
      },
      run,
    });
  }

  /** Returns tracked async RPC effect views for the requested daemon generation. */
  listForGeneration(generation: number): DaemonRpcEffectView[] {
    const map = this.viewsByGeneration.get(generation);
    if (!map || map.size === 0) return [];
    return [...map.values()].map((view) => ({ ...view }));
  }

  /**
   * Monotonic counter incremented whenever settled RPC effects are evicted from
   * `listForGeneration(generation)`. `DaemonStateWatch` uses this to force a
   * full snapshot for delta subscribers that straddled an eviction.
   */
  evictionVersion(generation: number): number {
    return this.evictionVersionByGeneration.get(generation) ?? 0;
  }

  /**
   * Bounded, durable lookup for an accepted async RPC effect in `generation`.
   * Checks the live in-memory projection and unrecorded-terminal map first
   * (preserving exact unrecorded uncertainty/failure guidance even after watch
   * cache eviction), then falls back to the durable SQLite `effects` table. If
   * SQLite still holds a non-terminal row (`prepared`/`executing`) with no
   * remaining active execution in this generation, synthesizes a truthful
   * terminal `uncertain`/`failed` view instead of advertising indefinite work.
   */
  getForGeneration(effectId: string, generation: number): DaemonRpcEffectView | null {
    const inMemory = this.viewsByGeneration.get(generation)?.get(effectId);
    if (inMemory) return { ...inMemory };
    const unrecorded = this.unrecordedTerminalByGeneration.get(generation)?.get(effectId);
    if (unrecorded) return { ...unrecorded };
    const durable = this.safeGetDurableEffect(effectId);
    if (!durable || !isAsyncRpcEffectKind(durable.kind) || durable.epoch !== generation) {
      return null;
    }
    if (!isTerminalEffectState(durable.state) && !this.isEffectActiveInMemory(effectId)) {
      const started = durable.state === "executing" || durable.attempt_count >= 1;
      if (started) {
        return {
          effect_id: durable.id,
          agent_id: durable.agent_id,
          kind: durable.kind,
          daemon_generation: durable.epoch,
          state: "uncertain",
          error: "Outcome is uncertain: execution ended in this daemon generation, but its receipt could not be recorded in the effect journal; verify external state before repeating it.",
          updated_at: durable.updated_at,
        };
      }
      return {
        effect_id: durable.id,
        agent_id: durable.agent_id,
        kind: durable.kind,
        daemon_generation: durable.epoch,
        state: "failed",
        error: "Operation did not start in this daemon generation and no failure receipt was recorded in the effect journal.",
        updated_at: durable.updated_at,
      };
    }
    return effectRecordToView(durable);
  }

  /** Wipes all queued in-memory invocations (and any secret closures) on shutdown/handoff. */
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
  }

  private isEffectActiveInMemory(effectId: string): boolean {
    return this.pending.has(effectId)
      || this.progressById.has(effectId)
      || this.options.getExecutor()?.isEffectActive(effectId) === true;
  }

  private safeGetDurableEffect(effectId: string): EffectRecord | null {
    try {
      if (this.options.getEffect) return this.options.getEffect(effectId);
      return this.options.getExecutor()?.getEffect(effectId) ?? null;
    } catch {
      return null;
    }
  }

  private recordUnrecordedTerminalView(view: DaemonRpcEffectView): void {
    this.recordView(view);
    const generation = view.daemon_generation;
    let byId = this.unrecordedTerminalByGeneration.get(generation);
    if (!byId) {
      for (const oldGeneration of this.unrecordedTerminalByGeneration.keys()) {
        if (oldGeneration < generation) {
          this.unrecordedTerminalByGeneration.delete(oldGeneration);
          this.unrecordedOrderByGeneration.delete(oldGeneration);
        }
      }
      byId = new Map();
      this.unrecordedTerminalByGeneration.set(generation, byId);
    }
    const alreadyPresent = byId.has(view.effect_id);
    byId.set(view.effect_id, view);
    if (!alreadyPresent) {
      let order = this.unrecordedOrderByGeneration.get(generation);
      if (!order) {
        order = [];
        this.unrecordedOrderByGeneration.set(generation, order);
      }
      order.push(view.effect_id);
      while (order.length > this.maxRetainedSettled) {
        const evicted = order.shift();
        if (evicted) byId.delete(evicted);
      }
    }
  }

  private recordView(view: DaemonRpcEffectView): void {
    const generation = view.daemon_generation;
    let byId = this.viewsByGeneration.get(generation);
    if (!byId) {
      // Prune older generations as soon as a new generation writes.
      for (const oldGeneration of this.viewsByGeneration.keys()) {
        if (oldGeneration < generation) {
          this.viewsByGeneration.delete(oldGeneration);
          this.settledOrderByGeneration.delete(oldGeneration);
          this.unrecordedTerminalByGeneration.delete(oldGeneration);
          this.unrecordedOrderByGeneration.delete(oldGeneration);
          this.evictionVersionByGeneration.delete(oldGeneration);
        }
      }
      byId = new Map();
      this.viewsByGeneration.set(generation, byId);
    }
    const previous = byId.get(view.effect_id);
    byId.set(view.effect_id, view);

    const terminal = isTerminalEffectState(view.state);
    const wasTerminal = previous !== undefined && isTerminalEffectState(previous.state);
    if (terminal && !wasTerminal) {
      let settledOrder = this.settledOrderByGeneration.get(generation);
      if (!settledOrder) {
        settledOrder = [];
        this.settledOrderByGeneration.set(generation, settledOrder);
      }
      settledOrder.push(view.effect_id);
      while (settledOrder.length > this.maxRetainedSettled) {
        const evicted = settledOrder.shift();
        if (evicted) {
          byId.delete(evicted);
          this.evictionVersionByGeneration.set(
            generation,
            (this.evictionVersionByGeneration.get(generation) ?? 0) + 1,
          );
        }
      }
    }
  }
}
