import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { createRoomEventBroker, RoomEventBroker } = await import("../server/room-event-broker.js");
const { isRoomEventVisibleToSubscriber } = await import(
  "../routes/rooms/messages/delivery-visibility.js"
);

function createSources() {
  return {
    messageEvents: new EventEmitter(),
    taskEvents: new EventEmitter(),
    githubRoomEvents: new EventEmitter(),
    reasoningEvents: new EventEmitter(),
    artifactEvents: new EventEmitter(),
    rentalActivityEvents: new EventEmitter(),
    messageInfoEvents: new EventEmitter(),
    agentWorkEvents: new EventEmitter(),
    executionDelegationEvents: new EventEmitter(),
  };
}

test("one source listener fans out only to subscribers in the affected room", async () => {
  const sources = createSources();
  const broker = createRoomEventBroker(sources, { instanceId: "broker" });
  const roomA = Array.from({ length: 100 }, () => broker.subscribe("room_a"));
  const roomB = broker.subscribe("room_b");

  assert.equal(sources.messageEvents.listenerCount("message:created"), 1);
  assert.equal(sources.taskEvents.listenerCount("task:updated"), 1);
  assert.equal(sources.githubRoomEvents.listenerCount("github_event:updated"), 1);
  assert.equal(sources.reasoningEvents.listenerCount("reasoning:updated"), 1);
  assert.equal(sources.reasoningEvents.listenerCount("reasoning:removed"), 1);
  assert.equal(sources.artifactEvents.listenerCount("artifact:updated"), 1);
  assert.equal(sources.rentalActivityEvents.listenerCount("activity:created"), 1);
  assert.equal(sources.messageInfoEvents.listenerCount("message_info:updated"), 1);
  assert.equal(sources.agentWorkEvents.listenerCount("agent_work:invalidated"), 1);
  assert.equal(sources.executionDelegationEvents.listenerCount("execution_delegation:invalidated"), 1);

  sources.taskEvents.emit("task:updated", { projectId: "room_a", task: { id: "task_1" } });
  const deliveries = await Promise.all(roomA.map((subscription) => subscription.next()));
  assert.ok(deliveries.every((delivery) =>
    delivery?.type === "event" && delivery.envelope.event.kind === "task_updated"
  ));

  const roomBRead = roomB.next();
  const roomBReceived = await Promise.race([
    roomBRead.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(roomBReceived, false);
  roomB.close();
  assert.equal(await roomBRead, null);
  for (const subscription of roomA) subscription.close();
  broker.close();
  assert.equal(sources.messageEvents.listenerCount("message:created"), 0);
  assert.equal(sources.taskEvents.listenerCount("task:updated"), 0);
  assert.equal(sources.githubRoomEvents.listenerCount("github_event:updated"), 0);
  assert.equal(sources.reasoningEvents.listenerCount("reasoning:updated"), 0);
  assert.equal(sources.reasoningEvents.listenerCount("reasoning:removed"), 0);
  assert.equal(sources.artifactEvents.listenerCount("artifact:updated"), 0);
  assert.equal(sources.rentalActivityEvents.listenerCount("activity:created"), 0);
  assert.equal(sources.messageInfoEvents.listenerCount("message_info:updated"), 0);
  assert.equal(sources.agentWorkEvents.listenerCount("agent_work:invalidated"), 0);
  assert.equal(sources.executionDelegationEvents.listenerCount("execution_delegation:invalidated"), 0);
});

test("agent-work invalidations remain pointer-only broker events", async () => {
  const sources = createSources();
  const broker = createRoomEventBroker(sources, { instanceId: "broker" });
  const subscription = broker.subscribe("room_work");

  sources.agentWorkEvents.emit("agent_work:invalidated", { projectId: "room_work" });
  const delivery = await subscription.next();
  assert.equal(delivery?.type, "event");
  if (delivery?.type === "event") {
    assert.deepEqual(delivery.envelope.event, {
      kind: "agent_work_invalidated",
      roomId: "room_work",
    });
  }

  subscription.close();
  broker.close();
});

test("execution-delegation invalidations remain pointer-only broker events", async () => {
  const sources = createSources();
  const broker = createRoomEventBroker(sources, { instanceId: "broker" });
  const subscription = broker.subscribe("room_delegation");

  sources.executionDelegationEvents.emit("execution_delegation:invalidated", {
    projectId: "room_delegation",
  });
  const delivery = await subscription.next();
  assert.equal(delivery?.type, "event");
  if (delivery?.type === "event") {
    assert.deepEqual(delivery.envelope.event, {
      kind: "execution_delegation_invalidated",
      roomId: "room_delegation",
    });
  }

  subscription.close();
  broker.close();
});

test("prompt fanout reuses one recipient set at maximum subscriber cardinality", async () => {
  const sources = createSources();
  const broker = createRoomEventBroker(sources, {
    instanceId: "broker",
    maxQueuedEventsPerSubscriber: 2,
  });
  const subscriptions = Array.from({ length: 1_000 }, () => broker.subscribe("room_prompt", {
    accept: (event) => isRoomEventVisibleToSubscriber({
      event,
      includePromptOnly: true,
      recipientAgentIdentity: {
        owner_account_id: "acct_emmy",
        agent_key: "emmymay/codex",
        agent_session_id: "session_codex",
      },
    }),
  }));

  sources.messageEvents.emit("message:created", {
    projectId: "room_prompt",
    message: {
      id: "msg_prompt",
      text: "targeted",
      agent_prompt_kind: "mention",
    },
    recipientAgentTargets: [{
      owner_account_id: "acct_emmy",
      agent_key: "emmymay/codex",
      agent_session_id: "session_codex",
    }],
  });
  const deliveries = await Promise.all(subscriptions.map((subscription) => subscription.next()));
  assert.ok(deliveries.every((delivery) => delivery?.type === "event"));
  assert.equal(deliveries.length, subscriptions.length);
  for (const subscription of subscriptions) subscription.close();
  broker.close();
});

test("six thousand realistic prompt recipients remain a compact canonical broker event", async () => {
  const sources = createSources();
  const broker = createRoomEventBroker(sources, { instanceId: "broker" });
  const subscriber = broker.subscribe("room_prompt");
  const recipientAgentTargets = Array.from({ length: 6_000 }, (_, index) => ({
    owner_account_id: `acct_${String(index).padStart(32, "0")}`,
    agent_key: `owner-${String(index).padStart(32, "0")}/worker-${String(index).padStart(32, "0")}`,
    agent_session_id: `session_${String(index).padStart(32, "0")}`,
  }));
  sources.messageEvents.emit("message:created", {
    projectId: "room_prompt",
    message: { id: "msg_prompt", text: "targeted", agent_prompt_kind: "mention" },
    recipientAgentTargets,
  });
  const delivery = await subscriber.next();
  assert.equal(delivery?.type, "event", "large supported fanout must not degrade into a broker gap");
  if (delivery?.type === "event" && delivery.envelope.event.kind === "message_created") {
    assert.equal(delivery.envelope.event.recipientAgentTargetSet.size, 6_000);
  }
  subscriber.close();
  broker.close();
});

test("one hundred thousand prompt recipients exceed the bounded broker audience budget", async () => {
  const broker = new RoomEventBroker({ instanceId: "broker" });
  const subscriber = broker.subscribe("room_prompt_oversize");
  const recipientAgentTargetSet = new Set(
    Array.from({ length: 100_000 }, (_, index) =>
      `acct_${String(index).padStart(32, "0")}\u0000owner/worker_${String(index).padStart(32, "0")}`),
  );
  broker.publish({
    kind: "message_created",
    roomId: "room_prompt_oversize",
    message: { id: "msg_prompt_oversize", text: "targeted", agent_prompt_kind: "mention" } as never,
    recipientAgentTargetSet,
  });
  assert.equal((await subscriber.next())?.type, "gap", "oversize audiences must never bypass byte backpressure");
  subscriber.close();
  broker.close();
});

test("bounded room buffers replay after a known cursor and report an evicted gap", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxBufferedEventsPerRoom: 2,
  });
  const first = broker.subscribe("room_a");
  assert.equal(first.checkpointCursor, null);
  assert.equal(first.checkpointGap, false);
  const one = broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_1" } as never });
  assert.equal((await first.next())?.type, "event");
  first.close();

  const two = broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_2" } as never });
  const baseline = broker.subscribe("room_a");
  assert.equal(baseline.checkpointCursor, two?.cursor);
  assert.equal(baseline.checkpointGap, false);
  baseline.close();
  const replay = broker.subscribe("room_a", { afterCursor: one?.cursor });
  assert.equal(replay.checkpointCursor, one?.cursor);
  assert.equal(replay.checkpointGap, false);
  const replayed = await replay.next();
  assert.equal(replayed?.type, "event");
  if (replayed?.type === "event") assert.equal(replayed.envelope.cursor, two?.cursor);
  replay.close();

  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_3" } as never });
  const gap = broker.subscribe("room_a", { afterCursor: one?.cursor });
  assert.equal(gap.checkpointGap, true);
  assert.equal(gap.checkpointCursor, "broker:3");
  assert.equal((await gap.next())?.type, "gap");
  gap.close();
  broker.close();
});

