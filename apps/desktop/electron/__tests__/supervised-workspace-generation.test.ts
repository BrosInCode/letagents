import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertSupervisedWorkspaceGenerationSupported,
  createSupervisedWorkspaceGeneration,
  recoverSupervisedWorkspaceGeneration,
  openSupervisedWorkspaceGeneration,
  removeSupervisedWorkspaceGenerationReceipt,
  SupervisedWorkspaceConflictError,
  SupervisedWorkspaceGenerationError,
  supervisedWorkspaceGenerationManifestPath,
  type SupervisedWorkspaceGenerationFailpoint,
  type SupervisedWorkspaceGenerationHandle,
} from "../main/agents/supervised-workspace-generation.js";
import { GIT_ENV, findWindowsGitExecutable, gitHooksPath } from "../main/agents/supervised-workspace-generation/git.js";
import { WINDOWS_FRESH_WORKTREE_NOTE } from "../main/agents/supervised-workspace-generation/worktree-windows.js";

const windows = process.platform === "win32";
// Writable generations exist on macOS (clonefile) and Windows (a Git worktree); Linux has neither.
const generationTest = process.platform === "darwin" || windows ? test : test.skip;
// macOS-only file metadata: POSIX modes, xattrs, flags, ACLs, FIFOs, and clonefile breaking hard links.
const darwinTest = process.platform === "darwin" ? test : test.skip;
const windowsTest = windows ? test : test.skip;

generationTest("preflight and manifest discovery are deterministic and read-only", async () => {
  await withRepository(async (repo) => {
    const before = git(repo, ["status", "--porcelain=v1"]);
    const support = await assertSupervisedWorkspaceGenerationSupported(repo);
    const first = await supervisedWorkspaceGenerationManifestPath(repo, "provider-turn-secret");
    const second = await supervisedWorkspaceGenerationManifestPath(repo, "provider-turn-secret");

    assert.equal(support.sourceRoot, repo);
    assert.equal(support.gitDirectory, join(repo, ".git"));
    assert.equal(support.gitCommonDirectory, join(repo, ".git"));
    assert.equal(support.gitIndexPath, join(repo, ".git", "index"));
    assert.equal(support.gitObjectDirectory, join(repo, ".git", "objects"));
    assert.equal(first, second);
    assert.match(first, /\.letagents-generation-[a-f0-9]{32}[\\/]generation-manifest\.json$/);
    assert.equal(first.includes("provider-turn-secret"), false);
    assert.equal(existsSync(dirname(first)), false);
    assert.equal(git(repo, ["status", "--porcelain=v1"]), before);
  });
});

generationTest("linked worktrees preserve dirty status and reconcile only the selected nested workspace", async () => {
  await withLinkedWorktree(async (main, worktree) => {
    mkdirSync(join(worktree, "packages", "app"), { recursive: true });
    writeFileSync(join(worktree, "packages", "app", "app.txt"), "app base\n");
    git(worktree, ["add", "packages/app/app.txt"]);
    git(worktree, ["commit", "-qm", "nested workspace"]);
    writeFileSync(join(worktree, "staged.txt"), "staged\n");
    git(worktree, ["add", "staged.txt"]);
    writeFileSync(join(worktree, "tracked.txt"), "unstaged\n");
    writeFileSync(join(worktree, "untracked.txt"), "untracked\n");
    const expectedStatus = carriedStatus(git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]));
    const workspace = join(worktree, "packages", "app");

    const support = await assertSupervisedWorkspaceGenerationSupported(workspace);
    assert.equal(support.sourceRoot, worktree);
    assert.equal(support.gitCommonDirectory, join(main, ".git"));
    assert.equal(support.gitObjectDirectory, join(main, ".git", "objects"));
    assert.equal(dirname(support.gitDirectory), join(main, ".git", "worktrees"));
    assert.equal(support.gitIndexPath, join(support.gitDirectory, "index"));

    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: workspace,
      turnIdentity: "linked-dirty-nested",
    });
    assert.equal(git(handle.liveSourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), expectedStatus);
    writeFileSync(join(handle.liveWorkspace, "app.txt"), "agent app\n");
    writeFileSync(join(handle.liveWorkspace, "new.txt"), "agent new\n");
    await handle.retireAndReconcile();

    assert.equal(readFileSync(join(workspace, "app.txt"), "utf8"), "agent app\n");
    assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "agent new\n");
    assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf8"), "unstaged\n");
    assert.equal(existsSync(join(main, "packages", "app", "new.txt")), false);
  });
});

generationTest("detached linked worktrees remain supported and split indexes fail closed", async () => {
  await withLinkedWorktree(async (_main, worktree) => {
    git(worktree, ["checkout", "--detach", "--quiet"]);
    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: worktree,
      turnIdentity: "detached-linked",
    });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "detached agent\n");
    await handle.retireAndReconcile();
    assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf8"), "detached agent\n");

    git(worktree, ["update-index", "--split-index"]);
    await assert.rejects(
      assertSupervisedWorkspaceGenerationSupported(worktree),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError
        && error.code === "SPLIT_INDEX_UNSUPPORTED",
    );
  });
});

generationTest("a linked-worktree marker swap after attestation cannot redirect generation authority", async () => {
  await withLinkedWorktree(async (_main, worktree) => {
    const marker = join(worktree, ".git");
    const originalMarker = readFileSync(marker, "utf8");
    const outside = join(dirname(worktree), "planted-repository");
    mkdirSync(outside);
    git(outside, ["init", "-q", "--object-format=sha256"]);
    try {
      const handle = await createSupervisedWorkspaceGeneration({
        realWorkspace: worktree,
        turnIdentity: "linked-marker-swap",
        failpoint: (point) => {
          if (point === "after_preparing") {
            overwriteGitControlFile(marker, `gitdir: ${join(outside, ".git")}\n`);
          }
        },
      });
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "pinned authority\n");
      await handle.retireAndReconcile();
      assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf8"), "pinned authority\n");
      assert.equal(git(outside, ["status", "--porcelain=v1"]), "");
    } finally {
      overwriteGitControlFile(marker, originalMarker);
    }
  });
});

generationTest("a linked-worktree commondir swap cannot redirect post-attestation ignore authority", async () => {
  await withLinkedWorktree(async (_main, worktree) => {
    const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"]);
    const commonMarker = join(gitDirectory, "commondir");
    const originalCommonMarker = readFileSync(commonMarker, "utf8");
    const planted = join(dirname(worktree), "planted-common-repository");
    mkdirSync(planted);
    git(planted, ["init", "-q"]);
    writeFileSync(join(planted, ".git", "info", "exclude"), "secret.txt\n");
    writeFileSync(join(worktree, "secret.txt"), "must remain visible\n");
    try {
      const handle = await createSupervisedWorkspaceGeneration({
        realWorkspace: worktree,
        turnIdentity: "linked-common-dir-swap",
        failpoint: (point) => {
          if (point === "after_preparing") {
            writeFileSync(commonMarker, `${join(planted, ".git")}\n`);
          }
        },
      });
      if (windows) {
        // A Windows worktree never carries untracked files, ignored or not.
        assert.equal(existsSync(join(handle.liveWorkspace, "secret.txt")), false);
      } else {
        assert.equal(readFileSync(join(handle.liveWorkspace, "secret.txt"), "utf8"), "must remain visible\n");
        assert.match(git(handle.liveWorkspace, ["status", "--porcelain=v1", "--untracked-files=all"]), /secret\.txt/);
      }
      await handle.abandon();
    } finally {
      writeFileSync(commonMarker, originalCommonMarker);
    }
  });
});

generationTest("linked-worktree marker, backlink, and common-directory inconsistencies fail preflight", async () => {
  await withLinkedWorktree(async (_main, worktree) => {
    const marker = join(worktree, ".git");
    const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"]);
    const cases: Array<{ path: string; replacement: string }> = [
      { path: marker, replacement: "gitdir: /tmp/not-the-attested-worktree\n" },
      { path: join(gitDirectory, "gitdir"), replacement: "/tmp/not-the-selected-marker\n" },
      { path: join(gitDirectory, "commondir"), replacement: "/tmp/not-the-common-directory\n" },
    ];
    for (const candidate of cases) {
      const original = readFileSync(candidate.path, "utf8");
      try {
        overwriteGitControlFile(candidate.path, candidate.replacement);
        await assert.rejects(
          assertSupervisedWorkspaceGenerationSupported(worktree),
          (error: unknown) => error instanceof SupervisedWorkspaceGenerationError
            && ["REDIRECTED_GIT_ROOT", "SEPARATE_GIT_DIR_UNSUPPORTED"].includes(error.code),
        );
      } finally {
        overwriteGitControlFile(candidate.path, original);
      }
    }
  });
});

