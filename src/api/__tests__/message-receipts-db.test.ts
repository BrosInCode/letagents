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
const { captureStatement, explainRead: explainStatementRead } = await import("./statement-read.js");
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

test("the route reports no reason for agent output, pending active routing, or a wake-rule wake", skip, async () => {
  process.env.LETAGENTS_JEV_ROUTING = "active";
  process.env.TYPESAFE_API_KEY = "fixture-key";
  const a = await seed(3);
  await client!.pool.query("UPDATE rooms SET jev_routing_enabled = true WHERE id = $1", [a.room.id]);
  const pending = await a.send("Which agent knows the design?");
  const agentOutput = await a.reply(0, pending.message.id);
  const wakeRule = await a.send("@MissingAgent hello");
  await client!.pool.query(`UPDATE messages SET no_wake = '{"reason":"wake_rule"}'::jsonb WHERE room_id=$1 AND number=$2`,
    [a.room.id, Number(wakeRule.message.id.slice(4))]);
  // A shadow-mode job does not hold back the reason written at send time.
  const shadow = await a.send("Which agent knows the tests?");
  await client!.pool.query(`UPDATE jev_routing_jobs SET plan = jsonb_set(plan, '{mode}', '"shadow"') WHERE room_id=$1 AND message_number=$2`,
    [a.room.id, Number(shadow.message.id.slice(4))]);
  await client!.pool.query(`UPDATE messages SET no_wake = '{"reason":"no_mention_large_room","agent_count":3}'::jsonb WHERE room_id=$1 AND number=$2`,
    [a.room.id, Number(shadow.message.id.slice(4))]);
  await withServer(async (get) => {
    const ids = [pending.message.id, agentOutput.message.id, wakeRule.message.id, shadow.message.id].join(",");
    const response = await get(a.ownerId, `/rooms/${encodeURIComponent(a.room.id)}/messages/receipts?ids=${ids}`);
    const byId = new Map(response.body.receipts.map((receipt: any) => [receipt.message_id, receipt.no_wake]));
    assert.equal(byId.size, 4, "the sender's own agents publish under the same account");
    assert.equal(byId.get(pending.message.id), null);
    assert.equal(byId.get(agentOutput.message.id), null);
    assert.equal(byId.get(wakeRule.message.id), null);
    assert.deepEqual(byId.get(shadow.message.id), { reason: "no_mention_large_room", agent_count: 3 });
  });
});

test("a plan queued before agent_count existed records unknown when routing elects nobody", skip, async () => {
  process.env.LETAGENTS_JEV_ROUTING = "active";
  process.env.TYPESAFE_API_KEY = "fixture-key";
  const a = await seed(3);
  await client!.pool.query("UPDATE rooms SET jev_routing_enabled = true WHERE id = $1", [a.room.id]);
  const sent = await a.send("Which agent knows the design?");
  await client!.pool.query("UPDATE jev_routing_jobs SET plan = plan - 'agent_count' - 'no_wake' WHERE room_id=$1", [a.room.id]);
  const [job] = await worker!.claimJevRoutingJobs();
  await worker!.completeJevRoutingJob(job!, {
    mode: "active", elected: [], electionReason: "none_chosen", needsResponse: 0.9, choice: "none",
    probabilitiesByAgentKey: {}, confidence: 0.9, respondByAgentKey: {}, candidateAgentKeys: [], latencyMs: 1,
  } as any);
  assert.deepEqual(await a.noWake(sent.message.id), { reason: "unknown" });
});

