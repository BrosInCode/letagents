import assert from "node:assert/strict";
import test from "node:test";

import type { Message, RoomAgentPresence } from "../db.js";
import { buildFallbackRoomParticipants } from "../room-participant-fallback.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? "msg_1",
    sender: overrides.sender ?? "EmmyMay",
    text: overrides.text ?? "hello room",
    agent_prompt_kind: overrides.agent_prompt_kind ?? null,
    source: overrides.source ?? "browser",
    timestamp: overrides.timestamp ?? "2026-04-08T15:00:00.000Z",
    reply_to: overrides.reply_to ?? null,
  };
}

function makePresence(overrides: Partial<RoomAgentPresence> = {}): RoomAgentPresence {
  return {
    room_id: overrides.room_id ?? "github.com/brosincode/letagents",
    actor_label: overrides.actor_label ?? "CrestPine | EmmyMay's agent | Agent",
    agent_key: overrides.agent_key ?? "EmmyMay/crestpine",
    display_name: overrides.display_name ?? "CrestPine",
    owner_label: overrides.owner_label ?? "EmmyMay",
    ide_label: overrides.ide_label ?? "Agent",
    status: overrides.status ?? "idle",
    status_text: overrides.status_text ?? "watching the room",
    reasoning_trace: overrides.reasoning_trace ?? null,
    last_heartbeat_at: overrides.last_heartbeat_at ?? "2026-04-08T15:04:00.000Z",
    created_at: overrides.created_at ?? "2026-04-08T15:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-08T15:04:00.000Z",
    freshness: overrides.freshness ?? "active",
  };
}

test("buildFallbackRoomParticipants combines stored presence and browser activity into a canonical roster", () => {
  const participants = buildFallbackRoomParticipants({
    roomId: "github.com/brosincode/letagents",
    presence: [
      makePresence(),
    ],
    messages: [
      makeMessage({
        id: "msg_1",
        sender: "EmmyMay",
        source: "browser",
        timestamp: "2026-04-08T15:02:00.000Z",
      }),
      makeMessage({
        id: "msg_2",
        sender: "GardenFern | EmmyMay's agent | Agent",
        source: "agent",
        text: "[status] reviewing PR #167",
        timestamp: "2026-04-08T15:01:00.000Z",
      }),
    ],
  });

  assert.equal(participants.length, 3);
  assert.equal(participants[0]?.participant_key, "agent:crestpine | emmymay's agent | agent");
  assert.equal(participants[0]?.display_name, "CrestPine");
  assert.equal(participants[1]?.participant_key, "human:login:emmymay");
  assert.equal(participants[1]?.kind, "human");
  assert.equal(participants[2]?.participant_key, "agent:gardenfern | emmymay's agent | agent");
  assert.equal(participants[2]?.owner_label, "EmmyMay");
});
