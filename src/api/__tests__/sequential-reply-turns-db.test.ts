import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { EventEmitter } from "node:events";
import { replyTurnGuidance } from "../../shared/activation-routing.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const settings = url ? await import("../db/room-settings.js") : null;
const activation = url ? await import("../routes/rooms/messages/receipt-activation.js") : null;
const routing = url ? await import("../db/messages/account-agent-routing.js") : null;
const holds = url ? await import("../server/reply-turn-holds.js") : null;
const events = url ? await import("../server/events.js") : null;
const rollout = url ? await import("../db/reply-turn-hold-rollout.js") : null;
const routes = url ? await import("../routes/rooms/messages/index.js") : null;
const broker_module = url ? await import("../server/room-event-broker.js") : null;
const overlays = url ? await import("../server/room-message-overlays.js") : null;
const headerNames = url ? await import("../../shared/request-headers.js") : null;
const skip = { skip: !url && "set TEST_DB_URL to run sequential reply turn tests" };

test.beforeEach(async () => {
  if (!client) return;
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
  await rollout!.reconcileReplyTurnHoldRollout(client.pool);
});
// Let after-commit wakes from the previous case finish before the schema resets.
test.afterEach(() => new Promise((resolve) => setTimeout(resolve, 50)));
test.after(async () => { await client?.pool.end(); });

type Activation = { decision: string; reason: string; turn?: { position: number; count: number; prior_speakers: string[] }; guidance?: string };

async function seed(count = 3, replyOrder: "sequential" | null = "sequential") {
  const room = await api!.createProjectWithName("turns-room");
  // Turn order is off by default; these cases run in a room whose admin turned it on.
  if (replyOrder) await settings!.setRoomAgentReplyOrder(room.id, replyOrder);
  const now = new Date().toISOString();
  const ownerId = "owner-turns";
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId,
    created_at: now, updated_at: now,
  });
  await api!.assignProjectAdmin(room.id, ownerId);
  const sessions = [];
  for (let i = 0; i < count; i++) sessions.push(await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "claude-code",
    actor_label: `Agent${i}`, agent_key: `${ownerId}/agent${i}`, display_name: `Agent${i}`,
    owner_account_id: ownerId, owner_label: ownerId, ide_label: "Agent",
  }));
  for (const session of sessions) await api!.markRoomAgentDeliveryConnected({
    room_id: room.id, actor_label: session.actor_label, display_name: session.display_name,
    agent_key: session.agent_key, agent_session_id: session.session_id, session_kind: "worker",
    transport: "long_poll", delivery_instance_id: `poll-${session.session_id}`,
    credential_fence: { kind: "session_token", token_hash: createHash("sha256").update(session.session_token).digest("hex") },
  });
  const send = (text: string, extra = {}) => api!.addMessageWithCreateStatus(room.id, ownerId, text, {
    source: "browser", account_id: ownerId, ...extra,
  });
  const identity = (index: number) => ({
    actor_label: sessions[index]!.actor_label, agent_key: sessions[index]!.agent_key,
    owner_account_id: ownerId, agent_instance_id: null, agent_session_id: sessions[index]!.session_id,
    session_kind: "worker" as const, runtime: "claude-code", display_name: sessions[index]!.display_name,
    owner_label: ownerId, ide_label: "Agent", repo_branch: null,
  });
  // The durable worker read: the poll's initial page and its activation authority.
  const read = async (index: number, after?: string) => {
    const page = await api!.getMessagesAfter(room.id, after, {
      wait_for_routing: true, hold_agent_key: sessions[index]!.agent_key,
    });
    return activation!.attachReceiptAuthorityActivations(room.id, identity(index), page.messages);
  };
  // The live overlay path: the batched account envelope the broker applies.
  const live = async (index: number, messageId: string) => {
    const number = Number(messageId.slice(4));
    const rows = await routing!.getMessageAccountRoutingRows(client!.db, room.id, [number]);
    const envelope = (await routing!.getMessageAccountAgentRoutings(client!.db, room.id, [ownerId], rows))
      .get(ownerId)!.get(number)!;
    return activation!.attachAccountRoutingAuthorityActivation({ id: messageId }, identity(index), envelope) as { activation: { for_current_agent: Activation } };
  };
  const forAgent = (messages: { id: string }[], id: string) =>
    (messages.find((message) => message.id === id) as unknown as { activation: { for_current_agent: Activation } } | undefined)
      ?.activation.for_current_agent;
  const turns = async (messageId: string) => (await client!.pool.query(
    `SELECT agent_key, turn_position, turn_count, hold_released_at IS NOT NULL AS released
       FROM message_agent_receipts WHERE message_room_id = $1 AND message_number = $2
      ORDER BY turn_position NULLS LAST, agent_key`,
    [room.id, Number(messageId.slice(4))],
  )).rows as Array<{ agent_key: string; turn_position: number | null; turn_count: number | null; released: boolean }>;
  const reply = (index: number, messageId: string, text = "My answer.", extra = {}) =>
    api!.addMessageWithCreateStatus(room.id, sessions[index]!.actor_label, text, {
      source: "agent",
      publisher_agent_key: sessions[index]!.agent_key,
      publisher_agent_session_id: sessions[index]!.session_id,
      account_id: ownerId,
      client_message_id: `supervised-room:supervised_${index}:${room.id}:${messageId}:reply:v1`,
      ...extra,
    });
  return { room, ownerId, sessions, send, read, live, forAgent, turns, reply };
}

/** Index of the session in each reply position, from the stored receipts. */
async function order(a: Awaited<ReturnType<typeof seed>>, messageId: string): Promise<number[]> {
  return (await a.turns(messageId)).map((row) => a.sessions.findIndex((session) => session.agent_key === row.agent_key));
}

