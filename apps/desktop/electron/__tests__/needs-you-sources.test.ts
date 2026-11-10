import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "needs-you-sources-" }).resetState({});

const { mayHoldPendingBoardIntents, readPendingBoardIntents } = await import("../main/rooms/knowledge.js");
const { mapDesktopBoardIntent } = await import("../main/rooms/board-governance/mappers.js");
const { liveSupervisorStateEntries, onSupervisorState, projectLiveSupervisorEntries, supervisorDaemonClient, supervisorStateWatchSettledForTest, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION } = await import("../main/supervisor-daemon.js");

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
  // A stopped daemon answers no poll: the watch learns of its end from the failed poll, not from a negotiate before it.
  supervisorDaemonClient.watchState = (async () => {
    watches += 1;
    if (!running) throw new Error("connect ECONNREFUSED");
    if (failNext) throw new Error("socket closed");
    return { daemonGeneration: 1, sequence: watches + 1, entries: [entry("running", "running"), entry("retired", "stopped")] };
  }) as unknown as typeof supervisorDaemonClient.watchState;
  // Once it holds a state, the watch asks for changes only; the same failures apply.
  supervisorDaemonClient.watchStateChanges = (async () => {
    watches += 1;
    if (!running) throw new Error("connect ECONNREFUSED");
    if (failNext) throw new Error("socket closed");
    return { complete: false, daemonGeneration: 1, sequence: watches + 1, changedEntries: [], removedEntryIds: [], entryOrder: ["running", "retired"] };
  }) as unknown as typeof supervisorDaemonClient.watchStateChanges;
  const settle = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };

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
  await supervisorStateWatchSettledForTest();

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
  await supervisorStateWatchSettledForTest();
});