generationTest("trusted snapshots cannot execute source or generation Git helpers", async () => {
  await withRepository(async (repo) => {
    const marker = join(dirname(repo), "external-helper-ran");
    const helperFile = join(dirname(repo), "evil-diff.sh");
    // Git for Windows runs helpers through its sh, which needs "/" paths.
    const helper = shellPath(helperFile);
    writeFileSync(helperFile, `#!/bin/sh\ntouch '${shellPath(marker)}'\nexit 1\n`);
    chmodSync(helperFile, 0o755);
    writeFileSync(join(repo, ".gitattributes"), "tracked.txt diff=evil filter=evil\n");
    git(repo, ["add", ".gitattributes"]);
    git(repo, ["commit", "-qm", "diff attributes"]);
    git(repo, ["config", "diff.evil.command", helper]);
    git(repo, ["config", "diff.evil.textconv", helper]);
    git(repo, ["config", "filter.evil.clean", helper]);
    git(repo, ["config", "filter.evil.smudge", "cat"]);
    git(repo, ["config", "filter.evil.required", "true"]);
    writeFileSync(join(repo, "tracked.txt"), "dirty\n");

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "no-helper-turn" });
    assert.equal(readFileSync(join(handle.liveWorkspace, "tracked.txt"), "utf8"), "dirty\n");
    git(handle.liveSourceRoot, ["config", "filter.evil.clean", helper]);
    git(handle.liveSourceRoot, ["config", "filter.evil.required", "true"]);
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    await handle.retireAndReconcile();
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "agent\n");
    assert.equal(existsSync(marker), false);
  });
});

generationTest("trusted Git commands ignore ambient Git authority redirects and injected config", async () => {
  await withRepository(async (repo) => {
    const outside = join(dirname(repo), "ambient-git-outside");
    mkdirSync(outside);
    git(outside, ["init", "-q"]);
    const previous = new Map<string, string | undefined>();
    const hostile = {
      GIT_DIR: join(outside, ".git"),
      GIT_WORK_TREE: outside,
      GIT_INDEX_FILE: join(outside, "hostile.index"),
      GIT_OBJECT_DIRECTORY: join(outside, ".git", "objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(outside, "hooks"),
    };
    for (const [key, value] of Object.entries(hostile)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const handle = await createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: "ambient-git-authority-turn",
      });
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "isolated\n");
      await handle.retireAndReconcile();
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "isolated\n");
      assert.equal(existsSync(join(outside, "hostile.index")), false);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

generationTest("preflight rejects Git object alternates instead of widening native read authority", async () => {
  await withRepository(async (repo) => {
    const alternate = join(dirname(repo), "alternate-objects");
    mkdirSync(alternate);
    writeFileSync(join(repo, ".git", "objects", "info", "alternates"), `${alternate}\n`);
    await assert.rejects(
      assertSupervisedWorkspaceGenerationSupported(repo),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError
        && error.code === "GIT_OBJECT_ALTERNATES_UNSUPPORTED",
    );
  });
});

generationTest("generation preserves staged, unstaged, and nonignored untracked status without walking ignored dependencies", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "unstaged\n");
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");
    mkdirSync(join(repo, "node_modules", "opaque"), { recursive: true });
    if (windows) writeFileSync(join(repo, "node_modules", "opaque", "tripwire"), "never read\n");
    else execFileSync("/usr/bin/mkfifo", [join(repo, "node_modules", "opaque", "tripwire")]);
    const expectedStatus = carriedStatus(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]));

    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: repo,
      turnIdentity: "status-turn",
    });
    try {
      assert.equal(git(handle.liveSourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), expectedStatus);
      const dependency = handle.readOnlyRoots.find((entry) => entry.purpose === "dependency" && entry.sourcePath.endsWith("node_modules"));
      assert.ok(dependency);
      assert.equal(dependency?.generationPath, join(handle.liveSourceRoot, "node_modules"));
      assert.equal(lstatSync(dependency!.generationPath!).isSymbolicLink(), true);
      const manifest = readFileSync(handle.manifestPath, "utf8");
      assert.equal(manifest.includes("status-turn"), false);
    } finally {
      await handle.abandon();
    }
    assert.equal(existsSync(handle.liveSourceRoot), false);
  });
});

generationTest("source-local ignores stay private and nested package dependency roots are mapped read-only", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, ".git", "info", "exclude"), "local-secret.env\n", { flag: "a" });
    writeFileSync(join(repo, "local-secret.env"), "TOP_SECRET=private\n");
    mkdirSync(join(repo, "packages", "app", "node_modules", "onlydep"), { recursive: true });
    writeFileSync(join(repo, "packages", "app", "node_modules", "onlydep", "index.js"), "module.exports = 42\n");

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "local-ignore-turn" });
    try {
      assert.equal(existsSync(join(handle.liveWorkspace, "local-secret.env")), false);
      const nested = handle.readOnlyRoots.find((entry) => entry.generationPath === join(handle.liveSourceRoot, "packages", "app", "node_modules"));
      assert.ok(nested, "package-local node_modules is discovered without walking its contents");
      assert.equal(lstatSync(nested!.generationPath!).isSymbolicLink(), true);
      assert.equal(readFileSync(join(nested!.generationPath!, "onlydep", "index.js"), "utf8"), "module.exports = 42\n");
    } finally {
      await handle.abandon();
    }
  });
});

generationTest("global ignore semantics are honored without copying ignored secrets or config", async () => {
  await withRepository(async (repo) => {
    const globalHome = mkdtempSync(join(tmpdir(), "letagents-generation-global-ignore-"));
    const previousHome = process.env.HOME;
    try {
      const excludes = join(globalHome, "global-excludes");
      writeFileSync(excludes, "global-secret.env\n");
      // A config value treats "\\" as an escape: Git for Windows reads "/" as well.
      writeFileSync(join(globalHome, ".gitconfig"), `[core]\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n`);
      writeFileSync(join(repo, "global-secret.env"), "GLOBAL_SECRET=private\n");
      process.env.HOME = globalHome;

      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "global-ignore-turn" });
      try {
        assert.equal(existsSync(join(handle.liveWorkspace, "global-secret.env")), false);
        assert.equal(readFileSync(join(providerGitDirectory(handle), "config"), "utf8").includes(excludes), false);
      } finally {
        await handle.abandon();
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(globalHome, { force: true, recursive: true });
    }
  });
});

generationTest("preflight rejects sparse, unmerged, unwritable, and custom-limit worktrees", async () => {
  await withRepository(async (repo) => {
    git(repo, ["sparse-checkout", "init", "--cone"]);
    await assert.rejects(
      assertSupervisedWorkspaceGenerationSupported(repo),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "SPARSE_CHECKOUT_UNSUPPORTED",
    );
  });
  await withRepository(async (repo) => {
    const oid = git(repo, ["rev-parse", "HEAD:tracked.txt"]);
    const zeros = "0".repeat(40);
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      input: `0 ${zeros}\ttracked.txt\n100644 ${oid} 1\ttracked.txt\n100644 ${oid} 2\ttracked.txt\n`,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    await assert.rejects(
      assertSupervisedWorkspaceGenerationSupported(repo),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "UNMERGED_INDEX_UNSUPPORTED",
    );
  });
  // A Windows folder's read-only attribute does not stop writes; its DACL would.
  if (!windows) await withRepository(async (repo) => {
    chmodSync(repo, 0o555);
    try {
      await assert.rejects(
        assertSupervisedWorkspaceGenerationSupported(repo),
        (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "GENERATION_PATH_UNWRITABLE",
      );
    } finally {
      chmodSync(repo, 0o755);
    }
  });
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "too-large.txt"), "12345");
    await assert.rejects(
      createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "custom-limit-turn", limits: { maxFileBytes: 4 } }),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "GENERATION_LIMIT_EXCEEDED",
    );
  });
});

generationTest("provider-visible Git metadata is never trusted for final snapshots", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "untrusted-provider-git" });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    writeFileSync(windows ? join(providerGitDirectory(handle), "worktrees", "live", "index") : join(handle.liveSourceRoot, ".git", "index"), "provider-corruption\n");
    rmSync(join(providerGitDirectory(handle), "objects"), { recursive: true, force: true });
    const receipt = await handle.retireAndReconcile();
    assert.equal(receipt.phase, "cleaned");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "agent\n");
  });
});

