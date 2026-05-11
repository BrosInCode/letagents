/**
 * Tests for the live-client wiring in `rental-handlers.ts` (p1.8c).
 *
 * Verifies each channel that p1.8c wires to the RentalApiClient:
 *   - When apiClient is provided AND the call returns ok=true,
 *     the channel returns the mapped DesktopRental* payload.
 *   - When apiClient is provided AND the call returns ok=false
 *     (network failure, 404, malformed body) OR returns a
 *     payload that doesn't map, the channel falls back to the
 *     stub response so the UI stays renderable.
 *   - When apiClient is omitted, the channel returns the
 *     pre-p1.8c stub response (regression guard).
 *
 * Uses a hand-rolled fake RentalApiClient — we don't need real
 * fetch here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerDesktopRentalIpcHandlers } from "../rental-handlers.js";
import type { RentalApiClient, RentalApiResult } from "../rental/api-client.js";

type CapturedHandler = (_event: any, ...args: any[]) => unknown;

// ---------------------------------------------------------------------------
// Fake API client
// ---------------------------------------------------------------------------

interface FakeCall {
  method: string;
  args: unknown[];
}

function makeFakeClient(
  scripted: Partial<Record<keyof RentalApiClient, RentalApiResult<unknown>>>,
): { client: RentalApiClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fallback: RentalApiResult<unknown> = {
    ok: false,
    status: 0,
    error: "no_script",
    body: null,
  };
  const proxy = new Proxy({} as RentalApiClient, {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return scripted[prop as keyof RentalApiClient] ?? fallback;
      };
    },
  });
  return { client: proxy, calls };
}

function captureHandlersWithClient(
  client: RentalApiClient | null,
): Map<string, CapturedHandler> {
  const handlers = new Map<string, CapturedHandler>();
  registerDesktopRentalIpcHandlers(
    {
      handle(channel: string, handler: CapturedHandler) {
        handlers.set(channel, handler);
      },
    },
    { enabled: true, apiClient: client },
  );
  return handlers;
}

async function invoke(
  handlers: Map<string, CapturedHandler>,
  channel: string,
  ...args: unknown[]
) {
  const handler = handlers.get(channel);
  assert.ok(handler, `expected ${channel} to be registered`);
  return handler(null, ...args);
}

// ---------------------------------------------------------------------------
// list-listings
// ---------------------------------------------------------------------------

test("list-listings forwards to publicListings and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    publicListings: {
      ok: true,
      status: 200,
      body: {
        listings: [
          {
            id: "listing_1",
            display_name: "Antigravity rental",
            ide_kind: "antigravity",
            status: "active",
            updated_at: "2026-05-11T10:00:00.000Z",
          },
        ],
      },
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

// ---------------------------------------------------------------------------
// list-provider-requests
// ---------------------------------------------------------------------------

test("list-provider-requests forwards to listProviderRequests and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    listProviderRequests: {
      ok: true,
      status: 200,
      body: [
        {
          id: "rsess_1",
          status: "requested",
          task_title: "Fix flaky test",
          updated_at: "2026-05-11T10:00:00.000Z",
        },
      ],
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(
    handlers,
    "desktop:rental:list-provider-requests",
  )) as Array<{ sessionId: string; status: string }>;
  assert.equal(calls[0]?.method, "listProviderRequests");
  assert.equal(out[0]?.sessionId, "rsess_1");
  assert.equal(out[0]?.status, "pending"); // requested → pending
});

test("list-provider-requests falls back to [] on API failure", async () => {
  const { client } = makeFakeClient({
    listProviderRequests: { ok: false, status: 0, error: "network", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const out = await invoke(handlers, "desktop:rental:list-provider-requests");
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// create-session
// ---------------------------------------------------------------------------

test("create-session forwards a mapped body and maps the response back", async () => {
  const { client, calls } = makeFakeClient({
    createSession: {
      ok: true,
      status: 201,
      body: {
        id: "rsess_42",
        listing_id: "listing_1",
        status: "requested",
        task_title: "Run tests",
        task_prompt: "go",
        updated_at: "2026-05-11T10:00:00.000Z",
      },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(handlers, "desktop:rental:create-session", {
    listingId: "listing_1",
    roomIdentifier: "room_1",
    taskTitle: "Run tests",
    taskPrompt: "go",
    repoOwner: "BrosInCode",
    repoName: "letagents",
    baseBranch: "main",
    mode: "scoped",
    continuityMode: "smart_handoff",
    approvedScope: {
      includePaths: [],
      excludePaths: [],
      protectedPaths: [],
      notes: null,
    },
    policy: {
      maxLrt: 10000,
      maxDurationMinutes: 60,
      maxPatchBytes: null,
      allowCommands: false,
      allowNetwork: false,
      requirePatchGate: true,
    },
  })) as { id: string };
  assert.equal(calls[0]?.method, "createSession");
  // The body should be the API-shape mapped version (no policy
  // envelope; lrtLimit + timeLimitMinutes lifted out).
  const body = (calls[0]?.args[0] ?? {}) as Record<string, unknown>;
  assert.equal(body.listingId, "listing_1");
  assert.equal(body.repoOwner, "BrosInCode");
  assert.equal(body.lrtLimit, 10000);
  assert.equal(body.timeLimitMinutes, 60);
  assert.equal(body.policy, undefined, "policy envelope is NOT forwarded");
  assert.equal(out.id, "rsess_42");
});

test("create-session falls back to a stub when API call fails", async () => {
  const { client } = makeFakeClient({
    createSession: { ok: false, status: 400, error: "listing_not_found", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(handlers, "desktop:rental:create-session", {
    listingId: "listing_1",
    taskTitle: "x",
  })) as { id: string };
  assert.equal(out.id, "session_stub");
});

// ---------------------------------------------------------------------------
// get-session / cancel-session / accept-request / decline-request
// ---------------------------------------------------------------------------

test("get-session maps the live response", async () => {
  const { client, calls } = makeFakeClient({
    getSession: {
      ok: true,
      status: 200,
      body: {
        id: "rsess_7",
        listing_id: "listing_1",
        status: "active",
        task_title: "T",
        task_prompt: "P",
        updated_at: "2026-05-11T10:00:00.000Z",
      },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(handlers, "desktop:rental:get-session", "rsess_7")) as {
    id: string;
    status: string;
  };
  assert.equal(calls[0]?.method, "getSession");
  assert.equal(calls[0]?.args[0], "rsess_7");
  assert.equal(out.id, "rsess_7");
  assert.equal(out.status, "active");
});

test("cancel-session falls back to a cancelled stub when the API rejects", async () => {
  const { client } = makeFakeClient({
    cancelSession: {
      ok: false,
      status: 409,
      error: "invalid_transition",
      body: null,
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(handlers, "desktop:rental:cancel-session", "rsess_8")) as {
    id: string;
    status: string;
  };
  assert.equal(out.id, "rsess_8");
  assert.equal(out.status, "cancelled");
});

test("accept-request forwards to acceptRequest and maps to a session", async () => {
  const { client, calls } = makeFakeClient({
    acceptRequest: {
      ok: true,
      status: 200,
      body: {
        id: "rsess_9",
        status: "accepted",
        task_title: "T",
        task_prompt: "P",
        listing_id: "listing_1",
        updated_at: "2026-05-11T10:00:00.000Z",
      },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(handlers, "desktop:rental:accept-request", "rsess_9")) as {
    id: string;
    status: string;
  };
  assert.equal(calls[0]?.method, "acceptRequest");
  assert.equal(out.status, "accepted");
});

test("decline-request forwards to declineRequest and maps to a request payload", async () => {
  const { client, calls } = makeFakeClient({
    declineRequest: {
      ok: true,
      status: 200,
      body: {
        id: "rsess_10",
        status: "cancelled",
        listing_id: "listing_1",
        task_title: "T",
        task_prompt: "P",
        updated_at: "2026-05-11T10:00:00.000Z",
      },
    },
  });
  const handlers = captureHandlersWithClient(client);
  const out = (await invoke(
    handlers,
    "desktop:rental:decline-request",
    "rsess_10",
  )) as { sessionId: string; status: string };
  assert.equal(calls[0]?.method, "declineRequest");
  assert.equal(out.sessionId, "rsess_10");
  assert.equal(out.status, "cancelled");
});

// ---------------------------------------------------------------------------
// No-client regression: every wired channel still returns its stub shape
// ---------------------------------------------------------------------------

test("without apiClient every wired channel still returns its stub", async () => {
  const handlers = captureHandlersWithClient(null);
  // Regression: pre-p1.8c behavior preserved.
  assert.deepEqual(await invoke(handlers, "desktop:rental:list-listings"), []);
  assert.deepEqual(
    await invoke(handlers, "desktop:rental:list-provider-requests"),
    [],
  );
  const create = (await invoke(
    handlers,
    "desktop:rental:create-session",
    { listingId: "listing_1" },
  )) as { id: string };
  assert.equal(create.id, "session_stub");
  const get = (await invoke(handlers, "desktop:rental:get-session", "rsess_z")) as {
    id: string;
  };
  assert.equal(get.id, "rsess_z");
  const cancel = (await invoke(
    handlers,
    "desktop:rental:cancel-session",
    "rsess_z",
  )) as { id: string; status: string };
  assert.equal(cancel.status, "cancelled");
  const accept = (await invoke(
    handlers,
    "desktop:rental:accept-request",
    "rsess_z",
  )) as { id: string; status: string };
  assert.equal(accept.status, "accepted");
  const decline = (await invoke(
    handlers,
    "desktop:rental:decline-request",
    "rsess_z",
  )) as { status: string };
  assert.equal(decline.status, "declined");
});
