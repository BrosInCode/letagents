import assert from "node:assert/strict";
import test from "node:test";

import { listingRow, readinessRow, requestRow } from "./fixtures.js";
import { captureHandlersWithClient, invoke, makeFakeClient } from "./harness.js";

test("list-listings forwards to publicListings and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    publicListings: {
      ok: true,
      status: 200,
      body: { listings: [listingRow()] },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(handlers, "desktop:rental:list-listings")) as Array<{
    id: string;
  }>;
  assert.equal(calls[0]?.method, "publicListings");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, "listing_1");
});

test("list-listings falls back to [] when the API call fails", async () => {
  const { client } = makeFakeClient({
    publicListings: { ok: false, status: 502, error: "bad_gateway", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const out = await invoke(handlers, "desktop:rental:list-listings");
  assert.deepEqual(out, []);
});

test("list-listings returns the stub when no apiClient is provided", async () => {
  const handlers = captureHandlersWithClient(null);
  const out = await invoke(handlers, "desktop:rental:list-listings");
  assert.deepEqual(out, []);
});

test("list-provider-requests forwards to listProviderRequests and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    listProviderRequests: {
      ok: true,
      status: 200,
      body: [requestRow()],
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(
    handlers,
    "desktop:rental:list-provider-requests",
  )) as Array<{ sessionId: string; status: string }>;
  assert.equal(calls[0]?.method, "listProviderRequests");
  assert.equal(out[0]?.sessionId, "rsess_1");
  assert.equal(out[0]?.status, "pending");
});

test("list-provider-requests falls back to [] on API failure", async () => {
  const { client } = makeFakeClient({
    listProviderRequests: { ok: false, status: 0, error: "network", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const out = await invoke(handlers, "desktop:rental:list-provider-requests");
  assert.deepEqual(out, []);
});

test("list-provider-requests returns the stub when no apiClient is provided", async () => {
  const handlers = captureHandlersWithClient(null);
  const out = await invoke(handlers, "desktop:rental:list-provider-requests");
  assert.deepEqual(out, []);
});

test("get-provider-dashboard composes live listings + pending requests + readiness", async () => {
  const { client, calls } = makeFakeClient({
    listProviderListings: {
      ok: true,
      status: 200,
      body: { listings: [listingRow({ display_name: "My agent" })] },
    },
    listProviderRequests: {
      ok: true,
      status: 200,
      body: [requestRow({ task_title: "Fix bug", task_prompt: "..." })],
    },
    getProviderReadiness: {
      ok: true,
      status: 200,
      body: readinessRow(),
    },
  });
  const handlers = captureHandlersWithClient(client);
  const dashboard = (await invoke(
    handlers,
    "desktop:rental:get-provider-dashboard",
  )) as {
    listings: Array<{ id: string }>;
    pendingRequests: Array<{ sessionId: string; status: string }>;
    activeSessions: unknown[];
    readiness: {
      status: string;
      summary: string | null;
      badges: string[];
      checks: Array<{ id: string }>;
      lastCheckedAt: string | null;
    };
  };
  const methodNames = calls.map((c) => c.method).sort();
  assert.deepEqual(methodNames, [
    "getProviderReadiness",
    "listProviderListings",
    "listProviderRequests",
  ]);
  assert.equal(dashboard.listings.length, 1);
  assert.equal(dashboard.listings[0]?.id, "listing_1");
  assert.equal(dashboard.pendingRequests.length, 1);
  assert.equal(dashboard.pendingRequests[0]?.sessionId, "rsess_1");
  assert.equal(dashboard.pendingRequests[0]?.status, "pending");
  assert.deepEqual(dashboard.activeSessions, []);
  assert.equal(dashboard.readiness.status, "ready");
  assert.equal(dashboard.readiness.summary, "1 listing: 1 active.");
  assert.deepEqual(dashboard.readiness.badges, ["verified"]);
  assert.equal(dashboard.readiness.checks.length, 1);
  assert.equal(dashboard.readiness.lastCheckedAt, "2026-05-12T11:00:00.000Z");
});

test("get-provider-dashboard tolerates one side failing without nuking the other", async () => {
  const { client } = makeFakeClient({
    listProviderListings: {
      ok: false,
      status: 502,
      error: "bad_gateway",
      body: null,
    },
    listProviderRequests: {
      ok: true,
      status: 200,
      body: { requests: [requestRow({ id: "rsess_x" })] },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const dashboard = (await invoke(
    handlers,
    "desktop:rental:get-provider-dashboard",
  )) as {
    listings: unknown[];
    pendingRequests: Array<{ sessionId: string }>;
    readiness: { status: string };
  };
  assert.deepEqual(dashboard.listings, []);
  assert.equal(dashboard.pendingRequests.length, 1);
  assert.equal(dashboard.pendingRequests[0]?.sessionId, "rsess_x");
  assert.equal(dashboard.readiness.status, "unknown");
});

test("get-provider-dashboard falls back to the empty stub when no apiClient", async () => {
  const handlers = captureHandlersWithClient(null);
  const dashboard = (await invoke(
    handlers,
    "desktop:rental:get-provider-dashboard",
  )) as { listings: unknown[]; pendingRequests: unknown[]; readiness: { status: string } };
  assert.deepEqual(dashboard.listings, []);
  assert.deepEqual(dashboard.pendingRequests, []);
  assert.equal(dashboard.readiness.status, "unknown");
});

test("get-provider-dashboard surfaces live readiness even when listings/requests fail", async () => {
  const { client } = makeFakeClient({
    listProviderListings: {
      ok: false,
      status: 503,
      error: "service_unavailable",
      body: null,
    },
    listProviderRequests: {
      ok: false,
      status: 503,
      error: "service_unavailable",
      body: null,
    },
    getProviderReadiness: {
      ok: true,
      status: 200,
      body: readinessRow({
        status: "blocked",
        summary: "No active listings.",
        blockers: ["No active listings - every listing is either disabled or pending setup."],
        badges: [],
        checks: [],
        last_checked_at: "2026-05-12T11:05:00.000Z",
      }),
    },
  });
  const handlers = captureHandlersWithClient(client);
  const dashboard = (await invoke(
    handlers,
    "desktop:rental:get-provider-dashboard",
  )) as {
    listings: unknown[];
    pendingRequests: unknown[];
    readiness: { status: string; blockers: string[] };
  };
  assert.deepEqual(dashboard.listings, []);
  assert.deepEqual(dashboard.pendingRequests, []);
  assert.equal(dashboard.readiness.status, "blocked");
  assert.equal(dashboard.readiness.blockers.length, 1);
});