test("slow subscribers receive one gap instead of an unbounded queue", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxQueuedEventsPerSubscriber: 2,
  });
  const subscription = broker.subscribe("room_a");
  for (let index = 1; index <= 3; index += 1) {
    broker.publish({
      kind: "task_updated",
      roomId: "room_a",
      task: { id: `task_${index}` } as never,
    });
  }
  assert.equal((await subscription.next())?.type, "gap");
  subscription.close();
  broker.close();
});

test("slow subscriber queues are bounded by serialized bytes as well as event count", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxQueuedEventsPerSubscriber: 100,
    maxQueuedBytesPerSubscriber: 180,
  });
  const subscription = broker.subscribe("room_a");
  broker.publish({
    kind: "task_updated",
    roomId: "room_a",
    task: { id: "task_1", body: "x".repeat(100) } as never,
  });
  broker.publish({
    kind: "task_updated",
    roomId: "room_a",
    task: { id: "task_2", body: "x".repeat(100) } as never,
  });
  assert.equal((await subscription.next())?.type, "gap");
  subscription.close();
  broker.close();
});

test("an oversized event becomes a gap even when a subscriber is already waiting", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxQueuedBytesPerSubscriber: 100,
    maxBufferedBytesPerRoom: 100,
  });
  const subscription = broker.subscribe("room_a");
  const pending = subscription.next();
  broker.publish({
    kind: "task_updated",
    roomId: "room_a",
    task: { id: "task_large", body: "x".repeat(1_000) } as never,
  });
  assert.equal((await pending)?.type, "gap");
  subscription.close();
  broker.close();
});

