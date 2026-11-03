import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import nodemailer from "nodemailer";

import { WakeRuleError, parseWakeRuleEmail, parseWakeRuleInput } from "../../../shared/wake-rules.mjs";
import { createConnectorCipher } from "../connectors/crypto.js";
import {
  EMAIL_FROM_ENV,
  EMAIL_SMTP_URL_ENV,
  classifyWakeMailError,
  composeWakeEmail,
  createWakeMailer,
  hashWakeLinkToken,
  loadWakeMailer,
  wakeEmailConfigured,
  wakeEmailConfirmToken,
  wakeEmailDisableToken,
  wakeLinkUrl,
  type MailTransport,
} from "../wake-rules/email.js";

/** nodemailer's jsonTransport, recording each message it would send. */
function recordingTransport() {
  const json = nodemailer.createTransport({ jsonTransport: true });
  const sent: Array<Record<string, any>> = [];
  const transport: MailTransport = {
    async sendMail(options) {
      const info = await json.sendMail(options as never) as { message: string };
      sent.push(JSON.parse(info.message));
      return info;
    },
  };
  return { transport, sent };
}

const disableUrl = "https://letagents.chat/wake-rules/disable/" + "d".repeat(64);

test("a message email has the subject, sender, preview, room link, message id and a stop link", async () => {
  const { transport, sent } = recordingTransport();
  const mailer = createWakeMailer(transport, "LetAgents <notify@letagents.chat>");
  const result = await mailer.send(composeWakeEmail({
    purpose: "message",
    to: "bot-inbox@example.com",
    agentName: "relaybot",
    roomName: "Deploys\r\nBcc: victim@example.com",
    roomUrl: "https://letagents.chat/in/deploys",
    disableUrl,
    sender: "Ada",
    preview: `@relaybot can you check the deploy?\n${"x".repeat(400)}`,
    messageId: "msg_42",
    deliveryId: "whd_1",
  }));
  assert.deepEqual(result, { outcome: "delivered", status: 250, error: null });
  assert.equal(sent.length, 1);
  const mail = sent[0]!;
  // Names are one line: a room name cannot add headers.
  assert.equal(mail.subject, "[LetAgents] New message for relaybot in Deploys Bcc: victim@example.com");
  assert.deepEqual(mail.to, [{ address: "bot-inbox@example.com", name: "" }]);
  assert.deepEqual(mail.from, { address: "notify@letagents.chat", name: "LetAgents" });
  assert.equal(mail.html, undefined, "plain text only");
  const text: string = mail.text;
  assert.match(text, /^From: Ada$/m);
  assert.match(text, /^Message: msg_42$/m);
  assert.match(text, /^Open the room: https:\/\/letagents\.chat\/in\/deploys$/m);
  assert.ok(text.includes(`Stop these emails: ${disableUrl}`));
  const preview = text.split("\n").find((line) => line.startsWith("@relaybot"))!;
  assert.equal(Array.from(preview).length, 200);
  assert.equal(mail.headers["List-Unsubscribe"], `<${disableUrl}>`);
  assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(mail.headers["Auto-Submitted"], "auto-generated");
  assert.equal(mail.headers["X-LetAgents-Delivery"], "whd_1");
});

test("a confirmation email carries the confirmation link and the stop link", async () => {
  const { transport, sent } = recordingTransport();
  const confirmUrl = "https://letagents.chat/wake-rules/confirm/" + "c".repeat(64);
  await createWakeMailer(transport, "notify@letagents.chat").send(composeWakeEmail({
    purpose: "confirm", to: "bot-inbox@example.com", agentName: "relaybot", roomName: "deploys",
    roomUrl: "https://letagents.chat/in/deploys", disableUrl, confirmUrl,
  }));
  assert.equal(sent[0]!.subject, "[LetAgents] Confirm email wake-ups for relaybot in deploys");
  assert.ok(sent[0]!.text.includes(`Confirm within 24 hours: ${confirmUrl}`));
  assert.ok(sent[0]!.text.includes(disableUrl));
  assert.equal(sent[0]!.headers["List-Unsubscribe"], `<${disableUrl}>`);
});

