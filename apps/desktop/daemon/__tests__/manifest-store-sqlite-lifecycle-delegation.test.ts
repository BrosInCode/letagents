import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { ManifestStore } from "../manifest-store.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import type { DaemonManifestEntry } from "../types.js";
import { executionRuntimeStorageIdentity, ExecutionShadowStore } from "../execution-shadow-store.js";
import { applyExecutionStorageSchema, validateExecutionStorageSchema } from "../execution-storage-schema.js";
import { TypedLifecycleEffectCoordinator } from "../typed-lifecycle-effect-coordinator.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import {
  restoreThreeProviderLifecycleProjectionFixture,
  restoreEmptyExecutionDelegationV23Fixture,
  localDelegationAuthority,
  localDelegationRevision,
  localDelegationInput,
  localDelegationValidation,
  seedLocalDelegationManifest,
  terminal,
  entry,
  fixture,
  seedTerminalExecution,
} from "./helpers/manifest-store-sqlite-fixture.js";

test("provider birth collisions cannot relabel frozen lifecycle authority", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const connection = {
    kind: "codex_app_server" as const,
    url: "http://127.0.0.1:4311",
    pid: 4311,
    processIdentity: "frozen-birth",
  };
  const agent: DaemonManifestEntry = {
    ...entry,
    condition: "none",
    delivery_mode: "daemon_inbox",
    turn_control: undefined,
    work_attempt_id: "attempt_1",
    provider_ref: {
      work_attempt_id: "attempt_1",
      execution_generation_id: "run_1",
      provider_continuation_id: "thread_1",
      provider_connection: connection,
    },
  };
  try {
    const written = await store.write(0, [agent]);
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    const first = await store.checkpointProviderBirth(written.generation, {
      entry: agent,
      executionGenerationId: "run_1",
      providerConnection: connection,
      appliedRevision: 1,
      requestedAuthorityMode: "typed_shadow",
      observedAtMs: 100,
    });
    const before = await store.load();
    await assert.rejects(store.checkpointProviderBirth(first.generation, {
      entry: first.entry,
      executionGenerationId: "run_1",
      providerConnection: connection,
      appliedRevision: 1,
      requestedAuthorityMode: "typed",
      observedAtMs: 200,
    }), /incompatible frozen lifecycle authority/);
    const after = await store.load();
    assert.equal(after.generation, before.generation, "rejected relabeling commits no manifest generation");
    assert.deepEqual(after.entries, before.entries, "rejected relabeling rolls back projection rewrites");
    assert.equal(await store.readRuntimeLifecycleAuthority({
      agentId: agent.id,
      executionGenerationId: "run_1",
      providerConnection: connection,
      configurationRevision: 1,
    }), "typed_shadow");
  } finally {
    await env.cleanup();
  }
});

test("typed runtime readiness makes a fresh exact birth idle and stamps readiness", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "ready-birth" };
  const { ready_reached_at: _priorReady, ...entryWithoutReadiness } = entry;
  const agent: DaemonManifestEntry = {
    ...entryWithoutReadiness, id: "ready-agent", room_id: "room", condition: "none", delivery_mode: "daemon_inbox",
    config_revision: 2, runtime_configuration_revision: 2, turn_control: undefined,
    work_attempt_id: "ready-workspace", observed_state: "starting",
    provider_ref: { work_attempt_id: "ready-workspace", execution_generation_id: "ready-generation",
      provider_continuation_id: "ready-continuation", provider_connection: connection },
  };
  await store.write(0, [agent]);
  seedTerminalExecution(env.databasePath, "ready-workspace", "ready-generation");
  const database = new DatabaseSync(env.databasePath);
  try {
    database.exec(`PRAGMA foreign_keys=ON;
      UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='ready-generation';
      UPDATE agent_configurations SET config_revision=2,runtime_configuration_revision=2 WHERE agent_id='ready-agent'`);
    const shadow = new ExecutionShadowStore(database);
    const runtimeGenerationId = executionRuntimeStorageIdentity("ready-agent", "ready-generation",
      connection.kind, connection.pid, connection.processIdentity);
    shadow.registerRuntime({ agentId: "ready-agent", executionGenerationId: "ready-generation", runtimeGenerationId,
      provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: 100 });
    const observer = shadow.bindObserver({ agentId: "ready-agent", subjectRuntimeGenerationId: runtimeGenerationId,
      observerRuntimeGenerationId: runtimeGenerationId, sourceId: "ready-source", daemonGenerationId: "1",
      expectedEpoch: 0, boundAtMs: 100 });
    shadow.ingest("ready-source", observer, { factId: "runtime-ready", agentId: "ready-agent",
      executionGenerationId: "ready-generation", runtimeGenerationId, observerEpoch: 1, sourceSequence: 1,
      observedAtMs: 101, domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" });
    const [pending] = await store.listPendingTypedLifecycleEffects("ready-agent");
    assert.equal(pending?.effectKind, "manifest_idle");
    const applied = await store.applyTypedLifecycleEffect(1, pending!, {
      agentId: "ready-agent", executionGenerationId: "ready-generation", workAttemptId: "ready-workspace",
      providerContinuationId: "ready-continuation", providerConnection: connection,
      configurationRevision: 2, authorityMode: "typed", disposedAtMs: 200,
    }, commit => commit());
    assert.equal(applied.disposition, "applied");
    assert.equal(applied.entry?.observed_state, "idle");
    assert.equal(applied.entry?.ready_reached_at, new Date(101).toISOString());
    assert.deepEqual(applied.entry?.native_liveness, {
      state: "idle", observed_at: new Date(101).toISOString(), detail: "Provider runtime ready",
    });
  } finally {
    database.close(); await store.close(); await env.cleanup();
  }
});

