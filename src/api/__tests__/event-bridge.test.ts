import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  BridgedEventEmitter,
  buildBridgeEnvelope,
  createBridgedEmitter,
  createOrderedBridgeNotificationReceiver,
  dispatchBridgeNotification,
  roomEventBridgeLossEvents,
} = await import(
  "../server/event-bridge.js"
);
const { queueRoomAgentCredentialInvalidationsTx } = await import(
  "../rooms/agent-credential-events.js"
);

test("maximum credential invalidations are chunked into valid transactional notifications", async () => {
  let notificationCount = 0;
  await queueRoomAgentCredentialInvalidationsTx({
    async execute() { notificationCount += 1; },
  }, [{
    room_id: `room_${"r".repeat(1_019)}`,
    agent_session_id: `session_${"s".repeat(16)}`,
    credential_fingerprints: Array.from({ length: 128 }, (_, index) =>
      `${String(index).padStart(3, "0")}${"f".repeat(40)}`),
    reason: "revoked",
  }]);
  assert.ok(notificationCount > 1, "a valid maximum mutation must split instead of rolling back");
});

test("oversize legacy room ids fall back to a transactional global loss marker", async () => {
  const notifications: unknown[] = [];
  await queueRoomAgentCredentialInvalidationsTx({
    async execute(query) { notifications.push(query); },
  }, [{
    room_id: "r".repeat(6_800),
    agent_session_id: "session_legacy",
    credential_fingerprints: ["f".repeat(43)],
    reason: "revoked",
  }]);
  assert.equal(notifications.length, 1, "the credential mutation must retain one compact durable fence");
  const queryChunks = (notifications[0] as { queryChunks?: unknown[] }).queryChunks ?? [];
  const envelope = queryChunks.find((chunk) =>
    typeof chunk === "string" && chunk.startsWith('{"v":1,"mode":"loss"'));
  const parsedEnvelope = JSON.parse(String(envelope));
  assert.deepEqual({ ...parsedEnvelope, origin: undefined }, {
    v: 1,
    mode: "loss",
    losses: [{ room_id: null, epoch: 1 }],
    origin: undefined,
  });
  assert.match(String(parsedEnvelope.origin), /^credential-tx:/);
});

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

