import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// A hosted bot registers a room.message webhook rule over /mcp (owner token,
// streamable HTTP), and a room message for it reaches a local receiver.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_CONNECTOR_SECRET_KEY = randomBytes(32).toString("hex");
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE = "1000";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed wake webhook tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const service = testDatabaseUrl ? await import("../wake-rules/service.js") : null;
const store = testDatabaseUrl ? await import("../db/wake-rules.js") : null;
const scheduler = testDatabaseUrl ? await import("../wake-rules/scheduler.js") : null;
const worker = testDatabaseUrl ? await import("../notifications/wake-webhooks.js") : null;
const guard = await import("../wake-rules/webhook-url.js");

const TOKEN_BOT = "wake_webhook_owner_token_bot";
const TOKEN_OTHER = "wake_webhook_owner_token_other";
const SECRET = "receiver-shared-secret-0123";
let server: Server | null = null;
let baseUrl = "";
const accounts: Record<"bot" | "other" | "human", string> = { bot: "", other: "", human: "" };

interface Received { headers: IncomingHttpHeaders; body: string }
const received: Received[] = [];
const replies: number[] = [];
let receiver: Server | null = null;
let hookUrl = "";

async function createOwner(suffix: string, token: string): Promise<string> {
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `wake-webhook-${suffix}`, login: `wake-webhook-${suffix}`, display_name: `Wake ${suffix}`,
  });
  await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: `wake-webhook-${suffix}`, token });
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
      provider: "github", provider_user_id: "wake-webhook-ada", login: "Ada", display_name: "Ada",
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
        received.push({ headers: request.headers, body });
        response.writeHead(replies.shift() ?? 200).end("ok");
      });
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/letagents`;
  });
  test.after(async () => {
    guard.allowLoopbackWakeWebhooksForTests(false);
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
  const client = new Client({ name: "Hosted bot", version: "1" });
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

/** Tool errors come back as `{ success: false, error }`. */
function failed(result: Record<string, any>): boolean {
  return result.isError === true || result.success === false;
}

async function deliveries(ruleId: string) {
  return (await dbClient!.pool.query<{ id: string; state: string; attempt_count: number; message_number: number; last_status: number | null }>(
    "SELECT id, state, attempt_count, message_number, last_status FROM wake_webhook_deliveries WHERE rule_id = $1 ORDER BY created_at, id",
    [ruleId],
  )).rows;
}

/** Make every waiting delivery due now, as if its coalescing window or backoff had passed. */
async function makeDue(): Promise<void> {
  await dbClient!.pool.query(
    "UPDATE wake_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE state IN ('queued', 'retry')",
  );
}

async function runWorker(overrides: Partial<import("../notifications/wake-webhooks.js").WakeWebhookDeliveryDeps> = {}): Promise<number> {
  return worker!.processWakeWebhookBatch("wake-webhook-test-worker", { ...worker!.defaultWakeWebhookDeps(), ...overrides });
}

/** The sealed columns of a rule, as stored. */
async function sealedOf(ruleId: string): Promise<{ delivery_target: unknown; delivery_bearer: unknown }> {
  return (await dbClient!.pool.query("SELECT delivery_target, delivery_bearer FROM agent_wake_rules WHERE id = $1", [ruleId])).rows[0];
}

async function ruleRow(ruleId: string) {
  return (await dbClient!.pool.query("SELECT * FROM agent_wake_rules WHERE id = $1", [ruleId])).rows[0];
}

async function humanSays(roomId: string, text: string) {
  return api!.addMessage(roomId, "Ada", text, { source: "browser", account_id: accounts.human });
}

async function setUpBot(roomName: string, token = TOKEN_BOT, bearer?: string) {
  const bot = await connect(token);
  const joined = await call(bot, "join_room", { name: roomName });
  assert.equal(joined.isError, undefined, joined.raw);
  const roomId = String(joined.room_id);
  const worker = await call(bot, "register_agent_session", { room_id: roomId, display_name: "relaybot", runtime: "hosted-bot" });
  assert.ok(worker.agent_session_id, worker.raw);
  const added = await call(bot, "add_wake_rule", {
    room_id: roomId,
    agent_session_id: worker.agent_session_id,
    event: "room.message",
    arguments: { mentions_me: true },
    webhook: { url: hookUrl, secret: SECRET, ...(bearer ? { bearer } : {}) },
    note: "start a turn when someone asks me",
  });
  assert.equal(added.isError, undefined, added.raw);
  assert.equal(added.created, true, added.raw);
  return { bot, roomId, sessionId: String(worker.agent_session_id), rule: added.rule as Record<string, any>, addedRaw: String(added.raw) };
}

test("a mention reaches the bot's webhook once, signed; 5xx retries, 4xx does not, its own message never does", { skip, timeout: 90_000 }, async () => {
  const { bot, roomId, sessionId, rule, addedRaw } = await setUpBot("wake-webhook-flow");
  const other = await connect(TOKEN_OTHER);
  try {
    // The answer names what the rule waits for, never where it delivers.
    assert.equal(rule.event, "room.message");
    // 30 days unless asked for less; adding it again renews it.
    assert.ok(Math.abs(Date.parse(rule.expires_at) - (Date.now() + 30 * 24 * 3600_000)) < 60_000);
    assert.equal(rule.delivery.kind, "webhook");
    assert.equal(addedRaw.includes(hookUrl) || addedRaw.includes(SECRET), false);
    const stored = (await dbClient!.pool.query("SELECT delivery_target::text AS target, identity_key, credential_kind, credential_ref FROM agent_wake_rules WHERE id = $1", [rule.id])).rows[0];
    // Bound to the credential that registered it: the owner token behind the /mcp session, by its hash.
    assert.equal(stored.credential_kind, "token");
    assert.equal(stored.credential_ref, createHash("sha256").update(TOKEN_BOT).digest("hex"));
    assert.equal(stored.target.includes("127.0.0.1") || stored.target.includes(SECRET), false, "the target is sealed");
    assert.equal(stored.identity_key.includes("127.0.0.1"), false, "only a keyed hash of the URL tells rules apart");

    // A person mentions the bot: one delivery, one signed POST.
    const asked = await humanSays(roomId, "@relaybot can you check the deploy?");
    assert.equal((await deliveries(rule.id)).length, 1);
    assert.equal(await runWorker(), 1);
    assert.equal(received.length, 1);
    const first = received[0]!;
    const timestamp = String(first.headers["x-letagents-timestamp"]);
    assert.match(timestamp, /^\d{10}$/);
    assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 60);
    assert.equal(first.headers["content-type"], "application/json");
    assert.equal(first.headers.authorization, undefined, "no Authorization header without a bearer");
    assert.equal(first.headers["x-letagents-signature"],
      `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${first.body}`).digest("hex")}`);
    const body = JSON.parse(first.body);
    assert.equal(first.headers["x-letagents-delivery"], body.delivery_id);
    assert.deepEqual(Object.keys(body).sort(), ["delivery_id", "message_id", "room_id", "room_url", "rule_id", "sender", "sent_at", "text_preview"]);
    assert.equal(body.room_id, roomId);
    assert.equal(body.message_id, asked.id);
    assert.equal(body.sender, "Ada");
    assert.equal(body.text_preview, "@relaybot can you check the deploy?");
    assert.equal(body.rule_id, rule.id);
    assert.match(body.room_url, new RegExp(`/in/${roomId}$`));
    assert.equal((await deliveries(rule.id))[0]!.state, "delivered");

    // A 5xx is retried with the same delivery id, so a receiver can drop the duplicate.
    replies.push(503);
    await humanSays(roomId, "@relaybot and the logs too");
    await makeDue();
    await runWorker();
    let rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "retry");
    assert.equal(rows.at(-1)!.last_status, 503);
    await makeDue();
    await runWorker();
    rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "delivered");
    assert.equal(rows.at(-1)!.attempt_count, 2);
    assert.equal(received.length, 3);
    assert.equal(received[1]!.headers["x-letagents-delivery"], received[2]!.headers["x-letagents-delivery"]);

    // A 4xx is final.
    replies.push(400);
    await humanSays(roomId, "@relaybot one more");
    await makeDue();
    await runWorker();
    rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "dead");
    assert.equal(rows.at(-1)!.last_status, 400);
    // Only an error class is kept, never the receiver's or the network's text.
    assert.equal((await ruleRow(rule.id)).delivery_last_error, "http_4xx");
    await makeDue();
    assert.equal(await runWorker(), 0);
    assert.equal(received.length, 4, "no retry after a 4xx");

    // The bot's own message, even one that names it, delivers nothing.
    const own = await call(bot, "send_message", { room_id: roomId, agent_session_id: sessionId, text: "@relaybot note to self: done" });
    assert.equal(own.isError, undefined, own.raw);
    assert.equal((await deliveries(rule.id)).length, rows.length);

    // People in the room see what the rule waits for, never the URL or secret.
    // The room is members-only: an admin let this person in first.
    await dbClient!.pool.query("INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'approved_request')",
      [roomId, accounts.other]);
    const otherJoined = await call(other, "join_room", { name: "wake-webhook-flow" });
    assert.equal(otherJoined.room_id, roomId);
    const seen = await call(other, "list_wake_rules", { room_id: roomId });
    assert.equal(seen.isError, undefined, seen.raw);
    assert.equal(seen.raw.includes("127.0.0.1") || seen.raw.includes(SECRET), false);
    const listed = (seen.active as Array<Record<string, any>>).find((entry) => entry.id === rule.id)!;
    assert.deepEqual(listed.delivery, { kind: "webhook", paused: false });
    const mine = await call(bot, "list_wake_rules", { room_id: roomId });
    const own_view = (mine.active as Array<Record<string, any>>).find((entry) => entry.id === rule.id)!;
    assert.equal(own_view.delivery.delivered_count, 2);
    assert.equal(own_view.delivery.consecutive_failures, 1);
    assert.equal(mine.raw.includes("127.0.0.1") || mine.raw.includes(SECRET), false);

    // Another account cannot cancel it: neither its agent nor its person.
    const otherWorker = await call(other, "register_agent_session", { room_id: roomId, display_name: "otherbot", runtime: "hosted-bot" });
    const refused = await call(other, "cancel_wake_rule", { room_id: roomId, agent_session_id: otherWorker.agent_session_id, rule_id: rule.id });
    assert.equal(failed(refused), true, refused.raw);
    assert.match(refused.raw, /only your own wake rules/);
    await assert.rejects(
      service!.cancelWakeRuleAs(roomId, rule.id, { kind: "human", id: accounts.other, label: "wake-webhook-other" }),
      /Only the account that owns this agent/,
    );
    // The bot can.
    const cancelled = await call(bot, "cancel_wake_rule", { room_id: roomId, agent_session_id: sessionId, rule_id: rule.id });
    assert.equal(cancelled.isError, undefined, cancelled.raw);
    assert.equal(cancelled.rule.status, "cancelled");
    await humanSays(roomId, "@relaybot are you there?");
    assert.equal((await deliveries(rule.id)).length, rows.length, "a cancelled rule queues nothing");
  } finally {
    await Promise.all([bot.close(), other.close()]);
  }
});

