import assert from "node:assert/strict";
import test from "node:test";

const { createManagedMessageDeliveryTracker } = await import("../main/room-stream-dedupe.js");

test("managed message delivery tracker suppresses duplicate room messages", () => {
  const tracker = createManagedMessageDeliveryTracker();

  assert.equal(tracker.remember("room_1", "msg_1"), true);
  assert.equal(tracker.remember("room_1", "msg_1"), false);
  assert.equal(tracker.remember("room_2", "msg_1"), true);
  assert.equal(tracker.remember("room_1", "msg_2"), true);
});

test("managed message delivery tracker does not suppress messages without ids", () => {
  const tracker = createManagedMessageDeliveryTracker();

  assert.equal(tracker.remember("room_1", null), true);
  assert.equal(tracker.remember("room_1", null), true);
  assert.equal(tracker.remember("room_1", ""), true);
});

test("managed message delivery tracker evicts old message ids", () => {
  const tracker = createManagedMessageDeliveryTracker(2);

  assert.equal(tracker.remember("room_1", "msg_1"), true);
  assert.equal(tracker.remember("room_1", "msg_2"), true);
  assert.equal(tracker.remember("room_1", "msg_3"), true);
  assert.equal(tracker.size(), 2);
  assert.equal(tracker.remember("room_1", "msg_1"), true);
  assert.equal(tracker.remember("room_1", "msg_2"), true);
});
