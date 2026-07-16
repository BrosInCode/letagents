import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ProviderActionPortRouter,
  type NativeProviderAdapter,
} from "../provider-action-port-router.js";
import type {
  ProviderActionRef,
  ProviderActionSpawn,
  ProviderActionTerminal,
} from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";

const execFileAsync = promisify(execFile);

async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function daemonRequest(socketPath: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      socket.end();
      resolve(JSON.parse(body.slice(0, body.indexOf("\n"))));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "router-test", method, params })}\n`));
  });
}

function fakeAdapter(provider: "codex" | "claude-code", calls: string[]): NativeProviderAdapter {
  const handles = new Map<string, ReturnType<typeof nativeHandle>>();
  return {
    capabilities: () => ({
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: provider === "codex",
    }),
    async spawn(input: ProviderActionSpawn) {
      calls.push(`${provider}:spawn:${input.workAttemptId}`);
      const handle = nativeHandle(provider, input.workAttemptId, `continuation:${input.workAttemptId}`);
      handles.set(input.workAttemptId, handle);
      return handle;
    },
    async attach(ref: ProviderActionRef) {
      calls.push(`${provider}:attach:${ref.workAttemptId}`);
      return handles.get(ref.workAttemptId) ?? null;
    },
    async resume(ref: ProviderActionRef, input: ProviderActionSpawn) {
      calls.push(`${provider}:resume:${ref.workAttemptId}`);
      const handle = nativeHandle(provider, input.workAttemptId, ref.providerContinuationId);
      handles.set(input.workAttemptId, handle);
      return handle;
    },
    async poke(handle, message) { calls.push(`${provider}:poke:${handle.workAttemptId}:${message}`); },
    async stop(handle): Promise<ProviderActionTerminal> {
      calls.push(`${provider}:stop:${handle.workAttemptId}`);
      return { endedAt: "2026-07-15T00:00:00.000Z", exitCode: 0, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: handle.providerContinuationId };
    },
    onExit: () => () => {},
    onStream: () => () => {},
  };
}

function nativeHandle(provider: "codex" | "claude-code", workAttemptId: string, providerContinuationId: string) {
  return {
    workAttemptId,
    pid: provider === "codex" ? 101 : 202,
    providerContinuationId,
    providerConnection: provider === "codex"
      ? { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 101 }
      : { kind: "claude_cli" as const, pid: 202 },
    observedState: () => "working" as const,
  };
}

test("provider router selects the native adapter by manifest provider and fences stale handles", async () => {
  const calls: string[] = [];
  const router = new ProviderActionPortRouter({
    codex: async () => fakeAdapter("codex", calls),
    "claude-code": async () => fakeAdapter("claude-code", calls),
  });
  const claudeSpawn: ProviderActionSpawn = {
    provider: "claude-code", workAttemptId: "claude-attempt", roomId: "room", cwd: "/tmp/claude", launchPolicy: { permissionMode: "acceptEdits" }, actionId: "launch-claude",
  };

  assert.deepEqual(await router.capabilities("claude-attempt", "claude-code"), {
    resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false,
  });
  const handle = await router.spawn(claudeSpawn);
  assert.equal(handle.providerConnection?.kind, "claude_cli");
  await assert.rejects(
    router.capabilities("claude-attempt", "codex"),
    /Conflicting provider identities/,
  );
  assert.deepEqual(await router.attachAction("launch-claude", "claude-attempt"), { state: "attached", handle });

  const resumed = await router.resume(
    { workAttemptId: "claude-attempt", provider: "claude-code", providerContinuationId: "continuation:claude-attempt", providerConnection: handle.providerConnection },
    { ...claudeSpawn, actionId: "resume-claude" },
  );
  await router.poke(resumed, "continue", { actionId: "poke-claude" });
  assert.deepEqual(calls, [
    "claude-code:spawn:claude-attempt",
    "claude-code:resume:claude-attempt",
    "claude-code:poke:claude-attempt:continue",
  ]);

  await assert.rejects(
    router.stop({ ...resumed, pid: 999 }),
    /not owned by the current daemon generation/,
  );
  await assert.rejects(
    router.attach({
      workAttemptId: "claude-attempt",
      provider: "codex",
      providerContinuationId: "continuation:claude-attempt",
      providerConnection: handle.providerConnection,
    }),
    /Conflicting provider identities/,
  );
  await assert.rejects(
    router.resume(
      { workAttemptId: "claude-attempt", provider: "claude-code", providerContinuationId: "continuation:claude-attempt", providerConnection: handle.providerConnection },
      { ...claudeSpawn, provider: "codex" },
    ),
    /Conflicting provider identities/,
  );
  await assert.rejects(
    router.spawn({ ...claudeSpawn, provider: "cursor" }),
    /No supervised native adapter is available for cursor/,
  );
});

test("provider router forwards devMcpServerEntryPath from ProviderActionSpawn to the adapter spawn", async () => {
  let capturedSpawn: ProviderActionSpawn | null = null;
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true }),
    async spawn(input) {
      capturedSpawn = input;
      return nativeHandle("codex", input.workAttemptId, "thread-dev");
    },
    async attach() { return null; },
    async resume(_ref, input) { return nativeHandle("codex", input.workAttemptId, "thread-dev"); },
    async poke() {},
    async stop(handle) { return { endedAt: "2026-07-15T00:00:00.000Z", exitCode: 0, signal: null, terminalCause: "exited" as const, providerContinuationId: handle.providerContinuationId }; },
    onExit: () => () => {},
    onStream: () => () => {},
  };
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  await router.spawn({
    provider: "codex",
    workAttemptId: "dev-attempt",
    roomId: "room",
    cwd: "/tmp/dev",
    launchPolicy: {},
    devMcpServerEntryPath: "/absolute/path/to/dist/mcp/server.js",
  });
  assert.equal(capturedSpawn?.devMcpServerEntryPath, "/absolute/path/to/dist/mcp/server.js");
  // Absent field must not be forwarded as undefined noise.
  let capturedNoEntry: ProviderActionSpawn | null = null;
  const adapter2: NativeProviderAdapter = {
    ...adapter,
    async spawn(input) { capturedNoEntry = input; return nativeHandle("codex", input.workAttemptId, "thread-no-dev"); },
  };
  const router2 = new ProviderActionPortRouter({ codex: async () => adapter2 });
  await router2.spawn({ provider: "codex", workAttemptId: "no-dev-attempt", roomId: "room", cwd: "/tmp/no-dev", launchPolicy: {} });
  assert.equal(capturedNoEntry?.devMcpServerEntryPath, undefined);
});

test("provider router public handle reads the native observed state live", async () => {
  let observedState: "working" | "idle" | "failed" = "working";
  const calls: string[] = [];
  const adapter = fakeAdapter("claude-code", calls);
  adapter.spawn = async (input) => ({
    ...nativeHandle("claude-code", input.workAttemptId, "continuation-live"),
    observedState: () => observedState,
  });
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  const handle = await router.spawn({
    provider: "claude-code",
    workAttemptId: "attempt-live",
    roomId: "focus_37",
    cwd: "/tmp/attempt-live",
    launchPolicy: {},
  });
  assert.equal(handle.observedState, "working");
  observedState = "idle";
  assert.equal(handle.observedState, "idle", "the same daemon handle sees native result completion");
  observedState = "failed";
  assert.equal(handle.observedState, "failed", "the same daemon handle sees native terminal failure");
});

test("daemon convergence drives Claude through the router across stop and same-attempt resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-router-daemon-"));
  const source = join(root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "router@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Router Test"]);
  await writeFile(join(source, "README.md"), "router\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);

  const calls: string[] = [];
  let nextPid = 5000;
  let continuation = "claude-continuation";
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    async spawn(input) { calls.push(`spawn:${input.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async attach() { calls.push("attach"); return null; },
    async resume(ref, input) { calls.push(`resume:${ref.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async poke() { throw new Error("Claude poke is intentionally unavailable"); },
    async stop(handle) {
      calls.push(`stop:${handle.workAttemptId}`);
      const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped" as const, providerContinuationId: handle.providerContinuationId };
      queueMicrotask(() => exitListeners.get(handle.workAttemptId)?.forEach((listener) => listener(terminal)));
      return terminal;
    },
    onExit(handle, listener) {
      const listeners = exitListeners.get(handle.workAttemptId) ?? new Set<(terminal: ProviderActionTerminal) => void>();
      listeners.add(listener);
      exitListeners.set(handle.workAttemptId, listeners);
      return () => listeners.delete(listener);
    },
    onStream: () => () => {},
  };
  const exitListeners = new Map<string, Set<(terminal: ProviderActionTerminal) => void>>();
  function lifecycleHandle(workAttemptId: string) {
    const pid = ++nextPid;
    return {
      workAttemptId,
      pid,
      providerContinuationId: continuation,
      providerConnection: { kind: "claude_cli" as const, pid, processIdentity: `claude:${pid}` },
      observedState: () => "working" as const,
    };
  }
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "manifest.json"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin", router, true);
  const entry: DaemonManifestEntry = {
    id: "claude_supervised", room_id: "room", display_name: "Claude", provider: "claude-code", model: null, charter: "poll", desired_state: "running", observed_state: "absent", condition: "none",
    permission_profile_id: "ask_before_write", provider_launch_policy: { permissionMode: "default" }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
  };
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "Claude router start");
    const first = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(first.provider_ref?.provider_connection?.kind, "claude_cli");
    assert.ok(first.work_attempt_id);
    const firstGeneration = first.provider_ref?.execution_generation_id;
    const fenceDirectory = join(dirname(first.workspace_path!), ".letagents-supervisor-workspace.fences");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: entry.id, desired_state: "stopped" })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped", "Claude router stop");
    assert.equal((await readdir(fenceDirectory)).some((name) => name.startsWith("shared-")), false, "intentional Stop releases terminal workspace authority");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: entry.id, desired_state: "running" })).ok, true);
    await eventually(async () => {
      const resumed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumed.observed_state === "working" && resumed.provider_ref?.execution_generation_id !== firstGeneration;
    }, "Claude router same-attempt resume");
    const resumed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(resumed.work_attempt_id, first.work_attempt_id);
    assert.equal(resumed.provider_ref?.provider_continuation_id, continuation);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).length, 1, "same-attempt resume reacquires exactly one shared fence");
    assert.ok(calls.some((call) => call.startsWith("spawn:")));
    assert.ok(calls.some((call) => call.startsWith("stop:")));
    assert.ok(calls.some((call) => call.startsWith("resume:")));
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});