test("five final failures in a row pause the rule; adding it again resumes it", { skip, timeout: 90_000 }, async () => {
  const { bot, roomId, sessionId, rule } = await setUpBot("wake-webhook-pause");
  try {
    const before = received.length;
    for (let index = 0; index < 5; index += 1) {
      replies.push(410);
      await humanSays(roomId, `@relaybot try ${index}`);
      await makeDue();
      await runWorker();
    }
    assert.equal(received.length, before + 5);
    const listed = await call(bot, "list_wake_rules", { room_id: roomId });
    const paused = (listed.active as Array<Record<string, any>>).find((entry) => entry.id === rule.id)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.delivery.paused, true);
    assert.equal(paused.delivery.consecutive_failures, 5);

    // A paused rule queues nothing.
    await humanSays(roomId, "@relaybot hello?");
    await makeDue();
    assert.equal(await runWorker(), 0);
    assert.equal(received.length, before + 5);

    // The same rule again (its receiver fixed) resumes it.
    const again = await call(bot, "add_wake_rule", {
      room_id: roomId, agent_session_id: sessionId, event: "room.message", webhook: { url: hookUrl, secret: SECRET },
    });
    assert.equal(again.isError, undefined, again.raw);
    assert.equal(again.created, false);
    assert.equal(again.rule.id, rule.id);
    assert.equal(again.rule.status, "active");
    assert.equal(again.rule.delivery.consecutive_failures, 0);
    await humanSays(roomId, "@relaybot back?");
    await makeDue();
    assert.equal(await runWorker(), 1);
    assert.equal(received.length, before + 6);
  } finally {
    await bot.close();
  }
});

