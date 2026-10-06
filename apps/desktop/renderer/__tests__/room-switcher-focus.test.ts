import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  coordinateRoomSwitcherFocus,
  focusSwitchedRoomOnceRendered,
  DESKTOP_COMPOSER_LOADING_SELECTOR,
  DESKTOP_COMPOSER_SELECTOR,
  DESKTOP_ROOM_MAIN_SELECTOR,
  resolveRoomSwitcherActivationAction,
  resolveRoomSwitcherFocusTarget,
} from "../src/domain/room-switcher-focus";

interface MockElement {
  id: string;
  tagName: string;
  isConnected: boolean;
  disabled?: boolean;
}

function createElement(
  id: string,
  tagName = "div",
  options: { isConnected?: boolean; disabled?: boolean } = {},
): MockElement {
  return {
    id,
    tagName,
    isConnected: options.isConnected ?? true,
    disabled: options.disabled ?? false,
  };
}

describe("room-switcher-focus: pure decision function", () => {
  it("focuses composer when composer is available in the room", () => {
    const composer = createElement("composer-input", "textarea");
    const main = createElement("desktop-main", "section");

    const decision = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: composer,
      mainElement: main,
    });

    assert.equal(decision.action, "composer");
    assert.equal(decision.target?.id, "composer-input");
  });

  it("focuses composer when choosing the room that is already open", () => {
    const composer = createElement("composer-input", "textarea");
    const main = createElement("desktop-main", "section");

    const decision = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: composer,
      mainElement: main,
    });

    assert.equal(decision.action, "composer");
    assert.equal(decision.target?.id, "composer-input");
  });

  it("falls back to the room main region when destination has no composer (e.g. read-only)", () => {
    const main = createElement("desktop-room-shell", "section");

    const decision = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: null,
      mainElement: main,
    });

    assert.equal(decision.action, "main");
    assert.equal(decision.target?.id, "desktop-room-shell");
  });

  it("falls back to the room main region when composer is disabled", () => {
    const disabledComposer = createElement("composer-input", "textarea", { disabled: true });
    const main = createElement("desktop-room-shell", "section");

    const decision = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: disabledComposer,
      mainElement: main,
    });

    assert.equal(decision.action, "main");
    assert.equal(decision.target?.id, "desktop-room-shell");
  });

  it("falls back to the room main region when composer is disconnected", () => {
    const disconnectedComposer = createElement("composer-input", "textarea", { isConnected: false });
    const main = createElement("desktop-main", "section");

    const decision = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: disconnectedComposer,
      mainElement: main,
    });

    assert.equal(decision.action, "main");
    assert.equal(decision.target?.id, "desktop-main");
  });

  it("never resolves focus to <body>", () => {
    const bodyElement = createElement("body-element", "body");

    const decisionWithBodyComposer = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: bodyElement,
      mainElement: null,
    });
    assert.notEqual(decisionWithBodyComposer.target?.tagName.toLowerCase(), "body");
    assert.equal(decisionWithBodyComposer.action, "none");

    const decisionWithBodyMain = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: null,
      mainElement: bodyElement,
    });
    assert.notEqual(decisionWithBodyMain.target?.tagName.toLowerCase(), "body");
    assert.equal(decisionWithBodyMain.action, "none");
  });

  it("returns action 'none' when no focusable candidate is found", () => {
    const decision = resolveRoomSwitcherFocusTarget<MockElement>({
      composerElement: null,
      mainElement: null,
    });

    assert.equal(decision.action, "none");
    assert.equal(decision.target, null);
  });
});

