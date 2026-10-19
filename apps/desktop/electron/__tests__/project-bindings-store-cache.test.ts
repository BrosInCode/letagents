import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import "./isolated-home.js";
import {
  bindProjectRoot,
  listProjectBindings,
  projectBindingValidationCountsForTest,
  projectBindingsStoreTestHooks,
  resetProjectBindingsStoreCachesForTest,
  setFilesystemNamespaceResolverForTest,
} from "../main/project-bindings-store.js";

function hostedRepo(temporary: string, name = "repo"): string {
  const root = join(temporary, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: root });
  return root;
}

const hostedContext = { roomIdentifier: "github.com/acme/widgets", gitRoom: null };

test("a different volume behind the same device number fails closed once the memo expires", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-volume-"));
  const root = hostedRepo(temporary);
  const storeOptions = { storePath: join(temporary, "bindings.sqlite") };
  resetProjectBindingsStoreCachesForTest();
  // The default (df + diskutil) path, keyed by device number inside a pass.
  let volume = "darwin:aaaaaaaa-0000-0000-0000-000000000000";
  let lookups = 0;
  setFilesystemNamespaceResolverForTest(async () => { lookups += 1; return volume; });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    await bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions);
    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    assert.equal(lookups, 2, "root and .git share one device: one lookup per pass after binding's own");
    // Another APFS image mounted at the same path: same device number, new UUID.
    volume = "darwin:bbbbbbbb-0000-0000-0000-000000000000";
    now += 46_000;
    assert.deepEqual(await listProjectBindings(storeOptions), [], "a changed volume UUID fails closed");
    volume = "darwin:aaaaaaaa-0000-0000-0000-000000000000";
    assert.equal((await listProjectBindings(storeOptions)).length, 1, "the original volume is accepted again");
  } finally {
    setFilesystemNamespaceResolverForTest(null);
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a memo hit still checks the volume: a changed UUID within 45 seconds fails closed", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-volume-memo-"));
  const first = hostedRepo(temporary, "first");
  const second = hostedRepo(temporary, "second");
  const storeOptions = { storePath: join(temporary, "bindings.sqlite") };
  resetProjectBindingsStoreCachesForTest();
  let volume = "darwin:aaaaaaaa-0000-0000-0000-000000000000";
  let lookups = 0;
  setFilesystemNamespaceResolverForTest(async () => { lookups += 1; return volume; });
  const counts = projectBindingValidationCountsForTest;
  try {
    await bindProjectRoot({ context: hostedContext, rootPath: first, source: "git_remote" }, storeOptions);
    await bindProjectRoot({
      context: { roomIdentifier: "github.com/acme/gadgets", gitRoom: null },
      rootPath: second,
      source: "local_git",
    }, storeOptions).catch(() => undefined);
    const bindings = (await listProjectBindings(storeOptions)).length;
    assert.ok(bindings >= 1);
    lookups = 0;
    const memo = counts.memo;
    assert.equal((await listProjectBindings(storeOptions)).length, bindings);
    assert.equal(counts.memo - memo, bindings, "every binding is a memo hit");
    // One device in this pass: one volume lookup (df + diskutil) shared by all bindings.
    assert.equal(lookups, 1, "one volume lookup per device per pass, memo hit or not");

    // Same device number, same inodes, different volume: within the 45 s window.
    volume = "darwin:bbbbbbbb-0000-0000-0000-000000000000";
    const full = counts.full;
    assert.deepEqual(await listProjectBindings(storeOptions), [], "a changed volume UUID fails closed at once");
    assert.equal(counts.full - full, bindings, "the memo entry is dropped and validation runs in full");
    volume = "darwin:aaaaaaaa-0000-0000-0000-000000000000";
    assert.equal((await listProjectBindings(storeOptions)).length, bindings, "the original volume is accepted again");
  } finally {
    setFilesystemNamespaceResolverForTest(null);
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Git config includes and other origin inputs keep the binding from being memoized or reused", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-include-"));
  const root = hostedRepo(temporary);
  const storeOptions = { storePath: join(temporary, "bindings.sqlite"), resolveFilesystemNamespace: async () => "test-volume" };
  resetProjectBindingsStoreCachesForTest();
  const counts = projectBindingValidationCountsForTest;
  try {
    await bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions);
    await listProjectBindings(storeOptions);

    // An included file can rewrite the origin URL with .git/config untouched.
    const extra = join(temporary, "extra.cfg");
    writeFileSync(extra, "[remote \"origin\"]\n\turl = git@github.com:acme/widgets.git\n");
    execFileSync("git", ["config", "include.path", extra], { cwd: root });
    execFileSync("git", ["config", "--unset", "remote.origin.url"], { cwd: root });
    assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim(), "git@github.com:acme/widgets.git");
    await listProjectBindings(storeOptions);
    let full = counts.full;
    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    assert.equal(counts.full - full, 1, "a repository with [include] is never memoized");
    writeFileSync(extra, "[remote \"origin\"]\n\turl = git@github.com:other/repo.git\n");
    assert.deepEqual(await listProjectBindings(storeOptions), [], "an included origin change fails closed at once");
    execFileSync("git", ["config", "--unset", "include.path"], { cwd: root });
    execFileSync("git", ["config", "remote.origin.url", "git@github.com:acme/widgets.git"], { cwd: root });

    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    full = counts.full;
    await listProjectBindings(storeOptions);
    assert.equal(counts.full - full, 0, "without includes the binding is memoized again");
    writeFileSync(join(root, ".git", "commondir"), "../elsewhere\n");
    full = counts.full;
    await listProjectBindings(storeOptions);
    assert.equal(counts.full - full, 1, "a new commondir re-validates");
    rmSync(join(root, ".git", "commondir"));
    await listProjectBindings(storeOptions);
    writeFileSync(join(root, ".git", "config.worktree"), "[core]\n");
    full = counts.full;
    await listProjectBindings(storeOptions);
    assert.equal(counts.full - full, 1, "a config.worktree change re-validates");
  } finally {
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

// Regression cases from review: each changes what `git remote get-url origin`
// returns without touching the files the fingerprint lists. The next pass
// must fail closed.
const goodOrigin = "[remote \"origin\"]\n\turl = git@github.com:acme/widgets.git\n";
const evilOrigin = "[remote \"origin\"]\n\turl = git@github.com:evil/other.git\n";
const coreSection = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";

async function originSwapFailsClosed(
  name: string,
  setup: (temporary: string, root: string) => void,
  attack: (temporary: string, root: string) => void,
): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-origin-"));
  const root = join(temporary, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const storeOptions = { storePath: join(temporary, "bindings.sqlite"), resolveFilesystemNamespace: async () => "test-volume" };
  resetProjectBindingsStoreCachesForTest();
  try {
    setup(temporary, root);
    assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim(), "git@github.com:acme/widgets.git", name);
    await bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions);
    assert.equal((await listProjectBindings(storeOptions)).length, 1, `${name}: accepted before the change`);
    assert.equal((await listProjectBindings(storeOptions)).length, 1, `${name}: still accepted`);
    attack(temporary, root);
    assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim(), "git@github.com:evil/other.git", name);
    assert.deepEqual(await listProjectBindings(storeOptions), [], `${name}: the next pass fails closed`);
  } finally {
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("an include on the same line as another section cannot keep a stale origin", async () => {
  await originSwapFailsClosed("same-line include", (temporary, root) => {
    writeFileSync(join(temporary, "inc"), goodOrigin);
    execFileSync("sh", ["-c", `printf '[core] [include] path = ${join(temporary, "inc")}\\n' >> .git/config`], { cwd: root });
  }, (temporary) => writeFileSync(join(temporary, "inc"), evilOrigin));
});

test("an indented include cannot keep a stale origin", async () => {
  await originSwapFailsClosed("indented include", (temporary, root) => {
    writeFileSync(join(temporary, "inc"), goodOrigin);
    execFileSync("sh", ["-c", `printf '\\t[include]\\n\\tpath = ${join(temporary, "inc")}\\n' >> .git/config`], { cwd: root });
  }, (temporary) => writeFileSync(join(temporary, "inc"), evilOrigin));
});

test("a commondir target edit cannot keep a stale origin", async () => {
  await originSwapFailsClosed("commondir target", (temporary, root) => {
    const other = join(temporary, "other");
    mkdirSync(other);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
    writeFileSync(join(other, ".git", "config"), coreSection + goodOrigin);
    writeFileSync(join(root, ".git", "commondir"), `${join(other, ".git")}\n`);
  }, (temporary) => writeFileSync(join(temporary, "other", ".git", "config"), coreSection + evilOrigin));
});

test("an atomic replace behind a symlinked .git/config cannot keep a stale origin", async () => {
  await originSwapFailsClosed("symlinked config", (temporary, root) => {
    writeFileSync(join(temporary, "real.cfg"), coreSection + goodOrigin);
    rmSync(join(root, ".git", "config"));
    symlinkSync(join(temporary, "real.cfg"), join(root, ".git", "config"));
  }, (temporary) => {
    writeFileSync(join(temporary, "new.cfg"), coreSection + evilOrigin);
    renameSync(join(temporary, "new.cfg"), join(temporary, "real.cfg"));
  });
});

test("an include set through GIT_CONFIG_* variables cannot keep a stale origin", async () => {
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    await originSwapFailsClosed("GIT_CONFIG include", (temporary, root) => {
      execFileSync("git", ["config", "remote.origin.url", "git@github.com:acme/widgets.git"], { cwd: root });
      writeFileSync(join(temporary, "inc"), "");
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "include.path";
      process.env.GIT_CONFIG_VALUE_0 = join(temporary, "inc");
    }, (temporary) => writeFileSync(
      join(temporary, "inc"),
      "[url \"git@github.com:evil/other.git\"]\n\tinsteadOf = git@github.com:acme/widgets.git\n",
    ));
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("a new folder around the same Git directory is caught by the root identity", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-root-"));
  const root = hostedRepo(temporary);
  const storeOptions = { storePath: join(temporary, "bindings.sqlite"), resolveFilesystemNamespace: async () => "test-volume" };
  resetProjectBindingsStoreCachesForTest();
  try {
    await bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions);
    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    renameSync(root, join(temporary, "old"));
    mkdirSync(root);
    renameSync(join(temporary, "old", ".git"), join(root, ".git"));
    assert.deepEqual(await listProjectBindings(storeOptions), [], "the same .git in a new folder fails closed at once");
  } finally {
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a change made while validation runs is never served from the memo", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-race-"));
  const root = hostedRepo(temporary);
  let swapDuringValidation = false;
  let callsThisPass = 0;
  const storeOptions = {
    storePath: join(temporary, "bindings.sqlite"),
    resolveFilesystemNamespace: async () => {
      // Calls 1-2 are the per-pass volume check (before validation);
      // call 3 is the verification-key lookup, after the room was derived.
      if (swapDuringValidation && ++callsThisPass === 3) {
        swapDuringValidation = false;
        // The room was already derived from the old remote; switch it now.
        execFileSync("git", ["remote", "set-url", "origin", "git@github.com:other/repo.git"], { cwd: root });
      }
      return "test-volume";
    },
  };
  resetProjectBindingsStoreCachesForTest();
  try {
    await bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions);
    swapDuringValidation = true;
    assert.equal((await listProjectBindings(storeOptions)).length, 1, "this pass saw the old remote");
    assert.deepEqual(await listProjectBindings(storeOptions), [], "the next pass must see the new remote");
  } finally {
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failed ROLLBACK discards the shared store connection", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-rollback-"));
  const root = hostedRepo(temporary);
  const storePath = join(temporary, "bindings.sqlite");
  const storeOptions = { storePath, resolveFilesystemNamespace: async () => "test-volume" };
  resetProjectBindingsStoreCachesForTest();
  try {
    projectBindingsStoreTestHooks.beforeCommit = (database) => {
      const exec = database.exec.bind(database);
      database.exec = (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("rollback failed");
        exec(sql);
      };
      throw new Error("write failed");
    };
    await assert.rejects(
      bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions),
      /write failed/,
    );
    projectBindingsStoreTestHooks.beforeCommit = undefined;
    // The abandoned transaction held the write lock; a discarded connection releases it.
    const other = new DatabaseSync(storePath);
    other.exec("PRAGMA busy_timeout = 100");
    other.exec("BEGIN IMMEDIATE; ROLLBACK;");
    other.close();
    const binding = await bindProjectRoot({ context: hostedContext, rootPath: root, source: "git_remote" }, storeOptions);
    assert.deepEqual((await listProjectBindings(storeOptions)).map((item) => item.id), [binding.id]);
  } finally {
    projectBindingsStoreTestHooks.beforeCommit = undefined;
    resetProjectBindingsStoreCachesForTest();
    rmSync(temporary, { recursive: true, force: true });
  }
});

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
    assert.equal(spawnsAt() - before, 5, "five unchanged lists spawn one git each (get-url origin)");
    // The options hook is not cached per device: root and .git, every pass.
    assert.equal(namespaceCalls - namespacesBefore, 10, "but still check the volume on every pass");
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
