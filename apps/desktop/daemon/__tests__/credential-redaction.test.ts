import assert from "node:assert/strict";
import test from "node:test";

import { redactCredentialText, redactCredentialTextWithoutHints, sanitizeDaemonActivityEvent } from "../credential-redaction.js";
import type { DaemonActivityEvent } from "../types.js";

const FRAGMENTS = [
  "token", "ToKeN", "accessToken", "refresh_token", "LETAGENTS-TOKEN", "password", "PassWD", "dbPassword", "secret",
  "clientSecret", "apiKey", "api_key", "API-KEY", "privateKey", "private-key", "cookie", "Set-Cookie", "credentials",
  "authorization", "Proxy-Authorization", "Bearer ", "basic ", "bearer\t", "ghp_", "GHO_", "github_pat_", "sk-", "AKIA",
  "lasb_", "lashg_", "postgres://", "redis://:", "https://user:", "@", "@host", "=", ":", " = ", ": ", "\"", "'", "\\\"",
  "\\'", ",", "}", "]", "[", "[REDACTED]", "<redacted>", "***", " ", "\n", "\t", "-----BEGIN RSA PRIVATE KEY-----",
  "-----END RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----", "İ", "ſ", "K", "é",
  "abcdefghijklmnopqrstuvwxyz0123456789", "ABCDEFGHIJKLMNOPQRST", "0123456789abcdef", "a1B2c3D4e5F6g7H8i9J0k", "_", "-",
  "/", ".", "+", "~",
];

/** A small deterministic generator, so a failure always reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test("hinted redaction returns exactly what running every pattern returns", () => {
  const next = random(1668);
  let redacted = 0;
  let skipped = 0;
  for (let index = 0; index < 20_000; index += 1) {
    const parts = 1 + Math.floor(next() * 24);
    let text = "";
    for (let part = 0; part < parts; part += 1) text += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
    const maxChars = next() < 0.2 ? 1 + Math.floor(next() * 40) : 8 * 1024;
    const expected = redactCredentialTextWithoutHints(text, maxChars);
    assert.deepEqual(redactCredentialText(text, maxChars), expected, JSON.stringify(text));
    if (expected.redacted) redacted += 1; else skipped += 1;
  }
  // The corpus exercises both sides: text the patterns redact and text they leave.
  assert.ok(redacted > 2_000 && skipped > 2_000, `${redacted} redacted, ${skipped} not`);
});

test("hints skip the patterns on text without credentials and keep every redaction", () => {
  const cases: Array<[string, string]> = [
    ["Authorization: Bearer abcdefgh12345678", "Authorization: Bearer [REDACTED]"],
    ["curl -H 'authorization: tok_123456'", "curl -H 'authorization: [REDACTED]'"],
    ["export DB_PASSWORD=hunter2hunter2", "export DB_PASSWORD=[REDACTED]"],
    ["{\"accessToken\":\"abcd1234\"}", "{\"accessToken\":\"[REDACTED]\"}"],
    ["push with ghp_abcdefghijklmnopqrstuvwxyz0123", "push with [REDACTED]"],
    ["key AKIAABCDEFGHIJKLMNOP here", "key [REDACTED] here"],
    ["postgres://admin:p@ss@db.local/app", "postgres://admin:[REDACTED]@db.local/app"],
    ["a\n-----BEGIN EC PRIVATE KEY-----\nMIIB\n-----END EC PRIVATE KEY-----\nb", "a\n[REDACTED]\nb"],
  ];
  for (const [input, expected] of cases) {
    const result = redactCredentialText(input);
    assert.equal(result.value, expected, input);
    assert.equal(result.redacted, true, input);
  }
  const plain = Array.from({ length: 4_000 }, (_, line) => `src/file${line}.ts: export const value${line} = compute(${line});`).join("\n");
  const result = redactCredentialText(plain);
  assert.equal(result.redacted, false);
  assert.equal(result.truncated, true);
  assert.equal(result.value, `${plain.slice(0, 8 * 1024)}…`);
});

test("a sanitized activity event keeps its redaction and truncation flags", () => {
  const output = `${"x".repeat(20_000)} password=hunter2hunter2`;
  const event = sanitizeDaemonActivityEvent({
    observed_at: "2026-10-19T00:00:00.000Z", sequence: 1, provider: "codex", kind: "tool",
    method: "item/commandExecution", summary: "Bearer abcdefgh12345678", status: "working",
    payload: { output, nested: { apiKey: "visible?" } }, payload_truncated: false, payload_redacted: false,
    durable_payload_ref: null,
  } as DaemonActivityEvent);
  assert.equal(event.summary, "Bearer [REDACTED]");
  assert.deepEqual((event.payload as { nested: unknown }).nested, { apiKey: "[REDACTED]" });
  assert.equal(event.payload_redacted, true);
  assert.equal(event.payload_truncated, true);
});
