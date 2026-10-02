import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  coordinateRoomSwitcherFocus,
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
  it("case 1 (already active): starts focus immediately without registering watch or timeout", () => {
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
    assert.equal(watchRegistered, 0);
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
    assert.equal(watchUnsubscribed, 1);
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