test("typed lifecycle effects apply once and restart supersedes work after structural terminal evidence", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "typed-birth" };
  const agent: DaemonManifestEntry = {
    ...entry, id: "agent", room_id: "room", condition: "none", delivery_mode: "daemon_inbox",
    config_revision: 2, runtime_configuration_revision: 2, turn_control: undefined,
    work_attempt_id: "workspace", observed_state: "idle",
    provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
      provider_continuation_id: "continuation", provider_connection: connection },
  };
  await store.write(0, [agent]);
  seedTerminalExecution(env.databasePath, "workspace", "generation");
  const database = new DatabaseSync(env.databasePath);
  database.exec(`PRAGMA foreign_keys=ON;
    UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='generation';
    UPDATE agent_configurations SET config_revision=2,runtime_configuration_revision=2 WHERE agent_id='agent'`);
  const shadow = new ExecutionShadowStore(database);
  const runtimeGenerationId = executionRuntimeStorageIdentity("agent", "generation", connection.kind, connection.pid, connection.processIdentity);
  shadow.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId,
    provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: 100 });
  const attemptId = shadow.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "message",
    executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
  shadow.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation",
    runtimeGenerationId, attemptId, turnId: "turn", providerContinuationId: "continuation",
    providerTurnId: "native-turn", createdAtMs: 100 });
  const observer = shadow.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: runtimeGenerationId,
    observerRuntimeGenerationId: runtimeGenerationId, sourceId: "source", daemonGenerationId: "1",
    expectedEpoch: 0, boundAtMs: 100 });
  shadow.ingest("source", observer, { factId: "active", agentId: "agent", executionGenerationId: "generation",
    runtimeGenerationId, observerEpoch: 1, sourceSequence: 1, observedAtMs: 101,
    turnId: "turn", providerContinuationId: "continuation", providerTurnId: "native-turn",
    domain: "turn", kind: "state_changed", state: "active", sideEffects: "none" });

  const handle: ProviderActionHandle = { workAttemptId: "workspace", pid: connection.pid,
    providerContinuationId: "continuation", providerConnection: connection, observedState: "idle", appliedConfigurationRevision: 2 };
  const token = Object.freeze({ nonce: Symbol("installation"), listenerLeaseNonce: Symbol("lease"), entryId: "agent", handle,
    executionGenerationId: "generation", workAttemptId: "workspace", providerContinuationId: "continuation",
    providerConnection: connection, configurationRevision: 2, authorityMode: "typed" as const }) satisfies ProviderInstallationToken;
  const persistedBirth = await store.getEntry("agent");
  assert.equal(database.prepare("SELECT runtime_configuration_revision FROM agent_configurations WHERE agent_id='agent'").get()?.runtime_configuration_revision,
    token.configurationRevision);
  assert.equal(persistedBirth?.work_attempt_id, token.workAttemptId);
  assert.equal(persistedBirth?.provider_ref?.work_attempt_id, token.workAttemptId);
  assert.equal(persistedBirth?.provider_ref?.execution_generation_id, token.executionGenerationId);
  assert.equal(persistedBirth?.provider_ref?.provider_continuation_id, token.providerContinuationId);
  assert.deepEqual(persistedBirth?.provider_ref?.provider_connection, token.providerConnection);
  const [pendingActive] = await store.listPendingTypedLifecycleEffects("agent");
  assert.ok(pendingActive);
  database.exec(`CREATE TRIGGER reject_lifecycle_ack BEFORE UPDATE ON execution_lifecycle_effects
    BEGIN SELECT RAISE(ABORT,'injected lifecycle acknowledgement failure'); END`);
  await assert.rejects(() => store.applyTypedLifecycleEffect(1, pendingActive, {
    agentId: "agent", executionGenerationId: "generation", workAttemptId: "workspace",
    providerContinuationId: "continuation", providerConnection: connection,
    configurationRevision: 2, authorityMode: "typed", disposedAtMs: 200,
  }, commit => commit()), /injected lifecycle acknowledgement failure/);
  database.exec("DROP TRIGGER reject_lifecycle_ack");
  assert.equal(database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get()?.generation, 1);
  assert.equal(database.prepare("SELECT observed_state FROM runtime_deployments WHERE agent_id='agent'").get()?.observed_state, "idle");
  assert.equal(database.prepare("SELECT state FROM execution_lifecycle_effects WHERE fact_id='active'").get()?.state, "pending",
    "manifest projection and disposition acknowledgement roll back together");
  let manifestGeneration = 1;
  const admissionChanges: Array<{ agentId: string; observedState: string | null }> = [];
  const coordinator = (currentInstallation: () => ProviderInstallationToken | undefined) => new TypedLifecycleEffectCoordinator({
    store, currentInstallation, isClosing: () => false, nowMs: () => 200, diagnostic: (_agentId, error) => { throw error; },
    changed: (agentId, observedState) => { admissionChanges.push({ agentId, observedState }); },
    authority: { serialize: operation => operation(), assertCurrent: async () => {},
      currentManifestGeneration: () => manifestGeneration,
      acceptManifestGeneration: generation => { manifestGeneration = generation; }, fenceCommit: commit => commit() },
  });
  let installed: ProviderInstallationToken | undefined;
  const first = coordinator(() => installed);
  try {
    first.start();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(database.prepare("SELECT state FROM execution_lifecycle_effects WHERE fact_id='active'").get()?.state, "pending",
      "a restart without the exact recovered installation preserves the retryable disposition");
    installed = token;
    first.changed("agent");
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(database.prepare("SELECT state FROM execution_lifecycle_effects WHERE fact_id='active'").get()?.state, "applied");
    assert.equal((await store.getEntry("agent"))?.observed_state, "working");
    assert.equal(manifestGeneration, 2);
    assert.deepEqual(admissionChanges, [{ agentId: "agent", observedState: "working" }],
      "a durable lifecycle disposition emits one state-change admission hint");

    shadow.ingest("source", observer, { factId: "terminal", agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId, observerEpoch: 1, sourceSequence: 2, observedAtMs: 102,
      turnId: "turn", providerContinuationId: "continuation", providerTurnId: "native-turn",
      domain: "turn", kind: "state_changed", state: "terminal", turnOutcome: "completed", sideEffects: "none" });
    database.prepare("UPDATE work_attempt_executions SET terminal_json='{}' WHERE execution_generation_id='generation'").run();
  } finally { await first.close(); }

  const restarted = coordinator(() => undefined);
  try {
    restarted.start();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(database.prepare("SELECT state FROM execution_lifecycle_effects WHERE fact_id='terminal'").get()?.state, "superseded");
    assert.equal((await store.getEntry("agent"))?.observed_state, "working",
      "typed drain loses to already-durable structural terminal authority");
    assert.equal(manifestGeneration, 2, "superseding an effect does not mutate the manifest generation");
    assert.deepEqual(admissionChanges, [
      { agentId: "agent", observedState: "working" },
      { agentId: "agent", observedState: null },
    ],
      "superseding the terminal effect also wakes exact readiness without granting authority itself");
  } finally {
    await restarted.close(); database.close(); await store.close(); await env.cleanup();
  }
});

