/**
 * Generic meter adapter scheduler.
 *
 * Owns the lifecycle of per-IDE adapters:
 *
 *   1. Holds a registry of adapter instances by provider key.
 *   2. While `LETAGENTS_RENT_ENABLED` and there's an active rental
 *      session, periodically polls the active adapter source for a fresh
 *      NativeQuotaSnapshot + UsageDelta and ships the result to the
 *      server via the snapshot-reporter from p2.3b.
 *   3. Stops gracefully when the active session ends or the feature
 *      flag flips off.
 *
 * The poll loop is intentionally fire-and-forget per interval — a
 * failure to POST is logged and we wait for the next tick. Retry /
 * backoff hardening is a future track per the same trade-off
 * documented in `snapshot-reporter.ts`.
 *
 * Spec §17.7. Per LivelyPeak's msg_63 dissent, adapters run desktop-side
 * (Electron main / MCP-local) because they read local IDE files. No
 * server-side filesystem access.
 */

import type {
  AdapterMeterSource,
  AdapterNativeQuotaSnapshot,
  AdapterRentalMeterScope,
  DesktopMeterAdapter,
} from "./adapter-types.js";
import {
  reportSnapshot,
  type ReportSnapshotConfig,
  type ReportSnapshotResult,
} from "./snapshot-reporter.js";

/**
 * Mutable in-process registry of meter adapters keyed by provider.
 *
 * Phase 2 PRs register their adapters here:
 *   p2.3 (this) → claude_code
 *   p2.4         → codex
 *   p2.5         → antigravity
 *   p2.7         → cursor
 */
export class AdapterRegistry {
  private readonly byProvider = new Map<string, DesktopMeterAdapter>();

  register(adapter: DesktopMeterAdapter): void {
    if (this.byProvider.has(adapter.provider)) {
      throw new Error(`adapter already registered for provider: ${adapter.provider}`);
    }
    this.byProvider.set(adapter.provider, adapter);
  }

  /** Replace an existing adapter. Useful in tests; production callers should `register` exactly once per provider. */
  override(adapter: DesktopMeterAdapter): void {
    this.byProvider.set(adapter.provider, adapter);
  }

  unregister(provider: string): void {
    this.byProvider.delete(provider);
  }

  get(provider: string): DesktopMeterAdapter | null {
    return this.byProvider.get(provider) ?? null;
  }

  list(): DesktopMeterAdapter[] {
    return Array.from(this.byProvider.values());
  }
}

// ===== Scheduler =====

/**
 * What the scheduler needs to know at each poll tick.
 *
 * The host (Electron main process or test harness) provides:
 *   • The active rental session id, if any. Polling pauses when null.
 *   • The provider whose adapter should run for this session
 *     (mapped from `session.renter_lane_provider`).
 *   • The meter scope identifying the rental's workspace marker.
 *   • The transport config for the snapshot reporter (api base url,
 *     bearer token, optional fetch override).
 *
 * Returning a fresh struct from `getActiveContext()` on each tick lets
 * the host adapt to session changes without restarting the scheduler.
 */
export interface AdapterPollContext {
  sessionId: string;
  provider: string;
  scope: AdapterRentalMeterScope;
  reporterConfig: ReportSnapshotConfig;
}