test("paused, desktop-only, stale and retired delivery credentials cannot block live reply turns", skip, async () => {
  const a = await seed(7);
  const ids = a.sessions.map(s => s.session_id);
  await client!.pool.query("UPDATE room_agent_delivery_sessions SET active_connection_count=0 WHERE agent_session_id=$1", [ids[0]]);
  // A room window can keep its summary fresh without a worker poll.
  await client!.pool.query("DELETE FROM room_agent_delivery_instances WHERE delivery_key=$1", [`agent_session:${ids[1]}`]);
  await client!.pool.query("UPDATE room_agent_delivery_instances SET updated_at=now()-interval '2 minutes' WHERE delivery_key=$1", [`agent_session:${ids[2]}`]);
  await client!.pool.query("UPDATE room_agent_delivery_instances SET credential_fingerprint='retired' WHERE delivery_key=$1", [`agent_session:${ids[3]}`]);
  await client!.pool.query("UPDATE room_agent_sessions SET token_hash='rotated' WHERE session_id=$1", [ids[4]]);
  const sent = await a.send("@everyone what is our next step?");
  const rows = await a.turns(sent.message.id);
  assert.equal(rows.length, 7, "all routing receipts survive");
  assert.deepEqual(rows.slice(0, 2).map(row => [row.turn_position, row.turn_count, row.released]), [[1, 2, true], [2, 2, false]]);
  assert.deepEqual(new Set(rows.slice(0, 2).map(row => row.agent_key)), new Set(a.sessions.slice(5).map(s => s.agent_key)));
  assert.ok(rows.slice(2).every(row => row.turn_position === null));
  const first = a.sessions.findIndex(s => s.agent_key === rows[0]!.agent_key);
  assert.ok((await a.read(first)).some(message => message.id === sent.message.id), "first live worker sees the message immediately");
});

test("offline room history does not push a small live team past the turn limit", skip, async () => {
  const a = await seed(10);
  await client!.pool.query("UPDATE room_agent_delivery_sessions SET active_connection_count=0 WHERE agent_session_id=ANY($1::text[])", [a.sessions.slice(0, 8).map(s => s.session_id)]);
  const sent = await a.send("@everyone what should we do next?");
  const rows = await a.turns(sent.message.id);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.filter(row => row.turn_position !== null).map(row => row.turn_count), [2, 2]);
});

test("a live bearer poll stays ready after a desktop token heartbeat, but revoked credentials do not", skip, async () => {
  const { getReplyTurnReadySessions } = await import("../db/messages/session-connections.js");
  const a = await seed(2);
  const session = a.sessions[0]!;
  const tokenFence = { kind: "session_token" as const, token_hash: createHash("sha256").update(session.session_token).digest("hex") };
  const fields = { room_id: a.room.id, actor_label: session.actor_label, display_name: session.display_name,
    agent_key: session.agent_key, agent_session_id: session.session_id, session_kind: "worker" as const };
  const now = new Date().toISOString();
  await client!.db.insert(schema!.room_agent_session_bearers).values({
    bearer_id: "trial-bearer", session_id: session.session_id, room_id: a.room.id,
    token_hash: "trial-bearer-token", generation: 77, capabilities: [], issued_at: now, created_at: now,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await client!.pool.query("DELETE FROM room_agent_delivery_instances WHERE delivery_key=$1", [`agent_session:${session.session_id}`]);
  await api!.markRoomAgentDeliveryConnected({ ...fields, transport: "long_poll", delivery_instance_id: "bearer-poll",
    credential_fence: { kind: "bearer", bearer_id: "trial-bearer", generation: 77 } });
  await api!.upsertDesktopRoomAgentDeliveryHeartbeat({ ...fields, credential_fence: tokenFence });
  assert.ok((await getReplyTurnReadySessions(client!.db, a.room.id, [session.session_id])).has(session.session_id));
  await client!.pool.query("UPDATE room_agent_session_bearers SET revoked_at=now() WHERE bearer_id='trial-bearer'");
  assert.equal((await getReplyTurnReadySessions(client!.db, a.room.id, [session.session_id])).size, 0);
});

test("a broadcast to three agents is sequenced, rotated, and hidden from later positions", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const later = await a.send("one more thought");
  const number = Number(sent.message.id.slice(4));
  const rows = await a.turns(sent.message.id);
  assert.deepEqual(rows.map((row) => [row.turn_position, row.turn_count, row.released]), [[1, 3, true], [2, 3, false], [3, 3, false]]);
  const sortedKeys = a.sessions.map((session) => session.agent_key).sort();
  assert.deepEqual(rows.map((row) => row.agent_key), [0, 1, 2].map((i) => sortedKeys[(i + number) % 3]), "rotated by message number");
  const [first, second, third] = await order(a, sent.message.id);

  const firstRead = await a.read(first!, before.message.id);
  assert.deepEqual(firstRead.map((message) => message.id), [sent.message.id, later.message.id]);
  assert.deepEqual(a.forAgent(firstRead, sent.message.id)?.turn, { position: 1, count: 3, prior_speakers: [] });
  assert.equal(a.forAgent(firstRead, sent.message.id)?.guidance, replyTurnGuidance(1, 3));
  for (const held of [second!, third!]) {
    assert.deepEqual((await a.read(held, before.message.id)).map((message) => message.id), [], "held message and everything after it");
    assert.equal((await api!.getMessageStreamCheckpoint(a.room.id, { waitForRouting: true, holdAgentKey: a.sessions[held]!.agent_key })).checkpoint, before.message.id);
  }
  assert.equal((await api!.getMessagesAfter(a.room.id, before.message.id)).messages.length, 2, "people still see everything");

  const nextSent = await a.send("@everyone and after that?");
  assert.notDeepEqual(await order(a, nextSent.message.id), [first, second, third], "the first speaker changes");
});

test("a supervised reply releases the next position, which sees who answered; the last stays hidden", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [first, second, third] = await order(a, sent.message.id);
  const routed: string[] = [];
  const onRouted = (event: { message: { id: string } }) => routed.push(event.message.id);
  events!.messageEvents.on("message:routed", onRouted);
  try {
    const reply = await api!.addMessageWithCreateStatus(a.room.id, a.sessions[first!]!.actor_label, "Build the board view.", {
      source: "agent",
      publisher_agent_key: a.sessions[first!]!.agent_key,
      publisher_agent_session_id: a.sessions[first!]!.session_id,
      account_id: a.ownerId,
      // The daemon's real reply id: supervised-room:<agent>:<room>:<message>:reply:v1.
      client_message_id: `supervised-room:supervised_turns:${a.room.id}:${sent.message.id}:reply:v1`,
    });
    const rows = await a.turns(sent.message.id);
    assert.deepEqual(rows.map((row) => row.released), [true, true, false]);
    const state = await client!.pool.query("SELECT receipt_state FROM message_agent_receipts WHERE message_room_id=$1 AND message_number=$2 AND agent_key=$3",
      [a.room.id, Number(sent.message.id.slice(4)), a.sessions[first!]!.agent_key]);
    assert.equal(state.rows[0]!.receipt_state, "replied");
    for (let i = 0; i < 50 && !routed.includes(sent.message.id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(routed.includes(sent.message.id), "the held agent's long-poll is woken");

    const secondRead = await a.read(second!, before.message.id);
    assert.deepEqual(secondRead.map((message) => message.id), [sent.message.id, reply.message.id]);
    const expected = {
      position: 2, count: 3, prior_speakers: [a.sessions[first!]!.actor_label],
    };
    assert.deepEqual(a.forAgent(secondRead, sent.message.id)?.turn, expected);
    assert.match(a.forAgent(secondRead, sent.message.id)?.guidance ?? "", /answered before you\. Use their replies where available/);
    assert.deepEqual((await a.live(second!, sent.message.id)).activation.for_current_agent.turn, expected, "live overlay agrees");
    assert.deepEqual((await a.live(first!, sent.message.id)).activation.for_current_agent.turn, { position: 1, count: 3, prior_speakers: [] });
    assert.deepEqual((await a.read(third!, before.message.id)).map((message) => message.id), []);
  } finally {
    events!.messageEvents.off("message:routed", onRouted);
  }
});

test("the deadline sweep releases a hold and the guidance says the agent before ran out of time", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [, second, third] = await order(a, sent.message.id);
  await client!.pool.query(
    "UPDATE message_agent_receipts SET hold_release_after = now() - interval '1 second' WHERE message_number = $1 AND turn_position = 2",
    [Number(sent.message.id.slice(4))],
  );
  assert.equal(await holds!.sweepReplyTurnHoldsOnce(), 1);
  assert.equal(await holds!.sweepReplyTurnHoldsOnce(), 0, "a release happens once");
  const secondRead = await a.read(second!, before.message.id);
  const turn = a.forAgent(secondRead, sent.message.id);
  assert.deepEqual(turn?.turn, { position: 2, count: 3, prior_speakers: [] });
  assert.equal(turn?.guidance, replyTurnGuidance(2, 3, [], "deadline"));
  assert.equal((await a.live(second!, sent.message.id)).activation.for_current_agent.guidance, turn?.guidance);
  assert.deepEqual((await a.read(third!, before.message.id)).map((message) => message.id), []);
});

test("an agent that leaves the room releases the next position", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [first, second, third] = await order(a, sent.message.id);
  await api!.endRoomAgentSession({ session_id: a.sessions[first!]!.session_id, room_id: a.room.id });
  assert.deepEqual((await a.turns(sent.message.id)).map((row) => row.released), [true, true, false]);
  assert.deepEqual((await a.read(second!, before.message.id)).map((message) => message.id), [sent.message.id]);
  assert.deepEqual((await a.read(third!, before.message.id)).map((message) => message.id), []);
});

