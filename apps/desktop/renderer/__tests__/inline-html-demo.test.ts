import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INLINE_DEMO_FOCUS_INTENT_MS,
  inlineDemoFrameHeight,
  inlineDemoMayTakeFocus,
  type InlineDemoFocusFacts,
} from "../src/components/desktop/content/desktop-chat-message/attachments";
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

describe("inline demo focus guard", () => {
  const facts = (overrides: Partial<InlineDemoFocusFacts>): InlineDemoFocusFacts => ({
    now: 10_000,
    pointerDownAt: null,
    tabKeyAt: null,
    holdsFocus: false,
    ...overrides,
  });

  it("refuses focus the person did not ask for", () => {
    assert.equal(inlineDemoMayTakeFocus(facts({})), false);
    assert.equal(inlineDemoMayTakeFocus(facts({ pointerDownAt: 4_000, tabKeyAt: 5_000 })), false);
  });

  it("allows focus right after a click or a Tab key press", () => {
    assert.equal(inlineDemoMayTakeFocus(facts({ pointerDownAt: 9_900 })), true);
    assert.equal(inlineDemoMayTakeFocus(facts({ tabKeyAt: 9_950 })), true);
    assert.equal(inlineDemoMayTakeFocus(facts({ pointerDownAt: 10_000 })), true);
  });

  it("allows focus for exactly one second after the input and not after", () => {
    assert.equal(INLINE_DEMO_FOCUS_INTENT_MS, 1_000);
    assert.equal(inlineDemoMayTakeFocus(facts({ pointerDownAt: 9_000 })), true);
    assert.equal(inlineDemoMayTakeFocus(facts({ pointerDownAt: 8_999 })), false);
    assert.equal(inlineDemoMayTakeFocus(facts({ tabKeyAt: 8_999 })), false);
  });

  it("does not trust an input time that is in the future", () => {
    assert.equal(inlineDemoMayTakeFocus(facts({ pointerDownAt: 10_001 })), false);
  });

  it("lets the window hand focus back to a demo the person already focused", () => {
    assert.equal(inlineDemoMayTakeFocus(facts({ holdsFocus: true })), true);
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
