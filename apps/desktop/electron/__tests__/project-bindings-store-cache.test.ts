import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import "./isolated-home.js";
import {
  bindProjectRoot,
  listProjectBindings,
  projectBindingValidationCountsForTest,
  resetProjectBindingsStoreCachesForTest,
} from "../main/project-bindings-store.js";

/** Put a counting `git` first on PATH; returns a reader for the spawn count. */
function countGitSpawns(directory: string): { count: () => number; restore: () => void } {
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(directory, "bin");
  const log = join(directory, "git-spawns.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  return {
    count: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
    restore: () => { process.env.PATH = previousPath; },
  };
}

test("validated bindings are reused until the folder, Git metadata, or stored row changes", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-cache-"));
  const rootPath = join(temporary, "checkout");
  const storePath = join(temporary, "bindings.sqlite");
  mkdirSync(rootPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: rootPath });
  let namespaceCalls = 0;
  const storeOptions = {
    storePath,
    resolveFilesystemNamespace: async (path: string) => {
      namespaceCalls += 1;
      return path.endsWith(".git") ? "test-git-volume" : "test-root-volume";
    },
  };
  resetProjectBindingsStoreCachesForTest();
  const git = countGitSpawns(temporary);
  try {
    const binding = await bindProjectRoot({
      context: { roomIdentifier: "github.com/acme/widgets", gitRoom: null },
      rootPath,
      source: "git_remote",
    }, storeOptions);
    const counts = projectBindingValidationCountsForTest;
    const spawnsAt = () => git.count();

    let before = spawnsAt();
    assert.deepEqual((await listProjectBindings(storeOptions)).map((item) => item.id), [binding.id]);
    const fullSpawns = spawnsAt() - before;
    t.diagnostic(`git spawns per full validation of one binding: ${fullSpawns}`);
    assert.ok(fullSpawns >= 4, `a full validation spawns git several times (${fullSpawns})`);

    // Before this memo: every list (window focus, room change) repeated all of it.
    before = spawnsAt();
    const memoBefore = counts.memo;
    const namespacesBefore = namespaceCalls;
    for (let index = 0; index < 5; index += 1) {
      assert.deepEqual((await listProjectBindings(storeOptions)).map((item) => item.id), [binding.id]);
    }
    assert.equal(spawnsAt() - before, 0, "five unchanged lists spawn no git");
    assert.equal(namespaceCalls - namespacesBefore, 0, "and resolve no filesystem namespace");
    assert.equal(counts.memo - memoBefore, 5);

    // HEAD moves: the derived room may change, so validate in full again.
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/feature"], { cwd: rootPath });
    let full = counts.full;
    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    assert.equal(counts.full - full, 1, "a HEAD change re-validates");

    // The remote changes: config changes, the binding no longer proves the room.
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:other/repo.git"], { cwd: rootPath });
    full = counts.full;
    assert.deepEqual(await listProjectBindings(storeOptions), [], "a different remote fails closed at once");
    assert.equal(counts.full - full, 1);
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/widgets.git"], { cwd: rootPath });
    assert.equal((await listProjectBindings(storeOptions)).length, 1);

    // The folder is swapped for another repository at the same path.
    renameSync(rootPath, join(temporary, "moved"));
    mkdirSync(rootPath);
    execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: rootPath });
    full = counts.full;
    assert.deepEqual(await listProjectBindings(storeOptions), [], "a swapped folder fails closed at once");
    assert.equal(counts.full - full, 1);
    rmSync(rootPath, { recursive: true, force: true });
    renameSync(join(temporary, "moved"), rootPath);
    assert.equal((await listProjectBindings(storeOptions)).length, 1, "the original folder is accepted again");

    // Another process rewrites the row: the memo never outlives its row.
    const database = new DatabaseSync(storePath);
    database.prepare("UPDATE project_bindings SET updated_at = ? WHERE id = ?").run(new Date(Date.now() + 1000).toISOString(), binding.id);
    database.close();
    full = counts.full;
    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    assert.equal(counts.full - full, 1, "a changed row re-validates");

    // The store file is replaced: the long-lived connection reopens it.
    rmSync(storePath, { force: true });
    rmSync(`${storePath}-wal`, { force: true });
    rmSync(`${storePath}-shm`, { force: true });
    assert.deepEqual(await listProjectBindings(storeOptions), [], "a deleted store is reopened, not served stale");
  } finally {
    git.restore();
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("validated bindings expire after 45 seconds and plain folders always validate in full", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-cache-ttl-"));
  const repoPath = join(temporary, "repo");
  const folderPath = join(temporary, "folder");
  const storePath = join(temporary, "bindings.sqlite");
  mkdirSync(repoPath);
  mkdirSync(folderPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: repoPath });
  const storeOptions = { storePath, resolveFilesystemNamespace: async () => "test-volume" };
  resetProjectBindingsStoreCachesForTest();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    await bindProjectRoot({
      context: { roomIdentifier: "github.com/acme/widgets", gitRoom: null },
      rootPath: repoPath,
      source: "git_remote",
    }, storeOptions);
    const { resolveRoomIdentifierFromPath } = await import("../repo-status.js");
    const plain = await resolveRoomIdentifierFromPath(folderPath, { ignoreConfiguredRoom: true });
    await bindProjectRoot({
      context: { roomIdentifier: plain.roomIdentifier, gitRoom: null },
      rootPath: folderPath,
      source: "local_folder",
    }, storeOptions);
    const counts = projectBindingValidationCountsForTest;
    assert.equal((await listProjectBindings(storeOptions)).length, 2);
    let full = counts.full;
    assert.equal((await listProjectBindings(storeOptions)).length, 2);
    assert.equal(counts.full - full, 1, "only the plain folder validates in full");
    now += 46_000;
    full = counts.full;
    assert.equal((await listProjectBindings(storeOptions)).length, 2);
    assert.equal(counts.full - full, 2, "an expired memo validates in full");
  } finally {
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});
