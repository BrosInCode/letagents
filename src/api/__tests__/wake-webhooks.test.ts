import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { WAKE_RULE_LIMITS, WakeRuleError, parseWakeRuleInput, parseWakeRuleWebhook } from "../../../shared/wake-rules.mjs";
import {
  afterFinalWakeWebhookFailure,
  buildWakeWebhookBody,
  planWakeWebhookEnqueue,
  signWakeWebhook,
  wakeWebhookHeaders,
  wakeWebhookRoomUrl,
  wakeWebhookTextPreview,
} from "../wake-rules/webhook-delivery.js";
import { isOwnWakeWebhookMessage, matchWakeWebhookRules, type WakeWebhookMessageFacts } from "../wake-rules/webhook-match.js";
import {
  WakeWebhookResolveError,
  WakeWebhookUrlError,
  allowLoopbackHttpWakeWebhooksForTests,
  assertWakeWebhookUrl,
  classifyWakeWebhookStatus,
  parseWakeWebhookUrl,
  postWakeWebhook,
  refusedWebhookAddress,
  resolveWakeWebhookAddress,
  type WakeWebhookLookup,
} from "../wake-rules/webhook-url.js";

const payload = {
  delivery_id: "whd_1",
  room_id: "github.com/org/repo",
  message_id: "msg_42",
  sender: "Ada",
  text_preview: "@relaybot can you look at the deploy?",
  room_url: "https://letagents.chat/in/github.com/org/repo",
  rule_id: "wake_abc",
  sent_at: "2026-11-03T10:00:00.000Z",
};

test("the signature is HMAC-SHA256 over \"<timestamp>.<raw body>\" with the rule's secret", () => {
  const body = buildWakeWebhookBody(payload);
  const secret = "s3cret-for-the-receiver";
  const timestamp = 1793700000;
  const signature = signWakeWebhook(secret, timestamp, body);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signature, `sha256=${expected}`);
  // Any change to the body, the timestamp or the secret changes it.
  assert.notEqual(signWakeWebhook(secret, timestamp + 1, body), signature);
  assert.notEqual(signWakeWebhook(secret, timestamp, body.replace("deploy", "Deploy")), signature);
  assert.notEqual(signWakeWebhook(`${secret}x`, timestamp, body), signature);
  assert.deepEqual(JSON.parse(body), payload);

  const headers = wakeWebhookHeaders({ deliveryId: "whd_1", timestamp, signature });
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-LetAgents-Timestamp"], String(timestamp));
  assert.equal(headers["X-LetAgents-Signature"], signature);
  assert.equal(headers["X-LetAgents-Delivery"], "whd_1");
});

test("the body stays within 4 KB and the preview within 200 characters", () => {
  const preview = wakeWebhookTextPreview(`line one\nline two ${"é".repeat(400)}`);
  assert.equal(Array.from(preview).length, 200);
  assert.ok(preview.endsWith("…"));
  assert.equal(preview.includes("\n"), false);
  const body = buildWakeWebhookBody({ ...payload, sender: "😀".repeat(3000), text_preview: "😀".repeat(3000) });
  assert.ok(Buffer.byteLength(body) <= 4096, `body is ${Buffer.byteLength(body)} bytes`);
  assert.equal(JSON.parse(body).room_id, payload.room_id);
  assert.equal(wakeWebhookRoomUrl("github.com/Org/my repo", "https://letagents.chat/"), "https://letagents.chat/in/github.com/Org/my%20repo");
});

