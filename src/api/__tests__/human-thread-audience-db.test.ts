import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { MessageCreateTransaction } from "../db/messages/create.js";
import { MessageRoutingPendingError } from "../validation-error.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const jev = url ? await import("../messages/jev-routing-worker.js") : null;
const skip = { skip: !url && "set TEST_DB_URL to run human-thread audience tests" };

test.before(async () => {
  if (!client) return;
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
  process.env.LETAGENTS_JEV_ROUTING = "off";
});
test.after(async () => {
  // Let committed routing wakes start their reads before closing the test pool.
  await new Promise(resolve => setTimeout(resolve, 50));
  await client?.pool.end();
});

let serial = 0;
async function account(id: string) {
  const now = new Date().toISOString();
  await client!.db.insert(schema!.accounts).values({ id, provider: "github", provider_user_id: id,
    login: id, created_at: now, updated_at: now });
}
async function seed(count = 3) {
  const ownerId = `thread-owner-${++serial}`;
  const room = await api!.createProjectWithName(`human-thread-${serial}`);
  await account(ownerId);
  await api!.assignProjectAdmin(room.id, ownerId);
  const sessions = [];
  for (let i = 0; i < count; i++) sessions.push(await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: i % 2 ? "codex" : "claude-code",
    actor_label: `Agent${i}`, agent_key: `${ownerId}/agent${i}`, display_name: `Agent${i}`,
    owner_account_id: ownerId, owner_label: ownerId, ide_label: "Agent",
  }));
  const send = (text: string, extra = {}) => api!.addMessageWithCreateStatus(room.id, ownerId, text, {
    source: "browser", account_id: ownerId, ...extra,
  });
  const reply = (index: number, source: string, extra = {}) => api!.addMessageWithCreateStatus(
    room.id, sessions[index]!.actor_label, "My contribution.", {
      source: "agent", publisher_agent_key: sessions[index]!.agent_key,
      publisher_agent_session_id: sessions[index]!.session_id, account_id: ownerId,
      client_message_id: `supervised-room:supervised_${index}:${room.id}:${source}:reply:v1`, ...extra,
    });
  const receipts = async (id: string) => (await client!.pool.query<{
    agent_key: string; agent_session_id: string; activation_reason: string; turn_position: number | null;
  }>(`SELECT agent_key,agent_session_id,activation_reason,turn_position FROM message_agent_receipts
      WHERE message_room_id=$1 AND message_number=$2 ORDER BY agent_key`, [room.id, Number(id.slice(4))])).rows;
  const thread = (root: string, text = "How would you change the recommendation?", extra = {}) => send(text, {
    thread_root_message_id: root, reply_to_message_id: root, ...extra,
  });
  return { room, ownerId, sessions, send, reply, receipts, thread };
}

test("a human's first thread follow-up reaches all eight original recipients after top-level answers", skip, async () => {
  const a = await seed(8);
  const root = await a.send("@everyone what should we run?");
  for (let i = 0; i < 8; i++) await a.reply(i, root.message.id);
  const follow = await a.thread(root.message.id);
  const rows = await a.receipts(follow.message.id);
  assert.deepEqual(rows.map(r => r.agent_key), a.sessions.map(s => s.agent_key).sort());
  assert.ok(rows.every(r => r.activation_reason === "thread_participant" && r.turn_position === null),
    "thread delivery keeps the existing thread scheduling contract");
});

test("an original subset stays bounded and agent peer messages do not inherit the root audience", skip, async () => {
  const a = await seed(4);
  const root = await a.send("@Agent0 @Agent1 compare these options");
  await a.reply(0, root.message.id);
  await a.reply(1, root.message.id);
  const follow = await a.thread(root.message.id);
  assert.deepEqual((await a.receipts(follow.message.id)).map(r => r.agent_key), a.sessions.slice(0, 2).map(s => s.agent_key));
  const peer = await a.reply(0, follow.message.id, { thread_root_message_id: root.message.id });
  assert.equal((await a.receipts(peer.message.id)).length, 0,
    "no global agent thread membership was manufactured from human receipt inheritance");
});

