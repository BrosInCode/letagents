import assert from "node:assert/strict";
import test from "node:test";
import { toAgentReadableMessages } from "../server/runtime/messages.js";

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg_1",
    sender: "EmmyMay",
    text: "Parent topic",
    agent_prompt_kind: null,
    source: "browser",
    timestamp: "2026-06-08T00:00:00.000Z",
    reply_to: null,
    ...overrides,
  };
}

// The next three fixtures carry no explicit thread_root_id (legacy / out-of-band
// shape that never went through the message mappers), so they exercise the GUARDED
// reply_to-walk fallback that still derives a thread root to preserve real threads.
test("agent-readable messages expose thread root metadata (reply_to fallback)", () => {
  const [parent, firstReply, secondReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Investigate this here" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "First thread reply",
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
      text: "Second thread reply",
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Investigate this here",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
  ]) as Array<Record<string, unknown>>;

  assert.equal("thread_parent_id" in parent, false);
  assert.equal("thread_root_id" in parent, false);
  assert.deepEqual(parent.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 2,
    latest_reply_id_in_result: "msg_3",
  });

  assert.equal(firstReply.thread_parent_id, "msg_1");
  assert.equal(firstReply.thread_root_id, "msg_1");
  assert.deepEqual(firstReply.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: "msg_1",
    is_thread_reply: true,
    reply_count_in_result: 2,
    latest_reply_id_in_result: "msg_3",
  });

  assert.equal(secondReply.thread_parent_id, "msg_1");
  assert.equal(secondReply.thread_reply_to_id, "msg_1");
});

test("agent-readable messages resolve nested replies to the thread root when available", () => {
  const [, firstReply, nestedReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Root topic" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "Thread reply",
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

test("agent-readable messages keep a bare quote-reply top-level via its explicit thread root", () => {
  // Post-#589 wire shape: every record carries an explicit thread_root_id. A bare
  // quote-reply has thread_root_id === its own id plus a thread_reply_to_id chip, so
  // it must stay top-level and must not inflate the quoted message's reply count.
  const [quoted, quoteReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Original message", thread_root_id: "msg_1" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "Quote reply",
      thread_root_id: "msg_2",
      thread_reply_to_id: "msg_1",
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Original message",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
  ]) as Array<Record<string, unknown>>;

  assert.equal("thread_root_id" in quoteReply, false);
  assert.equal("thread_reply_to_id" in quoteReply, false);
  assert.deepEqual(quoteReply.thread, {
    parent_id: "msg_2",
    root_message_id: "msg_2",
    reply_to_id: "msg_1",
    is_thread_reply: false,
    reply_count_in_result: 0,
    latest_reply_id_in_result: null,
  });
  // The quoted message accrues no phantom replies from the quote.
  assert.deepEqual(quoted.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 0,
    latest_reply_id_in_result: null,
  });
});

test("agent-readable messages thread a reply that carries an explicit thread root", () => {
  const [root, threadReply, quoteReply] = toAgentReadableMessages([
    message({ id: "msg_1", text: "Root topic", thread_root_id: "msg_1" }),
    message({
      id: "msg_2",
      sender: "Codex",
      text: "Real thread reply",
      thread_root_id: "msg_1",
      thread_reply_to_id: "msg_1",
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
      text: "Quote of the root",
      thread_root_id: "msg_3",
      thread_reply_to_id: "msg_1",
      reply_to: {
        id: "msg_1",
        sender: "EmmyMay",
        text: "Root topic",
        source: "browser",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    }),
  ]) as Array<Record<string, unknown>>;

  // Real thread reply belongs to msg_1's thread.
  assert.equal(threadReply.thread_root_id, "msg_1");
  assert.equal((threadReply.thread as Record<string, unknown>).is_thread_reply, true);
  // The quote of the root stays top-level (roots at itself).
  assert.equal("thread_root_id" in quoteReply, false);
  assert.equal((quoteReply.thread as Record<string, unknown>).is_thread_reply, false);
  // Only the real thread reply counts toward the root — the quote does not.
  assert.deepEqual(root.thread, {
    parent_id: "msg_1",
    root_message_id: "msg_1",
    reply_to_id: null,
    is_thread_reply: false,
    reply_count_in_result: 1,
    latest_reply_id_in_result: "msg_2",
  });
});
