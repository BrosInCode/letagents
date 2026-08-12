import assert from "node:assert/strict";
import test from "node:test";

import { requestRow, sessionRow } from "./fixtures.js";
import { captureHandlersWithClient, invoke, makeFakeClient } from "./harness.js";

test("create-session forwards a mapped body and maps the response back", async () => {
  const { client, calls } = makeFakeClient({
    createSession: {
      ok: true,
      status: 201,
      body: sessionRow({ id: "rsess_42" }),
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
  const body = (calls[0]?.args[0] ?? {}) as Record<string, unknown>;
  assert.equal(body.listingId, "listing_1");
  assert.equal(body.repoOwner, "BrosInCode");
  assert.deepEqual(body.approvedScope, {
    includePaths: [],
    excludePaths: [],
    protectedPaths: [],
    notes: null,
  });
  assert.deepEqual(body.policy, {
    maxLrt: 10000,
    maxDurationMinutes: 60,
    maxPatchBytes: null,
    allowCommands: false,
    allowNetwork: false,
    requirePatchGate: true,
  });
  assert.equal(body.lrtLimit, 10000);
  assert.equal(body.timeLimitMinutes, 60);
  assert.equal(out.id, "rsess_42");
});

test("create-session surfaces API failure", async () => {
  const { client } = makeFakeClient({
    createSession: { ok: false, status: 400, error: "listing_not_found", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  await assert.rejects(() => invoke(handlers, "desktop:rental:create-session", {
    listingId: "listing_1",
    taskTitle: "x",
  }), { code: "request_failed" });
});

test("get-session maps the live response", async () => {
  const { client, calls } = makeFakeClient({
    getSession: {
      ok: true,
      status: 200,
      body: sessionRow({
        id: "rsess_7",
        status: "active",
        task_title: "T",
        task_prompt: "P",
      }),
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

test("cancel-session surfaces API rejection", async () => {
  const { client } = makeFakeClient({
    cancelSession: {
      ok: false,
      status: 409,
      error: "invalid_transition",
      body: null,
    },
  });
  const handlers = captureHandlersWithClient(client);
  await assert.rejects(() => invoke(handlers, "desktop:rental:cancel-session", "rsess_8"), { code: "request_failed" });
});

test("accept-request delegates to the main-process launch coordinator", async () => {
  let accepted: unknown[] = [];
  const handlers = captureHandlersWithClient(null, {
    launchCoordinator: {
      async acceptAndLaunch(...args: unknown[]) {
        accepted = args;
        return sessionRow({ id: "rsess_9", status: "active" }) as never;
      },
    } as never,
  });
  const out = (await invoke(handlers, "desktop:rental:accept-request", "rsess_9", {
    providerId: "codex",
    permissionProfileId: "full_access",
  })) as {
    id: string;
    status: string;
  };
  assert.equal(out.status, "active");
  assert.equal(accepted[0], "rsess_9");
  assert.deepEqual(accepted[1], { providerId: "codex", permissionProfileId: "full_access" });
});

test("decline-request forwards to declineRequest and maps to a request payload", async () => {
  const { client, calls } = makeFakeClient({
    declineRequest: {
      ok: true,
      status: 200,
      body: requestRow({ id: "rsess_10", status: "cancelled" }),
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

test("without apiClient live-client session channels fail visibly", async () => {
  const handlers = captureHandlersWithClient(null);
  await assert.rejects(() => invoke(
    handlers,
    "desktop:rental:create-session",
    { listingId: "listing_1" },
  ), { code: "unavailable" });
  await assert.rejects(() => invoke(handlers, "desktop:rental:get-session", "rsess_z"), { code: "unavailable" });
  await assert.rejects(() => invoke(handlers, "desktop:rental:cancel-session", "rsess_z"), { code: "unavailable" });
  await assert.rejects(() => invoke(handlers, "desktop:rental:accept-request", "rsess_z"), { code: "unavailable" });
  await assert.rejects(() => invoke(handlers, "desktop:rental:decline-request", "rsess_z"), { code: "unavailable" });
});
