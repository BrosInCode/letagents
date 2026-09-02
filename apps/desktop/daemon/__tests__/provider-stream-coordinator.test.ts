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
  type ProviderInstallationToken,
} from "../provider-stream-coordinator.js";
import { providerStreamLifecycle } from "../provider-stream-policy.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import type { LifecycleProjectionObservation } from "../lifecycle-projection-ledger.js";

const cleanLifecycleProjection = () => ({
  available: true,
  providers: Object.fromEntries(["codex", "claude-code", "cursor", "open-model"].map((provider) => [provider, {
    comparedSegments: 1,
    matched: 1,
    missingInTyped: 0,
    missingInLegacy: 0,
    pairedButDifferent: 0,
    conflicts: 0,
    observationUnavailable: 0,
  }])) as Record<"codex" | "claude-code" | "cursor" | "open-model", {
    comparedSegments: number; matched: number; missingInTyped: number; missingInLegacy: number;
    pairedButDifferent: number; conflicts: number; observationUnavailable: number;
  }>,
});
const captureAdmission = (status: "pending" | "ready" | "unavailable" = "ready") => ({
  codex: status,
  "claude-code": status,
  cursor: status,
  "open-model": status,
});

test("local lifecycle conformance requires present clean evidence and clean daemon-owned wait authority", () => {
  assert.deepEqual(lifecycleLocalConformanceEligibility(cleanLifecycleProjection(), 0, captureAdmission()), {
    codex: true, "claude-code": true, cursor: true, "open-model": true,
  });
  assert.deepEqual(lifecycleLocalConformanceEligibility({ ...cleanLifecycleProjection(), available: false }, 0, captureAdmission()), {
    codex: false, "claude-code": false, cursor: false, "open-model": false,
  });
  assert.deepEqual(lifecycleLocalConformanceEligibility(cleanLifecycleProjection(), 1, captureAdmission()), {
    codex: false, "claude-code": false, cursor: false, "open-model": false,
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
      codex: false, "claude-code": true, cursor: true, "open-model": true,
    }, `${field} blocks only its provider`);
  }

  for (const malformed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const projection = cleanLifecycleProjection();
    projection.providers.codex.matched = malformed;
    assert.equal(lifecycleLocalConformanceEligibility(projection, 0, captureAdmission()).codex, false);
  }
  for (const status of ["pending", "unavailable"] as const) {
    assert.deepEqual(lifecycleLocalConformanceEligibility(cleanLifecycleProjection(), 0, captureAdmission(status)), {
      codex: false, "claude-code": false, cursor: false, "open-model": false,
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
    provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 42, processIdentity: "codex:42" },
  },
  activity: [],
});

