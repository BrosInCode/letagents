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

test("enforceTaskAdmissionPreconditions allows separate tasks from the same message", async () => {
  const harness = createHarness();
  harness.tasks.push(task({
    id: "task_41",
    source_message_id: "msg_existing",
    title: "Investigate board manager delivery",
  }));
  const service = createTaskCoordinationEnforcement(harness.deps);

  const result = await service.enforceTaskAdmissionPreconditions({
    projectId: "focus_5",
    title: "Fix manager permissions",
    sourceMessageId: "msg_existing",
    actorLabel,
    actorKey,
    actorInstanceId: "instance:dawn",
  });

  assert.deepEqual(result, { kind: "allow" });
  assert.equal(harness.events.length, 0);
});

function workerClaimInput() {
  return {
    req: { authKind: "agent_session", agentSession: {
      agent_session_id: "agent_session_1207", agent_key: actorKey,
      room_id: "focus_5", actor_label: actorLabel, agent_instance_id: "daemon:worker",
    } } as AuthenticatedRequest,
    projectId: "focus_5",
    task: task({ status: "accepted", assignee: null }),
    taskOwnership: { status: "accepted", assignee: null, assignee_agent_key: null } as TaskOwnershipState,
    updates: { status: "assigned" } as const,
    actorLabel, actorKey, actorInstanceId: "daemon:worker", actorSessionId: "agent_session_1207",
  };
}

test("worker claim creates session-bound work authority for subsequent updates", async () => {
  const harness = createHarness({ getAgentIdentityByCanonicalKey: async () => { throw new Error("worker must not require owner-token validation"); } });
  const service = createTaskCoordinationEnforcement(harness.deps);
  const input = workerClaimInput();
  const result = await service.enforceTaskCoordinationMutation(input);
  assert.equal(result.kind, "allow");
  if (result.kind !== "allow") return;
  assert.equal(result.workLeaseCreation?.agent_session_id, input.actorSessionId);
  assert.equal(result.workLeaseCreation?.agent_key, actorKey);
  harness.activeLeases.push(lease({ agent_session_id: input.actorSessionId, epoch: 0 }));
  const next = await service.enforceTaskCoordinationMutation({ ...input, task: task(), updates: { status: "in_progress" } });
  assert.equal(next.kind, "allow");
  if (next.kind === "allow") assert.equal(next.leaseFence?.agent_session_id, input.actorSessionId);
  const stale = await service.enforceTaskCoordinationMutation({ ...input, actorSessionId: "other_session", updates: { status: "in_progress" } });
  assert.equal(stale.kind, "deny", "updates from another session still fail closed");
});

test("worker claims retain board approval, locks and conflicting lease checks", async () => {
  const input = workerClaimInput();
  const gated = createHarness({ shouldRequireBoardIntent: async () => true,
    verifyBoardIntentApproval: async () => ({ kind: "deny", code: "approval_required", error: "Needs approval" }) });
  assert.equal((await createTaskCoordinationEnforcement(gated.deps).enforceTaskCoordinationMutation(input)).kind, "deny");
  for (const restriction of ["lock", "other_lease"] as const) {
    const harness = createHarness();
    if (restriction === "lock") harness.activeLocks.push(lock());
    else harness.activeLeases.push(lease({ agent_key: "other/worker", actor_label: "Other", agent_session_id: "other_session" }));
    assert.equal((await createTaskCoordinationEnforcement(harness.deps).enforceTaskCoordinationMutation(input)).kind, "deny", restriction);
  }
  const approved = createHarness({ shouldRequireBoardIntent: async () => true });
  const result = await createTaskCoordinationEnforcement(approved.deps).enforceTaskCoordinationMutation({ ...input, boardIntentId: "intent", boardApprovalToken: "approval" });
  assert.equal(result.kind, "allow");
  if (result.kind === "allow") assert.ok(result.workLeaseCreation);
});

test("worker claims reject missing or mismatched bearer session and room identities", async () => {
  for (const patch of [{ actorSessionId: null }, { actorSessionId: "different" }, { actorKey: "other/key" }, { projectId: "other-room" }]) {
    const harness = createHarness();
    const result = await createTaskCoordinationEnforcement(harness.deps).enforceTaskCoordinationMutation({ ...workerClaimInput(), ...patch });
    assert.equal(result.kind, "deny");
  }
});

test("assigned worker recovers a missing lease through the normal approved claim", async () => {
  const base = workerClaimInput();
  const input = { ...base, task: task(), taskOwnership: {
    status: "assigned", assignee: actorLabel, assignee_agent_key: actorKey,
  } as TaskOwnershipState };
  const checks: Array<Record<string, unknown>> = [];
  const harness = createHarness({ shouldRequireBoardIntent: async () => true,
    verifyBoardIntentApproval: async (check) => { checks.push(check); return check.intent_id
      ? { kind: "allow", intent: { id: check.intent_id } }
      : { kind: "deny", code: "board_intent_required", error: "Approval required" }; } });
  const service = createTaskCoordinationEnforcement(harness.deps);
  assert.equal((await service.enforceTaskCoordinationMutation(input)).kind, "deny");
  const recovery = await service.enforceTaskCoordinationMutation({ ...input, boardIntentId: "bi_recovery" });
  assert.equal(recovery.kind, "allow");
  if (recovery.kind !== "allow") return;
  assert.equal(recovery.workLeaseCreation?.agent_session_id, input.actorSessionId);
  assert.deepEqual(checks.at(-1)?.trusted_worker, { agent_session_id: input.actorSessionId, agent_key: actorKey });
  assert.deepEqual((recovery.boardIntentApproval as Record<string, unknown>).trusted_worker, checks.at(-1)?.trusted_worker);
  for (const changed of [
    { taskOwnership: { ...input.taskOwnership, assignee: "Someone else", assignee_agent_key: "other/key" } },
    { task: task({ status: "in_progress" }) },
  ]) assert.equal((await service.enforceTaskCoordinationMutation({ ...input, ...changed, boardIntentId: "bi_recovery" })).kind, "deny");
});

test("retrying an assigned claim reuses only the current session lease without another approval", async () => {
  const base = workerClaimInput();
  const input = { ...base, task: task(), taskOwnership: {
    status: "assigned", assignee: actorLabel, assignee_agent_key: actorKey,
  } as TaskOwnershipState };
  const harness = createHarness({ shouldRequireBoardIntent: async () => true,
    verifyBoardIntentApproval: async () => assert.fail("an existing claim must not consume another approval") });
  harness.activeLeases.push(lease({ agent_session_id: input.actorSessionId, epoch: 3 }));
  const result = await createTaskCoordinationEnforcement(harness.deps).enforceTaskCoordinationMutation(input);
  assert.equal(result.kind, "allow");
  if (result.kind === "allow") {
    assert.equal(result.workLeaseCreation, undefined);
    assert.equal(result.leaseFence?.expected_epoch, 3);
    assert.equal(result.leaseFence?.agent_session_id, input.actorSessionId);
  }
  harness.activeLocks.push(lock());
  // A retry cannot bypass a coordination lock or a successor's lease.
  harness.deps.verifyBoardIntentApproval = async () => ({ kind: "allow" });
  assert.equal((await createTaskCoordinationEnforcement(harness.deps).enforceTaskCoordinationMutation(input)).kind, "deny");
  harness.activeLocks.length = 0;
  harness.activeLeases[0]!.agent_session_id = "successor";
  assert.equal((await createTaskCoordinationEnforcement(harness.deps).enforceTaskCoordinationMutation(input)).kind, "deny");
});
