import assert from "node:assert/strict";
import test from "node:test";

import { isRentEnabled } from "../rental-handlers.js";
import { captureHandlers, invoke } from "./rental-handlers-live-client/harness.js";

test("desktop rental does not depend on a packaged-app environment variable", () => {
  const original = process.env.LETAGENTS_RENT_ENABLED;
  try {
    delete process.env.LETAGENTS_RENT_ENABLED;
    assert.equal(isRentEnabled(), true);

    for (const value of ["0", "false", "no", "off", "unexpected", "1", "true", "yes", "on"]) {
      process.env.LETAGENTS_RENT_ENABLED = value;
      assert.equal(isRentEnabled(), true, `${value} must not split desktop UI state from the server rollout`);
    }
  } finally {
    if (original === undefined) delete process.env.LETAGENTS_RENT_ENABLED;
    else process.env.LETAGENTS_RENT_ENABLED = original;
  }
});

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
    "desktop:rental:get-marketplace",
    "desktop:rental:get-provider-settings",
    "desktop:rental:verify-provider-runtime",
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
    "desktop:rental:update-provider-settings",
  ];
  assert.deepEqual([...handlers.keys()].sort(), expectedChannels.sort());
});

test("enabled rental IPC fails visibly when its service is not connected", async () => {
  const handlers = captureHandlers(true);
  await assert.rejects(
    invoke(handlers, "desktop:rental:list-listings"),
    { name: "RentalServiceError", code: "unavailable" },
  );
  await assert.rejects(
    invoke(handlers, "desktop:rental:get-provider-dashboard"),
    { name: "RentalServiceError", code: "unavailable" },
  );
});

test("enabled rental IPC never fabricates session or patch success", async () => {
  const handlers = captureHandlers(true);
  await assert.rejects(
    invoke(handlers, "desktop:rental:create-session", {
      listingId: "listing_1",
      roomIdentifier: "room_1",
      taskTitle: "Fix failing tests",
      taskPrompt: "Run the suite and patch failures.",
      mode: "scoped",
      continuityMode: "smart_handoff",
      approvedScope: { includePaths: ["src"], excludePaths: [], protectedPaths: [], notes: null },
      policy: { maxLrt: 10_000, maxDurationMinutes: 30, maxPatchBytes: null, allowCommands: false, allowNetwork: false, requirePatchGate: true },
    }),
    { name: "RentalServiceError", code: "unavailable" },
  );
  await assert.rejects(
    invoke(handlers, "desktop:rental:approve-patch", "session_1", "patch_1"),
    { name: "RentalServiceError", code: "unavailable" },
  );
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