test("parallel rooms and explicit mentions never hold", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const mention = await a.send("@Agent1 @Agent2 please both look");
  assert.deepEqual((await a.turns(mention.message.id)).map((row) => [row.turn_position, row.released]), [[null, false], [null, false]]);
  for (const index of [1, 2]) {
    assert.deepEqual((await a.read(index, before.message.id)).map((message) => message.id), [mention.message.id]);
  }
  await settings!.setRoomAgentReplyOrder(a.room.id, "parallel");
  const broadcast = await a.send("@everyone what should we build next?");
  assert.ok((await a.turns(broadcast.message.id)).every((row) => row.turn_position === null));
  for (const index of [0, 1, 2]) {
    const page = await a.read(index, mention.message.id);
    assert.deepEqual(page.map((message) => message.id), [broadcast.message.id]);
    assert.equal(a.forAgent(page, broadcast.message.id)?.turn, undefined);
  }
});

test("a room with no reply order setting stays parallel", skip, async () => {
  const a = await seed(3, null);
  const before = await a.send("@Agent0 warm up");
  const broadcast = await a.send("@everyone what should we build next?");
  assert.deepEqual((await a.turns(broadcast.message.id)).map((row) => [row.turn_position, row.turn_count, row.released]),
    [[null, null, false], [null, null, false], [null, null, false]]);
  for (const index of [0, 1, 2]) {
    const page = await a.read(index, before.message.id);
    assert.deepEqual(page.map((message) => message.id), [broadcast.message.id], "every agent sees it at once");
    assert.equal(a.forAgent(page, broadcast.message.id)?.turn, undefined);
    assert.equal(a.forAgent(page, broadcast.message.id)?.guidance, undefined);
  }
});

test("the small-room fallback with two agents is sequenced too", skip, async () => {
  const a = await seed(2);
  const sent = await a.send("what do you both think?");
  const rows = await a.turns(sent.message.id);
  assert.deepEqual(rows.map((row) => [row.turn_position, row.turn_count, row.released]), [[1, 2, true], [2, 2, false]]);
});

test("a held agent that leaves is skipped; the next waits for the earlier position, then names it", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [first, second, third] = await order(a, sent.message.id);
  await api!.endRoomAgentSession({ session_id: a.sessions[second!]!.session_id, room_id: a.room.id });
  assert.deepEqual((await a.turns(sent.message.id)).map((row) => row.released), [true, true, false],
    "the leaving held agent is skipped, but position 1 has not answered yet");
  assert.deepEqual((await a.read(third!, before.message.id)).map((message) => message.id), []);
  const answer = await a.reply(first!, sent.message.id);
  assert.deepEqual((await a.turns(sent.message.id)).map((row) => row.released), [true, true, true]);
  const page = await a.read(third!, before.message.id);
  assert.deepEqual(page.map((message) => message.id), [sent.message.id, answer.message.id]);
  const turn = a.forAgent(page, sent.message.id);
  assert.deepEqual(turn?.turn, { position: 3, count: 3, prior_speakers: [a.sessions[first!]!.actor_label] });
  assert.match(turn?.guidance ?? "", new RegExp(`^Turn order: you answer this message in position 3 of 3\\. ${a.sessions[first!]!.actor_label} answered before you\\.`));
});

