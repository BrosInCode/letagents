import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
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
  const reply = (index: number, messageId: string, text = "My answer.") =>
    api!.addMessageWithCreateStatus(room.id, sessions[index]!.actor_label, text, {
      source: "agent",
      publisher_agent_key: sessions[index]!.agent_key,
      publisher_agent_session_id: sessions[index]!.session_id,
      account_id: ownerId,
      client_message_id: `supervised-room:supervised_${index}:${room.id}:${messageId}:reply:v1`,
    });
  return { room, ownerId, sessions, send, read, live, forAgent, turns, reply };
}

/** Index of the session in each reply position, from the stored receipts. */
async function order(a: Awaited<ReturnType<typeof seed>>, messageId: string): Promise<number[]> {
  return (await a.turns(messageId)).map((row) => a.sessions.findIndex((session) => session.agent_key === row.agent_key));
}

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
  assert.deepEqual(a.forAgent(firstRead, sent.message.id), { decision: "activate", reason: "broadcast", addressed: true });
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
    assert.match(a.forAgent(secondRead, sent.message.id)?.guidance ?? "", /answered before you; their reply is/);
    assert.deepEqual((await a.live(second!, sent.message.id)).activation.for_current_agent.turn, expected, "live overlay agrees");
    assert.equal((await a.live(first!, sent.message.id)).activation.for_current_agent.turn, undefined);
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
  assert.equal(turn?.guidance, "Turn order: you answer this message in position 2 of 3. The agent before you did not answer in time. Answer now.");
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
  assert.match(turn?.guidance ?? "", new RegExp(`^Turn order: you answer this message in position 3 of 3\\. ${a.sessions[first!]!.actor_label} answered before you;`));
});

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
      "Turn order: you answer this message in position 3 of 3. The agents before you have not answered yet. Cover only what they are unlikely to say.",
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
    "Turn order: you answer this message in position 2 of 3. The agent before you did not answer in time. Answer now.");
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
  return { poll, reportSelf, close: () => { broker.close?.(); batcher.close(); } };
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
    assert.equal(open.body.messages[0]!.activation.for_current_agent.turn, undefined);

    // A long-poll that is already waiting wakes when the predecessor replies.
    const waiting = route.poll(a.sessions[second!]!, a.ownerId, before.message.id, "5000");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const answer = await a.reply(first!, sent.message.id);
    const woken = await waiting;
    assert.deepEqual(woken.body.messages.map((message) => message.id), [sent.message.id, answer.message.id]);
    const activation = woken.body.messages[0]!.activation.for_current_agent;
    assert.deepEqual(activation.turn, { position: 2, count: 3, prior_speakers: [a.sessions[first!]!.actor_label] });
    assert.match(activation.guidance, /answered before you; their reply is in the recent room context/);
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
