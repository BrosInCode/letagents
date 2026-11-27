import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};
const { hasFirstRoomTour, markFirstRoomTour, takeFirstRoomTour } = await import("../src/domain/first-room-tour");

beforeEach(() => store.clear());

test("the first room's tour opens once, for that room only", () => {
  markFirstRoomTour("Welcome_ABC");
  assert.equal(takeFirstRoomTour("another_room"), false);
  assert.equal(takeFirstRoomTour("welcome_abc"), true, "room ids compare after normalizing");
  assert.equal(takeFirstRoomTour("welcome_abc"), false, "the mark is used up");
});

test("no mark, no room, or blocked storage never opens the tour", () => {
  assert.equal(takeFirstRoomTour("welcome_abc"), false);
  assert.equal(takeFirstRoomTour(null), false);
  const saved = globalThis.localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  assert.doesNotThrow(() => markFirstRoomTour("welcome_abc"));
  assert.equal(takeFirstRoomTour("welcome_abc"), false);
  (globalThis as { localStorage?: unknown }).localStorage = saved;
});

test("looking at the mark does not use it up", () => {
  markFirstRoomTour("welcome_abc");
  assert.equal(hasFirstRoomTour("Welcome_ABC"), true);
  assert.equal(hasFirstRoomTour("another_room"), false);
  assert.equal(takeFirstRoomTour("welcome_abc"), true, "the tour still takes it once it opens");
  assert.equal(hasFirstRoomTour("welcome_abc"), false);
});
