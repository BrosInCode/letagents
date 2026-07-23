import assert from "node:assert/strict";
import test from "node:test";

import { mapRoomMessagePayload } from "../main/rooms/messages/mappers.js";

test("room message mapping preserves the durable client message identity", () => {
  const mapped = mapRoomMessagePayload({
    id: "msg_42",
    client_message_id: "supervised-room:supervised_garden:msg_41:reply:v1",
    sender: "GardenSignal",
    text: "Done.",
    timestamp: "2026-07-22T10:00:00.000Z",
  });

  assert.equal(
    mapped.clientMessageId,
    "supervised-room:supervised_garden:msg_41:reply:v1",
  );
});