test("refuses loopback, private, link-local, multicast, unspecified and reserved addresses", () => {
  const refused: Array<[string, string]> = [
    ["127.0.0.1", "loopback"], ["127.255.0.9", "loopback"], ["::1", "loopback"],
    ["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.1", "private"],
    ["100.64.0.1", "private"], ["fc00::1", "private"], ["fd12:3456::1", "private"], ["fec0::1", "private"],
    ["169.254.169.254", "link-local"], ["fe80::1", "link-local"], ["febf::1", "link-local"],
    ["224.0.0.1", "multicast"], ["239.255.255.250", "multicast"], ["ff02::1", "multicast"],
    ["0.0.0.0", "unspecified"], ["::", "unspecified"],
    ["255.255.255.255", "reserved"], ["240.0.0.1", "reserved"], ["192.0.2.1", "reserved"], ["2001:db8::1", "reserved"],
    // IPv4 written inside IPv6 is judged by the IPv4 rules.
    ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "link-local"], ["64:ff9b::a00:1", "private"], ["2002:c0a8:101::1", "private"],
    ["::127.0.0.1", "reserved"], ["2001::1", "reserved"], ["4000::1", "reserved"], ["fe80::1%en0", "reserved"],
    ["not-an-address", "reserved"],
  ];
  for (const [address, kind] of refused) assert.equal(refusedWebhookAddress(address), kind, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
    assert.equal(refusedWebhookAddress(address), null, address);
  }
});

test("a webhook URL must be https, without credentials, and resolve only to public addresses", async () => {
  assert.throws(() => parseWakeWebhookUrl("http://hooks.example.com/x"), /must use https/);
  assert.throws(() => parseWakeWebhookUrl("ftp://hooks.example.com/x"), /must use https/);
  assert.throws(() => parseWakeWebhookUrl("https://user:pw@hooks.example.com/x"), /user name or password/);
  assert.throws(() => parseWakeWebhookUrl("https://localhost/x"), /public address/);
  assert.throws(() => parseWakeWebhookUrl("not a url"), WakeWebhookUrlError);
  assert.equal(parseWakeWebhookUrl("https://hooks.example.com/x?a=1#frag").href, "https://hooks.example.com/x?a=1");
  // Literal and normalized forms of private hosts never reach DNS.
  for (const url of ["https://127.0.0.1/x", "https://[::1]/x", "https://2130706433/x", "https://0x7f.1/x", "https://[::ffff:10.0.0.1]/x", "https://169.254.169.254/latest"]) {
    await assert.rejects(assertWakeWebhookUrl(url, async () => { throw new Error("no DNS for literals"); }), WakeWebhookUrlError, url);
  }

  const resolver = (answers: Record<string, string[]>): WakeWebhookLookup => async (host) => {
    const found = answers[host];
    if (!found) throw new Error("ENOTFOUND");
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const lookup = resolver({
    "hooks.example.com": ["93.184.216.34", "2606:2800:220:1::1"],
    "rebind.example.com": ["93.184.216.34", "10.0.0.5"],
    "internal.example.com": ["fd00::5"],
    "metadata.example.com": ["169.254.169.254"],
  });
  assert.deepEqual(await resolveWakeWebhookAddress(new URL("https://hooks.example.com/x"), lookup), { address: "93.184.216.34", family: 4 });
  // One private answer among public ones refuses the name; it is not filtered out.
  await assert.rejects(resolveWakeWebhookAddress(new URL("https://rebind.example.com/x"), lookup), /resolves to a private address/);
  await assert.rejects(resolveWakeWebhookAddress(new URL("https://internal.example.com/x"), lookup), /private address/);
  await assert.rejects(resolveWakeWebhookAddress(new URL("https://metadata.example.com/x"), lookup), /link-local address/);
  await assert.rejects(resolveWakeWebhookAddress(new URL("https://missing.example.com/x"), lookup), WakeWebhookResolveError);
});

async function stub(handler: (request: IncomingMessage, body: string) => { status: number; delayMs?: number; headers?: Record<string, string> }) {
  const received: Array<{ headers: IncomingMessage["headers"]; body: string; url: string }> = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ headers: request.headers, body, url: request.url ?? "" });
      const reply = handler(request, body);
      setTimeout(() => {
        response.writeHead(reply.status, reply.headers);
        response.end("x".repeat(100_000));
      }, reply.delayMs ?? 0);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, received, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

