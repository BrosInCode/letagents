import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import {
  ProviderActionPortRouter,
  type NativeProviderAdapter,
} from "../provider-action-port-router.js";
import type {
  ProviderActionConnectionRef,
  ProviderActionRef,
  ProviderActionSpawn,
  ProviderActionTerminal,
} from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";

const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt-native-resolution",
  origin_execution_generation_id: "generation-native-resolution",
  provider_continuation_id: "thread-native-resolution",
} as const;
import { devMcpServerEntryFromEnv } from "../dev-spawn-options.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { NativeExecutionObservation, NativeTurnBoundary } from "../../shared/execution-protocol.js";

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

type FakeProvider = "codex" | "claude-code" | "open-model";

test("permission routing preserves frozen Codex request identity and fences native dispatch", async () => {
  const calls: string[] = [];
  const adapter = fakeAdapter("codex", calls);
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ provider: "codex", workAttemptId: "permission", roomId: "room", cwd: "/repo", launchPolicy: {} });
  const native = Object.freeze({ id: 1, method: "item/commandExecution/requestApproval", connectionId: "socket-1",
    params: Object.freeze({ threadId: handle.providerContinuationId, turnId: "turn", itemId: "item", startedAtMs: 1 }) });
  const request = { provider: "codex" as const, native };
  adapter.observePermissions = async (_handle, listener) => { listener({ type: "snapshot", requests: [native] }); };
  await router.observePermissions(handle, event => {
    assert.equal(event.type, "snapshot");
    if (event.type === "snapshot") { assert.equal(event.requests[0]!.native, native); assert.equal(event.connectionId, "socket-1"); }
  }, new AbortController().signal);
  assert.deepEqual(await router.correlatePermissionTurn(handle, request), { outcome: "correlated", providerContinuationId: handle.providerContinuationId, providerTurnId: "turn", kind: "command" });
  adapter.replyPermission = async (_handle, expected, _reply, options) => {
    assert.equal(expected, native);
    await options!.beforeNativeDispatch(); options!.assertNativeDispatch!(); calls.push("send");
    return { outcome: "sent", scope: "request" };
  };
  assert.deepEqual(await router.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => { calls.push("intent"); }, assertNativeDispatch: () => { calls.push("fence"); },
  }), { outcome: "sent_unacknowledged", nativeScope: "request" });
  assert.deepEqual(calls.slice(-3), ["intent", "fence", "send"]);
  await assert.rejects(router.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { throw new Error("closed"); },
  }), /closed/);
  assert.equal(calls.filter(value => value === "send").length, 1);
  await assert.rejects(router.replyPermission({ ...handle, providerConnection: { ...handle.providerConnection!, processIdentity: "forged" } }, request, "once", { beforeNativeDispatch: async () => {} }), /binding changed/);
});

test("permission routing snapshots OpenCode payloads and refuses replacement during broker checkpoint", async () => {
  const adapter = fakeAdapter("open-model", []);
  const router = new ProviderActionPortRouter({ "open-model": async () => adapter });
  const spawn = { provider: "open-model", workAttemptId: "permission", roomId: "room", cwd: "/repo", launchPolicy: {} };
  const handle = await router.spawn(spawn);
  const native = { id: "request", sessionID: handle.providerContinuationId!, permission: "bash", patterns: [], metadata: {}, always: [] };
  const request = { provider: "open-model" as const, native };
  adapter.observePermissions = async (_handle, listener) => { listener({ type: "snapshot", requests: [native] }); };
  let observedConnection: string | null = null;
  await router.observePermissions(handle, event => {
    if (event.type === "snapshot") {
      assert.notEqual(event.requests[0]!.native, native);
      assert.deepEqual(event.requests[0]!.native, native);
      observedConnection = event.connectionId;
    }
  }, new AbortController().signal);
  assert.match(observedConnection!, /^[a-f0-9]{64}$/);
  let sends = 0;
  adapter.replyPermission = async (_handle, expected, _reply, options) => {
    assert.notEqual(expected, native); assert.deepEqual(expected, native);
    await options!.beforeNativeDispatch(); options!.assertNativeDispatch!(); sends++;
    return { outcome: "processed", nativeScope: "session_pending" };
  };
  assert.deepEqual(await router.replyPermission(handle, request, "reject", { beforeNativeDispatch: async () => {} }), { outcome: "native_processed", nativeScope: "session_pending" });
  await assert.rejects(router.replyPermission(handle, request, "once", { beforeNativeDispatch: async () => { await router.spawn(spawn); } }), /binding changed/);
  assert.equal(sends, 1);
});

test("Codex file-change routing requires inspected edits and fences replacement during inspection", async () => {
  const adapter = fakeAdapter("codex", []);
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const spawn = { provider: "codex", workAttemptId: "permission", roomId: "room", cwd: "/repo", launchPolicy: {} };
  const handle = await router.spawn(spawn);
  const native = Object.freeze({ id: 1, method: "item/fileChange/requestApproval", connectionId: "socket-1",
    params: Object.freeze({ threadId: handle.providerContinuationId, turnId: "turn", itemId: "item", startedAtMs: 1 }) });
  const request = { provider: "codex" as const, native };
  assert.deepEqual(await router.correlatePermissionTurn(handle, request), { outcome: "correlation_unproven" });
  const changes = [{ path: "/repo/new.txt", kind: { type: "add" as const }, diff: "exact contents" }];
  adapter.inspectPermissionFileChanges = async (_handle, expected) => { assert.equal(expected, native); return changes; };
  assert.deepEqual(await router.correlatePermissionTurn(handle, request), { outcome: "correlated",
    providerContinuationId: handle.providerContinuationId, providerTurnId: "turn", kind: "file_change", fileChanges: changes });
  adapter.replyPermission = async (_handle, expected, _reply, options) => {
    assert.equal(expected, native); assert.deepEqual(options!.expectedFileChanges, changes);
    await options!.beforeNativeDispatch(); options!.assertNativeDispatch!();
    return { outcome: "sent", scope: "request" };
  };
  await router.replyPermission(handle, request, "once", { expectedFileChanges: changes, beforeNativeDispatch: async () => {} });
  adapter.inspectPermissionFileChanges = async () => { await router.spawn(spawn); return changes; };
  assert.deepEqual(await router.correlatePermissionTurn(handle, request), { outcome: "correlation_unproven" });
});

test("permission correlation and post-dispatch results reject replacement across native awaits", async () => {
  const adapter = fakeAdapter("open-model", []);
  const router = new ProviderActionPortRouter({ "open-model": async () => adapter });
  const spawn = { provider: "open-model", workAttemptId: "permission", roomId: "room", cwd: "/repo", launchPolicy: {} };
  let handle = await router.spawn(spawn);
  const request = { provider: "open-model" as const, native: { id: "request", sessionID: handle.providerContinuationId!, permission: "bash", patterns: [], metadata: {}, always: [] } };
  adapter.correlatePermissionTurn = async nativeHandle => {
    await router.spawn(spawn);
    return { outcome: "correlated", providerContinuationId: nativeHandle.providerContinuationId!, providerTurnId: "turn" };
  };
  assert.deepEqual(await router.correlatePermissionTurn(handle, request), { outcome: "correlation_unproven" });
  handle = await router.spawn(spawn);
  let sends = 0;
  adapter.replyPermission = async (_handle, _request, _reply, options) => {
    await options!.beforeNativeDispatch(); options!.assertNativeDispatch!(); sends++;
    await router.spawn(spawn);
    throw Object.assign(new Error("native response lost"), { outcome: "not_pending" });
  };
  await assert.rejects(router.replyPermission(handle, request, "reject", { beforeNativeDispatch: async () => {} }), { outcome: "uncertain" });
  assert.equal(sends, 1);
});