test("a permanent SMTP rejection is final; a temporary one or a connection error retries", () => {
  assert.deepEqual(classifyWakeMailError(Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550 })),
    { outcome: "dead", status: 550, error: "550 5.1.1 no such user" });
  assert.equal(classifyWakeMailError(Object.assign(new Error("554 rejected"), { responseCode: 554, code: "EENVELOPE" })).outcome, "dead");
  assert.equal(classifyWakeMailError(Object.assign(new Error("451 try later"), { responseCode: 451 })).outcome, "retry");
  assert.equal(classifyWakeMailError(Object.assign(new Error("421 busy"), { responseCode: 421, code: "EENVELOPE" })).outcome, "retry");
  assert.equal(classifyWakeMailError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" })).outcome, "retry");
  assert.equal(classifyWakeMailError(Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" })).outcome, "retry");
  assert.equal(classifyWakeMailError(Object.assign(new Error("No recipients defined"), { code: "EENVELOPE" })).outcome, "dead");
});

test("a mailer that throws reports the classified result", async () => {
  const failing = createWakeMailer({ async sendMail() { throw Object.assign(new Error("552 mailbox full"), { responseCode: 552 }); } }, "a@b.co");
  assert.equal((await failing.send({ to: "x@example.com", subject: "s", text: "t", headers: {} })).outcome, "dead");
});

test("email is configured only by both settings, and the mailer never connects to build", () => {
  assert.equal(wakeEmailConfigured({}), false);
  assert.equal(wakeEmailConfigured({ [EMAIL_SMTP_URL_ENV]: "smtps://u:p@smtp.example.com:465" }), false);
  assert.equal(wakeEmailConfigured({ [EMAIL_FROM_ENV]: "LetAgents <notify@letagents.chat>" }), false);
  const env = { [EMAIL_SMTP_URL_ENV]: "smtps://u:p@smtp.example.com:465", [EMAIL_FROM_ENV]: "LetAgents <notify@letagents.chat>" };
  assert.equal(wakeEmailConfigured(env), true);
  assert.equal(loadWakeMailer({}), null);
  assert.ok(loadWakeMailer(env));
});

test("link tokens are HMACs under the server key: a stable stop link, a new confirmation each time", () => {
  const cipher = createConnectorCipher(randomBytes(32).toString("hex"));
  const other = createConnectorCipher(randomBytes(32).toString("hex"));
  const stop = wakeEmailDisableToken(cipher, "wake_a");
  assert.match(stop, /^[0-9a-f]{64}$/);
  assert.equal(wakeEmailDisableToken(cipher, "wake_a"), stop);
  assert.notEqual(wakeEmailDisableToken(cipher, "wake_b"), stop);
  assert.notEqual(wakeEmailDisableToken(other, "wake_a"), stop, "another key makes another token");
  const first = wakeEmailConfirmToken(cipher, "wake_a", "2026-11-04T10:00:00.000Z");
  assert.equal(wakeEmailConfirmToken(cipher, "wake_a", "2026-11-04 10:00:00+00"), first, "the same moment in any notation");
  assert.notEqual(wakeEmailConfirmToken(cipher, "wake_a", "2026-11-04T10:10:00.000Z"), first);
  assert.equal(hashWakeLinkToken(first), createHash("sha256").update(first).digest("hex"));
  assert.equal(wakeLinkUrl("confirm", first, "https://letagents.chat/"), `https://letagents.chat/wake-rules/confirm/${first}`);
});

test("an email target is one plain address, and a rule takes webhook or email, not both", () => {
  assert.deepEqual(parseWakeRuleEmail({ to: "  Bot.Inbox+wake@Example.COM " }), { to: "Bot.Inbox+wake@example.com" });
  for (const to of ["Bob <bob@example.com>", "a@example.com,b@example.com", "a@example", "a@1.2.3.4", "a b@example.com",
    "a..b@example.com", ".a@example.com", "a@-example.com", `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`, ""]) {
    assert.throws(() => parseWakeRuleEmail({ to }), /one email address/, to);
  }
  assert.throws(() => parseWakeRuleEmail({ to: "a@example.com", cc: "b@example.com" }), /does not accept cc/);
  const now = new Date("2026-11-04T10:00:00Z");
  assert.equal(parseWakeRuleInput({ event: "room.message", email: { to: "a@example.com" } }, now).event, "room.message");
  const rejects = (input: unknown, pattern: RegExp) =>
    assert.throws(() => parseWakeRuleInput(input, now), (error: unknown) => error instanceof WakeRuleError && pattern.test(error.message));
  rejects({ event: "room.message", email: { to: "a@example.com" }, webhook: { url: "https://x.example.com", secret: "0123456789abcdef" } }, /either webhook or email, not both/);
  rejects({ event: "timer", arguments: { after_ms: 60_000 }, email: { to: "a@example.com" } }, /Only room.message rules deliver by webhook or email/);
  rejects({ event: "room.message" }, /webhook \{ url, secret \} or email \{ to \}/);
});
