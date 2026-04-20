import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentRoomParticipantUpsert,
  buildHumanRoomParticipantUpsert,
  buildRoomParticipantUpsertFromMessage,
  createRoomParticipantRecorder,
  getOwnerLabelFromAttribution,
  isAgentIdentityValue,
  normalizeParticipantValue,
  type RoomParticipantUpsertInput,
} from "../room-participants.js";

const seenAt = "2026-04-20T16:00:00.000Z";

test("normalizeParticipantValue trims nullable participant labels", () => {
  assert.equal(normalizeParticipantValue("  EmmyMay  "), "EmmyMay");
  assert.equal(normalizeParticipantValue(null), "");
  assert.equal(normalizeParticipantValue(undefined), "");
});

test("getOwnerLabelFromAttribution strips agent suffixes", () => {
  assert.equal(getOwnerLabelFromAttribution("EmmyMay's agent"), "EmmyMay");
  assert.equal(getOwnerLabelFromAttribution("Ops Team's agent"), "Ops Team");
  assert.equal(getOwnerLabelFromAttribution("Ops Team"), "Ops Team");
  assert.equal(getOwnerLabelFromAttribution("   "), null);
});

test("isAgentIdentityValue detects structured and attributed agent labels", () => {
  assert.equal(isAgentIdentityValue("GardenFern | EmmyMay's agent | Agent"), true);
  assert.equal(isAgentIdentityValue("EmmyMay"), false);
});

test("buildHumanRoomParticipantUpsert prefers authenticated login and preserves stored fields", () => {
  const participant = buildHumanRoomParticipantUpsert({
    projectId: "focus_5",
    sender: " Browser Name ",
    sessionAccount: { login: " EmmyMay " } as never,
    lastSeenAt: seenAt,
  });

  assert.deepEqual(participant, {
    room_id: "focus_5",
    participant_key: "human:login:emmymay",
    kind: "human",
    github_login: "EmmyMay",
    display_name: "EmmyMay",
    last_seen_at: seenAt,
  });
});

test("buildAgentRoomParticipantUpsert parses structured actor labels", () => {
  const participant = buildAgentRoomParticipantUpsert({
    projectId: "focus_5",
    actorLabel: " GardenFern | EmmyMay's agent | Agent ",
    agentKey: " EmmyMay/gardenfern ",
    lastSeenAt: seenAt,
  });

  assert.deepEqual(participant, {
    room_id: "focus_5",
    participant_key: "agent:gardenfern | emmymay's agent | agent",
    kind: "agent",
    actor_label: "GardenFern | EmmyMay's agent | Agent",
    agent_key: "EmmyMay/gardenfern",
    display_name: "GardenFern",
    owner_label: "EmmyMay",
    ide_label: "Agent",
    last_seen_at: seenAt,
  });
});

test("buildRoomParticipantUpsertFromMessage classifies agents, humans, and system senders", () => {
  assert.equal(
    buildRoomParticipantUpsertFromMessage({
      projectId: "focus_5",
      sender: "github",
      source: "github",
      timestamp: seenAt,
    }),
    null
  );

  const agent = buildRoomParticipantUpsertFromMessage({
    projectId: "focus_5",
    sender: "GardenFern | EmmyMay's agent | Agent",
    source: undefined,
    timestamp: seenAt,
  });
  assert.equal(agent?.kind, "agent");
  assert.equal(agent?.participant_key, "agent:gardenfern | emmymay's agent | agent");

  const human = buildRoomParticipantUpsertFromMessage({
    projectId: "focus_5",
    sender: "EmmyMay",
    source: "browser",
    sessionAccount: { login: "EmmyMay" } as never,
    timestamp: seenAt,
  });
  assert.equal(human?.kind, "human");
  assert.equal(human?.participant_key, "human:login:emmymay");
});

test("createRoomParticipantRecorder upserts valid participants and skips ignored messages", async () => {
  const calls: RoomParticipantUpsertInput[] = [];
  const recorder = createRoomParticipantRecorder({
    upsertRoomParticipant: async (input) => {
      calls.push(input);
      return null;
    },
  });

  await recorder.rememberRoomParticipantFromMessage({
    projectId: "focus_5",
    sender: "github",
    source: "github",
    timestamp: seenAt,
  });
  await recorder.rememberRoomParticipantFromMessage({
    projectId: "focus_5",
    sender: "GardenFern | EmmyMay's agent | Agent",
    source: "agent",
    timestamp: seenAt,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.participant_key, "agent:gardenfern | emmymay's agent | agent");
});
