import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { createRoomMessageOverlayBatcher } = await import("../server/room-message-overlays.js");
const { RoomEventBroker } = await import("../server/room-event-broker.js");
const { isRoomEventVisibleToSubscriber } = await import(
  "../routes/rooms/messages/delivery-visibility.js"
);
const { hydrateLiveMessageForSubscriber } = await import(
  "../routes/rooms/messages/live-message-delivery.js"
);
const { attachAccountRoutingAuthorityActivation } = await import(
  "../routes/rooms/messages/receipt-activation.js"
);

const routingRow = {
  number: 7,
  thread_root_number: 1,
  routing_snapshot_version: 1,
  publisher_account_id: null,
  publisher_agent_key: null,
  reply_to_number: null,
  sender: "Human",
  source: "browser",
  text: "hello",
};

test("one canonical message coalesces a thousand subscriber overlay requests into one batch", async () => {
  let routingRowCalls = 0;
  let routingCalls = 0;
  let threadReadCalls = 0;
  const targets = Object.freeze(Array.from({ length: 1_000 }, (_, index) => Object.freeze({
    accountId: `acct_${String(index).padStart(4, "0")}`,
    accountAgentRouting: index % 2 === 0,
  })));
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows(roomId, messageNumbers) {
      routingRowCalls += 1;
      assert.equal(roomId, "room_1");
      assert.deepEqual(messageNumbers, [7]);
      return [routingRow];
    },
    async loadAccountRoutings(roomId, accountIds, rows) {
      routingCalls += 1;
      assert.equal(roomId, "room_1");
      assert.equal(accountIds.length, 500);
      assert.deepEqual(rows, [routingRow]);
      return new Map(accountIds.map((accountId) => [accountId, new Map([[7, {
        version: 1,
        authority: "receipts" as const,
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: false,
      }]])]));
    },
    async loadThreadReadOverlays(roomId, readTargets, accountIds) {
      threadReadCalls += 1;
      assert.equal(roomId, "room_1");
      assert.deepEqual(readTargets, [{ root_message_id: "msg_1", reply_count: 9 }]);
      assert.equal(accountIds.length, 1_000);
      return new Map(accountIds.map((accountId) => [accountId, new Map([["msg_1", {
        last_read_message_id: null,
        unread_count: 9,
        has_unread: true,
      }]])]));
    },
  });
  const message = { id: "msg_7", thread: { root_message_id: "msg_1", reply_count: 9 } };

  const results = await Promise.all(Array.from(
    { length: 1_000 },
    () => batcher.prepare({ roomId: "room_1", message, targets }),
  ));

  assert.equal(routingRowCalls, 1);
  assert.equal(routingCalls, 1);
  assert.equal(threadReadCalls, 1);
  assert.equal(results[0]?.size, 1_000);
  for (const result of results) assert.strictEqual(result, results[0]);
  assert.equal(results[0]?.get("acct_0000")?.account_agent_routing?.authority, "receipts");
  assert.equal(results[0]?.get("acct_0001")?.account_agent_routing, undefined);
  assert.equal(results[0]?.get("acct_0001")?.thread_read?.unread_count, 9);
  batcher.close();
});

test("one canonical gap page resolves five hundred message overlays in three loader calls", async () => {
  let routingRowCalls = 0;
  let routingCalls = 0;
  let threadReadCalls = 0;
  const messages = Array.from({ length: 500 }, (_, index) => ({
    id: `msg_${index + 1}`,
    thread: { root_message_id: `msg_${index + 1}`, reply_count: index + 1 },
  }));
  const rows = messages.map((_, index) => ({ ...routingRow, number: index + 1 }));
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows(_roomId, messageNumbers) {
      routingRowCalls += 1;
      assert.equal(messageNumbers.length, 500);
      return rows;
    },
    async loadAccountRoutings(_roomId, accountIds, routingRows) {
      routingCalls += 1;
      assert.deepEqual(accountIds, ["acct_1"]);
      assert.equal(routingRows.length, 500);
      return new Map([["acct_1", new Map(routingRows.map((row) => [row.number, {
        version: 1 as const,
        authority: "receipts" as const,
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: false,
      }]))]]);
    },
    async loadThreadReadOverlays(_roomId, readTargets, accountIds) {
      threadReadCalls += 1;
      assert.equal(readTargets.length, 500);
      assert.deepEqual(accountIds, ["acct_1"]);
      return new Map([["acct_1", new Map(readTargets.map((target) => [target.root_message_id, {
        last_read_message_id: null,
        unread_count: target.reply_count,
        has_unread: target.reply_count > 0,
      }]))]]);
    },
  });
  const targets = Object.freeze([{ accountId: "acct_1", accountAgentRouting: true }]);
  const results = await Promise.all(Array.from({ length: 1_000 }, () => batcher.prepareMany({
    roomId: "room_1", messages, targets,
  })));
  const result = results[0]!;
  assert.ok(results.every((candidate) => candidate === result));
  assert.equal(result.size, 500);
  assert.equal(result.get(500)?.get("acct_1")?.thread_read?.unread_count, 500);
  assert.deepEqual([routingRowCalls, routingCalls, threadReadCalls], [1, 1, 1]);
  batcher.close();
});

