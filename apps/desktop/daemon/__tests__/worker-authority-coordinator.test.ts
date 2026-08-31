import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { SupervisorGrantRequestError } from "../cloud-http.js";
import {
  WorkerAuthorityCoordinator,
  type BindWorkerSessionInput,
  type BootstrapOperation,
  type WorkerAuthorityCoordinatorOptions,
} from "../worker-authority-coordinator.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import type { DaemonManifestEntry, ExecutionGeneration, WorkAttemptCheckpoint } from "../types.js";
import type { SupervisedWorkerSession, WorkerSessionBinding } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type InstalledHostGrant } from "../worker-runtime-custody.js";
import type { PollingActivationRecord } from "../custodial-polling-activation.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");

function manifestEntry(overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent One",
    provider: "codex",
    model: null,
    charter: "Help",
    desired_state: "running",
    observed_state: "recovering",
    condition: "coordination_blocked",
    last_error: "old",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "test",
    created_at: "2026-08-26T00:00:00.000Z",
    work_attempt_id: "attempt-1",
    provider_ref: {
      work_attempt_id: "attempt-1",
      provider_continuation_id: "continuation-1",
      provider_connection: null,
      execution_generation_id: "execution-1",
    },
    ...overrides,
  };
}

function execution(terminal: ExecutionGeneration["terminal"] = null): ExecutionGeneration {
  return {
    execution_generation_id: "execution-1",
    work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z",
    actor: "test",
    generation: 7,
    terminal,
  };
}

function terminalExecution(): NonNullable<ExecutionGeneration["terminal"]> {
  return {
    ended_at: "2026-08-26T01:00:00.000Z",
    exit_code: 0,
    signal: null,
    stdio_archive_ref: null,
    stdio_tail: "",
    terminal_cause: "completed",
    actor: "test",
    generation: 7,
    provider_continuation_id: "continuation-1",
  };
}

