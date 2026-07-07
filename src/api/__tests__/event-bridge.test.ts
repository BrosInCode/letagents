import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { BridgedEventEmitter, buildBridgeEnvelope, createBridgedEmitter } = await import(
  "../server/event-bridge.js"
);

test("buildBridgeEnvelope inlines events that fit the payload limit", () => {
  const data = { projectId: "room_1", message: { id: "msg_3", text: "hi" } };
  const envelope = buildBridgeEnvelope("messages", "message:created", data, "origin-a");
  assert.deepEqual(envelope, {
    v: 1,
    lane: "messages",
    event: "message:created",
    mode: "inline",
    data,
    origin: "origin-a",
  });
});

test("buildBridgeEnvelope falls back to a reference for oversize message events", () => {
  const data = {
    projectId: "github.com/org/repo",
    message: { id: "msg_42", text: "x".repeat(8_000) },
  };
  const envelope = buildBridgeEnvelope("messages", "message:created", data, "origin-a");
  assert.deepEqual(envelope, {
    v: 1,
    lane: "messages",
    event: "message:created",
    mode: "ref",
    ref: { room_id: "github.com/org/repo", number: 42 },
    origin: "origin-a",
  });
});

test("buildBridgeEnvelope builds references for task, reasoning, and artifact events", () => {
  const oversize = "x".repeat(8_000);
  assert.deepEqual(
    buildBridgeEnvelope("tasks", "task:updated", {
      projectId: "room_1",
      task: { id: "task_7", description: oversize },
    }, "o")?.mode,
    "ref",
  );
  assert.deepEqual(
    buildBridgeEnvelope("reasoning", "reasoning:updated", {
      projectId: "room_1",
      session: { id: "rs_abc" },
      update: { text: oversize },
    }, "o")?.mode,
    "ref",
  );
  assert.deepEqual(
    buildBridgeEnvelope("artifacts", "artifact:updated", {
      projectId: "room_1",
      artifact: { identity_key: "k1", content: oversize },
    }, "o")?.mode,
    "ref",
  );
});

test("buildBridgeEnvelope drops oversize events without a reference form", () => {
  const envelope = buildBridgeEnvelope("github", "github_event:updated", {
    projectId: "room_1",
    event: { body: "x".repeat(8_000) },
  }, "o");
  assert.equal(envelope, null);
});

test("createBridgedEmitter returns one emitter per lane", () => {
  const a = createBridgedEmitter("test_lane");
  const b = createBridgedEmitter("test_lane");
  assert.equal(a, b);
  assert.ok(a instanceof BridgedEventEmitter);
});

test("bridged emitter dispatches locally via emit and emitLocal", () => {
  const emitter = createBridgedEmitter("test_dispatch_lane");
  const received: unknown[] = [];
  emitter.on("evt", (payload: unknown) => received.push(payload));
  emitter.emit("evt", { n: 1 });
  emitter.emitLocal("evt", { n: 2 });
  assert.deepEqual(received, [{ n: 1 }, { n: 2 }]);
});