const handle: ProviderActionHandle = {
  workAttemptId: "attempt-1",
  pid: 42,
  providerContinuationId: "continuation-1",
  observedState: "working",
  providerConnection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 42, processIdentity: "codex:42" },
  appliedConfigurationRevision: 1,
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
  appendActivityOnly?: (method: string) => Promise<void>;
  stop?: () => Promise<void>;
  durabilityAttempt?: { execution_generations: Array<Record<string, unknown>>; checkpoints?: unknown[] };
  onExit?: ProviderActionPort["onExit"];
  onStream?: NonNullable<ProviderActionPort["onStream"]>;
  probeControl?: NonNullable<ProviderActionPort["probeControl"]>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  endStream?: (entryId: string) => void;
  observeExecution?: (installation: ProviderInstallationToken) => () => void;
  advanceExecution?: (installation: ProviderInstallationToken) => void;
  observeLegacyLifecycle?: (observation: LifecycleProjectionObservation) => void;
  markLifecycleProjectionUnavailable?: (provider: "codex" | "claude-code" | "cursor" | "open-model") => void;
  lifecycleProjectionDiagnostics?: () => ReturnType<typeof cleanLifecycleProjection>;
  captureAdmission?: (installation: ProviderInstallationToken) => "pending" | "ready" | "unavailable";
  typedLifecycleAdmission?: (installation: ProviderInstallationToken) => "pending" | "ready" | "unavailable";
  authorityMode?: "legacy" | "typed_shadow" | "typed";
  observePermissions?: (entryId: string, handle: ProviderActionHandle, generation: string) => () => void;
  startDelivery?: (entryId: string) => Promise<void>;
  startCutover?: (entryId: string) => Promise<void>;
  bindingGet?: (entryId: string) => Promise<null>;
  publishNativeActivity?: () => Promise<void>;
  requestConvergence?: (entryId: string) => void;
  serializeManifest?: <T>(operation: () => Promise<T>) => Promise<T>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
} = {}) {
  let manifest = entry();
  let manifestAvailable = true;
  const runtimeCustody = new WorkerRuntimeCustody();
  const pendingInstalled: unknown[] = [];
  const bindings = {
    get: input.bindingGet ?? (async () => null),
    credentialFor: async () => null,
    supervisedWorkerSession: async () => null,
    verifyAndAdvanceExecutionGeneration: async () => { throw new Error("unused"); },
    checkpointCursorMonotonic: async () => { throw new Error("unused"); },
  };
  let stopCalls = 0;
  const coordinator = new ProviderStreamCoordinator({
    observeExecution: input.observeExecution,
    advanceExecution: input.advanceExecution,
    observeLegacyLifecycle: input.observeLegacyLifecycle,
    markLifecycleProjectionUnavailable: input.markLifecycleProjectionUnavailable,
    lifecycleProjectionDiagnostics: input.lifecycleProjectionDiagnostics,
    captureAdmission: input.captureAdmission,
    typedLifecycleAdmission: input.typedLifecycleAdmission,
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
      readRuntimeLifecycleAuthority: async ({ agentId, executionGenerationId, providerConnection, configurationRevision }) =>
        providerConnection.kind === "cursor_cli" && providerConnection.pid === null
          ? null
          : manifestAvailable
          && agentId === manifest.id
          && executionGenerationId === manifest.provider_ref?.execution_generation_id
          && providerConnection.pid === manifest.provider_ref?.provider_connection?.pid
          && providerConnection.processIdentity === manifest.provider_ref?.provider_connection?.processIdentity
          && configurationRevision === 1
          ? input.authorityMode ?? "typed_shadow" : null,
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
    serializeManifest: input.serializeManifest ?? (async operation => operation()),
    transition: async (_entryId, observed_state, condition) => {
      manifest = { ...manifest, observed_state, condition };
    },
    appendActivity: async (_entryId, event) => input.appendActivity?.(event.method),
    appendActivityOnly: async (_entryId, event) => input.appendActivityOnly?.(event.method),
    publishNativeActivity: async () => input.publishNativeActivity?.(),
    handleTerminal: async () => {},
    streams: { reset: () => {}, push: () => {}, end: (entryId) => input.endStream?.(entryId) },
    delivery: { start: input.startDelivery ?? (async () => {}), startCutover: input.startCutover ?? (async () => {}) },
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
    setTimeout: input.setTimeout,
    clearTimeout: input.clearTimeout,
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
    captureAdmission: installation => admissions.get(installation.entryId) ?? "unavailable",
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  assert.deepEqual(harness.coordinator.recoveryDiagnostics().lifecycle_capture_admission, {
    codex: "pending", "claude-code": "unavailable", cursor: "unavailable", "open-model": "unavailable",
  });
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_local_conformance_eligible.codex, false);

  admissions.set("agent-1", "ready");
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_local_conformance_eligible.codex, true);

  const second = { ...handle, pid: 43, workAttemptId: "attempt-2",
    providerConnection: { ...handle.providerConnection!, pid: 43, processIdentity: "codex:43" } };
  admissions.set("agent-2", "unavailable");
  harness.setManifest({ ...entry(), id: "agent-2", work_attempt_id: "attempt-2", provider_ref: {
    work_attempt_id: "attempt-2", execution_generation_id: "generation-3",
    provider_continuation_id: "continuation-1", provider_connection: second.providerConnection!,
  } });
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

test("typed daemon-inbox activation waits for exact durable readiness and latches one way", async () => {
  let admission: "pending" | "ready" | "unavailable" = "pending";
  let exitRegistrations = 0;
  let captureRegistrations = 0;
  let permissionRegistrations = 0;
  let heartbeatRegistrations = 0;
  let deliveryStarts = 0;
  let publishedNativeActivity = 0;
  const rawListeners: Array<(event: ProviderActionStreamEvent) => void> = [];
  const activity: string[] = [];
  const activityOnly: string[] = [];
  const legacyLifecycle: LifecycleProjectionObservation[] = [];
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => admission,
    observeExecution: () => { captureRegistrations += 1; return () => {}; },
    observePermissions: () => { permissionRegistrations += 1; return () => {}; },
    onExit: async () => { exitRegistrations += 1; return () => {}; },
    onStream: async (_handle, listener) => { rawListeners.push(listener); return () => {}; },
    setInterval: ((() => {
      heartbeatRegistrations += 1;
      return { unref() {} };
    }) as unknown as typeof setInterval),
    startDelivery: async () => { deliveryStarts += 1; },
    publishNativeActivity: async () => { publishedNativeActivity += 1; },
    appendActivity: async method => { activity.push(method); },
    appendActivityOnly: async method => { activityOnly.push(method); },
    observeLegacyLifecycle: observation => { legacyLifecycle.push(observation); },
  });

  await harness.coordinator.install("agent-1", handle, "generation-2");
  assert.equal(captureRegistrations, 1);
  assert.equal(permissionRegistrations, 1);
  assert.equal(exitRegistrations, 1, "process exit authority attaches before typed readiness");
  assert.equal(rawListeners.length, 0);
  assert.equal(heartbeatRegistrations, 0);
  assert.equal(deliveryStarts, 0);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "canonical worker binding cannot bypass the exact typed hold");
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_capture_admission.codex, "pending");

  admission = "unavailable";
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(rawListeners.length, 0, "unavailable evidence cannot promote a typed birth");
  assert.equal(deliveryStarts, 0);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false);

  admission = "ready";
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(rawListeners.length, 1);
  assert.equal(heartbeatRegistrations, 1);
  assert.equal(deliveryStarts, 1);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true);
  assert.equal(harness.coordinator.recoveryDiagnostics().lifecycle_capture_admission.codex, "ready");
  harness.runtimeCustody.installLiveBinding("agent-1", {
    agentSessionId: "session-1", executionGenerationId: "generation-2",
    updatedAt: "2026-08-26T00:00:00.000Z",
  });

  admission = "unavailable";
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(rawListeners.length, 1, "a ready exact birth never demotes or installs twice");
  assert.equal(deliveryStarts, 1);

  rawListeners[0]!(streamEvent(1, "item/agentMessage/delta"));
  await harness.coordinator.drainCallbacks();
  assert.deepEqual(activity, []);
  assert.deepEqual(activityOnly, ["item/agentMessage/delta"],
    "typed raw output is presentation-only and cannot mutate lifecycle fields");
  assert.equal(publishedNativeActivity, 0,
    "typed raw output cannot publish operational room liveness through a valid worker binding");

  rawListeners[0]!({
    ...streamEvent(2, "turn/failed"),
    kind: "turn_lifecycle",
    nativeEventId: "turn-1:terminal",
    nativeLifecyclePhase: "turn_terminal",
  });
  await harness.coordinator.drainCallbacks();
  assert.equal(harness.getManifest().observed_state, "working",
    "an exact failed turn cannot poison the reusable typed Codex runtime");
  assert.equal(harness.stopCalls(), 0);
  assert.deepEqual(legacyLifecycle.map(({ nativeEventId, phase, state }) => ({ nativeEventId, phase, state })), [
    { nativeEventId: "turn-1:terminal", phase: "turn_terminal", state: "terminal" },
  ], "typed operation preserves the legacy comparator without granting it lifecycle authority");
  await harness.coordinator.disposeAll();
});