function workerBinding(overrides: Partial<WorkerSessionBinding> = {}): WorkerSessionBinding {
  return {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    credential_ref: "bearer-id-1",
    api_url: "https://letagents.test",
    room_cursor: null,
    last_sequence: 0,
    last_observed_at_ms: 0,
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function providerHandle(overrides: Partial<ProviderActionHandle> = {}): ProviderActionHandle {
  return {
    workAttemptId: "attempt-1",
    pid: 42,
    providerContinuationId: "continuation-1",
    observedState: "working",
    ...overrides,
  };
}

function hostGrant(overrides: Partial<InstalledHostGrant> = {}): InstalledHostGrant {
  return {
    entryId: "agent-1",
    roomId: "room-1",
    agentKey: "agent-key-1",
    grantId: "grant-1",
    supervisorGrant: "supervisor-secret",
    grantGeneration: 1,
    apiUrl: "https://letagents.test",
    daemonGeneration: 7,
    hostId: "host-1",
    installationId: "installation-1",
    expiresAt: new Date(now + 2 * 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

type HarnessOptions = {
  activation?: PollingActivationRecord | null;
  getAgentConfiguration?: WorkerAuthorityCoordinatorOptions["store"]["getAgentConfiguration"];
  drainPhase?: "draining" | "dispatching" | "uncertain";
  entry?: DaemonManifestEntry;
  generation?: number;
  handoff?: boolean;
  binding?: WorkerSessionBinding | null;
  credential?: string | null;
  handle?: ProviderActionHandle | null;
  cursor?: string | null;
  checkpoints?: WorkAttemptCheckpoint[];
  createWorkerSession?: WorkerAuthorityCoordinatorOptions["supervisorGrantHttp"]["createWorkerSession"];
  renewHostGrant?: NonNullable<WorkerAuthorityCoordinatorOptions["supervisorGrantHttp"]["renewHostGrant"]>;
  latest?: NonNullable<WorkerAuthorityCoordinatorOptions["deliveryHttp"]["latest"]>;
  terminal?: ExecutionGeneration["terminal"];
  loseAuthorityAfterFirstAssert?: "handoff";
  fireMintTimeout?: boolean;
  boundedContextError?: Error;
  publishNative?: () => Promise<void>;
};

function fixture(options: HarnessOptions = {}) {
  const events: string[] = [];
  let entry = options.entry ?? manifestEntry();
  let generation = options.generation ?? 7;
  let handoff = options.handoff ?? false;
  let handle = options.handle === undefined ? providerHandle() : options.handle ?? undefined;
  let binding = options.binding === undefined ? workerBinding() : options.binding;
  let credential = options.credential === undefined ? "worker-secret" : options.credential;
  let session: SupervisedWorkerSession | null = binding ? {
    agent_id: binding.entry_id,
    room_id: binding.room_id,
    agent_session_id: binding.agent_session_id,
    execution_generation_id: binding.execution_generation_id,
    credential_ref: binding.credential_ref,
    expires_at: new Date(now + 5 * 60_000).toISOString(),
    updated_at: binding.updated_at,
  } : null;
  let cursor = options.cursor === undefined ? "12" : options.cursor;
  let checkpoints = options.checkpoints ?? [];
  let asserted = 0;
  let destroyed = 0;
  let deliveryStarts = 0;
  let deliveryStops = 0;
  let convergenceRequests = 0;
  const scheduled: number[] = [];
  const manifestUpdates: DaemonManifestEntry[] = [];
  const durableCheckpoints: Array<{ room_cursor: string | null; provider_continuation_id: string | null }> = [];
  const timerDelays: number[] = [];
  let clearedTimers = 0;
  const custody = new WorkerRuntimeCustody();
  const originalDestroy = custody.destroyAllCredentials.bind(custody);
  custody.destroyAllCredentials = () => {
    destroyed += 1;
    events.push("custody:destroy-all");
    originalDestroy();
  };

  const bindings: WorkerAuthorityCoordinatorOptions["bindings"] = {
    get: async () => binding,
    bind: async (input, bindOptions) => {
      events.push("binding:bind");
      credential = input.agent_session_token;
      binding = workerBinding({
        entry_id: input.entry_id,
        room_id: input.room_id,
        work_attempt_id: input.work_attempt_id,
        execution_generation_id: input.execution_generation_id,
        agent_session_id: input.agent_session_id,
        credential_ref: input.credential_ref ?? "generated-ref",
        api_url: new URL(input.api_url).origin,
        ...(bindOptions ? { room_cursor: bindOptions.roomCursor ?? null } : {}),
      });
      return binding;
    },
    credentialFor: async () => credential,
    unbind: async () => {
      events.push("binding:unbind");
      binding = null;
      credential = null;
      return true;
    },
    supervisedWorkerSession: async () => session,
    beginSupervisedWorkerSessionMint: async (input) => {
      events.push("mint:begin-durable");
      return {
        ...input,
        phase: "minting_unknown",
        agent_session_id: null,
        updated_at: new Date(now).toISOString(),
      };
    },
    recordExactSupervisedWorkerSessionMint: async (input) => {
      events.push("mint:record-exact");
      return {
        agent_id: input.agent_id,
        room_id: input.room_id,
        agent_instance_id: input.agent_instance_id,
        phase: "exact",
        agent_session_id: input.agent_session_id,
        updated_at: new Date(now).toISOString(),
      };
    },
    recordSupervisedWorkerSession: async (input) => {
      events.push("session:record-generation");
      session = { ...input, updated_at: new Date(now).toISOString() };
      return session;
    },
    installCredential: async (input) => {
      events.push("binding:install-secret");
      if (!binding || binding.agent_session_id !== input.agent_session_id
        || binding.execution_generation_id !== input.execution_generation_id) return false;
      credential = input.agent_session_token;
      return true;
    },
    checkpointCursorMonotonic: async (_entryId, _sessionId, _executionId, roomCursor) => {
      if (!binding) throw new Error("missing binding");
      const advanced = binding.room_cursor === null || Number(roomCursor) > Number(binding.room_cursor);
      if (advanced) binding = { ...binding, room_cursor: roomCursor };
      events.push(`binding:cursor:${advanced ? "advanced" : "retained"}`);
      return { binding, advanced };
    },
  };

  const subject = new WorkerAuthorityCoordinator({
    store: {
      getAgentConfiguration: options.getAgentConfiguration ?? (async () => ({ polling_contract: null, config_revision: 1, runtime_configuration_revision: 1 })),
      unresolvedDeliveryDrain: async () => options.drainPhase ? ({ phase: options.drainPhase } as never) : null,
      unresolvedPollingActivation: async () => options.activation ?? null,
      load: async () => ({ entries: [entry] }),
      getEntry: async (entryId) => entry.id === entryId ? entry : null,
    },
    durability: {
      getAttempt: async () => ({ execution_generations: [execution(options.terminal)], checkpoints }),
      checkpoint: async (_attemptId, checkpoint) => {
        events.push(`attempt:checkpoint:${checkpoint.room_cursor}`);
        durableCheckpoints.push(checkpoint);
        checkpoints = [...checkpoints, { at: new Date(now).toISOString(), ...checkpoint }];
      },
    },
    bindings,
    custody,
    inbox: {
      cursor: async () => cursor === null ? null : { last_observed_message_id: cursor },
      enqueueInitialMessage: async () => { events.push("inbox:initial"); },
      bootstrapCursor: async (input) => {
        events.push(`inbox:bootstrap:${input.last_observed_message_id}`);
        const created = cursor === null;
        if (created) cursor = input.last_observed_message_id;
        return { created, last_observed_message_id: cursor };
      },
    },
    supervisorGrantHttp: {
      createWorkerSession: options.createWorkerSession ?? (async () => {
        events.push("http:mint");
        return {
          sessionId: "session-minted",
          bearer: "minted-secret",
          bearerId: "bearer-id-minted",
          expiresAt: new Date(now + 5 * 60_000).toISOString(),
        };
      }),
      ...(options.renewHostGrant ? { renewHostGrant: options.renewHostGrant } : {}),
    },
    deliveryHttp: {
      latest: options.latest ?? (async () => ({ messages: [{ id: "20" }] })),
    },
    authority: {
      currentGeneration: () => generation,
      isHandoffScheduled: () => handoff,
      assertCurrent: async () => {
        asserted += 1;
        events.push("authority:assert");
        if (asserted === 1 && options.loseAuthorityAfterFirstAssert === "handoff") handoff = true;
      },
    },
    serializeEntry: async (_entryId, operation) => {
      events.push("serialize:entry");
      return operation();
    },
    serializeCursorCheckpoint: async (_entryId, operation) => {
      events.push("serialize:cursor");
      return operation();
    },
    manifest: {
      updateEntry: async (_entryId, update) => {
        events.push("manifest:update");
        entry = update(entry);
        manifestUpdates.push(entry);
        return entry;
      },
    },
    runtime: {
      currentHandle: () => handle,
      attach: async () => { events.push("runtime:attach"); return handle ?? null; },
    },
    delivery: {
      stop: async () => { deliveryStops += 1; events.push("delivery:stop"); },
      start: async () => { deliveryStarts += 1; events.push("delivery:start"); },
    },
    convergence: {
      request: () => { convergenceRequests += 1; events.push("convergence:request"); },
      schedule: (_entryId, delayMs) => { scheduled.push(delayMs); events.push(`convergence:schedule:${delayMs}`); },
      clear: () => { events.push("convergence:clear"); },
      heartbeatIntervalMs: 15_000,
    },
    recovery: {
      resetMintAttempts: () => { events.push("recovery:reset-mint"); },
    },
    activity: {
      publishNative: async () => { events.push("activity:publish"); await options.publishNative?.(); return true; },
      transition: async (_entryId, _state, _condition, detail) => { events.push(`transition:${detail}`); },
    },
    boundedContext: async () => {
      events.push("bounded:verify");
      if (options.boundedContextError) throw options.boundedContextError;
    },
    nowMs: () => now,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number) => {
      timerDelays.push(delay ?? 0);
      if (delay === 100 || (delay === 10_000 && options.fireMintTimeout)) queueMicrotask(callback);
      const timer = setTimeout(() => undefined, 60_000);
      timer.unref();
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
      clearedTimers += 1;
      clearTimeout(timer);
    }) as typeof clearTimeout,
  });

  return {
    subject,
    custody,
    events,
    get entry() { return entry; },
    get binding() { return binding; },
    get credential() { return credential; },
    get asserted() { return asserted; },
    get destroyed() { return destroyed; },
    get deliveryStarts() { return deliveryStarts; },
    get deliveryStops() { return deliveryStops; },
    get convergenceRequests() { return convergenceRequests; },
    scheduled,
    manifestUpdates,
    durableCheckpoints,
    timerDelays,
    get clearedTimers() { return clearedTimers; },
    setGeneration(value: number) { generation = value; },
    setHandoff(value: boolean) { handoff = value; },
    setCursor(value: string | null) { cursor = value; },
    setEntry(value: DaemonManifestEntry) { entry = value; },
    setHandle(value: ProviderActionHandle | undefined) { handle = value; },
    bindings,
  };
}

test("custodial effects and cursor writes require exact active activation while same-worker credentials recover", async () => {
  const connection = { kind: "codex_app_server" as const, url: "ws://127.0.0.1:42", pid: 42, processIdentity: "Mon Aug 31 08:00:00 2026" };
  const activation: PollingActivationRecord = {
    operation_id: "activation-1", request_id: "activate-1", reverse_operation_id: "reverse-1",
    agent_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "execution-1",
    native_continuation_id: "continuation-1", native_connection_kind: connection.kind, native_pid: 42,
    native_process_identity: connection.processIdentity, native_connection_sha256: createHash("sha256").update(JSON.stringify([
      connection.kind, connection.url, connection.pid, connection.processIdentity,
    ])).digest("hex"), config_revision: 1, agent_session_id: "session-1", room_cursor: "12", phase: "uncertain",
    provider_turn_id: null, terminal_outcome: null, created_at_ms: 1, updated_at_ms: 1, compacted_through_offer_id: null,
  };
  let configurationRevision = 1;
  let runtimeConfigurationRevision = 1;
  let mintedSessionId = "session-1";
  const handle = providerHandle({ providerConnection: connection, appliedConfigurationRevision: 1 });
  const options: HarnessOptions = {
    activation, handle, binding: workerBinding({ room_cursor: "12" }),
    entry: manifestEntry({ delivery_mode: "mcp_polling", provider_ref: {
      work_attempt_id: "attempt-1", execution_generation_id: "execution-1", provider_continuation_id: "continuation-1",
      provider_connection: connection, custodial_launch_agent_session_id: "session-1",
    } }),
    getAgentConfiguration: async () => ({ polling_contract: "custodial_polling_v1", config_revision: configurationRevision, runtime_configuration_revision: runtimeConfigurationRevision }),
    createWorkerSession: async () => ({ sessionId: mintedSessionId, bearer: "rotated-secret", bearerId: "rotated-id", expiresAt: new Date(now + 60_000).toISOString() }),
  };
  const harness = fixture(options);
  harness.custody.installHostGrant(hostGrant());
  const request = { entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "execution-1",
    agent_session_id: "session-1", daemon_generation: 7, api_url: "https://letagents.test", contract: "custodial_polling_v1", phase: "before", tool_name: "send_message" };
  const cursor = { entry_id: "agent-1", work_attempt_id: "attempt-1", execution_generation_id: "execution-1", agent_session_id: "session-1", room_cursor: "47" };
  for (const phase of [null, "prepared", "dispatching", "uncertain"] as const) {
    options.activation = phase ? { ...activation, phase } : null;
    await assert.rejects(harness.subject.authorizeCustodialPolling(request), /activation/);
    await assert.rejects(harness.subject.checkpointWorkerCursor(cursor), /activation/);
    assert.equal(harness.binding?.room_cursor, "12");
  }
  options.activation = activation;
  const minted = await harness.subject.mintHostWorkerSession(harness.entry, "execution-1", true);
  assert.ok(minted);
  await harness.subject.bindMintedHostWorkerSession("agent-1", minted);
  assert.equal(harness.binding?.agent_session_id, "session-1");
  assert.equal(harness.binding?.room_cursor, "12");
  assert.equal(harness.entry.condition, "coordination_blocked", "a credential refresh cannot resolve uncertain native dispatch");
  assert.equal(harness.entry.last_error, "old");
  assert.equal(harness.deliveryStarts, 0);
  assert.equal(harness.events.includes("activity:publish"), false);
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...request, provider_turn_id: "" }), { status: "available", credential: "rotated-secret" });
  await assert.rejects(harness.subject.authorizeCustodialPolling(request), /activation/);

  options.activation = { ...activation, phase: "active", provider_turn_id: "native-turn" };
  assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
  assert.equal((await harness.subject.authorizeCustodialPolling({ ...request, phase: "release", expected_configuration_revision: 1 })).status, "authorized");
  await harness.subject.checkpointWorkerCursor(cursor);
  assert.equal(harness.binding?.room_cursor, "47");
  for (const wrong of [
    { phase: "release", expected_configuration_revision: 2 }, { daemon_generation: 8 },
    { room_id: "other-room" }, { agent_session_id: "unowned-worker" }, { execution_generation_id: "other-generation" },
  ]) {
    assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
    await assert.rejects(harness.subject.authorizeCustodialPolling({ ...request, ...wrong }), /stale|not authorized/);
    assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
  }
  const currentSession = harness.bindings.supervisedWorkerSession;
  const validSession = await currentSession("agent-1");
  assert.ok(validSession);
  const grant = harness.subject.currentHostGrant(harness.entry)!;
  const freshExpiry = grant.expiresAt;
  for (const expired of ["worker", "host"] as const) {
    assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
    if (expired === "worker") harness.bindings.supervisedWorkerSession = async () => ({ ...validSession, expires_at: new Date(now - 1).toISOString() });
    else grant.expiresAt = new Date(now - 1).toISOString();
    await assert.rejects(harness.subject.authorizeCustodialPolling(request), /authority changed|not authorized/);
    assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...request, provider_turn_id: "" }), { status: "stale" });
    await assert.rejects(harness.subject.checkpointWorkerCursor({ ...cursor, room_cursor: "48" }), /authority is unavailable/);
    assert.equal(harness.binding?.room_cursor, "47");
    harness.bindings.supervisedWorkerSession = currentSession; grant.expiresAt = freshExpiry;
    assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
    assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...request, provider_turn_id: "" }), { status: "available", credential: "rotated-secret" });
  }
  for (const change of ["configuration", "runtime_revision", "native_revision", "native_birth", "worker", "execution", "launch_receipt"] as const) {
    assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
    const entry = harness.entry;
    if (change === "configuration") configurationRevision = 2;
    if (change === "runtime_revision") runtimeConfigurationRevision = 2;
    if (change === "native_revision") harness.setHandle({ ...handle, appliedConfigurationRevision: 2 });
    if (change === "native_birth") harness.setHandle({ ...handle, providerConnection: { ...connection, processIdentity: "Mon Aug 31 09:00:00 2026" } });
    if (change === "worker") options.activation = { ...options.activation!, agent_session_id: "another-worker" };
    if (change === "execution") options.activation = { ...options.activation!, execution_generation_id: "another-generation" };
    if (change === "launch_receipt") harness.setEntry({ ...entry, provider_ref: { ...entry.provider_ref!, custodial_launch_agent_session_id: "another-worker" } });
    await assert.rejects(harness.subject.authorizeCustodialPolling(request), /activation|worker binding/);
    await assert.rejects(harness.subject.checkpointWorkerCursor({ ...cursor, room_cursor: "48" }), /activation/);
    assert.equal(harness.binding?.room_cursor, "47");
    configurationRevision = 1; runtimeConfigurationRevision = 1; harness.setHandle(handle); harness.setEntry(entry);
    options.activation = { ...activation, phase: "active", provider_turn_id: "native-turn" };
    assert.equal((await harness.subject.authorizeCustodialPolling(request)).status, "authorized");
  }
  mintedSessionId = "new-worker-same-process";
  await assert.rejects(harness.subject.mintHostWorkerSession(harness.entry, "execution-1", true), /activation/);
  assert.equal(harness.binding?.agent_session_id, "session-1", "a new session cannot replace the worker embedded in the live native MCP environment");
});