test("a five-hundred-message gap page chunks one thousand subscriber accounts within pair bounds", async () => {
  let routingRowCalls = 0;
  let globalLegacyPlanCalls = 0;
  const routingChunkSizes: number[] = [];
  const readChunkSizes: number[] = [];
  const messages = Array.from({ length: 500 }, (_, index) => ({
    id: `msg_${index + 1}`,
    thread: { root_message_id: `msg_${index + 1}`, reply_count: index + 1 },
  }));
  const rows = messages.map((_, index) => ({
    ...routingRow,
    number: index + 1,
    routing_snapshot_version: null,
  }));
  const targets = Object.freeze(Array.from({ length: 1_000 }, (_, index) => Object.freeze({
    accountId: `acct_${String(index).padStart(4, "0")}`,
    accountAgentRouting: true,
  })));
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows(_roomId, messageNumbers) {
      routingRowCalls += 1;
      assert.equal(messageNumbers.length, 500);
      return rows;
    },
    async loadGlobalLegacyRoutingPlan(_roomId, routingRows) {
      globalLegacyPlanCalls += 1;
      assert.equal(routingRows.length, 500);
      return new Map();
    },
    async loadAccountRoutings(_roomId, accountIds, routingRows, options) {
      routingChunkSizes.push(accountIds.length);
      assert.equal(routingRows.length, 500);
      assert.ok(options?.legacyRoutingPlan);
      return new Map(accountIds.map((accountId) => [accountId, new Map(routingRows.map((row) => [
        row.number,
        {
          version: 1 as const,
          authority: "legacy" as const,
          recipient_agent_keys: [],
          recipient_agent_sessions: [],
          control_authorized: false,
        },
      ]))]));
    },
    async loadThreadReadOverlays(_roomId, readTargets, accountIds) {
      readChunkSizes.push(accountIds.length);
      assert.equal(readTargets.length, 500);
      return new Map(accountIds.map((accountId) => [accountId, new Map(readTargets.map((target) => [
        target.root_message_id,
        {
          last_read_message_id: null,
          unread_count: target.reply_count,
          has_unread: target.reply_count > 0,
        },
      ]))]));
    },
  });

  const results = await Promise.all(targets.map((target) => batcher.prepareMany({
    roomId: "room_1",
    messages,
    targets,
    target,
  })));

  assert.equal(routingRowCalls, 1);
  assert.equal(globalLegacyPlanCalls, 1);
  assert.deepEqual(routingChunkSizes, [200, 200, 200, 200, 200]);
  assert.deepEqual(readChunkSizes, [200, 200, 200, 200, 200]);
  assert.equal(results[0]?.size, 500);
  assert.equal(results[0]?.get(500)?.size, 200);
  assert.strictEqual(results[0], results[199]);
  assert.notStrictEqual(results[199], results[200]);
  assert.strictEqual(results[800], results[999]);
  assert.equal(results[999]?.get(500)?.get("acct_0999")?.thread_read?.unread_count, 500);
  assert.ok(results.every((result) =>
    result.size * (result.values().next().value?.size ?? 0) <= 100_000));
  batcher.close();
});

