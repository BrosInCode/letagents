import assert from "node:assert/strict";
import test from "node:test";

import {
  createOwnerAuth,
  createWorkerPair,
  databaseTestOptions,
  dbApi,
  startApiServer,
  stopChildProcess,
} from "./harness.js";

test(
  "a re-review verdict is accepted while requested changes block the task",
  databaseTestOptions,
  async (t) => {
    const { createProjectWithName, createTask, updateTask } = dbApi;
    if (!createProjectWithName || !createTask || !updateTask) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({
      githubUserId: "42",
      token: "coordination-verdict-owner-token",
    });
    const room = await createProjectWithName("coordination-review-verdict");
    const { dawnCredentials } = await createWorkerPair({ roomId: room.id, ownerAccountId: owner.id, ownerLabel });
    const task = await createTask(room.id, "Page shell", "Human");
    for (const status of ["accepted", "assigned", "in_progress", "in_review", "blocked"] as const) {
      await updateTask(room.id, task.id, { status });
    }

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });
    const submitVerdict = () => fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}/tasks/${task.id}/review-verdict`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          verdict: "comment",
          body: "Re-reviewed at the pushed fixes.",
          idempotency_key: `${task.id}:re-review`,
          expected_head_sha: "a".repeat(40),
          ...dawnCredentials,
        }),
      },
    );

    // Blocked by requested changes is still under review: the verdict passes
    // the status check and stops only at the next requirement, a pull request.
    const blocked = await submitVerdict();
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "workflow_effect_pull_request_required");

    await updateTask(room.id, task.id, { status: "in_progress" });
    const inProgress = await submitVerdict();
    assert.equal(inProgress.status, 409);
    const refusal = await inProgress.json();
    assert.equal(refusal.code, "coordination_invalid_task_status");
    assert.match(refusal.error, /in review or blocked; task_\d+ is in_progress/);
  },
);
