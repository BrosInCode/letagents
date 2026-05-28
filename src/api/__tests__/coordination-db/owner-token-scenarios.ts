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
  "owner-token task mutations require the active coordination lease before publication",
  databaseTestOptions,
  async (t) => {
    const {
      createOwnerToken,
      createProjectWithName,
      createTask,
      createTaskLock,
      getActiveTaskLeases,
      updateTask,
      upsertAccount,
    } = dbApi;
    if (
      !createOwnerToken ||
      !createProjectWithName ||
      !createTask ||
      !createTaskLock ||
      !getActiveTaskLeases ||
      !updateTask ||
      !upsertAccount
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({
      githubUserId: "42",
      token: "coordination-route-owner-token",
    });
    const otherOwner = await upsertAccount({
      provider: "github",
      provider_user_id: "84",
      login: "OtherOwner",
      display_name: "Other Owner",
    });
    const otherOwnerToken = "coordination-route-other-owner-token";
    await createOwnerToken({
      accountId: otherOwner.id,
      githubUserId: otherOwner.provider_user_id,
      token: otherOwnerToken,
      providerAccessToken: "other-github-token",
    });

    const room = await createProjectWithName("coordination-api-routes");
    const { bayCredentials, dawnCredentials } = await createWorkerPair({
      roomId: room.id,
      ownerAccountId: owner.id,
      ownerLabel,
    });
    const task = await createTask(room.id, "Publish only with the work lease", "Human");
    await updateTask(room.id, task.id, { status: "accepted" });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });
    const { createTaskViaRoute, patchTask } = buildTaskRouteClient({
      port,
      roomId: room.id,
      ownerToken,
    });

    const claim = await patchTask(task.id, {
      status: "assigned",
      assignee: bayActor.actor_label,
      assignee_agent_key: bayActor.actor_key,
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(claim.status, 200);

    const activeLeases = await getActiveTaskLeases(room.id, task.id);
    assert.equal(activeLeases.length, 1);
    assert.equal(activeLeases[0]?.agent_key, bayActor.actor_key);
    assert.equal(activeLeases[0]?.output_intent, task.title);

    const spoofedPublish = await patchTask(
      task.id,
      {
        pr_url: "https://github.com/BrosInCode/letagents/pull/998",
        ...bayActor,
        ...bayCredentials,
      },
      otherOwnerToken,
    );
    assert.equal(spoofedPublish.status, 401);
    assert.equal((await spoofedPublish.json()).error, "Invalid agent session credentials.");

    const duplicateAdmission = await createTaskViaRoute({
      title: task.title,
      created_by: dawnActor.actor_label,
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(duplicateAdmission.status, 409);
    assert.equal((await duplicateAdmission.json()).code, "coordination_duplicate_work");

    const dawnPublish = await patchTask(task.id, {
      pr_url: "https://github.com/BrosInCode/letagents/pull/999",
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(dawnPublish.status, 409);
    assert.equal((await dawnPublish.json()).code, "coordination_wrong_actor");

    const unclaimedTask = await createTask(room.id, "Leaseless publication is blocked", "Human");
    await updateTask(room.id, unclaimedTask.id, { status: "accepted" });

    const leaselessPublish = await patchTask(unclaimedTask.id, {
      pr_url: "https://github.com/BrosInCode/letagents/pull/1000",
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(leaselessPublish.status, 409);
    assert.equal((await leaselessPublish.json()).code, "coordination_missing_lease");

    await createTaskLock({
      room_id: room.id,
      task_id: task.id,
      scope: "task",
      reason: "human_stop",
      created_by: "Human",
      message: "Human asked the worker to stop.",
    });

    const lockedMove = await patchTask(task.id, {
      status: "in_progress",
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(lockedMove.status, 409);
    assert.equal((await lockedMove.json()).code, "coordination_active_lock");

    await createTaskLock({
      room_id: room.id,
      scope: "room",
      reason: "manager_pause",
      created_by: "Human",
      message: "Pause all agent task admission.",
    });

    const blockedAdmission = await createTaskViaRoute({
      title: "Admission should wait",
      created_by: bayActor.actor_label,
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(blockedAdmission.status, 409);
    assert.equal((await blockedAdmission.json()).code, "coordination_active_lock");
  },
);