test("a webhook URL on a private address is refused when the rule is added", { skip, timeout: 60_000 }, async () => {
  const bot = await connect(TOKEN_BOT);
  try {
    const joined = await call(bot, "join_room", { name: "wake-webhook-refused" });
    const worker = await call(bot, "register_agent_session", { room_id: joined.room_id, display_name: "refusedbot", runtime: "hosted-bot" });
    for (const url of ["https://10.0.0.8/hook", "https://169.254.169.254/latest", "https://[fd00::1]/hook", "https://letagents.chat/webhooks/x"]) {
      const refused = await call(bot, "add_wake_rule", {
        room_id: joined.room_id, agent_session_id: worker.agent_session_id, event: "room.message", webhook: { url, secret: SECRET },
      });
      assert.equal(failed(refused), true, url);
      // One answer for every refusal: nothing about how the host resolved.
      assert.match(refused.raw, /The URL is not allowed\. Use a public https URL on port 443\./, url);
    }
    const missing = await call(bot, "add_wake_rule", { room_id: joined.room_id, agent_session_id: worker.agent_session_id, event: "room.message" });
    assert.equal(failed(missing), true);
    assert.match(missing.raw, /add webhook/);
    guard.allowLoopbackWakeWebhooksForTests(false);
    const otherPort = await call(bot, "add_wake_rule", {
      room_id: joined.room_id, agent_session_id: worker.agent_session_id, event: "room.message",
      webhook: { url: "https://hooks.example.com:8443/hook", secret: SECRET },
    });
    guard.allowLoopbackWakeWebhooksForTests({});
    assert.match(otherPort.raw, /The URL is not allowed/);
  } finally {
    await bot.close();
  }
});

