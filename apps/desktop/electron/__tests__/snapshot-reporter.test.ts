import assert from "node:assert/strict";
import test from "node:test";

import type {
  AdapterLrtEstimate,
  AdapterNativeQuotaSnapshot,
  AdapterUsageDelta,
} from "../rental/adapter-types.js";
import {
  buildUsageReport,
  computeIdempotencyKey,
  reportSnapshot,
  type FetchLike,
  type ReportSnapshotInputs,
} from "../rental/snapshot-reporter.js";

function fixtureSnapshot(over: Partial<AdapterNativeQuotaSnapshot> = {}): AdapterNativeQuotaSnapshot {
  return {
    provider: "claude_code",
    model: "claude-3.7-sonnet",
    sourceId: "jsonl:test",
    nativeUnit: "tokens",
    nativeRemaining: null,
    nativeTotal: null,
    nativeResetAt: null,
    confidence: "local_exact",
    observedAt: "2026-05-11T10:00:00.000Z",
    raw: { turnCount: 4, totals: { inputTokens: 4100, outputTokens: 2250 } },
    ...over,
  };
}

function fixtureDelta(over: Partial<AdapterUsageDelta> = {}): AdapterUsageDelta {
  return {
    inputTokens: 4100,
    outputTokens: 2250,
    cacheCreationTokens: 2500,
    cacheReadTokens: 73500,
    reasoningTokens: 210,
    requests: 0,
    credits: 0,
    usd: 0,
    toolCalls: 0,
    commandRuns: 0,
    ...over,
  };
}

function fixtureLrt(over: Partial<AdapterLrtEstimate> = {}): AdapterLrtEstimate {
  return {
    lrtUsed: 22_000,
    lrtRemaining: 978_000,
    confidence: "local_exact",
    ...over,
  };
}

function fixtureInputs(over: Partial<ReportSnapshotInputs> = {}): ReportSnapshotInputs {
  return {
    sessionId: "sess_abc",
    snapshot: fixtureSnapshot(),
    delta: fixtureDelta(),
    lrt: fixtureLrt(),
    ...over,
  };
}

test("computeIdempotencyKey is deterministic for identical inputs", () => {
  const inputs = fixtureInputs();
  const a = computeIdempotencyKey(inputs.sessionId, inputs.snapshot, inputs.delta, inputs.lrt);
  const b = computeIdempotencyKey(inputs.sessionId, inputs.snapshot, inputs.delta, inputs.lrt);
  assert.equal(a, b);
  assert.ok(a.startsWith("desktop_"));
});

test("computeIdempotencyKey changes when session_id changes", () => {
  const i1 = fixtureInputs();
  const i2 = fixtureInputs({ sessionId: "sess_other" });
  const k1 = computeIdempotencyKey(i1.sessionId, i1.snapshot, i1.delta, i1.lrt);
  const k2 = computeIdempotencyKey(i2.sessionId, i2.snapshot, i2.delta, i2.lrt);
  assert.notEqual(k1, k2);
});

test("computeIdempotencyKey changes when observedAt changes", () => {
  const i1 = fixtureInputs();
  const i2 = fixtureInputs({ snapshot: fixtureSnapshot({ observedAt: "2026-05-11T10:05:00.000Z" }) });
  assert.notEqual(
    computeIdempotencyKey(i1.sessionId, i1.snapshot, i1.delta, i1.lrt),
    computeIdempotencyKey(i2.sessionId, i2.snapshot, i2.delta, i2.lrt),
  );
});

test("computeIdempotencyKey changes when the LRT delta changes", () => {
  const i1 = fixtureInputs();
  const i2 = fixtureInputs({ lrt: fixtureLrt({ lrtUsed: 12_345 }) });
  assert.notEqual(
    computeIdempotencyKey(i1.sessionId, i1.snapshot, i1.delta, i1.lrt),
    computeIdempotencyKey(i2.sessionId, i2.snapshot, i2.delta, i2.lrt),
  );
});

test("buildUsageReport carries snapshot + delta + lrt into the wire shape", () => {
  const body = buildUsageReport(fixtureInputs());
  assert.equal(body.source, "adapter");
  assert.equal(body.snapshot.provider, "claude_code");
  assert.equal(body.snapshot.model, "claude-3.7-sonnet");
  assert.equal(body.snapshot.nativeUnit, "tokens");
  // Claude Code log doesn't report a "used" number to the server, only the totals on raw.
  assert.equal(body.snapshot.nativeUsed, null);
  assert.equal(body.delta.inputTokens, 4100);
  assert.equal(body.delta.reasoningTokens, 210);
  assert.equal(body.lrt.lrtUsed, 22_000);
  assert.equal(body.lrt.confidence, "local_exact");
  assert.ok(body.idempotencyKey.startsWith("desktop_"));
  assert.ok(body.adapterPayload && (body.adapterPayload as { turnCount?: number }).turnCount === 4);
});

test("buildUsageReport accepts an explicit idempotencyKey override", () => {
  const body = buildUsageReport(fixtureInputs({ idempotencyKey: "test-override-key" }));
  assert.equal(body.idempotencyKey, "test-override-key");
});

test("reportSnapshot POSTs JSON to the correct URL with the bearer token", async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchFn: FetchLike = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: "rusg_new" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await reportSnapshot(fixtureInputs(), {
    apiBaseUrl: "https://letagents.chat/",
    authToken: "tok_123",
    fetchFn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(captured.url, "https://letagents.chat/api/rental/sessions/sess_abc/usage");
  assert.equal(captured.init?.method, "POST");
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.authorization, "Bearer tok_123");
});

test("reportSnapshot omits the authorization header when no token is provided", async () => {
  let headers: Record<string, string> = {};
  const fetchFn: FetchLike = async (_url, init) => {
    headers = (init.headers as Record<string, string>) ?? {};
    return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
  };
  await reportSnapshot(fixtureInputs(), { apiBaseUrl: "https://letagents.chat", fetchFn });
  assert.equal(headers.authorization, undefined);
});

test("reportSnapshot returns ok=false with parsed error on non-2xx", async () => {
  const fetchFn: FetchLike = async () =>
    new Response(JSON.stringify({ error: "session not found", code: "session_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  const result = await reportSnapshot(fixtureInputs(), {
    apiBaseUrl: "https://letagents.chat",
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, "session not found");
});

test("reportSnapshot returns ok=false with the thrown error message on network failure", async () => {
  const fetchFn: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await reportSnapshot(fixtureInputs(), {
    apiBaseUrl: "https://letagents.chat",
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "ECONNREFUSED");
});

test("reportSnapshot URL-encodes the session id and trims trailing slashes from baseUrl", async () => {
  let url = "";
  const fetchFn: FetchLike = async (u) => {
    url = u;
    return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
  };
  await reportSnapshot(fixtureInputs({ sessionId: "sess with spaces/and/slashes" }), {
    apiBaseUrl: "https://letagents.chat///",
    fetchFn,
  });
  assert.equal(
    url,
    "https://letagents.chat/api/rental/sessions/sess%20with%20spaces%2Fand%2Fslashes/usage",
  );
});