generationTest("reconciliation preserves content, executable bits, additions, deletes, and rename-as-delete-plus-create", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "delete.txt"), "delete\n");
    writeFileSync(join(repo, "rename-old.txt"), "rename\n");
    writeFileSync(join(repo, "script.sh"), "#!/bin/sh\necho old\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "more fixtures"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "content-turn" });

    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent edit\n");
    rmSync(join(handle.liveWorkspace, "delete.txt"));
    renameSync(join(handle.liveWorkspace, "rename-old.txt"), join(handle.liveWorkspace, "rename-new.txt"));
    writeFileSync(join(handle.liveWorkspace, "script.sh"), "#!/bin/sh\necho new\n");
    chmodSync(join(handle.liveWorkspace, "script.sh"), 0o755);
    mkdirSync(join(handle.liveWorkspace, "new", "nested"), { recursive: true });
    writeFileSync(join(handle.liveWorkspace, "new", "nested", "file.txt"), "new\n");

    const receipt = await handle.retireAndReconcile();
    assert.equal(receipt.phase, "cleaned");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "agent edit\n");
    assert.equal(existsSync(join(repo, "delete.txt")), false);
    assert.equal(existsSync(join(repo, "rename-old.txt")), false);
    assert.equal(readFileSync(join(repo, "rename-new.txt"), "utf8"), "rename\n");
    assert.equal(readFileSync(join(repo, "new", "nested", "file.txt"), "utf8"), "new\n");
    // Windows files have no executable bit; the content still lands.
    if (!windows) assert.equal(lstatSync(join(repo, "script.sh")).mode & 0o111, 0o111);
    assert.equal(readFileSync(join(repo, "script.sh"), "utf8"), "#!/bin/sh\necho new\n");
    assert.equal(existsSync(handle.liveSourceRoot), false);
  });
});

darwinTest("content replacement preserves full POSIX mode and macOS extended metadata", async () => {
  await withRepository(async (repo) => {
    const target = join(repo, "private.txt");
    writeFileSync(target, "before\n");
    chmodSync(target, 0o600);
    execFileSync("/usr/bin/xattr", ["-w", "com.letagents.test", "preserved", target]);
    git(repo, ["add", "private.txt"]);
    git(repo, ["commit", "-qm", "private metadata"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "metadata-turn" });
    writeFileSync(join(handle.liveWorkspace, "private.txt"), "after\n");
    chmodSync(join(handle.liveWorkspace, "private.txt"), 0o600);
    await handle.retireAndReconcile();
    assert.equal(lstatSync(target).mode & 0o7777, 0o600);
    assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.letagents.test", target], { encoding: "utf8" }).trim(), "preserved");
  });
});

generationTest("case-only renames fail visibly instead of reporting a clean reconciliation", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "File.ts"), "case\n");
    git(repo, ["add", "File.ts"]);
    git(repo, ["commit", "-qm", "case fixture"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "case-turn" });
    renameSync(join(handle.liveWorkspace, "File.ts"), join(handle.liveWorkspace, "case-temporary"));
    renameSync(join(handle.liveWorkspace, "case-temporary"), join(handle.liveWorkspace, "file.ts"));
    await assert.rejects(
      handle.retireAndReconcile(),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "AMBIGUOUS_PATH_NORMALIZATION",
    );
    assert.equal(readFileSync(join(repo, "File.ts"), "utf8"), "case\n");
  });
});

generationTest("reserved-name matching does not swallow ordinary filenames", async () => {
  await withRepository(async (repo) => {
    const path = join(repo, "note.letagents-generation-example");
    writeFileSync(path, "before\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "ordinary reserved-like name"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "reserved-like-name" });
    assert.equal(handle.workspaceNote ?? null, windows ? WINDOWS_FRESH_WORKTREE_NOTE : null);
    writeFileSync(join(handle.liveWorkspace, "note.letagents-generation-example"), "after\n");
    const receipt = await handle.retireAndReconcile();
    assert.deepEqual(receipt.appliedPaths, ["note.letagents-generation-example"]);
    assert.equal(readFileSync(path, "utf8"), "after\n");
  });
});

generationTest("reconciliation handles file-to-directory and directory-to-file topology changes", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "becomes-directory"), "old file\n");
    mkdirSync(join(repo, "becomes-file"));
    writeFileSync(join(repo, "becomes-file", "old.txt"), "old child\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "topology fixtures"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "topology-turn" });

    rmSync(join(handle.liveWorkspace, "becomes-directory"));
    mkdirSync(join(handle.liveWorkspace, "becomes-directory"));
    writeFileSync(join(handle.liveWorkspace, "becomes-directory", "new.txt"), "new child\n");
    rmSync(join(handle.liveWorkspace, "becomes-file"), { recursive: true });
    writeFileSync(join(handle.liveWorkspace, "becomes-file"), "new file\n");

    await handle.retireAndReconcile();
    assert.equal(readFileSync(join(repo, "becomes-directory", "new.txt"), "utf8"), "new child\n");
    assert.equal(readFileSync(join(repo, "becomes-file"), "utf8"), "new file\n");
  });
});

generationTest("directory replacement conflicts before deleting tracked files when a concurrent entry appears", async () => {
  await withRepository(async (repo) => {
    mkdirSync(join(repo, "replace-me"));
    writeFileSync(join(repo, "replace-me", "tracked.txt"), "tracked\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "replacement fixture"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "topology-conflict-turn" });
    rmSync(join(handle.liveWorkspace, "replace-me"), { recursive: true });
    writeFileSync(join(handle.liveWorkspace, "replace-me"), "agent replacement\n");
    writeFileSync(join(repo, "replace-me", "concurrent.txt"), "human\n");

    await assert.rejects(handle.retireAndReconcile(), SupervisedWorkspaceConflictError);
    assert.equal(readFileSync(join(repo, "replace-me", "tracked.txt"), "utf8"), "tracked\n");
    assert.equal(readFileSync(join(repo, "replace-me", "concurrent.txt"), "utf8"), "human\n");
  });
});

generationTest("protected provider and Git authority changes reject the whole reconciliation", async () => {
  await withRepository(async (repo) => {
    mkdirSync(join(repo, ".cursor"));
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".cursor", "rules"), "real cursor\n");
    writeFileSync(join(repo, ".claude", "rules"), "real claude\n");
    git(repo, ["add", ".cursor", ".claude"]);
    git(repo, ["commit", "-qm", "provider config"]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "protected-turn" });
    writeFileSync(join(handle.liveWorkspace, ".cursor", "rules"), "agent cursor\n");
    writeFileSync(join(handle.liveWorkspace, ".claude", "rules"), "agent claude\n");
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "allowed\n");

    await assert.rejects(
      handle.retireAndReconcile(),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "PROTECTED_GENERATION_CHANGE",
    );
    assert.equal(readFileSync(join(repo, ".cursor", "rules"), "utf8"), "real cursor\n");
    assert.equal(readFileSync(join(repo, ".claude", "rules"), "utf8"), "real claude\n");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
  });
});

generationTest("mixed-case protected path aliases reject the complete reconciliation plan", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "mixed-case-protected-turn" });
    for (const relativePath of [
      join("nested", ".GiT", "config"),
      join(".CuRsOr", "rules"),
      join(".ClAuDe", "settings.json"),
      join(".LeTaGeNtS-FeNcE", "authority"),
    ]) {
      mkdirSync(dirname(join(handle.liveWorkspace, relativePath)), { recursive: true });
      writeFileSync(join(handle.liveWorkspace, relativePath), "protected\n");
    }
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent-allowed-change\n");

    await assert.rejects(
      handle.retireAndReconcile(),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "PROTECTED_GENERATION_CHANGE",
    );
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
    assert.equal(existsSync(join(repo, ".CuRsOr")), false);
  });
});

generationTest("optimistic conflict check refuses concurrent real-workspace edits", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "conflict-turn" });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    writeFileSync(join(repo, "tracked.txt"), "human\n");

    await assert.rejects(handle.retireAndReconcile(), SupervisedWorkspaceConflictError);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "human\n");
  });
});