test("custodial activation router forwards exact Codex callbacks and refuses unsupported or forged handles", async () => {
  const calls: string[] = [];
  const adapter = fakeAdapter("codex", calls);
  adapter.activateCustodialPolling = async (_handle, _request, options) => {
    await options.beforeNativeDispatch();
    calls.push("native:start");
    await options.checkpointTurnStarted("native-exact");
    return { providerTurnId: "native-exact" };
  };
  const router = new ProviderActionPortRouter({ codex: async () => adapter, "claude-code": async () => fakeAdapter("claude-code", calls) });
  const spawn = { workAttemptId: "activation", roomId: "room", cwd: "/repo", launchPolicy: {}, provider: "codex" };
  const handle = await router.spawn(spawn);
  const request = { operationId: "operation", roomId: "room", cwd: "/repo", agentDisplayName: "Garden",
    workerSession: { agentSessionId: "session", roomCursor: "msg_4" },
    launchReceipt: { contract: "custodial_polling_v1" as const, agentSessionId: "session", configurationRevision: 1,
      workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection! } };
  const options = { beforeNativeDispatch: async () => { calls.push("intent"); }, checkpointTurnStarted: async (id: string) => { calls.push(`checkpoint:${id}`); } };
  assert.deepEqual(await router.activateCustodialPolling(handle, request, options), { providerTurnId: "native-exact" });
  assert.deepEqual(calls.slice(-3), ["intent", "native:start", "checkpoint:native-exact"]);
  await assert.rejects(router.activateCustodialPolling({ ...handle, providerConnection: { ...handle.providerConnection!, processIdentity: "forged" } }, request, options));
  delete adapter.activateCustodialPolling;
  await assert.rejects(router.activateCustodialPolling(handle, request, options), /unavailable/);
  const other = await router.spawn({ ...spawn, workAttemptId: "other", provider: "claude-code" });
  await assert.rejects(router.activateCustodialPolling(other, request, options), /exact owned Codex/);
  assert.equal(calls.filter(value => value === "native:start").length, 1);
  assert.deepEqual(await router.inspectCustodialPollingActivation(other, "native-exact"), { state: "unknown" });
  assert.deepEqual(await router.inspectCustodialPollingActivation(handle, "native-exact"), { state: "unknown" });
  adapter.inspectCustodialPollingActivation = async (_handle, id) => {
    assert.equal(id, "native-exact"); return { state: "terminal", outcome: "failed" };
  };
  assert.deepEqual(await router.inspectCustodialPollingActivation(handle, "native-exact"), { state: "terminal", outcome: "failed" });
});

function fakeAdapter(provider: FakeProvider, calls: string[]): NativeProviderAdapter {
  const handles = new Map<string, ReturnType<typeof nativeHandle>>();
  let nextPid = provider === "codex" ? 100 : provider === "claude-code" ? 200 : 300;
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
      const handle = {
        ...nativeHandle(provider, input.workAttemptId, `continuation:${input.workAttemptId}`, ++nextPid),
        ...(input.lifecycleAuthorityMode ? { lifecycleAuthorityMode: input.lifecycleAuthorityMode } : {}),
      };
      handles.set(input.workAttemptId, handle);
      return handle;
    },
    async attach(ref: ProviderActionRef) {
      calls.push(`${provider}:attach:${ref.workAttemptId}`);
      return handles.get(ref.workAttemptId) ?? null;
    },
    async resume(ref: ProviderActionRef, input: ProviderActionSpawn) {
      calls.push(`${provider}:resume:${ref.workAttemptId}`);
      const handle = nativeHandle(provider, input.workAttemptId, ref.providerContinuationId, ++nextPid);
      handles.set(input.workAttemptId, handle);
      return handle;
    },
    async poke(handle, message) { calls.push(`${provider}:poke:${handle.workAttemptId}:${message}`); },
    async controlTurn(handle, correction, options) {
      await options?.markDispatched?.();
      calls.push(`${provider}:control:${handle.workAttemptId}:${correction ?? "stop"}`);
      return { capability: "native_interrupt", interrupted: true, resumed: Boolean(correction), state: correction ? "working" : "idle" };
    },
    async runRoomTurn(handle, request, options) {
      await options?.markDispatched?.();
      calls.push(`${provider}:room-turn:${handle.workAttemptId}:${request.inboxItemId}`);
      return { turnId: `turn:${request.inboxItemId}`, outcome: "reply", text: "bounded reply" };
    },
    async stop(handle): Promise<ProviderActionTerminal> {
      calls.push(`${provider}:stop:${handle.workAttemptId}`);
      return { endedAt: "2026-07-15T00:00:00.000Z", exitCode: 0, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: handle.providerContinuationId };
    },
    onExit: () => () => {},
    onStream: () => () => {},
  };
}

function nativeHandle(
  provider: FakeProvider,
  workAttemptId: string,
  providerContinuationId: string,
  pid = provider === "codex" ? 101 : provider === "claude-code" ? 202 : 303,
) {
  return {
    workAttemptId,
    pid,
    providerContinuationId,
    providerConnection: provider === "codex"
      ? { kind: "codex_app_server" as const, url: `ws://127.0.0.1:${pid}`, pid, processIdentity: `codex:${pid}` }
      : provider === "open-model"
        ? {
            kind: "opencode_server" as const,
            url: `http://127.0.0.1:${pid}`,
            pid,
            processIdentity: `opencode:${pid}`,
            serverAuthPath: `/tmp/opencode-${pid}.json`,
          }
        : { kind: "claude_cli" as const, pid, processIdentity: `claude:${pid}` },
    observedState: () => "working" as const,
  };
}

test("provider router preflights only Codex custody without launching or controlling a provider", async () => {
  const calls: string[] = [];
  const seen: unknown[] = [];
  const adapter = { ...fakeAdapter("codex", calls), preflightCustodialPolling: async (input: { devMcpServerEntryPath?: string }) => { seen.push(input); } };
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const request = { provider: "codex", devMcpServerEntryPath: "/trusted/dev/dist/mcp/server.js" };
  const pending = router.preflightCustodialPolling(request);
  request.devMcpServerEntryPath = "/changed/after-dispatch";
  await pending;
  assert.deepEqual(seen, [{ devMcpServerEntryPath: "/trusted/dev/dist/mcp/server.js" }]);
  await assert.rejects(router.preflightCustodialPolling({ provider: "cursor" }), /only supported by Codex/);
  await assert.rejects(new ProviderActionPortRouter({ codex: async () => fakeAdapter("codex", calls) }).preflightCustodialPolling({ provider: "codex" }), /does not expose/);
  adapter.preflightCustodialPolling = async () => { throw new Error("unsupported installed runtime"); };
  await assert.rejects(router.preflightCustodialPolling({ provider: "codex" }), /unsupported installed runtime/);
  assert.deepEqual(calls, []);
});

