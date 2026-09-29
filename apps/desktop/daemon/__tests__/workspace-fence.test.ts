import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { acquireWorkspaceFence, type WorkspaceFenceHandle } from "../workspace-fence.js";

test("workspace fence acquisition tolerates a live mutation lock beyond one scheduler burst", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-workspace-fence-contention-"));
  const workspacePath = join(root, "worktrees", "repository", "attempt");
  const fenceDirectory = join(
    dirname(resolve(workspacePath)),
    ".letagents-supervisor-workspace.fences",
  );
  const mutationLock = join(fenceDirectory, ".mutation.lock");
  let acquired: WorkspaceFenceHandle | null = null;
  let releaseContendedLock: Promise<void> | null = null;
  try {
    await mkdir(fenceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(mutationLock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    releaseContendedLock = new Promise<void>((resolveRelease, rejectRelease) => {
      setTimeout(() => {
        void rm(mutationLock, { force: true }).then(resolveRelease, rejectRelease);
      }, 150);
    });

    const startedAt = Date.now();
    acquired = await acquireWorkspaceFence(
      workspacePath,
      "waiting-supervisor",
      1,
      "shared",
    );
    assert.ok(Date.now() - startedAt >= 100, "acquisition must wait for the live lock owner");
  } finally {
    await releaseContendedLock?.catch(() => undefined);
    await acquired?.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