test("typed activation cannot open delivery when durable failure wins the serialized promotion boundary", async () => {
  let releasePromotion!: () => void;
  let promotionEntered!: () => void;
  const entered = new Promise<void>(resolve => { promotionEntered = resolve; });
  const blocked = new Promise<void>(resolve => { releasePromotion = resolve; });
  let streamRegistrations = 0;
  let heartbeatRegistrations = 0;
  let deliveryStarts = 0;
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => "ready",
    serializeManifest: async operation => {
      promotionEntered();
      await blocked;
      return operation();
    },
    onStream: async () => { streamRegistrations += 1; return () => {}; },
    setInterval: ((() => {
      heartbeatRegistrations += 1;
      return { unref() {} };
    }) as unknown as typeof setInterval),
    startDelivery: async () => { deliveryStarts += 1; },
  });

  await harness.coordinator.install("agent-1", handle, "generation-2");
  await entered;
  harness.setManifest({ ...harness.getManifest(), observed_state: "failed" });
  releasePromotion();
  await harness.coordinator.drainCallbacks();

  assert.equal(streamRegistrations, 1, "physical observation may begin before the final durable fence");
  assert.equal(heartbeatRegistrations, 1);
  assert.equal(deliveryStarts, 0);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "a typed birth that failed before admission remains closed");
  await harness.coordinator.disposeAll();
});

test("typed terminal effect revokes an admitted delivery latch before convergence", async () => {
  let deliveryStarts = 0;
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => "ready",
    startDelivery: async () => { deliveryStarts += 1; },
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.drainCallbacks();
  assert.equal(deliveryStarts, 1);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true);

  harness.setManifest({ ...harness.getManifest(), observed_state: "failed" });
  harness.coordinator.typedLifecycleEffectChanged("agent-1", "failed");
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "the committed terminal effect closes delivery without waiting for convergence");
  await harness.coordinator.disposeAll();
});

test("typed promotion remains retryable when raw stream registration fails", async () => {
  let registrations = 0;
  let deliveryStarts = 0;
  const retries: Array<() => void> = [];
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => "ready",
    onStream: async () => {
      registrations += 1;
      if (registrations === 1) throw new Error("injected registration failure");
      return () => {};
    },
    startDelivery: async () => { deliveryStarts += 1; },
    setTimeout: (((callback: () => void) => {
      retries.push(callback);
      return { unref() {} };
    }) as unknown as typeof setTimeout),
    clearTimeout: ((() => {}) as typeof clearTimeout),
  });

  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.drainCallbacks();
  assert.equal(registrations, 1);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "a failed activation cannot commit the one-way latch");
  assert.equal(deliveryStarts, 0);
  assert.equal(retries.length, 1, "promotion schedules its own bounded exact-birth retry");

  retries.shift()!();
  await harness.coordinator.drainCallbacks();
  assert.equal(registrations, 2);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true);
  assert.equal(deliveryStarts, 1);
  await harness.coordinator.disposeAll();
});

test("typed installation publishes its inert hold before asynchronous prerequisites", async () => {
  let releaseBinding!: (value: null) => void;
  let bindingStarted!: () => void;
  const started = new Promise<void>((resolve) => { bindingStarted = resolve; });
  const blockedBinding = new Promise<null>((resolve) => { releaseBinding = resolve; });
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => "ready",
    bindingGet: async () => {
      bindingStarted();
      return blockedBinding;
    },
  });

  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "an absent provider installation always fails the central delivery gate closed");
  const install = harness.coordinator.install("agent-1", handle, "generation-2");
  await started;
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "a current typed token is inert before binding and exit prerequisites finish");
  releaseBinding(null);
  await install;
  await harness.coordinator.drainCallbacks();
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true);
  await harness.coordinator.disposeAll();
});

test("a rejected typed prerequisite removes the partial installation before retry", async () => {
  let bindingAttempts = 0;
  let deliveryStarts = 0;
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => "ready",
    bindingGet: async () => {
      bindingAttempts += 1;
      if (bindingAttempts === 1) throw new Error("injected binding failure");
      return null;
    },
    startDelivery: async () => { deliveryStarts += 1; },
  });

  await assert.rejects(
    harness.coordinator.install("agent-1", handle, "generation-2"),
    /injected binding failure/,
  );
  assert.equal(harness.coordinator.get("agent-1"), undefined);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false);

  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.drainCallbacks();
  assert.equal(bindingAttempts, 2);
  assert.equal(deliveryStarts, 1);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true);
  await harness.coordinator.disposeAll();
});