test("Needs you marks each focus room with the room it is listed under, and says whether it read updates", async (t) => {
  const repo = "github.com/acme/app";
  const entry = (roomIdentifier: string, focusRooms: unknown[] = []) => ({ roomIdentifier, displayName: roomIdentifier, role: "participant", latestMessageAt: null, focusRooms });
  const updatesRead: string[] = [];
  t.mock.module("../main/auth.js", { namedExports: {
    readStoredAuth: async () => ({ token: "token" }),
    apiFetch: async () => ({ records: [], truncated: false, tasks: [] }),
  } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: "cloud" }),
    cloudRoomIdentifierForStorage: (_storage: unknown, roomIdentifier: string) => roomIdentifier,
    localRoomIdentifierForStorage: (_storage: unknown, roomIdentifier: string) => roomIdentifier,
    listLocalRoomEntries: async () => [],
    listLocalTasks: async () => [],
  } });
  t.mock.module("../main/rooms/local-db.js", { namedExports: { getLocalChatDatabase: async () => { throw new Error("cloud rooms only"); } } });
  t.mock.module("../main/rooms/messages/local-store.js", { namedExports: { addLocalChatMessage: async () => undefined } });
  t.mock.module("../main/rooms/board-governance.js", { namedExports: { listDesktopPendingBoardIntents: async () => [] } });
  t.mock.module("../main/rooms/account-rooms.js", { namedExports: {
    listDesktopAccountRooms: async () => [entry(repo, [entry("focus_1"), entry("focus_2")]), entry("ad-hoc")],
  } });
  t.mock.module("../main/rooms/inbox.js", { namedExports: {
    getDesktopInboxUpdates: async (roomIdentifier: string) => {
      updatesRead.push(roomIdentifier);
      return { threads: { threads: [], hasMore: false, unreadThreadCount: 0 }, tasks: [], githubEvents: null, reasoningSessions: [], presence: [], unavailable: [], limited: false };
    },
  } });
  const { getDesktopNeedsYou } = await import(new URL(`../main/rooms/knowledge.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/rooms/knowledge.js");
  const parentsOf = (result: Awaited<ReturnType<typeof getDesktopNeedsYou>>) =>
    Object.fromEntries(result.rooms.map((room) => [room.roomIdentifier, room.parentRoomIdentifier ?? null]));

  const withUpdates = await getDesktopNeedsYou(true);
  assert.equal(withUpdates.updatesIncluded, true);
  assert.deepEqual(parentsOf(withUpdates), { [repo]: null, focus_1: repo, focus_2: repo, "ad-hoc": null });
  assert.deepEqual(updatesRead.sort(), ["ad-hoc", "focus_1", "focus_2", repo].sort());
  assert.ok(withUpdates.rooms.every((room) => room.updates));

  const withoutUpdates = await getDesktopNeedsYou();
  assert.equal(withoutUpdates.updatesIncluded, false, "a read made outside the Inbox says its updates are missing");
  assert.deepEqual(parentsOf(withoutUpdates), parentsOf(withUpdates));
  assert.ok(withoutUpdates.rooms.every((room) => room.updates === undefined));
  assert.equal(updatesRead.length, 4);
});

test("Needs you reads every listed cloud room in one request and only uncovered rooms one by one", async (t) => {
  const repo = "github.com/acme/app";
  const entry = (roomIdentifier: string, role = "participant", focusRooms: unknown[] = []) => ({ roomIdentifier, displayName: roomIdentifier, role, latestMessageAt: null, focusRooms });
  const paths: string[] = [];
  const record = (id: string) => ({ id, room_id: id, type: "attention", title: id, response: null });
  const intent = { id: "bi_1", room_id: repo, task_id: "task_7", action_type: "task_claim", payload: {}, payload_hash: "h", status: "pending",
    proposer_actor_label: "Summit", proposer_actor_key: "k", proposer_actor_instance_id: null, proposer_agent_session_id: null, decision_by: null,
    decision_reason: null, approval_token_hash: null, decided_at: null, expires_at: null, created_at: "2026-11-10T00:00:00.000Z", updated_at: "2026-11-10T00:00:00.000Z" };
  t.mock.module("../main/auth.js", { namedExports: {
    readStoredAuth: async () => ({ token: "token" }),
    apiFetch: async (path: string) => {
      paths.push(path);
      if (path === "/account/attention") return {
        rooms: [
          { room_id: "GitHub.com/acme/app", records: [record("ask-repo")], truncated: false, tasks: [], board_intents: [intent] },
          { room_id: "focus_1", records: [record("ask-focus")], truncated: true, tasks: [{ id: "task_1", title: "Card", status: "blocked", description: null, updated_at: "T" }] },
        ],
        failures: [{ room_id: "focus_2" }],
      };
      return { records: [record(path)], truncated: false, tasks: [] };
    },
  } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: "cloud" }),
    cloudRoomIdentifierForStorage: (_storage: unknown, roomIdentifier: string) => roomIdentifier,
    localRoomIdentifierForStorage: (_storage: unknown, roomIdentifier: string) => roomIdentifier,
    listLocalRoomEntries: async () => [],
    listLocalTasks: async () => [],
  } });
  t.mock.module("../main/rooms/local-db.js", { namedExports: { getLocalChatDatabase: async () => { throw new Error("cloud rooms only"); } } });
  t.mock.module("../main/rooms/messages/local-store.js", { namedExports: { addLocalChatMessage: async () => undefined } });
  t.mock.module("../main/rooms/board-governance.js", { namedExports: { listDesktopPendingBoardIntents: async (id: string) => { paths.push(`intents:${id}`); return []; } } });
  t.mock.module("../main/rooms/account-rooms.js", { namedExports: {
    listDesktopAccountRooms: async () => [entry(repo, "admin", [entry("focus_1"), entry("focus_2")]), entry("ad-hoc", "admin")],
  } });
  t.mock.module("../main/rooms/inbox.js", { namedExports: { getDesktopInboxUpdates: async () => { throw new Error("not read outside the Inbox"); } } });
  const { getDesktopNeedsYou } = await import(new URL(`../main/rooms/knowledge.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/rooms/knowledge.js");
  const result = await getDesktopNeedsYou();
  assert.deepEqual(paths.sort(), ["/account/attention", "/rooms/ad-hoc/attention", "intents:ad-hoc"].sort(),
    "a room the account read does not cover is still read by itself");
  const byRoom = Object.fromEntries(result.rooms.map((room) => [room.roomIdentifier, room]));
  assert.deepEqual(byRoom[repo]!.records.map((r) => r.id), ["ask-repo"]);
  assert.deepEqual(byRoom[repo]!.boardIntents!.map((i) => i.id), ["bi_1"]);
  assert.equal(byRoom.focus_1!.truncated, true);
  assert.deepEqual(byRoom.focus_1!.tasks.map((task) => task.id), ["task_1"]);
  assert.equal(byRoom.focus_1!.boardIntents, undefined);
  assert.deepEqual(result.failures.map((failure) => failure.roomIdentifier), ["focus_2"], "a room the server refused is a failure, as before");
});