test("typed hard-runtime failure applies from durable birth evidence after its live installation is gone", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "failed-birth" };
  const agent: DaemonManifestEntry = {
    ...entry, id: "failed-agent", room_id: "room", condition: "none", delivery_mode: "daemon_inbox",
    config_revision: 2, runtime_configuration_revision: 2, turn_control: undefined,
    work_attempt_id: "failed-workspace", observed_state: "working",
    provider_ref: { work_attempt_id: "failed-workspace", execution_generation_id: "failed-generation",
      provider_continuation_id: "failed-continuation", provider_connection: connection },
  };
  await store.write(0, [agent]);
  seedTerminalExecution(env.databasePath, "failed-workspace", "failed-generation");
  const database = new DatabaseSync(env.databasePath);
  try {
    database.exec(`PRAGMA foreign_keys=ON;
      UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='failed-generation';
      UPDATE agent_configurations SET config_revision=2,runtime_configuration_revision=2 WHERE agent_id='failed-agent'`);
    const shadow = new ExecutionShadowStore(database);
    const runtimeGenerationId = executionRuntimeStorageIdentity("failed-agent", "failed-generation",
      connection.kind, connection.pid, connection.processIdentity);
    shadow.registerRuntime({ agentId: "failed-agent", executionGenerationId: "failed-generation", runtimeGenerationId,
      provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: 100 });
    const observer = shadow.bindObserver({ agentId: "failed-agent", subjectRuntimeGenerationId: runtimeGenerationId,
      observerRuntimeGenerationId: runtimeGenerationId, sourceId: "failed-source", daemonGenerationId: "1",
      expectedEpoch: 0, boundAtMs: 100 });
    shadow.ingest("failed-source", observer, { factId: "runtime-exited", agentId: "failed-agent",
      executionGenerationId: "failed-generation", runtimeGenerationId, observerEpoch: 1, sourceSequence: 1,
      observedAtMs: 101, domain: "runtime", kind: "state_changed", state: "exited",
      controlEvidence: "process_exit", sideEffects: "none" });
    const [pending] = await store.listPendingTypedLifecycleEffects("failed-agent");
    assert.equal(pending?.effectKind, "manifest_failed");
    const applied = await store.applyTypedLifecycleEffect((await store.load()).generation, pending!, null, commit => commit());
    assert.equal(applied.disposition, "applied");
    assert.equal(applied.entry?.observed_state, "failed");
    assert.deepEqual(applied.entry?.native_liveness, {
      state: "terminal", observed_at: new Date(101).toISOString(), detail: "Provider runtime unavailable",
    });
    assert.equal(database.prepare("SELECT state FROM execution_lifecycle_effects WHERE fact_id='runtime-exited'").get()?.state, "applied");
  } finally {
    database.close(); await store.close(); await env.cleanup();
  }
});