test("typed delivery-start retry reuses one physical stream and heartbeat", async () => {
  let admission: "ready" | "unavailable" = "ready";
  let rawRegistrations = 0;
  let heartbeatRegistrations = 0;
  let deliveryStarts = 0;
  const retries: Array<() => void> = [];
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: () => admission,
    onStream: async () => { rawRegistrations += 1; return () => {}; },
    setInterval: ((() => {
      heartbeatRegistrations += 1;
      return { unref() {} };
    }) as unknown as typeof setInterval),
    startDelivery: async () => {
      deliveryStarts += 1;
      if (deliveryStarts === 1) throw new Error("injected delivery failure");
    },
    setTimeout: (((callback: () => void) => {
      retries.push(callback);
      return { unref() {} };
    }) as unknown as typeof setTimeout),
    clearTimeout: ((() => {}) as typeof clearTimeout),
  });

  await harness.coordinator.install("agent-1", handle, "generation-2");
  await harness.coordinator.drainCallbacks();
  assert.equal(rawRegistrations, 1);
  assert.equal(heartbeatRegistrations, 1);
  assert.equal(deliveryStarts, 1);
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true,
    "the one-way operational latch stays armed after physical activation");
  assert.equal(retries.length, 1);

  admission = "unavailable";
  retries.shift()!();
  await harness.coordinator.drainCallbacks();
  assert.equal(rawRegistrations, 1, "delivery retry cannot duplicate the raw listener");
  assert.equal(heartbeatRegistrations, 1, "delivery retry cannot duplicate the heartbeat");
  assert.equal(deliveryStarts, 2);
  await harness.coordinator.disposeAll();
});

test("typed readiness belongs to one immutable provider birth", async () => {
  const admissions = new WeakMap<ProviderInstallationToken, "pending" | "ready">();
  const installations: ProviderInstallationToken[] = [];
  const rawListeners: Array<(event: ProviderActionStreamEvent) => void> = [];
  let deliveryStarts = 0;
  const harness = coordinatorHarness({
    authorityMode: "typed",
    typedLifecycleAdmission: installation => admissions.get(installation) ?? "pending",
    observeExecution: installation => {
      installations.push(installation);
      admissions.set(installation, "pending");
      return () => {};
    },
    onStream: async (_handle, listener) => { rawListeners.push(listener); return () => {}; },
    startDelivery: async () => { deliveryStarts += 1; },
  });
  await harness.coordinator.install("agent-1", handle, "generation-2");
  const first = installations[0]!;

  const replacement: ProviderActionHandle = {
    ...handle,
    pid: 43,
    providerConnection: { ...handle.providerConnection!, pid: 43, processIdentity: "codex:43" },
  };
  harness.setManifest({
    ...entry(),
    provider_ref: { ...entry().provider_ref!, provider_connection: replacement.providerConnection! },
  });
  await harness.coordinator.install("agent-1", replacement, "generation-2");
  const second = installations[1]!;
  assert.notEqual(first, second);

  admissions.set(first, "ready");
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(rawListeners.length, 0, "a stale birth cannot arm its replacement");
  assert.equal(deliveryStarts, 0);

  admissions.set(second, "ready");
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(rawListeners.length, 1);
  assert.equal(deliveryStarts, 1);
  await harness.coordinator.disposeAll();
});

for (const candidate of [
  { name: "shadow polling", authorityMode: "typed_shadow" as const, deliveryMode: "mcp_polling" as const },
  { name: "shadow daemon-inbox", authorityMode: "typed_shadow" as const, deliveryMode: "daemon_inbox" as const },
]) {
  test(`${candidate.name} keeps the existing operational stream and activity path`, async () => {
    const rawListeners: Array<(event: ProviderActionStreamEvent) => void> = [];
    const activity: string[] = [];
    const activityOnly: string[] = [];
    let deliveryStarts = 0;
    const harness = coordinatorHarness({
      authorityMode: candidate.authorityMode,
      typedLifecycleAdmission: () => "pending",
      onStream: async (_handle, listener) => { rawListeners.push(listener); return () => {}; },
      startDelivery: async () => { deliveryStarts += 1; },
      appendActivity: async method => { activity.push(method); },
      appendActivityOnly: async method => { activityOnly.push(method); },
    });
    harness.setManifest({ ...entry(), delivery_mode: candidate.deliveryMode });
    await harness.coordinator.install("agent-1", handle, "generation-2");
    assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true,
      "only typed daemon-inbox births acquire the operational hold");
    assert.equal(rawListeners.length, 1);
    assert.equal(deliveryStarts, 1);
    rawListeners[0]!(streamEvent(1, "item/agentMessage/delta"));
    await harness.coordinator.drainCallbacks();
    assert.deepEqual(activity, ["item/agentMessage/delta"]);
    assert.deepEqual(activityOnly, []);
    await harness.coordinator.disposeAll();
  });
}

