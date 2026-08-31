import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeliveryCutoverExecutionCoordinator, type DeliveryCutoverExecutionCoordinatorOptions } from "../delivery-cutover-execution-coordinator.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import type { InstalledHostGrant } from "../worker-runtime-custody.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import { ManifestStore } from "../manifest-store.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { processBirthState, sameProcessBirthIdentity } from "../process-identity.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { DaemonManifestEntry, TaskWorkAttempt } from "../types.js";

import {
  DeliveryCutoverCoordinator,
  DeliveryCutoverObservationDetached,
  type DeliveryCutoverRetryTimer,
} from "../delivery-cutover-coordinator.js";

test("start coalesces one in-flight request per entry and admits a successor after settlement", async () => {
  const firstGate = deferred<void>();
  let drives = 0;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async () => {
      drives += 1;
      if (drives === 1) await firstGate.promise;
    },
  });

  const first = coordinator.start("agent");
  const duplicate = coordinator.start("agent");
  assert.equal(duplicate, first);
  assert.equal(drives, 1);

  firstGate.resolve();
  await first;
  await coordinator.start("agent");
  assert.equal(drives, 2);
});

test("different entries have independent requests and a rejection does not strand a slot", async () => {
  const calls = new Map<string, number>();
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async (entryId) => {
      const call = (calls.get(entryId) ?? 0) + 1;
      calls.set(entryId, call);
      if (entryId === "left" && call === 1) throw new Error("drive failed");
    },
  });

  await Promise.all([
    assert.rejects(coordinator.start("left"), /drive failed/),
    coordinator.start("right"),
  ]);
  await coordinator.start("left");
  assert.deepEqual([...calls], [["left", 2], ["right", 1]]);
});

test("fenceAndDrain aborts observations and absorbs admitted request failures", async () => {
  let coordinator!: DeliveryCutoverCoordinator;
  const signals: AbortSignal[] = [];
  coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async (_entryId, signal) => {
      signals.push(signal);
      await coordinator.observe(signal, new Promise<void>(() => undefined));
    },
  });

  const left = coordinator.start("left");
  const right = coordinator.start("right");
  await coordinator.fenceAndDrain();

  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => signal.aborted), true);
  await assert.rejects(left, DeliveryCutoverObservationDetached);
  await assert.rejects(right, DeliveryCutoverObservationDetached);
});

test("fenceAndDrain waits for a driver that is still settling after abort", async () => {
  const gate = deferred<void>();
  let signal: AbortSignal | null = null;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async (_entryId, detachSignal) => {
      signal = detachSignal;
      await gate.promise;
    },
  });
  const operation = coordinator.start("agent");
  let drained = false;
  const drain = coordinator.fenceAndDrain().then(() => { drained = true; });

  await Promise.resolve();
  assert.equal(signal?.aborted, true);
  assert.equal(drained, false);
  gate.resolve();
  await operation;
  await drain;
  assert.equal(drained, true);
});

test("assertObservation detaches on either abort or daemon handoff", () => {
  let handoff = false;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => handoff,
    drive: async () => undefined,
  });
  const controller = new AbortController();

  assert.doesNotThrow(() => coordinator.assertObservation(controller.signal));
  handoff = true;
  assert.throws(() => coordinator.assertObservation(controller.signal), DeliveryCutoverObservationDetached);
  handoff = false;
  controller.abort();
  assert.throws(() => coordinator.assertObservation(controller.signal), DeliveryCutoverObservationDetached);
});

test("observe rejects a detached fulfillment but preserves an underlying rejection", async () => {
  let handoff = false;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => handoff,
    drive: async () => undefined,
  });
  const controller = new AbortController();
  const fulfilledGate = deferred<string>();
  const fulfillment = coordinator.observe(controller.signal, fulfilledGate.promise);
  handoff = true;
  fulfilledGate.resolve("terminal");
  await assert.rejects(fulfillment, DeliveryCutoverObservationDetached);

  handoff = false;
  const rejectedGate = deferred<string>();
  const rejection = coordinator.observe(controller.signal, rejectedGate.promise);
  handoff = true;
  rejectedGate.reject(new Error("provider inspection failed"));
  await assert.rejects(rejection, /provider inspection failed/);
});

