// Shared fixtures for the daemon-*.test.ts files that were split from daemon.test.ts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connectDaemon, daemonEndpoint } from "../../../../../shared/daemon-endpoint.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { removeTestDirectory } from "../../../electron/__tests__/harness.js";
import { testDaemonEndpoint, WINDOWS_TEST_HELPER } from "../../../electron/__tests__/platform.js";
import { WorkDurabilityStore } from "../../durability-store.js";
import { ManifestStore } from "../../manifest-store.js";
import { serializeDaemonDeploymentId } from "../../manifest-entry-projection.js";
import { SupervisorDaemon as ProductionSupervisorDaemon } from "../../main.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonManifestEntry } from "../../types.js";
import { WorkerBindingStore } from "../../worker-binding-store.js";
import { SupervisedAgentInboxStore } from "../../supervised-agent-inbox-store.js";
import { repositoryStorageKey } from "../../workspace-provisioner.js";
import type { ProviderActionHandle, ProviderActionPort } from "../../provider-action-port.js";
import type { NativeExecutionObservation, NativeExecutionSubscription } from "../../../shared/execution-protocol.js";
import type { ExecutionCaptureCoordinator } from "../../execution-capture-coordinator.js";
import type { ProviderCheckpointCoordinator } from "../../provider-checkpoint-coordinator.js";
import type { ProviderStreamCoordinator } from "../../provider-stream-coordinator.js";

export const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt",
  origin_execution_generation_id: "generation",
  provider_continuation_id: "continuation",
} as const;

/**
 * Unit ports stand in for the production router, whose successful spawn and
 * resume responses attest the exact configuration revision and native process
 * birth applied by the adapter. Keep those contracts explicit in this daemon
 * harness instead of weakening the production daemon's attestation checks.
 */