test("Cursor typed child births share one listener but never share operational admission", async () => {
  const rawListeners: Array<(event: ProviderActionStreamEvent) => void> = [];
  const admissions = new WeakMap<ProviderInstallationToken, "pending" | "ready">();
  const childTokens: ProviderInstallationToken[] = [];
  const activity: string[] = [];
  const activityOnly: string[] = [];
  let deliveryStarts = 0;
  const cursorHandle: ProviderActionHandle = {
    workAttemptId: "attempt-1", pid: null, providerContinuationId: "continuation-1",
    observedState: "idle", appliedConfigurationRevision: 1,
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
  };
  const cursorEntry = (connection: Extract<NonNullable<ProviderActionHandle["providerConnection"]>, { kind: "cursor_cli" }>): DaemonManifestEntry => ({
    ...entry(), provider: "cursor", observed_state: connection.pid === null ? "idle" : "working",
    provider_ref: { ...entry().provider_ref!, provider_connection: connection },
  });
  const event = (sequence: number, method: string, connection: { pid: number; processIdentity: string }): ProviderActionStreamEvent => ({
    ...streamEvent(sequence, method), provider: "cursor", nativeProcessPid: connection.pid,
    nativeProcessIdentity: connection.processIdentity,
  });
  const harness = coordinatorHarness({
    typedLifecycleAdmission: installation => admissions.get(installation) ?? "pending",
    advanceExecution: installation => { childTokens.push(installation); admissions.set(installation, "pending"); },
    onStream: async (_handle, listener) => { rawListeners.push(listener); return () => {}; },
    appendActivity: async method => { activity.push(method); },
    appendActivityOnly: async method => { activityOnly.push(method); },
    startDelivery: async () => { deliveryStarts += 1; },
  });
  harness.setManifest(cursorEntry(cursorHandle.providerConnection as Extract<NonNullable<ProviderActionHandle["providerConnection"]>, { kind: "cursor_cli" }>));
  await harness.coordinator.install("agent-1", cursorHandle, "generation-2");
  assert.equal(rawListeners.length, 1);
  assert.equal(deliveryStarts, 1);

  const birthA = { kind: "cursor_cli" as const, pid: 101, processIdentity: "cursor-typed-a" };
  cursorHandle.pid = birthA.pid; cursorHandle.providerConnection = birthA; cursorHandle.observedState = "working";
  harness.setManifest(cursorEntry(birthA));
  const tokenA = harness.coordinator.activateCommittedCursorRuntime({
    entry: harness.getManifest(), handle: cursorHandle, executionGenerationId: "generation-2", authorityMode: "typed",
  });
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false);
  rawListeners[0]!(event(1, "cursor/a-before-ready", birthA));
  await harness.coordinator.drainCallbacks();
  assert.deepEqual(activity, []);
  assert.deepEqual(activityOnly, ["cursor/a-before-ready"],
    "an unadmitted child can expose presentation without acquiring lifecycle fields");

  const birthB = { kind: "cursor_cli" as const, pid: 102, processIdentity: "cursor-typed-b" };
  cursorHandle.pid = birthB.pid; cursorHandle.providerConnection = birthB;
  harness.setManifest(cursorEntry(birthB));
  const tokenB = harness.coordinator.activateCommittedCursorRuntime({
    entry: harness.getManifest(), handle: cursorHandle, executionGenerationId: "generation-2", authorityMode: "typed",
  });
  admissions.set(tokenA, "ready");
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), false,
    "stale child A cannot arm child B");

  admissions.set(tokenB, "ready");
  harness.coordinator.typedLifecycleAdmissionChanged("agent-1");
  await harness.coordinator.drainCallbacks();
  assert.equal(harness.coordinator.isDeliveryAdmitted("agent-1"), true);
  assert.equal(rawListeners.length, 1, "child admission never duplicates the stable physical listener");
  assert.equal(deliveryStarts, 2, "exact readiness reopens the centrally gated delivery lane once");
  rawListeners[0]!(event(2, "cursor/b-after-ready", birthB));
  await harness.coordinator.drainCallbacks();
  assert.deepEqual(activity, []);
  assert.deepEqual(activityOnly, ["cursor/a-before-ready", "cursor/b-after-ready"]);
  assert.deepEqual(childTokens, [tokenA, tokenB]);
  await harness.coordinator.disposeAll();
});

