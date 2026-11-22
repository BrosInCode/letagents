import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  isDaemonAsyncRpcAccepted,
  type DaemonRpcEffectView,
  type DaemonStateWatchWireResult,
} from "#daemon-contract/index.js";
import { DaemonStateDatabase } from "../daemon-state-database.js";
import {
  AsyncRpcEffectCoordinator,
  AsyncRpcPreExecutionRefusalError,
  EffectExecutor,
  MAX_RETAINED_SETTLED_RPC_EFFECTS,
  getEffect,
  prepareEffect,
  claimEffectForExecution,
} from "../effect-journal/index.js";
import { DaemonStateWatch } from "../daemon-state-watch.js";
import { DaemonControlSocket } from "../control-socket.js";
import { MAX_EFFECT_OUTCOME_BYTES } from "../effect-journal/types.js";
import {
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_PROTOCOL_VERSION,
} from "#daemon-contract/index.js";
import { SupervisorDaemonClient, supervisorDaemonSpawnEnvironment } from "../../electron/main/supervisor-daemon.js";
import {
  SupervisorDaemon,
  daemonRawRequest,
  daemonRequest,
  entry,
  fixture,
  noWorkLeaseHttp,
  testDaemonEndpoint,
  within,
} from "./helpers/daemon-fixture.js";

