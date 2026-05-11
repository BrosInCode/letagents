import assert from "node:assert/strict";
import test from "node:test";

import type {
  AdapterCalibrationHistory,
  AdapterCapabilities,
  AdapterLrtEstimate,
  AdapterMeterSource,
  AdapterNativeQuotaSnapshot,
  AdapterRentalMeterScope,
  AdapterUsageDelta,
  DesktopMeterAdapter,
} from "../rental/adapter-types.js";
import {
  AdapterRegistry,
  AdapterScheduler,
  type AdapterPollContext,
  type AdapterTickResult,
} from "../rental/adapter-runtime.js";
import type {
  ReportSnapshotInputs,
  ReportSnapshotResult,
} from "../rental/snapshot-reporter.js";

const FIXED_CAPS: AdapterCapabilities = Object.freeze({
  supportsExact: true,
  supportsLaneRecovery: false,
  supportsTier2Continuity: false,
});

class StubAdapter implements DesktopMeterAdapter {
  readonly provider = "claude_code";
  readonly capabilities = FIXED_CAPS;
  sources: AdapterMeterSource[] = [
    { id: "s1", label: "S1", kind: "jsonl", pathHint: "/tmp/a.jsonl", lastSeenAt: null },
  ];
  snapshot: AdapterNativeQuotaSnapshot | null = {
    provider: "claude_code",
    model: "claude-3.7-sonnet",
    sourceId: "s1",
    nativeUnit: "tokens",
    nativeRemaining: null,
    nativeTotal: null,
    nativeResetAt: null,
    confidence: "local_exact",
    observedAt: "2026-05-11T10:00:00.000Z",
    raw: {},
  };
  delta: AdapterUsageDelta = {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    credits: 0,
    usd: 0,
    toolCalls: 0,
    commandRuns: 0,
  };
  lrt: AdapterLrtEstimate = { lrtUsed: 100, lrtRemaining: null, confidence: "local_exact" };
  discoverCalls = 0;
  readQuotaCalls = 0;
  readDeltaCalls = 0;

  async discoverSources(): Promise<AdapterMeterSource[]> {
    this.discoverCalls += 1;
    return this.sources;
  }
  async readNativeQuota(_source: AdapterMeterSource): Promise<AdapterNativeQuotaSnapshot | null> {
    this.readQuotaCalls += 1;
    return this.snapshot;
  }
  async readUsageDelta(_scope: AdapterRentalMeterScope): Promise<AdapterUsageDelta> {
    this.readDeltaCalls += 1;
    return this.delta;
  }
  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    _history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate {
    return { ...this.lrt, confidence: snapshot.confidence };
  }
}

function fakeContext(over: Partial<AdapterPollContext> = {}): AdapterPollContext {
  return {
    sessionId: "sess_42",
    provider: "claude_code",
    scope: { sessionId: "sess_42", workspaceMarker: "letagents-rental/sess_42" },
    reporterConfig: { apiBaseUrl: "https://letagents.test", fetchFn: async () => new Response("{}", { status: 201 }) },
    ...over,
  };
}

function buildScheduler(over: {
  context?: () => AdapterPollContext | null;
  enabled?: () => boolean;
  reporter?: (inputs: ReportSnapshotInputs) => Promise<ReportSnapshotResult>;
  onError?: (err: Error, context: { phase: string }) => void;
  intervalMs?: number;
} = {}) {
  const registry = new AdapterRegistry();
  const adapter = new StubAdapter();
  registry.register(adapter);
  const reporterCalls: ReportSnapshotInputs[] = [];
  const ticks: AdapterTickResult[][] = [];
  const errors: Array<{ err: Error; phase: string }> = [];
  let timerCb: (() => void) | null = null;
  const scheduler = new AdapterScheduler({
    registry,
    getActiveContext: over.context ?? fakeContext,
    isEnabled: over.enabled ?? (() => true),
    intervalMs: over.intervalMs ?? 30_000,
    setTimer: (cb) => {
      timerCb = cb;
      return 1;
    },
    clearTimer: () => {
      timerCb = null;
    },
    onError: (err, ctx) => {
      errors.push({ err, phase: ctx.phase });
      over.onError?.(err, ctx);
    },
    onTick: (r) => {
      ticks.push(r);
    },
    reportSnapshotFn: over.reporter
      ? (async (inputs, _config) => {
          reporterCalls.push(inputs);
          return over.reporter!(inputs);
        })
      : (async (inputs, _config) => {
          reporterCalls.push(inputs);
          return { ok: true, status: 201, idempotencyKey: "test-key", body: null, error: null };
        }),
  });
  return {
    scheduler,
    registry,
    adapter,
    reporterCalls,
    ticks,
    errors,
    fireTimer: () => {
      const cb = timerCb;
      timerCb = null;
      if (cb) cb();
    },
  };
}