test("a validated Cursor terminal settles only its durable exited child birth", async () => {
  const cases: Array<{
    name: string;
    mutate: (agent: DaemonManifestEntry) => DaemonManifestEntry;
    expectedDisposition: "applied" | "superseded";
    expectedState: DaemonManifestEntry["observed_state"];
  }> = [
    { name: "exact exited birth", mutate: agent => agent, expectedDisposition: "applied", expectedState: "idle" },
    { name: "successor child birth", mutate: agent => ({ ...agent, provider_ref: {
      ...agent.provider_ref!, provider_connection: {
        ...agent.provider_ref!.provider_connection, pid: 5311, processIdentity: "successor-birth",
      },
    } }), expectedDisposition: "superseded", expectedState: "working" },
    { name: "stopped agent", mutate: agent => ({ ...agent, desired_state: "stopped", observed_state: "stopped" }),
      expectedDisposition: "superseded", expectedState: "stopped" },
  ];
  for (const scenario of cases) {
    const env = await fixture(); const store = new ManifestStore(env.databasePath);
    const connection = { kind: "cursor_cli" as const, pid: 4311, processIdentity: "cursor-child-birth" };
    const agent: DaemonManifestEntry = {
      ...entry, id: "cursor-agent", room_id: "room", condition: "none", delivery_mode: "daemon_inbox",
      config_revision: 2, runtime_configuration_revision: 2, turn_control: undefined,
      work_attempt_id: "cursor-workspace", observed_state: "working",
      provider_ref: { work_attempt_id: "cursor-workspace", execution_generation_id: "cursor-generation",
        provider_continuation_id: "cursor-continuation", provider_connection: connection },
    };
    await store.write(0, [agent]);
    seedTerminalExecution(env.databasePath, "cursor-workspace", "cursor-generation");
    const database = new DatabaseSync(env.databasePath);
    try {
      database.exec(`PRAGMA foreign_keys=ON;
        UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='cursor-generation';
        UPDATE agent_configurations SET config_revision=2,runtime_configuration_revision=2 WHERE agent_id='cursor-agent'`);
      const shadow = new ExecutionShadowStore(database);
      const runtimeGenerationId = executionRuntimeStorageIdentity("cursor-agent", "cursor-generation",
        connection.kind, connection.pid, connection.processIdentity);
      shadow.registerRuntime({ agentId: "cursor-agent", executionGenerationId: "cursor-generation", runtimeGenerationId,
        provider: "cursor", authorityMode: "typed", configRevision: 2, createdAtMs: 100 });
      const attemptId = shadow.trackMessage({ agentId: "cursor-agent", roomId: "room", sourceMessageId: "message",
        executionGenerationId: "cursor-generation", workspaceId: "cursor-workspace", createdAtMs: 100 });
      shadow.trackNativeTurn({ agentId: "cursor-agent", roomId: "room", executionGenerationId: "cursor-generation",
        runtimeGenerationId, attemptId, turnId: "cursor-turn", providerContinuationId: "cursor-continuation",
        providerTurnId: "cursor-native-turn", createdAtMs: 100 });
      const observer = shadow.bindObserver({ agentId: "cursor-agent", subjectRuntimeGenerationId: runtimeGenerationId,
        observerRuntimeGenerationId: runtimeGenerationId, sourceId: "cursor-source", daemonGenerationId: "1",
        expectedEpoch: 0, boundAtMs: 100 });
      const base = { agentId: "cursor-agent", executionGenerationId: "cursor-generation", runtimeGenerationId,
        observerEpoch: 1, turnId: "cursor-turn", providerContinuationId: "cursor-continuation",
        providerTurnId: "cursor-native-turn", domain: "turn" as const, kind: "state_changed" as const,
        sideEffects: "none" as const };
      shadow.ingest("cursor-source", observer, { ...base, factId: "cursor-active", sourceSequence: 1,
        observedAtMs: 101, state: "active" });
      const [active] = await store.listPendingTypedLifecycleEffects("cursor-agent");
      assert.equal(active?.effectKind, "manifest_working", scenario.name);
      const installation = { agentId: "cursor-agent", executionGenerationId: "cursor-generation",
        workAttemptId: "cursor-workspace", providerContinuationId: "cursor-continuation", providerConnection: connection,
        configurationRevision: 2, authorityMode: "typed" as const, disposedAtMs: 102 };
      const working = await store.applyTypedLifecycleEffect((await store.load()).generation, active!, installation, commit => commit());
      assert.equal(working.disposition, "applied", scenario.name);

      shadow.ingest("cursor-source", observer, { ...base, factId: "cursor-terminal", sourceSequence: 2,
        observedAtMs: 103, state: "terminal", turnOutcome: "completed" });
      shadow.ingest("cursor-source", observer, { factId: "cursor-runtime-exited", agentId: "cursor-agent",
        executionGenerationId: "cursor-generation", runtimeGenerationId, observerEpoch: 1, sourceSequence: 3,
        observedAtMs: 104, domain: "runtime", kind: "state_changed", state: "exited",
        controlEvidence: "process_exit", sideEffects: "none" });
      const [terminal] = await store.listPendingTypedLifecycleEffects("cursor-agent");
      assert.equal(terminal?.effectKind, "manifest_idle", scenario.name);
      if (scenario.expectedDisposition === "superseded") {
        const current = await store.load();
        await store.write(current.generation, current.entries.map(candidate => candidate.id === agent.id
          ? scenario.mutate(candidate)
          : candidate));
      }
      const before = await store.load();
      const settled = await store.applyTypedLifecycleEffect(before.generation, terminal!, null, commit => commit());
      assert.equal(settled.disposition, scenario.expectedDisposition, scenario.name);
      const persisted = (await store.load()).entries.find(candidate => candidate.id === agent.id);
      assert.equal(persisted?.observed_state, scenario.expectedState, scenario.name);
    } finally {
      database.close(); await store.close(); await env.cleanup();
    }
  }
});

