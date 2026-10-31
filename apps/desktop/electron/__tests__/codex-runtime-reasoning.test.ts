import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-codex-runtime-reasoning-", paths: [] });

const {
  summarizeCodexReasoningNotification,
  summarizeCodexRuntimeNotification,
} = await import("../main/agents/codex-runtime-reasoning.js");

test("desktop Codex runtime reasoning summaries accumulate readable app-server deltas", () => {
  const params = { threadId: "thread_reasoning", turnId: "turn_reasoning", itemId: "item_reasoning" };

  const part = summarizeCodexReasoningNotification({
    method: "item/reasoning/summaryPartAdded",
    params: { ...params, summaryIndex: 0 },
  });
  assert.equal(part?.summary, "Codex started a new reasoning summary section.");

  const first = summarizeCodexReasoningNotification({
    method: "item/reasoning/summaryTextDelta",
    params: { ...params, summaryIndex: 0, delta: "Checking the desktop " },
  });
  const second = summarizeCodexReasoningNotification({
    method: "item/reasoning/summaryTextDelta",
    params: { ...params, summaryIndex: 0, delta: "reasoning bridge." },
  });

  assert.equal(first?.summary, "Checking the desktop");
  assert.equal(second?.summary, "Checking the desktop reasoning bridge.");
  assert.equal(second?.status, "working");
  assert.match(second?.checking ?? "", /readable reasoning summary/);
});

test("desktop Codex runtime reasoning hides raw app-server reasoning text", () => {
  const summary = summarizeCodexRuntimeNotification({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread_raw_reasoning",
      turnId: "turn_raw_reasoning",
      itemId: "item_raw_reasoning",
      contentIndex: 0,
      delta: "private raw reasoning should not leak",
    },
  });

  assert.equal(summary.summary, "Codex raw reasoning text is streaming.");
  assert.doesNotMatch(summary.checking, /private raw reasoning/);
  assert.doesNotMatch(summary.next_action, /private raw reasoning/);
});
