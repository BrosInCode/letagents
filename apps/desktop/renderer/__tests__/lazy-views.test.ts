import assert from "node:assert/strict";
import test from "node:test";
import { defineComponent } from "vue";

import { createIdlePreloader, lazyView, type IdleScheduler } from "../src/lazy-views";

/** What `import()` gives: a module namespace whose default export is the view. */
function moduleOf<T>(view: T): { default: T } {
  return Object.defineProperty({ default: view }, Symbol.toStringTag, { value: "Module" });
}

/** A scheduler the test drives by hand: nothing runs until it says so. */
function manualScheduler() {
  const paints: (() => void)[] = [];
  const idles: { callback: () => void; timeoutMs: number }[] = [];
  const scheduler: IdleScheduler = {
    afterPaint: (callback) => { paints.push(callback); },
    whenIdle: (callback, timeoutMs) => { idles.push({ callback, timeoutMs }); },
  };
  return {
    scheduler,
    paints,
    idles,
    paint() { paints.shift()?.(); },
    async idle() {
      idles.shift()?.callback();
      // Let the task's promise settle and the next slot be requested.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

test("the idle preloader does nothing before the first-room signal", () => {
  const clock = manualScheduler();
  const calls: string[] = [];
  createIdlePreloader([async () => { calls.push("settings"); }], clock.scheduler);
  assert.equal(clock.paints.length, 0);
  assert.equal(clock.idles.length, 0);
  assert.deepEqual(calls, []);
});

test("after the signal it waits for a painted frame, then loads one view per idle slot, in order", async () => {
  const clock = manualScheduler();
  const calls: string[] = [];
  const start = createIdlePreloader([
    async () => { calls.push("settings"); },
    async () => { calls.push("inbox"); },
  ], clock.scheduler, 1234);

  start();
  assert.equal(clock.paints.length, 1);
  assert.equal(clock.idles.length, 0, "no idle request before the frame has painted");

  clock.paint();
  assert.equal(clock.idles.length, 1);
  assert.equal(clock.idles[0].timeoutMs, 1234);
  assert.deepEqual(calls, []);

  await clock.idle();
  assert.deepEqual(calls, ["settings"]);
  assert.equal(clock.idles.length, 1, "the next view waits for its own idle slot");

  await clock.idle();
  assert.deepEqual(calls, ["settings", "inbox"]);
  assert.equal(clock.idles.length, 0);
});

test("the idle preloader runs once, however often the signal comes", async () => {
  const clock = manualScheduler();
  let loads = 0;
  const start = createIdlePreloader([async () => { loads += 1; }], clock.scheduler);
  start();
  start();
  start();
  assert.equal(clock.paints.length, 1);
  clock.paint();
  await clock.idle();
  start();
  assert.equal(clock.paints.length, 0);
  assert.equal(loads, 1);
});

test("a rejected or throwing import does not stop the views after it", async () => {
  const clock = manualScheduler();
  const calls: string[] = [];
  const start = createIdlePreloader([
    () => Promise.reject(new Error("chunk missing")),
    () => { throw new Error("loader threw"); },
    async () => { calls.push("my-work"); },
  ], clock.scheduler);
  start();
  clock.paint();
  await clock.idle();
  await clock.idle();
  await clock.idle();
  assert.deepEqual(calls, ["my-work"]);
});

test("the idle preloader never throws, even when the scheduler does", () => {
  const throwing: IdleScheduler = {
    afterPaint: () => { throw new Error("no frames"); },
    whenIdle: () => { throw new Error("no idle"); },
  };
  assert.doesNotThrow(() => createIdlePreloader([async () => undefined], throwing)());

  const idleThrows: IdleScheduler = {
    afterPaint: (callback) => callback(),
    whenIdle: () => { throw new Error("no idle"); },
  };
  assert.doesNotThrow(() => createIdlePreloader([async () => undefined], idleThrows)());
});

test("without requestIdleCallback or requestAnimationFrame the default scheduler still preloads", async () => {
  assert.equal(typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback, "undefined");
  let loads = 0;
  createIdlePreloader([async () => { loads += 1; }])();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loads, 1);
});

test("a preloaded view is resolved, so its next mount renders in the same pass", async () => {
  const View = defineComponent({ name: "PreloadedView", render: () => null });
  let loads = 0;
  const view = lazyView(async () => { loads += 1; return moduleOf(View); });
  const wrapper = view.component as { __asyncResolved?: unknown };
  assert.equal(wrapper.__asyncResolved, undefined);

  await view.preload();
  assert.equal(wrapper.__asyncResolved, View);
  await view.preload();
  assert.equal(loads, 1, "the chunk is requested once");
});

test("a failed preload resolves quietly and does not poison the view's own load", async () => {
  const View = defineComponent({ name: "LateView", render: () => null });
  let attempts = 0;
  const view = lazyView(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("chunk missing");
    return moduleOf(View);
  });
  await assert.doesNotReject(view.preload());
  const wrapper = view.component as { __asyncLoader: () => Promise<unknown>; __asyncResolved?: unknown };
  assert.equal(wrapper.__asyncResolved, undefined);

  // Mounting the view calls the wrapper's loader: it asks for the chunk again.
  assert.equal(await wrapper.__asyncLoader(), View);
  assert.equal(attempts, 2);
  assert.equal(wrapper.__asyncResolved, View);
});
