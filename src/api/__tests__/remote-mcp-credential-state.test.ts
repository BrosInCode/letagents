import assert from "node:assert/strict";
import test from "node:test";

import type { McpSessionPersistentState } from "../../mcp/server/runtime/session-scope.js";
import type { StoredAgentSessionState, StoredMcpWorker } from "../../mcp/local-state/types.js";
import { foldIntoCredential, projectCredentialState } from "../remote-mcp/credential-state.js";

// What a remote MCP credential keeps of its sessions, and how a session's
// state folds into it. No database: these are pure functions.

function session(id: string, roomId: string, seenAt: string, ended = false): StoredAgentSessionState {
  return {
    session_id: id, session_token: `tok-${id}`, room_id: roomId, session_kind: "worker", runtime: "dot",
    actor_label: id, agent_key: `key/${id}`, agent_instance_id: `worker_${id}`, display_name: id, owner_label: "o", ide_label: "Agent",
    created_at: seenAt, updated_at: seenAt, last_seen_at: seenAt, ended_at: ended ? seenAt : null,
  };
}

function worker(id: string, rooms: Record<string, string>, lastUsedAt?: string): StoredMcpWorker {
  return { worker_id: `worker_${id}`, scope: "s", registration_key_hash: `h${id}`, display_name: id,
    rooms: Object.fromEntries(Object.entries(rooms).map(([room, sid]) => [room, { session_id: sid }])), ...(lastUsedAt ? { last_used_at: lastUsedAt } : {}) };
}

function state(input: Partial<McpSessionPersistentState["local"]> & { pinned?: StoredAgentSessionState[]; room?: string }): McpSessionPersistentState {
  const { pinned, room, ...local } = input;
  return {
    local,
    currentRoom: room ? { room_id: room } : null,
    fullPromptDelivered: true,
    pinnedConnections: Object.fromEntries((pinned ?? []).map((entry) => [entry.session_id, entry])),
  };
}

test("a projection keeps worker handles, their live sessions and cursors, and nothing session-specific", () => {
  const live = session("s1", "x", "2026-11-03T10:00:00Z");
  const ended = session("s2", "x", "2026-11-03T11:00:00Z", true);
  const projected = projectCredentialState(state({
    mcp_workers: { worker_a: worker("a", { x: "s1" }), worker_b: worker("b", { x: "s2" }) },
    agent_sessions: { s1: live, s2: ended, s3: session("s3", "y", "2026-11-03T12:00:00Z") },
    current_agent_session_ids: { y: "s3", x: "s2" },
    room_sessions: { x: { room_id: "x", joined_via: "join_room", joined_at: "t", last_seen_at: "t", last_message_id: "msg_9" } },
    agent_identities: { "instance:abc": { name: "n", display_name: "n", owner_label: "o", actor_label: "n", source: "api", resolved_at: "t" } },
    agent_identity: { name: "n", display_name: "n", owner_label: "o", actor_label: "n", source: "api", resolved_at: "t" },
    pinned: [live, ended],
    room: "x",
  }));
  assert.deepEqual(Object.keys(projected.local.mcp_workers ?? {}).sort(), ["worker_a", "worker_b"], "a worker whose session ended keeps its handle");
  assert.deepEqual(Object.keys(projected.local.agent_sessions ?? {}).sort(), ["s1", "s3"], "ended sessions are dropped; a legacy current session is kept");
  assert.deepEqual(projected.local.current_agent_session_ids, { y: "s3" }, "a legacy registration whose session ended is dropped");
  assert.deepEqual(Object.keys(projected.pinnedConnections), ["s1"]);
  assert.equal(projected.local.room_sessions?.x?.last_message_id, "msg_9");
  assert.equal(projected.local.agent_identities, undefined);
  assert.equal(projected.local.agent_identity, undefined);
  assert.equal(projected.currentRoom, null, "a joined room is never kept");
  assert.equal(projected.fullPromptDelivered, false);
});