test("dispatching and uncertain handoff deny worker mutation before effects", async () => {
  for (const drainPhase of ["dispatching", "uncertain"] as const) {
    const harness = fixture({ drainPhase });
    harness.custody.installHostGrant(hostGrant());
    await assert.rejects(harness.subject.mintHostWorkerAuthorization(harness.entry), /frozen/);
    await assert.rejects(harness.subject.checkpointWorkerCursor({ entry_id: "agent-1", work_attempt_id: "attempt-1", execution_generation_id: "execution-1", agent_session_id: "session-1", room_cursor: "47" }), /frozen/);
    assert.equal(harness.deliveryStarts, 0);
    assert.deepEqual(harness.durableCheckpoints, []);
    assert.equal(harness.events.some((event) => event.startsWith("mint:") || event.startsWith("binding:cursor:")), false);
    const grant = hostGrant();
    assert.deepEqual(await harness.subject.installHostGrant({
      entry_id: grant.entryId, room_id: grant.roomId, agent_key: grant.agentKey,
      grant_id: grant.grantId, supervisor_grant: grant.supervisorGrant, grant_generation: grant.grantGeneration,
      api_url: grant.apiUrl, daemon_generation: grant.daemonGeneration, host_id: grant.hostId,
      installation_id: grant.installationId, grant_expires_at: grant.expiresAt, credential_only: true,
    }), { status: "installed" });
    assert.equal(harness.convergenceRequests, 0);
    assert.equal(harness.deliveryStarts, 0);
  }
});

