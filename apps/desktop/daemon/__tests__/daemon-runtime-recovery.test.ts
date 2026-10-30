import { recordInterruptedCursorRecovery } from "../runtime-recovery-journal.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { SupervisorGrantRequestError } from "../main.js";
import { type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRoomMoveRecord, type TaskWorkAttempt } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import type { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import { OpenCodeRuntimeGoneError } from "../../electron/main/agents/open-model-provider-adapter.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import {
  SupervisorDaemon,
  noWorkLeaseHttp,
  fixture,
  admitDaemonInboxForProviderTest,
  eventually,
  fakeRecoveryClock,
  daemonRequest,
  TEST_SUPERVISOR,
  provisionedWorkspace,
  committedSourceRepository,
  primeDaemonBareRepository,
  fakeGit,
  entry, testDaemonEndpoint } from "./helpers/daemon-fixture.js";
import { testNamedDaemonEndpoint } from "../../electron/__tests__/platform.js";

for (const providerId of ["open-model", "claude-code", "codex"] as const) {
test(`explicit runtime recovery retires proven-dead ${providerId} without replacing the durable agent`, async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "recover_dead_opencode_runtime";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath,
    paths.attemptsRoot,
    undefined,
    join(env.root, "worktrees"),
    undefined,
    fakeGit(env.root),
    undefined,
    TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({
    taskId: id,
    leaseId: id,
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const deadConnection = providerId === "claude-code"
    ? { kind: "claude_cli" as const, pid: 45550, processIdentity: "Mon Sep 14 15:50:00 2026" }
    : providerId === "codex"
      ? { kind: "codex_app_server" as const, pid: 45550, processIdentity: "Mon Sep 14 15:50:00 2026", url: "ws://127.0.0.1:45550" }
      : { kind: "opencode_server" as const, pid: 45550, processIdentity: "opencode-birth-45550",
          url: "http://127.0.0.1:52486", serverAuthPath: join(env.root, "opencode", "server-auth.json") };
  const death = deadConnection.kind === "opencode_server" ? undefined
    : { kind: deadConnection.kind, pid: deadConnection.pid, processIdentity: deadConnection.processIdentity };
  const calls = { attach: 0, spawn: 0, resume: 0, converge: 0 };
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async () => { calls.spawn += 1; throw new Error("recovery converges only after the RPC returns"); },
    attach: async (ref) => {
      calls.attach += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.equal(ref.providerContinuationId, "ses_dead_opencode");
      return {
        state: "terminal",
        terminal: {
          endedAt: "2099-07-29T12:00:00.000Z",
          exitCode: 1,
          signal: null,
          terminalCause: "crashed",
          providerContinuationId: "ses_dead_opencode",
          ...(death ? { nativeRuntimeDeath: death } : {}),
        },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { calls.resume += 1; throw new Error("recovery must not resume the dead provider"); },
    poke: async () => {},
    stop: async () => ({
      endedAt: "2099-07-29T12:00:00.000Z",
      exitCode: 1,
      signal: null,
      terminalCause: "crashed",
      providerContinuationId: "ses_dead_opencode",
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { requestConvergence: (entryId: string) => void; store: ManifestStore; durability: WorkDurabilityStore };
    internals.requestConvergence = (entryId) => {
      assert.equal(entryId, id);
      calls.converge += 1;
    };
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: providerId,
      delivery_mode: "daemon_inbox",
      desired_state: "running",
      observed_state: "recovering",
      condition: "coordination_blocked",
      last_error: "convergence scheduler failure: The saved OpenCode process is no longer running.",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "ses_dead_opencode",
        provider_connection: deadConnection,
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    calls.converge = 0;
    const blockedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(
      blockedProjection.room_agent_state?.connection.state,
      "disconnected",
      "a blocked recovery with no live provider handle cannot masquerade as reconnecting authority",
    );
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    let releases = 0;
    const release = internals.durability.releaseTerminalExecutionFence.bind(internals.durability);
    internals.durability.releaseTerminalExecutionFence = async (...args) => { releases++; await release(...args); };
    const settle = internals.store.settleWitnessedRuntimeApprovalClosures.bind(internals.store);
    let failSettlement = providerId === "codex";
    internals.store.settleWitnessedRuntimeApprovalClosures = async (...args) => {
      if (failSettlement) { failSettlement = false; throw new Error("transient closure failure"); }
      return settle(...args);
    };
    const recover = () => daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", { entry_id: id, daemon_generation: generation });
    let result = await recover();
    if (providerId === "codex") {
      assert.equal(result.ok, false); assert.match(result.error!, /transient closure failure/);
      assert.equal(releases, 0);
      result = await recover();
    }
    assert.equal(releases, 1, "a retry finishes the exact witnessed runtime's fence release");
    assert.equal(result.ok, true, result.error);
    const recovered = (result.result as { entry: DaemonManifestEntryView }).entry;
    assert.equal(recovered.id, id);
    assert.equal(recovered.workspace_path, attempt.workspace_path);
    assert.equal(recovered.work_attempt_id, attempt.work_attempt_id);
    assert.equal(recovered.provider_ref, null);
    assert.equal(recovered.observed_state, "starting");
    assert.equal(recovered.condition, "none");
    assert.deepEqual(calls, { attach: 1, spawn: 0, resume: 0, converge: 1 });

    const durable = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as {
      execution_generations: Array<{ execution_generation_id: string; terminal: { native_runtime_death?: unknown } }>;
    };
    assert.equal(durable.execution_generations.length, 1, "recovery does not start a provider generation inline");
    assert.equal(durable.execution_generations[0]?.execution_generation_id, execution.execution_generation_id);
    assert.ok(durable.execution_generations[0]?.terminal, "exact terminal evidence is persisted before replacement");
    assert.deepEqual(durable.execution_generations[0]?.terminal.native_runtime_death, death);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});
}

for (const cachedLane of [false, true]) {
for (const missingTurn of [false, true]) {
for (const recoveryFailure of ["none", "stop", "end", "commit"] as const) {
  if (recoveryFailure !== "none" && (!cachedLane || !missingTurn)) continue;
for (const apiUrl of ["https://letagents.test", "http://[::1]:3000"]) {
  if (apiUrl !== "https://letagents.test" && (!cachedLane || missingTurn || recoveryFailure !== "none")) continue;
  test(`runtime recovery releases a crashed Cursor FIFO without replay (${cachedLane ? "cached idle lane" : "terminal execution"}; ${missingTurn ? "missing native turn" : "captured native turn"}; ${recoveryFailure}; ${apiUrl})`, async () => {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const id = "recover_blocked_cursor";
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined,
      join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0,
      workspacePath: workspace.path, workAttemptId: workspace.id });
    const failedExecution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
    if (!cachedLane || missingTurn) await durability.recordTerminal(attempt.work_attempt_id, failedExecution.execution_generation_id, {
      ended_at: new Date().toISOString(), exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "",
      terminal_cause: "crashed", actor: "daemon-provider", generation: 1,
      provider_continuation_id: "cursor_crashed_continuation",
    });
    const execution = cachedLane && missingTurn
      ? await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 2)
      : failedExecution;
    await durability.close();
    const handle: ProviderActionHandle = {
      workAttemptId: attempt.work_attempt_id, pid: null, providerContinuationId: "cursor_crashed_continuation",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
      observedState: "idle", appliedConfigurationRevision: 1,
    };
    const calls = { stop: 0, converge: 0 };
    let onExit: ((terminal: Awaited<ReturnType<ProviderActionPort["stop"]>>) => void) | undefined;
    let observe!: (event: NativeExecutionObservation) => void;
    let sourceSequence = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: false,
        permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { throw new Error("replacement must converge after recovery returns"); },
      resume: async () => { throw new Error("failed continuation must not be resumed"); },
      attach: async () => { throw new Error("the exact processless lane is already installed"); },
      attachAction: async () => ({ state: "absent" }), poke: async () => {},
      stop: async (current) => {
        assert.equal(current, handle);
        calls.stop++;
        if (recoveryFailure === "stop") throw new Error("injected lane stop failure");
        const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: null,
          terminalCause: "stopped" as const, providerContinuationId: handle.providerContinuationId };
        handle.observedState = "stopped";
        onExit?.(terminal);
        return terminal;
      },
      onExit: async (_handle, listener) => { onExit = listener; return () => { onExit = undefined; }; },
      onStream: async () => () => {},
      onExecution: async (_current, listener) => {
        observe = listener;
        return { sourceId: "recovery-successor-source", position: () => ({ firstRetainedSequence: 1, latestSequence: sourceSequence }), dispose() {} };
      },
    };
    const leaseEvents: string[] = [];
    let lease = { id: "cursor-lease", task_id: "cursor-task", room_id: entry.room_id,
      agent_session_id: "retired-worker", agent_key: "owner/cursor", agent_instance_id: `daemon:${id}`, epoch: 4 };
    const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      endWorkerSession: async input => {
        assert.equal(input.sessionId, "retired-worker");
        assert.equal(input.restarting, true, "recovery starts the agent again in the same room");
        if (recoveryFailure === "end") throw new Error("injected worker retirement failure");
        leaseEvents.push("retire");
      },
      createWorkerSession: async () => {
        assert.equal(leaseEvents[0], "retire", "the predecessor must retire before its successor is minted");
        leaseEvents.push("mint");
        return { sessionId: "successor-worker", bearer: "inert-secret", bearerId: "inert-bearer", expiresAt: null };
      },
      getExecutionDelegation: async () => { throw new Error("unexpected delegation HTTP"); },
      listWorkLeases: async () => [lease], readWorkLease: async () => lease,
      attestWorkLease: async input => {
        assert.equal(input.executionGenerationId, execution.execution_generation_id);
        assert.equal(input.cause, "stopped");
        leaseEvents.push("attest");
        return "inert-attestation";
      },
      rebindWorkLease: async input => {
        leaseEvents.push("rebind");
        lease = { ...lease, agent_session_id: input.toSessionId, epoch: lease.epoch + 1 };
        return lease;
      },
    });
    try {
      await daemon.start();
      const internals = daemon as unknown as {
        requestConvergence: (entryId: string) => void;
        providerStreams: ProviderStreamCoordinator;
        supervisedInbox: SupervisedAgentInboxStore;
        liveHandles: Map<string, ProviderActionHandle>;
        store: ManifestStore;
        durability: WorkDurabilityStore;
        manifestGeneration: number;
        workerBindings: WorkerBindingStore;
        workerRuntimeCustody: WorkerRuntimeCustody;
        workerAuthority: import("../worker-authority-coordinator.js").WorkerAuthorityCoordinator;
      };
      internals.requestConvergence = () => { calls.converge++; };
      const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "cursor", delivery_mode: "daemon_inbox", observed_state: "idle",
        desired_state: "running", condition: "none", last_error: null,
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
        provider_ref: { work_attempt_id: attempt.work_attempt_id,
          execution_generation_id: execution.execution_generation_id,
          provider_continuation_id: handle.providerContinuationId, provider_connection: handle.providerConnection },
      } });
      assert.equal(put.ok, true, put.error);
      if (cachedLane) await internals.providerStreams.install(id, handle, execution.execution_generation_id);
      calls.converge = 0;
      const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      const recover = () => daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", {
        entry_id: id, daemon_generation: generation,
      });
      if (cachedLane) assert.match((await recover()).error!, /still connected/, "healthy idle lanes are not failed runtimes");
      const head = await internals.supervisedInbox.enqueueInitialMessage({ agent_id: id, room_id: entry.room_id,
        source_message_id: "failed-message", source_message: { text: "failed turn" }, activation: {} });
      await internals.supervisedInbox.transition(head.inbox_item_id, "dispatching");
      await internals.supervisedInbox.checkpointTurnStarted(head.inbox_item_id, "cursor-crashed-turn", {
        work_attempt_id: attempt.work_attempt_id, origin_execution_generation_id: failedExecution.execution_generation_id,
        provider_continuation_id: handle.providerContinuationId!,
      });
      await internals.supervisedInbox.transition(head.inbox_item_id, "blocked", {
        last_error: "Cursor's live MCP connector ended before the turn became terminal.",
      });
      const later = await internals.supervisedInbox.enqueueInitialMessage({ agent_id: id, room_id: entry.room_id,
        source_message_id: "later-message", source_message: { text: "later turn" }, activation: {} });
      const before = await internals.supervisedInbox.get(head.inbox_item_id);
      const bindingBefore = await internals.supervisedInbox.providerTurnBinding(head.inbox_item_id);
      const capture = new DatabaseSync(paths.manifestPath);
      const shadow = new ExecutionShadowStore(capture);
      const oldRuntime = executionRuntimeStorageIdentity(id, failedExecution.execution_generation_id, "cursor_cli", 7124, "crashed-child");
      const oldIdentity = { agentId: id, executionGenerationId: failedExecution.execution_generation_id, runtimeGenerationId: oldRuntime };
      shadow.registerRuntime({ ...oldIdentity, provider: "cursor", authorityMode: "typed", configRevision: 1, createdAtMs: 1 });
      const oldAttempt = shadow.trackMessage({ agentId: id, roomId: entry.room_id, sourceMessageId: "failed-message",
        executionGenerationId: failedExecution.execution_generation_id, workspaceId: attempt.work_attempt_id, createdAtMs: 1 });
      const oldTurn = { turnId: "captured-crashed-turn", providerContinuationId: handle.providerContinuationId!, providerTurnId: missingTurn ? "previous-completed-turn" : "cursor-crashed-turn" };
      shadow.trackNativeTurn({ ...oldIdentity, ...oldTurn, attemptId: oldAttempt, roomId: entry.room_id, createdAtMs: 1 });
      const oldObserver = shadow.bindObserver({ agentId: id, subjectRuntimeGenerationId: oldRuntime, observerRuntimeGenerationId: oldRuntime,
        daemonGenerationId: String(generation), sourceId: "crashed-source", expectedEpoch: 0, boundAtMs: 1 });
      shadow.ingest(oldObserver.sourceId, oldObserver, { ...oldIdentity, ...oldTurn, factId: "crashed-lost", observerEpoch: oldObserver.epoch,
        sourceSequence: 1, observedAtMs: 2, domain: "turn", kind: "state_changed", state: missingTurn ? "terminal" : "lost", sideEffects: "none",
        ...(missingTurn ? { turnOutcome: "completed" as const } : {}) });
      if (missingTurn) {
        capture.prepare("UPDATE execution_runtime_generations SET runtime_state='exited',control_state='lost',ended_at_ms=2 WHERE runtime_generation_id=?").run(oldRuntime);
        shadow.registerRuntime({ ...oldIdentity, runtimeGenerationId: "uncaptured-next-child", provider: "cursor",
          authorityMode: "typed", configRevision: 1, createdAtMs: 3 });
      }
      shadow.observeSourcePosition(oldObserver.sourceId, oldObserver, 9);
      const oldFacts = capture.prepare("SELECT * FROM execution_facts WHERE runtime_generation_id=?").all(oldRuntime);
      const oldRuntimeBefore = capture.prepare("SELECT * FROM execution_runtime_generations WHERE runtime_generation_id=?").get(oldRuntime);
      if (cachedLane) {
        handle.pid = 42;
        handle.providerConnection = { kind: "cursor_cli", pid: 42, processIdentity: "live-wrapper" };
        assert.match((await recover()).error!, /still connected/, "a live wrapper must not be discarded");
        handle.pid = null;
        handle.providerConnection = { kind: "cursor_cli", pid: null, processIdentity: null };
        handle.providerContinuationId = "another-continuation";
        assert.match((await recover()).error!, /still connected/, "recovery must target the exact continuation");
        handle.providerContinuationId = "cursor_crashed_continuation";
      }
      assert.equal(calls.stop, 0);
      const readTurnBinding = internals.supervisedInbox.providerTurnBinding.bind(internals.supervisedInbox);
      for (const key of ["agent_id", "room_id", "work_attempt_id", "origin_execution_generation_id", "provider_continuation_id", "provider_turn_id"]) {
        internals.supervisedInbox.providerTurnBinding = async () => ({ ...bindingBefore!, [key]: "unrelated" });
        assert.match((await recover()).error!, /exact provider authority/, key);
        assert.equal(calls.stop, 0, "unverified turn authority must fail before stopping a lane");
        assert.deepEqual(await internals.supervisedInbox.get(head.inbox_item_id), before);
      }
      internals.supervisedInbox.providerTurnBinding = readTurnBinding;

      if (!cachedLane) {
        const database = new DatabaseSync(paths.manifestPath);
        try {
          // replaceEntry settles the inbox before replacing its runtime rows.
          // Fail at that boundary to prove a crash cannot leave a released FIFO
          // alongside the old continuation for startup convergence to resume.
          database.exec(`CREATE TRIGGER reject_cursor_runtime_reset BEFORE DELETE ON agent_identities
            WHEN OLD.agent_id='recover_blocked_cursor'
            BEGIN SELECT RAISE(ABORT, 'injected runtime reset failure'); END`);
          assert.match((await recover()).error!, /injected runtime reset failure/);
          assert.deepEqual(await internals.supervisedInbox.get(head.inbox_item_id), before);
          const saved = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])
            .find((candidate) => candidate.id === id)!;
          assert.equal(saved.provider_ref?.provider_continuation_id, "cursor_crashed_continuation");
          assert.equal(calls.converge, 0);
          assert.equal(capture.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=?").get(id)!.n, 0);
          assert.equal(capture.prepare("SELECT observer_epoch FROM execution_observers WHERE agent_id=?").get(id)!.observer_epoch, oldObserver.epoch);
          database.exec("DROP TRIGGER reject_cursor_runtime_reset");
        } finally {
          database.close();
        }
      }

      if (missingTurn && !cachedLane) {
        capture.prepare("UPDATE execution_runtime_generations SET runtime_state='ready',ended_at_ms=NULL WHERE runtime_generation_id=?").run(oldRuntime);
        assert.match((await recover()).error!, /unrelated or unretired Cursor observer/);
        assert.deepEqual(await internals.supervisedInbox.get(head.inbox_item_id), before);
        capture.prepare("UPDATE execution_runtime_generations SET runtime_state='exited',ended_at_ms=2 WHERE runtime_generation_id=?").run(oldRuntime);
        for (const [table, key, value, column, invalid] of [
          ["execution_turns", "turn_id", oldTurn.turnId, "provider_continuation_id", "unrelated"],
          ["execution_attempt_generations", "attempt_id", oldAttempt, "workspace_id", "unrelated"],
          ["execution_runtime_generations", "runtime_generation_id", oldRuntime, "provider", "codex"],
          ["execution_runtime_generations", "runtime_generation_id", oldRuntime, "control_state", "responsive"],
          ["execution_observers", "agent_id", id, "observer_runtime_generation_id", "uncaptured-next-child"],
        ]) {
          const original = capture.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${key}=?`).get(value)!.value;
          capture.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(invalid, value);
          assert.match((await recover()).error!, /unrelated or unretired Cursor observer/, column);
          assert.deepEqual(await internals.supervisedInbox.get(head.inbox_item_id), before, "rejected recovery cannot clear the failed delivery");
          assert.equal(capture.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=?").get(id)!.n, 0);
          capture.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(original, value);
        }
      }
      internals.workerRuntimeCustody.installHostGrant({
        entryId: id, roomId: entry.room_id, agentKey: lease.agent_key, grantId: "cursor-grant",
        supervisorGrant: "inert-grant", grantGeneration: 1, apiUrl,
        daemonGeneration: generation, hostId: "host", installationId: "installation", expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await internals.workerBindings.bind({ entry_id: id, room_id: entry.room_id,
        work_attempt_id: attempt.work_attempt_id, execution_generation_id: execution.execution_generation_id,
        agent_session_id: lease.agent_session_id, agent_session_token: "inert-old-secret", api_url: apiUrl });
      await internals.workerBindings.recordExecutionBinding({ entry_id: id, room_id: entry.room_id,
        work_attempt_id: attempt.work_attempt_id, execution_generation_id: execution.execution_generation_id,
        agent_session_id: lease.agent_session_id, api_url: apiUrl, grant_id: "cursor-grant", agent_key: lease.agent_key });
      if (recoveryFailure === "commit") capture.exec(`CREATE TRIGGER reject_retirement BEFORE INSERT ON agent_runtime_recoveries
        BEGIN SELECT RAISE(ABORT, 'injected retirement commit failure'); END`);
      const result = await recover();
      if (recoveryFailure !== "none") {
        assert.equal(result.ok, false);
        assert.match(result.error!, /injected .* failure/);
        assert.deepEqual(await internals.supervisedInbox.get(head.inbox_item_id), before);
        assert.equal((await internals.supervisedInbox.get(later.inbox_item_id))?.attempt_count, 0);
        assert.equal(capture.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=?").get(id)!.n, 0);
        assert.deepEqual(capture.prepare("SELECT * FROM execution_facts WHERE runtime_generation_id=?").all(oldRuntime), oldFacts);
        assert.ok(leaseEvents.every(event => !["mint", "attest", "rebind"].includes(event)));
        capture.close();
        return;
      }
      assert.equal(result.ok, true, result.error);
      const recovered = (result.result as { entry: DaemonManifestEntryView }).entry;
      assert.equal(recovered.provider_ref, null);
      assert.equal(recovered.observed_state, "starting");
      assert.equal(recovered.condition, "none");
      assert.equal(recovered.work_attempt_id, attempt.work_attempt_id);
      assert.equal(recovered.workspace_path, attempt.workspace_path);
      assert.equal(internals.liveHandles.has(id), false);
      assert.deepEqual(calls, { stop: cachedLane ? 1 : 0, converge: 1 });
      const settled = await internals.supervisedInbox.get(head.inbox_item_id);
      assert.equal(settled?.state, "cancelled_by_user");
      assert.equal(settled?.provider_turn_id, before?.provider_turn_id);
      assert.equal(settled?.attempt_count, before?.attempt_count);
      assert.ok(settled?.last_error?.includes(before!.last_error!));
      assert.deepEqual(await internals.supervisedInbox.providerTurnBinding(head.inbox_item_id), bindingBefore);
      assert.equal((await internals.supervisedInbox.head(id))?.inbox_item_id, later.inbox_item_id,
        "explicit recovery releases the FIFO without replaying the failed turn");
      assert.equal((await internals.supervisedInbox.get(later.inbox_item_id))?.attempt_count, 0);
      const durable = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as TaskWorkAttempt;
      assert.equal(durable.execution_generations.length, cachedLane && missingTurn ? 2 : 1);
      assert.equal(durable.execution_generations[0]?.terminal?.terminal_cause, cachedLane && !missingTurn ? "stopped" : "crashed");
      assert.equal(durable.execution_generations.at(-1)?.terminal?.terminal_cause, cachedLane ? "stopped" : "crashed");
      const boundary = capture.prepare("SELECT phase,observer_json FROM agent_runtime_recoveries WHERE agent_id=? AND runtime_generation_id=?").get(id, oldRuntime)!;
      assert.ok(boundary, "recovery must archive the exact prior observer even when the failed native turn was not captured");
      assert.equal(boundary.phase, "complete");
      assert.equal(JSON.parse(String(boundary.observer_json)).max_observed_sequence, 9);
      assert.deepEqual(capture.prepare("SELECT * FROM execution_facts WHERE runtime_generation_id=?").all(oldRuntime), oldFacts);
      assert.equal(capture.prepare("SELECT state FROM execution_turns WHERE turn_id=?").get(oldTurn.turnId)!.state, missingTurn ? "terminal" : "lost");
      if (missingTurn) {
        assert.deepEqual(capture.prepare("SELECT * FROM execution_runtime_generations WHERE runtime_generation_id=?").get(oldRuntime), oldRuntimeBefore, "known predecessor retirement stays exact");
        assert.equal(capture.prepare("SELECT COUNT(*) AS n FROM execution_turns WHERE provider_turn_id='cursor-crashed-turn'").get()!.n, 0, "recovery never invents the uncaptured turn");
        assert.equal(capture.prepare("SELECT runtime_state FROM execution_runtime_generations WHERE runtime_generation_id='uncaptured-next-child'").get()!.runtime_state, "starting", "uncaptured native history stays unknown");
      }
      assert.throws(() => shadow.observeSourcePosition(oldObserver.sourceId, oldObserver, 10), /stale_observer/);

      const archivedRef = JSON.parse(String(capture.prepare("SELECT provider_ref_json FROM agent_runtime_recoveries WHERE agent_id=?").get(id)!.provider_ref_json));
      assert.equal(archivedRef.execution_generation_id, failedExecution.execution_generation_id);
      if (cachedLane) {
        assert.equal(archivedRef.cursor_lane_retirement.execution_generation_id, execution.execution_generation_id);
        assert.equal(execution.execution_generation_id === failedExecution.execution_generation_id, !missingTurn,
          "receipt identifies the stopped lane for both same-generation and older archived turns");
        capture.exec("BEGIN");
        try {
          assert.throws(() => recordInterruptedCursorRecovery(capture, bindingBefore!, new Date().toISOString(),
            archivedRef.cursor_lane_retirement), /cannot rewrite an archived/);
        } finally { capture.exec("ROLLBACK"); }
        capture.exec("BEGIN");
        try {
          assert.throws(() => recordInterruptedCursorRecovery(capture, { ...bindingBefore!, agent_id: "uncaptured-agent", origin_execution_generation_id: "uncaptured" },
            new Date().toISOString(), archivedRef.cursor_lane_retirement), /requires a new captured/);
        } finally { capture.exec("ROLLBACK"); }
        // Same-session grant rotation keeps both launch receipts for one lane.
        await internals.workerBindings.recordExecutionBinding({ entry_id: id, room_id: entry.room_id,
          work_attempt_id: attempt.work_attempt_id, execution_generation_id: execution.execution_generation_id,
          agent_session_id: "retired-worker", api_url: apiUrl, grant_id: "older-grant", agent_key: lease.agent_key });
        const reopened = new WorkerBindingStore(join(env.root, "reopened-bindings.json"), undefined, paths.manifestPath);
        try {
          const predecessors = await reopened.executionPredecessors(id, attempt.work_attempt_id, entry.room_id);
          assert.equal(predecessors.length, 2);
          assert.ok(predecessors.every(record => record.cursor_lane_retirement?.execution_generation_id === execution.execution_generation_id),
            "a new store reconstructs proof for rotated-grant receipts from committed bytes");
          for (const field of ["kind", "entry_id", "room_id", "work_attempt_id", "execution_generation_id",
            "agent_session_id", "api_url", "grant_id", "agent_key", "provider_continuation_id"]) {
            const altered = { ...archivedRef, cursor_lane_retirement: { ...archivedRef.cursor_lane_retirement, [field]: "wrong" } };
            try {
              capture.prepare("UPDATE agent_runtime_recoveries SET provider_ref_json=? WHERE agent_id=?").run(JSON.stringify(altered), id);
              assert.ok((await reopened.executionPredecessors(id, attempt.work_attempt_id, entry.room_id)).every(record => !record.cursor_lane_retirement), field);
            } finally { capture.prepare("UPDATE agent_runtime_recoveries SET provider_ref_json=? WHERE agent_id=?").run(JSON.stringify(archivedRef), id); }
          }
        } finally { await reopened.close(); }
      } else assert.equal(archivedRef.cursor_lane_retirement, undefined);

      // Recovery must cross real durable predecessor lookup and lease admission,
      // not manually create a successor that bypasses the failed cloud boundary.
      if (cachedLane) {
        assert.ok(await internals.workerAuthority.mintHostWorkerAuthorization(recovered));
        assert.deepEqual(leaseEvents, ["retire", "mint", "attest", "rebind"]);
        assert.equal(lease.agent_session_id, "successor-worker");
        assert.equal(lease.epoch, 5);
      } else {
        // An unproven predecessor keeps its lease, but no longer costs the
        // successor its room access; the unmoved lease expires on its own.
        assert.ok(await internals.workerAuthority.mintHostWorkerAuthorization(recovered));
        assert.deepEqual(leaseEvents, ["retire", "mint"], "no attestation or rebind without proof");
        assert.equal(lease.epoch, 4, "an old terminal/archive alone does not prove lane retirement");
        assert.equal(lease.agent_session_id, "retired-worker", "the unproven lease stays with its previous owner");
      }

      // Drive the next FIFO message through the real native observation path.
      const nextExecution = await internals.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 3);
      const nextConnection = { kind: "cursor_cli" as const, pid: 7125, processIdentity: "replacement-child" };
      const nextHandle: ProviderActionHandle = { ...handle, observedState: "working", pid: nextConnection.pid,
        providerContinuationId: "fresh-continuation", providerConnection: nextConnection };
      const birth = await internals.store.checkpointProviderBirth(internals.manifestGeneration, {
        entry: { ...recovered, provider_ref: { work_attempt_id: attempt.work_attempt_id,
          execution_generation_id: nextExecution.execution_generation_id, provider_continuation_id: nextHandle.providerContinuationId!,
          provider_connection: nextConnection } }, executionGenerationId: nextExecution.execution_generation_id,
        providerConnection: nextConnection, appliedRevision: 1, requestedAuthorityMode: "typed", observedAtMs: Date.now(),
      });
      internals.manifestGeneration = birth.generation;
      await internals.supervisedInbox.transition(later.inbox_item_id, "dispatching");
      await internals.supervisedInbox.checkpointTurnStarted(later.inbox_item_id, "next-turn", {
        work_attempt_id: attempt.work_attempt_id, origin_execution_generation_id: nextExecution.execution_generation_id,
        provider_continuation_id: nextHandle.providerContinuationId!,
      });
      await internals.providerStreams.install(id, nextHandle, nextExecution.execution_generation_id);
      await eventually(async () => Boolean(observe), "replacement capture subscribes");
      for (const state of ["active", "terminal"] as const) {
        observe({ sourceId: "recovery-successor-source", sequence: ++sourceSequence, observedAtMs: Date.now(),
          nativeProcessPid: nextConnection.pid, nativeProcessIdentity: nextConnection.processIdentity,
          fact: { domain: "turn", kind: "state_changed", state, providerContinuationId: nextHandle.providerContinuationId!,
            providerTurnId: "next-turn", sideEffects: "none", ...(state === "terminal" ? { turnOutcome: "completed" as const } : {}) } });
      }
      await eventually(async () => capture.prepare("SELECT state FROM execution_turns WHERE provider_turn_id='next-turn'").get()?.state === "terminal",
        "the next captured turn completes beyond the retained lost turn");
      assert.equal(shadow.retainedMessageExecution(id, entry.room_id, "failed-message").availability, "available");
      capture.close();
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  });
}
}
}
}

test("runtime recovery atomically fails a pre-join room move without losing its activating authority evidence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "move-recovery.lock"), ...testNamedDaemonEndpoint(env.root, "move-recovery"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "move-recovery-audit.jsonl"),
    attemptsPath: join(env.root, "move-recovery-attempts.json"), attemptsRoot: join(env.root, "move-recovery-attempt-data"), workspaceRoot: env.root,
  };
  const id = "recover_runtime_with_waiting_move";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath,
    paths.attemptsRoot,
    undefined,
    join(env.root, "worktrees"),
    undefined,
    fakeGit(env.root),
    undefined,
    TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({
    taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
  });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const continuation = "recovery-move-continuation";
  let attachCalls = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
      transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true,
    }),
    spawn: async () => { throw new Error("recovery test does not launch inline"); },
    attach: async () => {
      attachCalls += 1;
      return {
        state: "terminal",
        terminal: {
          endedAt: "2099-08-05T10:00:00.000Z", exitCode: 1, signal: null,
          terminalCause: "crashed", providerContinuationId: continuation,
        },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("dead runtime must not resume"); },
    poke: async () => {},
    stop: async () => ({
      endedAt: "2099-08-05T10:00:00.000Z", exitCode: 1, signal: null,
      terminalCause: "crashed", providerContinuationId: continuation,
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  let joinCalls = 0;
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
    joinRoom: async (input) => { joinCalls += 1; return { roomId: input.roomId }; },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      requestConvergence: (entryId: string) => void;
      store: ManifestStore;
      supervisedInbox: SupervisedAgentInboxStore;
      reconcileRoomMove: (move: DaemonRoomMoveRecord) => Promise<DaemonRoomMoveRecord>;
    };
    internals.requestConvergence = () => {};
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      delivery_mode: "daemon_inbox",
      desired_state: "running",
      observed_state: "recovering",
      condition: "none",
      last_error: null,
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: continuation,
        provider_connection: {
          kind: "opencode_server",
          url: "http://127.0.0.1:52487",
          pid: 45_551,
          processIdentity: "opencode-birth-45551",
          serverAuthPath: join(env.root, "opencode", "server-auth.json"),
        },
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    const [activating] = await internals.supervisedInbox.ingestPoll({
      agent_id: id,
      room_id: entry.room_id,
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "move before recovery" }, activation: { decision: "activate" } }],
    });
    assert(activating);
    assert.equal((await internals.supervisedInbox.claimHead(id))?.inbox_item_id, activating.inbox_item_id);
    const providerTurnId = "recover-move-turn";
    await internals.supervisedInbox.checkpointTurnStarted(activating.inbox_item_id, providerTurnId, {
      work_attempt_id: attempt.work_attempt_id,
      origin_execution_generation_id: execution.execution_generation_id,
      provider_continuation_id: continuation,
    });
    const ambiguous = await internals.supervisedInbox.prepareRoomMoveEffect({
      agent_id: id,
      room_id: entry.room_id,
      effect_execution_generation_id: execution.execution_generation_id,
      provider_turn_id: providerTurnId,
      mcp_request_id: "recover-move-request",
      request: { name: "room-after-recovery" },
      destination_room_id: "room-after-recovery",
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      work_attempt_id: attempt.work_attempt_id,
      execution_generation_id: execution.execution_generation_id,
      provider_continuation_id: continuation,
      agent_session_id: "recover-move-session",
      activating_inbox_item_id: activating.inbox_item_id,
    });
    const pending = (await internals.store.pendingRoomMoves(id))[0]!;
    assert.equal((await internals.reconcileRoomMove(pending)).phase, "waiting_for_current_turn");
    await internals.store.advanceRoomMove({
      operationId: pending.operation_id,
      agentId: id,
      expectedDaemonGeneration: pending.daemon_generation,
      expectedExecutionGenerationId: execution.execution_generation_id,
      from: ["waiting_for_current_turn"],
      to: "joining_destination",
    });
    const blocked = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", {
      entry_id: id,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
    });
    assert.equal(blocked.ok, false);
    assert.match(String(blocked.error), /blocked while a room move may have changed destination membership/i);
    assert.equal(attachCalls, 0, "post-join recovery rejects before attaching or recording terminal evidence");
    assert.ok((((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])?.provider_ref);
    assert.equal((await internals.store.getRoomMove(`room_move:${ambiguous.effect.effect_id}`))?.phase, "joining_destination");
    assert.ok(await internals.supervisedInbox.preparedRoomMove(id, execution.execution_generation_id, providerTurnId));

    // Retire the synthetic ambiguity without claiming an external join, then
    // seed the genuine pre-join case this test originally covered.
    await internals.store.advanceRoomMove({
      operationId: pending.operation_id,
      agentId: id,
      expectedDaemonGeneration: pending.daemon_generation,
      expectedExecutionGenerationId: execution.execution_generation_id,
      from: ["joining_destination"],
      to: "failed",
      error: "Test fixture proved no external join was issued.",
    });
    const prepared = await internals.supervisedInbox.prepareRoomMoveEffect({
      agent_id: id,
      room_id: entry.room_id,
      effect_execution_generation_id: execution.execution_generation_id,
      provider_turn_id: providerTurnId,
      mcp_request_id: "recover-move-request-prejoin",
      request: { name: "room-after-recovery" },
      destination_room_id: "room-after-recovery",
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
      work_attempt_id: attempt.work_attempt_id,
      execution_generation_id: execution.execution_generation_id,
      provider_continuation_id: continuation,
      agent_session_id: "recover-move-session",
      activating_inbox_item_id: activating.inbox_item_id,
    });
    const prejoin = (await internals.store.pendingRoomMoves(id))[0]!;
    assert.equal((await internals.reconcileRoomMove(prejoin)).phase, "waiting_for_current_turn");

    const result = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", {
      entry_id: id,
      daemon_generation: ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation,
    });
    assert.equal(result.ok, true, result.error);
    const recovered = (result.result as { entry: DaemonManifestEntryView }).entry;
    assert.equal(recovered.id, id);
    assert.equal(recovered.work_attempt_id, attempt.work_attempt_id);
    assert.equal(recovered.provider_ref, null);
    assert.equal(recovered.observed_state, "starting");
    assert.equal(attachCalls, 1);
    assert.equal(joinCalls, 0);
    assert.equal((await internals.store.getRoomMove(`room_move:${prepared.effect.effect_id}`))?.phase, "failed");
    assert.deepEqual(await internals.store.pendingRoomMoves(id), []);
    assert.equal((await internals.supervisedInbox.preparedRoomMove(id, execution.execution_generation_id, providerTurnId)), null);
    assert.equal((await internals.supervisedInbox.get(activating.inbox_item_id))?.state, "dispatching");
    assert.equal((await internals.supervisedInbox.providerTurnBinding(activating.inbox_item_id))?.provider_turn_id, providerTurnId);
    const durable = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as {
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    assert.ok(durable.execution_generations.find((candidate) =>
      candidate.execution_generation_id === execution.execution_generation_id)?.terminal);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a provably-gone provider runtime auto-recovers with a fresh runtime instead of dead-ending in recovering", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "auto_recover_gone_runtime";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"),
    undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const port: ProviderActionPort = {
    capabilities: async () => ({ deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("unused in this test"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("unused in this test"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: "ses_gone" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, { poll: async () => ({ messages: [] }), publish: async () => {} });
  try {
    await daemon.start();
    let scheduledConvergence = 0;
    const internals = daemon as unknown as {
      recordSchedulerFailure: (entryId: string, error: unknown, actor: string) => Promise<void>;
      scheduleRecoveryConvergence: (entryId: string, delayMs: number) => void;
      updateManifestEntry: (entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry) => Promise<DaemonManifestEntry>;
    };
    const realSchedule = internals.scheduleRecoveryConvergence.bind(internals);
    internals.scheduleRecoveryConvergence = (entryId, delayMs) => { if (entryId === id) scheduledConvergence += 1; void realSchedule; };
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "open-model", delivery_mode: "daemon_inbox",
      desired_state: "running", observed_state: "recovering", condition: "coordination_blocked",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id, provider_continuation_id: "ses_gone",
        provider_connection: { kind: "opencode_server", url: "http://127.0.0.1:52999", pid: 46_000, processIdentity: "opencode-birth-46000", serverAuthPath: join(env.root, "opencode", "server-auth.json") },
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);

    // The daemon observed the saved runtime is provably gone (adapter marks it).
    await internals.recordSchedulerFailure(id, new OpenCodeRuntimeGoneError(), "daemon-convergence");

    const recovered = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recovered.provider_ref, null, "the dead continuation is dropped so the next convergence spawns fresh");
    assert.equal(recovered.observed_state, "failed", "a failed edge engages the crash-loop backoff/quarantine machinery");
    assert.equal(recovered.condition, "none", "the entry is not left blocked; it is eligible for a fresh runtime");
    assert.match(String(recovered.last_error), /starting a replacement/);
    assert.equal(scheduledConvergence, 1, "a fresh-runtime convergence is scheduled automatically, no manual Recover required");

    // A non-gone durable-continuation failure must NOT drop the continuation:
    // the process may still be alive and resume must not spawn a competitor.
    // (manifest.put is idempotent for an existing id, so re-seed in place.)
    await internals.updateManifestEntry(id, (current) => ({
      ...current,
      observed_state: "recovering",
      condition: "none",
      last_error: null,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id, provider_continuation_id: "ses_unverified",
        provider_connection: { kind: "opencode_server", url: "http://127.0.0.1:52999", pid: 46_000, processIdentity: "opencode-birth-46000", serverAuthPath: join(env.root, "opencode", "server-auth.json") },
        execution_generation_id: execution.execution_generation_id,
      },
    }));
    await internals.recordSchedulerFailure(id, new Error("The saved OpenCode process could not be authenticated; refusing to start a competing runtime."), "daemon-convergence");
    const blocked = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.ok(blocked.provider_ref, "an unverifiable (maybe-alive) runtime keeps its continuation for a bounded retry");
    assert.equal(blocked.condition, "coordination_blocked", "it rests at an actionable blocked state, not a fresh-spawn reset");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("credential-only reconnect reattaches the exact OpenCode runtime and checkpoints recovered connection evidence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "credential_only_opencode_attach";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(
    paths.attemptsPath,
    paths.attemptsRoot,
    undefined,
    join(env.root, "worktrees"),
    undefined,
    fakeGit(env.root),
    undefined,
    TEST_SUPERVISOR,
  );
  const attempt = await durability.createAttempt({
    taskId: id,
    leaseId: id,
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  await durability.close();
  const recoveredConnection = {
    kind: "opencode_server" as const,
    url: "http://127.0.0.1:52486",
    pid: 45_550,
    processIdentity: "opencode-birth-45550",
    serverAuthPath: join(env.root, "opencode", "server-auth.json"),
  };
  const handle = {
    workAttemptId: attempt.work_attempt_id,
    pid: recoveredConnection.pid,
    providerContinuationId: "ses_exact_opencode",
    providerConnection: recoveredConnection,
    observedState: "idle" as const,
  };
  const calls = { attach: 0, spawn: 0, resume: 0, stop: 0, mint: 0 };
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async () => { calls.spawn += 1; throw new Error("reconnect must not spawn"); },
    attach: async (ref) => {
      calls.attach += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.equal(ref.providerContinuationId, handle.providerContinuationId);
      assert.equal(ref.providerConnection, null, "the adapter owns legacy connection recovery");
      return handle;
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { calls.resume += 1; throw new Error("reconnect must not resume"); },
    poke: async () => {},
    stop: async () => { calls.stop += 1; throw new Error("reconnect must not stop"); },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => {
      calls.mint += 1;
      return {
        sessionId: "session-opencode-reconnect",
        bearer: "opencode-reconnect-bearer",
        bearerId: "bearer-opencode-reconnect",
        expiresAt: null,
      };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      delivery_mode: "daemon_inbox",
      observed_state: "recovering",
      condition: "coordination_blocked",
      last_error: "durable execution generation remains live without an attachable provider handle",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: handle.providerContinuationId,
        provider_connection: null,
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const result = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id,
      room_id: entry.room_id,
      agent_key: "owner/opencode-agent",
      grant_id: "grant-opencode-reconnect",
      supervisor_grant: "opencode-reconnect-secret",
      grant_generation: 1,
      api_url: "https://letagents.example",
      host_id: "host-1",
      installation_id: "installation-1",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
      credential_only: true,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, {
      status: "installed",
      agent_session_id: "session-opencode-reconnect",
    });
    assert.deepEqual(calls, { attach: 1, spawn: 0, resume: 0, stop: 0, mint: 1 });
    const restored = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === id);
    assert.deepEqual(restored?.provider_ref?.provider_connection, recoveredConnection);
    assert.equal(restored?.provider_ref?.execution_generation_id, execution.execution_generation_id);
    assert.equal(restored?.provider_ref?.provider_continuation_id, handle.providerContinuationId);
    const internalStore = (daemon as unknown as { store: ManifestStore }).store;
    const restoredConfiguration = await internalStore.getAgentConfiguration(id);
    assert.ok(restoredConfiguration);
    assert.equal(await internalStore.readRuntimeLifecycleAuthority({
      agentId: id,
      executionGenerationId: execution.execution_generation_id,
      providerConnection: recoveredConnection,
      configurationRevision: restoredConfiguration.runtime_configuration_revision,
    }), "legacy", "reattach freezes the pre-existing native birth without current-policy inference");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("cursor admission repairs pre-upgrade running and stopped daemon-inbox entries without provider lifecycle work", async () => {
  for (const desiredState of ["running", "stopped"] as const) {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    };
    const lifecycle = { spawn: 0, resume: 0, stop: 0, converge: 0, mint: 0, tail: 0 };
    const tailId = desiredState === "running" ? "101" : "202";
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => { lifecycle.spawn += 1; throw new Error("cursor admission must not spawn"); },
      attach: async () => null, attachAction: async () => ({ state: "absent" }),
      resume: async () => { lifecycle.resume += 1; throw new Error("cursor admission must not resume"); }, poke: async () => {},
      stop: async () => { lifecycle.stop += 1; throw new Error("cursor admission must not stop"); },
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
      latest: async () => { lifecycle.tail += 1; return { messages: [{ id: tailId }] }; },
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      ...noWorkLeaseHttp,
      createWorkerSession: async () => {
        lifecycle.mint += 1;
        return { sessionId: `admission-${desiredState}`, bearer: "admission-bearer", bearerId: "admission-bearer-id", expiresAt: null };
      },
    });
    try {
      await daemon.start();
      const internals = daemon as unknown as { requestConvergence: (entryId: string) => void; supervisedInbox: SupervisedAgentInboxStore };
      const id = `cursorless_${desiredState}`;
      assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", desired_state: desiredState,
        observed_state: desiredState === "running" ? "working" : "stopped",
      } })).ok, true);
      let cursorObservedByConvergence: string | null | undefined;
      internals.requestConvergence = (entryId) => {
        lifecycle.converge += 1;
        void internals.supervisedInbox.cursor(entryId).then((cursor) => {
          cursorObservedByConvergence = cursor?.last_observed_message_id ?? null;
        });
      };
      const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: `grant-${desiredState}`,
        supervisor_grant: "admission-secret", grant_generation: 1, api_url: "https://letagents.example",
        host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation,
      })).ok, true);
      assert.deepEqual(lifecycle, { spawn: 0, resume: 0, stop: 0, converge: 0, mint: 0, tail: 0 }, "grant install cannot queue cursorless provider convergence");
      assert.equal(await internals.supervisedInbox.cursor(id), null, "no provider work is admitted before the first tail boundary");
      const admitted = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", { entry_id: id, daemon_generation: generation });
      assert.equal(admitted.ok, true, admitted.error);
      assert.deepEqual(admitted.result, { status: "bootstrapped", last_observed_message_id: tailId });
      assert.equal((await internals.supervisedInbox.cursor(id))?.last_observed_message_id, tailId, "history is skipped at the observed tail");
      if (desiredState === "running") {
        await eventually(async () => cursorObservedByConvergence !== undefined, "post-admission running convergence");
        assert.equal(cursorObservedByConvergence, tailId, "running convergence observes the committed admission cursor");
      } else {
        assert.equal(cursorObservedByConvergence, undefined, "stopped admission never queues provider convergence");
      }
      assert.deepEqual(lifecycle, {
        spawn: 0, resume: 0, stop: 0,
        converge: desiredState === "running" ? 1 : 0,
        mint: 1, tail: 1,
      }, "admission mints only a tail-reader session and never starts, resumes, or stops a provider");
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  }
});

test("fresh desktop bootstrap queues its initial message exactly once while legacy bootstrap queues none", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("stopped bootstrap must not spawn"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("stopped bootstrap must not resume"); }, poke: async () => {},
    stop: async () => { throw new Error("stopped bootstrap must not stop"); },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 15_000, undefined, {}, {
    latest: async () => ({ messages: [{ id: "44" }] }),
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => ({
      sessionId: "initial-message-session", bearer: "initial-message-bearer",
      bearerId: "initial-message-bearer-id", expiresAt: null,
    }),
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { supervisedInbox: SupervisedAgentInboxStore };
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    for (const id of ["fresh_initial_message", "legacy_without_initial_message"]) {
      assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "codex", delivery_mode: "daemon_inbox",
        desired_state: "stopped", observed_state: "stopped",
      } })).ok, true);
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: id, room_id: entry.room_id, agent_key: `owner/${id}`, grant_id: `grant-${id}`,
        supervisor_grant: `grant-secret-${id}`, grant_generation: 1, api_url: "https://letagents.example",
        host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
        daemon_generation: generation,
      })).ok, true);
    }

    const first = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "fresh_initial_message", daemon_generation: generation,
      initial_message: "join the room and say hi",
    });
    assert.equal(first.ok, true, first.error);
    const queued = await internals.supervisedInbox.head("fresh_initial_message");
    assert.equal(queued?.source_message_id, "desktop-initial-message:fresh_initial_message");
    assert.equal((queued?.source_message as { text?: string }).text, "join the room and say hi");
    assert.equal((queued?.source_message as { source?: string }).source, "desktop_initial_message");

    const retried = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "fresh_initial_message", daemon_generation: generation,
      initial_message: "a retry must not replace or duplicate the first message",
    });
    assert.equal(retried.ok, true, retried.error);
    const afterRetry = await internals.supervisedInbox.receipts("fresh_initial_message");
    assert.equal(afterRetry.length, 1);
    assert.equal(afterRetry[0]?.inbox_item_id, queued?.inbox_item_id);
    assert.equal((afterRetry[0]?.source_message as { text?: string }).text, "join the room and say hi");

    const legacy = await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: "legacy_without_initial_message", daemon_generation: generation,
    });
    assert.equal(legacy.ok, true, legacy.error);
    assert.equal(await internals.supervisedInbox.head("legacy_without_initial_message"), null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("bootstrap and launch reuse one fresh host worker mint before creating one provider generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const source = await committedSourceRepository(env.root, "bootstrap_reuse_source");
  await primeDaemonBareRepository(env.root, source);
  let mintCalls = 0;
  let spawns = 0;
  let mintedProvider: string | null = null;
  let mintedDisplayName: string | null = null;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (input) => {
      spawns += 1;
      return { workAttemptId: input.workAttemptId, pid: 9211, providerContinuationId: "bootstrap-reuse-continuation", observedState: "working" };
    },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("fresh bootstrap launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "bootstrap-reuse-continuation" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    latest: async () => ({ messages: [] }), poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async (input) => {
      mintCalls += 1;
      mintedProvider = input.provider;
      mintedDisplayName = input.displayName;
      return { sessionId: "bootstrap-reuse-session", bearer: "bootstrap-reuse-bearer", bearerId: "bootstrap-reuse-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "bootstrap_reuses_mint";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent", source_repo_path: source,
    } })).ok, true);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-bootstrap-reuse", supervisor_grant: "bootstrap-reuse-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", { entry_id: id, daemon_generation: generation })).ok, true);
    await eventually(async () => spawns === 1, "bootstrap launch provider spawn");
    assert.equal(mintCalls, 1, "bootstrap tail admission and launch share the same fresh worker mint");
    assert.equal(mintedProvider, "codex", "the worker session retains its real provider identity");
    assert.equal(mintedDisplayName, "Agent", "the worker session retains its agent display name");
    const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(attempt.execution_generations.length, 1, "only one durable execution generation is created after credential success");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("Open Model launches with its exact memory-only endpoint credential", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const source = await committedSourceRepository(env.root, "open_model_credential_source");
  await primeDaemonBareRepository(env.root, source);
  const providerSecret = "open-model-provider-secret-never-persist";
  let spawnInput: Parameters<ProviderActionPort["spawn"]>[0] | null = null;
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: true,
      midTurnInjection: false,
      transcriptAccess: true,
      permissionPromptBridging: false,
      survivesRestart: true,
    }),
    spawn: async (input) => {
      spawnInput = input;
      return {
        workAttemptId: input.workAttemptId,
        pid: 9311,
        providerContinuationId: "opencode-session-1",
        providerConnection: {
          kind: "opencode_server",
          url: "http://127.0.0.1:19311",
          pid: 9311,
          processIdentity: "opencode-process-birth",
          serverAuthPath: join(env.root, "opencode-server-auth.json"),
        },
        observedState: "idle",
      };
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("fresh Open Model launch must not resume"); },
    poke: async () => {},
    stop: async (handle) => ({
      endedAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: handle.providerContinuationId,
    }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    latest: async () => ({ messages: [] }),
    poll: async () => ({ messages: [] }),
    publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => ({
      sessionId: "open-model-worker",
      bearer: "open-model-worker-bearer",
      bearerId: "open-model-worker-bearer-id",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "open_model_memory_credential";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "open-model",
      model: "open-model/test",
      permission_profile_id: "full_access",
      delivery_mode: "daemon_inbox",
      observed_state: "absent",
      source_repo_path: source,
    } })).ok, true);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const installed = await daemonRequest(paths.socketPath, "supervisor.install_open_model_credential", {
      entry_id: id,
      api_key: providerSecret,
      base_url: "https://models.example.test/v1/",
      model: "open-model/test",
      daemon_generation: generation,
    });
    assert.equal(installed.ok, true, installed.error);
    assert.deepEqual(installed.result, { status: "installed" });
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id,
      room_id: entry.room_id,
      agent_key: "owner/open-model-agent",
      grant_id: "grant-open-model",
      supervisor_grant: "open-model-host-grant",
      grant_generation: 1,
      api_url: "https://letagents.example",
      daemon_generation: generation,
      host_id: "host-open-model",
      installation_id: "installation-open-model",
      grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bootstrap_room_ingress", {
      entry_id: id,
      daemon_generation: generation,
    })).ok, true);
    await eventually(async () => spawnInput !== null, "Open Model provider spawn");
    assert.deepEqual(spawnInput!.providerCredential, {
      apiKey: providerSecret,
      baseUrl: "https://models.example.test/v1",
      model: "open-model/test",
    });
    assert.equal(spawnInput!.provider, "open-model");
    assert.equal(spawnInput!.deliveryMode, "daemon_inbox");
    assert.deepEqual(spawnInput!.launchPolicy, { permission: { "*": "allow" } });
    const raw = await readFile(paths.manifestPath);
    assert.equal(raw.includes(Buffer.from(providerSecret)), false, "the endpoint key is never serialized into daemon state");
    assert.equal((await readFile(paths.auditPath)).includes(Buffer.from(providerSecret)), false, "the endpoint key is never written to audit");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("string-thrown transient worker mint failures redact credentials and automatically reconverge", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "transient_worker_mint_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const durableAttempt = await durability.createAttempt({ taskId: "transient_worker_mint_retry", leaseId: "transient_worker_mint_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const recovery = fakeRecoveryClock();
  let mintCalls = 0;
  let failMints = true;
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (input) => {
      spawns += 1;
      return { workAttemptId: input.workAttemptId, pid: 9212, providerContinuationId: "transient-mint-continuation", observedState: "working" };
    },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("transient credential recovery must start only once"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "transient-mint-continuation" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, recovery.clock, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => {
      mintCalls += 1;
      if (failMints) throw "worker mint transport failed; Authorization: Bearer transient-mint-secret";
      return { sessionId: "transient-mint-session", bearer: "transient-mint-bearer", bearerId: "transient-mint-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "transient_worker_mint_retry";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: durableAttempt.workspace_path, work_attempt_id: durableAttempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-transient-mint", supervisor_grant: "transient-mint-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => mintCalls === 1, "first transient mint attempt");
    await recovery.advance(1_000);
    await eventually(async () => mintCalls === 2, "second transient mint attempt");
    await recovery.advance(3_000);
    await eventually(async () => mintCalls === 3, "third transient mint attempt");
    await eventually(async () => recovery.pending() === 1, "automatic convergence timer after exhausted transient mint");
    const beforeRetry = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(beforeRetry.execution_generations.length, 0, "no execution generation exists before a credential is successfully minted");
    const failed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.match(failed.last_error ?? "", /Authorization: Bearer \[REDACTED\]/i, "string-thrown credential evidence is redacted before persistence");
    assert.doesNotMatch(failed.last_error ?? "", /transient-mint-secret/, "the raw string-thrown credential never reaches durable state");
    failMints = false;
    await recovery.advance(10);
    await eventually(async () => spawns === 1 && mintCalls === 4, "automatic post-failure convergence without another RPC");
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(recovered.execution_generations.length, 1, "automatic recovery creates exactly one provider generation");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("429 worker mint failures retry three times and automatically reconverge", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "rate_limited_worker_mint_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const durableAttempt = await durability.createAttempt({ taskId: "rate_limited_worker_mint_retry", leaseId: "rate_limited_worker_mint_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const recovery = fakeRecoveryClock();
  let mintCalls = 0;
  let rateLimited = true;
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (input) => {
      spawns += 1;
      return { workAttemptId: input.workAttemptId, pid: 9213, providerContinuationId: "rate-limit-mint-continuation", observedState: "working" };
    },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("rate-limited fresh launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "rate-limit-mint-continuation" }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, recovery.clock, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => {
      mintCalls += 1;
      if (rateLimited) throw new SupervisorGrantRequestError(429, "Supervisor worker session mint");
      return { sessionId: "rate-limit-session", bearer: "rate-limit-bearer", bearerId: "rate-limit-bearer-id", expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const id = "rate_limited_worker_mint_retry";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: durableAttempt.workspace_path, work_attempt_id: durableAttempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-rate-limit-mint", supervisor_grant: "rate-limit-mint-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => mintCalls === 1, "first 429 mint attempt");
    await recovery.advance(1_000);
    await eventually(async () => mintCalls === 2, "second 429 mint attempt");
    await recovery.advance(3_000);
    await eventually(async () => mintCalls === 3, "third 429 mint attempt");
    await eventually(async () => recovery.pending() === 1, "automatic convergence after exhausted 429 mint attempts");
    const beforeRecovery = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(beforeRecovery.execution_generations.length, 0, "rate limiting cannot create a durable execution before credentials exist");
    rateLimited = false;
    await recovery.advance(10);
    await eventually(async () => mintCalls === 4 && spawns === 1, "automatic 429 recovery without another RPC");
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(recovered.execution_generations.length, 1, "automatic 429 recovery creates one generation only after mint success");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("definitive worker mint rejection attempts once and never schedules automatic convergence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "definitive_worker_mint_rejection");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const durableAttempt = await durability.createAttempt({ taskId: "definitive_worker_mint_rejection", leaseId: "definitive_worker_mint_rejection", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const recovery = fakeRecoveryClock();
  let mintCalls = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("a definitive credential rejection cannot spawn"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("a definitive credential rejection cannot resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, recovery.clock, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    ...noWorkLeaseHttp,
    createWorkerSession: async () => {
      mintCalls += 1;
      throw new SupervisorGrantRequestError(401, "Supervisor worker session mint");
    },
  });
  try {
    await daemon.start();
    const id = "definitive_worker_mint_rejection";
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: durableAttempt.workspace_path, work_attempt_id: durableAttempt.work_attempt_id,
    } })).ok, true);
    await admitDaemonInboxForProviderTest(daemon, id, entry.room_id);
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-definitive-mint", supervisor_grant: "definitive-mint-grant",
      grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => mintCalls === 1, "single definitive mint attempt");
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
      return Boolean(current?.last_error);
    }, "definitive scheduler failure persistence");
    assert.equal(mintCalls, 1, "401 is definitive and must not enter the mint retry loop");
    assert.equal(recovery.pending(), 0, "a definitive mint rejection must not schedule recovery convergence");
    const failed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.match(failed.last_error ?? "", /failed after 1 attempt/i, "failure evidence reports the actual single attempt");
    const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
    assert.equal(attempt.execution_generations.length, 0, "definitive credential rejection occurs before execution generation creation");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});
