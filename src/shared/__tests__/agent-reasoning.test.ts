import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAgentReasoningTrace } from "../agent-reasoning.js";

test("normalizeAgentReasoningTrace keeps the structured reasoning fields", () => {
  const trace = normalizeAgentReasoningTrace({
    summary: "Tracing how to show progress without transcript spam",
    goal: "Show reasoning state in-room",
    hypothesis: "Presence can hold the active trace",
    checking: "room presence payload shape",
    next_action: "wire MCP tool to presence",
    blocker: "waiting on UI lane shape",
    confidence: 0.734,
  });

  assert.deepEqual(trace, {
    summary: "Tracing how to show progress without transcript spam",
    goal: "Show reasoning state in-room",
    hypothesis: "Presence can hold the active trace",
    checking: "room presence payload shape",
    next_action: "wire MCP tool to presence",
    blocker: "waiting on UI lane shape",
    confidence: 0.73,
  });
});

test("normalizeAgentReasoningTrace derives a summary from other fields", () => {
  const trace = normalizeAgentReasoningTrace({
    goal: "Keep agent thinking visible",
    confidence: "0.4",
  });

  assert.deepEqual(trace, {
    summary: "Keep agent thinking visible",
    goal: "Keep agent thinking visible",
    hypothesis: null,
    checking: null,
    next_action: null,
    blocker: null,
    confidence: 0.4,
  });
});

test("normalizeAgentReasoningTrace rejects empty payloads", () => {
  assert.equal(normalizeAgentReasoningTrace(null), null);
  assert.equal(normalizeAgentReasoningTrace({}), null);
  assert.equal(normalizeAgentReasoningTrace({ summary: "   " }), null);
});
