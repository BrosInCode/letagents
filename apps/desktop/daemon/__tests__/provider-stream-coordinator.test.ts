import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionStreamEvent,
} from "../provider-action-port.js";
import {
  lifecycleLocalConformanceEligibility,
  ProviderStreamCoordinator,
} from "../provider-stream-coordinator.js";
import { providerStreamLifecycle } from "../provider-stream-policy.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import type { LifecycleProjectionObservation } from "../lifecycle-projection-ledger.js";

const cleanLifecycleProjection = () => ({
  available: true,
  providers: Object.fromEntries(["codex", "claude-code", "cursor"].map((provider) => [provider, {
    comparedSegments: 1,
    matched: 1,
    missingInTyped: 0,
    missingInLegacy: 0,
    pairedButDifferent: 0,
    conflicts: 0,
    observationUnavailable: 0,
  }])) as Record<"codex" | "claude-code" | "cursor", {
    comparedSegments: number; matched: number; missingInTyped: number; missingInLegacy: number;
    pairedButDifferent: number; conflicts: number; observationUnavailable: number;
  }>,
});
const captureAdmission = (status: "pending" | "ready" | "unavailable" = "ready") => ({
  codex: status,
  "claude-code": status,
  cursor: status,
});

test("local lifecycle conformance requires present clean evidence and clean daemon-owned wait authority", () => {
  assert.deepEqual(lifecycleLocalConformanceEligibility(cleanLifecycleProjection(), 0, captureAdmission()), {
    codex: true, "claude-code": true, cursor: true,
  });
  assert.deepEqual(lifecycleLocalConformanceEligibility({ ...cleanLifecycleProjection(), available: false }, 0, captureAdmission()), {
    codex: false, "claude-code": false, cursor: false,
  });
  assert.deepEqual(lifecycleLocalConformanceEligibility(cleanLifecycleProjection(), 1, captureAdmission()), {
    codex: false, "claude-code": false, cursor: false,
  });
  const empty = cleanLifecycleProjection();
  empty.providers.codex.comparedSegments = 0;
  assert.equal(lifecycleLocalConformanceEligibility(empty, 0, captureAdmission()).codex, false,
    "hollow all-zero evidence is not a conformance sample");
  const multipleCheckpoints = cleanLifecycleProjection();
  multipleCheckpoints.providers.codex.matched = 2;
  assert.equal(lifecycleLocalConformanceEligibility(multipleCheckpoints, 0, captureAdmission()).codex, true,
    "matched checkpoints are not the terminal-delimited segment count");

  for (const field of [
    "missingInTyped",
    "missingInLegacy",
    "pairedButDifferent",
    "conflicts",
    "observationUnavailable",
  ] as const) {
    const projection = cleanLifecycleProjection();
    projection.providers.codex[field] = 1;
    assert.deepEqual(lifecycleLocalConformanceEligibility(projection, 0, captureAdmission()), {
      codex: false, "claude-code": true, cursor: true,
    }, `${field} blocks only its provider`);
  }

  for (const malformed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const projection = cleanLifecycleProjection();
    projection.providers.codex.matched = malformed;
    assert.equal(lifecycleLocalConformanceEligibility(projection, 0, captureAdmission()).codex, false);
  }
  for (const status of ["pending", "unavailable"] as const) {
    assert.deepEqual(lifecycleLocalConformanceEligibility(cleanLifecycleProjection(), 0, captureAdmission(status)), {
      codex: false, "claude-code": false, cursor: false,
    });
  }
});

const entry = (): DaemonManifestEntry => ({
  id: "agent-1",
  room_id: "room-1",
  display_name: "Agent",
  provider: "codex",
  model: null,
  charter: "Help",
  desired_state: "running",
  observed_state: "working",
  condition: "none",
  permission_profile_id: "supervised",
  created_by: "test",
  created_at: "2026-08-26T00:00:00.000Z",
  work_attempt_id: "attempt-1",
  delivery_mode: "daemon_inbox",
  provider_ref: {
    work_attempt_id: "attempt-1",
    execution_generation_id: "generation-2",
    provider_continuation_id: "continuation-1",
    provider_connection: null,
  },
  activity: [],
});