// The receipt read of a message page used to join the receipt table to a
// jsonb_to_recordset list, which PostgreSQL cannot size, so it scanned the
// whole table. This is the statement as it was, kept as the reference.
const REFERENCE_RECEIPTS_SQL = `
  WITH requested_account AS (
    SELECT value.account_id FROM jsonb_to_recordset($1::jsonb) AS value(account_id text)
  ), input_message AS (
    SELECT value.message_number FROM jsonb_to_recordset($2::jsonb) AS value(message_number integer)
  ), owned_receipt AS (
    SELECT captured.owner_account_id AS account_id, receipt.message_number, receipt.agent_key,
           receipt.agent_session_id, receipt.activation_reason, receipt.turn_position, receipt.turn_count,
           CASE WHEN receipt.hold_released_at IS NULL AND receipt.hold_release_after <= now()
                  THEN 'deadline' ELSE receipt.hold_release_reason END AS hold_release_reason,
           captured.ended_at
      FROM message_agent_receipts AS receipt
      JOIN input_message ON input_message.message_number = receipt.message_number
      JOIN room_agent_sessions AS captured
        ON captured.session_id = receipt.agent_session_id
       AND captured.room_id = receipt.room_id
       AND captured.agent_key = receipt.agent_key
      JOIN requested_account ON requested_account.account_id = captured.owner_account_id
     WHERE receipt.message_room_id = $3 AND captured.session_kind = 'worker'
  ), replied_turn AS (
    SELECT replied.message_number, replied.turn_position, replied.actor_label
      FROM message_agent_receipts AS replied
      JOIN input_message ON input_message.message_number = replied.message_number
     WHERE replied.message_room_id = $3 AND replied.turn_position IS NOT NULL
       AND replied.receipt_state = 'replied'
  ), receipt_key AS (
    SELECT DISTINCT owned_receipt.account_id, owned_receipt.agent_key
      FROM owned_receipt WHERE owned_receipt.ended_at IS NOT NULL
  ), unique_live_successor AS (
    SELECT receipt_key.account_id, active.agent_key,
           CASE WHEN COUNT(*) = 1
                  AND MIN(active.owner_account_id) = receipt_key.account_id
                  AND MAX(active.owner_account_id) = receipt_key.account_id
                  THEN MIN(active.session_id) ELSE NULL END AS agent_session_id
      FROM receipt_key
      JOIN room_agent_sessions AS active ON active.agent_key = receipt_key.agent_key
     WHERE active.room_id = $3 AND active.session_kind = 'worker' AND active.ended_at IS NULL
     GROUP BY receipt_key.account_id, active.agent_key
  )
  SELECT owned_receipt.account_id, owned_receipt.message_number, owned_receipt.agent_key,
         owned_receipt.agent_session_id, owned_receipt.activation_reason,
         CASE WHEN owned_receipt.ended_at IS NOT NULL
                THEN unique_live_successor.agent_session_id ELSE NULL END AS successor_agent_session_id,
         owned_receipt.turn_position, owned_receipt.turn_count, owned_receipt.hold_release_reason,
         CASE WHEN owned_receipt.turn_position >= 2 THEN (
           SELECT COALESCE(jsonb_agg(prior.actor_label ORDER BY prior.turn_position), '[]'::jsonb)
             FROM replied_turn AS prior
            WHERE prior.message_number = owned_receipt.message_number
              AND prior.turn_position < owned_receipt.turn_position
         ) END AS prior_speakers
    FROM owned_receipt
    LEFT JOIN unique_live_successor
      ON unique_live_successor.account_id = owned_receipt.account_id
     AND unique_live_successor.agent_key = owned_receipt.agent_key
   LIMIT 100001`;

// Records the receipt statement the routing function sends, with its rows.
const captureReceiptRead = (run: () => Promise<unknown>, match = /WITH live_successor AS/) =>
  captureStatement<any>(client!.pool, match, run);
const explainRead = (text: string, values: unknown[]) => explainStatementRead(client!.pool, text, values);

const sortRows = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const referenceReceipts = (roomId: string, accountIds: string[], snapshotNumbers: number[]) =>
  client!.pool.query(REFERENCE_RECEIPTS_SQL, [
    JSON.stringify([...new Set(accountIds)].map((account_id) => ({ account_id }))),
    JSON.stringify(snapshotNumbers.map((message_number) => ({ message_number }))),
    roomId,
  ]);

