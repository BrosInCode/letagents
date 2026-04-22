import assert from "node:assert/strict";
import test from "node:test";

import { buildFallbackPresenceFromMessages, buildSyntheticPresenceEntry } from "../presence-fallback.js";
import type { Message } from "../db.js";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? "msg_1",
    sender: overrides.sender ?? "HollowOtter | EmmyMay's agent | Agent",
    text: overrides.text ?? "[status] working on task_70",
    agent_prompt_kind: overrides.agent_prompt_kind ?? null,
    source: overrides.source ?? "agent",
    timestamp: overrides.timestamp ?? "2026-04-08T01:45:00.000Z",
    reply_to: overrides.reply_to ?? null,
  };
}

test("buildFallbackPresenceFromMessages keeps the latest agent status per sender", () => {
  const messages: Message[] = [
    makeMessage({
      id: "msg_1",
      timestamp: "2026-04-08T01:40:00.000Z",
      text: "[status] working on task_69",
      sender: "GardenFern | EmmyMay's agent | Agent",
    }),
    makeMessage({
      id: "msg_2",
      timestamp: "2026-04-08T01:44:00.000Z",
      text: "[status] working on task_70",
      sender: "HollowOtter | EmmyMay's agent | Agent",
    }),
    makeMessage({
      id: "msg_3",
      timestamp: "2026-04-08T01:44:30.000Z",
      text: "[status] idle and watching the room",
      sender: "HollowOtter | EmmyMay's agent | Agent",
    }),
    makeMessage({
      id: "msg_4",
      timestamp: "2026-04-08T01:44:45.000Z",
      source: "browser",
      sender: "EmmyMay",
      text: "human note",
    }),
  ];

  const presence = buildFallbackPresenceFromMessages({
    roomId: "github.com/brosincode/letagents",
    messages,
    now: Date.parse("2026-04-08T01:45:00.000Z"),
  });

  assert.equal(presence.length, 2);
  assert.equal(presence[0]?.actor_label, "HollowOtter | EmmyMay's agent | Agent");
  assert.equal(presence[0]?.status, "idle");
  assert.equal(presence[0]?.status_text, "idle and watching the room");
  assert.equal(presence[0]?.display_name, "HollowOtter");
  assert.equal(presence[0]?.owner_label, "EmmyMay");
  assert.equal(presence[0]?.ide_label, "Agent");
  assert.equal(presence[0]?.freshness, "stale");
  assert.equal(presence[0]?.activity_state, "historical");
  assert.deepEqual(presence[0]?.source_flags, ["messages"]);
});

test("buildFallbackPresenceFromMessages marks older activity as stale", () => {
  const presence = buildFallbackPresenceFromMessages({
    roomId: "github.com/brosincode/letagents",
    messages: [
      makeMessage({
        id: "msg_1",
        sender: "SolarVista | EmmyMay's agent | Agent",
        text: "[status] reviewing PR #154",
        timestamp: "2026-04-08T00:00:00.000Z",
      }),
    ],
    now: Date.parse("2026-04-08T01:45:00.000Z"),
  });

  assert.equal(presence.length, 1);
  assert.equal(presence[0]?.status, "reviewing");
  assert.equal(presence[0]?.freshness, "stale");
  assert.equal(presence[0]?.activity_state, "historical");
});

test("buildFallbackPresenceFromMessages treats watch-mode and task-waiting updates as idle", () => {
  const presence = buildFallbackPresenceFromMessages({
    roomId: "github.com/brosincode/letagents",
    messages: [
      makeMessage({
        id: "msg_1",
        sender: "CrestPine | EmmyMay's agent | Agent",
        text: "[status] waiting for tasks",
        timestamp: "2026-04-08T14:38:00.000Z",
      }),
      makeMessage({
        id: "msg_2",
        sender: "SolarVista | EmmyMay's agent | Agent",
        text: "[status] back to room watch",
        timestamp: "2026-04-08T14:38:30.000Z",
      }),
      makeMessage({
        id: "msg_3",
        sender: "GardenFern | EmmyMay's agent | Agent",
        text: "[status] waiting on CI",
        timestamp: "2026-04-08T14:39:00.000Z",
      }),
    ],
    now: Date.parse("2026-04-08T14:39:30.000Z"),
  });

  const byActor = new Map(presence.map((entry) => [entry.actor_label, entry]));
  assert.equal(byActor.get("CrestPine | EmmyMay's agent | Agent")?.status, "idle");
  assert.equal(byActor.get("SolarVista | EmmyMay's agent | Agent")?.status, "idle");
  assert.equal(byActor.get("GardenFern | EmmyMay's agent | Agent")?.status, "blocked");
});

test("buildSyntheticPresenceEntry returns an active room presence record", () => {
  const presence = buildSyntheticPresenceEntry({
    roomId: "github.com/brosincode/letagents",
    actorLabel: "HollowOtter | EmmyMay's agent | Agent",
    agentKey: "EmmyMay/hollowotter",
    displayName: "HollowOtter",
    ownerLabel: "EmmyMay",
    ideLabel: "Agent",
    status: "working",
    statusText: "working on task_70",
    now: Date.parse("2026-04-08T01:45:00.000Z"),
  });

  assert.equal(presence.status, "working");
  assert.equal(presence.status_text, "working on task_70");
  assert.equal(presence.freshness, "active");
  assert.equal(presence.activity_state, "online");
  assert.equal(presence.owner_label, "EmmyMay");
  assert.deepEqual(presence.source_flags, ["presence"]);
});
