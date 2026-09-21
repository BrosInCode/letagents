import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  resolveSourceRepositoryIdentity,
  repositoryStorageKey,
  WorkspaceProvisioner,
  UnusableSourceRepositoryError,
  type GitCommand,
} from "../workspace-provisioner.js";

/**
 * Build a fake GitCommand keyed by the meaningful subcommand. A value throws
 * (like real git exiting non-zero) or returns stdout.
 */
function fakeGit(responses: {
  isInside?: string | (() => never);
  remote?: string | (() => never);
  remotes?: string | (() => never);
  topLevel?: string | (() => never);
  head?: string | (() => never);
}): GitCommand {
  return async (args) => {
    const key = args.includes("--is-inside-work-tree")
      ? "isInside"
      : args.includes("get-url")
        ? "remote"
        : args.includes("HEAD^{commit}")
          ? "head"
          : args.includes("--show-toplevel")
            ? "topLevel"
            : args.at(-1) === "remote" ? "remotes" : "other";
    const value = (responses as Record<string, string | (() => never) | undefined>)[key];
    if (value === undefined) throw new Error(`unstubbed git ${args.join(" ")}`);
    if (typeof value === "function") return value();
    return value;
  };
}

const gitFatal = (msg: string) => () => {
  throw new Error(`Command failed: git ...\nfatal: ${msg}`);
};

test("rejects a non-git folder (e.g. home) with an actionable, path-naming message", async () => {
  const git = fakeGit({ isInside: gitFatal("not a git repository (or any of the parent directories): .git") });
  await assert.rejects(
    () => resolveSourceRepositoryIdentity("/Users/emmyleke", git),
    (error: unknown) =>
      error instanceof UnusableSourceRepositoryError
      && /not a git repository/.test(error.message)
      && error.message.includes("/Users/emmyleke")
      // never leaks the raw git failure
      && !/Command failed/.test(error.message),
  );
});

test("rejects a missing directory the same way (git exits non-zero)", async () => {
  const git = fakeGit({ isInside: gitFatal("cannot change to '/gone': No such file or directory") });
  await assert.rejects(
    () => resolveSourceRepositoryIdentity("/gone", git),
    (error: unknown) => error instanceof UnusableSourceRepositoryError,
  );
});

test("does not replace a configured but unreadable origin with a local identity", async () => {
  const git = fakeGit({ isInside: "true\n", remote: gitFatal("broken origin"), remotes: "origin\n" });
  await assert.rejects(
    () => resolveSourceRepositoryIdentity("/repo", git),
    (error: unknown) => error instanceof UnusableSourceRepositoryError && /could not identify/.test(error.message),
  );
});

test("rejects a repo with no HEAD commit", async () => {
  const git = fakeGit({
    isInside: "true\n",
    remote: "git@github.com:acme/app.git\n",
    head: gitFatal("Needed a single revision"),
  });
  await assert.rejects(
    () => resolveSourceRepositoryIdentity("/repo", git),
    (error: unknown) => error instanceof UnusableSourceRepositoryError && /no commits/.test(error.message),
  );
});

test("returns origin remote + revision for a valid repository", async () => {
  const git = fakeGit({
    isInside: "true\n",
    remote: "git@github.com:acme/app.git\n",
    head: "abcdef1234567890\n",
  });
  const identity = await resolveSourceRepositoryIdentity("/repo", git);
  assert.equal(identity.remoteUrl, "git@github.com:acme/app.git");
  assert.equal(identity.revision, "abcdef1234567890");
});


