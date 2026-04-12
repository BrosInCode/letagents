import assert from "node:assert/strict";
import test from "node:test";

import {
  tokensToComputeUnits,
  getModelCURate,
  getModelDisplayName,
  isKnownModel,
  CU_CONVERSION,
} from "../compute-units.js";

test("tokensToComputeUnits converts Haiku tokens 1:1", () => {
  const cu = tokensToComputeUnits("claude-haiku-3-5", 1000, 500);
  assert.equal(cu, 1000 * 1 + 500 * 1);
  assert.equal(cu, 1500);
});

test("tokensToComputeUnits converts Opus 4.6 at 15x rate", () => {
  const cu = tokensToComputeUnits("claude-opus-4-6", 1000, 500);
  assert.equal(cu, 1000 * 15 + 500 * 15);
  assert.equal(cu, 22500);
});

test("tokensToComputeUnits handles GPT models with different input/output rates", () => {
  const cu = tokensToComputeUnits("gpt-4o", 1000, 1000);
  assert.equal(cu, 1000 * 3 + 1000 * 4);
  assert.equal(cu, 7000);
});

test("tokensToComputeUnits defaults to 1:1 for unknown models", () => {
  const cu = tokensToComputeUnits("unknown-model-xyz", 1000, 500);
  assert.equal(cu, 1500);
});

test("tokensToComputeUnits handles zero tokens", () => {
  assert.equal(tokensToComputeUnits("claude-opus-4-6", 0, 0), 0);
});

test("tokensToComputeUnits handles input-only", () => {
  const cu = tokensToComputeUnits("claude-sonnet-4", 1000, 0);
  assert.equal(cu, 3000);
});

test("tokensToComputeUnits handles output-only", () => {
  const cu = tokensToComputeUnits("claude-sonnet-4", 0, 1000);
  assert.equal(cu, 3000);
});

test("getModelCURate returns rate for known model", () => {
  const rate = getModelCURate("claude-opus-4-6");
  assert.deepEqual(rate, { input: 15, output: 15 });
});

test("getModelCURate returns null for unknown model", () => {
  assert.equal(getModelCURate("nonexistent"), null);
});

test("getModelDisplayName returns human name for known model", () => {
  assert.equal(getModelDisplayName("claude-opus-4-6"), "Claude Opus 4.6");
  assert.equal(getModelDisplayName("gpt-4o"), "GPT-4o");
});

test("getModelDisplayName returns raw identifier for unknown model", () => {
  assert.equal(getModelDisplayName("my-custom-model"), "my-custom-model");
});

test("isKnownModel returns true for all defined models", () => {
  for (const model of Object.keys(CU_CONVERSION)) {
    assert.equal(isKnownModel(model), true, `Expected ${model} to be known`);
  }
});

test("isKnownModel returns false for unknown model", () => {
  assert.equal(isKnownModel("not-a-model"), false);
});

test("all models in CU_CONVERSION have positive rates", () => {
  for (const [model, rate] of Object.entries(CU_CONVERSION)) {
    assert.ok(rate.input > 0, `${model} input rate must be positive`);
    assert.ok(rate.output > 0, `${model} output rate must be positive`);
  }
});