test("daemon ownership destroys all process credentials when handoff fences authority", async () => {
  const harness = fixture({ handoff: true });
  harness.custody.installHostGrant(hostGrant());
  harness.custody.installWorkerAuthorization({
    entryId: "agent-1", roomId: "room-1", agentKey: "agent-key-1", workAttemptId: "attempt-1",
    grantId: "grant-1", grantGeneration: 1, daemonGeneration: 7, apiUrl: "https://letagents.test",
    agentSessionId: "session-1", bearer: "secret", bearerId: "bearer-id-1", expiresAt: null, mintedAtMs: now,
  });

  assert.equal(await harness.subject.ownsDaemonGeneration(7), false);
  assert.equal(harness.destroyed, 1);
  assert.equal(harness.custody.hostGrant("agent-1"), undefined);
  assert.equal(harness.custody.workerAuthorization("agent-1"), undefined);
  assert.deepEqual(harness.events, ["custody:destroy-all"]);
});

test("handoff scheduled immediately after singleton assertion destroys every credential", async () => {
  const harness = fixture({ loseAuthorityAfterFirstAssert: "handoff" });
  harness.custody.installHostGrant(hostGrant());
  harness.custody.installWorkerAuthorization({
    entryId: "agent-1", roomId: "room-1", agentKey: "agent-key-1", workAttemptId: "attempt-1",
    grantId: "grant-1", grantGeneration: 1, daemonGeneration: 7, apiUrl: "https://letagents.test",
    agentSessionId: "session-1", bearer: "secret", bearerId: "bearer-id-1", expiresAt: null, mintedAtMs: now,
  });

  assert.equal(await harness.subject.ownsDaemonGeneration(7), false);
  assert.equal(harness.destroyed, 1);
  assert.equal(harness.custody.hostGrant("agent-1"), undefined);
  assert.equal(harness.custody.workerAuthorization("agent-1"), undefined);
});

test("worker mint durably marks uncertainty before HTTP and exact public identity before caching", async () => {
  const harness = fixture();
  harness.custody.installHostGrant(hostGrant());

  const minted = await harness.subject.mintHostWorkerAuthorization(harness.entry);

  assert.equal(minted?.bearer, "minted-secret");
  assert.deepEqual(harness.events.slice(0, 6), [
    "authority:assert",
    "mint:begin-durable",
    "http:mint",
    "mint:record-exact",
    "authority:assert",
  ]);
  assert.equal(harness.custody.workerAuthorization("agent-1")?.bearer, "minted-secret");
  assert.equal(harness.custody.workerAuthorization("agent-1")?.workAttemptId, "attempt-1");
  assert.deepEqual(harness.timerDelays, [10_000], "constructor captures the supplied direct timer function");
  assert.equal(harness.clearedTimers, 1, "the paired supplied clear function receives the mint timer");
});

test("cached worker authority is reused unless force-fresh explicitly remints", async () => {
  let calls = 0;
  const harness = fixture({
    createWorkerSession: async () => {
      calls += 1;
      return {
        sessionId: `session-${calls}`,
        bearer: `secret-${calls}`,
        bearerId: `bearer-id-${calls}`,
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      };
    },
  });
  harness.custody.installHostGrant(hostGrant());

  assert.equal((await harness.subject.mintHostWorkerAuthorization(harness.entry))?.bearer, "secret-1");
  assert.equal((await harness.subject.mintHostWorkerAuthorization(harness.entry))?.bearer, "secret-1");
  assert.equal(calls, 1);
  assert.equal((await harness.subject.mintHostWorkerAuthorization(harness.entry, undefined, true))?.bearer, "secret-2");
  assert.equal(calls, 2);
});

test("non-retryable mint rejection fails once while timeout failures remain bounded", async () => {
  let rejectionCalls = 0;
  const rejected = fixture({
    createWorkerSession: async () => {
      rejectionCalls += 1;
      throw new SupervisorGrantRequestError(403, "mint");
    },
  });
  rejected.custody.installHostGrant(hostGrant());
  await assert.rejects(
    rejected.subject.mintHostWorkerAuthorization(rejected.entry),
    /failed after 1 attempt.*HTTP 403/,
  );
  assert.equal(rejectionCalls, 1);

  let timeoutCalls = 0;
  const timedOut = fixture({
    fireMintTimeout: true,
    createWorkerSession: async () => {
      timeoutCalls += 1;
      return new Promise<never>(() => undefined);
    },
  });
  timedOut.custody.installHostGrant(hostGrant());
  await assert.rejects(
    timedOut.subject.mintHostWorkerAuthorization(timedOut.entry),
    /failed after 3 attempts.*timed out after 10000ms/,
  );
  assert.equal(timeoutCalls, 3);
  assert.equal(timedOut.timerDelays.filter((delay) => delay === 10_000).length, 3);
});

