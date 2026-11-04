import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INLINE_DEMO_FOCUS_RESTORE_MS,
  inlineDemoFocusToRestore,
  inlineDemoFrameHeight,
  inlineDemoMayRestart,
  inlineDemoStoppedText,
} from "../src/components/desktop/content/desktop-chat-message/attachments";
import {
  dropPendingInlineDemoHeight,
  INLINE_DEMO_HEIGHT_MIN_SHRINK,
  INLINE_DEMO_HEIGHT_SETTLE_MS,
  inlineDemoHeightSettleDelay,
  newInlineDemoHeight,
  reportInlineDemoHeight,
  settleInlineDemoHeight,
  type InlineDemoHeight,
} from "../src/components/desktop/content/desktop-chat-message/inline-demo-height";
import type { DesktopInlineHtmlDemoEvent } from "../../electron/ipc-types";
import { createInlineDemoEvents } from "../src/components/desktop/content/desktop-chat-message/inline-demo-events";
import {
  createInlineDemoSlots,
  inlineDemoSlots,
  MAX_RUNNING_INLINE_DEMOS,
} from "../src/components/desktop/content/desktop-chat-message/inline-demo-slots";

describe("inline demo run slots", () => {
  it("lets three demos run across the app and queues the rest", () => {
    assert.equal(MAX_RUNNING_INLINE_DEMOS, 3);
    const slots = createInlineDemoSlots(MAX_RUNNING_INLINE_DEMOS);
    const started: string[] = [];
    for (const name of ["a", "b", "c", "d", "e"]) slots.request(() => started.push(name));

    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(slots.runningCount(), 3);
    assert.equal(slots.waitingCount(), 2);
  });

  it("shares one manager between all cards", () => {
    const first = inlineDemoSlots.request(() => undefined);
    const second = inlineDemoSlots.request(() => undefined);
    const third = inlineDemoSlots.request(() => undefined);
    let fourthStarted = false;
    const fourth = inlineDemoSlots.request(() => { fourthStarted = true; });
    try {
      assert.equal(fourthStarted, false);
      first.release();
      assert.equal(fourthStarted, true);
    } finally {
      for (const slot of [first, second, third, fourth]) slot.release();
    }
    assert.equal(inlineDemoSlots.runningCount(), 0);
    assert.equal(inlineDemoSlots.waitingCount(), 0);
  });

  it("starts the next waiter, in request order, when a running demo releases", () => {
    const slots = createInlineDemoSlots(2);
    const started: string[] = [];
    const a = slots.request(() => started.push("a"));
    slots.request(() => started.push("b"));
    slots.request(() => started.push("c"));
    slots.request(() => started.push("d"));
    assert.deepEqual(started, ["a", "b"]);

    a.release();
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(slots.runningCount(), 2);
    assert.equal(slots.waitingCount(), 1);
  });

  it("frees one place for one release, even when released twice", () => {
    const slots = createInlineDemoSlots(1);
    const started: string[] = [];
    const a = slots.request(() => started.push("a"));
    slots.request(() => started.push("b"));
    slots.request(() => started.push("c"));

    a.release();
    a.release();
    assert.deepEqual(started, ["a", "b"]);
    assert.equal(slots.runningCount(), 1);
    assert.equal(slots.waitingCount(), 1);
  });

  it("drops a waiter that leaves the queue before its turn", () => {
    const slots = createInlineDemoSlots(1);
    const started: string[] = [];
    const a = slots.request(() => started.push("a"));
    const b = slots.request(() => started.push("b"));
    slots.request(() => started.push("c"));

    b.release();
    b.release();
    assert.equal(slots.waitingCount(), 1);
    a.release();
    assert.deepEqual(started, ["a", "c"]);
  });

  it("does not let a released waiter start later", () => {
    const slots = createInlineDemoSlots(1);
    let started = false;
    const a = slots.request(() => undefined);
    slots.request(() => { started = true; }).release();
    a.release();
    assert.equal(started, false);
    assert.equal(slots.runningCount(), 0);
  });
});

