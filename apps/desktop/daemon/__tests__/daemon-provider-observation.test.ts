import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assertSupervisorDaemonPlatform } from "../platform.js";
import { type SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import type { NativeExecutionObservation, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import {
  within,
  eventually,
  daemonRequest,
  flushActivity,
  entry,
  observationDaemonFixture,
} from "./helpers/daemon-fixture.js";

test("configuration apply socket stops the exact idle birth and leaves the saved revision pending for its successor", async () => {
  let stops = 0;
  const env = await observationDaemonFixture(
    async () => ({ sourceId: "source-config", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose() {} }),
    "codex",
    {
      stop: async current => {
        assert.equal(current.providerContinuationId, "observed-continuation");
        stops += 1;
        return {
          endedAt: new Date().toISOString(),
          exitCode: 0,
          signal: null,
          terminalCause: "stopped",
          providerContinuationId: current.providerContinuationId,
        };
      },
    },
  );
  try {
    env.handle.observedState = "idle";
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    const status = await daemonRequest(env.paths.socketPath, "daemon.status");
    const daemonGeneration = (status.result as { generation: number }).generation;
    const before = await daemonRequest(env.paths.socketPath, "supervisor.get_agent_configuration", {
      entry_id: env.id,
      daemon_generation: daemonGeneration,
    });
    assert.equal(before.ok, true, before.error);
    const configuration = before.result as {
      config_revision: number;
      model: string | null;
      reasoning_effort: string | null;
      charter: string;
      permission_profile_id: string | null;
    };
    const update = await daemonRequest(env.paths.socketPath, "supervisor.update_agent_configuration", {
      entry_id: env.id,
      daemon_generation: daemonGeneration,
      expected_revision: configuration.config_revision,
      configuration: {
        model: configuration.model,
        reasoning_effort: configuration.reasoning_effort,
        charter: `${configuration.charter} with saved change`,
        permission_profile_id: configuration.permission_profile_id,
      },
    });
    assert.equal(update.ok, true, update.error);
    const saved = (update.result as {
      outcome: string;
      configuration: { config_revision: number; runtime_configuration_revision: number };
    }).configuration;
    assert.equal(saved.config_revision, 2);
    assert.equal(saved.runtime_configuration_revision, 1);

    const applied = await daemonRequest(env.paths.socketPath, "supervisor.apply_agent_configuration", {
      entry_id: env.id,
      daemon_generation: daemonGeneration,
      expected_configuration_revision: saved.config_revision,
    });
    assert.equal(applied.ok, true, applied.error);
    assert.deepEqual(applied.result, { outcome: "restarting" });
    assert.equal(stops, 1);
    assert.equal(env.internals.liveHandles.has(env.id), false);
    const after = await env.internals.store.getEntry(env.id);
    assert.equal(after?.observed_state, "recovering");
    assert.deepEqual(after?.provider_ref?.execution_generation_id, env.generation,
      "the retained continuation remains available to ordinary successor convergence");
    assert.equal((await env.internals.store.getAgentConfiguration(env.id))?.runtime_configuration_revision, 1,
      "only a successor birth may advance the applied configuration revision");
  } finally {
    await env.cleanup();
  }
});

for (const shutdown of ["stop", "handoff"] as const) test(`daemon captures only committed native-turn identity and fences live observation on ${shutdown}`, async () => {
  let listener: ((event: NativeExecutionObservation) => void) | undefined;
  let disposed = 0;
  let latestSequence = 2;
  const env = await observationDaemonFixture(async (handle, callback) => {
    listener = callback;
    callback({ sourceId: "source-live", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } });
    callback({ sourceId: "source-live", sequence: 2, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
        providerContinuationId: handle.providerContinuationId!, providerTurnId: "native-turn" } });
    return { sourceId: "source-live", position: () => ({ firstRetainedSequence: 1, latestSequence }), dispose: () => { disposed += 1; } };
  });
  const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await eventually(async () => inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count === 1,
      "runtime fact without fabricated native-turn mapping");
    assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM execution_turns").get()!.count, 0);
    const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: entry.room_id,
      last_observed_message_id: "901", messages: [{ source_message_id: "901", source_message: { text: "private source text" }, activation: {} }] });
    assert.ok(item);
    await env.internals.supervisedInbox.transition(item.inbox_item_id, "dispatching");
    await env.internals.supervisedInbox.checkpointTurnStarted(item.inbox_item_id, "native-turn", {
      work_attempt_id: env.handle.workAttemptId, origin_execution_generation_id: env.generation,
      provider_continuation_id: env.handle.providerContinuationId!,
    });
    await eventually(async () => inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count === 2,
      "post-commit inbox notification resumes structural capture");
    const mapped = inspection.prepare(`SELECT t.agent_id,t.execution_generation_id,t.provider_continuation_id,t.provider_turn_id,
      a.room_id,a.source_message_id FROM execution_turns t JOIN execution_message_attempts a USING(attempt_id)`).get();
    assert.deepEqual({ ...mapped }, { agent_id: env.id, execution_generation_id: env.generation,
      provider_continuation_id: env.handle.providerContinuationId, provider_turn_id: "native-turn",
      room_id: entry.room_id, source_message_id: "901" });
    const before = inspection.prepare("SELECT * FROM execution_facts ORDER BY sequence").all();
    assert.ok(!JSON.stringify(before).includes("private source text"));
    if (shutdown === "stop") {
      const stopped = env.daemon.stop();
      assert.equal(disposed, 1, "stop closes capture synchronously before awaiting operational drains");
      await within(stopped, "observation-aware daemon stop");
    } else {
      const handoff = env.daemon.waitForHandoff();
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true);
      assert.equal(disposed, 1, "handoff acknowledgement cannot leave a live observation subscription");
      await within(handoff, "observation-aware daemon handoff");
    }
    assert.equal(disposed, 1, "capture close and stream teardown must not dispose the same native subscription twice");
    latestSequence = 3;
    listener!({ sourceId: "source-live", sequence: 3, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, false);
    assert.deepEqual(inspection.prepare("SELECT * FROM execution_facts ORDER BY sequence").all(), before,
      "late native callbacks cannot persist after daemon authority closes");
  } finally { inspection.close(); await env.cleanup(); }
});