test("a delivery connects to the address that was checked, follows no redirect and reads only the status", async () => {
  allowLoopbackHttpWakeWebhooksForTests(true);
  const statuses = [204, 302, 503];
  const server = await stub(() => ({ status: statuses.shift() ?? 200, headers: { Location: "https://elsewhere.example.com/" } }));
  try {
    // The name does not exist in DNS: the request reaches the stub only through the pinned address.
    const lookup: WakeWebhookLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    const url = `http://pinned.invalid:${server.port}/hook?k=1`;
    const send = () => postWakeWebhook({ url, body: "{\"a\":1}", headers: { "Content-Type": "application/json" }, lookup });
    assert.deepEqual(await send(), { outcome: "delivered", status: 204, error: null });
    assert.equal(server.received[0]!.headers.host, `pinned.invalid:${server.port}`);
    assert.equal(server.received[0]!.url, "/hook?k=1");
    assert.equal(server.received[0]!.body, "{\"a\":1}");
    const redirected = await send();
    assert.equal(redirected.outcome, "dead");
    assert.match(redirected.error!, /redirects are not followed/);
    assert.equal((await send()).outcome, "retry");
    assert.equal(server.received.length, 3, "the redirect was not followed");

    // A private answer is refused even while loopback is allowed for this stub.
    const refused = await postWakeWebhook({ url, body: "{}", headers: {}, lookup: async () => [{ address: "10.0.0.7", family: 4 }] });
    assert.equal(refused.outcome, "dead");
    assert.match(refused.error!, /private address/);
    // Without the test switch, http and loopback are refused outright.
    allowLoopbackHttpWakeWebhooksForTests(false);
    const plain = await postWakeWebhook({ url, body: "{}", headers: {}, lookup });
    assert.equal(plain.outcome, "dead");
    assert.match(plain.error!, /must use https/);
    assert.equal(server.received.length, 3);
    const big = await postWakeWebhook({ url: "https://hooks.example.com/x", body: "x".repeat(5000), headers: {} });
    assert.equal(big.outcome, "dead");
  } finally {
    allowLoopbackHttpWakeWebhooksForTests(false);
    await server.close();
  }
});

test("a receiver that does not answer in time is retried", async () => {
  allowLoopbackHttpWakeWebhooksForTests(true);
  const server = await stub(() => ({ status: 200, delayMs: 2_000 }));
  try {
    const result = await postWakeWebhook({
      url: `http://127.0.0.1:${server.port}/slow`, body: "{}", headers: {}, timeoutMs: 150,
    });
    assert.equal(result.outcome, "retry");
    assert.match(result.error!, /No response within/);
  } finally {
    allowLoopbackHttpWakeWebhooksForTests(false);
    await server.close();
  }
});

test("network errors and 5xx retry; 4xx and redirects are final", () => {
  assert.equal(classifyWakeWebhookStatus(200), "delivered");
  assert.equal(classifyWakeWebhookStatus(299), "delivered");
  assert.equal(classifyWakeWebhookStatus(0), "retry");
  assert.equal(classifyWakeWebhookStatus(500), "retry");
  assert.equal(classifyWakeWebhookStatus(503), "retry");
  assert.equal(classifyWakeWebhookStatus(301), "dead");
  assert.equal(classifyWakeWebhookStatus(400), "dead");
  assert.equal(classifyWakeWebhookStatus(404), "dead");
  assert.equal(classifyWakeWebhookStatus(429), "dead");
});

test("matches within 10 s fold into one delivery that carries the newest message", () => {
  const t0 = Date.parse("2026-11-03T10:00:00Z");
  // A quiet rule sends the first match at once.
  assert.deepEqual(planWakeWebhookEnqueue({ nowMs: t0, pendingDeliveryId: null, lastScheduledAtMs: null, startedInLastHour: 0 }), { kind: "insert", scheduledAtMs: t0 });
  // A match 3 s later starts the next delivery at the end of the window...
  assert.deepEqual(planWakeWebhookEnqueue({ nowMs: t0 + 3_000, pendingDeliveryId: null, lastScheduledAtMs: t0, startedInLastHour: 1 }),
    { kind: "insert", scheduledAtMs: t0 + WAKE_RULE_LIMITS.webhookCoalesceMs });
  // ...and every match until then folds into it.
  assert.deepEqual(planWakeWebhookEnqueue({ nowMs: t0 + 5_000, pendingDeliveryId: "whd_2", lastScheduledAtMs: t0 + 10_000, startedInLastHour: 2 }),
    { kind: "coalesce", deliveryId: "whd_2" });
  // After a quiet window a match goes out at once again.
  assert.deepEqual(planWakeWebhookEnqueue({ nowMs: t0 + 25_000, pendingDeliveryId: null, lastScheduledAtMs: t0 + 10_000, startedInLastHour: 2 }),
    { kind: "insert", scheduledAtMs: t0 + 25_000 });
});

