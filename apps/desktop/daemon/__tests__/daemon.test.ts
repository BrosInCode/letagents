import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { AuditLog } from "../audit-log.js";
import { DaemonControlSocket } from "../control-socket.js";
import { ImmutableExecutionError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisorDaemon } from "../main.js";
import { assertMacOS } from "../platform.js";
import { DaemonAlreadyRunningError, DaemonFenceLostError, DaemonSingleton } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";
import { WorkspaceProvisioner } from "../workspace-provisioner.js";
import { withWorkspaceFence } from "../workspace-fence.js";

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

const TEST_OID = "a".repeat(40);
async function provisionedWorkspace(root: string, taskId = "task", workAttemptId = randomUUID()): Promise<{ path: string; id: string; bare: string }> {
  const bare = join(root, "repos", "repo.git");
  const path = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: taskId, remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  return { path, id: workAttemptId, bare };
}
function fakeGit(root: string): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args.includes("--git-common-dir")) return join(root, "repos", "repo.git");
    if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
    if (args.includes("--is-bare-repository")) return "true";
    if (args.includes("cat-file")) return "ok";
    if (args.includes("rev-parse")) return TEST_OID;
    return "";
  };
}

const entry: DaemonManifestEntry = {
  id: "agent_1", room_id: "room_1", display_name: "Agent", provider: "test", model: null, charter: "test",
  desired_state: "running", observed_state: "idle", condition: "none", permission_profile_id: null, created_by: "test", created_at: "2026-01-01T00:00:00.000Z",
};

test("daemon is visibly gated to macOS", () => {
  assert.throws(() => assertMacOS("linux"), /macOS only/);
});

test("singleton fences a second daemon and detects a newer generation", async () => {
  const env = await fixture();
  try {
    const lock = join(env.root, "daemon.lock");
    const first = new DaemonSingleton(lock, "darwin");
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => new DaemonSingleton(lock, "darwin").acquire(), DaemonAlreadyRunningError);
    await writeFile(`${lock}.generation`, "2\n");
    await assert.rejects(() => first.assertCurrent(), DaemonFenceLostError);
    await first.release();
    assert.equal((await stat(lock)).isFile(), true, "persistent inode prevents post-release unlink races");
    await writeFile(`${lock}.generation`, "partial");
    const second = new DaemonSingleton(join(env.root, "second.lock"), "darwin");
    await second.acquire();
    await writeFile(`${join(env.root, "second.lock")}.generation`, "partial");
    await assert.rejects(() => second.assertCurrent(), /malformed/);
    await second.release();
  } finally { await env.cleanup(); }
});

test("manifest writes CAS, fsync/rename payloads, and quarantines corruption", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "manifest.json");
    const store = new ManifestStore(path);
    const saved = await store.write(0, [entry]);
    assert.equal(saved.generation, 1);
    await assert.rejects(() => store.write(0, []), ManifestConflictError);
    const concurrent = await Promise.allSettled([store.write(1, [{ ...entry, id: "left" }]), store.write(1, [{ ...entry, id: "right" }])]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof ManifestConflictError).length, 1);
    await writeFile(path, '{"manifest":{"generation":7},"checksum":"bad"}');
    assert.deepEqual(await store.load(), { generation: 0, entries: [] });
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("manifest.json.corrupt-")));
  } finally { await env.cleanup(); }
});

test("audit transitions append and rotate instead of truncating", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "audit.jsonl");
    const log = new AuditLog(path, 1);
    await log.append({ at: "2026-01-01T00:00:00.000Z", entry_id: "agent", from: "idle", to: "recovering", cause: "test", actor: "test", generation: 1 });
    await log.append({ at: "2026-01-01T00:00:01.000Z", entry_id: "agent", from: "recovering", to: "idle", cause: "test", actor: "test", generation: 2 });
    const names = await readdir(env.root);
    assert.ok(names.some((name) => name.startsWith("audit.jsonl.") && name.endsWith(".archive")));
    assert.match(await readFile(path, "utf8"), /"generation":2/);
  } finally { await env.cleanup(); }
});

