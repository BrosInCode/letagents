import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { z } from "zod";

// A ChatGPT-like client subscribes to room.message over /mcp (MCP Events) with
// a loopback callback; verification, delivery, renewal, replay and the ends.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_CONNECTOR_SECRET_KEY = randomBytes(32).toString("hex");
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE = "1000";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed MCP Events tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const store = testDatabaseUrl ? await import("../db/wake-rules.js") : null;
const scheduler = testDatabaseUrl ? await import("../wake-rules/scheduler.js") : null;
const worker = testDatabaseUrl ? await import("../notifications/wake-webhooks.js") : null;
const events = testDatabaseUrl ? await import("../remote-mcp/events.js") : null;
const guard = await import("../wake-rules/webhook-url.js");
const contract = await import("../wake-rules/mcp-events.js");

const TOKEN_BOT = "mcp_events_owner_token_bot";
const TOKEN_OTHER = "mcp_events_owner_token_other";
const SECRET_A = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const SECRET_B = `whsec_${Buffer.alloc(48, 2).toString("base64")}`;
let server: Server | null = null;
let baseUrl = "";
const accounts: Record<"bot" | "other" | "human", string> = { bot: "", other: "", human: "" };

interface Received { headers: IncomingHttpHeaders; body: string; path: string }
/** Event POSTs the receiver got, and verification POSTs, apart. */
const received: Received[] = [];
const verifications: Received[] = [];
/** Statuses (and headers) the receiver answers the next event POSTs with. */
const replies: Array<number | { status: number; headers?: Record<string, string> }> = [];
type VerifyMode = "echo" | "mismatch" | "500" | "hang" | "nonjson";
let verifyMode: VerifyMode = "echo";
const hung: ServerResponse[] = [];
let receiver: Server | null = null;
let hookUrl = "";

async function createOwner(suffix: string, token: string): Promise<string> {
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `mcp-events-${suffix}`, login: `mcp-events-${suffix}`, display_name: `Events ${suffix}`,
  });
  await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: `mcp-events-${suffix}`, token });
  return account.id;
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    accounts.bot = await createOwner("bot", TOKEN_BOT);
    accounts.other = await createOwner("other", TOKEN_OTHER);
    accounts.human = (await accountSessions!.upsertAccount({
      provider: "github", provider_user_id: "mcp-events-ada", login: "Ada", display_name: "Ada",
    })).id;
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The receiver runs on loopback over http, which only this test switch admits.
    guard.allowLoopbackWakeWebhooksForTests({});
    receiver = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        let parsed: { type?: string; challenge?: string } = {};
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        if (parsed.type === "verification") {
          verifications.push({ headers: request.headers, body, path: request.url ?? "" });
          switch (verifyMode) {
            case "echo": response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ challenge: parsed.challenge })); return;
            case "mismatch": response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ challenge: `${parsed.challenge}x` })); return;
            case "500": response.writeHead(500).end("boom"); return;
            case "nonjson": response.writeHead(200).end("ok"); return;
            case "hang": hung.push(response); return;
          }
        }
        received.push({ headers: request.headers, body, path: request.url ?? "" });
        const reply = replies.shift() ?? 200;
        if (typeof reply === "number") response.writeHead(reply).end("ok");
        else response.writeHead(reply.status, reply.headers ?? {}).end("ok");
      });
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/chatgpt`;
  });
  test.after(async () => {
    guard.allowLoopbackWakeWebhooksForTests(false);
    events!.configureMcpEventsForTests(null);
    for (const response of hung) response.destroy();
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    receiver?.closeAllConnections();
    await new Promise<void>((done) => receiver ? receiver.close(() => done()) : done());
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    await dbClient!.pool.end();
  });
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "ChatGPT", version: "1" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
  try {
    return { ...JSON.parse(text), isError: result.isError, raw: text };
  } catch {
    return { raw: text, isError: result.isError };
  }
}

/** An `events/*` method, as a client that knows nothing of our types. */
function rpc(client: Client, method: string, params: unknown): Promise<Record<string, any>> {
  return client.request({ method, params: params as Record<string, unknown> }, z.any()) as Promise<Record<string, any>>;
}

/** The JSON-RPC error an `events/*` call fails with. */
async function rpcError(client: Client, method: string, params: unknown): Promise<{ code: number; message: string; data?: Record<string, any> }> {
  try {
    await rpc(client, method, params);
  } catch (error) {
    const { code, data, message } = error as { code: number; data?: Record<string, any>; message: string };
    assert.equal(typeof code, "number", message);
    return { code, message, data };
  }
  throw new Error(`${method} did not fail`);
}

function subscribeParams(roomId: string, overrides: Record<string, unknown> = {}, args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "room.message",
    arguments: { room_id: roomId, ...args },
    delivery: { mode: "webhook", url: hookUrl, secret: SECRET_A },
    cursor: null,
    ...overrides,
  };
}

async function humanSays(roomId: string, text: string) {
  return api!.addMessage(roomId, "Ada", text, { source: "browser", account_id: accounts.human });
}

/** The room message number behind a `msg_<number>` id. */
function numberOf(message: { id: string }): number {
  return Number(message.id.replace(/^msg_/, ""));
}

