import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DesktopGitRoomInfo } from "../ipc-types.js";
import {
  bindProjectRoot,
  listProjectBindings,
  migrateLegacyProjectBindings,
} from "../main/project-bindings-store.js";
import {
  canonicalProjectRoomIdentifier,
  findProjectBinding,
  projectContextsCompatibleForConnection,
  projectBindingAliases,
} from "../project-bindings.js";
import { resolveRoomIdentifierFromPath } from "../repo-status.js";

function githubGitRoom(): DesktopGitRoomInfo {
  return {
    provider: "github",
    host: "github.com",
    repository: {
      id: "1185805708",
      fullName: "BrosInCode/LetAgents",
      owner: "BrosInCode",
      name: "LetAgents",
    },
    ref: {
      type: "branch",
      name: "feature/foundational-bindings",
      defaultBranch: "staging",
      baseRef: "staging",
      headRef: "feature/foundational-bindings",
      headRepository: null,
    },
    visibility: "private",
    accessMode: "private",
    isDefault: false,
    source: "github",
  };
}

test("hosted root, branch, and focus rooms resolve one project binding", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-project-binding-"));
  const rootPath = join(temporary, "checkout");
  const storePath = join(temporary, "bindings.json");
  mkdirSync(rootPath);
  try {
    const binding = await bindProjectRoot({
      context: {
        roomIdentifier: "github.com/BrosInCode/LetAgents",
        gitRoom: githubGitRoom(),
      },
      rootPath,
      source: "git_remote",
    }, { storePath });

    assert.equal(
      findProjectBinding([binding], {
        roomIdentifier: "github.com/brosincode/letagents/focus/git:branch:ZmVhdHVyZQ",
      })?.rootPath,
      realpathSync(rootPath),
    );
    assert.equal(
      findProjectBinding([binding], {
        roomIdentifier: "sky-lake",
        gitRoom: githubGitRoom(),
      })?.rootPath,
      realpathSync(rootPath),
    );
    assert.equal((await listProjectBindings({ storePath })).length, 1);
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).version, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("local Git repositories without remotes keep one identity across branches", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-local-git-binding-"));
  const storePath = join(temporary, "bindings.json");
  const rootPath = join(temporary, "repo");
  mkdirSync(rootPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  try {
    const main = await resolveRoomIdentifierFromPath(rootPath);
    const binding = await bindProjectRoot({
      context: { roomIdentifier: main.roomIdentifier, gitRoom: main.gitRoom },
      rootPath,
      source: "local_git",
    }, { storePath });
    execFileSync("git", ["switch", "-c", "feature/local"], { cwd: rootPath, stdio: "ignore" });
    const branch = await resolveRoomIdentifierFromPath(rootPath);

    assert.equal(
      canonicalProjectRoomIdentifier(branch.roomIdentifier),
      canonicalProjectRoomIdentifier(main.roomIdentifier),
    );
    assert.equal(
      findProjectBinding([binding], {
        roomIdentifier: branch.roomIdentifier,
        gitRoom: branch.gitRoom,
      })?.id,
      binding.id,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("plain folders are durable projects without requiring Git", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-folder-binding-"));
  const storePath = join(temporary, "bindings.json");
  const rootPath = join(temporary, "notes-project");
  mkdirSync(rootPath);
  try {
    const resolved = await resolveRoomIdentifierFromPath(rootPath);
    assert.equal(resolved.source, "local_folder");
    const binding = await bindProjectRoot({
      context: { roomIdentifier: resolved.roomIdentifier },
      rootPath,
      source: "local_folder",
    }, { storePath });
    assert.equal(
      findProjectBinding([binding], { roomIdentifier: resolved.roomIdentifier })?.rootPath,
      realpathSync(rootPath),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("migration records a repository's source checkout, never a linked execution child", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-worktree-binding-"));
  const storePath = join(temporary, "bindings.json");
  const mainRoot = join(temporary, "repo");
  const linkedRoot = join(temporary, "repo-feature");
  mkdirSync(mainRoot);
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: mainRoot, stdio: "ignore" });
    writeFileSync(join(mainRoot, "tracked.txt"), "hello\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: mainRoot, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial"], {
      cwd: mainRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["worktree", "add", "-b", "feature/test", linkedRoot], {
      cwd: mainRoot,
      stdio: "ignore",
    });
    const resolved = await resolveRoomIdentifierFromPath(linkedRoot);
    const bindings = await migrateLegacyProjectBindings([{
      context: { roomIdentifier: resolved.roomIdentifier, gitRoom: resolved.gitRoom },
      rootPath: linkedRoot,
    }], { storePath });
    assert.equal(bindings[0]?.rootPath, realpathSync(mainRoot));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("legacy migration accepts identity matches and rejects unrelated folders", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-migration-"));
  const storePath = join(temporary, "bindings.json");
  const matching = join(temporary, "matching");
  const unrelated = join(temporary, "unrelated");
  const managedWorktree = join(temporary, "managed-worktree");
  mkdirSync(matching);
  mkdirSync(unrelated);
  mkdirSync(managedWorktree);
  for (const rootPath of [matching, unrelated, managedWorktree]) {
    execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  }
  execFileSync("git", ["remote", "add", "origin", "git@github.com:BrosInCode/LetAgents.git"], {
    cwd: matching,
  });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:other/project.git"], {
    cwd: unrelated,
  });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:BrosInCode/LetAgents.git"], {
    cwd: managedWorktree,
  });
  writeFileSync(join(managedWorktree, ".letagents-work-attempt.json"), "{}\n");
  try {
    const bindings = await migrateLegacyProjectBindings([
      {
        context: { roomIdentifier: "github.com/brosincode/letagents" },
        rootPath: managedWorktree,
      },
      {
        context: { roomIdentifier: "github.com/brosincode/letagents" },
        rootPath: unrelated,
      },
      {
        context: { roomIdentifier: "github.com/brosincode/letagents" },
        rootPath: matching,
      },
    ], { storePath });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.rootPath, realpathSync(matching));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("repository aliases let renamed room labels resolve by stable repository id", () => {
  const aliases = projectBindingAliases({
    roomIdentifier: "sky-lake",
    gitRoom: githubGitRoom(),
  });
  assert.ok(aliases.includes("repository-id:github.com:1185805708"));
  assert.ok(aliases.includes("repository:github.com:brosincode/letagents"));
});

test("explicit reconnect can move local-only projects but hosted repos stay identity-strict", () => {
  assert.equal(projectContextsCompatibleForConnection(
    { roomIdentifier: "git-room:local:1111111111111111:repo", gitRoom: {
      ...githubGitRoom(),
      host: "local",
      repository: { ...githubGitRoom().repository, id: "local:1111111111111111" },
      source: "local_git",
    } },
    { roomIdentifier: "git-room:local:2222222222222222:repo", gitRoom: {
      ...githubGitRoom(),
      host: "local",
      repository: { ...githubGitRoom().repository, id: "local:2222222222222222" },
      source: "local_git",
    } },
    "local_git",
  ), true);
  assert.equal(projectContextsCompatibleForConnection(
    { roomIdentifier: "local-notes-1111111111" },
    { roomIdentifier: "local-notes-2222222222" },
    "local_folder",
  ), true);
  assert.equal(projectContextsCompatibleForConnection(
    { roomIdentifier: "github.com/brosincode/letagents", gitRoom: githubGitRoom() },
    { roomIdentifier: "github.com/other/project" },
    "git_remote",
  ), false);
});

test("concurrent project writes cannot lose another room and unavailable roots stop resolving", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-concurrency-"));
  const storePath = join(temporary, "bindings.json");
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  mkdirSync(first);
  mkdirSync(second);
  try {
    await Promise.all([
      bindProjectRoot({
        context: { roomIdentifier: "local-first-1111111111" },
        rootPath: first,
        source: "local_folder",
      }, { storePath }),
      bindProjectRoot({
        context: { roomIdentifier: "local-second-2222222222" },
        rootPath: second,
        source: "local_folder",
      }, { storePath }),
    ]);
    assert.equal((await listProjectBindings({ storePath })).length, 2);
    rmSync(first, { recursive: true, force: true });
    assert.deepEqual(
      (await listProjectBindings({ storePath })).map((entry) => entry.rootPath),
      [realpathSync(second)],
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
