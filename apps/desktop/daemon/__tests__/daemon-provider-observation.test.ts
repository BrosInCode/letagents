import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ManifestStore } from "../manifest-store.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { assertMacOS } from "../platform.js";
import { type DaemonManifestEntry } from "../types.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { type SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import type { NativeExecutionObservation, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import type { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import {
  SupervisorDaemon,
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
    async () => ({ mode: "typed_shadow", dispose() {} }),
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

test("reverse drain socket and daemon restart preserve stop intent without a successor or cursor bootstrap", async () => {
  let starts = 0;
  let attaches = 0;
  let stops = 0;
  const birth = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  const connection = { kind: "codex_app_server" as const, pid: process.pid, processIdentity: birth, url: "ws://127.0.0.1:7123" };
  const env = await observationDaemonFixture(async () => ({ mode: "typed_shadow", dispose() {} }), "codex", {
    preflightCustodialPolling: async () => {},
    inspectTurnBoundary: async () => ({ state: "idle", providerContinuationId: "observed-continuation", nativeProcessIdentity: birth, latestProviderTurnId: null }),
    // This fixture deliberately keeps a demonstrably live process (this test)
    // alive. Returning a protocol terminal must never authorize the mode flip.
    stopRef: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "observed-continuation" }; },
    spawn: async () => { starts += 1; throw new Error("unexpected successor spawn"); },
    resume: async () => { starts += 1; throw new Error("unexpected successor resume"); },
    attach: async () => { attaches += 1; return null; },
    attachAction: async () => { attaches += 1; return { state: "absent" }; },
    runRoomTurn: async () => { throw new Error("reverse must not activate a turn"); },
  }, connection);
  let successor: SupervisorDaemon | undefined;
  try {
    const stored = (await env.internals.store.getEntry(env.id))!;
    env.internals.liveHandles.set(env.id, env.handle);
    await env.internals.supervisedInbox.bootstrapCursor({ agent_id: env.id, room_id: stored.room_id, last_observed_message_id: "100" });
    const status = await daemonRequest(env.paths.socketPath, "daemon.status");
    const generation = (status.result as { generation: number }).generation;
    const params = { entry_id: env.id, operation_id: "reverse-operation", request_id: "reverse-request", room_id: stored.room_id,
      execution_generation_id: env.generation, daemon_generation: generation };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", { ...params, daemon_generation: generation + 1 })).ok, false);
    assert.equal(await env.internals.store.unresolvedDeliveryDrain(env.id), null);
    assert.deepEqual((await env.internals.store.getEntry(env.id))?.provider_ref, stored.provider_ref);
    assert.equal(env.internals.liveHandles.get(env.id)?.providerContinuationId, "observed-continuation");
    // An agent that collects its own messages cannot be held back from its next turn, so it must never carry its
    // owner's own setup. While the setup is on, the move to polling delivery is refused and nothing is prepared.
    const policy = (value: string | null) => {
      const database = new DatabaseSync(env.paths.manifestPath);
      try {
        database.prepare(`UPDATE agent_configurations SET provider_launch_policy_present=?, provider_launch_policy_undefined=0, provider_launch_policy_json=? WHERE agent_id=?`)
          .run(value === null ? 0 : 1, value, env.id);
      } finally { database.close(); }
    };
    for (const withSetup of ['{"letagentsOwnerIsolation":false}', '{"letagentsOwnerIsolationChangedAt999":false}']) {
      // Saved on, or turned off while the running process still has it.
      policy(withSetup);
      const refused = await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", params);
      assert.equal(refused.ok, false, withSetup);
      assert.match(refused.error ?? "", /Turn off "Use your own Codex setup" for this agent and let it restart before moving it to polling delivery/);
      assert.equal(await env.internals.store.unresolvedDeliveryDrain(env.id), null);
      assert.equal(await env.internals.store.getDeliveryDrain("reverse-operation"), null);
    }
    policy(null);
    const prepared = await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", params);
    assert.equal(prepared.ok, true, prepared.error);
    const firstDriver = env.daemon as unknown as { deliveryCutovers: { start(id: string): Promise<void> } };
    await firstDriver.deliveryCutovers.start(env.id).catch(() => {});
    assert.equal((await env.internals.store.getDeliveryDrain("reverse-operation"))?.phase, "uncertain");
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.cancel_delivery_drain", params)).ok, false);
    await env.daemon.stop();
    successor = new SupervisorDaemon(env.paths, "darwin", env.port, true);
    await successor.start();
    const restarted = successor as unknown as { store: ManifestStore; supervisedInbox: SupervisedAgentInboxStore; deliveryCutovers: { start(id: string): Promise<void> } };
    await restarted.deliveryCutovers.start(env.id).catch(() => {});
    const after = await daemonRequest(env.paths.socketPath, "daemon.status");
    const currentGeneration = (after.result as { generation: number }).generation;
    assert.notEqual(currentGeneration, generation);
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.get_delivery_drain", params)).ok, false, "old daemon controllers cannot mutate/read under stale authority");
    const read = await daemonRequest(env.paths.socketPath, "supervisor.get_delivery_drain", { ...params, daemon_generation: currentGeneration });
    assert.equal(read.ok, true, read.error);
    assert.equal((read.result as { phase: string }).phase, "uncertain");
    await assert.rejects(restarted.supervisedInbox.bootstrapCursor({ agent_id: env.id, room_id: stored.room_id, last_observed_message_id: "999" }), /freezes/);
    assert.equal((await restarted.store.getEntry(env.id))?.delivery_mode, "daemon_inbox");
    assert.equal(starts, 0);
    assert.equal(attaches, 0, "restart cannot reattach/rebind the frozen process through normal convergence");
    assert.ok(stops >= 1);
  } finally { await successor?.stop(); await env.cleanup(); }
});

