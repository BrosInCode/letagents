/**
 * Single process-wide executor for durable outbound effects.
 *
 * Owns:
 * - Generation fencing (both process singleton fence inside SQLite transactions
 *   and per-effect monotonic `(epoch, attempt_count)` compare-and-swap)
 * - Retry and exponential backoff scheduling
 * - Startup recovery pass (`recoverOnStartup`)
 * - Synchronous fence and async in-flight drain on shutdown and handoff
 */
import type { DatabaseSync } from "node:sqlite";
import { DaemonFenceLostError } from "../singleton.js";
import {
  claimEffectForExecution,
  completeEffect,
  failEffect,
  getEffect,
  listDuePreparedEffects,
  markEffectUncertain,
  nextScheduledPreparedEffectAtMs,
  prepareEffect,
  quarantinePreparedRetryAsUncertain,
  recoverInterruptedEffectsOnStartup,
  rescheduleEffectForRetry,
  resolveUncertainEffect,
} from "./store.js";
import {
  EffectClaimRefusedError,
  EffectFenceError,
  EffectValidationError,
  type EffectBackoffPolicy,
  type EffectExecutionResult,
  type EffectHandler,
  type EffectRecord,
  type EffectStartupRecoveryReport,
  type PrepareEffectInput,
  type PrepareEffectResult,
} from "./types.js";

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const MIN_PRE_CLAIM_ERROR_BACKOFF_MS = 25;

export type EffectExecutorOptions = {
  getDatabase: () => DatabaseSync | null;
  currentDaemonGeneration: () => number;
  assertCurrent: () => Promise<void>;
  assertWriteFence: () => void;
  isClosing: () => boolean;
  notifyStateChanged?: () => void;
  nowMs?: () => number;
  nowIso?: () => string;
  defaultBackoff?: EffectBackoffPolicy;
};

