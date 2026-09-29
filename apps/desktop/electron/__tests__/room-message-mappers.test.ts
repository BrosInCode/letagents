import assert from "node:assert/strict";
import test from "node:test";

import {
  mapCloudRoomMessagePayload,
  mapRoomMessagePayload,
  type RoomMessagePayload,
} from "../main/rooms/messages/mappers.js";

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

test("room message mapping preserves account routing authority and fails closed when malformed", () => {
  const base = {
    id: "msg_43",
    sender: "Human",
    text: "Continue",
    timestamp: "2026-07-22T10:00:01.000Z",
  };
  assert.deepEqual(mapRoomMessagePayload({
    ...base,
    account_agent_routing: {
      version: 1,
      authority: "receipts",
      recipient_agent_keys: ["owner/oak"],
      recipient_agent_sessions: [
        {
          agent_key: "owner/oak",
          agent_session_id: "agent_session_oak",
          successor_agent_session_id: "agent_session_oak_next",
        },
      ],
    },
  }).accountAgentRouting, {
    version: 1,
    authority: "receipts",
    recipientAgentKeys: ["owner/oak"],
    recipientSessions: [{
      agentKey: "owner/oak",
      agentSessionId: "agent_session_oak",
      successorAgentSessionId: "agent_session_oak_next",
    }],
    controlAuthorized: false,
  });
  assert.deepEqual(mapRoomMessagePayload({
    ...base,
    account_agent_routing: {
      version: 1,
      authority: "legacy",
      recipient_agent_keys: ["owner/cedar"],
      recipient_agent_sessions: [{
        agent_key: "owner/cedar",
        agent_session_id: "agent_session_cedar",
        activation_reason: "explicit_mention",
      }],
    },
  }).accountAgentRouting, {
    version: 1,
    authority: "legacy",
    recipientAgentKeys: ["owner/cedar"],
    recipientSessions: [{
      agentKey: "owner/cedar",
      agentSessionId: "agent_session_cedar",
      activationReason: "explicit_mention",
    }],
    controlAuthorized: false,
  });
  assert.deepEqual(mapRoomMessagePayload({
    ...base,
    account_agent_routing: {
      version: 1,
      authority: "legacy",
      thread_participant_agent_keys: ["owner/cedar"],
    },
  } as RoomMessagePayload).accountAgentRouting, { version: 1, authority: "invalid" });
  assert.deepEqual(mapRoomMessagePayload({
    ...base,
    account_agent_routing: {
      version: 2,
      authority: "receipts",
      recipient_agent_keys: [],
    },
  }).accountAgentRouting, { version: 1, authority: "invalid" });
  for (const recipient_agent_sessions of [
    [{ agent_key: "owner/oak", agent_session_id: "" }],
    [{ agent_key: "owner/cedar", agent_session_id: "agent_session_cedar" }],
    [],
  ]) {
    assert.deepEqual(mapRoomMessagePayload({
      ...base,
      account_agent_routing: {
        version: 1,
        authority: "receipts",
        recipient_agent_keys: ["owner/oak"],
        recipient_agent_sessions,
      },
    }).accountAgentRouting, { version: 1, authority: "invalid" });
  }
  for (const malformedLegacy of [
    {
      recipient_agent_keys: ["owner/oak"],
      recipient_agent_sessions: [{
        agent_key: "owner/oak",
        agent_session_id: "",
        activation_reason: "thread_participant",
      }],
    },
    {
      recipient_agent_keys: ["OWNER/OAK", " owner/oak "],
      recipient_agent_sessions: [
        {
          agent_key: "OWNER/OAK",
          agent_session_id: "agent_session_oak",
          activation_reason: "thread_participant",
        },
        {
          agent_key: "owner/oak",
          agent_session_id: "agent_session_oak_2",
          activation_reason: "thread_participant",
        },
      ],
    },
  ]) {
    assert.deepEqual(mapRoomMessagePayload({
      ...base,
      account_agent_routing: {
        version: 1,
        authority: "legacy",
        ...malformedLegacy,
      },
    }).accountAgentRouting, { version: 1, authority: "invalid" });
  }
  assert.deepEqual(mapRoomMessagePayload({
    ...base,
    account_agent_routing: {
      version: 1,
      authority: "receipts",
      recipient_agent_keys: ["owner/oak"],
    },
  }).accountAgentRouting, {
    version: 1,
    authority: "invalid",
  }, "a present key-only receipt wrapper fails closed; older servers omit the wrapper");
  assert.equal(mapRoomMessagePayload(base).accountAgentRouting, undefined);
  assert.deepEqual(mapCloudRoomMessagePayload(base).accountAgentRouting, {
    version: 1,
    authority: "invalid",
  }, "a cloud POST/SSE/poll response without the opted-in envelope fails closed");
});


test("readable system copy preserves canonical agent instructions in desktop messages and replies", () => {
  const text = "@agent:owner/lumen Board intent bi_123 was approved. Continue with board_intent_id.";
  const display_text = "@LumenRiver — Your request to claim task_19: “Tests and CI” was approved. You can continue.";
  const reply = { id: "msg_1", sender: "letagents", text, display_text, timestamp: "2026-09-07T00:00:00Z" };
  const mapped = mapRoomMessagePayload({ ...reply, id: "msg_2", reply_to: reply,
    thread: { root_message_id: "msg_1", latest_reply: reply, reply_count: 1 } });
  assert.equal(mapped.text, text);
  assert.equal(mapped.displayText, display_text);
  assert.equal(mapped.replyTo?.text, text);
  assert.equal(mapped.replyTo?.displayText, display_text);
  assert.equal(mapped.thread?.latestReply?.displayText, display_text);
});
