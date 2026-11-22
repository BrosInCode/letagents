/**
 * Asynchronous RPC effect coordinator backed by the unified `effects` journal
 * and `EffectExecutor`, publishing outcomes through `DaemonStateWatch`.
 *
 * Long-running control-socket RPCs (`apply_agent_configuration`,
 * `recover_agent_runtime`, `bootstrap_room_ingress`, `install_host_grant`,
 * `retire_agent`) prepare an effect under the current daemon generation, start
 * execution immediately on `EffectExecutor`, and return `{ effect_id,
 * daemon_generation }` within the short default socket timeout. Outcomes arrive
 * over `manifest.watch_state` (`rpc_effects`).
 *
 * Security invariant: bearer secrets (such as `supervisor_grant` on
 * `supervisor.install_host_grant`) NEVER enter `effects.payload`, SQLite, or
 * `manifest.watch_state`. They reside strictly in process memory for the active
 * invocation and are deleted in `finally` and on `dispose()`.
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
};

export type AsyncRpcEffectCoordinatorOptions = {
  getExecutor: () => EffectExecutor | null;
  notifyImmediate: () => void;
  nowIso?: () => string;
  maxRetainedSettled?: number;
};

export class AsyncRpcEffectCoordinator {
  private readonly pending = new Map<string, PendingRpcInvocation>();
  private readonly viewsByGeneration = new Map<number, Map<string, DaemonRpcEffectView>>();
  private readonly settledOrderByGeneration = new Map<number, string[]>();
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
        if (!invocation) {
          return {
            status: "failed",
            error: "The RPC effect invocation is no longer resident in this daemon generation.",
          };
        }
        try {
          const raced = await raceWithAbortSignal(invocation.run(ctx.signal), ctx.signal);
          if (raced.aborted) {
            return {
              status: "uncertain",
              error: "Daemon stopped or handed off while this operation was in flight.",
            };
          }
          return {
            status: "completed",
            outcome: boundOutcomeForJournal(raced.value),
          };
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) {
            throw error;
          }
          if (ctx.signal.aborted) {
            return {
              status: "uncertain",
              error: "Daemon stopped or handed off while this operation was in flight.",
            };
          }
          return {
            status: "failed",
            error: errorMessage(error),
          };
        } finally {
          // Immediately clear any in-memory invocation closure (including any
          // secret bearer captured for `rpc_install_host_grant`).
          this.pending.delete(claimed.id);
        }
      },
      settle: async (_claimed, _result, defaultSettle) => {
        const settled = defaultSettle();
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
    this.pending.set(effectId, { run: input.run });
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
      throw error;
    }
    this.recordView(effectRecordToView(prepared));
    void executor.runEffect(prepared.id).then(
      (settled) => {
        const existing = this.viewsByGeneration.get(settled.epoch)?.get(settled.id);
        if (!existing || existing.state !== settled.state) {
          this.recordView(effectRecordToView(settled));
          this.options.notifyImmediate();
        }
      },
      (error) => {
        this.pending.delete(prepared.id);
        this.recordView({
          effect_id: prepared.id,
          agent_id: prepared.agent_id,
          kind: prepared.kind as DaemonAsyncRpcEffectKind,
          daemon_generation: prepared.epoch,
          state: "failed",
          error: truncateEffectError(errorMessage(error)),
          updated_at: this.options.nowIso?.() ?? new Date().toISOString(),
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

  /** Wipes all queued in-memory invocations (and any secret closures) on shutdown/handoff. */
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
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
        }
      }
      byId = new Map();
      this.viewsByGeneration.set(generation, byId);
    }
    const previous = byId.get(view.effect_id);
    byId.set(view.effect_id, view);

    const terminal = view.state === "completed" || view.state === "failed" || view.state === "uncertain";
    const wasTerminal = previous !== undefined
      && (previous.state === "completed" || previous.state === "failed" || previous.state === "uncertain");
    if (terminal && !wasTerminal) {
      let settledOrder = this.settledOrderByGeneration.get(generation);
      if (!settledOrder) {
        settledOrder = [];
        this.settledOrderByGeneration.set(generation, settledOrder);
      }
      settledOrder.push(view.effect_id);
      while (settledOrder.length > this.maxRetainedSettled) {
        const evicted = settledOrder.shift();
        if (evicted) byId.delete(evicted);
      }
    }
  }
}