export function configurationAttestingTestPort(port: ProviderActionPort): ProviderActionPort {
  const attestNativeBirth = (
    handle: ProviderActionHandle,
    provider: string | undefined,
  ): ProviderActionHandle => {
    if (handle.providerConnection !== undefined) return handle;
    const processIdentity = handle.pid === null
      ? null
      : `daemon-test:${provider ?? "unknown"}:${handle.pid}:${handle.providerContinuationId ?? "none"}`;
    if (provider === "codex") {
      handle.providerConnection = {
        kind: "codex_app_server",
        url: `ws://127.0.0.1:${handle.pid ?? 0}`,
        pid: handle.pid,
        processIdentity,
      };
    } else if (provider === "claude-code") {
      handle.providerConnection = { kind: "claude_cli", pid: handle.pid, processIdentity };
    } else if (provider === "cursor") {
      handle.providerConnection = { kind: "cursor_cli", pid: handle.pid, processIdentity };
    } else if (provider === "open-model") {
      handle.providerConnection = {
        kind: "opencode_server",
        url: `http://127.0.0.1:${handle.pid ?? 0}`,
        pid: handle.pid,
        processIdentity,
        serverAuthPath: `/tmp/letagents-daemon-test-${handle.pid ?? 0}.auth`,
      };
    }
    return handle;
  };
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === "spawn") {
        return async (request: Parameters<ProviderActionPort["spawn"]>[0]) => {
          const handle = attestNativeBirth(await target.spawn(request), request.provider);
          Object.defineProperty(handle, "appliedConfigurationRevision", {
            value: request.configurationRevision,
            enumerable: false,
            configurable: true,
            writable: true,
          });
          return handle;
        };
      }
      if (property === "resume") {
        return async (ref: Parameters<ProviderActionPort["resume"]>[0], request: Parameters<ProviderActionPort["resume"]>[1]) => {
          const handle = attestNativeBirth(await target.resume(ref, request), request.provider ?? ref.provider);
          Object.defineProperty(handle, "appliedConfigurationRevision", {
            value: request.configurationRevision,
            enumerable: false,
            configurable: true,
            writable: true,
          });
          return handle;
        };
      }
      if (property === "attach") {
        return async (ref: Parameters<ProviderActionPort["attach"]>[0]) => {
          const attachment = await target.attach(ref);
          return attachment && !("state" in attachment && attachment.state === "terminal")
            ? attestNativeBirth(attachment, ref.provider)
            : attachment;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function runtimeReadySubscription(
  handle: Pick<ProviderActionHandle, "workAttemptId" | "pid" | "providerConnection">,
  listener: (event: NativeExecutionObservation) => void,
): NativeExecutionSubscription {
  const processIdentity = handle.providerConnection?.processIdentity ?? null;
  const pid = handle.providerConnection?.pid ?? handle.pid;
  const sourceId = `runtime-ready:${handle.workAttemptId}:${processIdentity ?? "unknown"}`;
  listener({
    sourceId,
    sequence: 1,
    observedAtMs: Date.now(),
    ...(pid === null ? {} : { nativeProcessPid: pid }),
    ...(processIdentity === null ? {} : { nativeProcessIdentity: processIdentity }),
    fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
  });
  return { sourceId, position: () => ({ firstRetainedSequence: 1, latestSequence: 1 }), dispose() {} };
}

export class SupervisorDaemon extends ProductionSupervisorDaemon {
  constructor(...args: ConstructorParameters<typeof ProductionSupervisorDaemon>) {
    const forwarded = [...args] as ConstructorParameters<typeof ProductionSupervisorDaemon>;
    if (forwarded[2]) forwarded[2] = configurationAttestingTestPort(forwarded[2]);
    super(...forwarded);
  }
}

export const execFileAsync = promisify(execFile);

export const noWorkLeaseHttp = {
  listWorkLeases: async () => [], readWorkLease: async () => null,
  attestWorkLease: async () => { throw new Error("Unexpected lease attestation in this fixture"); },
  rebindWorkLease: async () => { throw new Error("Unexpected lease rebind in this fixture"); },
};

export async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  // Windows refuses to delete a database that is still open: removeTestDirectory closes it, or waits for the process to end.
  return { root, cleanup: async () => { removeTestDirectory(root); } };
}

/** Set up the already-admitted ingress assumed by provider-lifecycle tests. */
export async function admitDaemonInboxForProviderTest(daemon: SupervisorDaemon, agentId: string, roomId: string): Promise<void> {
  const internals = daemon as unknown as { supervisedInbox: SupervisedAgentInboxStore };
  await internals.supervisedInbox.bootstrapCursor({ agent_id: agentId, room_id: roomId, last_observed_message_id: null });
}

/**
 * How much longer a test waits for something to happen on Windows. A named pipe, a new process and a file
 * on NTFS each take longer than their POSIX counterpart, and the Windows test machines are slower. This only
 * lengthens how long a wait for an event lasts before it fails; it never changes what a test asserts.
 */
export const WAIT_SCALE = process.platform === "win32" ? 5 : 1;

export async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs * WAIT_SCALE); })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs * WAIT_SCALE;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function fakeRecoveryClock(startMs = 10_000) {
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
    clock: { nowMs: () => nowMs, setTimeout: setTimer, clearTimeout: clearTimer, random: () => 0 },
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

export { testDaemonEndpoint } from "../../../electron/__tests__/platform.js";

// Windows reads when a process started (its birth) through the process-tree helper. The test run names where
// the built helper is; the daemon's own process identity finds it through the variable the app sets for it.
if (WINDOWS_TEST_HELPER && !process.env.LETAGENTS_PROCESS_TREE_HELPER) process.env.LETAGENTS_PROCESS_TREE_HELPER = WINDOWS_TEST_HELPER;

/**
 * How long a test waits after it sends a request, before it releases a gate that request waits at.
 * A request over a Windows pipe takes much longer to reach the daemon (the proof handshake comes first).
 */
export const REQUEST_ARRIVAL_MS = process.platform === "win32" ? 500 : 10;

export async function daemonRequest(socketPath: string, method: string, params?: unknown, version = DAEMON_PROTOCOL_VERSION): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> {
  return new Promise((resolve, reject) => {
    const client = connectDaemon(socketPath);
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

export const TEST_OID = "a".repeat(40);
export const TEST_SUPERVISOR = { supervisor_id: "test-daemon", supervisor_generation: 1 };
export async function provisionedWorkspace(root: string, taskId = "task", workAttemptId = randomUUID()): Promise<{ path: string; id: string; bare: string }> {
  const bare = join(root, "repos", "repo.git");
  const path = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: taskId, remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  return { path, id: workAttemptId, bare };
}
export async function committedSourceRepository(root: string, name: string): Promise<string> {
  const source = join(root, name);
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);
  return source;
}
export async function primeDaemonBareRepository(root: string, source: string): Promise<void> {
  const repos = join(root, "repos");
  await mkdir(repos, { recursive: true });
  await execFileAsync("git", ["clone", "--bare", source, join(repos, `${repositoryStorageKey(source)}.git`)]);
}
export function fakeGit(root: string): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args.includes("--git-common-dir")) return join(root, "repos", "repo.git");
    if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
    if (args.includes("--is-bare-repository")) return "true";
    if (args.includes("cat-file")) return "ok";
    if (args.includes("rev-parse")) return TEST_OID;
    return "";
  };
}

/**
 * The write a provider stream makes for each activity event. The `manifest.append_activity`
 * request that once exposed it is retired, so these tests reach it through the daemon itself.
 */
export async function appendNativeActivity(daemon: SupervisorDaemon, id: string, event: DaemonActivityEvent): Promise<void> {
  const { manifestAdministration } = daemon as unknown as {
    manifestAdministration: { appendNativeActivity(id: string, event: DaemonActivityEvent, activityOnly: boolean): Promise<void> };
  };
  await manifestAdministration.appendNativeActivity(id, event, false);
  await flushActivity(daemon);
}

