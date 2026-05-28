import assert from "node:assert/strict";
import test from "node:test";

import { activityEventRow, usageRow } from "./fixtures.js";
import {
  captureHandlersWithClient,
  invoke,
  makeFakeClient,
  waitForFireAndForget,
} from "./harness.js";

test("get-usage forwards to getSessionUsage and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    getSessionUsage: {
      ok: true,
      status: 200,
      body: usageRow(),
    },
  });
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(
    handlers,
    "desktop:rental:get-usage",
    "rsess_42",
  )) as {
    sessionId: string;
    lrtLimit: number;
    lrtRemaining: number;
    startedAt: string;
    endsAt: string;
  };
  assert.equal(result.sessionId, "rsess_42");
  assert.equal(result.lrtLimit, 10_000);
  assert.equal(result.lrtRemaining, 7_400);
  assert.equal(result.startedAt, "2026-05-12T10:00:00.000Z");
  assert.equal(result.endsAt, "2026-05-12T11:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "getSessionUsage");
  assert.equal(calls[0]?.args[0], "rsess_42");
});

test("get-usage falls back to the empty snapshot when the api returns an error", async () => {
  const { client } = makeFakeClient({
    getSessionUsage: { ok: false, status: 500, error: "boom", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(
    handlers,
    "desktop:rental:get-usage",
    "rsess_42",
  )) as {
    sessionId: string;
    lrtUsed: number;
    lrtReserved: number;
  };
  assert.equal(result.sessionId, "rsess_42");
  assert.equal(result.lrtUsed, 0);
  assert.equal(result.lrtReserved, 0);
});

test("get-usage falls back to the empty snapshot when sessionId is missing", async () => {
  const { client, calls } = makeFakeClient({});
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(handlers, "desktop:rental:get-usage", "")) as {
    sessionId: string;
  };
  assert.equal(result.sessionId, "");
  assert.equal(calls.length, 0);
});

test("declare-quota-exhausted forwards the local signal to declareQuotaExhausted", async () => {
  const { client, calls } = makeFakeClient({
    declareQuotaExhausted: { ok: true, status: 200, body: {} },
  });
  const handlers = captureHandlersWithClient(client);
  const signal = (await invoke(
    handlers,
    "desktop:rental:declare-quota-exhausted",
    { provider: "cursor", model: "claude-3.7-sonnet" },
  )) as { triggered: boolean; provider: string | null };

  assert.equal(signal.triggered, true);
  assert.equal(signal.provider, "cursor");

  await waitForFireAndForget();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "declareQuotaExhausted");
  const sent = calls[0]?.args[0] as Record<string, unknown>;
  assert.equal(sent.startTrigger, "quota_exhausted");
  assert.equal(sent.triggerConfidence, "manual");
  assert.equal(sent.renterLaneProvider, "cursor");
  assert.equal(sent.renterLaneModel, "claude-3.7-sonnet");
  assert.ok(typeof sent.renterLaneExhaustedAt === "string");
});

test("declare-quota-exhausted skips server sync when provider is missing", async () => {
  const { client, calls } = makeFakeClient({
    declareQuotaExhausted: { ok: true, status: 200, body: {} },
  });
  const handlers = captureHandlersWithClient(client);
  await invoke(handlers, "desktop:rental:declare-quota-exhausted", {});

  await waitForFireAndForget();

  assert.equal(calls.length, 0);
});

test("declare-quota-exhausted ignores api failures (best-effort sync)", async () => {
  const { client, calls } = makeFakeClient({
    declareQuotaExhausted: { ok: false, status: 500, error: "boom", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const signal = (await invoke(
    handlers,
    "desktop:rental:declare-quota-exhausted",
    { provider: "cursor" },
  )) as { triggered: boolean };

  assert.equal(signal.triggered, true);

  await waitForFireAndForget();

  assert.equal(calls.length, 1, "still attempts the sync once");
});

test("get-activity forwards to getSessionActivity and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    getSessionActivity: {
      ok: true,
      status: 200,
      body: { events: [activityEventRow()] },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(
    handlers,
    "desktop:rental:get-activity",
    "rsess_42",
  )) as Array<{ id: string; sessionId: string }>;

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "evt_1");
  assert.equal(result[0]?.sessionId, "rsess_42");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "getSessionActivity");
  assert.equal(calls[0]?.args[0], "rsess_42");
});

test("get-activity returns [] when the api returns an error", async () => {
  const { client } = makeFakeClient({
    getSessionActivity: { ok: false, status: 500, error: "boom", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const result = await invoke(handlers, "desktop:rental:get-activity", "rsess_42");
  assert.deepEqual(result, []);
});

test("get-activity returns [] when sessionId is missing", async () => {
  const { client, calls } = makeFakeClient({});
  const handlers = captureHandlersWithClient(client);
  const result = await invoke(handlers, "desktop:rental:get-activity", "");
  assert.deepEqual(result, []);
  assert.equal(calls.length, 0);
});
