/**
 * Tests for the Cursor meter adapter (p2.7 desktop slice).
 *
 * Covers:
 *   - capabilities (estimated, lane recovery, no Tier 2 continuity)
 *   - discoverSources: additionalPaths first, dedup, missing paths skipped
 *   - parseCursorUsageDocument: happy path + tolerance for missing pieces
 *   - pickPrimaryModel preference (highest requests_used, lex tie-break)
 *   - readNativeQuota: nativeRemaining computed from premium counts,
 *     nativeResetAt picked from billing cycle, raw payload preserves
 *     primary/premium/spend/billing/allModels
 *   - readUsageDelta returns zero delta (per overcharge guard)
 *   - estimateAvailableLrt: holds lrtUsed=0 until server-side reconciler,
 *     projects lrtRemaining when calibration present, upgrades confidence
 *     after ≥10 samples
 *   - modelFilter restricts to a subset
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CURSOR_CAPABILITIES,
  CURSOR_PROVIDER,
  CursorAdapter,
  defaultCursorUsagePaths,
  parseCursorUsageDocument,
  pickPrimaryModel,
  type CursorPerModelEntry,
} from "../rental/adapters/cursor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "__fixtures__",
  "cursor-usage-snapshot.json",
);

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

test("CursorAdapter advertises request-based capabilities", () => {
  const adapter = new CursorAdapter();
  assert.equal(adapter.provider, CURSOR_PROVIDER);
  assert.equal(adapter.capabilities, CURSOR_CAPABILITIES);
  assert.equal(adapter.capabilities.supportsExact, false);
  assert.equal(adapter.capabilities.supportsLaneRecovery, true);
  assert.equal(adapter.capabilities.supportsTier2Continuity, false);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("defaultCursorUsagePaths returns platform-specific candidates", () => {
  const paths = defaultCursorUsagePaths("/tmp/cursor-home");
  assert.ok(paths.length >= 1);
  assert.ok(
    paths.some(
      (p) => p.includes("/tmp/cursor-home") || p.includes("\\tmp\\cursor-home"),
    ),
  );
});

test("discoverSources returns existing additionalPaths first + dedups", async () => {
  const adapter = new CursorAdapter({
    additionalPaths: [FIXTURE_PATH, FIXTURE_PATH],
  });
  const sources = await adapter.discoverSources();
  const matching = sources.filter((s) => s.pathHint === FIXTURE_PATH);
  assert.equal(matching.length, 1);
  assert.equal(sources[0]?.kind, "json");
  assert.match(sources[0]?.id ?? "", /^cursor-usage:/);
});

test("discoverSources skips paths that do not exist", async () => {
  const adapter = new CursorAdapter({
    additionalPaths: ["/definitely/nonexistent/cursor.json"],
    homeDirOverride: "/definitely/nonexistent/home",
  });
  const sources = await adapter.discoverSources();
  assert.deepEqual(sources, []);
});

// ---------------------------------------------------------------------------
// parseCursorUsageDocument
// ---------------------------------------------------------------------------

test("parseCursorUsageDocument loads the fixture cleanly", async () => {
  const adapter = new CursorAdapter();
  const doc = await adapter.parseUsageFile(FIXTURE_PATH);
  assert.ok(doc);
  assert.equal(doc!.version, 1);
  assert.equal(doc!.observedAt, "2026-05-11T10:00:00.000Z");
  assert.equal(doc!.premium!.requestsUsed, 320);
  assert.equal(doc!.premium!.requestsTotal, 500);
  assert.equal(doc!.spend!.centsUsed, 412);
  assert.equal(doc!.byModel.length, 3);
  assert.equal(doc!.billingCycle!.resetsAt, "2026-06-01T00:00:00.000Z");
});

test("parseCursorUsageDocument is tolerant of missing optional fields", () => {
  const doc = parseCursorUsageDocument({
    version: 1,
    premium: { requests_used: 10 },
    by_model: [],
  });
  assert.ok(doc);
  assert.equal(doc!.observedAt, null);
  assert.equal(doc!.billingCycle, null);
  assert.equal(doc!.premium!.requestsTotal, null);
  assert.equal(doc!.spend, null);
  assert.deepEqual(doc!.byModel, []);
});

test("parseCursorUsageDocument rejects unrecognized shapes", () => {
  assert.equal(parseCursorUsageDocument(null), null);
  assert.equal(parseCursorUsageDocument(42), null);
  assert.equal(parseCursorUsageDocument("nope"), null);
  assert.equal(parseCursorUsageDocument({}), null);
  assert.equal(parseCursorUsageDocument({ version: "1" }), null);
});

test("parseCursorUsageDocument tolerates malformed by_model entries", () => {
  const doc = parseCursorUsageDocument({
    version: 1,
    by_model: [
      { model: "claude", requests_used: 5, cents_used: 10 },
      { model: "", requests_used: 1 }, // bad model
      { requests_used: 99 },           // missing model
      "not-an-object",                  // bad row
      { model: "gpt-4o", requests_used: "bogus", cents_used: -5 },
    ],
  });
  assert.equal(doc!.byModel.length, 2);
  // Bogus number coerces to 0; negative cents coerces to 0.
  const gpt = doc!.byModel.find((m) => m.model === "gpt-4o");
  assert.ok(gpt);
  assert.equal(gpt!.requestsUsed, 0);
  assert.equal(gpt!.centsUsed, 0);
});

test("parseUsageFile returns null when JSON is malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letagents-rent-cursor-"));
  const path = join(dir, "bad.json");
  await writeFile(path, "{ not valid", "utf8");
  const adapter = new CursorAdapter();
  const doc = await adapter.parseUsageFile(path);
  assert.equal(doc, null);
});

// ---------------------------------------------------------------------------
// pickPrimaryModel
// ---------------------------------------------------------------------------

test("pickPrimaryModel picks highest requests_used; lex tie-break for stability", () => {
  const models: CursorPerModelEntry[] = [
    { model: "claude-3.7-sonnet", requestsUsed: 240, centsUsed: 240 },
    { model: "gpt-4o", requestsUsed: 60, centsUsed: 120 },
    { model: "claude-3-haiku", requestsUsed: 20, centsUsed: 52 },
  ];
  assert.equal(pickPrimaryModel(models)?.model, "claude-3.7-sonnet");

  // Tie: model names compared lexicographically.
  const tied: CursorPerModelEntry[] = [
    { model: "b-model", requestsUsed: 10, centsUsed: 0 },
    { model: "a-model", requestsUsed: 10, centsUsed: 0 },
  ];
  assert.equal(pickPrimaryModel(tied)?.model, "a-model");

  assert.equal(pickPrimaryModel([]), null);
});

// ---------------------------------------------------------------------------
// readNativeQuota
// ---------------------------------------------------------------------------

test("readNativeQuota produces a request-unit snapshot from the fixture", async () => {
  const adapter = new CursorAdapter({ additionalPaths: [FIXTURE_PATH] });
  const sources = await adapter.discoverSources();
  const snap = await adapter.readNativeQuota(sources[0]!);
  assert.ok(snap);
  assert.equal(snap!.provider, "cursor");
  assert.equal(snap!.nativeUnit, "requests");
  assert.equal(snap!.nativeRemaining, 180); // 500 - 320
  assert.equal(snap!.nativeTotal, 500);
  assert.equal(snap!.nativeResetAt, "2026-06-01T00:00:00.000Z");
  assert.equal(snap!.model, "claude-3.7-sonnet");
  assert.equal(snap!.confidence, "estimated");
  const raw = snap!.raw as { primaryModel: { model: string }; allModels: unknown[] };
  assert.equal(raw.primaryModel.model, "claude-3.7-sonnet");
  assert.equal(raw.allModels.length, 3);
});

test("readNativeQuota returns null when the source is not json", async () => {
  const adapter = new CursorAdapter();
  const snap = await adapter.readNativeQuota({
    id: "x",
    label: "x",
    kind: "jsonl",
    pathHint: FIXTURE_PATH,
    lastSeenAt: null,
  });
  assert.equal(snap, null);
});

test("readNativeQuota falls back gracefully when premium block is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letagents-rent-cursor-no-premium-"));
  const path = join(dir, "usage.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      observed_at: "2026-05-11T10:00:00.000Z",
      by_model: [
        { model: "claude-3.7-sonnet", requests_used: 10, cents_used: 5 },
      ],
    }),
    "utf8",
  );
  const adapter = new CursorAdapter({ additionalPaths: [path] });
  const [source] = await adapter.discoverSources();
  const snap = await adapter.readNativeQuota(source!);
  assert.ok(snap);
  // No premium block → remaining / total are null but model + raw payload still populated.
  assert.equal(snap!.nativeRemaining, null);
  assert.equal(snap!.nativeTotal, null);
  assert.equal(snap!.model, "claude-3.7-sonnet");
});

test("modelFilter restricts which models are eligible", async () => {
  const adapter = new CursorAdapter({
    additionalPaths: [FIXTURE_PATH],
    modelFilter: ["claude-3-haiku"],
  });
  const [source] = await adapter.discoverSources();
  const snap = await adapter.readNativeQuota(source!);
  assert.ok(snap);
  const raw = snap!.raw as { primaryModel: { model: string }; allModels: unknown[] };
  assert.equal(raw.primaryModel.model, "claude-3-haiku");
  assert.equal(raw.allModels.length, 1);
});

// ---------------------------------------------------------------------------
// readUsageDelta + estimateAvailableLrt
// ---------------------------------------------------------------------------

test("readUsageDelta returns a zero delta (server reconciles from snapshots)", async () => {
  const adapter = new CursorAdapter();
  const delta = await adapter.readUsageDelta({
    sessionId: "rsess_1",
    workspaceMarker: "ws-1",
  });
  assert.equal(delta.requests, 0);
  assert.equal(delta.inputTokens, 0);
  assert.equal(delta.heartbeats, 0);
});

test("estimateAvailableLrt holds lrtUsed=0 even with calibration (delta-only contract)", async () => {
  const adapter = new CursorAdapter({ additionalPaths: [FIXTURE_PATH] });
  const [source] = await adapter.discoverSources();
  const snapshot = (await adapter.readNativeQuota(source!))!;
  const result = adapter.estimateAvailableLrt(snapshot, {
    lrtPerFullWindow: 100_000,
    sampleCount: 5,
  });
  // remaining / total = 180 / 500 = 0.36 → 36_000 LRT remaining.
  assert.equal(result.lrtUsed, 0);
  assert.equal(result.lrtRemaining, 36_000);
  assert.equal(result.confidence, "estimated");
});

test("estimateAvailableLrt returns null lrtRemaining without calibration", async () => {
  const adapter = new CursorAdapter({ additionalPaths: [FIXTURE_PATH] });
  const [source] = await adapter.discoverSources();
  const snapshot = (await adapter.readNativeQuota(source!))!;
  const result = adapter.estimateAvailableLrt(snapshot, {
    lrtPerFullWindow: null,
    sampleCount: 0,
  });
  assert.equal(result.lrtUsed, 0);
  assert.equal(result.lrtRemaining, null);
});

test("estimateAvailableLrt upgrades confidence to calibrated after ≥10 samples", async () => {
  const adapter = new CursorAdapter({ additionalPaths: [FIXTURE_PATH] });
  const [source] = await adapter.discoverSources();
  const snapshot = (await adapter.readNativeQuota(source!))!;
  const result = adapter.estimateAvailableLrt(snapshot, {
    lrtPerFullWindow: 50_000,
    sampleCount: 12,
  });
  assert.equal(result.confidence, "calibrated");
  assert.equal(result.lrtUsed, 0);
});