describe("inline demo frame height", () => {
  it("uses 240 px until main reports a height", () => {
    assert.equal(inlineDemoFrameHeight(null), 240);
    assert.equal(inlineDemoFrameHeight(Number.NaN), 240);
    assert.equal(inlineDemoFrameHeight(Number.POSITIVE_INFINITY), 240);
  });

  it("keeps the reported height between 120 and 560 px", () => {
    assert.equal(inlineDemoFrameHeight(0), 120);
    assert.equal(inlineDemoFrameHeight(119), 120);
    assert.equal(inlineDemoFrameHeight(120), 120);
    assert.equal(inlineDemoFrameHeight(333), 333);
    assert.equal(inlineDemoFrameHeight(560), 560);
    assert.equal(inlineDemoFrameHeight(561), 560);
    assert.equal(inlineDemoFrameHeight(4000), 560);
    assert.equal(inlineDemoFrameHeight(-50), 120);
  });

  it("rounds to whole pixels", () => {
    assert.equal(inlineDemoFrameHeight(300.4), 300);
    assert.equal(inlineDemoFrameHeight(300.6), 301);
  });
});

describe("inline demo focus hand-back", () => {
  const left = (overrides: Partial<{ isConnected: boolean; at: number }> = {}) => ({
    element: { isConnected: overrides.isConnected ?? true },
    at: overrides.at ?? 9_900,
  });

  it("returns the element that lost focus a moment ago", () => {
    const candidate = left();
    assert.equal(inlineDemoFocusToRestore(candidate, 10_000), candidate.element);
    assert.equal(inlineDemoFocusToRestore(left({ at: 10_000 }), 10_000)?.isConnected, true);
  });

  it("gives back nothing when no element lost focus", () => {
    assert.equal(inlineDemoFocusToRestore(null, 10_000), null);
  });

  it("gives back nothing when the element left the page", () => {
    assert.equal(inlineDemoFocusToRestore(left({ isConnected: false }), 10_000), null);
  });

  it("allows exactly one second after the focus left, and not after", () => {
    assert.equal(INLINE_DEMO_FOCUS_RESTORE_MS, 1_000);
    assert.notEqual(inlineDemoFocusToRestore(left({ at: 9_000 }), 10_000), null);
    assert.equal(inlineDemoFocusToRestore(left({ at: 8_999 }), 10_000), null);
  });

  it("does not trust a time in the future", () => {
    assert.equal(inlineDemoFocusToRestore(left({ at: 10_001 }), 10_000), null);
  });
});

describe("inline demo event hub", () => {
  function fakeChannel() {
    const channel = {
      subscribes: 0,
      unsubscribes: 0,
      listener: null as ((event: DesktopInlineHtmlDemoEvent) => void) | null,
      subscribe(listener: (event: DesktopInlineHtmlDemoEvent) => void) {
        channel.subscribes++;
        channel.listener = listener;
        return () => {
          channel.unsubscribes++;
          channel.listener = null;
        };
      },
    };
    return channel;
  }
  const height = (url: string, value: number): DesktopInlineHtmlDemoEvent => ({ type: "height", url, height: value });

  it("listens to main only after the first card registers", () => {
    const channel = fakeChannel();
    const events = createInlineDemoEvents(channel.subscribe);
    assert.equal(channel.subscribes, 0);

    events.register("letagents-demo://a/", () => undefined);
    events.register("letagents-demo://b/", () => undefined);
    assert.equal(channel.subscribes, 1);
  });

  it("sends each event to the one card that holds its URL", () => {
    const channel = fakeChannel();
    const events = createInlineDemoEvents(channel.subscribe);
    const seenByA: DesktopInlineHtmlDemoEvent[] = [];
    const seenByB: DesktopInlineHtmlDemoEvent[] = [];
    events.register("letagents-demo://a/", (event) => seenByA.push(event));
    events.register("letagents-demo://b/", (event) => seenByB.push(event));

    channel.listener?.(height("letagents-demo://b/", 300));
    channel.listener?.({ type: "stopped", url: "letagents-demo://a/", reason: "crashed" });
    channel.listener?.(height("letagents-demo://unknown/", 100));

    assert.deepEqual(seenByA, [{ type: "stopped", url: "letagents-demo://a/", reason: "crashed" }]);
    assert.deepEqual(seenByB, [height("letagents-demo://b/", 300)]);
  });

  it("routes a focus-refused event to the card that holds its URL", () => {
    const channel = fakeChannel();
    const events = createInlineDemoEvents(channel.subscribe);
    const seen: string[] = [];
    events.register("letagents-demo://a/", (event) => seen.push(`a:${event.type}`));
    events.register("letagents-demo://b/", (event) => seen.push(`b:${event.type}`));

    channel.listener?.({ type: "focus-refused", url: "letagents-demo://b/" });
    assert.deepEqual(seen, ["b:focus-refused"]);
  });

  it("stops sending to a card that unregistered, and a second unregister does nothing", () => {
    const channel = fakeChannel();
    const events = createInlineDemoEvents(channel.subscribe);
    const seen: DesktopInlineHtmlDemoEvent[] = [];
    const stopA = events.register("letagents-demo://a/", (event) => seen.push(event));
    events.register("letagents-demo://b/", () => undefined);

    stopA();
    stopA();
    channel.listener?.(height("letagents-demo://a/", 200));
    assert.deepEqual(seen, []);
    assert.equal(channel.unsubscribes, 0);
  });

  it("stops listening when the last card leaves, and listens again for the next one", () => {
    const channel = fakeChannel();
    const events = createInlineDemoEvents(channel.subscribe);
    const stopA = events.register("letagents-demo://a/", () => undefined);
    const stopB = events.register("letagents-demo://b/", () => undefined);

    stopA();
    assert.equal(channel.unsubscribes, 0);
    stopB();
    assert.equal(channel.unsubscribes, 1);
    assert.equal(channel.listener, null);

    const seen: DesktopInlineHtmlDemoEvent[] = [];
    events.register("letagents-demo://c/", (event) => seen.push(event));
    assert.equal(channel.subscribes, 2);
    channel.listener?.(height("letagents-demo://c/", 150));
    assert.deepEqual(seen, [height("letagents-demo://c/", 150)]);
  });

  it("keeps a newer card's URL when an older card unregisters late", () => {
    const channel = fakeChannel();
    const events = createInlineDemoEvents(channel.subscribe);
    const seen: string[] = [];
    const stopOld = events.register("letagents-demo://a/", () => seen.push("old"));
    events.register("letagents-demo://a/", () => seen.push("new"));

    stopOld();
    channel.listener?.(height("letagents-demo://a/", 200));
    assert.deepEqual(seen, ["new"]);
    assert.equal(channel.unsubscribes, 0);
  });

  it("works when main has no event channel, and tries again for the next card", () => {
    let available = false;
    let subscribes = 0;
    const events = createInlineDemoEvents(() => {
      subscribes++;
      return available ? () => undefined : undefined;
    });

    const stopA = events.register("letagents-demo://a/", () => undefined);
    stopA();
    assert.equal(subscribes, 1);

    available = true;
    events.register("letagents-demo://b/", () => undefined);
    assert.equal(subscribes, 2);
  });
});