test("Cursor keeps one listener lease while immutable child-birth tokens advance", async () => {
  const rawListeners: Array<(event: ProviderActionStreamEvent) => void> = [];
  const appended: string[] = [];
  const unavailable: string[] = [];
  const captureInstalls: ProviderInstallationToken[] = [];
  const captureAdvances: ProviderInstallationToken[] = [];
  const cursorHandle: ProviderActionHandle = {
    workAttemptId: "attempt-1",
    pid: null,
    providerContinuationId: "continuation-1",
    observedState: "idle",
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    appliedConfigurationRevision: 1,
  };
  const cursorEntry = (connection: Extract<NonNullable<ProviderActionHandle["providerConnection"]>, { kind: "cursor_cli" }>): DaemonManifestEntry => ({
    ...entry(),
    provider: "cursor",
    observed_state: connection.pid === null ? "idle" : "working",
    provider_ref: { ...entry().provider_ref!, provider_connection: connection },
  });
  const harness = coordinatorHarness({
    appendActivity: async method => { appended.push(method); },
    markLifecycleProjectionUnavailable: provider => unavailable.push(provider),
    observeExecution: installation => { captureInstalls.push(installation); return () => {}; },
    advanceExecution: installation => { captureAdvances.push(installation); },
    onStream: async (_handle, listener) => { rawListeners.push(listener); return () => {}; },
  });
  harness.setManifest(cursorEntry(cursorHandle.providerConnection as Extract<NonNullable<ProviderActionHandle["providerConnection"]>, { kind: "cursor_cli" }>));
  await harness.coordinator.install("agent-1", cursorHandle, "generation-2");
  assert.equal(rawListeners.length, 1);
  assert.equal(captureInstalls.length, 1);

  const birthA = { kind: "cursor_cli" as const, pid: 101, processIdentity: "cursor-birth-a" };
  cursorHandle.pid = birthA.pid;
  cursorHandle.providerConnection = birthA;
  cursorHandle.observedState = "working";
  harness.setManifest(cursorEntry(birthA));
  const tokenA = harness.coordinator.activateCommittedCursorRuntime({
    entry: harness.getManifest(), handle: cursorHandle, executionGenerationId: "generation-2", authorityMode: "typed_shadow",
  });
  rawListeners[0]!({ ...streamEvent(1, "cursor/a"), provider: "cursor",
    nativeProcessPid: birthA.pid, nativeProcessIdentity: birthA.processIdentity });
  await harness.coordinator.drainCallbacks();

  const idle = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
  cursorHandle.pid = null;
  cursorHandle.providerConnection = idle;
  cursorHandle.observedState = "idle";
  harness.setManifest(cursorEntry(idle));
  assert.equal(harness.coordinator.currentInstallation("agent-1"), undefined,
    "the committed child token loses authority as soon as the handle moves to idle");
  harness.coordinator.activateCommittedCursorRuntime({
    entry: harness.getManifest(), handle: cursorHandle, executionGenerationId: "generation-2", authorityMode: null,
  });

  const birthB = { kind: "cursor_cli" as const, pid: 102, processIdentity: "cursor-birth-b" };
  cursorHandle.pid = birthB.pid;
  cursorHandle.providerConnection = birthB;
  cursorHandle.observedState = "working";
  harness.setManifest(cursorEntry(birthB));
  assert.equal(harness.coordinator.currentInstallation("agent-1"), undefined,
    "an uncommitted successor child cannot borrow the prior token");
  const tokenB = harness.coordinator.activateCommittedCursorRuntime({
    entry: harness.getManifest(), handle: cursorHandle, executionGenerationId: "generation-2", authorityMode: "typed_shadow",
  });
  rawListeners[0]!({ ...streamEvent(2, "cursor/late-a"), provider: "cursor", kind: "turn_lifecycle",
    nativeProcessPid: birthA.pid, nativeProcessIdentity: birthA.processIdentity,
    nativeEventId: "late-a", nativeLifecyclePhase: "turn_terminal" });
  rawListeners[0]!({ ...streamEvent(3, "cursor/b"), provider: "cursor",
    nativeProcessPid: birthB.pid, nativeProcessIdentity: birthB.processIdentity });
  await harness.coordinator.drainCallbacks();

  assert.equal(rawListeners.length, 1, "child transitions never reinstall the physical stream listener");
  assert.equal(captureInstalls.length, 1, "typed capture keeps the stable handle subscription");
  assert.equal(captureAdvances.length, 3, "capture receives only committed child/idle token advances");
  assert.notEqual(tokenA, tokenB);
  assert.deepEqual(appended, ["cursor/a", "cursor/b"]);
  assert.deepEqual(unavailable, ["cursor"], "a late event from child A cannot borrow child B's token");
  assert.equal(harness.coordinator.currentInstallation("agent-1"), tokenB);

  const staleListener = rawListeners[0]!;
  await harness.coordinator.install("agent-1", cursorHandle, "generation-2");
  const replacementToken = harness.coordinator.currentInstallation("agent-1");
  assert.ok(replacementToken);
  assert.notEqual(replacementToken, tokenB);
  staleListener({ ...streamEvent(4, "cursor/stale-lease"), provider: "cursor",
    nativeProcessPid: birthB.pid, nativeProcessIdentity: birthB.processIdentity });
  rawListeners[1]!({ ...streamEvent(5, "cursor/current-lease"), provider: "cursor",
    nativeProcessPid: birthB.pid, nativeProcessIdentity: birthB.processIdentity });
  await harness.coordinator.drainCallbacks();
  assert.deepEqual(appended, ["cursor/a", "cursor/b", "cursor/current-lease"],
    "a disposed listener cannot borrow a replacement lease for the same handle and birth");
  await harness.coordinator.disposeAll();
});

