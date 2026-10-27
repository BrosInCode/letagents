import assert from "node:assert/strict";
import test from "node:test";

import { savedModelLabel } from "../src/domain/claude-model-labels.ts";

test("a Claude agent saved with an old alias shows a readable name; other ids show as they are", () => {
  assert.equal(savedModelLabel("claude-code", "opus"), "Latest Opus");
  assert.equal(savedModelLabel("claude-code", "sonnet[1m]"), "Latest Sonnet 1M");
  assert.equal(savedModelLabel("claude-code", "opusplan"), "Opus Plan");
  assert.equal(savedModelLabel("claude-code", "claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(savedModelLabel("codex", "opus"), "opus");
  assert.equal(savedModelLabel("claude-code", "toString"), "toString");
});