const handle: ProviderActionHandle = {
  workAttemptId: "attempt-1",
  pid: 42,
  providerContinuationId: "continuation-1",
  observedState: "working",
  providerConnection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 42, processIdentity: "codex:42" },
};

const streamEvent = (sequence: number, method: string): ProviderActionStreamEvent => ({
  workAttemptId: "attempt-1",
  providerContinuationId: "continuation-1",
  observedAt: `2026-08-26T00:00:0${sequence}.000Z`,
  sequence,
  provider: "codex",
  kind: "text_delta",
  method,
  payload: { text: `${sequence}` },
  payloadTruncated: false,
  payloadRedacted: false,
  durablePayloadRef: null,
});

function coordinatorHarness(input: {
  appendActivity?: (method: string) => Promise<void>;
  stop?: () => Promise<void>;
  durabilityAttempt?: { execution_generations: Array<Record<string, unknown>>; checkpoints?: unknown[] };
  onExit?: ProviderActionPort["onExit"];
  onStream?: NonNullable<ProviderActionPort["onStream"]>;
  probeControl?: NonNullable<ProviderActionPort["probeControl"]>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  endStream?: (entryId: string) => void;
  observeExecution?: (entryId: string, handle: ProviderActionHandle, generation: string) => () => void;
  observeLegacyLifecycle?: (observation: LifecycleProjectionObservation) => void;
  markLifecycleProjectionUnavailable?: (provider: "codex" | "claude-code" | "cursor") => void;
  lifecycleProjectionDiagnostics?: () => ReturnType<typeof cleanLifecycleProjection>;
  captureAdmission?: (entryId: string, handle: ProviderActionHandle, generation: string) => "pending" | "ready" | "unavailable";
  observePermissions?: (entryId: string, handle: ProviderActionHandle, generation: string) => () => void;
  startDelivery?: (entryId: string) => Promise<void>;
  publishNativeActivity?: () => Promise<void>;
  requestConvergence?: (entryId: string) => void;
} = {}) {
  let manifest = entry();
  let manifestAvailable = true;
  const runtimeCustody = new WorkerRuntimeCustody();
  const pendingInstalled: unknown[] = [];
  const bindings = {
    get: async () => null,
    credentialFor: async () => null,
    supervisedWorkerSession: async () => null,
    verifyAndAdvanceExecutionGeneration: async () => { throw new Error("unused"); },
    checkpointCursorMonotonic: async () => { throw new Error("unused"); },
  };
  let stopCalls = 0;
  const coordinator = new ProviderStreamCoordinator({
    observeExecution: input.observeExecution,
    observeLegacyLifecycle: input.observeLegacyLifecycle,
    markLifecycleProjectionUnavailable: input.markLifecycleProjectionUnavailable,
    lifecycleProjectionDiagnostics: input.lifecycleProjectionDiagnostics,
    captureAdmission: input.captureAdmission,
    observePermissions: input.observePermissions,
    provider: {
      stop: async (current) => {
        stopCalls += 1;
        await input.stop?.();
        return {
          endedAt: "2026-08-26T00:00:00.000Z",
          exitCode: 0,
          signal: null,
          terminalCause: "stopped" as const,
          providerContinuationId: current.providerContinuationId,
        };
      },
      onExit: input.onExit ?? (async () => () => {}),
      onStream: input.onStream ?? (async () => () => {}),
      probeControl: input.probeControl,
    },
    manifest: {
      getEntry: async () => manifestAvailable ? manifest : undefined,
      load: async () => ({ entries: [manifest] }),
      updateEntry: async (_entryId, update) => {
        manifest = update(manifest);
        return manifest;
      },
    },
    bindings,
    durability: {
      getAttempt: async () => ({
        checkpoints: [],
        execution_generations: [],
        ...input.durabilityAttempt,
      }) as never,
      checkpoint: async () => ({}) as never,
    },
    runtimeCustody: {
      liveBinding: (entryId) => runtimeCustody.liveBinding(entryId),
      installLiveBinding: (entryId, identity) => runtimeCustody.installLiveBinding(entryId, identity),
      deleteLiveBinding: (entryId) => runtimeCustody.deleteLiveBinding(entryId),
      pendingResumeBinding: (entryId) => runtimeCustody.pendingResumeBinding(entryId),
      hasPendingResumeBinding: (entryId) => runtimeCustody.hasPendingResumeBinding(entryId),
      installPendingResumeBinding: (entryId, pending) => {
        pendingInstalled.push(pending);
        runtimeCustody.installPendingResumeBinding(entryId, pending);
      },
      deletePendingResumeBinding: (entryId) => runtimeCustody.deletePendingResumeBinding(entryId),
    },
    serializeEntry: async (_entryId, operation) => operation(),
    transition: async (_entryId, observed_state, condition) => {
      manifest = { ...manifest, observed_state, condition };
    },
    appendActivity: async (_entryId, event) => {
      await input.appendActivity?.(event.method);
    },
    publishNativeActivity: async () => input.publishNativeActivity?.(),
    handleTerminal: async () => {},
    streams: { reset: () => {}, push: () => {}, end: (entryId) => input.endStream?.(entryId) },
    delivery: { start: input.startDelivery ?? (async () => {}), startCutover: async () => {} },
    heartbeat: {
      intervalMs: 60_000,
      requiresHostGrant: () => false,
      currentHostGrant: () => null,
      hostGrantNeedsRenewal: () => false,
      hostWorkerBearerNeedsRotation: async () => false,
      requestConvergence: input.requestConvergence ?? (() => {}),
    },
    setInterval: input.setInterval
      ?? ((() => ({ unref() {} })) as unknown as typeof setInterval),
    clearInterval: input.clearInterval ?? ((() => {}) as typeof clearInterval),
  });
  return {
    coordinator,
    runtimeCustody,
    pendingInstalled,
    stopCalls: () => stopCalls,
    setManifest: (next: DaemonManifestEntry) => { manifest = next; },
    setManifestAvailable: (available: boolean) => { manifestAvailable = available; },
    getManifest: () => manifest,
  };
}

