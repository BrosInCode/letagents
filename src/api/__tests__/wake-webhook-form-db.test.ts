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

// A person adds, tests and cancels a webhook wake rule for one of their own
// agents from the app (an app session), without handing the URL and key to
// the bot. The rule is bound to the sign-in behind the agent.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_CONNECTOR_SECRET_KEY = randomBytes(32).toString("hex");
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE = "1000";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "1";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed wake webhook form tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const service = testDatabaseUrl ? await import("../wake-rules/service.js") : null;
const worker = testDatabaseUrl ? await import("../notifications/wake-webhooks.js") : null;
const guard = await import("../wake-rules/webhook-url.js");

const TOKEN_ADA = "wake_form_owner_token_ada";
const COOKIE = { ada: "letagents_session=wake-form-cookie-ada", bob: "letagents_session=wake-form-cookie-bob", cy: "letagents_session=wake-form-cookie-cy" };
const SECRET = "form-made-secret-0123456789abcdef";
const KEY = "crsr_form_sender_key_0001";
let server: Server | null = null;
let baseUrl = "";
const accounts: Record<"ada" | "bob" | "cy", string> = { ada: "", bob: "", cy: "" };

interface Received { headers: IncomingHttpHeaders; body: string }
const received: Received[] = [];
const replies: number[] = [];
let receiver: Server | null = null;
let hookUrl = "";
let roomId = "";
let adaBot: { session_id: string; agent_key: string; worker_bearer: string | null } = { session_id: "", agent_key: "", worker_bearer: null };
let bobBot: { session_id: string; agent_key: string } = { session_id: "", agent_key: "" };
let adaRemote: { session_id: string; agent_key: string; client: Client | null } = { session_id: "", agent_key: "", client: null };

async function createPerson(login: "ada" | "bob" | "cy"): Promise<string> {
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `wake-form-${login}`, login, display_name: login.toUpperCase(),
  });
  const expires = new Date(Date.now() + 60 * 60_000).toISOString();
  await accountSessions!.createSession(account.id, COOKIE[login].split("=")[1]!, expires, null);
  return account.id;
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

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    for (const login of ["ada", "bob", "cy"] as const) accounts[login] = await createPerson(login);
    await ownerTokens!.createOwnerToken({ accountId: accounts.ada, githubUserId: "wake-form-ada", token: TOKEN_ADA });
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

    // The room: ada's hosted bot makes it over the remote MCP connector (her owner token);
    // cy is made a room admin, bob a member.
    const client = await connect(TOKEN_ADA);
    const joined = await call(client, "join_room", { name: "wake-form" });
    assert.equal(joined.isError, undefined, joined.raw);
    roomId = String(joined.room_id);
    await dbClient!.pool.query("INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING", [roomId, accounts.cy]);
    for (const accountId of [accounts.ada, accounts.bob, accounts.cy]) {
      await members!.addRoomMember({ roomId, accountId, addedVia: "approved_request", addedBy: accounts.cy });
    }
    // ada's agent, with a worker bearer; bob's agent.
    const ada = await api!.createRoomAgentSession({
      room_id: roomId, session_kind: "worker", runtime: "hosted-bot", actor_label: "adabot",
      agent_key: `${accounts.ada}/adabot`, display_name: "adabot",
      owner_account_id: accounts.ada, owner_label: "ada", ide_label: "Agent",
    });
    adaBot = { session_id: ada.session_id, agent_key: ada.agent_key, worker_bearer: ada.worker_bearer ?? null };
    const bob = await api!.createRoomAgentSession({
      room_id: roomId, session_kind: "worker", runtime: "hosted-bot", actor_label: "bobbot",
      agent_key: `${accounts.bob}/bobbot`, display_name: "bobbot",
      owner_account_id: accounts.bob, owner_label: "bob", ide_label: "Agent",
    });
    bobBot = { session_id: bob.session_id, agent_key: bob.agent_key };
    // ada's hosted bot's worker, registered over the remote MCP connector.
    const worker = await call(client, "register_agent_session", { room_id: roomId, display_name: "remotebot", runtime: "hosted-bot" });
    assert.ok(worker.agent_session_id, worker.raw);
    const [row] = (await dbClient!.pool.query("SELECT agent_key FROM room_agent_sessions WHERE session_id = $1", [String(worker.agent_session_id)])).rows;
    adaRemote = { session_id: String(worker.agent_session_id), agent_key: String(row.agent_key), client };
  });
  test.after(async () => {
    guard.allowLoopbackWakeWebhooksForTests(false);
    await adaRemote.client?.close().catch(() => undefined);
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    receiver?.closeAllConnections();
    await new Promise<void>((done) => receiver ? receiver.close(() => done()) : done());
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    await dbClient!.pool.end();
  });
}