async function seedThreadTurn() {
  const a = await seed();
  const root = await a.send("Discussion history.");
  const priorReplies = [];
  for (let index = 0; index < a.sessions.length; index++) {
    priorReplies.push(await a.reply(index, root.message.id, "An earlier perspective.", {
      thread_root_message_id: root.message.id,
    }));
  }
  const sent = await a.send("@everyone what should we do next?", {
    thread_root_message_id: root.message.id,
  });
  const positions = await order(a, sent.message.id);
  assert.deepEqual((await a.turns(sent.message.id)).map(row => row.released), [true, false, false]);
  return { ...a, root, priorReplies, sent, positions };
}

test("ordinary peer thread replies preserve the remaining sequential turn holds", skip, async () => {
  const a = await seedThreadTurn();
  const [first, second, third] = a.positions as [number, number, number];
  const before = a.priorReplies.at(-1)!.message.id;
  const answer = await a.reply(first, a.sent.message.id, "My next perspective.", {
    thread_root_message_id: a.root.message.id,
  });
  assert.deepEqual((await a.turns(a.sent.message.id)).map(row => row.released), [true, true, false],
    "only the next speaker is released when the first answers in the thread");
  const peerReceipts = (await client!.pool.query(
    "SELECT agent_key, activation_reason FROM message_agent_receipts WHERE message_room_id=$1 AND message_number=$2 ORDER BY agent_key",
    [a.room.id, Number(answer.message.id.slice(4))],
  )).rows;
  assert.deepEqual(peerReceipts, [second, third].map(index => ({
    agent_key: a.sessions[index]!.agent_key, activation_reason: "thread_participant",
  })).sort((left, right) => left.agent_key.localeCompare(right.agent_key)),
  "peer messages remain deliverable; thread participation is not dropped");
  assert.deepEqual((await a.read(third, before)).map(message => message.id), []);
  const nextPage = await a.read(second, before);
  assert.deepEqual(nextPage.map(message => message.id), [a.sent.message.id, answer.message.id]);
  assert.equal(a.forAgent(nextPage, answer.message.id)?.reason, "thread_participant");
  await a.reply(second, a.sent.message.id, "Building on that.", { thread_root_message_id: a.root.message.id });
  assert.deepEqual((await a.turns(a.sent.message.id)).map(row => row.released), [true, true, true]);
  assert.ok((await a.read(third, before)).some(message => message.id === answer.message.id));
});

for (const leaseState of ["active", "expired", "ambiguous"] as const) {
  test(`peer thread task follow-up preserves ${leaseState} lease authority`, skip, async () => {
    const a = await seedThreadTurn();
    const [first, second, third] = a.positions as [number, number, number];
    for (const index of leaseState === "ambiguous" ? [third, second] : [third]) {
      await client!.pool.query(`INSERT INTO task_leases (
        id, room_id, task_id, kind, status, agent_key, agent_session_id,
        actor_label, expires_at, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, 'work', 'active', $4, $5, $6,
        NOW() + $7::interval, $8, NOW(), NOW())`, [
        `thread-lease-${index}`, a.room.id, `thread-task-${index}`,
        a.sessions[index]!.agent_key, a.sessions[index]!.session_id,
        a.sessions[index]!.actor_label, leaseState === "expired" ? "-1 hour" : "1 hour", a.ownerId,
      ]);
    }
    const followUp = await api!.addMessageWithCreateStatus(a.room.id, a.sessions[first]!.actor_label, "continue", {
      source: "agent", account_id: a.ownerId,
      publisher_agent_key: a.sessions[first]!.agent_key,
      publisher_agent_session_id: a.sessions[first]!.session_id,
      thread_root_message_id: a.root.message.id,
    });
    assert.deepEqual((await a.turns(a.sent.message.id)).map(row => row.released),
      leaseState === "active" ? [true, false, true] : [true, false, false],
      "only an unambiguous current task owner can interrupt the sequence");
    const before = a.priorReplies.at(-1)!.message.id;
    assert.deepEqual(await a.read(second, before), []);
    const page = await a.read(third, before);
    if (leaseState === "active") assert.equal(a.forAgent(page, followUp.message.id)?.reason, "thread_participant");
    else assert.deepEqual(page, []);
  });
}

for (const interruption of ["human_thread", "agent_mention", "agent_quote"] as const) {
  test(`thread turn holds still yield to ${interruption}`, skip, async () => {
    const a = await seedThreadTurn();
    const [first, second, third] = a.positions as [number, number, number];
    let interrupt;
    if (interruption === "human_thread") {
      interrupt = await a.send("Please reconsider this before continuing.", { thread_root_message_id: a.root.message.id });
    } else {
      interrupt = await api!.addMessageWithCreateStatus(a.room.id, a.sessions[first]!.actor_label,
        interruption === "agent_mention" ? `@${a.sessions[third]!.display_name} please check this.` : "Please check this point.", {
          source: "agent", account_id: a.ownerId,
          publisher_agent_key: a.sessions[first]!.agent_key,
          publisher_agent_session_id: a.sessions[first]!.session_id,
          thread_root_message_id: a.root.message.id,
          ...(interruption === "agent_quote" ? { reply_to_message_id: a.priorReplies[third]!.message.id } : {}),
        });
    }
    assert.deepEqual((await a.turns(a.sent.message.id)).map(row => row.released),
      interruption === "human_thread" ? [true, true, true] : [true, false, true]);
    const before = a.priorReplies.at(-1)!.message.id;
    const page = await a.read(third, before);
    assert.equal(a.forAgent(page, interrupt.message.id)?.reason,
      interruption === "human_thread" ? "thread_participant" : interruption === "agent_mention" ? "explicit_mention" : "reply_target");
    if (interruption !== "human_thread") assert.deepEqual(await a.read(second, before), []);
  });
}

