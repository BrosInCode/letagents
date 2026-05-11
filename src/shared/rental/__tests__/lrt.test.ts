import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LRT_WEIGHTS,
  STOP_THRESHOLD_BY_CONFIDENCE,
  compareConfidence,
  computeLrt,
  effectiveLrtCeiling,
  estimateLrtFromPercentWindow,
  isExactConfidence,
  resolveWeights,
} from "../lrt.js";
import type { UsageDelta } from "../meter-types.js";

function emptyDelta(): UsageDelta {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    credits: 0,
    usd: 0,
    toolCalls: 0,
    commandRuns: 0,
  };
}

test("computeLrt applies the §17.3 token weights for an exact log delta", () => {
  const delta: UsageDelta = {
    ...emptyDelta(),
    inputTokens: 1_000,
    outputTokens: 500,
    cacheCreationTokens: 2_000,
    cacheReadTokens: 10_000,
    reasoningTokens: 250,
  };
  const expected =
    1_000 * DEFAULT_LRT_WEIGHTS.input
    + 500 * DEFAULT_LRT_WEIGHTS.output
    + 2_000 * DEFAULT_LRT_WEIGHTS.cacheCreation
    + 10_000 * DEFAULT_LRT_WEIGHTS.cacheRead
    + 250 * DEFAULT_LRT_WEIGHTS.reasoning;
  assert.equal(computeLrt(delta, "claude_code"), expected);
});

test("computeLrt clamps negative components to zero (meter reset is not a refund)", () => {
  const delta: UsageDelta = {
    ...emptyDelta(),
    inputTokens: -100,
    outputTokens: 500,
  };
  assert.equal(computeLrt(delta, "claude_code"), 500 * DEFAULT_LRT_WEIGHTS.output);
});

test("PROVIDER_LRT_WEIGHTS leaves request weight at default for Cursor (no placeholder)", () => {
  // V1 ships no baked-in non-zero request weight for Cursor — adapters
  // calibrate via the per-session override (see next test). This guards
  // against accidentally re-introducing a hard-coded placeholder.
  const w = resolveWeights("cursor");
  assert.equal(w.request, DEFAULT_LRT_WEIGHTS.request, "no baked-in Cursor request weight");
  assert.equal(w.input, DEFAULT_LRT_WEIGHTS.input, "non-overridden weights fall back to defaults");

  const delta: UsageDelta = {
    ...emptyDelta(),
    requests: 3,
  };
  // Without a calibrated override, request-based deltas contribute 0 LRT.
  assert.equal(computeLrt(delta, "cursor"), 0);
});

test("computeLrt applies calibratedWeights override at session/adapter level", () => {
  // The meter adapter discovers, via CalibrationHistory, that this Cursor
  // lane averages ~37 LRT per request. It passes that override to
  // computeLrt for this session only — no global hard-coding.
  const delta: UsageDelta = {
    ...emptyDelta(),
    requests: 3,
  };
  assert.equal(computeLrt(delta, "cursor", { request: 37 }), 3 * 37);
});

test("calibratedWeights precedence — session override beats provider default", () => {
  // Even if we add a provider override later, the per-session calibration
  // wins. This is the contract Budget Sentinel relies on.
  const delta: UsageDelta = { ...emptyDelta(), outputTokens: 100 };
  assert.equal(
    computeLrt(delta, "claude_code", { output: 8 }),
    100 * 8,
    "calibrated override replaces provider/default output weight",
  );
});

test("computeLrt falls back to default weights for unknown providers", () => {
  const delta: UsageDelta = { ...emptyDelta(), outputTokens: 100 };
  assert.equal(
    computeLrt(delta, "some_new_ide_we_havent_seen"),
    100 * DEFAULT_LRT_WEIGHTS.output,
  );
});