test("observe detaches immediately on abort without waiting for the provider operation", async () => {
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async () => undefined,
  });
  const controller = new AbortController();
  const never = new Promise<void>(() => undefined);
  const observation = coordinator.observe(controller.signal, never);

  controller.abort();
  await assert.rejects(observation, DeliveryCutoverObservationDetached);
});

test("scheduleRetry preserves delay, unreferences its timer, and swallows drive rejection", async () => {
  let scheduled: { callback: () => void; delayMs: number; unrefCalls: number } | null = null;
  let driveCalls = 0;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async () => {
      driveCalls += 1;
      throw new Error("retry failed");
    },
    setRetryTimeout: (callback, delayMs): DeliveryCutoverRetryTimer => {
      const record = { callback, delayMs, unrefCalls: 0 };
      scheduled = record;
      return { unref: () => { record.unrefCalls += 1; } };
    },
  });

  coordinator.scheduleRetry("agent", 1_000);
  assert.ok(scheduled);
  assert.equal(scheduled.delayMs, 1_000);
  assert.equal(scheduled.unrefCalls, 1);
  scheduled.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(driveCalls, 1);
});

test("reverse drain refuses unsupported target before admission, join, or native stop", async () => {
  const env = await reverseFixture();
  try {
    env.state.preflightError = new Error("resolved MCP lacks custodial_polling_v1");
    await assert.rejects(env.driver().prepareDrain(env.request), /resolved MCP lacks/);
    assert.equal(await env.store.unresolvedDeliveryDrain("agent"), null);
    assert.deepEqual(env.events, ["preflight"]);
    assert.equal((await env.store.getEntry("agent"))?.delivery_mode, "daemon_inbox");
  } finally { await env.close(); }
});

test("reverse drain lets admitted A publish, joins ingress, and transfers only its settled cursor", async () => {
  const env = await reverseFixture();
  try {
    const [a] = await env.inbox.ingestPoll({ agent_id: "agent", room_id: "room", last_observed_message_id: "101",
      messages: [{ source_message_id: "101", source_message: {}, activation: {} }] });
    await env.inbox.claimHead("agent");
    await env.inbox.checkpointTurnStarted(a!.inbox_item_id, "A", { work_attempt_id: "work", origin_execution_generation_id: "run", provider_continuation_id: "thread" });
    env.state.activeTurn = "A";
    const driver = env.driver();
    assert.equal((await driver.prepareDrain(env.request)).phase, "draining");
    await driver.drive("agent", env.signal);
    assert.equal(env.events.includes("join"), false, "active A must not be aborted by joining its pump");
    await env.inbox.checkpointNormalizedTerminal({ inbox_item_id: a!.inbox_item_id, agent_id: "agent", execution_generation_id: "run",
      provider_turn_id: "A", outcome: "reply", text: "finished", evidence: "stream", terminal_evidence: { turnId: "A" } });
    await env.inbox.transition(a!.inbox_item_id, "awaiting_result");
    await env.inbox.transition(a!.inbox_item_id, "publishing");
    env.state.activeTurn = null;
    await driver.drive("agent", env.signal);
    assert.equal(env.events.includes("stop"), false, "provider completion alone does not settle room publication");
    await env.inbox.checkpointPublication({ inbox_item_id: a!.inbox_item_id, room_id: "room", canonical_message_id: "102" });
    await driver.drive("agent", env.signal);
    assert.equal((await driver.getDrain(env.request)).phase, "complete");
    assert.equal((await env.store.getAgentConfiguration("agent"))?.polling_contract, "custodial_polling_v1");
    assert.equal(env.checkpoint(), "101", "the daemon ingestion cursor, not a room tail or stale worker ACK, transfers");
    assert.ok(env.events.indexOf("join") < env.events.indexOf("stop"));
    assert.equal(env.events.includes("start"), false, "mode commit must not activate a polling turn");
    assert.equal((await driver.prepareDrain(env.request)).phase, "complete", "lost response is an idempotent receipt");
    await driver.drive("agent", env.signal);
    assert.equal(env.events.filter((event) => event === "stop").length, 1);
    await assert.rejects(driver.prepareDrain({ ...env.request, requestId: "different" }), /identity changed/);
  } finally { await env.close(); }
});

