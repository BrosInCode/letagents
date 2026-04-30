import assert from "node:assert/strict";
import test from "node:test";
import type { RoomAgentPresence, RoomParticipant } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  buildRoomActivityHistoryParticipants,
  isSuppressibleDisconnectedPresence,
  registerRoomPresenceRoutes,
} = await import("../routes/room-presence.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireAdmin: unused,
    requireParticipant: unused,
    rememberAgentRoomParticipant: unused,
    maybeEmitStaleWorkPrompt: unused,
  };
}

test("registerRoomPresenceRoutes preserves canonical presence route order", () => {
  const calls: Array<{ method: "get" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
  };

  registerRoomPresenceRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^(?:\\/api)?\\/rooms\\/(.+)\\/presence$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/participants$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/activity-history$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/participants\\/(?:clear|archive)-disconnected$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/agent-sessions$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/disconnect$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/presence$/" },
  ]);
});

function makePresence(overrides: Partial<RoomAgentPresence> = {}): RoomAgentPresence {
  return {
    room_id: "room_1",
    actor_label: "StatusOnly | EmmyMay's agent | Agent",
    agent_key: "EmmyMay/statusonly",
    agent_instance_id: "instance_status_only",
    agent_session_id: "session_status_only",
    session_kind: "worker",
    runtime: "codex",
    display_name: "StatusOnly",
    owner_label: "EmmyMay",
    ide_label: "Agent",
    status: "idle",
    status_text: "available in room",
    last_heartbeat_at: "2026-04-24T04:00:00.000Z",
    created_at: "2026-04-24T04:00:00.000Z",
    updated_at: "2026-04-24T04:00:00.000Z",
    freshness: "stale",
    activity_state: "offline",
    source_flags: ["presence"],
    ...overrides,
  };
}

function makeParticipant(overrides: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    room_id: "room_1",
    participant_key: "agent:stored | emmymay's agent | agent",
    kind: "agent",
    actor_label: "Stored | EmmyMay's agent | Agent",
    agent_key: "EmmyMay/stored",
    github_login: null,
    display_name: "Stored",
    owner_label: "EmmyMay",
    ide_label: "Agent",
    hidden_at: null,
    hidden_by: null,
    last_seen_at: "2026-04-24T03:59:00.000Z",
    last_room_activity_at: "2026-04-24T03:59:00.000Z",
    last_live_heartbeat_at: null,
    activity_state: "offline",
    source_flags: [],
    created_at: "2026-04-24T03:59:00.000Z",
    updated_at: "2026-04-24T03:59:00.000Z",
    ...overrides,
  };
}

test("buildRoomActivityHistoryParticipants preserves status-only presence as history", () => {
  const participants = buildRoomActivityHistoryParticipants({
    roomId: "room_1",
    storedParticipants: [makeParticipant()],
    presence: [makePresence()],
  });

  assert.deepEqual(
    participants.map((participant) => [participant.display_name, participant.activity_state, participant.source_flags]),
    [
      ["Stored", "offline", []],
      ["StatusOnly", "offline", ["presence"]],
    ],
  );
});

test("isSuppressibleDisconnectedPresence only suppresses delivery-backed stale agents", () => {
  assert.equal(
    isSuppressibleDisconnectedPresence(makePresence({ source_flags: ["presence"] }), Date.parse("2026-04-24T04:05:00.000Z")),
    false,
  );
  assert.equal(
    isSuppressibleDisconnectedPresence(makePresence({ source_flags: ["delivery", "presence"] }), Date.parse("2026-04-24T04:05:00.000Z")),
    true,
  );
  assert.equal(
    isSuppressibleDisconnectedPresence(makePresence({
      freshness: "active",
      activity_state: "away",
      source_flags: ["delivery", "presence"],
    }), Date.parse("2026-04-24T04:05:00.000Z")),
    false,
  );
});
