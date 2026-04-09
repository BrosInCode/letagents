import test from "node:test";
import assert from "node:assert/strict";

import { MessageBuffer, type BufferedMessage } from "../message-buffer.js";

interface TestMessage extends BufferedMessage {
  sender: string;
  text: string;
  timestamp: string;
}

function makeMessage(id: string): TestMessage {
  return {
    id,
    sender: "tester",
    text: id,
    timestamp: new Date().toISOString(),
  };
}

test("getBufferedMessages returns messages newer than a missing cursor", () => {
  const buffer = new MessageBuffer<TestMessage>({
    maxSize: 2,
    pollMessages: async () => ({ messages: [] }),
    fetchMessagesPage: async () => ({ messages: [] }),
  });

  buffer.recordMessages([makeMessage("msg_1"), makeMessage("msg_2"), makeMessage("msg_3")]);

  assert.deepEqual(
    buffer.getBufferedMessages("msg_1").map((message) => message.id),
    ["msg_2", "msg_3"]
  );
});

test("waitForMessages resolves when new buffered messages arrive", async () => {
  const buffer = new MessageBuffer<TestMessage>({
    pollMessages: async () => ({ messages: [] }),
    fetchMessagesPage: async () => ({ messages: [] }),
  });

  const waiting = buffer.waitForMessages("msg_1", 200);
  setTimeout(() => {
    buffer.recordMessages([makeMessage("msg_2")]);
  }, 20);

  const messages = await waiting;
  assert.deepEqual(messages.map((message) => message.id), ["msg_2"]);
});

test("waitForMessages returns an empty array on timeout", async () => {
  const buffer = new MessageBuffer<TestMessage>({
    pollMessages: async () => ({ messages: [] }),
    fetchMessagesPage: async () => ({ messages: [] }),
  });

  const messages = await buffer.waitForMessages("msg_9", 30);
  assert.deepEqual(messages, []);
});

test("canServeCursor returns false once the requested cursor has fallen behind eviction", () => {
  const buffer = new MessageBuffer<TestMessage>({
    maxSize: 2,
    pollMessages: async () => ({ messages: [] }),
    fetchMessagesPage: async () => ({ messages: [] }),
  });

  buffer.recordMessages([makeMessage("msg_2"), makeMessage("msg_3"), makeMessage("msg_4")]);

  assert.equal(buffer.canServeCursor("msg_1"), false);
  assert.equal(buffer.canServeCursor("msg_3"), true);
  assert.equal(buffer.canServeCursor("msg_4"), true);
});

test("canServeCursor returns false for cursors older than the activation seed", async () => {
  const buffer = new MessageBuffer<TestMessage>({
    pollMessages: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { messages: [] };
    },
    fetchMessagesPage: async () => ({ messages: [] }),
  });

  buffer.activate({ roomId: "room-1" }, "msg_100");
  buffer.recordMessages([makeMessage("msg_101"), makeMessage("msg_102")]);

  assert.equal(buffer.canServeCursor("msg_99"), false);
  assert.equal(buffer.canServeCursor("msg_100"), true);

  buffer.deactivate();
});

test("activate starts the background poller and paginates additional pages", async () => {
  let pollCount = 0;

  const buffer = new MessageBuffer<TestMessage>({
    pollMessages: async () => {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          messages: [makeMessage("msg_10")],
          has_more: true,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      return { messages: [] };
    },
    fetchMessagesPage: async () => ({
      messages: [makeMessage("msg_11")],
      has_more: false,
    }),
  });

  buffer.activate({ roomId: "room-1" });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (buffer.getBufferedMessages("msg_9").length === 2) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(
    buffer.getBufferedMessages("msg_9").map((message) => message.id),
    ["msg_10", "msg_11"]
  );

  buffer.deactivate();
});
