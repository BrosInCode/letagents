import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AuditLog } from "../audit-log.js";
import { DaemonControlSocket } from "../control-socket.js";
import { ImmutableExecutionError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisorDaemon, supervisedWaitCursorFromProviderEvent } from "../main.js";
import { assertMacOS } from "../platform.js";
import { DaemonAlreadyRunningError, DaemonFenceLostError, DaemonSingleton } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner } from "../workspace-provisioner.js";
import { acquireWorkspaceFence, withWorkspaceFence } from "../workspace-fence.js";
import { CRASH_LOOP_EXIT_LIMIT, decideReconciliation, restartBackoffMs, watchdogShouldEscalate } from "../reconciler-policy.js";
import { ProviderReconciler } from "../reconciler-runner.js";
import { advanceReconciliationState, recordReconciliationActionFailure } from "../reconciler-state.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import { launchLegacyWithOwnership } from "../../electron/main/supervisor-ownership.js";
import { defaultGetProcessIdentity } from "../../electron/main/agents/provider-evidence.js";

const execFileAsync = promisify(execFile);
const TEST_PROCESS_IDENTITY = execFileSync(
  "/bin/ps",
  ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
  { encoding: "utf8" },
).trim();

test("supervised native stream extracts only explicit LetAgents wait cursors", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code",
    kind: "text_delta",
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_3064", agent_session_id: "agent_session_exact" },
      }] },
    },
  }), "msg_3064");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "text", text: "wait_for_messages after msg_999" }] } },
  }), null, "free text cannot advance durable room progress");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__other__wait_for_messages", input: { after_message_id: "not-a-message" } }] } },
  }), null, "malformed cursors are ignored");
});

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs); })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeRecoveryClock(startMs = 10_000) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const delays: number[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    const id = nextId++;
    const handle = { id, unref() { return handle; } } as unknown as ReturnType<typeof setTimeout>;
    timers.set(id, { at: nowMs + Number(delay), callback });
    delays.push(Number(delay));
    return handle;
  }) as typeof setTimeout;
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
    const id = (handle as unknown as { id?: number }).id;
    if (id !== undefined) timers.delete(id);
  }) as typeof clearTimeout;
  return {
    clock: { nowMs: () => nowMs, setTimeout: setTimer, clearTimeout: clearTimer },
    delays,
    pending: () => timers.size,
    advance: async (deltaMs: number) => {
      nowMs += deltaMs;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await Promise.resolve();
    },
  };
}

async function daemonRequest(socketPath: string, method: string, params?: unknown, version = DAEMON_PROTOCOL_VERSION): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let received = "";
    let settled = false;
    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("close", () => {
      if (!settled) reject(new Error(`Daemon connection closed before '${method}' returned a response.`));
    });
    client.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      settled = true;
      client.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    client.on("connect", () => client.write(`${JSON.stringify({ version, id: "test", method, params })}\n`));
  });
}

function concurrentDaemonRequestBarrier(socketPath: string) {
  const clients = new Map<string, ReturnType<typeof createConnection>>();
  const requests = new Map<string, string>();
  const connected = new Set<string>();
  let released = false;

  const releaseWhenReady = () => {
    if (released || connected.size !== 2) return;
    released = true;
    for (const [label, client] of clients) client.write(requests.get(label)!);
  };

  return (label: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> => {
    if (clients.has(label)) throw new Error(`Duplicate barrier label: ${label}`);
    const response = new Promise<{ ok: boolean; result?: unknown; error?: string; version: number }>((resolve, reject) => {
      const client = createConnection(socketPath);
      clients.set(label, client);
      requests.set(label, `${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: `ordered_barrier_${label}`, method, params })}\n`);
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk) => {
        received += chunk;
        if (!received.includes("\n")) return;
        client.end();
        resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
      });
      client.on("connect", () => {
        connected.add(label);
        releaseWhenReady();
      });
    });
    releaseWhenReady();
    return response;
  };
}

function orderedDaemonMutationBarrier(releaseOrder: readonly ["legacy", "supervised"] | readonly ["supervised", "legacy"]) {
  const arrived = new Set<"legacy" | "supervised">();
  const waiting = new Map<"legacy" | "supervised", () => void>();
  let released = false;
  return {
    arrived,
    gate: (request: DaemonRequest): Promise<void> => {
      const label = request.method === "lane.reserve_legacy"
        ? "legacy"
        : request.method === "manifest.put"
          ? "supervised"
          : null;
      if (!label) return Promise.resolve();
      if (arrived.has(label)) throw new Error(`Duplicate mutation barrier arrival: ${label}`);
      arrived.add(label);
      const blocked = new Promise<void>((resolve) => { waiting.set(label, resolve); });
      if (!released && arrived.size === 2) {
        released = true;
        waiting.get(releaseOrder[0])!();
        queueMicrotask(() => waiting.get(releaseOrder[1])!());
      }
      return blocked;
    },
  };
}

const TEST_OID = "a".repeat(40);
const TEST_SUPERVISOR = { supervisor_id: "test-daemon", supervisor_generation: 1 };
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

