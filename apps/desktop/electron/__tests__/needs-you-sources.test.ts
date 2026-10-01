import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "needs-you-sources-" }).resetState({});

const { mayHoldPendingBoardIntents, readPendingBoardIntents } = await import("../main/rooms/knowledge.js");
const { mapDesktopBoardIntent } = await import("../main/rooms/board-governance/mappers.js");
const { liveSupervisorStateEntries, onSupervisorState, projectLiveSupervisorEntries, supervisorDaemonClient, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION } = await import("../main/supervisor-daemon.js");

test("Inbox asks only admin rooms active within an intent's lifetime for pending board intents", () => {
  const now = Date.parse("2026-09-30T16:30:00.000Z");
  const room = (role: "admin" | "participant", latestMessageAt: string | null) =>
    ({ role, latestMessageAt }) as Parameters<typeof mayHoldPendingBoardIntents>[0];
  assert.equal(mayHoldPendingBoardIntents(room("admin", "2026-09-30T16:10:00.000Z"), now), true);
  assert.equal(mayHoldPendingBoardIntents(room("participant", "2026-09-30T16:10:00.000Z"), now), false,
    "only admins can decide an intent");
  assert.equal(mayHoldPendingBoardIntents(room("admin", "2026-09-29T16:29:00.000Z"), now), false,
    "every intent posts a room message and expires after 24 hours");
  assert.equal(mayHoldPendingBoardIntents(room("admin", null), now), true, "an unknown latest message is still checked");
});

test("a quiet admin room is read as holding no intents, so a later read of that room includes them", async () => {
  const now = Date.parse("2026-09-30T16:30:00.000Z");
  const reads: string[] = [];
  const list = async (roomIdentifier: string) => { reads.push(roomIdentifier); return []; };
  const room = (role: "admin" | "participant", latestMessageAt: string | null) =>
    ({ roomIdentifier: `${role}-${latestMessageAt}`, role, latestMessageAt }) as Parameters<typeof readPendingBoardIntents>[0];
  assert.deepEqual(await readPendingBoardIntents(room("admin", "2026-09-28T16:00:00.000Z"), now, list), [], "an admin room, with nothing pending");
  assert.equal(await readPendingBoardIntents(room("participant", "2026-09-30T16:10:00.000Z"), now, list), undefined, "not the account's to decide");
  assert.deepEqual(await readPendingBoardIntents(room("admin", "2026-09-30T16:10:00.000Z"), now, list), []);
  assert.deepEqual(reads, ["admin-2026-09-30T16:10:00.000Z"], "only an active admin room is asked");
});

test("pending board intents keep their proposer and timing for the Inbox", () => {
  assert.deepEqual(mapDesktopBoardIntent({
    id: "bi_1", room_id: "room", task_id: "task_7", action_type: "task_claim", payload: { task_id: "task_7" },
    payload_hash: "hash", status: "pending", proposer_actor_label: "SummitMisty", proposer_actor_key: "emmymay/summit",
    proposer_actor_instance_id: null, proposer_agent_session_id: "session", decision_by: null, decision_reason: null,
    approval_token_hash: null, decided_at: null, expires_at: "2026-10-01T16:00:00.000Z",
    created_at: "2026-09-30T16:00:00.000Z", updated_at: "2026-09-30T16:00:00.000Z",
  }), {
    id: "bi_1", taskId: "task_7", actionType: "task_claim", status: "pending", proposerActorLabel: "SummitMisty",
    payload: { task_id: "task_7" }, createdAt: "2026-09-30T16:00:00.000Z", expiresAt: "2026-10-01T16:00:00.000Z",
    escalatedAt: null,
  }, "a server that predates escalation reads as not escalated");
});

test("a board intent sent to people keeps when it was escalated for the Inbox", () => {
  const intent = mapDesktopBoardIntent({
    id: "bi_2", room_id: "room", task_id: "task_6", action_type: "task_claim", payload: { task_id: "task_6" },
    payload_hash: "hash", status: "pending", proposer_actor_label: "HarborMarsh", proposer_actor_key: "emmymay/harbor",
    proposer_actor_instance_id: null, proposer_agent_session_id: "session", decision_by: null, decision_reason: null,
    approval_token_hash: null, decided_at: null, expires_at: null, escalated_at: "2026-09-30T16:00:01.000Z",
    created_at: "2026-09-30T16:00:00.000Z", updated_at: "2026-09-30T16:00:01.000Z",
  });
  assert.equal(intent.escalatedAt, "2026-09-30T16:00:01.000Z");
});

test("Needs you reads agents that are not retired, without their activity history", () => {
  const entry = (id: string, desiredState: "running" | "paused" | "stopped") => ({ id, desiredState,
    activity: [{ sequence: 1, summary: "large history" }] }) as unknown as Parameters<typeof projectLiveSupervisorEntries>[0][number];
  const live = projectLiveSupervisorEntries([entry("running", "running"), entry("paused", "paused"), entry("retired", "stopped")]);
  assert.deepEqual(live.map((agent) => agent.id), ["running", "paused"]);
  assert.ok(live.every((agent) => agent.activity.length === 0));
});

test("Needs you forgets agent state once the daemon stops or its watch fails", async () => {
  const entry = (id: string, desiredState: "running" | "stopped") => ({ id, desiredState, activity: [] });
  const status = { implementationVersion: SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, generation: 1, capabilities: { agentStateSubscription: true } };
  let running = true;
  let watches = 0;
  let failNext = false;
  // This process never reaches a real daemon.
  supervisorDaemonClient.connectIfRunning = (async () => (running ? status : null)) as typeof supervisorDaemonClient.connectIfRunning;
  supervisorDaemonClient.watchState = (async () => {
    watches += 1;
    if (failNext) throw new Error("socket closed");
    return { daemonGeneration: 1, sequence: watches + 1, entries: [entry("running", "running"), entry("retired", "stopped")] };
  }) as unknown as typeof supervisorDaemonClient.watchState;
  const settle = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i += 1) await new Promise(resolve => setImmediate(resolve)); };

  const snapshots: unknown[] = [];
  const stop = onSupervisorState((snapshot) => {
    snapshots.push(snapshot);
    if (snapshots.length === 1) running = false;
  });
  await settle(() => snapshots.length === 1);
  await settle(() => liveSupervisorStateEntries() === null);
  stop();
  assert.equal(snapshots.length, 1);
  assert.equal(liveSupervisorStateEntries(), null, "a stopped daemon's agents are not shown");

  running = true;
  const again: unknown[] = [];
  const stopAgain = onSupervisorState((snapshot) => {
    again.push(snapshot);
    failNext = true;
    assert.deepEqual(liveSupervisorStateEntries()?.map((agent) => agent.id), ["running"]);
  });
  await settle(() => again.length === 1);
  await settle(() => liveSupervisorStateEntries() === null);
  stopAgain();
  assert.equal(liveSupervisorStateEntries(), null, "a failing watch forgets what it can no longer confirm");
});