function rulesPath(suffix = ""): string {
  return `${baseUrl}/rooms/${encodeURIComponent(roomId)}/wake-rules${suffix}`;
}

/** A request as the app sends it: the session cookie and this app's own origin. */
async function send(method: "GET" | "POST", suffix: string, options: { cookie?: string; bearer?: string; origin?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  if (options.origin !== null && method === "POST") headers.Origin = options.origin ?? baseUrl;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(rulesPath(suffix), { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text };
}

function form(agentKey: string, overrides: Record<string, unknown> = {}) {
  return { agent_key: agentKey, rule: { event: "room.message", webhook: { url: hookUrl, secret: SECRET, bearer: KEY }, note: "wake my routine", ...overrides } };
}

async function ruleRow(ruleId: string) {
  return (await dbClient!.pool.query("SELECT * FROM agent_wake_rules WHERE id = $1", [ruleId])).rows[0];
}

async function testRows(ruleId: string) {
  return (await dbClient!.pool.query("SELECT id, state, last_status, last_error, purpose FROM wake_webhook_deliveries WHERE rule_id = $1 AND purpose = 'test' ORDER BY created_at, id", [ruleId])).rows;
}

test("my-agents lists only the caller's own agents in the room, and only for a person", { skip, timeout: 60_000 }, async () => {
  const ada = await send("GET", "/my-agents", { cookie: COOKIE.ada });
  assert.equal(ada.status, 200, ada.text);
  assert.deepEqual(ada.json.agents.map((agent: any) => agent.agent_key).sort(), [adaBot.agent_key, adaRemote.agent_key].sort());
  const mine = ada.json.agents.find((agent: any) => agent.agent_key === adaBot.agent_key);
  assert.deepEqual(Object.keys(mine).sort(), ["agent_key", "agent_name", "last_seen_at", "live"]);
  assert.equal(mine.agent_name, "adabot");
  assert.equal(mine.live, true);
  const bob = await send("GET", "/my-agents", { cookie: COOKIE.bob });
  assert.deepEqual(bob.json.agents.map((agent: any) => agent.agent_key), [bobBot.agent_key]);
  const cy = await send("GET", "/my-agents", { cookie: COOKIE.cy });
  assert.deepEqual(cy.json.agents, [], "a room admin without agents has none to pick");
  assert.equal((await send("GET", "/my-agents", { bearer: TOKEN_ADA })).status, 403, "an owner token is not a person");
  assert.ok(adaBot.worker_bearer, "the worker session has a bearer");
  assert.equal((await send("GET", "/my-agents", { bearer: adaBot.worker_bearer! })).status, 403, "a worker bearer is not a person");
});

test("a person adds a webhook rule for their own agent; it is bound to the sign-in behind the agent", { skip, timeout: 60_000 }, async () => {
  // A worker with a live session and no remote sign-in: bound to its session, like a rule added with its bearer.
  const added = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key) });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.created, true);
  const rule = added.json.rule;
  assert.equal(rule.agent_key, adaBot.agent_key);
  assert.equal(rule.agent_name, "adabot");
  assert.equal(rule.event, "room.message");
  assert.deepEqual(rule.arguments, { mentions_me: true });
  assert.equal(rule.note, "wake my routine");
  assert.equal(rule.status, "active");
  assert.equal(rule.delivery.kind, "webhook");
  assert.equal(rule.delivery.has_bearer, true);
  assert.equal(rule.delivery.delivered_count, 0);
  assert.equal(added.text.includes(hookUrl) || added.text.includes(SECRET) || added.text.includes(KEY), false, "the target is never returned");
  const row = await ruleRow(rule.id);
  assert.equal(row.owner_account_id, accounts.ada);
  assert.equal(row.credential_kind, "agent_session");
  assert.equal(row.credential_ref, adaBot.session_id);
  assert.equal(row.created_by_session_id, adaBot.session_id);

  // The same rule again renews it instead of making a second one.
  const again = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key) });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.created, false);
  assert.equal(again.json.rule.id, rule.id);

  // A worker registered over the remote MCP connector: bound to the owner token behind that session, by its hash.
  const remote = await send("POST", "", { cookie: COOKIE.ada, body: form(adaRemote.agent_key) });
  assert.equal(remote.status, 201, remote.text);
  const remoteRow = await ruleRow(remote.json.rule.id);
  assert.equal(remoteRow.credential_kind, "token");
  assert.equal(remoteRow.credential_ref, createHash("sha256").update(TOKEN_ADA).digest("hex"));

  // A remote MCP session row whose token is gone (revoked, not yet swept) is skipped for a live one;
  // with no live remote sign-in left, the rule falls back to the worker's live session.
  const deadHash = createHash("sha256").update("wake_form_revoked_token").digest("hex");
  const fakeRow = async (sessionId: string, workerSessionId: string) => dbClient!.pool.query(`
    INSERT INTO remote_mcp_sessions (session_id, account_id, token_hash, agent_instance_id, client_name, worker_session_id, state, version, created_at, last_seen_at, implicit)
    VALUES ($1, $2, $3, $4, 'Stale app', $5, '{}'::jsonb, 1, now(), now() + interval '1 minute', false)
  `, [sessionId, accounts.ada, deadHash, `instance_${sessionId}`, workerSessionId]);
  await fakeRow("rms_dead_remote", adaRemote.session_id);
  await fakeRow("rms_dead_bot", adaBot.session_id);
  try {
    const renewed = await send("POST", "", { cookie: COOKIE.ada, body: form(adaRemote.agent_key) });
    assert.equal(renewed.status, 200, renewed.text);
    assert.equal((await ruleRow(renewed.json.rule.id)).credential_ref, createHash("sha256").update(TOKEN_ADA).digest("hex"), "the newest row's dead token is skipped for the live one");
    const fallback = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key) });
    assert.equal(fallback.status, 200, fallback.text);
    const fallbackRow = await ruleRow(fallback.json.rule.id);
    assert.deepEqual([fallbackRow.credential_kind, fallbackRow.credential_ref], ["agent_session", adaBot.session_id], "no live remote sign-in: the live worker session");
  } finally {
    await dbClient!.pool.query("DELETE FROM remote_mcp_sessions WHERE token_hash = $1", [deadHash]);
  }

  // The agent's own list shows the rule with its delivery details to its owner only.
  const mine = await send("GET", "", { cookie: COOKIE.ada });
  const seen = mine.json.active.find((candidate: any) => candidate.id === rule.id);
  assert.equal(seen.delivery.has_bearer, true);
  const theirs = await send("GET", "", { cookie: COOKIE.bob });
  const seenByBob = theirs.json.active.find((candidate: any) => candidate.id === rule.id);
  assert.deepEqual(seenByBob.delivery, { kind: "webhook", paused: false });
});