test("control socket rejects protocol mismatch explicitly", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "daemon.sock");
    const socket = new DaemonControlSocket(socketPath, () => ({ healthy: true }));
    await chmod(env.root, 0o755);
    await socket.start();
    assert.equal((await stat(env.root)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const response = await new Promise<string>((resolve, reject) => {
      const client = createConnection(socketPath);
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk) => { received += chunk; if (received.includes("\n")) { client.end(); resolve(received); } });
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION + 1, id: "bad", method: "manifest.list" }) + "\n"));
    });
    assert.match(response, /Protocol version mismatch/);
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("fence loss fatally stops the control endpoint", async () => {
  const env = await fixture();
  try {
    const lockPath = join(env.root, "fatal.lock");
    const socketPath = join(env.root, "fatal.sock");
    const daemon = new SupervisorDaemon({ lockPath, socketPath, manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await writeFile(`${lockPath}.generation`, "2\n");
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("error", reject);
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, method: "manifest.list" }) + "\n"));
      client.on("close", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("connect", () => resolve()); client.once("error", reject);
    }));
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("control socket bounds an oversized JSON-lines frame", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "bounded.sock");
    const socket = new DaemonControlSocket(socketPath, () => ({ ok: true }), undefined, 16);
    await socket.start();
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("error", reject);
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
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:0${tick++}.000Z`, join(env.root, "worktrees"));
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_12", provider_continuation_id: "provider-1" });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const terminal = { ended_at: "2026-01-01T00:00:09.000Z", exit_code: 137, signal: "SIGKILL", stdio_archive_ref: "stdio.log.1.archive", stdio_tail: "last line", terminal_cause: "crash", actor: "daemon", generation: 1, provider_continuation_id: "provider-1" };
    const storedTerminal = await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, stdio_tail: "x".repeat(20) }, 8);
    assert.equal(storedTerminal.terminal?.stdio_tail, "x".repeat(8));
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal), ImmutableExecutionError);
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    const resumed = await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).workspace_path, workspace.path);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).epoch_history.length, 2);
    assert.equal(resumed.generation, 2);
    await store.recordTerminal(attempt.work_attempt_id, resumed.execution_generation_id, { ended_at: "2026-01-01T00:00:10.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "done", terminal_cause: "completed", actor: "daemon", generation: 2, provider_continuation_id: null });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "reviewed", postmortemDiff: "diff --git a/a b/a" });
    await assert.rejects(() => store.rebindAttempt(attempt.work_attempt_id, "lease-3", 3), ImmutableExecutionError);
  } finally { await env.cleanup(); }
});

test("stdio rotates append-only and GC protects active, ambiguous, quarantined, and unreviewed attempts", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`, join(env.root, "worktrees"), undefined, fakeGit(env.root));
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
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      commands.push(args);
      if (args.includes("worktree")) await mkdir(args.at(-2)!, { recursive: true });
      else if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) {
        if (args.includes("--git-common-dir")) return join(env.root, "repos", "repo.git");
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
    assert.match(first.path, new RegExp(`worktrees/repo/${workAttemptId}$`));
    assert.ok(commands[0]!.includes("--bare"));
    await rm(join(first.path, ".letagents-work-attempt.json"));
    const recovered = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(recovered.reused, true, "an add-before-marker crash is recoverable");
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://token@example.invalid/repo.git", revision: "abc" }), /userinfo/);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://evil.invalid/repo.git", revision: "abc" }), /identity/);
    await rm(first.path, { recursive: true });
    const outside = join(env.root, "outside"); await mkdir(outside);
    await symlink(outside, first.path);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" }), /symlink/);
  } finally { await env.cleanup(); }
});

test("durability store validates destructive identities, serializes GC, and quarantines tampering", async () => {
  const env = await fixture();
  let releaseGc!: () => void;
  let reserved!: () => void;
  const gcReserved = new Promise<void>((resolve) => { reserved = resolve; });
  const gcRelease = new Promise<void>((resolve) => { releaseGc = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const store = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), async () => { reserved(); await gcRelease; }, fakeGit(env.root));
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
    assert.deepEqual(await recovered.garbageCollect(0), []);
    assert.equal((await stat(protectedWorkspace.path)).isDirectory(), true);
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));

    const legacyWorkspace = await provisionedWorkspace(env.root);
    const legacyStore = new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:02.000Z", join(env.root, "worktrees"));
    const legacyAttempt = await legacyStore.createAttempt({ taskId: "task", leaseId: "lease-3", leaseEpoch: 3, workspacePath: legacyWorkspace.path, workAttemptId: legacyWorkspace.id });
    await legacyStore.concludeAttempt(legacyAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    const legacy = JSON.parse(await readFile(join(env.root, "legacy-attempts.json"), "utf8"));
    await writeFile(join(env.root, "legacy-attempts.json"), JSON.stringify({ version: 1, attempts: legacy.attempts }));
    assert.equal((await (new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:03.000Z", join(env.root, "worktrees"))).getAttempt(legacyAttempt.work_attempt_id)).state, "unreviewed");
  } finally { await env.cleanup(); }
});

test("execution identities prohibit parallel, duplicate, and laundered terminal generations", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"));
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
    const first = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), async () => { reserved(); await blocked; }, fakeGit(env.root));
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await first.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    assert.match(await readFile(join(env.root, "attempt-data", attempt.work_attempt_id, "postmortem.diff"), "utf8"), /status --porcelain/);
    const collecting = first.garbageCollect(0); await entered;
    const recovery = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root));
    assert.deepEqual(await recovery.garbageCollect(99), [attempt.work_attempt_id], "pending GC must not be hidden behind retention");
    release(); await collecting;

    const mismatch = await provisionedWorkspace(env.root);
    let evilRemote = false;
    const guarded = new WorkDurabilityStore(join(env.root, "mismatch.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => evilRemote && args.includes("remote") ? "https://evil.invalid/repo.git" : await fakeGit(env.root)(args));
    const other = await guarded.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: mismatch.path, workAttemptId: mismatch.id });
    await guarded.concludeAttempt(other.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    evilRemote = true;
    assert.deepEqual(await guarded.garbageCollect(0), []);
    assert.equal((await stat(mismatch.path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("workspace fences and terminal attestation protect clean GC", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root));
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

test("a retained live-generation fence prevents GC from deleting a swapped active workspace", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root));
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const activeWorkspace = await provisionedWorkspace(env.root, "active");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const active = await store.createAttempt({ taskId: "active", leaseId: "lease-active", leaseEpoch: 1, workspacePath: activeWorkspace.path, workAttemptId: activeWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(active.work_attempt_id, "daemon", 1);
    // Simulate an uncooperative filesystem attacker: it does not acquire any
    // helper fence. GC must fail closed before it can act on either pathname.
    await rm(doomedWorkspace.path, { recursive: true });
    await symlink(activeWorkspace.path, doomedWorkspace.path);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await stat(activeWorkspace.path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});
