import assert from "node:assert/strict";
import test from "node:test";

import {
  bayActor,
  buildTaskRouteClient,
  createOwnerAuth,
  createWorkerPair,
  databaseTestOptions,
  dbApi,
  dawnActor,
  pool,
  startApiServer,
  stopChildProcess,
} from "./harness.js";

test(
  "room task lease actions can force-release stale work and hand off an active lane",
  databaseTestOptions,
  async (t) => {
    const {
      assignProjectAdmin,
      createProjectWithName,
      createTask,
      createTaskLock,
      getActiveTaskLeases,
      updateTask,
    } = dbApi;
    if (
      !assignProjectAdmin ||
      !createProjectWithName ||
      !createTask ||
      !createTaskLock ||
      !getActiveTaskLeases ||
      !updateTask
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({
      githubUserId: "142",
      token: "coordination-lease-action-owner-token",
    });
    const room = await createProjectWithName("coordination-lease-actions");
    await assignProjectAdmin(room.id, owner.id);
    const { bayCredentials, dawnCredentials } = await createWorkerPair({
      roomId: room.id,
      ownerAccountId: owner.id,
      ownerLabel,
    });
    const task = await createTask(room.id, "Recover a stale lease", "Human");
    await updateTask(room.id, task.id, { status: "accepted" });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });
    const { leaseAction, patchTask } = buildTaskRouteClient({
      port,
      roomId: room.id,
      ownerToken,
    });

    const claimByBay = await patchTask(task.id, {
      status: "assigned",
      assignee: bayActor.actor_label,
      assignee_agent_key: bayActor.actor_key,
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(claimByBay.status, 200);

    const forcedRelease = await leaseAction(task.id, {
      action: "release",
      reason: "BayOtter worker is gone; clear the stale lane.",
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(forcedRelease.status, 200);
    const forcedReleaseBody = await forcedRelease.json();
    assert.equal(forcedReleaseBody.action, "release");
    assert.equal(forcedReleaseBody.task.status, "accepted");
    assert.equal(forcedReleaseBody.task.assignee, null);
    assert.equal(forcedReleaseBody.task.assignee_agent_key, null);
    assert.equal(forcedReleaseBody.released_lease.status, "revoked");

    const releasedActiveLeases = await getActiveTaskLeases(room.id, task.id);
    assert.equal(releasedActiveLeases.length, 0);

    const claimByDawn = await patchTask(task.id, {
      status: "assigned",
      assignee: dawnActor.actor_label,
      assignee_agent_key: dawnActor.actor_key,
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(claimByDawn.status, 200);
    const boundPrUrl = "https://github.com/BrosInCode/letagents/pull/1200";
    const bindPr = await patchTask(task.id, {
      pr_url: boundPrUrl,
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(bindPr.status, 200);

    const handoff = await leaseAction(task.id, {
      action: "handoff",
      reason: "Return the lane to BayOtter on a fresh lease.",
      target_actor_key: bayActor.actor_key,
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(handoff.status, 200);
    const handoffBody = await handoff.json();
    assert.equal(handoffBody.action, "handoff");
    assert.equal(handoffBody.task.status, "assigned");
    assert.equal(handoffBody.task.assignee, bayActor.actor_label);
    assert.equal(handoffBody.task.assignee_agent_key, bayActor.actor_key);
    assert.equal(handoffBody.released_lease.status, "released");
    assert.equal(handoffBody.new_lease.agent_key, bayActor.actor_key);
    assert.equal(handoffBody.new_lease.pr_url, boundPrUrl);
    assert.equal(handoffBody.new_lease.branch_ref, handoffBody.released_lease.branch_ref);

    const activeLeases = await getActiveTaskLeases(room.id, task.id);
    assert.equal(activeLeases.length, 1);
    assert.equal(activeLeases[0]?.agent_key, bayActor.actor_key);
    assert.equal(activeLeases[0]?.pr_url, boundPrUrl);

    const lockedTask = await createTask(room.id, "Locked handoff should fail", "Human");
    await updateTask(room.id, lockedTask.id, { status: "accepted" });
    const lockedClaim = await patchTask(lockedTask.id, {
      status: "assigned",
      assignee: dawnActor.actor_label,
      assignee_agent_key: dawnActor.actor_key,
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(lockedClaim.status, 200);
    await createTaskLock({
      room_id: room.id,
      task_id: lockedTask.id,
      scope: "task",
      reason: "human_stop",
      created_by: "Human",
      message: "Worker should not be handed off while stopped.",
    });
    const lockedHandoff = await leaseAction(lockedTask.id, {
      action: "handoff",
      reason: "Attempting to bypass the stop lock.",
      target_actor_key: bayActor.actor_key,
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(lockedHandoff.status, 409);
    assert.equal((await lockedHandoff.json()).code, "coordination_active_lock");
  },
);

for (const managerMode of ["off", "manager_optional", "intent_required"] as const) {
  test(`an approved worker handoff transfers retired ownership once in ${managerMode} mode`, databaseTestOptions, async (t) => {
    const api = await import("../../db.js");
    const { boardIntentPayloadForLeaseAction } = await import("../../board-intent-payloads.js");
    const { hashToken } = await import("../../db/utils.js");
    const previousBearerFlag = process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED;
    process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";
    t.after(() => {
      if (previousBearerFlag === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED;
      else process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = previousBearerFlag;
    });
    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({
      githubUserId: "approved-handoff", token: "approved-handoff-owner-token",
    });
    const room = await api.createProjectWithName("approved-worker-handoff");
    await api.assignProjectAdmin(room.id, owner.id);
    await api.setRoomBoardManagerMode({ room_id: room.id, manager_mode: managerMode, updated_by: "Human" });
    const makeWorker = async (actor: typeof bayActor) => {
      const session = await api.createRoomAgentSession({
        room_id: room.id, session_kind: "worker", runtime: "codex",
        actor_label: actor.actor_label, agent_key: actor.actor_key,
        agent_instance_id: actor.actor_instance_id, display_name: actor.display_name,
        owner_account_id: owner.id, owner_label: ownerLabel, ide_label: "Agent",
      });
      await api.markRoomAgentDeliveryConnected({
        room_id: room.id, actor_label: session.actor_label, agent_key: session.agent_key,
        agent_instance_id: session.agent_instance_id, agent_session_id: session.session_id,
        session_kind: "worker", runtime: session.runtime, display_name: session.display_name,
        owner_label: session.owner_label, ide_label: session.ide_label,
        credential_fence: { kind: "session_token", token_hash: hashToken(session.session_token) },
        transport: "long_poll",
      });
      assert.ok(session.worker_bearer);
      return session;
    };
    const predecessor = await makeWorker(bayActor);
    const replacement = await makeWorker(dawnActor);
    const task = await api.createTask(room.id, "Continue a retired worker's task", "Human");
    await api.updateTask(room.id, task.id, { status: "accepted" });
    await api.updateTask(room.id, task.id, {
      status: "assigned", assignee: predecessor.actor_label, assignee_agent_key: predecessor.agent_key,
    });
    await api.updateTask(room.id, task.id, { status: "in_progress" });
    await api.updateTask(room.id, task.id, { status: "blocked" });
    const lease = await api.createTaskLease({
      room_id: room.id, task_id: task.id, kind: "work", agent_key: predecessor.agent_key,
      agent_instance_id: predecessor.agent_instance_id, agent_session_id: predecessor.session_id,
      actor_label: predecessor.actor_label, created_by: predecessor.actor_label,
      branch_ref: "feature/preserved-work", pr_url: "https://github.com/example/fixture/pull/1",
    });
    const payload = boardIntentPayloadForLeaseAction({
      taskId: task.id, action: "handoff", leaseId: lease.id, targetActorKey: replacement.agent_key,
    });
    const intent = await api.createBoardIntent({
      room_id: room.id, task_id: task.id, action_type: "task_override", payload,
      proposer_actor_key: replacement.agent_key, proposer_actor_label: replacement.actor_label,
      proposer_agent_session_id: replacement.session_id, proposer_worker_auth_kind: "bearer",
    });
    const { child, port } = await startApiServer();
    t.after(() => stopChildProcess(child));
    const { leaseAction } = buildTaskRouteClient({ port, roomId: room.id, ownerToken });
    const request = (body: Record<string, unknown>, bearer = replacement.worker_bearer!) =>
      leaseAction(task.id, body, { bearerToken: bearer });
    const unchanged = async () => {
      const leases = await api.getActiveTaskLeases(room.id, task.id);
      assert.deepEqual(leases.map((row) => [row.id, row.agent_session_id, row.epoch]),
        [[lease.id, predecessor.session_id, lease.epoch]]);
      assert.equal((await api.getTaskById(room.id, task.id))?.status, "blocked");
    };
    const denialCodes: Array<{ actual: string | undefined; expected: string }> = [];
    const denied = async (body: Record<string, unknown>, code?: string, bearer?: string) => {
      const response = await request(body, bearer);
      assert.ok(response.status === 403 || response.status === 409, await response.clone().text());
      if (code) denialCodes.push({ actual: (await response.json()).code, expected: code });
      await unchanged();
    };
    // Approval is required even without an active Board Manager.
    await denied(payload);
    await denied({ ...payload, board_intent_id: intent.id });
    const approved = await api.approveBoardIntent({ room_id: room.id, intent_id: intent.id, decision_by: "Human" });
    assert.ok(approved);
    const approvedRequest = { ...payload, board_intent_id: intent.id };
    await denied({ ...approvedRequest, lease_id: "tl_stale" }, "coordination_stale_lease_reference");
    // Even possession of the legacy approval token cannot replace worker identity.
    await denied({ ...approvedRequest, board_approval_token: approved.approval_token },
      "board_intent_worker_mismatch", predecessor.worker_bearer!);
    await pool!.query("UPDATE board_intents SET proposer_agent_session_id = $1 WHERE id = $2", [predecessor.session_id, intent.id]);
    await denied({ ...approvedRequest, board_approval_token: approved.approval_token }, "board_intent_worker_mismatch");
    await pool!.query("UPDATE board_intents SET proposer_agent_session_id = $1 WHERE id = $2", [replacement.session_id, intent.id]);
    await denied({ ...approvedRequest, target_actor_key: predecessor.agent_key }, "board_intent_payload_mismatch");
    await denied({ ...approvedRequest, target_agent_session_id: replacement.session_id }, "board_intent_payload_mismatch");
    await denied({ ...approvedRequest, action: "release" });
    const wrongRoom = await api.createProjectWithName("wrong-handoff-approval-room");
    const wrongRoomIntent = await api.createBoardIntent({
      room_id: wrongRoom.id, action_type: "task_override", payload,
      proposer_actor_key: replacement.agent_key, proposer_agent_session_id: replacement.session_id,
    });
    await api.approveBoardIntent({ room_id: wrongRoom.id, intent_id: wrongRoomIntent.id, decision_by: "Human" });
    await denied({ ...approvedRequest, board_intent_id: wrongRoomIntent.id }, "board_intent_not_found");
    await pool!.query("UPDATE board_intents SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [intent.id]);
    await denied(approvedRequest, "board_intent_expired");
    await pool!.query("UPDATE board_intents SET expires_at = NOW() + INTERVAL '10 minutes' WHERE id = $1", [intent.id]);
    await api.endRoomAgentSession({ session_id: predecessor.session_id });
    // Human approval must work for the requesting replacement, with no owner token.
    const response = await request(approvedRequest);
    assert.equal(response.status, 200, await response.clone().text());
    for (const code of denialCodes) assert.equal(code.actual, code.expected);
    const result = await response.json();
    assert.equal(result.released_lease.id, lease.id);
    assert.equal(result.released_lease.status, "revoked");
    assert.equal(result.new_lease.agent_session_id, replacement.session_id);
    assert.equal(result.new_lease.branch_ref, lease.branch_ref);
    assert.equal(result.new_lease.pr_url, lease.pr_url);
    assert.equal(result.task.assignee_agent_key, replacement.agent_key);
    assert.equal(result.task.status, "assigned");
    const rows = await pool!.query("SELECT status FROM board_intents WHERE id = $1", [intent.id]);
    assert.equal(rows.rows[0].status, "used");
    const replay = await request(approvedRequest);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "coordination_stale_lease_reference");
    const leases = await api.getActiveTaskLeases(room.id, task.id);
    assert.equal(leases.length, 1);
    assert.equal(leases[0]?.id, result.new_lease.id);
  });
}
