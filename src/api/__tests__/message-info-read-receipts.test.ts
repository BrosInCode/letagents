import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { formatActivationReason } = await import("../routes/rooms/messages/info.js");
const { requiredAgentSessionRouteCapability } = await import("../request/agent-session-route-capabilities.js");
const { planObservationSpanUpdate } = await import("../routes/rooms/agents/observation.js");
const { attachAgentMessageActivationsFromReceipts } = await import("../../shared/activation-routing.js");

function routeSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("formatActivationReason maps all AgentMessageActivationReason values to human-friendly labels", () => {
  assert.equal(formatActivationReason("small_room"), "Included in this small room");
  assert.equal(formatActivationReason("recent_conversation"), "Continuing your conversation");
  assert.equal(formatActivationReason("explicit_mention"), "Mentioned directly");
  assert.equal(formatActivationReason("direct_mention"), "Mentioned directly");
  assert.equal(formatActivationReason("explicit_other_mention"), "Mentioned another agent");
  assert.equal(formatActivationReason("broadcast"), "Asked with @everyone");
  assert.equal(formatActivationReason("everyone"), "Asked with @everyone");
  assert.equal(formatActivationReason("reply_target"), "Replied to this agent");
  assert.equal(formatActivationReason("other_reply_target"), "Replied to another agent");
  assert.equal(formatActivationReason("thread_participant"), "Following this thread");
  assert.equal(formatActivationReason("task_owner"), "Assigned this work");
  assert.equal(formatActivationReason("self_message"), "Published by this agent");
  assert.equal(formatActivationReason("system_event"), "System notification");
  assert.equal(formatActivationReason("unaddressed"), "Unaddressed message");
  assert.equal(formatActivationReason("custom_reason"), "custom_reason");
});

test("agent session route capabilities registry covers message info and read receipt endpoints", () => {
  assert.equal(
    requiredAgentSessionRouteCapability("GET", "/rooms/room_123/messages/msg_5/info"),
    "messages.read"
  );
  assert.equal(
    requiredAgentSessionRouteCapability("PUT", "/rooms/room_123/messages/read"),
    "messages.read"
  );
  assert.equal(
    requiredAgentSessionRouteCapability("PUT", "/rooms/room_123/agents/self/observation"),
    "coordination.self_write"
  );
  assert.equal(
    requiredAgentSessionRouteCapability("PUT", "/rooms/room_123/messages/msg_5/agent-receipts/self"),
    "coordination.self_write"
  );
});

test("observation spans grow only through contiguous evidence and never bridge a gap", () => {
  const span = { id: "span_a", first_message_sequence: 10, last_message_sequence: 20 };

  assert.deepEqual(
    planObservationSpanUpdate([span], 15, 18),
    { kind: "noop", spanId: "span_a", first: 10, last: 20 },
  );
  assert.deepEqual(
    planObservationSpanUpdate([span], 21, 30),
    { kind: "extend", spanId: "span_a", first: 10, last: 30 },
  );
  assert.deepEqual(
    planObservationSpanUpdate([span], 5, 12),
    { kind: "extend", spanId: "span_a", first: 5, last: 20 },
  );
  // A gap means the agent never observed 21..99. That must become a new span.
  assert.deepEqual(
    planObservationSpanUpdate([span], 100, 110),
    { kind: "insert", first: 100, last: 110 },
  );
  // A reversed range is normalized before adjacency is judged, so it cannot
  // accidentally bridge the same gap.
  assert.deepEqual(
    planObservationSpanUpdate([span], 110, 100),
    { kind: "insert", first: 100, last: 110 },
  );
  assert.deepEqual(
    planObservationSpanUpdate([], 3, 7),
    { kind: "insert", first: 3, last: 7 },
  );
});

const workerIdentity = {
  actor_label: "GardenSignal | EmmyMay's agent | Supervisor Worker",
  agent_key: "owner/garden",
  agent_instance_id: null,
  agent_session_id: "session_1",
  display_name: "GardenSignal",
  session_kind: "worker",
};

