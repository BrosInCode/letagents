import assert from "node:assert/strict";
import test from "node:test";

test("a hung dashboard IPC expires and does not poison later rental refreshes", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let calls = 0;
  const dashboard = {
    listings: [], capacitySessions: [], pendingRequests: [], quotaSnapshots: [], updatedAt: null,
    readiness: { status: "unknown", summary: null, blockers: [], warnings: [], badges: [], checks: [], lastCheckedAt: null },
  };
  const desktopWindow = {
    letagentsDesktop: {
      rental: {
        getProviderDashboard: () => {
          calls += 1;
          return calls === 1 ? new Promise(() => undefined) : Promise.resolve(dashboard);
        },
      },
    },
  };
  Object.assign(globalThis, { window: desktopWindow });
  try {
    const { loadRentalProviderDashboard } = await import("../src/composables/useRentalProviderEvents.js");
    await assert.rejects(loadRentalProviderDashboard(10), /timed out/);
    assert.deepEqual(await loadRentalProviderDashboard(100), dashboard);
    assert.equal(calls, 2);
  } finally {
    Object.assign(globalThis, { window: previousWindow });
  }
});
