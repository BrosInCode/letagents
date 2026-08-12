import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkDurabilityStore } from "../durability-store.js";
import {
  EphemeralWorkspaceProvisioner,
  isEphemeralWorkspaceMarker,
} from "../ephemeral-workspace-provisioner.js";

test("room-only work attempts conclude and purge without invoking Git", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-rental-ephemeral-")));
  const workAttemptId = "d4cae1d6-3e7d-46f7-a176-4323eb80ff92";
  let gitCalls = 0;
  const store = new WorkDurabilityStore(
    join(root, "attempts.json"),
    join(root, "attempt-data"),
    () => "2026-08-09T12:00:00.000Z",
    join(root, "worktrees"),
    undefined,
    async () => {
      gitCalls += 1;
      throw new Error("Git must not run for an ephemeral workspace");
    },
    undefined,
    { supervisor_id: "rental-test", supervisor_generation: 1 },
  );

  try {
    const workspace = await new EphemeralWorkspaceProvisioner(root).provision({
      workAttemptId,
      taskId: "supervised_rental_test",
    });
    assert.equal(workspace.reused, false);
    assert.equal(isEphemeralWorkspaceMarker(workspace.identity), true);

    const attempt = await store.createAttempt({
      taskId: "supervised_rental_test",
      leaseId: "supervised_rental_test",
      leaseEpoch: 0,
      workspacePath: workspace.path,
      workAttemptId,
    });
    const concluded = await store.concludeAttempt(attempt.work_attempt_id, {
      state: "cleanly_concluded",
      cause: "rental_completed",
    });
    assert.match(concluded.postmortem_diff ?? "", /non-Git ephemeral workspace/);
    assert.equal(gitCalls, 0);
    assert.equal(await store.garbageCollectEphemeralAttempt(workAttemptId), true);
    await assert.rejects(stat(workspace.path), { code: "ENOENT" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup orphan collection removes only untracked room-only workspaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-rental-orphans-")));
  const provisioner = new EphemeralWorkspaceProvisioner(root);
  const retainedId = "3fd5aa70-1bf6-42ac-8c15-8af8509b1e88";
  const orphanId = "a94b918f-5652-4074-b4f5-39a8fe1782fa";
  const emptyCrashId = "61bb15a3-baa2-43cc-a92e-bfa27ead88c5";
  const unsafeId = "3a90cc2d-b4bb-450d-b333-cdb6cb450ba4";
  try {
    const retained = await provisioner.provision({ workAttemptId: retainedId, taskId: "retained" });
    const orphan = await provisioner.provision({ workAttemptId: orphanId, taskId: "orphan" });
    const roomOnlyRoot = join(root, "worktrees", "room-only");
    const emptyCrash = join(roomOnlyRoot, emptyCrashId);
    const unsafe = join(roomOnlyRoot, unsafeId);
    await mkdir(emptyCrash, { mode: 0o700 });
    await mkdir(unsafe, { mode: 0o700 });
    await writeFile(join(unsafe, "unknown.txt"), "do not delete\n");

    const removed = await provisioner.garbageCollectOrphans(new Set([retainedId]));

    assert.deepEqual(new Set(removed), new Set([orphanId, emptyCrashId]));
    assert.equal((await stat(retained.path)).isDirectory(), true);
    await assert.rejects(stat(orphan.path), { code: "ENOENT" });
    await assert.rejects(stat(emptyCrash), { code: "ENOENT" });
    assert.equal((await stat(unsafe)).isDirectory(), true, "unknown contents fail closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