test("duplicate subscriber accounts are normalized once and desktop routing wins", async () => {
  let routedAccounts: readonly string[] = [];
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() { return [routingRow]; },
    async loadAccountRoutings(_roomId, accountIds) {
      routedAccounts = accountIds;
      return new Map([["acct_a", new Map([[7, {
        version: 1,
        authority: "receipts" as const,
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: false,
      }]])]]);
    },
  });
  const result = await batcher.prepare({
    roomId: "room_1",
    message: { id: "msg_7" },
    targets: [
      { accountId: " acct_a ", accountAgentRouting: false },
      { accountId: "acct_a", accountAgentRouting: true },
      { accountId: "", accountAgentRouting: true },
    ],
  });
  assert.deepEqual(routedAccounts, ["acct_a"]);
  assert.deepEqual([...result.keys()], ["acct_a"]);
  assert.equal(result.get("acct_a")?.account_agent_routing?.authority, "receipts");
  batcher.close();
});

test("overlay batches resolve the global plan once across more than a thousand accounts", async () => {
  const routingChunkSizes: number[] = [];
  const readChunkSizes: number[] = [];
  const targets = Object.freeze(Array.from({ length: 2_001 }, (_, index) => Object.freeze({
    accountId: `acct_${String(index).padStart(4, "0")}`,
    accountAgentRouting: true,
  })));
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() { return [routingRow]; },
    async loadAccountRoutings(_roomId, accountIds) {
      routingChunkSizes.push(accountIds.length);
      return new Map(accountIds.map((accountId) => [accountId, new Map([[7, {
        version: 1,
        authority: "receipts" as const,
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: false,
      }]])]));
    },
    async loadThreadReadOverlays(_roomId, _readTargets, accountIds) {
      readChunkSizes.push(accountIds.length);
      return new Map(accountIds.map((accountId) => [accountId, new Map([["msg_1", {
        last_read_message_id: null,
        unread_count: 1,
        has_unread: true,
      }]])]));
    },
  });
  const result = await batcher.prepare({
    roomId: "room_1",
    message: { id: "msg_7", thread: { root_message_id: "msg_1", reply_count: 1 } },
    targets,
  });
  assert.deepEqual(routingChunkSizes, [2_001]);
  assert.deepEqual(readChunkSizes, [2_001]);
  assert.equal(result.size, 2_001);
  batcher.close();
});

test("the maximum empty-account overlay batch is bounded and does not inherit a wire-envelope limit", async () => {
  const { getMessageAccountAgentRoutings } = await import(
    "../db/messages/account-agent-routing.js"
  );
  const accountIds = Array.from({ length: 100_000 }, (_, index) =>
    `acct_${String(index).padStart(6, "0")}`);
  const executor = {
    async execute() { return { rows: [] }; },
    select() { throw new Error("select is not expected for the empty receipt fixture"); },
  } as never;
  const result = await getMessageAccountAgentRoutings(
    executor,
    "room_1",
    accountIds,
    [routingRow],
  );
  assert.equal(result.size, 100_000);
  assert.equal(result.get("acct_000000")?.get(7)?.authority, "receipts");
  assert.equal(result.get("acct_099999")?.get(7)?.recipient_agent_keys.length, 0);
});

test("a thousand worker subscribers share one receipt plan and derive activation without DB fan-out", async () => {
  let routingRowCalls = 0;
  let routingCalls = 0;
  const broker = new RoomEventBroker({ instanceId: "worker-overlay-batch" });
  const subscriptions = Array.from({ length: 1_000 }, (_, index) => {
    const accountId = `acct_${String(index).padStart(4, "0")}`;
    return broker.subscribe("room_1", {
      messageOverlayTarget: { accountId, accountAgentRouting: true },
    });
  });
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() {
      routingRowCalls += 1;
      return [routingRow];
    },
    async loadAccountRoutings(_roomId, accountIds) {
      routingCalls += 1;
      assert.equal(accountIds.length, 1_000);
      return new Map(accountIds.map((accountId, index) => [accountId, new Map([[7, {
        version: 1 as const,
        authority: "receipts" as const,
        recipient_agent_keys: [`owner/worker-${index}`],
        recipient_agent_sessions: [{
          agent_key: `owner/worker-${index}`,
          agent_session_id: `session_${index}`,
          activation_reason: "explicit_mention",
        }],
        control_authorized: false,
      }]])]));
    },
  });
  const message = {
    id: "msg_7",
    source: "browser",
    sender: "Human",
    text: "status",
  } as never;
  const targets = broker.getMessageOverlayTargets("room_1");
  const hydrated = await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
    hydrateLiveMessageForSubscriber({
      roomId: "room_1",
      message,
      identity: {
        actor_label: `Worker ${index}`,
        agent_key: `owner/worker-${index}`,
        owner_account_id: `acct_${String(index).padStart(4, "0")}`,
        agent_instance_id: `instance_${index}`,
        agent_session_id: `session_${index}`,
        session_kind: "worker",
        runtime: "test",
        display_name: `Worker ${index}`,
        owner_label: "Owner",
        ide_label: "Test",
        repo_branch: null,
      },
      target: targets[index],
      broker,
      batcher,
    })));

  assert.equal(routingRowCalls, 1, "the canonical message row is loaded once");
  assert.equal(routingCalls, 1, "receipt and successor authority is loaded once for all workers");
  assert.ok(hydrated.every((candidate) =>
    candidate.activation?.for_current_agent?.decision === "activate"));
  for (const subscription of subscriptions) subscription.close();
  broker.close();
  batcher.close();
});