test("a mention to a held agent ends its holds at once and wakes only that agent", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [, second, third] = await order(a, sent.message.id);
  const wakes: Array<{ id: string; keys: string[] | undefined }> = [];
  const onRouted = (event: { message: { id: string }; wakeAgentKeys?: string[] }) =>
    wakes.push({ id: event.message.id, keys: event.wakeAgentKeys });
  events!.messageEvents.on("message:routed", onRouted);
  try {
    const mention = await a.send(`@${a.sessions[third!]!.display_name} can you check the logs?`);
    const page = await a.read(third!, before.message.id);
    assert.deepEqual(page.map((message) => message.id), [sent.message.id, mention.message.id]);
    assert.equal(a.forAgent(page, mention.message.id)?.reason, "explicit_mention");
    assert.equal(a.forAgent(page, sent.message.id)?.guidance,
      replyTurnGuidance(3, 3, [], "activation"),
      "a turn opened by a direct activation does not claim the others ran out of time");
    assert.deepEqual((await a.read(second!, before.message.id)).map((message) => message.id), [], "others stay held");
    for (let i = 0; i < 50 && wakes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(wakes, [{ id: sent.message.id, keys: [a.sessions[third!]!.agent_key] }]);
  } finally {
    events!.messageEvents.off("message:routed", onRouted);
  }
});

test("a hold ends at its deadline even when no sweep runs, and the frontier uses the held-only index", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [, second] = await order(a, sent.message.id);
  await client!.pool.query("SET enable_seqscan = off");
  try {
    const plan = (await client!.pool.query(
      `EXPLAIN SELECT number FROM messages WHERE room_id = $1 AND number < COALESCE((
         SELECT min(held.message_number) FROM message_agent_receipts held
          WHERE held.message_room_id = $1 AND held.agent_key = $2
            AND held.hold_released_at IS NULL AND held.hold_release_after IS NOT NULL
            AND held.hold_release_after > now()), 2147483648)`,
      [a.room.id, a.sessions[second!]!.agent_key],
    )).rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /message_agent_receipts_reply_turn_hold_idx/);
  } finally {
    await client!.pool.query("RESET enable_seqscan");
  }
  await client!.pool.query(
    "UPDATE message_agent_receipts SET hold_release_after = now() - interval '1 second' WHERE message_number = $1 AND turn_position = 2",
    [Number(sent.message.id.slice(4))],
  );
  const page = await a.read(second!, before.message.id);
  assert.deepEqual(page.map((message) => message.id), [sent.message.id]);
  assert.equal(a.forAgent(page, sent.message.id)?.guidance,
    replyTurnGuidance(2, 3, [], "deadline"));
  assert.deepEqual((await a.turns(sent.message.id)).map((row) => row.released), [true, false, false], "no sweep has run");
});

test("the post-migration rollout builds valid hold indexes and replaces an invalid shell", skip, async () => {
  const valid = async () => (await client!.pool.query(
    `SELECT pg_class.relname AS name, pg_index.indisvalid AS valid FROM pg_index
       JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      WHERE pg_class.relname LIKE 'message_agent_receipts_reply_turn_%' ORDER BY 1`,
  )).rows;
  assert.deepEqual(await valid(), [
    { name: "message_agent_receipts_reply_turn_due_idx", valid: true },
    { name: "message_agent_receipts_reply_turn_hold_idx", valid: true },
  ]);
  assert.deepEqual(await rollout!.reconcileReplyTurnHoldRollout(client!.pool), [], "a second run builds nothing");
  await client!.pool.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'message_agent_receipts_reply_turn_hold_idx'::regclass");
  assert.deepEqual(await rollout!.reconcileReplyTurnHoldRollout(client!.pool), ["message_agent_receipts_reply_turn_hold_idx"]);
  assert.ok((await valid()).every((row) => row.valid));
  const migration = (await import("node:fs")).readFileSync(path.resolve("drizzle/0112_sequential_reply_turns.sql"), "utf8");
  assert.doesNotMatch(migration, /^\s*CREATE\s+INDEX/im, "no index build inside the migration transaction");
});

