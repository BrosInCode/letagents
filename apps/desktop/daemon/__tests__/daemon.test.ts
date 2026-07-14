import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
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
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:0${tick++}.000Z`);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: join(env.root, "workspace") });
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_12", provider_continuation_id: "provider-1" });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const terminal = { ended_at: "2026-01-01T00:00:09.000Z", exit_code: 137, signal: "SIGKILL", stdio_archive_ref: "stdio.log.1.archive", stdio_tail: "last line", terminal_cause: "crash", actor: "daemon", generation: 1, provider_continuation_id: "provider-1" };
    const storedTerminal = await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, stdio_tail: "x".repeat(20) }, 8);
    assert.equal(storedTerminal.terminal?.stdio_tail, "x".repeat(8));
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal), ImmutableExecutionError);
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    const resumed = await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).workspace_path, join(env.root, "workspace"));
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).epoch_history.length, 2);
    assert.equal(resumed.generation, 2);
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "reviewed", postmortemDiff: "diff --git a/a b/a" });
    await assert.rejects(() => store.rebindAttempt(attempt.work_attempt_id, "lease-3", 3), ImmutableExecutionError);
  } finally { await env.cleanup(); }
});

test("stdio rotates append-only and GC protects active, ambiguous, quarantined, and unreviewed attempts", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`);
    const create = async () => {
      const workspace = join(env.root, `workspace-${tick}`); await mkdir(workspace, { recursive: true });
      return store.createAttempt({ taskId: "task", leaseId: `lease-${tick}`, leaseEpoch: 1, workspacePath: workspace });
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
    });
    assert.throws(() => provisioner.workspacePath("../dev", "attempt"), /Unsafe repository/);
    const first = await provisioner.provision({ repo: "repo", workAttemptId: "attempt-1", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    const second = await provisioner.provision({ repo: "repo", workAttemptId: "attempt-1", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(commands.length, 2);
    assert.match(first.path, /worktrees\/repo\/attempt-1$/);
    assert.ok(commands[0]!.includes("--bare"));
  } finally { await env.cleanup(); }
});