test("async RPC returns effect_id immediately while executing and delivers terminal outcome via manifest.watch_state", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  let mintEntered!: () => void;
  const mintStarted = new Promise<void>((resolve) => { mintEntered = resolve; });
  let releaseMint!: () => void;
  const mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });

  const daemon = new SupervisorDaemon(
    paths,
    "darwin",
    undefined,
    false,
    15_000,
    undefined,
    {},
    {
      latest: async () => ({ messages: [{ id: "42" }] }),
      poll: async () => ({ messages: [] }),
      publish: async () => {},
    },
    {
      ...noWorkLeaseHttp,
      createWorkerSession: async () => {
        mintEntered();
        await mintGate;
        return {
          sessionId: "session-async-1",
          bearer: "bearer-async-1",
          bearerId: "bearer-id-async-1",
          expiresAt: null,
        };
      },
    },
  );
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: {
        ...entry,
        id: "async_bootstrap_agent",
        provider: "codex",
        delivery_mode: "daemon_inbox",
        desired_state: "paused",
        observed_state: "absent",
      },
    })).ok, true);
    const status = (await daemonRawRequest(paths.socketPath, "daemon.status")).result as {
      generation: number;
      capabilities: { async_rpc_effects_v1?: boolean };
    };
    assert.equal(status.capabilities.async_rpc_effects_v1, true);
    const generation = status.generation;

    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "async_bootstrap_agent",
      room_id: entry.room_id,
      agent_key: "owner/agent",
      grant_id: "grant-async",
      supervisor_grant: "secret-grant-async-bootstrap",
      grant_generation: 1,
      api_url: "https://letagents.example",
      host_id: "host-1",
      installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
    })).ok, true);

    // Raw RPC call returns `{ effect_id, daemon_generation }` immediately while createWorkerSession is blocked.
    const startedAt = Date.now();
    const rawAccepted = await daemonRawRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "async_bootstrap_agent",
      daemon_generation: generation,
    });
    assert.equal(rawAccepted.ok, true, rawAccepted.error);
    assert.equal(isDaemonAsyncRpcAccepted(rawAccepted.result), true);
    assert.ok(Date.now() - startedAt < 1_000, "async RPC acknowledgement must not block on external I/O");
    const accepted = rawAccepted.result as { effect_id: string; daemon_generation: number };
    assert.equal(accepted.daemon_generation, generation);

    await within(mintStarted, "bootstrap execution starts in background", 2_000);

    // Unrelated control RPCs remain responsive while the async effect is in flight.
    assert.equal((await daemonRawRequest(paths.socketPath, "daemon.status")).ok, true);

    // Full state watch snapshot reports the in-flight effect before settlement.
    const initialWatch = (await daemonRawRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: 0,
      after_sequence: 0,
      wait_ms: 0,
      changed_only: false,
    })).result as DaemonStateWatchWireResult;
    const inFlightView = initialWatch.rpc_effects?.find((item) => item.effect_id === accepted.effect_id);
    assert.ok(inFlightView, "in-flight async RPC effect should be visible on manifest.watch_state");
    assert.ok(inFlightView.state === "prepared" || inFlightView.state === "executing");

    // Observe changed_only deltas while unblocking the background effect; intermediate manifest
    // updates (worker binding / cursor commit) may wake earlier deltas before effect settlement.
    releaseMint();
    let afterGen = initialWatch.daemon_generation;
    let afterSeq = initialWatch.sequence;
    let settled: DaemonRpcEffectView | undefined;
    const deadline = Date.now() + 2_000;
    while (!settled && Date.now() < deadline) {
      const delta = (await within(daemonRawRequest(paths.socketPath, "manifest.watch_state", {
        after_daemon_generation: afterGen,
        after_sequence: afterSeq,
        wait_ms: 2_000,
        changed_only: true,
      }), "changed_only watch wakes on effect settlement", 2_000)).result as DaemonStateWatchWireResult;
      afterGen = delta.daemon_generation;
      afterSeq = delta.sequence;
      const candidate = delta.rpc_effects?.find((item) => item.effect_id === accepted.effect_id);
      if (candidate && candidate.state !== "prepared" && candidate.state !== "executing") {
        settled = candidate;
      }
    }
    assert.ok(settled, "settled async RPC effect must arrive in changed_only watch delta");
    assert.equal(settled.state, "completed");
    assert.deepEqual(settled.result, { status: "bootstrapped", last_observed_message_id: "42" });

    // Durable journal row exists with at-most-once policy (`retryable = false`, `max_attempts = 1`).
    const db = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try {
      const row = getEffect(db, accepted.effect_id);
      assert.ok(row);
      assert.equal(row.kind, "rpc_bootstrap_room_ingress");
      assert.equal(row.state, "completed");
      assert.equal(row.retryable, false);
      assert.equal(row.max_attempts, 1);
      assert.deepEqual(row.outcome, { status: "bootstrapped", last_observed_message_id: "42" });
    } finally {
      db.close();
    }
  } finally {
    releaseMint?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("supervisor.install_host_grant never persists supervisor_grant into SQLite effects or manifest.watch_state", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const secretGrant = "sup_secret_bearer_NEVER_WRITE_TO_SQLITE_OR_WATCH_9f8e7d6c";
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  }, noWorkLeaseHttp);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: {
        ...entry,
        id: "secret_hygiene_agent",
        provider: "codex",
        delivery_mode: "daemon_inbox",
        desired_state: "paused",
        observed_state: "absent",
      },
    })).ok, true);
    const generation = ((await daemonRawRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const installResult = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "secret_hygiene_agent",
      room_id: entry.room_id,
      agent_key: "owner/agent",
      grant_id: "grant-hygiene",
      supervisor_grant: secretGrant,
      grant_generation: 1,
      api_url: "https://letagents.example",
      host_id: "host-1",
      installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
    });
    assert.equal(installResult.ok, true, installResult.error);
    assert.deepEqual(installResult.result, { status: "installed" });

    // Check manifest.watch_state carries the settled effect but NEVER the secret bearer.
    const watch = (await daemonRawRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: 0,
      after_sequence: 0,
      wait_ms: 0,
      changed_only: false,
    })).result as DaemonStateWatchWireResult;
    const watchJson = JSON.stringify(watch);
    assert.equal(watchJson.includes(secretGrant), false, "manifest.watch_state must never expose supervisor_grant");
    assert.ok(
      watch.rpc_effects?.some((effect) => effect.kind === "rpc_install_host_grant" && effect.state === "completed"),
      "completed rpc_install_host_grant view should be published",
    );

    // Check every row in SQLite `effects` contains zero occurrences of the secret.
    const db = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try {
      const rawRows = db.prepare("SELECT id, kind, payload, outcome, last_error FROM effects").all() as Array<{
        id: string;
        kind: string;
        payload: string | null;
        outcome: string | null;
        last_error: string | null;
      }>;
      assert.ok(rawRows.some((effect) => effect.kind === "rpc_install_host_grant"));
      assert.equal(
        JSON.stringify(rawRows).includes(secretGrant),
        false,
        "SQLite effects table must never contain supervisor_grant",
      );
    } finally {
      db.close();
    }

    // In-memory pending invocation map is wiped immediately on execution.
    const pendingSize = (daemon as unknown as { asyncRpcEffects: { pending: Map<string, unknown> } })
      .asyncRpcEffects.pending.size;
    assert.equal(pendingSize, 0, "transient invocation closures must not remain resident after completion");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("startup recovery fails unstarted prepared async RPC effects and marks interrupted executing ones uncertain without replaying", async () => {
  const env = await fixture();
  const dbPath = join(env.root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const noopFence = () => {};
  try {
    const preparedOnly = prepareEffect(stateDb.connection, noopFence, {
      id: "rpc:rpc_retire_agent:orphan-prepared",
      agent_id: "agent-crash-1",
      kind: "rpc_retire_agent",
      idempotency_key: "rpc:rpc_retire_agent:orphan-prepared",
      epoch: 1,
      payload: { method: "supervisor.retire_agent", entry_id: "agent-crash-1", daemon_generation: 1 },
      retryable: false,
      max_attempts: 1,
    }, "2026-11-22T00:00:00.000Z").effect;

    const executingInterrupted = prepareEffect(stateDb.connection, noopFence, {
      id: "rpc:rpc_recover_agent_runtime:orphan-executing",
      agent_id: "agent-crash-2",
      kind: "rpc_recover_agent_runtime",
      idempotency_key: "rpc:rpc_recover_agent_runtime:orphan-executing",
      epoch: 1,
      payload: { method: "supervisor.recover_agent_runtime", entry_id: "agent-crash-2", daemon_generation: 1 },
      retryable: false,
      max_attempts: 1,
    }, "2026-11-22T00:00:00.000Z").effect;
    claimEffectForExecution(stateDb.connection, noopFence, {
      id: executingInterrupted.id,
      daemonGeneration: 1,
      nowMs: 1_000,
      nowIso: "2026-11-22T00:00:01.000Z",
    });

    const executor = new EffectExecutor({
      getDatabase: () => stateDb.connection,
      currentDaemonGeneration: () => 2,
      assertCurrent: async () => undefined,
      assertWriteFence: noopFence,
      isClosing: () => false,
    });
    const coordinator = new AsyncRpcEffectCoordinator({
      getExecutor: () => executor,
      notifyImmediate: () => undefined,
    });
    coordinator.registerHandlers(executor);

    const report = await executor.recoverOnStartup();
    assert.deepEqual(report.fencedOrphanPreparedIds, [preparedOnly.id]);
    assert.deepEqual(report.uncertainIds, [executingInterrupted.id]);
    assert.deepEqual(report.requeuedIds, []);

    const afterPrepared = getEffect(stateDb.connection, preparedOnly.id);
    assert.equal(afterPrepared?.state, "failed");
    assert.match(afterPrepared?.last_error ?? "", /restarted before this generation-scoped RPC effect started/i);

    const afterExecuting = getEffect(stateDb.connection, executingInterrupted.id);
    assert.equal(afterExecuting?.state, "uncertain");
  } finally {
    stateDb.close();
    await env.cleanup();
  }
});

test("SupervisorDaemon.stop detaches a wedged async RPC effect promptly and settles it uncertain", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  let wedgedStarted!: () => void;
  const entered = new Promise<void>((resolve) => { wedgedStarted = resolve; });
  const daemon = new SupervisorDaemon(
    paths,
    "darwin",
    undefined,
    false,
    15_000,
    undefined,
    {},
    {
      latest: async () => ({ messages: [] }),
      poll: async () => ({ messages: [] }),
      publish: async () => {},
    },
    {
      ...noWorkLeaseHttp,
      // Deliberately ignores abort signal to simulate a hung external call.
      createWorkerSession: () => new Promise<never>(() => { wedgedStarted(); }),
    },
  );
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: {
        ...entry,
        id: "wedged_rpc_agent",
        provider: "codex",
        delivery_mode: "daemon_inbox",
        desired_state: "paused",
        observed_state: "absent",
      },
    })).ok, true);
    const generation = ((await daemonRawRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "wedged_rpc_agent",
      room_id: entry.room_id,
      agent_key: "owner/agent",
      grant_id: "grant-wedged",
      supervisor_grant: "wedged-secret",
      grant_generation: 1,
      api_url: "https://letagents.example",
      host_id: "host-1",
      installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
    })).ok, true);

    const accepted = (await daemonRawRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "wedged_rpc_agent",
      daemon_generation: generation,
    })).result as { effect_id: string; daemon_generation: number };
    await within(entered, "wedged async RPC enters remote call", 2_000);

    await within(daemon.stop(), "daemon.stop must not hang on wedged async RPC", 1_500);

    const db = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try {
      const row = getEffect(db, accepted.effect_id);
      assert.ok(row);
      assert.equal(row.state, "uncertain");
      assert.match(row.last_error ?? "", /stopped or handed off/i);
    } finally {
      db.close();
    }
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("AsyncRpcEffectCoordinator projects oversized recovery entry outcomes to fit journal bounds", async () => {
  const env = await fixture();
  const dbPath = join(env.root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const noopFence = () => {};
  let notifications = 0;
  try {
    const executor = new EffectExecutor({
      getDatabase: () => stateDb.connection,
      currentDaemonGeneration: () => 3,
      assertCurrent: async () => undefined,
      assertWriteFence: noopFence,
      isClosing: () => false,
    });
    let settledSignal!: () => void;
    const settledPromise = new Promise<void>((resolve) => { settledSignal = resolve; });
    const coordinator = new AsyncRpcEffectCoordinator({
      getExecutor: () => executor,
      notifyImmediate: () => {
        notifications += 1;
        settledSignal();
      },
    });
    coordinator.registerHandlers(executor);

    const hugeEntry = {
      ...entry,
      id: "huge_recovery_agent",
      workplace_liveness: { state: "unknown", observed_at: null, detail: null },
      native_liveness: { state: "unknown", observed_at: null, detail: null },
      activity: Array.from({ length: 120 }, (_unused, index) => ({
        observed_at: "2026-11-22T00:00:00.000Z",
        sequence: index + 1,
        provider: "codex",
        kind: "provider_stream",
        method: "item/tool_call",
        summary: `step ${index + 1}`,
        status: "working",
        payload: { blob: "x".repeat(4_000) },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      })),
    };
    assert.ok(Buffer.byteLength(JSON.stringify({ outcome: "recovering", entry: hugeEntry }), "utf8") > MAX_EFFECT_OUTCOME_BYTES);

    const accepted = await coordinator.submitRecoverAgentRuntime(
      { entryId: "huge_recovery_agent", daemonGeneration: 3 },
      async () => ({ outcome: "recovering", entry: hugeEntry }),
    );
    await within(settledPromise, "oversized recovery outcome settles", 2_000);
    await executor.fenceAndDrain();

    assert.equal(notifications, 1);
    const views = coordinator.listForGeneration(3);
    const view = views.find((item: DaemonRpcEffectView) => item.effect_id === accepted.effect_id);
    assert.equal(view?.state, "completed");
    const outcome = view?.result as { outcome: string; entry: { id: string; activity: Array<{ payload: unknown }> } };
    assert.equal(outcome.outcome, "recovering");
    assert.equal(outcome.entry.id, "huge_recovery_agent");
    assert.ok(outcome.entry.activity.every((item) => item.payload === null));
  } finally {
    stateDb.close();
    await env.cleanup();
  }
});

test("SupervisorDaemonClient succeeds over a real daemon when async RPC execution outlives requestTimeoutMs", async () => {
  const env = await fixture();
  const previousAllow = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  const previousRuntimeFp = process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
  const previousCompatFp = process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
  const spawnEnv = supervisorDaemonSpawnEnvironment();
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = spawnEnv.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
  process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = spawnEnv.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const ackTimeoutMs = process.platform === "win32" ? 1_200 : 250;
  const executionDelayMs = ackTimeoutMs + 300;
  const daemon = new SupervisorDaemon(
    paths,
    process.platform === "win32" ? "win32" : "darwin",
    undefined,
    false,
    15_000,
    undefined,
    {},
    {
      latest: async () => ({ messages: [{ id: "99" }] }),
      poll: async () => ({ messages: [] }),
      publish: async () => {},
    },
    {
      ...noWorkLeaseHttp,
      createWorkerSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, executionDelayMs));
        return {
          sessionId: "session-client-1",
          bearer: "bearer-client-1",
          bearerId: "bearer-id-client-1",
          expiresAt: null,
        };
      },
    },
  );
  try {
    await daemon.start();
    const client = new SupervisorDaemonClient({
      stateDir: env.root,
      socketPath: paths.socketPath,
      peerProofPath: paths.peerProofPath,
      requestTimeoutMs: ackTimeoutMs,
      spawnDaemon: () => { throw new Error("must reuse running daemon"); },
    });
    const status = await client.connectIfRunning();
    assert.ok(status);
    assert.equal(status.capabilities.agentStateSubscription, true);
    await daemonRequest(paths.socketPath, "manifest.put", {
      entry: {
        ...entry,
        id: "client_async_agent",
        provider: "codex",
        delivery_mode: "daemon_inbox",
        desired_state: "paused",
        observed_state: "absent",
      },
    });
    assert.equal(await client.installHostGrant({
      entryId: "client_async_agent",
      roomId: entry.room_id,
      agentKey: "owner/agent",
      grantId: "grant-client",
      supervisorGrant: "client-secret-grant",
      grantGeneration: 1,
      daemonGeneration: status.generation,
      hostId: "host-1",
      installationId: "installation-1",
      ownerAccountId: null,
      scopeKey: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      apiUrl: "https://letagents.example",
    }), "installed");

    const startedAt = Date.now();
    const bootstrapOutcome = await client.bootstrapRoomIngress("client_async_agent", status.generation);
    assert.equal(bootstrapOutcome, "bootstrapped");
    assert.ok(
      Date.now() - startedAt >= executionDelayMs - 50,
      "async RPC execution outlived requestTimeoutMs while socket acknowledgement stayed bounded",
    );
  } finally {
    await daemon.stop().catch(() => undefined);
    if (previousAllow === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousAllow;
    if (previousRuntimeFp === undefined) delete process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
    else process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = previousRuntimeFp;
    if (previousCompatFp === undefined) delete process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
    else process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = previousCompatFp;
    await env.cleanup();
  }
});