test("authority changing after the remote mint records public identity but never caches its bearer", async () => {
  let harness!: ReturnType<typeof fixture>;
  harness = fixture({
    createWorkerSession: async () => {
      harness.setGeneration(8);
      return {
        sessionId: "session-lost",
        bearer: "secret-lost",
        bearerId: "bearer-id-lost",
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      };
    },
  });
  harness.custody.installHostGrant(hostGrant());

  assert.equal(await harness.subject.mintHostWorkerAuthorization(harness.entry), null);
  assert.ok(harness.events.includes("mint:record-exact"));
  assert.equal(harness.custody.workerAuthorization("agent-1"), undefined);
  assert.equal(harness.custody.hostGrant("agent-1"), undefined);
});

test("retryable worker mint failures are bounded at three attempts", async () => {
  let calls = 0;
  const harness = fixture({
    createWorkerSession: async () => {
      calls += 1;
      throw new SupervisorGrantRequestError(503, "mint");
    },
  });
  harness.custody.installHostGrant(hostGrant());

  await assert.rejects(
    harness.subject.mintHostWorkerAuthorization(harness.entry),
    (error: unknown) => error instanceof Error
      && error.message.includes("failed after 3 attempts")
      && error.message.includes("HTTP 503"),
  );
  assert.equal(calls, 3);
  assert.equal(harness.events.filter((event) => event === "mint:begin-durable").length, 1);
});

test("definitive host-grant renewal rejection revokes secrets, delivery, binding, and liveness", async () => {
  const harness = fixture({
    renewHostGrant: async () => { throw new SupervisorGrantRequestError(403, "renew"); },
  });
  harness.custody.installHostGrant(hostGrant({ expiresAt: new Date(now + 30 * 60_000).toISOString() }));

  assert.equal(await harness.subject.ensureHostGrantFresh(harness.entry), null);
  assert.equal(harness.custody.hostGrant("agent-1"), undefined);
  assert.equal(harness.deliveryStops, 1);
  assert.equal(harness.binding, null);
  assert.equal(harness.entry.condition, "auth_blocked");
  assert.equal(harness.entry.workplace_liveness?.state, "stale");
  assert.match(harness.entry.last_error ?? "", /HTTP 403/);
});

test("expired and structurally invalid host grants are blocked without retaining child authority", async () => {
  let expiredRenewals = 0;
  const expired = fixture({
    renewHostGrant: async () => {
      expiredRenewals += 1;
      throw new Error("must not run");
    },
  });
  expired.custody.installHostGrant(hostGrant({ expiresAt: new Date(now - 1).toISOString() }));
  assert.equal(await expired.subject.ensureHostGrantFresh(expired.entry), null);
  assert.equal(expiredRenewals, 0);
  assert.equal(expired.entry.condition, "auth_blocked");

  const invalid = fixture({
    renewHostGrant: async () => ({
      grantId: "different-grant",
      supervisorGrant: "replacement-secret",
      grantGeneration: 1,
      expiresAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    }),
  });
  invalid.custody.installHostGrant(hostGrant({ expiresAt: new Date(now + 30 * 60_000).toISOString() }));
  assert.equal(await invalid.subject.ensureHostGrantFresh(invalid.entry), null);
  assert.equal(invalid.custody.hostGrant("agent-1"), undefined);
  assert.equal(invalid.entry.condition, "auth_blocked");
});

test("transient grant renewal failure retains valid authority and schedules convergence", async () => {
  const grant = hostGrant({ expiresAt: new Date(now + 30 * 60_000).toISOString() });
  const harness = fixture({
    renewHostGrant: async () => { throw new SupervisorGrantRequestError(503, "renew"); },
  });
  harness.custody.installHostGrant(grant);

  assert.equal(await harness.subject.ensureHostGrantFresh(harness.entry), grant);
  assert.equal(harness.custody.hostGrant("agent-1"), grant);
  assert.equal(harness.deliveryStops, 0);
  assert.deepEqual(harness.scheduled, [15_000]);
  assert.equal(harness.entry.condition, "coordination_blocked");
});

test("successful host-grant renewal replaces only the exact grant and rotates the live worker bearer", async () => {
  const oldGrant = hostGrant({ expiresAt: new Date(now + 30 * 60_000).toISOString() });
  const renewedExpiry = new Date(now + 2 * 60 * 60_000).toISOString();
  const harness = fixture({
    renewHostGrant: async () => ({
      grantId: oldGrant.grantId,
      supervisorGrant: "renewed-supervisor-secret",
      grantGeneration: oldGrant.grantGeneration,
      expiresAt: renewedExpiry,
    }),
  });
  harness.custody.installHostGrant(oldGrant);

  const renewed = await harness.subject.ensureHostGrantFresh(harness.entry);

  assert.equal(renewed?.supervisorGrant, "renewed-supervisor-secret");
  assert.equal(renewed?.expiresAt, renewedExpiry);
  assert.equal(harness.custody.hostGrant("agent-1"), renewed);
  assert.equal(harness.binding?.agent_session_id, "session-minted");
  assert.equal(harness.credential, "minted-secret");
  assert.ok(harness.events.indexOf("session:record-generation") < harness.events.indexOf("binding:bind"));
  assert.equal(harness.deliveryStops, 0);
});

test("binding publishes before clearing recovery and commits exact public metadata without exposing the bearer", async () => {
  const harness = fixture({ binding: null, credential: null });
  const input: BindWorkerSessionInput = {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-new",
    agent_session_token: "raw-secret",
    credential_ref: "opaque-id",
    api_url: "https://letagents.test/path",
  };

  assert.deepEqual(await harness.subject.bindWorkerSession(input), {
    bound: true,
    entry_id: "agent-1",
    agent_session_id: "session-new",
  });
  assert.ok(harness.events.indexOf("activity:publish") < harness.events.indexOf("manifest:update"));
  assert.equal(harness.entry.condition, "none");
  assert.equal(harness.entry.observed_state, "working");
  assert.equal(harness.entry.last_worker_binding?.agent_session_id, "session-new");
  assert.equal(JSON.stringify(harness.entry).includes("raw-secret"), false);
  assert.equal(harness.deliveryStarts, 1);
});