test("typed hard-runtime failure cannot overwrite a replacement or intentionally inactive agent", async () => {
  const cases: Array<{ name: string; mutate: (agent: DaemonManifestEntry) => DaemonManifestEntry }> = [
    { name: "successor birth", mutate: agent => ({ ...agent, provider_ref: {
      ...agent.provider_ref!, execution_generation_id: "successor-generation",
      provider_continuation_id: "successor-continuation", provider_connection: {
        ...agent.provider_ref!.provider_connection, pid: 5311, processIdentity: "successor-birth",
      },
    } }) },
    { name: "stopped agent", mutate: agent => ({ ...agent, desired_state: "stopped", observed_state: "stopped" }) },
    { name: "quarantined agent", mutate: agent => ({ ...agent, condition: "quarantined" }) },
    { name: "polling delivery", mutate: agent => ({ ...agent, delivery_mode: "mcp_polling" }) },
    { name: "completed stop turn", mutate: agent => ({ ...agent, turn_control: {
      action_id: "stop-action", action_sequence: 1, work_attempt_id: "fenced-workspace",
      execution_generation_id: "fenced-generation", has_correction: false, status: "completed",
      capability: "native_interrupt", interrupted: true, resumed: false, state: "idle",
      stages: ["interrupting", "applied"], error: null,
      recorded_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:01.000Z",
    }, last_turn_control_sequence: 1 }) },
  ];
  for (const [scenarioIndex, scenario] of cases.entries()) {
    const env = await fixture(); const store = new ManifestStore(env.databasePath);
    const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "fenced-birth" };
    const agent: DaemonManifestEntry = {
      ...entry, id: "fenced-agent", room_id: "room", condition: "none", delivery_mode: "daemon_inbox",
      config_revision: 2, runtime_configuration_revision: 2, turn_control: undefined,
      work_attempt_id: "fenced-workspace", observed_state: "working",
      provider_ref: { work_attempt_id: "fenced-workspace", execution_generation_id: "fenced-generation",
        provider_continuation_id: "fenced-continuation", provider_connection: connection },
    };
    try {
      await store.write(0, [agent]);
      seedTerminalExecution(env.databasePath, "fenced-workspace", "fenced-generation");
      const database = new DatabaseSync(env.databasePath);
      try {
        database.exec(`PRAGMA foreign_keys=ON;
          UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='fenced-generation';
          UPDATE agent_configurations SET config_revision=2,runtime_configuration_revision=2 WHERE agent_id='fenced-agent'`);
        const shadow = new ExecutionShadowStore(database);
        const runtimeGenerationId = executionRuntimeStorageIdentity("fenced-agent", "fenced-generation",
          connection.kind, connection.pid, connection.processIdentity);
        shadow.registerRuntime({ agentId: "fenced-agent", executionGenerationId: "fenced-generation", runtimeGenerationId,
          provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: 100 });
        const observer = shadow.bindObserver({ agentId: "fenced-agent", subjectRuntimeGenerationId: runtimeGenerationId,
          observerRuntimeGenerationId: runtimeGenerationId, sourceId: "fenced-source", daemonGenerationId: "1",
          expectedEpoch: 0, boundAtMs: 100 });
        shadow.ingest("fenced-source", observer, { factId: `runtime-exited-${scenarioIndex}`, agentId: "fenced-agent",
          executionGenerationId: "fenced-generation", runtimeGenerationId, observerEpoch: 1, sourceSequence: 1,
          observedAtMs: 101, domain: "runtime", kind: "state_changed", state: "exited",
          controlEvidence: "process_exit", sideEffects: "none" });
        const [pending] = await store.listPendingTypedLifecycleEffects("fenced-agent");
        assert.ok(pending, scenario.name);
        await store.write(1, [scenario.mutate(agent)]);
        const before = await store.getEntry("fenced-agent");
        const result = await store.applyTypedLifecycleEffect(2, pending, null, commit => commit());
        assert.equal(result.disposition, "superseded", scenario.name);
        assert.equal((await store.load()).generation, 2, `${scenario.name} must not advance the manifest`);
        const after = await store.getEntry("fenced-agent");
        assert.equal(after?.observed_state, before?.observed_state, scenario.name);
        assert.deepEqual(after?.native_liveness, before?.native_liveness, scenario.name);
        assert.equal(database.prepare("SELECT state FROM execution_lifecycle_effects WHERE fact_id=?")
          .get(pending.factId)?.state, "superseded", scenario.name);
      } finally { database.close(); }
    } finally { await store.close(); await env.cleanup(); }
  }
});