test("recovery diagnostics require every exact live provider lane to be capture-ready", async () => {
  const admissions = new Map<string, "pending" | "ready" | "unavailable">([["agent-1", "pending"]]);
  const harness = coordinatorHarness({
    lifecycleProjectionDiagnostics: cleanLifecycleProjection,
    captureAdmission: entryId => admissions.get(entryId) ?? "unavailable",
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  assert.deepEqual(harness.coordinator.recoveryDiagnostics().lifecycle_capture_admission, {
    codex: "pending", "claude-code": "unavailable", cursor: "unavailable",
  });
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_local_conformance_eligible.codex, false);

  admissions.set("agent-1", "ready");
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_local_conformance_eligible.codex, true);

  const second = { ...handle, pid: 43, workAttemptId: "attempt-2",
    providerConnection: { ...handle.providerConnection!, pid: 43, processIdentity: "codex:43" } };
  admissions.set("agent-2", "unavailable");
  await harness.coordinator.install("agent-2", second, "generation-3");
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_capture_admission.codex, "unavailable",
    "one broken current lane fails the provider closed even when another lane is ready");
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_local_conformance_eligible.codex, false);
  await harness.coordinator.disposeAll();

  const throwing = coordinatorHarness({
    lifecycleProjectionDiagnostics: cleanLifecycleProjection,
    captureAdmission: () => { throw new Error("injected optional capture failure"); },
  });
  await throwing.coordinator.install("agent-1", handle, "generation-2");
  assert.equal(throwing.coordinator.recoveryDiagnostics().lifecycle_capture_admission.codex, "unavailable",
    "an optional capture callback cannot break daemon status");
  assert.equal(throwing.coordinator.recoveryDiagnostics().lifecycle_local_conformance_eligible.codex, false);
  await throwing.coordinator.disposeAll();
});

