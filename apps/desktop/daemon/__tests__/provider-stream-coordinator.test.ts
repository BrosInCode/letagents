import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionStreamEvent,
} from "../provider-action-port.js";
import { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";

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
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  endStream?: (entryId: string) => void;
} = {}) {
  let manifest = entry();
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
    },
    manifest: {
      getEntry: async () => manifest,
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
    transition: async () => {},
    appendActivity: async (_entryId, event) => {
      await input.appendActivity?.(event.method);
    },
    publishNativeActivity: async () => {},
    handleTerminal: async () => {},
    streams: { reset: () => {}, push: () => {}, end: (entryId) => input.endStream?.(entryId) },
    delivery: { start: async () => {}, startCutover: async () => {} },
    heartbeat: {
      intervalMs: 60_000,
      requiresHostGrant: () => false,
      currentHostGrant: () => null,
      hostGrantNeedsRenewal: () => false,
      hostWorkerBearerNeedsRotation: async () => false,
      requestConvergence: () => {},
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
  };
}

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
  await harness.coordinator.stageWorkerBindingAfterResume(
    entry(),
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
      entry(),
      { ...priorBinding, execution_generation_id: "wrong-generation" },
      "generation-2",
      handle,
    ),
    /predecessor execution is not durably terminal/,
  );
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