describe("room-switcher-focus: activation synchronization decision", () => {
  it("case 1: decides immediate focus when chosen room is already active", () => {
    const action = resolveRoomSwitcherActivationAction({
      currentRoomId: "room_alpha",
      chosenRoomId: "room_alpha",
    });
    assert.equal(action, "immediate");
  });

  it("case 2: decides to wait when chosen room is not yet active", () => {
    const action = resolveRoomSwitcherActivationAction({
      currentRoomId: "room_alpha",
      chosenRoomId: "room_beta",
    });
    assert.equal(action, "wait");
  });

  it("case 3: decides to abandon when chosen room never becomes active before timeout", () => {
    const action = resolveRoomSwitcherActivationAction({
      currentRoomId: "room_alpha",
      chosenRoomId: "room_beta",
      timedOut: true,
    });
    assert.equal(action, "abandon");
  });
});

describe("room-switcher-focus: coordinateRoomSwitcherFocus coordinator", () => {
  it("case 1 (already active): starts focus with a room ownership watch and no activation timeout", () => {
    let focusStarted = 0;
    let watchRegistered = 0;
    let timeoutRegistered = 0;

    coordinateRoomSwitcherFocus({
      currentRoomId: () => "room_1",
      chosenRoomId: "room_1",
      startFocus: () => {
        focusStarted += 1;
      },
      watchRoomId: () => {
        watchRegistered += 1;
        return () => {};
      },
      setTimeoutFn: () => {
        timeoutRegistered += 1;
        return 123;
      },
    });

    assert.equal(focusStarted, 1);
    assert.equal(watchRegistered, 1);
    assert.equal(timeoutRegistered, 0);
  });

  it("case 2 (becomes active): waits for active room to match, awaits nextTick, then starts focus", async () => {
    let currentId = "room_1";
    let focusStarted = 0;
    let nextTickCalled = 0;
    let watchUnsubscribed = 0;
    let timeoutCleared = 0;
    let watchListener: ((roomId: string) => void) | null = null;

    coordinateRoomSwitcherFocus({
      currentRoomId: () => currentId,
      chosenRoomId: "room_2",
      startFocus: () => {
        focusStarted += 1;
      },
      watchRoomId: (listener) => {
        watchListener = listener;
        return () => {
          watchUnsubscribed += 1;
        };
      },
      nextTick: async () => {
        nextTickCalled += 1;
      },
      setTimeoutFn: () => 456,
      clearTimeoutFn: () => {
        timeoutCleared += 1;
      },
    });

    // Before activation
    assert.equal(focusStarted, 0);
    assert.equal(nextTickCalled, 0);
    assert.equal(watchUnsubscribed, 0);
    assert.ok(watchListener);

    // Active room changes to destination room
    currentId = "room_2";
    await (watchListener as ((id: string) => void))("room_2");

    assert.equal(nextTickCalled, 1);
    assert.equal(focusStarted, 1);
    assert.equal(watchUnsubscribed, 0, "room watch lasts until focus completes or is cancelled");
    assert.equal(timeoutCleared, 1);
  });

  it("case 3 (never becomes active): cleans up on timeout and never starts focus", () => {
    let focusStarted = 0;
    let watchUnsubscribed = 0;
    let timeoutHandler: (() => void) | null = null;

    coordinateRoomSwitcherFocus({
      currentRoomId: () => "room_1",
      chosenRoomId: "room_2",
      startFocus: () => {
        focusStarted += 1;
      },
      watchRoomId: () => () => {
        watchUnsubscribed += 1;
      },
      setTimeoutFn: (handler) => {
        timeoutHandler = handler;
        return 789;
      },
      clearTimeoutFn: () => {},
    });

    assert.equal(focusStarted, 0);
    assert.equal(watchUnsubscribed, 0);
    assert.ok(timeoutHandler);

    // Timeout occurs before room activation
    (timeoutHandler as unknown as () => void)();

    assert.equal(focusStarted, 0);
    assert.equal(watchUnsubscribed, 1);
  });

  it("cancelling coordinator before activation prevents focus application", async () => {
    let focusStarted = 0;
    let watchUnsubscribed = 0;
    let timeoutCleared = 0;
    let watchListener: ((roomId: string) => void) | null = null;

    const cancel = coordinateRoomSwitcherFocus({
      currentRoomId: () => "room_1",
      chosenRoomId: "room_2",
      startFocus: () => {
        focusStarted += 1;
      },
      watchRoomId: (listener) => {
        watchListener = listener;
        return () => {
          watchUnsubscribed += 1;
        };
      },
      setTimeoutFn: () => 999,
      clearTimeoutFn: () => {
        timeoutCleared += 1;
      },
    });

    cancel();
    assert.equal(watchUnsubscribed, 1);
    assert.equal(timeoutCleared, 1);

    // A late active room change after cancel must not trigger focus
    await (watchListener as unknown as (id: string) => void)?.("room_2");
    assert.equal(focusStarted, 0);
  });
});

