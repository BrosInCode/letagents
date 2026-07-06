import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_READ_MESSAGES_LIMIT,
  selectRecentMessages,
} from "../server/tools/messages/read-tool.js";

function messages(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `msg_${index + 1}` }));
}

test("selectRecentMessages keeps only the most recent N messages", () => {
  const selection = selectRecentMessages(messages(5), 2);

  assert.deepEqual(selection.messages, [{ id: "msg_4" }, { id: "msg_5" }]);
  assert.equal(selection.total_message_count, 5);
  assert.equal(selection.omitted_message_count, 3);
});

test("selectRecentMessages returns everything when under the limit", () => {
  const selection = selectRecentMessages(messages(3), 10);

  assert.equal(selection.messages.length, 3);
  assert.equal(selection.omitted_message_count, 0);
});

test("selectRecentMessages treats limit 0 as full history", () => {
  const selection = selectRecentMessages(messages(DEFAULT_READ_MESSAGES_LIMIT + 50), 0);

  assert.equal(selection.messages.length, DEFAULT_READ_MESSAGES_LIMIT + 50);
  assert.equal(selection.omitted_message_count, 0);
});