test("the authorization matrix: another account, an owner token, a worker bearer and a cross-site cookie are refused; an admin may cancel but not add or restore", { skip, timeout: 60_000 }, async () => {
  const other = await send("POST", "", { cookie: COOKIE.bob, body: form(adaBot.agent_key) });
  assert.equal(other.status, 403, other.text);
  assert.match(other.json.error, /belongs to your account/);
  const admin = await send("POST", "", { cookie: COOKIE.cy, body: form(adaBot.agent_key) });
  assert.equal(admin.status, 403, "a room admin cannot add a rule for someone else's agent");
  const ownerToken = await send("POST", "", { bearer: TOKEN_ADA, body: form(adaBot.agent_key) });
  assert.equal(ownerToken.status, 403, ownerToken.text);
  assert.match(ownerToken.json.error, /signed-in person/);
  const workerBearer = await send("POST", "", { bearer: adaBot.worker_bearer!, body: form(adaBot.agent_key) });
  assert.equal(workerBearer.status, 403, workerBearer.text);
  const crossSite = await send("POST", "", { cookie: COOKIE.ada, origin: "https://evil.example", body: form(adaBot.agent_key) });
  assert.equal(crossSite.status, 403, crossSite.text);
  assert.match(crossSite.json.error, /from LetAgents/);
  const noOrigin = await send("POST", "", { cookie: COOKIE.ada, origin: null, body: form(adaBot.agent_key) });
  assert.equal(noOrigin.status, 403, "a cookie write without an origin is refused");
  const badAgent = await send("POST", "", { cookie: COOKIE.ada, body: form("nobody/ghost") });
  assert.equal(badAgent.status, 403);
  const email = await send("POST", "", { cookie: COOKIE.ada, body: { agent_key: adaBot.agent_key, rule: { event: "room.message", email: { to: "bot@example.com" } } } });
  assert.equal(email.status, 400, "the form adds webhook rules only");
  const timer = await send("POST", "", { cookie: COOKIE.ada, body: { agent_key: adaBot.agent_key, rule: { event: "timer", arguments: { after_ms: 60_000 }, webhook: { url: hookUrl, secret: SECRET } } } });
  assert.equal(timer.status, 400);
  const badUrl = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key, { webhook: { url: "http://10.0.0.8/hook", secret: SECRET } }) });
  assert.equal(badUrl.status, 400, badUrl.text);
  assert.equal(badUrl.json.error, guard.WAKE_WEBHOOK_URL_REFUSED);
  const badKey = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key, { webhook: { url: hookUrl, secret: SECRET, bearer: "has space" } }) });
  assert.equal(badKey.status, 400, badKey.text);
  assert.match(badKey.json.error, /webhook\.bearer/);

  const ruleId = (await send("GET", "", { cookie: COOKIE.ada })).json.active.find((rule: any) => rule.agent_key === adaBot.agent_key).id;
  const bobCancel = await send("POST", `/${ruleId}/cancel`, { cookie: COOKIE.bob, body: {} });
  assert.equal(bobCancel.status, 403, "a member who is not the owner or an admin cannot cancel a webhook rule");
  const cyCancel = await send("POST", `/${ruleId}/cancel`, { cookie: COOKIE.cy, body: {} });
  assert.equal(cyCancel.status, 200, cyCancel.text);
  assert.equal(cyCancel.json.rule.status, "cancelled");
  const cyRestore = await send("POST", `/${ruleId}/restore`, { cookie: COOKIE.cy, body: {} });
  assert.equal(cyRestore.status, 403, "only the owning account starts the rule again");
  // The owner adds it again instead: the cancelled rule is left behind and a new one holds the target.
  const readded = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key) });
  assert.equal(readded.status, 201, readded.text);
  assert.notEqual(readded.json.rule.id, ruleId);
});