test("v29 lifecycle effect migration rolls back its journal and version markers together", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.load();
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    restoreThreeProviderLifecycleProjectionFixture(historical);
    restoreEmptyExecutionDelegationV23Fixture(historical);
    historical.exec(`DROP TABLE execution_lifecycle_effects;
      UPDATE manifest_metadata SET schema_version=29 WHERE singleton=1;
      PRAGMA user_version=29`);
    historical.close();

    const interrupted = new ManifestStore(env.databasePath, undefined, undefined, () => {
      throw new Error("interrupt v30 lifecycle effect migration");
    });
    await assert.rejects(() => interrupted.load(), /interrupt v30/);
    await interrupted.close();
    const rolledBack = new DatabaseSync(env.databasePath);
    assert.equal(rolledBack.prepare("PRAGMA user_version").get()?.user_version, 29);
    assert.equal(rolledBack.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get()?.schema_version, 29);
    assert.equal(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_lifecycle_effects'").get(), undefined);
    rolledBack.close();

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    await migrated.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.ok(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_lifecycle_effects'").get());
    inspection.close();
  } finally {
    await initialized.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v30 runtime-failure effect migration rolls back its schema and version markers together", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.load();
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    restoreThreeProviderLifecycleProjectionFixture(historical);
    restoreEmptyExecutionDelegationV23Fixture(historical);
    historical.exec("DROP TABLE execution_lifecycle_effects");
    applyExecutionStorageSchema(historical, 22);
    historical.exec("UPDATE manifest_metadata SET schema_version=30 WHERE singleton=1; PRAGMA user_version=30");
    validateExecutionStorageSchema(historical, 22);
    historical.close();

    const interrupted = new ManifestStore(env.databasePath, undefined, undefined, () => {
      throw new Error("interrupt v31 runtime-failure effect migration");
    });
    await assert.rejects(() => interrupted.load(), /interrupt v31/);
    await interrupted.close();
    const rolledBack = new DatabaseSync(env.databasePath);
    assert.equal(rolledBack.prepare("PRAGMA user_version").get()?.user_version, 30);
    assert.equal(rolledBack.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get()?.schema_version, 30);
    validateExecutionStorageSchema(rolledBack, 22);
    rolledBack.close();

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    await migrated.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
    validateExecutionStorageSchema(inspection);
    inspection.close();
  } finally {
    await initialized.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("local delegation journal admits exact monotonic revisions and current grant rotation", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath); const other = new ManifestStore(env.databasePath);
  try {
    await seedLocalDelegationManifest(store); await other.load();
    const authority = localDelegationAuthority();
    const revision = localDelegationRevision();
    const input = localDelegationInput(revision, authority, 120);
    const competing = await Promise.all([
      store.reconcileExecutionDelegation(input, () => {}, async commit => commit()),
      other.reconcileExecutionDelegation(input, () => {}, async commit => commit()),
    ]);
    assert.deepEqual(competing.map(result => result.created).sort(), [false, true]);
    assert.deepEqual(competing.map(result => result.changed).sort(), [false, true], "only the committed creation changes authority");
    assert.deepEqual(competing[0]!.delegation, competing[1]!.delegation);

    const secondAuthority = localDelegationAuthority({ grantId: "host-grant-2" });
    const secondRevision = localDelegationRevision({
      revision: 2,
      scopeSha256: "b".repeat(64),
      createdAtMs: 160,
      expiresAtMs: 500,
    });
    const revised = await store.reconcileExecutionDelegation(
      localDelegationInput(secondRevision, secondAuthority, 170),
      () => {},
      async commit => commit(),
    );
    assert.equal(revised.created, true);
    assert.equal(revised.changed, true);
    assert.equal(revised.delegation.grantId, "host-grant-2");
    assert.equal(revised.delegation.scopeSha256, secondRevision.scopeSha256);

    const currentAuthority = localDelegationAuthority({ grantId: "host-grant-3" });
    const replayed = await store.reconcileExecutionDelegation(
      localDelegationInput(secondRevision, currentAuthority, 180),
      () => {},
      async commit => commit(),
    );
    assert.equal(replayed.created, false);
    assert.equal(replayed.changed, true, "same-revision rebinding remains a material change");
    assert.equal(replayed.delegation.grantId, "host-grant-3", "stable grant rotation updates no delegation scope");
    const unchanged = await store.reconcileExecutionDelegation(
      localDelegationInput(secondRevision, currentAuthority, 181), () => {}, async commit => commit(),
    );
    assert.equal(unchanged.created, false);
    assert.equal(unchanged.changed, false, "an exact replay provides no new restart authority");
    assert.deepEqual(unchanged.delegation, replayed.delegation);
    assert.deepEqual(await store.listExecutionDelegationInstanceIds({
      agentId: "agent",
      roomId: revision.roomId,
      agentKey: revision.agentKey,
      ownerAccountId: currentAuthority.ownerAccountId,
      hostId: currentAuthority.hostId,
      installationId: currentAuthority.installationId,
    }), [revision.delegationInstanceId]);
    assert.deepEqual(await store.listExecutionDelegationInstanceIds({
      agentId: "agent",
      roomId: revision.roomId,
      agentKey: revision.agentKey,
      ownerAccountId: currentAuthority.ownerAccountId,
      hostId: currentAuthority.hostId,
      installationId: "other-installation",
    }), [], "local discovery never crosses host installations");
    assert.deepEqual(await store.listExecutionDelegationInstanceIds({
      agentId: "agent",
      roomId: "other-room",
      agentKey: revision.agentKey,
      ownerAccountId: currentAuthority.ownerAccountId,
      hostId: currentAuthority.hostId,
      installationId: currentAuthority.installationId,
    }), [], "local discovery never crosses the current grant's room scope");
    assert.deepEqual(await store.validateExecutionDelegation(localDelegationValidation(currentAuthority, {
      revision: 2,
      scopeSha256: secondRevision.scopeSha256,
      atMs: 190,
    })), replayed.delegation);
    await assert.rejects(
      store.validateExecutionDelegation(localDelegationValidation(currentAuthority, { revision: 1, atMs: 190 })),
      { code: "revision_conflict" },
    );
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput(revision, currentAuthority, 190),
      () => {},
      async commit => commit(),
    ), { code: "revision_conflict" });
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput({ ...revision, revokedAtMs: 190 }, currentAuthority, 190),
      () => {},
      async commit => commit(),
    ), { code: "revision_conflict" });

    const database = new DatabaseSync(env.databasePath);
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_local_delegations").get()!.n, 2);
      assert.equal(database.prepare("SELECT grant_id FROM execution_local_delegations WHERE revision=1").get()!.grant_id, "host-grant-1");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { database.close(); }
  } finally { await other.close(); await store.close(); await env.cleanup(); }
});