for (const scenario of ["activation", "pre_activation_forward"] as const) test(scenario === "activation"
  ? "custodial polling socket activation is generation-fenced and restart never dispatches prepared or uncertain work"
  : "custodial forward socket switches only before activation and restart preserves the completed receipt", async () => {
  const oldProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { oldProcess.once("spawn", resolve); oldProcess.once("error", reject); });
  const oldPid = oldProcess.pid!;
  const birth = (pid: number) => execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  const oldConnection = { kind: "codex_app_server" as const, pid: oldPid, processIdentity: birth(oldPid), url: "ws://127.0.0.1:7123" };
  const pollingProcess = scenario === "pre_activation_forward"
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
  if (pollingProcess) await new Promise<void>((resolve, reject) => {
    pollingProcess.once("spawn", resolve);
    pollingProcess.once("error", error => { oldProcess.kill("SIGTERM"); reject(error); });
  });
  const pollingPid = pollingProcess?.pid ?? process.pid;
  const currentConnection = { ...oldConnection, pid: pollingPid, processIdentity: birth(pollingPid) };
  let nativeStarts = 0;
  let expectedPollingCursor = "100";
  let behavior: "success" | "before_dispatch_failure" | "lost_ack" = "success";
  let terminal = false;
  let currentHandle: ProviderActionHandle | undefined;
  const env = await observationDaemonFixture(async () => ({ mode: "typed_shadow", dispose() {} }), "codex", {
    preflightCustodialPolling: async () => {},
    inspectTurnBoundary: async handle => ({ state: "idle", providerContinuationId: handle.providerContinuationId!,
      nativeProcessIdentity: handle.providerConnection!.processIdentity!, latestProviderTurnId: null }),
    stopRef: async ref => {
      const target = ref.providerConnection?.pid === oldPid ? oldProcess : pollingProcess;
      assert.ok(target, "only this test's exact child process can be stopped");
      assert.deepEqual(ref.providerConnection, target === oldProcess ? oldConnection : currentConnection);
      const exited = new Promise<void>(resolve => target.once("exit", () => resolve()));
      target.kill("SIGTERM"); await exited;
      return { endedAt: new Date().toISOString(), exitCode: null, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: ref.providerContinuationId };
    },
    activateCustodialPolling: async (handle, request, callbacks) => {
      assert.equal(handle, currentHandle);
      assert.equal(request.launchReceipt.agentSessionId, "polling-worker");
      assert.deepEqual(request.launchReceipt.providerConnection, currentConnection);
      assert.equal(request.workerSession.roomCursor, expectedPollingCursor);
      if (behavior === "before_dispatch_failure") throw new Error("test transport unavailable before dispatch");
      await callbacks.beforeNativeDispatch(); nativeStarts += 1;
      if (behavior === "lost_ack") throw new Error("test native acknowledgement lost");
      await callbacks.checkpointTurnStarted("exact-polling-turn");
      return { providerTurnId: "exact-polling-turn" };
    },
    inspectCustodialPollingActivation: async (handle, turnId) => {
      assert.deepEqual(handle.providerConnection, currentConnection);
      assert.equal(turnId, "exact-polling-turn");
      return terminal ? { state: "terminal", outcome: "completed" } : { state: "active" };
    },
  }, oldConnection).catch(error => { oldProcess.kill("SIGTERM"); pollingProcess?.kill("SIGTERM"); throw error; });
  let daemon = env.daemon;
  type Internals = typeof env.internals & {
    authority: { generation: number; fenceDaemonCommit<T>(commit: () => Promise<T>): Promise<T> };
    updateManifestEntry(id: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<DaemonManifestEntry>;
    deliveryCutovers: { start(id: string): Promise<void> };
  };
  let internals = daemon as unknown as Internals;
  const generation = async () => ((await daemonRequest(env.paths.socketPath, "daemon.status")).result as { generation: number }).generation;
  const grant = async () => {
    const response = await daemonRequest(env.paths.socketPath, "supervisor.install_host_grant", {
      entry_id: env.id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "polling-grant", supervisor_grant: "test-parent",
      grant_generation: 1, api_url: "https://example.test", daemon_generation: await generation(),
      host_id: "host", installation_id: "installation", grant_expires_at: "2099-01-01T00:00:00.000Z", recovery_only: true,
    });
    assert.equal(response.ok, true, response.error);
    assert.equal((response.result as { status: string }).status, "installed");
  };
  try {
    assert.equal((await stat(env.paths.socketPath)).mode & 0o777, 0o600, "activation uses the owner-only control endpoint");
    internals.liveHandles.set(env.id, env.handle);
    await internals.supervisedInbox.bootstrapCursor({ agent_id: env.id, room_id: entry.room_id, last_observed_message_id: "100" });
    const reverse = await daemonRequest(env.paths.socketPath, "supervisor.prepare_delivery_drain", {
      entry_id: env.id, operation_id: "socket-reverse", request_id: "socket-reverse-request", room_id: entry.room_id,
      execution_generation_id: env.generation, daemon_generation: await generation(),
    });
    assert.equal(reverse.ok, true, reverse.error);
    await internals.deliveryCutovers.start(env.id);
    assert.equal((await internals.store.getDeliveryDrain("socket-reverse"))?.phase, "complete");
    assert.equal(oldProcess.signalCode, "SIGTERM", "real OS death, not protocol terminal data, authorized the predecessor");
    await internals.durability.recordTerminal(env.handle.workAttemptId, env.generation, {
      ended_at: new Date().toISOString(), exit_code: null, signal: "SIGTERM", stdio_archive_ref: null, stdio_tail: "",
      terminal_cause: "stopped", actor: "daemon-provider", generation: 1, provider_continuation_id: env.handle.providerContinuationId,
    });
    const execution = await internals.durability.startGeneration(env.handle.workAttemptId, "daemon-provider", 2);
    const config = (await internals.store.getAgentConfiguration(env.id))!;
    // Only the native adapter is represented by a fixture handle: its receipt
    // names the actual launch session, while both process births came from ps.
    currentHandle = { ...env.handle, pid: pollingPid, providerConnection: currentConnection, observedState: "idle",
      custodyLaunchAgentSessionId: "polling-worker", appliedConfigurationRevision: config.config_revision };
    await internals.updateManifestEntry(env.id, current => ({ ...current,
      run_id: execution.execution_generation_id, deployment_id: serializeDaemonDeploymentId(env.id, execution.execution_generation_id),
      provider_ref: { work_attempt_id: env.handle.workAttemptId, execution_generation_id: execution.execution_generation_id,
        provider_continuation_id: currentHandle!.providerContinuationId!, provider_connection: currentConnection,
        custodial_launch_agent_session_id: currentHandle!.custodyLaunchAgentSessionId! },
    }));
    const applied = await internals.store.markRuntimeConfigurationApplied(internals.authority.generation, {
      agentId: env.id, executionGenerationId: execution.execution_generation_id, appliedRevision: config.config_revision,
    }, commit => internals.authority.fenceDaemonCommit(commit));
    internals.authority.generation = applied.generation;
    const binding = await internals.workerBindings.bind({ entry_id: env.id, room_id: entry.room_id,
      work_attempt_id: env.handle.workAttemptId, execution_generation_id: execution.execution_generation_id,
      agent_session_id: "polling-worker", agent_session_token: "test-worker", api_url: "https://example.test" });
    await internals.workerBindings.checkpointCursor(env.id, binding.agent_session_id, execution.execution_generation_id, "100");
    await internals.workerBindings.recordSupervisedWorkerSession({ agent_id: env.id, room_id: entry.room_id,
      execution_generation_id: execution.execution_generation_id, agent_session_id: binding.agent_session_id,
      credential_ref: binding.credential_ref, expires_at: "2099-01-01T00:00:00.000Z" });
    internals.liveHandles.set(env.id, currentHandle); await grant();
    const params = { entry_id: env.id, operation_id: "socket-activation", request_id: "socket-activation-request",
      room_id: entry.room_id, execution_generation_id: execution.execution_generation_id, reverse_operation_id: "socket-reverse",
      daemon_generation: await generation() };
    if (scenario === "pre_activation_forward") {
      const forward = { ...params, operation_id: "socket-forward", request_id: "socket-forward-request" };
      assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.prepare_custodial_forward",
        { ...forward, daemon_generation: forward.daemon_generation + 1 })).ok, false);
      assert.equal(await internals.store.getDeliveryDrain(forward.operation_id), null);
      const prepared = await daemonRequest(env.paths.socketPath, "supervisor.prepare_custodial_forward", forward);
      assert.equal(prepared.ok, true, prepared.error);
      await internals.deliveryCutovers.start(env.id);
      const receipt = await internals.store.getDeliveryDrain(forward.operation_id);
      assert.equal(receipt?.phase, "complete");
      assert.equal(receipt?.predecessor_operation_id, "socket-reverse");
      assert.equal(pollingProcess!.signalCode, "SIGTERM", "forward also requires real native birth death");
      assert.equal((await internals.store.getEntry(env.id))?.delivery_mode, "daemon_inbox");
      assert.equal((await internals.store.getAgentConfiguration(env.id))?.polling_contract, null);
      assert.equal(nativeStarts, 0, "undoing the mode choice cannot activate polling work");
      await daemon.stop();
      daemon = new SupervisorDaemon(env.paths, "darwin", env.port, false);
      internals = daemon as unknown as Internals;
      await daemon.start(); await internals.deliveryCutovers.start(env.id);
      const duplicate = await daemonRequest(env.paths.socketPath, "supervisor.prepare_custodial_forward",
        { ...forward, daemon_generation: await generation() });
      assert.equal(duplicate.ok, true, duplicate.error);
      assert.deepEqual(duplicate.result, { ...receipt }, "restart returns the same completed journal without a second stop or cursor transfer");
      assert.equal(nativeStarts, 0);
      return;
    }
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", { ...params, daemon_generation: params.daemon_generation + 1 })).ok, false);
    assert.equal(await internals.store.getPollingActivation(params.operation_id), null); assert.equal(nativeStarts, 0);
    const activated = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", params);
    assert.equal(activated.ok, true, activated.error);
    const record = (await internals.store.getPollingActivation(params.operation_id))!;
    assert.equal(record.phase, "active"); assert.equal(record.provider_turn_id, "exact-polling-turn");
    assert.equal(record.execution_generation_id, execution.execution_generation_id);
    assert.equal(record.native_process_identity, currentConnection.processIdentity);
    assert.equal(record.agent_session_id, "polling-worker"); assert.equal(nativeStarts, 1);
    const negotiated = await daemonRequest(env.paths.socketPath, "daemon.negotiate");
    assert.equal((negotiated.result as { capabilities: { custodialPollingOffersV1: boolean } }).capabilities.custodialPollingOffersV1, true);
    const wait = { entry_id: env.id, room_id: entry.room_id, work_attempt_id: env.handle.workAttemptId,
      execution_generation_id: execution.execution_generation_id, agent_session_id: binding.agent_session_id,
      daemon_generation: await generation(), api_url: "https://example.test", contract: "custodial_polling_v1",
      tool_name: "wait_for_messages", phase: "before", process_incarnation_id: "01234567-89ab-4cde-8f01-23456789abcd",
      mcp_request_id: 1, room_cursor: "999" };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, mcp_request_id: null })).ok, false);
    const before = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", wait);
    assert.equal(before.ok, true, before.error);
    const receipt = before.result as { activation_id: string; binding_epoch: number; room_cursor: string; configuration_revision: number };
    assert.equal(receipt.room_cursor, "100", "unknown ACK cannot jump past unread work");
    assert.equal(receipt.activation_id, record.operation_id);
    const release = { ...wait, phase: "release", expected_activation_id: receipt.activation_id,
      expected_binding_epoch: receipt.binding_epoch, expected_configuration_revision: receipt.configuration_revision,
      input_cursor: receipt.room_cursor, offered_frontier: "102" };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", release)).ok, true);
    const firstOffer = (await internals.store.getPollingOfferTail(record.operation_id))!;
    assert.equal(firstOffer.mcp_request_id, "1");
    assert.equal((await internals.workerBindings.get(env.id))?.room_cursor, "100", "offering does not ACK");
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...release, mcp_request_id: "1", offered_frontier: "103" })).ok, true);
    const tail = (await internals.store.getPollingOfferTail(record.operation_id))!;
    assert.equal(tail.mcp_request_id, '"1"', "router must not collapse numeric and string SDK IDs");
    assert.equal(tail.predecessor_offer_id, firstOffer.offer_id);
    const staleAck = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, room_cursor: "102" });
    assert.equal((staleAck.result as { room_cursor: string }).room_cursor, "100");
    // Recent-tail context reads are fenced but never grant a delivery ACK.
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, tool_name: "read_messages", room_cursor: "103" })).ok, true);
    assert.equal((await internals.workerBindings.get(env.id))?.room_cursor, "100");
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.checkpoint_worker_cursor", { ...wait, room_cursor: "103" })).ok, false);
    const acknowledged = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...wait, mcp_request_id: 2, room_cursor: "103" });
    assert.equal(acknowledged.ok, true, acknowledged.error);
    assert.equal((acknowledged.result as { room_cursor: string }).room_cursor, "103");
    expectedPollingCursor = "103";
    const noProgress = { ...release, mcp_request_id: 2, input_cursor: "103", offered_frontier: "103" };
    assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", noProgress)).ok, true);
    assert.equal((await internals.store.getPollingOfferTail(record.operation_id))?.offer_id, tail.offer_id);
    await internals.workerBindings.bind({ ...binding, agent_session_token: "test-worker" });
    const staleRelease = await daemonRequest(env.paths.socketPath, "supervisor.authorize_custodial_polling", { ...noProgress, offered_frontier: "104" });
    assert.equal(staleRelease.ok, false, "same-session rebind must invalidate the old BEFORE epoch");
    assert.equal((await internals.store.getPollingOfferTail(record.operation_id))?.offer_id, tail.offer_id);
    terminal = true;
    await eventually(async () => {
      await internals.deliveryCutovers.start(env.id);
      return (await internals.store.getPollingActivation(params.operation_id))?.phase === "complete";
    }, "exact polling terminal observation settles after any earlier coalesced active observation");
    const duplicate = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", params);
    assert.equal(duplicate.ok, true, duplicate.error);
    assert.equal((duplicate.result as { phase: string }).phase, "complete"); assert.equal(nativeStarts, 1);

    const recovery = { ...params, operation_id: "socket-recovery", request_id: "socket-recovery-request" };
    behavior = "before_dispatch_failure";
    const prepared = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", recovery);
    assert.equal(prepared.ok, false); assert.match(prepared.error ?? "", /before dispatch/);
    assert.equal((await internals.store.getPollingActivation(recovery.operation_id))?.phase, "prepared");
    for (const phase of ["prepared", "uncertain"] as const) {
      const startsBeforeRestart = nativeStarts;
      await daemon.stop();
      // Startup's unresolved-journal observer is live even with provider
      // auto-convergence disabled, exactly as in observationDaemonFixture.
      daemon = new SupervisorDaemon(env.paths, "darwin", env.port, false);
      internals = daemon as unknown as Internals;
      await daemon.start(); await internals.deliveryCutovers.start(env.id);
      assert.equal(nativeStarts, startsBeforeRestart, `${phase} startup must never start a native turn`);
      assert.equal((await internals.store.getPollingActivation(recovery.operation_id))?.phase, phase);
      assert.equal((await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", recovery)).ok, false, "retired daemon generation cannot dispatch");
      recovery.daemon_generation = await generation();
      internals.liveHandles.set(env.id, currentHandle); await grant();
      await internals.workerBindings.installCredential({ entry_id: env.id, agent_session_id: binding.agent_session_id,
        execution_generation_id: execution.execution_generation_id, agent_session_token: "test-worker" });
      behavior = "lost_ack";
      const retry = await daemonRequest(env.paths.socketPath, "supervisor.activate_custodial_polling", recovery);
      assert.equal(retry.ok, true, retry.error);
      assert.equal((retry.result as { phase: string }).phase, "uncertain");
      assert.equal(nativeStarts, phase === "prepared" ? startsBeforeRestart + 1 : startsBeforeRestart);
      assert.equal((await internals.store.getPollingActivation(recovery.operation_id))?.provider_turn_id, null);
    }
  } finally {
    await daemon.stop(); await env.cleanup();
    if (oldProcess.exitCode === null && oldProcess.signalCode === null) oldProcess.kill("SIGTERM");
    if (pollingProcess && pollingProcess.exitCode === null && pollingProcess.signalCode === null) pollingProcess.kill("SIGTERM");
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
  const delayedStream = new Promise<void>((resolve) => { release = resolve; });
  env.port.onStream = async () => { entered(); await delayedStream; return () => {}; };
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

test("daemon is visibly gated to macOS", () => {
  assert.throws(() => assertMacOS("linux"), /macOS only/);
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
    assert.equal(current.observed_state, "idle");
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
    assert.equal(current.observed_state, "working", "the same healthy execution continues after a retryable wait failure");
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

test("daemon keeps empty wait results idle across the real stream handler and restart", async () => {
  const env = await observationDaemonFixture(async () => ({
    sourceId: "source-quiet-poll", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => {},
  }), "claude-code");
  const { paths, handle } = env;
  type StreamEvent = {
    workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
    provider: string; kind: string; method: string; payload: unknown; payloadTruncated: boolean;
    payloadRedacted: boolean; durablePayloadRef: null;
  };
  type StreamInternals = {
    providerStreams: ProviderStreamCoordinator;
    workerRuntimeCustody: WorkerRuntimeCustody;
    handleProviderStream: (entryId: string, providerHandle: typeof handle, event: StreamEvent) => Promise<void>;
    publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean>;
  };
  let sequence = 0;
  const event = (method: string, payload: unknown): StreamEvent => ({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    observedAt: new Date(Date.now() + sequence).toISOString(),
    sequence: ++sequence,
    provider: "claude-code",
    kind: "tool_lifecycle",
    method,
    payload,
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  });
  const codexEvent = (method: string, payload: unknown): StreamEvent => ({
    ...event(method, payload),
    provider: "codex",
  });
  const wait = (id: string) => event("assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "mcp__letagents__wait_for_messages", input: {} }] },
  });
  const result = (id: string, messages: unknown[]) => event("user", {
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: JSON.stringify({ messages, room_id: "focus_37" }) }],
    }] },
  });
  const install = async (daemon: SupervisorDaemon, published: Array<"working" | "idle">): Promise<StreamInternals> => {
    const internals = daemon as unknown as StreamInternals;
    await internals.providerStreams.install(env.id, handle, env.generation, () => false);
    internals.workerRuntimeCustody.installLiveBinding(env.id, {
      agentSessionId: "session-poll",
      executionGenerationId: env.generation,
      updatedAt: new Date().toISOString(),
    });
    internals.publishNativeActivity = async (_entryId, _method, status) => { published.push(status); return true; };
    return internals;
  };

  const first = env.daemon;
  let second: SupervisorDaemon | null = null;
  try {
    const published: Array<"working" | "idle"> = [];
    const firstInternals = await install(first, published);
    await firstInternals.handleProviderStream(env.id, handle, wait("wait_1"));
    await firstInternals.handleProviderStream(env.id, handle, result("wait_1", []));
    await firstInternals.handleProviderStream(env.id, handle, event("assistant", {
      type: "assistant", message: { content: [{ type: "thinking", thinking: "provider-internal handoff" }] },
    }));
    assert.deepEqual(published, ["idle", "idle", "idle"], "empty Claude wait lifecycle never flips room presence to working");
    await flushActivity(second ?? first);
    let projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "idle");
    assert.deepEqual(projection.activity?.slice(-3).map((activity) => activity.status), ["idle", "idle", "idle"]);

    await firstInternals.handleProviderStream(env.id, handle, wait("wait_2"));
    await firstInternals.handleProviderStream(env.id, handle, result("wait_2", [{ id: "msg_12", text: "please review" }]));
    assert.equal(published.at(-1), "working", "a nonempty addressed wait result remains visible work");
    await flushActivity(second ?? first);
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "working");

    const codexStarted = codexEvent("item/started", {
      item: {
        type: "mcpToolCall", id: "wait_codex_real", server: "letagents", tool: "wait_for_messages",
        status: "inProgress", arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
      startedAtMs: Date.now(),
    });
    const codexProgress = codexEvent("item/mcpToolCall/progress", {
      itemId: "wait_codex_real", message: "waiting", threadId: "thread_codex", turnId: "turn_codex",
    });
    const codexCompleted = codexEvent("item/completed", {
      item: {
        type: "mcpToolCall", id: "wait_codex_real", server: "letagents", tool: "wait_for_messages",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: {
          content: [{ type: "text", text: JSON.stringify({ messages: [], last_observed_message_id: "msg_13", skipped_message_count: 1 }) }],
          structuredContent: null,
          _meta: null,
        },
        error: null,
        durationMs: 30_000,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
      completedAtMs: Date.now(),
    });
    await firstInternals.handleProviderStream(env.id, handle, codexStarted);
    await firstInternals.handleProviderStream(env.id, handle, codexProgress);
    await firstInternals.handleProviderStream(env.id, handle, codexCompleted);
    assert.deepEqual(published.slice(-3), ["idle", "idle", "idle"], "real Codex start, progress, and empty/silent completion stay idle");
    await flushActivity(second ?? first);
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.deepEqual(projection.activity?.slice(-3).map((activity) => activity.status), ["idle", "idle", "idle"]);

    const addressedStarted = codexEvent("item/started", {
      item: {
        type: "mcpToolCall", id: "wait_codex_addressed", server: "letagents", tool: "wait_for_messages",
        status: "inProgress", arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
      },
    });
    const addressedCompleted = codexEvent("item/completed", {
      item: {
        type: "mcpToolCall", id: "wait_codex_addressed", server: "letagents", tool: "wait_for_messages",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: { content: [], structuredContent: { messages: [{ id: "msg_14", text: "please act" }] }, _meta: null },
        error: null,
        durationMs: 1,
      },
    });
    await firstInternals.handleProviderStream(env.id, handle, addressedStarted);
    await firstInternals.handleProviderStream(env.id, handle, addressedCompleted);
    assert.deepEqual(published.slice(-2), ["idle", "working"], "a real addressed Codex completion wakes the work indicator");
    await flushActivity(second ?? first);
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "working");
    assert.equal(projection.activity?.at(-1)?.status, "working");

    await firstInternals.handleProviderStream(env.id, handle, wait("wait_restart"));
    await first.stop();
    second = new SupervisorDaemon(paths, "darwin", env.port, false);
    await second.start();
    const afterRestart: Array<"working" | "idle"> = [];
    const secondInternals = await install(second, afterRestart);
    await secondInternals.handleProviderStream(env.id, handle, result("wait_restart", []));
    assert.deepEqual(afterRestart, ["idle"], "persisted wait correlation survives a daemon restart mid-poll");
    await flushActivity(second ?? first);
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "idle");
  } finally {
    await second?.stop();
    await first.stop();
    await env.cleanup();
  }
});