test("a cloud room whose history is local on this device keeps reading its requests from the local store", async (t) => {
  const entry = (roomIdentifier: string) => ({ roomIdentifier, displayName: roomIdentifier, role: "participant", latestMessageAt: null, focusRooms: [] });
  const paths: string[] = [];
  t.mock.module("../main/auth.js", { namedExports: {
    readStoredAuth: async () => ({ token: "token" }),
    apiFetch: async (path: string) => {
      paths.push(path);
      if (path === "/account/attention") return { rooms: [
        { room_id: "forked-room", records: [{ id: "server-ask" }], truncated: false, tasks: [] },
        { room_id: "cloud-room", records: [{ id: "cloud-ask" }], truncated: false, tasks: [] },
      ], failures: [] };
      throw new Error(`unexpected ${path}`);
    },
  } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async (room: string) => ({ effectiveMode: room === "forked-room" ? "local" : "cloud" }),
    cloudRoomIdentifierForStorage: (_storage: unknown, roomIdentifier: string) => roomIdentifier,
    localRoomIdentifierForStorage: (_storage: unknown, roomIdentifier: string) => `local:${roomIdentifier}`,
    listLocalRoomEntries: async () => [],
    listLocalTasks: async () => [],
  } });
  t.mock.module("../main/rooms/local-db.js", { namedExports: { getLocalChatDatabase: async () => ({ prepare: () => ({ all: () => [], run: () => undefined }) }) } });
  t.mock.module("../../../../shared/local-room-knowledge.mjs", { namedExports: {
    getLocalKnowledge: () => null, initializeRoomKnowledge: () => undefined, localKnowledgeHistory: () => [], saveLocalKnowledge: () => undefined,
    listLocalKnowledge: (_db: unknown, room: string) => ({ records: [{ id: `local-ask:${room}` }], truncated: false }),
  } });
  t.mock.module("../main/rooms/messages/local-store.js", { namedExports: { addLocalChatMessage: async () => undefined } });
  t.mock.module("../main/rooms/board-governance.js", { namedExports: { listDesktopPendingBoardIntents: async () => [] } });
  t.mock.module("../main/rooms/account-rooms.js", { namedExports: { listDesktopAccountRooms: async () => [entry("forked-room"), entry("cloud-room")] } });
  t.mock.module("../main/rooms/inbox.js", { namedExports: { getDesktopInboxUpdates: async () => undefined } });
  const { getDesktopNeedsYou } = await import(new URL(`../main/rooms/knowledge.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/rooms/knowledge.js");
  const result = await getDesktopNeedsYou();
  const byRoom = Object.fromEntries(result.rooms.map((room) => [room.roomIdentifier, room.records.map((record) => record.id)]));
  assert.deepEqual(byRoom, { "forked-room": ["local-ask:local:forked-room"], "cloud-room": ["cloud-ask"] });
  assert.deepEqual(paths, ["/account/attention"]);
});

test("Needs you merges changes-only answers, reads the whole state again when they do not fit, and starts over on a new daemon generation", async () => {
  const entry = (id: string, desiredState: "running" | "paused" | "stopped") => ({ id, desiredState, activity: [] });
  const status = { implementationVersion: SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, generation: 1, capabilities: { agentStateSubscription: true } };
  let running = true;
  const wholeReads: Array<{ afterDaemonGeneration: number; afterSequence: number }> = [];
  const changeReads: Array<{ afterDaemonGeneration: number; afterSequence: number }> = [];
  const wholeAnswers = [
    { daemonGeneration: 1, sequence: 1, entries: [entry("a", "running"), entry("b", "stopped")] },
    // After the refused merge: the whole state at the daemon's sequence.
    { daemonGeneration: 1, sequence: 3, entries: [entry("a", "paused"), entry("b", "stopped"), entry("c", "running")] },
    // After the daemon restarted.
    { daemonGeneration: 2, sequence: 1, entries: [entry("a", "running")] },
  ];
  const changeAnswers = [
    { complete: false, daemonGeneration: 1, sequence: 2, changedEntries: [entry("a", "paused")], removedEntryIds: [], entryOrder: ["a", "b"] },
    // Names an entry neither side has: does not fit the state held.
    { complete: false, daemonGeneration: 1, sequence: 3, changedEntries: [], removedEntryIds: [], entryOrder: ["a", "b", "c"] },
    // The daemon restarted between two polls. The cursor is from another
    // generation, so the new daemon answers its whole state; the watch keeps
    // none of it until it has negotiated with this daemon (an entry only this
    // answer names would otherwise show in the snapshots below).
    { complete: true, daemonGeneration: 2, sequence: 1, entries: [entry("leaked", "running")] },
  ];
  let connects = 0;
  // Counted while the script runs: once it is exhausted the loop may negotiate once more before the subscriber leaves.
  supervisorDaemonClient.connectIfRunning = (async () => { if (running) connects += 1; return running ? status : null; }) as typeof supervisorDaemonClient.connectIfRunning;
  supervisorDaemonClient.watchState = (async (input: { afterDaemonGeneration: number; afterSequence: number }) => {
    wholeReads.push({ afterDaemonGeneration: input.afterDaemonGeneration, afterSequence: input.afterSequence });
    const answer = wholeAnswers.shift();
    if (!answer) { running = false; throw new Error("script exhausted"); }
    if (wholeAnswers.length === 1) status.generation = 2; // the daemon restarts after this answer is used
    if (wholeAnswers.length === 0) running = false;
    return answer;
  }) as unknown as typeof supervisorDaemonClient.watchState;
  supervisorDaemonClient.watchStateChanges = (async (input: { afterDaemonGeneration: number; afterSequence: number }) => {
    changeReads.push({ afterDaemonGeneration: input.afterDaemonGeneration, afterSequence: input.afterSequence });
    const answer = changeAnswers.shift();
    if (!answer) { running = false; throw new Error("script exhausted"); }
    return answer;
  }) as unknown as typeof supervisorDaemonClient.watchStateChanges;
  const settle = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };

  const snapshots: Array<{ daemonGeneration: number; sequence: number; entries: Array<{ id: string; desiredState: string }> }> = [];
  const stop = onSupervisorState((snapshot) => { snapshots.push(snapshot as unknown as (typeof snapshots)[number]); });
  await settle(() => snapshots.length === 4);
  await settle(() => liveSupervisorStateEntries() === null);
  stop();
  await supervisorStateWatchSettledForTest();
  assert.deepEqual(snapshots.map((snapshot) => [snapshot.daemonGeneration, snapshot.sequence, snapshot.entries.map((item) => `${item.id}:${item.desiredState}`)]), [
    [1, 1, ["a:running", "b:stopped"]],
    [1, 2, ["a:paused", "b:stopped"]],
    [1, 3, ["a:paused", "b:stopped", "c:running"]],
    [2, 1, ["a:running"]],
  ]);
  assert.deepEqual(changeReads.map((read) => read.afterSequence), [1, 2, 3, 1],
    "changes are asked for from the sequence held; the poll at 3 reached the restarted daemon, the one at 1 is the last poll of the new one");
  assert.equal(wholeReads.length, 3);
  assert.equal(wholeReads[1]!.afterSequence, 0, "a refused merge reads the whole state again");
  assert.deepEqual(wholeReads[2], { afterDaemonGeneration: 0, afterSequence: 0 }, "a new daemon generation starts over");
  assert.equal(connects, 2, "negotiated once at the start and once when an answer named another daemon: not before each of the seven polls");
});