test("existing agent thread participants take precedence over the original root audience", skip, async () => {
  const a = await seed();
  const root = await a.send("@Agent0 start here");
  await a.reply(1, root.message.id, { thread_root_message_id: root.message.id });
  const follow = await a.thread(root.message.id);
  assert.deepEqual((await a.receipts(follow.message.id)).map(r => r.agent_key), [a.sessions[1]!.agent_key]);
});

test("explicit, unknown and ambiguous mentions never fall back to the root audience", skip, async () => {
  const a = await seed();
  const root = await a.send("@Agent0 what do you think?");
  const explicit = await a.thread(root.message.id, "@Agent2 give your view");
  assert.deepEqual((await a.receipts(explicit.message.id)).map(r => r.agent_key), [a.sessions[2]!.agent_key]);
  const missing = await a.thread(root.message.id, "@MissingAgent give your view");
  assert.equal((await a.receipts(missing.message.id)).length, 0);
  await client!.pool.query("UPDATE room_agent_sessions SET display_name='Agent0' WHERE session_id=$1", [a.sessions[2]!.session_id]);
  const ambiguous = await a.thread(root.message.id, "@Agent0 give your view");
  assert.equal((await a.receipts(ambiguous.message.id)).length, 0);
  const broadcast = await a.thread(root.message.id, "@everyone give your view");
  assert.equal((await a.receipts(broadcast.message.id)).length, 3);
});

test("a successor follows only when the durable key and captured owner still match", skip, async () => {
  const a = await seed(2);
  const root = await a.send("@Agent0 what should happen?");
  const prior = a.sessions[0]!;
  await api!.endRoomAgentSession({ room_id: a.room.id, session_id: prior.session_id });
  const successor = await api!.createRoomAgentSession({ room_id: a.room.id, session_kind: "worker", runtime: "codex",
    actor_label: prior.actor_label, display_name: prior.display_name, agent_key: prior.agent_key,
    owner_account_id: a.ownerId, owner_label: a.ownerId, ide_label: "Agent" });
  const continued = await a.thread(root.message.id);
  assert.equal((await a.receipts(continued.message.id))[0]?.agent_session_id, successor.session_id);
  await api!.endRoomAgentSession({ room_id: a.room.id, session_id: successor.session_id });
  const otherOwner = `${a.ownerId}-other`;
  await account(otherOwner);
  await api!.createRoomAgentSession({ room_id: a.room.id, session_kind: "worker", runtime: "codex",
    actor_label: prior.actor_label, display_name: prior.display_name, agent_key: prior.agent_key,
    owner_account_id: otherOwner, owner_label: otherOwner, ide_label: "Agent" });
  const changedOwner = await a.thread(root.message.id);
  assert.equal((await a.receipts(changedOwner.message.id)).length, 0);
});

test("ordinary agent-directed replies and genuine task-owner follow-ups keep their existing targets", skip, async () => {
  const a = await seed();
  const root = await a.send("@Agent0 investigate");
  const agentRoot = await a.reply(2, root.message.id);
  const directed = await a.thread(agentRoot.message.id);
  assert.deepEqual((await a.receipts(directed.message.id)).map(r => r.agent_key), [a.sessions[2]!.agent_key]);
  await api!.createTaskLease({ room_id: a.room.id, task_id: "task_1", kind: "work", agent_key: a.sessions[1]!.agent_key,
    agent_session_id: a.sessions[1]!.session_id, actor_label: a.sessions[1]!.actor_label, created_by: a.ownerId });
  const work = await a.thread(root.message.id, "continue");
  assert.deepEqual((await a.receipts(work.message.id)).map(r => [r.agent_key, r.activation_reason]),
    [[a.sessions[1]!.agent_key, "task_owner"]]);
});