/** The real poll route, with a real worker session credential on the request. */
function pollRoute(roomId: string) {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const putHandlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = { get: (path: RegExp, handler: never) => handlers.set(path.toString(), handler),
    put: (path: RegExp, handler: never) => putHandlers.set(path.toString(), handler),
    post() {}, patch() {}, delete() {} };
  const sources = {
    messageEvents: events!.messageEvents, taskEvents: new EventEmitter(), reasoningEvents: new EventEmitter(),
    githubRoomEvents: new EventEmitter(), artifactEvents: new EventEmitter(), rentalActivityEvents: new EventEmitter(),
    messageInfoEvents: new EventEmitter(),
  };
  const broker = broker_module!.createRoomEventBroker(sources);
  const batcher = overlays!.createRoomMessageOverlayBatcher();
  routes!.registerRoomMessageRoutes(app as never, {
    roomEventBroker: broker,
    roomMessageOverlayBatcher: batcher,
    resolveCanonicalRoomRequestId: async () => roomId,
    resolveRoomOrReply: async () => ({ id: roomId }),
    requireParticipant: async () => true,
    reauthorizeGitRoomParticipant: async () => true,
    resolveRequestProjectRepoAccessRoomName: async () => roomId,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: () => null,
    parseOptionalThreadRootMessageId: () => null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: async () => { throw new Error("not invoked"); },
    rememberRoomParticipantFromMessage: async () => undefined,
    rememberAccountRoom: async () => undefined,
  } as never);
  const handler = [...handlers].find(([path]) => path.includes("messages\\/poll"))![1];
  const poll = (session: { session_id: string; session_token: string }, ownerId: string, after: string, timeout: string) =>
    new Promise<{ statusCode: number; body: { messages: Array<Record<string, any>>; last_observed_message_id?: string | null } }>((resolve, reject) => {
      const headers = new Map([
        [headerNames!.LETAGENTS_AGENT_SESSION_ID_HEADER.toLowerCase(), session.session_id],
        [headerNames!.LETAGENTS_AGENT_SESSION_TOKEN_HEADER.toLowerCase(), session.session_token],
      ]);
      const req = Object.assign(new EventEmitter(), {
        params: { 0: roomId }, query: { after, timeout }, body: {}, authKind: "owner_token",
        sessionAccount: { account_id: ownerId, login: ownerId },
        get: (name: string) => headers.get(name.toLowerCase()) ?? "",
        header: (name: string) => headers.get(name.toLowerCase()) ?? "",
        headers: Object.fromEntries(headers),
      });
      const res = {
        statusCode: 200, headersSent: false,
        status(code: number) { this.statusCode = code; return this; },
        json(body: any) { this.headersSent = true; resolve({ statusCode: this.statusCode, body }); return this; },
        setHeader() { return this; },
      };
      handler(req, res).catch(reject);
    });
  const selfReceipt = [...putHandlers].find(([path]) => path.includes("agent-receipts"))![1];
  const reportSelf = (session: { session_id: string; session_token: string }, ownerId: string, messageId: string, state: string) =>
    new Promise<{ statusCode: number; body: Record<string, unknown> }>((resolve, reject) => {
      const headers = new Map([
        [headerNames!.LETAGENTS_AGENT_SESSION_ID_HEADER.toLowerCase(), session.session_id],
        [headerNames!.LETAGENTS_AGENT_SESSION_TOKEN_HEADER.toLowerCase(), session.session_token],
      ]);
      const req = {
        params: { 0: roomId, 1: messageId }, query: {}, body: { receipt_state: state, agent_session_id: session.session_id, agent_session_token: session.session_token },
        authKind: "owner_token",
        sessionAccount: { account_id: ownerId, login: ownerId },
        get: (name: string) => headers.get(name.toLowerCase()) ?? "",
        header: (name: string) => headers.get(name.toLowerCase()) ?? "",
        headers: Object.fromEntries(headers),
      };
      const res = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(body: any) { resolve({ statusCode: this.statusCode, body }); return this; },
      };
      selfReceipt(req, res).catch(reject);
    });
  const historyHandler = handlers.get(/^\/rooms\/(.+)\/messages$/.toString())!;
  const history = (session: { session_id: string; session_token: string } | null, ownerId: string, query: Record<string, string>) =>
    new Promise<{ statusCode: number; body: { context_only?: boolean; room_id?: string; messages: Array<Record<string, any>> } }>((resolve, reject) => {
      const headers = new Map(session ? [
        [headerNames!.LETAGENTS_AGENT_SESSION_ID_HEADER.toLowerCase(), session.session_id],
        [headerNames!.LETAGENTS_AGENT_SESSION_TOKEN_HEADER.toLowerCase(), session.session_token],
      ] : []);
      const req = { params: { 0: roomId }, query, body: {}, authKind: "owner_token",
        sessionAccount: { account_id: ownerId, login: ownerId },
        get: (name: string) => headers.get(name.toLowerCase()) ?? "",
        header: (name: string) => headers.get(name.toLowerCase()) ?? "", headers: Object.fromEntries(headers) };
      const res = { statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(body: any) { resolve({ statusCode: this.statusCode, body }); return this; } };
      historyHandler(req, res).catch(reject);
    });
  return { poll, reportSelf, history, close: () => { broker.close?.(); batcher.close(); } };
}

test("the poll route hides a held turn from its worker, then delivers it with turn and guidance", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [first, second] = await order(a, sent.message.id);
  const route = pollRoute(a.room.id);
  try {
    const held = await route.poll(a.sessions[second!]!, a.ownerId, before.message.id, "150");
    assert.equal(held.statusCode, 200);
    assert.deepEqual(held.body.messages, [], "nothing is delivered while the turn is held");
    assert.ok(!held.body.last_observed_message_id || held.body.last_observed_message_id === before.message.id,
      "the cursor never passes the held message");
    const open = await route.poll(a.sessions[first!]!, a.ownerId, before.message.id, "2000");
    assert.deepEqual(open.body.messages.map((message) => message.id), [sent.message.id]);
    assert.deepEqual(open.body.messages[0]!.activation.for_current_agent.turn, { position: 1, count: 3, prior_speakers: [] });

    // A long-poll that is already waiting wakes when the predecessor replies.
    const waiting = route.poll(a.sessions[second!]!, a.ownerId, before.message.id, "5000");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answer = await a.reply(first!, sent.message.id);
    const woken = await waiting;
    assert.deepEqual(woken.body.messages.map((message) => message.id), [sent.message.id, answer.message.id]);
    const activation = woken.body.messages[0]!.activation.for_current_agent;
    assert.deepEqual(activation.turn, { position: 2, count: 3, prior_speakers: [a.sessions[first!]!.actor_label] });
    assert.match(activation.guidance, /answered before you\. Use their replies where available/);
  } finally {
    route.close();
  }
});

test("a quick follow-up broadcast does not let a held agent answer the previous one out of turn", skip, async () => {
  const a = await seed(2);
  const before = await a.send("@Agent0 warm up");
  const first = await a.send("what do you both think?");
  const [, heldOnFirst] = await order(a, first.message.id);
  const second = await a.send("and one more question for you both");
  const secondOrder = await order(a, second.message.id);
  assert.equal(secondOrder[0], heldOnFirst, "the held agent speaks first on the follow-up");
  assert.deepEqual((await a.turns(first.message.id)).map((row) => row.released), [true, false],
    "position 1 of the follow-up does not release the earlier hold");
  assert.deepEqual((await a.read(heldOnFirst!, before.message.id)).map((message) => message.id), [],
    "the follow-up waits behind the earlier held turn");
});