test("missing account authority rejects every coalesced caller and closed batchers reject new work", async () => {
  let routingRowCalls = 0;
  const targets = [{ accountId: "acct_a", accountAgentRouting: true }];
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() {
      routingRowCalls += 1;
      return [];
    },
  });
  const requests = Array.from({ length: 20 }, () => batcher.prepare({
    roomId: "room_1",
    message: { id: "msg_7" },
    targets,
  }));
  const settled = await Promise.allSettled(requests);
  assert.equal(routingRowCalls, 1);
  assert.ok(settled.every((result) =>
    result.status === "rejected" && /routing row is unavailable/.test(String(result.reason))));
  batcher.close();
  await assert.rejects(
    batcher.prepare({ roomId: "room_1", message: { id: "msg_8" }, targets }),
    /batcher is closed/,
  );
});

test("settled account authority is never reused across a live-session transition", async () => {
  let calls = 0;
  let successor = "session_successor_1";
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() { return [routingRow]; },
    async loadAccountRoutings(_roomId, accountIds) {
      calls += 1;
      return new Map(accountIds.map((accountId) => [accountId, new Map([[7, {
        version: 1 as const,
        authority: "receipts" as const,
        recipient_agent_keys: ["owner/worker"],
        recipient_agent_sessions: [{
          agent_key: "owner/worker",
          agent_session_id: "captured",
          successor_agent_session_id: successor,
        }],
        control_authorized: false,
      }]])]));
    },
  });
  const input = {
    roomId: "room_1",
    message: { id: "msg_7" },
    targets: [{ accountId: "acct_1", accountAgentRouting: true }],
  };
  const first = await batcher.prepare(input);
  successor = "session_successor_2";
  const second = await batcher.prepare(input);
  assert.equal(calls, 2);
  assert.notStrictEqual(first, second);
  assert.equal(second.get("acct_1")?.account_agent_routing?.recipient_agent_sessions?.[0]
    ?.successor_agent_session_id, "session_successor_2");
  batcher.close();
});

test("prompt bodies are revalidated after a successor becomes ambiguous", async () => {
  const broker = new RoomEventBroker({ instanceId: "prompt-transition" });
  const subscription = broker.subscribe("room_1", {
    messageOverlayTarget: { accountId: "acct_owner", accountAgentRouting: true },
  });
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() { return [routingRow]; },
    async loadAccountRoutings() {
      return new Map([["acct_owner", new Map([[7, {
        version: 1 as const,
        authority: "receipts" as const,
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: false,
      }]])]]);
    },
  });
  await assert.rejects(
    hydrateLiveMessageForSubscriber({
      roomId: "room_1",
      message: {
        id: "msg_7",
        sender: "Human",
        text: "",
        source: "browser",
        agent_prompt_kind: "auto",
      } as never,
      identity: {
        actor_label: "Worker",
        agent_key: "owner/worker",
        owner_account_id: "acct_owner",
        agent_instance_id: "instance_successor",
        agent_session_id: "session_successor_1",
        session_kind: "worker",
        runtime: "test",
        display_name: "Worker",
        owner_label: "Owner",
        ide_label: "Test",
        repo_branch: null,
      },
      target: broker.getMessageOverlayTargets("room_1")[0],
      broker,
      batcher,
    }),
    /prompt-only subscriber authority is no longer active/,
  );
  subscription.close();
  broker.close();
  batcher.close();
});