test("tickOnce skips work when feature flag is off", async () => {
  const { scheduler, reporterCalls } = buildScheduler({ enabled: () => false });
  const out = await scheduler.tickOnce();
  assert.deepEqual(out, []);
  assert.equal(reporterCalls.length, 0);
});

test("tickOnce skips work when there is no active context", async () => {
  const { scheduler, reporterCalls } = buildScheduler({ context: () => null });
  const out = await scheduler.tickOnce();
  assert.deepEqual(out, []);
  assert.equal(reporterCalls.length, 0);
});

test("tickOnce skips work when no adapter is registered for the context's provider", async () => {
  const { scheduler, reporterCalls } = buildScheduler({
    context: () =>
      fakeContext({ provider: "antigravity" }), // no antigravity adapter registered
  });
  const out = await scheduler.tickOnce();
  assert.deepEqual(out, []);
  assert.equal(reporterCalls.length, 0);
});

test("tickOnce runs discover → readNativeQuota → readUsageDelta → reportSnapshot for every source", async () => {
  const { scheduler, adapter, reporterCalls } = buildScheduler();
  const out = await scheduler.tickOnce();
  assert.equal(adapter.discoverCalls, 1);
  assert.equal(adapter.readQuotaCalls, 1);
  assert.equal(adapter.readDeltaCalls, 1);
  assert.equal(reporterCalls.length, 1);
  assert.equal(reporterCalls[0]!.sessionId, "sess_42");
  assert.equal(out.length, 1);
  assert.ok(out[0]!.reported?.ok);
  assert.equal(out[0]!.error, null);
});

test("tickOnce records null snapshot results without invoking the reporter", async () => {
  const { scheduler, registry, reporterCalls } = buildScheduler();
  const stub = registry.get("claude_code")! as StubAdapter;
  stub.snapshot = null;
  const out = await scheduler.tickOnce();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.snapshot, null);
  assert.equal(out[0]!.reported, null);
  assert.equal(reporterCalls.length, 0);
});

test("tickOnce logs an error via onError when a reporter call returns ok=false", async () => {
  const errors: Array<{ err: Error; phase: string }> = [];
  const { scheduler } = buildScheduler({
    onError: (err, ctx) => errors.push({ err, phase: ctx.phase }),
    reporter: async () => ({
      ok: false,
      status: 503,
      idempotencyKey: "k",
      body: null,
      error: "upstream down",
    }),
  });
  await scheduler.tickOnce();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.phase, "reportSnapshot");
});

test("tickOnce catches adapter-thrown errors and continues with a typed result", async () => {
  const errors: Array<{ err: Error; phase: string }> = [];
  const { scheduler, registry } = buildScheduler({
    onError: (err, ctx) => errors.push({ err, phase: ctx.phase }),
  });
  const stub = registry.get("claude_code")! as StubAdapter;
  stub.readNativeQuota = async () => {
    throw new Error("disk i/o failed");
  };
  const out = await scheduler.tickOnce();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.snapshot, null);
  assert.equal(out[0]!.reported, null);
  assert.match(out[0]!.error!.message, /disk i\/o failed/);
  assert.ok(errors.some((e) => e.phase === "runAdapterPass"));
});

test("tickOnce skips the whole adapter when discoverSources throws (and logs)", async () => {
  const errors: Array<{ err: Error; phase: string }> = [];
  const { scheduler, registry, reporterCalls } = buildScheduler({
    onError: (err, ctx) => errors.push({ err, phase: ctx.phase }),
  });
  const stub = registry.get("claude_code")! as StubAdapter;
  stub.discoverSources = async () => {
    throw new Error("no project dir");
  };
  const out = await scheduler.tickOnce();
  assert.deepEqual(out, []);
  assert.equal(reporterCalls.length, 0);
  assert.ok(errors.some((e) => e.phase === "discoverSources"));
});

test("start() schedules a tick after intervalMs and fires it; stop() prevents further ticks", async () => {
  const { scheduler, fireTimer, ticks } = buildScheduler({ intervalMs: 5_000 });
  scheduler.start();
  // setTimer was called with a 5000ms delay; fire it to simulate elapsed time.
  fireTimer();
  // Wait for the microtask queue to settle so the async tickOnce inside runTick completes.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(ticks.length, 1, "one tick should have completed");
  scheduler.stop();
  fireTimer(); // no-op once stopped
  await new Promise((r) => setImmediate(r));
  assert.equal(ticks.length, 1, "stop() should suppress further ticks");
});

test("start() is idempotent", () => {
  const { scheduler } = buildScheduler();
  scheduler.start();
  scheduler.start();
  scheduler.stop();
});