test("a legacy silent position 1 does not stall the chain after a deadline release", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 warm up");
  const sent = await a.send("@everyone what should we build next?");
  const [, second, third] = await order(a, sent.message.id);
  await client!.pool.query(
    "UPDATE message_agent_receipts SET hold_release_after = now() - interval '1 second' WHERE message_number = $1 AND turn_position = 2",
    [Number(sent.message.id.slice(4))],
  );
  assert.equal(await holds!.sweepReplyTurnHoldsOnce(), 1);
  const done = await client!.pool.query(
    "SELECT turn_position, turn_done_at IS NOT NULL AS done, hold_release_reason FROM message_agent_receipts WHERE message_number = $1 ORDER BY turn_position",
    [Number(sent.message.id.slice(4))],
  );
  assert.deepEqual(done.rows, [
    { turn_position: 1, done: true, hold_release_reason: null },
    { turn_position: 2, done: false, hold_release_reason: "deadline" },
    { turn_position: 3, done: false, hold_release_reason: null },
  ], "the silent position 1 is closed when position 2 gives up waiting for it");
  const answer = await a.reply(second!, sent.message.id);
  assert.deepEqual((await a.turns(sent.message.id)).map((row) => row.released), [true, true, true], "position 3 is released by 2's reply at once");
  const page = await a.read(third!, before.message.id);
  assert.deepEqual(page.map((message) => message.id), [sent.message.id, answer.message.id]);
  assert.deepEqual(a.forAgent(page, sent.message.id)?.turn?.prior_speakers, [a.sessions[second!]!.actor_label]);
});

test("a self-reported no_reply ends the turn and releases the next position", skip, async () => {
  const a = await seed();
  const sent = await a.send("@everyone what should we build next?");
  const [first] = await order(a, sent.message.id);
  const route = pollRoute(a.room.id);
  try {
    const reported = await route.reportSelf(a.sessions[first!]!, a.ownerId, sent.message.id, "no_reply");
    assert.equal(reported.statusCode, 200, JSON.stringify(reported.body));
    assert.deepEqual((await a.turns(sent.message.id)).map((row) => row.released), [true, true, false]);
  } finally {
    route.close();
  }
});

test("a successor can settle its retired session's silent outcome without reviving another turn", skip, async () => {
  const a = await seed();
  const sent = await a.send("@everyone what should we build next?");
  const [first] = await order(a, sent.message.id);
  const predecessor = a.sessions[first!]!;
  await api!.endRoomAgentSession({ session_id: predecessor.session_id, room_id: a.room.id });
  const before = await a.turns(sent.message.id);
  const successor = await api!.createRoomAgentSession({
    room_id: a.room.id, session_kind: "worker", runtime: "claude-code",
    actor_label: predecessor.actor_label, display_name: predecessor.display_name,
    agent_key: predecessor.agent_key, owner_account_id: a.ownerId,
    owner_label: a.ownerId, ide_label: "Agent",
  });
  const outsider = await api!.createRoomAgentSession({
    room_id: a.room.id, session_kind: "worker", runtime: "claude-code",
    actor_label: "Unrouted", display_name: "Unrouted", agent_key: `${a.ownerId}/unrouted`,
    owner_account_id: a.ownerId, owner_label: a.ownerId, ide_label: "Agent",
  });
  const route = pollRoute(a.room.id);
  try {
    const retired = await route.reportSelf(predecessor, a.ownerId, sent.message.id, "no_reply");
    assert.equal(retired.statusCode, 401, "retired credentials cannot settle a receipt");
    const unrelated = await route.reportSelf(outsider, a.ownerId, sent.message.id, "no_reply");
    assert.equal(unrelated.statusCode, 404, "another durable agent cannot settle this receipt");
    const reported = await route.reportSelf(successor, a.ownerId, sent.message.id, "no_reply");
    assert.equal(reported.statusCode, 200, JSON.stringify(reported.body));
    const replay = await route.reportSelf(successor, a.ownerId, sent.message.id, "no_reply");
    assert.equal(replay.statusCode, 200, "a lost acknowledgment can be retried");
    assert.deepEqual(await a.turns(sent.message.id), before, "settlement does not release another agent out of turn");
    const receipt = await client!.pool.query(
      `SELECT r.receipt_state, e.from_state, e.actor_session_id FROM message_agent_receipts r
       JOIN message_agent_receipt_events e ON e.receipt_id = r.id
       WHERE r.message_room_id = $1 AND r.message_number = $2 AND r.agent_key = $3 AND e.to_state = 'no_reply'`,
      [a.room.id, Number(sent.message.id.slice(4)), predecessor.agent_key],
    );
    assert.deepEqual(receipt.rows, [{ receipt_state: "no_reply", from_state: "unavailable", actor_session_id: successor.session_id }],
      "one truthful completion event records the authenticated successor");
  } finally { route.close(); }
});