generationTest("concurrent chmod metadata edits conflict without overwriting human state", async () => {
  await withRepository(async (repo) => {
    const target = join(repo, "tracked.txt");
    chmodSync(target, 0o644);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "chmod-conflict-turn" });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    // Windows reports one mode bit: the read-only attribute (0o444).
    const humanMode = windows ? 0o444 : 0o600;
    chmodSync(target, humanMode);

    try {
      await assert.rejects(
        handle.retireAndReconcile(),
        (error: unknown) => error instanceof SupervisedWorkspaceConflictError && error.code === "WORKSPACE_CONFLICT",
      );
      assert.equal(readFileSync(target, "utf8"), "base\n");
      assert.equal(lstatSync(target).mode & 0o7777, humanMode);
    } finally {
      chmodSync(target, 0o644);
    }
  });
});

darwinTest("concurrent xattr metadata edits conflict without overwriting human state", async () => {
  await withRepository(async (repo) => {
    const target = join(repo, "tracked.txt");
    execFileSync("/usr/bin/xattr", ["-w", "com.letagents.concurrent", "baseline", target]);
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "xattr-conflict-turn" });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    execFileSync("/usr/bin/xattr", ["-w", "com.letagents.concurrent", "human", target]);

    await assert.rejects(
      handle.retireAndReconcile(),
      (error: unknown) => error instanceof SupervisedWorkspaceConflictError && error.code === "WORKSPACE_CONFLICT",
    );
    assert.equal(readFileSync(target, "utf8"), "base\n");
    assert.equal(
      execFileSync("/usr/bin/xattr", ["-p", "com.letagents.concurrent", target], { encoding: "utf8" }).trim(),
      "human",
    );
  });
});

generationTest("exact-file inspection caching invalidates on a commit-edge metadata change", async () => {
  await withRepository(async (repo) => {
    const target = join(repo, "tracked.txt");
    let fired = false;
    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: repo,
      turnIdentity: "inspection-cache-invalidation",
      failpoint: (point) => {
        if (point === "after_operation_effect" && !fired) {
          fired = true;
          // Windows: the read-only attribute is the metadata it reports.
          if (windows) chmodSync(target, 0o444);
          else execFileSync("/usr/bin/xattr", ["-w", "com.letagents.cache-race", "human", target]);
        }
      },
    });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    try {
      await assert.rejects(handle.retireAndReconcile(), SupervisedWorkspaceConflictError);
      assert.equal(readFileSync(target, "utf8"), "agent\n");
      if (windows) assert.equal(lstatSync(target).mode & 0o7777, 0o444);
      else {
        assert.equal(
          execFileSync("/usr/bin/xattr", ["-p", "com.letagents.cache-race", target], { encoding: "utf8" }).trim(),
          "human",
        );
      }
    } finally {
      if (windows) chmodSync(target, 0o644);
    }
  });
});

darwinTest("exact-file inspection caching invalidates for commit-edge flags and ACLs", async () => {
  const cases = [
    {
      name: "hidden flag",
      mutate: (target: string) => execFileSync("/usr/bin/chflags", ["hidden", target]),
      observe: (target: string) => execFileSync("/bin/ls", ["-lO", target], { encoding: "utf8" }),
      expected: /hidden/,
    },
    {
      name: "ACL",
      mutate: (target: string) => execFileSync("/bin/chmod", ["+a", "everyone allow read", target]),
      observe: (target: string) => execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8" }),
      expected: /everyone allow read/,
    },
  ];
  for (const candidate of cases) {
    await withRepository(async (repo) => {
      const target = join(repo, "tracked.txt");
      let fired = false;
      const handle = await createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: `inspection-cache-${candidate.name}`,
        failpoint: (point) => {
          if (point === "after_operation_effect" && !fired) {
            fired = true;
            candidate.mutate(target);
          }
        },
      });
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
      await assert.rejects(handle.retireAndReconcile(), SupervisedWorkspaceConflictError);
      assert.equal(readFileSync(target, "utf8"), "agent\n");
      assert.match(candidate.observe(target), candidate.expected, `${candidate.name} mutation must remain on the human workspace file`);
    });
  }
});

generationTest("a commit-edge concurrent edit retains baseline, desired, and concurrent versions", async () => {
  await withRepository(async (repo) => {
    let fired = false;
    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: repo,
      turnIdentity: "commit-edge-concurrent-turn",
      failpoint: (point) => {
        if (point === "after_operation_effect" && !fired) {
          fired = true;
          throw new Error("commit-edge crash");
        }
      },
    });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    await assert.rejects(handle.retireAndReconcile(), /commit-edge crash/);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "agent\n");

    writeFileSync(join(repo, "tracked.txt"), "human-after-effect\n");
    await assert.rejects(recoverSupervisedWorkspaceGeneration(handle.manifestPath), SupervisedWorkspaceConflictError);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "human-after-effect\n");

    const manifest = JSON.parse(readFileSync(handle.manifestPath, "utf8")) as {
      generationRoot: string;
      operationJournal: Array<{
        relativePath: string;
        stagingRelativePath: string;
        displacedArtifactRelativePath: string;
      }>;
    };
    const operation = manifest.operationJournal.find((entry) => entry.relativePath === "tracked.txt");
    assert.ok(operation);
    assert.equal(readFileSync(join(manifest.generationRoot, operation!.displacedArtifactRelativePath), "utf8"), "base\n");
    assert.equal(readFileSync(join(manifest.generationRoot, operation!.stagingRelativePath), "utf8"), "agent\n");
  });
});

generationTest("source and agent-created symlink escapes fail closed without touching the target", async () => {
  const outside = mkdtempSync(join(tmpdir(), "letagents-generation-outside-"));
  try {
    writeFileSync(join(outside, "target.txt"), "outside\n");
    // Git for Windows records links only with core.symlinks; the agent-made
    // link and junction below are the Windows escape that matters.
    if (!windows) await withRepository(async (repo) => {
      symlinkSync(join(outside, "target.txt"), join(repo, "tracked-link"));
      git(repo, ["add", "tracked-link"]);
      git(repo, ["commit", "-qm", "tracked link"]);
      await assert.rejects(
        createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "tracked-link-turn" }),
        (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "TRACKED_LINK_OR_GITLINK_UNSUPPORTED",
      );
    });
    if (!windows) await withRepository(async (repo) => {
      symlinkSync(join(outside, "target.txt"), join(repo, "untracked-link"));
      await assert.rejects(
        assertSupervisedWorkspaceGenerationSupported(repo),
        (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "UNTRACKED_SPECIAL_FILE_UNSUPPORTED",
      );
    });
    await withRepository(async (repo) => {
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "agent-link-turn" });
      symlinkSync(join(outside, "target.txt"), join(handle.liveWorkspace, "agent-link"));
      await assert.rejects(
        handle.retireAndReconcile(),
        (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "UNSUPPORTED_GIT_TREE_ENTRY",
      );
      assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside\n");
    });
    if (windows) await withRepository(async (repo) => {
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "agent-junction-turn" });
      symlinkSync(outside, join(handle.liveWorkspace, "agent-junction"), "junction");
      await assert.rejects(
        handle.retireAndReconcile(),
        (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "UNSUPPORTED_GIT_TREE_ENTRY",
      );
      assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside\n");
      assert.equal(existsSync(join(repo, "agent-junction")), false);
    });
  } finally {
    rmSync(outside, { force: true, recursive: true });
  }
});

darwinTest("external hardlinks are broken by CoW overlay cloning and special files are rejected", async () => {
  const outside = mkdtempSync(join(tmpdir(), "letagents-generation-hardlink-"));
  try {
    await withRepository(async (repo) => {
      writeFileSync(join(outside, "shared.txt"), "shared\n");
      linkSync(join(outside, "shared.txt"), join(repo, "untracked-hardlink.txt"));
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "hardlink-turn" });
      assert.equal(lstatSync(join(handle.liveWorkspace, "untracked-hardlink.txt")).nlink, 1);
      writeFileSync(join(handle.liveWorkspace, "untracked-hardlink.txt"), "agent\n");
      await handle.retireAndReconcile();
      assert.equal(readFileSync(join(repo, "untracked-hardlink.txt"), "utf8"), "agent\n");
      assert.equal(readFileSync(join(outside, "shared.txt"), "utf8"), "shared\n");
    });
    await withRepository(async (repo) => {
      execFileSync("/usr/bin/mkfifo", [join(repo, "special")]);
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "special-turn" });
      assert.equal(existsSync(join(handle.liveWorkspace, "special")), false);
      execFileSync("/usr/bin/mkfifo", [join(handle.liveWorkspace, "agent-special")]);
      await handle.retireAndReconcile();
      assert.equal(lstatSync(join(repo, "special")).isFIFO(), true);
      assert.equal(existsSync(join(repo, "agent-special")), false);
    });
  } finally {
    rmSync(outside, { force: true, recursive: true });
  }
});