test("binding adopts a provided credential reference even when the worker bearer is unchanged", async () => {
  const harness = fixture();
  const input: BindWorkerSessionInput = {
    entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "execution-1",
    agent_session_id: "session-1", agent_session_token: "worker-secret", credential_ref: "minted-ref",
    api_url: "https://letagents.test",
  };
  await harness.subject.bindWorkerSession(input);
  assert.equal(harness.binding?.credential_ref, "minted-ref");
  assert.equal(harness.credential, "worker-secret");
  assert.equal(harness.events.filter((event) => event === "binding:bind").length, 1);
  await harness.subject.bindWorkerSession(input);
  await harness.subject.bindWorkerSession({ ...input, credential_ref: undefined });
  assert.equal(harness.events.filter((event) => event === "binding:bind").length, 1,
    "same-reference and legacy unspecified-reference confirmations remain idempotent");
});

test("a minted worker stays fenced to its original room, attempt, daemon, and installed grant object", async () => {
  for (const mismatch of ["room", "attempt", "daemon", "grant"] as const) {
    const harness = fixture();
    const grant = hostGrant();
    harness.custody.installHostGrant(grant);
    const minted = await harness.subject.mintHostWorkerAuthorization(harness.entry);
    assert.ok(minted);
    const bound = await harness.subject.recordMintedHostWorkerSession(harness.entry, "execution-1", minted);
    assert.ok(bound);
    if (mismatch === "room") harness.setEntry({ ...harness.entry, room_id: "other-room" });
    if (mismatch === "attempt") harness.setEntry({ ...harness.entry, work_attempt_id: "other-attempt" });
    if (mismatch === "daemon") harness.setGeneration(8);
    if (mismatch === "grant") harness.custody.installHostGrant({ ...grant });
    assert.equal(await harness.subject.recordMintedHostWorkerSession(harness.entry, "execution-1", minted), null, mismatch);
    await assert.rejects(harness.subject.bindMintedHostWorkerSession("agent-1", bound), /no longer matches/, mismatch);
    assert.equal(harness.events.includes("binding:bind"), false, mismatch);
    assert.equal(harness.deliveryStarts, 0, mismatch);
    assert.equal(harness.entry.condition, "coordination_blocked", mismatch);
  }
});

test("worker readiness fails closed when authority changes during the binding publication", async () => {
  for (const mismatch of ["room", "attempt", "generation", "continuation", "handle", "grant", "daemon", "worker"] as const) {
    let harness!: ReturnType<typeof fixture>;
    harness = fixture({ publishNative: async () => {
      if (mismatch === "room") harness.setEntry({ ...harness.entry, room_id: "other-room" });
      if (mismatch === "attempt") harness.setEntry({ ...harness.entry, work_attempt_id: "other-attempt" });
      if (mismatch === "generation") harness.setEntry({ ...harness.entry,
        provider_ref: { ...harness.entry.provider_ref!, execution_generation_id: "replacement" } });
      if (mismatch === "continuation") harness.setEntry({ ...harness.entry,
        provider_ref: { ...harness.entry.provider_ref!, provider_continuation_id: "replacement" } });
      if (mismatch === "handle") harness.setHandle(providerHandle());
      if (mismatch === "grant") harness.custody.installHostGrant(hostGrant());
      if (mismatch === "daemon") harness.setHandoff(true);
      if (mismatch === "worker") harness.bindings.get = async () => workerBinding({ agent_session_id: "other-worker" });
    } });
    await assert.rejects(harness.subject.bindWorkerSession({
      entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "execution-1",
      agent_session_id: "session-1", agent_session_token: "worker-secret", api_url: "https://letagents.test",
    }), /authority changed|binding changed/, mismatch);
    assert.equal(harness.entry.condition, "coordination_blocked", mismatch);
    assert.equal(harness.deliveryStarts, 0, mismatch);
    assert.equal(harness.manifestUpdates.length, 0, mismatch);
  }
});

test("bind and verify reject every mismatched durable or secret-bearing identity", async () => {
  const exact: BindWorkerSessionInput = {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    agent_session_token: "worker-secret",
    api_url: "https://letagents.test/path",
  };
  const bindCases: Array<[string, ReturnType<typeof fixture>, BindWorkerSessionInput]> = [
    ["room", fixture(), { ...exact, room_id: "other-room" }],
    ["work attempt", fixture(), { ...exact, work_attempt_id: "other-attempt" }],
    ["execution", fixture(), { ...exact, execution_generation_id: "other-execution" }],
    ["terminal", fixture({ terminal: terminalExecution() }), exact],
  ];
  for (const [name, harness, input] of bindCases) {
    await assert.rejects(harness.subject.bindWorkerSession(input), /does not match|absent or terminal/, name);
    assert.equal(harness.events.includes("binding:bind"), false, name);
  }

  const verified = fixture();
  assert.deepEqual(await verified.subject.verifyWorkerSession(exact), {
    verified: true,
    entry_id: "agent-1",
    agent_session_id: "session-1",
  });
  const verifyCases: Array<[string, ReturnType<typeof fixture>, BindWorkerSessionInput]> = [
    ["room", fixture(), { ...exact, room_id: "other-room" }],
    ["work attempt", fixture(), { ...exact, work_attempt_id: "other-attempt" }],
    ["execution", fixture(), { ...exact, execution_generation_id: "other-execution" }],
    ["secret", fixture(), { ...exact, agent_session_token: "wrong-secret" }],
    ["session", fixture(), { ...exact, agent_session_id: "wrong-session" }],
    ["API origin", fixture(), { ...exact, api_url: "https://other.test" }],
    ["binding room", fixture({ binding: workerBinding({ room_id: "other-room" }) }), exact],
    ["terminal", fixture({ terminal: terminalExecution() }), exact],
  ];
  for (const [name, harness, input] of verifyCases) {
    await assert.rejects(harness.subject.verifyWorkerSession(input), /does not match|absent or terminal/, name);
  }
});

test("worker credential installation is exact-generation-only and starts delivery only after vault acceptance", async () => {
  const exact = {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    agent_session_token: "rotated-secret",
    daemon_generation: 7,
  };
  const installed = fixture({ credential: null });
  assert.deepEqual(await installed.subject.installWorkerCredential(exact), { status: "installed" });
  assert.equal(installed.credential, "rotated-secret");
  assert.equal(installed.deliveryStarts, 1);

  for (const [name, harness, input] of [
    ["daemon generation", fixture(), { ...exact, daemon_generation: 8 }],
    ["room", fixture(), { ...exact, room_id: "other" }],
    ["work attempt", fixture(), { ...exact, work_attempt_id: "other" }],
    ["execution", fixture(), { ...exact, execution_generation_id: "other" }],
    ["session", fixture(), { ...exact, agent_session_id: "other" }],
    ["terminal", fixture({ terminal: terminalExecution() }), exact],
  ] as const) {
    assert.deepEqual(await harness.subject.installWorkerCredential(input), { status: "stale" }, name);
    assert.equal(harness.events.includes("binding:install-secret"), false, name);
    assert.equal(harness.deliveryStarts, 0, name);
  }
});