describe("room-switcher-focus: selector contracts", () => {
  it("DESKTOP_COMPOSER_SELECTOR targets composer input and ignores disabled", () => {
    assert.ok(DESKTOP_COMPOSER_SELECTOR.includes('[data-testid="desktop-composer-input"]'));
    assert.ok(DESKTOP_COMPOSER_SELECTOR.includes(":not([disabled])"));
  });

  it("DESKTOP_ROOM_MAIN_SELECTOR targets room shell or semantic main regions", () => {
    assert.ok(DESKTOP_ROOM_MAIN_SELECTOR.includes('[data-testid="desktop-room-shell"]'));
    assert.ok(DESKTOP_ROOM_MAIN_SELECTOR.includes('[data-testid="desktop-main"]'));
    assert.ok(DESKTOP_ROOM_MAIN_SELECTOR.includes('[role="main"]'));
    assert.ok(DESKTOP_ROOM_MAIN_SELECTOR.includes("main"));
  });

  it("DESKTOP_COMPOSER_LOADING_SELECTOR targets composer loading placeholder", () => {
    assert.ok(DESKTOP_COMPOSER_LOADING_SELECTOR.includes('[data-testid="desktop-composer-loading"]'));
  });
});

function focusFixture(options: { hiddenComposer?: boolean; rejectedComposerFocus?: boolean } = {}) {
  const actions: string[] = [];
  const doc = { activeElement: null as unknown, querySelector: (selector: string): unknown => {
    if (selector === DESKTOP_COMPOSER_SELECTOR) return composer;
    if (selector === DESKTOP_ROOM_MAIN_SELECTOR) return main;
    return null;
  }, querySelectorAll: () => [main] };
  function element(hidden: boolean, acceptsFocus: boolean) {
    const target = {
      tagName: "DIV", isConnected: true, tabIndex: -1,
      getClientRects: () => hidden ? [] : [{}],
      closest: () => null,
      ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: "visible" }) } },
      hasAttribute: () => false, setAttribute() {},
      focus() { if (!hidden && acceptsFocus) doc.activeElement = target; },
    };
    return target;
  }
  const composer = element(Boolean(options.hiddenComposer), !options.rejectedComposerFocus);
  const main = element(false, true);
  return { doc: doc as unknown as Document, composer, main, actions };
}

describe("room-switcher-focus: real focus attempts", () => {
  for (const options of [{ hiddenComposer: true }, { rejectedComposerFocus: true }]) {
    it(`falls back to visible main when composer cannot receive focus: ${JSON.stringify(options)}`, () => {
      const fixture = focusFixture(options);
      const cancel = focusSwitchedRoomOnceRendered({ doc: fixture.doc, onFocus: decision => fixture.actions.push(decision.action) });
      assert.equal(fixture.doc.activeElement, fixture.main);
      assert.deepEqual(fixture.actions, ["main"]);
      cancel();
    });
  }
});

