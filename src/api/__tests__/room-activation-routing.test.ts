import assert from "node:assert/strict";
import test from "node:test";

import {
  attachAgentMessageActivations,
  decideAgentMessageActivation,
} from "../rooms/activation-routing.js";

const worker = {
  actor_label: "CometLively | EmmyMay's agent | Agent",
  agent_key: "EmmyMay/cometlively",
  display_name: "CometLively",
  session_kind: "worker" as const,
};

test("activation routing silences a worker's own echoed messages", () => {
  const decision = decideAgentMessageActivation({
    id: "msg_1",
    sender: "CometLively | EmmyMay's agent | Agent",
    text: "working on this",
  }, worker);

  assert.deepEqual(decision, {
    decision: "silent",
    reason: "self_message",
    addressed: false,
  });
});

test("activation routing activates explicit mentions and silences other mentions", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "@cometlively please take this",
    }, worker),
    {
      decision: "activate",
      reason: "explicit_mention",
      addressed: true,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_2",
      sender: "EmmyMay",
      text: "@NorthHarbor please review",
    }, worker),
    {
      decision: "silent",
      reason: "explicit_other_mention",
      addressed: false,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_3",
      sender: "EmmyMay",
      text: "@northharbor please review",
    }, worker),
    {
      decision: "silent",
      reason: "explicit_other_mention",
      addressed: false,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_4",
      sender: "EmmyMay",
      text: "@north-harbor please review",
    }, worker),
    {
      decision: "silent",
      reason: "explicit_other_mention",
      addressed: false,
    },
  );
});

test("activation routing activates full agent key mentions", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "@EmmyMay/cometlively please take this",
    }, worker),
    {
      decision: "activate",
      reason: "explicit_mention",
      addressed: true,
    },
  );
});

test("activation routing activates thread participants and direct reply targets", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_7",
      sender: "EmmyMay",
      text: "any update?",
      thread_root_id: "msg_3",
      reply_to: {
        sender: "EmmyMay",
      },
      thread: {
        root_message_id: "msg_3",
        participants: [
          { sender: "EmmyMay" },
          { sender: "CometLively | EmmyMay's agent | Agent" },
        ],
      },
    }, worker),
    {
      decision: "activate",
      reason: "thread_participant",
      addressed: true,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_8",
      sender: "EmmyMay",
      text: "try again",
      reply_to: {
        sender: "CometLively | EmmyMay's agent | Agent",
      },
    }, worker),
    {
      decision: "activate",
      reason: "reply_target",
      addressed: true,
    },
  );
});

test("activation routing ignores non-chat at-tokens when resolving replies", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_8",
      sender: "EmmyMay",
      text: "try npm install @types/node",
      reply_to: {
        sender: "CometLively | EmmyMay's agent | Agent",
      },
    }, worker),
    {
      decision: "activate",
      reason: "reply_target",
      addressed: true,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_9",
      sender: "EmmyMay",
      text: "email dev@example.com then try again",
      reply_to: {
        sender: "CometLively | EmmyMay's agent | Agent",
      },
    }, worker),
    {
      decision: "activate",
      reason: "reply_target",
      addressed: true,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_10",
      sender: "EmmyMay",
      text: "try adding @media print",
      reply_to: {
        sender: "CometLively | EmmyMay's agent | Agent",
      },
    }, worker),
    {
      decision: "activate",
      reason: "reply_target",
      addressed: true,
    },
  );
});

test("activation routing silences explicit other-agent mentions before reply ownership", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_11",
      sender: "EmmyMay",
      text: "@NorthHarbor please review this",
      reply_to: {
        sender: "CometLively | EmmyMay's agent | Agent",
      },
    }, worker),
    {
      decision: "silent",
      reason: "explicit_other_mention",
      addressed: false,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_12",
      sender: "EmmyMay",
      text: "@northharbor please review this",
      reply_to: {
        sender: "CometLively | EmmyMay's agent | Agent",
      },
    }, worker),
    {
      decision: "silent",
      reason: "explicit_other_mention",
      addressed: false,
    },
  );
});

test("activation routing leaves unaddressed code at-tokens unclear", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "npm install @types/node",
    }, worker),
    {
      decision: "unclear",
      reason: "unaddressed",
      addressed: false,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_2",
      sender: "EmmyMay",
      text: "try adding @media print",
    }, worker),
    {
      decision: "unclear",
      reason: "unaddressed",
      addressed: false,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_3",
      sender: "EmmyMay",
      text: "add @font-face for the custom font",
    }, worker),
    {
      decision: "unclear",
      reason: "unaddressed",
      addressed: false,
    },
  );
});

test("activation routing marks broadcasts as fan-out activations", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "you guys coordinate the review",
    }, worker),
    {
      decision: "activate",
      reason: "broadcast",
      addressed: true,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_2",
      sender: "EmmyMay",
      text: "@NorthHarbor or any agent can take this",
    }, worker),
    {
      decision: "activate",
      reason: "broadcast",
      addressed: true,
    },
  );
});

test("activation routing leaves unaddressed messages unclear in the advisory slice", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "okay try again",
    }, worker),
    {
      decision: "unclear",
      reason: "unaddressed",
      addressed: false,
    },
  );
});

test("activation routing attaches metadata only for worker sessions", () => {
  const messages = [{ id: "msg_1", sender: "EmmyMay", text: "@cometlively ping" }];

  const annotated = attachAgentMessageActivations(messages, worker);
  assert.equal(annotated[0].activation?.for_current_agent.reason, "explicit_mention");

  const controllerMessages = attachAgentMessageActivations(messages, {
    ...worker,
    session_kind: "controller",
  });
  assert.equal("activation" in controllerMessages[0], false);
});
