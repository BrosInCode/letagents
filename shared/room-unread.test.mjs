import assert from "node:assert/strict";
import test from "node:test";
import { createRoomUnreadStore, canClearUnreadBookmark } from "./room-unread.mjs";

test("bookmarks persist per account and room, without changing existing markers or receipt evidence", () => {
  const data = new Map([["legacy-markers", '{"a":"msg_9"}'], ["receipts", '{"a":[1,9]}']]);
  const storage = () => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  const store = createRoomUnreadStore({ storage, namespace: "test" });
  const a = store.mark("alice", " RoomA ", "msg_3");
  store.mark("bob", "rooma", "msg_5");
  store.mark("alice", "roomb", "msg_7");
  const reload = createRoomUnreadStore({ storage, namespace: "test" });
  assert.equal(reload.get("alice", "rooma").revision, a.revision);
  assert.equal(reload.get("bob", "rooma").messageId, "msg_5");
  assert.equal(reload.get("alice", "roomb").messageId, "msg_7");
  assert.equal(reload.get("other", "rooma"), null);
  assert.equal(data.get("legacy-markers"), '{"a":"msg_9"}');
  assert.equal(data.get("receipts"), '{"a":[1,9]}');
});

test("a stale clear re-reads storage and cannot erase a newer mark from another window", () => {
  const data = new Map();
  const storage = () => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  const first = createRoomUnreadStore({ storage, namespace: "test" });
  const second = createRoomUnreadStore({ storage, namespace: "test" });
  const old = first.mark("a", "room", "msg_1");
  const newer = second.mark("a", "room", "msg_2");
  assert.equal(first.clear("a", "room", old.revision), false);
  assert.deepEqual(first.get("a", "room"), newer);
  assert.equal(second.clear("a", "room", newer.revision), true);
  assert.equal(first.get("a", "room"), null);
});

test("marking works when randomUUID is absent or unavailable outside a secure context", (t) => {
  const data = new Map();
  const store = createRoomUnreadStore({
    namespace: "test",
    storage: () => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }),
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  t.after(() => Object.defineProperty(globalThis, "crypto", original));
  for (const crypto of [undefined, {}, { randomUUID() { throw Error("unavailable"); } }]) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    const first = store.mark("alice", "room", "msg_1");
    const second = store.mark("alice", "room", "msg_2");
    assert.ok(first?.revision);
    assert.ok(second?.revision);
    assert.notEqual(second.revision, first.revision);
    assert.equal(store.clear("alice", "room", first.revision), false);
    assert.deepEqual(store.get("alice", "room"), second);
  }
});

test("storage getter, read, write and malformed data failures do not escape or create a bookmark", () => {
  const fail = () => { throw new Error("blocked"); };
  for (const storage of [fail, () => ({ getItem: fail, setItem: fail }), () => ({ getItem: () => null, setItem: fail })]) {
    const store = createRoomUnreadStore({ storage, namespace: "test" });
    assert.equal(store.get("a", "room"), null);
    assert.equal(store.mark("a", "room", "msg_1"), null);
    assert.equal(store.clear("a", "room", "r"), false);
  }
  for (const value of ["bad JSON", "null", "{}", '[null,{},{"room":"x"}]']) {
    const store = createRoomUnreadStore({ storage: () => ({ getItem: () => value, setItem() {} }), namespace: "test" });
    assert.equal(store.get("a", "x"), null);
  }
});

test("500 most recently marked rooms are retained; replacing one does not consume another slot", () => {
  let raw = null;
  const store = createRoomUnreadStore({ namespace: "test", storage: () => ({ getItem: () => raw, setItem: (_, value) => { raw = value; } }) });
  for (let i = 0; i < 501; i++) store.mark("a", "room" + i, "msg_" + i);
  assert.equal(store.get("a", "room0"), null);
  assert.equal(store.get("a", "room1").messageId, "msg_1");
  store.mark("a", "room1", "msg_900");
  store.mark("a", "room501", "msg_501");
  assert.equal(store.get("a", "room2"), null);
  assert.equal(store.get("a", "room1").messageId, "msg_900");
  assert.equal(JSON.parse(raw).length, 500);
});

test("only a revealed bookmark from entry can clear at the visible, focused bottom", () => {
  const current = { revision: "old" };
  const eligible = { enteredRevision: "old", current, revealed: true, atBottom: true, visible: true, focused: true };
  assert.equal(canClearUnreadBookmark(eligible), true);
  for (const key of ["revealed", "atBottom", "visible", "focused"]) {
    assert.equal(canClearUnreadBookmark({ ...eligible, [key]: false }), false, key);
  }
  assert.equal(canClearUnreadBookmark({ ...eligible, enteredRevision: null }), false);
  assert.equal(canClearUnreadBookmark({ ...eligible, current: { revision: "new" } }), false);
  assert.equal(canClearUnreadBookmark({ ...eligible, current: null }), false);
});