test("terminal native failure is sticky for one provider execution", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "terminal_stream", provider: "codex", observed_state: "working" },
    })).ok, true);
    const handle = {
      workAttemptId: "attempt_exact",
      pid: 4100,
      providerContinuationId: "thread_exact",
      providerConnection: null,
      observedState: "failed" as const,
    };
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof handle>;
      handleProviderStream: (entryId: string, providerHandle: typeof handle, event: {
        workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
        provider: string; kind: string; method: string; payload: unknown; payloadTruncated: boolean;
        payloadRedacted: boolean; durablePayloadRef: null;
      }) => Promise<void>;
    };
    internals.liveHandles.set("terminal_stream", handle);
    const base = {
      workAttemptId: "attempt_exact",
      providerContinuationId: "thread_exact",
      observedAt: new Date().toISOString(),
      provider: "codex",
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    };
    await internals.handleProviderStream("terminal_stream", handle, {
      ...base,
      sequence: 1,
      kind: "transcript_snapshot",
      method: "thread/read",
      payload: { threadStatus: { type: "systemError" }, latestTurn: { status: "failed" } },
    });
    let current = (await new ManifestStore(paths.manifestPath).load()).entries[0]!;
    assert.equal(current.observed_state, "failed");
    assert.equal(current.activity?.at(-1)?.status, "blocked");

    await internals.handleProviderStream("terminal_stream", handle, {
      ...base,
      sequence: 2,
      kind: "text_delta",
      method: "item/agentMessage/delta",
      payload: { delta: "late evidence" },
    });
    current = (await new ManifestStore(paths.manifestPath).load()).entries[0]!;
    assert.equal(current.observed_state, "failed", "late same-execution activity cannot restore working");
    assert.equal(current.activity?.at(-1)?.status, "blocked");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct manifest convergence shares the per-entry reconciliation lane", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "serialized_direct_convergence");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "serialized_direct_convergence", leaseId: "serialized_direct_convergence", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let spawnCount = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 4201, providerContinuationId: "serialized-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; return handle; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; return handle; },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  let releaseTick!: () => void;
  let tickEntered!: () => void;
  const tickStarted = new Promise<void>((resolve) => { tickEntered = resolve; });
  const tickHold = new Promise<void>((resolve) => { releaseTick = resolve; });
  try {
    await daemon.start();
    const internals = daemon as unknown as { serializeEntryTick: <T>(entryId: string, operation: () => Promise<T>) => Promise<T> };
    const heldTick = internals.serializeEntryTick("serialized_direct_convergence", async () => { tickEntered(); await tickHold; });
    await tickStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "serialized_direct_convergence", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(spawnCount, 0, "manifest convergence cannot pass an in-flight reconciliation tick");
    releaseTick();
    await heldTick;
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "serialized provider launch");
    assert.equal(spawnCount, 1);
  } finally {
    releaseTick?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("an unattached live durable generation blocks a duplicate provider start", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "unattached_live_generation");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
  const attempt = await durability.createAttempt({ taskId: "unattached_live_generation", leaseId: "unattached_live_generation", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; throw new Error("must not mint a duplicate generation"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; throw new Error("must not mint a duplicate generation"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "live-continuation" }),
    onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "unattached_live_generation", provider: "claude-code", observed_state: "recovering",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "live-continuation",
        provider_connection: null,
        execution_generation_id: execution.execution_generation_id,
      },
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "coordination_blocked" && /remains live/.test(current.last_error ?? "");
    }, "ambiguous live generation hold");
    assert.equal(spawnCount, 0);
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "unattached_live_generation" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(detail.execution_generations.length, 1);
    assert.equal(detail.execution_generations[0]?.terminal, null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a failed provider launch terminalizes its generation and releases the shared workspace fence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "failed_launch_cleanup");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "failed_launch_cleanup", leaseId: "failed_launch_cleanup", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let launchCount = 0;
  const recovered = { workAttemptId: attempt.work_attempt_id, pid: 4202, providerContinuationId: "recovered-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { launchCount += 1; if (launchCount === 1) throw new Error("injected launch failure"); return recovered; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => recovered,
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: recovered.providerContinuationId }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "failed_launch_cleanup", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "coordination_blocked" && /injected launch failure/.test(current.last_error ?? "");
    }, "failed launch persistence");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "failed_launch_cleanup" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.ok(detail.execution_generations[0]?.terminal, "failed launch generation is durably terminal");
    const fenceDirectory = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    assert.equal((await readdir(fenceDirectory)).some((name) => name.startsWith("shared-")), false, "failed launch releases retained workspace authority");

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "failed_launch_cleanup", desired_state: "running" })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "provider retry without daemon restart");
    assert.equal(launchCount, 2);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).length, 1, "successful retry reacquires one shared fence");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a provider handle returned already terminal is fenced and resumes under a successor generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "returned_terminal");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: "returned_terminal",
    leaseId: "returned_terminal",
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const failedHandle = {
    workAttemptId: attempt.work_attempt_id,
    pid: 4101,
    providerContinuationId: "claude-continuation",
    observedState: "failed" as const,
  };
  const recoveredHandle = {
    ...failedHandle,
    pid: 4102,
    observedState: "working" as const,
  };
  let stopCount = 0;
  let resumeCount = 0;
  const streamListeners = new Map<object, (event: any) => void>();
  const exitListeners = new Map<object, (terminal: {
    endedAt: string; exitCode: number | null; signal: string | null;
    terminalCause: "stopped"; providerContinuationId: string;
  }) => void>();
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => failedHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { resumeCount += 1; return recoveredHandle; },
    poke: async () => {},
    stop: async (handle) => {
      stopCount += 1;
      const terminal = {
        endedAt: new Date().toISOString(),
        exitCode: 1,
        signal: null,
        terminalCause: "stopped" as const,
        providerContinuationId: "claude-continuation",
      };
      queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
      return terminal;
    },
    onExit: async (handle, listener) => {
      exitListeners.set(handle as object, listener);
      return () => exitListeners.delete(handle as object);
    },
    onStream: async (handle, listener) => {
      streamListeners.set(handle as object, listener);
      if (handle === failedHandle) {
        listener({
          workAttemptId: attempt.work_attempt_id,
          providerContinuationId: "claude-continuation",
          observedAt: new Date().toISOString(),
          sequence: 1,
          provider: "claude-code",
          kind: "error",
          method: "result/error_during_execution",
          payload: { type: "result", subtype: "error_during_execution", is_error: true },
          payloadTruncated: false,
          payloadRedacted: false,
          durablePayloadRef: null,
        });
      }
      return () => streamListeners.delete(handle as object);
    },
  };
  const recovery = fakeRecoveryClock();
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, recovery.clock);
  try {
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "returned_terminal",
      provider: "claude-code",
      observed_state: "absent",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
    } });
    assert.equal(put.ok, true, put.error);
    await eventually(async () => stopCount === 1 && recovery.pending() === 1, "terminal fence and recovery timer");
    assert.equal(resumeCount, 0);
    await recovery.advance(999);
    await Promise.resolve();
    assert.equal(resumeCount, 0, "generation 2 cannot start before the persisted backoff");
    await recovery.advance(1);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.observed_state === "working"
        && current.provider_ref?.execution_generation_id !== undefined;
    }, "already-terminal launch recovery");
    assert.equal(stopCount, 1, "returned-state and just-installed stream paths share one idempotent terminal fence");
    assert.equal(resumeCount, 1, "the listener boundary race mints exactly one bounded successor");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "returned_terminal" })).result as {
      execution_generations: Array<{ terminal: unknown }>;
    };
    assert.ok(detail.execution_generations[0]?.terminal, "the returned-terminal generation is durably terminal");
    assert.equal(detail.execution_generations[1]?.terminal, null, "only the successor generation remains live");

    streamListeners.get(recoveredHandle as object)?.({
      workAttemptId: attempt.work_attempt_id,
      providerContinuationId: "claude-continuation",
      observedAt: new Date().toISOString(),
      sequence: 2,
      provider: "claude-code",
      kind: "error",
      method: "result/error_during_execution",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    });
    await eventually(async () => recovery.pending() === 1, "second terminal recovery timer");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "returned_terminal", desired_state: "stopped" });
    assert.equal(recovery.pending(), 0, "manual Stop cancels the pending recovery timer");
    await recovery.advance(60_000);
    await Promise.resolve();
    assert.equal(resumeCount, 1, "a cancelled recovery timer cannot mint another successor");
  } finally {
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "returned_terminal", desired_state: "stopped" }).catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct terminal recovery increases delay and quarantines before a sixth generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "bounded_terminal_loop");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "bounded_terminal_loop", leaseId: "bounded_terminal_loop", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let launchCount = 0;
  const exitListeners = new Map<object, (terminal: any) => void>();
  const failedHandle = () => ({ workAttemptId: attempt.work_attempt_id, pid: 4200 + launchCount, providerContinuationId: "bounded-continuation", observedState: "failed" as const });
  const launch = () => { launchCount += 1; return failedHandle(); };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => launch(),
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => launch(),
    poke: async () => {},
    stop: async (handle) => {
      const terminal = { endedAt: new Date().toISOString(), exitCode: 1, signal: null, terminalCause: "stopped" as const, providerContinuationId: "bounded-continuation" };
      queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
      return terminal;
    },
    onExit: async (handle, listener) => { exitListeners.set(handle as object, listener); return () => exitListeners.delete(handle as object); },
    onStream: async () => () => {},
  };
  const recovery = fakeRecoveryClock();
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, recovery.clock);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "bounded_terminal_loop", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await eventually(async () => launchCount === index + 1 && recovery.pending() === 1, `recovery timer ${index + 1}`);
      assert.equal(recovery.delays.at(-1), delay);
      await recovery.advance(delay - 1);
      await Promise.resolve();
      assert.equal(launchCount, index + 1);
      await recovery.advance(1);
    }
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "quarantined";
    }, "fifth terminal quarantine");
    assert.equal(launchCount, CRASH_LOOP_EXIT_LIMIT, "the threshold prevents generation 6");
    assert.equal(recovery.pending(), 0, "quarantine leaves no recovery timer");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "bounded_terminal_loop" })).result as { execution_generations: unknown[] };
    assert.equal(detail.execution_generations.length, CRASH_LOOP_EXIT_LIMIT);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a terminal handle discovered during daemon reattach is fenced and resumes once", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "reattached_terminal");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "reattached_terminal", leaseId: "reattached_terminal", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const liveHandle = { workAttemptId: attempt.work_attempt_id, pid: 4301, providerContinuationId: "reattach-continuation", observedState: "working" as const };
  const terminalHandle = { ...liveHandle, observedState: "idle" as const };
  const successorHandle = { ...liveHandle, pid: 4302 };
  const firstPort: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => liveHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("first daemon starts fresh"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "reattach-continuation" }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const recovery = fakeRecoveryClock();
  const first = new SupervisorDaemon(paths, "darwin", firstPort, true, 15_000, undefined, recovery.clock);
  let second: SupervisorDaemon | null = null;
  let stopCount = 0;
  let resumeCount = 0;
  const exitListeners = new Map<object, (terminal: any) => void>();
  try {
    await first.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "reattached_terminal", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "first daemon provider start");
    await first.stop();

    const secondPort: ProviderActionPort = {
      ...firstPort,
      spawn: async () => { throw new Error("reattach recovery must preserve the continuation"); },
      attach: async () => terminalHandle,
      resume: async () => { resumeCount += 1; return successorHandle; },
      stop: async (handle) => {
        stopCount += 1;
        const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: "reattach-continuation" };
        queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
        return terminal;
      },
      onExit: async (handle, listener) => { exitListeners.set(handle as object, listener); return () => exitListeners.delete(handle as object); },
    };
    second = new SupervisorDaemon(paths, "darwin", secondPort, true, 15_000, undefined, recovery.clock);
    await second.start();
    await eventually(async () => stopCount === 1 && recovery.pending() === 1, "terminal reattach fence");
    assert.equal(resumeCount, 0);
    await recovery.advance(1_000);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "reattached successor");
    assert.equal(stopCount, 1);
    assert.equal(resumeCount, 1);
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "reattached_terminal" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.ok(detail.execution_generations[0]?.terminal);
    assert.equal(detail.execution_generations[1]?.terminal, null);
  } finally {
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct provider convergence quarantines persisted crash loops without another spawn", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
  };
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; throw new Error("quarantined entry must not spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; throw new Error("quarantined entry must not resume"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const now = Date.now();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "persisted_crash_loop",
      observed_state: "failed",
      reconciliation: {
        exit_timestamps_ms: Array.from({ length: CRASH_LOOP_EXIT_LIMIT }, (_, index) => now - index),
        consecutive_action_failures: CRASH_LOOP_EXIT_LIMIT,
        last_observed_state: "failed",
        next_restart_at_ms: now + 60_000,
        completed_action_ids: [],
        last_action_sequence: 0,
        pending_action: null,
      },
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "quarantined";
    }, "persisted crash-loop quarantine");
    assert.equal(spawnCount, 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("reconciler policy uses the addressed-message watchdog rather than turn duration", () => {
  const base = {
    desiredState: "running" as const, observedState: "working" as const, condition: "none" as const,
    capabilities: { resume: true, midTurnInjection: true }, nowMs: 10_000, lastPollAtMs: 0,
    addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, exitsInWindow: 0,
  };
  assert.equal(watchdogShouldEscalate({ ...base, addressedMessagesWaiting: 0, pokeIgnored: true }, 1_000), false, "long work with an empty inbox is never touched");
  assert.equal(watchdogShouldEscalate({ ...base, lastPollAtMs: 9_999, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000), false, "quiet but polling is never touched");
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 1 }, 1_000).action, "poke");
  assert.equal(watchdogShouldEscalate({ ...base, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000), true);
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000).action, "restart_with_resume");
});

test("reconciler policy fences recovery, gates resume, quarantines crash loops, and backs off", () => {
  const base = {
    desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const,
    capabilities: { resume: true, midTurnInjection: false }, nowMs: 0, lastPollAtMs: null,
    addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: true, fencedRebindProven: false, exitsInWindow: 0,
  };
  assert.deepEqual(decideReconciliation(base, 1_000), {
    action: "hold_coordination", observedState: "recovering", condition: "coordination_blocked", reason: "active lease requires fenced rebind before restart",
  });
  assert.equal(decideReconciliation({ ...base, fencedRebindProven: true }, 1_000).action, "restart_with_resume");
  assert.equal(decideReconciliation({ ...base, activeLease: false, capabilities: { resume: false, midTurnInjection: false } }, 1_000).action, "restart_fresh");
  assert.equal(decideReconciliation({ ...base, exitsInWindow: CRASH_LOOP_EXIT_LIMIT }, 1_000).action, "quarantine");
  assert.equal(restartBackoffMs(1), 1_000);
  assert.equal(restartBackoffMs(20), 5 * 60 * 1_000);
  assert.equal(decideReconciliation({ ...base, activeLease: false, nextRestartAtMs: 1_001, nowMs: 1_000 }, 1_000).action, "wait");
});

test("reconciliation bookkeeping keeps rolling exits independent from action backoff", () => {
  const first = advanceReconciliationState(undefined, "failed", 1_000);
  assert.deepEqual(first.exit_timestamps_ms, [1_000]);
  assert.equal(first.consecutive_action_failures, 1);
  assert.deepEqual(advanceReconciliationState(first, "failed", 1_500), first, "a polling tick cannot manufacture another exit");
  const recovered = advanceReconciliationState(first, "recovering", 2_000);
  assert.deepEqual(recovered.exit_timestamps_ms, [1_000]);
  assert.deepEqual(advanceReconciliationState(recovered, "working", 2_500).exit_timestamps_ms, [1_000], "healthy work never erases exit history");
  const later = advanceReconciliationState({ ...first, last_observed_state: "recovering" }, "failed", 2_000);
  assert.deepEqual(later.exit_timestamps_ms, [1_000, 2_000]);
  const expired = advanceReconciliationState({ ...later, last_observed_state: "recovering" }, "failed", 2_000 + 10 * 60 * 1_000 + 1);
  assert.deepEqual(expired.exit_timestamps_ms, [2_000 + 10 * 60 * 1_000 + 1]);
  const actionFailure = recordReconciliationActionFailure(first, "generation-2", 2_000);
  assert.equal(actionFailure.consecutive_action_failures, 2);
  assert.equal(recordReconciliationActionFailure(actionFailure, "generation-2", 3_000), actionFailure, "retried action is idempotent");
  const afterAnotherAction = recordReconciliationActionFailure(actionFailure, "generation-3", 4_000);
  assert.equal(recordReconciliationActionFailure(afterAnotherAction, "generation-2", 5_000), afterAnotherAction, "non-adjacent replay is rejected");
});