test("the receipt read finds receipts by room and message number and returns what the join-list read returned", skip, async () => {
  const routing = await import("../db/messages/account-agent-routing.js");
  const room = await api!.createProjectWithName("receipt-parity");
  const focus = await api!.createProjectWithName("receipt-parity-focus");
  for (const id of ["acct-a", "acct-b", "acct-c"]) await account(id);
  const T = "2026-01-01T00:00:00Z";
  await client!.pool.query(
    `INSERT INTO messages (room_id, sender, text, timestamp, number, routing_snapshot_version)
       SELECT $1, 'human', 'm' || n, $2, n, CASE WHEN n = 7 THEN NULL ELSE 1 END FROM generate_series(1, 12) n`,
    [room.id, T]);
  const session = (id: string, roomId: string, owner: string, key: string, kind: string, ended: boolean) =>
    client!.pool.query(
      `INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key,
         display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at, ended_at)
       VALUES ($1,$2,$1,$3::room_agent_session_kind,'codex',$1,$4,$1,$5,$5,'Codex',$6,$6,$6,$7)`,
      [id, roomId, kind, key, owner, T, ended ? T : null]);
  await session("s-a-live", room.id, "acct-a", "acct-a/x", "worker", false);
  await session("s-a-old", room.id, "acct-a", "acct-a/y", "worker", true);
  await session("s-a-new", room.id, "acct-a", "acct-a/y", "worker", false);
  await session("s-b-old", room.id, "acct-b", "acct-b/z", "worker", true);
  await session("s-b-live1", room.id, "acct-b", "acct-b/z", "worker", false);
  await session("s-b-live2", room.id, "acct-b", "acct-b/z", "worker", false);
  await session("s-c-ctrl", room.id, "acct-c", "acct-c/c", "controller", false);
  await session("s-c-live", room.id, "acct-c", "acct-c/d", "worker", false);
  await session("s-a-focus", focus.id, "acct-a", "acct-a/f", "worker", false);
  let n = 0;
  const receipt = (msg: number, roomId: string, sessionId: string, key: string, extra: Record<string, unknown> = {}) => {
    const row = {
      activation_reason: "mention", receipt_state: "pending", turn_position: null, turn_count: null,
      hold_release_after: null, hold_released_at: null, hold_release_reason: null, actor_label: key, ...extra,
    };
    return client!.pool.query(
      `INSERT INTO message_agent_receipts (id, message_room_id, message_number, room_id, agent_session_id, agent_key,
         actor_label, activation_reason, receipt_state, turn_position, turn_count, hold_release_after,
         hold_released_at, hold_release_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [`r${++n}`, room.id, msg, roomId, sessionId, key, row.actor_label, row.activation_reason, row.receipt_state,
        row.turn_position, row.turn_count, row.hold_release_after, row.hold_released_at, row.hold_release_reason, T]);
  };
  // 1: live agent, ended agent with one live successor, ended agent with two live successors.
  await receipt(1, room.id, "s-a-live", "acct-a/x");
  await receipt(1, room.id, "s-a-old", "acct-a/y");
  await receipt(1, room.id, "s-b-old", "acct-b/z");
  // 2: a three-turn sequence; position 1 replied, position 3 is past its deadline and never swept.
  await receipt(2, room.id, "s-c-live", "acct-c/d", { turn_position: 1, turn_count: 3, receipt_state: "replied", actor_label: "First" });
  await receipt(2, room.id, "s-a-live", "acct-a/x", { turn_position: 2, turn_count: 3 });
  await receipt(2, room.id, "s-b-live1", "acct-b/z", { turn_position: 3, turn_count: 3, hold_release_after: "2026-01-02T00:00:00Z" });
  // 3: a hold still in the future, and a hold already released with its reason.
  await receipt(3, room.id, "s-a-live", "acct-a/x", { turn_position: 2, turn_count: 2, hold_release_after: "2999-01-01T00:00:00Z" });
  await receipt(3, room.id, "s-b-live1", "acct-b/z", { turn_position: 1, turn_count: 2, hold_release_after: "2026-01-02T00:00:00Z",
    hold_released_at: "2026-01-02T00:00:00Z", hold_release_reason: "turn" });
  // 4: a controller session (excluded). 5: a receipt whose own room differs from its message room.
  await receipt(4, room.id, "s-c-ctrl", "acct-c/c");
  await receipt(5, focus.id, "s-a-focus", "acct-a/f");
  // 7 has no routing snapshot; 6 and 8 have a snapshot and no receipt.
  // 9: ended agents whose agent key lives on in a session that may not take the receipt over.
  const odd = "acct-a/o\"d\\d:1 ü";
  await session("s-a-moved-old", room.id, "acct-a", "acct-a/moved", "worker", true);
  await session("s-b-moved-new", room.id, "acct-b", "acct-a/moved", "worker", false);    // another account owns it
  await session("s-a-ctl-old", room.id, "acct-a", "acct-a/ctl", "worker", true);
  await session("s-a-ctl-new", room.id, "acct-a", "acct-a/ctl", "controller", false);    // not a worker
  await session("s-a-away-old", room.id, "acct-a", "acct-a/away", "worker", true);
  await session("s-a-away-new", focus.id, "acct-a", "acct-a/away", "worker", false);     // another room
  await session("s-a-both-old", room.id, "acct-a", "acct-a/both", "worker", true);
  await session("s-a-both-ctl", room.id, "acct-a", "acct-a/both", "controller", false);  // the worker beside it counts alone
  await session("s-a-both-new", room.id, "acct-a", "acct-a/both", "worker", false);
  await session("s-a-odd-old", room.id, "acct-a", odd, "worker", true);
  await session("s-a-odd-new", room.id, "acct-a", odd, "worker", false);
  for (const key of ["moved", "ctl", "away", "both"]) await receipt(9, room.id, `s-a-${key}-old`, `acct-a/${key}`);
  await receipt(9, room.id, "s-a-odd-old", odd);
  // 10: turn positions with gaps, written out of order; a reply without a position is no speaker.
  await receipt(10, room.id, "s-c-live", "acct-c/d", { turn_position: 5, turn_count: 9, receipt_state: "replied", actor_label: "Fi\"fth" });
  await receipt(10, room.id, "s-b-live1", "acct-b/z", { turn_position: 2, turn_count: 9, receipt_state: "replied", actor_label: "Second ü" });
  await receipt(10, room.id, "s-a-live", "acct-a/x", { turn_position: 9, turn_count: 9 });
  await receipt(10, room.id, "s-a-new", "acct-a/y", { receipt_state: "replied", actor_label: "No position" });
  // 11: a second position nobody answered before. 12: receipts without a matching session.
  await receipt(11, room.id, "s-a-live", "acct-a/x", { turn_position: 2, turn_count: 2 });
  await receipt(11, room.id, "s-c-live", "acct-c/d", { turn_position: 1, turn_count: 2 });
  await receipt(12, room.id, "s-gone", "acct-a/x");
  await receipt(12, room.id, "s-a-live", "acct-a/other-key");
  await receipt(12, focus.id, "s-b-live1", "acct-b/z");

  const run = async (accountIds: string[], numbers: number[]) => {
    const rows = await routing.getMessageAccountRoutingRows(client!.db, room.id, [...new Set(numbers)]);
    // Duplicated rows model a caller that repeats a message; the function collapses them.
    const repeated = [...rows, ...rows.filter((row) => numbers.indexOf(row.number) !== numbers.lastIndexOf(row.number))];
    const captured = await captureReceiptRead(() =>
      routing.getMessageAccountAgentRoutings(client!.db, room.id, accountIds, repeated));
    return { ...captured, rows };
  };
  const cases: Array<[string, string[], number[]]> = [
    ["every account, every message", ["acct-a", "acct-b", "acct-c"], [1, 2, 3, 4, 5, 6, 7, 8]],
    ["duplicate account and message numbers", ["acct-a", "acct-a", "acct-b"], [3, 2, 3, 2, 1]],
    ["one account", ["acct-a"], [1, 2, 3, 4, 5]],
    ["numbers without receipts", ["acct-a", "acct-b"], [6, 8]],
    ["an account that owns nothing", ["nobody"], [1, 2, 3]],
    ["successors and turn orders at their edges", ["acct-a", "acct-b", "acct-c"], [9, 10, 11, 12]],
    // PostgreSQL searches a list of nine or more values by hash and a shorter one value by value.
    ["long lists", ["acct-a", "acct-b", "acct-c", ...Array.from({ length: 9 }, (_, i) => `nobody-${i}`)],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
  ];
  let compared = 0;
  for (const [label, accountIds, numbers] of cases) {
    const { read } = await run(accountIds, numbers);
    assert.ok(read, `${label}: the receipt statement ran`);
    assert.match(read.text, /= ANY\(/, `${label}: the new statement filters by an array`);
    const snapshotNumbers = (await routing.getMessageAccountRoutingRows(client!.db, room.id, [...new Set(numbers)]))
      .filter((row) => row.routing_snapshot_version !== null).map((row) => row.number);
    const reference = await referenceReceipts(room.id, accountIds, snapshotNumbers);
    // The statement has no ORDER BY, so both sides are compared as sets of rows.
    assert.deepEqual(sortRows(read.rows), sortRows(reference.rows), label);
    compared += read.rows.length;
  }
  assert.ok(compared > 0);

  const full = await run(["acct-a", "acct-b", "acct-c"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const byAccount = full.result as Map<string, Map<number, any>>;
  const targets = (account: string, number: number) => byAccount.get(account)!.get(number).recipient_agent_sessions;
  assert.equal(targets("acct-a", 1).find((t: any) => t.agent_key === "acct-a/y").successor_agent_session_id, "s-a-new");
  assert.equal(targets("acct-b", 1)[0].successor_agent_session_id, undefined, "two live successors name none");
  assert.deepEqual(targets("acct-a", 2)[0].prior_speakers, ["First"]);
  assert.equal(targets("acct-b", 2)[0].hold_release_reason, "deadline");
  assert.equal(targets("acct-a", 3)[0].hold_release_reason, undefined, "a future hold has no release reason");
  assert.equal(targets("acct-b", 3)[0].hold_release_reason, "turn");
  assert.deepEqual(targets("acct-c", 4), [], "a controller session receives nothing");
  assert.equal(targets("acct-a", 5)[0].agent_key, "acct-a/f");
  assert.equal(byAccount.get("acct-a")!.get(7)!.authority, "legacy");
  const successor = (key: string) => targets("acct-a", 9).find((t: any) => t.agent_key === key).successor_agent_session_id;
  assert.equal(successor("acct-a/moved"), undefined, "a live session of another account is no successor");
  assert.equal(successor("acct-a/ctl"), undefined, "a live controller is no successor");
  assert.equal(successor("acct-a/away"), undefined, "a live session in another room is no successor");
  assert.equal(successor("acct-a/both"), "s-a-both-new");
  assert.equal(successor(odd), "s-a-odd-new");
  assert.deepEqual(targets("acct-a", 10).find((t: any) => t.turn_position === 9).prior_speakers, ["Second ü", "Fi\"fth"]);
  assert.deepEqual(targets("acct-c", 10)[0].prior_speakers, ["Second ü"]);
  assert.deepEqual(targets("acct-b", 10)[0].prior_speakers, []);
  assert.deepEqual(targets("acct-a", 11)[0].prior_speakers, []);
  assert.deepEqual([targets("acct-a", 12), targets("acct-b", 12)], [[], []], "a receipt without its session reaches nobody");

  const empty = await captureReceiptRead(() => routing.getMessageAccountAgentRoutings(client!.db, room.id, ["acct-a"], []));
  assert.equal(empty.read, null, "an empty list sends no receipt statement");
  assert.equal((empty.result as Map<unknown, unknown>).size, 0);
});

test("the receipt read of a message page reads the receipt table through its index", skip, async () => {
  const routing = await import("../db/messages/account-agent-routing.js");
  const T = "2026-01-01T00:00:00Z";
  for (const id of ["acct-a", "acct-b", "acct-c"]) await account(id);
  // 60 rooms; room-0 holds 850 messages with 4 receipts each (3,400), the others 24 each (~5,600).
  await client!.pool.query(`
    INSERT INTO rooms (id, created_at, display_name) SELECT 'plan-' || r, '${T}', 'plan ' || r FROM generate_series(0, 59) r;
    INSERT INTO messages (room_id, sender, text, timestamp, number, routing_snapshot_version)
      SELECT 'plan-' || r, 'human', 'm', '${T}', n, 1 FROM generate_series(0, 59) r,
        LATERAL generate_series(1, CASE WHEN r = 0 THEN 850 ELSE 24 END) n;
    INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key,
        display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at)
      SELECT 's-' || r || '-' || i, 'plan-' || r, 's-' || r || '-' || i, 'worker', 'codex', 'a' || i, 'acct-' || chr(97 + i % 3) || '/a' || i,
        'a' || i, 'acct-' || chr(97 + i % 3), 'x', 'Codex', '${T}', '${T}', '${T}'
        FROM generate_series(0, 59) r, generate_series(0, 5) i;
    INSERT INTO message_agent_receipts (id, message_room_id, message_number, room_id, agent_session_id, agent_key,
        actor_label, activation_reason, receipt_state, created_at, updated_at)
      SELECT 'p-' || r || '-' || n || '-' || i, 'plan-' || r, n, 'plan-' || r, 's-' || r || '-' || i,
        'acct-' || chr(97 + i % 3) || '/a' || i, 'a' || i, 'mention', 'pending', '${T}', '${T}'
        FROM generate_series(0, 59) r, LATERAL generate_series(1, CASE WHEN r = 0 THEN 850 ELSE 24 END) n,
        generate_series(0, 3) i;
    ANALYZE;`);
  const numbers = Array.from({ length: 50 }, (_, index) => 700 + index);
  const rows = await routing.getMessageAccountRoutingRows(client!.db, "plan-0", numbers);
  const { read } = await captureReceiptRead(() =>
    routing.getMessageAccountAgentRoutings(client!.db, "plan-0", ["acct-a", "acct-b", "acct-c"], rows));
  assert.ok(read);
  assert.equal(read.rows.length, 200);
  const plan = await explainRead(read.text, read.values);
  assert.ok(plan.scans("message_agent_receipts").length > 0);
  for (const scan of plan.scans("message_agent_receipts")) assert.notEqual(scan["Node Type"], "Seq Scan", "no full scan of message_agent_receipts");
  // The page names 50 messages of a room that holds 3,400 receipts; only the 200 that match may be read.
  assert.ok(plan.rowsRead("message_agent_receipts") <= 400, `receipt rows read: ${plan.rowsRead("message_agent_receipts")}`);
  // A receipt reads its own session and no other row of the table's 360. (PostgreSQL may read a session
  // once for all the receipts that name it.)
  assert.ok(plan.rowsRead("room_agent_sessions") <= 200, `session rows read: ${plan.rowsRead("room_agent_sessions")}`);
});

// One message with 6,000 receipts, in tables that were never analyzed: the
// planner then expects one row everywhere. Statements that left the session
// join or the successor join to the planner read thousands of sessions for
// each receipt here. The bounds hold for every plan the statement permits, so
// statistics that arrive later cannot change the verdict.
test("the receipt read of a 6,000-recipient broadcast reads each receipt and each session once", skip, async () => {
  const routing = await import("../db/messages/account-agent-routing.js");
  const room = await api!.createProjectWithName("receipt-broadcast");
  for (const id of ["acct-big", "acct-other"]) await account(id);
  const COUNT = 6_000;
  const sessions = (prefix: string) => client!.pool.query(
    `INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key,
       display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at)
     SELECT $2 || n, $1, $2 || n, 'worker', 'test', $2 || n, 'test/broadcast-agent-' || n, 'Broadcast agent ' || n,
            'acct-big', 'Owner', 'Codex', now(), now(), now()
       FROM generate_series(1, $3::int) n`, [room.id, prefix, COUNT]);
  await sessions("first-");
  await client!.pool.query(
    `INSERT INTO messages (room_id, sender, text, timestamp, number, routing_snapshot_version)
       VALUES ($1, 'human', '@everyone status', now(), 1, 1)`, [room.id]);
  await client!.pool.query(
    `INSERT INTO message_agent_receipts (id, message_room_id, message_number, room_id, agent_session_id, agent_key,
       actor_label, activation_reason, receipt_state, created_at, updated_at)
     SELECT 'broadcast-' || n, $1, 1, $1, 'first-' || n, 'test/broadcast-agent-' || n, 'Broadcast agent ' || n,
            'broadcast', 'pending', now(), now()
       FROM generate_series(1, $2::int) n`, [room.id, COUNT]);
  const rows = await routing.getMessageAccountRoutingRows(client!.db, room.id, [1]);
  const read = async () => (await captureReceiptRead(() =>
    routing.getMessageAccountAgentRoutings(client!.db, room.id, ["acct-big", "acct-other"], rows))).read!;
  const bounded = (plan: Awaited<ReturnType<typeof explainRead>>, sessionRows: number) => {
    assert.ok(plan.rowsRead("message_agent_receipts") <= COUNT, `receipt rows read: ${plan.rowsRead("message_agent_receipts")}`);
    assert.ok(plan.rowsRead("room_agent_sessions") <= sessionRows, `session rows read: ${plan.rowsRead("room_agent_sessions")}`);
    assert.ok(plan.pages <= 10 * COUNT, `pages touched: ${plan.pages}`);
  };

  const live = await read();
  assert.equal(live.rows.length, COUNT);
  assert.deepEqual(sortRows(live.rows), sortRows((await referenceReceipts(room.id, ["acct-big", "acct-other"], [1])).rows));
  bounded(await explainRead(live.text, live.values), COUNT);

  // Every agent stops and starts again: each receipt now names an ended session with one live successor.
  // The reference statement is not run for this room: it needs minutes.
  await client!.pool.query("UPDATE room_agent_sessions SET ended_at = now() WHERE room_id = $1", [room.id]);
  await sessions("second-");
  // One session for each receipt, and one pass over the room's 12,000 sessions for the successors.
  bounded(await explainRead(live.text, live.values), 3 * COUNT);
  const ended = await read();
  assert.equal(ended.rows.length, COUNT);
  assert.ok(ended.rows.every((row) => row.successor_agent_session_id === `second-${String(row.agent_session_id).slice("first-".length)}`));
});

test("the receipt read returns the rows of the join-list read for random rooms", skip, async () => {
  const routing = await import("../db/messages/account-agent-routing.js");
  const T = "2026-01-01T00:00:00Z";
  const accounts = ["rnd-a", "rnd-b", "rnd-c", "rnd \"d\\ ü"];
  for (const id of accounts) await account(id);
  let state = 20261120;
  const random = () => { state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff; return state / 0x80000000; };
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const odd = ["", " ", "a:b", "1:2", "qu\"ote", "back\\slash", "line\nbreak", "{x}", "null", "ü", "日本", "x".repeat(200)];
  let compared = 0, successors = 0, priorSpeakers = 0;
  for (let round = 0; round < 40; round++) {
    const rooms = [`rnd-${round}`, `rnd-${round}-other`];
    await client!.pool.query(
      `INSERT INTO rooms (id, created_at, display_name) SELECT id, $2, id FROM unnest($1::text[]) id`, [rooms, T]);
    const messageCount = 1 + Math.floor(random() * 8);
    await client!.pool.query(
      `INSERT INTO messages (room_id, sender, text, timestamp, number, routing_snapshot_version)
         SELECT $1, 'human', 'm', $2, n, 1 FROM generate_series(1, $3::int) n`, [rooms[0], T, messageCount]);
    const owners = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(accounts));
    const keys = owners.map((owner, i) => `${owner}/${random() < 0.4 ? pick(odd) : "agent"}-${i}`);
    // An agent key mostly keeps its room and its owner; some sessions are controllers, strays or another account's.
    const sessions = Array.from({ length: Math.floor(random() * 20) }, (_, i) => {
      const agent = Math.floor(random() * keys.length);
      return {
        id: `rnd-${round}-s${i}`, room: random() < 0.85 ? rooms[0] : rooms[1], kind: random() < 0.85 ? "worker" : "controller",
        key: keys[agent]!, owner: random() < 0.85 ? owners[agent]! : pick(accounts), ended: random() < 0.7,
      };
    });
    await client!.pool.query(
      `INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key,
         display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at, ended_at)
       SELECT v.id, v.room, v.id, v.kind::room_agent_session_kind, 'codex', v.id, v.key, v.id, v.owner, v.owner, 'Codex',
              $2, $2, $2, CASE WHEN v.ended THEN $2::timestamptz END
         FROM jsonb_to_recordset($1::jsonb) AS v(id text, room text, kind text, key text, owner text, ended boolean)`,
      [JSON.stringify(sessions), T]);
    const receipts: Record<string, unknown>[] = [];
    for (let number = 1; number <= messageCount; number++) {
      const sequenced = random() < 0.5;
      const positions = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 2147483647].sort(() => random() - 0.5);
      for (const key of keys.filter(() => random() < 0.7)) {
        const session = sessions.length > 0 && random() < 0.93 ? pick(sessions) : null;
        // Most receipts name a session of their own agent; the rest name another agent's, or none.
        const own = sessions.filter((candidate) => candidate.key === key);
        const captured = own.length > 0 && random() < 0.85 ? pick(own) : session;
        const position = sequenced && random() < 0.8 ? positions.pop()! : null;   // each position once in a message
        receipts.push({
          id: `rnd-${round}-r${receipts.length}`, number, room: captured && random() < 0.93 ? captured.room : pick(rooms),
          session: captured?.id ?? "rnd-missing", key, label: random() < 0.3 ? pick(odd) : `Agent ${receipts.length}`,
          state: pick(["pending", "replied", "replied", "failed"]), position, count: position === null ? null : 8,
          release_after: pick([null, null, "2020-01-01T00:00:00Z", "2999-01-01T00:00:00Z"]),
          released_at: pick([null, null, "2020-01-01T00:00:00Z"]), reason: pick([null, null, "turn", "deadline", "skipped"]),
        });
      }
    }
    await client!.pool.query(
      `INSERT INTO message_agent_receipts (id, message_room_id, message_number, room_id, agent_session_id, agent_key,
         actor_label, activation_reason, receipt_state, turn_position, turn_count, hold_release_after, hold_released_at,
         hold_release_reason, created_at, updated_at)
       SELECT v.id, $2, v.number, v.room, v.session, v.key, v.label, 'broadcast', v.state, v.position, v.count,
              v.release_after::timestamptz, v.released_at::timestamptz, v.reason, $3, $3
         FROM jsonb_to_recordset($1::jsonb) AS v(id text, number int, room text, session text, key text, label text,
           state text, position int, count int, release_after text, released_at text, reason text)`,
      [JSON.stringify(receipts), rooms[0], T]);
    for (let query = 0; query < 4; query++) {
      const accountIds = [...accounts.filter(() => random() < 0.6), ...(random() < 0.3 ? Array.from({ length: 9 }, (_, i) => `rnd-nobody-${i}`) : [])];
      if (accountIds.length === 0) accountIds.push(pick(accounts));
      const numbers = Array.from({ length: messageCount + 1 }, (_, i) => i + 1).filter(() => random() < 0.8);
      const rows = await routing.getMessageAccountRoutingRows(client!.db, rooms[0]!, numbers);
      if (rows.length === 0) continue;
      const { read } = await captureReceiptRead(() => routing.getMessageAccountAgentRoutings(client!.db, rooms[0]!, accountIds, rows));
      assert.ok(read);
      const reference = await referenceReceipts(rooms[0]!, accountIds, rows.map((row) => row.number));
      assert.deepEqual(sortRows(read.rows), sortRows(reference.rows), `round ${round}, query ${query}`);
      compared += read.rows.length;
      successors += read.rows.filter((row) => row.successor_agent_session_id !== null).length;
      priorSpeakers += read.rows.filter((row) => Array.isArray(row.prior_speakers) && row.prior_speakers.length > 0).length;
    }
  }
  // The random rooms must reach both lookups, or the comparison proves little.
  assert.ok(compared > 300 && successors > 20 && priorSpeakers > 20, JSON.stringify({ compared, successors, priorSpeakers }));
});

const REFERENCE_REPLY_SQL = `
  WITH input_reply AS (
    SELECT value.number FROM jsonb_to_recordset($1::jsonb) AS value(number integer)
  )
  SELECT reply.number, reply.sender, reply.source, reply.publisher_agent_key,
         reply.publisher_agent_session_id, reply.publisher_account_id
    FROM messages AS reply
    JOIN input_reply ON input_reply.number = reply.number
   WHERE reply.room_id = $2`;

test("the reply lookup of legacy routing reads only the named messages of a large room", skip, async () => {
  const routing = await import("../db/messages/account-agent-routing.js");
  const room = await api!.createProjectWithName("reply-lookup");
  await account("acct-r");
  await client!.pool.query(
    `INSERT INTO messages (room_id, sender, text, timestamp, number, source, publisher_agent_key, publisher_account_id)
       SELECT $1, 'human', 'm', '2026-01-01T00:00:00Z', n, CASE WHEN n % 7 = 0 THEN 'agent' ELSE 'browser' END,
              CASE WHEN n % 7 = 0 THEN 'acct-r/a' END, CASE WHEN n % 7 = 0 THEN 'acct-r' END
         FROM generate_series(1, 3000) n`, [room.id]);
  await client!.pool.query("ANALYZE messages");
  const legacy = (replyTo: number[]) => replyTo.map((reply_to_number, index) => ({
    number: 5000 + index, thread_root_number: null, routing_snapshot_version: null, publisher_account_id: null,
    publisher_agent_key: null, reply_to_number, sender: "human", source: "browser", text: "hello",
  }));
  const run = (replyTo: number[]) => captureReceiptRead(
    () => routing.resolveGlobalLegacyTargets(client!.db, room.id, legacy(replyTo)), /AS reply/i);
  const cases: Array<[string, number[]]> = [
    ["three numbers", [7, 1400, 2999]],
    ["duplicate numbers", [14, 14, 21, 14]],
    ["numbers with no message", [7, 99999, 3001]],
    ["only missing numbers", [99999]],
  ];
  for (const [label, replyTo] of cases) {
    const { read } = await run(replyTo);
    assert.ok(read, label);
    const unique = [...new Set(replyTo)];
    const reference = await client!.pool.query(REFERENCE_REPLY_SQL, [
      JSON.stringify(unique.map((number) => ({ number }))), room.id]);
    assert.deepEqual(sortRows(read.rows), sortRows(reference.rows), label);
  }
  const found = await run([7, 1400, 2999]);
  assert.equal(found.read!.rows.length, 3);
  assert.equal(found.read!.rows.find((row) => row.number === 7)!.publisher_agent_key, "acct-r/a");
  assert.match(found.read!.text, /= ANY\(/);
  const none = await run([]);
  assert.equal(none.read, null, "no reply numbers sends no reply statement");

  const rowsRead = async (text: string, values: unknown[]) => (await explainRead(text, values)).rowsRead("messages");
  // The room holds 3,000 messages; the three named ones are all the lookup may read.
  assert.ok(await rowsRead(found.read!.text, found.read!.values) <= 10, "new form reads about 3 messages");
  const oldRead = await rowsRead(REFERENCE_REPLY_SQL, [JSON.stringify([7, 1400, 2999].map((number) => ({ number }))), room.id]);
  assert.ok(oldRead >= 3000, `the old form reads the whole room (${oldRead})`);
});
