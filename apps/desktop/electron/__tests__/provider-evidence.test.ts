import assert from "node:assert/strict";
import test from "node:test";

import { safeStreamPayload } from "../main/agents/provider-evidence.js";

test("provider evidence recursively redacts credential-shaped keys and embedded tool output", () => {
  const canary = "canary-not-a-real-credential-123456789";
  const safe = safeStreamPayload({
    nested: [{ LETAGENTS_TOKEN: canary }, { api_key: canary }, { clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }],
    json: JSON.stringify({ LETAGENTS_TOKEN: canary }),
    env: `LETAGENTS_TOKEN=${canary}`,
    header: `Authorization: Bearer ${canary}`,
    basic: `Authorization: Basic ${canary}`,
    arbitraryAuthorization: `Authorization: ${canary}`,
    stringifiedHeaders: JSON.stringify({ bearer: `Authorization: Bearer ${canary}`, basic: `Authorization: Basic ${canary}`, arbitrary: `Authorization: ${canary}` }),
    stringifiedCamelCase: JSON.stringify({ clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }),
  });
  assert.equal(safe.payloadRedacted, true);
  assert.equal(safe.payloadTruncated, false);
  assert.doesNotMatch(JSON.stringify(safe.payload), new RegExp(canary));
  assert.match(JSON.stringify(safe.payload), /REDACTED/);
});

test("provider evidence bounds wide, large, cyclic, and unreadable payloads before serialization", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const unreadable = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("must not escape"); } });
  const safe = safeStreamPayload({
    large: Array.from({ length: 10_000 }, (_value, index) => index),
    wide: Object.fromEntries(Array.from({ length: 10_000 }, (_value, index) => [`field_${index}`, index])),
    cyclic,
    unreadable,
  });
  const payload = safe.payload as { large: unknown[]; wide: Record<string, unknown>; cyclic: { self: string }; unreadable: { secret: string } };
  assert.equal(safe.payloadTruncated, true);
  assert.equal(payload.large.length, 100);
  assert.equal(Object.keys(payload.wide).length, 100);
  assert.equal(payload.cyclic.self, "[CIRCULAR]");
  assert.equal(payload.unreadable.secret, "[UNREADABLE]");
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 32 * 1024);
});

test("provider evidence leaves innocuous bounded payloads unchanged", () => {
  const payload = { status: "working", tool: "Bash", content: ["tests passed"] };
  const safe = safeStreamPayload(payload);
  assert.deepEqual(safe.payload, payload);
  assert.equal(safe.payloadRedacted, false);
  assert.equal(safe.payloadTruncated, false);
});