test("daemon-inbox heartbeats probe exact live runtimes without granting recovery authority", async () => {
  let heartbeat: (() => void) | null = null;
  let probe: "lost" | "throw" = "lost";
  let probeCalls = 0;
  let activityCalls = 0;
  let convergenceCalls = 0;
  const harness = coordinatorHarness({
    probeControl: async () => {
      probeCalls += 1;
      if (probe === "throw") throw new Error("probe unavailable");
      return { state: "lost", controlEvidence: "transport_refused" };
    },
    publishNativeActivity: async () => { activityCalls += 1; },
    requestConvergence: () => { convergenceCalls += 1; },
    setInterval: ((callback: () => void) => {
      heartbeat = callback;
      return { unref() {} };
    }) as unknown as typeof setInterval,
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  harness.runtimeCustody.installLiveBinding("agent-1", {
    agentSessionId: "session-1", executionGenerationId: "generation-2", updatedAt: "2026-08-26T00:00:00.000Z",
  });
  heartbeat!();
  await harness.coordinator.drainCallbacks();
  probe = "throw";
  heartbeat!();
  await harness.coordinator.drainCallbacks();
  assert.equal(probeCalls, 2);
  assert.equal(activityCalls, 2, "a failed shadow probe cannot suppress the ordinary heartbeat");
  assert.equal(convergenceCalls, 0);
  assert.equal(harness.stopCalls(), 0);
  assert.equal(harness.getManifest().observed_state, "working");
  assert.equal(harness.getManifest().condition, "none");
  await harness.coordinator.disposeAll();
});

test("control probes exclude non-daemon, non-live, generation-mismatched, and replaced runtimes", async () => {
  const cases: Array<{ name: string; configure(harness: ReturnType<typeof coordinatorHarness>): void; replaceAfterTick?: boolean }> = [
    { name: "mcp polling", configure: harness => harness.setManifest({ ...entry(), delivery_mode: "mcp_polling" }) },
    { name: "non-live manifest", configure: harness => harness.setManifest({ ...entry(), observed_state: "recovering" }) },
    { name: "generation mismatch", configure: harness => harness.runtimeCustody.installLiveBinding("agent-1", {
      agentSessionId: "session-1", executionGenerationId: "generation-old", updatedAt: "2026-08-26T00:00:00.000Z",
    }) },
    { name: "replaced handle", configure: () => {}, replaceAfterTick: true },
  ];
  for (const candidate of cases) {
    let heartbeat: (() => void) | null = null;
    let probes = 0;
    const harness = coordinatorHarness({
      probeControl: async () => { probes += 1; return { state: "responsive" }; },
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref() {} };
      }) as unknown as typeof setInterval,
    });
    await harness.coordinator.install("agent-1", handle, "generation-2");
    if (candidate.name !== "generation mismatch") harness.runtimeCustody.installLiveBinding("agent-1", {
      agentSessionId: "session-1", executionGenerationId: "generation-2", updatedAt: "2026-08-26T00:00:00.000Z",
    });
    candidate.configure(harness);
    heartbeat!();
    if (candidate.replaceAfterTick) harness.coordinator.liveHandles.set("agent-1", { ...handle, pid: 99 });
    await harness.coordinator.drainCallbacks();
    assert.equal(probes, 0, candidate.name);
    await harness.coordinator.disposeAll();
  }
});

test("installing the approval bridge preserves full-access launch configuration and runtime", async () => {
  const observed: Array<[string, ProviderActionHandle, string]> = [];
  let starts = 0;
  let disposed = 0;
  const harness = coordinatorHarness({
    observePermissions: (agentId, native, generation) => {
      observed.push([agentId, native, generation]);
      return () => { disposed++; };
    },
    startDelivery: async () => { starts++; },
  });
  const configured: DaemonManifestEntry = { ...entry(), permission_profile_id: "full_access",
    config_revision: 7, runtime_configuration_revision: 7,
    provider_launch_policy: { approvalPolicy: "never", sandboxMode: "danger-full-access" } };
  harness.setManifest(structuredClone(configured));
  const beforeHandle = structuredClone(handle);
  await harness.coordinator.install(configured.id, handle, "generation-2");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]![1], handle);
  assert.equal(observed[0]![2], "generation-2");
  assert.deepEqual(harness.getManifest(), configured);
  assert.deepEqual(handle, beforeHandle);
  assert.equal(harness.stopCalls(), 0);
  assert.equal(starts, 1);
  harness.coordinator.remove(configured.id, handle);
  assert.equal(disposed, 1);
  assert.deepEqual(harness.getManifest(), configured);
});

