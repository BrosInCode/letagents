import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER,
  CodexAdapter,
  defaultCodexSessionsDir,
  readUsageDeltaFromEvents,
  sumUsageEvents,
} from "../rental/adapters/codex.js";
import { AdapterRegistry } from "../rental/adapter-runtime.js";
import { computeAdapterLrt } from "../rental/adapter-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "..", "..", "__fixtures__", "codex-session.jsonl");

// Fixture has 3 token_count events:
//   event 1 cumulative total: input 1000, output 250, cache_r 400, reason 50
//   event 2 cumulative total: input 1600, output 350, cache_r 600, reason 75
//   event 3 direct delta    : input 200,  output 80,  cache_c 30, cache_r 70, reason 10
const EXPECTED_TOTALS = {
  inputTokens: 1_800,
  outputTokens: 430,
  cacheCreationTokens: 30,
  cacheReadTokens: 670,
  reasoningTokens: 85,
} as const;

test("CodexAdapter advertises local_exact-capable capabilities", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.provider, CODEX_PROVIDER);
  assert.equal(adapter.capabilities, CODEX_CAPABILITIES);
  assert.equal(adapter.capabilities.supportsExact, true);
  assert.equal(adapter.capabilities.supportsLaneRecovery, false);
  assert.equal(adapter.capabilities.supportsTier2Continuity, true);
});

test("defaultCodexSessionsDir points at ~/.codex/sessions", () => {
  assert.equal(defaultCodexSessionsDir("/tmp/home"), join("/tmp/home", ".codex", "sessions"));
});

test("discoverSources returns explicitly-passed Codex JSONL files", async () => {
  const adapter = new CodexAdapter({ homeDirOverride: "/tmp/no-codex-home", additionalPaths: [FIXTURE_PATH] });
  const sources = await adapter.discoverSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.kind, "jsonl");
  assert.equal(sources[0]?.pathHint, FIXTURE_PATH);
  assert.match(sources[0]?.label ?? "", /Codex session/);
});

test("parseSessionFile produces exactly the 3 token_count events from the fixture", async () => {
  const adapter = new CodexAdapter();
  const events = await adapter.parseSessionFile(FIXTURE_PATH);
  assert.equal(events.length, 3, "fixture has 3 token_count events plus non-usage/malformed lines");
  assert.equal(events[0]?.inputTokens, 1000);
  assert.equal(events[1]?.outputTokens, 100);
  assert.equal(events[2]?.cacheCreationTokens, 30);
});

test("parser carries model from turn_context and accepts nested payload.model", async () => {
  const adapter = new CodexAdapter();
  const events = await adapter.parseSessionFile(FIXTURE_PATH);
  assert.equal(events[0]?.model, "gpt-5.4-codex");
  assert.equal(events[1]?.model, "gpt-5.4-codex");
  assert.equal(events[2]?.model, "gpt-5.5-codex");
});

test("sumUsageEvents honors cumulative totals and direct deltas", async () => {
  const adapter = new CodexAdapter();
  const events = await adapter.parseSessionFile(FIXTURE_PATH);
  assert.deepEqual(sumUsageEvents(events), EXPECTED_TOTALS);
});

test("readNativeQuota produces local_exact snapshot with token totals on raw payload", async () => {
  const adapter = new CodexAdapter({ homeDirOverride: "/tmp/no-codex-home", additionalPaths: [FIXTURE_PATH] });
  const [source] = await adapter.discoverSources();
  assert.ok(source, "source should exist");
  const snapshot = await adapter.readNativeQuota(source);
  assert.ok(snapshot, "snapshot should be produced");
  assert.equal(snapshot.provider, CODEX_PROVIDER);
  assert.equal(snapshot.model, "gpt-5.5-codex");
  assert.equal(snapshot.confidence, "local_exact");
  assert.equal(snapshot.nativeUnit, "tokens");
  assert.equal(snapshot.nativeRemaining, null);
  const raw = snapshot.raw as {
    eventCount?: number;
    totals?: typeof EXPECTED_TOTALS;
    lastRateLimits?: { credits?: { remaining?: number } };
  };
  assert.equal(raw.eventCount, 3);
  assert.deepEqual(raw.totals, EXPECTED_TOTALS);
  assert.equal(raw.lastRateLimits?.credits?.remaining, 9.5);
});

test("readUsageDeltaFromEvents aggregates events into AdapterUsageDelta with zero non-token fields", async () => {
  const adapter = new CodexAdapter();
  const events = await adapter.parseSessionFile(FIXTURE_PATH);
  const delta = readUsageDeltaFromEvents(events);
  assert.equal(delta.inputTokens, EXPECTED_TOTALS.inputTokens);
  assert.equal(delta.outputTokens, EXPECTED_TOTALS.outputTokens);
  assert.equal(delta.cacheCreationTokens, EXPECTED_TOTALS.cacheCreationTokens);
  assert.equal(delta.cacheReadTokens, EXPECTED_TOTALS.cacheReadTokens);
  assert.equal(delta.reasoningTokens, EXPECTED_TOTALS.reasoningTokens);
  assert.equal(delta.requests, 0);
  assert.equal(delta.credits, 0);
  assert.equal(delta.usd, 0);
  assert.equal(delta.toolCalls, 0);
  assert.equal(delta.commandRuns, 0);
  assert.equal(delta.filesExposed, 0);
  assert.equal(delta.heartbeats, 0);
});

test("readUsageDeltaFromEvents uses last_token_usage deltas rather than cumulative totals for slices", async () => {
  const adapter = new CodexAdapter();
  const events = await adapter.parseSessionFile(FIXTURE_PATH);
  const delta = readUsageDeltaFromEvents(events.slice(1, 2));
  assert.equal(delta.inputTokens, 600);
  assert.equal(delta.outputTokens, 100);
  assert.equal(delta.cacheReadTokens, 200);
  assert.equal(delta.reasoningTokens, 25);
});

test("estimateAvailableLrt computes LRT used and remaining vs calibration", async () => {
  const adapter = new CodexAdapter({ homeDirOverride: "/tmp/no-codex-home", additionalPaths: [FIXTURE_PATH] });
  const [source] = await adapter.discoverSources();
  assert.ok(source);
  const snapshot = await adapter.readNativeQuota(source);
  assert.ok(snapshot);

  const expectedLrtUsed = computeAdapterLrt({
    inputTokens: EXPECTED_TOTALS.inputTokens,
    outputTokens: EXPECTED_TOTALS.outputTokens,
    cacheCreationTokens: EXPECTED_TOTALS.cacheCreationTokens,
    cacheReadTokens: EXPECTED_TOTALS.cacheReadTokens,
    reasoningTokens: EXPECTED_TOTALS.reasoningTokens,
    requests: 0,
    credits: 0,
    usd: 0,
    toolCalls: 0,
    commandRuns: 0,
    filesExposed: 0,
    heartbeats: 0,
  });

  const estimate = adapter.estimateAvailableLrt(snapshot, {
    lrtPerFullWindow: 100_000,
    sampleCount: 3,
  });

  assert.equal(estimate.lrtUsed, expectedLrtUsed);
  assert.equal(estimate.lrtRemaining, 100_000 - expectedLrtUsed);
  assert.equal(estimate.confidence, "local_exact");
});

test("AdapterRegistry accepts Codex adapter registration", () => {
  const registry = new AdapterRegistry();
  const adapter = new CodexAdapter();
  registry.register(adapter);
  assert.equal(registry.get(CODEX_PROVIDER), adapter);
  assert.equal(registry.list().length, 1);
});