test("provider router prefers exact Codex stopRef over a remembered protocol terminal with no fallback", async () => {
  const calls: string[] = [];
  const seen: ProviderActionRef[] = [];
  const adapter: NativeProviderAdapter = {
    ...fakeAdapter("codex", calls),
    stopRef: async (ref) => {
      seen.push(ref);
      return { endedAt: "2026-08-31T00:00:00.000Z", exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: ref.providerContinuationId };
    },
  };
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ provider: "codex", workAttemptId: "exact-stop", roomId: "room", cwd: "/tmp/exact-stop", launchPolicy: {} });
  const ref: ProviderActionRef = { provider: "codex", workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: { ...handle.providerConnection! } };
  const original = structuredClone(ref);
  const stopped = router.stopRef(ref, { actionId: "stop-exact-birth" });
  ref.providerContinuationId = "mutated";
  ref.providerConnection!.pid = 9999;
  await stopped;
  assert.deepEqual(seen, [original], "exact reference is snapshotted before loading the adapter");
  assert.equal((await router.attachAction("stop-exact-birth", original.workAttemptId)).state, "attached");
  await new ProviderActionPortRouter({ codex: async () => adapter }).stopRef(original);
  assert.equal(seen.length, 2, "restart recovery does not need a remembered handle");
  await assert.rejects(router.stopRef({ ...original, provider: "cursor" }), /Conflicting provider identities/);
  await assert.rejects(router.stopRef({ ...original, providerConnection: { kind: "cursor_cli", pid: 101, processIdentity: "codex:101" } }), /Conflicting provider identities/);
  adapter.stopRef = async () => { throw new Error("process identity is unknown"); };
  await assert.rejects(router.stopRef(original), /process identity is unknown/);
  assert.deepEqual(calls, ["codex:spawn:exact-stop"], "refusal must not fall back to cached ordinary stop");
});

test("provider router preserves Cursor's remembered-stop path", async () => {
  const calls: string[] = [];
  const adapter: NativeProviderAdapter = {
    ...fakeAdapter("claude-code", calls),
    spawn: async (input) => ({ ...nativeHandle("claude-code", input.workAttemptId, "cursor-session", 202), providerConnection: { kind: "cursor_cli", pid: 202, processIdentity: "cursor:202" } }),
    stopRef: async () => { throw new Error("cached Cursor stop must retain its existing behavior"); },
  };
  const router = new ProviderActionPortRouter({ cursor: async () => adapter });
  const handle = await router.spawn({ provider: "cursor", workAttemptId: "cursor-stop", roomId: "room", cwd: "/tmp/cursor", launchPolicy: {} });
  await router.stopRef({ provider: "cursor", workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection });
  assert.deepEqual(calls, ["claude-code:stop:cursor-stop"]);
});

test("provider router carries native shadow facts and probes without invoking legacy actions", async () => {
  const calls: string[] = [];
  let listener: ((event: NativeExecutionObservation) => void) | undefined;
  let latestSequence = 0;
  const subscription = {
    sourceId: "opaque-observer-source",
    position: () => ({ firstRetainedSequence: 1, latestSequence }),
    dispose: () => { listener = undefined; },
  };
  const native = fakeAdapter("codex", calls);
  const adapter: NativeProviderAdapter = {
    ...native,
    onExecution: (_handle, next) => { listener = next; return subscription; },
    probeControl: async () => ({ state: "degraded" }),
  };
  const router = new ProviderActionPortRouter({ codex: async () => adapter, "claude-code": async () => fakeAdapter("claude-code", calls) });
  const request: ProviderActionSpawn = { provider: "codex", workAttemptId: "shadow", roomId: "room", cwd: "/tmp/shadow", launchPolicy: {} };
  const handle = await router.spawn(request);
  const received: NativeExecutionObservation[] = [];
  const observed = await router.onExecution(handle, (event) => received.push(event));
  assert.equal(observed, subscription, "the router forwards the source's subscription without inventing identity or positions");
  assert.equal(observed.sourceId, "opaque-observer-source");
  assert.deepEqual(observed.position(), { firstRetainedSequence: 1, latestSequence: 0 });
  const observation: NativeExecutionObservation = {
    sourceId: subscription.sourceId, sequence: 1, observedAtMs: 1, nativeProcessIdentity: "codex:101",
    fact: { domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
  };
  latestSequence = 1;
  listener!(observation);
  assert.deepEqual(received, [observation]);
  assert.deepEqual(observed.position(), { firstRetainedSequence: 1, latestSequence: 1 });
  assert.deepEqual(await router.probeControl(handle), { state: "degraded" });
  assert.deepEqual(calls, ["codex:spawn:shadow"], "no stop, poke, turn, or restart effect from observation/probe");
  observed.dispose();
  assert.equal(listener, undefined);
  const unprobeable = await router.spawn({ ...request, provider: "claude-code", workAttemptId: "unprobeable" });
  assert.deepEqual(await router.probeControl(unprobeable), { state: "unprobeable" });
  await assert.rejects(router.onExecution(unprobeable, () => {}), /does not expose native execution observations/);
  const stale = { ...handle, providerContinuationId: "stale" };
  await assert.rejects(router.probeControl(stale), /not owned/);
  await assert.rejects(router.onExecution(stale, () => {}), /not owned/);
});

test("provider router forwards exact turn-boundary snapshots and rejects mismatched native authority", async () => {
  const calls: string[] = [];
  const native = nativeHandle("codex", "boundary", "thread-boundary");
  let inspected = 0;
  let result: NativeTurnBoundary = { state: "idle", providerContinuationId: native.providerContinuationId,
    nativeProcessIdentity: native.providerConnection.processIdentity, latestProviderTurnId: null };
  const adapter: NativeProviderAdapter = { ...fakeAdapter("codex", calls), spawn: async () => native,
    inspectTurnBoundary: async exact => { assert.equal(exact, native); inspected++; return result; } };
  const router = new ProviderActionPortRouter({ codex: async () => adapter, "claude-code": async () => fakeAdapter("claude-code", calls) });
  const request: ProviderActionSpawn = { provider: "codex", workAttemptId: native.workAttemptId, roomId: "room", cwd: "/tmp/boundary", launchPolicy: {} };
  const handle = await router.spawn(request);
  assert.deepEqual(await router.inspectTurnBoundary(handle), result);
  result = { state: "active", providerContinuationId: native.providerContinuationId,
    nativeProcessIdentity: native.providerConnection.processIdentity, providerTurnId: "active-turn" };
  assert.deepEqual(await router.inspectTurnBoundary(handle), result);
  for (const mismatch of ["continuation", "process_birth"] as const) {
    result = { state: "idle", providerContinuationId: mismatch === "continuation" ? "wrong-thread" : native.providerContinuationId,
      nativeProcessIdentity: mismatch === "process_birth" ? "forged-birth" : native.providerConnection.processIdentity, latestProviderTurnId: null };
    assert.deepEqual(await router.inspectTurnBoundary(handle), { state: "unknown" }, mismatch);
  }
  const inspectedBefore = inspected;
  for (const connection of [null, { ...native.providerConnection, processIdentity: "fabricated-birth" }, { ...native.providerConnection, processIdentity: "" }]) {
    assert.deepEqual(await router.inspectTurnBoundary({ ...handle, providerConnection: connection }), { state: "unknown" });
  }
  await assert.rejects(router.inspectTurnBoundary({ ...handle, providerContinuationId: "stale-thread" }), /not owned/);
  assert.equal(inspected, inspectedBefore, "unfenced handles never reach the adapter");
  const unsupported = await router.spawn({ ...request, provider: "claude-code", workAttemptId: "unsupported" });
  assert.deepEqual(await router.inspectTurnBoundary(unsupported), { state: "unknown" });
  assert.deepEqual(calls, ["claude-code:spawn:unsupported"], "boundary inspection invokes no turn, stop, or launch action");
});

for (const race of ["process_birth", "continuation", "owned_handle"] as const) {
  test(`provider router discards a turn-boundary result after ${race} changes during inspection`, async () => {
    let native = nativeHandle("codex", "raced-boundary", "thread-boundary");
    const original = native;
    const calls: string[] = [];
    let release!: () => void; let markReading!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { markReading = resolve; });
    const adapter: NativeProviderAdapter = { ...fakeAdapter("codex", calls), spawn: async () => native,
      inspectTurnBoundary: async exact => {
        assert.equal(exact, original);
        const result: NativeTurnBoundary = { state: "idle", providerContinuationId: exact.providerContinuationId!,
          nativeProcessIdentity: exact.providerConnection!.processIdentity!, latestProviderTurnId: "completed-turn" };
        markReading(); await waiting; return result;
      } };
    const router = new ProviderActionPortRouter({ codex: async () => adapter });
    const request: ProviderActionSpawn = { provider: "codex", workAttemptId: native.workAttemptId, roomId: "room", cwd: "/tmp/boundary", launchPolicy: {} };
    const handle = await router.spawn(request);
    const pending = router.inspectTurnBoundary(handle);
    await reading;
    if (race === "process_birth") native.providerConnection.processIdentity += "-replaced";
    else if (race === "continuation") native.providerContinuationId = "thread-replaced";
    else {
      native = nativeHandle("codex", original.workAttemptId, original.providerContinuationId, original.pid);
      await router.spawn(request); // Different owned handle with the same apparent native identity.
    }
    release();
    assert.deepEqual(await pending, { state: "unknown" });
    assert.deepEqual(calls, [], "observation does not dispatch control actions while ownership changes");
  });
}

