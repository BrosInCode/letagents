import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentIdentity,
  Task,
  TaskLeaseKind,
  TaskOwnershipState,
} from "../db.js";
import type { AuthenticatedRequest } from "../http-helpers.js";
import type {
  CoordinationFocusRoomLike,
  CoordinationLeaseLike,
  CoordinationLockLike,
  CoordinationTaskLike,
} from "../coordination-policy.js";
import {
  createTaskCoordinationEnforcement,
  type TaskCoordinationEnforcementDeps,
} from "../task-coordination-enforcement.js";

const actorLabel = "DawnWinter | EmmyMay's agent | Agent";
const actorKey = "EmmyMay/dawnwinter";

function ownerReq(accountId = "acct_1"): AuthenticatedRequest {
  return {
    authKind: "owner_token",
    sessionAccount: { account_id: accountId },
  } as AuthenticatedRequest;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_37",
    room_id: "focus_5",
    title: "Task 114 follow-up",
    description: null,
    status: "assigned",
    assignee: actorLabel,
    created_by: actorLabel,
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function lease(overrides: Partial<CoordinationLeaseLike> = {}): CoordinationLeaseLike {
  return {
    id: "tl_existing",
    room_id: "focus_5",
    task_id: "task_37",
    kind: "work",
    status: "active",
    agent_key: actorKey,
    agent_instance_id: null,
    actor_label: actorLabel,
    branch_ref: "letagents/task_37/emmymay-dawnwinter",
    pr_url: null,
    output_intent: "Task 114 follow-up",
    expires_at: null,
    ...overrides,
  };
}

function lock(overrides: Partial<CoordinationLockLike> = {}): CoordinationLockLike {
  return {
    id: "lock_1",
    room_id: "focus_5",
    task_id: null,
    scope: "room",
    reason: "manager_pause",
    message: null,
    cleared_at: null,
    ...overrides,
  };
}

function createHarness(overrides: Partial<TaskCoordinationEnforcementDeps> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const createdLeases: Array<Record<string, unknown>> = [];
  const workflowRefUpdates: Array<{
    roomId: string;
    leaseId: string;
    updates: { branch_ref?: string | null; pr_url?: string | null };
  }> = [];
  const activeLeases: CoordinationLeaseLike[] = [];
  const activeLocks: CoordinationLockLike[] = [];
  const tasks: CoordinationTaskLike[] = [];
  const focusRooms: CoordinationFocusRoomLike[] = [];

  const deps: TaskCoordinationEnforcementDeps = {
    getAgentIdentityByCanonicalKey: async (canonicalKey) => ({
      canonical_key: canonicalKey,
      owner_account_id: "acct_1",
    } satisfies Pick<AgentIdentity, "canonical_key" | "owner_account_id">),
    createCoordinationEvent: async (input) => {
      events.push(input);
    },
    getActiveTaskLocks: async () => activeLocks,
    getTasks: async () => ({ tasks, has_more: false }),
    getFocusRoomsForParent: async () => focusRooms,
    getActiveTaskLeases: async () => activeLeases,
    createTaskLease: async (input) => {
      createdLeases.push(input);
      return lease({
        id: "tl_created",
        room_id: input.room_id,
        task_id: input.task_id,
        kind: input.kind as TaskLeaseKind,
        agent_key: input.agent_key,
        agent_instance_id: input.agent_instance_id ?? null,
        actor_label: input.actor_label,
        branch_ref: input.branch_ref ?? null,
        pr_url: input.pr_url ?? null,
        output_intent: input.output_intent ?? null,
        expires_at: input.expires_at ?? null,
      });
    },
    updateTaskLeaseWorkflowRefs: async (roomId, leaseId, updates) => {
      workflowRefUpdates.push({ roomId, leaseId, updates });
    },
    ...overrides,
  };

  return {
    deps,
    events,
    createdLeases,
    workflowRefUpdates,
    activeLeases,
    activeLocks,
    tasks,
    focusRooms,
  };
}

test("enforceTaskCoordinationMutation issues a work lease for the assigned actor", async () => {
  const harness = createHarness();
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskCoordinationMutation({
    req: ownerReq(),
    projectId: "focus_5",
    task: task(),
    taskOwnership: {
      status: "assigned",
      assignee: null,
      assignee_agent_key: actorKey,
    } satisfies TaskOwnershipState,
    updates: { status: "in_progress" },
    actorLabel,
    actorKey,
    actorInstanceId: "instance:dawn",
  });

  assert.deepEqual(result, { kind: "allow" });
  assert.equal(harness.createdLeases.length, 1);
  assert.deepEqual(harness.createdLeases[0], {
    room_id: "focus_5",
    task_id: "task_37",
    kind: "work",
    agent_key: actorKey,
    agent_instance_id: "instance:dawn",
    actor_label: actorLabel,
    branch_ref: "letagents/task_37/emmymay-dawnwinter",
    created_by: actorLabel,
    output_intent: "Task 114 follow-up",
  });
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event_type, "task_update");
  assert.equal(harness.events[0].decision, "allow");
  assert.equal(harness.events[0].lease_id, "tl_created");
});

test("enforceTaskCoordinationMutation binds PR URLs to an existing work lease", async () => {
  const harness = createHarness();
  harness.activeLeases.push(lease());
  const service = createTaskCoordinationEnforcement(harness.deps);
  const prUrl = "https://github.com/BrosInCode/letagents/pull/256";

  const result = await service.enforceTaskCoordinationMutation({
    req: ownerReq(),
    projectId: "focus_5",
    task: task(),
    taskOwnership: {
      status: "in_progress",
      assignee: actorLabel,
      assignee_agent_key: null,
    } satisfies TaskOwnershipState,
    updates: { pr_url: prUrl },
    actorLabel,
    actorKey,
    actorInstanceId: null,
  });

  assert.deepEqual(result, { kind: "allow" });
  assert.deepEqual(harness.workflowRefUpdates, [
    {
      roomId: "focus_5",
      leaseId: "tl_existing",
      updates: { pr_url: prUrl },
    },
  ]);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event_type, "workflow_artifact_attach");
  assert.equal(harness.events[0].decision, "allow");
});

test("enforceTaskAdmissionCoordination records active room lock denials", async () => {
  const harness = createHarness();
  harness.activeLocks.push(lock());
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskAdmissionCoordination({
    req: ownerReq(),
    projectId: "focus_5",
    title: "New slice",
    actorLabel,
    actorKey,
    actorInstanceId: null,
  });

  assert.deepEqual(result, {
    kind: "deny",
    code: "coordination_active_lock",
    error: "Task admission is blocked by manager_pause lock lock_1.",
  });
  assert.deepEqual(harness.events, [
    {
      room_id: "focus_5",
      task_id: null,
      event_type: "task_admit",
      decision: "deny",
      actor_label: actorLabel,
      actor_key: actorKey,
      actor_instance_id: null,
      reason: "Task admission is blocked by manager_pause lock lock_1.",
      lease_id: null,
      lock_id: "lock_1",
    },
  ]);
});
