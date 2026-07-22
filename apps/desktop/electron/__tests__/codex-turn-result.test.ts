import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexTurnResultAccumulator,
  finalCodexAgentText,
} from "../main/agents/codex-turn-result.js";

test("normalizes recorded final and final_answer transcript variants", () => {
  assert.equal(finalCodexAgentText([
    { id: "old", type: "agentMessage", phase: "final", text: "Old answer" },
    { id: "new", type: "agentMessage", phase: "final_answer", text: "Hi 👋" },
  ]), "Hi 👋");
});

test("normalizes exact-turn delta-only output when the terminal snapshot has no answer item", () => {
  const results = new CodexTurnResultAccumulator();
  results.track("thread-1", "turn-1");
  results.observe("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "answer-1",
    delta: "Hel",
  });
  results.observe("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "answer-1",
    delta: "lo",
  });
  assert.deepEqual(results.normalize("thread-1", "turn-1", { id: "turn-1", status: "completed" }), {
    outcome: "reply",
    text: "Hello",
    evidence: "stream",
  });
});

test("classifies only the exact sentinel as no reply", () => {
  const results = new CodexTurnResultAccumulator();
  assert.deepEqual(results.normalize("thread-1", "turn-1", {
    id: "turn-1",
    status: "completed",
    items: [{ type: "agentMessage", phase: "final_answer", text: "LETAGENTS_NO_ROOM_REPLY" }],
  }), { outcome: "no_reply", text: null, evidence: "transcript" });
  assert.deepEqual(results.normalize("thread-1", "turn-2", {
    id: "turn-2",
    status: "completed",
    items: [{ type: "agentMessage", phase: "final_answer", text: "LETAGENTS_NO_ROOM_REPLY\nextra" }],
  }), { outcome: "reply", text: "LETAGENTS_NO_ROOM_REPLY\nextra", evidence: "transcript" });
});

test("preserves unknown and empty completed shapes as unreadable evidence", () => {
  const results = new CodexTurnResultAccumulator();
  assert.deepEqual(results.normalize("thread-1", "turn-empty", {
    id: "turn-empty",
    status: "completed",
    items: [{ type: "agentMessage", phase: "mystery", text: "provider changed shape" }],
  }), { outcome: "unreadable", text: null, evidence: "none" });
});

test("never mixes stream evidence between turns", () => {
  const results = new CodexTurnResultAccumulator();
  results.track("thread-1", "other-turn");
  results.observe("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "other-turn",
    itemId: "answer",
    delta: "Wrong answer",
  });
  assert.deepEqual(results.normalize("thread-1", "target-turn", {
    id: "target-turn",
    status: "completed",
  }), { outcome: "unreadable", text: null, evidence: "none" });
});

test("ignores interactive turn streams that were never claimed as bounded work", () => {
  const results = new CodexTurnResultAccumulator();
  results.observe("item/agentMessage/delta", {
    threadId: "interactive-thread",
    turnId: "interactive-turn",
    itemId: "answer",
    delta: "must not be retained",
  });
  assert.deepEqual(results.normalize("interactive-thread", "interactive-turn", {
    id: "interactive-turn",
    status: "completed",
  }), { outcome: "unreadable", text: null, evidence: "none" });
});
