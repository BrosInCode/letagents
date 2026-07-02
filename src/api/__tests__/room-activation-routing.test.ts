import assert from "node:assert/strict";
import test from "node:test";

import {
  attachAgentMessageActivations,
  decideAgentMessageActivation,
} from "../../shared/activation-routing.js";

const worker = {
  actor_label: "CometLively | EmmyMay's agent | Agent",
  agent_key: "EmmyMay/cometlively",
  agent_instance_id: "agent_instance_1",
  agent_session_id: "agent_session_1",
  display_name: "CometLively",
  session_kind: "worker" as const,
};

function workLease(overrides: {
  actor_label?: string;
  agent_key?: string;
  agent_instance_id?: string | null;
  agent_session_id?: string | null;
} = {}) {
  return {
    kind: "work" as const,
    status: "active" as const,
    actor_label: overrides.actor_label ?? worker.actor_label,
    agent_key: overrides.agent_key ?? worker.agent_key,
    agent_instance_id: overrides.agent_instance_id ?? null,
    agent_session_id: overrides.agent_session_id ?? null,
  };
}

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

test("activation routing sends unaddressed work follow-ups to the active task owner", () => {
  for (const text of ["okay try again", "update it", "run tests", "fix tests"]) {
    assert.deepEqual(
      decideAgentMessageActivation({
        id: `msg_${text.length}`,
        sender: "EmmyMay",
        text,
      }, worker, {
        activeTaskLeases: [workLease()],
      }),
      {
        decision: "activate",
        reason: "task_owner",
        addressed: true,
      },
    );
  }
});

test("activation routing silences unrelated non-owners for unaddressed active task follow-ups", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "open a PR",
    }, worker, {
      activeTaskLeases: [workLease({
        actor_label: "NorthHarbor | EmmyMay's agent | Agent",
        agent_key: "EmmyMay/northharbor",
      })],
    }),
    {
      decision: "silent",
      reason: "task_owner",
      addressed: false,
    },
  );
});

test("activation routing does not turn room-wide announcements into task-owner silence", () => {
  const context = { activeTaskLeases: [workLease()] };

  for (const text of [
    "update: standup moved to 3pm",
    "merge freeze starts friday",
  ]) {
    assert.deepEqual(
      decideAgentMessageActivation({
        id: `msg_${text.length}`,
        sender: "EmmyMay",
        text,
      }, worker, context),
      {
        decision: "unclear",
        reason: "unaddressed",
        addressed: false,
      },
    );
  }

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_99",
      sender: "EmmyMay",
      text: "test env is down for everyone",
    }, worker, context),
    {
      decision: "activate",
      reason: "broadcast",
      addressed: true,
    },
  );
});

test("activation routing keeps task-owner inference conservative", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "okay try again",
    }, worker, {
      activeTaskLeases: [
        workLease(),
        workLease({
          actor_label: "CometLively | EmmyMay's agent | Agent",
          agent_key: "EmmyMay/northharbor",
        }),
      ],
    }),
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
      text: "continue",
    }, worker, {
      activeTaskLeases: [
        workLease(),
        workLease({
          actor_label: "CometLively",
          agent_key: "EmmyMay/cometlively",
        }),
      ],
    }),
    {
      decision: "activate",
      reason: "task_owner",
      addressed: true,
    },
  );

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_3",
      sender: "EmmyMay",
      text: "I pushed some notes",
    }, worker, {
      activeTaskLeases: [workLease()],
    }),
    {
      decision: "unclear",
      reason: "unaddressed",
      addressed: false,
    },
  );
});

test("activation routing does not route review requests to the work owner", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "review it",
    }, worker, {
      activeTaskLeases: [workLease()],
    }),
    {
      decision: "unclear",
      reason: "unaddressed",
      addressed: false,
    },
  );
});

test("activation routing respects session-specific task ownership", () => {
  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: "EmmyMay",
      text: "continue",
    }, {
      ...worker,
      agent_session_id: "agent_session_2",
    }, {
      activeTaskLeases: [workLease({ agent_session_id: "agent_session_1" })],
    }),
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
      text: "continue",
    }, worker, {
      activeTaskLeases: [workLease({ agent_session_id: "agent_session_1" })],
    }),
    {
      decision: "activate",
      reason: "task_owner",
      addressed: true,
    },
  );
});

test("activation routing does not silence teammates when the task owner sends an unaddressed request", () => {
  const teammate = {
    ...worker,
    actor_label: "NorthHarbor | EmmyMay's agent | Agent",
    agent_key: "EmmyMay/northharbor",
    agent_instance_id: "agent_instance_2",
    agent_session_id: "agent_session_2",
    display_name: "NorthHarbor",
  };

  assert.deepEqual(
    decideAgentMessageActivation({
      id: "msg_1",
      sender: worker.actor_label,
      text: "merge it when you get a chance",
    }, teammate, {
      activeTaskLeases: [workLease()],
    }),
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
