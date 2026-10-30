import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkDurabilityStore } from "../durability-store.js";
import {
  EphemeralWorkspaceProvisioner,
  isEphemeralWorkspaceMarker,
} from "../ephemeral-workspace-provisioner.js";
import { probeScratchWorkspaceGit, RETAINED_REPLACED_ENTRIES } from "../../../../shared/scratch-workspace-repository.mjs";

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

// Git as a person would run it, with none of this machine's configuration.
const cleanGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnvironment() });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function assertOwnRepository(workspace: string): void {
  assert.equal(git(workspace, "rev-parse", "--show-toplevel"), workspace);
  assert.equal(git(workspace, "rev-parse", "--absolute-git-dir"), join(workspace, ".git"));
  assert.equal(git(workspace, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(git(workspace, "remote"), "", "the repository has no remote to push to");
  assert.equal(git(workspace, "rev-list", "--all", "--count"), "0", "the repository starts with no commits");
}
const ids = [
  "6e7f8091-a2b3-44c5-9d6e-7f8091a2b3c4",
  "0f5f4d2e-6a0c-4f4e-9d1a-2b3c4d5e6f70",
  "1e2d3c4b-5a69-4788-8a9b-0c1d2e3f4a5b",
  "2a3b4c5d-6e7f-4081-9a2b-3c4d5e6f7a8b",
  "3b4c5d6e-7f80-4192-8a3b-4c5d6e7f8a9b",
  "4c5d6e7f-8091-42a3-9b4c-5d6e7f8a9b0c",
  "5d6e7f80-91a2-43b4-8c5d-6e7f8a9b0c1d",
];

test("each room-only workspace is the root of its own empty repository, and room-only is not one", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-repository-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const first = await provisioner.provision({ workAttemptId: ids[0], taskId: "first" });
    const second = await provisioner.provision({ workAttemptId: ids[1], taskId: "second" });
    await writeFile(join(second.path, "notes.txt"), "another room\n");
    for (const workspace of [first, second]) assertOwnRepository(workspace.path);
    await assert.rejects(lstat(join(root, "worktrees", "room-only", ".git")), { code: "ENOENT" });
    // The daemon's marker is excluded, and no other room's file is visible.
    assert.equal(git(first.path, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(git(first.path, "ls-files", "--others", "--exclude-standard", "--full-name", ":/"), "");
    assert.equal(git(second.path, "status", "--porcelain", "--untracked-files=all"), "?? notes.txt");
    // `git clean` leaves the marker, so the daemon can still collect the workspace.
    git(second.path, "clean", "-fd");
    assert.equal((await stat(join(second.path, ".letagents-work-attempt.json"))).isFile(), true);
    // Git records case sensitivity the way `git init` would on this file system.
    await writeFile(join(root, "CaseProbe"), "");
    const ignoresCase = await stat(join(root, "caseprobe")).then(() => true, () => false);
    const recorded = spawnSync("git", ["config", "--bool", "core.ignorecase"], { cwd: first.path, encoding: "utf8", env: cleanGitEnvironment() });
    assert.equal(recorded.stdout.trim() === "true", ignoresCase);
    assert.deepEqual((await readdir(join(first.path, ".git"))).sort(), ["HEAD", "config", "info", "objects", "refs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspaces and a room-only directory from older versions are upgraded, and an existing .git is kept", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-upgrade-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const reused = await provisioner.provision({ workAttemptId: ids[0], taskId: "reused" });
    const launched = await provisioner.provision({ workAttemptId: ids[1], taskId: "launched" });
    const agentOwned = await provisioner.provision({ workAttemptId: ids[2], taskId: "agent" });
    // What an older version left behind: plain directories.
    for (const workspace of [reused, launched]) await rm(join(workspace.path, ".git"), { recursive: true });

    // A reused provision upgrades its workspace.
    const again = await provisioner.provision({ workAttemptId: ids[0], taskId: "reused" });
    assert.equal(again.reused, true);
    assertOwnRepository(again.path);
    // So does the launch of an attempt that is never provisioned again.
    assert.equal(await provisioner.ensureRepository(launched.path), "created");
    assertOwnRepository(launched.path);
    assert.equal(await provisioner.ensureRepository(launched.path), "present");

    // A repository the agent made or changed is its own and stays as it is.
    await writeFile(join(agentOwned.path, ".git", "config"), "[core]\n\tbare = false\n# agent-owned\n");
    assert.equal(await provisioner.ensureRepository(agentOwned.path), "present");
    assert.match(await readFile(join(agentOwned.path, ".git", "config"), "utf8"), /# agent-owned/);
    assert.equal(await provisioner.ensureRepository(join(root, "worktrees", "room-only", ids[3])), "missing");
    // An empty `.git` directory is no repository to Git, which would look above it.
    await rm(join(launched.path, ".git"), { recursive: true });
    await mkdir(join(launched.path, ".git"));
    assert.equal(await provisioner.ensureRepository(launched.path), "replaced");
    assertOwnRepository(launched.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository is only ever added to exactly one room-only workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-refuse-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const workspace = await provisioner.provision({ workAttemptId: ids[0], taskId: "refuse" });
    const roomOnly = join(root, "worktrees", "room-only");
    const otherRepository = join(root, "worktrees", "repo", ids[1]);
    const notAnAttempt = join(roomOnly, "not-an-attempt");
    const link = join(roomOnly, ids[2]);
    await mkdir(otherRepository, { recursive: true });
    await mkdir(notAnAttempt);
    await symlink(workspace.path, link);
    // Named like a workspace, but inside one.
    const nestedAttempt = join(workspace.path, ids[3]);
    for (const path of [roomOnly, otherRepository, notAnAttempt, join(workspace.path, "nested"), nestedAttempt, link]) {
      await mkdir(path, { recursive: true }).catch(() => {});
      await assert.rejects(provisioner.ensureRepository(path), /not a room-only workspace|unsafe/, path);
    }
    for (const path of [roomOnly, otherRepository, notAnAttempt, join(workspace.path, "nested"), nestedAttempt]) {
      await assert.rejects(lstat(join(path, ".git")), { code: "ENOENT" }, path);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent provisioning gives every workspace exactly one complete repository", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-concurrent-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const workspaces = await Promise.all(ids.map((workAttemptId) => provisioner.provision({ workAttemptId, taskId: workAttemptId })));
    for (const workspace of workspaces) assertOwnRepository(workspace.path);

    const target = workspaces[0].path;
    await rm(join(target, ".git"), { recursive: true });
    const results = await Promise.all(Array.from({ length: 12 }, () => provisioner.ensureRepository(target)));
    assert.equal(results.filter((result) => result === "created").length, 1);
    assert.equal(results.filter((result) => result === "present").length, 11);
    assertOwnRepository(target);
    assert.deepEqual((await readdir(target)).sort(), [".git", ".letagents-work-attempt.json"], "no staging directory is left behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning needs no Git and ignores the owner's Git environment", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-hostile-")));
  const saved = { ...process.env };
  const restore = () => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  };
  try {
    const elsewhere = join(root, "elsewhere");
    const template = join(root, "template");
    await mkdir(join(template, "hooks"), { recursive: true });
    await writeFile(join(template, "hooks", "post-checkout"), "#!/bin/sh\ntouch ran\n", { mode: 0o755 });
    await writeFile(join(root, "gitconfig"), `[init]\n\tdefaultBranch = hostile\n\ttemplateDir = ${template}\n[core]\n\thooksPath = ${template}/hooks\n`);
    await mkdir(join(root, "no-git-here"));
    Object.assign(process.env, {
      PATH: join(root, "no-git-here"),
      GIT_DIR: elsewhere,
      GIT_WORK_TREE: elsewhere,
      GIT_TEMPLATE_DIR: template,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_PARAMETERS: "'init.defaultbranch'='hostile'",
      GIT_DEFAULT_BRANCH: "hostile",
    });
    const workspace = await new EphemeralWorkspaceProvisioner(join(root, "daemon")).provision({ workAttemptId: ids[0], taskId: "hostile" });
    restore();
    assertOwnRepository(workspace.path);
    await assert.rejects(lstat(elsewhere), { code: "ENOENT" });
    await assert.rejects(lstat(join(workspace.path, ".git", "hooks")), { code: "ENOENT" });
    assert.doesNotMatch(await readFile(join(workspace.path, ".git", "config"), "utf8"), /hostile|hooksPath|template/i);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("anything at .git that Git would not take as a repository is moved aside and replaced", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-broken-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const elsewhere = join(root, "elsewhere-repository");
    await mkdir(elsewhere);
    git(elsewhere, "init", "-q", "--template=");
    const cases: Array<[string, (git: string) => Promise<void>]> = [
      ["an empty file", (path) => writeFile(path, "")],
      ["a gitdir file", (path) => writeFile(path, "gitdir: /nonexistent\n")],
      ["a directory of junk", async (path) => { await mkdir(path); await writeFile(join(path, "junk"), "x"); }],
      ["a directory missing refs", async (path) => {
        await mkdir(join(path, "objects"), { recursive: true });
        await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
        await writeFile(join(path, "config"), "");
      }],
      ["a link to a repository elsewhere", (path) => symlink(join(elsewhere, ".git"), path)],
      ["a complete directory whose HEAD is junk", async (path) => {
        for (const directory of ["objects", "refs"]) await mkdir(join(path, directory), { recursive: true });
        await writeFile(join(path, "HEAD"), "junk\n");
        await writeFile(join(path, "config"), "[core]\n\tbare = false\n");
      }],
    ];
    for (const [index, [label, plant]] of cases.entries()) {
      const workspace = await provisioner.provision({ workAttemptId: ids[index], taskId: label });
      await rm(join(workspace.path, ".git"), { recursive: true });
      await plant(join(workspace.path, ".git"));
      assert.equal(await provisioner.ensureRepository(workspace.path), "replaced", label);
      assertOwnRepository(workspace.path);
      const aside = (await readdir(workspace.path)).filter((name) => name.startsWith(".git.replaced."));
      assert.equal(aside.length, 1, `${label} is kept aside, not deleted`);
      assert.equal(git(workspace.path, "status", "--porcelain", "--untracked-files=all"), "", `${label} stays out of git status`);
    }
    assert.equal(git(elsewhere, "rev-parse", "--is-inside-work-tree"), "true", "a linked repository is never touched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the repository is private, excludes exactly the daemon's own entries, and clears abandoned staging", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-details-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const workspace = await provisioner.provision({ workAttemptId: ids[0], taskId: "details" });
    assert.equal((await stat(join(workspace.path, ".git"))).mode & 0o777, 0o700);
    assert.equal(await readFile(join(workspace.path, ".git", "info", "exclude"), "utf8"),
      "/.git.*.tmp\n/.git.replaced.*\n/.letagents-work-attempt.json\n/.letagents-work-attempt.json.*.tmp\n");
    // Anchored at the workspace root: the same names elsewhere are the agent's.
    await writeFile(join(workspace.path, `.letagents-work-attempt.json.1.${ids[1]}.tmp`), "");
    await mkdir(join(workspace.path, "sub"));
    await writeFile(join(workspace.path, "sub", ".letagents-work-attempt.json"), "");
    await writeFile(join(workspace.path, "sub", `.letagents-work-attempt.json.1.${ids[1]}.tmp`), "");
    assert.deepEqual(git(workspace.path, "status", "--porcelain", "--untracked-files=all").split("\n").sort(), [
      "?? sub/.letagents-work-attempt.json",
      `?? sub/.letagents-work-attempt.json.1.${ids[1]}.tmp`,
    ]);

    // A process that died while writing leaves its staging directory; a live one's is left alone.
    const dead = join(workspace.path, `.git.999999.${ids[2]}.tmp`);
    const live = join(workspace.path, `.git.1.${ids[3]}.tmp`);
    await mkdir(dead);
    await mkdir(live);
    await provisioner.ensureRepository(workspace.path);
    await assert.rejects(lstat(dead), { code: "ENOENT" });
    assert.equal((await stat(live)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash while writing the repository leaves the marker, so orphan collection still removes the workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-crash-")));
  try {
    const crashing = new EphemeralWorkspaceProvisioner(root, async (workspace) => {
      await mkdir(join(workspace, ".git"));
      throw new Error("daemon killed while writing the repository");
    });
    await assert.rejects(crashing.provision({ workAttemptId: ids[0], taskId: "crash" }), /daemon killed/);
    const workspace = join(root, "worktrees", "room-only", ids[0]);
    assert.deepEqual((await readdir(workspace)).sort(), [".git", ".letagents-work-attempt.json"],
      "the marker is written before the repository");
    assert.deepEqual(await new EphemeralWorkspaceProvisioner(root).garbageCollectOrphans(new Set()), [ids[0]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid HEAD is kept whatever it names, and only the newest broken entries are kept aside", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-head-")));
  try {
    const provisioner = new EphemeralWorkspaceProvisioner(root);
    const workspace = await provisioner.provision({ workAttemptId: ids[0], taskId: "head" });
    for (const head of ["ref: refs/heads/feature/x\n", `${"a".repeat(40)}\n`, `${"b".repeat(64)}`]) {
      await writeFile(join(workspace.path, ".git", "HEAD"), head);
      assert.equal(await provisioner.ensureRepository(workspace.path), "present", head);
    }
    for (const head of ["ref: heads/main\n", "a".repeat(39), "ref: refs/heads/main\nextra\n", ""]) {
      await writeFile(join(workspace.path, ".git", "HEAD"), head);
      assert.equal(await provisioner.ensureRepository(workspace.path), "replaced", JSON.stringify(head));
      assertOwnRepository(workspace.path);
    }
    const aside = (await readdir(workspace.path)).filter((name) => name.startsWith(".git.replaced.")).sort();
    assert.equal(aside.length, RETAINED_REPLACED_ENTRIES);
    // The oldest broken HEAD was the first; the newest three remain.
    const heads = await Promise.all(aside.map((name) => readFile(join(workspace.path, name, "HEAD"), "utf8")));
    assert.deepEqual(new Set(heads), new Set(["a".repeat(39), "ref: refs/heads/main\nextra\n", ""]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Git check runs Git as OpenCode will, with only the launch's environment, within its bound", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-scratch-probe-")));
  try {
    const workspace = await new EphemeralWorkspaceProvisioner(root).provision({ workAttemptId: ids[0], taskId: "probe" });
    const bin = join(root, "bin");
    await mkdir(bin);
    const stub = async (body: string) => writeFile(join(bin, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const path = `${bin}:/bin:/usr/bin`;

    assert.equal(await probeScratchWorkspaceGit(workspace.path, { PATH: join(root, "nowhere") }), "no git on the launch's PATH");
    await stub("exit 128");
    assert.match(await probeScratchWorkspaceGit(workspace.path, { PATH: path }) ?? "", /^git rev-parse --git-dir failed: /);
    await stub("echo /somewhere/else/.git");
    assert.equal(await probeScratchWorkspaceGit(workspace.path, { PATH: path }), "git found its repository at /somewhere/else/.git, not in the workspace");
    // Exactly what OpenCode asks, in the workspace, and none of the launch's secrets.
    await stub(`[ -z "$OPENCODE_AUTH_CONTENT" ] || exit 3\n[ "$*" = "-C ${workspace.path} rev-parse --git-dir" ] || exit 4\n[ "$XDG_CONFIG_HOME" = "/launch/config" ] || exit 5\necho .git`);
    assert.equal(await probeScratchWorkspaceGit(workspace.path, { PATH: path, XDG_CONFIG_HOME: "/launch/config", OPENCODE_AUTH_CONTENT: "secret" }), null);
    await stub("exec sleep 30");
    const started = Date.now();
    assert.match(await probeScratchWorkspaceGit(workspace.path, { PATH: path }) ?? "", /^git rev-parse --git-dir failed: /);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1_500 && elapsed < 6_000, `a hanging git is abandoned at the two-second bound (${elapsed} ms)`);

    // Apple's /usr/bin/git without the command line tools is never run.
    const marker = join(root, "xcode-select-ran");
    const xcodeSelect = join(root, "xcode-select");
    await writeFile(xcodeSelect, `#!/bin/sh\ntouch ${marker}\nexit 2\n`, { mode: 0o755 });
    assert.equal(await probeScratchWorkspaceGit(workspace.path, { PATH: "/usr/bin:/bin" }, { platform: "darwin", xcodeSelect }),
      "the Xcode command line tools are not installed (xcode-select -p failed), so /usr/bin/git cannot run");
    await rm(marker);
    // Another git on the PATH needs no tools check.
    await stub("echo .git");
    assert.equal(await probeScratchWorkspaceGit(workspace.path, { PATH: path }, { platform: "darwin", xcodeSelect }), null);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    // The real Git on this machine reads the repository.
    assert.equal(await probeScratchWorkspaceGit(workspace.path, { PATH: process.env.PATH }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