test("a 429 waits for its Retry-After and does not count; access denied at delivery time counts", { skip, timeout: 90_000 }, async () => {
  const { bot, roomId, rule } = await setUpBot("wake-webhook-throttle");
  try {
    replies.push(429);
    await humanSays(roomId, "@relaybot are you busy?");
    await makeDue();
    const before = received.length;
    await runWorker();
    assert.equal(received.length, before + 1);
    let [row] = await deliveries(rule.id);
    assert.equal(row!.state, "retry");
    assert.equal(row!.last_status, 429);
    const due = (await dbClient!.pool.query("SELECT next_attempt_at FROM wake_webhook_deliveries WHERE rule_id = $1", [rule.id])).rows[0];
    const waitMs = Date.parse(due.next_attempt_at) - Date.now();
    assert.ok(waitMs > 4 * 60_000 && waitMs <= 5 * 60_000, `no Retry-After: wait the 5-minute bound, got ${waitMs}`);
    assert.equal((await ruleRow(rule.id)).delivery_consecutive_failures, 0);
    assert.equal((await ruleRow(rule.id)).delivery_last_error, "http_throttled");
    await makeDue();
    await runWorker();
    [row] = await deliveries(rule.id);
    assert.equal(row!.state, "delivered");

    // The agent's account loses access to the room: nothing is sent, and it counts.
    await humanSays(roomId, "@relaybot still there?");
    await makeDue();
    const sent = received.length;
    await runWorker({ authorize: async () => "deny" });
    assert.equal(received.length, sent, "no POST without room access");
    const rows = await deliveries(rule.id);
    assert.equal(rows.at(-1)!.state, "dead");
    assert.equal((await ruleRow(rule.id)).delivery_last_error, "access_denied");
    assert.equal((await ruleRow(rule.id)).delivery_consecutive_failures, 1);
  } finally {
    await bot.close();
  }
});

