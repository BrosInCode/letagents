import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SEQUENTIAL_REPLY_AGENTS, planReplyTurns, REPLY_TURN_HOLD_STEP_MS } from "../db/messages/reply-turn-plan.js";
import {
  attachAgentMessageActivationsFromReceipts,
  replyTurnGuidance,
  type ActivationIdentity,
} from "../../shared/activation-routing.js";

const sentAt = "2026-10-09T10:00:00.000Z";
const receipts = (reason = "broadcast") => ["owner/c", "owner/a", "owner/b"].map((agent_key) => ({
  agent_key,
  activation_reason: reason,
}));

test("reply order sorts agent keys and rotates the first speaker by message number", () => {
  const order = (messageNumber: number) => planReplyTurns(receipts(), {
    messageNumber,
    timestamp: sentAt,
    sequential: true,
  }).map((receipt) => receipt.agent_key);
  assert.deepEqual(order(3), ["owner/a", "owner/b", "owner/c"]);
  assert.deepEqual(order(4), ["owner/b", "owner/c", "owner/a"]);
  assert.deepEqual(order(5), ["owner/c", "owner/a", "owner/b"]);
});

test("position 1 is released at send time; later positions get stepped deadlines", () => {
  const planned = planReplyTurns(receipts(), { messageNumber: 3, timestamp: sentAt, sequential: true });
  assert.deepEqual(planned.map((receipt) => [
    receipt.turn_position,
    receipt.turn_count,
    receipt.hold_released_at,
    receipt.hold_release_after,
  ]), [
    [1, 3, sentAt, null],
    [2, 3, null, new Date(Date.parse(sentAt) + REPLY_TURN_HOLD_STEP_MS).toISOString()],
    [3, 3, null, new Date(Date.parse(sentAt) + 2 * REPLY_TURN_HOLD_STEP_MS).toISOString()],
  ]);
});

test("mentions, single receipts, mixed reasons and the parallel setting stay parallel", () => {
  const parallel = (rows: { agent_key: string; activation_reason: string }[], sequential = true) =>
    planReplyTurns(rows, { messageNumber: 7, timestamp: sentAt, sequential })
      .every((receipt) => receipt.turn_position === null && receipt.hold_released_at === null
        && receipt.hold_release_after === null && receipt.turn_count === null);
  assert.ok(parallel(receipts("explicit_mention")));
  assert.ok(parallel(receipts().slice(0, 1)));
  assert.ok(parallel([...receipts().slice(0, 2), { agent_key: "owner/d", activation_reason: "reply_target" }]));
  assert.ok(parallel(receipts(), false));
  assert.ok(!parallel(receipts("small_room").slice(0, 2)));
  assert.ok(!parallel(receipts("jev_routed")), "Jev's election of several agents is sequenced too");
  assert.ok(parallel(receipts("recent_conversation")), "recent_conversation stays parallel");
});

test("all speakers can express a complete viewpoint without a prescribed conversational formula", () => {
  for (const position of [1, 2, 3]) {
    const guidance = replyTurnGuidance(position, 3, position > 1 ? ["Alice"] : []);
    assert.match(guidance, /You are an equal participant/);
    assert.match(guidance, /Express a complete point of view/);
    assert.match(guidance, /later speakers are not limited to reviewing/);
    assert.match(guidance, /Speaking later does not require a shorter answer/);
    assert.match(guidance, /no required agreement preface/);
    assert.match(guidance, /Agreement can be substantive/);
    assert.match(guidance, /Useful overlap is welcome/);
    assert.match(guidance, /shared work already in progress/);
    assert.match(guidance, /unless the human asks for separate full answers/);
    assert.match(guidance, /does not require starting a thread/);
    assert.match(guidance, /Silence is not a vote/);
    assert.doesNotMatch(guidance, /Add only new points|agree in one short line|Cover only/);
  }
  assert.match(replyTurnGuidance(1, 3), /opening this exchange/);
});

test("guidance distinguishes missing context from an expired wait without inventing agreement", () => {
  assert.match(replyTurnGuidance(2, 3, ["Alice"]), /Alice answered before you/);
  assert.match(replyTurnGuidance(3, 3, ["Alice", "Bob"]), /Alice and Bob answered before you/);
  assert.match(replyTurnGuidance(2, 3, ["Alice"]), /if missing context matters, read the relevant room messages/);
  assert.match(replyTurnGuidance(2, 3, [], "deadline"), /wait for earlier turns expired/);
  assert.match(replyTurnGuidance(2, 3, [], "deadline"), /an earlier agent may still reply/);
  for (const reason of ["activation", "turn", "skipped", null, undefined]) {
    assert.match(replyTurnGuidance(2, 3, [], reason), /No earlier answer is recorded/);
    assert.doesNotMatch(replyTurnGuidance(2, 3, [], reason), /expired/);
  }
});

