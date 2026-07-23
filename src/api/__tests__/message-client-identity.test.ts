import assert from "node:assert/strict";
import test from "node:test";

import type { MessageRow } from "../db/types/messages.js";

const row: MessageRow = {
  room_id: "room_1",
  number: 42,
  reply_to_number: null,
  thread_root_number: null,
  sender: "GardenSignal",
  text: "Done.",
  agent_prompt_kind: null,
  source: "agent",
  client_message_id: "supervised-room:supervised_garden:msg_41:reply:v1",
  timestamp: "2026-07-22T10:00:00.000Z",
};

test("message projections preserve the caller-owned durable publication identity", async () => {
  process.env.DB_URL ||= "postgresql://postgres:postgres@localhost:5432/letagents";
  const { toMessage, toMessageWithReply } = await import("../db/mappers.js");
  assert.equal(toMessage(row).client_message_id, row.client_message_id);
  assert.equal(toMessageWithReply(row, null).client_message_id, row.client_message_id);
});