test("a send-time receipt is the activation authority for its message", () => {
  const [attached] = attachAgentMessageActivationsFromReceipts(
    [{ id: "msg_5", sender: "EmmyMay", text: "no mention here", source: "human" }],
    workerIdentity,
    new Map([[5, { activation_reason: "broadcast" }]]),
    new Set([5]),
  ) as Array<{ activation: { for_current_agent: { decision: string; reason: string; addressed: boolean } } }>;
  assert.deepEqual(attached.activation.for_current_agent, {
    decision: "activate",
    reason: "broadcast",
    addressed: true,
  });
});

test("a snapshot message without a receipt stays silent: the router never re-promotes send-time decisions", () => {
  // The text mentions the agent, so the lazy router WOULD activate — but the
  // send-time snapshot already decided. Anything else is a second authority.
  const [attached] = attachAgentMessageActivationsFromReceipts(
    [{ id: "msg_8", sender: "EmmyMay", text: "@GardenSignal please fix the build", source: "human" }],
    workerIdentity,
    new Map(),
    new Set([8]),
  ) as Array<{ activation: { for_current_agent: { decision: string } } }>;
  assert.equal(attached.activation.for_current_agent.decision, "silent");
});

test("snapshot system failures retain the canonical silent system-event reason", () => {
  const [attached] = attachAgentMessageActivationsFromReceipts(
    [{
      id: "msg_9",
      sender: "GardenSignal",
      text: "Worker turn failed",
      source: "managed_agent_failure",
    }],
    workerIdentity,
    new Map(),
    new Set([9]),
  ) as Array<{ activation: { for_current_agent: { decision: string; reason: string } } }>;
  assert.deepEqual(attached.activation.for_current_agent, {
    decision: "silent",
    reason: "system_event",
    addressed: false,
  });
});

test("send-time routing never creates managed-agent recipients for GitHub event text", () => {
  const create = routeSource("../db/messages/create.ts");
  assert.match(
    create,
    /const untrustedExternalEvent = isUntrustedExternalActivationSource\(createdMessage\.source\)/,
  );
  assert.match(
    create,
    /const activeSessions = !untrustedExternalEvent && \(needsCompletePopulation \|\| candidateCondition\)/,
  );
  assert.match(
    create,
    /const taskOwnerFollowUp = !untrustedExternalEvent\s+&& isTaskOwnerFollowUpMessageText/,
  );
});

test("malformed scoped ids cannot borrow another message's receipt", () => {
  for (const id of ["msg_5junk", "msg_05", "msg_0", "msg_2147483648", "msg_9007199254740992"]) {
    const [attached] = attachAgentMessageActivationsFromReceipts(
      [{ id, sender: "EmmyMay", text: "no mention", source: "human" }],
      workerIdentity,
      new Map([[5, { activation_reason: "broadcast" }]]),
      new Set([5]),
    ) as Array<{ activation: { for_current_agent: { decision: string } } }>;
    assert.notEqual(attached.activation.for_current_agent.decision, "activate", id);
  }
});

test("pre-snapshot legacy messages keep lazy routing so backlog mentions still activate rotated sessions", () => {
  const [mentioned, unaddressed] = attachAgentMessageActivationsFromReceipts(
    [
      { id: "msg_6", sender: "EmmyMay", text: "@GardenSignal please fix the build", source: "human" },
      { id: "msg_7", sender: "EmmyMay", text: "just thinking out loud", source: "human" },
    ],
    workerIdentity,
    new Map(),
    new Set(),
  ) as Array<{ activation: { for_current_agent: { decision: string; reason: string } } }>;
  assert.equal(mentioned.activation.for_current_agent.decision, "activate");
  assert.equal(mentioned.activation.for_current_agent.reason, "explicit_mention");
  assert.notEqual(unaddressed.activation.for_current_agent.decision, "activate");
});

test("non-worker identities never receive activation envelopes from receipts", () => {
  const result = attachAgentMessageActivationsFromReceipts(
    [{ id: "msg_5", sender: "EmmyMay", text: "hello", source: "human" }],
    null,
    new Map([[5, { activation_reason: "broadcast" }]]),
    new Set([5]),
  );
  assert.equal("activation" in (result[0] as Record<string, unknown>), false);
});