for (const shutdown of ["stop", "handoff"] as const) test(shutdown === "stop"
  ? "daemon stop does not wait for a pending native subscription and disposes its late result"
  : "daemon handoff defers a pending native subscription and preserves its queued evidence", async () => {
  let release!: (subscription: NativeExecutionSubscription) => void;
  const pending = new Promise<NativeExecutionSubscription>((resolve) => { release = resolve; });
  let listener: ((event: NativeExecutionObservation) => void) | undefined;
  let subscriptions = 0;
  let disposed = 0;
  const env = await observationDaemonFixture(async (_handle, callback) => { subscriptions += 1; listener = callback; return pending; });
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await eventually(async () => subscriptions === 1, "pending native subscription starts");
    const event: NativeExecutionObservation = { sourceId: "source-late", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } };
    listener!(event);
    const subscription = { sourceId: "source-late", position: () => ({ firstRetainedSequence: 1, latestSequence: 1 }), dispose: () => { disposed += 1; } };
    if (shutdown === "stop") {
      await within(env.daemon.stop(), "stop with unresolved optional subscription", 1000);
      release(subscription);
    }
    else {
      const deferred = await within(daemonRequest(env.paths.socketPath, "daemon.prepare_handoff"),
        "handoff promptly defers an unresolved subscription", 1000);
      assert.equal(deferred.ok, false);
      assert.match(deferred.error!, /pending agent lifecycle evidence could not be preserved/);
      assert.equal(disposed, 0);
      assert.equal(env.internals.liveHandles.get(env.id), env.handle);
      assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, true);
      release(subscription);
      const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
      try {
        await eventually(async () => inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count === 1,
          "deferred handoff retains and commits the original queued observation");
      } finally { inspection.close(); }
      const handoff = env.daemon.waitForHandoff();
      assert.equal((await daemonRequest(env.paths.socketPath, "daemon.prepare_handoff")).ok, true);
      await within(handoff, "handoff after the original subscription resolves", 1000);
    }
    await eventually(async () => disposed === 1, "shutdown disposes the original subscription exactly once");
    listener!(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
    try { assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count, shutdown === "stop" ? 0 : 1); }
    finally { inspection.close(); }
    assert.equal(subscriptions, 1);
    assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, false);
  } finally {
    release({ sourceId: "source-late", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {} });
    await env.cleanup();
  }
});

