import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import test from "node:test";
import tls from "node:tls";

import { WakeRuleError, parseWakeRuleEmail, parseWakeRuleInput } from "../../../shared/wake-rules.mjs";
import { createConnectorCipher } from "../connectors/crypto.js";
import {
  EMAIL_FROM_ENV,
  EMAIL_SMTP_URL_ENV,
  classifyWakeMailError,
  composeWakeEmail,
  createSmtpMailer,
  hashWakeLinkToken,
  loadWakeMailer,
  wakeEmailAddressFingerprint,
  wakeEmailMailboxKey,
  wakeEmailConfigured,
  wakeEmailConfirmToken,
  wakeEmailDisableToken,
  wakeLinkUrl,
} from "../wake-rules/email.js";
import { SmtpError, buildMimeMessage, dotStuff, parseSmtpUrl, quotedPrintable, sendSmtpMail } from "../wake-rules/smtp.js";
import { makeTestCertificate } from "./wake-test-tls.js";

const certificate = makeTestCertificate();
const needsTls = { skip: !certificate && "openssl is not installed" };

type Stage = "auth" | "mail" | "rcpt" | "data";

interface StubOptions {
  /** Offer STARTTLS on a plain connection. */
  starttls?: boolean;
  /** The whole connection is TLS (smtps://). */
  implicitTls?: boolean;
  auth?: "PLAIN" | "LOGIN" | null;
  fail?: Partial<Record<Stage, number>>;
  /** Plain text written in the same packet as the "220" to STARTTLS (a man in the middle). */
  injectAfterStarttls?: string;
  /** Drop the connection right after the "220" to STARTTLS. */
  resetAfterStarttls?: boolean;
  /** End multi-line replies with a bare code ("250"), as RFC 5321 allows. */
  bareFinalLine?: boolean;
}

/** A loopback SMTP server that records what it is told. */
async function smtpStub(options: StubOptions = {}) {
  const commands: Array<{ line: string; secure: boolean }> = [];
  const messages: string[] = [];
  const credentials: string[] = [];
  const handle = (socket: net.Socket, startsSecure: boolean) => {
    let current: net.Socket = socket;
    let secure = startsSecure;
    let buffer = "";
    let inData = false;
    let data: string[] = [];
    let login: "user" | "pass" | null = null;
    const say = (text: string) => current.write(`${text}\r\n`);
    const reply = (stage: Stage, ok: string) => {
      const code = options.fail?.[stage];
      say(code ? `${code} refused` : ok);
    };
    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          messages.push(data.map((part) => (part.startsWith("..") ? part.slice(1) : part)).join("\r\n"));
          data = [];
          return reply("data", "250 queued");
        }
        data.push(line);
        return;
      }
      if (login) {
        credentials.push(Buffer.from(line, "base64").toString("utf8"));
        if (login === "user") {
          login = "pass";
          return say("334 UGFzc3dvcmQ6");
        }
        login = null;
        return reply("auth", "235 ok");
      }
      commands.push({ line, secure });
      const verb = line.split(/[ :]/)[0]!.toUpperCase();
      if (verb === "EHLO") {
        const lines = ["stub", ...(options.starttls && !secure ? ["STARTTLS"] : []), ...(options.auth ? [`AUTH ${options.auth}`] : []), "8BITMIME"];
        lines.forEach((text, index) => say(index < lines.length - 1 ? `250-${text}` : options.bareFinalLine ? "250" : `250 ${text}`));
      } else if (verb === "STARTTLS") {
        if (options.resetAfterStarttls) {
          say("220 go ahead");
          current.removeListener("data", onData);
          setTimeout(() => current.destroy(), 20);
          return;
        }
        current.write(`220 go ahead\r\n${options.injectAfterStarttls ?? ""}`);
        current.removeListener("data", onData);
        const upgraded = new tls.TLSSocket(current, { isServer: true, key: certificate!.key, cert: certificate!.cert });
        upgraded.on("data", onData);
        upgraded.on("error", () => undefined);
        current = upgraded;
        secure = true;
        buffer = "";
      } else if (verb === "AUTH") {
        const [, mechanism, initial] = line.split(" ");
        if (mechanism === "PLAIN") {
          credentials.push(Buffer.from(initial ?? "", "base64").toString("utf8"));
          reply("auth", "235 ok");
        } else {
          login = "user";
          say("334 VXNlcm5hbWU6");
        }
      } else if (verb === "MAIL") reply("mail", "250 ok");
      else if (verb === "RCPT") reply("rcpt", "250 ok");
      else if (verb === "DATA") {
        if (options.fail?.data && options.fail.data < 400) return say(`${options.fail.data} no`);
        inData = true;
        say("354 go");
      } else if (verb === "QUIT") {
        say("221 bye");
        current.end();
      } else say("500 what");
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\r\n"); index >= 0; index = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    };
    current.on("data", onData);
    current.on("error", () => undefined);
    say("220 stub ESMTP");
  };
  const server = options.implicitTls
    ? tls.createServer({ key: certificate!.key, cert: certificate!.cert }, (socket) => handle(socket, true))
    : net.createServer((socket) => handle(socket, false));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    commands,
    messages,
    credentials,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Decode a quoted-printable body back to text. */