test("estimateLrtFromPercentWindow follows the §17.4 calibration shape", () => {
  // Closed-form math: 160k LRT observed at 32% used (68% remaining).
  //   percent_used = 0.32
  //   window_total = 160_000 / 0.32 = 500_000
  //   remaining    = 500_000 × 0.68 = 340_000
  //
  // Floating-point arithmetic produces a tiny error vs the integer answer,
  // so the test asserts within a 1-LRT tolerance rather than strict equality.
  const observedThisWindow = 160_000;
  const percentRemainingNow = 0.68;
  const estimate = estimateLrtFromPercentWindow(percentRemainingNow, observedThisWindow);
  assert.ok(estimate !== null, "estimate should be defined for valid inputs");
  assert.ok(
    Math.abs((estimate as number) - 340_000) < 1,
    `estimate ${estimate} should be within 1 LRT of 340_000`,
  );
});

test("estimateLrtFromPercentWindow returns null for nonsensical inputs", () => {
  assert.equal(estimateLrtFromPercentWindow(1.5, 1_000), null, "percent > 1 is rejected");
  assert.equal(estimateLrtFromPercentWindow(-0.1, 1_000), null, "negative percent is rejected");
  assert.equal(estimateLrtFromPercentWindow(0.5, 0), null, "zero observation is rejected");
  assert.equal(estimateLrtFromPercentWindow(0.5, -1), null, "negative observation is rejected");
  assert.equal(estimateLrtFromPercentWindow(1.0, 100), null, "percent_used=0 has no denominator");
});

test("STOP_THRESHOLD_BY_CONFIDENCE encodes the §17.13 ladder", () => {
  // Sanity: exact tiers stop at 98%, unknown at 75%.
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.official_exact, 0.98);
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.local_exact, 0.98);
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.derived, 0.95);
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.calibrated, 0.92);
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.estimated, 0.87);
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.weak_estimate, 0.80);
  assert.equal(STOP_THRESHOLD_BY_CONFIDENCE.unknown, 0.75);

  // Monotonic: lower confidence ≤ higher confidence.
  assert.ok(STOP_THRESHOLD_BY_CONFIDENCE.unknown <= STOP_THRESHOLD_BY_CONFIDENCE.weak_estimate);
  assert.ok(STOP_THRESHOLD_BY_CONFIDENCE.weak_estimate <= STOP_THRESHOLD_BY_CONFIDENCE.estimated);
  assert.ok(STOP_THRESHOLD_BY_CONFIDENCE.estimated <= STOP_THRESHOLD_BY_CONFIDENCE.calibrated);
  assert.ok(STOP_THRESHOLD_BY_CONFIDENCE.calibrated <= STOP_THRESHOLD_BY_CONFIDENCE.derived);
  assert.ok(STOP_THRESHOLD_BY_CONFIDENCE.derived <= STOP_THRESHOLD_BY_CONFIDENCE.local_exact);
});

test("effectiveLrtCeiling floors the budget × threshold product", () => {
  assert.equal(effectiveLrtCeiling(1_000_000, "local_exact"), 980_000);
  assert.equal(effectiveLrtCeiling(1_000_000, "estimated"), 870_000);
  assert.equal(effectiveLrtCeiling(1_000_000, "unknown"), 750_000);
});

test("effectiveLrtCeiling returns 0 for non-positive limits", () => {
  assert.equal(effectiveLrtCeiling(0, "local_exact"), 0);
  assert.equal(effectiveLrtCeiling(-100, "local_exact"), 0);
  assert.equal(effectiveLrtCeiling(Number.NaN, "local_exact"), 0);
});

test("compareConfidence orders the ladder correctly", () => {
  assert.ok(compareConfidence("local_exact", "unknown") > 0);
  assert.ok(compareConfidence("estimated", "official_exact") < 0);
  assert.equal(compareConfidence("derived", "derived"), 0);
});

test("isExactConfidence flags both vendor-exact and local-exact tiers", () => {
  assert.equal(isExactConfidence("official_exact"), true);
  assert.equal(isExactConfidence("local_exact"), true);
  assert.equal(isExactConfidence("derived"), false);
  assert.equal(isExactConfidence("estimated"), false);
  assert.equal(isExactConfidence("unknown"), false);
});