/**
 * Native activity is admitted at once but committed in short batches. Tests
 * that read stored activity right after a stream event write the batch first,
 * as the window timer would.
 */
export function flushActivity(daemon: SupervisorDaemon): Promise<void> {
  return (daemon as unknown as { activityWrites: { flush(): Promise<void> } }).activityWrites.flush();
}

export const entry: DaemonManifestEntry = {
  id: "agent_1", room_id: "room_1", display_name: "Agent", provider: "test", model: null, charter: "test",
  desired_state: "running", observed_state: "idle", condition: "none", permission_profile_id: null, created_by: "test", created_at: "2026-01-01T00:00:00.000Z",
};

/** Real daemon storage/lifecycle wiring with only the native observer faked. */
export async function observationDaemonFixture(onExecution: NonNullable<ProviderActionPort["onExecution"]>, provider: "codex" | "claude-code" | "cursor" = "codex", overrides: Partial<ProviderActionPort> = {}, codexConnection?: Extract<NonNullable<ProviderActionHandle["providerConnection"]>, { kind: "codex_app_server" }>) {
  const env = await fixture();
  const id = "observed-agent";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("observation fixture installs an existing exact handle"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("observation fixture must not resume a provider"); }, poke: async () => {},
    stop: async () => { throw new Error("observation must never control the provider"); },
    onExit: async () => () => {}, onStream: async () => () => {}, onExecution, ...overrides,
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false);
  const internals = daemon as unknown as {
    durability: WorkDurabilityStore; store: ManifestStore; supervisedInbox: SupervisedAgentInboxStore;
    workerBindings: WorkerBindingStore; providerStreams: ProviderStreamCoordinator;
    providerCheckpoints: ProviderCheckpointCoordinator; executionCapture: ExecutionCaptureCoordinator | null;
    liveHandles: Map<string, ProviderActionHandle>;
    manifestGeneration: number;
  };
  try {
    await daemon.start();
    assert.ok(internals.executionCapture, "optional writer opens only after real protected schema initialization");
    const workspace = await provisionedWorkspace(env.root, id);
    const attempt = await internals.durability.createAttempt({
      taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
    });
    const execution = await internals.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
    const handle: ProviderActionHandle = {
      workAttemptId: attempt.work_attempt_id, providerContinuationId: "observed-continuation", observedState: "working",
      pid: provider === "cursor" ? null : codexConnection?.pid ?? 7123,
      providerConnection: provider === "cursor" ? { kind: "cursor_cli", pid: null, processIdentity: null }
        : provider === "claude-code" ? { kind: "claude_cli", pid: 7123, processIdentity: "observed-birth" }
          : codexConnection ?? { kind: "codex_app_server", pid: 7123, processIdentity: "observed-birth", url: "ws://127.0.0.1:7123" },
    };
    const stored: DaemonManifestEntry = {
      ...entry, id, provider, delivery_mode: "daemon_inbox", workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id, run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      runtime_configuration_revision: 1,
      provider_ref: { work_attempt_id: attempt.work_attempt_id, execution_generation_id: execution.execution_generation_id,
        provider_continuation_id: handle.providerContinuationId!, provider_connection: handle.providerConnection! },
    };
    const inserted = await daemonRequest(paths.socketPath, "manifest.put", { entry: stored });
    assert.equal(inserted.ok, true, inserted.error);
    handle.appliedConfigurationRevision = 1;
    const persisted = await internals.store.load();
    const current = persisted.entries.find((candidate) => candidate.id === id);
    assert.ok(current);
    const birth = await internals.store.checkpointProviderBirth(persisted.generation, {
      entry: current,
      executionGenerationId: execution.execution_generation_id,
      providerConnection: handle.providerConnection!,
      appliedRevision: 1,
      requestedAuthorityMode: "typed_shadow",
      observedAtMs: Date.now(),
    });
    internals.manifestGeneration = birth.generation;
    return { ...env, id, paths, daemon, internals, handle, port, generation: execution.execution_generation_id,
      cleanup: async () => { await daemon.stop(); await env.cleanup(); } };
  } catch (error) {
    await daemon.stop().catch(() => undefined); await env.cleanup(); throw error;
  }
}

export async function originRemoteFixture(root: string) {
  const remote = join(root, "origin.git");
  const source = join(root, "source");
  const git = async (args: string[]) => (await execFileAsync("git", args)).stdout.trim();
  await git(["init", "--bare", remote]);
  await git(["init", source]);
  await git(["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await git(["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "first\n");
  await git(["-C", source, "add", "README.md"]);
  await git(["-C", source, "commit", "-m", "first"]);
  await git(["-C", source, "branch", "-M", "main"]);
  await git(["-C", source, "remote", "add", "origin", remote]);
  await git(["-C", source, "push", "origin", "main", "main:feature"]);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { remote, source, git, firstRevision: await git(["-C", source, "rev-parse", "HEAD"]) };
}
