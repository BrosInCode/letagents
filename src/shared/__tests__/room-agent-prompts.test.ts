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

test("buildRoomAgentPrompt keys thread replies off structured thread state", () => {
  const prompt = buildRoomAgentPrompt("join");

  assert.match(prompt, /thread\.is_thread_reply === true/);
  assert.match(prompt, /thread\.root_message_id/);
  assert.match(prompt, /treat the message as top-level/i);
  assert.doesNotMatch(prompt, /if a message includes `thread_parent_id`/i);
});

test("buildRoomAgentPrompt describes advisory activation metadata", () => {
  const prompt = buildRoomAgentPrompt("join");

  assert.match(prompt, /activation\.for_current_agent\.decision/);
  assert.match(prompt, /`silent` means terminate silently with no room message/);
  assert.match(prompt, /`unclear` means use the rest of the message\/thread\/task context/);
});
