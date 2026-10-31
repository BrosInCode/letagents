import { DaemonReadModel } from "../daemon-read-model.js";
import { isHumanRoomActivityEvent } from "../provider-stream-policy.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DaemonControlSocket } from "../control-socket.js";
import { CorruptAttemptStoreError, ImmutableExecutionError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { providerStreamLifecycle, SupervisorDaemon as ProductionSupervisorDaemon } from "../main.js";
import { DaemonFenceLostError } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { productionSupervisorGrantHttp } from "../cloud-http.js";
import { createGitCommand, RepositoryNetworkError, repositoryStorageKey, WorkspaceProvisioner } from "../workspace-provisioner.js";
import { ProviderSchedulerFailureCoordinator } from "../provider-scheduler-failure-coordinator.js";
import { acquireWorkspaceFence, withWorkspaceFence } from "../workspace-fence.js";
import { connectDaemon } from "../../../../shared/daemon-endpoint.mjs";
import { needsDeletableCwd, testNamedDaemonEndpoint } from "../../electron/__tests__/platform.js";
import {
  SupervisorDaemon,
  execFileAsync,
  fixture,
  admitDaemonInboxForProviderTest,
  daemonRequest,
  TEST_OID,
  TEST_SUPERVISOR,
  provisionedWorkspace,
  fakeGit,
  entry,
  originRemoteFixture, testDaemonEndpoint, WAIT_SCALE } from "./helpers/daemon-fixture.js";

test("fence loss fatally stops the control endpoint", async () => {
  const env = await fixture();
  try {
    const lockPath = join(env.root, "fatal.lock");
    const { socketPath, peerProofPath } = testNamedDaemonEndpoint(env.root, "fatal");
    const daemon = new SupervisorDaemon({ lockPath, socketPath, peerProofPath, manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await writeFile(`${lockPath}.generation`, "2\n");
    await new Promise<void>((resolve, reject) => {
      const client = connectDaemon(socketPath); client.once("error", reject);
      // A connection that nobody reads never reports that the daemon closed it on Windows.
      client.resume();
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, method: "manifest.list" }) + "\n"));
      client.on("close", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => new Promise<void>((resolve, reject) => {
      const client = connectDaemon(socketPath); client.once("connect", () => resolve()); client.once("error", reject);
    }));
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("control socket bounds an oversized JSON-lines frame", async () => {
  const env = await fixture();
  try {
    const { socketPath, peerProofPath } = testNamedDaemonEndpoint(env.root, "bounded");
    const socket = new DaemonControlSocket(socketPath, () => ({ ok: true }), undefined, 16, { peerProofPath });
    await socket.start();
    await new Promise<void>((resolve, reject) => {
      const client = connectDaemon(socketPath); client.once("error", reject);
      client.resume();
      client.on("connect", () => client.write("x".repeat(17)));
      client.on("close", () => resolve());
    });
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("work attempts survive generations and lease rebinds while terminal payloads stay immutable", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:0${tick++}.000Z`, join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_12", provider_continuation_id: "provider-1" });
    const historyGuard = new DatabaseSync(join(env.root, "daemon-state.sqlite"));
    historyGuard.exec(`
      CREATE TRIGGER forbid_checkpoint_rewrite BEFORE DELETE ON work_attempt_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint history rewritten'); END;
      CREATE TRIGGER forbid_epoch_rewrite BEFORE DELETE ON work_attempt_lease_epochs BEGIN SELECT RAISE(ABORT, 'epoch history rewritten'); END;
      CREATE TRIGGER forbid_execution_rewrite BEFORE DELETE ON work_attempt_executions BEGIN SELECT RAISE(ABORT, 'execution history rewritten'); END;
    `);
    historyGuard.close();
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const terminal = { ended_at: "2026-01-01T00:00:09.000Z", exit_code: 137, signal: "SIGKILL", stdio_archive_ref: "stdio.log.1.archive", stdio_tail: "last line", terminal_cause: "crash", actor: "daemon", generation: 1, provider_continuation_id: "provider-1" };
    const storedTerminal = await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, stdio_tail: "x".repeat(20) }, 8);
    assert.equal(storedTerminal.terminal?.stdio_tail, "x".repeat(8));
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal), ImmutableExecutionError);
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_13", provider_continuation_id: "provider-2" });
    const resumed = await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).workspace_path, workspace.path);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).epoch_history.length, 2);
    assert.equal(resumed.generation, 2);
    const terminalCanary = "canary-not-a-real-terminal-secret-123456789";
    const resumedTerminal = await store.recordTerminal(attempt.work_attempt_id, resumed.execution_generation_id, { ended_at: "2026-01-01T00:00:10.000Z", exit_code: 0, signal: null, stdio_archive_ref: `LETAGENTS_TOKEN=${terminalCanary}`, stdio_tail: `Authorization: Bearer ${terminalCanary}`, terminal_cause: `OPENAI_API_KEY=${terminalCanary}`, actor: "daemon", generation: 2, provider_continuation_id: null });
    assert.doesNotMatch(JSON.stringify(resumedTerminal.terminal), new RegExp(terminalCanary));
    assert.doesNotMatch(JSON.stringify(await store.getAttempt(attempt.work_attempt_id)), new RegExp(terminalCanary));
    assert.match(JSON.stringify(resumedTerminal.terminal), /REDACTED/);
    const releaseHistoryGuard = new DatabaseSync(join(env.root, "daemon-state.sqlite"));
    releaseHistoryGuard.exec("DROP TRIGGER forbid_checkpoint_rewrite; DROP TRIGGER forbid_epoch_rewrite; DROP TRIGGER forbid_execution_rewrite");
    releaseHistoryGuard.close();
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "reviewed", postmortemDiff: "diff --git a/a b/a" });
    await assert.rejects(() => store.rebindAttempt(attempt.work_attempt_id, "lease-3", 3), ImmutableExecutionError);
  } finally { await env.cleanup(); }
});

for (const failure of ["before-commit", "after-commit"] as const) test(`terminal persistence retains exact evidence when its commit fence fails ${failure}`, async () => {
  const env = await fixture();
  const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"),
    () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
  try {
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1,
      workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const terminal = { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 0, signal: null,
      stdio_archive_ref: null, stdio_tail: "", terminal_cause: "exited", actor: "daemon", generation: 1,
      provider_continuation_id: "original" };
    let current = true, fences = 0;
    const operation = store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal, 0,
      async commit => {
        fences += 1;
        await Promise.resolve();
        if (!current) throw new DaemonFenceLostError("terminal owner changed before commit");
        await commit();
        throw new Error("terminal write committed before callback failed");
      });
    if (failure === "before-commit") current = false;
    await assert.rejects(operation, failure === "before-commit" ? /owner changed/ : /write committed/);
    assert.equal(fences, 1, "the exact fence runs inside the store's reserved write operation");
    const saved = (await store.getAttempt(attempt.work_attempt_id)).execution_generations[0]!.terminal;
    assert.deepEqual(saved, failure === "before-commit" ? null : terminal);
    if (failure === "before-commit") {
      await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal);
    }
    await assert.rejects(store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id,
      { ...terminal, provider_continuation_id: "replacement" }), ImmutableExecutionError);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).execution_generations[0]!.terminal?.provider_continuation_id, "original");
  } finally { await store.close(); await env.cleanup(); }
});

for (const boundary of ["failed-release", "successor-overlap", "owner-loss"] as const) test(`terminal workspace fence preserves exact ownership across ${boundary}`, async () => {
  const env = await fixture();
  const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"),
    () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
  try {
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1,
      workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, {
      ended_at: "2026-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null,
      stdio_tail: "", terminal_cause: "exited", actor: "daemon", generation: 1, provider_continuation_id: "original",
    });
    const held = (store as unknown as { executionFences: Map<string, Awaited<ReturnType<typeof acquireWorkspaceFence>>> }).executionFences;
    const original = held.get(attempt.work_attempt_id)!;
    const release = original.release.bind(original);
    let releases = 0;
    if (boundary === "failed-release") {
      original.release = async () => { if (++releases === 1) throw new Error("fixture filesystem release failure"); await release(); };
      await assert.rejects(store.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id), /filesystem release failure/);
      assert.equal(held.get(attempt.work_attempt_id), original, "failed release retains the actual filesystem handle");
      await store.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id);
      assert.equal(releases, 2);
      assert.equal(held.has(attempt.work_attempt_id), false);
      const exclusive = await acquireWorkspaceFence(workspace.path, "exclusive-proof", 1, "exclusive");
      await exclusive.release();
    } else if (boundary === "owner-loss") {
      await assert.rejects(store.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id,
        async () => { throw new DaemonFenceLostError("fixture owner superseded after validation"); }), /owner superseded/);
      assert.equal(held.get(attempt.work_attempt_id), original);
      await store.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id);
    } else {
      let entered!: () => void, unblock!: () => void;
      const entering = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { unblock = resolve; });
      original.release = async () => { releases++; entered(); await gate; await release(); };
      const retiring = store.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id);
      await entering;
      let successorStarted = false;
      const starting = store.startGeneration(attempt.work_attempt_id, "daemon", 2).then(result => { successorStarted = true; return result; });
      await new Promise<void>(resolve => setImmediate(resolve));
      const overlapped = successorStarted;
      unblock();
      await retiring;
      const successor = await starting;
      assert.equal(overlapped, false, "a successor cannot adopt H while its release is in progress");
      const replacement = held.get(attempt.work_attempt_id)!;
      assert.notEqual(replacement, original);
      await assert.rejects(store.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id), /another execution generation is live/);
      assert.equal(held.get(attempt.work_attempt_id), replacement, "old terminal cannot release successor H2");
      await store.recoverExecutionFence(attempt.work_attempt_id);
      assert.equal(held.get(attempt.work_attempt_id), replacement);
      await store.recordTerminal(attempt.work_attempt_id, successor.execution_generation_id, {
        ended_at: "2026-01-01T00:00:02.000Z", exit_code: 0, signal: null, stdio_archive_ref: null,
        stdio_tail: "", terminal_cause: "exited", actor: "daemon", generation: 2, provider_continuation_id: "successor",
      });
      await store.releaseTerminalExecutionFence(attempt.work_attempt_id, successor.execution_generation_id);
      assert.equal(releases, 1);
    }
  } finally { await store.close(); await env.cleanup(); }
});

test("independent SQLite connections cannot start two live generations for one attempt", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "attempts.json");
    const root = join(env.root, "attempt-data");
    const workspace = await provisionedWorkspace(env.root);
    const first = new WorkDurabilityStore(path, root, undefined, join(env.root, "worktrees"), undefined, undefined, undefined, { supervisor_id: "race-a", supervisor_generation: 1 });
    const second = new WorkDurabilityStore(path, root, undefined, join(env.root, "worktrees"), undefined, undefined, undefined, { supervisor_id: "race-b", supervisor_generation: 1 });
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "race", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const results = await Promise.allSettled([
      first.startGeneration(attempt.work_attempt_id, "daemon", 1),
      second.startGeneration(attempt.work_attempt_id, "daemon", 1),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await first.getAttempt(attempt.work_attempt_id)).execution_generations.filter((item) => item.terminal === null).length, 1);
    await first.close();
    await second.close();
  } finally { await env.cleanup(); }
});

test("stdio rotates append-only and GC protects active, ambiguous, quarantined, and unreviewed attempts", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const create = async () => {
      const workspace = await provisionedWorkspace(env.root);
      const attempt = await store.createAttempt({ taskId: "task", leaseId: `lease-${tick}`, leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
      return attempt;
    };
    const first = await create(); const second = await create(); const latest = await create(); const protectedAttempt = await create();
    await store.concludeAttempt(first.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "first" });
    await store.concludeAttempt(second.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "second" });
    await store.concludeAttempt(latest.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "latest" });
    await store.markState(protectedAttempt.work_attempt_id, "quarantined");
    const log = await store.appendStdio(first.work_attempt_id, "x".repeat(8), 8);
    await store.appendStdio(first.work_attempt_id, "next", 8);
    const stdioCanary = "canary-not-a-real-stdio-secret-123456789";
    const credentialLog = await store.appendStdio(protectedAttempt.work_attempt_id, "Authorization: Bearer ", 1_024);
    await store.appendStdio(protectedAttempt.work_attempt_id, stdioCanary, 1_024);
    assert.doesNotMatch(await readFile(credentialLog, "utf8"), new RegExp(stdioCanary));
    assert.match(await readFile(credentialLog, "utf8"), /REDACTED/);
    assert.ok((await readdir(dirname(log))).some((name) => name.includes("stdio.log.") && name.endsWith(".archive")));
    const removed = await store.garbageCollect(1);
    assert.deepEqual(new Set(removed), new Set([first.work_attempt_id, second.work_attempt_id]));
    await assert.rejects(() => stat(first.workspace_path));
    assert.equal((await stat(latest.workspace_path)).isDirectory(), true);
    assert.equal((await stat(protectedAttempt.workspace_path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("workspace provisioner uses daemon-owned clones, reuses attempts, and rejects dev-checkout escapes", async () => {
  const env = await fixture();
  try {
    const commands: string[][] = [];
    let rejectMarkerlessRecovery = false;
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      commands.push(args);
      if (args.includes("worktree") && args.includes("add")) { rejectMarkerlessRecovery = false; await mkdir(args.at(-2)!, { recursive: true }); }
      else if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) {
        if (args.includes("--git-common-dir")) return rejectMarkerlessRecovery ? join(env.root, "repos", "wrong.git") : join(env.root, "repos", "repo.git");
        return TEST_OID;
      }
      return "";
    });
    assert.throws(() => provisioner.workspacePath("../dev", "attempt"), /Unsafe repository/);
    assert.throws(() => provisioner.workspacePath(".", "attempt"), /Unsafe repository/);
    const workAttemptId = randomUUID();
    const first = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    const second = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "moved-branch" });
    assert.equal(first.reused, false); assert.equal(second.reused, true); assert.ok(commands.length > 2);
    const refresh = commands.findIndex((args) => args.includes("fetch") && args.includes("+refs/heads/*:refs/letagents/remotes/origin/*"));
    const resolution = commands.findIndex((args) => args.includes("abc^{commit}"));
    assert.ok(refresh >= 0 && refresh < resolution, "the verified origin is refreshed before revision resolution");
    assert.equal(commands[refresh]![1], await realpath(join(env.root, "repos", "repo.git")));
    assert.deepEqual(commands[refresh], [
      "--git-dir", await realpath(join(env.root, "repos", "repo.git")),
      "fetch", "--prune", "--no-tags", "origin",
      "+refs/heads/*:refs/letagents/remotes/origin/*",
      "+refs/tags/*:refs/letagents/tags/*",
    ]);
    assert.match(first.path, new RegExp(`worktrees[/\\\\]repo[/\\\\]${workAttemptId}$`));
    assert.ok(commands[0]!.includes("--bare"));
    await rm(join(first.path, ".letagents-work-attempt.json"));
    const recovered = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(recovered.reused, true, "an add-before-marker crash is recoverable");
    await rm(join(first.path, ".letagents-work-attempt.json"));
    rejectMarkerlessRecovery = true;
    const reprovisioned = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(reprovisioned.reused, false, "an unprovable markerless partial is quarantined and reprovisioned");
    const remove = commands.findIndex((args) => args.includes("worktree") && args.includes("remove") && args.includes(first.path));
    const replacementAdd = commands.findIndex((args, index) => index > remove && args.includes("worktree") && args.includes("add") && args.includes(first.path));
    assert.ok(remove >= 0 && replacementAdd > remove, "the exact stale worktree registration is removed before re-adding");
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://token@example.invalid/repo.git", revision: "abc" }), /userinfo/);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://evil.invalid/repo.git", revision: "abc" }), /identity/);
    await rm(first.path, { recursive: true });
    const outside = join(env.root, "outside"); await mkdir(outside);
    await symlink(outside, first.path);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" }), /symlink/);
  } finally { await env.cleanup(); }
});

test("repository storage keys preserve full project identity across same-basename remotes", () => {
  const first = repositoryStorageKey("https://git.example.invalid/owner-a/shared-project.git");
  const equivalent = repositoryStorageKey("https://git.example.invalid/owner-a/shared-project.git/");
  const second = repositoryStorageKey("https://git.example.invalid/owner-b/shared-project.git");
  assert.equal(first, equivalent);
  assert.notEqual(first, second);
  assert.notEqual(repositoryStorageKey("file:///tmp/shared-project.git"), repositoryStorageKey("file:///tmp/shared-project"));
  assert.notEqual(repositoryStorageKey("./shared-project.git"), repositoryStorageKey("./shared-project"));
  assert.equal(repositoryStorageKey("git@github.com:owner-a/shared-project.git"), repositoryStorageKey("git@github.com:owner-a/shared-project"));
  assert.match(first, /^shared-project-[0-9a-f]{16}$/);
  assert.match(second, /^shared-project-[0-9a-f]{16}$/);
});

test("filesystem remotes that differ by a literal .git suffix remain isolated during local revision import", async () => {
  const env = await fixture();
  try {
    const remoteWithSuffix = join(env.root, "same.git");
    const remoteWithoutSuffix = join(env.root, "same");
    const sourceWithSuffix = join(env.root, "source-with-suffix");
    const sourceWithoutSuffix = join(env.root, "source-without-suffix");
    const daemonRoot = join(env.root, "daemon");
    await execFileAsync("git", ["init", "--bare", remoteWithSuffix]);
    await execFileAsync("git", ["init", "--bare", remoteWithoutSuffix]);

    const initializeSource = async (source: string, remote: string, content: string) => {
      await execFileAsync("git", ["init", source]);
      await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
      await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
      await writeFile(join(source, "README.md"), content);
      await execFileAsync("git", ["-C", source, "add", "README.md"]);
      await execFileAsync("git", ["-C", source, "commit", "-m", "initial"]);
      await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
      await execFileAsync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"]);
    };
    await initializeSource(sourceWithSuffix, remoteWithSuffix, "suffix remote\n");
    await initializeSource(sourceWithoutSuffix, remoteWithoutSuffix, "plain remote\n");
    await writeFile(join(sourceWithoutSuffix, "README.md"), "plain remote local only\n");
    await execFileAsync("git", ["-C", sourceWithoutSuffix, "add", "README.md"]);
    await execFileAsync("git", ["-C", sourceWithoutSuffix, "commit", "-m", "local only"]);

    const firstKey = repositoryStorageKey(remoteWithSuffix);
    const secondKey = repositoryStorageKey(remoteWithoutSuffix);
    assert.notEqual(firstKey, secondKey, "literal filesystem paths must not inherit hosted-remote .git equivalence");
    const firstRevision = (await execFileAsync("git", ["-C", sourceWithSuffix, "rev-parse", "HEAD"])).stdout.trim();
    const secondRevision = (await execFileAsync("git", ["-C", sourceWithoutSuffix, "rev-parse", "HEAD"])).stdout.trim();
    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    await provisioner.provision({
      repo: firstKey,
      workAttemptId: randomUUID(),
      taskId: "suffix_remote",
      remoteUrl: remoteWithSuffix,
      revision: firstRevision,
      sourceRepoPath: sourceWithSuffix,
    });
    await assert.rejects(
      () => provisioner.provision({
        repo: firstKey,
        workAttemptId: randomUUID(),
        taskId: "cross_wired_source",
        remoteUrl: remoteWithSuffix,
        revision: secondRevision,
        sourceRepoPath: sourceWithoutSuffix,
      }),
      /Local source repository remote identity does not match/,
    );
    const second = await provisioner.provision({
      repo: secondKey,
      workAttemptId: randomUUID(),
      taskId: "plain_remote",
      remoteUrl: remoteWithoutSuffix,
      revision: secondRevision,
      sourceRepoPath: sourceWithoutSuffix,
    });
    assert.equal((await execFileAsync("git", ["-C", second.path, "rev-parse", "HEAD"])).stdout.trim(), secondRevision);
    assert.notEqual(
      join(daemonRoot, "repos", `${firstKey}.git`),
      join(daemonRoot, "repos", `${secondKey}.git`),
    );
  } finally { await env.cleanup(); }
});

test("workspace provisioner refreshes an existing bare clone before resolving a new source revision", async () => {
  const env = await fixture();
  try {
    const remote = join(env.root, "origin.git");
    const source = join(env.root, "source");
    const daemonRoot = join(env.root, "daemon");
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
    await writeFile(join(source, "README.md"), "first\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "first"]);
    await execFileAsync("git", ["-C", source, "branch", "-M", "main"]);
    await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
    await execFileAsync("git", ["-C", source, "push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const firstRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    const first = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_first",
      remoteUrl: remote,
      revision: firstRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", first.path, "rev-parse", "HEAD"])).stdout.trim(), firstRevision);

    let remoteCalls = 0;
    const networkFailure = Object.assign(new Error("git fetch failed"), {
      stderr: "ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.",
    });
    const offline = new WorkspaceProvisioner(daemonRoot, async (args) => {
      if (args.includes("clone") || (args.includes("fetch") && args.includes("origin"))) {
        remoteCalls += 1;
        throw networkFailure;
      }
      return createGitCommand(daemonRoot)(args);
    });
    const reused = await offline.provision({
      repo: "repo", workAttemptId: first.identity.work_attempt_id,
      taskId: "task_first", remoteUrl: remote, revision: "moved-branch",
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.identity.resolved_revision, firstRevision);
    const cached = await offline.provision({
      repo: "repo", workAttemptId: randomUUID(), taskId: "cached",
      remoteUrl: remote, revision: firstRevision,
    });
    assert.equal(cached.identity.resolved_revision, firstRevision);
    assert.equal(remoteCalls, 0, "verified workspaces and cached exact commits need no network");
    await assert.rejects(offline.provision({
      repo: "repo", workAttemptId: first.identity.work_attempt_id,
      taskId: "wrong-task", remoteUrl: remote, revision: firstRevision,
    }), /Workspace identity does not match/);
    for (const revision of ["main", "f".repeat(40)]) {
      await assert.rejects(offline.provision({
        repo: "repo", workAttemptId: randomUUID(), taskId: "needs_remote",
        remoteUrl: remote, revision,
      }), (error: unknown) => error instanceof RepositoryNetworkError && error.cause === networkFailure);
    }
    assert.equal(remoteCalls, 2, "symbolic revisions and missing objects must still refresh");

    await writeFile(join(source, "README.md"), "second\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "second"]);
    const secondRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/fresh-after-clone"]);

    const second = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_second",
      remoteUrl: remote,
      revision: secondRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", second.path, "rev-parse", "HEAD"])).stdout.trim(), secondRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", "refs/letagents/remotes/origin/fresh-after-clone"])).stdout.trim(),
      secondRevision,
    );
    assert.equal(
      (await execFileAsync("git", ["-C", second.path, "rev-parse", "origin/fresh-after-clone"])).stdout.trim(),
      secondRevision,
      "the daemon's refresh also updates agents' origin/* refs",
    );

    await writeFile(join(source, "README.md"), "local only\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "local only"]);
    const localOnlyRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await assert.rejects(
      () => execFileAsync("git", ["--git-dir", remote, "cat-file", "-e", `${localOnlyRevision}^{commit}`]),
      "the remote must not contain the unpushed source commit",
    );
    const localAttemptId = randomUUID();
    const localOnly = await provisioner.provision({
      repo: "repo",
      workAttemptId: localAttemptId,
      taskId: "task_local_only",
      remoteUrl: remote,
      revision: localOnlyRevision,
      sourceRepoPath: source,
    });
    assert.equal((await execFileAsync("git", ["-C", localOnly.path, "rev-parse", "HEAD"])).stdout.trim(), localOnlyRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", `refs/letagents/sources/${localAttemptId}^{commit}`])).stdout.trim(),
      localOnlyRevision,
      "the daemon retains the exact local commit under an attempt-scoped private ref",
    );

    await execFileAsync("git", ["-C", source, "checkout", "--detach", secondRevision]);
    await writeFile(join(source, "README.md"), "tag only\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "tag only"]);
    await execFileAsync("git", ["-C", source, "tag", "release-only"]);
    const tagOnlyRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", source, "push", "origin", "refs/tags/release-only"]);

    const tagged = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_tag_only",
      remoteUrl: remote,
      revision: tagOnlyRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", tagged.path, "rev-parse", "HEAD"])).stdout.trim(), tagOnlyRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", "refs/letagents/tags/release-only^{commit}"])).stdout.trim(),
      tagOnlyRevision,
    );
  } finally { await env.cleanup(); }
});

test("agent worktrees get origin tracking refs without the network, and the daemon's marker stays out of git", async () => {
  const env = await fixture();
  try {
    const { remote, source, git, firstRevision } = await originRemoteFixture(env.root);
    const daemonRoot = join(env.root, "daemon");
    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    const provision = (repo: string) => provisioner.provision({
      repo, workAttemptId: randomUUID(), taskId: "task_tracking", remoteUrl: remote, revision: firstRevision,
    });
    const refspecs = async (bare: string) => (await git(["--git-dir", bare, "config", "--get-all", "remote.origin.fetch"])).split("\n");
    const assertAgentReady = async (path: string, originMain: string) => {
      assert.equal(await git(["-C", path, "rev-parse", "--verify", "origin/main^{commit}"]), originMain);
      assert.equal(await git(["-C", path, "rev-parse", "--verify", "origin/feature^{commit}"]), firstRevision);
      assert.equal(await git(["-C", path, "symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
      assert.equal(await git(["-C", path, "status", "--porcelain", "--untracked-files=all"]), "", "the workspace marker is not an untracked file");
      await git(["-C", path, "check-ignore", "--quiet", ".letagents-work-attempt.json"]);
    };

    const fresh = await provision("fresh");
    await assertAgentReady(fresh.path, firstRevision);
    assert.deepEqual(await refspecs(fresh.identity.bare_path), ["+refs/heads/*:refs/remotes/origin/*"]);
    await writeFile(join(source, "README.md"), "second\n");
    await git(["-C", source, "commit", "-am", "second"]);
    const secondRevision = await git(["-C", source, "rev-parse", "HEAD"]);
    await git(["-C", source, "push", "origin", "main"]);
    await git(["-C", fresh.path, "fetch", "--quiet", "origin"]);
    assert.equal(await git(["-C", fresh.path, "rev-parse", "--verify", "origin/main^{commit}"]), secondRevision, "an agent's own fetch updates origin/main");

    // A repository from an older daemon has no refspec and no origin refs.
    // Its refresh copied the remote's branches, and its own branches now
    // include an agent's, which must not pass for the remote's.
    const legacyBare = join(daemonRoot, "repos", "legacy.git");
    await git(["clone", "--bare", "--no-local", remote, legacyBare]);
    await git(["--git-dir", legacyBare, "fetch", "--no-tags", "origin", "+refs/heads/*:refs/letagents/remotes/origin/*"]);
    await git(["--git-dir", legacyBare, "branch", "agent-only", firstRevision]);
    await assert.rejects(git(["--git-dir", legacyBare, "config", "--get-all", "remote.origin.fetch"]));
    const repaired = await provision("legacy");
    await assertAgentReady(repaired.path, secondRevision);
    assert.deepEqual(await refspecs(legacyBare), ["+refs/heads/*:refs/remotes/origin/*"]);
    await assert.rejects(git(["--git-dir", legacyBare, "rev-parse", "--verify", "refs/remotes/origin/agent-only"]));

    // An agent's workaround edits the shared config, and a second agent repeats it.
    await git(["--git-dir", legacyBare, "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await git(["--git-dir", legacyBare, "config", "--add", "remote.origin.fetch", "refs/heads/*:refs/remotes/origin/*"]);
    await git(["--git-dir", legacyBare, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/remotes/origin/tags/*"]);
    await assertAgentReady((await provision("legacy")).path, secondRevision);
    assert.deepEqual(await refspecs(legacyBare), [
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/remotes/origin/tags/*",
    ], "duplicates collapse to one standard entry; an unrelated refspec is kept");
    const excludes = (await readFile(join(legacyBare, "info", "exclude"), "utf8")).split("\n");
    assert.equal(excludes.filter((line) => line === "/.letagents-work-attempt.json").length, 1, "the exclude is written once");
    assert.equal(await git(["-C", repaired.path, "status", "--porcelain", "--untracked-files=all"]), "", "earlier worktrees share the exclude");

    // With no copy of the remote's branches, the agent's own fetch fills them.
    const unrefreshedBare = join(daemonRoot, "repos", "unrefreshed.git");
    await git(["clone", "--bare", "--no-local", remote, unrefreshedBare]);
    const unrefreshed = await provision("unrefreshed");
    await assert.rejects(git(["-C", unrefreshed.path, "rev-parse", "--verify", "origin/main"]));
    await git(["-C", unrefreshed.path, "fetch", "--quiet", "origin"]);
    assert.equal(await git(["-C", unrefreshed.path, "rev-parse", "--verify", "origin/main^{commit}"]), secondRevision);

    // The daemon never writes through a link planted in the shared repository.
    const outside = join(env.root, "outside-exclude");
    await writeFile(outside, "outside\n");
    await rm(join(unrefreshedBare, "info", "exclude"));
    await symlink(outside, join(unrefreshedBare, "info", "exclude"));
    await assert.rejects(provision("unrefreshed"), /symlink/);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  } finally { await env.cleanup(); }
});

test("launching a cached commit never waits on an unreachable origin, and setup failures do not fail it", async () => {
  const env = await fixture();
  const connections = new Set<Socket>();
  // Accepts connections and never answers, like a black-holed remote.
  const server = createNetServer((socket) => { connections.add(socket); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const unreachable = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
    const { remote, git, firstRevision } = await originRemoteFixture(env.root);
    const daemonRoot = join(env.root, "daemon");
    const bare = join(daemonRoot, "repos", "offline.git");
    await git(["clone", "--bare", "--no-local", remote, bare]);
    await git(["--git-dir", bare, "remote", "set-url", "origin", unreachable]);
    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    const launch = () => provisioner.provision({
      repo: "offline", workAttemptId: randomUUID(), taskId: "task_offline", remoteUrl: unreachable, revision: firstRevision,
    });
    const bounded = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("the launch waited on the unreachable origin")), 10_000).unref();
    })]);
    const first = await bounded(launch());
    assert.equal(await git(["-C", first.path, "rev-parse", "HEAD"]), firstRevision);
    // A held config lock makes repairing a duplicated refspec fail; that
    // setup is skipped, not fatal.
    await git(["--git-dir", bare, "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await writeFile(join(bare, "config.lock"), "");
    const second = await bounded(launch());
    assert.equal(await git(["-C", second.path, "rev-parse", "HEAD"]), firstRevision);
    assert.equal(connections.size, 0, "provisioning never contacted origin");
  } finally {
    for (const socket of connections) socket.destroy();
    server.close();
    await env.cleanup();
  }
});

test("repository transport errors get friendly bounded recovery, but auth failures do not", async () => {
  const env = await fixture();
  try {
    const failures = [
      "ssh: connect to host github.com port 22: Operation timed out",
      "fatal: unable to access remote: Could not resolve host: github.com",
      "Connection reset by peer",
      "git@github.com: Permission denied (publickey).",
      "ERROR: Repository not found.",
    ];
    const scheduled: string[] = [];
    const messages: string[] = [];
    const coordinator = new ProviderSchedulerFailureCoordinator({
      nativeHeartbeatIntervalMs: 1000, currentDaemonGeneration: () => 1, nowMs: () => 0,
      serializeEntry: async (_id, operation) => operation(),
      serializeManifest: async (operation) => operation(),
      manifest: { load: async () => ({ entries: [entry] }), updateEntry: async (_id, update) => update(entry) },
      transitionOnce: async (_id, _state, _condition, message) => { messages.push(message); },
      audit: { append: async () => {} },
      scheduleRecovery: (id, delay) => { assert.equal(delay, 1000); scheduled.push(id); },
    });
    for (const [index, stderr] of failures.entries()) {
      const original = Object.assign(new Error("Command failed: git clone"), { stderr });
      const provisioner = new WorkspaceProvisioner(join(env.root, String(index)), async () => { throw original; });
      let failure: unknown;
      await assert.rejects(provisioner.provision({
        repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "git@github.com:owner/repo.git", revision: TEST_OID,
      }), (error: unknown) => { failure = error; return true; });
      const transient = index < 3;
      assert.equal(failure instanceof RepositoryNetworkError, transient);
      if (!transient) assert.equal(failure, original, "auth errors retain their original classification");
      const before = scheduled.length;
      coordinator.clearSuccessfulRecovery(entry.id);
      for (let attempt = 0; attempt < 5; attempt += 1) await coordinator.record(entry.id, failure, "test");
      assert.equal(scheduled.length - before, transient ? 3 : 0, "recovery is bounded and transport-only");
      if (transient) {
        assert.match(messages.at(-1)!, /Check your network or VPN/);
        assert.doesNotMatch(messages.at(-1)!, /convergence scheduler|git clone|port 22/);
        coordinator.clearSuccessfulRecovery(entry.id);
        await coordinator.record(entry.id, failure, "test");
        assert.equal(scheduled.length - before, 4, "successful recovery resets the retry budget");
      }
    }
  } finally { await env.cleanup(); }
});

test("workspace provisioning survives deletion of the daemon's inherited launch cwd", { skip: needsDeletableCwd }, async () => {
  const env = await fixture();
  try {
    const source = join(env.root, "source");
    const launchCwd = join(env.root, "ephemeral-launch-cwd");
    const daemonRoot = join(env.root, "stable-daemon-root");
    await mkdir(source);
    await mkdir(launchCwd);
    await mkdir(daemonRoot);
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
    await writeFile(join(source, "README.md"), "stable cwd\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);

    const moduleUrl = new URL("../workspace-provisioner.ts", import.meta.url).href;
    const tsxImport = import.meta.resolve("tsx");
    const workAttemptId = randomUUID();
    const script = [
      `import { rm } from "node:fs/promises";`,
      `import { createGitCommand, WorkspaceProvisioner } from ${JSON.stringify(moduleUrl)};`,
      `const git = createGitCommand(${JSON.stringify(daemonRoot)});`,
      `process.chdir(${JSON.stringify(launchCwd)});`,
      `await rm(${JSON.stringify(launchCwd)}, { recursive: true });`,
      `const provisioner = new WorkspaceProvisioner(${JSON.stringify(daemonRoot)}, git);`,
      `const result = await provisioner.provision(${JSON.stringify({
        repo: "repo",
        workAttemptId,
        taskId: "task_deleted_cwd",
        remoteUrl: source,
        revision: "HEAD",
      })});`,
      `process.stdout.write(JSON.stringify({ path: result.path, reused: result.reused }));`,
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxImport, "--input-type=module", "-e", script],
      { cwd: launchCwd, maxBuffer: 8 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as { path: string; reused: boolean };
    assert.equal(result.reused, false);
    assert.equal(result.path, join(daemonRoot, "worktrees", "repo", workAttemptId));
    assert.equal((await stat(result.path)).isDirectory(), true);
  } finally {
    await env.cleanup();
  }
});

test("durability store validates destructive identities, serializes GC, and quarantines tampering", async () => {
  const env = await fixture();
  let releaseGc!: () => void;
  let reserved!: () => void;
  const gcReserved = new Promise<void>((resolve) => { reserved = resolve; });
  const gcRelease = new Promise<void>((resolve) => { releaseGc = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const store = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), async () => { reserved(); await gcRelease; }, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await assert.rejects(() => store.appendStdio("../../outside", "nope"), /UUID/);
    const collecting = store.garbageCollect(0);
    await gcReserved;
    await assert.rejects(() => store.markState(attempt.work_attempt_id, "quarantined"), /GC reservation/);
    releaseGc();
    assert.deepEqual(await collecting, [attempt.work_attempt_id]);

    const protectedWorkspace = await provisionedWorkspace(env.root);
    const protectedAttempt = await store.createAttempt({ taskId: "task", leaseId: "lease-2", leaseEpoch: 2, workspacePath: protectedWorkspace.path, workAttemptId: protectedWorkspace.id });
    await store.concludeAttempt(protectedAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await writeFile(path, "{\"version\":2,\"attempts\":[],\"checksum\":\"tampered\"}");
    const recovered = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:01.000Z", join(env.root, "worktrees"));
    await assert.rejects(() => recovered.garbageCollect(0), CorruptAttemptStoreError);
    assert.equal((await stat(protectedWorkspace.path)).isDirectory(), true);
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));

    const legacyWorkspace = await provisionedWorkspace(env.root);
    const legacyDatabase = join(env.root, "legacy-state.sqlite");
    const legacyStore = new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:02.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR, undefined, legacyDatabase);
    const legacyAttempt = await legacyStore.createAttempt({ taskId: "task", leaseId: "lease-3", leaseEpoch: 3, workspacePath: legacyWorkspace.path, workAttemptId: legacyWorkspace.id });
    await legacyStore.concludeAttempt(legacyAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    const legacySnapshot = await legacyStore.getAttempt(legacyAttempt.work_attempt_id);
    await legacyStore.close();
    await rm(legacyDatabase, { force: true });
    await rm(`${legacyDatabase}-wal`, { force: true });
    await rm(`${legacyDatabase}-shm`, { force: true });
    await writeFile(join(env.root, "legacy-attempts.json"), JSON.stringify({ version: 1, attempts: [legacySnapshot] }));
    assert.equal((await (new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:03.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, legacyDatabase)).getAttempt(legacyAttempt.work_attempt_id)).state, "unreviewed");
  } finally { await env.cleanup(); }
});

test("execution identities prohibit parallel, duplicate, and laundered terminal generations", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const first = await store.startGeneration(attempt.work_attempt_id, "starter", 1);
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "starter", 2), /one execution generation/);
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2025-01-01T00:00:00.000Z", exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "", actor: "other", generation: 1, provider_continuation_id: null }), /runtime schema|identity/);
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 1.5, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crash", actor: "starter", generation: 1, provider_continuation_id: null }), /runtime schema/);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).execution_generations[0]?.terminal, null, "invalid runtime input must never poison the persisted authority record");
    await store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crash", actor: "starter", generation: 1, provider_continuation_id: null });
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "starter", 1), /strictly monotonic/);
  } finally { await env.cleanup(); }
});

test("execution fencing fails closed without an injected P1a supervisor identity", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"));
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "daemon", 1), /P1a supervisor identity/);
  } finally { await env.cleanup(); }
});

test("postmortem capture failure releases the retained execution fence", async () => {
  const env = await fixture();
  try {
    const git = async (args: string[]) => {
      if (args.includes("status")) throw new Error("injected postmortem failure");
      return fakeGit(env.root)(args);
    };
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, git, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" }), /postmortem failure/);
    const fenceDir = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    assert.equal((await readdir(fenceDir)).some((name) => name.startsWith("shared-")), false);
  } finally { await env.cleanup(); }
});

test("live generations block every conclusion before Git capture", async () => {
  const env = await fixture();
  let gitCalls = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => { gitCalls += 1; return fakeGit(env.root)(args); }, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" }), /terminal attestation/);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "abandoned", cause: "stopped" }), /terminal attestation/);
    assert.equal(gitCalls, 0);
  } finally { await env.cleanup(); }
});

test("attempt creation requires a final provisioned marker and enforces unique exact worktree layout", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"));
    const id = randomUUID();
    const unmarked = join(env.root, "worktrees", "repo", id); await mkdir(unmarked, { recursive: true });
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: unmarked, workAttemptId: id }), /marker/);
    const first = await provisionedWorkspace(env.root);
    await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: first.path, workAttemptId: first.id });
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease-2", leaseEpoch: 2, workspacePath: first.path, workAttemptId: first.id }), /already exists/);
    const duplicatePath = await provisionedWorkspace(env.root, "task", randomUUID());
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: duplicatePath.path, workAttemptId: first.id }), /marker/);
    const sibling = join(env.root, "worktrees", "repo", "not-the-attempt"); await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: id, task_id: "task", remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: join(env.root, "repos", "repo.git") }));
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: sibling, workAttemptId: id }), /exact daemon worktree layout/);
  } finally { await env.cleanup(); }
});

test("GC replays every pending tombstone and refuses a Git identity mismatch", async () => {
  const env = await fixture();
  let release!: () => void;
  let reserved!: () => void;
  const entered = new Promise<void>((resolve) => { reserved = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const workspace = await provisionedWorkspace(env.root);
    const first = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), async () => { reserved(); await blocked; }, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await first.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    assert.match(await readFile(join(env.root, "attempt-data", attempt.work_attempt_id, "postmortem.diff"), "utf8"), /status --porcelain/);
    const collecting = first.garbageCollect(0); await entered;
    const recovery = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root));
    assert.deepEqual(await recovery.garbageCollect(99), [attempt.work_attempt_id], "pending GC must not be hidden behind retention");
    release(); await collecting;

    const mismatch = await provisionedWorkspace(env.root);
    let evilRemote = false;
    const guarded = new WorkDurabilityStore(join(env.root, "mismatch.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => evilRemote && args.includes("remote") ? "https://evil.invalid/repo.git" : await fakeGit(env.root)(args), undefined, TEST_SUPERVISOR);
    const other = await guarded.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: mismatch.path, workAttemptId: mismatch.id });
    await guarded.concludeAttempt(other.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    evilRemote = true;
    assert.deepEqual(await guarded.garbageCollect(0), []);
    assert.equal((await stat(mismatch.path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("a retained live generation permits provisioning a distinct sibling workspace", async () => {
  const env = await fixture();
  try {
    const bare = join(env.root, "repos", "repo.git");
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      else if (args.includes("worktree") && args.includes("add")) await mkdir(args.at(-2)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) return args.includes("--git-common-dir") ? bare : TEST_OID;
      return "";
    });
    const firstId = randomUUID();
    const first = await provisioner.provision({
      repo: "repo",
      workAttemptId: firstId,
      taskId: "first",
      remoteUrl: "https://example.invalid/repo.git",
      revision: TEST_OID,
    });
    const retained = await acquireWorkspaceFence(first.path, "live-supervisor", 1, "shared");
    try {
      const secondId = randomUUID();
      const second = await provisioner.provision({
        repo: "repo",
        workAttemptId: secondId,
        taskId: "second",
        remoteUrl: "https://example.invalid/repo.git",
        revision: TEST_OID,
      });
      assert.equal(second.path, join(env.root, "worktrees", "repo", secondId));
      assert.equal((await stat(second.path)).isDirectory(), true);
    } finally { await retained.release(); }
  } finally { await env.cleanup(); }
});

test("target-exclusive provisioning remains mutually exclusive for the same workspace", async () => {
  const env = await fixture();
  try {
    const target = join(env.root, "worktrees", "repo", randomUUID());
    const sibling = join(env.root, "worktrees", "repo", randomUUID());
    let siblingRan = false;
    await withWorkspaceFence(target, async () => {
      await assert.rejects(() => withWorkspaceFence(target, async () => undefined), /fenced by a live supervisor generation/);
      await assert.rejects(
        () => acquireWorkspaceFence(target, "generation-during-provision", 1, "shared"),
        /fenced by a live supervisor generation/,
      );
      await withWorkspaceFence(sibling, async () => { siblingRan = true; });
    });
    assert.equal(siblingRan, true, "a distinct target remains independently provisionable");

    siblingRan = false;
    const retained = await acquireWorkspaceFence(target, "live-generation", 1, "shared");
    try {
      await assert.rejects(() => withWorkspaceFence(target, async () => undefined), /fenced by a live supervisor generation/);
      await withWorkspaceFence(sibling, async () => { siblingRan = true; });
    } finally { await retained.release(); }
    assert.equal(siblingRan, true, "a sibling remains provisionable beside a retained generation");
  } finally { await env.cleanup(); }
});

test("repo-exclusive GC authority conflicts with every live fence in both acquisition orders", async () => {
  const env = await fixture();
  try {
    const active = join(env.root, "worktrees", "repo", randomUUID());
    const doomed = join(env.root, "worktrees", "repo", randomUUID());
    const retained = await acquireWorkspaceFence(active, "live-supervisor", 1, "shared");
    try {
      await assert.rejects(
        () => acquireWorkspaceFence(doomed, "gc", 1, "exclusive", "repo"),
        /fenced by a live supervisor generation/,
      );
    } finally { await retained.release(); }

    const gc = await acquireWorkspaceFence(doomed, "gc", 1, "exclusive", "repo");
    try {
      await assert.rejects(
        () => withWorkspaceFence(active, async () => undefined),
        /fenced by a live supervisor generation/,
      );
      await assert.rejects(
        () => acquireWorkspaceFence(active, "successor-supervisor", 2, "shared"),
        /fenced by a live supervisor generation/,
      );
    } finally { await gc.release(); }
  } finally { await env.cleanup(); }
});

test("workspace fences remove stale PIDs and treat live pre-scope records as repo-wide", async () => {
  const env = await fixture();
  try {
    const target = join(env.root, "worktrees", "repo", randomUUID());
    const sibling = join(env.root, "worktrees", "repo", randomUUID());
    const directory = join(dirname(target), ".letagents-supervisor-workspace.fences");
    await mkdir(directory, { recursive: true });
    const legacyRecord = (pid: number) => JSON.stringify({
      owner: "legacy-daemon",
      generation: 1,
      pid,
      workspace_path: target,
      mode: "exclusive",
      created_at: "2026-07-16T00:00:00.000Z",
    });

    const stalePath = join(directory, "exclusive-stale.json");
    await writeFile(stalePath, legacyRecord(2_147_483_647));
    let ran = false;
    await withWorkspaceFence(target, async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal((await readdir(directory)).includes("exclusive-stale.json"), false);

    const livePath = join(directory, "exclusive-live-legacy.json");
    await writeFile(livePath, legacyRecord(process.pid));
    try {
      await assert.rejects(
        () => withWorkspaceFence(sibling, async () => undefined),
        /fenced by a live supervisor generation/,
      );
    } finally { await rm(livePath, { force: true }); }
  } finally { await env.cleanup(); }
});

test("workspace fences and terminal attestation protect clean GC", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" }), /terminal attestation/);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await withWorkspaceFence(workspace.path, async () => {
      assert.deepEqual(await store.garbageCollect(0), []);
      assert.equal((await stat(workspace.path)).isDirectory(), true);
    });
  } finally { await env.cleanup(); }
});

test("retained shared fences permit concurrent work and prevent GC from deleting a swapped active workspace", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const activeWorkspace = await provisionedWorkspace(env.root, "active");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const active = await store.createAttempt({ taskId: "active", leaseId: "lease-active", leaseEpoch: 1, workspacePath: activeWorkspace.path, workAttemptId: activeWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    const activeGeneration = await store.startGeneration(active.work_attempt_id, "daemon", 1);
    // Independent supervisor generations share read authority instead of
    // serializing all agents behind a global exclusive lock.
    const secondWorkspace = await provisionedWorkspace(env.root, "second");
    const second = await store.createAttempt({ taskId: "second", leaseId: "lease-second", leaseEpoch: 1, workspacePath: secondWorkspace.path, workAttemptId: secondWorkspace.id });
    await store.startGeneration(second.work_attempt_id, "daemon", 1);
    assert.equal((await readdir(join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences"))).filter((name) => name.startsWith("shared-")).length, 2);
    // Simulate an uncooperative filesystem attacker: it does not acquire any
    // helper fence. GC must fail closed before it can act on either pathname.
    await rm(doomedWorkspace.path, { recursive: true });
    await symlink(activeWorkspace.path, doomedWorkspace.path);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await stat(activeWorkspace.path)).isDirectory(), true);
    await store.recordTerminal(active.work_attempt_id, activeGeneration.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
  } finally { await env.cleanup(); }
});

test("worker binding cursor survives an exact-session generation rebind and fences stale writers", async () => {
  const env = await fixture();
  try {
    const store = new WorkerBindingStore(join(env.root, "worker-bindings.json"));
    await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_1",
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: "https://letagents.chat",
    });
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2819");
    const internals = store as unknown as { write: (value: unknown) => Promise<void> };
    const originalWrite = internals.write.bind(internals);
    let writes = 0;
    internals.write = async (value) => { writes += 1; await originalWrite(value); };
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2819");
    assert.equal(writes, 0, "a repeated empty poll cursor performs no credential-store write");
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2820")).advanced, true);
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2818")).advanced, false);
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2820", "out-of-order compatibility evidence cannot regress progress");
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2822");
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2821")).advanced, false);
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2822", "a newer formal response checkpoint wins over delayed compatibility evidence");
    let verifiedPredecessorGeneration: string | null = null;
    const reboundResult = await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact",
      roomId: "focus_37",
      workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_1",
      toExecutionGenerationId: "execution_2",
      agentSessionId: "agent_session_exact",
    }, async ({ binding }) => {
      verifiedPredecessorGeneration = binding.execution_generation_id;
      return { accepted: true };
    });
    const rebound = reboundResult.binding;
    assert.equal(verifiedPredecessorGeneration, "execution_1", "credential verification runs before durable generation mutation");
    assert.equal(rebound.room_cursor, "msg_2822");
    assert.equal(await store.credentialFor(rebound), "session-secret", "generation rollover preserves only the private in-memory authority");
    let racedVerificationCalled = false;
    assert.equal((await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_1", toExecutionGenerationId: "execution_2",
      agentSessionId: "agent_session_exact",
    }, async () => { racedVerificationCalled = true; return { accepted: true }; })).binding.execution_generation_id, "execution_2", "a formal bind winning the successor race is idempotent");
    assert.equal(racedVerificationCalled, false);
    const rejectedRollover = await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => ({ accepted: false }));
    assert.equal(rejectedRollover.advanced, false);
    assert.equal((await store.get("entry_exact"))?.execution_generation_id, "execution_2", "rejected verification preserves predecessor authority");
    await assert.rejects(store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => { throw new Error("verification timeout"); }), /verification timeout/);
    assert.equal((await store.get("entry_exact"))?.execution_generation_id, "execution_2", "verification timeout preserves predecessor authority");
    await assert.rejects(store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_other", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => ({ accepted: true })), /does not match the durable worker identity/);
    await assert.rejects(
      store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_stale"),
      /does not match the active supervised binding/,
    );
    await store.bind({
      entry_id: "entry_peer_b",
      room_id: "focus_37",
      work_attempt_id: "attempt_peer_b",
      execution_generation_id: "execution_peer_b",
      agent_session_id: "agent_session_peer_b",
      agent_session_token: "peer-b-secret",
      api_url: "https://letagents.chat",
    });
    await store.checkpointCursor("entry_peer_b", "agent_session_peer_b", "execution_peer_b", "msg_peer_b");
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2822", "peer B cannot advance peer A's same-room cursor");
    assert.equal((await store.get("entry_peer_b"))?.room_cursor, "msg_peer_b");

    const replacementIdentity = await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_3",
      agent_session_id: "agent_session_other",
      agent_session_token: "other-secret",
      api_url: "https://letagents.chat",
    });
    assert.equal(replacementIdentity.room_cursor, null, "a different worker identity cannot inherit another session's cursor");
  } finally {
    await env.cleanup();
  }
});

test("one retained supervisor handle survives terminal, rebind, and successor start", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const first = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const fenceDirectory = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    const held = (await readdir(fenceDirectory)).find((name) => name.startsWith("shared-"));
    assert.ok(held);
    await store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).join(), held, "handoff must retain the same fence record without a release/reacquire gap");
  } finally { await env.cleanup(); }
});

test("a live fence in an unrelated repository does not starve safe GC", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    const unrelated = join(env.root, "worktrees", "other-repo", randomUUID());
    await mkdir(unrelated, { recursive: true });
    const live = await acquireWorkspaceFence(unrelated, "other-supervisor", 1, "shared");
    try { assert.deepEqual(await store.garbageCollect(0), [attempt.work_attempt_id]); }
    finally { await live.release(); }
  } finally { await env.cleanup(); }
});

test("supervisor quiescence lets same-repository GC progress without stopping live work", async () => {
  const env = await fixture();
  let quiesced: string[] = [];
  let resumed = false;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async (attempts) => { quiesced = attempts.map((attempt) => attempt.work_attempt_id); return async () => { resumed = true; }; }, TEST_SUPERVISOR,
    );
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), [doomed.work_attempt_id]);
    assert.deepEqual(quiesced, [live.work_attempt_id]);
    assert.equal(resumed, true);
    assert.equal((await stat(liveWorkspace.path)).isDirectory(), true);
    assert.equal((await readdir(join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences"))).filter((name) => name.startsWith("shared-")).length, 1, "live generation fence is restored before it resumes");
  } finally { await env.cleanup(); }
});

test("quiescence failures never resume a partially unfenced live generation", async () => {
  const env = await fixture();
  let resumed = 0;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { resumed += 1; }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
      { before_release: async (_attempt, index) => { if (index === 1) throw new Error("injected partial-release failure"); } },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const firstWorkspace = await provisionedWorkspace(env.root, "first");
    const secondWorkspace = await provisionedWorkspace(env.root, "second");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const first = await store.createAttempt({ taskId: "first", leaseId: "lease-first", leaseEpoch: 1, workspacePath: firstWorkspace.path, workAttemptId: firstWorkspace.id });
    const second = await store.createAttempt({ taskId: "second", leaseId: "lease-second", leaseEpoch: 1, workspacePath: secondWorkspace.path, workAttemptId: secondWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(first.work_attempt_id, "daemon", 1);
    await store.startGeneration(second.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal(resumed, 0);
    assert.equal((await store.getAttempt(first.work_attempt_id)).state, "coordination_blocked");
    assert.equal((await store.getAttempt(second.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("quiescence restore failure never resumes unfenced work", async () => {
  const env = await fixture();
  let resumed = 0;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { resumed += 1; }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
      { before_restore: async () => { throw new Error("injected restore failure"); } },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal(resumed, 0);
    assert.equal((await store.getAttempt(live.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("quiescence resume failure blocks the live attempt", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { throw new Error("injected resume failure"); }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await store.getAttempt(live.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("providerStreamLifecycle reads an Open Model provider retry notice as ordinary work", () => {
  const notice = {
    workAttemptId: "attempt", providerContinuationId: "session", observedAt: "2026-09-28T00:00:00.000Z",
    sequence: 1, provider: "open-model", kind: "provider_event", method: "letagents/providerRetry",
    summary: "The model provider returned an error. Retrying (attempt 2).",
    payload: { kind: "provider_retry", turnId: "msg_1", attempt: 2, message: "Rate limit exceeded", nextRetryAt: "2026-09-28T00:00:04.000Z" },
    payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null,
  } as const;
  // The notice describes a provider error, but the turn is still running.
  // Reading it as failed would fence the runtime; as idle, hide the agent.
  assert.equal(providerStreamLifecycle(notice), "working");
  assert.equal(providerStreamLifecycle(notice, true), "working");
  assert.equal(isHumanRoomActivityEvent(notice), true, "the notice is recorded as activity");
});

test("providerStreamLifecycle never fails the agent on a tool call's own error status", () => {
  const base = { workAttemptId: "attempt", providerContinuationId: "thread", observedAt: "2026-08-01T00:00:00.000Z", sequence: 1, provider: "open-model", summary: null, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null };
  // The #860 Live-tab emitToolCall path: a tool with status "error" (a tool
  // crash, a permission denial, or a tool aborted by a Stop). This must NOT
  // classify the whole agent as failed — that would SIGKILL the OpenCode server
  // mid-turn (and, once stop-then-resend coexists, kill the session the
  // correction was about to resume on).
  assert.equal(providerStreamLifecycle({ ...base, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { status: "error", partId: "tool-1" } }), "working");
  assert.equal(providerStreamLifecycle({ ...base, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { status: "running", partId: "tool-1" } }), "working");
  // A failed Codex turn leaves its reusable runtime available. Genuine process
  // failures still classify failed.
  assert.equal(providerStreamLifecycle({ ...base, provider: "codex", kind: "turn_lifecycle", method: "turn/failed", payload: {} }), "terminal");
  assert.equal(providerStreamLifecycle({ ...base, kind: "error", method: "result", payload: { is_error: true } }), "failed");
  assert.equal(providerStreamLifecycle({ ...base, provider: "codex", kind: "command_output", method: "process/systemError", payload: { status: "systemError" } }), "failed");
});

test("all approval settlement callers schedule fault-only recovery under current daemon authority", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      store: ManifestStore; handoffScheduled: boolean;
      settleRuntimeApprovals(id: string): Promise<void>;
      scheduleRecoveryConvergence(id: string, delay: number): void;
    };
    const retries: string[] = [];
    internals.scheduleRecoveryConvergence = (id, delay) => { assert.equal(delay, 5_000); retries.push(id); };
    let fail = false;
    internals.store.settleWitnessedRuntimeApprovalClosures = async () => {
      if (fail) throw new Error("transient closure write");
      return 0;
    };
    await internals.settleRuntimeApprovals("first-convergence-without-terminal");
    assert.deepEqual(retries, []);
    fail = true;
    for (const caller of ["exit", "attach-after-terminal-persistence", "manual-recovery", "retry-convergence"]) {
      await assert.rejects(internals.settleRuntimeApprovals(caller), /transient closure write/);
    }
    assert.deepEqual(retries, ["exit", "attach-after-terminal-persistence", "manual-recovery", "retry-convergence"]);
    fail = false;
    await internals.settleRuntimeApprovals("healthy-again");
    assert.equal(retries.length, 4);
    internals.handoffScheduled = true; fail = true;
    await assert.rejects(internals.settleRuntimeApprovals("retired"), /transient closure write/);
    assert.equal(retries.length, 4, "handoff cannot retry under retired authority");
    internals.handoffScheduled = false;
  } finally { await daemon.stop().catch(() => undefined); await env.cleanup(); }
});

test("worker lease HTTP uses complete worker-scoped inventory and exact grant-fenced transfer receipts", async () => {
  const calls: Array<{ url: string; authorization: string | undefined; generation: string | string[] | undefined; body: Record<string, unknown> }> = [];
  const lease = { id: "lease-1", room_id: "owner/repo", task_id: "task_1", kind: "work", status: "active", epoch: 3,
    agent_session_id: "old-session", agent_key: "owner/agent", agent_instance_id: "daemon:agent" };
  const proof = { id: "proof", lease_id: lease.id, epoch: 3, from_agent_session_id: "old-session", grant_id: "grant",
    supervisor_generation: 2, work_attempt_id: "attempt", execution_generation_id: "execution", cause: "killed", consumed_at: null };
  let wrongReceipt = false;
  let brokenPage = false;
  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ url: request.url!, authorization: request.headers.authorization, generation: request.headers["x-letagents-supervisor-generation"], body });
    response.setHeader("content-type", "application/json");
    if (request.url!.endsWith("/attestation")) return response.end(JSON.stringify({ ...proof, ...(wrongReceipt ? { execution_generation_id: "different" } : {}) }));
    if (request.url!.endsWith("/rebind")) return response.end(JSON.stringify({ ...lease, agent_session_id: "new-session", epoch: wrongReceipt ? 9 : 4 }));
    if (request.url!.endsWith("/tasks/task_1")) return response.end(JSON.stringify({ id: "task_1", room_id: "owner/repo", status: "in_review", active_leases: [lease] }));
    if (request.url!.includes("after=task_1")) return response.end(JSON.stringify({ room_id: "owner/repo", tasks: [{ id: "task_2", room_id: "owner/repo", status: "merged", active_leases: [{ ...lease, kind: "review", id: "review", task_id: "task_2" }] }], has_more: false }));
    response.end(JSON.stringify({ room_id: "owner/repo", tasks: [{ id: "task_1", room_id: "owner/repo", status: "in_review", active_leases: [lease] }], ...(brokenPage ? {} : { has_more: true }) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = { apiUrl, roomId: "owner/repo", bearer: "worker-secret" };
    const inventory = await productionSupervisorGrantHttp.listWorkLeases!(read);
    assert.equal(inventory.length, 1, "In review work is retained, review leases are not rebound");
    assert.ok(calls.slice(0, 2).every(call => call.authorization === "Bearer worker-secret" && !call.url.includes("open=") && !call.url.includes("status=")));
    assert.equal(calls[1]!.url, "/rooms/owner/repo/tasks?limit=100&after=task_1");
    assert.deepEqual(await productionSupervisorGrantHttp.readWorkLease!({ ...read, taskId: "task_1", leaseId: "lease-1" }), inventory[0]);
    const mutation = { apiUrl, grantId: "grant", supervisorGrant: "grant-secret", grantGeneration: 2,
      lease: inventory[0]!, workAttemptId: "attempt", executionGenerationId: "execution", cause: "killed" as const };
    assert.equal(await productionSupervisorGrantHttp.attestWorkLease!(mutation), "proof");
    proof.supervisor_generation = 1;
    assert.equal(await productionSupervisorGrantHttp.attestWorkLease!(mutation), "proof", "same-grant historical evidence survives handoff unchanged");
    for (const generation of [3, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      proof.supervisor_generation = generation;
      await assert.rejects(productionSupervisorGrantHttp.attestWorkLease!(mutation), /different proof/, "future or malformed evidence is never accepted");
    }
    proof.supervisor_generation = 2;
    assert.equal((await productionSupervisorGrantHttp.rebindWorkLease!({ ...mutation, attestationId: "proof", toSessionId: "new-session" })).epoch, 4);
    assert.ok(calls.slice(-2).every(call => call.authorization === "Bearer grant-secret" && call.generation === "2"));
    assert.deepEqual(calls.at(-1)!.body, { expected_epoch: 3, from_agent_session_id: "old-session", to_agent_session_id: "new-session",
      work_attempt_id: "attempt", execution_generation_id: "execution", attestation_id: "proof" });
    wrongReceipt = true;
    await assert.rejects(productionSupervisorGrantHttp.attestWorkLease!(mutation), /different proof/);
    await assert.rejects(productionSupervisorGrantHttp.rebindWorkLease!({ ...mutation, attestationId: "proof", toSessionId: "new-session" }), /different successor/);
    brokenPage = true;
    await assert.rejects(productionSupervisorGrantHttp.listWorkLeases!(read), /incomplete/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("unchanged delegation replays do not restart a failed provider, but committed changes remain eligible", { timeout: 15_000 * WAIT_SCALE }, async () => {
  const env = await fixture();
  const id = "unchanged-delegation";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
  });
  await durability.close();
  let spawns = 0;
  let inventories = 0;
  const wakes: string[] = [];
  const createdAtMs = Date.now();
  const remoteDelegation = {
    delegationInstanceId: "inert-existing-delegation", revision: 1, ownerAccountId: "inert-owner",
    roomId: "room-inert", agentKey: "owner/inert", approverAccountId: "inert-approver",
    category: "file_change", riskCeiling: "low", scopeSha256: "a".repeat(64),
    createdAtMs, expiresAtMs: createdAtMs + 60_000, revokedAtMs: null,
  };
  const unexpected = async () => { throw new Error("Unexpected native operation in inert fixture"); };
  const port = {
    capabilities: async () => ({ deliveryModes: ["daemon_inbox"], resume: false, midTurnInjection: false,
      transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { spawns++; throw new Error("inert bootstrap failure"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: unexpected, poke: unexpected, stop: unexpected,
    onExit: async () => () => {}, onStream: async () => () => {}, runtimeCustody: () => ({ state: "absent" }),
  };
  const http = new Proxy({
    createWorkerSession: async () => ({ sessionId: "inert-session", bearer: "inert-bearer",
      bearerId: "inert-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" }),
    listWorkLeases: async () => [], readWorkLease: async () => null,
    listExecutionDelegationIds: async () => {
      inventories++;
      return { delegationInstanceIds: [remoteDelegation.delegationInstanceId], nextCursor: null };
    },
    getExecutionDelegation: async () => structuredClone(remoteDelegation),
    listExecutionDelegationDecisionIds: async () => ({ decisionIds: [], nextCursor: null }),
  }, { get: (target, key) => key in target ? (target as any)[key] : async () => {
    throw new Error(`Unexpected HTTP boundary ${String(key)}`);
  } });
  const daemon = new ProductionSupervisorDaemon(paths, "darwin", port as any, true, 15_000, undefined, {},
    { poll: async () => ({ messages: [] }), publish: async () => {} } as any, http as any);
  try {
    await daemon.start();
    const internals = daemon as any;
    internals.publishNativeActivity = async () => true;
    const original = internals.requestConvergence.bind(daemon);
    internals.requestConvergence = (entryId: string, kind?: string) => {
      wakes.push(kind ?? "owned");
      original(entryId, kind);
    };
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      id, room_id: "room-inert", display_name: "Inert", provider: "codex", model: null, charter: "fixture",
      desired_state: "running", observed_state: "absent", condition: "none", permission_profile_id: "full_access",
      created_by: "fixture", created_at: new Date().toISOString(), delivery_mode: "daemon_inbox",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    assert.equal(put.ok, true, put.error);
    await admitDaemonInboxForProviderTest(daemon, id, "room-inert");
    await internals.providerExecution.drainConvergence();
    assert.equal(spawns, 0);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as any).generation;
    const grant = {
      entry_id: id, room_id: "room-inert", agent_key: "owner/inert", grant_id: "inert-grant", supervisor_grant: "inert-parent",
      grant_generation: 1, api_url: "https://example.test", daemon_generation: generation, host_id: "inert-host",
      installation_id: "inert-installation", owner_account_id: "inert-owner", scope_key: "owner",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
    };
    async function flush() {
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      const sync = internals.executionDelegations.grants;
      await Promise.all([...sync.lanes.values(), ...sync.roomLanes.values()].map((lane: any) => lane.promise));
      await internals.providerExecution.drainConvergence();
    }
    async function install(value = grant) {
      const result = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", value);
      assert.equal(result.ok, true, result.error);
      assert.equal((result.result as any).status, "installed");
      await flush();
    }
    function snapshot() {
      const db = new DatabaseSync(paths.manifestPath, { readOnly: true });
      try {
        return JSON.stringify(db.prepare("SELECT * FROM execution_local_delegations ORDER BY delegation_instance_id,revision").all());
      } finally { db.close(); }
    }
    await install();
    assert.ok(spawns >= 1);
    assert.ok(inventories >= 1);
    const firstSpawns = spawns;
    const before = snapshot();
    assert.equal(JSON.parse(before).length, 1);
    const initialWakes = wakes.length;
    await install();
    await install();
    internals.executionDelegations.requestRoom("room-inert");
    await flush();
    assert.equal(snapshot(), before, "every delegation authority column must remain unchanged on exact replay");
    assert.ok(wakes.length > initialWakes);
    assert.ok(wakes.slice(initialWakes).every(kind => kind === "rehydration"));
    assert.equal(spawns, firstSpawns, "unchanged exact delegation replay must not restart failed native admission");

    remoteDelegation.revision = 2;
    remoteDelegation.scopeSha256 = "b".repeat(64);
    remoteDelegation.createdAtMs = Date.now();
    remoteDelegation.expiresAtMs = remoteDelegation.createdAtMs + 60_000;
    await install();
    assert.equal(spawns, firstSpawns + 1, "a committed new revision remains eligible");
    await install();
    assert.equal(spawns, firstSpawns + 1, "the new revision is then suppressed on replay");
    await install({ ...grant, grant_generation: 2 });
    assert.equal(spawns, firstSpawns + 2, "changed grant inputs remain eligible even when the delegation row is unchanged");
    await install({ ...grant, grant_generation: 2 });
    assert.equal(spawns, firstSpawns + 2);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});


test("read model projects child compaction before admission without changing durable lifecycle", async () => {
  let progress: { state: "compacting"; startedAt: string } | null = { state: "compacting", startedAt: "2026-09-24T00:00:00Z" };
  const model = new DaemonReadModel({
    currentDaemonGeneration: () => 1, nowMs: () => Date.parse("2026-09-24T00:00:01Z"), startedAt: "2026-09-24T00:00:00Z",
    capabilities: { hasDelivery: () => false, supportsRoomTurns: () => true, supportsContinuationRepair: () => false },
    recoveryDiagnostics: () => { throw new Error("not part of progress projection"); }, deliveryAdmission: () => null,
    compactionProgress: candidate => { assert.equal(candidate.work_attempt_id, "compaction-attempt"); return progress; },
    manifest: { load: async () => ({ entries: [] }), getEntry: async () => undefined, pendingRuntimeRecovery: async () => null, getAgentConfiguration: async () => undefined },
    bindings: { credentialFor: async () => null, get: async () => null, list: async () => [] },
    inbox: { detail: async () => { throw new Error("unused"); }, ingressHealth: async () => null,
      latestContinuationRepair: async () => null, receiptProjection: async () => [] },
    durability: { getAttempt: async () => null },
    workerAuthority: { currentHostGrant: () => null, pollingContract: async () => null },
    liveHandles: new Map(), delivery: null,
  });
  const starting: DaemonManifestEntry = { ...entry, provider: "claude-code", desired_state: "running",
    observed_state: "starting", condition: "none", work_attempt_id: "compaction-attempt", provider_ref: undefined };
  const before = structuredClone(starting);
  const projected = await model.entryWithDerivedLiveness(starting);
  assert.deepEqual(projected.provider_progress, progress);
  assert.equal(projected.observed_state, "starting");
  assert.equal(projected.provider_ref, undefined);
  assert.equal(projected.ready_reached_at, undefined);
  assert.deepEqual(starting, before);
  for (const patch of [{ desired_state: "paused" }, { observed_state: "failed" }, { condition: "coordination_blocked" }] as Partial<DaemonManifestEntry>[]) {
    assert.equal((await model.entryWithDerivedLiveness({ ...starting, ...patch })).provider_progress, null);
  }
  progress = null;
  assert.equal((await model.entryWithDerivedLiveness(starting)).provider_progress, null);
});

test("read model projects live launch progress only for an agent meant to run", async () => {
  const progress = { started_at: "2026-10-26T00:00:00.000Z", state: "running" as const, current: "slot_wait" as const,
    phases: [{ phase: "prepare" as const, started_at: "2026-10-26T00:00:00.000Z", ms: 40 },
      { phase: "slot_wait" as const, started_at: "2026-10-26T00:00:00.040Z", ms: null }],
    ended_at: null, first_output_at: null, failure: null, slot_ahead: 2 };
  const model = new DaemonReadModel({
    currentDaemonGeneration: () => 1, nowMs: () => Date.parse("2026-10-26T00:00:01Z"), startedAt: "2026-10-26T00:00:00Z",
    capabilities: { hasDelivery: () => false, supportsRoomTurns: () => true, supportsContinuationRepair: () => false },
    recoveryDiagnostics: () => { throw new Error("not part of progress projection"); }, deliveryAdmission: () => null,
    launchProgress: candidate => { assert.equal(candidate.id, entry.id); return progress; },
    manifest: { load: async () => ({ entries: [] }), getEntry: async () => undefined, pendingRuntimeRecovery: async () => null, getAgentConfiguration: async () => undefined },
    bindings: { credentialFor: async () => null, get: async () => null, list: async () => [] },
    inbox: { detail: async () => { throw new Error("unused"); }, ingressHealth: async () => null,
      latestContinuationRepair: async () => null, receiptProjection: async () => [] },
    durability: { getAttempt: async () => null },
    workerAuthority: { currentHostGrant: () => null, pollingContract: async () => null },
    liveHandles: new Map(), delivery: null,
  });
  const starting: DaemonManifestEntry = { ...entry, provider: "claude-code", desired_state: "running",
    observed_state: "starting", condition: "none", provider_ref: undefined };
  assert.deepEqual((await model.entryWithDerivedLiveness(starting)).launch_progress, progress);
  assert.equal((await model.entryWithDerivedLiveness({ ...starting, desired_state: "stopped" })).launch_progress, null);
});

test("inspector usage is read for the exact live continuation and drops races during the read", async () => {
  for (const mutation of ["none", "room", "continuation", "execution", "daemon", "handle", "failure"] as const) {
    const handle = { workAttemptId: "usage-attempt", providerContinuationId: "thread" } as any;
    let current: DaemonManifestEntry = { ...entry, id: "usage-agent", room_id: "usage-room", work_attempt_id: "usage-attempt",
      provider_ref: { work_attempt_id: "usage-attempt", provider_continuation_id: "thread", execution_generation_id: "execution", provider_connection: null } };
    let generation = 4;
    const handles = new Map([[current.id, handle]]);
    const usage = { providerContinuationId: "thread", account: { state: "available", windows: [] }, context: null, compaction: null };
    const model = new DaemonReadModel({
      manifest: { getEntry: async () => current }, currentDaemonGeneration: () => generation, liveHandles: handles,
      inbox: { detail: async () => ({ availability: "not_loaded" }) },
      readUsage: async (received: any) => {
        assert.equal(received, handle);
        if (mutation === "room") current = { ...current, room_id: "another-room" };
        if (mutation === "continuation") current = { ...current, provider_ref: { ...current.provider_ref!, provider_continuation_id: "replacement" } };
        if (mutation === "execution") current = { ...current, provider_ref: { ...current.provider_ref!, execution_generation_id: "replacement" } };
        if (mutation === "daemon") generation++;
        if (mutation === "handle") handles.set(current.id, { ...handle });
        if (mutation === "failure") throw new Error("provider unavailable");
        return usage;
      },
    } as any);
    const result = await model.inspectorDetail(current.id, "usage-room", null);
    assert.deepEqual(result.usage, mutation === "none" ? { ...usage, executionGenerationId: "execution", daemonGeneration: 4 } : null, mutation);
    assert.equal(result.availability, "not_loaded", "usage failures do not break retained Work detail");
  }
});
