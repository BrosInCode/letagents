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
    last_heartbeat_at: overrides.last_heartbeat_at ?? "2026-04-08T15:04:00.000Z",
    created_at: overrides.created_at ?? "2026-04-08T15:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-08T15:04:00.000Z",
    freshness: overrides.freshness ?? "active",
    activity_state: overrides.activity_state ?? "online",
    source_flags: overrides.source_flags ?? ["presence"],
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
  assert.equal(participants[0]?.activity_state, "online");
  assert.equal(participants[0]?.last_live_heartbeat_at, "2026-04-08T15:04:00.000Z");
  assert.equal(participants[1]?.participant_key, "human:login:emmymay");
  assert.equal(participants[1]?.kind, "human");
  assert.equal(participants[2]?.participant_key, "agent:gardenfern | emmymay's agent | agent");
  assert.equal(participants[2]?.owner_label, "EmmyMay");
  assert.equal(participants[2]?.activity_state, "historical");
  assert.deepEqual(participants[2]?.source_flags, ["messages"]);
});

test("buildFallbackRoomParticipants preserves presence-backed reachability when a newer message exists", () => {
  const actorLabel = "CrestPine | EmmyMay's agent | Agent";
  const participants = buildFallbackRoomParticipants({
    roomId: "github.com/brosincode/letagents",
    presence: [
      makePresence({
        actor_label: actorLabel,
        last_heartbeat_at: "2026-04-08T15:04:00.000Z",
        updated_at: "2026-04-08T15:04:00.000Z",
        activity_state: "online",
        source_flags: ["presence"],
      }),
    ],
    messages: [
      makeMessage({
        id: "msg_2",
        sender: actorLabel,
        source: "agent",
        text: "[status] still here",
        timestamp: "2026-04-08T15:05:00.000Z",
      }),
    ],
  });

  assert.equal(participants.length, 1);
  assert.equal(participants[0]?.participant_key, "agent:crestpine | emmymay's agent | agent");
  assert.equal(participants[0]?.activity_state, "online");
  assert.equal(participants[0]?.last_live_heartbeat_at, "2026-04-08T15:04:00.000Z");
  assert.equal(participants[0]?.last_room_activity_at, "2026-04-08T15:05:00.000Z");
  assert.equal(participants[0]?.last_seen_at, "2026-04-08T15:05:00.000Z");
  assert.deepEqual(participants[0]?.source_flags, ["presence", "messages"]);
});