for (const off of ["parallel", null] as const) {
  test(`switching off (${off}) releases waiting turns and removes guidance without cancelling work`, skip, async () => {
    const a = await seed();
    const sent = await a.send("@everyone compare approaches");
    const [first, second] = await order(a, sent.message.id);
    assert.equal((await a.read(second!)).length, 0);
    const wakes: Set<string> = new Set();
    const onRouted = (event: { wakeAgentKeys?: string[] }) => {
      for (const key of event.wakeAgentKeys ?? []) wakes.add(key);
    };
    events!.messageEvents.on("message:routed", onRouted);
    try {
      await settings!.setRoomAgentReplyOrder(a.room.id, off);
      assert.equal(await settings!.getRoomAgentReplyOrder(a.room.id), off);
      assert.ok((await a.turns(sent.message.id)).every((row) => row.released));
      for (let index = 0; index < 3; index++) {
        assert.deepEqual(a.forAgent(await a.read(index), sent.message.id), {
          decision: "activate", reason: "broadcast", addressed: true,
        });
        assert.equal((await a.live(index, sent.message.id)).activation.for_current_agent.guidance, undefined);
      }
      const state = await client!.pool.query(
        "SELECT receipt_state, turn_done_at, hold_release_reason FROM message_agent_receipts WHERE message_room_id = $1",
        [a.room.id]);
      assert.ok(state.rows.every((row) => row.receipt_state === "queued" && row.turn_done_at === null && row.hold_release_reason === "disabled"));
      for (let i = 0; i < 50 && wakes.size < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual([...wakes].sort(), a.sessions.filter((_, index) => index !== first).map((session) => session.agent_key).sort());
      await settings!.setRoomAgentReplyOrder(a.room.id, off); // idempotent
      const next = await a.send("@everyone another question");
      assert.ok((await a.turns(next.message.id)).every((row) => row.turn_position === null));
      await settings!.setRoomAgentReplyOrder(a.room.id, "sequential");
      assert.equal(a.forAgent(await a.read(second!), sent.message.id)?.guidance, undefined, "on again must not revive old turns");
      const resumed = await a.send("@everyone a fresh exchange");
      assert.ok((await a.turns(resumed.message.id)).some((row) => row.turn_position === 2 && !row.released));
    } finally {
      events!.messageEvents.off("message:routed", onRouted);
    }
  });
}

test("switching off waits for an in-flight receipt plan, then releases its holds", skip, async () => {
  const a = await seed();
  const gate = await client!.pool.connect();
  const { rows: [{ pid }] } = await gate.query("SELECT pg_backend_pid() AS pid");
  await gate.query("SELECT pg_advisory_lock(711028, 1)");
  // Pause the real send after reading the setting, just before receipt insert.
  await client!.pool.query(`
    CREATE FUNCTION pause_reply_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(711028, 1); RETURN NEW; END $$;
    CREATE TRIGGER pause_reply_receipt_insert BEFORE INSERT ON message_agent_receipts
      FOR EACH ROW EXECUTE FUNCTION pause_reply_receipt_insert();
  `);
  const sending = a.send("@everyone race the off switch");
  let disabling: Promise<void> | undefined;
  try {
    let writerPid: number | undefined;
    for (let i = 0; i < 100 && !writerPid; i++) {
      const blocked = await client!.pool.query("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
      writerPid = blocked.rows[0]?.pid;
      if (!writerPid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(writerPid, "the real message writer reached receipt insertion");
    let disabled = false;
    disabling = settings!.setRoomAgentReplyOrder(a.room.id, "parallel").then(() => { disabled = true; });
    let blockedByWriter = false;
    for (let i = 0; i < 100 && !disabled && !blockedByWriter; i++) {
      const blocked = await client!.pool.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [writerPid]);
      blockedByWriter = blocked.rows.length > 0;
      if (!blockedByWriter) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blockedByWriter && !disabled, "off waits for the sequence plan's shared setting lock");
  } finally {
    await gate.query("SELECT pg_advisory_unlock(711028, 1)");
    gate.release();
    await Promise.all([sending, disabling]);
    await client!.pool.query("DROP TRIGGER pause_reply_receipt_insert ON message_agent_receipts; DROP FUNCTION pause_reply_receipt_insert()");
  }
  const sent = await sending;
  assert.ok((await a.turns(sent.message.id)).every((row) => row.released));
  for (let index = 0; index < 3; index++) assert.equal(a.forAgent(await a.read(index), sent.message.id)?.guidance, undefined);
});


test("context-only history sees a newer held human correction without releasing it or losing its later activation", skip, async () => {
  const a = await seed();
  const original = await a.send("@everyone discuss borrowing books");
  const [first] = await order(a, original.message.id);
  assert.ok((await a.read(first!)).some(message => message.id === original.message.id));
  const correction = await a.send("@everyone browse only; do not collect names");
  const correctionOrder = await order(a, correction.message.id);
  assert.notEqual(correctionOrder[0], first, "rotating order holds the correction for the earlier speaker");
  const peer = await a.send("A newer public clarification");
  const hidden = await a.send("", { agent_prompt_kind: "auto" });
  // Routing may be unresolved for a newer public message. That governs
  // activation, not whether the already-public correction can be observed.
  await client!.pool.query(`INSERT INTO jev_routing_jobs(room_id,message_number,plan,state)
    VALUES ($1,$2,'{"mode":"active"}','pending')`, [a.room.id, Number(correction.message.id.slice(4))]);
  const route = pollRoute(a.room.id);
  const session = a.sessions[first!]!;
  const readState = async () => (await client!.pool.query(`SELECT agent_key,message_number,receipt_state,hold_released_at,turn_done_at
    FROM message_agent_receipts WHERE message_room_id=$1 ORDER BY message_number,agent_key`, [a.room.id])).rows;
  try {
    const before = await readState();
    const regular = await route.history(session, a.ownerId, { before: "latest", limit: "30" });
    assert.ok(!regular.body.messages.some(m => m.id === correction.message.id));
    const context = await route.history(session, a.ownerId, { before: "latest", limit: "100", context_only: "true" });
    assert.equal(context.statusCode, 200);
    assert.equal(context.body.context_only, true);
    assert.equal(context.body.room_id, a.room.id);
    assert.deepEqual(context.body.messages.map(m => m.id), [original.message.id, correction.message.id, peer.message.id]);
    assert.ok(context.body.messages.every(m => m.activation === undefined));
    assert.ok(!context.body.messages.some(m => m.id === hidden.message.id));
    assert.deepEqual(await readState(), before, "observation changes no receipt or turn hold");
    const held = await route.poll(session, a.ownerId, original.message.id, "150");
    assert.deepEqual(held.body.messages, [], "delivery still cannot pass the held correction");
    for (const query of [{ context_only: "true" }, { context_only: "true", before: "latest", after: original.message.id }]) {
      assert.equal((await route.history(session, a.ownerId, query)).statusCode, 400);
    }
    assert.equal((await route.history(null, a.ownerId, { context_only: "true", before: "latest" })).statusCode, 400);
    await client!.pool.query("UPDATE jev_routing_jobs SET state='completed' WHERE room_id=$1", [a.room.id]);
    const position = correctionOrder.indexOf(first!);
    for (const index of correctionOrder.slice(0, position)) await a.reply(index, correction.message.id);
    const released = await route.poll(session, a.ownerId, original.message.id, "150");
    assert.equal(released.body.messages.filter(m => m.id === correction.message.id).length, 1);
    assert.equal(released.body.messages.find(m => m.id === correction.message.id)?.activation.for_current_agent.decision, "activate");
    for (let i = 0; i < 31; i++) await a.send(`Public history ${i}`);
    const bounded = await route.history(session, a.ownerId, { before: "latest", limit: "100", context_only: "true" });
    assert.equal(bounded.body.messages.length, 30);
    assert.equal(bounded.body.messages[0]?.text, "Public history 1");
    assert.equal(bounded.body.messages.at(-1)?.text, "Public history 30");
  } finally { route.close(); }
});
