import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { WAKE_RULE_LIMITS } from "../../../shared/wake-rules.mjs";
import {
  MCP_EVENT_DEFINITIONS,
  MCP_EVENTS_INVALID_PARAMS,
  McpEventsError,
  buildMcpEventBody,
  buildMcpVerificationBody,
  canonicalJson,
  grantMcpEventTtlMs,
  mcpCallbackReason,
  mcpChallengeAnswered,
  mcpEventHeaders,
  mcpEventId,
  mcpEventSignature,
  mcpEventSubscriptionId,
  parseMcpEventCursor,
  parseMcpEventSecret,
  parseMcpRoomMessageArguments,
  verifyMcpEventSignature,
} from "../wake-rules/mcp-events.js";
import { webhookOutcome } from "../wake-rules/webhook-delivery.js";
import { classifyWakeWebhookStatus, isThrottlingStatus } from "../wake-rules/webhook-url.js";

// Known answer: 32 key bytes 0x01..0x20, a fixed id, timestamp and body.
const KEY_B64 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const SECRET = `whsec_${KEY_B64}`;
const ID = "evt_3f9c1a2b3c4d5e6f70818293_42";
const TIMESTAMP = 1793700000;
const ENVELOPE = {
  eventId: ID,
  name: "room.message",
  timestamp: "2026-11-03T10:00:00.000Z",
  data: {
    room_id: "github.com/org/repo",
    message_id: "msg_42",
    sender: "Ada",
    text_preview: "@relaybot can you look at the deploy?",
    room_url: "https://letagents.chat/in/github.com/org/repo",
  },
  cursor: "42",
};
const KNOWN_SIGNATURE = "v1,IXA/Q7t83o4BfdsGHs/hnvUunz8rFYsN4/o4A60m9gs=";

/** A receiver written from the Standard Webhooks description alone. */
function receiverVerifies(secret: string, headers: Record<string, string>, body: string): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
  return headers["webhook-signature"].split(" ").some((part) => part === `v1,${expected}`);
}

function refusal(run: () => unknown): McpEventsError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof McpEventsError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

test("the signature is Standard Webhooks: v1, base64 HMAC-SHA256 of \"<id>.<timestamp>.<body>\" under the decoded secret", () => {
  const body = buildMcpEventBody(ENVELOPE);
  assert.equal(body, JSON.stringify(ENVELOPE), "serialized once, keys in envelope order");
  const key = parseMcpEventSecret(SECRET);
  const signature = mcpEventSignature([key], ID, TIMESTAMP, body);
  assert.equal(signature, KNOWN_SIGNATURE);
  assert.equal(signature, `v1,${createHmac("sha256", Buffer.from(KEY_B64, "base64")).update(`${ID}.${TIMESTAMP}.${body}`).digest("base64")}`);
  // Any change to the id, the timestamp, the body or the key changes it.
  assert.notEqual(mcpEventSignature([key], `${ID}x`, TIMESTAMP, body), signature);
  assert.notEqual(mcpEventSignature([key], ID, TIMESTAMP + 1, body), signature);
  assert.notEqual(mcpEventSignature([key], ID, TIMESTAMP, body.replace("deploy", "Deploy")), signature);
  assert.notEqual(mcpEventSignature([parseMcpEventSecret(`whsec_${Buffer.alloc(32, 9).toString("base64")}`)], ID, TIMESTAMP, body), signature);

  const headers = mcpEventHeaders({ id: ID, timestamp: TIMESTAMP, signature, subscriptionId: "sub_abc" });
  assert.deepEqual(Object.keys(headers).sort(), ["Content-Type", "User-Agent", "X-MCP-Subscription-Id", "webhook-id", "webhook-signature", "webhook-timestamp"]);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["webhook-id"], ID);
  assert.equal(headers["webhook-timestamp"], String(TIMESTAMP));
  assert.equal(headers["X-MCP-Subscription-Id"], "sub_abc");
  assert.equal(receiverVerifies(SECRET, headers, body), true);
  assert.equal(receiverVerifies(SECRET, headers, `${body} `), false);
  assert.equal(verifyMcpEventSignature(SECRET, ID, TIMESTAMP, body, signature), true);
  assert.equal(verifyMcpEventSignature(SECRET, ID, TIMESTAMP, body, "v1,AAAA"), false);

  // During a rotation both keys sign; a receiver with either secret accepts.
  const other = `whsec_${Buffer.alloc(48, 3).toString("base64")}`;
  const both = mcpEventSignature([parseMcpEventSecret(other), key], ID, TIMESTAMP, body);
  assert.equal(both.split(" ").length, 2);
  assert.ok(both.endsWith(` ${KNOWN_SIGNATURE}`));
  assert.equal(verifyMcpEventSignature(SECRET, ID, TIMESTAMP, body, both), true);
  assert.equal(verifyMcpEventSignature(other, ID, TIMESTAMP, body, both), true);
  assert.throws(() => mcpEventSignature([], ID, TIMESTAMP, body));
});