darwinTest("a detached writer retaining the retired cwd and file descriptor cannot alter the frozen receipt or a successor", async () => {
  await withRepository(async (repo) => {
    const first = await createSupervisedWorkspaceGeneration({
      realWorkspace: repo,
      turnIdentity: "detached-first",
      failpoint: async (point) => {
        if (point !== "after_frozen") return;
        child.send?.("late-write");
        await onceMessage(child, "wrote");
      },
    });
    writeFileSync(join(first.liveWorkspace, "tracked.txt"), "captured\n");
    const child = spawn(process.execPath, ["-e",
      `const fs=require('fs');const p=process.argv[1];const fd=fs.openSync(p,'r+');process.chdir(require('path').dirname(p));process.send('ready');process.on('message',m=>{if(m==='late-write'){fs.ftruncateSync(fd,0);fs.writeSync(fd,'late\\n');fs.fsyncSync(fd);process.send('wrote')}});`,
      join(first.liveWorkspace, "tracked.txt"),
    ], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await onceMessage(child, "ready");
    try {
      const receipt = await first.retireAndReconcile();
      assert.equal(receipt.phase, "cleaned");
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "captured\n");
      const successor = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "detached-successor" });
      try {
        assert.equal(readFileSync(join(successor.liveWorkspace, "tracked.txt"), "utf8"), "captured\n");
      } finally {
        await successor.abandon();
      }
    } finally {
      child.kill("SIGKILL");
    }
  });
});

generationTest("every retirement phase and effect-to-journal crash window resumes idempotently", async () => {
  const points: SupervisedWorkspaceGenerationFailpoint[] = [
    "after_quarantined",
    "after_frozen",
    "after_planned",
    "after_applying",
    "after_operation_effect",
    "after_operation",
    "after_committed",
    "after_cleaned",
  ];
  for (const point of points) {
    await withRepository(async (repo) => {
      let fired = false;
      const handle = await createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: `crash-${point}`,
        failpoint: (candidate) => {
          if (candidate === point && !fired) {
            fired = true;
            throw new Error(`simulated crash at ${point}`);
          }
        },
      });
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), `${point}\n`);
      await assert.rejects(handle.retireAndReconcile(), new RegExp(point));
      const receipt = await recoverSupervisedWorkspaceGeneration(handle.manifestPath, { retireReadyGeneration: true });
      assert.equal(receipt.phase, "cleaned");
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), `${point}\n`);
      const again = await recoverSupervisedWorkspaceGeneration(handle.manifestPath, { retireReadyGeneration: true });
      assert.equal(again.phase, "cleaned");
    });
  }
});

generationTest("ready recovery requires explicit authority revocation and abandon is idempotent", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "abandon-turn" });
    await assert.rejects(
      recoverSupervisedWorkspaceGeneration(handle.manifestPath),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "LIVE_GENERATION_REQUIRES_EXPLICIT_RETIREMENT",
    );
    assert.equal((await handle.abandon()).phase, "aborted");
    assert.equal((await handle.abandon()).phase, "aborted");
  });
});

generationTest("durable receipts remain until explicit result-checkpoint cleanup", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "receipt-lifecycle-turn" });
    await assert.rejects(
      removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "GENERATION_RECEIPT_STILL_REQUIRED",
    );
    await handle.retireAndReconcile();
    assert.equal(existsSync(handle.manifestPath), true, "cleaned receipt remains recoverable before the daemon checkpoint");
    await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath);
    assert.equal(existsSync(dirname(handle.manifestPath)), false);
    await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath);
  });
});

generationTest("terminal receipt cleanup does not depend on the linked common object directory", async () => {
  await withLinkedWorktree(async (main, worktree) => {
    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: worktree,
      turnIdentity: "terminal-cleanup-without-common-objects",
    });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    await handle.retireAndReconcile();
    const objects = join(main, ".git", "objects");
    const unavailableObjects = join(main, ".git", "objects-unavailable");
    renameSync(objects, unavailableObjects);
    try {
      await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath);
      assert.equal(existsSync(dirname(handle.manifestPath)), false);
    } finally {
      renameSync(unavailableObjects, objects);
    }
  });
});

generationTest("version-2 development receipts normalize before recovery", async () => {
  await withRepository(async (repo) => {
    let manifestPath = "";
    await assert.rejects(
      createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: "legacy-v2-receipt",
        failpoint: (point, candidatePath) => {
          if (point !== "after_preparing") return;
          manifestPath = candidatePath;
          throw new Error("legacy receipt crash");
        },
      }),
      /legacy receipt crash/,
    );
    const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    legacy.version = 2;
    delete legacy.sourceGitObjectDirectory;
    writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    assert.equal((await recoverSupervisedWorkspaceGeneration(manifestPath)).phase, "aborted");
  });
});

generationTest("preparing and ready creation crashes have explicit idempotent recovery", async () => {
  await withRepository(async (repo) => {
    let preparingManifest = "";
    await assert.rejects(
      createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: "preparing-crash",
        failpoint: (point, manifestPath) => {
          if (point !== "after_preparing") return;
          preparingManifest = manifestPath;
          throw new Error("preparing crash");
        },
      }),
      /preparing crash/,
    );
    assert.equal((await recoverSupervisedWorkspaceGeneration(preparingManifest)).phase, "aborted");
    assert.equal((await recoverSupervisedWorkspaceGeneration(preparingManifest)).phase, "aborted");

    let readyManifest = "";
    await assert.rejects(
      createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: "ready-crash",
        failpoint: (point, manifestPath) => {
          if (point !== "after_ready") return;
          readyManifest = manifestPath;
          throw new Error("ready crash");
        },
      }),
      /ready crash/,
    );
    await assert.rejects(recoverSupervisedWorkspaceGeneration(readyManifest), /still live/i);
    assert.equal((await recoverSupervisedWorkspaceGeneration(readyManifest, { retireReadyGeneration: true })).phase, "cleaned");
  });
});

generationTest("a crash after the aborted receipt retries private-tree cleanup", async () => {
  await withRepository(async (repo) => {
    let fired = false;
    const handle = await createSupervisedWorkspaceGeneration({
      realWorkspace: repo,
      turnIdentity: "aborted-cleanup-crash",
      failpoint: (point) => {
        if (point === "after_aborted" && !fired) {
          fired = true;
          throw new Error("crash before aborted cleanup");
        }
      },
    });
    await assert.rejects(handle.abandon(), /crash before aborted cleanup/);
    assert.equal(existsSync(handle.liveSourceRoot), true);
    const receipt = await recoverSupervisedWorkspaceGeneration(handle.manifestPath);
    assert.equal(receipt.phase, "aborted");
    assert.equal(existsSync(handle.liveSourceRoot), false);
  });
});

generationTest("selected subdirectories map exactly and outside-generation changes fail closed", async () => {
  await withRepository(async (repo) => {
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    writeFileSync(join(repo, "packages", "app", "app.txt"), "app\n");
    writeFileSync(join(repo, "root.txt"), "root\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "workspace subtree"]);
    const workspace = join(repo, "packages", "app");
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: workspace, turnIdentity: "subdir-good" });
    assert.equal(handle.liveWorkspace, join(handle.liveSourceRoot, "packages", "app"));
    assert.ok(handle.readOnlyRoots.some((entry) => entry.purpose === "git-objects" && entry.sourcePath === join(repo, ".git", "objects")));
    writeFileSync(join(handle.liveWorkspace, "app.txt"), "agent app\n");
    await handle.retireAndReconcile();
    assert.equal(readFileSync(join(workspace, "app.txt"), "utf8"), "agent app\n");
    assert.equal(readFileSync(join(repo, "root.txt"), "utf8"), "root\n");

    const escaped = await createSupervisedWorkspaceGeneration({ realWorkspace: workspace, turnIdentity: "subdir-escape" });
    writeFileSync(join(escaped.liveSourceRoot, "root.txt"), "outside mapping\n");
    await assert.rejects(
      escaped.retireAndReconcile(),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "OUT_OF_SCOPE_GENERATION_CHANGE",
    );
    assert.equal(readFileSync(join(repo, "root.txt"), "utf8"), "root\n");
  });
});