test("queued Cursor init survives same-birth continuation adoption exactly once", async () => {
  const rawListeners: Array<(event: ProviderActionStreamEvent) => void> = [];
  const appended: string[] = [];
  const lifecycle: string[] = [];
  const cursorHandle: ProviderActionHandle = {
    workAttemptId: "attempt-1",
    pid: 101,
    providerContinuationId: "pending-continuation",
    observedState: "working",
    providerConnection: { kind: "cursor_cli", pid: 101, processIdentity: "cursor-birth" },
    appliedConfigurationRevision: 1,
  };
  const cursorEntry = (continuation: string): DaemonManifestEntry => ({
    ...entry(),
    provider: "cursor",
    provider_ref: {
      ...entry().provider_ref!,
      provider_continuation_id: continuation,
      provider_connection: structuredClone(cursorHandle.providerConnection!),
    },
  });
  const harness = coordinatorHarness({
    appendActivity: async method => { appended.push(method); },
    observeLegacyLifecycle: observation => { lifecycle.push(observation.nativeEventId); },
    onStream: async (_handle, listener) => { rawListeners.push(listener); return () => {}; },
  });
  harness.setManifest(cursorEntry("pending-continuation"));
  await harness.coordinator.install("agent-1", cursorHandle, "generation-2");

  rawListeners[0]!({ ...streamEvent(1, "system/init"), provider: "cursor", kind: "turn_lifecycle",
    providerContinuationId: "pending-continuation", nativeProcessPid: 101, nativeProcessIdentity: "cursor-birth",
    nativeEventId: "cursor-init", nativeLifecyclePhase: "turn_active" });
  cursorHandle.providerContinuationId = "real-continuation";
  harness.setManifest(cursorEntry("real-continuation"));
  const adopted = harness.coordinator.activateCommittedCursorRuntime({
    entry: harness.getManifest(), handle: cursorHandle, executionGenerationId: "generation-2", authorityMode: "typed_shadow",
  });

  await harness.coordinator.drainCallbacks();
  assert.equal(adopted.providerContinuationId, "real-continuation");
  assert.deepEqual(appended, ["system/init"]);
  assert.deepEqual(lifecycle, ["cursor-init"]);
  await harness.coordinator.disposeAll();
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
  const installation = harness.coordinator.currentInstallation(configured.id)!;
  assert.equal(harness.coordinator.remove(installation), true);
  assert.equal(harness.coordinator.currentInstallation(configured.id), undefined,
    "removed handles no longer hold live publication authority");
  assert.equal(harness.coordinator.isLatestInstallation(installation), true,
    "terminal reconciliation retains the exact latest-birth witness");
  assert.equal(disposed, 1);
  assert.deepEqual(harness.getManifest(), configured);
});

