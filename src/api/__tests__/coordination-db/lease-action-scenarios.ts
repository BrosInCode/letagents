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