test("optional execution observation failures cannot block installation, delivery, or replacement cleanup", async () => {
  const installed: Array<[string, ProviderActionHandle, string]> = [];
  const disposed: ProviderActionHandle[] = [];
  const deliveries: string[] = [];
  const harness = coordinatorHarness({
    observeExecution: (entryId, current, generation) => {
      installed.push([entryId, current, generation]);
      if (current === handle) throw new Error("observation unavailable");
      return () => { disposed.push(current); throw new Error("optional cleanup unavailable"); };
    },
    startDelivery: async (entryId) => { deliveries.push(entryId); },
  });
  const second = { ...handle, pid: 43 };
  const third = { ...handle, pid: 44 };
  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.install("agent-1", second, "generation-3");
  await harness.coordinator.install("agent-1", third, "generation-4");
  assert.deepEqual(installed, [["agent-1", handle, "generation-2"], ["agent-1", second, "generation-3"], ["agent-1", third, "generation-4"]]);
  assert.deepEqual(disposed, [second], "replacement disposes only its preceding observer");
  assert.deepEqual(deliveries, ["agent-1", "agent-1", "agent-1"]);
  await harness.coordinator.disposeAll();
  await harness.coordinator.disposeAll();
  assert.deepEqual(disposed, [second, third], "each installed observer is disposed exactly once");
  assert.equal(harness.stopCalls(), 0);
  assert.equal(harness.getManifest().observed_state, "working");
});

for (const delivery_mode of ["daemon_inbox", "mcp_polling"] as const) {
  test(`execution errors do not fence or latch failure on a healthy ${delivery_mode} runtime`, async () => {
    const harness = coordinatorHarness();
    harness.setManifest({ ...entry(), delivery_mode });
    await harness.coordinator.install("agent-1", handle, "generation-2");
    const failures: Array<Pick<ProviderActionStreamEvent, "method" | "kind" | "payload">> = [
      { method: "item/commandExecution/failed", kind: "command_output", payload: { status: "failed", exitCode: 1 } },
      { method: "item/mcpToolCall/failed", kind: "tool_lifecycle", payload: { status: "failed" } },
      { method: "item/fileChange/failed", kind: "tool_lifecycle", payload: { status: "error" } },
      { method: "item/toolCall/error_during_execution", kind: "tool_lifecycle", payload: { status: "error" } },
      { method: "command/exec/failed", kind: "command_output", payload: { status: "failed" } },
      { method: "item/completed", kind: "item_lifecycle", payload: { item: { type: "commandExecution", status: "failed", error: { message: "exit 1" } } } },
      { method: "item/completed", kind: "item_lifecycle", payload: { item: { type: "fileChange", status: "failed", error: { message: "write denied" } } } },
      { method: "item/failed", kind: "error", payload: { status: "failed" } },
    ];
    for (const [index, failure] of failures.entries()) {
      const event = { ...streamEvent(index + 1, failure.method), ...failure };
      assert.equal(providerStreamLifecycle(event), "working", failure.method);
      await harness.coordinator.enqueue("agent-1", handle, event);
      assert.notEqual(harness.getManifest().observed_state, "failed", failure.method);
    }
    await harness.coordinator.enqueue("agent-1", handle, { ...streamEvent(9, "turn/completed"), kind: "turn_lifecycle" });
    assert.equal(harness.stopCalls(), 0, "only the native turn ends, never the reusable runtime");
    await harness.coordinator.disposeAll();
  });

  test(`Claude turn-limit results do not fence the ${delivery_mode} runtime but genuine failures still do`, async () => {
    const harness = coordinatorHarness();
    harness.setManifest({ ...entry(), provider: "claude-code", delivery_mode });
    await harness.coordinator.install("agent-1", handle, "generation-2");
    for (const [index, subtype] of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].entries()) {
      const event: ProviderActionStreamEvent = {
        ...streamEvent(index + 1, `result/${subtype}`), provider: "claude-code", kind: "turn_lifecycle",
        payload: { type: "result", subtype, is_error: true },
      };
      assert.equal(providerStreamLifecycle(event), "idle");
      await harness.coordinator.enqueue("agent-1", handle, event);
      assert.notEqual(harness.getManifest().observed_state, "failed");
    }
    assert.equal(harness.stopCalls(), 0);
    await harness.coordinator.enqueue("agent-1", handle, {
      ...streamEvent(4, "result/error_during_execution"), provider: "claude-code", kind: "error",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
    });
    assert.equal(harness.getManifest().observed_state, "failed");
    assert.equal(harness.stopCalls(), 1);
    await harness.coordinator.disposeAll();
  });
}

