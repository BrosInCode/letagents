import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";

import type { DesktopGitRoomInfo } from "../ipc-types.js";
import {
  bindProjectRoot,
  listProjectBindings,
  migrateLegacyProjectBindings,
  parseMacosVolumeUuid,
} from "../main/project-bindings-store.js";
import {
  canonicalProjectRoomIdentifier,
  findProjectBinding,
  projectContextsCompatibleForConnection,
  projectBindingAliases,
} from "../project-bindings.js";
import { resolveRoomIdentifierFromPath } from "../repo-status.js";

const execFileAsync = promisify(execFile);

test("macOS filesystem identity prefers the volume UUID over the earlier disk UUID", () => {
  const plist = `
    <key>DiskUUID</key><string>AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA</string>
    <key>VolumeUUID</key><string>BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB</string>
  `;
  assert.equal(parseMacosVolumeUuid(plist), "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB");
  assert.equal(
    parseMacosVolumeUuid("<key>DiskUUID</key><string>AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA</string>"),
    "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
  );
});

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
  execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:BrosInCode/LetAgents.git"], {
    cwd: rootPath,
  });
  const storeOptions = {
    storePath,
    resolveFilesystemNamespace: async (path: string) =>
      path.endsWith(".git") ? "test-git-volume" : "test-root-volume",
  };
  try {
    const binding = await bindProjectRoot({
      context: {
        roomIdentifier: "github.com/BrosInCode/LetAgents",
        gitRoom: githubGitRoom(),
      },
      rootPath,
      source: "git_remote",
    }, storeOptions);

    assert.equal(
      findProjectBinding([binding], {
        roomIdentifier: "github.com/brosincode/letagents/focus/git:branch:ZmVhdHVyZQ",
        gitRoom: githubGitRoom(),
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
    assert.equal((await listProjectBindings(storeOptions)).length, 1);
    assert.ok(binding.verificationKeys.some((key) => key.startsWith("fs-root:v2:")));
    assert.ok(binding.verificationKeys.some((key) => key.startsWith("fs-git:v2:")));
    const rootNamespace = binding.verificationKeys.find((key) => key.startsWith("fs-root:v2:"))?.split(":")[2];
    const gitNamespace = binding.verificationKeys.find((key) => key.startsWith("fs-git:v2:"))?.split(":")[2];
    assert.notEqual(rootNamespace, gitNamespace);
    assert.equal(readFileSync(storePath).subarray(0, 16).toString(), "SQLite format 3\0");
    assert.equal(statSync(storePath).mode & 0o777, 0o600);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("legacy project bindings survive filesystem device renumbering", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-remount-"));
  const storePath = join(temporary, "bindings.sqlite");
  const rootPath = join(temporary, "checkout");
  mkdirSync(rootPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:BrosInCode/LetAgents.git"], {
    cwd: rootPath,
  });
  const volumeA = async () => "test-volume-a";
  try {
    const binding = await bindProjectRoot({
      context: {
        roomIdentifier: "github.com/BrosInCode/LetAgents",
        gitRoom: githubGitRoom(),
      },
      rootPath,
      source: "git_remote",
    }, { storePath, resolveFilesystemNamespace: volumeA });
    const legacyKeys = binding.verificationKeys.map((key) =>
      key.replace(/^(fs-(?:root|git)):v2:[a-f\d]{64}:(\d+):(\d+)$/, "$1:999999:$2:$3")
    );
    const database = new DatabaseSync(storePath);
    try {
      database.prepare(`
        UPDATE project_bindings
        SET verification_keys_json = ?
        WHERE id = ?
      `).run(JSON.stringify(legacyKeys), binding.id);
    } finally {
      database.close();
    }

    const restored = await listProjectBindings({ storePath, resolveFilesystemNamespace: volumeA });
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.id, binding.id);
    assert.equal(restored[0]?.rootPath, realpathSync(rootPath));
    assert.ok(restored[0]?.verificationKeys.some((key) => /^fs-root:v2:[a-f\d]{64}:/.test(key)));
    assert.ok(restored[0]?.verificationKeys.every((key) => !/^fs-(?:root|git):999999:/.test(key)));

    assert.deepEqual(await listProjectBindings({
      storePath,
      resolveFilesystemNamespace: async () => "test-volume-b",
    }), []);

    const replacedObjectKeys = restored[0]!.verificationKeys.map((key) => {
      const filesystemKey = /^(fs-(?:root|git)):v2:([a-f\d]{64}):(\d+):(\d+)$/.exec(key);
      return filesystemKey
        ? `${filesystemKey[1]}:v2:${filesystemKey[2]}:${BigInt(filesystemKey[3]) + 1n}:${filesystemKey[4]}`
        : key;
    });
    const replacementDatabase = new DatabaseSync(storePath);
    try {
      replacementDatabase.prepare(`
        UPDATE project_bindings
        SET verification_keys_json = ?
        WHERE id = ?
      `).run(JSON.stringify(replacedObjectKeys), binding.id);
    } finally {
      replacementDatabase.close();
    }
    assert.deepEqual(await listProjectBindings({
      storePath,
      resolveFilesystemNamespace: volumeA,
    }), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("bindings fail closed when a stable filesystem namespace is unavailable", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-no-volume-id-"));
  const storePath = join(temporary, "bindings.sqlite");
  const rootPath = join(temporary, "project");
  mkdirSync(rootPath);
  try {
    const resolved = await resolveRoomIdentifierFromPath(rootPath);
    const binding = await bindProjectRoot({
      context: { roomIdentifier: resolved.roomIdentifier },
      rootPath,
      source: "local_folder",
    }, { storePath, resolveFilesystemNamespace: async () => null });

    assert.ok(binding.verificationKeys.some((key) => /^fs-root:\d+:\d+:\d+$/.test(key)));
    const restored = await listProjectBindings({
      storePath,
      resolveFilesystemNamespace: async () => null,
    });
    assert.equal(restored.length, 1);
    assert.ok(restored[0]?.verificationKeys.every((key) => !key.includes(":v2:")));

    const changedDeviceKeys = binding.verificationKeys.map((key) =>
      key.replace(/^(fs-root):\d+:/, "$1:999999:")
    );
    const database = new DatabaseSync(storePath);
    try {
      database.prepare(`
        UPDATE project_bindings
        SET verification_keys_json = ?
        WHERE id = ?
      `).run(JSON.stringify(changedDeviceKeys), binding.id);
    } finally {
      database.close();
    }
    assert.deepEqual(await listProjectBindings({
      storePath,
      resolveFilesystemNamespace: async () => null,
    }), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a reconnect wins over an in-flight legacy proof upgrade", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-upgrade-race-"));
  const storePath = join(temporary, "bindings.sqlite");
  const rootA = join(temporary, "project-a");
  const rootB = join(temporary, "project-b");
  mkdirSync(rootA);
  mkdirSync(rootB);
  let pauseRootA = false;
  let releaseRootA!: () => void;
  let observedRootA!: () => void;
  const rootAReleased = new Promise<void>((resolve) => { releaseRootA = resolve; });
  const rootAObserved = new Promise<void>((resolve) => { observedRootA = resolve; });
  const resolveFilesystemNamespace = async (path: string): Promise<string> => {
    if (path === realpathSync(rootA) && pauseRootA) {
      pauseRootA = false;
      observedRootA();
      await rootAReleased;
    }
    return path === realpathSync(rootA) ? "volume-a" : "volume-b";
  };
  try {
    const resolvedA = await resolveRoomIdentifierFromPath(rootA);
    const binding = await bindProjectRoot({
      context: { roomIdentifier: resolvedA.roomIdentifier },
      rootPath: rootA,
      source: "local_folder",
    }, { storePath, resolveFilesystemNamespace });
    const legacyKeys = binding.verificationKeys.map((key) =>
      key.replace(/^(fs-root):v2:[a-f\d]{64}:(\d+):(\d+)$/, "$1:999999:$2:$3")
    );
    const database = new DatabaseSync(storePath);
    try {
      database.prepare(`
        UPDATE project_bindings
        SET verification_keys_json = ?
        WHERE id = ?
      `).run(JSON.stringify(legacyKeys), binding.id);
    } finally {
      database.close();
    }

    pauseRootA = true;
    const staleRead = listProjectBindings({ storePath, resolveFilesystemNamespace });
    await rootAObserved;
    await bindProjectRoot({
      context: { roomIdentifier: resolvedA.roomIdentifier },
      rootPath: rootB,
      source: "local_folder",
    }, { storePath, resolveFilesystemNamespace });
    releaseRootA();

    assert.deepEqual((await staleRead).map((row) => row.rootPath), [realpathSync(rootB)]);
    assert.deepEqual(
      (await listProjectBindings({ storePath, resolveFilesystemNamespace })).map((row) => row.rootPath),
      [realpathSync(rootB)],
    );
  } finally {
    releaseRootA();
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
    const migration = await migrateLegacyProjectBindings([{
      context: { roomIdentifier: resolved.roomIdentifier, gitRoom: resolved.gitRoom },
      rootPath: linkedRoot,
    }], { storePath });
    assert.equal(migration.bindings[0]?.rootPath, realpathSync(mainRoot));
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
    const migration = await migrateLegacyProjectBindings([
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
    assert.equal(migration.bindings.length, 1);
    assert.equal(migration.bindings[0]?.rootPath, realpathSync(matching));
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

test("mutable hosted names never merge distinct stable repository identities", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-rename-"));
  const storePath = join(temporary, "bindings.json");
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  for (const rootPath of [first, second]) {
    mkdirSync(rootPath);
    execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:BrosInCode/LetAgents.git"], { cwd: rootPath });
  }
  try {
    const firstRoom = githubGitRoom();
    const secondRoom = {
      ...githubGitRoom(),
      repository: { ...githubGitRoom().repository, id: "different-stable-id" },
    };
    const firstBinding = await bindProjectRoot({
      context: { roomIdentifier: "github.com/brosincode/letagents", gitRoom: firstRoom },
      rootPath: first,
      source: "git_remote",
    }, { storePath });
    await bindProjectRoot({
      context: { roomIdentifier: "github.com/brosincode/letagents", gitRoom: secondRoom },
      rootPath: second,
      source: "git_remote",
    }, { storePath });
    const bindings = await listProjectBindings({ storePath });
    assert.equal(bindings.length, 2);
    assert.equal(findProjectBinding(bindings, { gitRoom: firstRoom })?.id, firstBinding.id);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a folder replaced at the same path loses its old binding", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-replaced-"));
  const storePath = join(temporary, "bindings.json");
  const rootPath = join(temporary, "project");
  mkdirSync(rootPath);
  try {
    const resolved = await resolveRoomIdentifierFromPath(rootPath);
    await bindProjectRoot({
      context: { roomIdentifier: resolved.roomIdentifier },
      rootPath,
      source: "local_folder",
    }, { storePath });
    rmSync(rootPath, { recursive: true, force: true });
    mkdirSync(rootPath);
    assert.deepEqual(await listProjectBindings({ storePath }), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("configured room files cannot impersonate hosted Git identity", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-config-spoof-"));
  const rootPath = join(temporary, "repo");
  mkdirSync(rootPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  writeFileSync(join(rootPath, ".letagents.json"), '{"room":"github.com/brosincode/letagents"}\n');
  try {
    const selected = await resolveRoomIdentifierFromPath(rootPath, { ignoreConfiguredRoom: true });
    assert.equal(selected.source, "local_git");
    assert.equal(projectContextsCompatibleForConnection(
      { roomIdentifier: "github.com/brosincode/letagents", gitRoom: githubGitRoom() },
      { roomIdentifier: selected.roomIdentifier, gitRoom: selected.gitRoom },
      selected.source,
    ), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("failed legacy migration keys are retained for a later launch", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-retry-"));
  try {
    const result = await migrateLegacyProjectBindings([{
      legacyKey: "github.com/brosincode/letagents",
      context: { roomIdentifier: "github.com/brosincode/letagents" },
      rootPath: join(temporary, "temporarily-missing"),
    }], { storePath: join(temporary, "bindings.json") });
    assert.deepEqual(result.retryLegacyKeys, ["github.com/brosincode/letagents"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a migrated hosted name cannot satisfy a different stable repository id", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-legacy-reuse-"));
  const storePath = join(temporary, "bindings.sqlite");
  const rootPath = join(temporary, "legacy-checkout");
  mkdirSync(rootPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:org/old.git"], { cwd: rootPath });
  try {
    const migration = await migrateLegacyProjectBindings([{
      legacyKey: "github.com/org/old",
      context: { roomIdentifier: "github.com/org/old" },
      rootPath,
    }], { storePath });
    assert.equal(migration.bindings[0]?.identityKey, "project-room:github.com/org/old");

    const reusedName = {
      ...githubGitRoom(),
      repository: {
        ...githubGitRoom().repository,
        id: "repo-id-2",
        fullName: "org/old",
        owner: "org",
        name: "old",
      },
    };
    assert.equal(findProjectBinding(migration.bindings, {
      roomIdentifier: "github.com/org/old",
      gitRoom: reusedName,
    }), null);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("separate desktop processes serialize whole-store updates", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-binding-processes-"));
  const moduleUrl = new URL("../main/project-bindings-store.ts", import.meta.url).href;
  const script = `
    const { bindProjectRoot } = await import(process.env.BINDINGS_MODULE_URL);
    await bindProjectRoot({
      context: { roomIdentifier: process.env.ROOM_ID },
      rootPath: process.env.ROOT_PATH,
      source: "local_folder",
    }, { storePath: process.env.STORE_PATH });
  `;
  try {
    for (let round = 0; round < 6; round += 1) {
      const roundRoot = join(temporary, `round-${round}`);
      const storePath = join(roundRoot, "bindings.sqlite");
      mkdirSync(roundRoot);
      const roots = Array.from({ length: 16 }, (_value, index) => {
        const rootPath = join(roundRoot, `project-${index}`);
        mkdirSync(rootPath);
        return rootPath;
      });
      await Promise.all(roots.map((rootPath, index) => execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            BINDINGS_MODULE_URL: moduleUrl,
            ROOM_ID: `local-project-${round}-${index}-1111111111`,
            ROOT_PATH: rootPath,
            STORE_PATH: storePath,
          },
        },
      )));
      assert.equal((await listProjectBindings({ storePath })).length, roots.length);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