test("reconciler executes only fenced, capability-negotiated port actions", async () => {
  const calls: string[] = [];
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "failed" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null,
    resume: async () => { calls.push("resume"); return handle; }, poke: async () => { calls.push("poke"); },
    stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }), onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const base = { workAttemptId: "attempt", desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const, nowMs: 1_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, exitsInWindow: 0, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle, resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" } };
  assert.equal((await runner.reconcile({ ...base, activeLease: true, fencedRebindProven: false }, 100)).decision.action, "hold_coordination");
  assert.deepEqual(calls, []);
  assert.equal((await runner.reconcile({ ...base, activeLease: false, fencedRebindProven: false }, 100)).decision.action, "restart_with_resume");
  assert.deepEqual(calls, ["resume"]);
  const missing = await runner.reconcile({ ...base, activeLease: false, fencedRebindProven: false, resumeFrom: null }, 100);
  assert.equal(missing.decision.action, "hold_coordination");
  assert.equal(missing.disposition, "held");
});

test("reconciler dispatches fresh, poke, and stop safely and reports port faults", async () => {
  const calls: string[] = [];
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null,
    resume: async () => { calls.push("resume"); return handle; }, poke: async () => { calls.push("poke"); },
    stop: async () => { calls.push("stop"); return { endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }; }, onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const base = { workAttemptId: "attempt", desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const, nowMs: 10_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, exitsInWindow: 0, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle, resumeFrom: null };
  assert.equal((await runner.reconcile(base, 100)).decision.action, "restart_fresh");
  assert.deepEqual(calls, ["spawn"]);
  const poke = await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1 }, 100);
  assert.equal(poke.decision.action, "poke");
  const stop = await runner.reconcile({ ...base, desiredState: "stopped", observedState: "working" }, 100);
  assert.equal(stop.decision.action, "stop");
  assert.deepEqual(calls, ["spawn", "poke", "stop"]);
  assert.equal((await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1, handle: null }, 100)).disposition, "held");
  assert.equal((await runner.reconcile({ ...base, desiredState: "stopped", observedState: "working", handle: null }, 100)).disposition, "held");
  for (const unsafe of [
    { desiredState: "stopped" as const },
    { condition: "quarantined" as const },
    { activeLease: true, fencedRebindProven: true },
  ]) {
    const before = calls.length;
    const held = await runner.reconcile({ ...base, forcedAction: "restart_fresh", ...unsafe }, 100);
    assert.equal(held.disposition, "held", "a durable pending restart must revalidate current stop/quarantine/lease gates");
    assert.equal(calls.length, before, "an unsafe durable restart is never dispatched");
  }
  const beforePoke = calls.length;
  const pendingPoke = await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1, activeLease: true, fencedRebindProven: true, forcedAction: "poke" }, 100);
  assert.equal(pendingPoke.disposition, "executed", "an active lease does not block a safe durable poke");
  assert.equal(calls.length, beforePoke + 1);
  const broken = new ProviderReconciler({ ...port, spawn: async () => { throw new Error("child failed"); } });
  const result = await broken.reconcile(base, 100);
  assert.equal(result.disposition, "failed");
  assert.match(result.decision.reason, /child failed/);
});

test("an exact resume method failure downgrades capabilities and the next reconcile starts fresh", async () => {
  const calls: string[] = [];
  let resumeSupported = true;
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "failed" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: resumeSupported, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { calls.push("spawn"); return handle; },
    attach: async () => null,
    resume: async () => {
      calls.push("resume");
      resumeSupported = false;
      throw new Error("Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.");
    },
    poke: async () => {},
    stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }),
    onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const input = {
    workAttemptId: "attempt",
    desiredState: "running" as const,
    observedState: "failed" as const,
    condition: "none" as const,
    nowMs: 1_000,
    lastPollAtMs: null,
    addressedMessagesWaiting: 0,
    pokeIgnored: false,
    exitsInWindow: 0,
    activeLease: false,
    fencedRebindProven: false,
    spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} },
    handle,
    resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" },
  };

  const failedResume = await runner.reconcile(input, 100);
  assert.equal(failedResume.disposition, "failed");
  assert.match(failedResume.decision.reason, /bounded recovery must start a fresh generation/);
  const freshRetry = await runner.reconcile(input, 100);
  assert.equal(freshRetry.decision.action, "restart_fresh");
  assert.equal(freshRetry.disposition, "executed");
  assert.deepEqual(calls, ["resume", "spawn"]);
});

