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
import { devMcpServerEntryFromEnv } from "../dev-spawn-options.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { ManifestStore } from "../manifest-store.js";

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
      turnControl: "native_interrupt",
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
    async controlTurn(handle, correction) {
      calls.push(`${provider}:control:${handle.workAttemptId}:${correction ?? "stop"}`);
      return { capability: "native_interrupt", interrupted: true, resumed: Boolean(correction), state: correction ? "working" : "idle" };
    },
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
    resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false, turnControl: "native_interrupt",
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
  assert.deepEqual(await router.controlTurn(resumed, "redirect", { actionId: "control-claude" }), {
    capability: "native_interrupt", interrupted: true, resumed: true, state: "working",
  });
  assert.deepEqual(calls, [
    "claude-code:spawn:claude-attempt",
    "claude-code:resume:claude-attempt",
    "claude-code:poke:claude-attempt:continue",
    "claude-code:control:claude-attempt:redirect",
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
    /requires the durable agent display name/,
  );
});

test("devMcpServerEntryFromEnv returns path only when both env gates are set", () => {
  assert.equal(devMcpServerEntryFromEnv({}), null, "both absent → null");
  assert.equal(devMcpServerEntryFromEnv({ LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://localhost:3000" }), null, "entry absent → null");
  assert.equal(devMcpServerEntryFromEnv({ LETAGENTS_DEV_MCP_SERVER_ENTRY: "/abs/server.js" }), null, "dev-url absent → null");
  assert.equal(devMcpServerEntryFromEnv({ LETAGENTS_DESKTOP_DEV_SERVER_URL: "  " }), null, "whitespace-only dev-url → null");
  assert.equal(devMcpServerEntryFromEnv({ LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://localhost:3000", LETAGENTS_DEV_MCP_SERVER_ENTRY: "relative/path.js" }), null, "relative entry → null");
  assert.equal(
    devMcpServerEntryFromEnv({ LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://localhost:3000", LETAGENTS_DEV_MCP_SERVER_ENTRY: "/absolute/path/server.js" }),
    "/absolute/path/server.js",
    "both gates set with absolute path → path",
  );
});

test("daemon spawn includes devMcpServerEntryPath for codex when both env gates are set, omits it otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-dev-spawn-gate-"));
  const source = join(root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "devgate@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Dev Gate Test"]);
  await writeFile(join(source, "README.md"), "dev gate\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);

  const capturedSpawns: ProviderActionSpawn[] = [];
  const exitListeners3 = new Map<string, Set<(t: ProviderActionTerminal) => void>>();
  let nextDevPid = 7000;
  function devHandle(workAttemptId: string) {
    const pid = nextDevPid++;
    return { workAttemptId, pid, providerContinuationId: "dev-thread", providerConnection: { kind: "claude_cli" as const, pid, processIdentity: `dev:${pid}` }, observedState: () => "working" as const };
  }
  function makeDevAdapter(): NativeProviderAdapter {
    return {
      capabilities: () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      async spawn(input) { capturedSpawns.push(input); return devHandle(input.workAttemptId); },
      async attach() { return null; },
      async resume(_ref, input) { return devHandle(input.workAttemptId); },
      async poke() {},
      async stop(handle) {
        const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped" as const, providerContinuationId: handle.providerContinuationId };
        queueMicrotask(() => exitListeners3.get(handle.workAttemptId)?.forEach((l) => l(terminal)));
        return terminal;
      },
      onExit(handle, listener) {
        const set = exitListeners3.get(handle.workAttemptId) ?? new Set();
        set.add(listener);
        exitListeners3.set(handle.workAttemptId, set);
        return () => set.delete(listener);
      },
      onStream: () => () => {},
    };
  }

  const savedUrl = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
  const savedEntry = process.env.LETAGENTS_DEV_MCP_SERVER_ENTRY;
  try {
    // Case 1: both env gates set + codex provider → field present
    process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = "http://localhost:3000";
    process.env.LETAGENTS_DEV_MCP_SERVER_ENTRY = "/absolute/dist/mcp/server.js";
    capturedSpawns.length = 0;
    const paths1 = {
      lockPath: join(root, "d1.lock"), socketPath: join(root, "d1.sock"), manifestPath: join(root, "manifest1.json"), auditPath: join(root, "audit1.jsonl"),
      attemptsPath: join(root, "attempts1.json"), attemptsRoot: join(root, "attempts1"), workspaceRoot: root,
    };
    const codexEntry: DaemonManifestEntry = {
      id: "dev_gate_codex", room_id: "room", display_name: "CodexAgent", provider: "codex", model: null, charter: "poll", desired_state: "running", observed_state: "absent", condition: "none",
      permission_profile_id: "ask_before_write", provider_launch_policy: { promptForInstallation: false }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
    };
    const daemon1 = new SupervisorDaemon(paths1, "darwin", new ProviderActionPortRouter({ codex: async () => makeDevAdapter() }), true);
    try {
      await daemon1.start();
      assert.equal((await daemonRequest(paths1.socketPath, "manifest.put", { entry: codexEntry })).ok, true);
      await eventually(async () => ((await daemonRequest(paths1.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "codex dev-gate spawn");
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, "/absolute/dist/mcp/server.js", "codex + both gates: devMcpServerEntryPath must reach adapter");
    } finally {
      await daemon1.stop();
    }

    // Case 2: both env gates set + claude-code provider → field absent (provider gate)
    capturedSpawns.length = 0;
    const paths2 = {
      lockPath: join(root, "d2.lock"), socketPath: join(root, "d2.sock"), manifestPath: join(root, "manifest2.json"), auditPath: join(root, "audit2.jsonl"),
      attemptsPath: join(root, "attempts2.json"), attemptsRoot: join(root, "attempts2"), workspaceRoot: root,
    };
    const claudeEntry: DaemonManifestEntry = {
      id: "dev_gate_claude", room_id: "room", display_name: "ClaudeAgent", provider: "claude-code", model: null, charter: "poll", desired_state: "running", observed_state: "absent", condition: "none",
      permission_profile_id: "ask_before_write", provider_launch_policy: { permissionMode: "default" }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
    };
    const daemon2 = new SupervisorDaemon(paths2, "darwin", new ProviderActionPortRouter({ "claude-code": async () => makeDevAdapter() }), true);
    try {
      await daemon2.start();
      assert.equal((await daemonRequest(paths2.socketPath, "manifest.put", { entry: claudeEntry })).ok, true);
      await eventually(async () => ((await daemonRequest(paths2.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "claude dev-gate spawn");
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, undefined, "claude-code + both gates: devMcpServerEntryPath must be absent (provider gate)");
    } finally {
      await daemon2.stop();
    }

    // Case 3: dev-url gate absent + codex provider → field absent (env gate)
    delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    capturedSpawns.length = 0;
    const paths3 = {
      lockPath: join(root, "d3.lock"), socketPath: join(root, "d3.sock"), manifestPath: join(root, "manifest3.json"), auditPath: join(root, "audit3.jsonl"),
      attemptsPath: join(root, "attempts3.json"), attemptsRoot: join(root, "attempts3"), workspaceRoot: root,
    };
    const daemon3 = new SupervisorDaemon(paths3, "darwin", new ProviderActionPortRouter({ codex: async () => makeDevAdapter() }), true);
    try {
      await daemon3.start();
      assert.equal((await daemonRequest(paths3.socketPath, "manifest.put", { entry: { ...codexEntry, id: "dev_gate_codex_nourl" } })).ok, true);
      await eventually(async () => ((await daemonRequest(paths3.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "codex no-dev-url spawn");
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, undefined, "codex + missing dev-url: devMcpServerEntryPath must be absent");
    } finally {
      await daemon3.stop();
    }
  } finally {
    if (savedUrl === undefined) delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    else process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = savedUrl;
    if (savedEntry === undefined) delete process.env.LETAGENTS_DEV_MCP_SERVER_ENTRY;
    else process.env.LETAGENTS_DEV_MCP_SERVER_ENTRY = savedEntry;
    await rm(root, { recursive: true, force: true });
  }
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
  let rejectControlAfterDispatch = false;
  let sawAcceptedControlBeforeProvider = false;
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false, turnControl: "native_interrupt" }),
    async spawn(input) { calls.push(`spawn:${input.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async attach() { calls.push("attach"); return null; },
    async resume(ref, input) { calls.push(`resume:${ref.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async poke() { throw new Error("Claude poke is intentionally unavailable"); },
    async controlTurn(handle, correction) {
      calls.push(`control:${handle.workAttemptId}:${correction ?? "stop"}`);
      const current = (await new ManifestStore(paths.manifestPath).load()).entries.find((candidate) => candidate.id === entry.id);
      sawAcceptedControlBeforeProvider = current?.turn_control?.status === "accepted"
        && current.turn_control.stages.length === 0;
      if (rejectControlAfterDispatch) throw new Error("injected ambiguous provider outcome");
      return { capability: "native_interrupt", interrupted: true, resumed: Boolean(correction), state: correction ? "working" : "idle" };
    },
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
    workerBindingsPath: join(root, "worker-bindings.json"),
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
    assert.ok(firstGeneration);
    await new WorkerBindingStore(paths.workerBindingsPath).bind({
      entry_id: entry.id,
      room_id: entry.room_id,
      work_attempt_id: first.work_attempt_id!,
      execution_generation_id: firstGeneration!,
      agent_session_id: "agent_session_exact",
      agent_session_token: "test-session-token",
      api_url: "https://letagents.test",
    });
    const controlParams = {
      id: entry.id,
      work_attempt_id: first.work_attempt_id,
      execution_generation_id: firstGeneration,
      action_id: "human-control-1",
      correction: "Use the revised direction",
    };
    const controlled = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal(controlled.ok, true);
    assert.deepEqual(controlled.result, {
      entryId: entry.id,
      workAttemptId: first.work_attempt_id,
      executionGenerationId: firstGeneration,
      actionId: "human-control-1",
      duplicate: false,
      stages: ["delivered", "interrupting", "applied", "resumed"],
      capability: "native_interrupt",
      interrupted: true,
      resumed: true,
      state: "working",
    });
    const duplicate = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal((duplicate.result as { duplicate: boolean }).duplicate, true, "durable action id makes transport retries idempotent");
    const stale = await daemonRequest(paths.socketPath, "manifest.control_turn", { ...controlParams, action_id: "human-control-stale", execution_generation_id: "wrong-generation" });
    assert.equal(stale.ok, false);
    assert.match(stale.error ?? "", /stale or incomplete/);
    assert.equal(calls.filter((call) => call.startsWith("control:")).length, 1, "duplicate and stale requests never reach the provider");
    assert.equal(sawAcceptedControlBeforeProvider, true, "the action is durable before provider dispatch and carries no optimistic ack stages");
    rejectControlAfterDispatch = true;
    const uncertainParams = { ...controlParams, action_id: "human-control-uncertain", correction: "Do not replay this correction" };
    const uncertain = await daemonRequest(paths.socketPath, "manifest.control_turn", uncertainParams);
    assert.equal(uncertain.ok, false);
    assert.match(uncertain.error ?? "", /injected ambiguous provider outcome/);
    rejectControlAfterDispatch = false;
    const retryUncertain = await daemonRequest(paths.socketPath, "manifest.control_turn", uncertainParams);
    assert.equal(retryUncertain.ok, false);
    assert.match(retryUncertain.error ?? "", /durably accepted.*uncertain.*not replayed/i);
    const competing = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      ...uncertainParams,
      action_id: "human-control-competing",
    });
    assert.equal(competing.ok, false);
    assert.match(competing.error ?? "", /unresolved.*refusing a second action/i);
    assert.equal(calls.filter((call) => call.startsWith("control:")).length, 2, "an ambiguous accepted effect is never dispatched twice");
    const journaled = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.turn_control;
    assert.equal(journaled?.status, "uncertain");
    assert.deepEqual(journaled?.stages, []);
    await new WorkerBindingStore(paths.workerBindingsPath).unbind(entry.id);
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

test("daemon restart never replays a durably accepted turn-control effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-control-restart-"));
  const calls: string[] = [];
  const adapter = fakeAdapter("claude-code", calls);
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "manifest.json"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
    workerBindingsPath: join(root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin", router, false);
  const recordedAt = new Date().toISOString();
  const entry: DaemonManifestEntry = {
    id: "restart_control", room_id: "room", display_name: "Claude", provider: "claude-code", model: null, charter: "poll", desired_state: "running", observed_state: "working", condition: "none",
    permission_profile_id: "full_access", created_by: "test", created_at: recordedAt,
    work_attempt_id: "attempt_exact",
    provider_ref: {
      work_attempt_id: "attempt_exact",
      provider_continuation_id: "session_exact",
      execution_generation_id: "generation_exact",
      provider_connection: { kind: "claude_cli", pid: 4242, processIdentity: "claude:4242" },
    },
    turn_control: {
      action_id: "action_accepted_before_crash",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      has_correction: true,
      status: "accepted",
      capability: "native_interrupt",
      interrupted: null,
      resumed: null,
      state: null,
      stages: [],
      error: null,
      recorded_at: recordedAt,
      updated_at: recordedAt,
    },
  };
  try {
    await new ManifestStore(paths.manifestPath).write(0, [entry]);
    await daemon.start();
    const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.turn_control;
    assert.equal(recovered?.status, "uncertain");
    assert.match(recovered?.error ?? "", /restarted.*not replayed/i);
    const replay = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_accepted_before_crash",
      correction: "one correction",
    });
    assert.equal(replay.ok, false);
    assert.match(replay.error ?? "", /durably accepted.*not replayed/i);
    assert.equal(calls.some((call) => call.includes(":control:")), false);
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});
