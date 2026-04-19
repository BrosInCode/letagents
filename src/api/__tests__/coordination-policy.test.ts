import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCoordinationMutation,
  evaluateReviewLeaseRouting,
  evaluateTaskAdmission,
  findApplicableLock,
  isActiveCoordinationLease,
  leaseMatchesActor,
  type CoordinationLeaseLike,
  type CoordinationLockLike,
  type CoordinationTaskLike,
} from "../coordination-policy.js";

function lease(overrides: Partial<CoordinationLeaseLike> = {}): CoordinationLeaseLike {
  return {
    id: "tl_1",
    room_id: "github.com/brosincode/letagents",
    task_id: "task_90",
    kind: "work",
    status: "active",
    agent_key: "EmmyMay/bayotter",
    agent_instance_id: "instance:bayotter-1",
    actor_label: "BayOtter | EmmyMay's agent | Agent",
    expires_at: null,
    ...overrides,
  };
}

function lock(overrides: Partial<CoordinationLockLike> = {}): CoordinationLockLike {
  return {
    id: "lock_1",
    room_id: "github.com/brosincode/letagents",
    task_id: "task_90",
    scope: "task",
    reason: "human_stop",
    message: "Human asked the worker to stop.",
    cleared_at: null,
    ...overrides,
  };
}

function task(overrides: Partial<CoordinationTaskLike> = {}): CoordinationTaskLike {
  return {
    id: "task_90",
    room_id: "github.com/brosincode/letagents",
    status: "in_progress",
    source_message_id: "msg_400",
    pr_url: null,
    workflow_artifacts: [],
    ...overrides,
  };
}

test("isActiveCoordinationLease rejects expired and revoked leases", () => {
  const now = new Date("2026-04-19T19:00:00.000Z");

  assert.equal(isActiveCoordinationLease(lease(), now), true);
  assert.equal(
    isActiveCoordinationLease(
      lease({ expires_at: "2026-04-19T18:59:59.000Z" }),
      now
    ),
    false
  );
  assert.equal(isActiveCoordinationLease(lease({ status: "revoked" }), now), false);
});

test("leaseMatchesActor binds an instance-scoped lease to the exact worker instance", () => {
  assert.equal(
    leaseMatchesActor(lease(), {
      actorLabel: "BayOtter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/bayotter",
      agentInstanceId: "instance:bayotter-1",
    }),
    true
  );
  assert.equal(
    leaseMatchesActor(lease(), {
      actorLabel: "BayOtter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/bayotter",
      agentInstanceId: "instance:bayotter-2",
    }),
    false
  );
});

test("findApplicableLock applies room locks to every task and task locks only to the task", () => {
  assert.equal(
    findApplicableLock({
      locks: [lock({ id: "room_lock", scope: "room", task_id: null })],
      taskId: "task_91",
    })?.id,
    "room_lock"
  );
  assert.equal(
    findApplicableLock({
      locks: [lock({ id: "other_task_lock", task_id: "task_91" })],
      taskId: "task_90",
    }),
    null
  );
});

test("evaluateCoordinationMutation denies before mutation when a stop lock exists", () => {
  const result = evaluateCoordinationMutation({
    mutation: "workflow_artifact_attach",
    taskId: "task_90",
    requiredLeaseKind: "work",
    actor: {
      actorLabel: "BayOtter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/bayotter",
      agentInstanceId: "instance:bayotter-1",
    },
    leases: [lease()],
    locks: [lock()],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "deny");
  assert.equal(result.kind === "deny" ? result.code : null, "active_lock");
});

test("evaluateCoordinationMutation allows the worker holding the active work lease", () => {
  const result = evaluateCoordinationMutation({
    mutation: "task_complete",
    taskId: "task_90",
    requiredLeaseKind: "work",
    actor: {
      actorLabel: "BayOtter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/bayotter",
      agentInstanceId: "instance:bayotter-1",
    },
    leases: [lease()],
    locks: [],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "allow");
  assert.equal(result.kind === "allow" ? result.lease.id : null, "tl_1");
});

test("evaluateCoordinationMutation denies a second worker on the same work lease", () => {
  const result = evaluateCoordinationMutation({
    mutation: "workflow_artifact_attach",
    taskId: "task_90",
    requiredLeaseKind: "work",
    actor: {
      actorLabel: "DawnWinter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/dawnwinter",
      agentInstanceId: "instance:dawn-1",
    },
    leases: [lease()],
    locks: [],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "deny");
  assert.equal(result.kind === "deny" ? result.code : null, "wrong_actor");
});

test("evaluateCoordinationMutation does not let a review lease satisfy work publication", () => {
  const result = evaluateCoordinationMutation({
    mutation: "workflow_artifact_attach",
    taskId: "task_90",
    requiredLeaseKind: "work",
    actor: {
      actorLabel: "StoneCloud | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/stonecloud",
      agentInstanceId: "instance:stone-1",
    },
    leases: [
      lease({
        id: "tl_review",
        kind: "review",
        agent_key: "EmmyMay/stonecloud",
        agent_instance_id: "instance:stone-1",
        actor_label: "StoneCloud | EmmyMay's agent | Agent",
      }),
    ],
    locks: [],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "deny");
  assert.equal(result.kind === "deny" ? result.code : null, "wrong_lease_kind");
});

test("evaluateTaskAdmission routes source-message duplicates to review", () => {
  const result = evaluateTaskAdmission({
    intent: { sourceMessageId: "msg_400" },
    tasks: [task()],
  });

  assert.equal(result.kind, "route_to_review");
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.reason : null,
    "source_message"
  );
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.taskId : null,
    "task_90"
  );
});

test("evaluateTaskAdmission routes active focus-room source task duplicates to review", () => {
  const result = evaluateTaskAdmission({
    intent: { sourceTaskId: "task_90" },
    tasks: [],
    focusRooms: [
      {
        room_id: "focus_3",
        focus_key: "task_90",
        source_task_id: "task_90",
        focus_status: "active",
      },
    ],
  });

  assert.equal(result.kind, "route_to_review");
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.reason : null,
    "focus_room"
  );
});

test("evaluateTaskAdmission routes workflow-artifact PR-number duplicates to review", () => {
  const result = evaluateTaskAdmission({
    intent: {
      workflowArtifacts: [
        {
          provider: "github",
          kind: "pull_request",
          number: 184,
        },
      ],
    },
    tasks: [
      task({
        workflow_artifacts: [
          {
            provider: "github",
            kind: "pull_request",
            url: "https://github.com/BrosInCode/letagents/pull/184",
            number: 184,
          },
        ],
      }),
    ],
  });

  assert.equal(result.kind, "route_to_review");
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.reason : null,
    "workflow_artifact"
  );
});

