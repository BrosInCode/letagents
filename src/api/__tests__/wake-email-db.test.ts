import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import nodemailer from "nodemailer";

// A hosted bot registers a room.message email rule over /mcp. Mail goes to
// nodemailer's jsonTransport; nothing leaves the machine.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_CONNECTOR_SECRET_KEY = randomBytes(32).toString("hex");
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE = "1000";
delete process.env.LETAGENTS_EMAIL_SMTP_URL;
delete process.env.LETAGENTS_EMAIL_FROM;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed wake email tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const worker = testDatabaseUrl ? await import("../notifications/wake-webhooks.js") : null;
const email = await import("../wake-rules/email.js");

const TOKEN_BOT = "wake_email_owner_token_bot";
const ADDRESS = "relaybot-inbox@example.com";
let server: Server | null = null;
let baseUrl = "";
let humanAccountId = "";
const sent: Array<Record<string, any>> = [];
const json = nodemailer.createTransport({ jsonTransport: true });
const mailer = email.createWakeMailer({
  async sendMail(options) {
    const info = await json.sendMail(options as never) as { message: string };
    sent.push(JSON.parse(info.message));
    return info;
  },
}, "LetAgents <notify@letagents.chat>");

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    const account = await accountSessions!.upsertAccount({
      provider: "github", provider_user_id: "wake-email-bot", login: "wake-email-bot", display_name: "Wake email bot",
    });
    await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: "wake-email-bot", token: TOKEN_BOT });
    humanAccountId = (await accountSessions!.upsertAccount({
      provider: "github", provider_user_id: "wake-email-ada", login: "Ada", display_name: "Ada",
    })).id;
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Links in the emails point at this test server.
    process.env.LETAGENTS_BASE_URL = baseUrl;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    await dbClient!.pool.end();
  });
}

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN_BOT}` } },
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

const failed = (result: Record<string, any>) => result.isError === true || result.success === false;

async function deliveries(ruleId: string) {
  return (await dbClient!.pool.query<{ purpose: string; kind: string; state: string; message_number: number | null }>(
    "SELECT purpose, kind, state, message_number FROM wake_webhook_deliveries WHERE rule_id = $1 ORDER BY created_at, id", [ruleId],
  )).rows;
}

async function ruleRow(ruleId: string) {
  return (await dbClient!.pool.query("SELECT * FROM agent_wake_rules WHERE id = $1", [ruleId])).rows[0];
}

async function runWorker(): Promise<number> {
  await dbClient!.pool.query("UPDATE wake_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE state IN ('queued', 'retry')");
  return worker!.processWakeWebhookBatch("wake-email-test-worker", { ...worker!.defaultWakeWebhookDeps(), mailer });
}

async function humanSays(roomId: string, text: string) {
  return api!.addMessage(roomId, "Ada", text, { source: "browser", account_id: humanAccountId });
}

function linkIn(text: string, kind: "confirm" | "disable"): string {
  const match = new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/wake-rules/${kind}/[0-9a-f]{64}`).exec(text);
  assert.ok(match, `no ${kind} link in:\n${text}`);
  return match[0];
}