test("at most 20 deliveries per rule per hour; later matches are dropped unless one is waiting", () => {
  const nowMs = Date.parse("2026-11-03T10:00:00Z");
  assert.equal(WAKE_RULE_LIMITS.webhookHourlyCap, 20);
  assert.equal(planWakeWebhookEnqueue({ nowMs, pendingDeliveryId: null, lastScheduledAtMs: nowMs - 60_000, startedInLastHour: 19 }).kind, "insert");
  assert.deepEqual(planWakeWebhookEnqueue({ nowMs, pendingDeliveryId: null, lastScheduledAtMs: nowMs - 60_000, startedInLastHour: 20 }), { kind: "drop" });
  assert.deepEqual(planWakeWebhookEnqueue({ nowMs, pendingDeliveryId: "whd_9", lastScheduledAtMs: nowMs, startedInLastHour: 20 }), { kind: "coalesce", deliveryId: "whd_9" });
});

test("a rule pauses on its fifth final failure in a row", () => {
  let failures = 0;
  const pauses: boolean[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = afterFinalWakeWebhookFailure(failures);
    failures = next.consecutiveFailures;
    pauses.push(next.pause);
  }
  assert.deepEqual(pauses, [false, false, false, false, true]);
});

const bot = { id: "wake_bot", agent_key: "acct-a/relaybot", agent_name: "relaybot", arguments: { mentions_me: true as const } };
const watcher = { id: "wake_all", agent_key: "acct-a/watcher", agent_name: "watcher", arguments: { any: true as const } };

function facts(overrides: Partial<WakeWebhookMessageFacts> = {}): WakeWebhookMessageFacts {
  const text = overrides.text ?? "hello room";
  return {
    sender: "Ada", source: "browser", publisher_agent_key: null, thread_root_number: null, text,
    promptOnly: false, restricted: false, addressedAgentKey: null, recipientAgentKeys: new Set(), activeIdentities: [],
    routingMessage: { id: "msg_5", sender: overrides.sender ?? "Ada", text, source: overrides.source ?? "browser" },
    ...overrides,
  };
}

test("an agent's own messages never deliver, by identity or by name", () => {
  const own = facts({ sender: "relaybot | acct-a | Bot", source: "agent", publisher_agent_key: bot.agent_key, text: "@relaybot note to self",
    recipientAgentKeys: new Set([bot.agent_key]) });
  assert.equal(isOwnWakeWebhookMessage(bot, own), true);
  assert.deepEqual(matchWakeWebhookRules([bot], own), []);
  assert.deepEqual(matchWakeWebhookRules([{ ...watcher, agent_key: bot.agent_key }], own), [], "any skips its own messages too");
  // An older agent post without an authenticated identity is matched by name.
  assert.equal(isOwnWakeWebhookMessage(bot, { sender: "relaybot | acct-a | Bot", source: "agent", publisher_agent_key: null }), true);
  // A person who shares the name is not the agent.
  assert.equal(isOwnWakeWebhookMessage(bot, { sender: "relaybot", source: "browser", publisher_agent_key: null }), false);
  // Another agent's message is not this agent's.
  assert.equal(isOwnWakeWebhookMessage(bot, { sender: "Fable", source: "agent", publisher_agent_key: "acct-b/fable" }), false);
});