test("evaluateTaskAdmission routes duplicate active branch lease intent to review", () => {
  const result = evaluateTaskAdmission({
    intent: { branchRef: "dawnwinter/task-94-gates" },
    tasks: [task({ source_message_id: null })],
    leases: [
      lease({
        branch_ref: "dawnwinter/task-94-gates",
        task_id: "task_90",
      }),
    ],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "route_to_review");
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.reason : null,
    "lease_branch_ref"
  );
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.taskId : null,
    "task_90"
  );
});

test("evaluateTaskAdmission routes duplicate PR-number intent from an active lease to review", () => {
  const result = evaluateTaskAdmission({
    intent: {
      workflowArtifacts: [
        {
          provider: "github",
          kind: "pull_request",
          number: 183,
        },
      ],
    },
    tasks: [task({ source_message_id: null })],
    leases: [
      lease({
        pr_url: "https://github.com/BrosInCode/letagents/pull/183",
        task_id: "task_90",
      }),
    ],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "route_to_review");
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.reason : null,
    "lease_pr_url"
  );
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.taskId : null,
    "task_90"
  );
});

test("evaluateTaskAdmission routes duplicate output intent from an active lease to review", () => {
  const result = evaluateTaskAdmission({
    intent: { outputIntent: "fix chat scroll from top" },
    tasks: [task({ source_message_id: null })],
    leases: [
      lease({
        output_intent: "fix chat scroll from top",
        task_id: "task_90",
      }),
    ],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "route_to_review");
  assert.equal(
    result.kind === "route_to_review" ? result.duplicate.reason : null,
    "lease_output_intent"
  );
});

test("evaluateReviewLeaseRouting rejects the active work lease holder", () => {
  const result = evaluateReviewLeaseRouting({
    taskId: "task_90",
    actor: {
      actorLabel: "BayOtter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/bayotter",
      agentInstanceId: "instance:bayotter-1",
    },
    leases: [lease()],
    reviewerAgentKeys: ["EmmyMay/bayotter"],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "deny");
  assert.equal(result.kind === "deny" ? result.code : null, "work_lease_holder");
});

test("evaluateReviewLeaseRouting allows assigned reviewers without taking over work", () => {
  const result = evaluateReviewLeaseRouting({
    taskId: "task_90",
    actor: {
      actorLabel: "StoneCloud | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/stonecloud",
      agentInstanceId: "instance:stone-1",
    },
    leases: [
      lease(),
      lease({
        id: "tl_review",
        kind: "review",
        agent_key: "EmmyMay/stonecloud",
        agent_instance_id: "instance:stone-1",
        actor_label: "StoneCloud | EmmyMay's agent | Agent",
      }),
    ],
    reviewerAgentKeys: ["EmmyMay/stonecloud"],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "allow");
  assert.equal(result.kind === "allow" ? result.activeWorkLease?.id : null, "tl_1");
  assert.equal(result.kind === "allow" ? result.existingReviewLease?.id : null, "tl_review");
});

test("evaluateReviewLeaseRouting rejects unassigned reviewers when routing is scoped", () => {
  const result = evaluateReviewLeaseRouting({
    taskId: "task_90",
    actor: {
      actorLabel: "DawnWinter | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/dawnwinter",
      agentInstanceId: "instance:dawn-1",
    },
    leases: [lease()],
    reviewerAgentKeys: ["EmmyMay/stonecloud"],
    now: new Date("2026-04-19T19:00:00.000Z"),
  });

  assert.equal(result.kind, "deny");
  assert.equal(result.kind === "deny" ? result.code : null, "unassigned_reviewer");
});