export interface AdapterSchedulerOptions {
  registry: AdapterRegistry;
  /** Pure function returning the current context, or null when idle. */
  getActiveContext: () => AdapterPollContext | null;
  /** Returns `true` when the feature flag is on. */
  isEnabled: () => boolean;
  /** Tick interval in ms. Default 30_000 (§17.4 polling). */
  intervalMs?: number;
  /** Logger sink for non-fatal errors. Default = no-op. */
  onError?: (err: Error, context: { phase: string }) => void;
  /**
   * Test hook fired after every completed tick (success or failure).
   * Receives the per-source results so tests can assert the
   * reporter was invoked.
   */
  onTick?: (results: AdapterTickResult[]) => void;
  /** Injectable timer hooks for tests. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Override snapshot-reporter for unit tests. */
  reportSnapshotFn?: typeof reportSnapshot;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface AdapterTickResult {
  source: AdapterMeterSource;
  snapshot: AdapterNativeQuotaSnapshot | null;
  reported: ReportSnapshotResult | null;
  error: Error | null;
}

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Periodic poller — keeps the scheduler alive until `stop()` is called.
 *
 * Tick body for one adapter:
 *
 *   1. discoverSources()
 *   2. pick the active source, then readNativeQuota → readUsageDelta(scope)
 *      → estimateAvailableLrt → reportSnapshot
 *   3. record results, invoke onTick(...)
 *
 * Ticks for *one* adapter run sequentially (per the rolling-LRT
 * contract — see snapshot-reporter idempotency). Multiple adapters
 * for the same session shouldn't happen in V1 since one session = one
 * lane.
 */
export class AdapterScheduler {
  private timerHandle: unknown = null;
  private running = false;
  private readonly opts: Required<Pick<AdapterSchedulerOptions, "intervalMs">> &
    AdapterSchedulerOptions;

  constructor(options: AdapterSchedulerOptions) {
    this.opts = { intervalMs: DEFAULT_INTERVAL_MS, ...options };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timerHandle !== null) {
      const clear = this.opts.clearTimer ?? clearTimeout;
      clear(this.timerHandle as never);
      this.timerHandle = null;
    }
  }

  /** Manually trigger a single tick. Useful in tests. */
  async tickOnce(): Promise<AdapterTickResult[]> {
    if (!this.opts.isEnabled()) return [];
    const context = this.opts.getActiveContext();
    if (!context) return [];
    const adapter = this.opts.registry.get(context.provider);
    if (!adapter) return [];
    return this.runAdapterPass(adapter, context);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const setTimer = this.opts.setTimer ?? setTimeout;
    this.timerHandle = setTimer(() => {
      void this.runTick().finally(() => this.scheduleNext());
    }, this.opts.intervalMs);
  }

  private async runTick(): Promise<void> {
    if (!this.running) return;
    try {
      const results = await this.tickOnce();
      this.opts.onTick?.(results);
    } catch (err) {
      this.opts.onError?.(asError(err), { phase: "runTick" });
    }
  }

  private async runAdapterPass(
    adapter: DesktopMeterAdapter,
    context: AdapterPollContext,
  ): Promise<AdapterTickResult[]> {
    const results: AdapterTickResult[] = [];
    let sources: AdapterMeterSource[];
    try {
      sources = await adapter.discoverSources();
    } catch (err) {
      this.opts.onError?.(asError(err), { phase: "discoverSources" });
      return results;
    }
    const report = this.opts.reportSnapshotFn ?? reportSnapshot;
    const source = sources[0];
    if (!source) return results;

    try {
      const snapshot = await adapter.readNativeQuota(source);
      if (!snapshot) {
        results.push({ source, snapshot: null, reported: null, error: null });
        return results;
      }
      const rawDelta = await adapter.readUsageDelta(context.scope);
      const delta = { ...rawDelta, heartbeats: 1 };
      const lrt = adapter.estimateAvailableLrt(snapshot, {
        lrtPerFullWindow: null,
        sampleCount: 0,
      });
      const lastHeartbeatAt = (this.opts.now ?? (() => new Date()))().toISOString();
      const reported = await report(
        {
          sessionId: context.sessionId,
          snapshot,
          delta,
          lrt,
          lastHeartbeatAt,
        },
        context.reporterConfig,
      );
      if (!reported.ok) {
        this.opts.onError?.(
          new Error(`reportSnapshot failed: ${reported.status} ${reported.error ?? "unknown"}`),
          { phase: "reportSnapshot" },
        );
      }
      results.push({ source, snapshot, reported, error: null });
    } catch (err) {
      const e = asError(err);
      this.opts.onError?.(e, { phase: "runAdapterPass" });
      results.push({ source, snapshot: null, reported: null, error: e });
    }
    return results;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
