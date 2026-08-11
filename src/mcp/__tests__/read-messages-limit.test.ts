import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_MESSAGE_BODY_MAX_BYTES,
  AGENT_MESSAGE_OUTPUT_MAX_BYTES,
  boundAgentMessageOutput,
} from "../server/runtime/messages.js";

function messages(count: number, text = ""): Array<{ id: string; text: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg_${index + 1}`,
    text,
  }));
}

test("boundAgentMessageOutput keeps a prefix within the byte budget", () => {
  const selection = boundAgentMessageOutput(messages(100, "x".repeat(950_000)), {
    maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES,
  });

  assert.deepEqual(selection.messages.map((message) => (message as { id: string }).id), [
    "msg_1",
    "msg_2",
  ]);
  assert.equal(selection.truncated, true);
  assert.equal(selection.omittedMessageCount, 98);
  assert.ok(selection.outputBytes <= AGENT_MESSAGE_BODY_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: selection.messages }), "utf8")
    < AGENT_MESSAGE_OUTPUT_MAX_BYTES);
});

test("boundAgentMessageOutput keeps a suffix in chronological order", () => {
  const selection = boundAgentMessageOutput(messages(5, "x".repeat(700_000)), {
    direction: "suffix",
    maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES,
  });

  assert.deepEqual(selection.messages.map((message) => (message as { id: string }).id), [
    "msg_4",
    "msg_5",
  ]);
  assert.equal(selection.omittedMessageCount, 3);
});

test("boundAgentMessageOutput compacts one oversized message", () => {
  const selection = boundAgentMessageOutput(messages(1, "x".repeat(5_000_000)), {
    maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES,
  });

  assert.equal(selection.messages.length, 1);
  assert.equal((selection.messages[0] as { content_truncated?: boolean }).content_truncated, true);
  assert.ok(selection.outputBytes <= AGENT_MESSAGE_BODY_MAX_BYTES);
});