describe("inline demo stopped text", () => {
  it("says a frozen or crashed demo stopped responding", () => {
    assert.equal(inlineDemoStoppedText("unresponsive"), "This demo stopped responding.");
    assert.equal(inlineDemoStoppedText("crashed"), "This demo stopped responding.");
  });

  it("says an overloaded demo was stopped for slowing down the app", () => {
    assert.equal(inlineDemoStoppedText("overloaded"), "This demo was stopped because it slowed down the app.");
  });
});

describe("inline demo restart limit", () => {
  it("restarts a lost demo twice in 30 s and then stops", () => {
    assert.equal(inlineDemoMayRestart(1_000, []), true);
    assert.equal(inlineDemoMayRestart(2_000, [1_000]), true);
    assert.equal(inlineDemoMayRestart(3_000, [1_000, 2_000]), false);
  });

  it("forgets restarts older than 30 s", () => {
    assert.equal(inlineDemoMayRestart(31_000, [1_000, 2_000]), true);
    assert.equal(inlineDemoMayRestart(30_999, [1_000, 2_000]), false);
  });
});

describe("inline demo height smoothing", () => {
  const report = (state: InlineDemoHeight, height: number, now: number) => reportInlineDemoHeight(state, height, now);

  it("shows the first report at once, even when it is lower than the starting height", () => {
    const state = report(newInlineDemoHeight(), 150, 0);
    assert.equal(state.shown, 150);
  });

  it("shows a higher height at once", () => {
    let state = report(newInlineDemoHeight(), 200, 0);
    state = report(state, 320, 100);
    assert.equal(state.shown, 320);
    assert.equal(state.pending, null);
  });

  it("shows a lower height only after it held for 400 ms", () => {
    let state = report(newInlineDemoHeight(), 320, 0);
    state = report(state, 200, 1_000);
    assert.equal(state.shown, 320);
    assert.deepEqual(state.pending, { height: 200, since: 1_000 });
    assert.equal(inlineDemoHeightSettleDelay(state, 1_000), INLINE_DEMO_HEIGHT_SETTLE_MS);
    assert.equal(inlineDemoHeightSettleDelay(state, 1_350), 50);

    assert.equal(settleInlineDemoHeight(state, 1_399).shown, 320);
    const settled = settleInlineDemoHeight(state, 1_400);
    assert.equal(settled.shown, 200);
    assert.equal(settled.pending, null);
    assert.equal(inlineDemoHeightSettleDelay(settled, 1_400), null);
  });

  it("starts the wait again when another lower height arrives, and keeps it for a repeat", () => {
    let state = report(newInlineDemoHeight(), 320, 0);
    state = report(state, 200, 1_000);
    state = report(state, 200, 1_200);
    assert.deepEqual(state.pending, { height: 200, since: 1_000 });
    state = report(state, 180, 1_300);
    assert.deepEqual(state.pending, { height: 180, since: 1_300 });
  });

  it("drops a pending lower height when the frame grows or the height returns", () => {
    let state = report(newInlineDemoHeight(), 320, 0);
    state = report(state, 200, 1_000);
    assert.equal(report(state, 320, 1_100).pending, null);
    assert.equal(report(state, 400, 1_100).shown, 400);
    assert.equal(dropPendingInlineDemoHeight(state).pending, null);
    assert.equal(dropPendingInlineDemoHeight(state).shown, 320);
  });

  it("applies a due lower height before it takes the next report", () => {
    let state = report(newInlineDemoHeight(), 320, 0);
    state = report(state, 200, 1_000);
    state = report(state, 150, 1_500);
    assert.equal(state.shown, 200);
    assert.deepEqual(state.pending, { height: 150, since: 1_500 });
  });

  it("ignores a decrease smaller than 24 px but shows any increase at once", () => {
    assert.equal(INLINE_DEMO_HEIGHT_MIN_SHRINK, 24);
    const base = report(newInlineDemoHeight(), 300, 0);

    const small = report(base, 277, 1_000);
    assert.equal(small.shown, 300);
    assert.equal(small.pending, null);
    assert.equal(settleInlineDemoHeight(small, 5_000).shown, 300);

    const exact = report(base, 276, 1_000);
    assert.deepEqual(exact.pending, { height: 276, since: 1_000 });
    assert.equal(settleInlineDemoHeight(exact, 1_400).shown, 276);

    assert.equal(report(base, 301, 1_000).shown, 301);
  });

  it("drops a pending shrink when a small decrease arrives after it", () => {
    let state = report(newInlineDemoHeight(), 320, 0);
    state = report(state, 200, 1_000);
    state = report(state, 310, 1_100);
    assert.equal(state.pending, null);
    assert.equal(settleInlineDemoHeight(state, 2_000).shown, 320);
  });

  it("does not creep down when the page follows its frame", () => {
    let state = report(newInlineDemoHeight(), 228, 0);
    for (let step = 1; step <= 40; step += 1) {
      const now = step * 450;
      state = report(settleInlineDemoHeight(state, now), (state.shown ?? 0) - 12, now);
    }
    assert.equal(state.shown, 228);
    assert.equal(state.held, false);
  });

  it("works on frame heights, so changes past 560 px do not count", () => {
    let state = report(newInlineDemoHeight(), 700, 0);
    assert.equal(state.shown, 560);
    state = report(state, 900, 100);
    assert.equal(state.shown, 560);
    assert.equal(state.changedAt.length, 0);
  });

  it("holds the largest height when it changes more than 10 times in 2 s", () => {
    let state = report(newInlineDemoHeight(), 200, 0);
    for (let index = 1; index <= 11; index += 1) {
      state = report(state, index % 2 === 0 ? 200 : 300, index * 100);
    }
    assert.equal(state.held, true);
    assert.equal(state.shown, 300);

    state = report(state, 450, 1_300);
    state = report(state, 130, 1_400);
    assert.equal(state.shown, 300);
    assert.equal(state.pending, null);
  });

  it("does not hold a demo that settles after a few changes, or changes slowly", () => {
    let state = report(newInlineDemoHeight(), 200, 0);
    for (let index = 1; index <= 8; index += 1) state = report(state, 200 + index * 10, index * 100);
    assert.equal(state.held, false);

    let slow = report(newInlineDemoHeight(), 200, 0);
    for (let index = 1; index <= 30; index += 1) slow = report(slow, index % 2 === 0 ? 200 : 300, index * 500);
    assert.equal(slow.held, false);
  });

  it("starts a reload from the shown height without the hold", () => {
    let state = report(newInlineDemoHeight(), 200, 0);
    for (let index = 1; index <= 11; index += 1) state = report(state, index % 2 === 0 ? 200 : 300, index * 100);
    const reloaded = newInlineDemoHeight(state.shown);
    assert.equal(reloaded.held, false);
    assert.equal(reloaded.shown, 300);
    assert.equal(report(reloaded, 150, 5_000).shown, 300);
  });
});