test("a buffered local prompt reaches a sole successor through fresh exact authority", async () => {
  const broker = new RoomEventBroker({ instanceId: "prompt-successor-replay" });
  const batcher = createRoomMessageOverlayBatcher({
    async loadRoutingRows() { return [routingRow]; },
    async loadAccountRoutings() {
      return new Map([["acct_owner", new Map([[7, {
        version: 1 as const,
        authority: "receipts" as const,
        recipient_agent_keys: ["owner/worker"],
        recipient_agent_sessions: [{
          agent_key: "owner/worker",
          agent_session_id: "session_captured",
          successor_agent_session_id: "session_successor",
          activation_reason: "explicit_mention",
        }],
        control_authorized: false,
      }]])]]);
    },
  });
  const message = {
    id: "msg_7",
    sender: "Human",
    text: "",
    source: "browser",
    agent_prompt_kind: "auto",
  } as never;
  const event = {
    kind: "message_created" as const,
    roomId: "room_1",
    message,
    recipientAgentTargetSet: new Set([
      "acct_owner\u0000owner/worker",
    ]),
  };
  const seed = broker.subscribe("room_1");
  const checkpoint = broker.publish({
    kind: "task_updated",
    roomId: "room_1",
    task: { id: "task_checkpoint" },
  } as never);
  assert.ok(checkpoint);
  assert.ok(broker.publish(event));
  seed.close();
  const successorIdentity = {
    actor_label: "Worker",
    agent_key: "owner/worker",
    owner_account_id: "acct_owner",
    agent_instance_id: "instance_successor",
    agent_session_id: "session_successor",
    session_kind: "worker" as const,
    runtime: "test",
    display_name: "Worker",
    owner_label: "Owner",
    ide_label: "Test",
    repo_branch: null,
  };
  const subscription = broker.subscribe("room_1", {
    afterCursor: checkpoint.cursor,
    messageOverlayTarget: { accountId: "acct_owner", accountAgentRouting: true },
    accept: (candidate) => isRoomEventVisibleToSubscriber({
      event: candidate,
      includePromptOnly: true,
      recipientAgentIdentity: successorIdentity,
    }),
  });
  const delivery = await subscription.next();
  assert.equal(delivery?.type, "event");
  const hydrated = await hydrateLiveMessageForSubscriber({
    roomId: "room_1",
    message,
    identity: successorIdentity,
    target: broker.getMessageOverlayTargets("room_1")[0],
    broker,
    batcher,
  });
  assert.equal(hydrated.activation?.for_current_agent?.decision, "activate");
  subscription.close();
  broker.close();
  batcher.close();
});

test("six-thousand-recipient activation builds one index instead of quadratic scans", () => {
  let yielded = 0;
  const targets = Array.from({ length: 6_000 }, (_, index) => ({
    agent_key: `owner/worker-${index}`,
    agent_session_id: `session_${index}`,
  }));
  const nativeIterator = targets[Symbol.iterator].bind(targets);
  Object.defineProperty(targets, Symbol.iterator, {
    value: function* () {
      for (const target of nativeIterator()) {
        yielded += 1;
        yield target;
      }
    },
  });
  const routing = {
    version: 1 as const,
    authority: "receipts" as const,
    recipient_agent_keys: targets.map((target) => target.agent_key),
    recipient_agent_sessions: targets,
    control_authorized: false,
  };
  for (let index = 0; index < 6_000; index += 1) {
    const attached = attachAccountRoutingAuthorityActivation(
      { id: "msg_7" },
      {
        actor_label: `Worker ${index}`,
        agent_key: `owner/worker-${index}`,
        owner_account_id: "acct_owner",
        agent_instance_id: `instance_${index}`,
        agent_session_id: `session_${index}`,
        session_kind: "worker",
        runtime: "test",
        display_name: `Worker ${index}`,
        owner_label: "Owner",
        ide_label: "Test",
        repo_branch: null,
      },
      routing,
    ) as { activation?: { for_current_agent?: { decision?: string } } };
    assert.equal(attached.activation?.for_current_agent?.decision, "activate");
  }
  assert.equal(yielded, 6_000, "the recipient array is indexed exactly once");
});
