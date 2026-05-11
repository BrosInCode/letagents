/**
 * Tests for the Antigravity meter adapter (p2.5 desktop slice).
 *
 * Covers:
 *   - capabilities (estimated, lane recovery)
 *   - discoverSources (additionalPaths + platform defaults)
 *   - parseQuotaFile against the fixture (lane round-trip)
 *   - parseQuotaDocument tolerates malformed entries
 *   - pickPrimaryLane preference order (recent > lowest > first)
 *   - readNativeQuota produces a percent_window snapshot
 *   - estimateAvailableLrt math (with / without calibration history)
 *   - computePercentWindowDelta gates lane comparison correctly
 *   - laneFilter restricts to a subset of lanes
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER,
  AntigravityAdapter,
  computePercentWindowDelta,
  defaultAntigravityQuotaPaths,
  estimateLrtRemainingForWindow,
  parseQuotaDocument,
  pickPrimaryLane,
  type AntigravityLane,
} from "../rental/adapters/antigravity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "__fixtures__",
  "antigravity-quota.json",
);

// ---------------------------------------------------------------------------
// Capabilities / provider key
// ---------------------------------------------------------------------------

test("AntigravityAdapter advertises percent_window-capable capabilities", () => {
  const adapter = new AntigravityAdapter();
  assert.equal(adapter.provider, ANTIGRAVITY_PROVIDER);
  assert.equal(adapter.capabilities, ANTIGRAVITY_CAPABILITIES);
  assert.equal(adapter.capabilities.supportsExact, false);
  assert.equal(adapter.capabilities.supportsLaneRecovery, true);
  assert.equal(adapter.capabilities.supportsTier2Continuity, false);
});

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

test("defaultAntigravityQuotaPaths returns platform-specific candidates", () => {
  const paths = defaultAntigravityQuotaPaths("/tmp/fake-home");
  assert.ok(paths.length >= 1);
  // Every entry must mention /tmp/fake-home or an env-derived equivalent
  // (on Windows we use %APPDATA% which may not be /tmp/fake-home, so
  // we only assert that at least one candidate contains the home).
  assert.ok(paths.some((p) => p.includes("/tmp/fake-home") || p.includes("\\tmp\\fake-home")));
});

test("discoverSources returns existing additionalPaths first", async () => {
  const adapter = new AntigravityAdapter({ additionalPaths: [FIXTURE_PATH] });
  const sources = await adapter.discoverSources();
  assert.ok(sources.length >= 1);
  assert.equal(sources[0]?.kind, "json");
  assert.equal(sources[0]?.pathHint, FIXTURE_PATH);
  assert.match(sources[0]?.id ?? "", /^antigravity-quota:/);
});

test("discoverSources deduplicates paths", async () => {
  const adapter = new AntigravityAdapter({
    additionalPaths: [FIXTURE_PATH, FIXTURE_PATH],
  });
  const sources = await adapter.discoverSources();
  const matching = sources.filter((s) => s.pathHint === FIXTURE_PATH);
  assert.equal(matching.length, 1);
});

test("discoverSources skips paths that do not exist", async () => {
  const adapter = new AntigravityAdapter({
    additionalPaths: ["/definitely/nonexistent/path/quota.json"],
    homeDirOverride: "/definitely/nonexistent/home",
  });
  const sources = await adapter.discoverSources();
  assert.deepEqual(sources, []);
});

// ---------------------------------------------------------------------------
// parseQuotaFile + parseQuotaDocument
// ---------------------------------------------------------------------------

test("parseQuotaFile loads the fixture and round-trips all 3 lanes", async () => {
  const adapter = new AntigravityAdapter();
  const doc = await adapter.parseQuotaFile(FIXTURE_PATH);
  assert.ok(doc, "fixture should parse");
  assert.equal(doc!.version, 1);
  assert.equal(doc!.observedAt, "2026-05-11T10:00:00.000Z");
  assert.equal(doc!.lanes.length, 3);
  assert.equal(doc!.lanes[0]!.laneId, "gemini-2.5-pro");
  assert.equal(doc!.lanes[0]!.model, "gemini-2.5-pro");
  assert.equal(doc!.lanes[0]!.percentRemaining, 0.42);
  assert.equal(doc!.lanes[2]!.percentRemaining, 0);
});

test("parseQuotaDocument tolerates missing/malformed lane entries", () => {
  const doc = parseQuotaDocument({
    version: 1,
    lanes: [
      { lane_id: "ok", percent_remaining: 0.5 },
      { lane_id: "", percent_remaining: 0.5 },               // bad lane_id
      { lane_id: "no-percent" },                             // missing percent
      { lane_id: "non-number", percent_remaining: "0.5" },   // bad percent
      { lane_id: "good", model: "m", percent_remaining: 0.1 },
      "not-an-object" as unknown,
    ],
  });
  assert.ok(doc);
  assert.equal(doc!.lanes.length, 2);
  assert.equal(doc!.lanes[0]!.laneId, "ok");
  assert.equal(doc!.lanes[1]!.laneId, "good");
});

test("parseQuotaDocument rejects unrecognized shapes", () => {
  assert.equal(parseQuotaDocument(null), null);
  assert.equal(parseQuotaDocument(42), null);
  assert.equal(parseQuotaDocument("not-json"), null);
  assert.equal(parseQuotaDocument({ version: "1", lanes: [] }), null);
  assert.equal(parseQuotaDocument({ version: 1 }), null);
  assert.equal(parseQuotaDocument({ version: 1, lanes: "not-array" }), null);
});

test("parseQuotaDocument clamps percent_remaining to [0, 1]", () => {
  const doc = parseQuotaDocument({
    version: 1,
    lanes: [
      { lane_id: "high", percent_remaining: 1.5 },
      { lane_id: "neg", percent_remaining: -0.3 },
    ],
  });
  assert.equal(doc!.lanes[0]!.percentRemaining, 1);
  assert.equal(doc!.lanes[1]!.percentRemaining, 0);
});

test("parseQuotaFile returns null when JSON is malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letagents-rent-antigravity-"));
  const path = join(dir, "bad.json");
  await writeFile(path, "{ not valid json", "utf8");
  const adapter = new AntigravityAdapter();
  const doc = await adapter.parseQuotaFile(path);
  assert.equal(doc, null);
});

test("parseQuotaFile returns null when the file does not exist", async () => {
  const adapter = new AntigravityAdapter();
  const doc = await adapter.parseQuotaFile("/no/such/file.json");
  assert.equal(doc, null);
});

// ---------------------------------------------------------------------------
// pickPrimaryLane preference order
// ---------------------------------------------------------------------------

test("pickPrimaryLane prefers the most-recent lastEventAt", () => {
  const lanes: AntigravityLane[] = [
    {
      laneId: "old",
      model: null,
      displayName: null,
      percentRemaining: 0.1,
      resetAt: null,
      lastEventAt: "2026-05-10T00:00:00.000Z",
    },
    {
      laneId: "fresh",
      model: null,
      displayName: null,
      percentRemaining: 0.9,
      resetAt: null,
      lastEventAt: "2026-05-11T09:55:00.000Z",
    },
  ];
  assert.equal(pickPrimaryLane(lanes).laneId, "fresh");
});

test("pickPrimaryLane falls back to lowest percentRemaining when no events", () => {
  const lanes: AntigravityLane[] = [
    {
      laneId: "high",
      model: null,
      displayName: null,
      percentRemaining: 0.9,
      resetAt: null,
      lastEventAt: null,
    },
    {
      laneId: "exhausted",
      model: null,
      displayName: null,
      percentRemaining: 0.05,
      resetAt: null,
      lastEventAt: null,
    },
  ];
  assert.equal(pickPrimaryLane(lanes).laneId, "exhausted");
});

test("pickPrimaryLane handles a single-lane document", () => {
  const lanes: AntigravityLane[] = [
    {
      laneId: "only",
      model: null,
      displayName: null,
      percentRemaining: 0.5,
      resetAt: null,
      lastEventAt: null,
    },
  ];
  assert.equal(pickPrimaryLane(lanes).laneId, "only");
});

// ---------------------------------------------------------------------------
// readNativeQuota
// ---------------------------------------------------------------------------

test("readNativeQuota returns a percent_window snapshot for the primary lane", async () => {
  const adapter = new AntigravityAdapter({ additionalPaths: [FIXTURE_PATH] });
  const sources = await adapter.discoverSources();
  const snapshot = await adapter.readNativeQuota(sources[0]!);
  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "antigravity");
  assert.equal(snapshot!.nativeUnit, "percent_window");
  assert.equal(snapshot!.nativeTotal, 1);
  // Fixture's primary lane is the one with the most recent
  // lastEventAt (claude-haiku-4 at 09:59 beats gemini-pro at 09:55).
  // The exhausted lane is also the most realistic D1 trigger surface.
  assert.equal(snapshot!.model, "claude-haiku-4");
  assert.equal(snapshot!.nativeRemaining, 0);
  assert.equal(snapshot!.nativeResetAt, "2026-05-11T20:30:00.000Z");
  assert.equal(snapshot!.confidence, "estimated");
  const raw = snapshot!.raw as { allLanes: unknown[]; laneId: string };
  assert.equal(raw.laneId, "claude-haiku-4");
  assert.equal(raw.allLanes.length, 3);
});

test("readNativeQuota returns null for non-json sources", async () => {
  const adapter = new AntigravityAdapter();
  const snap = await adapter.readNativeQuota({
    id: "x",
    label: "x",
    kind: "jsonl",
    pathHint: FIXTURE_PATH,
    lastSeenAt: null,
  });
  assert.equal(snap, null);
});

test("laneFilter restricts which lanes are eligible", async () => {
  const adapter = new AntigravityAdapter({
    additionalPaths: [FIXTURE_PATH],
    laneFilter: ["gemini-2.5-flash"],
  });
  const [source] = await adapter.discoverSources();
  const snapshot = await adapter.readNativeQuota(source!);
  assert.ok(snapshot);
  assert.equal(snapshot!.model, "gemini-2.5-flash");
  assert.equal(snapshot!.nativeRemaining, 1);
});

test("laneFilter that matches no lane yields no snapshot", async () => {
  const adapter = new AntigravityAdapter({
    additionalPaths: [FIXTURE_PATH],
    laneFilter: ["does-not-exist"],
  });
  const [source] = await adapter.discoverSources();
  const snapshot = await adapter.readNativeQuota(source!);
  assert.equal(snapshot, null);
});

// ---------------------------------------------------------------------------
// estimateAvailableLrt
// ---------------------------------------------------------------------------

test("estimateAvailableLrt returns null lrtRemaining without calibration", () => {
  const adapter = new AntigravityAdapter();
  const result = adapter.estimateAvailableLrt(
    {
      provider: "antigravity",
      model: "gemini-2.5-pro",
      sourceId: "x",
      nativeUnit: "percent_window",
      nativeRemaining: 0.5,
      nativeTotal: 1,
      nativeResetAt: null,
      confidence: "estimated",
      observedAt: "2026-05-11T10:00:00.000Z",
      raw: {},
    },
    { lrtPerFullWindow: null, sampleCount: 0 },
  );
  assert.equal(result.lrtUsed, 0);
  assert.equal(result.lrtRemaining, null);
  assert.equal(result.confidence, "estimated");
});

test("estimateAvailableLrt projects lrtRemaining but holds lrtUsed at 0 until the server reconciler lands", () => {
  // For a percent_window meter, `lrt.lrtUsed` reported every tick
  // would be summed into `lrt_total` server-side and over-charge the
  // session. The successive-snapshot reconciler (which converts
  // pairs of snapshots into a real delta) is a separate slice;
  // until then this adapter must report `lrtUsed = 0` even when
  // calibration is available. `lrtRemaining` is informational and
  // safe to project.
  const adapter = new AntigravityAdapter();
  const result = adapter.estimateAvailableLrt(
    {
      provider: "antigravity",
      model: "gemini-2.5-pro",
      sourceId: "x",
      nativeUnit: "percent_window",
      nativeRemaining: 0.25,
      nativeTotal: 1,
      nativeResetAt: null,
      confidence: "estimated",
      observedAt: "2026-05-11T10:00:00.000Z",
      raw: {},
    },
    { lrtPerFullWindow: 100_000, sampleCount: 3 },
  );
  assert.equal(result.lrtUsed, 0);
  assert.equal(result.lrtRemaining, 25_000);
  assert.equal(result.confidence, "estimated");
});

test("estimateAvailableLrt is safe across repeated heartbeats (no LRT overcharge)", () => {
  // Spot-check guard against the LivelyPeak overcharge finding:
  // ten consecutive snapshots at the same percent_remaining must
  // each report lrtUsed=0 so the server's lrt_total += lrt.lrtUsed
  // accumulator never grows on a stable lane.
  const adapter = new AntigravityAdapter();
  const baseSnapshot = {
    provider: "antigravity",
    model: "gemini-2.5-pro",
    sourceId: "x",
    nativeUnit: "percent_window" as const,
    nativeRemaining: 0.3,
    nativeTotal: 1,
    nativeResetAt: null,
    confidence: "estimated" as const,
    observedAt: "2026-05-11T10:00:00.000Z",
    raw: {},
  };
  for (let i = 0; i < 10; i++) {
    const result = adapter.estimateAvailableLrt(baseSnapshot, {
      lrtPerFullWindow: 100_000,
      sampleCount: 12,
    });
    assert.equal(result.lrtUsed, 0, `tick ${i} reported non-zero lrtUsed`);
  }
});

test("estimateAvailableLrt upgrades confidence to calibrated after ≥10 samples", () => {
  const adapter = new AntigravityAdapter();
  const result = adapter.estimateAvailableLrt(
    {
      provider: "antigravity",
      model: "gemini-2.5-pro",
      sourceId: "x",
      nativeUnit: "percent_window",
      nativeRemaining: 0.5,
      nativeTotal: 1,
      nativeResetAt: null,
      confidence: "estimated",
      observedAt: "2026-05-11T10:00:00.000Z",
      raw: {},
    },
    { lrtPerFullWindow: 80_000, sampleCount: 15 },
  );
  assert.equal(result.confidence, "calibrated");
  assert.equal(result.lrtRemaining, 40_000);
  assert.equal(result.lrtUsed, 0);
});

test("estimateAvailableLrt clamps out-of-range percent_remaining for lrtRemaining", () => {
  const adapter = new AntigravityAdapter();
  const overshoot = adapter.estimateAvailableLrt(
    {
      provider: "antigravity",
      model: null,
      sourceId: "x",
      nativeUnit: "percent_window",
      nativeRemaining: 1.5,
      nativeTotal: 1,
      nativeResetAt: null,
      confidence: "estimated",
      observedAt: "2026-05-11T10:00:00.000Z",
      raw: {},
    },
    { lrtPerFullWindow: 100, sampleCount: 1 },
  );
  assert.equal(overshoot.lrtRemaining, 100);
  assert.equal(overshoot.lrtUsed, 0);

  const undershoot = adapter.estimateAvailableLrt(
    {
      provider: "antigravity",
      model: null,
      sourceId: "x",
      nativeUnit: "percent_window",
      nativeRemaining: -0.2,
      nativeTotal: 1,
      nativeResetAt: null,
      confidence: "estimated",
      observedAt: "2026-05-11T10:00:00.000Z",
      raw: {},
    },
    { lrtPerFullWindow: 100, sampleCount: 1 },
  );
  assert.equal(undershoot.lrtRemaining, 0);
  assert.equal(undershoot.lrtUsed, 0);
});

test("estimateLrtRemainingForWindow is a pure helper for the reconciler / UI", () => {
  // Available LRT projection should be a standalone helper too, so
  // the future server-side reconciler and any UI consumer share one
  // formula. Test the boundary cases directly.
  assert.equal(estimateLrtRemainingForWindow(0.5, 100_000), 50_000);
  assert.equal(estimateLrtRemainingForWindow(0, 100_000), 0);
  assert.equal(estimateLrtRemainingForWindow(1, 100_000), 100_000);
  assert.equal(estimateLrtRemainingForWindow(1.5, 100_000), 100_000);
  assert.equal(estimateLrtRemainingForWindow(-0.1, 100_000), 0);
  assert.equal(estimateLrtRemainingForWindow(0.5, null), null);
  assert.equal(estimateLrtRemainingForWindow(0.5, 0), null);
  assert.equal(estimateLrtRemainingForWindow(NaN, 100_000), null);
});

// ---------------------------------------------------------------------------
// readUsageDelta + computePercentWindowDelta
// ---------------------------------------------------------------------------

test("readUsageDelta returns a zero delta (Antigravity has no per-turn token log)", async () => {
  const adapter = new AntigravityAdapter();
  const delta = await adapter.readUsageDelta({
    sessionId: "rsess_1",
    workspaceMarker: "ws-1",
  });
  assert.equal(delta.inputTokens, 0);
  assert.equal(delta.outputTokens, 0);
  assert.equal(delta.heartbeats, 0);
});

test("computePercentWindowDelta returns the directional delta for the same lane", () => {
  const make = (id: string, pct: number): AntigravityLane => ({
    laneId: id,
    model: null,
    displayName: null,
    percentRemaining: pct,
    resetAt: null,
    lastEventAt: null,
  });
  const drop = computePercentWindowDelta(make("a", 1.0), make("a", 0.6));
  assert.ok(drop !== null && Math.abs(drop - -0.4) < 1e-9);
  const recovery = computePercentWindowDelta(make("a", 0.05), make("a", 0.95));
  assert.ok(recovery !== null && Math.abs(recovery - 0.9) < 1e-9);
});

test("computePercentWindowDelta returns null across lanes or with bad input", () => {
  const lane = {
    laneId: "a",
    model: null,
    displayName: null,
    percentRemaining: 0.5,
    resetAt: null,
    lastEventAt: null,
  };
  assert.equal(computePercentWindowDelta(null, lane), null);
  assert.equal(computePercentWindowDelta(lane, null), null);
  assert.equal(
    computePercentWindowDelta(lane, { ...lane, laneId: "b" }),
    null,
  );
  assert.equal(
    computePercentWindowDelta(lane, { ...lane, percentRemaining: NaN }),
    null,
  );
});
