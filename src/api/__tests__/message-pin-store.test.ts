import assert from "node:assert/strict";
import test from "node:test";
import { createMessagePinStore } from "../../../shared/message-pin-store.mjs";
import { isPinMessageId, messagePinSnippet, type MessagePin } from "../../../shared/message-pins.mjs";
const pin = (id = "msg_1"): MessagePin => ({ message_id: id, sender: "Ada", source: "browser", timestamp: "2026-10-02", thread_root_id: null, snippet: "Shown", pinned_at: "2026-10-02", pinned_by: { login: "ada", name: "Ada", avatar_url: null } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test("pin ids and displayed snippets are bounded without breaking Unicode", () => {
  for (const id of ["msg_1", "msg_2147483647"]) assert.equal(isPinMessageId(id), true);
  for (const id of ["msg_0", "msg_01", "msg_-1", "msg_2147483648", "msg_1/x", "pending:1", null]) assert.equal(isPinMessageId(id), false);
  assert.equal(messagePinSnippet("private stored text", "shown\n  text"), "shown text");
  assert.equal(messagePinSnippet("fallback", ""), "fallback");
  assert.equal(messagePinSnippet("😀".repeat(241)), "😀".repeat(239) + "…");
  assert.equal(messagePinSnippet("<img src=x>"), "<img src=x>", "a snippet is text, not trusted HTML");
});
test("the list is complete, deduplicated, id-validated, and capped", async () => {
  const store = createMessagePinStore({ load: async () => ({ room_id: "a", pins: [pin("bad"), pin(), pin(), ...Array.from({ length: 60 }, (_, i) => pin("msg_" + (i + 2)))] }), mutate: async () => {} });
  store.reset("a"); await tick();
  assert.equal(store.state.pins.length, 50);
  assert.equal(store.state.available, true);
  store.dispose();
});
test("coalesces invalidations during a read into one repair", async () => {
  const first = deferred<any>(); let calls = 0;
  const store = createMessagePinStore({ load: async () => ++calls === 1 ? first.promise : { room_id: "a", pins: [pin()] }, mutate: async () => {} });
  store.reset("a"); await tick();
  void store.refresh(); void store.refresh(); void store.refresh();
  first.resolve({ room_id: "a", pins: [] }); await tick();
  assert.equal(calls, 2); assert.equal(store.state.pins.length, 1);
});
test("room/account reset and disposal discard late reads and mutations", async () => {
  const old = deferred<any>(); const mutation = deferred<void>(); const calls: string[] = [];
  const store = createMessagePinStore<string>({ load: async (room) => { calls.push(room); return room === "a" ? old.promise : { room_id: room, pins: [pin("msg_2")] }; }, mutate: () => mutation.promise });
  store.reset("a"); await tick();
  store.reset("b"); assert.deepEqual(store.state.pins, []); await tick();
  old.resolve({ room_id: "a", pins: [pin()] }); await tick();
  assert.equal(store.state.pins[0]?.message_id, "msg_2");
  void store.setPinned("msg_2", false); await tick();
  store.reset("c"); await tick(); mutation.resolve(); await tick();
  assert.deepEqual(calls, ["a", "b", "c"]);
  store.dispose(); await store.refresh(); assert.deepEqual(store.state.pins, []);
});
test("an older read cannot overwrite a completed write; repair follows it", async () => {
  const stale = deferred<any>(); let reads = 0;
  const store = createMessagePinStore({ load: async () => ++reads === 2 ? stale.promise : { room_id: "a", pins: reads === 1 ? [] : [pin()] }, mutate: async () => {} });
  store.reset("a"); await tick();
  void store.refresh(); await tick();
  const write = store.setPinned("msg_1", true); await tick();
  stale.resolve({ room_id: "a", pins: [pin("msg_9")] }); await write; await tick();
  assert.equal(reads, 3);
  assert.deepEqual(store.state.pins.map((p) => p.message_id), ["msg_1"]);
});

test("failed writes retain membership and report errors; invalidations still repair", async () => {
  const errors: string[] = []; let fail = false; let calls = 0;
  const store = createMessagePinStore({ load: async () => { calls++; if (fail) throw Error("offline"); return { room_id: "a", pins: [pin()] }; }, mutate: async () => { throw Error("pin_limit"); }, onError: (error) => errors.push(error) });
  store.reset("a"); await tick();
  await store.setPinned("msg_1", false);
  assert.equal(store.state.pins.length, 1); assert.equal(store.state.pending, null);
  assert.deepEqual(errors, ["pin_limit"]);
  fail = true; await store.refresh(); assert.equal(store.state.pins.length, 1);
  assert.equal(store.state.error, "offline");
  fail = false; await store.refresh(); assert.equal(store.state.error, null);
  assert.equal(calls, 3);
});
test("synchronous transport errors leave no stuck operation; local rooms cannot mutate", async () => {
  let calls = 0;
  const store = createMessagePinStore({ load: () => { calls++; throw Error("sync"); }, mutate: async () => { assert.fail("cannot write unavailable store"); } });
  store.reset("a"); await tick(); await store.refresh();
  assert.equal(calls, 2); assert.equal(store.state.loading, false);
  await store.setPinned("msg_1", true);
});

test("reset before dispatch cancels queued reads and writes, including an account switch", async () => {
  const reads: string[] = [], writes: string[] = [];
  const store = createMessagePinStore<string>({ load: async (room) => { reads.push(room); return { room_id: room, pins: [] }; }, mutate: async (room) => { writes.push(room); } });
  store.reset("retired"); store.reset("current"); await tick();
  assert.deepEqual(reads, ["current"]);
  const mutation = store.setPinned("msg_1", true);
  store.reset("new-account"); await mutation; await tick();
  assert.deepEqual(writes, []);
  store.reset("disposed"); store.dispose(); await tick();
  assert.deepEqual(reads, ["current", "new-account"]);
});
test("a successful write remains pending until its authoritative repair arrives", async () => {
  const repair = deferred<any>(); let reads = 0, writes = 0;
  const store = createMessagePinStore({ load: async () => ++reads === 1 ? { room_id: "a", pins: [] } : repair.promise, mutate: async () => { writes++; } });
  store.reset("a"); await tick();
  const write = store.setPinned("msg_1", true); await tick();
  assert.equal(store.state.pending, "msg_1");
  await store.setPinned("msg_1", true); assert.equal(writes, 1);
  repair.resolve({ room_id: "a", pins: [pin()] }); await write;
  assert.equal(store.state.pending, null); assert.equal(store.state.pins.length, 1);
});
