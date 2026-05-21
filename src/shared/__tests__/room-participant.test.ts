import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentRoomParticipantKey,
  buildHumanRoomParticipantKey,
  ROOM_PARTICIPANT_KINDS,
} from "../room-participant.js";

// ── ROOM_PARTICIPANT_KINDS ──────────────────────────────

test("ROOM_PARTICIPANT_KINDS includes human and agent", () => {
  assert.deepEqual([...ROOM_PARTICIPANT_KINDS], ["human", "agent"]);
});

// ── buildAgentRoomParticipantKey ────────────────────────

test("buildAgentRoomParticipantKey creates agent: prefixed key from structured label", () => {
  const key = buildAgentRoomParticipantKey("MarshIndigo | EmmyMay's agent | Agent");
  assert.ok(key);
  assert.ok(key.startsWith("agent:"));
  assert.equal(key, "agent:marshindigo | emmymay's agent | agent");
});

test("buildAgentRoomParticipantKey creates key from plain agent name", () => {
  const key = buildAgentRoomParticipantKey("some-agent");
  assert.ok(key);
  assert.equal(key, "agent:some-agent");
});

test("buildAgentRoomParticipantKey normalizes whitespace to lowercase", () => {
  const key1 = buildAgentRoomParticipantKey("  MarshIndigo  ");
  const key2 = buildAgentRoomParticipantKey("marshindigo");
  assert.equal(key1, key2);
});

test("buildAgentRoomParticipantKey returns null for null/undefined/empty", () => {
  assert.equal(buildAgentRoomParticipantKey(null), null);
  assert.equal(buildAgentRoomParticipantKey(undefined), null);
  assert.equal(buildAgentRoomParticipantKey(""), null);
  assert.equal(buildAgentRoomParticipantKey("   "), null);
});

// ── buildHumanRoomParticipantKey ────────────────────────

test("buildHumanRoomParticipantKey prefers github_login when available", () => {
  const key = buildHumanRoomParticipantKey({
    github_login: "kdnotfound",
    display_name: "KD",
  });
  assert.equal(key, "human:login:kdnotfound");
});

test("buildHumanRoomParticipantKey falls back to display_name", () => {
  const key = buildHumanRoomParticipantKey({
    display_name: "EmmyMay",
  });
  assert.equal(key, "human:name:emmymay");
});

test("buildHumanRoomParticipantKey normalizes login to lowercase", () => {
  const key = buildHumanRoomParticipantKey({
    github_login: "KDnotFound",
  });
  assert.equal(key, "human:login:kdnotfound");
});

test("buildHumanRoomParticipantKey returns null when both are empty", () => {
  assert.equal(buildHumanRoomParticipantKey({}), null);
  assert.equal(
    buildHumanRoomParticipantKey({ github_login: "", display_name: "" }),
    null
  );
  assert.equal(
    buildHumanRoomParticipantKey({ github_login: null, display_name: null }),
    null
  );
});

test("buildHumanRoomParticipantKey trims whitespace", () => {
  const key = buildHumanRoomParticipantKey({
    github_login: "  kdnotfound  ",
  });
  assert.equal(key, "human:login:kdnotfound");
});