windowsTest("a process holding the live worktree open blocks retirement without touching the workspace", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "busy-live-worktree" });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "captured\n");
    const child = spawn(process.execPath, ["-e",
      "const fs=require('fs');const p=process.argv[1];fs.openSync(p,'r+');process.chdir(require('path').dirname(p));process.send('ready');setInterval(()=>{},1000);",
      join(handle.liveWorkspace, "tracked.txt"),
    ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await onceMessage(child, "ready");
    try {
      // Windows cannot rename a folder another process holds open: the
      // generation stays ready, and nothing reaches the real workspace.
      await assert.rejects(handle.retireAndReconcile(), (error: unknown) =>
        ["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""));
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
    } finally {
      const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
      child.kill();
      await exited;
    }
    const receipt = await recoverSupervisedWorkspaceGeneration(handle.manifestPath, { retireReadyGeneration: true });
    assert.equal(receipt.phase, "cleaned");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "captured\n");
  });
});

windowsTest("a Windows generation is a detached worktree of a private clone and never writes the source .git", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "tracked.txt"), "dirty\n");
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");
    const sourceConfig = readFileSync(join(repo, ".git", "config"), "utf8");
    const sourceObjects = countLooseObjects(join(repo, ".git", "objects"));

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "windows-worktree-shape" });
    assert.equal(handle.workspaceNote, WINDOWS_FRESH_WORKTREE_NOTE);
    assert.match(readFileSync(join(handle.liveSourceRoot, ".git"), "utf8"), /^gitdir: .*provider-git[\\/]worktrees[\\/]live\r?\n?$/);
    assert.throws(() => git(handle.liveSourceRoot, ["symbolic-ref", "-q", "HEAD"]));
    assert.equal(readFileSync(join(handle.liveWorkspace, "tracked.txt"), "utf8"), "dirty\n");
    assert.equal(readFileSync(join(handle.liveWorkspace, "staged.txt"), "utf8"), "staged\n");
    assert.equal(existsSync(join(handle.liveWorkspace, "untracked.txt")), false);
    assert.equal(git(handle.liveSourceRoot, ["status", "--porcelain=v1"]), "A  staged.txt\n M tracked.txt");

    // The agent's own Git writes land in the private clone.
    writeFileSync(join(handle.liveWorkspace, "agent.txt"), "agent\n");
    git(handle.liveSourceRoot, ["add", "-A"]);
    git(handle.liveSourceRoot, ["-c", "user.email=agent@example.test", "-c", "user.name=Agent", "commit", "-qm", "agent work"]);
    git(handle.liveSourceRoot, ["config", "core.hooksPath", join(repo, "planted-hooks")]);
    assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), sourceConfig);
    assert.equal(existsSync(join(repo, ".git", "worktrees")), false);
    assert.equal(countLooseObjects(join(repo, ".git", "objects")), sourceObjects);

    const receipt = await handle.retireAndReconcile();
    assert.deepEqual(receipt.appliedPaths, ["agent.txt"]);
    assert.equal(readFileSync(join(repo, "agent.txt"), "utf8"), "agent\n");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "dirty\n");
    assert.equal(readFileSync(join(repo, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), sourceConfig);
    assert.equal(existsSync(join(dirname(handle.liveSourceRoot), "provider-git")), false);
  });
});

windowsTest("a Windows generation checks out the workspace's own line endings and reconciles them", async () => {
  await withRepository(async (repo) => {
    git(repo, ["config", "core.autocrlf", "true"]);
    writeFileSync(join(repo, "lines.txt"), "one\ntwo\n");
    git(repo, ["add", "lines.txt"]);
    git(repo, ["commit", "-qm", "text with line endings"]);
    rmSync(join(repo, "lines.txt"));
    git(repo, ["checkout", "--", "lines.txt"]);
    assert.equal(readFileSync(join(repo, "lines.txt"), "utf8"), "one\r\ntwo\r\n");

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "windows-line-endings" });
    assert.equal(readFileSync(join(handle.liveWorkspace, "lines.txt"), "utf8"), "one\r\ntwo\r\n");
    assert.equal(git(handle.liveSourceRoot, ["status", "--porcelain=v1"]), "");
    writeFileSync(join(handle.liveWorkspace, "lines.txt"), "one\r\nthree\r\n");
    const receipt = await handle.retireAndReconcile();
    assert.deepEqual(receipt.appliedPaths, ["lines.txt"]);
    assert.equal(readFileSync(join(repo, "lines.txt"), "utf8"), "one\r\nthree\r\n");
  });
});

generationTest("the whole generation lifecycle never writes the repository's .git", async () => {
  await withRepository(async (repo) => {
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "dep\n");
    writeFileSync(join(repo, "tracked.txt"), "dirty\n");
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);
    git(repo, ["pack-refs", "--all"]);
    const before = gitDirectoryFingerprint(join(repo, ".git"));

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "source-git-untouched" });
    writeFileSync(join(handle.liveWorkspace, "agent.txt"), "agent\n");
    git(handle.liveSourceRoot, ["add", "-A"]);
    git(handle.liveSourceRoot, ["-c", "user.email=agent@example.test", "-c", "user.name=Agent", "commit", "-qm", "agent work"]);
    git(handle.liveSourceRoot, ["branch", "agent-branch"]);
    git(handle.liveSourceRoot, ["config", "core.hooksPath", join(repo, "planted-hooks")]);
    // Windows: per-worktree config goes to the private clone's worktree folder.
    if (windows) git(handle.liveSourceRoot, ["config", "--worktree", "core.fsmonitor", "true"]);
    assert.deepEqual(gitDirectoryFingerprint(join(repo, ".git")), before);

    await handle.retireAndReconcile();
    await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath);
    assert.equal(readFileSync(join(repo, "agent.txt"), "utf8"), "agent\n");
    assert.deepEqual(gitDirectoryFingerprint(join(repo, ".git")), before);
  });
});

windowsTest("objects pruned from the repository fail resume and export closed, and the generation can be abandoned", async () => {
  await withRepository(async (repo) => {
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "pruned-objects" });
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    // The private clones borrow this blob through alternates; a gc after a
    // history rewrite in the repository would delete it the same way.
    const blob = git(repo, ["rev-parse", "HEAD:tracked.txt"]);
    const loose = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const saved = join(dirname(repo), "saved-object");
    chmodSync(loose, 0o666);
    renameSync(loose, saved);
    const missing = (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "GENERATION_OBJECTS_MISSING";
    await assert.rejects(openSupervisedWorkspaceGeneration(handle.manifestPath), missing);
    await assert.rejects(handle.retireAndReconcile(), missing);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
    assert.equal(JSON.parse(readFileSync(handle.manifestPath, "utf8")).phase, "ready");
    assert.equal((await handle.abandon()).phase, "aborted");
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
    renameSync(saved, loose);
  });
});

generationTest("staged and unstaged deletions, renames, and file/folder replacements are carried into the generation", async () => {
  await withRepository(async (repo) => {
    for (const name of ["deleted-staged.txt", "deleted-unstaged.txt", "rename-old.txt", "becomes-folder"]) {
      writeFileSync(join(repo, name), `${name}\n`);
    }
    mkdirSync(join(repo, "becomes-file"));
    writeFileSync(join(repo, "becomes-file", "child.txt"), "child\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "topology fixtures"]);
    git(repo, ["rm", "-q", "deleted-staged.txt"]);
    rmSync(join(repo, "deleted-unstaged.txt"));
    git(repo, ["mv", "rename-old.txt", "rename-new.txt"]);
    git(repo, ["rm", "-q", "becomes-folder"]);
    mkdirSync(join(repo, "becomes-folder"));
    writeFileSync(join(repo, "becomes-folder", "inside.txt"), "inside\n");
    git(repo, ["rm", "-rq", "becomes-file"]);
    writeFileSync(join(repo, "becomes-file"), "now a file\n");
    git(repo, ["add", "becomes-folder/inside.txt", "becomes-file"]);
    const expectedStatus = carriedStatus(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]));

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "carried-topology" });
    assert.equal(git(handle.liveSourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), expectedStatus);
    for (const name of ["deleted-staged.txt", "deleted-unstaged.txt", "rename-old.txt"]) {
      assert.equal(existsSync(join(handle.liveWorkspace, name)), false, name);
    }
    assert.equal(readFileSync(join(handle.liveWorkspace, "rename-new.txt"), "utf8"), "rename-old.txt\n");
    assert.equal(readFileSync(join(handle.liveWorkspace, "becomes-folder", "inside.txt"), "utf8"), "inside\n");
    assert.equal(readFileSync(join(handle.liveWorkspace, "becomes-file"), "utf8"), "now a file\n");
    writeFileSync(join(handle.liveWorkspace, "rename-new.txt"), "agent\n");
    const receipt = await handle.retireAndReconcile();
    assert.deepEqual(receipt.appliedPaths, ["rename-new.txt"]);
    assert.equal(readFileSync(join(repo, "rename-new.txt"), "utf8"), "agent\n");
    assert.equal(existsSync(join(repo, "deleted-staged.txt")), false);
  });
});