test("optional execution observation failures cannot block installation, delivery, or replacement cleanup", async () => {
  const installed: Array<[string, ProviderActionHandle, string]> = [];
  const disposed: ProviderActionHandle[] = [];
  const deliveries: string[] = [];
  const harness = coordinatorHarness({
    observeExecution: (installation) => {
      const { entryId, handle: current, executionGenerationId: generation } = installation;
      installed.push([entryId, current, generation]);
      if (current === handle) throw new Error("observation unavailable");
      return () => { disposed.push(current); throw new Error("optional cleanup unavailable"); };
    },
    startDelivery: async (entryId) => { deliveries.push(entryId); },
  });
  const second = { ...handle, pid: 43, providerConnection: {
    ...handle.providerConnection!, pid: 43, processIdentity: "codex:43",
  } };
  const third = { ...handle, pid: 44, providerConnection: {
    ...handle.providerConnection!, pid: 44, processIdentity: "codex:44",
  } };
  await harness.coordinator.install("agent-1", handle, "generation-2");
  harness.setManifest({ ...entry(), provider_ref: { ...entry().provider_ref!, execution_generation_id: "generation-3",
    provider_connection: second.providerConnection! } });
  await harness.coordinator.install("agent-1", second, "generation-3");
  harness.setManifest({ ...entry(), provider_ref: { ...entry().provider_ref!, execution_generation_id: "generation-4",
    provider_connection: third.providerConnection! } });
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
    const cutovers: string[] = [];
    const harness = coordinatorHarness({ startCutover: async (entryId) => { cutovers.push(entryId); } });
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
    const turnFailures = [
      { method: "turn/failed", kind: "turn_lifecycle", payload: {} },
      { method: "turn/completed", kind: "turn_lifecycle", payload: { turn: { status: "failed" } } },
      { method: "thread/read", kind: "transcript_snapshot", payload: { latestTurn: { status: "failed" } } },
      { method: "thread/read", kind: "transcript_snapshot", payload: { latestTurn: { status: { status: "failed" } } } },
    ] as const;
    for (const failure of turnFailures) {
      assert.equal(providerStreamLifecycle({ ...streamEvent(9, failure.method), ...failure }), "terminal", failure.method);
    }
    await harness.coordinator.enqueue("agent-1", handle, {
      ...streamEvent(9, turnFailures[0].method), ...turnFailures[0],
    });
    assert.notEqual(harness.getManifest().observed_state, "failed");
    assert.equal(cutovers.length, delivery_mode === "mcp_polling" ? 1 : 0,
      "only legacy polling observes the terminal edge as a cutover trigger");
    await harness.coordinator.enqueue("agent-1", handle, {
      ...streamEvent(10, "turn/started"), kind: "turn_lifecycle", payload: { turn: { status: "inProgress" } },
    });
    assert.equal(harness.getManifest().observed_state, "working", "the next turn remains admissible");
    assert.equal(harness.stopCalls(), 0, "only the native turn ends, never the reusable runtime");
    await harness.coordinator.enqueue("agent-1", handle, {
      ...streamEvent(11, "thread/read"), kind: "transcript_snapshot",
      payload: { threadStatus: { type: "systemError" }, latestTurn: { status: { status: "failed" } } },
    });
    assert.equal(harness.getManifest().observed_state, "failed");
    assert.equal(harness.stopCalls(), 1, "mixed transcript evidence preserves hard runtime failure precedence");
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

test("genuine runtime failures and failed MCP waits keep their existing classification", () => {
  assert.equal(providerStreamLifecycle({
    ...streamEvent(1, "item/completed"), kind: "item_lifecycle",
    payload: { item: { type: "commandExecution", status: "completed", exitCode: 0 } },
  }), "idle", "successful item completion preserves the existing presence signal");
  for (const failure of [
    { method: "thread/status/changed", kind: "provider_event", payload: { threadStatus: { type: "systemError" } } },
    { method: "result", kind: "error", payload: { is_error: true } },
    { method: "process/systemError", kind: "command_output", payload: { status: "systemError" } },
  ] as const) {
    assert.equal(providerStreamLifecycle({ ...streamEvent(1, failure.method), ...failure }), "failed", failure.method);
  }
  assert.equal(providerStreamLifecycle({
    ...streamEvent(1, "thread/read"), provider: "codex", kind: "provider_event",
    payload: { latestTurn: { status: "failed" } },
  }), "failed", "unsupported snapshot kinds fail closed instead of taking the turn-scoped carve-out");
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
  await harness.coordinator.install("agent-1", handle, "generation-2");
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

test("Open Model projection-only frames feed comparison evidence and no operational path", async () => {
  const observations: LifecycleProjectionObservation[] = [];
  const unavailable: string[] = [];
  const activity: string[] = [];
  let activityOnly = 0;
  let publications = 0;
  let deliveries = 0;
  let cutovers = 0;
  const openModelHandle: ProviderActionHandle = {
    ...handle,
    providerConnection: { kind: "opencode_server", url: "http://127.0.0.1:4311", pid: 42,
      processIdentity: "opencode:42", serverAuthPath: "/private/opencode-auth.json" },
  };
  const harness = coordinatorHarness({
    observeLegacyLifecycle: observation => observations.push(observation),
    markLifecycleProjectionUnavailable: provider => unavailable.push(provider),
    appendActivity: async method => { activity.push(method); },
    appendActivityOnly: async () => { activityOnly += 1; },
    publishNativeActivity: async () => { publications += 1; },
    startDelivery: async () => { deliveries += 1; },
    startCutover: async () => { cutovers += 1; },
  });
  harness.setManifest({ ...entry(), provider: "open-model", provider_ref: {
    ...entry().provider_ref!, provider_connection: { ...openModelHandle.providerConnection! },
  } });
  await harness.coordinator.install("agent-1", openModelHandle, "generation-2");
  const baseline = { activity: activity.length, activityOnly, publications, deliveries, cutovers,
    manifest: harness.getManifest(), stop: harness.stopCalls() };

  await harness.coordinator.enqueue("agent-1", openModelHandle, {
    ...streamEvent(1, "turn/completed"),
    provider: "open-model",
    kind: "turn_lifecycle",
    nativeEventId: "open-model-terminal",
    nativeLifecyclePhase: "turn_terminal",
    lifecycleProjectionOnly: true,
  });
  assert.deepEqual(observations, [{
    agentId: "agent-1", provider: "open-model", workAttemptId: "attempt-1",
    executionGenerationId: "generation-2", nativeEventId: "open-model-terminal",
    phase: "turn_terminal", state: "terminal",
  }]);
  assert.deepEqual({ activity: activity.length, activityOnly, publications, deliveries, cutovers,
    manifest: harness.getManifest(), stop: harness.stopCalls() }, baseline,
  "comparison evidence cannot mutate delivery, activity, manifest, or provider lifecycle");

  await harness.coordinator.enqueue("agent-1", openModelHandle, {
    ...streamEvent(2, "turn/completed"), provider: "open-model", kind: "turn_lifecycle",
    nativeEventId: "malformed", nativeLifecyclePhase: "turn_active", lifecycleProjectionOnly: true,
  });
  assert.deepEqual(unavailable, ["open-model"]);
  assert.equal(observations.length, 1);
  assert.deepEqual({ activity: activity.length, activityOnly, publications, deliveries, cutovers,
    manifest: harness.getManifest(), stop: harness.stopCalls() }, baseline,
  "malformed comparison evidence is unavailable-only");

  await harness.coordinator.enqueue("agent-1", { ...openModelHandle, pid: 99 }, {
    ...streamEvent(3, "not-a-lifecycle-frame"), provider: "open-model", lifecycleProjectionOnly: true,
  });
  assert.deepEqual(unavailable, ["open-model", "open-model"],
    "a stale malformed comparison frame still records unavailable evidence");
  assert.deepEqual({ activity: activity.length, activityOnly, publications, deliveries, cutovers,
    manifest: harness.getManifest(), stop: harness.stopCalls() }, baseline);

  await harness.coordinator.enqueue("agent-1", openModelHandle, {
    ...streamEvent(4, "item/agentMessage/delta"), provider: "open-model",
  });
  assert.deepEqual(activity, ["item/agentMessage/delta"],
    "ordinary Open Model stream frames retain the existing operational path");
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
  assert.deepEqual(observations, []);
  assert.equal(unavailable.at(-1), "codex",
    "a callback cannot borrow a successor manifest generation");
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
  const secondHandle = { ...handle, pid: 43, providerConnection: {
    ...handle.providerConnection!, pid: 43, processIdentity: "codex:43",
  } };
  harness.setManifest({ ...entry(), id: "agent-2", provider_ref: {
    ...entry().provider_ref!, provider_connection: secondHandle.providerConnection!,
  } });
  await harness.coordinator.install(
    "agent-2",
    secondHandle,
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