test("eviction clears physical references instead of retaining a logical prefix", async () => {
  const broker = new RoomEventBroker({ instanceId: "broker", maxBufferedEventsPerRoom: 1 });
  const subscription = broker.subscribe("room_a");
  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_1" } as never });
  await subscription.next();
  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_2" } as never });
  const buffer = (broker as unknown as { buffers: Map<string, { events: unknown[] }> })
    .buffers.get("room_a");
  assert.equal(buffer?.events[0], undefined);
  subscription.close();
  broker.close();
});

test("subscriber filter failures are isolated and force only that subscriber to repair", async () => {
  const broker = new RoomEventBroker({ instanceId: "broker" });
  const broken = broker.subscribe("room_a", { accept: () => { throw new Error("bad filter"); } });
  const healthy = broker.subscribe("room_a");
  assert.doesNotThrow(() => {
    broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_1" } as never });
  });
  assert.equal((await broken.next())?.type, "gap");
  assert.equal((await healthy.next())?.type, "event");
  broken.close();
  healthy.close();
  broker.close();
});

test("bridge loss epochs stay visible to reconnecting subscribers", async () => {
  const sources = { ...createSources(), bridgeLossEvents: new EventEmitter() };
  const broker = createRoomEventBroker(sources, { instanceId: "broker" });
  const first = broker.subscribe("room_a");
  const beforeLoss = broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "before" } as never });
  await first.next();
  sources.bridgeLossEvents.emit("loss", { roomId: "room_a", epoch: 1 });
  assert.equal((await first.next())?.type, "gap");
  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "after" } as never });
  first.close();

  const replay = broker.subscribe("room_a", { afterCursor: beforeLoss?.cursor });
  assert.equal((await replay.next())?.type, "gap");
  const after = await replay.next();
  assert.equal(after?.type, "event");
  if (after?.type === "event" && after.envelope.event.kind === "task_updated") {
    assert.equal(after.envelope.event.task.id, "after");
  }
  replay.close();
  broker.close();
});