test("revoking the credential that registered a rule ends it: token deleted, token gone, worker session ended", { skip, timeout: 90_000 }, async () => {
  // A token deleted through the account's revoke path retires its rules at once.
  const revocable = "wake_webhook_owner_token_revocable";
  const accountId = await createOwner("revocable", revocable);
  const first = await setUpBot("wake-webhook-revoke", revocable, "crsr_revocable_sender_key_01");
  await first.bot.close();
  assert.ok((await sealedOf(first.rule.id)).delivery_bearer);
  const tokenId = (await dbClient!.pool.query("SELECT token_id FROM owner_tokens WHERE token_hash = $1",
    [createHash("sha256").update(revocable).digest("hex")])).rows[0].token_id;
  await api!.deleteOwnerTokenById(tokenId);
  const retired = await ruleRow(first.rule.id);
  assert.equal(retired.status, "retired");
  assert.match(retired.ended_reason, /revoked/);
  // Retired for good: the sealed URL, secret and key are gone from the row.
  assert.deepEqual(await sealedOf(first.rule.id), { delivery_target: null, delivery_bearer: null });
  await humanSays(first.roomId, "@relaybot hello?");
  assert.equal((await deliveries(first.rule.id)).length, 0);

  // A credential that vanished another way is caught at the next attempt.
  const vanishing = "wake_webhook_owner_token_vanishing";
  await ownerTokens!.createOwnerToken({ accountId, githubUserId: "wake-webhook-revocable", token: vanishing });
  const second = await setUpBot("wake-webhook-vanish", vanishing);
  await second.bot.close();
  await humanSays(second.roomId, "@relaybot hello?");
  assert.equal((await deliveries(second.rule.id)).length, 1);
  await dbClient!.pool.query("DELETE FROM owner_tokens WHERE token_hash = $1", [createHash("sha256").update(vanishing).digest("hex")]);
  const before = received.length;
  await makeDue();
  await runWorker();
  assert.equal(received.length, before, "nothing is sent for a revoked credential");
  assert.equal((await deliveries(second.rule.id))[0]!.state, "dead");
  assert.equal((await ruleRow(second.rule.id)).status, "retired");
  assert.deepEqual(await sealedOf(second.rule.id), { delivery_target: null, delivery_bearer: null });

  // A rule registered with a worker session's bearer ends when the session does.
  const room = await api!.createProjectWithName("wake-webhook-session");
  const session = await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "hosted-bot", actor_label: "sessionbot",
    agent_key: `${accountId}/sessionbot`, display_name: "sessionbot",
    owner_account_id: accountId, owner_label: "wake-webhook-revocable", ide_label: "Agent",
  });
  const { rule } = await service!.addWakeRuleForAgent({
    roomId: room.id,
    agent: { agent_key: session.agent_key, agent_name: "sessionbot", session_id: session.session_id, owner_account_id: accountId },
    body: { event: "room.message", webhook: { url: hookUrl, secret: SECRET } },
    credential: { kind: "agent_session", ref: session.session_id },
  });
  assert.equal((await ruleRow(rule.id)).status, "active");
  await api!.endRoomAgentSession({ session_id: session.session_id });
  assert.equal((await ruleRow(rule.id)).status, "retired");
  await assert.rejects(service!.addWakeRuleForAgent({
    roomId: room.id,
    agent: { agent_key: session.agent_key, agent_name: "sessionbot", session_id: session.session_id, owner_account_id: accountId },
    body: { event: "room.message", webhook: { url: hookUrl, secret: SECRET } },
  }), /needs an agent that signed in/, "a delivery rule always has a credential");
});

