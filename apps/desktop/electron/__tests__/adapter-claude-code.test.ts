import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ClaudeCodeAdapter,
  readUsageDeltaFromTurns,
  sumTurns,
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_PROVIDER,
} from "../rental/adapters/claude-code.js";
import { AdapterRegistry } from "../rental/adapter-runtime.js";
import { computeAdapterLrt } from "../rental/adapter-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "..", "..", "__fixtures__", "claude-code-session.jsonl");

// Expected totals for the fixture (sum of all assistant turn usage):
//   input  : 1500 + 800 + 1200 + 600   = 4100
//   output : 420  + 650 + 880  + 300   = 2250
//   cache_c: 2000 + 0   + 500  + 0     = 2500
//   cache_r: 15000+18000+19500+21000   = 73500
//   reason : 0    + 0   + 150  + 60    = 210
const EXPECTED_TOTALS = {
  inputTokens: 4_100,
  outputTokens: 2_250,
  cacheCreationTokens: 2_500,
  cacheReadTokens: 73_500,
  reasoningTokens: 210,
} as const;

test("ClaudeCodeAdapter advertises local_exact-capable capabilities", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.provider, CLAUDE_CODE_PROVIDER);
  assert.equal(adapter.capabilities, CLAUDE_CODE_CAPABILITIES);
  assert.equal(adapter.capabilities.supportsExact, true);
  assert.equal(adapter.capabilities.supportsLaneRecovery, false);
  assert.equal(adapter.capabilities.supportsTier2Continuity, true);
});

test("discoverSources returns explicitly-passed paths only", async () => {
  const adapter = new ClaudeCodeAdapter({ additionalPaths: [FIXTURE_PATH] });
  const sources = await adapter.discoverSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.kind, "jsonl");
  assert.equal(sources[0]?.pathHint, FIXTURE_PATH);
});

test("parseSessionFile produces exactly the 4 assistant turns from the fixture", async () => {
  const adapter = new ClaudeCodeAdapter();
  const turns = await adapter.parseSessionFile(FIXTURE_PATH);
  assert.equal(turns.length, 4, "fixture has 4 assistant turns + 1 user turn (skipped)");
  assert.equal(turns[0]?.inputTokens, 1500);
  assert.equal(turns[0]?.outputTokens, 420);
  assert.equal(turns[2]?.reasoningTokens, 150);
});

test("parser reads model from top-level OR nested message.model (real Claude Code JSONL)", async () => {
  // Real Claude Code JSONL puts model on `message.model`. Our older
  // fixture had it top-level. The parser accepts either form,
  // preferring top-level when both are present.
  //
  // Fixture turns:
  //   turn[0] — top-level model only
  //   turn[1] — message.model only
  //   turn[2] — message.model only (with reasoning_tokens)
  //   turn[3] — message.model only
  const adapter = new ClaudeCodeAdapter();
  const turns = await adapter.parseSessionFile(FIXTURE_PATH);
  for (const turn of turns) {
    assert.equal(
      turn.model,
      "claude-3.7-sonnet",
      "every assistant turn should resolve to the same model regardless of placement",
    );
  }
});

test("parser writes a synthetic conflicting-model file and prefers top-level", async () => {
  // When both top-level `turn.model` and nested `turn.message.model` are
  // present, the parser should prefer the top-level value. This is the
  // documented precedence in the ClaudeCodeAssistantTurn JSDoc.
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmpDir = await mkdtemp(join(tmpdir(), "letagents-rent-test-"));
  const tmpPath = join(tmpDir, "conflict.jsonl");
  const conflictLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-11T10:00:00.000Z",
    model: "top-level-wins",
    message: {
      model: "nested-loses",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  await writeFile(tmpPath, conflictLine + "\n", "utf8");
  const adapter = new ClaudeCodeAdapter();
  const turns = await adapter.parseSessionFile(tmpPath);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.model, "top-level-wins");
});

test("sumTurns matches expected totals across the fixture", async () => {
  const adapter = new ClaudeCodeAdapter();
  const turns = await adapter.parseSessionFile(FIXTURE_PATH);
  const totals = sumTurns(turns);
  assert.deepEqual(totals, EXPECTED_TOTALS);
});

test("readNativeQuota produces local_exact snapshot with token totals on raw payload", async () => {
  const adapter = new ClaudeCodeAdapter();
  const source = (await adapter.discoverSources.call(
    new ClaudeCodeAdapter({ additionalPaths: [FIXTURE_PATH] }),
  ))[0];
  assert.ok(source, "source should exist");
  const snapshot = await adapter.readNativeQuota(source);
  assert.ok(snapshot, "snapshot should be produced");
  assert.equal(snapshot.provider, CLAUDE_CODE_PROVIDER);
  assert.equal(snapshot.confidence, "local_exact");
  assert.equal(snapshot.nativeUnit, "tokens");
  assert.equal(snapshot.nativeRemaining, null, "Claude Code local logs record consumed tokens, not remaining");
  assert.equal(snapshot.nativeResetAt, null);
  const totals = (snapshot.raw as { totals?: typeof EXPECTED_TOTALS }).totals;
  assert.deepEqual(totals, EXPECTED_TOTALS);
});

test("readUsageDeltaFromTurns aggregates turns into an AdapterUsageDelta with zero non-token fields", async () => {
  const adapter = new ClaudeCodeAdapter();
  const turns = await adapter.parseSessionFile(FIXTURE_PATH);
  const delta = readUsageDeltaFromTurns(turns);
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

test("estimateAvailableLrt computes LRT used via the §17.3 formula and remaining vs calibration", async () => {
  const adapter = new ClaudeCodeAdapter({ additionalPaths: [FIXTURE_PATH] });
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
    lrtPerFullWindow: 1_000_000,
    sampleCount: 5,
  });

  assert.equal(estimate.lrtUsed, expectedLrtUsed);
  assert.equal(estimate.lrtRemaining, 1_000_000 - expectedLrtUsed);
  assert.equal(estimate.confidence, "local_exact");
});

test("estimateAvailableLrt returns null remaining when calibration is missing", async () => {
  const adapter = new ClaudeCodeAdapter({ additionalPaths: [FIXTURE_PATH] });
  const [source] = await adapter.discoverSources();
  assert.ok(source);
  const snapshot = await adapter.readNativeQuota(source);
  assert.ok(snapshot);

  const estimate = adapter.estimateAvailableLrt(snapshot, {
    lrtPerFullWindow: null,
    sampleCount: 0,
  });
  assert.equal(estimate.lrtRemaining, null);
  assert.ok(estimate.lrtUsed > 0);
});

test("parser skips malformed lines and user turns without throwing", async () => {
  const adapter = new ClaudeCodeAdapter();
  const turns = await adapter.parseSessionFile(FIXTURE_PATH);
  // Fixture has 1 user turn and 0 malformed lines; assistant count = 4.
  assert.equal(turns.length, 4);
});

test("AdapterRegistry registers, retrieves, and lists adapters", () => {
  const registry = new AdapterRegistry();
  const a = new ClaudeCodeAdapter();
  registry.register(a);
  assert.equal(registry.get(CLAUDE_CODE_PROVIDER), a);
  assert.equal(registry.list().length, 1);
  registry.unregister(CLAUDE_CODE_PROVIDER);
  assert.equal(registry.get(CLAUDE_CODE_PROVIDER), null);
});

test("AdapterRegistry rejects double-registration for the same provider", () => {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter());
  assert.throws(
    () => registry.register(new ClaudeCodeAdapter()),
    /adapter already registered for provider: claude_code/,
  );
});