it("cancels focus when the chosen room is left while its composer is still loading", async () => {
  let current = "a";
  let listener: (id: string) => void = () => {};
  let cancelled = 0;
  let started = 0;
  let released = 0;
  const cancel = coordinateRoomSwitcherFocus({
    currentRoomId: () => current, chosenRoomId: "b",
    startFocus: () => { started++; return () => { cancelled++; }; },
    watchRoomId: callback => { listener = callback; return () => { released++; }; },
    nextTick: async () => {}, setTimeoutFn: () => 1, clearTimeoutFn() {},
  });
  current = "b";
  await listener(current);
  assert.equal(started, 1);
  current = "c";
  await listener(current);
  assert.equal(cancelled, 1, "a pending render must lose focus ownership when another room opens");
  assert.equal(released, 1);
  cancel();
});

it("does not start focus if room ownership changes during nextTick", async () => {
  let current = "a";
  let listener: (id: string) => void = () => {};
  let finishTick!: () => void;
  let started = 0;
  const cancel = coordinateRoomSwitcherFocus({
    currentRoomId: () => current, chosenRoomId: "b",
    startFocus: () => { started++; },
    watchRoomId: callback => { listener = callback; return () => {}; },
    nextTick: () => new Promise<void>(resolve => { finishTick = resolve; }),
    setTimeoutFn: () => 1, clearTimeoutFn() {},
  });
  current = "b";
  const pending = listener(current);
  current = "c";
  finishTick();
  await pending;
  assert.equal(started, 0);
  cancel();
});

it("opening the switcher again cancels the previous focus job", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const ts = (await import("typescript")).default;
  const text = readFileSync(new URL("../src/components/desktop/sidebar/DesktopSidebar.vue", import.meta.url), "utf8");
  const marker = '<script setup lang="ts">';
  const ast = ts.createSourceFile("sidebar.ts", text.slice(text.indexOf(marker) + marker.length, text.indexOf("</script>")), ts.ScriptTarget.Latest, true);
  const handler = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "openRoomSwitcher");
  assert.ok(handler);
  let cancelled = 0;
  const switcherOpen = { value: false };
  const open = runInNewContext(ts.transpileModule(handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nopenRoomSwitcher", {
    props: { batchActionBusy: false, selectionActive: false }, switcherOpen,
    closeRoomContextMenu() {}, closeBackgroundContextMenu() {},
    cancelPendingSwitcherFocus: () => { cancelled++; },
  });
  open();
  assert.equal(cancelled, 1);
  assert.equal(switcherOpen.value, true);
});

it("successful focus and timeout both release the room watch and pending frames", () => {
  const savedFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const savedCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => frames.delete(id) });
  try {
    for (const timeout of [false, true]) {
      const fixture = focusFixture();
      if (timeout) fixture.doc.querySelectorAll = (() => []) as unknown as Document["querySelectorAll"];
      if (timeout) fixture.doc.querySelector = (() => null) as Document["querySelector"];
      let released = 0;
      const cancel = coordinateRoomSwitcherFocus({
        currentRoomId: () => "a", chosenRoomId: "a",
        watchRoomId: () => () => { released++; },
        startFocus: (isCurrent, onComplete) => focusSwitchedRoomOnceRendered({ doc: fixture.doc, timeoutMs: 0, isCurrent, onComplete }),
      });
      const [id, callback] = [...frames.entries()][0]!;
      frames.delete(id);
      callback(0);
      assert.equal(released, 1);
      assert.equal(frames.size, 0);
      assert.equal(fixture.doc.activeElement, timeout ? null : fixture.composer);
      cancel();
      assert.equal(released, 1, "cleanup is idempotent");
    }
  } finally {
    if (savedFrame) Object.defineProperty(globalThis, "requestAnimationFrame", savedFrame);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (savedCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", savedCancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
});

it("a render attempt cannot focus after its selected room loses ownership", () => {
  const fixture = focusFixture();
  let completed = 0;
  focusSwitchedRoomOnceRendered({ doc: fixture.doc, isCurrent: () => false, onComplete: () => { completed++; } });
  assert.equal(fixture.doc.activeElement, null);
  assert.equal(completed, 1);
});