test("every sequenced receipt includes equal-participant guidance, including position 1", () => {
  const identity: ActivationIdentity = {
    actor_label: "Bob", agent_key: "owner/b", agent_instance_id: null,
    agent_session_id: "session-b", display_name: "Bob", session_kind: "worker",
  };
  const [first, second, third] = attachAgentMessageActivationsFromReceipts(
    [{ id: "msg_1", text: "@everyone ideas?" }, { id: "msg_2", text: "@everyone more?" }, { id: "msg_3", text: "@everyone again?" }],
    identity,
    new Map([
      [1, { activation_reason: "broadcast", turn_position: 1, turn_count: 2, prior_speakers: [] }],
      [2, { activation_reason: "broadcast", turn_position: 2, turn_count: 2, prior_speakers: ["Alice"] }],
      [3, { activation_reason: "broadcast", turn_position: 2, turn_count: 2, prior_speakers: [], hold_release_reason: "deadline" }],
    ]),
    new Set([1, 2, 3]),
  ) as Array<{ activation: { for_current_agent: Record<string, unknown> } }>;
  assert.deepEqual(first!.activation.for_current_agent.turn, { position: 1, count: 2, prior_speakers: [] });
  assert.equal(first!.activation.for_current_agent.guidance, replyTurnGuidance(1, 2));
  assert.deepEqual(second!.activation.for_current_agent.turn, { position: 2, count: 2, prior_speakers: ["Alice"] });
  assert.equal(second!.activation.for_current_agent.guidance, replyTurnGuidance(2, 2, ["Alice"]));
  assert.equal(third!.activation.for_current_agent.guidance, replyTurnGuidance(2, 2, [], "deadline"), "the receipt's release reason is used");
});

test("a broadcast to more agents than the sequence limit stays parallel", () => {
  const many = Array.from({ length: MAX_SEQUENTIAL_REPLY_AGENTS + 1 }, (_, index) => ({
    agent_key: `owner/${index}`,
    activation_reason: "broadcast",
  }));
  assert.ok(planReplyTurns(many, { messageNumber: 1, timestamp: sentAt, sequential: true })
    .every((receipt) => receipt.turn_position === null));
  assert.equal(planReplyTurns(many.slice(1), { messageNumber: 1, timestamp: sentAt, sequential: true })
    .filter((receipt) => receipt.hold_release_after !== null).length, MAX_SEQUENTIAL_REPLY_AGENTS - 1);
});

test("a reply-turn wake reaches only the released agent's worker subscription", async () => {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
  const { isRoomEventVisibleToSubscriber } = await import("../routes/rooms/messages/delivery-visibility.js");
  const message = { id: "msg_7", text: "@everyone ideas?", sender: "Ada" } as never;
  const wake = {
    kind: "message_routed" as const, roomId: "room", message,
    recipientAgentTargetSet: new Set<string>(), wakeAgentKeys: new Set(["owner/b"]),
  };
  const visible = (identity: { agent_key: string } | null, event: typeof wake | Omit<typeof wake, "wakeAgentKeys">) =>
    isRoomEventVisibleToSubscriber({ event, includePromptOnly: false, recipientAgentIdentity: identity });
  assert.equal(visible({ agent_key: "owner/b" }, wake), true);
  assert.equal(visible({ agent_key: "owner/a" }, wake), false, "other agents already saw it");
  assert.equal(visible(null, wake), false, "people and the app stream already saw it");
  const { wakeAgentKeys: _omit, ...routingPass } = wake;
  assert.equal(visible(null, routingPass), true, "an ordinary routing pass still reaches everyone");
});

test("parallel, disabled and malformed turns do not add experimental guidance", () => {
  const identity: ActivationIdentity = {
    actor_label: "Bob", agent_key: "owner/b", agent_instance_id: null,
    agent_session_id: "session-b", display_name: "Bob", session_kind: "worker",
  };
  for (const turn of [
    {}, { turn_position: 1, turn_count: 1 }, { turn_position: 0, turn_count: 3 },
    { turn_position: 3, turn_count: 2 },
    ...[1, 2].map((position) => ({ turn_position: position, turn_count: 2, hold_release_reason: "disabled" })),
  ]) {
    const [message] = attachAgentMessageActivationsFromReceipts([{ id: "msg_1" }], identity,
      new Map([[1, { activation_reason: "broadcast", ...turn }]]), new Set([1])) as
      Array<{ activation: { for_current_agent: Record<string, unknown> } }>;
    assert.deepEqual(message!.activation.for_current_agent, { decision: "activate", reason: "broadcast", addressed: true });
  }
});
