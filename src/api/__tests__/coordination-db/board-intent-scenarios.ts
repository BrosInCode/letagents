import assert from "node:assert/strict";
import test from "node:test";

import {
  databaseTestOptions,
  dbApi,
} from "./harness.js";

test(
  "board intents expire pending rows before queue reads",
  databaseTestOptions,
  async () => {
    const {
      countBoardIntents,
      createBoardIntent,
      createProjectWithName,
      verifyBoardIntentApproval,
    } = dbApi;
    if (
      !countBoardIntents ||
      !createBoardIntent ||
      !createProjectWithName ||
      !verifyBoardIntentApproval
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-expiry");
    const payload = {
      task_id: "task_1",
      status: "assigned",
      assignee: "BayOtter",
      assignee_agent_key: "EmmyMay/bayotter",
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      expires_at: "2000-01-01T00:00:00.000Z",
      now: new Date("2026-07-03T10:00:00.000Z"),
    });

    assert.equal(intent.status, "pending");
    assert.equal(await countBoardIntents({ room_id: room.id, status: "pending" }), 0);

    const expiredDecision = await verifyBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: "unused",
      now: new Date("2026-07-03T10:00:01.000Z"),
    });
    assert.deepEqual(expiredDecision, {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intent.id} has expired.`,
    });
  },
);

test(
  "expired pending board intents cannot be denied",
  databaseTestOptions,
  async () => {
    const {
      createBoardIntent,
      createProjectWithName,
      denyBoardIntent,
      verifyBoardIntentApproval,
    } = dbApi;
    if (
      !createBoardIntent ||
      !createProjectWithName ||
      !denyBoardIntent ||
      !verifyBoardIntentApproval
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-deny-expired");
    const payload = {
      task_id: "task_4",
      status: "assigned",
      assignee: "HarborLight",
      assignee_agent_key: "EmmyMay/harborlight",
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      expires_at: "2000-01-01T00:00:00.000Z",
      now: new Date("2026-07-03T09:30:00.000Z"),
    });

    const denied = await denyBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "Board Manager",
      now: new Date("2026-07-03T10:00:00.000Z"),
    });
    assert.equal(denied, null);

    const expiredDecision = await verifyBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: "unused",
      now: new Date("2026-07-03T10:00:01.000Z"),
    });
    assert.deepEqual(expiredDecision, {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intent.id} has expired.`,
    });
  },
);

test(
  "board intent approvals are consumed exactly once",
  databaseTestOptions,
  async () => {
    const {
      approveBoardIntent,
      consumeBoardIntentApproval,
      createBoardIntent,
      createProjectWithName,
    } = dbApi;
    if (
      !approveBoardIntent ||
      !consumeBoardIntentApproval ||
      !createBoardIntent ||
      !createProjectWithName
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-consume-once");
    const payload = {
      task_id: "task_2",
      status: "assigned",
      assignee: "DawnWinter",
      assignee_agent_key: "EmmyMay/dawnwinter",
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      now: new Date("2026-07-03T10:00:00.000Z"),
    });
    const approved = await approveBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "Board Manager",
      now: new Date("2026-07-03T10:01:00.000Z"),
    });
    assert.ok(approved);

    const firstDecision = await consumeBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-03T10:02:00.000Z"),
    });
    assert.equal(firstDecision.kind, "allow");

    const secondDecision = await consumeBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-03T10:03:00.000Z"),
    });
    assert.deepEqual(secondDecision, {
      kind: "deny",
      code: "board_intent_not_approved",
      error: `Board intent ${intent.id} is used, not approved.`,
    });
  },
);

test(
  "approving a task_create board intent creates the task and marks the intent used",
  databaseTestOptions,
  async () => {
    const {
      approveTaskCreateBoardIntent,
      createBoardIntent,
      createProjectWithName,
      verifyBoardIntentApproval,
    } = dbApi;
    if (
      !approveTaskCreateBoardIntent ||
      !createBoardIntent ||
      !createProjectWithName ||
      !verifyBoardIntentApproval
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-task-create-approval");
    const payload = {
      title: "Investigate accepted task editing",
      description: "Find why accepted board tasks cannot be edited after creation.",
      source_message_id: "msg_94",
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_create",
      payload,
      proposer_actor_label: "HarborVale",
      now: new Date("2026-07-04T02:20:00.000Z"),
    });

    const approved = await approveTaskCreateBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "RiverField",
      now: new Date("2026-07-04T02:21:00.000Z"),
    });
    assert.ok(approved);
    assert.equal(approved.task.title, payload.title);
    assert.equal(approved.task.description, payload.description);
    assert.equal(approved.task.source_message_id, payload.source_message_id);
    assert.equal(approved.task.created_by, "HarborVale");
    assert.equal(approved.task.status, "proposed");
    assert.equal(approved.intent.status, "used");
    assert.equal(approved.intent.task_id, approved.task.id);
    assert.equal(approved.intent.decision_by, "RiverField");

    const reuseDecision = await verifyBoardIntentApproval({
      room_id: room.id,
      action_type: "task_create",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-04T02:22:00.000Z"),
    });
    assert.deepEqual(reuseDecision, {
      kind: "deny",
      code: "board_intent_not_approved",
      error: `Board intent ${intent.id} is used, not approved.`,
    });
  },
);