test("a secret is whsec_ and standard base64 of 24 to 64 bytes; anything else is a bad parameter", () => {
  for (const bytes of [24, 32, 64]) {
    assert.equal(parseMcpEventSecret(`whsec_${Buffer.alloc(bytes, 7).toString("base64")}`).length, bytes);
  }
  for (const bad of [
    `whsec_${Buffer.alloc(23, 7).toString("base64")}`,
    `whsec_${Buffer.alloc(65, 7).toString("base64")}`,
    `secret_${Buffer.alloc(32, 7).toString("base64")}`,
    Buffer.alloc(32, 7).toString("base64"),
    "whsec_!!!not-base64!!!",
    `whsec_${Buffer.alloc(32, 250).toString("base64url")}`,
    "whsec_",
    `whsec_${Buffer.alloc(32, 7).toString("base64")}=`,
    42,
    null,
    undefined,
  ]) {
    const error = refusal(() => parseMcpEventSecret(bad));
    assert.equal(error.code, MCP_EVENTS_INVALID_PARAMS, String(bad));
    assert.match(error.message, /whsec_/);
  }
});

test("the subscription id follows the principal, URL, event and canonical arguments; key order does not matter", () => {
  const a = mcpEventSubscriptionId("hash-a", "https://hooks.example.com/x", "room.message", { room_id: "r", mentions_me: true, worker_id: "w" });
  const b = mcpEventSubscriptionId("hash-a", "https://hooks.example.com/x", "room.message", { worker_id: "w", mentions_me: true, room_id: "r" });
  assert.equal(a, b);
  assert.match(a, /^sub_[0-9a-f]{32}$/);
  assert.notEqual(a, mcpEventSubscriptionId("hash-b", "https://hooks.example.com/x", "room.message", { room_id: "r", mentions_me: true, worker_id: "w" }));
  assert.notEqual(a, mcpEventSubscriptionId("hash-a", "https://hooks.example.com/y", "room.message", { room_id: "r", mentions_me: true, worker_id: "w" }));
  assert.notEqual(a, mcpEventSubscriptionId("hash-a", "https://hooks.example.com/x", "room.other", { room_id: "r", mentions_me: true, worker_id: "w" }));
  assert.notEqual(a, mcpEventSubscriptionId("hash-a", "https://hooks.example.com/x", "room.message", { room_id: "r", any: true }));
  assert.equal(canonicalJson({ b: { d: 1, c: [{ z: 1, y: 2 }] }, a: null }), '{"a":null,"b":{"c":[{"y":2,"z":1}],"d":1}}');
});

test("room.message arguments: mentions_me is the default, any excludes it, include_agents needs any, worker_id is optional", () => {
  assert.deepEqual(parseMcpRoomMessageArguments({ room_id: " sky-owl " }), {
    canonical: { room_id: "sky-owl", mentions_me: true }, rule: { mentions_me: true },
  });
  assert.deepEqual(parseMcpRoomMessageArguments({ room_id: "r", mentions_me: true, worker_id: "wrk_1" }), {
    canonical: { room_id: "r", mentions_me: true, worker_id: "wrk_1" }, rule: { mentions_me: true },
  });
  assert.deepEqual(parseMcpRoomMessageArguments({ room_id: "r", any: true, include_agents: true }), {
    canonical: { room_id: "r", any: true, include_agents: true }, rule: { any: true, include_agents: true },
  });
  assert.deepEqual(parseMcpRoomMessageArguments({ room_id: "r", any: true, mentions_me: false, include_agents: false }), {
    canonical: { room_id: "r", any: true }, rule: { any: true },
  });
  for (const [bad, pattern] of [
    [{}, /room_id/],
    [{ room_id: 7 }, /room_id/],
    [{ room_id: "r", any: true, mentions_me: true }, /not both/],
    [{ room_id: "r", mentions_me: false }, /any: true/],
    [{ room_id: "r", include_agents: true }, /include_agents goes with any/],
    [{ room_id: "r", mentions_me: "yes" }, /true or false/],
    [{ room_id: "r", worker_id: "" }, /worker_id/],
    [{ room_id: "r", channel: "x" }, /does not accept channel/],
    [null, /object/],
    [[], /object/],
  ] as const) {
    const error = refusal(() => parseMcpRoomMessageArguments(bad));
    assert.equal(error.code, MCP_EVENTS_INVALID_PARAMS);
    assert.match(error.message, pattern);
  }
  // The catalog entry agrees with the parser.
  const [definition] = MCP_EVENT_DEFINITIONS;
  assert.equal(definition.name, "room.message");
  assert.deepEqual(definition.delivery, ["webhook"]);
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ["any", "include_agents", "mentions_me", "room_id", "worker_id"]);
  assert.deepEqual(definition.inputSchema.required, ["room_id"]);
  assert.deepEqual(Object.keys(definition.payloadSchema.properties).sort(), ["message_id", "room_id", "room_url", "sender", "text_preview", "thread_root_id"]);
});