test("restricted and rental-associated roots do not widen their thread audience", skip, async () => {
  for (const change of ["visibility='internal'", "rental_session_id='fixture-rental'"]) {
    const a = await seed();
    const root = await a.send("@Agent0 assess this");
    await client!.pool.query(`UPDATE messages SET ${change} WHERE room_id=$1 AND number=$2`, [a.room.id, Number(root.message.id.slice(4))]);
    const follow = await a.thread(root.message.id);
    assert.equal((await a.receipts(follow.message.id)).length, 0, change);
  }
  for (const change of ["visibility='internal'", "rental_session_id='fixture-rental'"]) {
    const a = await seed();
    const root = await a.send("@Agent0 assess this");
    const follow = await a.thread(root.message.id, "How would you adapt this?", {
      with_created_message_in_transaction: async (tx: MessageCreateTransaction, message: { number: number }) => {
        const { sql } = await import("drizzle-orm");
        await tx.execute(sql`UPDATE messages SET ${sql.raw(change)} WHERE room_id=${a.room.id} AND number=${message.number}`);
      },
    });
    assert.equal((await a.receipts(follow.message.id)).length, 0, `follow-up ${change}`);
  }
});

test("visible inline human roots remain usable while prompt-only roots and unauthenticated traffic do not gain an audience", skip, async () => {
  const a = await seed();
  const root = await a.send("@Agent0 explain this", { agent_prompt_kind: "inline" });
  const follow = await a.thread(root.message.id);
  assert.deepEqual((await a.receipts(follow.message.id)).map(r => r.agent_key), [a.sessions[0]!.agent_key]);
  const anonymous = await a.thread(root.message.id, "How would you adapt this?", { account_id: null });
  assert.equal((await a.receipts(anonymous.message.id)).length, 0);
  const anonymousRoot = await a.send("@Agent0 explain this", { account_id: null });
  const noCapturedOwner = await a.thread(anonymousRoot.message.id);
  assert.equal((await a.receipts(noCapturedOwner.message.id)).length, 0);
  const hidden = await a.send("", { agent_prompt_kind: "auto" });
  await assert.rejects(a.thread(hidden.message.id), /visible message/);
});

test("pending root routing rolls back the follow-up, and the same outgoing identity succeeds once routing commits", skip, async () => {
  const a = await seed(4);
  process.env.LETAGENTS_JEV_ROUTING = "active";
  process.env.TYPESAFE_API_KEY = "fixture-never-sent";
  try {
    await client!.pool.query("UPDATE rooms SET jev_routing_enabled=true WHERE id=$1", [a.room.id]);
    const root = await a.send("Which approach would you choose?");
    const outgoing = { client_message_id: "desktop-send:thread-retry" };
    await assert.rejects(a.thread(root.message.id, "How would you adapt this?", outgoing), MessageRoutingPendingError);
    assert.equal((await client!.pool.query("SELECT count(*)::int count FROM messages WHERE room_id=$1", [a.room.id])).rows[0].count, 1);
    const job = (await jev!.claimJevRoutingJobs()).find(j => j.room_id === a.room.id)!;
    const keys = [a.sessions[0]!.agent_key, a.sessions[2]!.agent_key];
    await jev!.completeJevRoutingJob(job, { mode: "active", elected: keys, electionReason: "elected", needsResponse: .9,
      choice: "agent_1", probabilitiesByAgentKey: {}, confidence: .9, respondByAgentKey: {}, candidateAgentKeys: keys, latencyMs: 1 });
    const sent = await a.thread(root.message.id, "How would you adapt this?", outgoing);
    assert.deepEqual((await a.receipts(sent.message.id)).map(r => r.agent_key), keys);
    const replay = await a.thread(root.message.id, "How would you adapt this?", outgoing);
    assert.equal(replay.created, false);
    assert.equal(replay.message.id, sent.message.id);
    assert.equal((await a.receipts(sent.message.id)).length, 2);
  } finally {
    process.env.LETAGENTS_JEV_ROUTING = "off";
    delete process.env.TYPESAFE_API_KEY;
  }
});