test("Open Model credentials accept only exact owned entries and safe endpoints", async () => {
  const exact = fixture({ entry: manifestEntry({ provider: "open-model" }) });
  assert.deepEqual(await exact.subject.installOpenModelCredential({
    entry_id: "agent-1",
    api_key: "model-secret",
    base_url: "https://models.test/v1/",
    model: " model-a ",
    daemon_generation: 7,
  }), { status: "installed" });
  assert.deepEqual(exact.custody.currentOpenModelCredential("agent-1", 7), {
    entryId: "agent-1",
    apiKey: "model-secret",
    baseUrl: "https://models.test/v1",
    model: "model-a",
    daemonGeneration: 7,
  });

  const wrongProvider = fixture();
  assert.deepEqual(await wrongProvider.subject.installOpenModelCredential({
    entry_id: "agent-1", api_key: null, base_url: "https://models.test", model: "m", daemon_generation: 7,
  }), { status: "stale" });
  await assert.rejects(exact.subject.installOpenModelCredential({
    entry_id: "agent-1", api_key: null, base_url: "https://user:pass@models.test", model: "m", daemon_generation: 7,
  }), /unsafe endpoint/);
});

test("credential borrowing is fenced by daemon, durable generation, binding route, API origin, and cursor turn", async () => {
  const harness = fixture({ entry: manifestEntry({ provider: "cursor" }) });
  const input = {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    daemon_generation: 7,
    api_url: "https://letagents.test/path",
    provider_turn_id: "turn-1",
  };

  assert.deepEqual(await harness.subject.borrowWorkerCredential(input), {
    status: "available",
    credential: "worker-secret",
  });
  assert.ok(harness.events.includes("bounded:verify"));
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...input, daemon_generation: 8 }), { status: "stale" });
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...input, api_url: "https://other.test" }), { status: "stale" });
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...input, room_id: "other" }), { status: "stale" });
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...input, work_attempt_id: "other" }), { status: "stale" });
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...input, execution_generation_id: "other" }), { status: "stale" });
  assert.deepEqual(await harness.subject.borrowWorkerCredential({ ...input, agent_session_id: "other" }), { status: "stale" });

  const terminal = fixture({ entry: manifestEntry({ provider: "cursor" }), terminal: terminalExecution() });
  assert.deepEqual(await terminal.subject.borrowWorkerCredential(input), { status: "stale" });
  const rejectedTurn = fixture({
    entry: manifestEntry({ provider: "cursor" }),
    boundedContextError: new Error("turn changed"),
  });
  assert.deepEqual(await rejectedTurn.subject.borrowWorkerCredential(input), { status: "stale" });
  const missingSecret = fixture({ entry: manifestEntry({ provider: "cursor" }), credential: null });
  assert.deepEqual(await missingSecret.subject.borrowWorkerCredential(input), { status: "deferred" });
});

test("cursor checkpoints retain monotonic binding authority and repair a missing attempt checkpoint", async () => {
  const prior = { at: "2026-08-26T00:00:00.000Z", room_cursor: "10", provider_continuation_id: "continuation-1" };
  const harness = fixture({
    binding: workerBinding({ room_cursor: "12" }),
    checkpoints: [prior],
  });

  const result = await harness.subject.checkpointWorkerCursor({
    entry_id: "agent-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    room_cursor: "11",
  });

  assert.equal(result.room_cursor, "12");
  assert.deepEqual(harness.durableCheckpoints, [{
    room_cursor: "12",
    provider_continuation_id: "continuation-1",
  }]);
  assert.deepEqual(harness.events.slice(0, 4), [
    "serialize:entry",
    "serialize:cursor",
    "binding:cursor:retained",
    "attempt:checkpoint:12",
  ]);
});

test("an advancing cursor commits binding authority before the work-attempt checkpoint", async () => {
  const harness = fixture({
    binding: workerBinding({ room_cursor: "10" }),
    checkpoints: [{
      at: "2026-08-26T00:00:00.000Z",
      room_cursor: "10",
      provider_continuation_id: "continuation-1",
    }],
  });
  const result = await harness.subject.checkpointWorkerCursor({
    entry_id: "agent-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    room_cursor: "13",
  });

  assert.equal(result.room_cursor, "13");
  assert.ok(harness.events.indexOf("binding:cursor:advanced") < harness.events.indexOf("attempt:checkpoint:13"));
  assert.deepEqual(harness.durableCheckpoints, [{
    room_cursor: "13",
    provider_continuation_id: "continuation-1",
  }]);
});

test("cursor checkpointing rejects work, execution, terminal, session, and room-binding mismatches before writes", async () => {
  const exact = {
    entry_id: "agent-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    room_cursor: "13",
  };
  const cases: Array<[string, ReturnType<typeof fixture>, typeof exact]> = [
    ["work attempt", fixture(), { ...exact, work_attempt_id: "other" }],
    ["execution", fixture(), { ...exact, execution_generation_id: "other" }],
    ["terminal", fixture({ terminal: terminalExecution() }), exact],
    ["session", fixture(), { ...exact, agent_session_id: "other" }],
    ["binding room", fixture({ binding: workerBinding({ room_id: "other" }) }), exact],
  ];
  for (const [name, harness, input] of cases) {
    await assert.rejects(harness.subject.checkpointWorkerCursor(input), /does not match|absent or terminal/, name);
    assert.equal(harness.events.some((event) => event.startsWith("binding:cursor")), false, name);
    assert.equal(harness.durableCheckpoints.length, 0, name);
  }
});

test("bootstrap commits the observed tail even after authority changes, then refuses convergence", async () => {
  let harness!: ReturnType<typeof fixture>;
  harness = fixture({
    cursor: null,
    latest: async () => {
      harness.events.push("http:latest");
      harness.setGeneration(8);
      return { messages: [{ id: "19" }, { id: "20" }] };
    },
  });
  harness.custody.installHostGrant(hostGrant());
  const operation: BootstrapOperation = {
    controller: new AbortController(),
    phase: "observing",
    operation: Promise.resolve(),
  };

  const result = await harness.subject.bootstrapRoomIngress({
    entry_id: "agent-1",
    daemon_generation: 7,
    initial_message: "hello",
  }, operation);

  assert.deepEqual(result, { status: "bootstrapped", last_observed_message_id: "20" });
  assert.equal(operation.phase, "committing");
  assert.ok(harness.events.indexOf("http:latest") < harness.events.indexOf("inbox:bootstrap:20"));
  assert.equal(harness.convergenceRequests, 0);
});