test("the scheduler ends a delivery rule at its expiry, paused or not, and never leaves one due", { skip, timeout: 60_000 }, async () => {
  const { bot, rule, roomId } = await setUpBot("wake-webhook-expiry", TOKEN_BOT, "crsr_expiring_sender_key_01");
  // Paused, with a past check time: the rule is ended, not left due.
  await dbClient!.pool.query(
    "UPDATE agent_wake_rules SET status = 'paused', expires_at = now() - interval '1 minute', next_check_at = now() - interval '1 minute' WHERE id = $1",
    [rule.id]);
  const now = new Date();
  await scheduler!.checkWakeRules(await store!.getDueWakeRules(now), now);
  const ended = await ruleRow(rule.id);
  assert.equal(ended.status, "expired");
  assert.deepEqual(await sealedOf(rule.id), { delivery_target: null, delivery_bearer: null }, "expired for good: nothing sealed is kept");
  const listedAfter = await call(bot, "list_wake_rules", { room_id: roomId });
  const recentView = (listedAfter.recent as Array<Record<string, any>>).find((entry) => entry.id === rule.id)!;
  assert.equal(recentView.delivery.kind, "webhook", "an ended rule still shows as a webhook rule");
  assert.equal(recentView.delivery.has_bearer, false);
  await bot.close();
  // Another one is due early (a skewed clock): it is moved to its expiry, not left due.
  const other = await setUpBot("wake-webhook-rearm");
  await other.bot.close();
  await dbClient!.pool.query("UPDATE agent_wake_rules SET next_check_at = now() - interval '1 minute' WHERE id = $1", [other.rule.id]);
  const later = new Date();
  await scheduler!.checkWakeRules(await store!.getDueWakeRules(later), later);
  const rearmed = await ruleRow(other.rule.id);
  assert.equal(rearmed.status, "active");
  assert.equal(Date.parse(rearmed.next_check_at), Date.parse(rearmed.expires_at));
  const next = await store!.getNextWakeRuleCheckAt();
  assert.ok(!next || Date.parse(next) > Date.now(), "nothing is left due");
});

