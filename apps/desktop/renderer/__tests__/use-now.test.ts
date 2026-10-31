import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { effectScope, nextTick, ref } from "vue";

import { activeNowClockCount, useNow } from "../src/composables/useNow";

describe("useNow shared clock", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_020_000 + 7_000 });
  });
  afterEach(() => mock.timers.reset());

  it("runs one timer for many subscribers and stops after the last one", () => {
    const created = { timeouts: 0, intervals: 0 };
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { created.timeouts += 1; return realSetTimeout(...args); }) as typeof setTimeout;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { created.intervals += 1; return realSetInterval(...args); }) as typeof setInterval;
    try {
      const scopes = Array.from({ length: 50 }, () => effectScope());
      const clocks = scopes.map((scope) => scope.run(() => useNow(30_000))!);
      assert.equal(activeNowClockCount(), 1);
      assert.equal(created.timeouts, 1);
      mock.timers.tick(30_000);
      assert.equal(created.intervals, 1);
      const first = clocks[0]!.value;
      assert.ok(clocks.every((clock) => clock.value === first));
      scopes.slice(1).forEach((scope) => scope.stop());
      assert.equal(activeNowClockCount(), 1);
      scopes[0]!.stop();
      assert.equal(activeNowClockCount(), 0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
    }
  });

  it("ticks on wall-clock boundaries", () => {
    const scope = effectScope();
    const now = scope.run(() => useNow(30_000))!;
    const start = now.value;
    // Started 7 s into a 30 s slot, so the first tick is 23 s later, on the boundary.
    mock.timers.tick(22_999);
    assert.equal(now.value, start);
    mock.timers.tick(1);
    assert.equal(now.value % 30_000, 0);
    mock.timers.tick(30_000);
    assert.equal(now.value % 30_000, 0);
    scope.stop();
  });

  it("subscribes only while active is true", async () => {
    const active = ref(false);
    const scope = effectScope();
    scope.run(() => useNow(1_000, () => active.value));
    assert.equal(activeNowClockCount(), 0);
    active.value = true;
    await nextTick();
    assert.equal(activeNowClockCount(), 1);
    active.value = false;
    await nextTick();
    assert.equal(activeNowClockCount(), 0);
    scope.stop();
  });

  it("skips ticks while the window is hidden and catches up when visible", () => {
    const listeners = new Map<string, () => void>();
    const fakeDocument = {
      hidden: false,
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    (globalThis as { document?: unknown }).document = fakeDocument;
    try {
      const scope = effectScope();
      const now = scope.run(() => useNow(1_000))!;
      mock.timers.tick(1_000);
      fakeDocument.hidden = true;
      const hiddenAt = now.value;
      mock.timers.tick(5_000);
      assert.equal(now.value, hiddenAt);
      fakeDocument.hidden = false;
      listeners.get("visibilitychange")!();
      assert.ok(now.value > hiddenAt);
      scope.stop();
      assert.equal(listeners.size, 0);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