test("mentions_me follows routing; any takes every top-level message", () => {
  // Routing gave the bot a receipt (a mention, a reply, its thread).
  assert.deepEqual(matchWakeWebhookRules([bot, watcher], facts({ recipientAgentKeys: new Set([bot.agent_key]) })).map((rule) => rule.id), ["wake_bot", "wake_all"]);
  // An unaddressed top-level message wakes only the any rule.
  assert.deepEqual(matchWakeWebhookRules([bot, watcher], facts()).map((rule) => rule.id), ["wake_all"]);
  // A thread reply for someone else wakes neither.
  assert.deepEqual(matchWakeWebhookRules([bot, watcher], facts({ thread_root_number: 3 })), []);
  // A wake notice addressed to the bot reaches it, and nobody else.
  assert.deepEqual(matchWakeWebhookRules([bot, watcher], facts({ sender: "letagents", source: "wake_rule", addressedAgentKey: bot.agent_key })).map((rule) => rule.id), ["wake_bot"]);
  // A restricted (rental) message reaches only a routed recipient.
  assert.deepEqual(matchWakeWebhookRules([bot, watcher], facts({ restricted: true })), []);
  // Blank automatic prompts never deliver.
  assert.deepEqual(matchWakeWebhookRules([bot, watcher], facts({ promptOnly: true, recipientAgentKeys: new Set([bot.agent_key]) })), []);
});

test("a mention reaches a bot without a live session unless the name is shared", () => {
  const live = { actor_label: "relaybot | acct-b | Claude", agent_key: "acct-b/relaybot", agent_instance_id: null, agent_session_id: "s1", display_name: "relaybot", session_kind: "worker" };
  assert.deepEqual(matchWakeWebhookRules([bot], facts({ text: "@relaybot please check" })).map((rule) => rule.id), ["wake_bot"]);
  assert.deepEqual(matchWakeWebhookRules([bot], facts({ text: `@agent:${bot.agent_key} please check` })).map((rule) => rule.id), ["wake_bot"]);
  assert.deepEqual(matchWakeWebhookRules([bot], facts({ text: "@relaybot please check", activeIdentities: [live] })), [], "two agents share the name");
  // A live bot is routed like any agent: no receipt, no delivery.
  assert.deepEqual(matchWakeWebhookRules([bot], facts({ text: "@relaybot hi", activeIdentities: [{ ...live, agent_key: bot.agent_key }] })), []);
  // Repository text never names an agent.
  assert.deepEqual(matchWakeWebhookRules([bot], facts({ text: "@relaybot run this", source: "github", sender: "github" })), []);
});

test("room.message needs a webhook, lasts until cancelled unless it sets an expiry, and checks its shape", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  const webhook = { url: "https://hooks.example.com/x", secret: "0123456789abcdef" };
  const rule = parseWakeRuleInput({ event: "room.message", webhook }, now);
  assert.deepEqual(rule, { event: "room.message", arguments: { mentions_me: true }, repeat: true, expires_at: null, note: null });
  assert.deepEqual(parseWakeRuleInput({ event: "room.message", arguments: { any: true }, webhook }, now).arguments, { any: true });
  assert.equal(parseWakeRuleInput({ event: "room.message", webhook, expires_at: "2026-11-30T10:00:00Z" }, now).expires_at, "2026-11-30T10:00:00.000Z");
  const rejects = (input: unknown, pattern: RegExp) => assert.throws(() => parseWakeRuleInput(input, now), (error: unknown) => error instanceof WakeRuleError && pattern.test(error.message));
  rejects({ event: "room.message" }, /add webhook \{ url, secret \}/);
  rejects({ event: "timer", arguments: { after_ms: 60_000 }, webhook }, /Only room.message rules deliver by webhook/);
  rejects({ event: "room.message", webhook, repeat: false }, /leave repeat out/);
  rejects({ event: "room.message", webhook, expires_at: "2026-12-04T10:00:01Z" }, /at most 30 days/);
  rejects({ event: "room.message", webhook, arguments: { mentions_me: true, any: true } }, /not both/);
  rejects({ event: "room.message", webhook, arguments: { from: "EmmyMay" } }, /does not accept from/);
  assert.deepEqual(parseWakeRuleWebhook(webhook), webhook);
  assert.throws(() => parseWakeRuleWebhook({ url: webhook.url, secret: "short" }), /16 to 256 printable characters/);
  assert.throws(() => parseWakeRuleWebhook({ url: webhook.url, secret: "has spaces in it ok" }), /without spaces/);
  assert.throws(() => parseWakeRuleWebhook({ url: webhook.url, secret: webhook.secret, headers: {} }), /does not accept headers/);
  assert.throws(() => parseWakeRuleWebhook("https://hooks.example.com"), /object with url and secret/);
});