test("every delivery surface routes through the single receipt authority", () => {
  const history = routeSource("../routes/rooms/messages/history.ts");
  const stream = routeSource("../routes/rooms/messages/stream.ts");
  const liveDelivery = routeSource("../routes/rooms/messages/live-message-delivery.ts");
  const receiptAuthority = routeSource("../routes/rooms/messages/receipt-activation.ts");

  assert.match(history, /attachReceiptAuthorityActivations/);
  assert.match(stream, /hydrateLiveMessageForSubscriber/);
  assert.match(liveDelivery, /attachAccountRoutingAuthorityActivation/);
  assert.match(receiptAuthority, /attachAgentMessageActivationsFromReceipts/);
  for (const source of [history, stream, liveDelivery]) {
    assert.doesNotMatch(source, /attachAgentMessageActivations\(/);
    assert.doesNotMatch(source, /attachAgentMessageActivation\(/);
  }
});

test("the server-owned replied transition checks its compare-and-set before recording an event", () => {
  const source = routeSource("../db/messages/create.ts");
  const repliedBlock = /const applied = await tx[\s\S]*?\.returning\(\{ id: message_agent_receipts\.id \}\);\s*if \(applied\.length === 0\) continue;/;
  assert.match(source, repliedBlock);
});

test("the replied transition stamps the canonical reply so supervised answers stay linkable", () => {
  // Supervised publications never set reply_to; without the stamped number,
  // Message info would show "Replied" with no working "View reply".
  const create = routeSource("../db/messages/create.ts");
  assert.match(create, /receipt_state: "replied",[\s\S]{0,400}?reply_message_number: createdMessage\.number/);
  const info = routeSource("../routes/rooms/messages/info.ts");
  assert.match(info, /r\.reply_message_number \? `msg_\$\{r\.reply_message_number\}` : null/);
});

test("info and receipt routes conceal missing messages with the house 404 wording", () => {
  for (const relative of [
    "../routes/rooms/messages/info.ts",
    "../routes/rooms/messages/agent-receipts.ts",
  ]) {
    const source = routeSource(relative);
    assert.doesNotMatch(source, /Message not found/);
  }
  assert.match(routeSource("../routes/rooms/messages/info.ts"), /message does not exist in this room/);
});

test("self-reported receipt states exclude the server-owned replied and unavailable transitions", () => {
  const source = routeSource("../routes/rooms/messages/agent-receipts.ts");
  const literal = /const validStates = \[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
  assert.ok(literal.includes('"responding"'));
  assert.ok(!literal.includes('"replied"'), "replied is derived from a committed reply message, never self-reported");
  assert.ok(!literal.includes('"unavailable"'));
  assert.ok(!literal.includes('"failed"'));
});

test("message-info invalidations never enumerate ids on the shared room stream", () => {
  for (const relative of [
    "../routes/rooms/messages/reads.ts",
    "../routes/rooms/messages/agent-receipts.ts",
    "../routes/rooms/agents/observation.ts",
    "../db/messages/create.ts",
    "../db/auth/room-agent-sessions.ts",
  ]) {
    const source = routeSource(relative);
    for (const call of source.match(/queueMessageInfoInvalidation\([^)]*\)/g) ?? []) {
      assert.match(call, /,\s*null\)$/, `${relative}: ${call} must stay room-level until per-stream visibility filtering exists`);
    }
  }
});

test("the web read reporter and the reads route agree on one wire contract", () => {
  const client = routeSource("../../web/src/components/room/MessageList.vue");
  const reporter = routeSource("../../web/src/components/room/readEvidence.ts");
  const server = routeSource("../routes/rooms/messages/reads.ts");
  assert.match(client, /readReporter\.qualify\(seq, threadRootSeqForMessage\(seq\)\)/);
  assert.match(reporter, /body: JSON\.stringify\(\{ ranges: queue \}\)/);
  assert.match(reporter, /first_message_id: `msg_\$\{range\.first\}`/);
  assert.match(reporter, /client_batch_id: makeBatchId\(\)/);
  assert.match(server, /req\.body\?\.ranges/);
  assert.match(server, /item\.first_message_id/);
  assert.match(server, /item\.client_batch_id/);
});

test("read evidence is room-scoped: switching rooms retires the old reporter", () => {
  const client = routeSource("../../web/src/components/room/MessageList.vue");
  assert.match(client, /watch\(\(\) => props\.roomIdentifier,[\s\S]{0,600}?createReadEvidenceReporter\(\{ roomIdentifier: nextRoomIdentifier/);
  assert.match(client, /retiring\.dispose\(\)/);
});

test("receipt transitions follow the lifecycle graph and unavailable has no self-reported entry", async () => {
  const { canTransitionReceiptState } = await import("../routes/rooms/messages/agent-receipts.js");
  assert.equal(canTransitionReceiptState("queued", "responding"), true);
  assert.equal(canTransitionReceiptState("queued", "replied"), true);
  assert.equal(canTransitionReceiptState("responding", "queued"), false, "receipts never regress to queued");
  assert.equal(canTransitionReceiptState("replied", "no_reply"), false, "replied is terminal");
  assert.equal(canTransitionReceiptState("cancelled", "responding"), false, "cancelled is terminal");
  assert.equal(canTransitionReceiptState("no_reply", "replied"), true, "a late reply upgrades no_reply");
  assert.equal(canTransitionReceiptState("unavailable", "replied"), true, "a successor may revive unavailable");
  assert.equal(canTransitionReceiptState("queued", "unavailable"), false, "unavailable is server-owned");
});

test("message info invalidations coalesce ids and overflow to room-level", async () => {
  const { mergeMessageInfoInvalidation } = await import("../server/message-info-events.js");
  assert.deepEqual([...mergeMessageInfoInvalidation(undefined, ["msg_1", "msg_2"])!], ["msg_1", "msg_2"]);
  assert.deepEqual([...mergeMessageInfoInvalidation(new Set(["msg_1"]), ["msg_1", "msg_3"])!], ["msg_1", "msg_3"]);
  assert.equal(mergeMessageInfoInvalidation(new Set(["msg_1"]), null), null, "room-level absorbs everything");
  assert.equal(mergeMessageInfoInvalidation(null, ["msg_9"]), null, "room-level stays room-level");
  assert.equal(mergeMessageInfoInvalidation(new Set(["msg_1", "msg_2"]), ["msg_3"], 2), null, "cap overflow degrades to room-level");
});

test("only the supervised reply namespace identifies a server-side reply target", async () => {
  const { chunkMessageReceiptRows, parseSupervisedReplySourceNumber } = await import("../db/messages/create.js");
  assert.equal(parseSupervisedReplySourceNumber("supervised-room:supervised_garden:msg_41:reply:v1"), 41);
  assert.equal(parseSupervisedReplySourceNumber("supervised-room:supervised_garden:room_a:msg_41:reply:v1"), 41);
  assert.equal(parseSupervisedReplySourceNumber("supervised-room:supervised_garden:msg_041:reply:v1"), null);
  assert.equal(parseSupervisedReplySourceNumber("supervised-room:supervised_garden:msg_41junk:reply:v1"), null);
  assert.equal(parseSupervisedReplySourceNumber("supervised-room:supervised_garden:msg_2147483648:reply:v1"), null);
  assert.equal(parseSupervisedReplySourceNumber("local-chat:room_1:7"), null);
  assert.equal(parseSupervisedReplySourceNumber("supervised-room:supervised_garden:not-a-message:reply:v1"), null);
  assert.equal(parseSupervisedReplySourceNumber(null), null);
  const receiptChunks = chunkMessageReceiptRows(Array.from({ length: 6_000 }, (_, index) => index));
  assert.equal(receiptChunks.length, 12);
  assert.ok(receiptChunks.every((chunk) => chunk.length <= 500));
});

test("terminal session ends are the only writer of unavailable receipts", () => {
  const auth = routeSource("../db/auth/room-agent-sessions.ts");
  assert.match(auth, /markUnresolvedReceiptsUnavailableTx/);
  assert.match(auth, /actor_session_id: null/);
  const receiptsRoute = routeSource("../routes/rooms/messages/agent-receipts.ts");
  const literal = /const validStates = \[([\s\S]*?)\]/.exec(receiptsRoute)?.[1] ?? "";
  assert.ok(!literal.includes('"unavailable"'));
});