test("the envelope has eventId, name, timestamp, data and cursor; the body is bounded to 256 KiB by shortening the preview", () => {
  assert.deepEqual(Object.keys(JSON.parse(buildMcpEventBody(ENVELOPE))), ["eventId", "name", "timestamp", "data", "cursor"]);
  const huge = buildMcpEventBody({ ...ENVELOPE, data: { ...ENVELOPE.data, text_preview: "x".repeat(300 * 1024) } });
  assert.ok(Buffer.byteLength(huge) <= WAKE_RULE_LIMITS.mcpEventMaxBodyBytes);
  const parsed = JSON.parse(huge);
  assert.equal(parsed.data.sender, "Ada");
  assert.ok(parsed.data.text_preview.length > 200_000, "the preview is cut, not dropped");
  assert.equal(mcpEventId("wake_3f9c1a2b3c4d5e6f7081", 42), "evt_3f9c1a2b3c4d5e6f7081_42");
  assert.doesNotMatch(mcpEventId("wake_a.b/c", 7), /[./]/);
  assert.equal(buildMcpVerificationBody("abc"), '{"type":"verification","challenge":"abc"}');
  assert.equal(mcpChallengeAnswered("abc", '{"challenge":"abc"}'), true);
  assert.equal(mcpChallengeAnswered("abc", '{"challenge":"abd"}'), false);
  assert.equal(mcpChallengeAnswered("abc", '{"challenge":"abcd"}'), false);
  assert.equal(mcpChallengeAnswered("abc", "not json"), false);
  assert.equal(mcpChallengeAnswered("abc", undefined), false);
  assert.equal(mcpChallengeAnswered("abc", '{"challenge":["abc"]}'), false);
});

test("ttlMs: the default when omitted, never more than asked, at least 5 minutes, at most 7 days; null is not granted", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(grantMcpEventTtlMs(undefined), 24 * hour);
  assert.equal(grantMcpEventTtlMs(null), 7 * 24 * hour);
  assert.equal(grantMcpEventTtlMs(hour), hour);
  assert.equal(grantMcpEventTtlMs(1000), 5 * 60 * 1000);
  assert.equal(grantMcpEventTtlMs(30 * 24 * hour), 7 * 24 * hour);
  assert.equal(grantMcpEventTtlMs(hour + 0.7), hour);
  for (const bad of ["3600000", -1, 0, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(refusal(() => grantMcpEventTtlMs(bad)).code, MCP_EVENTS_INVALID_PARAMS, String(bad));
  }
  assert.equal(parseMcpEventCursor(null), null);
  assert.equal(parseMcpEventCursor(undefined), null);
  assert.equal(parseMcpEventCursor("42"), 42);
  for (const bad of [42, "", "-1", "4.2", "abc", "99999999999"]) {
    assert.equal(refusal(() => parseMcpEventCursor(bad)).code, MCP_EVENTS_INVALID_PARAMS, String(bad));
  }
});

test("statuses: 410 and 413 are final, 425 and 503 retry; 425 waits uncounted, 503 honours Retry-After and counts", () => {
  assert.equal(classifyWakeWebhookStatus(410), "dead");
  assert.equal(classifyWakeWebhookStatus(413), "dead");
  assert.equal(classifyWakeWebhookStatus(425), "retry");
  assert.equal(classifyWakeWebhookStatus(429), "retry");
  assert.equal(classifyWakeWebhookStatus(503), "retry");
  assert.equal(isThrottlingStatus(425), true);
  assert.equal(isThrottlingStatus(503), false);
  assert.deepEqual(webhookOutcome({ outcome: "retry", status: 425, error: "http_throttled", throttled: true, retryAfterMs: 2000 }),
    { kind: "retry", status: 425, error: "http_throttled", holdMs: 2000, uncounted: true });
  assert.deepEqual(webhookOutcome({ outcome: "retry", status: 503, error: "http_5xx", retryAfterMs: 30_000 }),
    { kind: "retry", status: 503, error: "http_5xx", holdMs: 30_000 });
  assert.deepEqual(webhookOutcome({ outcome: "retry", status: 503, error: "http_5xx" }), { kind: "retry", status: 503, error: "http_5xx" });
  assert.deepEqual(webhookOutcome({ outcome: "dead", status: 413, error: "http_4xx" }), { kind: "failed", status: 413, error: "http_4xx" });
});

test("a failed verification is categorized, never described", () => {
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 0, error: "connect_failed" }), "connection_refused");
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 0, error: "dns_failed" }), "connection_refused");
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 0, error: "timeout" }), "timeout");
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 0, error: "dns_timeout" }), "timeout");
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 0, error: "tls_failed" }), "tls_error");
  assert.equal(mcpCallbackReason({ outcome: "dead", status: 404, error: "http_4xx" }), "http_4xx");
  assert.equal(mcpCallbackReason({ outcome: "dead", status: 302, error: "http_redirect" }), "http_4xx");
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 429, error: "http_throttled", throttled: true }), "http_4xx");
  assert.equal(mcpCallbackReason({ outcome: "retry", status: 503, error: "http_5xx" }), "http_5xx");
  assert.equal(mcpCallbackReason({ outcome: "dead", status: 0, error: "body_too_large" }), "challenge_failed");
});
