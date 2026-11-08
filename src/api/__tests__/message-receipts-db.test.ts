import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const members = url ? await import("../db/room-members.js") : null;
const worker = url ? await import("../messages/jev-routing-worker.js") : null;
const settle = url ? await import("./settle-background-db-work.js") : null;
const { registerMessageReceiptsRoute, parseMessageReceiptIds, MESSAGE_RECEIPTS_MAX_IDS } = await import("../routes/rooms/messages/receipts.js");
const { registerMessageInfoRoute } = await import("../routes/rooms/messages/info.js");
const skip = { skip: !url && "set TEST_DB_URL to run message receipt tests" };

test.beforeEach(async () => {
  if (!client) return;
  await settle!.settleBackgroundDbWork();
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
  process.env.LETAGENTS_JEV_ROUTING = "off";
});
test.after(async () => {
  await settle?.settleBackgroundDbWork();
  await client?.pool.end();
});

let serial = 0;
async function account(id: string, displayName: string | null = null) {
  const now = new Date().toISOString();
  await client!.db.insert(schema!.accounts).values({
    id, provider: "github", provider_user_id: id, login: id, display_name: displayName,
    avatar_url: `https://avatars.example/${id}.png`, created_at: now, updated_at: now,
  });
}

async function seed(count = 3, roomName?: string) {
  const ownerId = `owner-${++serial}`;
  const room = await api!.createProjectWithName(roomName ?? `receipts-${serial}`);
  await account(ownerId, "Owner Person");
  await api!.assignProjectAdmin(room.id, ownerId);
  const sessions = [];
  for (let i = 0; i < count; i++) sessions.push(await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: i % 2 ? "codex" : "claude-code",
    actor_label: `Agent${i}`, agent_key: `${ownerId}/agent${i}`, display_name: `Agent${i}`,
    owner_account_id: ownerId, owner_label: ownerId, ide_label: i % 2 ? "Codex" : "Claude Code",
  }));
  const sendAs = (accountId: string, text: string, extra = {}) => api!.addMessageWithCreateStatus(room.id, accountId, text, {
    source: "browser", account_id: accountId, ...extra,
  });
  const send = (text: string, extra = {}) => sendAs(ownerId, text, extra);
  const reply = (index: number, replyTo: string, extra = {}) => api!.addMessageWithCreateStatus(
    room.id, sessions[index]!.actor_label, "Here is my answer.", {
      source: "agent", publisher_agent_key: sessions[index]!.agent_key,
      publisher_agent_session_id: sessions[index]!.session_id, account_id: ownerId,
      reply_to_message_id: replyTo, ...extra,
    });
  const noWake = async (id: string) => (await client!.pool.query<{ no_wake: unknown }>(
    "SELECT no_wake FROM messages WHERE room_id=$1 AND number=$2", [room.id, Number(id.slice(4))])).rows[0]?.no_wake ?? null;
  const endSession = (index: number) => client!.pool.query(
    "UPDATE room_agent_sessions SET ended_at = now() WHERE session_id=$1", [sessions[index]!.session_id]);
  return { room, ownerId, sessions, send, sendAs, reply, noWake, endSession };
}

async function withServer<T>(run: (get: (accountId: string, pathname: string) => Promise<{ status: number; body: any }>) => Promise<T>) {
  const app = express();
  app.use((req, _res, next) => {
    const accountId = req.header("x-test-account");
    if (accountId) (req as any).sessionAccount = { account_id: accountId, login: accountId };
    next();
  });
  const deps = {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string, res: express.Response) => {
      const project = await api!.getProjectById(roomId);
      if (!project) res.status(404).json({ error: "Room not found" });
      return project;
    },
    requireParticipant: async () => true,
    shouldIncludePromptOnlyMessages: () => false,
  } as any;
  registerMessageInfoRoute(app, deps);
  registerMessageReceiptsRoute(app, deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(async (accountId, pathname) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { "x-test-account": accountId } });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("receipt ids parse strictly", () => {
  assert.deepEqual(parseMessageReceiptIds("msg_1,msg_2,msg_1"), [1, 2]);
  assert.equal(parseMessageReceiptIds(""), null);
  assert.equal(parseMessageReceiptIds("msg_1,bogus"), null);
  assert.equal(MESSAGE_RECEIPTS_MAX_IDS, 100);
});