windowsTest("read-only tracked files start read-only in the worktree and keep their attribute, whatever their name", async () => {
  await withRepository(async (repo) => {
    for (const name of ["read-only.txt", "__proto__"]) writeFileSync(join(repo, name), `${name}\n`);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "read-only fixtures"]);
    for (const name of ["read-only.txt", "__proto__"]) chmodSync(join(repo, name), 0o444);
    try {
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "read-only-start" });
      for (const name of ["read-only.txt", "__proto__"]) {
        assert.equal(lstatSync(join(handle.liveWorkspace, name)).mode & 0o7777, 0o444, name);
      }
      // The agent clears the attribute to edit one file; nothing else changes it.
      chmodSync(join(handle.liveWorkspace, "__proto__"), 0o666);
      writeFileSync(join(handle.liveWorkspace, "__proto__"), "agent\n");
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
      const receipt = await handle.retireAndReconcile();
      assert.deepEqual(receipt.appliedPaths.sort(), ["__proto__", "tracked.txt"]);
      assert.equal(readFileSync(join(repo, "__proto__"), "utf8"), "agent\n");
      assert.equal(readFileSync(join(repo, "read-only.txt"), "utf8"), "read-only.txt\n");
      assert.equal(lstatSync(join(repo, "read-only.txt")).mode & 0o7777, 0o444);
    } finally {
      for (const name of ["read-only.txt", "__proto__"]) chmodSync(join(repo, name), 0o666);
    }
  });
});

windowsTest("the agent's own Git handles a path that is long only inside the generation", async () => {
  await withRepository(async (repo) => {
    // About 240 characters in the workspace; the generation folder adds about 60 (MAX_PATH is 260).
    const segments: string[] = [];
    while (join(repo, ...segments, "file.txt").length < 230) segments.push("long-folder-name");
    const relativePath = join(...segments, "file.txt");
    mkdirSync(join(repo, ...segments), { recursive: true });
    writeFileSync(join(repo, relativePath), "deep\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "deep file"]);

    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "long-path" });
    assert.ok(join(handle.liveWorkspace, relativePath).length > 260);
    assert.equal(git(handle.liveSourceRoot, ["config", "--get", "core.longpaths"]), "true");
    writeFileSync(join(handle.liveWorkspace, relativePath), "agent\n");
    git(handle.liveSourceRoot, ["add", "-A"]);
    assert.match(git(handle.liveSourceRoot, ["status", "--porcelain=v1"]), /^M  /);
    await handle.retireAndReconcile();
    assert.equal(readFileSync(join(repo, relativePath), "utf8"), "agent\n");
  });
});

generationTest("no Git hook of the repository or the empty Git home runs in a supervisor command", async () => {
  await withRepository(async (repo) => {
    const marker = join(dirname(repo), "hook-ran");
    const hook = `#!/bin/sh\necho "$0" >> '${shellPath(marker)}'\n`;
    const planted: string[] = [];
    for (const folder of [join(repo, ".git", "hooks"), ...(windows ? [GIT_ENV.HOME!] : [])]) {
      for (const name of ["post-index-change", "reference-transaction", "post-checkout", "pre-commit"]) {
        const path = join(folder, name);
        writeFileSync(path, hook, { mode: 0o755 });
        planted.push(path);
      }
    }
    try {
      // The planted hooks do run for an ordinary Git command in the repository.
      git(repo, ["commit", "-q", "--allow-empty", "-m", "hooks run here"]);
      assert.equal(existsSync(marker), true);
      rmSync(marker);

      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "no-hooks" });
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
      await handle.retireAndReconcile();
      await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath);
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "agent\n");
      assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
    } finally {
      for (const path of planted) rmSync(path, { force: true });
    }
  });
});

windowsTest("a hook the agent plants under a folder named nul never runs, and the name is refused", async () => {
  await withRepository(async (repo) => {
    // A relative core.hooksPath would be joined to the working tree.
    assert.equal(isAbsolute(gitHooksPath()) && statSync(gitHooksPath()).isFile(), true);
    const marker = join(dirname(repo), "nul-hook-ran");
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "nul-hooks" });
    const planted = `\\\\?\\${join(handle.liveWorkspace, "nul")}`;
    mkdirSync(planted);
    for (const name of ["post-index-change", "reference-transaction"]) {
      writeFileSync(`${planted}\\${name}`, `#!/bin/sh\necho "$0" >> '${shellPath(marker)}'\n`);
    }
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    await assert.rejects(
      handle.retireAndReconcile(),
      (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "UNSUPPORTED_GIT_TREE_ENTRY",
    );
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
  });
});

windowsTest("the agent's .gitignore cannot hide a junction that replaces a tracked folder", async () => {
  const outside = mkdtempSync(join(tmpdir(), "letagents-generation-hidden-junction-"));
  try {
    writeFileSync(join(outside, "a.txt"), "outside\n");
    await withRepository(async (repo) => {
      mkdirSync(join(repo, "src", "lib"), { recursive: true });
      writeFileSync(join(repo, "src", "lib", "a.txt"), "tracked\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-qm", "tracked folder"]);
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "hidden-junction" });
      writeFileSync(join(handle.liveWorkspace, ".gitignore"), "src/\nnode_modules/\n");
      rmSync(join(handle.liveWorkspace, "src", "lib"), { recursive: true });
      symlinkSync(outside, join(handle.liveWorkspace, "src", "lib"), "junction");
      await assert.rejects(
        handle.retireAndReconcile(),
        (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "UNSUPPORTED_GIT_TREE_ENTRY",
      );
      assert.equal(readFileSync(join(repo, "src", "lib", "a.txt"), "utf8"), "tracked\n");
      assert.equal(readFileSync(join(outside, "a.txt"), "utf8"), "outside\n");
    });
  } finally {
    rmSync(outside, { force: true, recursive: true });
  }
});

windowsTest("an 8.3 short name cannot reach a protected folder of the real workspace", async (t) => {
  await withRepository(async (repo) => {
    mkdirSync(join(repo, ".claude"));
    if (!existsSync(join(repo, "CLAUDE~1"))) {
      t.skip("this volume has no 8.3 short names");
      return;
    }
    const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "short-name-alias" });
    mkdirSync(join(handle.liveWorkspace, "CLAUDE~1"));
    writeFileSync(join(handle.liveWorkspace, "CLAUDE~1", "settings.json"), "{\"hooks\":{}}\n");
    writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
    await assert.rejects(handle.retireAndReconcile(), SupervisedWorkspaceConflictError);
    assert.equal(existsSync(join(repo, ".claude", "settings.json")), false);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "base\n");
  });
});

windowsTest("junctions under an ignored folder (a package manager's) do not block reconciliation", async () => {
  const outside = mkdtempSync(join(tmpdir(), "letagents-generation-ignored-junction-"));
  try {
    writeFileSync(join(outside, "index.js"), "outside\n");
    await withRepository(async (repo) => {
      // An installed node_modules is far over the path limit; it is never walked.
      const handle = await createSupervisedWorkspaceGeneration({
        realWorkspace: repo,
        turnIdentity: "ignored-junction",
        limits: { maxChangedPaths: 50 },
      });
      mkdirSync(join(handle.liveWorkspace, "node_modules", ".pnpm"), { recursive: true });
      for (let index = 0; index < 120; index += 1) {
        writeFileSync(join(handle.liveWorkspace, "node_modules", ".pnpm", `file-${index}.js`), "x\n");
      }
      symlinkSync(outside, join(handle.liveWorkspace, "node_modules", "pkg"), "junction");
      writeFileSync(join(handle.liveWorkspace, "tracked.txt"), "agent\n");
      const receipt = await handle.retireAndReconcile();
      assert.deepEqual(receipt.appliedPaths, ["tracked.txt"]);
      assert.equal(existsSync(join(repo, "node_modules")), false);
      assert.equal(readFileSync(join(outside, "index.js"), "utf8"), "outside\n");
    });
  } finally {
    rmSync(outside, { force: true, recursive: true });
  }
});

