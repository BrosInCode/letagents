import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const worker = url ? await import("../messages/jev-routing-worker.js") : null;
const routing = url ? await import("../db/messages/jev-routing-hint.js") : null;
const skip = { skip: !url && "set TEST_DB_URL to run routing persistence tests" };

test.beforeEach(async () => {
  if (!client) return;
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
  process.env.LETAGENTS_JEV_ROUTING = "active";
  process.env.TYPESAFE_API_KEY = "fixture-key";
});
test.after(async () => { await client?.pool.end(); });

async function seed(name = "routing-room", count = 4) {
  const room = await api!.createProjectWithName(name);
  const now = new Date().toISOString();
  const ownerId = `owner-${name}`;
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId,
    created_at: now, updated_at: now,
  });
  await api!.assignProjectAdmin(room.id, ownerId);
  const sessions = [];
  for (let i = 0; i < count; i++) sessions.push(await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: i < 2 ? "codex" : "claude-code",
    actor_label: `Agent${i}`, agent_key: `${ownerId}/agent${i}`, display_name: `Agent${i}`,
    owner_account_id: ownerId, owner_label: ownerId, ide_label: "Agent",
  }));
  const send = (text: string, extra = {}) => api!.addMessageWithCreateStatus(room.id, ownerId, text, {
    source: "browser", account_id: ownerId, ...extra,
  });
  const enable = (enabled: boolean) => client!.pool.query("UPDATE rooms SET jev_routing_enabled = $2 WHERE id = $1", [room.id, enabled]);
  return { room, ownerId, sessions, send, enable };
}

function hint(keys: string[]): import("../db/messages/jev-routing-hint.js").JevConversationRoutingHint {
  return { mode: "active", elected: keys, electionReason: keys.length ? "elected" : "none_chosen",
    needsResponse: 0.9, choice: keys.length ? "agent_1" : "none", probabilitiesByAgentKey: {},
    confidence: 0.9, respondByAgentKey: {}, candidateAgentKeys: keys, latencyMs: 1 };
}

test("default off and deterministic paths never enqueue; opt-in is room scoped and atomic", skip, async () => {
  const a = await seed();
  await a.send("Who can help with the design?");
  assert.equal((await worker!.claimJevRoutingJobs()).length, 0);
  await a.enable(true);
  await a.send("@Agent0 please inspect this");
  await a.send("@everyone hello");
  await a.send("continue");
  await a.send("Thanks for the update", { source: "agent", publisher_agent_key: a.sessions[0]!.agent_key,
    publisher_agent_session_id: a.sessions[0]!.session_id });
  const b = await seed("other-room");
  await b.send("Who can help with the design?");
  assert.equal((await worker!.claimJevRoutingJobs()).length, 0);
  await assert.rejects(a.send("roll back this send", {
    with_created_message_in_transaction: async () => { throw new Error("fixture rollback"); },
  }));
  assert.equal((await worker!.claimJevRoutingJobs()).length, 0);
  const sent = await a.send("Which agents use Claude?", { client_message_id: "once" });
  await a.send("Which agents use Claude?", { client_message_id: "once" });
  const jobs = await worker!.claimJevRoutingJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.message_number, Number(sent.message.id.slice(4)));
  assert.equal(jobs[0]!.room_id, a.room.id);
});

test("ordered worker reads survive abandoned leases, out-of-order completion and duplicate completion", skip, async () => {
  const a = await seed();
  const before = await a.send("@Agent0 start here");
  await a.enable(true);
  const first = await a.send("Which agents use Claude?");
  const second = await a.send("Which agents use Codex?");
  const direct = await a.send("@Agent1 this is directly addressed");
  const read = () => api!.getMessagesAfter(a.room.id, before.message.id, { wait_for_routing: true });
  assert.equal((await read()).messages.length, 0);
  assert.equal((await api!.getLatestMessages(a.room.id, { wait_for_routing: true })).messages.at(-1)?.id, before.message.id);
  assert.equal((await api!.getMessageStreamCheckpoint(a.room.id, { waitForRouting: true })).checkpoint, before.message.id);
  assert.equal((await api!.getMessagesAfter(a.room.id, before.message.id)).messages.length, 3, "human transcript is immediate");
  const jobs = await worker!.claimJevRoutingJobs();
  const firstJob = jobs.find((job) => `msg_${job.message_number}` === first.message.id)!;
  const secondJob = jobs.find((job) => `msg_${job.message_number}` === second.message.id)!;
  await worker!.completeJevRoutingJob(secondJob, hint([a.sessions[1]!.agent_key]));
  assert.equal((await read()).messages.length, 0, "later completed jobs cannot leap the first");
  assert.equal((await worker!.claimJevRoutingJobs()).length, 0, "a live lease is exclusive");
  await client!.pool.query("UPDATE jev_routing_jobs SET available_at = now() - interval '1 second' WHERE state = 'processing'");
  const [recovered] = await worker!.claimJevRoutingJobs();
  assert.ok(recovered);
  assert.notEqual(recovered.claim_token, firstJob.claim_token);
  await worker!.completeJevRoutingJob(firstJob, hint([a.sessions[3]!.agent_key]));
  assert.equal((await read()).messages.length, 0, "stale process cannot commit");
  await worker!.completeJevRoutingJob(recovered, hint([]));
  await worker!.completeJevRoutingJob(recovered, hint([a.sessions[2]!.agent_key]));
  assert.deepEqual((await read()).messages.map((m) => m.id), [first.message.id, second.message.id, direct.message.id]);
  const receipts = await client!.pool.query("SELECT message_number, agent_key FROM message_agent_receipts WHERE activation_reason='jev_routed'");
  assert.deepEqual(receipts.rows, [{ message_number: secondJob.message_number, agent_key: a.sessions[1]!.agent_key }]);
  assert.deepEqual((await read()).messages.map((m) => m.id), [first.message.id, second.message.id, direct.message.id], "lost HTTP response is replayable");
});

