import assert from "node:assert/strict";
import test from "node:test";

import { mergeRoomAgentPresenceRecords } from "../db/presence/merge.js";
import type { RoomAgentDeliverySession } from "../db/types/agents.js";

const NOW = Date.parse("2026-07-30T22:00:00.000Z");

function workerSession(input: {
  sessionId: string;
  agentKey?: string | null;
  agentInstanceId?: string | null;
  actorLabel?: string;
  displayName?: string;
  reachable?: boolean;
  seenAt?: string;
}): RoomAgentDeliverySession {
  const seenAt = input.seenAt ?? new Date(NOW - 5_000).toISOString();
  const reachable = input.reachable ?? true;
  return {
    room_id: "room_1",
    delivery_key: `agent_session:${input.sessionId}`,
    actor_label: input.actorLabel ?? "summitsignal",
    agent_key: input.agentKey === undefined ? "EmmyMay/desktop-open-model-abc" : input.agentKey,
    agent_instance_id: input.agentInstanceId === undefined ? "daemon:supervised_1" : input.agentInstanceId,
    agent_session_id: input.sessionId,
    session_kind: "worker",
    runtime: "open-model",
    display_name: input.displayName ?? "SummitSignal",
    owner_label: "EmmyMay",
    ide_label: "Agent",
    repo_branch: null,
    transport: "desktop_events",
    active_connection_count: reachable ? 1 : 0,
    last_connected_at: seenAt,
    last_disconnected_at: reachable ? null : seenAt,
    reconnect_grace_expires_at: reachable ? null : new Date(NOW - 60_000).toISOString(),
    offline_announced_at: null,
    recovery_announced_at: null,
    created_at: seenAt,
    updated_at: seenAt,
  };
}

test("a session succession collapses to the successor's presence row", () => {
  // Runtime recovery ends the predecessor worker session and mints a
  // successor with the same durable identity. Until the predecessor's
  // delivery row ages out, both rows are live — the room must still present
  // one agent, bound to the successor session.
  const predecessor = workerSession({
    sessionId: "agent_session_553",
    reachable: false,
    seenAt: new Date(NOW - 120_000).toISOString(),
  });
  const successor = workerSession({ sessionId: "agent_session_554" });

  const merged = mergeRoomAgentPresenceRecords({
    roomId: "room_1",
    statusEntries: [],
    deliverySessions: [predecessor, successor],
    now: NOW,
  });

  assert.equal(merged.length, 1, "one presence row per durable agent identity");
  assert.equal(merged[0]!.agent_session_id, "agent_session_554");
});

test("the reachable session wins over a fresher unreachable echo", () => {
  const staleButRecent = workerSession({
    sessionId: "agent_session_601",
    reachable: false,
    seenAt: new Date(NOW - 1_000).toISOString(),
  });
  const reachable = workerSession({
    sessionId: "agent_session_600",
    seenAt: new Date(NOW - 30_000).toISOString(),
  });

  const merged = mergeRoomAgentPresenceRecords({
    roomId: "room_1",
    statusEntries: [],
    deliverySessions: [staleButRecent, reachable],
    now: NOW,
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.agent_session_id, "agent_session_600");
});

test("distinct instances of the same canonical key stay separate", () => {
  // Burst workers legitimately run several instances under one canonical
  // agent key; succession collapse must never hide a concurrent peer.
  const first = workerSession({
    sessionId: "agent_session_700",
    agentInstanceId: "burst:1",
    actorLabel: "worker-1",
  });
  const second = workerSession({
    sessionId: "agent_session_701",
    agentInstanceId: "burst:2",
    actorLabel: "worker-2",
  });

  const merged = mergeRoomAgentPresenceRecords({
    roomId: "room_1",
    statusEntries: [],
    deliverySessions: [first, second],
    now: NOW,
  });

  assert.equal(merged.length, 2);
});

test("rows without a full durable identity are never collapsed", () => {
  const missingKey = workerSession({
    sessionId: "agent_session_800",
    agentKey: null,
    actorLabel: "legacy-1",
  });
  const missingInstance = workerSession({
    sessionId: "agent_session_801",
    agentInstanceId: null,
    actorLabel: "legacy-1",
  });

  const merged = mergeRoomAgentPresenceRecords({
    roomId: "room_1",
    statusEntries: [],
    deliverySessions: [missingKey, missingInstance],
    now: NOW,
  });

  assert.equal(merged.length, 2, "identity gaps fail open to the previous per-session behavior");
});