test("post-action throws settle as uncertain while explicit pre-execution refusals settle as failed", async () => {
  const env = await fixture();
  const dbPath = join(env.root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const noopFence = () => {};
  let notifyResolvers: Array<() => void> = [];
  const waitForNotify = () => new Promise<void>((resolve) => { notifyResolvers.push(resolve); });
  try {
    const executor = new EffectExecutor({
      getDatabase: () => stateDb.connection,
      currentDaemonGeneration: () => 5,
      assertCurrent: async () => undefined,
      assertWriteFence: noopFence,
      isClosing: () => false,
    });
    const coordinator = new AsyncRpcEffectCoordinator({
      getExecutor: () => executor,
      notifyImmediate: () => {
        const pending = notifyResolvers;
        notifyResolvers = [];
        for (const resolve of pending) resolve();
      },
    });
    coordinator.registerHandlers(executor);

    // 1. Simulated external action followed by response-loss throw -> durable row AND watch view are `uncertain`.
    let externalActions = 0;
    const firstNotified = waitForNotify();
    const uncertainAccepted = await coordinator.submitRetireAgent(
      { entryId: "agent-throw", daemonGeneration: 5, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
      async () => {
        externalActions += 1;
        throw new Error("socket closed before response arrived");
      },
    );
    await within(firstNotified, "post-action throw settles", 2_000);
    assert.equal(externalActions, 1);
    const durableUncertain = getEffect(stateDb.connection, uncertainAccepted.effect_id);
    assert.equal(durableUncertain?.state, "uncertain");
    assert.match(durableUncertain?.last_error ?? "", /socket closed before response arrived/i);
    assert.match(durableUncertain?.last_error ?? "", /verify external state before repeating/i);
    const viewUncertain = coordinator.getForGeneration(uncertainAccepted.effect_id, 5);
    assert.equal(viewUncertain?.state, "uncertain");
    assert.match(viewUncertain?.error ?? "", /verify external state before repeating/i);

    // 2. Explicit pre-execution refusal -> durable row AND watch view are `failed`.
    const secondNotified = waitForNotify();
    const refusedAccepted = await coordinator.submitRetireAgent(
      { entryId: "agent-refused", daemonGeneration: 5, hasRevokedAgentSessionId: false, grantRevokedWithoutWorkerSession: false },
      async () => {
        throw new AsyncRpcPreExecutionRefusalError("entry cannot retire while active turn is running");
      },
    );
    await within(secondNotified, "pre-execution refusal settles", 2_000);
    const durableRefused = getEffect(stateDb.connection, refusedAccepted.effect_id);
    assert.equal(durableRefused?.state, "failed");
    assert.equal(durableRefused?.last_error, "entry cannot retire while active turn is running");
    assert.equal(coordinator.getForGeneration(refusedAccepted.effect_id, 5)?.state, "failed");

    await executor.fenceAndDrain();
  } finally {
    stateDb.close();
    await env.cleanup();
  }
});

test("failed completion or uncertain journal settlement publishes uncertain with unrecorded-receipt guidance, never failed", async () => {
  const env = await fixture();
  const dbPath = join(env.root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const noopFence = () => {};
  let notifyResolvers: Array<() => void> = [];
  const waitForNotify = () => new Promise<void>((resolve) => { notifyResolvers.push(resolve); });
  try {
    stateDb.connection.exec(`
      CREATE TRIGGER reject_completed_update
      BEFORE UPDATE ON effects
      WHEN NEW.state = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'injected completion write failure');
      END;
      CREATE TRIGGER reject_uncertain_update
      BEFORE UPDATE ON effects
      WHEN NEW.state = 'uncertain'
      BEGIN
        SELECT RAISE(ABORT, 'injected uncertain write failure');
      END;
    `);
    const executor = new EffectExecutor({
      getDatabase: () => stateDb.connection,
      currentDaemonGeneration: () => 6,
      assertCurrent: async () => undefined,
      assertWriteFence: noopFence,
      isClosing: () => false,
    });
    const coordinator = new AsyncRpcEffectCoordinator({
      getExecutor: () => executor,
      notifyImmediate: () => {
        const pending = notifyResolvers;
        notifyResolvers = [];
        for (const resolve of pending) resolve();
      },
    });
    coordinator.registerHandlers(executor);

    // Case A: action succeeds in memory, completion write rejected by SQLite trigger.
    let retirementCalls = 0;
    const completedWriteRejected = waitForNotify();
    const acceptedA = await coordinator.submitRetireAgent(
      { entryId: "agent-write-fail-1", daemonGeneration: 6, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
      async () => {
        retirementCalls += 1;
        return { outcome: "retired" as const };
      },
    );
    await within(completedWriteRejected, "failed completion settlement notifies watch", 2_000);
    assert.equal(retirementCalls, 1);
    assert.equal(getEffect(stateDb.connection, acceptedA.effect_id)?.state, "executing");
    const viewA = coordinator.getForGeneration(acceptedA.effect_id, 6);
    assert.equal(viewA?.state, "uncertain", "must never fabricate confirmed failure after action completed");
    assert.match(viewA?.error ?? "", /injected completion write failure/);
    assert.match(viewA?.error ?? "", /could not be recorded in the effect journal/i);
    assert.match(viewA?.error ?? "", /verify external state before repeating/i);

    // Case B: post-action throw AND uncertain settlement write also rejected by SQLite trigger.
    const uncertainWriteRejected = waitForNotify();
    const acceptedB = await coordinator.submitRetireAgent(
      { entryId: "agent-write-fail-2", daemonGeneration: 6, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
      async () => {
        throw new Error("remote confirmation timed out");
      },
    );
    await within(uncertainWriteRejected, "failed uncertain settlement notifies watch", 2_000);
    assert.equal(getEffect(stateDb.connection, acceptedB.effect_id)?.state, "executing");
    const viewB = coordinator.getForGeneration(acceptedB.effect_id, 6);
    assert.equal(viewB?.state, "uncertain");
    assert.match(viewB?.error ?? "", /remote confirmation timed out/);
    assert.match(viewB?.error ?? "", /injected uncertain write failure/);
    assert.match(viewB?.error ?? "", /could not be recorded in the effect journal/i);
    assert.match(viewB?.error ?? "", /verify external state before repeating/i);

    await executor.fenceAndDrain();
  } finally {
    stateDb.close();
    await env.cleanup();
  }
});

test("SupervisorDaemonClient recovers accepted async RPC result from SQLite after 257 completions evict it from the watch cache", async () => {
  const env = await fixture();
  const previousAllow = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  const previousRuntimeFp = process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
  const previousCompatFp = process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
  const spawnEnv = supervisorDaemonSpawnEnvironment();
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = spawnEnv.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
  process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = spawnEnv.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;

  const dbPath = join(env.root, "daemon-state.sqlite");
  const endpoint = testDaemonEndpoint(env.root);
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const noopFence = () => {};
  const generation = 9;
  let settledCount = 0;
  let resolveAllSettled!: () => void;
  const allSettled = new Promise<void>((resolve) => { resolveAllSettled = resolve; });
  const totalEffects = MAX_RETAINED_SETTLED_RPC_EFFECTS + 1;

  const executor = new EffectExecutor({
    getDatabase: () => stateDb.connection,
    currentDaemonGeneration: () => generation,
    assertCurrent: async () => undefined,
    assertWriteFence: noopFence,
    isClosing: () => false,
  });
  let stateWatch!: DaemonStateWatch;
  const coordinator = new AsyncRpcEffectCoordinator({
    getExecutor: () => executor,
    notifyImmediate: () => {
      settledCount += 1;
      stateWatch?.notifyImmediate();
      if (settledCount >= totalEffects) resolveAllSettled();
    },
  });
  stateWatch = new DaemonStateWatch({
    currentGeneration: () => generation,
    isHandoffScheduled: () => false,
    assertCurrent: async () => undefined,
    entries: async () => [],
    rpcEffects: (gen) => coordinator.listForGeneration(gen),
    rpcEffectEvictionVersion: (gen) => coordinator.evictionVersion(gen),
  });
  coordinator.registerHandlers(executor);

  let firstAccepted!: { effect_id: string; daemon_generation: number };
  let lookupCalls = 0;
  let replayFirstNext = false;
  let returnUnknownNext = false;
  const socket = new DaemonControlSocket(
    endpoint.socketPath,
    async (request) => {
      if (request.method === "daemon.negotiate" || request.method === "daemon.status") {
        return {
          healthy: true,
          protocol_version: DAEMON_PROTOCOL_VERSION,
          implementation_version: DAEMON_IMPLEMENTATION_VERSION,
          runtime_environment_fingerprint: spawnEnv.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT,
          compatibility_fingerprint: spawnEnv.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT,
          capabilities: {
            agent_lifecycle_v1: true,
            agent_state_subscription_v1: true,
            async_rpc_effects_v1: true,
          },
          generation,
          pid: process.pid,
          started_at: "2026-11-22T00:00:00.000Z",
        };
      }
      if (request.method === "manifest.watch_state") {
        const params = (request.params ?? {}) as {
          after_daemon_generation?: number;
          after_sequence?: number;
          wait_ms?: number;
          changed_only?: boolean;
        };
        return stateWatch.watch({
          afterDaemonGeneration: params.after_daemon_generation ?? 0,
          afterSequence: params.after_sequence ?? 0,
          waitMs: params.wait_ms ?? 5_000,
          changedOnly: params.changed_only === true,
        });
      }
      if (request.method === "supervisor.get_rpc_effect") {
        lookupCalls += 1;
        const params = request.params as { effect_id: string; daemon_generation: number };
        return coordinator.getForGeneration(params.effect_id, params.daemon_generation);
      }
      if (request.method === "supervisor.retire_agent") {
        if (returnUnknownNext) {
          returnUnknownNext = false;
          return { effect_id: "rpc:rpc_retire_agent:never-existed", daemon_generation: generation };
        }
        if (replayFirstNext) {
          replayFirstNext = false;
          return firstAccepted;
        }
        return coordinator.submitRetireAgent(
          { entryId: "agent-live", daemonGeneration: generation, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
          async () => ({ outcome: "retired" as const }),
        );
      }
      throw new Error(`Unexpected test method: ${request.method}`);
    },
    undefined,
    undefined,
    { peerProofPath: endpoint.peerProofPath ?? null },
  );

  try {
    await socket.start();

    // Complete 257 effects through the real coordinator/executor so #1 is evicted from the 256-entry watch cache.
    firstAccepted = await coordinator.submitRetireAgent(
      { entryId: "agent-0", daemonGeneration: generation, hasRevokedAgentSessionId: false, grantRevokedWithoutWorkerSession: false },
      async () => ({ outcome: "revocation_required" as const, revocation_kind: "grant_only" as const }),
    );
    for (let i = 1; i < totalEffects; i += 1) {
      await coordinator.submitRetireAgent(
        { entryId: `agent-${i}`, daemonGeneration: generation, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
        async () => ({ outcome: "retired" as const }),
      );
    }
    await within(allSettled, "257 async RPC effects settle", 10_000);

    // Prove #1 is durably completed in SQLite yet evicted from the bounded 256-item watch cache.
    const watchList = coordinator.listForGeneration(generation);
    assert.equal(watchList.length, MAX_RETAINED_SETTLED_RPC_EFFECTS);
    assert.equal(watchList.some((item) => item.effect_id === firstAccepted.effect_id), false);
    assert.equal(getEffect(stateDb.connection, firstAccepted.effect_id)?.state, "completed");

    // Delayed SupervisorDaemonClient awaits #1's acknowledgement and recovers it via supervisor.get_rpc_effect.
    const client = new SupervisorDaemonClient({
      stateDir: env.root,
      socketPath: endpoint.socketPath,
      peerProofPath: endpoint.peerProofPath,
      requestTimeoutMs: process.platform === "win32" ? 2_000 : 1_000,
      spawnDaemon: () => { throw new Error("must reuse running test socket"); },
    });
    replayFirstNext = true;
    const recovered = await within(
      client.retireAgent("agent-0", generation),
      "delayed client recovers evicted effect #1 without generation change",
      3_000,
    );
    assert.deepEqual(recovered, { outcome: "revocation_required", revocationKind: "grant_only" });
    assert.equal(lookupCalls, 1, "durable lookup fires once for the evicted effect");

    // Truly unknown effect id fails promptly instead of hanging forever.
    returnUnknownNext = true;
    await assert.rejects(
      () => within(client.retireAgent("agent-missing", generation), "unknown effect fails promptly", 3_000),
      /no record of async RPC effect/,
    );
    await executor.fenceAndDrain();
  } finally {
    stateWatch.close();
    await socket.stop().catch(() => undefined);
    stateDb.close();
    if (previousAllow === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousAllow;
    if (previousRuntimeFp === undefined) delete process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
    else process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = previousRuntimeFp;
    if (previousCompatFp === undefined) delete process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
    else process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = previousCompatFp;
    await env.cleanup();
  }
});

test("unrecorded terminal outcomes remain recoverable after watch-cache eviction and even after unrecorded-cache overflow", async () => {
  const env = await fixture();
  const previousAllow = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  const previousRuntimeFp = process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
  const previousCompatFp = process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
  const spawnEnv = supervisorDaemonSpawnEnvironment();
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = spawnEnv.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
  process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = spawnEnv.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;

  const dbPath = join(env.root, "daemon-state.sqlite");
  const endpoint = testDaemonEndpoint(env.root);
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const noopFence = () => {};
  const generation = 10;
  let settledCount = 0;
  let resolveFirstSettled!: () => void;
  const firstSettled = new Promise<void>((resolve) => { resolveFirstSettled = resolve; });
  let resolveAllSettled!: () => void;
  const allSettled = new Promise<void>((resolve) => { resolveAllSettled = resolve; });
  const totalEffects = MAX_RETAINED_SETTLED_RPC_EFFECTS + 1;

  // Reject completion/uncertain SQLite updates only for the targeted effect agent.
  stateDb.connection.exec(`
    CREATE TRIGGER reject_target_settlement
    BEFORE UPDATE ON effects
    WHEN OLD.agent_id = 'agent-unrecorded-evicted' AND NEW.state IN ('completed', 'uncertain')
    BEGIN
      SELECT RAISE(ABORT, 'injected target completion write failure');
    END;
  `);

  const executor = new EffectExecutor({
    getDatabase: () => stateDb.connection,
    currentDaemonGeneration: () => generation,
    assertCurrent: async () => undefined,
    assertWriteFence: noopFence,
    isClosing: () => false,
  });
  let stateWatch!: DaemonStateWatch;
  const coordinator = new AsyncRpcEffectCoordinator({
    getExecutor: () => executor,
    notifyImmediate: () => {
      settledCount += 1;
      stateWatch?.notifyImmediate();
      if (settledCount === 1) resolveFirstSettled();
      if (settledCount >= totalEffects) resolveAllSettled();
    },
  });
  stateWatch = new DaemonStateWatch({
    currentGeneration: () => generation,
    isHandoffScheduled: () => false,
    assertCurrent: async () => undefined,
    entries: async () => [],
    rpcEffects: (gen) => coordinator.listForGeneration(gen),
    rpcEffectEvictionVersion: (gen) => coordinator.evictionVersion(gen),
  });
  coordinator.registerHandlers(executor);

  let failedWriteAccepted!: { effect_id: string; daemon_generation: number };
  let lookupCalls = 0;
  const socket = new DaemonControlSocket(
    endpoint.socketPath,
    async (request) => {
      if (request.method === "daemon.negotiate" || request.method === "daemon.status") {
        return {
          healthy: true,
          protocol_version: DAEMON_PROTOCOL_VERSION,
          implementation_version: DAEMON_IMPLEMENTATION_VERSION,
          runtime_environment_fingerprint: spawnEnv.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT,
          compatibility_fingerprint: spawnEnv.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT,
          capabilities: {
            agent_lifecycle_v1: true,
            agent_state_subscription_v1: true,
            async_rpc_effects_v1: true,
          },
          generation,
          pid: process.pid,
          started_at: "2026-11-22T00:00:00.000Z",
        };
      }
      if (request.method === "manifest.watch_state") {
        const params = (request.params ?? {}) as {
          after_daemon_generation?: number;
          after_sequence?: number;
          wait_ms?: number;
          changed_only?: boolean;
        };
        return stateWatch.watch({
          afterDaemonGeneration: params.after_daemon_generation ?? 0,
          afterSequence: params.after_sequence ?? 0,
          waitMs: params.wait_ms ?? 5_000,
          changedOnly: params.changed_only === true,
        });
      }
      if (request.method === "supervisor.get_rpc_effect") {
        lookupCalls += 1;
        const params = request.params as { effect_id: string; daemon_generation: number };
        return coordinator.getForGeneration(params.effect_id, params.daemon_generation);
      }
      if (request.method === "supervisor.retire_agent") {
        return failedWriteAccepted;
      }
      throw new Error(`Unexpected test method: ${request.method}`);
    },
    undefined,
    undefined,
    { peerProofPath: endpoint.peerProofPath ?? null },
  );

  try {
    await socket.start();

    let externalRuns = 0;
    failedWriteAccepted = await coordinator.submitRetireAgent(
      { entryId: "agent-unrecorded-evicted", daemonGeneration: generation, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
      async () => {
        externalRuns += 1;
        return { outcome: "retired" as const };
      },
    );
    await within(firstSettled, "unrecorded effect #1 settles before subsequent 256 completions", 2_000);
    assert.equal(coordinator.getForGeneration(failedWriteAccepted.effect_id, generation)?.state, "uncertain");

    for (let i = 1; i < totalEffects; i += 1) {
      await coordinator.submitRetireAgent(
        { entryId: `agent-ok-${i}`, daemonGeneration: generation, hasRevokedAgentSessionId: true, grantRevokedWithoutWorkerSession: false },
        async () => ({ outcome: "retired" as const }),
      );
    }
    await within(allSettled, "1 unrecorded + 256 completed effects settle", 10_000);
    assert.equal(externalRuns, 1);

    // SQLite still holds `executing`, and watch cache evicted the unrecorded view.
    assert.equal(getEffect(stateDb.connection, failedWriteAccepted.effect_id)?.state, "executing");
    const watchList = coordinator.listForGeneration(generation);
    assert.equal(watchList.length, MAX_RETAINED_SETTLED_RPC_EFFECTS);
    assert.equal(watchList.some((item) => item.effect_id === failedWriteAccepted.effect_id), false);

    // Delayed SupervisorDaemonClient settles immediately with truthful uncertainty guidance (never hangs).
    const client = new SupervisorDaemonClient({
      stateDir: env.root,
      socketPath: endpoint.socketPath,
      peerProofPath: endpoint.peerProofPath,
      requestTimeoutMs: process.platform === "win32" ? 2_000 : 1_000,
      spawnDaemon: () => { throw new Error("must reuse running test socket"); },
    });
    await assert.rejects(
      () => within(
        client.retireAgent("agent-unrecorded-evicted", generation),
        "delayed client settles unrecorded evicted outcome without hanging",
        3_000,
      ),
      /injected target completion write failure.*verify external state before repeating/i,
    );
    assert.equal(lookupCalls, 1);

    // Layer 2 proof: even if BOTH in-memory caches overflow (small limit = 1) or an unstarted
    // prepared row has no active execution in this generation, getForGeneration never returns
    // stale `executing`/`prepared`.
    const smallCoordinator = new AsyncRpcEffectCoordinator({
      getExecutor: () => executor,
      notifyImmediate: () => undefined,
      maxRetainedSettled: 1,
    });
    // Directly insert an orphaned unstarted prepared row in the same generation with no active run.
    const orphanPrepared = prepareEffect(stateDb.connection, noopFence, {
      id: "rpc:rpc_retire_agent:orphan-pre-exec-same-gen",
      agent_id: "agent-pre-exec-fail",
      kind: "rpc_retire_agent",
      idempotency_key: "rpc:rpc_retire_agent:orphan-pre-exec-same-gen",
      epoch: generation,
      payload: { method: "supervisor.retire_agent", entry_id: "agent-pre-exec-fail", daemon_generation: generation },
      retryable: false,
      max_attempts: 1,
    }, "2026-11-22T00:00:00.000Z").effect;

    // `smallCoordinator` has empty in-memory caches; both rows live only in SQLite with no active execution.
    const synthesizedUncertain = smallCoordinator.getForGeneration(failedWriteAccepted.effect_id, generation);
    assert.equal(synthesizedUncertain?.state, "uncertain");
    assert.match(synthesizedUncertain?.error ?? "", /could not be recorded in the effect journal/i);
    assert.match(synthesizedUncertain?.error ?? "", /verify external state before repeating/i);

    const synthesizedPreExecFailed = smallCoordinator.getForGeneration(orphanPrepared.id, generation);
    assert.equal(synthesizedPreExecFailed?.state, "failed");
    assert.match(synthesizedPreExecFailed?.error ?? "", /did not start.*no failure receipt was recorded/i);

    await executor.fenceAndDrain();
  } finally {
    stateWatch.close();
    await socket.stop().catch(() => undefined);
    stateDb.close();
    if (previousAllow === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousAllow;
    if (previousRuntimeFp === undefined) delete process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
    else process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = previousRuntimeFp;
    if (previousCompatFp === undefined) delete process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT;
    else process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = previousCompatFp;
    await env.cleanup();
  }
});
