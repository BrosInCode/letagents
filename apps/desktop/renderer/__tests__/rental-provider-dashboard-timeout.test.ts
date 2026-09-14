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

test('account invalidation prevents coalescing or publishing a previous account dashboard', async () => {
  const previousWindow = globalThis.window;
  const pending: Array<(value: any) => void> = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { rental: { getProviderDashboard: () => new Promise(resolve => pending.push(resolve)) } } } });
  const { invalidateRentalProviderDashboard, loadRentalProviderDashboard } = await import('../src/composables/useRentalProviderEvents');
  try {
    invalidateRentalProviderDashboard();
    const accountA = loadRentalProviderDashboard();
    const rejectedA = assert.rejects(accountA, /Account changed/);
    invalidateRentalProviderDashboard();
    const accountB = loadRentalProviderDashboard();
    assert.equal(pending.length, 2, 'new account starts its own IPC request');
    pending[0]({ pendingRequests: [{ taskPrompt: 'Account A private request' }] });
    await rejectedA;
    pending[1]({ pendingRequests: [] });
    assert.deepEqual((await accountB).pendingRequests, []);
  } finally { invalidateRentalProviderDashboard(); Object.assign(globalThis, { window: previousWindow }); }
});
