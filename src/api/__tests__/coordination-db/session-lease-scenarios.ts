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
  "session participants cannot spoof lease-holder release and terminal lease cleanup does not reopen tasks",
  databaseTestOptions,
  async (t) => {
    const {
      assignProjectAdmin,
      createProjectWithName,
      createSession,
      createTask,
      getActiveTaskLeases,
      updateTask,
      upsertAccount,
    } = dbApi;
    if (
      !assignProjectAdmin ||
      !createProjectWithName ||
      !createSession ||
      !createTask ||
      !getActiveTaskLeases ||
      !updateTask ||
      !upsertAccount
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({
      githubUserId: "242",
      token: "coordination-lease-action-owner-token-2",
    });
    const participant = await upsertAccount({
      provider: "github",
      provider_user_id: "243",
      login: "ViewerOnly",
      display_name: "Viewer Only",
    });
    const sessionToken = "coordination-lease-action-session-token";
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await createSession(participant.id, sessionToken, expiresAt, "viewer-github-token");

    const room = await createProjectWithName("coordination-lease-actions-session");
    await assignProjectAdmin(room.id, owner.id);
    const { bayCredentials, dawnCredentials } = await createWorkerPair({
      roomId: room.id,
      ownerAccountId: owner.id,
      ownerLabel,
    });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });
    const { leaseAction, patchTask } = buildTaskRouteClient({
      port,
      roomId: room.id,
      ownerToken,
    });

    const activeTask = await createTask(room.id, "Spoofed release should fail", "Human");
    await updateTask(room.id, activeTask.id, { status: "accepted" });
    const claimByBay = await patchTask(activeTask.id, {
      status: "assigned",
      assignee: bayActor.actor_label,
      assignee_agent_key: bayActor.actor_key,
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(claimByBay.status, 200);

    const spoofedRelease = await leaseAction(
      activeTask.id,
      {
        action: "release",
        actor_label: bayActor.actor_label,
        actor_key: bayActor.actor_key,
      },
      { sessionToken },
    );
    assert.equal(spoofedRelease.status, 403);
    assert.equal((await spoofedRelease.json()).error, "Admin privileges required");

    const stillActiveLeases = await getActiveTaskLeases(room.id, activeTask.id);
    assert.equal(stillActiveLeases.length, 1);
    assert.equal(stillActiveLeases[0]?.agent_key, bayActor.actor_key);

    const mergedTask = await createTask(room.id, "Merged task lease cleanup", "Human");
    await updateTask(room.id, mergedTask.id, { status: "accepted" });
    const mergedClaim = await patchTask(mergedTask.id, {
      status: "assigned",
      assignee: bayActor.actor_label,
      assignee_agent_key: bayActor.actor_key,
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(mergedClaim.status, 200);
    const mergedReview = await patchTask(mergedTask.id, {
      status: "in_review",
      ...bayActor,
      ...bayCredentials,
    });
    assert.equal(mergedReview.status, 200);
    const mergedState = await updateTask(room.id, mergedTask.id, { status: "merged" });
    assert.equal(mergedState?.status, "merged");

    const mergedHandoff = await leaseAction(mergedTask.id, {
      action: "handoff",
      target_actor_key: dawnActor.actor_key,
      reason: "This should not reassign merged work.",
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(mergedHandoff.status, 409);
    assert.equal((await mergedHandoff.json()).code, "coordination_invalid_task_status");

    const mergedRelease = await leaseAction(mergedTask.id, {
      action: "release",
      reason: "Clean up the stale merged lease without reopening.",
      ...dawnActor,
      ...dawnCredentials,
    });
    assert.equal(mergedRelease.status, 200);
    const mergedReleaseBody = await mergedRelease.json();
    assert.equal(mergedReleaseBody.task.status, "merged");
    assert.equal(mergedReleaseBody.released_lease.status, "revoked");
  },
);