test("no_wake records why a human message woke nobody", skip, async () => {
  const empty = await seed(0);
  const lonely = await empty.send("Is anyone here?");
  assert.deepEqual(await empty.noWake(lonely.message.id), { reason: "no_agents" });

  const a = await seed(4);
  const large = await a.send("What should we do next?");
  assert.deepEqual(await a.noWake(large.message.id), { reason: "no_mention_large_room", agent_count: 4 });

  const missing = await a.send("@MissingAgent can you look?");
  assert.deepEqual(await a.noWake(missing.message.id), { reason: "unknown" });

  const threadReply = await a.send("Following up", {
    thread_root_message_id: missing.message.id, reply_to_message_id: missing.message.id,
  });
  assert.deepEqual(await a.noWake(threadReply.message.id), { reason: "thread_no_agents" });

  await client!.pool.query("UPDATE room_agent_sessions SET display_name='Agent0' WHERE session_id=$1", [a.sessions[2]!.session_id]);
  const ambiguous = await a.send("@Agent0 please check");
  assert.deepEqual(await a.noWake(ambiguous.message.id), { reason: "ambiguous_mention", handles: ["Agent0"] });
  await client!.pool.query("UPDATE room_agent_sessions SET display_name='Agent2' WHERE session_id=$1", [a.sessions[2]!.session_id]);

  // A conversation with Agent1, then Agent1 leaves: three agents remain.
  const asked = await a.send("@Agent1 can you start?");
  assert.equal(await a.noWake(asked.message.id), null, "a woken agent leaves the column empty");
  await a.reply(1, asked.message.id);
  await a.endSession(1);
  const followUp = await a.send("And then?");
  assert.deepEqual(await a.noWake(followUp.message.id), {
    reason: "recent_agent_left", agent_count: 3, recent_agent: "Agent1",
  });

  const agentMessage = await a.reply(0, followUp.message.id);
  assert.equal(await a.noWake(agentMessage.message.id), null, "agent messages carry no reason");
});

test("deferred routing records routing_chose_none, or the heuristic reason when it could not run", skip, async () => {
  process.env.LETAGENTS_JEV_ROUTING = "active";
  process.env.TYPESAFE_API_KEY = "fixture-key";
  const a = await seed(3);
  await client!.pool.query("UPDATE rooms SET jev_routing_enabled = true WHERE id = $1", [a.room.id]);
  const elected = await a.send("Which agent knows the design?");
  const fallback = await a.send("Which agent knows the tests?");
  assert.equal(await a.noWake(elected.message.id), null, "pending routing leaves the column empty");
  const jobs = await worker!.claimJevRoutingJobs();
  const job = (id: string) => jobs.find((candidate) => `msg_${candidate.message_number}` === id)!;
  await worker!.completeJevRoutingJob(job(elected.message.id), {
    mode: "active", elected: [], electionReason: "none_chosen", needsResponse: 0.9, choice: "none",
    probabilitiesByAgentKey: {}, confidence: 0.9, respondByAgentKey: {}, candidateAgentKeys: [], latencyMs: 1,
  } as any);
  assert.deepEqual(await a.noWake(elected.message.id), { reason: "routing_chose_none", agent_count: 3 });
  await worker!.completeJevRoutingJob(job(fallback.message.id), null);
  assert.deepEqual(await a.noWake(fallback.message.id), { reason: "no_mention_large_room", agent_count: 3 });
});