async function deliveries(ruleId: string) {
  return (await dbClient!.pool.query<{ id: string; kind: string; state: string; attempt_count: number; message_number: number; last_status: number | null; last_error: string | null; held_by_cap: boolean; sender: string; text_preview: string }>(
    "SELECT id, kind, state, attempt_count, message_number, last_status, last_error, held_by_cap, sender, text_preview FROM wake_webhook_deliveries WHERE rule_id = $1 ORDER BY message_number, created_at, id",
    [ruleId],
  )).rows;
}

/** Drop what earlier tests left waiting, so one test's receiver answers go to its own events. */
async function drainOutbox(): Promise<void> {
  await dbClient!.pool.query("UPDATE wake_webhook_deliveries SET state = 'dead', last_error = 'test_drained' WHERE state IN ('queued', 'retry', 'processing')");
}

async function makeDue(): Promise<void> {
  await dbClient!.pool.query(
    "UPDATE wake_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE state IN ('queued', 'retry')",
  );
}

async function runWorker(overrides: Partial<import("../notifications/wake-webhooks.js").WakeWebhookDeliveryDeps> = {}): Promise<number> {
  return worker!.processWakeWebhookBatch("mcp-events-test-worker", { ...worker!.defaultWakeWebhookDeps(), ...overrides });
}

async function ruleRow(ruleId: string) {
  return (await dbClient!.pool.query("SELECT * FROM agent_wake_rules WHERE id = $1", [ruleId])).rows[0];
}

/** The one held (active, paused or pending) rule behind a subscription id; ended ones may remain in history. */
async function ruleBySubscription(subscriptionId: string) {
  const rows = (await dbClient!.pool.query(
    "SELECT * FROM agent_wake_rules WHERE mcp_subscription_id = $1 AND status IN ('active', 'paused', 'pending_confirmation') ORDER BY created_at",
    [subscriptionId],
  )).rows;
  assert.equal(rows.length, 1, `one held rule per subscription id, got ${rows.length}`);
  return rows[0];
}

