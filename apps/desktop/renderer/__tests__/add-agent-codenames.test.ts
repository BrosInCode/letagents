import assert from "node:assert/strict";
import test from "node:test";
import { suggestSupervisedCodexCodename } from "../src/domain/codenames";

test("sequential Codex creation requests receive distinct persisted display names", () => {
  const firstRequestId = "e730326a-2d7d-4898-b1a6-bdf14c3448ea";
  const secondRequestId = "cc9814d8-4dbd-419b-9db0-1b638e13e38e";
  const firstDisplayName = suggestSupervisedCodexCodename([], firstRequestId);
  const secondDisplayName = suggestSupervisedCodexCodename([firstDisplayName], secondRequestId);

  assert.notEqual(firstRequestId, secondRequestId);
  assert.notEqual(firstDisplayName, secondDisplayName);
  assert.doesNotMatch(firstDisplayName, /supervised agent/i);
  assert.doesNotMatch(secondDisplayName, /supervised agent/i);
});