test("uninterested reference skips stay DB-cold but gap a racing subscriber", async () => {
  const sources = { ...createSources(), bridgeLossEvents: new EventEmitter() };
  const broker = createRoomEventBroker(sources, { instanceId: "broker" });
  assert.equal(broker.hasInterest("room_cold"), false);
  sources.bridgeLossEvents.emit("loss", {
    roomId: "room_cold",
    epoch: 1,
    reason: "uninterested_reference",
  });
  sources.bridgeLossEvents.emit("loss", {
    roomId: "room_cold",
    epoch: 2,
    reason: "uninterested_reference",
  });
  assert.equal(
    broker.hasInterest("room_cold"),
    false,
    "compact skipped markers never make later refs hydrate on an idle pod",
  );
  const raced = broker.subscribe("room_cold");
  assert.equal((await raced.next())?.type, "gap");
  raced.close();
  broker.close();
});

test("replay applies subscriber visibility before queue capacity", async () => {
  const broker = new RoomEventBroker({ instanceId: "broker", maxQueuedEventsPerSubscriber: 1 });
  const seeder = broker.subscribe("room_a");
  const first = broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "first" } as never });
  await seeder.next();
  seeder.close();
  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "hidden" } as never });
  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "visible" } as never });
  const replay = broker.subscribe("room_a", {
    afterCursor: first?.cursor,
    accept: (event) => event.kind !== "task_updated" || event.task.id !== "hidden",
  });
  const delivered = await replay.next();
  assert.equal(delivered?.type, "event");
  if (delivered?.type === "event" && delivered.envelope.event.kind === "task_updated") {
    assert.equal(delivered.envelope.event.task.id, "visible");
  }
  replay.close();
  broker.close();
});

test("subscription kind filters avoid waking message polls for metadata events", async () => {
  const broker = new RoomEventBroker({ instanceId: "broker" });
  const subscription = broker.subscribe("room_a", {
    kinds: new Set(["message_created"]),
  });
  broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_1" } as never });
  broker.publish({
    kind: "message_created",
    roomId: "room_a",
    message: { id: "msg_1" } as never,
    recipientAgentTargetSet: new Set(),
  });
  const delivery = await subscription.next();
  assert.equal(delivery?.type, "event");
  if (delivery?.type === "event") assert.equal(delivery.envelope.event.kind, "message_created");
  subscription.close();
  broker.close();
});

test("rejected hidden events do not consume subscriber queue capacity", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxQueuedEventsPerSubscriber: 1,
  });
  const subscription = broker.subscribe("room_a", {
    accept: (event) => event.kind !== "message_created" || event.message.text !== "hidden",
  });
  for (let index = 0; index < 10; index += 1) {
    broker.publish({
      kind: "message_created",
      roomId: "room_a",
      message: { id: `msg_${index}`, text: "hidden" } as never,
      recipientAgentTargetSet: new Set(),
    });
  }
  broker.publish({
    kind: "message_created",
    roomId: "room_a",
    message: { id: "msg_11", text: "visible" } as never,
    recipientAgentTargetSet: new Set(),
  });
  const delivery = await subscription.next();
  assert.equal(delivery?.type, "event");
  if (delivery?.type === "event" && delivery.envelope.event.kind === "message_created") {
    assert.equal(delivery.envelope.event.message.id, "msg_11");
  }
  subscription.close();
  broker.close();
});

test("per-room byte budgets evict oversized replay history", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxBufferedBytesPerRoom: 180,
  });
  const live = broker.subscribe("room_a");
  const first = broker.publish({
    kind: "task_updated",
    roomId: "room_a",
    task: { id: "task_1", body: "x".repeat(100) } as never,
  });
  await live.next();
  live.close();
  broker.publish({
    kind: "task_updated",
    roomId: "room_a",
    task: { id: "task_2", body: "x".repeat(100) } as never,
  });
  const replay = broker.subscribe("room_a", { afterCursor: first?.cursor });
  assert.equal((await replay.next())?.type, "gap");
  replay.close();
  broker.close();
});