test("local delegation journal refreshes mutable server aliases without changing admitted authority", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  try {
    await seedLocalDelegationManifest(store);
    const authority = localDelegationAuthority();
    const revision = localDelegationRevision();
    await store.reconcileExecutionDelegation(
      localDelegationInput(revision, authority, 120),
      () => {},
      async commit => commit(),
    );

    const renamedAuthority = authority;
    const renamedRevision = {
      ...revision,
      roomId: "renamed-room",
      agentKey: "EmmyMay/renamed-agent",
    };
    const replayed = await store.reconcileExecutionDelegation(
      localDelegationInput(renamedRevision, renamedAuthority, 130),
      () => {},
      async commit => commit(),
    );

    assert.equal(replayed.created, false);
    assert.equal(replayed.changed, true, "same-revision rebinding remains a material change");
    assert.equal(replayed.delegation.roomId, "renamed-room");
    assert.equal(replayed.delegation.agentKey, "EmmyMay/renamed-agent");
    assert.equal(replayed.delegation.scopeSha256, revision.scopeSha256);
    assert.deepEqual(await store.validateExecutionDelegation(localDelegationValidation(renamedAuthority, {
      atMs: 140,
    })), replayed.delegation);
    await assert.rejects(store.validateExecutionDelegation(localDelegationValidation(renamedAuthority, {
      scopeSha256: "b".repeat(64),
      atMs: 140,
    })), { code: "authority_mismatch" });

    const database = new DatabaseSync(env.databasePath);
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_local_delegations").get()!.n, 1);
      assert.deepEqual({ ...database.prepare(`SELECT room_id,agent_key,scope_sha256
        FROM execution_local_delegations`).get() }, {
        room_id: "renamed-room",
        agent_key: "EmmyMay/renamed-agent",
        scope_sha256: revision.scopeSha256,
      });
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("local delegation journal checkpoints exact latest revisions across offline gaps", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  try {
    await seedLocalDelegationManifest(store);
    const authority = localDelegationAuthority();
    const initialLatest = localDelegationRevision({
      delegationInstanceId: "initial-gap",
      revision: 3,
      approverAccountId: "approver-gap-1",
      createdAtMs: 120,
      expiresAtMs: 300,
    });
    assert.equal((await store.reconcileExecutionDelegation(
      localDelegationInput(initialLatest, authority, 130),
      () => {},
      async commit => commit(),
    )).created, true);

    const first = localDelegationRevision({
      delegationInstanceId: "later-gap",
      approverAccountId: "approver-gap-2",
      expiresAtMs: 140,
    });
    await store.reconcileExecutionDelegation(
      localDelegationInput(first, authority, 120),
      () => {},
      async commit => commit(),
    );
    const terminalLatest = {
      ...first,
      revision: 3,
      createdAtMs: 180,
      expiresAtMs: 400,
      revokedAtMs: 190,
    };
    assert.equal((await store.reconcileExecutionDelegation(
      localDelegationInput(terminalLatest, authority, 200),
      () => {},
      async commit => commit(),
    )).created, true, "the exact current terminal revision settles skipped retired history");
    await assert.rejects(store.validateExecutionDelegation(localDelegationValidation(authority, {
      delegationInstanceId: "later-gap",
      revision: 3,
      approverAccountId: "approver-gap-2",
      atMs: 200,
    })), { code: "terminal" });
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput({ ...terminalLatest, revision: 2 }, authority, 200),
      () => {},
      async commit => commit(),
    ), { code: "revision_conflict" });
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput({ ...terminalLatest, expiresAtMs: 401 }, authority, 200),
      () => {},
      async commit => commit(),
    ), { code: "revision_conflict" });
  } finally { await store.close(); await env.cleanup(); }
});

test("local delegation journal rejects remote authority, scope, and exact-decision mismatches", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  try {
    await seedLocalDelegationManifest(store);
    const authority = localDelegationAuthority();
    const revision = localDelegationRevision();
    await store.reconcileExecutionDelegation(localDelegationInput(revision, authority, 120), () => {}, async commit => commit());

    const foreignOwner = { ...revision, revision: 2, createdAtMs: 160, ownerAccountId: "other-owner" };
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput(foreignOwner, authority, 170),
      () => {},
      async commit => commit(),
    ), { code: "authority_mismatch" });

    for (const changedAuthority of [
      localDelegationAuthority({ hostId: "other-host" }),
      localDelegationAuthority({ installationId: "other-installation" }),
    ]) {
      const changedRevision = { ...revision, revision: 2, createdAtMs: 160, expiresAtMs: 400 };
      await assert.rejects(store.reconcileExecutionDelegation(
        localDelegationInput(changedRevision, changedAuthority, 170),
        () => {},
        async commit => commit(),
      ), { code: "revision_conflict" });
    }

    await assert.rejects(store.reconcileExecutionDelegation(localDelegationInput(
      revision,
      localDelegationAuthority({ expiresAtMs: 120 }),
      120,
    ), () => {}, async commit => commit()), { code: "authority_mismatch" });
    await assert.rejects(store.reconcileExecutionDelegation(localDelegationInput(
      { ...revision, expiresAtMs: 120 + 30 * 24 * 60 * 60 * 1_000 + 1 },
      authority,
      120,
    ), () => {}, async commit => commit()), { code: "authority_mismatch" });
    const day = 24 * 60 * 60 * 1_000;
    await assert.rejects(store.reconcileExecutionDelegation(localDelegationInput(
      localDelegationRevision({
        delegationInstanceId: "aged-long-lifetime",
        approverAccountId: "approver-long-lifetime",
        createdAtMs: 0,
        expiresAtMs: 40 * day,
      }),
      localDelegationAuthority({ expiresAtMs: 50 * day }),
      20 * day,
    ), () => {}, async commit => commit()), { code: "authority_mismatch" });
    await assert.rejects(store.reconcileExecutionDelegation({
      delegation: revision,
      authority: { ...authority, supervisorGrant: "must-not-enter-the-journal" } as never,
      atMs: 120,
    }, () => {}, async commit => commit()), { code: "invalid_input" });
    await assert.rejects(store.validateExecutionDelegation(localDelegationValidation(authority, {
      approverAccountId: "other-approver",
    })), { code: "authority_mismatch" });
    await assert.rejects(store.validateExecutionDelegation(localDelegationValidation(
      localDelegationAuthority({ grantId: "unreconciled-rotation" }),
    )), { code: "authority_mismatch" });
  } finally { await store.close(); await env.cleanup(); }
});