test("a test delivery goes through the real pipeline and reports the receiver's answer; 4xx never counts toward a pause; tests are rate-limited", { skip, timeout: 90_000 }, async () => {
  const ruleId = (await send("GET", "", { cookie: COOKIE.ada })).json.active.find((rule: any) => rule.agent_key === adaBot.agent_key).id;
  received.length = 0;
  const ok = await send("POST", `/${ruleId}/test`, { cookie: COOKIE.ada, body: {} });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 200);
  assert.equal(ok.json.error_class, null);
  assert.match(ok.json.delivery_id, /^whd_/);
  assert.equal(received.length, 1);
  const first = received[0]!;
  const timestamp = String(first.headers["x-letagents-timestamp"]);
  assert.equal(first.headers.authorization, `Bearer ${KEY}`, "the receiver's sender key goes with the test");
  assert.equal(first.headers["x-letagents-signature"], `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${first.body}`).digest("hex")}`);
  assert.equal(first.headers["x-letagents-delivery"], ok.json.delivery_id);
  const body = JSON.parse(first.body);
  assert.deepEqual(Object.keys(body).sort(), ["delivery_id", "message_id", "room_id", "room_url", "rule_id", "sender", "sent_at", "text_preview"]);
  assert.equal(body.delivery_id, ok.json.delivery_id);
  assert.equal(body.message_id, "test");
  assert.equal(body.text_preview, "Test delivery from LetAgents");
  assert.equal(body.sender, "ada");
  assert.equal(body.rule_id, ruleId);
  assert.equal(body.room_id, roomId);
  let row = await ruleRow(ruleId);
  assert.equal(row.delivery_last_status, 200);
  assert.equal(row.delivery_delivered_count, 0, "a test is not a delivered message");
  assert.equal(row.delivery_consecutive_failures, 0);
  assert.equal((await testRows(ruleId))[0]!.state, "delivered");
  // The rule remembers its last answer was a test, and says so to its owner only.
  assert.equal(row.delivery_last_attempt_was_test, true);
  const ownerView = (await send("GET", "", { cookie: COOKIE.ada })).json.active.find((candidate: any) => candidate.id === ruleId);
  assert.equal(ownerView.delivery.last_attempt_was_test, true);
  assert.equal(ownerView.delivery.last_status, 200);
  const otherView = (await send("GET", "", { cookie: COOKIE.bob })).json.active.find((candidate: any) => candidate.id === ruleId);
  assert.deepEqual(otherView.delivery, { kind: "webhook", paused: false }, "nobody else sees the result, or that it was a test");

  assert.equal(ok.json.resumed, false);
  assert.equal((await testRows(ruleId))[0]!.last_error, null);

  // The receiver rejects the key on a paused rule: reported, recorded, never counted toward the pause, still paused.
  // The mark is cleared first (as a real delivery would), so only the failed branch of the test route can set it again.
  await dbClient!.pool.query("UPDATE agent_wake_rules SET status = 'paused', paused_at = now(), delivery_consecutive_failures = 5, delivery_last_attempt_was_test = false WHERE id = $1", [ruleId]);
  replies.push(401);
  const rejected = await send("POST", `/${ruleId}/test`, { cookie: COOKIE.ada, body: {} });
  assert.equal(rejected.status, 200, rejected.text);
  assert.deepEqual([rejected.json.status, rejected.json.error_class, rejected.json.resumed], [401, "http_4xx", false]);
  row = await ruleRow(ruleId);
  assert.equal(row.status, "paused");
  assert.equal(row.delivery_last_status, 401);
  assert.equal(row.delivery_last_error, "http_4xx");
  assert.equal(row.delivery_last_attempt_was_test, true, "a failed test is a test too");
  assert.equal(row.delivery_consecutive_failures, 5, "a failed test never counts toward pausing the rule");
  assert.deepEqual([(await testRows(ruleId))[1]!.state, (await testRows(ruleId))[1]!.last_error], ["dead", "http_4xx"]);

  // The receiver accepts: the run of failures ends and the paused rule is active again.
  const resumed = await send("POST", `/${ruleId}/test`, { cookie: COOKIE.ada, body: {} });
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual([resumed.json.status, resumed.json.error_class, resumed.json.resumed], [200, null, true]);
  row = await ruleRow(ruleId);
  assert.equal(row.status, "active");
  assert.equal(row.paused_at, null);
  assert.equal(row.delivery_consecutive_failures, 0);

  // Only the owner tests; only a webhook rule can be tested.
  assert.equal((await send("POST", `/${ruleId}/test`, { cookie: COOKIE.bob, body: {} })).status, 403);
  assert.equal((await send("POST", `/${ruleId}/test`, { cookie: COOKIE.cy, body: {} })).status, 403, "a room admin cannot test");
  assert.equal((await send("POST", `/${ruleId}/test`, { bearer: TOKEN_ADA, body: {} })).status, 403);
  assert.equal((await send("POST", `/wake_missing/test`, { cookie: COOKIE.ada, body: {} })).status, 404);
  const timer = await service!.addWakeRuleForAgent({
    roomId, agent: { agent_key: adaBot.agent_key, agent_name: "adabot", session_id: adaBot.session_id, owner_account_id: accounts.ada },
    body: { event: "timer", arguments: { after_ms: 120_000 } },
  });
  assert.equal((await send("POST", `/${timer.rule.id}/test`, { cookie: COOKIE.ada, body: {} })).status, 409);

  // The URL guard runs again at send time: with the loopback switch off, the stored http URL is refused.
  guard.allowLoopbackWakeWebhooksForTests(false);
  try {
    const refused = await send("POST", `/${ruleId}/test`, { cookie: COOKIE.ada, body: {} });
    assert.equal(refused.status, 200, refused.text);
    assert.deepEqual([refused.json.status, refused.json.error_class], [0, "url_not_allowed"]);
  } finally {
    guard.allowLoopbackWakeWebhooksForTests({});
  }
  assert.equal(received.length, 3, "nothing left the server for the refused test");
  assert.equal((await testRows(ruleId)).at(-1)!.last_error, "url_not_allowed");

  // Five tests in ten minutes, the refused one included; the sixth waits.
  assert.equal((await send("POST", `/${ruleId}/test`, { cookie: COOKIE.ada, body: {} })).json.status, 200);
  const limited = await send("POST", `/${ruleId}/test`, { cookie: COOKIE.ada, body: {} });
  assert.equal(limited.status, 429, limited.text);
  assert.match(limited.json.error, /5 tests/);
  assert.equal((await testRows(ruleId)).length, 5);

  // The five tests count against the rule's hourly budget of 20: with 15 message deliveries this hour, the next match waits.
  const now = new Date().toISOString();
  for (let n = 1; n <= 15; n += 1) {
    await dbClient!.pool.query(`
      INSERT INTO wake_webhook_deliveries (
        id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, match_count, state, attempt_count,
        scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id, host_fingerprint
      ) VALUES ($1, $2, $3, 'webhook', 'message', $4, '', '', 1, 'delivered', 1, $5, $5, $5, $5, $6, $7)
    `, [`whd_form_fill_${n}`, ruleId, roomId, n, now, accounts.ada, row.delivery_host_fingerprint]);
  }
  await api!.addMessage(roomId, "ada", "@adabot are you there?", { source: "browser", account_id: accounts.ada });
  const [held] = (await dbClient!.pool.query(
    "SELECT held_by_cap FROM wake_webhook_deliveries WHERE rule_id = $1 AND purpose = 'message' AND state = 'queued'", [ruleId],
  )).rows;
  assert.equal(held?.held_by_cap, true, "the budget counted the tests");
  assert.equal((await ruleRow(ruleId)).delivery_over_cap_count, 1);
});

test("eight tests at once: the rule's lock lets exactly five send and refuses the rest", { skip, timeout: 60_000 }, async () => {
  const added = await send("POST", "", { cookie: COOKIE.bob, body: form(bobBot.agent_key) });
  assert.equal(added.status, 201, added.text);
  const ruleId = added.json.rule.id;
  const before = received.length;
  const answers = await Promise.all(Array.from({ length: 8 }, () => send("POST", `/${ruleId}/test`, { cookie: COOKIE.bob, body: {} })));
  const sent = answers.filter((answer) => answer.status === 200);
  const refused = answers.filter((answer) => answer.status === 429);
  assert.equal(sent.length, 5, answers.map((answer) => answer.status).join(","));
  assert.equal(refused.length, 3);
  assert.ok(sent.every((answer) => answer.json.status === 200));
  assert.equal(received.length - before, 5, "at most five deliveries left the server");
  const rows = await testRows(ruleId);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((testRow) => testRow.state === "delivered"));
  assert.equal((await dbClient!.pool.query("SELECT count(*)::int AS n FROM wake_webhook_deliveries WHERE rule_id = $1 AND last_error = 'test_incomplete'", [ruleId])).rows[0].n, 0);
});

test("the rule ends when the sign-in behind the agent is removed: the worker session, or the owner token", { skip, timeout: 60_000 }, async () => {
  const mine = (await send("GET", "", { cookie: COOKIE.ada })).json.active;
  const sessionRule = mine.find((rule: any) => rule.agent_key === adaBot.agent_key && rule.delivery?.kind === "webhook");
  const tokenRule = mine.find((rule: any) => rule.agent_key === adaRemote.agent_key);
  assert.ok(sessionRule && tokenRule);
  await api!.endRoomAgentSession({ session_id: adaBot.session_id });
  let row = await ruleRow(sessionRule.id);
  assert.equal(row.status, "retired");
  assert.match(row.ended_reason, /revoked/);
  assert.equal(row.delivery_target, null);
  // An ended worker with no remote sign-in cannot be bound again until it reconnects.
  const again = await send("POST", "", { cookie: COOKIE.ada, body: form(adaBot.agent_key) });
  assert.equal(again.status, 409, again.text);
  assert.match(again.json.error, /no live session/);

  await adaRemote.client?.close().catch(() => undefined);
  adaRemote.client = null;
  const [token] = (await dbClient!.pool.query("SELECT token_id FROM owner_tokens WHERE token_hash = $1", [createHash("sha256").update(TOKEN_ADA).digest("hex")])).rows;
  await api!.deleteOwnerTokenById(token.token_id);
  row = await ruleRow(tokenRule.id);
  assert.equal(row.status, "retired");
  assert.match(row.ended_reason, /revoked/);
});

test("a real delivery attempt clears the test mark: delivered, retried and failed alike", { skip, timeout: 60_000 }, async () => {
  const ruleId = (await send("GET", "", { cookie: COOKIE.bob })).json.active.find((rule: any) => rule.agent_key === bobBot.agent_key).id;
  // The eight tests at once (earlier in this file) left a test as the rule's last answer.
  assert.equal((await ruleRow(ruleId)).delivery_last_attempt_was_test, true);
  const drain = async () => {
    await dbClient!.pool.query("UPDATE wake_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE rule_id = $1 AND state IN ('queued', 'retry')", [ruleId]);
    return worker!.processWakeWebhookBatch("wake-form-test-worker", { ...worker!.defaultWakeWebhookDeps() });
  };
  const runOneDelivery = async (text: string) => {
    await api!.addMessage(roomId, "ada", text, { source: "browser", account_id: accounts.ada });
    return drain();
  };
  const mark = async () => {
    const row = await ruleRow(ruleId);
    return [row.delivery_last_attempt_was_test, row.delivery_last_status, row.delivery_last_error];
  };

  // Delivered.
  const before = received.length;
  assert.equal(await runOneDelivery("@bobbot first real message"), 1);
  assert.equal(received.length, before + 1);
  assert.deepEqual(await mark(), [false, 200, null]);
  assert.equal((await send("GET", "", { cookie: COOKIE.bob })).json.active.find((rule: any) => rule.id === ruleId).delivery.last_attempt_was_test, false);

  // Retried (a 5xx), after the mark is set again as a test would set it.
  await dbClient!.pool.query("UPDATE agent_wake_rules SET delivery_last_attempt_was_test = true WHERE id = $1", [ruleId]);
  replies.push(503);
  await runOneDelivery("@bobbot second real message");
  assert.deepEqual(await mark(), [false, 503, "http_5xx"]);
  assert.equal(await drain(), 1, "the retry goes out and the receiver accepts it");

  // Failed for good (a 4xx).
  await dbClient!.pool.query("UPDATE agent_wake_rules SET delivery_last_attempt_was_test = true WHERE id = $1", [ruleId]);
  replies.push(400);
  await runOneDelivery("@bobbot third real message");
  assert.deepEqual(await mark(), [false, 400, "http_4xx"]);
  assert.equal((await ruleRow(ruleId)).delivery_consecutive_failures, 1);
});