test("global byte budgets evict the least-recently-used room buffer", async () => {
  const broker = new RoomEventBroker({
    instanceId: "broker",
    maxBufferedBytesPerRoom: 512,
    maxBufferedBytesTotal: 512,
  });
  const roomA = broker.subscribe("room_a");
  const first = broker.publish({
    kind: "task_updated",
    roomId: "room_a",
    task: { id: "task_a", body: "a".repeat(300) } as never,
  });
  await roomA.next();
  roomA.close();

  const roomB = broker.subscribe("room_b");
  broker.publish({
    kind: "task_updated",
    roomId: "room_b",
    task: { id: "task_b", body: "b".repeat(300) } as never,
  });
  await roomB.next();
  roomB.close();

  const replay = broker.subscribe("room_a", { afterCursor: first?.cursor });
  assert.equal((await replay.next())?.type, "gap");
  replay.close();
  broker.close();
});

test("idle buffers expire without another publish or subscribe", async () => {
  const broker = new RoomEventBroker({ instanceId: "broker", bufferTtlMs: 10 });
  const live = broker.subscribe("room_a");
  const first = broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_1" } as never });
  await live.next();
  live.close();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const replay = broker.subscribe("room_a", { afterCursor: first?.cursor });
  assert.equal((await replay.next())?.type, "gap");
  replay.close();
  broker.close();
});

test("closed brokers reject reattachment and cannot leak source listeners", () => {
  const sources = createSources();
  const broker = createRoomEventBroker(sources);
  broker.close();
  assert.throws(() => broker.attach(sources), /closed room event broker/);
  assert.equal(sources.messageEvents.listenerCount("message:created"), 0);
});

test("buffer TTL and room caps bound reconnect memory", async () => {
  let now = 1_000;
  const broker = new RoomEventBroker({
    instanceId: "broker",
    bufferTtlMs: 100,
    maxBufferedRooms: 1,
    now: () => now,
  });
  const roomA = broker.subscribe("room_a");
  const eventA = broker.publish({ kind: "task_updated", roomId: "room_a", task: { id: "task_a" } as never });
  await roomA.next();
  roomA.close();

  const roomB = broker.subscribe("room_b");
  broker.publish({ kind: "task_updated", roomId: "room_b", task: { id: "task_b" } as never });
  await roomB.next();
  roomB.close();

  const evicted = broker.subscribe("room_a", { afterCursor: eventA?.cursor });
  assert.equal((await evicted.next())?.type, "gap");
  evicted.close();

  now += 101;
  const expired = broker.subscribe("room_b", { afterCursor: "broker:2" });
  assert.equal((await expired.next())?.type, "gap");
  expired.close();
  broker.close();
});

test("message overlay target snapshots are deduplicated, stable, and invalidated on membership changes", () => {
  const broker = new RoomEventBroker({ instanceId: "overlay-targets" });
  const browser = broker.subscribe("room_a", {
    messageOverlayTarget: { accountId: "acct_a", accountAgentRouting: false },
  });
  const desktop = broker.subscribe("room_a", {
    messageOverlayTarget: { accountId: "acct_a", accountAgentRouting: true },
  });
  const first = broker.getMessageOverlayTargets("room_a");
  assert.strictEqual(broker.getMessageOverlayTargets("room_a"), first);
  assert.deepEqual(first, [{ accountId: "acct_a", accountAgentRouting: true }]);

  const secondAccount = broker.subscribe("room_a", {
    messageOverlayTarget: { accountId: "acct_b", accountAgentRouting: false },
  });
  const expanded = broker.getMessageOverlayTargets("room_a");
  assert.notStrictEqual(expanded, first);
  assert.deepEqual(expanded, [
    { accountId: "acct_a", accountAgentRouting: true },
    { accountId: "acct_b", accountAgentRouting: false },
  ]);

  desktop.close();
  const downgraded = broker.getMessageOverlayTargets("room_a");
  assert.deepEqual(downgraded, [
    { accountId: "acct_a", accountAgentRouting: false },
    { accountId: "acct_b", accountAgentRouting: false },
  ]);
  browser.close();
  secondAccount.close();
  broker.close();
});
