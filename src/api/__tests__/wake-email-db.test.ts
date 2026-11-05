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

// A hosted bot registers room.message email rules over /mcp. Mail goes to a
// capturing mailer (the SMTP client itself is tested against a loopback stub
// in wake-email.test.ts); nothing leaves the machine.
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
const store = testDatabaseUrl ? await import("../db/wake-rules.js") : null;
const scheduler = testDatabaseUrl ? await import("../wake-rules/scheduler.js") : null;

import type { WakeEmailMessage, WakeMailer } from "../wake-rules/email.js";

let server: Server | null = null;
let baseUrl = "";
let humanAccountId = "";
let owners = 0;
const sent: WakeEmailMessage[] = [];
const mailer: WakeMailer = {
  async send(message) {
    sent.push(message);
    return { outcome: "delivered", status: 250, error: null };
  },
};

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
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

const configure = () => {
  process.env.LETAGENTS_EMAIL_SMTP_URL = "smtps://user:password@smtp.example.invalid:465";
  process.env.LETAGENTS_EMAIL_FROM = "LetAgents <notify@letagents.chat>";
};

/** A fresh account, its owner token and a connected /mcp client, so daily budgets never leak between tests. */
async function newBot(): Promise<Client> {
  owners += 1;
  const token = `wake_email_owner_token_${owners}`;
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `wake-email-bot-${owners}`, login: `wake-email-bot-${owners}`, display_name: "Wake email bot",
  });
  await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: `wake-email-bot-${owners}`, token });
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

const failed = (result: Record<string, any>) => result.isError === true || result.success === false;

/** Join a room and register the bot; returns an `add` for email rules in it. */
async function inRoom(bot: Client, roomName: string) {
  const joined = await call(bot, "join_room", { name: roomName });
  const roomId = String(joined.room_id);
  const session = await call(bot, "register_agent_session", { room_id: roomId, display_name: "relaybot", runtime: "hosted-bot" });
  const add = (to: string) => call(bot, "add_wake_rule", {
    room_id: roomId, agent_session_id: session.agent_session_id, event: "room.message", email: { to },
  });
  const cancel = (ruleId: string) => call(bot, "cancel_wake_rule", { room_id: roomId, agent_session_id: session.agent_session_id, rule_id: ruleId });
  return { roomId, add, cancel };
}

async function deliveries(ruleId: string) {
  return (await dbClient!.pool.query<{ purpose: string; kind: string; state: string; held_by_cap: boolean; scheduled_at: string }>(
    "SELECT purpose, kind, state, held_by_cap, scheduled_at FROM wake_webhook_deliveries WHERE rule_id = $1 ORDER BY created_at, id", [ruleId],
  )).rows;
}

async function ruleRow(ruleId: string) {
  return (await dbClient!.pool.query("SELECT * FROM agent_wake_rules WHERE id = $1", [ruleId])).rows[0];
}