test("the worker cap keeps the most recently used handles, and a handle keeps at most 16 rooms", () => {
  const sessions: Record<string, StoredAgentSessionState> = {};
  const workers: Record<string, StoredMcpWorker> = {};
  for (let i = 0; i < 5; i += 1) {
    sessions[`s${i}`] = session(`s${i}`, "x", `2026-11-03T1${i}:00:00Z`);
    workers[`worker_${i}`] = worker(String(i), { x: `s${i}` });
  }
  // The oldest-registered worker was used most recently, so it stays.
  workers.worker_0 = { ...workers.worker_0!, last_used_at: "2026-11-03T20:00:00Z" };
  const projected = projectCredentialState(state({ mcp_workers: workers, agent_sessions: sessions }), 2);
  assert.deepEqual(Object.keys(projected.local.mcp_workers ?? {}).sort(), ["worker_0", "worker_4"]);
  assert.deepEqual(Object.keys(projected.local.agent_sessions ?? {}).sort(), ["s0", "s4"], "only the kept workers' sessions stay");

  const manyRooms: Record<string, string> = {};
  const roomSessions: Record<string, StoredAgentSessionState> = {};
  for (let i = 0; i < 20; i += 1) {
    manyRooms[`room${i}`] = `r${i}`;
    roomSessions[`r${i}`] = session(`r${i}`, `room${i}`, `2026-11-03T${String(i).padStart(2, "0")}:00:00Z`);
  }
  const wide = projectCredentialState(state({ mcp_workers: { worker_w: worker("w", manyRooms) }, agent_sessions: roomSessions }));
  const kept = Object.keys(wide.local.mcp_workers!.worker_w!.rooms);
  assert.equal(kept.length, 16);
  assert.ok(kept.includes("room19") && !kept.includes("room0"), "the least recently seen rooms go first");
});

test("a fold takes only what the session changed since its baseline; an ended entry stays ended", () => {
  const seededSession = session("s1", "x", "2026-11-03T10:00:00Z");
  const baseline = projectCredentialState(state({ mcp_workers: { worker_a: worker("a", { x: "s1" }) }, agent_sessions: { s1: seededSession }, pinned: [seededSession] }));
  // Another session later replaced s1 with s9 and ended s1.
  const newer = session("s9", "x", "2026-11-03T12:00:00Z");
  const credential = projectCredentialState(state({
    mcp_workers: { worker_a: worker("a", { x: "s9" }) },
    agent_sessions: { s1: { ...seededSession, ended_at: "2026-11-03T12:00:00Z" }, s9: newer }, pinned: [newer],
  }));
  // A stale session that only added a cursor must not point worker_a back at s1 or revive it.
  const stale = state({ mcp_workers: { worker_a: worker("a", { x: "s1" }) }, agent_sessions: { s1: seededSession }, pinned: [seededSession],
    room_sessions: { x: { room_id: "x", joined_via: "join_room", joined_at: "t", last_seen_at: "t", last_message_id: "msg_3" } } });
  const folded = foldIntoCredential(credential, stale, baseline);
  assert.equal(folded.local.mcp_workers!.worker_a!.rooms.x!.session_id, "s9", "the unchanged worker keeps the credential's newer binding");
  assert.equal(folded.local.agent_sessions!.s1, undefined, "the ended session is dropped, not revived");
  assert.equal(folded.local.room_sessions!.x!.last_message_id, "msg_3", "the cursor the session added is folded in");
  // Without a baseline the session's entries win. The projection keeps no
  // tombstones, so only the baseline keeps a stale session from re-adding an
  // entry the credential dropped; a loaded session always has one.
  const blind = foldIntoCredential(credential, stale, null);
  assert.equal(blind.local.mcp_workers!.worker_a!.rooms.x!.session_id, "s1");
  // An ended entry the credential still holds is never revived: it stays
  // ended in the fold, and the projection then drops it as not live.
  const withTombstone = { ...credential, local: { ...credential.local, agent_sessions: { ...credential.local.agent_sessions, s1: { ...seededSession, ended_at: "2026-11-03T12:00:00Z" } } } };
  const revived = foldIntoCredential(withTombstone, stale, null).local.agent_sessions?.s1;
  assert.ok(!revived || revived.ended_at, "ended stays ended");
});

test("two sessions that bind one worker in different rooms both keep their binding", () => {
  const shared = session("s0", "x", "2026-11-03T10:00:00Z");
  const seed = projectCredentialState(state({ mcp_workers: { worker_a: worker("a", { x: "s0" }) }, agent_sessions: { s0: shared }, pinned: [shared] }));
  const inY = session("sy", "y", "2026-11-03T11:00:00Z");
  const inZ = session("sz", "z", "2026-11-03T11:30:00Z");
  const one = state({ mcp_workers: { worker_a: worker("a", { x: "s0", y: "sy" }) }, agent_sessions: { s0: shared, sy: inY }, pinned: [shared, inY] });
  const two = state({ mcp_workers: { worker_a: worker("a", { x: "s0", z: "sz" }) }, agent_sessions: { s0: shared, sz: inZ }, pinned: [shared, inZ] });
  const afterOne = foldIntoCredential(seed, one, seed);
  const afterBoth = foldIntoCredential(afterOne, two, seed);
  assert.deepEqual(Object.keys(afterBoth.local.mcp_workers!.worker_a!.rooms).sort(), ["x", "y", "z"]);
  assert.deepEqual(Object.keys(afterBoth.local.agent_sessions!).sort(), ["s0", "sy", "sz"]);
  assert.deepEqual(Object.keys(afterBoth.pinnedConnections).sort(), ["s0", "sy", "sz"]);
});
