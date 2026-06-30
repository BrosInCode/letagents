import assert from "node:assert/strict";
import test from "node:test";
import { toAgentReadableMessages } from "../server/runtime/messages.js";

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  const id = typeof overrides.id === "string" ? overrides.id : "msg_1";
  return {
    id,
    sender: "EmmyMay",
    text: "Parent topic",
    agent_prompt_kind: null,
    source: "browser",
    timestamp: "2026-06-08T00:00:00.000Z",
    reply_to: null,
    thread_root_id: id,
    ...overrides,
  };
}

test("agent-readable messages count only explicit thread replies", () => {
  const [parent, quoteReply, threadReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Investigate this here" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "Quote reply",
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Investigate this here",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
    message({
      id: "msg_3",
      text: "Thread reply",
      thread_root_id: "msg_1",
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Investigate this here",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
  ]) as Array<Record<string, unknown>>;

  assert.equal(parent.thread_parent_id, "msg_1");
  assert.equal(parent.thread_root_id, "msg_1");
  assert.deepEqual(parent.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 1,
    latest_reply_id_in_result: "msg_3",
  });

  assert.equal(quoteReply.thread_parent_id, "msg_2");
  assert.equal(quoteReply.thread_root_id, "msg_2");
  assert.equal(quoteReply.thread_reply_to_id, null);
  assert.deepEqual(quoteReply.thread, {
    parent_id: "msg_2",
    root_message_id: "msg_2",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 0,
    latest_reply_id_in_result: null,
  });

  assert.equal(threadReply.thread_parent_id, "msg_1");
  assert.equal(threadReply.thread_root_id, "msg_1");
  assert.equal(threadReply.thread_reply_to_id, "msg_1");
  assert.deepEqual(threadReply.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: "msg_1",
    is_thread_reply: true,
    reply_count_in_result: 1,
    latest_reply_id_in_result: "msg_3",
  });
});

test("agent-readable messages keep nested thread replies on their explicit root", () => {
  const [, firstReply, nestedReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Root topic" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "Thread reply",
      thread_root_id: "msg_1",
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Root topic",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
    message({
      id: "msg_3",
      sender: "Claude",
      text: "Accidental nested reply",
      thread_root_id: "msg_1",
      reply_to: {
        id: "msg_2",
        sender: "Codex",
        text: "Thread reply",
        source: "agent",
        timestamp: "2026-06-08T00:01:00.000Z",
      },
    }),
  ]) as Array<Record<string, unknown>>;

  assert.equal(firstReply.thread_parent_id, "msg_1");
  assert.equal(firstReply.thread_reply_to_id, "msg_1");
  assert.equal(nestedReply.thread_parent_id, "msg_1");
  assert.equal(nestedReply.thread_root_id, "msg_1");
  assert.equal(nestedReply.thread_reply_to_id, "msg_2");
  assert.deepEqual(nestedReply.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: "msg_2",
    is_thread_reply: true,
    reply_count_in_result: 2,
    latest_reply_id_in_result: "msg_3",
  });
});

test("agent-readable messages use context ancestors without returning them", () => {
  const [nestedReply] = toAgentReadableMessages(
    [
      message({
        id: "msg_3",
        sender: "Claude",
        text: "New poll result",
        thread_root_id: "msg_1",
        reply_to: {
          id: "msg_2",
          sender: "Codex",
          text: "Earlier reply",
          source: "agent",
          timestamp: "2026-06-08T00:01:00.000Z",
        },
      }),
    ],
    [
      message({ id: "msg_1", text: "Original topic" }),
      message({
        id: "msg_2",
        sender: "Codex",
        text: "Earlier reply",
        thread_root_id: "msg_1",
        reply_to: {
          id: "msg_1",
          sender: "EmmyMay",
          text: "Original topic",
          source: "browser",
          timestamp: "2026-06-08T00:00:00.000Z",
        },
      }),
    ],
  ) as Array<Record<string, unknown>>;

  assert.equal(nestedReply.id, "msg_3");
  assert.equal(nestedReply.thread_parent_id, "msg_1");
  assert.equal(nestedReply.thread_root_id, "msg_1");
  assert.equal(nestedReply.thread_reply_to_id, "msg_2");
  assert.deepEqual(nestedReply.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: "msg_2",
    is_thread_reply: true,
    reply_count_in_result: 1,
    latest_reply_id_in_result: "msg_3",
  });
});

test("agent-readable messages do not synthesize threads from bare reply_to", () => {
  const [parent, quoteReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Quoted topic" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "Top-level quote reply",
      thread_root_id: undefined,
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Quoted topic",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
  ]) as Array<Record<string, unknown>>;

  assert.equal(parent.thread_parent_id, "msg_1");
  assert.deepEqual(parent.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 0,
    latest_reply_id_in_result: null,
  });

  assert.equal(quoteReply.thread_parent_id, "msg_2");
  assert.equal(quoteReply.thread_root_id, "msg_2");
  assert.equal(quoteReply.thread_reply_to_id, null);
  assert.equal((quoteReply.reply_to as { id?: string } | null)?.id, "msg_1");
  assert.deepEqual(quoteReply.thread, {
    parent_id: "msg_2",
    root_message_id: "msg_2",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 0,
    latest_reply_id_in_result: null,
  });
});