async function runWorker(): Promise<number> {
  await dbClient!.pool.query("UPDATE wake_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE state IN ('queued', 'retry') AND NOT held_by_cap");
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

/** The newest email sent to one address (other tests' queued emails may go out in the same pass). */
function lastTo(address: string): WakeEmailMessage {
  const found = sent.filter((message) => message.to === address).at(-1);
  assert.ok(found, `no email to ${address}`);
  return found;
}

const form = (url: string, body: string) => fetch(url, {
  method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
});

test("an email rule is refused without SMTP settings, confirms by a button, emails once confirmed, and stops by its link", { skip, timeout: 90_000 }, async () => {
  const bot = await newBot();
  try {
    const { roomId, add } = await inRoom(bot, "wake-email-flow");
    const roomName = (await dbClient!.pool.query("SELECT display_name FROM rooms WHERE id = $1", [roomId])).rows[0].display_name;
    const address = "relaybot-inbox@example.com";

    const refused = await add(address);
    assert.equal(failed(refused), true, refused.raw);
    assert.match(refused.raw, /Email delivery is not configured on this server/);
    assert.equal((await dbClient!.pool.query("SELECT count(*)::int AS n FROM agent_wake_rules WHERE delivery_kind = 'email'")).rows[0].n, 0);

    configure();
    const added = await add(address);
    assert.equal(failed(added), false, added.raw);
    const rule = added.rule as Record<string, any>;
    assert.equal(rule.status, "pending_confirmation");
    assert.equal(rule.delivery.kind, "email");
    assert.equal(added.confirmation.sent, true);
    assert.match(added.confirmation.next_step, /No room messages are emailed until the address confirms/);
    assert.equal(added.raw.includes(address), false, "the address is never returned");
    assert.equal(JSON.stringify((await ruleRow(rule.id)).delivery_target).includes(address), false, "the address is sealed");

    // Before confirmation only the confirmation goes out, and it carries no agent or room text.
    await humanSays(roomId, "@relaybot are you there?");
    assert.deepEqual((await deliveries(rule.id)).map((row) => row.purpose), ["confirm"]);
    assert.equal(await runWorker(), 1);
    const confirmation = lastTo(address);
    assert.equal(confirmation.to, address);
    assert.equal(confirmation.subject, "[LetAgents] Confirm email notifications");
    assert.equal(confirmation.text.includes("relaybot") || confirmation.text.includes(roomName), false);
    const confirmUrl = linkIn(confirmation.text, "confirm");
    const stopUrl = linkIn(confirmation.text, "disable");
    assert.equal(confirmation.headers["List-Unsubscribe"], `<${stopUrl}>`);
    // Adding it again within minutes sends no second confirmation.
    const again = await add(address);
    assert.equal(again.confirmation.sent, false);
    assert.equal((await deliveries(rule.id)).length, 1);

    // Opening the link changes nothing: it shows a button, and only its POST confirms.
    const opened = await fetch(confirmUrl);
    assert.equal(opened.status, 200);
    assert.match(opened.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(opened.headers.get("content-security-policy") ?? "", /form-action 'self'/);
    const page = await opened.text();
    assert.match(page, /<form method="post"><input type="hidden" name="confirm" value="yes"><button type="submit">Confirm<\/button><\/form>/);
    assert.equal((await ruleRow(rule.id)).status, "pending_confirmation");
    assert.equal((await form(confirmUrl, "")).status, 400, "a POST without the button's field changes nothing");
    assert.equal((await fetch(`${baseUrl}/wake-rules/confirm/${"0".repeat(64)}`, { method: "POST", body: "confirm=yes", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 404);
    const confirmed = await form(confirmUrl, "confirm=yes");
    assert.equal(confirmed.status, 200);
    assert.match(await confirmed.text(), /<h1>Confirmed<\/h1>/);
    assert.equal((await ruleRow(rule.id)).status, "active");
    assert.match(await (await form(confirmUrl, "confirm=yes")).text(), /Already confirmed/);

    // Once confirmed, a message for the bot is one email.
    const asked = await humanSays(roomId, "@relaybot can you check the deploy?");
    await runWorker();
    const mail = lastTo(address);
    assert.equal(mail.subject, `[LetAgents] New message for relaybot in ${roomName}`);
    assert.match(mail.text, /^From: Ada$/m);
    assert.ok(mail.text.includes("@relaybot can you check the deploy?"));
    assert.match(mail.text, new RegExp(`/in/${roomId}$`, "m"));
    assert.ok(mail.text.includes(`Message: ${asked.id}`));
    assert.ok(mail.text.includes(`Stop these emails: ${stopUrl}`));
    assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

    // The stop link: opening it shows a button; a one-click POST must carry exactly its body.
    assert.match(await (await fetch(stopUrl)).text(), /name="List-Unsubscribe" value="One-Click"/);
    assert.equal((await ruleRow(rule.id)).status, "active");
    assert.equal((await form(stopUrl, "List-Unsubscribe=One-Click&x=1")).status, 400);
    assert.equal((await ruleRow(rule.id)).status, "active");
    const stopped = await form(stopUrl, "List-Unsubscribe=One-Click");
    assert.equal(stopped.status, 200);
    assert.match(await stopped.text(), /<h1>Stopped<\/h1>/);
    const paused = await ruleRow(rule.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.confirmed_at, null);
    assert.equal(Date.parse(paused.next_check_at), Date.parse(paused.expires_at), "a stopped rule is not due before it ends");
    await humanSays(roomId, "@relaybot hello?");
    const count = sent.filter((message) => message.to === address).length;
    await runWorker();
    assert.equal(sent.filter((message) => message.to === address).length, count, "nothing for a stopped rule");

    // A stopped address gets no new request from the agent...
    const blocked = await add(address);
    assert.equal(failed(blocked), true);
    assert.match(blocked.raw, /asked LetAgents to stop emailing it/);
    // ...until the person asks from the stop page; then one confirmation goes out.
    const askedAgain = await form(`${stopUrl}/again`, "again=yes");
    assert.equal(askedAgain.status, 200);
    assert.equal((await ruleRow(rule.id)).status, "pending_confirmation");
    await runWorker();
    assert.equal(lastTo(address).subject, "[LetAgents] Confirm email notifications");
    assert.equal(linkIn(lastTo(address).text, "disable"), stopUrl, "the stop link of a rule never changes");
  } finally {
    await bot.close();
  }
});

test("add, cancel and add again cannot send more than 3 confirmations to one address a day", { skip, timeout: 90_000 }, async () => {
  configure();
  const bot = await newBot();
  try {
    const { add, cancel } = await inRoom(bot, "wake-email-loop");
    const address = "loop-target@example.com";
    for (let round = 0; round < 3; round += 1) {
      const added = await add(address);
      assert.equal(added.confirmation?.sent, true, added.raw);
      assert.equal(failed(await cancel(added.rule.id)), false);
    }
    const fourth = await add(address);
    assert.equal(failed(fourth), true, fourth.raw);
    assert.match(fourth.raw, /already got 3 confirmation requests today/);
    assert.equal((await dbClient!.pool.query("SELECT count(*)::int AS n FROM wake_email_confirmations")).rows[0].n >= 3, true);
    // Another address still works, and one account may have only 3 waiting at once.
    for (const to of ["second@example.com", "third@example.com", "fourth@example.com"]) {
      assert.equal((await add(to)).rule?.status, "pending_confirmation");
    }
    const tooMany = await add("fifth@example.com");
    assert.match(tooMany.raw, /3 email rules waiting for confirmation/);
  } finally {
    await bot.close();
  }
});

test("the scheduler ends an unconfirmed rule when its link expires, and a stop while pending leaves nothing due", { skip, timeout: 60_000 }, async () => {
  configure();
  const bot = await newBot();
  try {
    const { add } = await inRoom(bot, "wake-email-scheduler");
    const unconfirmed = (await add("late@example.com")).rule as Record<string, any>;
    await dbClient!.pool.query(
      "UPDATE agent_wake_rules SET confirm_expires_at = now() - interval '1 second', next_check_at = now() - interval '1 second' WHERE id = $1",
      [unconfirmed.id]);
    const now = new Date();
    await scheduler!.checkWakeRules(await store!.getDueWakeRules(now), now);
    const ended = await ruleRow(unconfirmed.id);
    assert.equal(ended.status, "expired");
    assert.match(ended.ended_reason, /not confirmed within 24 hours/);

    const pending = (await add("pending@example.com")).rule as Record<string, any>;
    await runWorker();
    const stopUrl = linkIn(lastTo("pending@example.com").text, "disable");
    assert.equal((await form(stopUrl, "List-Unsubscribe=One-Click")).status, 200);
    const stopped = await ruleRow(pending.id);
    assert.equal(stopped.status, "paused");
    // Before the fix a stopped pending rule kept a past check time and spun the scheduler.
    assert.ok(Date.parse(stopped.next_check_at) > Date.now() + 29 * 24 * 3600_000);
    const later = new Date();
    assert.deepEqual((await store!.getDueWakeRules(later)).map((rule) => rule.id).filter((id) => id === pending.id), []);
  } finally {
    await bot.close();
  }
});

test("past the hourly budget one email waits for the hour's end and later matches fold into it", { skip, timeout: 60_000 }, async () => {
  configure();
  const bot = await newBot();
  try {
    const { roomId, add } = await inRoom(bot, "wake-email-cap");
    const rule = (await add("busy@example.com")).rule as Record<string, any>;
    await runWorker();
    const confirmUrl = linkIn(lastTo("busy@example.com").text, "confirm");
    assert.equal((await form(confirmUrl, "confirm=yes")).status, 200);
    const owner = (await ruleRow(rule.id)).owner_account_id;
    await dbClient!.pool.query(`
      INSERT INTO wake_webhook_deliveries (id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, state,
        scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id)
      SELECT 'whd_cap_' || n, $1, $2, 'email', 'message', 1, '', '', 'delivered',
             now() - make_interval(mins => 50 - n), now(), now(), now(), $3
        FROM generate_series(1, 20) AS n
    `, [rule.id, roomId, owner]);
    await humanSays(roomId, "@relaybot first over the budget");
    await humanSays(roomId, "@relaybot second over the budget");
    const waiting = (await deliveries(rule.id)).filter((row) => row.state === "queued");
    assert.equal(waiting.length, 1, "one delivery waits; nothing is dropped");
    assert.equal(waiting[0]!.held_by_cap, true);
    const waitMs = Date.parse(waiting[0]!.scheduled_at) - Date.now();
    assert.ok(waitMs > 9 * 60_000 && waitMs < 12 * 60_000, `it waits for the oldest to leave the hour, got ${waitMs}`);
    assert.equal((await ruleRow(rule.id)).delivery_over_cap_count, 2);
  } finally {
    await bot.close();
  }
});

/** The code line of a confirmation mail: the link's token, printed for a bot that owns the mailbox. */
function codeIn(text: string): string {
  const match = /^Confirmation code: ([0-9a-f]{64})$/m.exec(text);
  assert.ok(match, `no confirmation code in:\n${text}`);
  return match[1]!;
}

test("a bot confirms its own email rule with the code from the mail; another account's bot cannot; the page button still works", { skip, timeout: 90_000 }, async () => {
  configure();
  const bot = await newBot();
  const other = await newBot();
  try {
    const { roomId, add } = await inRoom(bot, "wake-email-code");
    const address = "routine+sky@example.com";
    const added = await add(address);
    assert.equal(failed(added), false, added.raw);
    assert.match(added.confirmation.next_step, /Open the link from that mailbox and press Confirm, or, if the mailbox is yours as a bot, call confirm_wake_email with the code in the mail\.$/);
    const rule = added.rule as Record<string, any>;
    await runWorker();
    const mail = lastTo(address);
    const code = codeIn(mail.text);
    assert.equal(code, linkIn(mail.text, "confirm").split("/").pop(), "the code is the link's own token, not a second secret");
    assert.match(mail.text, /^If you are a bot: call the LetAgents tool confirm_wake_email with this code\.$/m);
    assert.equal(mail.text.includes("relaybot"), false, "the wording stays fixed: no agent name");
    const confirm = (client: Client, value: string) => call(client, "confirm_wake_email", { code: value });

    // A wrong or malformed code changes nothing, and the answer says only that no rule waits for it.
    const wrong = await confirm(bot, "0".repeat(64));
    assert.equal(wrong.confirmed, false, wrong.raw);
    assert.equal(wrong.error, "unknown_or_expired");
    assert.equal((await confirm(bot, "not a code")).error, "unknown_or_expired");
    assert.equal((await ruleRow(rule.id)).status, "pending_confirmation");

    // The real code in another account's hands: not theirs, and the rule stays pending.
    const leaked = await confirm(other, code);
    assert.equal(leaked.confirmed, false, leaked.raw);
    assert.equal(leaked.error, "not_yours");
    assert.equal((await ruleRow(rule.id)).status, "pending_confirmation");

    // The owner's bot confirms (spacing and case do not matter): the rule is active.
    const confirmed = await confirm(bot, ` ${code.toUpperCase()} `);
    assert.equal(confirmed.confirmed, true, confirmed.raw);
    assert.equal(confirmed.rule.id, rule.id);
    assert.equal(confirmed.rule.status, "active");
    assert.equal(confirmed.rule.delivery.kind, "email");
    assert.equal(confirmed.raw.includes(address), false, "the address is never returned");
    const row = await ruleRow(rule.id);
    assert.equal(row.status, "active");
    assert.ok(row.confirmed_at, "the confirmation is recorded on the rule");
    assert.equal(row.confirm_expires_at, null);

    // A second call, and the link's page, both say it is already confirmed.
    const again = await confirm(bot, code);
    assert.equal(again.confirmed, false);
    assert.equal(again.error, "already_active");
    assert.equal(again.rule?.status, "active");
    assert.match(await (await form(linkIn(mail.text, "confirm"), "confirm=yes")).text(), /Already confirmed/);

    // Once confirmed by code, a message for the bot is one email, as after the button.
    await humanSays(roomId, "@relaybot confirmed by code?");
    await runWorker();
    assert.match(lastTo(address).subject, /^\[LetAgents\] New message for relaybot in /);

    // An expired code is unknown, and the rule it named stays as it was.
    const late = (await add("late-code@example.com")).rule as Record<string, any>;
    await runWorker();
    const lateCode = codeIn(lastTo("late-code@example.com").text);
    await dbClient!.pool.query("UPDATE agent_wake_rules SET confirm_expires_at = now() - interval '1 second' WHERE id = $1", [late.id]);
    assert.equal((await confirm(bot, lateCode)).error, "unknown_or_expired");
    assert.equal((await ruleRow(late.id)).status, "pending_confirmation");

    // The page's button still confirms a rule the tool never saw.
    const byButton = (await add("by-button@example.com")).rule as Record<string, any>;
    await runWorker();
    const buttonUrl = linkIn(lastTo("by-button@example.com").text, "confirm");
    assert.equal((await form(buttonUrl, "confirm=yes")).status, 200);
    assert.equal((await ruleRow(byButton.id)).status, "active");
  } finally {
    await bot.close();
    await other.close();
  }
});

test("confirm_wake_email takes 10 attempts per credential in 10 minutes: the 11th is refused, right code or wrong", { skip, timeout: 60_000 }, async () => {
  configure();
  const bot = await newBot();
  const other = await newBot();
  try {
    const { add } = await inRoom(bot, "wake-email-attempts");
    const rule = (await add("guess-target@example.com")).rule as Record<string, any>;
    await runWorker();
    const code = codeIn(lastTo("guess-target@example.com").text);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const wrong = await call(bot, "confirm_wake_email", { code: attempt.toString(16).padStart(64, "0") });
      assert.equal(wrong.error, "unknown_or_expired", `attempt ${attempt}: ${wrong.raw}`);
    }
    const eleventh = await call(bot, "confirm_wake_email", { code });
    assert.equal(eleventh.confirmed, false, eleventh.raw);
    assert.equal(eleventh.error, "too_many_attempts");
    assert.match(eleventh.message, /10 confirmation attempts in 10 minutes/);
    assert.equal((await ruleRow(rule.id)).status, "pending_confirmation", "the right code waits too while the budget is spent");
    // The budget is per credential: another sign-in is not held back by this one's guesses.
    assert.equal((await call(other, "confirm_wake_email", { code: "f".repeat(64) })).error, "unknown_or_expired");
  } finally {
    await bot.close();
    await other.close();
  }
});