test("a late B during joined ingress cancels the pre-dispatch switch and restarts delivery without skipping B", async () => {
  const env = await reverseFixture();
  try {
    const driver = env.driver();
    await driver.prepareDrain(env.request);
    env.state.onJoin = async () => {
      // Proves the join is outside entry.run: a real publication callback
      // needs this same lock to finish before stop() resolves.
      await env.entries.run("agent", async () => {
        await env.inbox.ingestPoll({ agent_id: "agent", room_id: "room", last_observed_message_id: "101",
          messages: [{ source_message_id: "101", source_message: { text: "B" }, activation: {} }] });
      });
    };
    await driver.drive("agent", env.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal((await driver.getDrain(env.request)).phase, "cancelled");
    assert.equal(env.events.includes("stop"), false);
    assert.equal(env.events.includes("start"), true);
    assert.equal((await env.inbox.claimHead("agent"))?.source_message_id, "101");
    assert.equal((await env.store.getEntry("agent"))?.delivery_mode, "daemon_inbox");
    assert.equal(env.checkpoint(), null);
  } finally { await env.close(); }
});

test("reverse drain keeps ambiguous stops frozen across reopen and commits only after hard birth death", async () => {
  for (const probe of ["same", "unknown", "malformed"] as const) {
    const env = await reverseFixture();
    try {
      let driver = env.driver();
      await driver.prepareDrain(env.request);
      env.state.afterStop = probe;
      await assert.rejects(driver.drive("agent", env.signal), /no hard proof/);
      assert.equal((await driver.getDrain(env.request)).phase, "uncertain");
      assert.equal((await env.store.getEntry("agent"))?.delivery_mode, "daemon_inbox");
      await env.reopen();
      driver = env.driver();
      await assert.rejects(env.inbox.bootstrapCursor({ agent_id: "agent", room_id: "room", last_observed_message_id: "999" }), /freezes/);
      await assert.rejects(driver.cancelDrain(env.request), /cannot be cancelled/);
      // A cached protocol terminal deliberately has no bearing on OS state.
      env.setTerminal();
      await assert.rejects(driver.drive("agent", env.signal), /no hard proof/);
      env.state.birth = "gone";
      env.state.preflightError = new Error("runtime changed after stop intent");
      const stops = env.events.filter((event) => event === "stop").length;
      await driver.drive("agent", env.signal);
      assert.equal((await driver.getDrain(env.request)).phase, "complete");
      assert.equal(env.events.filter((event) => event === "stop").length, stops, "recovery never signals a dead or replaced birth");
      assert.equal(env.checkpoint(), "100");
    } finally { await env.close(); }
  }
});

test("reverse stop intent survives handoff during native stop without restarting ingress or committing", async () => {
  const env = await reverseFixture();
  try {
    const stopped = deferred<void>();
    env.state.onStop = async () => { env.state.handoff = true; env.controller.abort(); await stopped.promise; };
    const driver = env.driver();
    await driver.prepareDrain(env.request);
    await driver.drive("agent", env.signal);
    assert.equal((await env.store.getDeliveryDrain("operation"))?.phase, "dispatching");
    assert.equal(env.events.includes("start"), false);
    assert.equal((await env.store.getEntry("agent"))?.delivery_mode, "daemon_inbox");
    stopped.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    env.state.handoff = false;
    await env.driver().drive("agent", new AbortController().signal);
    assert.equal((await env.store.getDeliveryDrain("operation"))?.phase, "complete");
  } finally { await env.close(); }
});

test("process death proof rejects malformed and unreadable births, and accepts only ESRCH or valid replacement", () => {
  const identity = { probe: () => {}, readBirthIdentity: () => BIRTH, sameBirthIdentity: sameProcessBirthIdentity };
  assert.equal(processBirthState(42, BIRTH, identity), "live");
  for (const malformed of ["", "diagnostic text", "Fake Bad 31 99:99:99 2026"]) {
    assert.equal(processBirthState(42, BIRTH, { ...identity, readBirthIdentity: () => malformed }), "unknown");
    assert.equal(processBirthState(42, malformed, identity), "unknown");
  }
  for (const code of ["EPERM", "ETIMEDOUT", "EIO"]) {
    assert.equal(processBirthState(42, BIRTH, { ...identity, probe: () => { throw Object.assign(new Error(code), { code }); } }), "unknown");
  }
  assert.equal(processBirthState(42, BIRTH, { ...identity, probe: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), "gone");
  assert.equal(processBirthState(42, BIRTH, { ...identity, readBirthIdentity: () => "Mon Aug 31 09:00:00 2026" }), "gone");
});

test("polling activation checkpoints one exact native turn before releasing worker admission; duplicates never dispatch", async () => {
  const env = await activationFixture();
  try {
    const gate = deferred<void>();
    const dispatched = deferred<void>();
    let worker!: Promise<void>;
    env.provider.activateCustodialPolling = async (_handle, request, options) => {
      assert.equal(request.launchReceipt.agentSessionId, "worker");
      assert.equal(request.workerSession.roomCursor, "100");
      await options.beforeNativeDispatch(); env.starts += 1; dispatched.resolve();
      assert.equal((await env.base.store.getPollingActivation("activation"))?.phase, "dispatching");
      worker = env.base.entries.run("agent", async () => {
        assert.equal((await env.base.store.getPollingActivation("activation"))?.provider_turn_id, "polling-turn");
        env.workerAdmitted = true;
      });
      await gate.promise;
      await options.checkpointTurnStarted("polling-turn");
      return { providerTurnId: "polling-turn" };
    };
    const starting = env.driver().activatePolling(env.request);
    await Promise.race([dispatched.promise, starting]);
    assert.equal(env.workerAdmitted, false);
    await assert.rejects(env.driver().activatePolling(env.request), /in-flight lifecycle/);
    gate.resolve();
    assert.equal((await starting).phase, "active"); await worker;
    assert.equal((await env.driver().activatePolling(env.request)).provider_turn_id, "polling-turn");
    assert.equal(env.starts, 1); assert.equal(env.workerAdmitted, true);
    await assert.rejects(env.driver().activatePolling({ ...env.request, requestId: "other" }), /identity changed/);
    await assert.rejects(env.driver().cancelPollingActivation(env.request), /undispatched/);
  } finally { await env.close(); }
});

test("prepared activation survives restart without dispatch; explicit retry or cancellation is required", async () => {
  const env = await activationFixture();
  try {
    await env.prepare(); await env.base.reopen();
    await env.driver().drive("agent", env.base.signal);
    assert.equal(env.starts, 0);
    assert.equal((await env.driver().getPollingActivation(env.request)).phase, "prepared");
    assert.equal((await env.driver().cancelPollingActivation(env.request)).phase, "cancelled");
    assert.equal(env.starts, 0);
  } finally { await env.close(); }
});

test("lost activation ACK stays uncertain across restart and never adopts another native turn", async () => {
  const env = await activationFixture();
  try {
    env.provider.activateCustodialPolling = async (_handle, _request, options) => {
      await options.beforeNativeDispatch(); env.starts += 1; throw new Error("ACK connection lost");
    };
    assert.equal((await env.driver().activatePolling(env.request)).phase, "uncertain");
    await env.base.reopen();
    for (const birth of ["same", "unknown", "malformed"]) {
      env.base.state.birth = birth;
      await env.driver().drive("agent", env.base.signal);
      assert.equal((await env.driver().activatePolling(env.request)).phase, "uncertain");
      assert.equal(env.inspections, 0, "without the ACK there is no safe native turn to inspect");
    }
    assert.equal(env.starts, 1);
    env.base.state.birth = "gone";
    await env.driver().drive("agent", env.base.signal);
    const terminal = await env.driver().getPollingActivation(env.request);
    assert.equal(terminal.phase, "complete"); assert.equal(terminal.terminal_outcome, "lost");
    assert.equal(terminal.provider_turn_id, null);
  } finally { await env.close(); }
});

test("known activation reconciles only its exact turn, preserves failures, and never replays after handoff", async () => {
  const env = await activationFixture();
  try {
    await env.driver().activatePolling(env.request);
    await env.base.reopen();
    env.observation = { state: "unknown" };
    await env.driver().drive("agent", env.base.signal);
    assert.equal((await env.driver().getPollingActivation(env.request)).phase, "uncertain");
    env.observation = { state: "active" };
    await env.driver().drive("agent", env.base.signal);
    assert.equal((await env.driver().getPollingActivation(env.request)).phase, "active");
    env.observation = { state: "terminal", outcome: "failed" };
    env.base.state.handoff = true;
    await env.driver().drive("agent", env.base.signal);
    assert.equal((await env.base.store.getPollingActivation("activation"))?.phase, "active");
    env.base.state.handoff = false;
    await env.driver().drive("agent", env.base.signal);
    assert.equal((await env.driver().getPollingActivation(env.request)).terminal_outcome, "failed");
    assert.equal(env.starts, 1);
  } finally { await env.close(); }
});

test("activation refuses a stale launch session before preparing or starting native work", async () => {
  const env = await activationFixture();
  try {
    const manifest = await env.base.store.load();
    await env.base.store.write(manifest.generation, manifest.entries.map(entry => ({ ...entry,
      provider_ref: { ...entry.provider_ref!, custodial_launch_agent_session_id: "old-worker" },
    })));
    await assert.rejects(env.driver().activatePolling(env.request), /bound worker authority/);
    assert.equal(await env.base.store.getPollingActivation("activation"), null);
    assert.equal(env.starts, 0);
  } finally { await env.close(); }
});

async function activationFixture() {
  const base = await reverseFixture();
  await base.driver().prepareDrain(base.request);
  await base.driver().drive("agent", base.signal);
  assert.equal((await base.store.getDeliveryDrain("operation"))?.phase, "complete");
  const seed = new DatabaseSync(base.path);
  seed.exec(`UPDATE work_attempt_executions SET terminal_json='{}';
    INSERT INTO work_attempt_executions(execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json)
    VALUES('polling-run','work','2026-08-31T08:01:00Z','provider',2,NULL);`);
  seed.close();
  const manifest = await base.store.load();
  await base.store.write(manifest.generation, manifest.entries.map(entry => ({ ...entry,
    run_id: "polling-run", deployment_id: serializeDaemonDeploymentId("agent", "polling-run"),
    provider_ref: { work_attempt_id: "work", execution_generation_id: "polling-run", provider_continuation_id: "thread",
      provider_connection: base.handle.providerConnection!, custodial_launch_agent_session_id: "worker" },
  })));
  const config = (await base.store.getAgentConfiguration("agent"))!;
  await base.store.markRuntimeConfigurationApplied((await base.store.load()).generation,
    { agentId: "agent", executionGenerationId: "polling-run", appliedRevision: config.config_revision });
  base.authority.generation = (await base.store.load()).generation;
  const ready = (await base.store.getEntry("agent"))!;
  assert.equal(ready.delivery_mode ?? "mcp_polling", "mcp_polling");
  assert.equal(ready.desired_state, "running");
  assert.equal(ready.condition, "none");
  assert.deepEqual(ready.provider_ref?.provider_connection, base.handle.providerConnection);
  base.state.birth = "same";
  const bindings = new WorkerBindingStore(join(base.root, "bindings.json"), undefined, base.path);
  const bound = await bindings.bind({ entry_id: "agent", room_id: "room", work_attempt_id: "work", execution_generation_id: "polling-run",
    agent_session_id: "worker", agent_session_token: "test-worker-bearer", api_url: "https://example.test" });
  await bindings.checkpointCursor("agent", "worker", "polling-run", "100");
  await bindings.recordSupervisedWorkerSession({ agent_id: "agent", room_id: "room", agent_session_id: "worker",
    execution_generation_id: "polling-run", credential_ref: bound.credential_ref,
    expires_at: new Date(Date.now() + 60_000).toISOString() });
  const grant: InstalledHostGrant = { entryId: "agent", roomId: "room", agentKey: "owner/agent", grantId: "grant", supervisorGrant: "test-grant",
    grantGeneration: 1, apiUrl: "https://example.test", daemonGeneration: 1, hostId: "host", installationId: "install", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const env = { base, provider: { ...base.provider }, starts: 0, inspections: 0, workerAdmitted: false,
    observation: { state: "active" } as Awaited<ReturnType<NonNullable<ProviderActionPort["inspectCustodialPollingActivation"]>>>,
    request: { entryId: "agent", operationId: "activation", requestId: "activate-request", roomId: "room", executionGenerationId: "polling-run", reverseOperationId: "operation" },
    driver: () => base.driver({ provider: env.provider,
      getAttempt: async () => ({ workspace_path: "/workspace" }) as TaskWorkAttempt,
      polling: { bindings, currentHostGrant: () => grant },
    }),
    prepare: () => base.store.preparePollingActivation({ ...env.request, agentId: "agent", handle: base.handle,
      boundary: { state: "idle", providerContinuationId: "thread", nativeProcessIdentity: BIRTH, latestProviderTurnId: null } }, async commit => commit()),
    close: async () => { await bindings.close(); await base.close(); },
  };
  env.provider.activateCustodialPolling = async (_handle, _request, options) => {
    await options.beforeNativeDispatch(); env.starts += 1;
    await options.checkpointTurnStarted("polling-turn"); return { providerTurnId: "polling-turn" };
  };
  env.provider.inspectCustodialPollingActivation = async (_handle, turnId) => {
    assert.equal(turnId, "polling-turn"); env.inspections += 1; return env.observation;
  };
  return env;
}

const BIRTH = "Mon Aug 31 08:00:00 2026";
async function reverseFixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-reverse-drain-"));
  const path = join(root, "state.sqlite");
  let store = new ManifestStore(path);
  let inbox = new SupervisedAgentInboxStore(path);
  const events: string[] = [];
  const state = { handoff: false, birth: "same", afterStop: "gone", activeTurn: null as string | null,
    preflightError: null as Error | null, onJoin: async () => {}, onStop: async () => {} };
  const connection = { kind: "codex_app_server" as const, url: "ws://127.0.0.1:4567", pid: 4567, processIdentity: BIRTH };
  const handle: ProviderActionHandle = { workAttemptId: "work", pid: 4567, providerContinuationId: "thread", providerConnection: connection, observedState: "idle" };
  const entry: DaemonManifestEntry = { id: "agent", room_id: "room", display_name: "Agent", provider: "codex", model: null, charter: "test",
    desired_state: "running", observed_state: "idle", condition: "none", permission_profile_id: null, created_by: "test", created_at: "2026-08-31T08:00:00Z",
    delivery_mode: "daemon_inbox", work_attempt_id: "work", provider_ref: { work_attempt_id: "work", execution_generation_id: "run", provider_continuation_id: "thread", provider_connection: connection } };
  await store.write(0, [entry]);
  const seed = new DatabaseSync(path);
  seed.exec(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
    VALUES('work','task','lease',1,'/workspace','repo','https://example.test/repo.git','abc','/bare','active','2026-08-31T08:00:00Z');
    INSERT INTO work_attempt_executions(execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json)
    VALUES('run','work','2026-08-31T08:00:00Z','provider',1,NULL);`);
  seed.close();
  await inbox.bootstrapCursor({ agent_id: "agent", room_id: "room", last_observed_message_id: "100" });
  const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => state.handoff, notifyStateChanged: () => {} }, 1);
  const entries = new EntryConcurrencyGate({ isHandoffScheduled: () => state.handoff });
  const controller = new AbortController();
  const provider: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("reverse must not spawn"); }, resume: async () => { throw new Error("reverse must not resume"); },
    attach: async () => { throw new Error("reverse must not attach"); }, poke: async () => {},
    stop: async () => { throw new Error("reverse requires exact stopRef"); }, onExit: async () => () => {}, onStream: async () => () => {},
    preflightCustodialPolling: async () => { events.push("preflight"); if (state.preflightError) throw state.preflightError; },
    inspectTurnBoundary: async () => state.activeTurn
      ? { state: "active", providerContinuationId: "thread", nativeProcessIdentity: BIRTH, providerTurnId: state.activeTurn }
      : { state: "idle", providerContinuationId: "thread", nativeProcessIdentity: BIRTH, latestProviderTurnId: null },
    stopRef: async (ref) => {
      assert.deepEqual(ref.providerConnection, connection);
      assert.equal((await store.getDeliveryDrain("operation"))?.phase === "dispatching" || (await store.getDeliveryDrain("operation"))?.phase === "uncertain", true);
      events.push("stop"); await state.onStop(); state.birth = state.afterStop;
      return { endedAt: new Date().toISOString(), exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: "thread" };
    },
  };
  return {
    get store() { return store; }, get inbox() { return inbox; }, root, path, handle, provider, authority, events, state, entries, controller, signal: controller.signal,
    request: { entryId: "agent", roomId: "room", operationId: "operation", requestId: "request", executionGenerationId: "run" },
    driver: (overrides: Partial<DeliveryCutoverExecutionCoordinatorOptions> = {}) => new DeliveryCutoverExecutionCoordinator({ isHandoffScheduled: () => state.handoff, provider,
      getEntry: (id) => store.getEntry(id), getAttempt: async () => { throw new Error("legacy attempt path"); },
      updateEntry: async () => { throw new Error("legacy manifest path"); }, getLiveHandle: () => handle,
      startDelivery: async () => { events.push("start"); },
      observation: new DeliveryCutoverCoordinator({ isHandoffScheduled: () => state.handoff, drive: async () => {}, setRetryTimeout: () => ({ unref() {} }) }),
      drain: { store, authority, entries, delivery: { stop: async () => { events.push("join"); await state.onJoin(); } }, processIdentity: {
        probe: () => { if (state.birth === "gone") throw Object.assign(new Error(), { code: "ESRCH" }); },
        readBirthIdentity: () => { if (state.birth === "unknown") throw new Error("unreadable"); return state.birth === "malformed" ? "ps diagnostic" : BIRTH; },
        sameBirthIdentity: sameProcessBirthIdentity,
      } }, ...overrides,
    }),
    checkpoint: () => { const db = new DatabaseSync(path); try { return (db.prepare("SELECT room_cursor FROM work_attempt_checkpoints ORDER BY sort_order DESC LIMIT 1").get() as { room_cursor: string } | undefined)?.room_cursor ?? null; } finally { db.close(); } },
    setTerminal: () => { const db = new DatabaseSync(path); try { db.exec("UPDATE work_attempt_executions SET terminal_json='{}'"); } finally { db.close(); } },
    reopen: async () => { await inbox.close(); await store.close(); store = new ManifestStore(path); inbox = new SupervisedAgentInboxStore(path); authority.generation = (await store.load()).generation; },
    close: async () => { await inbox.close(); await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
