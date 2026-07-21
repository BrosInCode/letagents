import assert from "node:assert/strict";
import test from "node:test";
import { suggestSupervisedCodexCodename, supervisedAgentDisplayLabel } from "../src/domain/codenames";

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

test("concurrent codename collisions remain identity-safe without leaking launch UUIDs", () => {
  // These seeds select the same friendly base candidate. Concurrent launches
  // are still separated by their supervised entry id; the visible label is
  // deliberately allowed to remain human-sized.
  const firstRequestId = "request_00000005";
  const secondRequestId = "request_00000070";
  const firstDisplayName = suggestSupervisedCodexCodename([], firstRequestId);
  const secondDisplayName = suggestSupervisedCodexCodename([], secondRequestId);

  assert.equal(firstDisplayName.split(" · ")[0], secondDisplayName.split(" · ")[0]);
  assert.equal(firstDisplayName, secondDisplayName);
  assert.doesNotMatch(firstDisplayName, /000000/);
  assert.equal(
    supervisedAgentDisplayLabel(`CloudHaven · ${firstRequestId}`, `supervised_${firstRequestId}`),
    "CloudHaven",
  );
  assert.equal(
    supervisedAgentDisplayLabel(`CloudHaven · ${firstRequestId}`, `supervised_${secondRequestId}`),
    `CloudHaven · ${firstRequestId}`,
    "only the exact entry-owned suffix is hidden",
  );
});
