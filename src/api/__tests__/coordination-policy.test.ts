import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCoordinationMutation,
  findApplicableLock,
  isActiveCoordinationLease,
  leaseMatchesActor,
  type CoordinationLeaseLike,
  type CoordinationLockLike,
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