test("local delegation journal makes revocation and chronological expiry terminal without blocking a fresh instance", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  try {
    await seedLocalDelegationManifest(store);
    const authority = localDelegationAuthority();
    const revision = localDelegationRevision({ expiresAtMs: 200 });
    await store.reconcileExecutionDelegation(localDelegationInput(revision, authority, 120), () => {}, async commit => commit());
    const overlapping = localDelegationRevision({ delegationInstanceId: "overlapping-instance", createdAtMs: 130, expiresAtMs: 300 });
    await assert.rejects(store.reconcileExecutionDelegation({
      ...localDelegationInput(overlapping, authority, 140),
    }, () => {}, async commit => commit()), { code: "revision_conflict" });
    const revokedRevision = { ...revision, revokedAtMs: 140 };
    const revoked = await store.reconcileExecutionDelegation({
      ...localDelegationInput(revokedRevision, authority, 150),
    }, () => {}, async commit => commit());
    assert.equal(revoked.delegation.revokedAtMs, 140);
    assert.equal(revoked.created, false);
    assert.equal(revoked.changed, true, "revocation changes an existing revision");
    const revokedReplay = await store.reconcileExecutionDelegation(
      localDelegationInput(revokedRevision, authority, 151), () => {}, async commit => commit(),
    );
    assert.equal(revokedReplay.changed, false, "an already committed revocation is not a new change");
    await assert.rejects(store.validateExecutionDelegation(localDelegationValidation(authority, { atMs: 160 })), { code: "terminal" });
    const afterRevocation = { ...revision, revision: 2, createdAtMs: 160, expiresAtMs: 300, revokedAtMs: null };
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput(afterRevocation, authority, 170),
      () => {},
      async commit => commit(),
    ), { code: "terminal" });

    const expired = localDelegationRevision({ delegationInstanceId: "expired-instance", createdAtMs: 140, expiresAtMs: 150 });
    await store.reconcileExecutionDelegation(localDelegationInput(expired, authority, 160), () => {}, async commit => commit());
    await assert.rejects(store.validateExecutionDelegation(localDelegationValidation(authority, {
      delegationInstanceId: "expired-instance",
      atMs: 160,
    })), { code: "expired" });
    const afterExpiry = { ...expired, revision: 2, createdAtMs: 150, expiresAtMs: 300 };
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput(afterExpiry, authority, 160),
      () => {},
      async commit => commit(),
    ), { code: "terminal" });

    const fresh = localDelegationRevision({ delegationInstanceId: "fresh-instance", createdAtMs: 160, expiresAtMs: 300 });
    assert.equal((await store.reconcileExecutionDelegation(
      localDelegationInput(fresh, authority, 170),
      () => {},
      async commit => commit(),
    )).created, true);
  } finally { await store.close(); await env.cleanup(); }
});

test("local delegation journal fences competing writers and rolls back failed ownership commits", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath); const other = new ManifestStore(env.databasePath);
  try {
    await seedLocalDelegationManifest(store); await other.load();
    const authority = localDelegationAuthority();
    const revision = localDelegationRevision();
    await assert.rejects(store.reconcileExecutionDelegation(localDelegationInput(revision, authority, 120), undefined as never, async commit => commit()), /current host authority/i);
    await assert.rejects(store.reconcileExecutionDelegation(localDelegationInput(revision, authority, 120), () => {}, undefined as never), /current host authority/i);
    await assert.rejects(store.reconcileExecutionDelegation(localDelegationInput(revision, authority, 120), () => {}, async () => {}), /without committing/i);

    const database = new DatabaseSync(env.databasePath);
    database.exec("CREATE TRIGGER fail_delegation_admission AFTER INSERT ON execution_local_delegations BEGIN SELECT RAISE(ABORT,'delegation rollback'); END");
    await assert.rejects(store.reconcileExecutionDelegation(
      localDelegationInput(revision, authority, 120),
      () => {},
      async commit => commit(),
    ), /delegation rollback/);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_local_delegations").get()!.n, 0);
    database.exec("DROP TRIGGER fail_delegation_admission");

    const conflicting = await Promise.allSettled([
      store.reconcileExecutionDelegation(localDelegationInput(revision, authority, 120), () => {}, async commit => commit()),
      other.reconcileExecutionDelegation(localDelegationInput(
        { ...revision, expiresAtMs: 400 },
        authority,
        120,
      ), () => {}, async commit => commit()),
    ]);
    assert.equal(conflicting.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(conflicting.filter(result => result.status === "rejected"
      && result.reason?.code === "revision_conflict").length, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_local_delegations").get()!.n, 1);
    database.close();
  } finally { await other.close(); await store.close(); await env.cleanup(); }
});