test(
  "approved board intents deny consumption after approval expiry",
  databaseTestOptions,
  async () => {
    const {
      approveBoardIntent,
      consumeBoardIntentApproval,
      createBoardIntent,
      createProjectWithName,
    } = dbApi;
    if (
      !approveBoardIntent ||
      !consumeBoardIntentApproval ||
      !createBoardIntent ||
      !createProjectWithName
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-approval-expiry");
    const payload = {
      task_id: "task_3",
      status: "done",
      assignee: null,
      assignee_agent_key: null,
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_close",
      payload,
      now: new Date("2026-07-03T10:00:00.000Z"),
    });
    const approved = await approveBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "Board Manager",
      now: new Date("2026-07-03T10:01:00.000Z"),
    });
    assert.ok(approved);

    const decision = await consumeBoardIntentApproval({
      room_id: room.id,
      action_type: "task_close",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-03T10:31:01.000Z"),
    });
    assert.deepEqual(decision, {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intent.id} approval has expired.`,
    });
  },
);

test(
  "pending board intents are superseded when the task reaches their target another way",
  databaseTestOptions,
  async () => {
    const {
      countBoardIntents,
      createBoardIntent,
      createProjectWithName,
      createTask,
      getBoardGovernanceSnapshot,
      getBoardIntent,
      updateTask,
    } = dbApi;
    if (
      !countBoardIntents ||
      !createBoardIntent ||
      !createProjectWithName ||
      !createTask ||
      !getBoardGovernanceSnapshot ||
      !getBoardIntent ||
      !updateTask
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-supersede");
    const task = await createTask(room.id, "Ship year dots", "EmmyMay");
    const closeIntent = (status: string) => createBoardIntent({
      room_id: room.id,
      action_type: "task_close",
      task_id: task.id,
      payload: { task_id: task.id, status, assignee: null, assignee_agent_key: null, pr_url: null },
      proposer_actor_label: "ScarletHarbor",
      proposer_actor_key: "EmmyMay/scarletharbor",
    });
    const claimIntent = (actorKey: string) => createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      task_id: task.id,
      payload: { task_id: task.id, status: "assigned", assignee: actorKey, assignee_agent_key: actorKey, pr_url: null },
      proposer_actor_label: actorKey,
      proposer_actor_key: actorKey,
    });
    const statusOf = async (intentId: string) =>
      (await getBoardIntent({ room_id: room.id, intent_id: intentId }))?.status;

    await updateTask(room.id, task.id, { status: "accepted" });
    const losingClaim = await claimIntent("EmmyMay/copperridge");
    // A different agent claiming the task makes the pending claim moot.
    await updateTask(room.id, task.id, { status: "assigned", assignee: "SparrowOtter", assignee_agent_key: "EmmyMay/sparrowotter" });
    assert.equal(await statusOf(losingClaim.id), "superseded");

    await updateTask(room.id, task.id, { status: "in_progress" });
    await updateTask(room.id, task.id, { status: "in_review" });
    const mergeIntent = await closeIntent("merged");
    const doneIntent = await closeIntent("done");
    const reopenIntent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_override",
      task_id: task.id,
      payload: { task_id: task.id, status: "accepted", assignee: null, assignee_agent_key: null, pr_url: null },
    });
    assert.equal(await countBoardIntents({ room_id: room.id, status: "pending" }), 3);

    // The pull request merged on GitHub: the merge request is done, the close is not yet.
    await updateTask(room.id, task.id, { status: "merged" });
    const merged = await getBoardIntent({ room_id: room.id, intent_id: mergeIntent.id });
    assert.equal(merged?.status, "superseded");
    assert.equal(merged?.decision_by, "LetAgents");
    assert.equal(merged?.decision_reason, `Superseded: ${task.id} moved to merged.`);
    assert.ok(merged?.decided_at);
    assert.equal(await statusOf(doneIntent.id), "pending");

    // A person pressed Mark Done.
    await updateTask(room.id, task.id, { status: "done" });
    assert.equal(await statusOf(doneIntent.id), "superseded");
    assert.equal(await statusOf(reopenIntent.id), "pending", "reopening a done task is still a real request");
    assert.equal(await countBoardIntents({ room_id: room.id, status: "pending" }), 1);

    const governance = await getBoardGovernanceSnapshot({ room_id: room.id, is_admin: true });
    assert.equal(governance.pending_intent_count, 1);
    assert.deepEqual(governance.pending_intents.map((intent) => intent.id), [reopenIntent.id]);
    const auditEntry = governance.audit.find((entry) => entry.id === mergeIntent.id);
    assert.equal(auditEntry?.event_type, "board_intent_superseded");
    assert.equal(auditEntry?.actor_label, "LetAgents");
    assert.equal(auditEntry?.reason, `Superseded: ${task.id} moved to merged.`);

    await updateTask(room.id, task.id, { status: "accepted" });
    assert.equal(await statusOf(reopenIntent.id), "superseded");
  },
);

test(
  "approvals are bound to the task as approved, and lease intents to their lease",
  databaseTestOptions,
  async () => {
    const {
      applyTaskWorkLeaseAction,
      approveBoardIntent,
      createBoardIntent,
      createProjectWithName,
      createTask,
      createTaskLease,
      getBoardIntent,
      updateTask,
    } = dbApi;
    if (
      !applyTaskWorkLeaseAction ||
      !approveBoardIntent ||
      !createBoardIntent ||
      !createProjectWithName ||
      !createTask ||
      !createTaskLease ||
      !getBoardIntent ||
      !updateTask
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-bound-approvals");
    const task = await createTask(room.id, "Draw the grid", "EmmyMay");
    const intentFor = (action_type: "task_close" | "task_override", payload: Record<string, unknown>) =>
      createBoardIntent({ room_id: room.id, action_type, task_id: task.id, payload: { task_id: task.id, ...payload } });
    const closePayload = (status: string) => ({ status, assignee: null, assignee_agent_key: null, pr_url: null });
    const approve = async (intentId: string) =>
      assert.ok(await approveBoardIntent({ room_id: room.id, intent_id: intentId, decision_by: "SparrowOtter" }));
    const intent = (intentId: string) => getBoardIntent({ room_id: room.id, intent_id: intentId });

    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned", assignee: "CopperRidge", assignee_agent_key: "EmmyMay/copperridge" });
    const lease = await createTaskLease({
      room_id: room.id, task_id: task.id, kind: "work", agent_key: "EmmyMay/copperridge",
      actor_label: "CopperRidge", created_by: "CopperRidge",
    });
    await updateTask(room.id, task.id, { status: "in_progress" });
    await updateTask(room.id, task.id, { status: "in_review" });

    // Approved while in review; a person then sends the work back.
    const approvedDone = await intentFor("task_close", closePayload("done"));
    await approve(approvedDone.id);
    await updateTask(room.id, task.id, { status: "in_progress" });
    const retired = await intent(approvedDone.id);
    assert.equal(retired?.status, "superseded", "an approval cannot be used after the task changed");
    assert.equal(retired?.decision_by, "LetAgents");
    assert.equal(retired?.decision_reason, `Superseded: ${task.id} moved to in_progress after SparrowOtter approved it.`);

    const releaseIntent = await intentFor("task_override", {
      action: "release", lease_id: lease.id, target_actor_key: null, target_agent_session_id: null,
    });
    const approvedCancel = await intentFor("task_close", closePayload("cancelled"));
    await approve(approvedCancel.id);
    const releaseResult = await applyTaskWorkLeaseAction({
      room_id: room.id, task_id: task.id, active_lease_id: lease.id, disposition_status: "released",
      task_updates: { status: "accepted", assignee: null, assignee_agent_key: null },
    });
    assert.equal(releaseResult.conflict, null);
    assert.equal((await intent(releaseIntent.id))?.status, "superseded", "the lease it names is gone");
    assert.equal((await intent(approvedCancel.id))?.status, "superseded", "the lease action changed the task");

    // A cancel request cannot apply to a merged task without a reopen first.
    await updateTask(room.id, task.id, { status: "assigned", assignee: "CopperRidge", assignee_agent_key: "EmmyMay/copperridge" });
    await updateTask(room.id, task.id, { status: "in_review" });
    const pendingCancel = await intentFor("task_close", closePayload("cancelled"));
    await updateTask(room.id, task.id, { status: "merged" });
    assert.equal((await intent(pendingCancel.id))?.status, "superseded");
  },
);