test("supervisor convergence persists the retry deadline before it can restart", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    const store = new ManifestStore(manifestPath);
    await store.write(0, [{ ...entry, observed_state: "failed" }]);
    const calls: string[] = [];
    const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null, resume: async () => handle,
      poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const input = { workAttemptId: "attempt", reconciliationActionId: "generation-1", reconciliationActionSequence: 1, nowMs: 1_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    assert.equal((await daemon.reconcile(entry.id, input, 100)).decision.action, "wait");
    assert.deepEqual(calls, []);
    assert.equal((await store.load()).entries[0]?.reconciliation?.next_restart_at_ms, 2_000);
    assert.equal((await daemon.reconcile(entry.id, { ...input, nowMs: 2_000 }, 100)).decision.action, "restart_fresh");
    assert.deepEqual(calls, ["spawn"]);
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("five terminal exit edges across reload quarantine even with intermediate work", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  let reloaded: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") };
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "working" }]);
    let spawnCalls = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCalls += 1; throw new Error("should not restart"); }, attach: async () => null,
      resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const base = { workAttemptId: "attempt", lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    daemon = new SupervisorDaemon(paths, "darwin", port);
    await daemon.start();
    for (let index = 0; index < 5; index += 1) {
      await daemon.transition(entry.id, "failed", "none", `terminal-exit-${index}`, "provider");
      await daemon.transition(entry.id, "working", "none", `recovered-${index}`, "provider");
    }
    await daemon.stop();
    reloaded = new SupervisorDaemon(paths, "darwin", port);
    await reloaded.start();
    const quarantined = await reloaded.reconcile(entry.id, { ...base, reconciliationActionId: "generation-5", reconciliationActionSequence: 5, nowMs: Date.now() }, 100);
    assert.equal(quarantined.decision.action, "quarantine");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "quarantined");
    assert.equal(spawnCalls, 0, "quarantine blocks another provider launch");
    await reloaded.stop();
  } finally { await reloaded?.stop().catch(() => undefined); await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("reconciliation journals intent before provider dispatch and attaches it after reload", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  let reloaded: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") };
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [0], consecutive_action_failures: 1, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let releaseSpawn!: () => void;
    let signalSpawn!: () => void;
    const spawned = new Promise<void>((resolve) => { signalSpawn = resolve; });
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { signalSpawn(); await new Promise<void>((resolve) => { releaseSpawn = resolve; }); return { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" }; }, attach: async () => null,
      resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const input = { workAttemptId: "attempt", reconciliationActionId: "generation-2", reconciliationActionSequence: 2, nowMs: 2_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    daemon = new SupervisorDaemon(paths, "darwin", port);
    await daemon.start();
    const running = daemon.reconcile(entry.id, input, 100);
    await spawned;
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.pending_action?.id, "generation-2");
    releaseSpawn();
    await running;
    await daemon.stop();
    const reloadedPort: ProviderActionPort = { ...port, spawn: async () => { throw new Error("must not respawn a pending action"); }, attachAction: async (id) => id === "orphan" ? { state: "attached", handle: { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" } } : { state: "absent" } };
    const stored = await new ManifestStore(manifestPath).load();
    await new ManifestStore(manifestPath).write(stored.generation, stored.entries.map((candidate) => candidate.id === entry.id ? { ...candidate, reconciliation: { ...candidate.reconciliation!, pending_action: { id: "orphan", sequence: 3, kind: "restart_fresh", recorded_at_ms: 3_000 } } } : candidate));
    reloaded = new SupervisorDaemon(paths, "darwin", reloadedPort);
    await reloaded.start();
    assert.equal((await reloaded.reconcile(entry.id, { ...input, reconciliationActionId: "generation-3", reconciliationActionSequence: 3, nowMs: 3_001 }, 100)).disposition, "held");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.pending_action, null);
    await reloaded.stop();
  } finally { await reloaded?.stop().catch(() => undefined); await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("an absent pending intent redispatches its exact durable identity and kind, while ambiguity blocks", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 7, pending_action: { id: "durable-restart", sequence: 7, kind: "restart_fresh", recorded_at_ms: 1 } } }]);
    const requests: Array<{ actionId?: string }> = [];
    let attachment: "absent" | "ambiguous" = "absent";
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async (request) => { requests.push({ actionId: request.actionId }); return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; },
      attach: async () => null,
      attachAction: async () => attachment === "absent" ? { state: "absent" } : { state: "ambiguous", reason: "provider lookup timed out" },
      resume: async () => { throw new Error("the durable restart_fresh kind must not become resume"); },
      poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const input = { workAttemptId: "attempt", reconciliationActionId: "newer-tick", reconciliationActionSequence: 8, nowMs: 2_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" } };
    assert.equal((await daemon.reconcile(entry.id, input, 100)).decision.action, "restart_fresh");
    assert.deepEqual(requests, [{ actionId: "durable-restart" }]);
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.last_action_sequence, 7, "redispatch never decrements the monotonic sequence");

    const stored = await new ManifestStore(manifestPath).load();
    await daemon.stop();
    daemon = null;
    await new ManifestStore(manifestPath).write(stored.generation, stored.entries.map((candidate) => candidate.id === entry.id ? { ...candidate, reconciliation: { ...candidate.reconciliation!, pending_action: { id: "ambiguous-intent", sequence: 9, kind: "restart_fresh", recorded_at_ms: 3 } } } : candidate));
    attachment = "ambiguous";
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const held = await daemon.reconcile(entry.id, { ...input, reconciliationActionId: "later-tick", reconciliationActionSequence: 10, nowMs: 3_000 }, 100);
    assert.equal(held.disposition, "held");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "coordination_blocked");
    assert.equal(requests.length, 1, "ambiguous attachment may never redispatch");
    await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("global manifest mutation serialization preserves concurrent different-entry transitions", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [entry, { ...entry, id: "agent_2" }]);
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await Promise.all([daemon.transition("agent_1", "failed", "none", "exit", "test"), daemon.transition("agent_2", "failed", "none", "exit", "test")]);
    assert.deepEqual((await new ManifestStore(manifestPath).load()).entries.map((candidate) => candidate.observed_state), ["failed", "failed"]);
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("scheduled convergence records provider exits and durable escalation notices", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "working" }]);
    let onExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }), spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (_handle, listener) => { onExit = listener; return () => { onExit = null; }; },
    };
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "working" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "generation-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    onExit?.({ endedAt: "now", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.observed_state, "failed");
    await daemon.transition(entry.id, "failed", "quarantined", "five exits in window", "reconciler");
    const notices = (await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? [];
    assert.deepEqual(notices.map((notice) => notice.kind), ["quarantine_death"]);
    assert.equal(notices[0]?.terminal?.terminal_cause, "crashed", "quarantine escalation carries immutable terminal evidence");
    await daemon.transition(entry.id, "recovering", "coordination_blocked", "active lease needs rebind", "reconciler");
    assert.deepEqual(((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? []).map((notice) => notice.kind), ["quarantine_death", "coordination_escalation"]);
    await stop();
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("scheduled convergence atomically replaces exit subscriptions and preserves stop/quarantine terminals", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    const listeners = new Map<number, (terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void>();
    let subscriptions = 0;
    const poked: Array<number | null> = [];
    const replacement = { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => replacement, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async (handle) => { poked.push(handle.pid); }, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { subscriptions += 1; listeners.set(handle.pid ?? -1, listener); return () => { listeners.delete(handle.pid ?? -1); }; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    let sequence = 0;
    const input = () => { sequence += 1; return { workAttemptId: "attempt", reconciliationActionId: `generation-${sequence}`, reconciliationActionSequence: sequence, nowMs: Date.now(), lastPollAtMs: 0, addressedMessagesWaiting: 1, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" as const }, resumeFrom: null }; };
    const [stop, sameStop] = await Promise.all([
      daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 5),
      daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 5),
    ]);
    assert.equal(subscriptions, 2, "one initial listener is atomically replaced by the spawned child listener");
    assert.equal(listeners.has(1), false, "the superseded child listener is removed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(poked.every((pid) => pid === 2) && poked.length > 0, "later scheduler ticks target the installed replacement, not input's stale handle");
    await stop(); await sameStop();

    await daemon.transition(entry.id, "working", "quarantined", "already quarantined", "test");
    await daemon.observeProviderExit(entry.id, { endedAt: "late", exitCode: 9, signal: "SIGKILL", terminalCause: "killed", providerContinuationId: null });
    const late = (await new ManifestStore(manifestPath).load()).entries[0]!;
    assert.equal(late.condition, "quarantined");
    assert.equal(late.reconciliation_notices?.at(-1)?.terminal?.terminal_cause, "killed");
    await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a slow old replacement registration cannot overwrite a newer child listener", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    const listeners = new Map<number, (terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void>();
    let releaseSecondRegistration!: () => void;
    const secondRegistration = new Promise<void>((resolve) => { releaseSecondRegistration = resolve; });
    let signalSecondRegistration!: () => void;
    const waitingForSecondRegistration = new Promise<void>((resolve) => { signalSecondRegistration = resolve; });
    let spawnCount = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCount += 1; return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; },
      attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => {
        if (handle.pid === 2) { signalSecondRegistration(); await secondRegistration; }
        listeners.set(handle.pid ?? -1, listener);
        return () => { listeners.delete(handle.pid ?? -1); };
      },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    let sequence = 0;
    const input = () => { sequence += 1; return { workAttemptId: "attempt", reconciliationActionId: `g-${sequence}`, reconciliationActionSequence: sequence, nowMs: Date.now() + 10_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }; };
    const scheduled = daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 60_000);
    await within(waitingForSecondRegistration, "the blocked second listener registration");
    listeners.get(1)?.({ endedAt: "early", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    releaseSecondRegistration();
    const stop = await within(scheduled, "the first scheduled convergence");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(spawnCount, 1, "a superseded child terminal cannot launch a second replacement");
    assert.deepEqual([...listeners.keys()], [2], "the promoted replacement is the only subscribed child");
    await eventually(async () => ((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? []).some((notice) => notice.cause.includes("stale terminal from superseded")), "durable stale-terminal evidence");
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a replacement child terminal callback enters durable convergence", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let replacementExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => ({ workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }), attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { if (handle.pid === 2) replacementExit = listener; return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    assert.ok(replacementExit, "the spawned child replaces the initial exit listener");
    replacementExit?.({ endedAt: "later", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await eventually(async () => (await new ManifestStore(manifestPath).load()).entries[0]?.observed_state === "failed", "replacement terminal persistence");
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a transient replacement listener failure retries the promoted child without a second spawn", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let spawnCount = 0;
    let failReplacementListener = true;
    let replacementExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCount += 1; return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { if (handle.pid === 2 && failReplacementListener) { failReplacementListener = false; throw new Error("transient replacement listener failure"); } if (handle.pid === 2) replacementExit = listener; return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 5);
    await eventually(async () => replacementExit !== null, "replacement listener retry");
    assert.equal(spawnCount, 1);
    replacementExit?.({ endedAt: "later", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await eventually(async () => (await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.last_terminal?.ended_at === "later", "replacement exit after listener retry");
    assert.equal(spawnCount, 1);
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("desired stopped turns every terminal into a clean stopped observation and scheduler setup faults persist", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, desired_state: "stopped", observed_state: "stopping" }]);
    let failSubscribe = true;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }), spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async () => { if (failSubscribe) throw new Error("listener bridge unavailable"); return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    await daemon.observeProviderExit(entry.id, { endedAt: "now", exitCode: 0, signal: null, terminalCause: "exited", providerContinuationId: null });
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.observed_state, "stopped");
    await assert.rejects(() => daemon!.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000), /listener bridge unavailable/);
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "coordination_blocked");
    failSubscribe = false;
    let unsubscribedAfterTickFailure = false;
    const tickFailurePort = { ...port, onExit: async () => () => { unsubscribedAfterTickFailure = true; } };
    await daemon.stop();
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", tickFailurePort);
    await daemon.start();
    await assert.rejects(() => daemon!.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => { throw new Error("initial tick input failed"); }, 100, 60_000), /initial tick input failed/);
    assert.equal(unsubscribedAfterTickFailure, true, "a post-subscribe initial tick failure removes the listener");
    await daemon.stop();
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g2", reconciliationActionSequence: 2, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("simulated flock reacquires the persistent lock inode after release", async () => {
  const env = await fixture();
  const lock = join(env.root, "daemon.lock");
  const first = new DaemonSingleton(lock, "darwin");
  const second = new DaemonSingleton(lock, "darwin");
  try {
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => second.acquire(), DaemonAlreadyRunningError);
    await first.release();
    assert.equal((await stat(lock)).isFile(), true);
    assert.equal(await second.acquire(), 2);
  } finally {
    await second.release();
    await first.release();
    await env.cleanup();
  }
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
    const canary = "canary-not-a-real-audit-secret-123456789";
    await log.append({ at: "2026-01-01T00:00:01.000Z", entry_id: "agent", from: "recovering", to: "idle", cause: `Authorization: Bearer ${canary}`, actor: "test", generation: 2 });
    const names = await readdir(env.root);
    assert.ok(names.some((name) => name.startsWith("audit.jsonl.") && name.endsWith(".archive")));
    assert.match(await readFile(path, "utf8"), /"generation":2/);
    assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(canary));
    assert.match(await readFile(path, "utf8"), /REDACTED/);
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

test("cross-version negotiation is allowed before a generation handoff", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "daemon.sock");
    const socket = new DaemonControlSocket(socketPath, (request) => request.method === "daemon.negotiate"
      ? { healthy: true, protocol_version: DAEMON_PROTOCOL_VERSION, generation: 9 }
      : { ok: true });
    await socket.start();
    const response = await daemonRequest(socketPath, "daemon.negotiate", undefined, DAEMON_PROTOCOL_VERSION + 1);
    assert.equal(response.ok, true);
    assert.equal((response.result as { generation: number }).generation, 9);
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("version handoff releases authority without waiting for wedged callbacks and preserves provider work", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await first.start();
    const never = new Promise<void>(() => {});
    const internals = first as unknown as {
      convergenceRequests: Map<string, Promise<void>>;
      providerCallbacks: Set<Promise<void>>;
      scheduledConvergence: Map<string, Promise<{ dispose: () => Promise<void> }>>;
    };
    internals.convergenceRequests.set("wedged", never);
    internals.providerCallbacks.add(never);
    internals.scheduledConvergence.set("wedged", new Promise(() => {}));

    const prepared = await daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    assert.equal(prepared.ok, true);
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon authority after handoff", 1_000);
    assert.doesNotThrow(() => process.kill(provider.pid!, 0), "handoff detaches daemon observers without killing provider work");
  } finally {
    await second?.stop();
    provider.kill("SIGKILL");
    await env.cleanup();
  }
});

test("handoff destroys open control sockets and fences a mutation paused before commit", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let reachedCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  let releaseBindingCommit!: () => void;
  const bindingCommitGate = new Promise<void>((resolve) => { releaseBindingCommit = resolve; });
  let reachedBindingCommit!: () => void;
  const bindingCommitReached = new Promise<void>((resolve) => { reachedBindingCommit = resolve; });
  let heldSocket: ReturnType<typeof createConnection> | null = null;
  try {
    await first.start();
    const store = (first as unknown as { store: ManifestStore }).store;
    const originalWrite = store.write.bind(store);
    store.write = (expected, entries, owners, commitFence) => originalWrite(expected, entries, owners, async (commit) => {
      reachedCommit();
      await commitGate;
      if (commitFence) await commitFence(commit);
      else await commit();
    });
    const lateMutation = daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "must_not_commit_after_handoff" },
    }).catch(() => null);
    const bindingStore = (first as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    const rawBindingStore = bindingStore as unknown as { write: (value: unknown) => Promise<void> };
    const originalBindingWrite = rawBindingStore.write.bind(rawBindingStore);
    rawBindingStore.write = async (value) => {
      reachedBindingCommit();
      await bindingCommitGate;
      await originalBindingWrite(value);
    };
    const lateBinding = bindingStore.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_old",
      execution_generation_id: "execution_old", agent_session_id: "session_old",
      agent_session_token: "old-secret", api_url: "https://letagents.chat",
    }).catch(() => null);
    await Promise.all([commitReached, bindingCommitReached]);

    heldSocket = createConnection(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      heldSocket!.once("connect", resolve);
      heldSocket!.once("error", reject);
    });
    const heldClosed = new Promise<void>((resolve) => heldSocket!.once("close", () => resolve()));
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon while an old control socket is open", 1_000);
    await within(heldClosed, "old control connection destruction", 1_000);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "binding_race", room_id: "focus_37", observed_state: "working", work_attempt_id: "attempt_old",
      provider_ref: {
        work_attempt_id: "attempt_old", provider_continuation_id: "continuation_successor",
        provider_connection: null, execution_generation_id: "execution_old",
      },
    } })).ok, true);
    const replacementBindings = (second as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    const predecessorBinding = await replacementBindings.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_old",
      execution_generation_id: "execution_old", agent_session_id: "session_old",
      agent_session_token: "old-secret", api_url: "https://letagents.chat",
    });
    const staleHandle = {
      workAttemptId: "attempt_old", pid: null, providerContinuationId: "continuation_old",
      providerConnection: null, observedState: "working" as const,
    };
    const successorHandle = { ...staleHandle, providerContinuationId: "continuation_successor" };
    let releaseTerminalLoad!: () => void;
    const terminalLoadGate = new Promise<void>((resolve) => { releaseTerminalLoad = resolve; });
    let reachedTerminalLoad!: () => void;
    const terminalLoadReached = new Promise<void>((resolve) => { reachedTerminalLoad = resolve; });
    const replacementInternals = second as unknown as {
      liveHandles: Map<string, typeof staleHandle>;
      liveBindingIdentities: Map<string, { agentSessionId: string; executionGenerationId: string; updatedAt: string }>;
      store: ManifestStore;
      durability: {
        getAttempt: (id: string) => Promise<{ execution_generations: Array<{ execution_generation_id: string; terminal: unknown; actor: string; generation: number }> }>;
        recordTerminal: (workAttemptId: string, executionGenerationId: string, terminal: unknown) => Promise<void>;
      };
      handleProviderTerminal: (entryId: string, handle: typeof staleHandle, executionGenerationId: string, binding: { agentSessionId: string; executionGenerationId: string; updatedAt: string }, terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "stopped"; providerContinuationId: string }) => Promise<void>;
    };
    replacementInternals.liveHandles.set("binding_race", staleHandle);
    const predecessorIdentity = {
      agentSessionId: predecessorBinding.agent_session_id,
      executionGenerationId: predecessorBinding.execution_generation_id,
      updatedAt: predecessorBinding.updated_at,
    };
    replacementInternals.liveBindingIdentities.set("binding_race", predecessorIdentity);
    const fakeExecutions = [
      { execution_generation_id: "execution_old", terminal: null as unknown, actor: "old-worker", generation: 1 },
      { execution_generation_id: "execution_successor", terminal: null as unknown, actor: "successor-worker", generation: 2 },
    ];
    replacementInternals.durability.getAttempt = async () => ({ execution_generations: fakeExecutions });
    replacementInternals.durability.recordTerminal = async (_workAttemptId, executionGenerationId, terminal) => {
      const execution = fakeExecutions.find((candidate) => candidate.execution_generation_id === executionGenerationId)!;
      execution.terminal = terminal;
    };
    const originalReplacementLoad = replacementInternals.store.load.bind(replacementInternals.store);
    let gateNextLoad = true;
    replacementInternals.store.load = async () => {
      if (gateNextLoad) {
        gateNextLoad = false;
        reachedTerminalLoad();
        await terminalLoadGate;
      }
      return originalReplacementLoad();
    };
    const staleTerminal = replacementInternals.handleProviderTerminal("binding_race", staleHandle, "execution_old", predecessorIdentity, {
      endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "continuation_old",
    });
    await terminalLoadReached;
    const successorBinding = await replacementBindings.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_new",
      execution_generation_id: "execution_old", agent_session_id: "session_new",
      agent_session_token: "new-secret", api_url: "https://letagents.chat",
    });
    replacementInternals.liveHandles.set("binding_race", successorHandle);
    replacementInternals.liveBindingIdentities.set("binding_race", {
      agentSessionId: successorBinding.agent_session_id,
      executionGenerationId: successorBinding.execution_generation_id,
      updatedAt: successorBinding.updated_at,
    });
    releaseTerminalLoad();
    await staleTerminal;
    const afterStaleTerminal = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === "binding_race")!;
    assert.equal(afterStaleTerminal.observed_state, "working", "a stale terminal callback cannot transition the successor manifest entry");
    assert.equal(afterStaleTerminal.provider_ref?.provider_continuation_id, "continuation_successor");
    assert.equal(replacementInternals.liveHandles.get("binding_race"), successorHandle, "the successor provider handle remains live");
    assert.equal(fakeExecutions[0]!.terminal, null, "the stale callback cannot terminalize the shared execution after its handle was replaced");
    assert.equal(fakeExecutions[1]!.terminal, null, "the successor execution remains live");

    releaseCommit();
    releaseBindingCommit();
    await Promise.all([lateMutation, lateBinding]);
    const listed = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(listed.some((candidate) => candidate.id === "must_not_commit_after_handoff"), false);
    assert.doesNotMatch(await readFile(paths.auditPath, "utf8").catch(() => ""), /must_not_commit_after_handoff/);
    assert.equal((await replacementBindings.get("binding_race"))?.agent_session_id, "session_new", "a stale bind cannot overwrite its successor generation");
  } finally {
    releaseCommit();
    releaseBindingCommit();
    heldSocket?.destroy();
    await second?.stop();
    await env.cleanup();
  }
});

