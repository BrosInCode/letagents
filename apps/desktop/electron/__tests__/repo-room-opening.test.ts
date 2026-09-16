import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-room-opening-",
  paths: [],
  extraEnvFiles: { LETAGENTS_PROJECT_BINDINGS_PATH: "bindings.sqlite" },
});

test("opening a fetched repo room preserves its identity without calculating branch statistics", async (t) => {
  const repoPath = realpathSync(env.tempDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  git("init", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/project.git");
  writeFileSync(join(repoPath, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");
  git("checkout", "-b", "feature/room");

  let fetchedSnapshot: unknown;
  t.mock.module("electron", { defaultExport: {} });
  t.mock.module("../main/window.js", { namedExports: { focusMainWindow() {} } });
  t.mock.module("../main/rooms/snapshot.js", {
    namedExports: {
      fetchRoomSnapshot: async (roomIdentifier: string) => {
        fetchedSnapshot = { roomIdentifier, access: { status: "ready" }, room: { gitRoom: null } };
        return fetchedSnapshot;
      },
    },
  });
  const unused = () => { throw new Error("Unexpected room storage mutation"); };
  t.mock.module("../main/rooms/local-store.js", {
    namedExports: {
      resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: "cloud" }),
      cloudRoomIdentifierForStorage: unused,
      createLocalRoom: unused,
      localRoomIdentifierForStorage: unused,
      setLocalAwareRoomStorageMode: unused,
      updateLocalRoomDisplayName: unused,
    },
  });
  const { openRepoRoomFromPath } = await import("../main/rooms/repo.js");
  const tracePath = join(repoPath, ".git", "room-opening-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    process.env.GIT_TRACE2_EVENT = tracePath;
    const opened = await openRepoRoomFromPath(repoPath);
    assert.strictEqual(opened.snapshot, fetchedSnapshot);
    assert.equal(opened.error, null);
    assert.equal(opened.repoPath, repoPath);
    assert.equal(opened.repoStatus?.branch, "feature/room");
    assert.equal(opened.repoStatus?.roomIdentifier, opened.roomIdentifier);
    assert.ok(opened.projectBinding?.aliases.includes(`room:${opened.roomIdentifier?.toLowerCase()}`));
    assert.equal(opened.repoStatus?.branchDelta, null);
    assert.deepEqual(opened.repoStatus?.branchDeltas, []);

    const commands = readFileSync(tracePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "start")
      .map((event) => event.argv as string[]);
    assert.equal(commands.some((argv) => argv.includes("diff")), false,
      "room opening must not wait for branch comparisons after fetching its snapshot");
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }
});
