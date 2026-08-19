import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSourceRepositoryIdentity,
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
  head?: string | (() => never);
}): GitCommand {
  return async (args) => {
    const key = args.includes("--is-inside-work-tree")
      ? "isInside"
      : args.includes("get-url")
        ? "remote"
        : args.includes("HEAD^{commit}")
          ? "head"
          : "other";
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

test("rejects a git repo without an origin remote", async () => {
  const git = fakeGit({ isInside: "true\n", remote: gitFatal("No such remote 'origin'") });
  await assert.rejects(
    () => resolveSourceRepositoryIdentity("/repo", git),
    (error: unknown) => error instanceof UnusableSourceRepositoryError && /no "origin" remote/.test(error.message),
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
