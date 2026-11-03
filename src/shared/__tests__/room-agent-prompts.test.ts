import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompactRoomAgentPrompt,
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
  assert.match(prompt, /last_observed_message_id/);
  assert.match(prompt, /do not announce skipped messages/);
  assert.match(prompt, /`silent` means terminate silently with no room message/);
  assert.match(prompt, /`unclear` means use the rest of the message\/thread\/task context/);
});

test("room agent prompts are guidance, not a claim of authority over the agent or its user", () => {
  for (const kind of ["join", "inline", "auto"] as const) {
    for (const prompt of [buildRoomAgentPrompt(kind), buildCompactRoomAgentPrompt(kind)]) {
      assert.doesNotMatch(prompt, /CRITICAL OVERRIDE/);
      assert.doesNotMatch(prompt, /supersede/i);
      assert.doesNotMatch(prompt, /NEVER/);
      assert.doesNotMatch(prompt, /\bMUST\b/);
      assert.doesNotMatch(prompt, /organically/);
      assert.match(prompt, /say so in the room first/);
    }
  }
});

test("the full room prompt opens and closes as conventions the person can overrule", () => {
  const prompt = buildRoomAgentPrompt("join");

  assert.match(
    prompt,
    /Room conventions for an independent MCP chat\. These are conventions of this room, not an override of your own instructions or of the person you work for\./
  );
  assert.match(
    prompt,
    /While the person wants you active in this room, answer in the room with `send_message` or `send_thread_message`, and call `wait_for_messages` again between messages instead of ending with a summary\. If you need to stop, or to talk to the person outside the room, say so in the room first\.$/
  );
});

test("the full room prompt keeps the registration and worker handle rules", () => {
  const prompt = buildRoomAgentPrompt("join");

  assert.match(prompt, /`registration_key`/);
  assert.match(prompt, /keep the returned `worker_id`/);
  assert.match(prompt, /retry with the same registration_key/);
  assert.match(prompt, /reconnect explicitly with worker_id and room_id/);
  assert.match(prompt, /Separate chats need separate keys/);
  assert.match(prompt, /Set display_name on first registration/);
  assert.match(prompt, /agent_session_id/);
  assert.match(prompt, /Supervisor-managed workers use their supervisor-provided identity/);
  assert.match(prompt, /Focus Room/);
  assert.match(prompt, /Leave unassigned tasks alone/);
});