test("daemon control surface persists three-axis state, dual-axis liveness, and bounded activity", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true);
    assert.equal((status.result as { generation: number }).generation, 1);
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, workspace_path: "/tmp/work" } });
    assert.equal(put.ok, true);
    const listed = await daemonRequest(paths.socketPath, "manifest.list");
    const saved = (listed.result as DaemonManifestEntry[])[0];
    assert.equal(saved.desired_state, "running");
    assert.equal(saved.workplace_liveness?.state, "unknown");
    assert.equal(saved.native_liveness?.state, "unknown");
    const paused = await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: entry.id, desired_state: "paused" });
    assert.equal((paused.result as DaemonManifestEntry).desired_state, "paused");
    const event = { observed_at: "2026-01-01T00:00:01.000Z", sequence: 1, provider: "codex", kind: "turn_lifecycle", method: "turn/started", summary: "Working on the task", status: "working", payload: {}, payload_truncated: false, payload_redacted: true, durable_payload_ref: null };
    const active = await daemonRequest(paths.socketPath, "manifest.append_activity", { id: entry.id, event });
    assert.equal((active.result as DaemonManifestEntry).observed_state, "working");
    assert.equal((active.result as DaemonManifestEntry).native_liveness?.state, "active");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", { id: entry.id, state: "reachable", detail: "heartbeat", observed_at: "2026-01-01T00:00:01.000Z" });
    const stale = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
    assert.equal(stale.workplace_liveness?.state, "stale");
    assert.equal(stale.native_liveness?.state, "stale");
    assert.equal(stale.observed_state, "working", "stale axes are a probe/suspect signal, never manufactured death");
    assert.equal(stale.condition, "none");
    const detail = await daemonRequest(paths.socketPath, "attempt.read", { id: entry.id });
    assert.equal((detail.result as { workspace_path: string | null }).workspace_path, null, "attempt.read never launders a manifest placeholder into durability authority");
    assert.equal((detail.result as { activity: unknown[] }).activity.length, 1);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("daemon ingress redacts provider credentials before manifest, DTO, and audit persistence", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const canary = "canary-not-a-real-credential-123456789";
  const workerBearer = `lasb_${"A".repeat(43)}`;
  const hostGrant = `lashg_${"b".repeat(43)}`;
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, id: "credential_firewall" } });
    const response = await daemonRequest(paths.socketPath, "manifest.append_activity", {
      id: "credential_firewall",
      event: {
        observed_at: "2026-01-01T00:00:01.000Z",
        sequence: 1,
        provider: "claude-code",
        kind: "tool_result",
        method: `tool/result Authorization: Bearer ${canary}`,
        summary: `LETAGENTS_TOKEN=${canary}`,
        status: "working",
        payload: {
          nested: [{ LETAGENTS_TOKEN: canary }, { api_key: canary }, { clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }],
          json: JSON.stringify({ LETAGENTS_TOKEN: canary }),
          header: `Authorization: Bearer ${canary}`,
          basic: `Authorization: Basic ${canary}`,
          arbitraryAuthorization: `Authorization: ${canary}`,
          stringifiedHeaders: JSON.stringify({ bearer: `Authorization: Bearer ${canary}`, basic: `Authorization: Basic ${canary}`, arbitrary: `Authorization: ${canary}` }),
          stringifiedCamelCase: JSON.stringify({ clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }),
          standaloneOwnedTokens: `worker=${workerBearer} host=${hostGrant}`,
          stringifiedOwnedTokens: JSON.stringify({ message: `${workerBearer} ${hostGrant}` }),
        },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: `Authorization: Bearer ${canary}`,
      },
    });
    assert.equal(response.ok, true, response.error);
    const dto = response.result as DaemonManifestEntry;
    assert.equal(dto.activity?.[0]?.payload_redacted, true);
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(workerBearer));
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(hostGrant));
    const persistedActivity = await readFile(paths.manifestPath, "utf8");
    assert.doesNotMatch(persistedActivity, new RegExp(canary));
    assert.doesNotMatch(persistedActivity, new RegExp(workerBearer));
    assert.doesNotMatch(persistedActivity, new RegExp(hostGrant));

    await daemon.transition("credential_firewall", "failed", "coordination_blocked", `Authorization: Bearer ${canary}`, `LETAGENTS_TOKEN=${canary}`, {
      exit_timestamps_ms: [],
      consecutive_action_failures: 0,
      last_observed_state: "failed",
      next_restart_at_ms: null,
      completed_action_ids: [],
      last_action_sequence: 0,
      pending_action: null,
      last_terminal: {
        ended_at: "2026-01-01T00:00:02.000Z",
        exit_code: 1,
        signal: null,
        stdio_archive_ref: `LETAGENTS_TOKEN=${canary}`,
        stdio_tail: `Authorization: Bearer ${canary}`,
        terminal_cause: `OPENAI_API_KEY=${canary}`,
        actor: `LETAGENTS_TOKEN=${canary}`,
        generation: 1,
        provider_continuation_id: `Authorization: Bearer ${canary}`,
      },
    });
    assert.doesNotMatch(await readFile(paths.manifestPath, "utf8"), new RegExp(canary));
    assert.match(await readFile(paths.manifestPath, "utf8"), /REDACTED/);
    assert.doesNotMatch(await readFile(paths.auditPath, "utf8"), new RegExp(canary));
    assert.match(await readFile(paths.auditPath, "utf8"), /REDACTED/);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("concurrent supervised creates get independent lanes while duplicate request ids stay exactly-once", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  let daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const candidate = (id: string): DaemonManifestEntry => ({
      ...entry,
      id,
      room_id: "focus_37",
      provider: "codex",
      desired_state: "paused",
      observed_state: "paused",
    });
    const results = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("owner_a") }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("owner_b") }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 2);
    let manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.deepEqual(manifest.map((candidate) => candidate.id).sort(), ["owner_a", "owner_b"]);

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "owner_a", desired_state: "running",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "owner_b", desired_state: "stopped",
    })).ok, true, "one supervised agent stops independently");

    const retry = await daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("owner_a") });
    assert.equal(retry.ok, true);
    assert.equal((retry.result as DaemonManifestEntry).desired_state, "running", "a stale creation retry cannot rewind lifecycle state");
    const conflictingRetry = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...candidate("owner_a"), charter: "different agent" },
    });
    assert.equal(conflictingRetry.ok, false);
    assert.match(conflictingRetry.error ?? "", /already bound to different agent parameters/);

    await daemon.stop();
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(manifest.filter((candidate) => candidate.id === "owner_a").length, 1, "daemon restart preserves exactly one durable request owner");
    assert.equal(manifest.find((candidate) => candidate.id === "owner_a")?.desired_state, "running");
    assert.equal(manifest.find((candidate) => candidate.id === "owner_b")?.desired_state, "stopped");
    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_blocked_by_any_supervised", room_id: "focus_37", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false, "any active supervised agent keeps the legacy provider engine fenced out");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "owner_a", desired_state: "stopped",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_after_all_supervised_stop", room_id: "focus_37", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true, "legacy migration is available only after every supervised agent stops");
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      reservation_id: "legacy_after_all_supervised_stop",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "owner_b", desired_state: "running",
    })).ok, true, "one previously stopped supervised agent can restart independently");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("legacy and supervised lanes share one durable linearization point in both flip directions", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string, roomId: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: roomId,
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();

    // Legacy wins the first linearization point. A paused transfer claim may
    // be recorded, but it cannot activate/spawn until the legacy owner exits.
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_first", room_id: "room_legacy_first", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_pending", "room_legacy_first"),
    })).ok, true);
    const blockedActivation = await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_pending", desired_state: "running",
    });
    assert.equal(blockedActivation.ok, false);
    assert.match(blockedActivation.error ?? "", /legacy reservation/);
    assert.equal((await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: "legacy_first", session_id: "legacy_session_first",
    })).ok, true);

    // After the confirmed legacy stop/release, the pending supervised claim
    // is the only engine allowed to activate.
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      session_id: "legacy_session_first",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_pending", desired_state: "running",
    })).ok, true);

    // Supervised wins the opposite direction before a legacy spawn. The
    // legacy reservation fails, so its caller cannot enter runtime.start.
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_first", "room_supervised_first"),
    })).ok, true);
    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_loser", room_id: "room_supervised_first", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false);
    assert.match(blockedLegacy.error ?? "", /supervised entry/);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_first", desired_state: "running",
    })).ok, true);

    // Barrier edge: the legacy runtime became visible before its reservation
    // was bound to a session. Supervised teardown releases by lane, so the
    // pending supervised claim activates and the late legacy bind is fenced.
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_mid_spawn", room_id: "room_mid_spawn", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_mid_spawn", "room_mid_spawn"),
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      room_id: "room_mid_spawn", provider: "codex",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_mid_spawn", desired_state: "running",
    })).ok, true);
    const lateLegacyBind = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: "legacy_mid_spawn", session_id: "legacy_session_late",
    });
    assert.equal(lateLegacyBind.ok, false);
    assert.match(lateLegacyBind.error ?? "", /Unknown legacy lane reservation/);

    const durable = await new ManifestStore(paths.manifestPath).load();
    assert.deepEqual(durable.legacy_lane_owners ?? [], []);
    assert.equal(durable.entries.filter((owner) => owner.desired_state === "running").length, 3);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("public-socket barrier races observe exactly one real mixed-engine product-path callback in both winner directions", async () => {
  for (const releaseOrder of [["legacy", "supervised"], ["supervised", "legacy"]] as const) {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"),
      socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "manifest.json"),
      auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"),
      attemptsRoot: join(env.root, "attempt-data"),
      workspaceRoot: env.root,
    };
    const roomId = `room_product_race_${releaseOrder[0]}`;
    const supervisedId = `supervised_product_race_${releaseOrder[0]}`;
    const reservationId = `legacy_product_race_${releaseOrder[0]}`;
    const workspace = await provisionedWorkspace(env.root, supervisedId);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({
      taskId: supervisedId,
      leaseId: supervisedId,
      leaseEpoch: 0,
      workspacePath: workspace.path,
      workAttemptId: workspace.id,
    });
    let legacyStarts = 0;
    let supervisedSpawns = 0;
    let supervisedStreamDeliveries = 0;
    const handle = {
      workAttemptId: attempt.work_attempt_id,
      pid: 42,
      providerContinuationId: `continuation_${releaseOrder[0]}`,
      observedState: "working" as const,
    };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async (request) => {
        supervisedSpawns += 1;
        assert.equal(request.workAttemptId, attempt.work_attempt_id);
        return handle;
      },
      attach: async () => null,
      attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("fresh mixed-engine race must not resume"); },
      poke: async () => {},
      stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
      onExit: async () => () => {},
      onStream: async (_providerHandle, listener) => {
        queueMicrotask(() => {
          supervisedStreamDeliveries += 1;
          listener({
            workAttemptId: attempt.work_attempt_id,
            providerContinuationId: handle.providerContinuationId,
            observedAt: new Date().toISOString(),
            sequence: 1,
            provider: "codex",
            kind: "turn_lifecycle",
            method: "turn/product-path-delivery",
            payload: { releaseOrder },
            payloadTruncated: false,
            payloadRedacted: false,
            durablePayloadRef: null,
          });
        });
        return () => {};
      },
    };
    const mutationBarrier = orderedDaemonMutationBarrier(releaseOrder);
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 60_000, mutationBarrier.gate);
    try {
      await daemon.start();
      const barrierRequest = concurrentDaemonRequestBarrier(paths.socketPath);
      const legacy = launchLegacyWithOwnership({
        reserve: async () => {
          const result = await barrierRequest("legacy", "lane.reserve_legacy", {
            reservation_id: reservationId,
            room_id: roomId,
            provider: "codex",
            owner_pid: process.pid,
            owner_process_identity: TEST_PROCESS_IDENTITY,
          });
          if (!result.ok) throw new Error(result.error);
        },
        start: async () => {
          legacyStarts += 1;
          return { sessionId: `legacy_session_${releaseOrder[0]}` };
        },
        activate: async (started) => {
          const result = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
            reservation_id: reservationId,
            session_id: started.sessionId,
          });
          if (!result.ok) throw new Error(result.error);
        },
        stop: async () => { legacyStarts -= 1; },
        release: async () => {
          await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: reservationId });
        },
      });
      const supervised = barrierRequest("supervised", "manifest.put", {
        entry: {
          ...entry,
          id: supervisedId,
          room_id: roomId,
          provider: "codex",
          desired_state: "running",
          observed_state: "absent",
          workspace_path: attempt.workspace_path,
          work_attempt_id: attempt.work_attempt_id,
        },
      });
      const [legacyResult, supervisedResult] = await Promise.allSettled([legacy, supervised]);
      assert.deepEqual([...mutationBarrier.arrived].sort(), ["legacy", "supervised"], "both public claim frames reach the daemon before either mutation is released");

      if (releaseOrder[0] === "legacy") {
        assert.equal(legacyResult.status, "fulfilled");
        assert.equal(supervisedResult.status, "fulfilled");
        assert.equal(supervisedResult.value.ok, false);
        assert.match(supervisedResult.value.error ?? "", /legacy reservation/);
      } else {
        assert.equal(supervisedResult.status, "fulfilled");
        assert.equal(supervisedResult.value.ok, true, supervisedResult.value.error);
        assert.equal(legacyResult.status, "rejected");
        assert.match(String(legacyResult.reason), /supervised entry/);
        await eventually(async () => supervisedSpawns === 1 && supervisedStreamDeliveries === 1, "supervised spawn and stream delivery callbacks");
        await eventually(async () => {
          const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
          return manifest.find((candidate) => candidate.id === supervisedId)?.activity?.some((event) => event.method === "turn/product-path-delivery") === true;
        }, "supervised stream delivery persisted through the daemon product path");
      }

      const expected = releaseOrder[0] === "legacy" ? [1, 0] : [0, 1];
      assert.deepEqual([legacyStarts, supervisedSpawns], expected, "real legacy start and ProviderActionPort.spawn callbacks have exactly one winner");
      assert.equal(supervisedStreamDeliveries, expected[1], "only the supervised winner installs and receives its provider stream delivery");
    } finally {
      await daemon.stop();
      await env.cleanup();
    }
  }
});