function receiverVerifies(secret: string, entry: Received): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${entry.headers["webhook-id"]}.${entry.headers["webhook-timestamp"]}.${entry.body}`).digest("base64");
  return String(entry.headers["webhook-signature"]).split(" ").some((part) => part === `v1,${expected}`);
}

function closeTo(iso: string, expectedMs: number, toleranceMs = 60_000): void {
  assert.ok(Math.abs(Date.parse(iso) - expectedMs) < toleranceMs, `${iso} is not within ${toleranceMs} ms of ${new Date(expectedMs).toISOString()}`);
}

const HOUR = 60 * 60 * 1000;

async function setUpRoom(name: string, token = TOKEN_BOT, registerWorker = true) {
  const bot = await connect(token);
  const joined = await call(bot, "join_room", { name });
  assert.equal(joined.isError, undefined, joined.raw);
  const roomId = String(joined.room_id);
  let workerSession: string | null = null;
  if (registerWorker) {
    const registered = await call(bot, "register_agent_session", { room_id: roomId, display_name: "relaybot", runtime: "chatgpt" });
    assert.ok(registered.agent_session_id, registered.raw);
    workerSession = String(registered.agent_session_id);
  }
  return { bot, roomId, workerSession };
}

test("initialize advertises events; events/list names room.message with its schemas", { skip, timeout: 30_000 }, async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_BOT}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ChatGPT", version: "1" } } }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()));
  const init = data.find((message) => message.result)?.result;
  assert.ok(init, text);
  assert.deepEqual(init.capabilities.events, {}, "capabilities.events: {} as the OpenAI page shows it");
  assert.ok(init.capabilities.tools, "tools stay advertised next to it");

  const bot = await connect(TOKEN_BOT);
  try {
    const listed = await rpc(bot, "events/list", {});
    assert.equal(listed.nextCursor, undefined, "one page");
    assert.equal(listed.events.length, 1);
    const [event] = listed.events;
    assert.equal(event.name, "room.message");
    assert.deepEqual(event.delivery, ["webhook"]);
    assert.equal(typeof event.description, "string");
    assert.deepEqual(event.inputSchema.required, ["room_id"]);
    assert.equal(event.inputSchema.additionalProperties, false);
    assert.equal(event.inputSchema.properties.mentions_me.default, true);
    assert.deepEqual(event.payloadSchema.required, ["room_id", "message_id", "sender", "text_preview", "room_url"]);
    const again = await rpc(bot, "events/list", { cursor: "anything" });
    assert.deepEqual(again, listed);
  } finally {
    await bot.close();
  }
});

test("subscribe verifies the callback, stores a sealed subscription bound to the credential, renews idempotently and rotates the secret", { skip, timeout: 90_000 }, async () => {
  events!.forgetMcpEventVerificationsForTests();
  const { bot, roomId } = await setUpRoom("mcp-events-flow");
  const other = await connect(TOKEN_OTHER);
  try {
    const before = Date.now();
    const first = await rpc(bot, "events/subscribe", subscribeParams(roomId));
    assert.match(first.id, /^sub_[0-9a-f]{32}$/);
    closeTo(first.refreshBefore, before + 24 * HOUR);
    assert.equal(first.truncated, false);
    const latest = (await dbClient!.pool.query("SELECT COALESCE(max(number), 0)::int AS n FROM messages WHERE room_id = $1", [roomId])).rows[0].n;
    assert.equal(first.cursor, String(latest), "a new subscription starts at the room's current position");
    assert.deepEqual(Object.keys(first).sort(), ["cursor", "id", "refreshBefore", "truncated"]);

    // One verification POST, signed like an event, with the challenge echoed.
    assert.equal(verifications.length, 1);
    const verification = verifications[0]!;
    assert.match(String(verification.headers["webhook-id"]), /^msg_verification_[0-9a-f]+$/);
    assert.match(String(verification.headers["webhook-timestamp"]), /^\d{10}$/);
    assert.equal(verification.headers["x-mcp-subscription-id"], first.id);
    assert.equal(verification.headers["content-type"], "application/json");
    assert.equal(receiverVerifies(SECRET_A, verification), true);
    const challenge = JSON.parse(verification.body);
    assert.deepEqual(Object.keys(challenge).sort(), ["challenge", "type"]);
    assert.equal(challenge.type, "verification");
    assert.ok(challenge.challenge.length >= 32);

    // Stored as a wake rule of kind mcp_event, bound to the owner token's hash, target sealed.
    const stored = await ruleBySubscription(first.id);
    assert.equal(stored.delivery_kind, "mcp_event");
    assert.equal(stored.event, "room.message");
    assert.deepEqual(stored.arguments, { mentions_me: true });
    assert.deepEqual(stored.mcp_arguments, { room_id: roomId, mentions_me: true });
    assert.equal(stored.mcp_event_name, "room.message");
    assert.equal(stored.credential_kind, "token");
    assert.equal(stored.credential_ref, createHash("sha256").update(TOKEN_BOT).digest("hex"));
    assert.equal(stored.status, "active");
    assert.equal(new Date(stored.expires_at).toISOString(), first.refreshBefore);
    assert.equal(stored.agent_name, "relaybot", "\"me\" is the credential's registered worker");
    const row = JSON.stringify(stored);
    assert.equal(row.includes("127.0.0.1") || row.includes(SECRET_A.slice(6, 20)), false, "URL and secret are sealed");

    // The same identity again (arguments in another order, a new secret, a shorter ttl): the same id, no new rule, no new challenge.
    const renewed = await rpc(bot, "events/subscribe", {
      name: "room.message",
      arguments: { mentions_me: true, room_id: roomId },
      delivery: { secret: SECRET_B, url: hookUrl, mode: "webhook" },
      cursor: null,
      ttlMs: HOUR,
    });
    assert.equal(renewed.id, first.id);
    closeTo(renewed.refreshBefore, Date.now() + HOUR);
    assert.equal(renewed.truncated, false);
    assert.equal(verifications.length, 1, "a URL verified in the last 10 minutes is not challenged again");
    assert.equal((await ruleBySubscription(first.id)).id, stored.id);

    // A mention: one event, signed with the new secret and, inside the rotation window, the old one too.
    const asked = await humanSays(roomId, "@relaybot can you check the deploy?");
    let rows = await deliveries(stored.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "mcp_event");
    assert.equal(rows[0]!.state, "retry");
    assert.equal(rows[0]!.attempt_count, 0);
    assert.equal(rows[0]!.text_preview, "", "the outbox row holds no message text");
    assert.equal(await runWorker(), 1);
    assert.equal(received.length, 1);
    const event = received[0]!;
    assert.equal(event.headers["content-type"], "application/json");
    assert.equal(event.headers["x-mcp-subscription-id"], first.id);
    assert.match(String(event.headers["webhook-timestamp"]), /^\d{10}$/);
    assert.ok(Math.abs(Number(event.headers["webhook-timestamp"]) - Date.now() / 1000) < 60);
    assert.equal(String(event.headers["webhook-signature"]).split(" ").length, 2, "two signatures during the rotation window");
    assert.equal(receiverVerifies(SECRET_B, event), true);
    assert.equal(receiverVerifies(SECRET_A, event), true);
    const body = JSON.parse(event.body);
    assert.deepEqual(Object.keys(body), ["eventId", "name", "timestamp", "data", "cursor"]);
    assert.equal(event.headers["webhook-id"], body.eventId);
    assert.match(body.eventId, /^evt_[A-Za-z0-9_-]+$/);
    assert.equal(body.eventId.includes("."), false);
    assert.equal(body.name, "room.message");
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(body.cursor, String(numberOf(asked)));
    assert.deepEqual(Object.keys(body.data).sort(), ["message_id", "room_id", "room_url", "sender", "text_preview"]);
    assert.equal(body.data.room_id, roomId);
    assert.equal(body.data.message_id, asked.id);
    assert.equal(body.data.sender, "Ada");
    assert.equal(body.data.text_preview, "@relaybot can you check the deploy?");
    assert.match(body.data.room_url, new RegExp(`/in/${roomId}$`));
    rows = await deliveries(stored.id);
    assert.equal(rows[0]!.state, "delivered");
    assert.equal((await ruleRow(stored.id)).mcp_cursor, String(numberOf(asked)));

    // A thread reply for the bot names its thread.
    const reply = await api!.addMessage(roomId, "Ada", "@relaybot and in the thread", { source: "browser", account_id: accounts.human, thread_root_message_id: asked.id });
    assert.equal(await runWorker(), 1);
    const threaded = JSON.parse(received.at(-1)!.body);
    assert.equal(threaded.data.message_id, reply.id);
    assert.equal(threaded.data.thread_root_id, asked.id);

    // The bot's own message, even one that names it, delivers nothing.
    const workerSession = (await dbClient!.pool.query("SELECT created_by_session_id AS id FROM agent_wake_rules WHERE id = $1", [stored.id])).rows[0].id as string;
    const own = await call(bot, "send_message", { room_id: roomId, agent_session_id: workerSession, text: "@relaybot note to self" });
    assert.equal(own.isError, undefined, own.raw);
    assert.equal((await deliveries(stored.id)).length, 2);

    // The owner sees the subscription in list_wake_rules; others see the kind only; nobody sees the URL or secret.
    const mine = await call(bot, "list_wake_rules", { room_id: roomId });
    const ownView = (mine.active as Array<Record<string, any>>).find((entry) => entry.id === stored.id)!;
    assert.equal(ownView.delivery.kind, "mcp_event");
    assert.equal(ownView.delivery.subscription_id, first.id);
    assert.equal(ownView.delivery.event_name, "room.message");
    assert.equal(ownView.delivery.refresh_before, renewed.refreshBefore);
    assert.equal(ownView.delivery.cursor, String(numberOf(reply)));
    assert.equal(ownView.delivery.delivered_count, 2);
    assert.equal(mine.raw.includes("127.0.0.1") || mine.raw.includes(SECRET_A.slice(6, 20)) || mine.raw.includes(SECRET_B.slice(6, 20)), false);
    await call(other, "join_room", { name: "mcp-events-flow" });
    const seen = await call(other, "list_wake_rules", { room_id: roomId });
    const otherView = (seen.active as Array<Record<string, any>>).find((entry) => entry.id === stored.id)!;
    assert.deepEqual(otherView.delivery, { kind: "mcp_event", paused: false });

    // ttl bounds on renewal: never more than asked, at least 5 minutes, at most 7 days; null is a finite 7 days.
    closeTo((await rpc(bot, "events/subscribe", subscribeParams(roomId, { ttlMs: 1000 }))).refreshBefore, Date.now() + 5 * 60_000);
    closeTo((await rpc(bot, "events/subscribe", subscribeParams(roomId, { ttlMs: 30 * 24 * HOUR }))).refreshBefore, Date.now() + 7 * 24 * HOUR);
    closeTo((await rpc(bot, "events/subscribe", subscribeParams(roomId, { ttlMs: null }))).refreshBefore, Date.now() + 7 * 24 * HOUR);
    closeTo((await rpc(bot, "events/subscribe", subscribeParams(roomId, { ttlMs: undefined }))).refreshBefore, Date.now() + 24 * HOUR);

    // Unsubscribe ends it (idempotently); nothing more is queued.
    assert.deepEqual(await rpc(bot, "events/unsubscribe", { name: "room.message", arguments: { room_id: roomId }, delivery: { mode: "webhook", url: hookUrl } }), {});
    const ended = await ruleRow(stored.id);
    assert.equal(ended.status, "cancelled");
    assert.deepEqual(ended.cancelled_by, { kind: "agent", id: ended.agent_key, label: "relaybot" });
    assert.deepEqual(await rpc(bot, "events/unsubscribe", { name: "room.message", arguments: { room_id: roomId }, delivery: { mode: "webhook", url: hookUrl } }), {});
    assert.deepEqual(await rpc(bot, "events/unsubscribe", { name: "room.message", arguments: { room_id: roomId }, delivery: { mode: "webhook", url: "not a url" } }), {});
    await humanSays(roomId, "@relaybot anyone there?");
    assert.equal((await deliveries(stored.id)).length, 2, "a cancelled subscription queues nothing");
    // Subscribing again after an unsubscribe makes a new rule with the same id.
    const again = await rpc(bot, "events/subscribe", subscribeParams(roomId));
    assert.equal(again.id, first.id);
    assert.notEqual((await ruleBySubscription(first.id)).id, stored.id);
  } finally {
    await Promise.all([bot.close(), other.close()]);
  }
});

test("subscribe refuses what it must: unknown event, bad delivery, bad secret, a room it cannot read, no worker, private URLs, failed verification", { skip, timeout: 90_000 }, async () => {
  events!.forgetMcpEventVerificationsForTests();
  await drainOutbox();
  const { bot, roomId } = await setUpRoom("mcp-events-refusals");
  const lonely = await call(bot, "join_room", { name: "mcp-events-no-worker" });
  const verifiedBefore = verifications.length;
  try {
    const expect = async (params: Record<string, unknown>, code: number, pattern: RegExp, data?: Record<string, unknown>) => {
      const error = await rpcError(bot, "events/subscribe", params);
      assert.equal(error.code, code, `${error.code}: ${error.message}`);
      assert.match(error.message, pattern);
      if (data) assert.deepEqual(error.data, data);
      return error;
    };
    await expect(subscribeParams(roomId, { name: "room.reaction" }), -32602, /Unknown event/);
    await expect(subscribeParams(roomId, { delivery: { mode: "poll", url: hookUrl, secret: SECRET_A } }), -32602, /delivery\.mode/);
    await expect(subscribeParams(roomId, { delivery: { mode: "webhook", url: hookUrl, secret: "whsec_short" } }), -32602, /whsec_/);
    await expect(subscribeParams(roomId, { delivery: { mode: "webhook", url: hookUrl, secret: `whsec_${Buffer.alloc(23, 1).toString("base64")}` } }), -32602, /24 to 64 bytes/);
    await expect(subscribeParams(roomId, { delivery: { mode: "webhook", url: hookUrl } }), -32602, /secret/);
    await expect(subscribeParams(roomId, { arguments: { room_id: roomId, any: true, mentions_me: true } }), -32602, /not both/);
    await expect(subscribeParams(roomId, { ttlMs: "soon" }), -32602, /ttlMs/);
    await expect(subscribeParams(roomId, { cursor: 12 }), -32602, /cursor/);
    await expect(subscribeParams(roomId, {}, { worker_id: "wrk_nobody" }), -32602, /worker_id/);
    await expect(subscribeParams("github.com/nobody/has-this-room-" + randomBytes(4).toString("hex")), -32024, /cannot read this room/);
    await expect(subscribeParams(String(lonely.room_id)), -32602, /register_agent_session/);
    assert.equal(verifications.length, verifiedBefore, "nothing was challenged before validation passed");
    // any: true works without a worker.
    const anyone = await rpc(bot, "events/subscribe", subscribeParams(String(lonely.room_id), {}, { any: true }));
    assert.match(anyone.id, /^sub_/);
    assert.equal((await ruleBySubscription(anyone.id)).agent_key, `${accounts.bot}/mcp-events`);
    assert.equal(verifications.length, verifiedBefore + 1);
    // Private, loopback (without the test switch for the address class), this server's host, http: one answer.
    for (const url of ["https://10.0.0.8/hook", "https://169.254.169.254/latest", "https://[fd00::1]/hook", "https://letagents.chat/hooks/x", "ftp://hooks.example.com/x"]) {
      await expect(subscribeParams(roomId, { delivery: { mode: "webhook", url, secret: SECRET_A } }), -32602, /The URL is not allowed\. Use a public https URL on port 443\./);
    }
    assert.equal(verifications.length, verifiedBefore + 1, "a refused URL is never challenged");
    assert.equal((await dbClient!.pool.query("SELECT count(*)::int AS n FROM agent_wake_rules WHERE room_id = $1", [roomId])).rows[0].n, 0, "no rule was stored");

    // Verification failures: one error code, a categorized reason, and no rule.
    const failing = (path: string) => subscribeParams(roomId, { delivery: { mode: "webhook", url: hookUrl.replace("/hooks/chatgpt", path), secret: SECRET_A } });
    verifyMode = "mismatch";
    await expect(failing("/hooks/mismatch"), -32015, /challenge/, { reason: "challenge_failed" });
    verifyMode = "nonjson";
    await expect(failing("/hooks/nonjson"), -32015, /challenge/, { reason: "challenge_failed" });
    verifyMode = "500";
    await expect(failing("/hooks/500"), -32015, /did not accept/, { reason: "http_5xx" });
    verifyMode = "hang";
    events!.configureMcpEventsForTests({ verifyTimeoutMs: 400 });
    await expect(failing("/hooks/hang"), -32015, /did not accept/, { reason: "timeout" });
    events!.configureMcpEventsForTests(null);
    verifyMode = "echo";
    await expect(subscribeParams(roomId, { delivery: { mode: "webhook", url: "http://127.0.0.1:1/hooks/nobody", secret: SECRET_A } }), -32015, /did not accept/, { reason: "connection_refused" });
    assert.equal((await dbClient!.pool.query("SELECT count(*)::int AS n FROM agent_wake_rules WHERE room_id = $1", [roomId])).rows[0].n, 0, "a failed verification stores nothing");
    // A receiver that answers 4xx to the challenge (here: a path this API does not serve).
    await expect(subscribeParams(roomId, { delivery: { mode: "webhook", url: `${baseUrl}/no-such-path`, secret: SECRET_A } }), -32015, /did not accept/, { reason: "http_4xx" });
    // Verification requests one credential may cause are bounded; a verified URL costs none.
    events!.forgetMcpEventVerificationsForTests();
    events!.configureMcpEventsForTests({ verificationsPer10Min: 2 });
    verifyMode = "500";
    await expect(failing("/hooks/budget-1"), -32015, /did not accept/, { reason: "http_5xx" });
    await expect(failing("/hooks/budget-2"), -32015, /did not accept/, { reason: "http_5xx" });
    await expect(failing("/hooks/budget-3"), -32025, /verifications in 10 minutes/, { limit: "verifications" });
    verifyMode = "echo";
    events!.configureMcpEventsForTests(null);
    events!.forgetMcpEventVerificationsForTests();
  } finally {
    verifyMode = "echo";
    events!.configureMcpEventsForTests(null);
    await bot.close();
  }
});

test("delivery: 503 and 425 retry with the same eventId, 413 is final, 410 ends the subscription", { skip, timeout: 90_000 }, async () => {
  events!.forgetMcpEventVerificationsForTests();
  await drainOutbox();
  const { bot, roomId } = await setUpRoom("mcp-events-delivery");
  try {
    const subscribed = await rpc(bot, "events/subscribe", subscribeParams(roomId));
    const rule = await ruleBySubscription(subscribed.id);
    const sent = () => received.length;

    // 503: retry with the same eventId, a fresh timestamp and signature.
    replies.push(503);
    await humanSays(roomId, "@relaybot first");
    await makeDue();
    let before = sent();
    await runWorker();
    let rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "retry");
    assert.equal(rows.at(-1)!.last_status, 503);
    assert.equal(rows.at(-1)!.attempt_count, 1);
    await makeDue();
    await runWorker();
    rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "delivered");
    assert.equal(rows.at(-1)!.attempt_count, 2);
    assert.equal(received.length, before + 2);
    const [firstTry, secondTry] = received.slice(-2);
    assert.equal(firstTry!.headers["webhook-id"], secondTry!.headers["webhook-id"]);
    assert.equal(JSON.parse(firstTry!.body).eventId, JSON.parse(secondTry!.body).eventId);
    assert.equal((await ruleRow(rule.id)).delivery_consecutive_failures, 0);

    // 425 Too Early with Retry-After: held for that long, not counted.
    replies.push({ status: 425, headers: { "Retry-After": "120" } });
    await humanSays(roomId, "@relaybot second");
    await makeDue();
    await runWorker();
    rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "retry");
    assert.equal(rows.at(-1)!.last_status, 425);
    const due = (await dbClient!.pool.query("SELECT next_attempt_at FROM wake_webhook_deliveries WHERE id = $1", [rows.at(-1)!.id])).rows[0];
    const waitMs = Date.parse(due.next_attempt_at) - Date.now();
    assert.ok(waitMs > 100_000 && waitMs <= 120_000, `Retry-After honoured, got ${waitMs}`);
    assert.equal((await ruleRow(rule.id)).delivery_consecutive_failures, 0);
    assert.equal((await ruleRow(rule.id)).delivery_last_error, "http_throttled");
    await makeDue();
    await runWorker();
    assert.equal((await deliveries(rule.id)).at(-1)!.state, "delivered");

    // 413: final, counts toward the pause, the subscription stays.
    replies.push(413);
    await humanSays(roomId, "@relaybot third");
    await makeDue();
    before = sent();
    await runWorker();
    rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "dead");
    assert.equal(rows.at(-1)!.last_status, 413);
    assert.equal((await ruleRow(rule.id)).delivery_consecutive_failures, 1);
    assert.equal((await ruleRow(rule.id)).status, "active");
    await makeDue();
    await runWorker();
    assert.equal(received.length, before + 1, "no retry after 413");

    // 410 Gone: final, and the subscription ends now.
    replies.push(410);
    await humanSays(roomId, "@relaybot fourth");
    await makeDue();
    await runWorker();
    rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "dead");
    assert.equal(rows.at(-1)!.last_status, 410);
    const gone = await ruleRow(rule.id);
    assert.equal(gone.status, "retired");
    assert.match(gone.ended_reason, /410 Gone/);
    await humanSays(roomId, "@relaybot fifth");
    assert.equal((await deliveries(rule.id)).length, rows.length, "a retired subscription queues nothing");
    const listed = await call(bot, "list_wake_rules", { room_id: roomId });
    assert.ok((listed.recent as Array<Record<string, any>>).some((entry) => entry.id === rule.id && entry.status === "retired"));
  } finally {
    await bot.close();
  }
});

test("renewal with a cursor replays the events after it, in order, with the same ids; gaps and bounds report truncated", { skip, timeout: 120_000 }, async () => {
  events!.forgetMcpEventVerificationsForTests();
  await drainOutbox();
  const { bot, roomId } = await setUpRoom("mcp-events-replay", TOKEN_BOT, false);
  try {
    const subscribed = await rpc(bot, "events/subscribe", subscribeParams(roomId, {}, { any: true }));
    const rule = await ruleBySubscription(subscribed.id);
    const posted = [];
    for (const text of ["one", "two", "three"]) posted.push(await humanSays(roomId, text));
    assert.equal((await deliveries(rule.id)).length, 3, "every match is its own event; none is folded");
    await makeDue();
    // In order: the subscription's next event is claimed only once the one before it finished.
    assert.equal(await runWorker(), 1);
    assert.equal(await runWorker(), 1);
    assert.equal(await runWorker(), 1);
    const firstRound = received.slice(-3).map((entry) => JSON.parse(entry.body));
    assert.deepEqual(firstRound.map((body) => body.cursor), posted.map((message) => String(numberOf(message))));
    assert.equal((await ruleRow(rule.id)).mcp_cursor, String(numberOf(posted[2]!)));

    // Renew with the first event's cursor: the two after it go out again, same ids.
    const renewed = await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: String(numberOf(posted[0]!)) }, { any: true }));
    assert.equal(renewed.id, subscribed.id);
    assert.equal(renewed.cursor, String(numberOf(posted[0]!)), "the watermark stops before the first event that waits to go out again");
    assert.equal(renewed.truncated, false);
    let rows = await deliveries(rule.id);
    assert.deepEqual(rows.map((row) => row.state), ["delivered", "retry", "retry"]);
    assert.deepEqual(rows.slice(1).map((row) => row.attempt_count), [0, 0]);
    await makeDue();
    // One event of a subscription is in flight at a time, so a pass sends one and the next pass the next.
    assert.equal(await runWorker(), 1);
    assert.equal(await runWorker(), 1);
    assert.equal(await runWorker(), 0);
    const secondRound = received.slice(-2).map((entry) => JSON.parse(entry.body));
    assert.deepEqual(secondRound.map((body) => body.eventId), firstRound.slice(1).map((body) => body.eventId));
    assert.deepEqual(secondRound.map((body) => body.cursor), firstRound.slice(1).map((body) => body.cursor));

    // The same old cursor again inside the hour re-queues nothing; the answer is the watermark (delivered up to 3).
    const repeated = await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: String(numberOf(posted[0]!)) }, { any: true }));
    assert.equal(repeated.cursor, String(numberOf(posted[2]!)));
    assert.equal(repeated.truncated, false);
    assert.equal((await deliveries(rule.id)).every((row) => row.state === "delivered"), true, "one replay an hour");
    // A cursor at the newest event replays nothing either.
    await dbClient!.pool.query("UPDATE agent_wake_rules SET mcp_replayed_at = NULL WHERE id = $1", [rule.id]);
    const upToDate = await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: String(numberOf(posted[2]!)) }, { any: true }));
    assert.equal(upToDate.truncated, false);
    assert.equal(upToDate.cursor, String(numberOf(posted[2]!)));
    assert.equal((await deliveries(rule.id)).every((row) => row.state === "delivered"), true);
    // A cursor no message can have (past the integer range) is unknown: nothing to replay, truncated, and not an error.
    const huge = await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: "9999999999" }, { any: true }));
    assert.equal(huge.truncated, true);
    assert.equal(huge.cursor, String(numberOf(posted[2]!)));

    // More than 50 events after the cursor: the newest 50 go, truncated says the rest is gone; the re-queued
    // events spend the rule's hourly budget (20, three used), and the rest wait an hour, in order.
    await dbClient!.pool.query("UPDATE agent_wake_rules SET mcp_replayed_at = NULL WHERE id = $1", [rule.id]);
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR).toISOString();
    for (let number = 1000; number < 1060; number += 1) {
      await dbClient!.pool.query(`
        INSERT INTO wake_webhook_deliveries (id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, match_count, state, attempt_count,
          scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id, delivered_at)
        VALUES ($1, $2, $3, 'mcp_event', 'message', $4, '', '', 1, 'delivered', 1, $5, $5, $5, $5, $6, $5)
      `, [`whd_replay_${number}`, rule.id, roomId, number, twoHoursAgo, accounts.bot]);
    }
    const bounded = await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: String(numberOf(posted[2]!)) }, { any: true }));
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.cursor, String(numberOf(posted[2]!)), "the watermark stops before the first event that waits");
    const requeued = (await deliveries(rule.id)).filter((row) => row.state === "retry");
    assert.equal(requeued.length, 50);
    assert.equal(requeued[0]!.message_number, 1010, "the oldest ten are left out");
    assert.equal(requeued.filter((row) => !row.held_by_cap).length, 17, "the budget had 17 left");
    assert.equal(requeued.filter((row) => row.held_by_cap).length, 33);
    assert.equal(requeued.find((row) => row.held_by_cap)!.message_number, 1027, "the held ones are the newest");
    const heldAt = (await dbClient!.pool.query("SELECT min(next_attempt_at) AS at FROM wake_webhook_deliveries WHERE rule_id = $1 AND held_by_cap", [rule.id])).rows[0].at;
    assert.ok(Date.parse(heldAt) - Date.now() > 55 * 60_000, "held events wait for the hour");
    assert.equal((await ruleRow(rule.id)).delivery_over_cap_count, 33);
    // Those messages do not exist: the worker skips them, one pass each, without a POST.
    const before = received.length;
    await makeDue();
    for (let pass = 0; pass < 50; pass += 1) await runWorker();
    assert.equal(received.length, before);
    assert.equal((await deliveries(rule.id)).some((row) => row.state === "retry"), false);
    await dbClient!.pool.query("DELETE FROM wake_webhook_deliveries WHERE id LIKE 'whd_replay_%'");
    await dbClient!.pool.query("UPDATE agent_wake_rules SET mcp_replayed_at = NULL, delivery_over_cap_count = 0 WHERE id = $1", [rule.id]);

    // A gap: the subscription was paused (nothing matched meanwhile), so a renewal with a cursor is truncated.
    await dbClient!.pool.query("UPDATE agent_wake_rules SET status = 'paused', paused_at = now(), delivery_consecutive_failures = 5 WHERE id = $1", [rule.id]);
    await humanSays(roomId, "missed while paused");
    const afterGap = await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: String(numberOf(posted[2]!)) }, { any: true }));
    assert.equal(afterGap.id, subscribed.id);
    assert.equal(afterGap.truncated, true);
    const resumed = await ruleRow(rule.id);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.delivery_consecutive_failures, 0);
    // An unknown cursor is truncated too; a cursor for a brand-new subscription is truncated.
    assert.equal((await rpc(bot, "events/subscribe", subscribeParams(roomId, { cursor: "999999" }, { any: true }))).truncated, true);
    const fresh = await call(bot, "join_room", { name: "mcp-events-replay-fresh" });
    const freshLatest = (await dbClient!.pool.query("SELECT COALESCE(max(number), 0)::int AS n FROM messages WHERE room_id = $1", [fresh.room_id])).rows[0].n;
    const brandNew = await rpc(bot, "events/subscribe", subscribeParams(String(fresh.room_id), { cursor: "1" }, { any: true }));
    assert.equal(brandNew.truncated, true);
    assert.equal(brandNew.cursor, String(freshLatest), "a new subscription answers the room's newest message number");
    assert.equal((await ruleBySubscription(brandNew.id)).mcp_cursor, String(freshLatest));

    // Past the hourly budget the 21st event waits for the hour's end, in order, instead of being folded away.
    const budget = await ruleBySubscription(subscribed.id);
    await dbClient!.pool.query("DELETE FROM wake_webhook_deliveries WHERE rule_id = $1", [budget.id]);
    for (let index = 0; index < 21; index += 1) await humanSays(roomId, `burst ${index}`);
    const burst = await deliveries(budget.id);
    assert.equal(burst.length, 21);
    assert.equal(burst.filter((row) => row.held_by_cap).length, 1);
    assert.equal(burst.at(-1)!.held_by_cap, true);
    assert.equal((await ruleRow(budget.id)).delivery_over_cap_count, 1);
  } finally {
    await bot.close();
  }
});

test("a subscription never gets its own account's worker posts back, even with any and include_agents and no worker", { skip, timeout: 90_000 }, async () => {
  events!.forgetMcpEventVerificationsForTests();
  await drainOutbox();
  const { bot, roomId } = await setUpRoom("mcp-events-echo", TOKEN_BOT, false);
  const other = await connect(TOKEN_OTHER);
  try {
    const subscribed = await rpc(bot, "events/subscribe", subscribeParams(roomId, {}, { any: true, include_agents: true }));
    const rule = await ruleBySubscription(subscribed.id);
    assert.equal(rule.agent_key, `${accounts.bot}/mcp-events`, "no worker: a stand-in agent key");
    // Later the same credential registers a worker and posts: that is the subscriber talking, not an event for it.
    const worker = await call(bot, "register_agent_session", { room_id: roomId, display_name: "chatgpt-hands", runtime: "chatgpt" });
    const own = await call(bot, "send_message", { room_id: roomId, agent_session_id: worker.agent_session_id, text: "I am replying to the room" });
    assert.equal(own.isError, undefined, own.raw);
    assert.equal((await deliveries(rule.id)).length, 0, "an own-account worker post is not echoed back");
    // A person's message and another account's agent still are events.
    await humanSays(roomId, "hello from Ada");
    await call(other, "join_room", { name: "mcp-events-echo" });
    const otherWorker = await call(other, "register_agent_session", { room_id: roomId, display_name: "otherbot", runtime: "hosted-bot" });
    const theirs = await call(other, "send_message", { room_id: roomId, agent_session_id: otherWorker.agent_session_id, text: "hello from otherbot" });
    assert.equal(theirs.isError, undefined, theirs.raw);
    const rows = await deliveries(rule.id);
    assert.equal(rows.length, 2);
    await makeDue();
    assert.equal(await runWorker(), 1);
    assert.equal(await runWorker(), 1);
    // An agent's sender label carries its owner and app ("otherbot | <owner> | Agent").
    const senders = received.slice(-2).map((entry) => JSON.parse(entry.body).data.sender as string).sort();
    assert.equal(senders[0], "Ada");
    assert.match(senders[1]!, /^otherbot\b/);
  } finally {
    await Promise.all([bot.close(), other.close()]);
  }
});

test("revoking the credential retires the subscription; expiry stops delivery and the scheduler ends it", { skip, timeout: 90_000 }, async () => {
  events!.forgetMcpEventVerificationsForTests();
  const revocable = "mcp_events_owner_token_revocable";
  await ownerTokens!.createOwnerToken({ accountId: accounts.bot, githubUserId: "mcp-events-bot", token: revocable });
  await drainOutbox();
  const { bot, roomId } = await setUpRoom("mcp-events-revoke", revocable);
  const subscribed = await rpc(bot, "events/subscribe", subscribeParams(roomId));
  await bot.close();
  const rule = await ruleBySubscription(subscribed.id);
  await humanSays(roomId, "@relaybot before the revoke");
  assert.equal((await deliveries(rule.id)).length, 1);
  const tokenId = (await dbClient!.pool.query("SELECT token_id FROM owner_tokens WHERE token_hash = $1",
    [createHash("sha256").update(revocable).digest("hex")])).rows[0].token_id;
  await api!.deleteOwnerTokenById(tokenId);
  const retired = await ruleRow(rule.id);
  assert.equal(retired.status, "retired");
  assert.match(retired.ended_reason, /revoked/);
  assert.equal((await deliveries(rule.id))[0]!.state, "dead");
  const before = received.length;
  await makeDue();
  await runWorker();
  assert.equal(received.length, before, "nothing goes out for a revoked credential");
  await humanSays(roomId, "@relaybot after the revoke");
  assert.equal((await deliveries(rule.id)).length, 1);

  // Expiry: a waiting event is not sent once refreshBefore has passed, and the scheduler ends the rule.
  const { bot: second, roomId: secondRoom } = await setUpRoom("mcp-events-expiry");
  const expiring = await rpc(second, "events/subscribe", subscribeParams(secondRoom, { ttlMs: 5 * 60_000 }));
  await second.close();
  const expiringRule = await ruleBySubscription(expiring.id);
  await humanSays(secondRoom, "@relaybot last call");
  assert.equal((await deliveries(expiringRule.id)).length, 1);
  await dbClient!.pool.query("UPDATE agent_wake_rules SET expires_at = now() - interval '1 second', next_check_at = now() - interval '1 second' WHERE id = $1", [expiringRule.id]);
  const sent = received.length;
  await makeDue();
  await runWorker();
  assert.equal(received.length, sent, "nothing goes out past refreshBefore");
  assert.equal((await deliveries(expiringRule.id))[0]!.state, "dead");
  const now = new Date();
  await scheduler!.checkWakeRules(await store!.getDueWakeRules(now), now);
  assert.equal((await ruleRow(expiringRule.id)).status, "expired");
  await humanSays(secondRoom, "@relaybot too late");
  assert.equal((await deliveries(expiringRule.id)).length, 1);
  const next = await store!.getNextWakeRuleCheckAt();
  assert.ok(!next || Date.parse(next) > Date.now(), "nothing is left due");
});
