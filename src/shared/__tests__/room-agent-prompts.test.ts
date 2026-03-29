import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRoomAgentPrompt,
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
} from "../room-agent-prompts.js";

test("normalizeAgentPromptKind accepts join, inline, and auto", () => {
  assert.equal(normalizeAgentPromptKind("join"), "join");
  assert.equal(normalizeAgentPromptKind("inline"), "inline");
  assert.equal(normalizeAgentPromptKind("auto"), "auto");
});

test("normalizeAgentPromptKind rejects unknown prompt kinds", () => {
  assert.equal(normalizeAgentPromptKind("bogus"), null);
  assert.equal(normalizeAgentPromptKind(undefined), null);
});

test("isPromptOnlyAgentMessage only hides empty prompt-bearing messages", () => {
  assert.equal(isPromptOnlyAgentMessage("", "auto"), true);
  assert.equal(isPromptOnlyAgentMessage("   ", "inline"), false);
  assert.equal(isPromptOnlyAgentMessage("hello", "inline"), false);
  assert.equal(isPromptOnlyAgentMessage("", "bogus"), false);
  assert.equal(isPromptOnlyAgentMessage("", null), false);
});

test("buildRoomAgentPrompt returns an auto reminder variant", () => {
  assert.match(buildRoomAgentPrompt("auto"), /Background reminder\./);
});