test("room/global disable and malformed provider answers use fallback without exporting restricted context", skip, async () => {
  const a = await seed();
  await a.send("@Agent0 hello");
  await a.enable(true);
  await a.send("A secret rental snippet", { source: "agent", publisher_agent_key: a.sessions[1]!.agent_key, publisher_agent_session_id: a.sessions[1]!.session_id });
  await client!.pool.query("UPDATE messages SET visibility = 'internal' WHERE text='A secret rental snippet'");
  await a.send("Which agent is best for design?");
  const [job] = await worker!.claimJevRoutingJobs();
  assert.ok(job);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.doesNotMatch(String(init?.body), /secret rental/);
    return new Response(JSON.stringify({ answers: {} }), { status: 200 });
  };
  try {
    assert.equal(await routing!.resolveJevConversationRoutingHint(job.plan), null);
    assert.equal(calls, 1);
    await client!.pool.query("UPDATE messages SET visibility = 'internal' WHERE room_id=$1 AND number=$2", [a.room.id, job.message_number]);
    assert.equal(await routing!.resolveJevConversationRoutingHint(job.plan), null);
    assert.equal(calls, 1, "newly restricted latest message is never exported");
    await client!.pool.query("UPDATE messages SET visibility = NULL WHERE room_id=$1 AND number=$2", [a.room.id, job.message_number]);
    await a.enable(false);
    assert.equal(await routing!.resolveJevConversationRoutingHint(job.plan), null);
    assert.equal(calls, 1);
    await a.enable(true);
    process.env.LETAGENTS_JEV_ROUTING = "off";
    assert.equal(await routing!.resolveJevConversationRoutingHint(job.plan), null);
    assert.equal(calls, 1);
    await worker!.completeJevRoutingJob(job, null);
    const fallback = await client!.pool.query("SELECT agent_key, activation_reason FROM message_agent_receipts WHERE message_room_id=$1 AND message_number=$2", [a.room.id, job.message_number]);
    assert.deepEqual(fallback.rows, [{ agent_key: a.sessions[0]!.agent_key, activation_reason: "recent_conversation" }]);
    assert.equal((await api!.getMessages(a.room.id, { wait_for_routing: true } )).messages.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("routing setting is admin-only, canonical and disabled by default", skip, async () => {
  const a = await seed();
  const { registerConversationRoutingRoutes } = await import("../routes/rooms/conversation-routing.js");
  const { requireAdmin, requireParticipant, resolveProjectRole } = await import("../rooms/access.js");
  const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
  registerConversationRoutingRoutes({ get: (_p: unknown, h: any) => { handlers.get = h; }, patch: (_p: unknown, h: any) => { handlers.patch = h; } } as never, {
    resolveCanonicalRoomRequestId: async () => a.room.id,
    resolveRoomOrReply: async () => a.room,
    requireAdmin, requireParticipant, resolveProjectRole,
  });
  const request = async (method: string, accountId: string | null, body = {}, authKind = "session") => {
    const res = { statusCode: 200, body: {} as any, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; } };
    await handlers[method]!({ params: { 0: "room-alias" }, body, authKind,
      sessionAccount: accountId ? { account_id: accountId, provider: "github", login: accountId } : null }, res);
    return res;
  };
  assert.deepEqual((await request("get", a.ownerId)).body, { enabled: false, available: true, can_manage: true });
  assert.equal((await request("patch", null, { enabled: true })).statusCode, 401);
  assert.equal((await request("patch", "not-admin", { enabled: true })).statusCode, 403);
  assert.equal((await request("patch", a.ownerId, { enabled: true }, "agent_session")).statusCode, 403);
  assert.equal((await request("patch", a.ownerId, { enabled: "true" })).statusCode, 400);
  assert.equal((await request("patch", a.ownerId, { enabled: true })).body.enabled, true);
  process.env.LETAGENTS_JEV_ROUTING = "off";
  assert.equal((await request("patch", a.ownerId, { enabled: true })).statusCode, 409);
  assert.equal((await request("patch", a.ownerId, { enabled: false })).body.enabled, false);
});


test("shadow evaluations never hold the worker frontier", skip, async () => {
  const a = await seed();
  await a.enable(true);
  process.env.LETAGENTS_JEV_ROUTING = "shadow";
  const sent = await a.send("Which agents use Claude?");
  assert.equal((await worker!.claimJevRoutingJobs()).length, 1);
  assert.equal((await api!.getLatestMessages(a.room.id, { wait_for_routing: true })).messages.at(-1)?.id, sent.message.id);
});