test("a slow reference notification cannot be overtaken by a later inline notification", async () => {
  const delivered: string[] = [];
  const losses: string[] = [];
  let releaseReference!: () => void;
  const referenceGate = new Promise<void>((resolve) => { releaseReference = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({
    onLoss: (reason) => losses.push(reason),
  });

  receiver.enqueue({
    origin: "instance-a",
    roomId: "room_ordered",
    run: async () => {
      await referenceGate;
      delivered.push("reference");
    },
  });
  receiver.enqueue({
    origin: "instance-a",
    roomId: "room_ordered",
    run: async () => { delivered.push("inline"); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  releaseReference();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["reference", "inline"]);
  assert.deepEqual(losses, []);
  receiver.close();
});

test("same-room notifications stay ordered across publisher origins", async () => {
  const delivered: string[] = [];
  let releaseReference!: () => void;
  const referenceGate = new Promise<void>((resolve) => { releaseReference = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({ onLoss() {} });
  receiver.enqueue({
    origin: "instance-a",
    roomId: "room_ordered",
    run: async () => { await referenceGate; delivered.push("earlier-reference"); },
  });
  receiver.enqueue({
    origin: "instance-b",
    roomId: "room_ordered",
    run: async () => { delivered.push("later-inline"); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  releaseReference();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["earlier-reference", "later-inline"]);
  receiver.close();
});

test("a global loss barrier cannot be overtaken by its publisher's next room event", async () => {
  const delivered: string[] = [];
  let releaseLoss!: () => void;
  const lossGate = new Promise<void>((resolve) => { releaseLoss = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({ onLoss: () => {} });
  receiver.enqueue({
    origin: "instance-a",
    roomId: null,
    run: async () => { await lossGate; delivered.push("global-loss"); },
  });
  receiver.enqueue({
    origin: "instance-a",
    roomId: "room_a",
    run: async () => { delivered.push("room-event"); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  releaseLoss();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["global-loss", "room-event"]);
  receiver.close();
});

test("a global loss barrier cannot be overtaken by another publisher's room event", async () => {
  const delivered: string[] = [];
  let releaseLoss!: () => void;
  const lossGate = new Promise<void>((resolve) => { releaseLoss = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({ onLoss: () => {} });
  receiver.enqueue({
    origin: "instance-a",
    roomId: null,
    run: async () => { await lossGate; delivered.push("global-loss"); },
  });
  receiver.enqueue({
    origin: "instance-b",
    roomId: "room_a",
    run: async () => { delivered.push("cross-origin-room-event"); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  releaseLoss();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["global-loss", "cross-origin-room-event"]);
  receiver.close();
});

test("a global loss barrier waits for earlier room work from another publisher", async () => {
  const delivered: string[] = [];
  let releaseEarlier!: () => void;
  const earlierGate = new Promise<void>((resolve) => { releaseEarlier = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({ onLoss: () => {} });
  receiver.enqueue({
    origin: "instance-b",
    roomId: "room_b",
    run: async () => { await earlierGate; delivered.push("earlier-room-event"); },
  });
  receiver.enqueue({
    origin: "instance-a",
    roomId: null,
    run: async () => { delivered.push("global-loss"); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  releaseEarlier();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["earlier-room-event", "global-loss"]);
  receiver.close();
});

test("a multi-room loss barrier preserves origin order before later room data", async () => {
  const delivered: string[] = [];
  let releaseLoss!: () => void;
  const lossGate = new Promise<void>((resolve) => { releaseLoss = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({ onLoss: () => {} });
  receiver.enqueue({
    origin: "instance-a",
    // Multiple loss rooms conservatively map to the room-less origin barrier.
    roomId: null,
    run: async () => { await lossGate; delivered.push("multi-room-loss"); },
  });
  receiver.enqueue({
    origin: "instance-a",
    roomId: "room_b",
    run: async () => { delivered.push("room-b-event"); },
  });
  releaseLoss();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["multi-room-loss", "room-b-event"]);
  receiver.close();
});

test("bridge envelopes reject malformed and oversized room identifiers", () => {
  for (const projectId of [" room_1", "room_1 ", "room\n1", "x".repeat(1_025)]) {
    assert.equal(buildBridgeEnvelope("messages", "message:created", {
      projectId,
      message: { id: "msg_1", text: "hello" },
    }, "origin-a"), null);
  }
});

test("unknown bridge lanes and events become repair gaps", async () => {
  const reasons: string[] = [];
  const onLoss = (loss: { reason?: string }) => { if (loss.reason) reasons.push(loss.reason); };
  roomEventBridgeLossEvents.on("loss", onLoss);
  try {
    await dispatchBridgeNotification({
      v: 1,
      lane: "newer_version_lane",
      event: "newer:event",
      mode: "inline",
      data: { projectId: "room_mixed_version" },
      origin: "remote-origin",
    });
    createBridgedEmitter("known_no_listener_lane");
    await dispatchBridgeNotification({
      v: 1,
      lane: "known_no_listener_lane",
      event: "newer:event",
      mode: "inline",
      data: { projectId: "room_mixed_version" },
      origin: "remote-origin",
    });
    assert.deepEqual(reasons, ["unknown_notification_lane", "unknown_notification_event"]);
  } finally {
    roomEventBridgeLossEvents.off("loss", onLoss);
  }
});

test("malformed retained-loss room identifiers become one repair gap", async () => {
  const reasons: string[] = [];
  const onLoss = (loss: { reason?: string }) => { if (loss.reason) reasons.push(loss.reason); };
  roomEventBridgeLossEvents.on("loss", onLoss);
  try {
    await dispatchBridgeNotification({
      v: 1,
      mode: "loss",
      losses: [{ room_id: " room_invalid", epoch: 1 }],
      origin: "remote-origin",
    });
    assert.deepEqual(reasons, ["malformed_loss_marker"]);
  } finally {
    roomEventBridgeLossEvents.off("loss", onLoss);
  }
});

test("a retired receiver cannot dispatch a hydration that completes after replacement", async () => {
  const delivered: string[] = [];
  const losses: string[] = [];
  let releaseHydration!: () => void;
  const hydrationGate = new Promise<void>((resolve) => { releaseHydration = resolve; });
  const retired = createOrderedBridgeNotificationReceiver({
    onLoss: (reason) => losses.push(reason),
  });
  retired.enqueue({
    origin: "instance-a",
    roomId: "room_retired",
    run: async (isCurrent) => {
      await hydrationGate;
      if (isCurrent()) delivered.push("stale-reference");
    },
  });
  retired.close();
  const replacement = createOrderedBridgeNotificationReceiver({
    onLoss: (reason) => losses.push(reason),
  });
  replacement.enqueue({
    origin: "instance-a",
    roomId: "room_retired",
    run: async (isCurrent) => {
      if (isCurrent()) delivered.push("fresh-inline");
    },
  });
  releaseHydration();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["fresh-inline"]);
  assert.ok(losses.includes("notification_receiver_retired"));
  replacement.close();
});

test("ordered notification queues bound backlog and turn expired work into gaps", async () => {
  const losses: string[] = [];
  let now = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({
    maxQueuedPerOrigin: 1,
    deadlineMs: 10,
    now: () => now,
    onLoss: (reason) => losses.push(reason),
  });
  receiver.enqueue({ origin: "instance-a", roomId: "room_ordered", run: () => firstGate });
  assert.equal(receiver.enqueue({
    origin: "instance-a",
    roomId: "room_ordered",
    run: async () => undefined,
  }), true);
  assert.equal(receiver.enqueue({
    origin: "instance-a",
    roomId: "room_ordered",
    run: async () => undefined,
  }), false);
  now = 11;
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(losses, [
    "notification_queue_overflow",
    "notification_queue_deadline",
    "notification_queue_deadline",
  ]);
  receiver.close();
});

test("ordered notification queues cap aggregate work across publisher origins", async () => {
  const losses: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const receiver = createOrderedBridgeNotificationReceiver({
    maxOrigins: 8,
    maxQueuedPerOrigin: 8,
    maxOutstanding: 2,
    onLoss: (reason) => losses.push(reason),
  });
  assert.equal(receiver.enqueue({ origin: "instance-a", roomId: "room-a", run: () => gate }), true);
  assert.equal(receiver.enqueue({ origin: "instance-b", roomId: "room-b", run: () => gate }), true);
  assert.equal(receiver.enqueue({
    origin: "instance-c",
    roomId: "room-c",
    run: async () => undefined,
  }), false);
  assert.deepEqual(losses, ["notification_total_overflow"]);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  receiver.close();
});