test("provider router selects the native adapter by manifest provider and fences stale handles", async () => {
  const calls: string[] = [];
  const router = new ProviderActionPortRouter({
    codex: async () => fakeAdapter("codex", calls),
    "claude-code": async () => fakeAdapter("claude-code", calls),
    cursor: async () => {
      const adapter = fakeAdapter("claude-code", calls);
      return {
        ...adapter,
        async spawn(input) {
          if (!input.agentDisplayName?.trim()) throw new Error("Cursor requires the durable agent display name.");
          return adapter.spawn(input);
        },
      };
    },
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
  let dispatchPersisted = false;
  assert.deepEqual(await router.runRoomTurn(resumed, {
    inboxItemId: "inbox-1", sourceMessage: { id: "msg-1", text: "hello" },
    activation: { for_current_agent: true }, actionId: "room-action-1",
  }, { markDispatched: async () => { dispatchPersisted = true; } }), {
    turnId: "turn:inbox-1", outcome: "reply", text: "bounded reply",
  });
  assert.equal(dispatchPersisted, true);
  assert.deepEqual(calls, [
    "claude-code:spawn:claude-attempt",
    "claude-code:resume:claude-attempt",
    "claude-code:poke:claude-attempt:continue",
    "claude-code:control:claude-attempt:redirect",
    "claude-code:room-turn:claude-attempt:inbox-1",
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
  const cursor = await router.spawn({
    ...claudeSpawn,
    provider: "cursor",
    workAttemptId: "cursor-attempt",
    agentDisplayName: "Durable Cursor Agent",
  });
  assert.equal(cursor.providerContinuationId, "continuation:cursor-attempt");
});

test("Cursor router ownership remains stable while its per-turn PID changes", async () => {
  let pid: number | null = null;
  let resolveTurn!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const turnGate = new Promise<void>((resolve) => { resolveTurn = resolve; });
  const calls: string[] = [];
  const native = {
    workAttemptId: "cursor-dynamic",
    get pid() { return pid; },
    providerContinuationId: "cursor-session",
    get providerConnection() {
      return { kind: "cursor_cli" as const, pid, processIdentity: pid === null ? null : `cursor:${pid}` };
    },
    observedState: () => pid === null ? "idle" as const : "working" as const,
  };
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false, turnControl: "restart_resume" }),
    async spawn() { return native; },
    async attach() { return native; },
    async resume() { return native; },
    async poke() {},
    async controlTurn() { calls.push("control"); return { capability: "restart_resume", interrupted: true, resumed: false, state: "idle" }; },
    async runRoomTurn() {
      pid = 8181;
      signalStarted();
      await turnGate;
      pid = null;
      return { turnId: "cursor:dynamic", outcome: "reply", text: "done" };
    },
    async stop(handle) {
      calls.push(`stop:${handle.pid}`);
      return { endedAt: new Date(0).toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId };
    },
    onExit: () => () => {},
    onStream: () => () => {},
  };
  const router = new ProviderActionPortRouter({ cursor: async () => adapter });
  const handle = await router.spawn({
    provider: "cursor", workAttemptId: "cursor-dynamic", roomId: "room", cwd: "/tmp/cursor",
    launchPolicy: { mode: "ask", force: false }, agentDisplayName: "DynamicCursor",
  });
  assert.equal(handle.pid, null);
  const turn = router.runRoomTurn(handle, {
    inboxItemId: "inbox", sourceMessage: {}, activation: {}, actionId: "action",
  });
  await started;
  assert.equal(handle.pid, 8181, "public handle proxies the native per-turn PID");
  await router.controlTurn(handle);
  await router.stop(handle);
  assert.deepEqual(calls, ["control", "stop:8181"]);
  resolveTurn();
  await turn;
  assert.equal(handle.pid, null);
});

test("provider router accepts a missing connection only for the exact remembered Codex birth authority", async () => {
  const calls: string[] = [];
  const adapter = fakeAdapter("codex", calls);
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const alpha = await router.spawn({
    provider: "codex", workAttemptId: "alpha-attempt", roomId: "room", cwd: "/tmp/alpha", launchPolicy: {},
    deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed",
  });
  const bravo = await router.spawn({
    provider: "codex", workAttemptId: "bravo-attempt", roomId: "room", cwd: "/tmp/bravo", launchPolicy: {},
  });
  const alphaRef: ProviderActionRef = {
    workAttemptId: alpha.workAttemptId,
    provider: "codex",
    providerContinuationId: alpha.providerContinuationId!,
    providerConnection: alpha.providerConnection,
    lifecycleAuthorityMode: "typed",
  };

  assert.deepEqual(await router.attach(alphaRef), alpha);
  assert.equal(await router.attach({ ...alphaRef, lifecycleAuthorityMode: "typed_shadow" }), null);
  assert.equal(await router.attach({ ...alphaRef, lifecycleAuthorityMode: undefined }), null);
  assert.equal(await router.attach({ ...alphaRef, providerContinuationId: bravo.providerContinuationId! }), null);
  assert.equal(await router.attach({ ...alphaRef, providerConnection: bravo.providerConnection }), null);
  assert.deepEqual(
    await router.attach({ ...alphaRef, providerConnection: null }),
    alpha,
    "the exact Electron-owned handle repairs a predecessor daemon's missing connection evidence",
  );
  assert.ok(alpha.providerConnection?.kind === "codex_app_server");
  const mismatchedConnections: ProviderActionConnectionRef[] = [
    { ...alpha.providerConnection, url: "ws://127.0.0.1:9999" },
    { ...alpha.providerConnection, url: "" },
    { ...alpha.providerConnection, pid: alpha.providerConnection.pid! + 1 },
    { ...alpha.providerConnection, pid: null },
    { ...alpha.providerConnection, processIdentity: "another-process-birth" },
    { ...alpha.providerConnection, processIdentity: null },
  ];
  for (const providerConnection of mismatchedConnections) {
    assert.equal(await router.attach({ ...alphaRef, providerConnection }), null);
  }
  await assert.rejects(router.attach({
    ...alphaRef,
    providerConnection: { kind: "claude_cli", pid: alpha.providerConnection.pid, processIdentity: alpha.providerConnection.processIdentity },
  }), /Conflicting provider identities/);
  assert.deepEqual(calls, [
    "codex:spawn:alpha-attempt",
    "codex:spawn:bravo-attempt",
  ], "connection mismatches are rejected by the router instead of delegated to an adapter");
});

test("provider router selects Open Model from an exact OpenCode connection", async () => {
  const calls: string[] = [];
  const adapter = fakeAdapter("open-model", calls);
  const router = new ProviderActionPortRouter({ "open-model": async () => adapter });
  const spawned = await router.spawn({
    provider: "open-model",
    workAttemptId: "open-model-attempt",
    roomId: "room",
    cwd: "/tmp/open-model",
    launchPolicy: { permission: { "*": "allow" } },
    providerCredential: {
      apiKey: "provider-secret",
      baseUrl: "https://models.example.test/v1",
      model: "open-model/test",
    },
  });
  assert.equal(spawned.providerConnection?.kind, "opencode_server");

  const freshRouter = new ProviderActionPortRouter({ "open-model": async () => adapter });
  assert.deepEqual(await freshRouter.attach({
    workAttemptId: spawned.workAttemptId,
    providerContinuationId: spawned.providerContinuationId!,
    providerConnection: spawned.providerConnection,
  }), spawned);
  assert.deepEqual(calls, [
    "open-model:spawn:open-model-attempt",
    "open-model:attach:open-model-attempt",
  ]);
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

test("daemon spawn gates the local MCP entry to supported providers and explicit development", async () => {
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
  function devHandle(workAttemptId: string, provider: "codex" | "claude-code" | "cursor") {
    const pid = nextDevPid++;
    const processIdentity = `dev:${provider}:${pid}`;
    const providerConnection = provider === "codex"
      ? { kind: "codex_app_server" as const, url: `ws://127.0.0.1:${pid}`, pid, processIdentity }
      : provider === "cursor"
        ? { kind: "cursor_cli" as const, pid, processIdentity }
        : { kind: "claude_cli" as const, pid, processIdentity };
    return { workAttemptId, pid, providerContinuationId: "dev-thread", providerConnection, observedState: () => "working" as const };
  }
  function makeDevAdapter(provider: "codex" | "claude-code" | "cursor"): NativeProviderAdapter {
    return {
      capabilities: () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      async spawn(input) { capturedSpawns.push(input); return devHandle(input.workAttemptId, provider); },
      async attach() { return null; },
      async resume(_ref, input) { return devHandle(input.workAttemptId, provider); },
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
      permission_profile_id: "full_access", provider_launch_policy: { promptForInstallation: false }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
    };
    const daemon1 = new SupervisorDaemon(paths1, "darwin", new ProviderActionPortRouter({ codex: async () => makeDevAdapter("codex") }), true);
    try {
      await daemon1.start();
      assert.equal((await daemonRequest(paths1.socketPath, "manifest.put", { entry: codexEntry })).ok, true);
      await eventually(async () => ((await daemonRequest(paths1.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "codex dev-gate spawn");
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, "/absolute/dist/mcp/server.js", "codex + both gates: devMcpServerEntryPath must reach adapter");
    } finally {
      await daemon1.stop();
    }

    capturedSpawns.length = 0;
    const cursorPaths = {
      lockPath: join(root, "dc.lock"), socketPath: join(root, "dc.sock"), manifestPath: join(root, "manifestc.json"), auditPath: join(root, "auditc.jsonl"),
      attemptsPath: join(root, "attemptsc.json"), attemptsRoot: join(root, "attemptsc"), workspaceRoot: root,
    };
    const cursorEntry: DaemonManifestEntry = {
      ...codexEntry,
      id: "dev_gate_cursor",
      display_name: "CursorAgent",
      provider: "cursor",
      permission_profile_id: "read_only",
      provider_launch_policy: { mode: "ask", force: false },
    };
    const cursorDaemon = new SupervisorDaemon(
      cursorPaths,
      "darwin",
      new ProviderActionPortRouter({ cursor: async () => makeDevAdapter("cursor") }),
      true,
    );
    try {
      await cursorDaemon.start();
      assert.equal((await daemonRequest(cursorPaths.socketPath, "manifest.put", { entry: cursorEntry })).ok, true);
      await eventually(async () => ((await daemonRequest(cursorPaths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "Cursor dev-gate spawn");
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, "/absolute/dist/mcp/server.js");
    } finally {
      await cursorDaemon.stop();
    }

    // Case 2: a stale generic Claude profile must be rejected before native dispatch.
    capturedSpawns.length = 0;
    const paths2 = {
      lockPath: join(root, "d2.lock"), socketPath: join(root, "d2.sock"), manifestPath: join(root, "manifest2.json"), auditPath: join(root, "audit2.jsonl"),
      attemptsPath: join(root, "attempts2.json"), attemptsRoot: join(root, "attempts2"), workspaceRoot: root,
    };
    const claudeEntry: DaemonManifestEntry = {
      id: "dev_gate_claude", room_id: "room", display_name: "ClaudeAgent", provider: "claude-code", model: null, charter: "poll", desired_state: "running", observed_state: "absent", condition: "none",
      permission_profile_id: "ask_before_write", provider_launch_policy: { permissionMode: "acceptEdits" }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
    };
    const daemon2 = new SupervisorDaemon(paths2, "darwin", new ProviderActionPortRouter({ "claude-code": async () => makeDevAdapter("claude-code") }), true);
    try {
      await daemon2.start();
      assert.equal((await daemonRequest(paths2.socketPath, "manifest.put", { entry: claudeEntry })).ok, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(capturedSpawns.length, 0, "a gated supervised profile must fail before provider launch");
    } finally {
      await daemon2.stop();
    }

    // Case 3: a missing legacy Claude profile uses the supervised default,
    // not the interactive-worker generic ask-before-write default.
    capturedSpawns.length = 0;
    const paths3 = {
      lockPath: join(root, "d3.lock"), socketPath: join(root, "d3.sock"), manifestPath: join(root, "manifest3.json"), auditPath: join(root, "audit3.jsonl"),
      attemptsPath: join(root, "attempts3.json"), attemptsRoot: join(root, "attempts3"), workspaceRoot: root,
    };
    const daemon3 = new SupervisorDaemon(paths3, "darwin", new ProviderActionPortRouter({ "claude-code": async () => makeDevAdapter("claude-code") }), true);
    try {
      await daemon3.start();
      assert.equal((await daemonRequest(paths3.socketPath, "manifest.put", { entry: {
        ...claudeEntry,
        id: "dev_gate_claude_legacy_default",
        permission_profile_id: null,
        provider_launch_policy: { permissionMode: "acceptEdits" },
      } })).ok, true);
      await eventually(async () => ((await daemonRequest(paths3.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "Claude supervised default spawn");
      assert.equal(capturedSpawns[0]?.permissionProfileId, "read_only");
      assert.deepEqual(capturedSpawns[0]?.launchPolicy, { permissionMode: "plan", dangerouslySkipPermissions: false });
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, undefined, "claude-code + both gates: devMcpServerEntryPath must be absent (provider gate)");
    } finally {
      await daemon3.stop();
    }

    // Case 4: dev-url gate absent + codex provider → field absent (env gate)
    delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    capturedSpawns.length = 0;
    const paths4 = {
      lockPath: join(root, "d4.lock"), socketPath: join(root, "d4.sock"), manifestPath: join(root, "manifest4.json"), auditPath: join(root, "audit4.jsonl"),
      attemptsPath: join(root, "attempts4.json"), attemptsRoot: join(root, "attempts4"), workspaceRoot: root,
    };
    const daemon4 = new SupervisorDaemon(paths4, "darwin", new ProviderActionPortRouter({ codex: async () => makeDevAdapter("codex") }), true);
    try {
      await daemon4.start();
      assert.equal((await daemonRequest(paths4.socketPath, "manifest.put", { entry: { ...codexEntry, id: "dev_gate_codex_nourl" } })).ok, true);
      await eventually(async () => ((await daemonRequest(paths4.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "codex no-dev-url spawn");
      assert.equal(capturedSpawns[0]?.devMcpServerEntryPath, undefined, "codex + missing dev-url: devMcpServerEntryPath must be absent");
    } finally {
      await daemon4.stop();
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
  let proveControlNotApplied = false;
  let reportEffectWithoutDispatchMarker = false;
  let controlGate: Promise<void> | null = null;
  let sawAcceptedControlBeforeProvider = false;
  let nativeTurnSequence = 0;
  const checkpointedControlTargets: string[] = [];
  const adapter: NativeProviderAdapter = {
    // This fake models a native interrupt+resume provider (its controlTurn
    // resumes on a correction), so it declares midTurnCorrection — the daemon
    // routes corrections natively rather than via stop-then-resend.
    capabilities: () => ({ resume: true, midTurnInjection: false, midTurnCorrection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false, turnControl: "native_interrupt" }),
    async spawn(input) { calls.push(`spawn:${input.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async attach() { calls.push("attach"); return null; },
    async resume(ref, input) { calls.push(`resume:${ref.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async poke() { throw new Error("Claude poke is intentionally unavailable"); },
    async controlTurn(handle, correction, options) {
      const exactTarget = options?.targetTurnId ?? `native-turn-${++nativeTurnSequence}`;
      await options?.checkpointTurnStarted?.(exactTarget);
      checkpointedControlTargets.push(exactTarget);
      if (!reportEffectWithoutDispatchMarker) await options?.markDispatched?.();
      calls.push(`control:${handle.workAttemptId}:${correction ?? "stop"}`);
      await controlGate;
      const current = (await new ManifestStore(paths.manifestPath).load()).entries.find((candidate) => candidate.id === entry.id);
      sawAcceptedControlBeforeProvider = current?.turn_control?.status === "dispatching"
        && current.turn_control.stages.length === 0;
      if (proveControlNotApplied) {
        throw Object.assign(new Error("provider proved the native effect was not applied"), {
          turnControlOutcome: "not_applied" as const,
        });
      }
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
    permission_profile_id: "full_access", provider_launch_policy: { permissionMode: "acceptEdits" }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
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
    await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).bind({
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
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      room_id: entry.room_id,
      work_attempt_id: first.work_attempt_id,
      execution_generation_id: firstGeneration,
      provider_continuation_id: continuation,
      provider_turn_id: "not-an-admitted-turn",
      inbox_item_id: "not-an-admitted-inbox",
      source_message_id: "not-an-admitted-message",
      action_id: "human-control-1",
      action_sequence: 1,
      correction: "Use the revised direction",
    };
    for (const actionId of ["x".repeat(257), "human control with spaces"]) {
      const invalidAction = await daemonRequest(paths.socketPath, "manifest.control_turn", { ...controlParams, action_id: actionId });
      assert.equal(invalidAction.ok, false);
      assert.match(invalidAction.error ?? "", /at most 256 UTF-8 bytes|contain only/i);
    }
    assert.equal(calls.some((call) => call.startsWith("control:")), false, "malformed action ids are rejected before provider dispatch");
    const oversized = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      ...controlParams,
      action_id: "human-control-oversized",
      correction: "x".repeat(32 * 1024 + 1),
    });
    assert.equal(oversized.ok, false);
    assert.match(oversized.error ?? "", /32 KiB durable payload limit/i);
    assert.equal(calls.some((call) => call.startsWith("control:")), false, "oversized durable input is rejected before provider dispatch");
    const unowned = await daemonRequest(paths.socketPath, "manifest.control_turn", controlParams);
    assert.equal(unowned.ok, false);
    assert.match(unowned.error ?? "", /exact room message|exact room turn|durable authority binding/i);
    assert.equal(calls.some((call) => call.startsWith("control:")), false,
      "session-level provider control is never dispatched without an exact daemon-owned room turn");
    await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).unbind(entry.id);
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

test("an mcp-polling provider cannot receive Inspector control without an exact daemon-owned turn", async () => {
  // Regression guard for the Cursor routing bug: Cursor advertises only
  // mcp_polling but applies a correction natively (its controlTurn stops the
  // child and beginTurns the same session with the correction). Such a provider
  // must NOT be routed into daemon stop-then-resend, which would strip the
  // correction and enqueue a synthetic daemon-inbox row its mcp_polling lane
  // could never pump. The fake below is that Cursor shape (mcp_polling +
  // midTurnCorrection), registered under a proven-spawnable provider key so the
  // daemon's capability-based routing is what's under test, not one provider's
  // spawn lifecycle.
  const root = await mkdtemp(join(tmpdir(), "letagents-router-native-correction-"));
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
  let nextPid = 6000;
  const continuation = "native-correction-continuation";
  const exitListeners = new Map<string, Set<(terminal: ProviderActionTerminal) => void>>();
  function lifecycleHandle(workAttemptId: string) {
    const pid = ++nextPid;
    return {
      workAttemptId, pid, providerContinuationId: continuation,
      providerConnection: { kind: "claude_cli" as const, pid, processIdentity: `native:${pid}` },
      observedState: () => "working" as const,
    };
  }
  const adapter: NativeProviderAdapter = {
    // mcp_polling lane, but midTurnCorrection: it resumes the correction through
    // its own controlTurn (restart+resume), so the daemon routes natively rather
    // than stripping the correction into a daemon-inbox row nothing could pump.
    capabilities: () => ({ resume: true, midTurnInjection: false, midTurnCorrection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false, turnControl: "restart_resume" }),
    async spawn(input) { calls.push(`spawn:${input.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async attach() { return null; },
    async resume(ref, input) { calls.push(`resume:${ref.workAttemptId}`); return lifecycleHandle(input.workAttemptId); },
    async poke() { throw new Error("poke unavailable"); },
    async controlTurn(handle, correction, options) {
      await options?.markDispatched?.();
      calls.push(`control:${handle.workAttemptId}:${correction ?? "stop"}`);
      // The native path receives the correction verbatim and resumes the session.
      return { capability: "restart_resume" as const, interrupted: true, resumed: Boolean(correction), state: correction ? "working" as const : "idle" as const };
    },
    async stop(handle) {
      calls.push(`stop:${handle.workAttemptId}`);
      const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped" as const, providerContinuationId: handle.providerContinuationId };
      queueMicrotask(() => exitListeners.get(handle.workAttemptId)?.forEach((listener) => listener(terminal)));
      return terminal;
    },
    onExit(handle, listener) {
      const listeners = exitListeners.get(handle.workAttemptId) ?? new Set<(terminal: ProviderActionTerminal) => void>();
      listeners.add(listener); exitListeners.set(handle.workAttemptId, listeners);
      return () => listeners.delete(listener);
    },
    onStream: () => () => {},
  };
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "manifest.json"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
    workerBindingsPath: join(root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin", router, true);
  const entry: DaemonManifestEntry = {
    id: "native_correction_supervised", room_id: "room", display_name: "NativeCorrection", provider: "claude-code", model: null, charter: "poll", desired_state: "running", observed_state: "absent", condition: "none",
    permission_profile_id: "full_access", provider_launch_policy: { permissionMode: "acceptEdits" }, created_by: "test", created_at: new Date().toISOString(), source_repo_path: source,
  };
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "native-correction router start");
    const first = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    const firstGeneration = first.provider_ref?.execution_generation_id;
    await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).bind({
      entry_id: entry.id, room_id: entry.room_id, work_attempt_id: first.work_attempt_id!, execution_generation_id: firstGeneration!,
      agent_session_id: "agent_session_exact", agent_session_token: "test-session-token", api_url: "https://letagents.test",
    });
    const controlled = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entry.id,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      room_id: entry.room_id, work_attempt_id: first.work_attempt_id, execution_generation_id: firstGeneration,
      provider_continuation_id: continuation, provider_turn_id: "missing-turn",
      inbox_item_id: "missing-inbox", source_message_id: "missing-message",
      action_id: "human-control-1", action_sequence: 1, correction: "Use the revised direction",
    });
    assert.equal(controlled.ok, false);
    assert.match(controlled.error ?? "", /daemon-owned exact room turn/i);
    assert.deepEqual(calls.filter((call) => call.startsWith("control:")), [],
      "Inspector authority is room-turn scoped, never a provider-session-wide interrupt");
  } finally {
    await daemon.stop();
    // No synthetic correction row was enqueued into a lane that could never pump it.
    const inbox = new SupervisedAgentInboxStore(paths.manifestPath);
    try {
      assert.equal(
        (await inbox.receipts(entry.id)).find((receipt) => receipt.source_message_id === "correction:human-control-1"),
        undefined,
        "a native-correction provider must not enqueue a daemon-inbox correction row",
      );
    } finally { await inbox.close(); }
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon restart quarantines pre-target turn controls for explicit resolution", async () => {
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
    last_turn_control_sequence: 1,
    turn_control: {
      action_id: "action_dispatching_before_crash",
      action_sequence: 1,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      has_correction: true,
      correction_text: "one correction",
      correction_strategy: "native",
      status: "dispatching",
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
  const preparedEntry: DaemonManifestEntry = {
    ...entry,
    id: "restart_prepared_control",
    room_id: "room-prepared-control",
    turn_control: {
      ...entry.turn_control!,
      action_id: "action_prepared_before_crash",
      status: "prepared",
    },
  };
  const appliedEntry: DaemonManifestEntry = {
    ...entry,
    id: "restart_applied_control",
    room_id: "room-applied-control",
    turn_control: {
      ...entry.turn_control!,
      action_id: "action_operator_verified_applied",
    },
  };
  const historicalActionId = "historical-control-that-must-never-return";
  const historicalEntry: DaemonManifestEntry = {
    ...entry,
    id: "restart_historical_control",
    room_id: "room-historical-control",
    turn_control: {
      ...entry.turn_control!,
      action_id: "newer-completed-control",
      status: "completed",
      interrupted: false,
      resumed: false,
      state: "working",
      stages: ["applied"],
    },
    reconciliation: {
      exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "working",
      next_restart_at_ms: null,
      completed_action_ids: [historicalActionId, ...Array.from({ length: 79 }, (_, index) => `later-control-${index}`)],
      last_action_sequence: 0, pending_action: null,
    },
  };
  try {
    await new ManifestStore(paths.manifestPath).write(0, [entry, preparedEntry, appliedEntry, historicalEntry]);
    await daemon.start();
    const recoveredEntries = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    const recovered = recoveredEntries.find((candidate) => candidate.id === entry.id)?.turn_control;
    const prepared = recoveredEntries.find((candidate) => candidate.id === preparedEntry.id)?.turn_control;
    assert.equal(recovered?.status, "uncertain");
    assert.match(recovered?.error ?? "", /predates exact causal target fencing/i);
    assert.equal(prepared?.status, "uncertain");
    assert.match(prepared?.error ?? "", /predates exact causal target fencing/i);
    const historicalReplay = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: historicalEntry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: historicalActionId,
      action_sequence: 1,
      correction: null,
    });
    assert.equal(historicalReplay.ok, false);
    assert.match(historicalReplay.error ?? "", /room_id is required|causal target/i);
    const replay = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_dispatching_before_crash",
      action_sequence: 1,
      correction: "one correction",
    });
    assert.equal(replay.ok, false);
    assert.match(replay.error ?? "", /room_id is required|causal target/i);
    assert.equal(calls.some((call) => call.includes(":control:")), false);
    const resolved = await daemonRequest(paths.socketPath, "manifest.resolve_turn_control", {
      id: entry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_dispatching_before_crash",
      resolution: "not_applied",
    });
    assert.equal(resolved.ok, true);
    const resolvedEntry = resolved.result as DaemonManifestEntry;
    assert.equal(resolvedEntry.turn_control?.status, "completed");
    assert.equal(resolvedEntry.turn_control?.interrupted, false);
    assert.equal(resolvedEntry.activity?.at(-1)?.method, "supervisor/resolve-turn-control");
    assert.deepEqual(resolvedEntry.activity?.at(-1)?.payload, {
      action_id: "action_dispatching_before_crash",
      resolution: "not_applied",
    });
    const oppositeResolution = await daemonRequest(paths.socketPath, "manifest.resolve_turn_control", {
      id: entry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_dispatching_before_crash",
      resolution: "applied",
    });
    assert.equal(oppositeResolution.ok, false);
    assert.match(oppositeResolution.error ?? "", /already completed with a different operator resolution/i);
    const notAppliedDuplicate = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: entry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_dispatching_before_crash",
      action_sequence: 1,
      correction: "one correction",
    });
    assert.equal(notAppliedDuplicate.ok, false);
    assert.match(notAppliedDuplicate.error ?? "", /room_id is required|causal target/i,
      "a completed legacy action without a causal target cannot regain session-wide control authority");
    const appliedResolution = await daemonRequest(paths.socketPath, "manifest.resolve_turn_control", {
      id: appliedEntry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_operator_verified_applied",
      resolution: "applied",
    });
    assert.equal(appliedResolution.ok, true);
    const operatorApplied = appliedResolution.result as DaemonManifestEntry;
    assert.equal(operatorApplied.turn_control?.status, "completed");
    assert.deepEqual(operatorApplied.turn_control?.stages, ["already_applied"]);
    assert.equal(operatorApplied.activity?.at(-1)?.method, "supervisor/resolve-turn-control");
    const appliedDuplicate = await daemonRequest(paths.socketPath, "manifest.control_turn", {
      id: appliedEntry.id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      action_id: "action_operator_verified_applied",
      action_sequence: 1,
      correction: "one correction",
    });
    assert.equal(appliedDuplicate.ok, false);
    assert.match(appliedDuplicate.error ?? "", /room_id is required|causal target/i);
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("operator-applied legacy native correction settles its interrupted FIFO row instead of retrying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-ncr-"));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "manifest.json"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
    workerBindingsPath: join(root, "worker-bindings.json"),
  };
  const recordedAt = "2026-08-05T13:00:00.000Z";
  const seeded: DaemonManifestEntry = {
    id: "native-correction-resolution", room_id: "room-native-resolution", display_name: "Codex", provider: "codex", model: null, charter: "poll",
    desired_state: "running", observed_state: "working", condition: "none", delivery_mode: "daemon_inbox",
    permission_profile_id: "workspace-write", created_by: "test", created_at: recordedAt,
    work_attempt_id: "attempt-native-resolution",
    provider_ref: {
      work_attempt_id: "attempt-native-resolution", provider_continuation_id: "thread-native-resolution",
      execution_generation_id: "generation-native-resolution",
      provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:9999", pid: 9999, processIdentity: "codex:9999" },
    },
    last_turn_control_sequence: 1,
    turn_control: {
      action_id: "native-correction-action", action_sequence: 1, work_attempt_id: "attempt-native-resolution", execution_generation_id: "generation-native-resolution",
      inbox_item_id: null, provider_turn_id: null, has_correction: true, correction_text: "keep the same turn, but revise it",
      correction_strategy: "native", status: "uncertain", capability: "native_interrupt", interrupted: null, resumed: null,
      state: null, stages: [], error: "native correction outcome unknown", recorded_at: recordedAt, updated_at: recordedAt,
    },
  };
  const store = new ManifestStore(paths.manifestPath);
  const inbox = new SupervisedAgentInboxStore(paths.manifestPath);
  const router = new ProviderActionPortRouter({ codex: async () => fakeAdapter("codex", []) });
  let daemon: SupervisorDaemon | null = null;
  try {
    await store.write(0, [{ ...seeded, turn_control: undefined }]);
    const row = await inbox.enqueueCorrection({
      agent_id: seeded.id, room_id: seeded.room_id, source_message_id: "native-A",
      source_message: { text: "A" }, activation: { decision: "activate" },
    });
    await inbox.claimHead(seeded.id);
    await inbox.checkpointTurnStarted(row.inbox_item_id, "turn-native-A", TEST_PROVIDER_TURN_AUTHORITY);
    await store.replaceEntry(1, {
      ...(await store.getEntry(seeded.id))!,
      turn_control: { ...seeded.turn_control!, inbox_item_id: row.inbox_item_id, provider_turn_id: "turn-native-A" },
    });
    await store.close();
    await inbox.close();

    daemon = new SupervisorDaemon(paths, "darwin", router, false);
    await daemon.start();
    const resolved = await daemonRequest(paths.socketPath, "manifest.resolve_turn_control", {
      id: seeded.id,
      work_attempt_id: "attempt-native-resolution",
      execution_generation_id: "generation-native-resolution",
      action_id: "native-correction-action",
      resolution: "applied",
    });
    assert.equal(resolved.ok, true, resolved.error ?? "native correction resolution failed");
    const receiptStore = new SupervisedAgentInboxStore(paths.manifestPath);
    try {
      const settled = await receiptStore.get(row.inbox_item_id);
      assert.equal(settled?.state, "cancelled_by_user", "the interrupted pre-correction turn is never recovered or rerun");
      assert.equal(settled?.provider_turn_id, "turn-native-A");
    } finally { await receiptStore.close(); }
    const completed = resolved.result as DaemonManifestEntry;
    assert.equal(completed.turn_control?.status, "completed");
    assert.equal(completed.turn_control?.resumed, true);
  } finally {
    await daemon?.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    await inbox.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("operator resolution remains available after the controlled runtime is detached or replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-historical-control-"));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
  };
  const workAttemptId = "11111111-1111-4111-8111-111111111111";
  const controlledGenerationId = "22222222-2222-4222-8222-222222222222";
  const successorGenerationId = "33333333-3333-4333-8333-333333333333";
  const recordedAt = "2026-08-05T14:00:00.000Z";
  const historical = (id: string, providerRef: DaemonManifestEntry["provider_ref"]): DaemonManifestEntry => ({
    id, room_id: `room-${id}`, display_name: "Historical Codex", provider: "codex", model: null, charter: "recover exactly",
    desired_state: "stopped", observed_state: "failed", condition: "coordination_blocked", delivery_mode: "daemon_inbox",
    permission_profile_id: "workspace-write", created_by: "test", created_at: recordedAt,
    work_attempt_id: workAttemptId, provider_ref: providerRef,
    last_turn_control_sequence: 1,
    turn_control: {
      action_id: `action-${id}`, action_sequence: 1, work_attempt_id: workAttemptId, execution_generation_id: controlledGenerationId,
      inbox_item_id: null, provider_turn_id: "turn-old-A", has_correction: false,
      correction_text: null, correction_strategy: null, status: "uncertain", capability: "native_interrupt",
      interrupted: null, resumed: null, state: null, stages: [], error: "native response was lost",
      recorded_at: recordedAt, updated_at: recordedAt,
    },
  });
  const detached = historical("detached-control", null);
  const replaced = historical("replaced-control", {
    work_attempt_id: workAttemptId,
    execution_generation_id: successorGenerationId,
    provider_continuation_id: "thread-successor-B",
    provider_connection: {
      kind: "codex_app_server", url: "http://127.0.0.1:48888", pid: 48888,
      processIdentity: "codex-successor-birth",
    },
  });
  const store = new ManifestStore(paths.manifestPath);
  let daemon: SupervisorDaemon | null = null;
  try {
    await store.write(0, [detached, replaced]);
    await store.close();
    const database = new DatabaseSync(paths.manifestPath);
    database.prepare(`INSERT INTO work_attempts
      (work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      workAttemptId, "task-historical", "lease-historical", 1, join(root, "workspace"), "repo",
      "https://example.test/repo.git", "a".repeat(40), join(root, "bare.git"), "active", recordedAt,
    );
    database.prepare(`INSERT INTO work_attempt_lease_epochs
      (work_attempt_id,sort_order,lease_id,epoch,recorded_at) VALUES (?,?,?,?,?)`).run(
      workAttemptId, 0, "lease-historical", 1, recordedAt,
    );
    database.prepare(`INSERT INTO work_attempt_executions
      (execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json)
      VALUES (?,?,?,?,?,?)`).run(
      controlledGenerationId, workAttemptId, recordedAt, "provider", 1, JSON.stringify({
        ended_at: "2026-08-05T14:01:00.000Z", exit_code: 1, signal: null,
        stdio_archive_ref: null, stdio_tail: "controlled runtime ended", terminal_cause: "process_exit",
        actor: "provider", generation: 1, provider_continuation_id: "thread-old-A",
      }),
    );
    database.close();

    daemon = new SupervisorDaemon(paths, "darwin", undefined, false);
    await daemon.start();
    for (const candidate of [detached, replaced]) {
      const resolved = await daemonRequest(paths.socketPath, "manifest.resolve_turn_control", {
        id: candidate.id, work_attempt_id: workAttemptId, execution_generation_id: controlledGenerationId,
        action_id: candidate.turn_control!.action_id, resolution: "applied",
      });
      assert.equal(resolved.ok, true, resolved.error ?? `${candidate.id} historical resolution failed`);
      const completed = resolved.result as DaemonManifestEntry;
      assert.equal(completed.turn_control?.status, "completed");
      assert.equal(completed.turn_control?.operator_resolution, "applied");
      assert.deepEqual(completed.turn_control?.stages, ["already_applied"]);
      if (candidate.id === detached.id) assert.equal(completed.provider_ref ?? null, null);
      else assert.equal(completed.provider_ref?.execution_generation_id, successorGenerationId, "resolution cannot rewrite successor B");
    }
  } finally {
    await daemon?.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