windowsTest("an installed read-only file keeps its attribute when the receipt is removed", async () => {
  await withRepository(async (repo) => {
    writeFileSync(join(repo, "read-only.txt"), "before\n");
    git(repo, ["add", "read-only.txt"]);
    git(repo, ["commit", "-qm", "read-only fixture"]);
    chmodSync(join(repo, "read-only.txt"), 0o444);
    try {
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "read-only-install" });
      const live = join(handle.liveWorkspace, "read-only.txt");
      chmodSync(live, 0o666);
      writeFileSync(live, "after\n");
      chmodSync(live, 0o444);
      await handle.retireAndReconcile();
      assert.equal(readFileSync(join(repo, "read-only.txt"), "utf8"), "after\n");
      assert.equal(lstatSync(join(repo, "read-only.txt")).mode & 0o7777, 0o444);
      await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath);
      assert.equal(existsSync(dirname(handle.manifestPath)), false);
      assert.equal(lstatSync(join(repo, "read-only.txt")).mode & 0o7777, 0o444);
    } finally {
      chmodSync(join(repo, "read-only.txt"), 0o666);
    }
  });
});

windowsTest("partial clones are refused before anything is made", async () => {
  await withRepository(async (repo) => {
    git(repo, ["config", "uploadpack.allowFilter", "true"]);
    const partial = join(dirname(repo), "partial");
    git(dirname(repo), ["clone", "-q", "--filter=blob:none", pathToFileURL(repo).href, partial]);
    const refused = (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "PARTIAL_CLONE_UNSUPPORTED";
    await assert.rejects(assertSupervisedWorkspaceGenerationSupported(await realpathForTest(partial)), refused);

    // The older marker alone, as Git before 2.32 or a hand edit leaves it.
    git(repo, ["config", "core.repositoryformatversion", "1"]);
    git(repo, ["config", "extensions.partialClone", "origin"]);
    await assert.rejects(assertSupervisedWorkspaceGenerationSupported(repo), refused);
  });
});

windowsTest("a read-only release interrupted after the journal link is gone still restores the attribute", async () => {
  await withRepository(async (repo) => {
    const target = join(repo, "read-only.txt");
    writeFileSync(target, "before\n");
    git(repo, ["add", "read-only.txt"]);
    git(repo, ["commit", "-qm", "read-only fixture"]);
    try {
      const handle = await createSupervisedWorkspaceGeneration({ realWorkspace: repo, turnIdentity: "read-only-release-crash" });
      writeFileSync(join(handle.liveWorkspace, "read-only.txt"), "after\n");
      chmodSync(join(handle.liveWorkspace, "read-only.txt"), 0o444);
      await handle.retireAndReconcile();
      assert.equal(lstatSync(target).mode & 0o7777, 0o444);
      // The state a crash leaves after the release recorded the attribute,
      // cleared it and removed the journal's link, but before it set it again.
      const manifest = JSON.parse(readFileSync(handle.manifestPath, "utf8")) as {
        generationRoot: string;
        operationJournal: Array<{ id: string; relativePath: string; desiredArtifactRelativePath: string }>;
      };
      const operation = manifest.operationJournal.find((entry) => entry.relativePath === "read-only.txt")!;
      const info = lstatSync(target, { bigint: true });
      writeFileSync(join(manifest.generationRoot, "reconcile-staging", `${operation.id}.read-only`),
        JSON.stringify({ dev: String(info.dev), ino: String(info.ino), mode: 0o444 }));
      chmodSync(target, 0o666);
      rmSync(join(manifest.generationRoot, operation.desiredArtifactRelativePath));
      await removeSupervisedWorkspaceGenerationReceipt(handle.manifestPath, { settlementVerified: true });
      assert.equal(existsSync(dirname(handle.manifestPath)), false);
      assert.equal(lstatSync(target).mode & 0o7777, 0o444);
    } finally {
      chmodSync(target, 0o666);
    }
  });
});

test("git.exe is found on absolute PATH folders with a .exe or .com PATHEXT name only", () => {
  const present = new Set([
    "relative\\bin\\git.exe",
    "C:\\Shim\\git.cmd",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Later\\git.exe",
  ]);
  const isFile = (path: string) => present.has(path);
  assert.equal(findWindowsGitExecutable({
    PATH: "relative\\bin;C:\\Shim;\"C:\\Program Files\\Git\\cmd\";C:\\Later",
    PATHEXT: ".BAT;.CMD;.EXE",
  }, isFile), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.throws(
    () => findWindowsGitExecutable({ PATH: "relative\\bin;C:\\Shim", PATHEXT: ".CMD;.EXE" }, isFile),
    (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "GIT_EXECUTABLE_NOT_FOUND",
  );
  assert.throws(
    () => findWindowsGitExecutable({ PATH: "C:\\Program Files\\Git\\cmd", PATHEXT: ".CMD" }, isFile),
    (error: unknown) => error instanceof SupervisedWorkspaceGenerationError && error.code === "GIT_EXECUTABLE_NOT_FOUND",
  );
});

/**
 * Rewrite a Git control file in place. Git for Windows marks `.git` hidden,
 * and Windows refuses to replace a hidden file (EPERM).
 */
function overwriteGitControlFile(path: string, contents: string): void {
  const descriptor = openSync(path, "r+");
  try {
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, contents, 0);
  } finally {
    closeSync(descriptor);
  }
}

/** Path and bytes of every file under the parts of .git a generation could write, and the object names. */
function gitDirectoryFingerprint(gitDirectory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (relativePath: string): void => {
    const path = join(gitDirectory, relativePath);
    if (!existsSync(path)) return;
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relativePath, name));
      return;
    }
    result[relativePath] = readFileSync(path).toString("base64");
  };
  for (const name of ["config", "config.worktree", "HEAD", "index", "packed-refs", "refs", "worktrees", "info", "logs", "hooks"]) visit(name);
  const objects = join(gitDirectory, "objects");
  result["objects/"] = readdirSync(objects).sort()
    .flatMap((name) => lstatSync(join(objects, name)).isDirectory() ? readdirSync(join(objects, name)).sort().map((entry) => `${name}/${entry}`) : [name])
    .join(",");
  return result;
}

function countLooseObjects(objects: string): number {
  return readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))
    .reduce((total, name) => total + readdirSync(join(objects, name)).length, 0);
}

async function withRepository(run: (repo: string) => Promise<void>): Promise<void> {
  const container = mkdtempSync(join(tmpdir(), "letagents-generation-test-"));
  const repo = join(container, "repo");
  mkdirSync(repo);
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.test"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.pnpm/\n.yarn/cache/\nvendor/\n.venv/\n");
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "initial"]);
    await run(await realpathForTest(repo));
  } finally {
    rmSync(container, { force: true, recursive: true });
  }
}

async function withLinkedWorktree(
  run: (main: string, worktree: string) => Promise<void>,
): Promise<void> {
  const container = mkdtempSync(join(tmpdir(), "letagents-generation-linked-test-"));
  const main = join(container, "main");
  const worktree = join(container, "linked");
  mkdirSync(main);
  try {
    git(main, ["init", "-q"]);
    git(main, ["config", "user.email", "agent@example.test"]);
    git(main, ["config", "user.name", "Agent"]);
    writeFileSync(join(main, ".gitignore"), "node_modules/\n.pnpm/\n.yarn/cache/\nvendor/\n.venv/\n");
    writeFileSync(join(main, "tracked.txt"), "base\n");
    git(main, ["add", "."]);
    git(main, ["commit", "-qm", "initial"]);
    git(main, ["worktree", "add", "-qb", "linked-test", worktree]);
    await run(await realpathForTest(main), await realpathForTest(worktree));
  } finally {
    rmSync(container, { force: true, recursive: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trimEnd();
}

async function realpathForTest(path: string): Promise<string> {
  return realpathSync.native(path);
}

/** The Git folder the provider's tree belongs to: its own .git (macOS) or the private clone (Windows). */
function providerGitDirectory(handle: SupervisedWorkspaceGenerationHandle): string {
  return windows ? join(dirname(handle.liveSourceRoot), "provider-git") : join(handle.liveSourceRoot, ".git");
}

/** A path as Git for Windows' sh reads it ("/"); unchanged elsewhere. */
function shellPath(path: string): string {
  return windows ? path.replaceAll("\\", "/") : path;
}

/** The workspace status a generation shows: a Windows worktree carries no untracked files. */
function carriedStatus(status: string): string {
  return windows ? status.split("\n").filter((line) => !line.startsWith("?? ")).join("\n") : status;
}

function onceMessage(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (message: unknown): void => {
      if (message !== expected) return;
      cleanup();
      resolvePromise();
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`detached fixture exited before ${expected}`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