test("originless local projects provision isolated worktrees without changing the source", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-local-source-")));
  const source = join(root, "project");
  const exec = promisify(execFile);
  const git: GitCommand = async (args) => (await exec("git", args, {
    cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout;
  const commit = async (cwd: string, contents: string) => {
    await writeFile(join(cwd, "app.txt"), contents);
    await git(["-C", cwd, "add", "app.txt"]);
    await git(["-C", cwd, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-qm", contents]);
  };
  try {
    await git(["init", "--quiet", source]);
    await assert.rejects(resolveSourceRepositoryIdentity(source, git), /no commits yet/);
    await commit(source, "first");
    const sourceConfig = await readFile(join(source, ".git", "config"), "utf8");
    const sourceHead = await readFile(join(source, ".git", "HEAD"), "utf8");
    const identity = await resolveSourceRepositoryIdentity(source, git);
    assert.equal(identity.remoteUrl, source);
    await mkdir(join(source, "nested"));
    await symlink(source, join(root, "alias"));
    assert.deepEqual(await resolveSourceRepositoryIdentity(join(source, "nested"), git), identity);
    assert.deepEqual(await resolveSourceRepositoryIdentity(join(root, "alias"), git), identity);
    const provisioner = new WorkspaceProvisioner(join(root, "daemon"), git);
    const provision = (revision: string, sourceRepoPath = source) => provisioner.provision({
      repo: repositoryStorageKey(identity.remoteUrl), workAttemptId: randomUUID(), taskId: "task-qa",
      remoteUrl: identity.remoteUrl, revision, sourceRepoPath,
    });
    const first = await provision(identity.revision);
    assert.equal(await readFile(join(first.path, "app.txt"), "utf8"), "first");
    await writeFile(join(first.path, "app.txt"), "agent change");
    assert.equal(await readFile(join(source, "app.txt"), "utf8"), "first");
    const sourceObject = join(source, ".git", "objects", identity.revision.slice(0, 2), identity.revision.slice(2));
    assert.equal((await lstat(sourceObject)).nlink, 1, "private clone does not hardlink source objects");
    assert.equal(await readFile(join(source, ".git", "config"), "utf8"), sourceConfig);
    assert.equal(await readFile(join(source, ".git", "HEAD"), "utf8"), sourceHead);
    assert.equal(String(await git(["-C", source, "status", "--porcelain"])).trim(), "");

    // A detached local commit is not advertised by a branch fetch. The existing
    // source-import path must accept this exact originless source and revision.
    await git(["-C", source, "checkout", "--detach", "--quiet"]);
    await commit(source, "detached follow-up");
    const updated = await resolveSourceRepositoryIdentity(source, git);
    const second = await provision(updated.revision);
    assert.equal(await readFile(join(second.path, "app.txt"), "utf8"), "detached follow-up");
    const foreign = join(root, "foreign");
    await git(["init", "--quiet", foreign]);
    await commit(foreign, "foreign work");
    const foreignIdentity = await resolveSourceRepositoryIdentity(foreign, git);
    await assert.rejects(provision(foreignIdentity.revision, foreign), /remote identity does not match/);
    assert.equal(String(await git(["-C", source, "remote"])).trim(), "", "launch never adds an origin to the project");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("originless repositories borrowing objects produce independent private clones", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-local-alternates-")));
  const exec = promisify(execFile);
  const git: GitCommand = async (args) => (await exec("git", args, { cwd: root })).stdout;
  try {
    const donor = join(root, "donor");
    const source = join(root, "project");
    await git(["init", "--quiet", donor]);
    await writeFile(join(donor, "app.txt"), "borrowed content");
    await git(["-C", donor, "add", "app.txt"]);
    await git(["-C", donor, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "seed"]);
    await git(["clone", "--shared", donor, source]);
    await git(["-C", source, "remote", "remove", "origin"]);
    const alternates = await readFile(join(source, ".git", "objects", "info", "alternates"), "utf8");
    const identity = await resolveSourceRepositoryIdentity(source, git);
    const result = await new WorkspaceProvisioner(join(root, "daemon"), git).provision({
      repo: repositoryStorageKey(identity.remoteUrl), workAttemptId: randomUUID(), taskId: "task-qa",
      ...identity, sourceRepoPath: source,
    });
    await assert.rejects(lstat(join(result.identity.bare_path, "objects", "info", "alternates")), { code: "ENOENT" });
    await rename(donor, join(root, "donor-unavailable"));
    assert.equal(String(await git(["-C", result.path, "show", "HEAD:app.txt"])), "borrowed content");
    assert.equal(await readFile(join(source, ".git", "objects", "info", "alternates"), "utf8"), alternates);
  } finally { await rm(root, { recursive: true, force: true }); }
});