test("bootstrap is stale/idempotent before remote work and an aborted observation never creates a cursor", async () => {
  const stale = fixture({ generation: 8, cursor: null });
  stale.custody.installHostGrant(hostGrant());
  const staleOperation: BootstrapOperation = {
    controller: new AbortController(), phase: "observing", operation: Promise.resolve(),
  };
  assert.deepEqual(
    await stale.subject.bootstrapRoomIngress({ entry_id: "agent-1", daemon_generation: 7 }, staleOperation),
    { status: "stale", last_observed_message_id: null },
  );
  assert.equal(stale.events.includes("mint:begin-durable"), false);

  const existing = fixture({ cursor: "12" });
  existing.custody.installHostGrant(hostGrant());
  const existingOperation: BootstrapOperation = {
    controller: new AbortController(), phase: "observing", operation: Promise.resolve(),
  };
  assert.deepEqual(
    await existing.subject.bootstrapRoomIngress({ entry_id: "agent-1", daemon_generation: 7 }, existingOperation),
    { status: "existing", last_observed_message_id: "12" },
  );
  assert.equal(existing.events.includes("mint:begin-durable"), false);
  assert.equal(existing.convergenceRequests, 1);

  const aborted = fixture({ cursor: null });
  aborted.custody.installHostGrant(hostGrant());
  const controller = new AbortController();
  controller.abort();
  const abortedOperation: BootstrapOperation = {
    controller, phase: "observing", operation: Promise.resolve(),
  };
  await assert.rejects(
    aborted.subject.bootstrapRoomIngress({ entry_id: "agent-1", daemon_generation: 7 }, abortedOperation),
    /mint was cancelled/,
  );
  assert.equal(aborted.events.some((event) => event.startsWith("inbox:bootstrap")), false);
  assert.equal(aborted.convergenceRequests, 0);
});

test("credential-only host install never retains a new grant when no exact provider is available", async () => {
  const harness = fixture({ handle: null });

  const result = await harness.subject.installHostGrant({
    entry_id: "agent-1",
    room_id: "room-1",
    agent_key: "agent-key-1",
    grant_id: "grant-1",
    supervisor_grant: "secret",
    grant_generation: 1,
    api_url: "https://letagents.test/path",
    daemon_generation: 7,
    host_id: "host-1",
    installation_id: "installation-1",
    grant_expires_at: new Date(now + 60_000).toISOString(),
    credential_only: true,
  });

  assert.deepEqual(result, { status: "provider_unavailable" });
  assert.equal(harness.custody.hostGrant("agent-1"), undefined);
  assert.equal(harness.deliveryStarts, 0);
  assert.equal(harness.convergenceRequests, 0);
});

test("standard host install retains the current grant and converges only after durable inbox admission", async () => {
  const input = {
    entry_id: "agent-1",
    room_id: "room-1",
    agent_key: "agent-key-1",
    grant_id: "grant-standard",
    supervisor_grant: "standard-secret",
    grant_generation: 2,
    api_url: "https://letagents.test/path",
    daemon_generation: 7,
    host_id: "host-1",
    installation_id: "installation-1",
    grant_expires_at: new Date(now + 60_000).toISOString(),
  };
  const admitted = fixture({ handle: null });
  assert.deepEqual(await admitted.subject.installHostGrant(input), { status: "installed" });
  assert.equal(admitted.custody.hostGrant("agent-1")?.apiUrl, "https://letagents.test");
  assert.equal(admitted.convergenceRequests, 1);
  assert.equal(admitted.events.includes("mint:begin-durable"), false);

  const cursorless = fixture({ handle: null, cursor: null });
  assert.deepEqual(await cursorless.subject.installHostGrant(input), { status: "installed" });
  assert.equal(cursorless.custody.hostGrant("agent-1")?.grantId, "grant-standard");
  assert.equal(cursorless.convergenceRequests, 0);
});

test("recovery-only host installation restores owner authority without touching the retained provider", async () => {
  const harness = fixture();
  const result = await harness.subject.installHostGrant({
    entry_id: "agent-1",
    room_id: "room-1",
    agent_key: "agent-key-1",
    grant_id: "grant-recovery",
    supervisor_grant: "recovery-secret",
    grant_generation: 2,
    api_url: "https://letagents.test/path",
    daemon_generation: 7,
    host_id: "host-1",
    installation_id: "installation-1",
    grant_expires_at: new Date(now + 60_000).toISOString(),
    recovery_only: true,
  });

  assert.deepEqual(result, { status: "installed" });
  assert.equal(harness.custody.hostGrant("agent-1")?.grantId, "grant-recovery");
  assert.equal(harness.events.includes("runtime:attach"), false);
  assert.equal(harness.events.includes("mint:begin-durable"), false);
  assert.equal(harness.deliveryStarts, 0);
  assert.equal(harness.convergenceRequests, 0);
});

test("binding recovery retries only the exact live provider and stops after the third failure", async () => {
  const harness = fixture();

  await harness.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("token=secret failure"));
  await harness.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("again"));
  await harness.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("last"));

  assert.deepEqual(harness.scheduled, [1_000, 3_000]);
  const transitions = harness.events.filter((event) => event.startsWith("transition:"));
  assert.equal(transitions.length, 3);
  assert.match(transitions[2] ?? "", /after 3 attempts/);
  assert.equal(transitions[0]?.includes("secret"), false);
});

test("binding recovery ignores stopped or mismatched providers and a successful bind resets its counter", async () => {
  for (const [name, harness] of [
    ["stopped entry", fixture({ entry: manifestEntry({ desired_state: "stopped" }) })],
    ["execution mismatch", fixture({ handle: providerHandle({ workAttemptId: "other" }) })],
    ["continuation mismatch", fixture({ handle: providerHandle({ providerContinuationId: "other" }) })],
  ] as const) {
    await harness.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("failure"));
    assert.equal(harness.events.some((event) => event.startsWith("transition:")), false, name);
    assert.deepEqual(harness.scheduled, [], name);
  }

  const reset = fixture();
  await reset.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("first"));
  await reset.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("second"));
  await reset.subject.bindWorkerSession({
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    agent_session_token: "worker-secret",
    api_url: "https://letagents.test",
  });
  await reset.subject.recordWorkerBindingRecoveryFailure("agent-1", "execution-1", new Error("after bind"));
  assert.deepEqual(reset.scheduled, [1_000, 3_000, 1_000]);
  const lastTransition = reset.events.filter((event) => event.startsWith("transition:")).at(-1) ?? "";
  assert.match(lastTransition, /attempt 1 of 3/);
});