test("genuine runtime/turn failures and failed MCP waits keep their existing classification", () => {
  assert.equal(providerStreamLifecycle({
    ...streamEvent(1, "item/completed"), kind: "item_lifecycle",
    payload: { item: { type: "commandExecution", status: "completed", exitCode: 0 } },
  }), "idle", "successful item completion preserves the existing presence signal");
  for (const failure of [
    { method: "turn/failed", kind: "turn_lifecycle", payload: {} },
    { method: "turn/completed", kind: "turn_lifecycle", payload: { turn: { status: "failed" } } },
    { method: "thread/status/changed", kind: "provider_event", payload: { threadStatus: { type: "systemError" } } },
    { method: "result", kind: "error", payload: { is_error: true } },
    { method: "process/systemError", kind: "command_output", payload: { status: "systemError" } },
  ] as const) {
    assert.equal(providerStreamLifecycle({ ...streamEvent(1, failure.method), ...failure }), "failed", failure.method);
  }
  for (const tool of ["wait_for_messages", "mcp__letagents__wait_for_messages", "read_messages"]) {
    assert.equal(providerStreamLifecycle({
      ...streamEvent(1, "item/completed"), kind: "item_lifecycle",
      payload: { item: { type: "mcpToolCall", status: "failed", tool, error: { message: "tool failed" } } },
    }), tool.includes("wait_for_messages") ? "idle" : "working");
  }
});

