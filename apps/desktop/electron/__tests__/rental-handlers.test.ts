import assert from "node:assert/strict";
import test from "node:test";

import { captureHandlers, invoke } from "./rental-handlers-live-client/harness.js";

test("rental IPC handlers return disabled marker when feature flag is off", async () => {
  const handlers = captureHandlers(false);
  const result = await invoke(handlers, "desktop:rental:list-listings");
  assert.deepEqual(result, { enabled: false });
});

test("rental IPC registers the preload channel surface", () => {
  const handlers = captureHandlers(true);
  const expectedChannels = [
    "desktop:rental:list-listings",
    "desktop:rental:get-provider-dashboard",
    "desktop:rental:create-listing",
    "desktop:rental:update-listing",
    "desktop:rental:pause-listing",
    "desktop:rental:resume-listing",
    "desktop:rental:refresh-quota",
    "desktop:rental:run-preflight",
    "desktop:rental:create-session",
    "desktop:rental:get-session",
    "desktop:rental:cancel-session",
    "desktop:rental:list-provider-requests",
    "desktop:rental:accept-request",
    "desktop:rental:decline-request",
    "desktop:rental:get-activity",
    "desktop:rental:get-exposures",
    "desktop:rental:get-context-requests",
    "desktop:rental:get-patches",
    "desktop:rental:get-usage",
    "desktop:rental:get-own-quota-status",
    "desktop:rental:declare-quota-exhausted",
    "desktop:rental:approve-patch",
    "desktop:rental:request-patch-changes",
    "desktop:rental:approve-context-request",
    "desktop:rental:deny-context-request",
  ];
  assert.deepEqual([...handlers.keys()].sort(), expectedChannels.sort());
});

test("enabled rental IPC returns empty listing and dashboard stubs", async () => {
  const handlers = captureHandlers(true);
  assert.deepEqual(await invoke(handlers, "desktop:rental:list-listings"), []);

  const dashboard = await invoke(handlers, "desktop:rental:get-provider-dashboard");
  assert.equal((dashboard as { readiness: { status: string } }).readiness.status, "unknown");
  assert.deepEqual((dashboard as { listings: unknown[] }).listings, []);
  assert.deepEqual((dashboard as { pendingRequests: unknown[] }).pendingRequests, []);
});

test("enabled rental IPC creates typed session and patch stubs", async () => {
  const handlers = captureHandlers(true);
  const session = await invoke(handlers, "desktop:rental:create-session", {
    listingId: "listing_1",
    roomIdentifier: "room_1",
    taskTitle: "Fix failing tests",
    taskPrompt: "Run the suite and patch failures.",
    mode: "scoped",
    continuityMode: "smart_handoff",
    approvedScope: { includePaths: ["src"], excludePaths: [], protectedPaths: [], notes: null },
    policy: { maxLrt: 10_000, maxDurationMinutes: 30, maxPatchBytes: null, allowCommands: false, allowNetwork: false, requirePatchGate: true },
  });
  assert.equal((session as { listingId: string }).listingId, "listing_1");
  assert.equal((session as { status: string }).status, "requested");

  const patch = await invoke(handlers, "desktop:rental:approve-patch", "session_1", "patch_1");
  assert.equal((patch as { sessionId: string }).sessionId, "session_1");
  assert.equal((patch as { gateStatus: string }).gateStatus, "passed");
});

test("enabled rental IPC exposes renter-side quota trigger status and manual declaration", async () => {
  const handlers = captureHandlers(true);
  const initial = await invoke(handlers, "desktop:rental:get-own-quota-status");
  assert.equal((initial as { triggered: boolean }).triggered, false);

  const signal = await invoke(handlers, "desktop:rental:declare-quota-exhausted", {
    provider: "codex",
    model: "gpt-5.2",
    note: "quota modal",
    occurredAt: "2026-05-11T10:00:00.000Z",
  });
  assert.equal((signal as { triggered: boolean }).triggered, true);
  assert.equal((signal as { confidence: string }).confidence, "manual");
  assert.equal((signal as { provider: string }).provider, "codex");

  const after = await invoke(handlers, "desktop:rental:get-own-quota-status");
  assert.equal((after as { triggered: boolean }).triggered, true);
  assert.equal((after as { provider: string }).provider, "codex");
});