export function computeEffectBackoffMs(
  attemptCount: number,
  handlerPolicy?: EffectBackoffPolicy,
  defaultPolicy?: EffectBackoffPolicy,
): number {
  const base = handlerPolicy?.baseDelayMs ?? defaultPolicy?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = handlerPolicy?.maxDelayMs ?? defaultPolicy?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = handlerPolicy?.factor ?? defaultPolicy?.factor ?? DEFAULT_BACKOFF_FACTOR;
  const safeBase = Math.max(0, base);
  const safeMax = Math.max(safeBase, max);
  const safeFactor = Math.max(1, factor);
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(safeMax, Math.round(safeBase * (safeFactor ** Math.min(exponent, 20))));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Single process-wide external-effect executor.
 *
 * Concurrency: each pump pass runs up to 64 due effects concurrently across
 * registered kinds and agents. Features that require strict per-agent ordering
 * must gate effect admission in domain state or add explicit per-agent/per-kind
 * serialization when migrating onto the executor.
 */
export class EffectExecutor {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly activeById = new Map<string, Promise<EffectRecord>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly abortController = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private timerDueMs = Infinity;
  private fenced = false;
  private activePump: Promise<void> | null = null;
  private pumpAgain = false;
  private consecutivePumpErrors = 0;

  constructor(private readonly options: EffectExecutorOptions) {}

  registerHandler(kind: string, handler: EffectHandler): void {
    if (!kind.trim()) throw new EffectValidationError("Effect handler kind must be non-empty.");
    if (this.handlers.has(kind)) {
      throw new EffectValidationError(`Effect handler for kind ${kind} is already registered.`);
    }
    if (typeof handler.retryable !== "boolean") {
      throw new EffectValidationError(`Effect handler for kind ${kind} must explicitly declare retryable: boolean.`);
    }
    if (handler.autoPump !== undefined && typeof handler.autoPump !== "boolean") {
      throw new EffectValidationError(`Effect handler for kind ${kind} must use a boolean autoPump option when provided.`);
    }
    if (handler.defaultMaxAttempts !== undefined) {
      if (!Number.isSafeInteger(handler.defaultMaxAttempts) || handler.defaultMaxAttempts < 1) {
        throw new EffectValidationError(`Effect handler for kind ${kind} must use a positive safe integer defaultMaxAttempts.`);
      }
      if (!handler.retryable && handler.defaultMaxAttempts !== 1) {
        throw new EffectValidationError(`Non-retryable effect handler for kind ${kind} must have defaultMaxAttempts = 1.`);
      }
    }
    this.handlers.set(kind, handler);
  }

  hasHandler(kind: string): boolean {
    return this.handlers.has(kind);
  }

  get isFenced(): boolean {
    return this.fenced || this.options.isClosing();
  }

  /** Prepares a durable outbound effect under the current daemon generation. */
  async prepare(
    input: Omit<PrepareEffectInput, "epoch"> & { epoch?: number },
  ): Promise<PrepareEffectResult> {
    this.assertNotFenced();
    await this.assertAuthority();
    this.assertNotFenced();
    const database = this.requireDatabase();
    const generation = this.runFencedWrite(() => this.options.currentDaemonGeneration());
    if (input.epoch !== undefined && input.epoch !== generation) {
      throw new EffectFenceError(
        `Effect prepare generation mismatch: requested ${input.epoch}, current ${generation}.`,
      );
    }
    const handler = this.handlers.get(input.kind);
    if (handler && !handler.retryable && input.retryable === true) {
      throw new EffectValidationError(
        `Effect kind ${input.kind} is registered as non-retryable (at-most-once) and cannot be prepared with retryable=true.`,
      );
    }
    const resolvedRetryable = input.retryable ?? handler?.retryable ?? false;
    const resolvedMaxAttempts = input.max_attempts
      ?? (resolvedRetryable ? (handler?.defaultMaxAttempts ?? 3) : 1);
    const prepared = this.runFencedWrite(() => prepareEffect(
      database,
      this.options.assertWriteFence,
      {
        ...input,
        epoch: generation,
        retryable: resolvedRetryable,
        max_attempts: resolvedMaxAttempts,
      },
      this.nowIso(),
    ));
    if (prepared.created) {
      this.options.notifyStateChanged?.();
    }
    return prepared;
  }

  /**
   * Prepares an outbound effect and kicks off asynchronous execution on the
   * executor without blocking the caller for external I/O. Intended for long
   * RPCs that return an `effect_id` immediately and deliver outcomes via watch.
   */
  async enqueue(
    input: Omit<PrepareEffectInput, "epoch"> & { epoch?: number },
  ): Promise<PrepareEffectResult> {
    const prepared = await this.prepare(input);
    const handler = this.handlers.get(prepared.effect.kind);
    if (prepared.effect.state === "prepared" && handler && handler.autoPump !== false) {
      this.schedulePump(0);
    }
    return prepared;
  }

  /**
   * Runs startup crash recovery for interrupted effects, then schedules the
   * pump for any runnable `prepared` effects whose kind enables `autoPump`.
   */
  async recoverOnStartup(): Promise<EffectStartupRecoveryReport> {
    this.assertNotFenced();
    await this.assertAuthority();
    this.assertNotFenced();
    const database = this.requireDatabase();
    const nonRetryableKinds = [...this.handlers.entries()]
      .filter(([, handler]) => !handler.retryable)
      .map(([kind]) => kind);
    const report = this.runFencedWrite(() => recoverInterruptedEffectsOnStartup(database, this.options.assertWriteFence, {
      daemonGeneration: this.options.currentDaemonGeneration(),
      nowMs: this.nowMs(),
      nowIso: this.nowIso(),
      nonRetryableKinds,
    }));
    if (report.requeuedIds.length > 0
      || report.uncertainIds.length > 0
      || report.fencedFutureEpochIds.length > 0
      || report.fencedOrphanPreparedIds.length > 0) {
      this.options.notifyStateChanged?.();
    }
    if (this.autoPumpKinds().length > 0 && report.preparedIds.length > 0) {
      this.scheduleNextPump();
    }
    return report;
  }

  /** Runs a single prepared effect to its next durable state, sharing any in-flight run. */
  runEffect(effectId: string): Promise<EffectRecord> {
    const existing = this.activeById.get(effectId);
    if (existing) return existing;
    this.assertNotFenced();
    const promise = this.trackInFlight(effectId, () => this.executeEffect(effectId));
    return promise;
  }

  /**
   * Runs a handler's read-only `reconcileUncertain` probe for one `uncertain`
   * effect and settles it to `completed` or `failed` if externally confirmed.
   */
  reconcileUncertain(effectId: string): Promise<EffectRecord> {
    const existing = this.activeById.get(effectId);
    if (existing) return existing;
    this.assertNotFenced();
    return this.trackInFlight(effectId, () => this.reconcileUncertainInternal(effectId));
  }

  /** Cancels a `prepared` effect before external execution begins. */
  async cancelPrepared(effectId: string, error: string): Promise<EffectRecord> {
    this.assertNotFenced();
    await this.assertAuthority();
    this.assertNotFenced();
    const database = this.requireDatabase();
    const settled = this.runFencedWrite(() => failEffect(database, this.options.assertWriteFence, {
      id: effectId,
      expectedEpoch: this.options.currentDaemonGeneration(),
      error,
      nowIso: this.nowIso(),
    }));
    this.options.notifyStateChanged?.();
    return settled;
  }

  /** Drains all currently due `prepared` effects for registered auto-pumped kinds. */
  async pumpNow(): Promise<void> {
    if (this.isFenced || this.autoPumpKinds().length === 0) return;
    if (this.activePump) {
      this.pumpAgain = true;
      await this.activePump;
      return;
    }
    let active!: Promise<void>;
    active = Promise.resolve()
      .then(async () => {
        do {
          this.pumpAgain = false;
          if (this.isFenced) break;
          const database = this.options.getDatabase();
          if (!database || !database.isOpen) break;
          const maxEpoch = this.safeCurrentGeneration();
          if (maxEpoch === null) break;
          const kinds = this.autoPumpKinds();
          if (kinds.length === 0) break;
          const runnable = listDuePreparedEffects(database, this.nowMs(), kinds, 64, {
            excludeIds: [...this.activeById.keys()],
            maxEpoch,
          });
          if (runnable.length === 0) break;
          const settled = await Promise.allSettled(runnable.map((effect) => this.runEffect(effect.id)));
          let fulfilledCount = 0;
          let rejectedCount = 0;
          let lostAuthority = false;
          for (const outcome of settled) {
            if (outcome.status === "fulfilled") {
              fulfilledCount += 1;
            } else {
              rejectedCount += 1;
              if (outcome.reason instanceof DaemonFenceLostError) lostAuthority = true;
            }
          }
          if (lostAuthority) {
            this.fence();
            break;
          }
          if (fulfilledCount > 0) {
            this.consecutivePumpErrors = 0;
          } else if (rejectedCount > 0) {
            // Every due row failed before claiming (zero durable progress). Yield to
            // the event loop with a bounded backoff timer instead of spinning.
            this.consecutivePumpErrors += 1;
            this.pumpAgain = false;
            break;
          }
        } while (this.pumpAgain && !this.isFenced);
      })
      .finally(() => {
        if (this.activePump === active) this.activePump = null;
        if (!this.isFenced) this.scheduleNextPump();
      });
    this.activePump = active;
    await active;
  }

  /**
   * Synchronous handoff/shutdown edge: prevents any new effect admission,
   * clears retry timers, and aborts the cancellation signal for in-flight work.
   */
  fence(): void {
    if (this.fenced) return;
    this.fenced = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.timerDueMs = Infinity;
    }
    if (this.immediate) {
      clearImmediate(this.immediate);
      this.immediate = null;
    }
    this.abortController.abort(new EffectFenceError("Effect executor fenced for shutdown or handoff."));
  }

  /** Fences new work synchronously and waits for all admitted executions to settle. */
  async fenceAndDrain(): Promise<void> {
    this.fence();
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date(this.nowMs()).toISOString();
  }

  private assertNotFenced(): void {
    if (this.isFenced) {
      throw new EffectFenceError("Effect executor is fenced for shutdown or handoff.");
    }
  }

  private safeCurrentGeneration(): number | null {
    try {
      return this.options.currentDaemonGeneration();
    } catch (error) {
      if (error instanceof DaemonFenceLostError) {
        this.fence();
        return null;
      }
      throw error;
    }
  }

  private async assertAuthority(): Promise<void> {
    try {
      await this.options.assertCurrent();
    } catch (error) {
      if (error instanceof DaemonFenceLostError) this.fence();
      throw error;
    }
  }

  private requireDatabase(): DatabaseSync {
    const database = this.options.getDatabase();
    if (!database || !database.isOpen) {
      throw new EffectFenceError("Daemon state database is unavailable for effect execution.");
    }
    return database;
  }

  private trackInFlight(effectId: string, run: () => Promise<EffectRecord>): Promise<EffectRecord> {
    let release!: () => void;
    let settledWithoutError = false;
    const tracker = new Promise<void>((resolve) => { release = resolve; });
    this.inFlight.add(tracker);
    const execution = Promise.resolve()
      .then(async () => {
        const result = await run();
        settledWithoutError = true;
        return result;
      })
      .finally(() => {
        this.activeById.delete(effectId);
        this.inFlight.delete(tracker);
        release();
        if (this.isFenced || this.activePump) return;
        if (settledWithoutError) {
          this.consecutivePumpErrors = 0;
        } else {
          // A direct execution failed before settling (for example a transient
          // pre-claim authority error while a concurrent pump skipped this active
          // row). Back off with a timer so queued work never stalls or spins.
          this.consecutivePumpErrors += 1;
        }
        this.scheduleNextPump();
      });
    this.activeById.set(effectId, execution);
    return execution;
  }

  private autoPumpKinds(): string[] {
    const kinds: string[] = [];
    for (const [kind, handler] of this.handlers) {
      if (handler.autoPump !== false) kinds.push(kind);
    }
    return kinds;
  }

  private scheduleNextPump(): void {
    const kinds = this.autoPumpKinds();
    if (this.isFenced || kinds.length === 0) return;
    const database = this.options.getDatabase();
    if (!database || !database.isOpen) return;
    const maxEpoch = this.safeCurrentGeneration();
    if (maxEpoch === null) return;
    const dueMs = nextScheduledPreparedEffectAtMs(database, kinds, {
      excludeIds: [...this.activeById.keys()],
      maxEpoch,
    });
    if (dueMs === null) return;
    let delay = Math.max(0, dueMs - this.nowMs());
    if (this.consecutivePumpErrors > 0) {
      const errorBackoff = Math.max(
        MIN_PRE_CLAIM_ERROR_BACKOFF_MS,
        computeEffectBackoffMs(this.consecutivePumpErrors, undefined, this.options.defaultBackoff),
      );
      delay = Math.max(delay, errorBackoff);
    }
    this.schedulePump(delay);
  }

  private schedulePump(delayMs: number): void {
    if (this.isFenced) return;
    if (delayMs <= 0) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        this.timerDueMs = Infinity;
      }
      if (this.immediate) return;
      this.immediate = setImmediate(() => {
        this.immediate = null;
        if (!this.isFenced) void this.pumpNow();
      });
      return;
    }
    const due = Date.now() + delayMs;
    if (this.timer && this.timerDueMs <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueMs = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueMs = Infinity;
      void this.pumpNow();
    }, delayMs);
    this.timer.unref();
  }

  private async executeEffect(effectId: string): Promise<EffectRecord> {
    await this.assertAuthority();
    this.assertNotFenced();
    const database = this.requireDatabase();
    const initial = getEffect(database, effectId);
    if (!initial) throw new EffectFenceError(`Unknown effect ${effectId}.`);
    if (initial.state !== "prepared") return initial;
    const handler = this.handlers.get(initial.kind);
    if (!handler) {
      throw new EffectValidationError(`No effect handler registered for kind ${initial.kind}.`);
    }

    // Enforce at-most-once policy before dispatching any previously attempted
    // retry row (e.g., if policy tightened across builds or handler registration
    // occurred after startup recovery).
    if ((!handler.retryable || !initial.retryable) && initial.attempt_count >= 1) {
      const quarantined = this.runFencedWrite(() => quarantinePreparedRetryAsUncertain(
        database,
        this.options.assertWriteFence,
        {
          id: initial.id,
          daemonGeneration: this.options.currentDaemonGeneration(),
          error: `Effect kind ${initial.kind} is non-retryable (at-most-once); refusing replay after ${initial.attempt_count} prior attempt(s) and marking uncertain.`,
          nowIso: this.nowIso(),
        },
      ));
      this.options.notifyStateChanged?.();
      return quarantined;
    }

    let claimed: EffectRecord;
    try {
      claimed = this.runFencedWrite(() => claimEffectForExecution(database, this.options.assertWriteFence, {
        id: effectId,
        daemonGeneration: this.options.currentDaemonGeneration(),
        nowMs: this.nowMs(),
        nowIso: this.nowIso(),
        authorizeClaim: handler.authorizeClaim,
      }));
    } catch (error) {
      if (error instanceof EffectClaimRefusedError) {
        this.options.notifyStateChanged?.();
      }
      throw error;
    }
    this.options.notifyStateChanged?.();

    let result: EffectExecutionResult;
    try {
      result = await handler.execute(claimed, {
        signal: this.abortController.signal,
        daemonGeneration: claimed.epoch,
        attemptCount: claimed.attempt_count,
        assertCurrent: this.options.assertCurrent,
      });
    } catch (error) {
      // Never swallow lost singleton authority or pretend an external call failed
      // when this daemon lost its write fence.
      if (error instanceof DaemonFenceLostError) {
        this.fence();
        throw error;
      }
      if (error instanceof EffectFenceError) throw error;
      return this.settleUnexpectedThrow(claimed, handler, error);
    }

    // Settlement checks singleton authority (not `!fenced`) so an execution already
    // admitted before `fenceAndDrain()` can durably record its receipt before the
    // daemon releases the lock and closes SQLite.
    await this.assertAuthority();
    const defaultSettle = () => this.runFencedWrite(() => this.settleExecutionResult(claimed, handler, result));
    const settled = handler.settle
      ? await handler.settle(claimed, result, defaultSettle)
      : defaultSettle();
    this.options.notifyStateChanged?.();
    if (!this.isFenced) this.scheduleNextPump();
    return settled;
  }

  private runFencedWrite<T>(write: () => T): T {
    try {
      return write();
    } catch (error) {
      if (error instanceof DaemonFenceLostError) this.fence();
      throw error;
    }
  }

  private settleExecutionResult(
    claimed: EffectRecord,
    handler: EffectHandler,
    result: EffectExecutionResult,
  ): EffectRecord {
    const database = this.requireDatabase();
    const nowIso = this.nowIso();
    switch (result.status) {
      case "completed":
        try {
          return completeEffect(database, this.options.assertWriteFence, {
            id: claimed.id,
            expectedEpoch: claimed.epoch,
            expectedAttemptCount: claimed.attempt_count,
            outcome: result.outcome,
            nowIso,
          });
        } catch (error) {
          if (!(error instanceof EffectValidationError)) throw error;
          // External execution already succeeded; store a bounded omission marker
          // rather than losing the completion receipt or misreporting failure.
          return completeEffect(database, this.options.assertWriteFence, {
            id: claimed.id,
            expectedEpoch: claimed.epoch,
            expectedAttemptCount: claimed.attempt_count,
            outcome: { effect_outcome_omitted: true, reason: error.message },
            nowIso,
          });
        }
      case "failed":
        return failEffect(database, this.options.assertWriteFence, {
          id: claimed.id,
          expectedEpoch: claimed.epoch,
          expectedAttemptCount: claimed.attempt_count,
          error: result.error,
          outcome: result.outcome,
          nowIso,
        });
      case "retry": {
        if (!claimed.retryable || !handler.retryable) {
          return markEffectUncertain(database, this.options.assertWriteFence, {
            id: claimed.id,
            expectedEpoch: claimed.epoch,
            expectedAttemptCount: claimed.attempt_count,
            error: `Non-retryable effect requested retry after execution started; marked uncertain to preserve at-most-once delivery: ${result.error}`,
            nowIso,
          });
        }
        if (claimed.attempt_count >= claimed.max_attempts) {
          return failEffect(database, this.options.assertWriteFence, {
            id: claimed.id,
            expectedEpoch: claimed.epoch,
            expectedAttemptCount: claimed.attempt_count,
            error: result.error,
            nowIso,
          });
        }
        const computed = computeEffectBackoffMs(claimed.attempt_count, handler.backoff, this.options.defaultBackoff);
        const maxDelay = handler.backoff?.maxDelayMs ?? this.options.defaultBackoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
        const delayMs = result.retryAfterMs !== undefined
          ? Math.max(0, Math.min(maxDelay, Math.round(result.retryAfterMs)))
          : computed;
        return rescheduleEffectForRetry(database, this.options.assertWriteFence, {
          id: claimed.id,
          expectedEpoch: claimed.epoch,
          expectedAttemptCount: claimed.attempt_count,
          nextAttemptAtMs: this.nowMs() + delayMs,
          error: result.error,
          nowIso,
        });
      }
      case "uncertain":
        return markEffectUncertain(database, this.options.assertWriteFence, {
          id: claimed.id,
          expectedEpoch: claimed.epoch,
          expectedAttemptCount: claimed.attempt_count,
          error: result.error,
          outcome: result.outcome,
          nowIso,
        });
    }
  }

  private async settleUnexpectedThrow(
    claimed: EffectRecord,
    handler: EffectHandler,
    error: unknown,
  ): Promise<EffectRecord> {
    await this.assertAuthority();
    const database = this.requireDatabase();
    const detail = errorMessage(error);
    const nowIso = this.nowIso();
    let settled: EffectRecord;
    if (claimed.retryable && handler.retryable && claimed.attempt_count < claimed.max_attempts) {
      const delayMs = computeEffectBackoffMs(claimed.attempt_count, handler.backoff, this.options.defaultBackoff);
      settled = this.runFencedWrite(() => rescheduleEffectForRetry(database, this.options.assertWriteFence, {
        id: claimed.id,
        expectedEpoch: claimed.epoch,
        expectedAttemptCount: claimed.attempt_count,
        nextAttemptAtMs: this.nowMs() + delayMs,
        error: detail,
        nowIso,
      }));
    } else {
      // An unexpected throw after entering `executing` cannot prove the external
      // side effect did not occur. Mark `uncertain` instead of falsely claiming failure.
      settled = this.runFencedWrite(() => markEffectUncertain(database, this.options.assertWriteFence, {
        id: claimed.id,
        expectedEpoch: claimed.epoch,
        expectedAttemptCount: claimed.attempt_count,
        error: detail,
        nowIso,
      }));
    }
    this.options.notifyStateChanged?.();
    if (!this.isFenced) this.scheduleNextPump();
    return settled;
  }

  private async reconcileUncertainInternal(effectId: string): Promise<EffectRecord> {
    await this.assertAuthority();
    this.assertNotFenced();
    const database = this.requireDatabase();
    const current = getEffect(database, effectId);
    if (!current) throw new EffectFenceError(`Unknown effect ${effectId}.`);
    if (current.state !== "uncertain") return current;
    const handler = this.handlers.get(current.kind);
    if (!handler?.reconcileUncertain) return current;

    const generation = this.runFencedWrite(() => this.options.currentDaemonGeneration());
    const verified = await handler.reconcileUncertain(current, {
      signal: this.abortController.signal,
      daemonGeneration: generation,
      attemptCount: current.attempt_count,
      assertCurrent: this.options.assertCurrent,
    });
    if (verified.status === "still_uncertain") return current;

    await this.assertAuthority();
    const nowIso = this.nowIso();
    let settled: EffectRecord;
    try {
      settled = this.runFencedWrite(() => resolveUncertainEffect(database, this.options.assertWriteFence, {
        id: current.id,
        daemonGeneration: generation,
        state: verified.status,
        outcome: verified.outcome,
        error: verified.status === "failed" ? verified.error : undefined,
        nowIso,
      }));
    } catch (error) {
      if (!(error instanceof EffectValidationError) || verified.status !== "completed") throw error;
      settled = this.runFencedWrite(() => resolveUncertainEffect(database, this.options.assertWriteFence, {
        id: current.id,
        daemonGeneration: generation,
        state: "completed",
        outcome: { effect_outcome_omitted: true, reason: error.message },
        nowIso,
      }));
    }
    this.options.notifyStateChanged?.();
    return settled;
  }
}