test("provider stream events are FIFO per entry and stale handles are ignored", async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const harness = coordinatorHarness({
    appendActivity: async (method) => {
      calls.push(method);
      if (method === "item/first") await firstBlocked;
    },
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");

  const first = harness.coordinator.enqueue("agent-1", handle, streamEvent(1, "item/first"));
  const second = harness.coordinator.enqueue("agent-1", handle, streamEvent(2, "item/second"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["item/first"], "second event waits behind the first projection");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["item/first", "item/second"]);

  await harness.coordinator.enqueue(
    "agent-1",
    { ...handle, pid: 99 },
    streamEvent(3, "item/stale"),
  );
  assert.deepEqual(calls, ["item/first", "item/second"]);
  await harness.coordinator.disposeAll();
});

test("queued raw lifecycle checkpoints record unavailability when replacement wins first", async () => {
  const unavailable: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const harness = coordinatorHarness({
    appendActivity: async (method) => {
      if (method === "item/first") await firstBlocked;
    },
    markLifecycleProjectionUnavailable: provider => unavailable.push(provider),
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  const first = harness.coordinator.enqueue("agent-1", handle, streamEvent(1, "item/first"));
  const terminal = harness.coordinator.enqueue("agent-1", handle, {
    ...streamEvent(2, "turn/completed"),
    kind: "turn_lifecycle",
    nativeEventId: "native-terminal",
    nativeLifecyclePhase: "turn_terminal",
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.coordinator.liveHandles.set("agent-1", { ...handle, pid: 99 });
  releaseFirst();
  await Promise.all([first, terminal]);

  assert.deepEqual(unavailable, ["codex"]);
  await harness.coordinator.disposeAll();
});

test("a raw lifecycle checkpoint records unavailability when its manifest entry disappeared", async () => {
  const unavailable: string[] = [];
  const harness = coordinatorHarness({
    markLifecycleProjectionUnavailable: provider => unavailable.push(provider),
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  harness.setManifestAvailable(false);
  await harness.coordinator.enqueue("agent-1", handle, {
    ...streamEvent(1, "turn/completed"),
    kind: "turn_lifecycle",
    nativeEventId: "native-terminal",
    nativeLifecyclePhase: "turn_terminal",
  });

  assert.deepEqual(unavailable, ["codex"]);
  await harness.coordinator.disposeAll();
});

test("terminal fencing is idempotent for one exact handle", async () => {
  let releaseStop!: () => void;
  const stopBlocked = new Promise<void>((resolve) => { releaseStop = resolve; });
  const harness = coordinatorHarness({ stop: async () => stopBlocked });
  const first = harness.coordinator.fenceTerminalOnce(handle, "terminal-1");
  const second = harness.coordinator.fenceTerminalOnce(handle, "terminal-2");
  assert.equal(first, second);
  assert.equal(harness.stopCalls(), 1);
  releaseStop();
  await Promise.all([first, second]);
});

test("resume staging requires a terminal predecessor and exactly one live successor", async () => {
  const pollingEntry = { ...entry(), delivery_mode: "mcp_polling" as const };
  const predecessorTerminal = {
    ended_at: "2026-08-26T00:00:00.000Z",
    exit_code: 0,
    signal: null,
    stdio_archive_ref: null,
    stdio_tail: "",
    terminal_cause: "stopped",
    actor: "daemon-provider",
    generation: 1,
    provider_continuation_id: "continuation-1",
  };
  const harness = coordinatorHarness({
    durabilityAttempt: {
      execution_generations: [
        { execution_generation_id: "generation-1", terminal: predecessorTerminal },
        { execution_generation_id: "generation-2", terminal: null },
      ],
    },
  });
  const priorBinding = {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "generation-1",
    agent_session_id: "session-1",
    credential_ref: "credential-1",
    api_url: "https://example.test",
    room_cursor: "7",
    last_sequence: 7,
    last_observed_at_ms: 1_777_000_000_000,
    updated_at: "2026-08-26T00:00:00.000Z",
  };
  harness.setManifest(pollingEntry);
  await harness.coordinator.stageWorkerBindingAfterResume(
    pollingEntry,
    priorBinding,
    "generation-2",
    handle,
  );
  assert.deepEqual(harness.pendingInstalled, [{
    roomId: "room-1",
    workAttemptId: "attempt-1",
    predecessorExecutionGenerationId: "generation-1",
    successorExecutionGenerationId: "generation-2",
    agentSessionId: "session-1",
    providerContinuationId: "continuation-1",
  }]);

  await assert.rejects(
    () => harness.coordinator.stageWorkerBindingAfterResume(
      pollingEntry,
      { ...priorBinding, execution_generation_id: "wrong-generation" },
      "generation-2",
      handle,
    ),
    /predecessor execution is not durably terminal/,
  );
});

test("raw lifecycle shadow capture precedes daemon-inbox terminal rewriting and owns no runtime behavior", async () => {
  const observations: LifecycleProjectionObservation[] = [];
  const harness = coordinatorHarness({ observeLegacyLifecycle: (observation) => observations.push(observation) });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.enqueue("agent-1", handle, {
    ...streamEvent(1, "turn/completed"),
    kind: "turn_lifecycle",
    nativeEventId: "native-terminal",
    nativeLifecyclePhase: "turn_terminal",
  });
  assert.deepEqual(observations, [{
    agentId: "agent-1",
    provider: "codex",
    workAttemptId: "attempt-1",
    executionGenerationId: "generation-2",
    nativeEventId: "native-terminal",
    phase: "turn_terminal",
    state: "terminal",
  }]);
  assert.equal(harness.stopCalls(), 0, "daemon-inbox still rewrites operational terminal to idle");
  assert.notEqual(harness.getManifest().observed_state, "failed");
  await harness.coordinator.disposeAll();
});

test("raw lifecycle shadow capture rejects inexact identity and isolates observer failures", async () => {
  const observations: LifecycleProjectionObservation[] = [];
  const unavailable: string[] = [];
  let throwObservation = false;
  const harness = coordinatorHarness({ observeLegacyLifecycle: (observation) => {
    if (throwObservation) throw new Error("optional storage unavailable");
    observations.push(observation);
  }, markLifecycleProjectionUnavailable: provider => unavailable.push(provider) });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  const exact = {
    ...streamEvent(1, "turn/started"),
    kind: "turn_lifecycle",
    nativeEventId: "native-active",
    nativeLifecyclePhase: "turn_active" as const,
  };
  for (const inexact of [
    { ...exact, workAttemptId: "other-attempt" },
    { ...exact, providerContinuationId: "other-continuation" },
    { ...exact, provider: "other-provider" },
  ]) await harness.coordinator.enqueue("agent-1", handle, inexact);
  assert.deepEqual(observations, []);
  assert.deepEqual(unavailable, ["codex", "codex", "codex"]);

  harness.setManifest({ ...entry(), provider_ref: {
    ...entry().provider_ref!, execution_generation_id: "generation-replaced",
  } });
  await harness.coordinator.enqueue("agent-1", handle, exact);
  assert.equal(observations.at(-1)?.executionGenerationId, "generation-2",
    "an old installed stream retains its captured generation instead of borrowing the successor manifest generation");
  harness.setManifest(entry());

  throwObservation = true;
  await harness.coordinator.enqueue("agent-1", handle, exact);
  assert.equal(unavailable.at(-1), "codex");
  assert.equal(harness.getManifest().observed_state, "working");
  assert.equal(harness.stopCalls(), 0);
  await harness.coordinator.disposeAll();
});

test("daemon inbox ignores provider wait evidence and measures illegal legacy authority calls", async () => {
  const harness = coordinatorHarness();
  harness.setManifest({ ...entry(), provider: "claude-code" });
  harness.runtimeCustody.installPendingResumeBinding("agent-1", {
    roomId: "room-1", workAttemptId: "attempt-1", predecessorExecutionGenerationId: "generation-1",
    successorExecutionGenerationId: "generation-2", agentSessionId: "session-1", providerContinuationId: "continuation-1",
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.enqueue("agent-1", handle, {
    ...streamEvent(1, "assistant"), provider: "claude-code",
    payload: { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__letagents__wait_for_messages",
      input: { after_message_id: "8", agent_session_id: "session-1" } }] } },
  });
  assert.equal(harness.coordinator.recoveryDiagnostics().daemon_inbox_wait_evidence_dependency, 0,
    "ordinary provider output never enters a daemon-owned authority path");
  assert.equal(harness.getManifest().condition, "none");
  assert.deepEqual(harness.pendingInstalled, []);
  assert.equal(harness.runtimeCustody.hasPendingResumeBinding("agent-1"), true,
    "provider output cannot clear or advance a retained authority record");

  await assert.rejects(harness.coordinator.stageWorkerBindingAfterResume(entry(), {} as never, "generation-2", handle),
    /Only legacy polling/);
  assert.equal(await harness.coordinator.restoreWorkerBindingFromWait("agent-1", {
    agentSessionId: "session-1", roomCursor: "8",
  }), false);
  await harness.coordinator.checkpointObservedWaitCursor(entry(), "8", "session-1");
  assert.equal(harness.coordinator.recoveryDiagnostics().daemon_inbox_wait_evidence_dependency, 3,
    "the diagnostic counts attempted dependencies rather than returning a constant zero");
  await harness.coordinator.disposeAll();
});

test("handoff detach attempts every stream disposer, surfaces failures, and never awaits callbacks", async () => {
  const disposed: string[] = [];
  let timerSequence = 0;
  let callbackReleased = false;
  let releaseCallback!: () => void;
  const wedgedCallback = new Promise<void>((resolve) => {
    releaseCallback = () => { callbackReleased = true; resolve(); };
  });
  const harness = coordinatorHarness({
    onExit: async (current) => () => {
      disposed.push(`exit:${current.pid}`);
      if (current.pid === 42) throw new Error("exit unsubscribe failed");
    },
    onStream: async (current) => () => { disposed.push(`stream:${current.pid}`); },
    setInterval: (() => {
      timerSequence += 1;
      return { id: timerSequence, unref() {} };
    }) as unknown as typeof setInterval,
    clearInterval: ((timer: { id: number }) => {
      disposed.push(`heartbeat:${timer.id}`);
    }) as unknown as typeof clearInterval,
    endStream: (entryId) => { disposed.push(`end:${entryId}`); },
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.install(
    "agent-2",
    { ...handle, pid: 43 },
    "generation-2",
  );
  harness.coordinator.track(wedgedCallback);

  assert.throws(() => harness.coordinator.detachAll(), /exit unsubscribe failed/);
  assert.equal(callbackReleased, false, "handoff never waits for the wedged callback");
  assert.deepEqual(disposed, [
    "exit:42",
    "stream:42",
    "heartbeat:1",
    "end:agent-1",
    "exit:43",
    "stream:43",
    "heartbeat:2",
    "end:agent-2",
  ]);
  releaseCallback();
  await wedgedCallback;
});