test("daemon start deterministically removes crash-orphaned reserved legacy lanes", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  await new ManifestStore(paths.manifestPath).write(0, [], [{
    reservation_id: "orphaned_reservation",
    room_id: "room_orphaned",
    provider: "codex",
    owner_pid: 2_147_483_647,
    owner_process_identity: "orphaned-process-identity",
    state: "reserved",
    session_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }]);
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.deepEqual((await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [], []);
    const claim = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "supervised_after_orphan", room_id: "room_orphaned", provider: "codex", desired_state: "paused" },
    });
    assert.equal(claim.ok, true, claim.error);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("restart fences a title-mutated orphan, durably closes its generation, and resumes one successor", async () => {
  const env = await fixture();
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "durable\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const continuation = "claude-session-durable";
  let activeChild: ChildProcess | null = null;
  let originalPid: number | null = null;
  let recordedBirthIdentity: string | null = null;
  let workAttemptId = "";
  let fencedBeforeTerminalEvidence = false;
  let resumeCount = 0;

  const launch = async (mutateTitle: boolean) => {
    const script = mutateTitle
      ? "setTimeout(() => { process.title = 'claude'; }, 50); setInterval(() => {}, 1000)"
      : "setInterval(() => {}, 1000)";
    activeChild = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await eventually(async () => typeof defaultGetProcessIdentity(activeChild!.pid!) === "string", "provider birth identity");
    return activeChild;
  };
  const publicHandle = () => ({
    workAttemptId,
    pid: activeChild?.pid ?? null,
    providerContinuationId: continuation,
    providerConnection: {
      kind: "claude_cli" as const,
      pid: activeChild?.pid ?? null,
      processIdentity: defaultGetProcessIdentity(activeChild!.pid!) ?? null,
    },
    observedState: "working" as const,
  });
  const firstPort: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      await launch(true);
      originalPid = activeChild!.pid!;
      recordedBirthIdentity = defaultGetProcessIdentity(originalPid);
      return publicHandle();
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("first daemon must not resume"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: continuation }),
    onExit: async () => () => {},
  };
  const secondPort: ProviderActionPort = {
    capabilities: firstPort.capabilities,
    spawn: async () => { throw new Error("durable Claude continuation must resume, not spawn"); },
    attach: async (ref) => {
      assert.equal(ref.providerContinuationId, continuation);
      assert.equal(ref.providerConnection?.processIdentity, recordedBirthIdentity);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(defaultGetProcessIdentity(originalPid!), recordedBirthIdentity, "process title mutation cannot change birth identity");
      const exited = new Promise<void>((resolve) => activeChild!.once("exit", () => resolve()));
      activeChild!.kill("SIGTERM");
      await exited;
      assert.equal(defaultGetProcessIdentity(originalPid!), null, "old writer is gone before terminal evidence crosses the adapter boundary");
      fencedBeforeTerminalEvidence = true;
      return {
        state: "terminal",
        terminal: { endedAt: new Date().toISOString(), exitCode: null, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: continuation },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref) => {
      assert.equal(fencedBeforeTerminalEvidence, true);
      assert.equal(ref.providerContinuationId, continuation);
      const persisted = JSON.parse(await readFile(paths.attemptsPath, "utf8")) as { attempts: Array<{ execution_generations: Array<{ terminal: unknown }> }> };
      assert.notEqual(persisted.attempts[0]!.execution_generations[0]!.terminal, null, "old generation is durable terminal before successor launch");
      resumeCount += 1;
      await launch(false);
      return publicHandle();
    },
    poke: async () => {},
    stop: firstPort.stop,
    onExit: async () => () => {},
  };

  const first = new SupervisorDaemon(paths, "darwin", firstPort, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "supervised_claude_fence",
      room_id: "focus_37",
      provider: "claude-code",
      observed_state: "absent",
      source_repo_path: source,
      workspace_path: null,
      work_attempt_id: null,
      provider_launch_policy: { permissionMode: "acceptEdits" },
    } });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "first Claude generation");
    const original = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_claude_fence" })).result as { execution_generations: Array<{ execution_generation_id: string }> });
    assert.equal(original.execution_generations.length, 1);
    const originalGenerationId = original.execution_generations[0]!.execution_generation_id;

    await first.stop();
    second = new SupervisorDaemon(paths, "darwin", secondPort, true);
    await second.start();
    await eventually(async () => {
      const manifest = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return manifest.observed_state === "working" && manifest.provider_ref?.execution_generation_id !== originalGenerationId;
    }, "bounded successor resume", 8_000);
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_claude_fence" })).result as {
      execution_generations: Array<{ terminal: { terminal_cause: string } | null }>;
    };
    assert.equal(fencedBeforeTerminalEvidence, true);
    assert.equal(recovered.execution_generations.length, 2, "recovery mints exactly one successor generation");
    assert.equal(recovered.execution_generations[0]!.terminal?.terminal_cause, "stopped");
    assert.equal(recovered.execution_generations[1]!.terminal, null);
    assert.equal(resumeCount, 1);
  } finally {
    await first.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
    if (activeChild?.pid) {
      try { activeChild.kill("SIGKILL"); } catch {}
    }
    await env.cleanup();
  }
});