test("a rule's bearer is sealed, never shown, sent on every attempt, and replaced when the rule is added again", { skip, timeout: 90_000 }, async () => {
  const BEARER = "crsr_test_sender_key_0123456789";
  const { bot, roomId, sessionId, rule, addedRaw } = await setUpBot("wake-webhook-bearer", TOKEN_BOT, BEARER);
  const other = await connect(TOKEN_OTHER);
  try {
    assert.equal(addedRaw.includes(BEARER), false, "the add answer does not echo it");
    const stored = (await dbClient!.pool.query(
      "SELECT delivery_bearer::text AS bearer, delivery_target::text AS target, identity_key FROM agent_wake_rules WHERE id = $1", [rule.id])).rows[0];
    assert.ok(stored.bearer, "a sealed bearer is stored");
    assert.equal(stored.bearer.includes(BEARER) || stored.target.includes(BEARER) || stored.identity_key.includes(BEARER), false, "sealed at rest");
    // Not in any read: the owner's list, another account's list, or the REST route behind them.
    const ownList = await call(bot, "list_wake_rules", { room_id: roomId });
    assert.equal(ownList.raw.includes(BEARER), false);
    const ownView = (ownList.active as Array<Record<string, any>>).find((entry) => entry.id === rule.id)!;
    assert.equal(ownView.delivery.has_bearer, true, "the owner sees that a key is stored, never the key");
    // The room is members-only: an admin let this person in first.
    await dbClient!.pool.query("INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'approved_request')",
      [roomId, accounts.other]);
    await call(other, "join_room", { name: "wake-webhook-bearer" });
    const otherList = await call(other, "list_wake_rules", { room_id: roomId });
    assert.equal(otherList.raw.includes(BEARER), false);
    const otherView = (otherList.active as Array<Record<string, any>>).find((entry) => entry.id === rule.id)!;
    assert.deepEqual(otherView.delivery, { kind: "webhook", paused: false }, "another account does not see has_bearer");

    // Sent on the first attempt and on the retry, alongside the signature.
    replies.push(503);
    await humanSays(roomId, "@relaybot please start");
    const before = received.length;
    await makeDue();
    await runWorker();
    await makeDue();
    await runWorker();
    const attempts = received.slice(before);
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.equal(attempt.headers.authorization, `Bearer ${BEARER}`);
      assert.match(String(attempt.headers["x-letagents-signature"]), /^sha256=[0-9a-f]{64}$/);
    }
    assert.equal(attempts[0]!.headers["x-letagents-delivery"], attempts[1]!.headers["x-letagents-delivery"], "the same delivery, retried");

    // Adding the rule again with another key replaces it; without one, it is removed.
    const NEXT = "crsr_rotated_sender_key_9876543210";
    const again = await call(bot, "add_wake_rule", {
      room_id: roomId, agent_session_id: sessionId, event: "room.message",
      webhook: { url: hookUrl, secret: SECRET, bearer: NEXT },
    });
    assert.equal(again.created, false, again.raw);
    assert.equal(again.rule.id, rule.id);
    await humanSays(roomId, "@relaybot with the new key");
    await makeDue();
    await runWorker();
    assert.equal(received.at(-1)!.headers.authorization, `Bearer ${NEXT}`);
    const cleared = await call(bot, "add_wake_rule", {
      room_id: roomId, agent_session_id: sessionId, event: "room.message", webhook: { url: hookUrl, secret: SECRET },
    });
    assert.equal(cleared.rule.id, rule.id);
    assert.equal((await dbClient!.pool.query("SELECT delivery_bearer FROM agent_wake_rules WHERE id = $1", [rule.id])).rows[0].delivery_bearer, null);
    const afterClear = (await call(bot, "list_wake_rules", { room_id: roomId })).active as Array<Record<string, any>>;
    assert.equal(afterClear.find((entry) => entry.id === rule.id)!.delivery.has_bearer, false);
    await humanSays(roomId, "@relaybot no key now");
    await makeDue();
    await runWorker();
    assert.equal(received.at(-1)!.headers.authorization, undefined);

    // A malformed key is refused at add time with no rule change.
    const refused = await call(bot, "add_wake_rule", {
      room_id: roomId, agent_session_id: sessionId, event: "room.message",
      webhook: { url: hookUrl, secret: SECRET, bearer: "bad key\r\nX-Evil: 1" },
    });
    assert.equal(failed(refused), true, refused.raw);
    assert.match(refused.raw, /webhook.bearer must be 8 to 512 printable ASCII characters/);

    // A cancel keeps the sealed target and key, so the 10-minute undo can bring the rule back.
    await call(bot, "add_wake_rule", {
      room_id: roomId, agent_session_id: sessionId, event: "room.message", webhook: { url: hookUrl, secret: SECRET, bearer: BEARER },
    });
    const cancelled = await call(bot, "cancel_wake_rule", { room_id: roomId, agent_session_id: sessionId, rule_id: rule.id });
    assert.equal(cancelled.rule.status, "cancelled", cancelled.raw);
    const kept = await sealedOf(rule.id);
    assert.ok(kept.delivery_target && kept.delivery_bearer, "kept after cancel");
  } finally {
    await Promise.all([bot.close(), other.close()]);
  }
});
