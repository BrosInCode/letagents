import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  buildApnsPayload,
  createApnsProviderToken,
  shouldRefreshApnsProviderToken,
  type ApnsCredentials,
} from "../apns-client.js";
import { classifyApnsResult } from "../delivery-policy.js";

function credentials(): { credentials: ApnsCredentials; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentials: {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      topic: "chat.letagents.desktop",
    },
    publicKey,
  };
}

test("creates a valid ES256 APNs provider token", () => {
  const input = credentials();
  const token = createApnsProviderToken(input.credentials, 1_700_000_000);
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: "TEAM123456", iat: 1_700_000_000 });
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.equal(verify(
    "SHA256",
    Buffer.from(`${header}.${claims}`),
    { key: input.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  ), true);
});

test("builds a grouped, routable alert payload within the APNs size limit", () => {
  const payload = buildApnsPayload({
    notificationId: "la_device_room_2a",
    deviceToken: "a".repeat(64),
    environment: "production",
    roomId: "github.com/acme/project",
    roomDisplayName: "Project Room",
    messageId: "msg_42",
    threadRootId: "msg_40",
    sender: "agent-name | owner",
    body: "🚀".repeat(2_000),
  });
  assert.equal(Buffer.byteLength(JSON.stringify(payload)) < 4_096, true);
  assert.deepEqual(payload.letagents, {
    notification_id: "la_device_room_2a",
    room_id: "github.com/acme/project",
    message_id: "msg_42",
    thread_root_id: "msg_40",
  });
  assert.equal((payload.aps as Record<string, unknown>)["thread-id"], "github.com/acme/project");
});

test("classifies APNs responses for idempotent retry and token retirement", () => {
  assert.equal(classifyApnsResult({ status: 200, reason: null, apnsId: "id" }), "delivered");
  assert.equal(classifyApnsResult({ status: 503, reason: "ServiceUnavailable", apnsId: null }), "retry");
  assert.equal(classifyApnsResult({ status: 403, reason: "ExpiredProviderToken", apnsId: null }), "retry");
  assert.equal(classifyApnsResult({ status: 403, reason: "InvalidProviderToken", apnsId: null }), "retry");
  assert.equal(shouldRefreshApnsProviderToken({ status: 403 }), true);
  assert.equal(shouldRefreshApnsProviderToken({ status: 503 }), false);
  assert.equal(classifyApnsResult({ status: 410, reason: "Unregistered", apnsId: null }), "disable-device");
  assert.equal(classifyApnsResult({ status: 400, reason: "PayloadEmpty", apnsId: null }), "dead");
});
