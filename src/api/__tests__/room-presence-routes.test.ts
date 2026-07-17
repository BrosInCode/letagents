import assert from "node:assert/strict";
import test from "node:test";
import type { RoomAgentPresence, RoomParticipant } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  buildRoomActivityHistoryParticipants,
  isSuppressibleDisconnectedPresence,
  registerRoomPresenceRoutes,
} = await import("../routes/rooms/presence/index.js");
const {
  desktopManagedPausePresence,
  isNumericSuffixExtension,
  normalizeReplayedAgentDisplayName,
  resolveReplayCanonicalBase,
} = await import("../routes/rooms/presence/agent-session-routes.js");
const {
  isActiveRoomAgentSessionStaleForRegistration,
  SAME_INSTANCE_RECLAIM_STALE_AFTER_MS,
} = await import("../db/auth.js");

test("desktop closed-room pauses stay distinct from agent failures", () => {
  assert.deepEqual(desktopManagedPausePresence({ availability: "room_closed" }), {
    status: "idle",
    statusText: "Room not open on the managing desktop",
  });
  assert.deepEqual(desktopManagedPausePresence({ availability: "failure" }), {
    status: "blocked",
    statusText: "Needs attention",
  });
});

test("replayed collision suffixes normalize to the canonical agent display name", () => {
  assert.equal(normalizeReplayedAgentDisplayName("SilverHarbor 2", "SilverHarbor"), "SilverHarbor");
  assert.equal(normalizeReplayedAgentDisplayName("SilverHarbor 2 1 1 1", "SilverHarbor"), "SilverHarbor");
  assert.equal(normalizeReplayedAgentDisplayName("SilverHarbor East", "SilverHarbor"), "SilverHarbor East");
  assert.equal(normalizeReplayedAgentDisplayName("Agent 47", "Agent"), "Agent");
  assert.equal(normalizeReplayedAgentDisplayName("Agent 47A", "Agent"), "Agent 47A");
});

test("isNumericSuffixExtension recognizes only base + trailing numeric groups", () => {
  assert.equal(isNumericSuffixExtension("MistyMorrow 2 1 1 1", "MistyMorrow"), true);
  assert.equal(isNumericSuffixExtension("MistyMorrow 1", "MistyMorrow"), true);
  assert.equal(isNumericSuffixExtension("MistyMorrow", "MistyMorrow"), false); // no suffix
  assert.equal(isNumericSuffixExtension("Agent 47A", "Agent"), false);         // 47A not pure-digit
  assert.equal(isNumericSuffixExtension("MistyMorrow East", "MistyMorrow"), false);
  assert.equal(isNumericSuffixExtension("Otter 3", "MistyMorrow"), false);     // different base
});

test("resolveReplayCanonicalBase reduces ONLY via a valid trusted base signal", () => {
  // Trusted client base "MistyMorrow" reduces a compounded replay to it.
  assert.equal(resolveReplayCanonicalBase("MistyMorrow 2 1 1 1", "MistyMorrow"), "MistyMorrow");
  assert.equal(resolveReplayCanonicalBase("MistyMorrow", "MistyMorrow"), "MistyMorrow");
  // A deliberate numeric-ending name declared as its own base is preserved.
  assert.equal(resolveReplayCanonicalBase("Agent 47", "Agent 47"), "Agent 47");
  // A trusted base that does NOT match the requested label is ignored (the
  // label is preserved, not force-reduced) — no cross-name capture.
  assert.equal(resolveReplayCanonicalBase("Agent 47", "MistyMorrow"), "Agent 47");
  // No signal -> fail closed, preserve verbatim (never guess from shape).
  assert.equal(resolveReplayCanonicalBase("MistyMorrow 2 1 1 1", null), "MistyMorrow 2 1 1 1");
  assert.equal(resolveReplayCanonicalBase("Agent 47", ""), "Agent 47");
});

test("trusted base + normalize converges a compounded label while preserving a deliberate one", () => {
  assert.equal(
    normalizeReplayedAgentDisplayName("MistyMorrow 2 1 1 1", resolveReplayCanonicalBase("MistyMorrow 2 1 1 1", "MistyMorrow")),
    "MistyMorrow",
  );
  // First-ever deliberate "Agent 47" (declared base "Agent 47") stays put even
  // though the identity previously held "Agent".
  assert.equal(
    normalizeReplayedAgentDisplayName("Agent 47", resolveReplayCanonicalBase("Agent 47", "Agent 47")),
    "Agent 47",
  );
});

test("same-instance stale reclaim requires an expired heartbeat", () => {
  const now = Date.parse("2026-07-17T19:00:00.000Z");
  const active = {
    last_seen_at: new Date(now - 1_000).toISOString(),
  };
  assert.equal(isActiveRoomAgentSessionStaleForRegistration({
    active_session: active,
    now_ms: now,
  }), false, "a fresh session cannot be reclaimed without its exact credential");
  assert.equal(isActiveRoomAgentSessionStaleForRegistration({
    active_session: {
      ...active,
      last_seen_at: new Date(now - SAME_INSTANCE_RECLAIM_STALE_AFTER_MS).toISOString(),
    },
    now_ms: now,
  }), true, "a stale/crashed predecessor can be reclaimed after heartbeat expiry");
  assert.equal(isActiveRoomAgentSessionStaleForRegistration({
    active_session: { ...active, last_seen_at: "not-a-time" },
    now_ms: now,
  }), false, "missing or malformed liveness proof fails closed");
});

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
    emitProjectMessage: unused,
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
    { method: "post", path: "/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/failures$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/desktop-heartbeat$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/native-activity$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/desktop-pause$/" },
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