function decodeQuotedPrintable(body: string): string {
  const bytes: number[] = [];
  const text = body.replace(/=\r\n/g, "");
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "=" && /^[0-9A-F]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(...Buffer.from(text[index]!, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

const FROM = "LetAgents <notify@letagents.chat>";
const disableUrl = "https://letagents.chat/wake-rules/disable/" + "d".repeat(64);
const sample = composeWakeEmail({
  purpose: "message",
  to: "bot-inbox@example.com",
  agentName: "relaybot",
  roomName: "Déploiements",
  roomUrl: "https://letagents.chat/in/deploys",
  disableUrl,
  sender: "Ada",
  preview: ".hidden line start, ünïcode and a long tail " + "x".repeat(150),
  messageId: "msg_42",
  deliveryId: "whd_1",
});

test("smtp:// upgrades with STARTTLS before anything else, signs in with AUTH PLAIN, and sends a dot-stuffed message", needsTls, async () => {
  const stub = await smtpStub({ starttls: true, auth: "PLAIN" });
  try {
    const mailer = createSmtpMailer(parseSmtpUrl(`smtp://wake%40letagents.chat:p%40ss@127.0.0.1:${stub.port}`), FROM, { ca: certificate!.cert });
    assert.deepEqual(await mailer.send(sample), { outcome: "delivered", status: 250, error: null });
    // Only EHLO and STARTTLS travel in the clear; credentials and mail only after TLS.
    assert.deepEqual(stub.commands.filter((command) => !command.secure).map((command) => command.line.split(" ")[0]), ["EHLO", "STARTTLS"]);
    assert.deepEqual(stub.commands.filter((command) => command.secure).map((command) => command.line.split(/[ :]/)[0]), ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
    assert.deepEqual(stub.credentials, ["\u0000wake@letagents.chat\u0000p@ss"]);
    assert.ok(stub.commands.some((command) => command.line === "MAIL FROM:<notify@letagents.chat>"));
    assert.ok(stub.commands.some((command) => command.line === "RCPT TO:<bot-inbox@example.com>"));
    const raw = stub.messages[0]!;
    const headers = raw.slice(0, raw.indexOf("\r\n\r\n"));
    const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
    assert.match(headers, /^From: "LetAgents" <notify@letagents\.chat>$/m);
    assert.match(headers, /^To: bot-inbox@example\.com$/m);
    assert.match(headers, /^Subject: =\?UTF-8\?B\?/m, "a non-ASCII subject is an encoded word");
    assert.match(headers, /^Content-Type: text\/plain; charset=utf-8$/m);
    assert.match(headers, /^List-Unsubscribe: <https:\/\/letagents\.chat\/wake-rules\/disable\/d{64}>$/m);
    assert.match(headers, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    // The line that starts with a period arrived intact (stuffed, then unstuffed by the server).
    assert.equal(decodeQuotedPrintable(body).replace(/\r\n/g, "\n"), sample.text);
    assert.ok(body.split("\r\n").every((line) => line.length <= 76));
  } finally {
    await stub.close();
  }
});

test("smtp:// is refused when the server does not offer STARTTLS, before any credential is sent", needsTls, async () => {
  const stub = await smtpStub({ starttls: false, auth: "PLAIN" });
  try {
    const result = await createSmtpMailer(parseSmtpUrl(`smtp://user:secret@127.0.0.1:${stub.port}`), FROM, { ca: certificate!.cert }).send(sample);
    assert.deepEqual(result, { outcome: "retry", status: 0, error: "smtp_operator", operator: true });
    assert.deepEqual(stub.commands.map((command) => command.line), ["EHLO letagents"]);
    assert.deepEqual(stub.credentials, []);
  } finally {
    await stub.close();
  }
});

test("plain text written after the STARTTLS 220 is refused, never read as a reply over TLS", needsTls, async () => {
  // A man in the middle appends a forged EHLO reply that offers AUTH PLAIN; the real one over TLS offers only LOGIN.
  const stub = await smtpStub({ starttls: true, auth: "LOGIN", injectAfterStarttls: "250-forged\r\n250 AUTH PLAIN\r\n" });
  try {
    const config = parseSmtpUrl(`smtp://user:secret@127.0.0.1:${stub.port}`);
    await assert.rejects(sendSmtpMail(config, { from: FROM, to: "a@example.com", subject: "s", text: "t" }, { ca: certificate!.cert, timeoutMs: 3_000 }),
      (error: unknown) => error instanceof SmtpError && error.stage === "starttls");
    assert.deepEqual(stub.commands.filter((command) => command.secure), [], "nothing is sent once the stream is suspect");
    assert.deepEqual(stub.credentials, []);
    // It is the operator's problem: retried, never counted against the rule.
    const result = await createSmtpMailer(config, FROM, { ca: certificate!.cert, timeoutMs: 3_000 }).send(sample);
    assert.deepEqual(result, { outcome: "retry", status: 0, error: "smtp_operator", operator: true });
  } finally {
    await stub.close();
  }
});

test("a connection reset during the STARTTLS handshake is a clean SmtpError, with nothing uncaught", needsTls, async () => {
  const stub = await smtpStub({ starttls: true, auth: "PLAIN", resetAfterStarttls: true });
  let uncaught: unknown = null;
  const onUncaught = (error: unknown) => { uncaught = error; };
  process.on("uncaughtException", onUncaught);
  try {
    await assert.rejects(
      sendSmtpMail(parseSmtpUrl(`smtp://user:secret@127.0.0.1:${stub.port}`), { from: FROM, to: "a@example.com", subject: "s", text: "t" },
        { ca: certificate!.cert, timeoutMs: 3_000 }),
      (error: unknown) => error instanceof SmtpError && (error.stage === "starttls" || error.stage === "ehlo"),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(uncaught, null, `uncaught: ${String(uncaught)}`);
  } finally {
    process.off("uncaughtException", onUncaught);
    await stub.close();
  }
});

test("a reply whose last line is the bare code is read as final", needsTls, async () => {
  const stub = await smtpStub({ starttls: true, auth: "PLAIN", bareFinalLine: true });
  try {
    const mailer = createSmtpMailer(parseSmtpUrl(`smtp://u:p@127.0.0.1:${stub.port}`), FROM, { ca: certificate!.cert });
    assert.deepEqual(await mailer.send(sample), { outcome: "delivered", status: 250, error: null });
    assert.equal(stub.messages.length, 1);
  } finally {
    await stub.close();
  }
});

test("smtps:// is TLS from the start and signs in with AUTH LOGIN; an untrusted certificate is an operator problem", needsTls, async () => {
  const stub = await smtpStub({ implicitTls: true, auth: "LOGIN" });
  try {
    const config = parseSmtpUrl(`smtps://user:secret@127.0.0.1:${stub.port}`);
    assert.deepEqual(await createSmtpMailer(config, FROM, { ca: certificate!.cert }).send(sample), { outcome: "delivered", status: 250, error: null });
    assert.deepEqual(stub.credentials, ["user", "secret"]);
    assert.ok(stub.commands.every((command) => command.secure));
    const untrusted = await createSmtpMailer(config, FROM).send(sample);
    assert.equal(untrusted.error, "smtp_operator");
    assert.equal(untrusted.operator, true);
    assert.equal(stub.messages.length, 1);
  } finally {
    await stub.close();
  }
});

test("only RCPT TO and DATA replies count against a rule; earlier failures are the operator's", needsTls, async () => {
  const cases: Array<[Partial<Record<Stage, number>>, { outcome: string; error: string; status: number; operator?: boolean }]> = [
    [{ rcpt: 550 }, { outcome: "dead", error: "smtp_rejected", status: 550 }],
    [{ rcpt: 451 }, { outcome: "retry", error: "smtp_deferred", status: 451 }],
    [{ data: 554 }, { outcome: "dead", error: "smtp_rejected", status: 554 }],
    [{ data: 452 }, { outcome: "retry", error: "smtp_deferred", status: 452 }],
    [{ auth: 535 }, { outcome: "retry", error: "smtp_operator", status: 535, operator: true }],
    [{ mail: 553 }, { outcome: "retry", error: "smtp_operator", status: 553, operator: true }],
  ];
  for (const [fail, expected] of cases) {
    const stub = await smtpStub({ starttls: true, auth: "PLAIN", fail });
    try {
      const result = await createSmtpMailer(parseSmtpUrl(`smtp://u:p@127.0.0.1:${stub.port}`), FROM, { ca: certificate!.cert }).send(sample);
      assert.deepEqual(result, expected, JSON.stringify(fail));
    } finally {
      await stub.close();
    }
  }
  // Nobody listening: the operator's problem, retried.
  const closed = net.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((done) => closed.close(() => done()));
  const refused = await createSmtpMailer(parseSmtpUrl(`smtp://127.0.0.1:${port}`), FROM).send(sample);
  assert.deepEqual(refused, { outcome: "retry", status: 0, error: "smtp_operator", operator: true });
});

test("classification uses the stage and code only", () => {
  assert.equal(classifyWakeMailError(new SmtpError("rcpt", 550)).outcome, "dead");
  assert.equal(classifyWakeMailError(new SmtpError("connect", 0)).operator, true);
  assert.equal(classifyWakeMailError(new SmtpError("greeting", 554)).operator, true);
  assert.equal(classifyWakeMailError(new Error("anything")).error, "smtp_operator");
});

test("the message is plain-text MIME: quoted-printable, encoded words, dot-stuffing", () => {
  assert.equal(dotStuff(".a\r\nb\r\n..c\r\n."), "..a\r\nb\r\n...c\r\n..");
  assert.equal(quotedPrintable("a=b é \t"), "a=3Db =C3=A9 =09");
  assert.ok(quotedPrintable("y".repeat(200)).split("\r\n").every((line) => line.length <= 76));
  const mime = buildMimeMessage({ from: "notify@letagents.chat", to: "a@example.com", subject: "Plain\r\nBcc: x@example.com", text: "hi" }, new Date("2026-11-04T10:00:00Z"));
  assert.match(mime, /^From: notify@letagents\.chat$/m);
  assert.match(mime, /^Subject: Plain Bcc: x@example\.com$/m, "a subject cannot add headers");
  assert.doesNotMatch(mime, /^Bcc:/m);
  assert.match(mime, /^Date: Wed, 04 Nov 2026 10:00:00 \+0000$/m);
  assert.match(mime, /^Message-ID: <[0-9a-f-]+@letagents\.chat>$/m);
});

test("a confirmation is fixed wording: no agent or room name, only the room link and the two links", () => {
  const confirmUrl = "https://letagents.chat/wake-rules/confirm/" + "c".repeat(64);
  const mail = composeWakeEmail({ purpose: "confirm", to: "bot-inbox@example.com", roomUrl: "https://letagents.chat/in/free-money", disableUrl, confirmUrl });
  assert.equal(mail.subject, "[LetAgents] Confirm email notifications");
  assert.ok(mail.text.includes("The room: https://letagents.chat/in/free-money"));
  assert.ok(mail.text.includes(confirmUrl));
  assert.ok(mail.text.includes(disableUrl));
  assert.equal(mail.headers["List-Unsubscribe"], `<${disableUrl}>`);
  // A message email, sent only after confirmation, names the agent and the room.
  assert.equal(sample.subject, "[LetAgents] New message for relaybot in Déploiements");
  assert.match(sample.text, /^From: Ada$/m);
  assert.match(sample.text, /^Message: msg_42$/m);
  assert.ok(sample.text.includes(`Stop these emails: ${disableUrl}`));
});

test("email is configured only by both settings; a bad SMTP URL is reported without its value", () => {
  assert.equal(wakeEmailConfigured({}), false);
  assert.equal(wakeEmailConfigured({ [EMAIL_SMTP_URL_ENV]: "smtps://u:p@smtp.example.com:465" }), false);
  assert.equal(wakeEmailConfigured({ [EMAIL_FROM_ENV]: FROM }), false);
  const env = { [EMAIL_SMTP_URL_ENV]: "smtps://u:p@smtp.example.com:465", [EMAIL_FROM_ENV]: FROM };
  assert.equal(wakeEmailConfigured(env), true);
  assert.equal(loadWakeMailer({}), null);
  assert.ok(loadWakeMailer(env));
  assert.deepEqual(parseSmtpUrl("smtp://mail.example.com"), { secure: false, host: "mail.example.com", port: 587, username: null, password: null });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try {
    assert.equal(loadWakeMailer({ [EMAIL_SMTP_URL_ENV]: "imap://user:hunter2@mail.example.com", [EMAIL_FROM_ENV]: FROM }), null);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.includes("hunter2") || logged[0]!.includes("mail.example.com"), false);
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

test("one mailbox is one budget: case, plus tags and Gmail dots do not make a new address", () => {
  const cipher = createConnectorCipher(randomBytes(32).toString("hex"));
  const fingerprint = (to: string) => wakeEmailAddressFingerprint(cipher, parseWakeRuleEmail({ to }).to);
  const victim = fingerprint("victim@gmail.com");
  for (const variant of ["Victim@gmail.com", "victim+1@gmail.com", "victim+2@gmail.com", "v.ictim@gmail.com", "vi.c.tim+x@GoogleMail.com"]) {
    assert.equal(fingerprint(variant), victim, variant);
  }
  assert.equal(wakeEmailMailboxKey("V.Ictim+tag@googlemail.com"), "victim@gmail.com");
  // Plus tags go for every domain; dots only where the provider ignores them.
  assert.equal(wakeEmailMailboxKey("Ops+bots@Example.com"), "ops@example.com");
  assert.equal(wakeEmailMailboxKey("first.last@example.com"), "first.last@example.com");
  assert.notEqual(fingerprint("first.last@example.com"), fingerprint("firstlast@example.com"));
  assert.notEqual(fingerprint("victim@gmail.com"), fingerprint("victim@example.com"));
  // The sealed address stays as written: only the fingerprint is normalized.
  assert.deepEqual(parseWakeRuleEmail({ to: "V.ictim+1@gmail.com" }), { to: "V.ictim+1@gmail.com" });
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