for (const failure of ["observer_rejection", "storage_closed"] as const) test(`optional ${failure} cannot fail provider installation or a committed daemon mutation`, async () => {
  let subscriptions = 0;
  const env = await observationDaemonFixture(async (_handle, callback) => {
    subscriptions += 1;
    if (failure === "observer_rejection") throw new Error("optional observer refused");
    callback({ sourceId: "source-storage", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } });
    return { sourceId: "source-storage", position: () => ({ firstRetainedSequence: 1, latestSequence: 1 }), dispose: () => {} };
  });
  try {
    if (failure === "storage_closed") (env.internals.executionCapture as unknown as { database: DatabaseSync }).database.close();
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await eventually(async () => subscriptions === 1, "optional observer invoked");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(env.internals.liveHandles.get(env.id), env.handle);
    const updated = await daemonRequest(env.paths.socketPath, "manifest.set_desired_state", { id: env.id, desired_state: "paused" });
    assert.equal(updated.ok, true, updated.error);
    assert.equal((await env.internals.store.getEntry(env.id))?.desired_state, "paused");
    assert.equal((await daemonRequest(env.paths.socketPath, "daemon.status")).ok, true);
  } finally { await env.cleanup(); }
});

test("a stream installation that completes after daemon stop cannot restart its early observation subscription", async () => {
  let subscriptions = 0;
  let disposed = 0;
  let observe!: (event: NativeExecutionObservation) => void;
  const env = await observationDaemonFixture(async (_handle, listener) => {
    subscriptions += 1;
    observe = listener;
    return { sourceId: "source-early-installed", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => { disposed += 1; } };
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const delayedInstall = new Promise<void>((resolve) => { release = resolve; });
  env.port.onExit = async () => { entered(); await delayedInstall; return () => {}; };
  try {
    const installing = env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await waiting;
    await eventually(async () => subscriptions === 1, "early optional subscription installed");
    await within(env.daemon.stop(), "stop while stream installation is pending", 1000);
    assert.equal(disposed, 1, "stop disposes the already-installed optional subscription synchronously");
    release();
    await installing;
    observe({ sourceId: "source-early-installed", sequence: 1, observedAtMs: Date.now(), nativeProcessPid: 7123, nativeProcessIdentity: "observed-birth",
      fact: { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(subscriptions, 1, "late stream completion must not start another optional subscription");
    assert.equal(disposed, 1);
    assert.equal((env.internals.executionCapture as unknown as { database: DatabaseSync }).database.isOpen, false);
    const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
    try { assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count, 0); }
    finally { inspection.close(); }
  } finally { release(); await env.cleanup(); }
});

for (const commit of ["normal", "recovered"] as const) test(`Cursor observation callback follows only an exact ${commit} prepared checkpoint and cannot reject it`, async () => {
  const env = await observationDaemonFixture(async () => ({
    sourceId: "source-cursor", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {},
  }), "cursor");
  const inspection = new DatabaseSync(env.paths.manifestPath, { readOnly: true });
  try {
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    await env.internals.workerBindings.bind({ entry_id: env.id, room_id: entry.room_id,
      work_attempt_id: env.handle.workAttemptId, execution_generation_id: env.generation,
      agent_session_id: "cursor-observation-worker", agent_session_token: "cursor-observation-bearer",
      credential_ref: "cursor-observation-credential", api_url: "https://letagents.example" });
    const [item] = await env.internals.supervisedInbox.ingestPoll({ agent_id: env.id, room_id: entry.room_id,
      last_observed_message_id: "902", messages: [{ source_message_id: "902", source_message: { text: "prepare" }, activation: {} }] });
    assert.ok(item);
    await env.internals.supervisedInbox.transition(item.inbox_item_id, "dispatching");
    const agent: SupervisedIngressAgent = {
      agentId: env.id, roomId: entry.room_id, provider: "cursor", deliveryMode: "daemon_inbox",
      apiUrl: "https://letagents.example", agentSessionId: "cursor-observation-worker", bearer: "cursor-observation-bearer",
      handle: env.handle, workAttemptId: env.handle.workAttemptId, providerContinuationId: env.handle.providerContinuationId,
      providerConnection: env.handle.providerConnection!, executionGenerationId: env.generation,
      daemonGeneration: ((await daemonRequest(env.paths.socketPath, "daemon.status")).result as { generation: number }).generation,
    };
    const connection = { kind: "cursor_cli" as const, pid: 7124, processIdentity: "cursor-prepared-birth" };
    env.handle.pid = connection.pid;
    env.handle.providerConnection = connection;
    const observations: Array<{ runtime: Parameters<ExecutionCaptureCoordinator["prepared"]>[0]; binding: unknown; connection: unknown }> = [];
    env.internals.executionCapture!.prepared = (runtime) => {
      observations.push({ runtime,
        binding: inspection.prepare("SELECT provider_turn_id,origin_execution_generation_id FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(item.inbox_item_id),
        connection: inspection.prepare("SELECT provider_connection_pid,provider_process_identity FROM runtime_deployments WHERE agent_id=?").get(env.id) });
      throw new Error("optional observation callback failed after commit");
    };
    const input = { agent, inboxItemId: item.inbox_item_id, providerTurnId: "cursor-prepared-turn",
      providerContinuationId: env.handle.providerContinuationId!, providerConnection: connection };
    await assert.rejects(() => env.internals.providerCheckpoints.checkpointPreparedTurn({ ...input, agent: { ...agent, bearer: "wrong-bearer" } }), /exact supervised lane/);
    assert.equal(observations.length, 0, "failed exact-authority validation cannot mint observation proof");
    assert.equal((await env.internals.supervisedInbox.get(item.inbox_item_id))?.provider_turn_id, null);
    if (commit === "recovered") {
      const checkpoint = env.internals.store.checkpointCursorPreparedTurn.bind(env.internals.store);
      env.internals.store.checkpointCursorPreparedTurn = async (...args) => {
        await checkpoint(...args);
        throw new Error("transport reported failure after the prepared transaction committed");
      };
    }
    await env.internals.providerCheckpoints.checkpointPreparedTurn(input);
    assert.equal(observations.length, 1, "successful or independently recovered commit publishes exactly one optional observation proof");
    const observed = observations[0]!;
    assert.equal(observed.runtime.handle, env.handle);
    assert.equal(observed.runtime.executionGenerationId, env.generation);
    assert.equal(observed.runtime.configurationRevision, 1);
    assert.deepEqual(observed.runtime.connection, connection);
    assert.deepEqual({ ...observed.binding as object }, { provider_turn_id: "cursor-prepared-turn", origin_execution_generation_id: env.generation });
    assert.deepEqual({ ...observed.connection as object }, { provider_connection_pid: 7124, provider_process_identity: "cursor-prepared-birth" });
    assert.deepEqual(agent.providerConnection, connection, "callback failure cannot undo the operational provider snapshot");
    assert.equal((await env.internals.supervisedInbox.get(item.inbox_item_id))?.provider_turn_id, "cursor-prepared-turn");
  } finally { inspection.close(); await env.cleanup(); }
});

test("daemon is visibly gated to macOS and Windows", () => {
  assert.throws(() => assertSupervisorDaemonPlatform("linux"), /macOS and Windows only/);
  assert.doesNotThrow(() => assertSupervisorDaemonPlatform("darwin"));
  assert.doesNotThrow(() => assertSupervisorDaemonPlatform("win32"));
});

test("failed room waits remain retryable for one healthy provider execution", async () => {
  const env = await observationDaemonFixture(async () => ({
    sourceId: "source-room-wait", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {},
  }));
  try {
    env.handle.observedState = "failed";
    await env.internals.providerStreams.install(env.id, env.handle, env.generation, () => false);
    const handle = env.handle;
    const internals = env.daemon as unknown as {
      handleProviderStream: (entryId: string, providerHandle: typeof handle, event: {
        workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
        provider: string; kind: string; method: string; summary?: string | null; payload: unknown; payloadTruncated: boolean;
        payloadRedacted: boolean; durablePayloadRef: null;
      }) => Promise<void>;
    };
    const base = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId!,
      observedAt: new Date().toISOString(),
      provider: "codex",
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    };
    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 1,
      kind: "item_lifecycle",
      method: "item/completed",
      payload: {
        item: {
          type: "mcpToolCall", id: "wait_codex_failed", server: "letagents", tool: "wait_for_messages",
          status: "failed", result: null, error: { message: "poll failed" },
        },
      },
    });
    await flushActivity(env.daemon);
    let current = await env.internals.store.getEntry(env.id);
    assert.ok(current);
    assert.equal(current.activity?.at(-1)?.status, "idle");

    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 2,
      kind: "text_delta",
      method: "item/agentMessage/delta",
      payload: { threadId: handle.providerContinuationId!, turnId: "turn_exact", itemId: "message_exact", delta: "late evidence" },
    });
    await flushActivity(env.daemon);
    current = await env.internals.store.getEntry(env.id);
    assert.ok(current);
    assert.equal(current.activity?.at(-1)?.status, "working");

    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 3,
      kind: "text_delta",
      method: "item/reasoning/summaryTextDelta",
      summary: "Checking the durable room delivery path.",
      payload: {
        threadId: handle.providerContinuationId!,
        turnId: "turn_exact",
        itemId: "reasoning_exact",
        summaryIndex: 0,
        delta: "Checking the durable room delivery path.",
      },
    });
    await flushActivity(env.daemon);
    current = await env.internals.store.getEntry(env.id);
    assert.ok(current);
    assert.equal(
      current.activity?.at(-1)?.summary,
      "Checking the durable room delivery path.",
      "the daemon preserves the provider-approved display summary instead of replacing it with a protocol method",
    );
    await internals.handleProviderStream(env.id, handle, {
      ...base,
      sequence: 4,
      kind: "text_delta",
      method: "item/reasoning/textDelta",
      summary: "Codex raw reasoning text is streaming.",
      payload: {
        threadId: handle.providerContinuationId!,
        turnId: "turn_exact",
        itemId: "reasoning_exact",
        delta: "private chain of thought must never enter Live",
      },
    });
    const live = (await daemonRequest(env.paths.socketPath, "supervisor.watch_agent_stream", {
      entry_id: env.id, after_sequence: 0, wait_ms: 0,
    })).result as { events: Array<{ method: string; summary: string | null }> };
    assert.deepEqual(
      live.events.map((event) => event.method),
      ["item/agentMessage/delta", "item/reasoning/summaryTextDelta"],
      "Codex's verbatim readable-reasoning method survives the Live display filter",
    );
    assert.equal(live.events[1]?.summary, "Checking the durable room delivery path.");
    assert.doesNotMatch(JSON.stringify(live), /private chain of thought/);
  } finally {
    await env.cleanup();
  }
});