test("receipts are for the sender only, with agents, readers, not-read people and the no-wake reason", skip, async () => {
  const a = await seed(2);
  await account("reader-1", "Reader One");
  await account("unread-1", null);
  await account("outsider-1", null);
  await members!.addRoomMember({ roomId: a.room.id, accountId: "reader-1", addedVia: "seed" });
  await members!.addRoomMember({ roomId: a.room.id, accountId: "unread-1", addedVia: "seed" });

  const asked = await a.send("@Agent0 please review");
  await a.reply(0, asked.message.id);
  const others = await a.sendAs("reader-1", "My own message");
  // A legacy zero-agent message from the sender (before the column existed).
  await a.endSession(0);
  await a.endSession(1);
  const legacy = await a.send("Anyone?");
  await client!.pool.query("UPDATE messages SET no_wake = NULL WHERE room_id=$1 AND number=$2", [a.room.id, Number(legacy.message.id.slice(4))]);
  const lonely = await a.send("Still nobody?");

  const askedNumber = Number(asked.message.id.slice(4));
  const now = new Date().toISOString();
  await client!.db.insert(schema!.message_human_read_ranges).values([
    { id: "range_1", room_id: a.room.id, account_id: "reader-1", scope_kind: "timeline", thread_root_number: null,
      first_message_sequence: askedNumber, last_message_sequence: askedNumber + 1, client_batch_id: "b1", created_at: now },
    // A thread range never marks a timeline message read.
    { id: "range_2", room_id: a.room.id, account_id: "unread-1", scope_kind: "thread", thread_root_number: askedNumber,
      first_message_sequence: askedNumber, last_message_sequence: askedNumber + 1, client_batch_id: "b2", created_at: now },
    // The sender's own read is never a receipt.
    { id: "range_3", room_id: a.room.id, account_id: a.ownerId, scope_kind: "timeline", thread_root_number: null,
      first_message_sequence: askedNumber, last_message_sequence: askedNumber, client_batch_id: "b3", created_at: now },
  ]);

  await withServer(async (get) => {
    const roomPath = `/rooms/${encodeURIComponent(a.room.id)}/messages`;
    const ids = [asked.message.id, others.message.id, legacy.message.id, lonely.message.id, "msg_99999"].join(",");
    const own = await get(a.ownerId, `${roomPath}/receipts?ids=${ids}`);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.receipts.map((receipt: any) => receipt.message_id),
      [asked.message.id, legacy.message.id, lonely.message.id], "other people's messages are silently omitted");
    const [first, legacyReceipt, lonelyReceipt] = own.body.receipts;
    assert.equal(first.agents.length, 1);
    const agent = first.agents[0];
    assert.equal(agent.agent_key, a.sessions[0]!.agent_key);
    assert.equal(agent.display_name, "Agent0");
    assert.equal(agent.provider, "Claude Code");
    assert.equal(agent.owner_name, a.ownerId);
    assert.equal(agent.mine, true);
    assert.equal(agent.activation_reason, "explicit_mention");
    assert.equal(agent.activation_reason_label, "Mentioned directly");
    assert.equal(agent.state, "replied");
    assert.match(agent.reply_message_id, /^msg_\d+$/);
    assert.ok(agent.asked_at && agent.finished_at);
    assert.deepEqual(first.readers.map((reader: any) => [reader.name, reader.avatar_url]),
      [["Reader One", "https://avatars.example/reader-1.png"]]);
    assert.deepEqual(first.not_read.map((person: any) => person.name), ["unread-1"]);
    assert.equal(first.no_wake, null);
    assert.deepEqual(legacyReceipt.no_wake, { reason: "unknown" });
    assert.deepEqual(lonelyReceipt.no_wake, { reason: "no_agents" });

    const outsider = await get("reader-1", `${roomPath}/receipts?ids=${ids}`);
    assert.deepEqual(outsider.body.receipts.map((receipt: any) => receipt.message_id), [others.message.id]);

    const tooMany = Array.from({ length: 101 }, (_, i) => `msg_${i + 1}`).join(",");
    assert.equal((await get(a.ownerId, `${roomPath}/receipts?ids=${tooMany}`)).status, 400);
    assert.equal((await get(a.ownerId, `${roomPath}/receipts?ids=bogus`)).status, 400);

    // Info: only the sender learns who read the message.
    const senderInfo = await get(a.ownerId, `${roomPath}/${asked.message.id}/info`);
    assert.deepEqual(senderInfo.body.seen_by_people.map((reader: any) => reader.name), ["Reader One"]);
    const otherInfo = await get("unread-1", `${roomPath}/${asked.message.id}/info`);
    assert.equal(otherInfo.status, 200);
    assert.deepEqual(otherInfo.body.seen_by_people, []);
    assert.equal(otherInfo.body.agents_asked.length, 1, "everything else stays visible");
  });
});

test("a repository room has no member list, so not_read is null", skip, async () => {
  const a = await seed(1, "github.com/acme/receipts");
  const sent = await a.send("Hello");
  await withServer(async (get) => {
    const response = await get(a.ownerId, `/rooms/${encodeURIComponent(a.room.id)}/messages/receipts?ids=${sent.message.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.receipts.length, 1);
    assert.equal(response.body.receipts[0].not_read, null);
    assert.equal(response.body.receipts[0].agents.length, 1);
  });
});
