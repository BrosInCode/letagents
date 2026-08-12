import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentIdentity,
  Task,
  TaskOwnershipState,
} from "../db.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import type {
  CoordinationFocusRoomLike,
  CoordinationLeaseLike,
  CoordinationLockLike,
  CoordinationTaskLike,
} from "../coordination-policy.js";
import {
  createTaskCoordinationEnforcement,
  type TaskCoordinationEnforcementDeps,
} from "../tasks/coordination-enforcement.js";

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
    updateTaskLeaseWorkflowRefs: async (roomId, leaseId, updates) => {
      workflowRefUpdates.push({ roomId, leaseId, updates });
    },
    shouldRequireBoardIntent: async () => false,
    verifyBoardIntentApproval: async () => ({ kind: "allow" as const }),
    ...overrides,
  };

  return {
    deps,
    events,
    workflowRefUpdates,
    activeLeases,
    activeLocks,
    tasks,
    focusRooms,
  };
}

test("enforceTaskAdmissionCoordination denies agent-created work when manager approval is required", async () => {
  const harness = createHarness({
    shouldRequireBoardIntent: async () => true,
    verifyBoardIntentApproval: async () => ({
      kind: "deny",
      code: "board_intent_required",
      error: "Board Manager approval is required for this board action.",
    }),
  });
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskAdmissionCoordination({
    req: ownerReq(),
    projectId: "focus_5",
    title: "Make the board calmer",
    description: "Reduce default board noise",
    actorLabel,
    actorKey,
    actorInstanceId: "instance:dawn",
    actorSessionId: "agent_session_1",
  });

  assert.deepEqual(result, {
    kind: "deny",
    code: "board_intent_required",
    error: "Board Manager approval is required for this board action.",
  });
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event_type, "task_admit");
  assert.equal(harness.events[0].decision, "deny");
});

test("enforceTaskCoordinationMutation returns approved board intent for claiming", async () => {
  const approvalChecks: Array<Record<string, unknown>> = [];
  const harness = createHarness({
    shouldRequireBoardIntent: async () => true,
    verifyBoardIntentApproval: async (input) => {
      approvalChecks.push(input);
      return { kind: "allow", intent: { id: "bi_approved" } };
    },
  });
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskCoordinationMutation({
    req: ownerReq(),
    projectId: "focus_5",
    task: task({ status: "accepted" }),
    taskOwnership: {
      status: "accepted",
      assignee: null,
      assignee_agent_key: null,
    } satisfies TaskOwnershipState,
    updates: {
      status: "assigned",
      assignee: actorLabel,
      assignee_agent_key: actorKey,
    } as never,
    actorLabel,
    actorKey,
    actorInstanceId: "instance:dawn",
    actorSessionId: "agent_session_1",
    boardIntentId: "bi_approved",
    boardApprovalToken: "approval-token",
  });

  assert.deepEqual(result, {
    kind: "allow",
    boardIntentApproval: {
      room_id: "focus_5",
      action_type: "task_claim",
      payload: {
        task_id: "task_37",
        status: "assigned",
        assignee: actorLabel,
        assignee_agent_key: actorKey,
        pr_url: null,
      },
      intent_id: "bi_approved",
      approval_token: "approval-token",
    },
    workLeaseCreation: {
      agent_key: actorKey,
      agent_instance_id: "instance:dawn",
      actor_label: actorLabel,
      branch_ref: "letagents/task_37/emmymay-dawnwinter",
      created_by: actorLabel,
      output_intent: "Task 114 follow-up",
      agent_session_id: "agent_session_1",
    },
  });
  assert.equal(approvalChecks.length, 1);
});

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

  assert.deepEqual(result, {
    kind: "allow",
    workLeaseCreation: {
      agent_key: actorKey,
      agent_instance_id: "instance:dawn",
      actor_label: actorLabel,
      branch_ref: "letagents/task_37/emmymay-dawnwinter",
      created_by: actorLabel,
      output_intent: "Task 114 follow-up",
    },
  });
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event_type, "task_update");
  assert.equal(harness.events[0].decision, "allow");
  assert.equal(harness.events[0].lease_id, null);
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

test("enforceTaskAdmissionPreconditions records active room lock denials", async () => {
  const harness = createHarness();
  harness.activeLocks.push(lock());
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskAdmissionPreconditions({
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
  assert.equal(harness.events[0]?.event_type, "task_admit");
  assert.equal(harness.events[0]?.decision, "deny");
  assert.equal(harness.events[0]?.lock_id, "lock_1");
});

test("enforceTaskAdmissionPreconditions blocks duplicate task-create intents", async () => {
  const harness = createHarness();
  harness.tasks.push(task({
    id: "task_41",
    source_message_id: "msg_existing",
    title: "Investigate board manager delivery",
  }));
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskAdmissionPreconditions({
    projectId: "focus_5",
    title: "Investigate board manager delivery",
    sourceMessageId: "msg_existing",
    actorLabel,
    actorKey,
    actorInstanceId: "instance:dawn",
  });

  assert.equal(result.kind, "deny");
  assert.equal(result.code, "coordination_duplicate_work");
  assert.match(result.error, /Duplicate work intent matched source_message on task_41/);
  assert.equal(harness.events[0]?.event_type, "task_admit");
  assert.equal(harness.events[0]?.decision, "deny");
  assert.equal(harness.events[0]?.reason, result.error);
});