test("generation handoff reattaches the same provider and publishes its supervised native stream to the exact worker endpoint", async () => {
  const env = await fixture();
  const nativeRequests: Array<{ headers: import("node:http").IncomingHttpHeaders; body: any }> = [];
  let rejectNativeActivity = false;
  let nativeRequestsInFlight = 0;
  let maxNativeRequestsInFlight = 0;
  const nativeServer = createHttpServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", async () => {
      nativeRequestsInFlight += 1;
      maxNativeRequestsInFlight = Math.max(maxNativeRequestsInFlight, nativeRequestsInFlight);
      const body = JSON.parse(raw);
      nativeRequests.push({ headers: request.headers, body });
      if (body.method === "turn/same-millisecond-a") await new Promise((resolve) => setTimeout(resolve, 30));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: !rejectNativeActivity, presence: { status: "working" }, lease_heartbeats: rejectNativeActivity ? [] : [{ id: "lease_exact", epoch: 7 }] }));
      nativeRequestsInFlight -= 1;
    });
  });
  await new Promise<void>((resolve, reject) => { nativeServer.once("error", reject); nativeServer.listen(0, "127.0.0.1", resolve); });
  const nativeAddress = nativeServer.address() as AddressInfo;
  const apiUrl = `http://127.0.0.1:${nativeAddress.port}`;
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "durable\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);

  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  let child: ChildProcess | null = null;
  let continuation = "thread-durable";
  let sequence = 0;
  let resumeCount = 0;
  const resumeRequests: Array<Parameters<ProviderActionPort["resume"]>[1]> = [];
  const streamListeners = new Set<(event: any) => void>();
  const exitListeners = new Set<(terminal: any) => void>();
  const handle = () => ({
    workAttemptId: "", pid: child?.pid ?? null, providerContinuationId: continuation,
    providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:65534", pid: child?.pid ?? null, processIdentity: `fixture:${child?.pid}` },
    observedState: "working" as const,
  });
  let workAttemptId = "";
  const launchChild = () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.once("exit", (code, signal) => {
      for (const listener of exitListeners) listener({ endedAt: new Date().toISOString(), exitCode: code, signal, terminalCause: "stopped", providerContinuationId: continuation });
    });
  };
  const port = (): ProviderActionPort => ({
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    attach: async (ref) => child?.pid && ref.providerContinuationId === continuation
      ? { ...handle(), workAttemptId: ref.workAttemptId }
      : null,
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref, request) => {
      resumeCount += 1;
      resumeRequests.push(request);
      workAttemptId = ref.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    poke: async () => {},
    stop: async () => new Promise((resolveStop) => {
      const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped" as const, providerContinuationId: continuation };
      child?.once("exit", () => resolveStop(terminal));
      child?.kill("SIGTERM");
    }),
    onExit: async (_providerHandle, listener) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    onStream: async (_providerHandle, listener) => { streamListeners.add(listener); return () => streamListeners.delete(listener); },
  });

  const first = new SupervisorDaemon(paths, "darwin", port(), true);
  let second: SupervisorDaemon | null = null;
  let third: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "supervised_handoff", room_id: "focus_37", provider: "codex", observed_state: "absent",
      source_repo_path: source, workspace_path: null, work_attempt_id: null,
      provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    } });
    try {
      await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "daemon-owned provider start", 8_000);
    } catch (error) {
      const state = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      throw new Error(`${(error as Error).message}: ${JSON.stringify(state)}`);
    }
    const before = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    const originalPid = before.provider_ref?.provider_connection?.pid;
    const executionGenerationId = before.provider_ref?.execution_generation_id;
    assert.equal(originalPid, child?.pid);
    const bound = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff",
      room_id: "focus_37",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: apiUrl,
    });
    assert.equal(bound.ok, true, bound.error);
    const boundProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(boundProjection.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(boundProjection.worker_binding?.work_attempt_id, workAttemptId);
    assert.equal(boundProjection.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(boundProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(boundProjection.workplace_liveness?.state, "reachable", "fresh exact binding marks the MCP workplace reachable");
    assert.doesNotMatch(JSON.stringify(boundProjection), /session-secret|api_url/, "renderer projection never exposes worker authority");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "native_harness.bound"), "initial daemon worker binding activity");
    const emitCompatWaitCursor = (roomCursor: string) => {
      for (const listener of streamListeners) listener({
        workAttemptId,
        providerContinuationId: continuation,
        observedAt: new Date().toISOString(),
        sequence: ++sequence,
        provider: "claude-code",
        kind: "text_delta",
        method: "assistant",
        payload: {
          type: "assistant",
          message: { content: [{
            type: "tool_use",
            name: "mcp__letagents__wait_for_messages",
            input: { after_message_id: roomCursor, agent_session_id: "agent_session_exact" },
          }] },
        },
        payloadTruncated: false,
        payloadRedacted: false,
        durablePayloadRef: null,
      });
    };
    emitCompatWaitCursor("msg_2818");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.room_cursor === "msg_2818", "published-runtime native wait cursor checkpoint");
    await eventually(async () => {
      const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
      return attempt.checkpoints.at(-1)?.room_cursor === "msg_2818";
    }, "published-runtime durable wait cursor checkpoint");
    const nativeCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(nativeCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2818");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2820",
    })).ok, true);
    emitCompatWaitCursor("msg_2819");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 2), "delayed compatibility cursor evidence");
    const formalCursorWins = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.equal(formalCursorWins?.room_cursor, "msg_2820", "delayed compatibility evidence cannot regress the formal response cursor");
    const formalCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(formalCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2820", "durable attempt progress follows the same serialized no-regression order");
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "tool_lifecycle", method: "item/toolCall/started", payload: { tool: "test" }, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 3), "first native stream event after cursor evidence");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "item/toolCall/started"), "daemon-supervised stream HTTP publication");
    const published = nativeRequests.find((request) => request.body.method === "item/toolCall/started")!;
    assert.equal(published.headers.authorization, undefined, "daemon never persists or sends owner/optional bearer authority");
    assert.equal(published.body.agent_session_id, "agent_session_exact");
    assert.equal(published.body.agent_session_token, "session-secret");
    assert.equal(published.body.status, "working");
    assert.equal(typeof published.body.sequence, "number");
    assert.ok(published.body.sequence > 0);
    assert.equal((await stat(paths.workerBindingsPath)).mode & 0o777, 0o600);
    const bindingFile = await readFile(paths.workerBindingsPath, "utf8");
    assert.doesNotMatch(bindingFile, /authorization|Bearer|scoped-worker-bearer/, "binding store carries no owner or optional bearer authority");
    assert.doesNotMatch(await readFile(paths.manifestPath, "utf8"), /session-secret/);
    const nativeCanary = "canary-not-a-real-native-secret-123456789";
    const nativeInternals = first as unknown as { publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean> };
    await nativeInternals.publishNativeActivity("supervised_handoff", `tool Authorization: Bearer ${nativeCanary}`, "working");
    const canaryPublication = nativeRequests.at(-1)!;
    assert.doesNotMatch(JSON.stringify(canaryPublication.body), new RegExp(nativeCanary));
    assert.match(canaryPublication.body.method, /REDACTED/);

    const sameObservedAt = new Date().toISOString();
    for (const [method, eventObservedAt] of [
      ["turn/same-millisecond-a", sameObservedAt],
      ["turn/same-millisecond-b", sameObservedAt],
      ["turn/reordered-older", new Date(Date.parse(sameObservedAt) - 60_000).toISOString()],
    ] as const) {
      for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: eventObservedAt, sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method, payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    }
    await eventually(async () => nativeRequests.filter((request) => /same-millisecond|reordered-older/.test(request.body.method)).length === 3, "same-ms and reordered native publications");
    const orderedPublications = ["item/toolCall/started", "turn/same-millisecond-a", "turn/same-millisecond-b", "turn/reordered-older"]
      .map((method) => nativeRequests.find((request) => request.body.method === method)!.body);
    for (let index = 1; index < orderedPublications.length; index += 1) {
      assert.ok(orderedPublications[index]!.sequence > orderedPublications[index - 1]!.sequence);
      assert.ok(Date.parse(orderedPublications[index]!.observed_at) > Date.parse(orderedPublications[index - 1]!.observed_at));
    }
    assert.equal(maxNativeRequestsInFlight, 1, "the durable publication mutex remains held through fetch completion");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 6), "serialized local native events");

    await first.stop();
    assert.doesNotThrow(() => process.kill(originalPid!, 0), "provider survives daemon handoff");
    second = new SupervisorDaemon(paths, "darwin", port(), true);
    await second.start();
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "replacement daemon attach");
    await eventually(async () => streamListeners.size === 1, "replacement native stream subscription");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "unknown",
      detail: "replacement daemon awaiting exact persisted bind",
      observed_at: new Date().toISOString(),
    });
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const after = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(after.provider_ref?.provider_connection?.pid, originalPid);
    assert.equal(after.provider_ref?.provider_continuation_id, continuation);
    assert.equal((after as DaemonManifestEntryView).worker_binding?.agent_session_id, "agent_session_exact", "daemon handoff preserves the public exact-session projection");
    assert.equal(after.workplace_liveness?.state, "reachable", "idempotent persisted bind restores workplace reachability after daemon replacement");
    sequence = 0; // A freshly attached adapter has a fresh local counter.
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "item_lifecycle", method: "item/completed", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 7), "reattached stream event");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "item/completed"), "replacement daemon native stream publication");
    assert.equal(after.activity?.at(-1)?.sequence, 6);
    const withReattachedStream = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(withReattachedStream.activity?.at(-1)?.sequence, 7, "daemon preserves global activity ordering across adapter counter reset");
    const firstPublished = nativeRequests.find((request) => request.body.method === "item/toolCall/started")!;
    const reattachedPublished = nativeRequests.find((request) => request.body.method === "item/completed")!;
    assert.ok(reattachedPublished.body.sequence > firstPublished.body.sequence, "durable publisher sequence survives daemon generation handoff");

    rejectNativeActivity = true;
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/rejected-for-successor", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => nativeRequests.some((request) => request.body.method === "turn/rejected-for-successor"), "successor fence rejection");
    await eventually(async () => !/agent_session_exact/.test(await readFile(paths.workerBindingsPath, "utf8")), "stale worker binding removal");
    const requestsAfterFence = nativeRequests.length;
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/must-not-publish-after-fence", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 9), "local post-fence stream evidence");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nativeRequests.length, requestsAfterFence, "successor rejection fences later native publications");

    const generationsBeforeBindingRecovery = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { execution_generations: unknown[] }).execution_generations.length;
    const recoveryInternals = second as unknown as {
      transition: (entryId: string, observed: "recovering", condition: "coordination_blocked", cause: string, actor: string) => Promise<void>;
    };
    await recoveryInternals.transition("supervised_handoff", "recovering", "coordination_blocked", "lost current worker binding during exact-generation recovery", "test-recovery");
    const latchedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(latchedProjection.worker_binding, null);
    assert.equal(latchedProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(latchedProjection.condition, "coordination_blocked");
    assert.equal(latchedProjection.reconciliation?.pending_action, null);

    rejectNativeActivity = false;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_cursor_exact",
    })).ok, true);
    const recoveredProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recoveredProjection.observed_state, "working");
    assert.equal(recoveredProjection.condition, "none", "exact worker rebind clears the coordination latch");
    assert.equal(recoveredProjection.last_error, null);
    assert.equal(recoveredProjection.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(recoveredProjection.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(recoveredProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    const generationsAfterBindingRecovery = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { execution_generations: unknown[] }).execution_generations.length;
    assert.equal(generationsAfterBindingRecovery, generationsBeforeBindingRecovery, "binding recovery cannot mint a duplicate execution generation");
    assert.equal(resumeCount, 0, "binding recovery reuses the same worker before a later intentional pause/resume");
    const checkpointsBeforeNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_cursor_exact",
    })).ok, true);
    const checkpointsAfterNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal(checkpointsAfterNoop, checkpointsBeforeNoop, "an unchanged poll cursor appends no durability checkpoint");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "paused" });
    await eventually(async () => !child?.pid || (() => { try { process.kill(child.pid!, 0); return false; } catch { return true; } })(), "daemon stop authority");
    await eventually(async () => /agent_session_exact/.test(await readFile(paths.workerBindingsPath, "utf8")), "paused attempt retains exact private worker continuity");
    const stoppedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(stoppedProjection.worker_binding, null, "paused terminal generation is not projected as live worker authority");
    assert.equal(stoppedProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "pause preserves the non-secret exact control route");
    await eventually(async () => {
      const stopped = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return stopped.observed_state === "paused" && stopped.condition === "none";
    }, "intentional pause remains unblocked after the terminal callback");

    const stoppedPid = child?.pid;
    const stoppedGenerationId = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!.provider_ref!.execution_generation_id;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const resumed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumed.observed_state === "working" && resumed.condition === "none" && resumed.provider_ref?.execution_generation_id !== stoppedGenerationId;
    }, "intentional stop resumes under a successor execution generation");
    const resumed = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(resumed.id, "supervised_handoff");
    assert.equal(resumed.work_attempt_id, workAttemptId, "resume preserves the durable work attempt");
    assert.equal(resumed.provider_ref?.provider_continuation_id, continuation, "resume preserves provider continuation identity");
    assert.notEqual(resumed.provider_ref?.provider_connection?.pid, stoppedPid, "resume installs the replacement provider process");
    assert.equal(resumeCount, 1);
    assert.deepEqual(resumeRequests[0]?.supervisorWorkerSession, {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_cursor_exact",
    }, "resume receives the exact prior worker identity and cursor without its secret");
    assert.doesNotMatch(JSON.stringify(resumeRequests[0]), /session-secret/, "provider request never receives worker session authority");
    const resumedGenerationId = resumed.provider_ref!.execution_generation_id;
    const rebound = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: resumedGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    });
    assert.equal(rebound.ok, true, rebound.error);
    const reboundProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(reboundProjection.worker_binding?.agent_session_id, "agent_session_exact", "the successor execution restores the same worker binding");
    assert.equal(reboundProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "the durable exact control route remains unchanged");
    assert.equal(reboundProjection.worker_binding?.execution_generation_id, resumedGenerationId);
    assert.doesNotMatch(JSON.stringify(reboundProjection), /session-secret/);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_cursor_after_resume",
    })).ok, true);
    for (const listener of streamListeners) listener({
      workAttemptId,
      providerContinuationId: continuation,
      observedAt: new Date().toISOString(),
      sequence: ++sequence,
      provider: "claude-code",
      kind: "error",
      method: "result/error_during_execution",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    });
    await eventually(async () => {
      const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return recovered.observed_state === "working"
        && recovered.provider_ref?.execution_generation_id !== resumedGenerationId;
    }, "terminal provider turn enters a bounded resume generation");
    const recovered = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    const recoveredGenerationId = recovered.provider_ref!.execution_generation_id;
    assert.equal(resumeCount, 2);
    assert.deepEqual(resumeRequests[1]?.supervisorWorkerSession, {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_cursor_after_resume",
    });
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: recoveredGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true, "the recovered generation rebinds the same exact worker session");
    const staleBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_stale",
      work_attempt_id: workAttemptId, execution_generation_id: stoppedGenerationId,
      agent_session_token: "stale-secret", api_url: apiUrl,
    });
    assert.equal(staleBind.ok, false, "a terminal predecessor generation cannot bind a worker session");
    assert.match(staleBind.error ?? "", /terminal/);
    const resumedAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { restart_count: number; execution_generations: Array<{ terminal: unknown }> };
    assert.equal(resumedAttempt.restart_count, 2);
    assert.ok(resumedAttempt.execution_generations[0]?.terminal, "the predecessor terminal remains immutable after resume");
    assert.ok(resumedAttempt.execution_generations[1]?.terminal, "the native terminal-turn generation is durably terminal");
    assert.equal(resumedAttempt.execution_generations[2]?.terminal, null, "the recovered successor is the only live generation");

    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "stopped" });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped"), "second intentional stop");
    await second.stop();
    second = null;
    third = new SupervisorDaemon(paths, "darwin", port(), true);
    await third.start();
    await eventually(async () => {
      const stopped = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return stopped.observed_state === "stopped" && stopped.condition === "none";
    }, "replacement daemon keeps a terminal generation stopped without stale attachment");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const resumedAfterHandoff = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumedAfterHandoff.observed_state === "working" && resumedAfterHandoff.condition === "none";
    }, "replacement daemon resumes the stopped work attempt");
    assert.equal(resumeCount, 3);
  } finally {
    await third?.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already stopped */ } }
    await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
    await env.cleanup();
  }
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
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:0${tick++}.000Z`, join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
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
    const terminalCanary = "canary-not-a-real-terminal-secret-123456789";
    const resumedTerminal = await store.recordTerminal(attempt.work_attempt_id, resumed.execution_generation_id, { ended_at: "2026-01-01T00:00:10.000Z", exit_code: 0, signal: null, stdio_archive_ref: `LETAGENTS_TOKEN=${terminalCanary}`, stdio_tail: `Authorization: Bearer ${terminalCanary}`, terminal_cause: `OPENAI_API_KEY=${terminalCanary}`, actor: "daemon", generation: 2, provider_continuation_id: null });
    assert.doesNotMatch(JSON.stringify(resumedTerminal.terminal), new RegExp(terminalCanary));
    assert.doesNotMatch(await readFile(store.path, "utf8"), new RegExp(terminalCanary));
    assert.match(JSON.stringify(resumedTerminal.terminal), /REDACTED/);
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "reviewed", postmortemDiff: "diff --git a/a b/a" });
    await assert.rejects(() => store.rebindAttempt(attempt.work_attempt_id, "lease-3", 3), ImmutableExecutionError);
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
    const refresh = commands.findIndex((args) => args.includes("fetch"));
    const resolution = commands.findIndex((args) => args.includes("abc^{commit}"));
    assert.ok(refresh >= 0 && refresh < resolution, "the verified origin is refreshed before revision resolution");
    assert.equal(commands[refresh]![1], await realpath(join(env.root, "repos", "repo.git")));
    assert.deepEqual(commands[refresh], [
      "--git-dir", await realpath(join(env.root, "repos", "repo.git")),
      "fetch", "--prune", "--no-tags", "origin",
      "+refs/heads/*:refs/letagents/remotes/origin/*",
      "+refs/tags/*:refs/letagents/tags/*",
    ]);
    assert.match(first.path, new RegExp(`worktrees/repo/${workAttemptId}$`));
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
  assert.match(first, /^shared-project-[0-9a-f]{16}$/);
  assert.match(second, /^shared-project-[0-9a-f]{16}$/);
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

test("workspace provisioning survives deletion of the daemon's inherited launch cwd", async () => {
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
    assert.deepEqual(await recovered.garbageCollect(0), []);
    assert.equal((await stat(protectedWorkspace.path)).isDirectory(), true);
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));

    const legacyWorkspace = await provisionedWorkspace(env.root);
    const legacyStore = new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:02.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
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
    const rebound = await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_2",
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: "https://letagents.chat",
    });
    assert.equal(rebound.room_cursor, "msg_2822");
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