test("an email rule is refused while the server has no SMTP settings, confirms by link, emails once confirmed, and stops by its link",
  { skip, timeout: 90_000 }, async () => {
    const bot = await connect();
    try {
      const joined = await call(bot, "join_room", { name: "wake-email-flow" });
      const roomId = String(joined.room_id);
      const roomName = (await dbClient!.pool.query("SELECT display_name FROM rooms WHERE id = $1", [roomId])).rows[0].display_name;
      const session = await call(bot, "register_agent_session", { room_id: roomId, display_name: "relaybot", runtime: "hosted-bot" });
      const add = () => call(bot, "add_wake_rule", {
        room_id: roomId, agent_session_id: session.agent_session_id, event: "room.message", email: { to: ADDRESS },
      });

      // Not configured: a clear error, and no rule.
      const refused = await add();
      assert.equal(failed(refused), true, refused.raw);
      assert.match(refused.raw, /Email delivery is not configured on this server/);
      assert.equal((await dbClient!.pool.query("SELECT count(*)::int AS n FROM agent_wake_rules")).rows[0].n, 0);

      process.env.LETAGENTS_EMAIL_SMTP_URL = "smtps://user:password@smtp.example.invalid:465";
      process.env.LETAGENTS_EMAIL_FROM = "LetAgents <notify@letagents.chat>";
      const added = await add();
      assert.equal(failed(added), false, added.raw);
      assert.equal(added.created, true);
      const rule = added.rule as Record<string, any>;
      assert.equal(rule.status, "pending_confirmation");
      assert.deepEqual(rule.delivery.kind, "email");
      assert.equal(added.confirmation.sent, true);
      assert.match(added.confirmation.next_step, /confirmation link/);
      assert.equal(added.raw.includes(ADDRESS), false, "the address is never returned");
      const stored = await ruleRow(rule.id);
      assert.equal(JSON.stringify(stored.delivery_target).includes(ADDRESS), false, "the address is sealed");
      assert.equal(stored.identity_key.includes(ADDRESS), false);

      // Before confirmation nothing but the confirmation goes out.
      await humanSays(roomId, "@relaybot are you there?");
      assert.deepEqual((await deliveries(rule.id)).map((row) => row.purpose), ["confirm"]);
      assert.equal(await runWorker(), 1);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0]!.to, [{ address: ADDRESS, name: "" }]);
      assert.equal(sent[0]!.subject, `[LetAgents] Confirm email wake-ups for relaybot in ${roomName}`);
      const confirmUrl = linkIn(sent[0]!.text, "confirm");
      const stopUrl = linkIn(sent[0]!.text, "disable");
      assert.equal(sent[0]!.headers["List-Unsubscribe"], `<${stopUrl}>`);
      // Adding it again within minutes sends no second confirmation.
      const again = await add();
      assert.equal(again.created, false);
      assert.equal(again.confirmation.sent, false);
      assert.equal((await deliveries(rule.id)).length, 1);

      // A wrong or made-up token does nothing.
      assert.equal((await fetch(`${baseUrl}/wake-rules/confirm/${"0".repeat(64)}`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/wake-rules/confirm/not-a-token`)).status, 404);
      const confirmed = await fetch(confirmUrl);
      assert.equal(confirmed.status, 200);
      assert.match(confirmed.headers.get("content-type") ?? "", /^text\/plain/);
      assert.match(await confirmed.text(), /^Confirmed\./);
      assert.equal((await ruleRow(rule.id)).status, "active");
      const reused = await fetch(confirmUrl);
      assert.equal(reused.status, 200, "a confirmation link works once; again it only says so");
      assert.match(await reused.text(), /already confirmed/);

      // Once confirmed, a message for the bot is one email.
      const asked = await humanSays(roomId, "@relaybot can you check the deploy?");
      assert.equal(await runWorker(), 1);
      assert.equal(sent.length, 2);
      const mail = sent[1]!;
      assert.equal(mail.subject, `[LetAgents] New message for relaybot in ${roomName}`);
      assert.match(mail.text, /^From: Ada$/m);
      assert.ok(mail.text.includes("@relaybot can you check the deploy?"));
      assert.ok(mail.text.includes(`Open the room: `));
      assert.match(mail.text, new RegExp(`/in/${roomId}$`, "m"));
      assert.ok(mail.text.includes(`Message: ${asked.id}`));
      assert.ok(mail.text.includes(`Stop these emails: ${stopUrl}`));
      assert.equal(mail.headers["List-Unsubscribe"], `<${stopUrl}>`);
      assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      const kinds = await deliveries(rule.id);
      assert.deepEqual(kinds.map((row) => [row.purpose, row.kind, row.state]), [["confirm", "email", "delivered"], ["message", "email", "delivered"]]);

      // The hourly cap: with 20 deliveries this hour, the next match is dropped and counted.
      await dbClient!.pool.query(`
        INSERT INTO wake_webhook_deliveries (id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, state,
          scheduled_at, next_attempt_at, created_at, updated_at)
        SELECT 'whd_cap_' || n, $1, $2, 'email', 'message', 1, '', '', 'delivered', now(), now(), now(), now()
          FROM generate_series(1, 18) AS n
      `, [rule.id, roomId]);
      await humanSays(roomId, "@relaybot one more");
      assert.equal((await deliveries(rule.id)).length, 20, "no 21st delivery");
      assert.equal((await ruleRow(rule.id)).delivery_dropped_count, 1);
      await dbClient!.pool.query("DELETE FROM wake_webhook_deliveries WHERE id LIKE 'whd_cap_%'");

      // The stop link (one-click POST from the mail client) pauses the rule.
      const stopped = await fetch(stopUrl, { method: "POST", body: "List-Unsubscribe=One-Click",
        headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      assert.equal(stopped.status, 200);
      assert.match(await stopped.text(), /^Stopped\./);
      const paused = await ruleRow(rule.id);
      assert.equal(paused.status, "paused");
      assert.equal(paused.confirmed_at, null);
      await humanSays(roomId, "@relaybot hello?");
      assert.equal(await runWorker(), 0);
      assert.equal(sent.length, 2);
      assert.match(await (await fetch(stopUrl)).text(), /already stopped/);

      // The agent adding it again needs the address to confirm again.
      const resumed = await add();
      assert.equal(resumed.rule.status, "pending_confirmation");
      assert.equal(resumed.confirmation.sent, true);
      assert.equal(await runWorker(), 1);
      assert.equal(sent.length, 3);
      assert.equal(sent[2]!.subject, `[LetAgents] Confirm email wake-ups for relaybot in ${roomName}`);
      assert.equal(linkIn(sent[2]!.text, "disable"), stopUrl, "the stop link of a rule never changes");
      assert.notEqual(linkIn(sent[2]!.text, "confirm"), confirmUrl);

      // One account may have only 3 addresses waiting to confirm, so it cannot send confirmations in bulk.
      for (const to of ["second-inbox@example.com", "third-inbox@example.com"]) {
        const more = await call(bot, "add_wake_rule", { room_id: roomId, agent_session_id: session.agent_session_id, event: "room.message", email: { to } });
        assert.equal(more.rule?.status, "pending_confirmation", more.raw);
      }
      const fourth = await call(bot, "add_wake_rule", {
        room_id: roomId, agent_session_id: session.agent_session_id, event: "room.message", email: { to: "fourth-inbox@example.com" },
      });
      assert.equal(failed(fourth), true, fourth.raw);
      assert.match(fourth.raw, /3 email rules waiting for confirmation/);
    } finally {
      delete process.env.LETAGENTS_EMAIL_SMTP_URL;
      delete process.env.LETAGENTS_EMAIL_FROM;
      await bot.close();
    }
  });
