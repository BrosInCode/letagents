import { prepareRetiredRuntimePlan, archiveRetiredRuntimes } from "../runtime-recovery-journal.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { CONTINUATION_REPAIR_EXHAUSTED_ERROR, continuationRepairExhaustionNeedsPersistence, continuationRepairMissingContinuation, isSupervisedQuietPollContinuation, isSupervisedWaitProviderEvent, productionSupervisedDeliveryHttp, resolveReadyReachedAt, sameProcessBirthIdentity, supervisedWaitCursorFromProviderEvent, supervisedWaitEvidenceFromProviderEvent, workplaceLivenessStaleAfterMs } from "../main.js";
import { type DaemonActivityEvent, type DaemonManifestEntry, type DaemonManifestEntryView } from "../types.js";
import { loadSupervisedToolRuntimeAt } from "../supervised-tool-runtime.js";
import { productionSupervisorGrantHttp } from "../cloud-http.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import type { RuntimeRecoveryCoordinator } from "../runtime-recovery-coordinator.js";
import type { ProcessIdentity } from "../process-identity.js";
import {
  SupervisorDaemon,
  fixture,
  daemonRequest,
  TEST_SUPERVISOR,
  provisionedWorkspace,
  fakeGit,
  entry, testDaemonEndpoint } from "./helpers/daemon-fixture.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";

for (const predecessors of [false, true]) for (const mode of ["resume", "fresh"] as const) test(`operator ${mode} recovery is fenced, durable, and idempotent${predecessors ? " with retired predecessors" : ""}`, async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root };
  const id = `operator_${mode}`;
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined,
    join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0,
    workspacePath: workspace.path, workAttemptId: workspace.id });
  const retired = [] as Array<{ executionGenerationId: string; runtimeGenerationId: string;
    death: { kind: "codex_app_server"; pid: number; processIdentity: string } }>;
  const predecessorCount = predecessors ? (mode === "fresh" ? 33 : 2) : 0;
  for (const index of Array.from({ length: predecessorCount }, (_, n) => n + 1)) {
    const old = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", index);
    const death = { kind: "codex_app_server" as const, pid: 44000 + index, processIdentity: `Mon Sep 14 14:50:${String(index).padStart(2, "0")} 2026` };
    retired.push({ executionGenerationId: old.execution_generation_id,
      runtimeGenerationId: executionRuntimeStorageIdentity(id, old.execution_generation_id, death.kind, death.pid, death.processIdentity), death });
    await durability.recordTerminal(attempt.work_attempt_id, old.execution_generation_id, {
      actor: old.actor, generation: old.generation, ended_at: new Date().toISOString(), exit_code: null, signal: null,
      stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crashed", provider_continuation_id: "saved-conversation",
      ...(index !== 2 ? { native_runtime_death: death } : {}),
    });
  }
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", predecessorCount + 1);
  await durability.close();
  const connection = { kind: "codex_app_server" as const, pid: 45550,
    processIdentity: "Mon Sep 14 15:50:00 2026", url: "ws://127.0.0.1:45550" };
  const runtimeId = executionRuntimeStorageIdentity(id, execution.execution_generation_id, connection.kind, connection.pid, connection.processIdentity);
  let stopCalls = 0;
  let gone = false;
  let allowStop = false;
  let exactStopSupported = false;
  let actualBirth = connection.processIdentity;
  let predecessorState: "gone" | "live" | "unknown" = "gone";
  let changePredecessorAfterStop = false;
  const processIdentity: ProcessIdentity = {
    probe: pid => {
      if (pid !== 45550 && predecessorState === "unknown") throw Object.assign(new Error("denied"), { code: "EPERM" });
      if ((pid === 45550 && gone) || (pid !== 45550 && predecessorState === "gone")) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    readBirthIdentity: pid => pid === 45550 ? actualBirth : retired.find(item => item.death.pid === pid)!.death.processIdentity,
    sameBirthIdentity: (actual, expected) => actual === expected,
  };
  const terminal = { endedAt: new Date().toISOString(), exitCode: null, signal: "SIGKILL",
    terminalCause: "killed" as const, providerContinuationId: "saved-conversation",
    nativeRuntimeDeath: { kind: "codex_app_server" as const, pid: connection.pid, processIdentity: connection.processIdentity } };
  const provider: ProviderActionPort = {
    capabilities: async () => ({ deliveryModes: ["daemon_inbox"], resume: true, exactProcessStop: exactStopSupported, midTurnInjection: false,
      transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("No launch during the recovery transaction"); },
    resume: async () => { throw new Error("No launch during the recovery transaction"); },
    attach: async () => { throw new Error("A cached attachment is not process-death proof"); },
    attachAction: async () => ({ state: "absent" }), poke: async () => {},
    stop: async () => terminal,
    stopRef: async ref => {
      stopCalls++;
      assert.deepEqual(ref.providerConnection, connection);
      if (allowStop) { gone = true; if (changePredecessorAfterStop) predecessorState = "live"; }
      return terminal; // Simulate a cached terminal while the process is alive.
    },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", provider, false, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { requestConvergence: (id: string) => void; durability: WorkDurabilityStore;
      runtimeRecovery: RuntimeRecoveryCoordinator & { options: { processIdentity: ProcessIdentity } };
      providerExecution: { converge(id: string): Promise<void> } };
    internals.requestConvergence = () => {};
    (internals.runtimeRecovery as unknown as { options: { processIdentity: ProcessIdentity } }).options.processIdentity = processIdentity;
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, id,
      provider: "codex", delivery_mode: "daemon_inbox", desired_state: "running", observed_state: "working", condition: "none",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      run_id: execution.execution_generation_id, deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id), provider_ref: { work_attempt_id: attempt.work_attempt_id,
        execution_generation_id: execution.execution_generation_id, provider_continuation_id: "saved-conversation", provider_connection: connection } } });
    assert.equal(put.ok, true, put.error);
    const beforeDb = new DatabaseSync(paths.manifestPath);
    try {
      const at = new Date().toISOString();
      const outcome = JSON.stringify(mode === "resume" ? { kind: "reply", text: "Saved answer", evidence: "stream" }
        : { kind: "unreadable", text: null, evidence: "none" });
      beforeDb.prepare(`INSERT INTO supervised_agent_inbox
        (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,created_at,updated_at)
        VALUES('inbox',?,?,'source','{}','{}',1,'awaiting_result',1,'action','reply','turn',?,?,?)`)
        .run(id, entry.room_id, outcome, at, at);
      beforeDb.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES('inbox',?,?,?,?,'saved-conversation','turn')")
        .run(id, entry.room_id, attempt.work_attempt_id, execution.execution_generation_id);
      for (const [inboxId, sequence, providerTurn] of [["pending_old", 2, "retried-turn"], ["pending_new", 3, null]] as const) {
        beforeDb.prepare(`INSERT INTO supervised_agent_inbox
          (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,created_at,updated_at)
          VALUES(?,?,?,?,'{}','{}',?,'pending',1,?,?,?,NULL,?,?)`)
          .run(inboxId, id, entry.room_id, inboxId, sequence, `action-${inboxId}`, `reply-${inboxId}`, providerTurn, at, at);
      }
      beforeDb.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES('pending_old',?,?,?,?,'saved-conversation','retried-turn')")
        .run(id, entry.room_id, attempt.work_attempt_id, execution.execution_generation_id);
      beforeDb.prepare(`INSERT INTO supervised_agent_effects(effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,created_at,updated_at)
        VALUES('effect',?,?,?,'turn','request','send_message','{}',1,'executing',?,?)`)
        .run(id, entry.room_id, execution.execution_generation_id, at, at);
      const shadow = new ExecutionShadowStore(beforeDb);
      shadow.registerRuntime({ agentId: id, executionGenerationId: execution.execution_generation_id, runtimeGenerationId: runtimeId,
        provider: "codex", authorityMode: "typed", configRevision: 1, createdAtMs: 100 });
      const capturedAttempt = shadow.trackMessage({ agentId: id, roomId: entry.room_id, sourceMessageId: "source",
        executionGenerationId: execution.execution_generation_id, workspaceId: attempt.work_attempt_id, createdAtMs: 100 });
      shadow.trackNativeTurn({ agentId: id, roomId: entry.room_id, attemptId: capturedAttempt, executionGenerationId: execution.execution_generation_id,
        runtimeGenerationId: runtimeId, turnId: "captured-turn", providerContinuationId: "saved-conversation", providerTurnId: "turn", createdAtMs: 100 });
      const token = shadow.bindObserver({ agentId: id, subjectRuntimeGenerationId: runtimeId, observerRuntimeGenerationId: runtimeId,
        daemonGenerationId: "old-daemon", sourceId: "old-source", expectedEpoch: 0, boundAtMs: 100 });
      shadow.ingest(token.sourceId, token, { factId: "active", agentId: id, executionGenerationId: execution.execution_generation_id,
        runtimeGenerationId: runtimeId, sourceSequence: 1, observerEpoch: 1, observedAtMs: 101,
        domain: "turn", kind: "state_changed", state: "active", sideEffects: "none", turnId: "captured-turn",
        providerContinuationId: "saved-conversation", providerTurnId: "turn" });
      shadow.observeSourcePosition(token.sourceId, token, 776);
      if (predecessors) {
        beforeDb.prepare("UPDATE execution_turns SET state='lost',ended_at_ms=101 WHERE turn_id='captured-turn'").run();
        for (const [index, old] of retired.entries()) {
          shadow.registerRuntime({ agentId: id, executionGenerationId: old.executionGenerationId,
            runtimeGenerationId: old.runtimeGenerationId, provider: "codex", authorityMode: "typed", configRevision: 1, createdAtMs: 50 });
          const oldAttempt = shadow.trackMessage({ agentId: id, roomId: entry.room_id, sourceMessageId: `old-${index}`,
            executionGenerationId: old.executionGenerationId, workspaceId: attempt.work_attempt_id, createdAtMs: 50 });
          // Retained legacy state: A's unresolved turn outlived its observer.
          beforeDb.prepare(`INSERT INTO execution_turns VALUES(?,?,?,?,?,?,?,?,?,'possible',50,?)`)
            .run(`old-turn-${index}`, oldAttempt, id, entry.room_id, old.executionGenerationId, old.runtimeGenerationId, "saved-conversation", `old-native-turn-${index}`, index === 0 && mode === "resume" ? "active" : "lost", index === 0 && mode === "resume" ? null : 51);
          beforeDb.prepare(`INSERT INTO supervised_agent_inbox
            (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,created_at,updated_at)
            VALUES(?,?,?,?,'{}','{}',?,'pending',1,?,?,?,NULL,?,?)`)
            .run(`old-inbox-${index}`, id, entry.room_id, `old-${index}`, index + 4, `old-action-${index}`, `old-reply-${index}`, `old-native-turn-${index}`, at, at);
          beforeDb.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES(?,?,?,?,?,'saved-conversation',?)")
            .run(`old-inbox-${index}`, id, entry.room_id, attempt.work_attempt_id, old.executionGenerationId, `old-native-turn-${index}`);
          if (index === 0 && mode === "fresh") beforeDb.prepare("UPDATE supervised_agent_inbox SET state='acknowledged' WHERE inbox_item_id=?").run(`old-inbox-${index}`);
        }
        const old = retired[1]!;
        beforeDb.prepare(`UPDATE execution_observers SET execution_generation_id=?,runtime_generation_id=?,
          observer_execution_generation_id=?,observer_runtime_generation_id=?,last_source_sequence=1,max_observed_sequence=72
          WHERE agent_id=?`).run(old.executionGenerationId, old.runtimeGenerationId, old.executionGenerationId, old.runtimeGenerationId, id);
      }
    } finally { beforeDb.close(); }
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const request = { entry_id: id, daemon_generation: generation, mode, operation_id: `restart-${mode}`,
      room_id: entry.room_id, execution_generation_id: execution.execution_generation_id, runtime_generation_id: runtimeId,
      ...(predecessors ? { retired_runtime_evidence: [retired[1]!] } : {}) };
    if (predecessors) {
      const missing = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", { ...request, retired_runtime_evidence: [] });
      assert.equal(missing.ok, false); assert.match(missing.error!, /older runtime needs/);
      const wrong = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", { ...request,
        retired_runtime_evidence: [{ ...retired[1]!, death: { ...retired[1]!.death, pid: 44099 } }] });
      assert.equal(wrong.ok, false); assert.match(wrong.error!, /recorded process owner/);
      const contradict = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", { ...request,
        retired_runtime_evidence: [retired[1]!, { ...retired[0]!, death: { ...retired[0]!.death, pid: 44099 } }] });
      assert.equal(contradict.ok, false); assert.match(contradict.error!, /contradicts/);
      for (const state of ["live", "unknown"] as const) {
        predecessorState = state;
        const unavailable = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", request);
        assert.equal(unavailable.ok, false); assert.match(unavailable.error!, /not been proven gone/);
      }
      predecessorState = "gone";
      assert.equal(stopCalls, 0);
      const unchanged = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      assert.equal(unchanged.desired_state, "running");
      const db = new DatabaseSync(paths.manifestPath);
      try {
        const coordinates = { operationId: request.operation_id, entryId: id, roomId: entry.room_id, mode,
          executionGenerationId: execution.execution_generation_id, runtimeGenerationId: runtimeId };
        const plan = prepareRetiredRuntimePlan(db, coordinates, unchanged, [retired[1]!], processIdentity);
        assert.equal(plan.evidence.length, predecessorCount, "durable candidates are not truncated to the maintenance input limit");
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE execution_observers SET max_observed_sequence=max_observed_sequence+1 WHERE agent_id=?").run(id);
        assert.throws(() => archiveRetiredRuntimes(db, coordinates, { ...unchanged, desired_state: "paused" }, plan, processIdentity), /observation changed/);
        db.exec("ROLLBACK");
        assert.throws(() => prepareRetiredRuntimePlan(db, { ...coordinates, runtimeGenerationId: "different-current" }, unchanged, [retired[1]!], processIdentity), /runtime changed/);
      } finally { db.close(); }
    }
    const stale = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", { ...request, runtime_generation_id: "other-runtime" });
    assert.equal(stale.ok, false);
    assert.equal(stopCalls, 0);
    const unsupported = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", request);
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error!, /does not yet support/);
    assert.equal(stopCalls, 0);
    const unchanged = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
    assert.equal(unchanged.desired_state, "running");
    assert.equal(unchanged.runtime_recovery, null, "unsupported providers cannot be trapped in prepared recovery");
    exactStopSupported = true;
    const unsafe = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", request);
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.error!, /not been proven stopped/);
    const paused = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
    assert.equal(paused.desired_state, "paused");
    assert.equal(paused.runtime_recovery?.phase, "prepared");
    const afterRejectedStop = await internals.durability.getAttempt(attempt.work_attempt_id);
    assert.equal(afterRejectedStop.execution_generations.find(value => value.execution_generation_id === execution.execution_generation_id)?.terminal, null,
      "a cached terminal cannot release the old workspace execution fence while its process is alive");
    const resume = await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: "running" });
    assert.equal(resume.ok, false, "ordinary Resume cannot bypass an unfinished recovery");
    const callsBeforeConvergence = stopCalls;
    await internals.providerExecution.converge(id);
    assert.equal(stopCalls, callsBeforeConvergence, "a restarted daemon must not automatically replay the stop");
    allowStop = true;
    if (mode === "fresh") actualBirth = "Tue Sep 15 15:50:00 2026";
    if (predecessors && mode === "resume") {
      changePredecessorAfterStop = true;
      const changed = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", request);
      assert.equal(changed.ok, false); assert.match(changed.error!, /not been proven gone/);
      const db = new DatabaseSync(paths.manifestPath);
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE phase='complete'").get()!.n, 0);
        assert.equal(db.prepare("SELECT state FROM execution_turns WHERE turn_id='old-turn-0'").get()!.state, "active");
      } finally { db.close(); }
      changePredecessorAfterStop = false;
      predecessorState = "gone";
    }
    const repaired = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", request);
    assert.equal(repaired.ok, true, repaired.error);
    if (mode === "fresh") assert.equal(stopCalls, callsBeforeConvergence, "a reused PID must never be signalled");
    const recovered = (repaired.result as { entry: DaemonManifestEntryView }).entry;
    assert.equal(recovered.id, id);
    assert.equal(recovered.workspace_path, attempt.workspace_path);
    assert.equal(recovered.work_attempt_id, attempt.work_attempt_id);
    assert.equal(recovered.desired_state, "running");
    assert.equal(recovered.runtime_recovery, null);
    assert.equal(recovered.provider_ref?.provider_continuation_id ?? null, mode === "resume" ? "saved-conversation" : null);
    const stoppedAttempt = await internals.durability.getAttempt(attempt.work_attempt_id);
    assert.deepEqual(stoppedAttempt.execution_generations.find(value => value.execution_generation_id === execution.execution_generation_id)?.terminal?.native_runtime_death,
      terminal.nativeRuntimeDeath, "manual recovery retains exact death evidence before resetting the reference");
    const afterDb = new DatabaseSync(paths.manifestPath);
    try {
      assert.equal(afterDb.prepare("SELECT state FROM supervised_agent_inbox WHERE inbox_item_id='inbox'").get()!.state,
        mode === "resume" ? "awaiting_result" : "cancelled_by_user",
        "a saved answer remains publishable; an unreadable result cannot block or replay in the fresh conversation");
      assert.equal(afterDb.prepare("SELECT state FROM supervised_agent_effects WHERE effect_id='effect'").get()!.state, "uncertain");
      assert.equal(afterDb.prepare("SELECT state FROM supervised_agent_inbox WHERE inbox_item_id='pending_old'").get()!.state, "cancelled_by_user",
        "an unresolved old turn returned to pending by a retry must not follow the replacement conversation");
      assert.equal(afterDb.prepare("SELECT state FROM supervised_agent_inbox WHERE inbox_item_id='pending_new'").get()!.state, "pending",
        "genuinely undispatched messages stay queued");
      assert.equal(afterDb.prepare("SELECT state FROM execution_turns WHERE turn_id='captured-turn'").get()!.state, "lost");
      assert.equal(afterDb.prepare("SELECT state FROM execution_message_attempts WHERE source_message_id='source'").get()!.state,
        mode === "resume" ? "active" : "lost");
      const archive = JSON.parse(String(afterDb.prepare("SELECT observer_json FROM agent_runtime_recoveries WHERE runtime_generation_id=?")
        .get(predecessors ? retired[1]!.runtimeGenerationId : runtimeId)!.observer_json));
      assert.equal(archive.max_observed_sequence, predecessors ? 72 : 776);
      if (predecessors) {
        assert.equal(afterDb.prepare("SELECT observer_json FROM agent_runtime_recoveries WHERE runtime_generation_id=?").get(retired[0]!.runtimeGenerationId)!.observer_json, null);
        for (const [index, old] of retired.entries()) {
          assert.equal(afterDb.prepare("SELECT phase FROM agent_runtime_recoveries WHERE runtime_generation_id=?").get(old.runtimeGenerationId)!.phase, "complete");
          assert.equal(afterDb.prepare("SELECT state FROM execution_turns WHERE turn_id=?").get(`old-turn-${index}`)!.state, "lost");
          assert.equal(afterDb.prepare("SELECT state FROM supervised_agent_inbox WHERE inbox_item_id=?").get(`old-inbox-${index}`)!.state, index === 0 && mode === "fresh" ? "acknowledged" : "cancelled_by_user");
        }
        assert.equal(afterDb.prepare("SELECT COUNT(*) AS n FROM execution_facts WHERE agent_id=?").get(id)!.n, 1, "no historical facts removed");
        const shadow = new ExecutionShadowStore(afterDb);
        shadow.registerRuntime({ agentId: id, executionGenerationId: "successor", runtimeGenerationId: "successor-runtime",
          provider: "codex", authorityMode: "typed", configRevision: 1, createdAtMs: Date.now() });
        const token = shadow.bindObserver({ agentId: id, subjectRuntimeGenerationId: "successor-runtime",
          observerRuntimeGenerationId: "successor-runtime", daemonGenerationId: "successor-daemon", sourceId: "successor-source",
          expectedEpoch: 2, boundAtMs: Date.now() });
        assert.equal(token.epoch, 3, "successor crosses the retained 1/72 gap only after the exact boundary");
      }
      assert.equal(archive.last_source_sequence, 1);
    } finally { afterDb.close(); }
    const callsAfterRecovery = stopCalls;
    const retry = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", request);
    assert.equal(retry.ok, true, retry.error);
    assert.equal(stopCalls, callsAfterRecovery, "a lost response cannot stop a successor on retry");
    const reused = await daemonRequest(paths.socketPath, "supervisor.recover_agent_runtime", { ...request, room_id: "other-room" });
    assert.equal(reused.ok, false);
    assert.equal(stopCalls, callsAfterRecovery);
  } finally { await daemon.stop().catch(() => undefined); await env.cleanup(); }
});

test("daemon tool runtime loader requires a sealed package tree outside explicit development", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-tool-runtime-"));
  try {
    const valid = join(root, "daemon-tool-executor.mjs");
    await writeFile(valid, "export async function executeDaemonTool() { return { liveResult: {}, durableResult: {} }; }\nexport function supervisedToolIsMutation() { return false; }\n", { mode: 0o600 });
    await assert.rejects(() => loadSupervisedToolRuntimeAt(valid), /sealed package tree/i);
    const runtime = await loadSupervisedToolRuntimeAt(valid, { allowUnsealedDevelopmentRuntime: true });
    assert.equal(runtime.supervisedToolIsMutation("get_board"), false);

    const redirected = join(root, "redirected.mjs");
    await symlink(valid, redirected);
    await assert.rejects(
      () => loadSupervisedToolRuntimeAt(redirected, { allowUnsealedDevelopmentRuntime: true }),
      /real file|canonical/i,
    );

    const incompatible = join(root, "incompatible.mjs");
    await writeFile(incompatible, "export const nope = true;\n", { mode: 0o600 });
    await assert.rejects(
      () => loadSupervisedToolRuntimeAt(incompatible, { allowUnsealedDevelopmentRuntime: true }),
      /incompatible contract/i,
    );

    const nodeModules = join(root, "sealed", "node_modules");
    const executor = join(nodeModules, "letagents", "dist", "mcp", "server", "daemon-tool-executor.js");
    const dependencyProof = join(nodeModules, "dependency-proof.txt");
    const verifier = join(root, "runtime-verifier.mjs");
    const sealedDigest = "a".repeat(64);
    await mkdir(dirname(executor), { recursive: true });
    await writeFile(executor, "export async function executeDaemonTool() { return { liveResult: {}, durableResult: {} }; }\nexport function supervisedToolIsMutation() { return false; }\n", { mode: 0o600 });
    await writeFile(dependencyProof, sealedDigest, { mode: 0o600 });
    await writeFile(verifier, `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport const LETAGENTS_MCP_RUNTIME_TREE_SHA256 = "${sealedDigest}";\nexport function computeLetAgentsMcpRuntimeTreeSha256(root) { return readFileSync(join(root, "dependency-proof.txt"), "utf8").trim(); }\n`, { mode: 0o600 });
    const sealedRuntime = await loadSupervisedToolRuntimeAt(executor, {
      verifierPath: verifier,
      expectedTreeSha256: sealedDigest,
    });
    assert.equal(sealedRuntime.supervisedToolIsMutation("get_board"), false);
    await writeFile(dependencyProof, "b".repeat(64), { mode: 0o600 });
    await assert.rejects(
      () => loadSupervisedToolRuntimeAt(executor, { verifierPath: verifier, expectedTreeSha256: sealedDigest }),
      /complete tree integrity check/i,
      "a changed dependency is rejected before the privileged executor import",
    );
  } finally {
    await removeTestDirectory(root);
  }
});

test("worker mint preserves the exact server-issued identity paired with its bearer", async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      session_id: "session-exact", session_kind: "worker", room_id: "room-exact", runtime: "cursor",
      actor_label: "CedarRidge | EmmyMay's agent | Cursor", agent_key: "emmymay/cedarridge",
      agent_instance_id: "daemon:cedar", display_name: "CedarRidge", owner_label: "EmmyMay",
      ide_label: "Cursor", created_at: "2026-08-14T00:00:00.000Z", updated_at: "2026-08-14T00:00:01.000Z",
      last_seen_at: "2026-08-14T00:00:01.000Z", ended_at: null,
      worker_bearer: "worker-secret", worker_bearer_id: "bearer-exact", worker_bearer_expires_at: null,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const minted = await productionSupervisorGrantHttp.createWorkerSession({
      apiUrl: `http://127.0.0.1:${address.port}`, grantId: "grant", supervisorGrant: "grant-secret",
      grantGeneration: 1, roomId: "room-exact", agentKey: "emmymay/cedarridge",
      agentInstanceId: "daemon:cedar", provider: "cursor", displayName: "CedarRidge",
    });
    assert.equal(minted.agentSession?.agent_key, "emmymay/cedarridge");
    assert.equal(minted.agentSession?.actor_label, "CedarRidge | EmmyMay's agent | Cursor");
    assert.equal(minted.agentSession?.owner_label, "EmmyMay");
    assert.equal(minted.agentSession?.session_id, minted.sessionId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("execution delegation read requires the exact host projection and normalizes timestamps", async () => {
  const observed: Array<{ url: string; authorization?: string; generation?: string }> = [];
  const server = createHttpServer((request, response) => {
    observed.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      generation: request.headers["x-letagents-supervisor-generation"] as string | undefined,
    });
    response.writeHead(200, { "content-type": "application/json" });
    const missingDigest = request.url?.endsWith("/missing-digest");
    response.end(JSON.stringify({ delegation: {
      delegation_instance_id: missingDigest ? "missing-digest" : "delegation-exact",
      revision: 4,
      owner_account_id: "owner-exact",
      room_id: "room-exact",
      agent_key: "owner/agent",
      approver_account_id: "approver-exact",
      category: "file_change",
      risk_ceiling: "low",
      ...(!missingDigest ? { scope_sha256: "a".repeat(64) } : {}),
      created_at: "2026-08-14T00:00:00.000Z",
      expires_at: "2026-08-15T00:00:00.000Z",
      revoked_at: null,
      status: "active",
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const delegation = await productionSupervisorGrantHttp.getExecutionDelegation({
      apiUrl,
      grantId: "grant-exact",
      supervisorGrant: "grant-secret",
      grantGeneration: 3,
      delegationInstanceId: "delegation-exact",
    });
    assert.deepEqual(delegation, {
      delegationInstanceId: "delegation-exact",
      revision: 4,
      ownerAccountId: "owner-exact",
      roomId: "room-exact",
      agentKey: "owner/agent",
      approverAccountId: "approver-exact",
      category: "file_change",
      riskCeiling: "low",
      scopeSha256: "a".repeat(64),
      createdAtMs: Date.parse("2026-08-14T00:00:00.000Z"),
      expiresAtMs: Date.parse("2026-08-15T00:00:00.000Z"),
      revokedAtMs: null,
    });
    assert.deepEqual(observed[0], {
      url: "/supervisor-host-grants/grant-exact/execution-delegations/delegation-exact",
      authorization: "Bearer grant-secret",
      generation: "3",
    });
    await assert.rejects(
      productionSupervisorGrantHttp.getExecutionDelegation({
        apiUrl,
        grantId: "grant-exact",
        supervisorGrant: "grant-secret",
        grantGeneration: 3,
        delegationInstanceId: "missing-digest",
      }),
      /scope_sha256/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("execution delegation inventory preserves exact host scope and cursor", async () => {
  const observed: string[] = [];
  const server = createHttpServer((request, response) => {
    observed.push(request.url ?? "");
    assert.equal(request.headers.authorization, "Bearer grant-secret");
    assert.equal(request.headers["x-letagents-supervisor-generation"], "3");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      delegation_instance_ids: ["delegation-b", "delegation-c"],
      next_cursor: "delegation-c",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const page = await productionSupervisorGrantHttp.listExecutionDelegationIds({
      apiUrl: `http://127.0.0.1:${address.port}`,
      grantId: "grant-exact",
      supervisorGrant: "grant-secret",
      grantGeneration: 3,
      roomId: "room/exact",
      agentKey: "owner/agent",
      after: "delegation-a",
    });
    assert.deepEqual(page, {
      delegationInstanceIds: ["delegation-b", "delegation-c"],
      nextCursor: "delegation-c",
    });
    assert.equal(observed[0], "/supervisor-host-grants/grant-exact/execution-delegations?room_id=room%2Fexact&agent_key=owner%2Fagent&after=delegation-a");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("execution delegation decision inventory and exact read preserve the frozen host contract", async () => {
  const observed: string[] = [];
  const server = createHttpServer((request, response) => {
    observed.push(request.url ?? "");
    assert.equal(request.headers.authorization, "Bearer grant-secret");
    assert.equal(request.headers["x-letagents-supervisor-generation"], "3");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.includes("?")) {
      response.end(JSON.stringify({ decision_ids: ["decision-b", "decision-c"], next_cursor: "decision-c" }));
      return;
    }
    const decisionId = request.url?.split("/").at(-1);
    response.end(JSON.stringify({ decision: {
      decision_id: decisionId === "decision-mismatch" ? "other-decision" : decisionId,
      delegation_instance_id: "delegation", delegation_revision: 4,
      actor_account_id: "approver", request_id: "request", request_version: 2,
      request_sha256: "a".repeat(64), projection_sha256: "b".repeat(64), decision: "allow_once",
      decided_at: "2026-08-14T00:00:00.000Z", owner_account_id: "owner", room_id: "room/exact",
      agent_key: "owner/agent", approver_account_id: decisionId === "decision-bad" ? "someone-else" : "approver",
      category: "file_change", risk_ceiling: "low",
      scope_sha256: "c".repeat(64),
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const common = { apiUrl: `http://127.0.0.1:${address.port}`, grantId: "grant-exact",
      supervisorGrant: "grant-secret", grantGeneration: 3 };
    const page = await productionSupervisorGrantHttp.listExecutionDelegationDecisionIds({
      ...common, roomId: "room/exact", agentKey: "owner/agent", after: "decision-a",
    });
    assert.deepEqual(page, { decisionIds: ["decision-b", "decision-c"], nextCursor: "decision-c" });
    const decision = await productionSupervisorGrantHttp.getExecutionDelegationDecision({
      ...common, decisionId: "decision-c",
    });
    assert.equal(decision.decision_id, "decision-c");
    assert.equal(decision.actor_account_id, decision.approver_account_id);
    await assert.rejects(
      productionSupervisorGrantHttp.getExecutionDelegationDecision({ ...common, decisionId: "decision-bad" }),
      /different intent/,
    );
    await assert.rejects(
      productionSupervisorGrantHttp.getExecutionDelegationDecision({ ...common, decisionId: "decision-mismatch" }),
      /different intent/,
    );
    assert.deepEqual(observed, [
      "/supervisor-host-grants/grant-exact/execution-delegation-decisions?room_id=room%2Fexact&agent_key=owner%2Fagent&after=decision-a",
      "/supervisor-host-grants/grant-exact/execution-delegation-decisions/decision-c",
      "/supervisor-host-grants/grant-exact/execution-delegation-decisions/decision-bad",
      "/supervisor-host-grants/grant-exact/execution-delegation-decisions/decision-mismatch",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("workplace reachability outlives the configured room long poll", () => {
  assert.equal(workplaceLivenessStaleAfterMs(""), 210_000);
  assert.equal(workplaceLivenessStaleAfterMs("999"), 210_000);
  assert.equal(workplaceLivenessStaleAfterMs("36000000"), 36_030_000);
  assert.equal(workplaceLivenessStaleAfterMs("36000000ms"), 36_030_000);
  assert.equal(workplaceLivenessStaleAfterMs("999999999"), 86_430_000);
  assert.equal(workplaceLivenessStaleAfterMs("invalid"), 210_000);
});

test("production room observation polls stay below common proxy idle cutoffs", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let requestedUrl = "";
    globalThis.fetch = (async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await productionSupervisedDeliveryHttp.poll({
      roomId: "github.com/example/repo",
      apiUrl: "https://letagents.test",
      bearer: "worker-secret",
      afterMessageId: "msg_42",
      signal: new AbortController().signal,
    });

    const request = new URL(requestedUrl);
    assert.equal(request.searchParams.get("timeout"), "25000");
    assert.equal(request.searchParams.get("after"), "msg_42");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("task continuity inventory uses exact worker leases, pagination and the failure-time cutoff", async () => {
  const previousFetch = globalThis.fetch;
  const roomId = "github.com/example/repo";
  const input = { roomId, apiUrl: "https://letagents.test", bearer: "worker-secret", agentSessionId: "session-1",
    heldBefore: "2026-09-09T00:00:00Z", signal: new AbortController().signal };
  const task = (id: string, leasePatch: Record<string, unknown> = {}, status = "in_progress") => ({
    id, title: id, status, active_leases: [{ id: `lease-${id}`, epoch: 2, kind: "work", status: "active",
      room_id: roomId, task_id: id, agent_session_id: "session-1", expires_at: null,
      created_at: "2026-09-08T00:00:00Z", ...leasePatch }],
  });
  const calls: URL[] = [];
  try {
    globalThis.fetch = (async (url, options) => {
      assert.equal((options?.headers as Record<string, string>).authorization, "Bearer worker-secret");
      const parsed = new URL(String(url)); calls.push(parsed);
      const after = parsed.searchParams.get("after");
      return Response.json({ room_id: roomId, has_more: !after, tasks: after ? [task("task-last")] : [
        task("owned"), task("another-instance", { agent_session_id: "session-2" }),
        task("finished", {}, "done"), task("reviewing", { kind: "review" }),
        task("expired", { expires_at: "2020-01-01T00:00:00Z" }),
        task("new-work", { created_at: "2026-09-09T00:00:01Z" }),
        task("missing-creation", { created_at: undefined }),
      ] });
    }) as typeof fetch;
    assert.deepEqual(await productionSupervisedDeliveryHttp.ownedTasks!(input), [
      { id: "owned", title: "owned", leaseId: "lease-owned", epoch: 2 },
      { id: "task-last", title: "task-last", leaseId: "lease-task-last", epoch: 2 },
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.searchParams.get("open"), "true");
    assert.equal(calls[1]!.searchParams.get("after"), "missing-creation");
    assert.equal(decodeURIComponent(calls[0]!.pathname), `/rooms/${roomId}/tasks`);

    globalThis.fetch = (async () => Response.json({ ...task("owned"), room_id: roomId })) as typeof fetch;
    assert.equal((await productionSupervisedDeliveryHttp.ownedTasks!({ ...input, taskIds: ["owned"] })).length, 1);
    await assert.rejects(productionSupervisedDeliveryHttp.ownedTasks!({ ...input, taskIds: ["wrong-id"] }), /different task/);
    globalThis.fetch = (async () => Response.json({ ...task("owned"), room_id: "other-room" })) as typeof fetch;
    await assert.rejects(productionSupervisedDeliveryHttp.ownedTasks!({ ...input, taskIds: ["owned"] }), /another room/);
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await assert.rejects(productionSupervisedDeliveryHttp.ownedTasks!(input), /HTTP 503/);
  } finally { globalThis.fetch = previousFetch; }
});

test("continuation repair resumes every uncommitted journal phase from the original missing conversation", () => {
  const inboxItemId = "inbox_1";
  const originalContinuation = "thread_missing";
  const promotedReplacement = "thread_replacement";
  for (const phase of ["probing", "replacement_created", "failed"] as const) {
    assert.equal(
      continuationRepairMissingContinuation({
        inbox_item_id: inboxItemId,
        phase,
        missing_continuation: originalContinuation,
      }, inboxItemId, promotedReplacement),
      originalContinuation,
      `${phase} remains owned by the interrupted repair journal`,
    );
  }
  assert.equal(
    continuationRepairMissingContinuation({
      inbox_item_id: inboxItemId,
      phase: "committed",
      missing_continuation: originalContinuation,
    }, inboxItemId, promotedReplacement),
    promotedReplacement,
    "only a committed repair makes the replacement the next missing continuation",
  );
  assert.equal(
    continuationRepairMissingContinuation({
      inbox_item_id: "another_inbox",
      phase: "replacement_created",
      missing_continuation: originalContinuation,
    }, inboxItemId, promotedReplacement),
    promotedReplacement,
    "a repair for another FIFO item cannot claim this one",
  );
});

test("continuation repair exhaustion policy treats the exact durable error as already persisted", () => {
  assert.equal(continuationRepairExhaustionNeedsPersistence(null), true);
  assert.equal(continuationRepairExhaustionNeedsPersistence("another failure"), true);
  assert.equal(
    continuationRepairExhaustionNeedsPersistence(CONTINUATION_REPAIR_EXHAUSTED_ERROR),
    false,
  );
});

test("resolveReadyReachedAt stamps ready once, monotonically, and only when running + unblocked + live (task_84)", () => {
  const now = "2026-07-17T00:00:00.000Z";
  // A bind that clears the pre-bind coordination latch reaches ready.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "recovering", condition: "coordination_blocked", ready_reached_at: null }, true, now),
    now,
  );
  // An idempotent bind of an already working/none entry is ready without clearing a latch.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "working", condition: "none", ready_reached_at: null }, false, now),
    now,
  );
  // Already stamped → keeps the original timestamp (monotonic, set-once).
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "working", condition: "none", ready_reached_at: "2026-07-16T00:00:00.000Z" }, false, now),
    "2026-07-16T00:00:00.000Z",
  );
  // Not running, or still blocked → never stamped.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "paused", observed_state: "working", condition: "none", ready_reached_at: null }, false, now),
    null,
  );
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "recovering", condition: "auth_blocked", ready_reached_at: null }, false, now),
    null,
  );
});

test("ready_reached_at survives a manifest round-trip, defaults absent, and a stop never clears it (task_84)", async () => {
  const env = await fixture();
  try {
    const store = new ManifestStore(join(env.root, "manifest.json"));
    // An old manifest without the field loads as absent (defaults null downstream).
    await store.write(0, [{ ...entry }]);
    assert.equal((await store.load()).entries[0]?.ready_reached_at, undefined);
    // A set-once stamp survives save → load (i.e. a daemon restart round-trip).
    await store.write(1, [{ ...entry, ready_reached_at: "2026-07-17T00:00:00.000Z" }]);
    assert.equal((await store.load()).entries[0]?.ready_reached_at, "2026-07-17T00:00:00.000Z");
    // A later stop (spread-preserving mutation) must not clear the stamp.
    const loaded = (await store.load()).entries[0]!;
    await store.write(2, [{ ...loaded, desired_state: "stopped", observed_state: "absent" }]);
    const after = (await store.load()).entries[0];
    assert.equal(after?.ready_reached_at, "2026-07-17T00:00:00.000Z");
    assert.equal(after?.desired_state, "stopped");
  } finally {
    await env.cleanup();
  }
});

test("manifest state subscription returns an initial snapshot and wakes on a committed mutation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const initial = (await daemonRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: 0,
      after_sequence: 0,
      wait_ms: 1_000,
    })).result as { daemon_generation: number; sequence: number; entries: DaemonManifestEntryView[] };
    assert.ok(initial.daemon_generation > 0);
    assert.ok(initial.sequence > 0);
    assert.deepEqual(initial.entries, []);

    const changed = daemonRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: initial.daemon_generation,
      after_sequence: initial.sequence,
      wait_ms: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "state_subscription_agent" },
    });
    const snapshot = (await changed).result as {
      daemon_generation: number;
      sequence: number;
      entries: DaemonManifestEntryView[];
    };
    assert.equal(snapshot.daemon_generation, initial.daemon_generation);
    assert.ok(snapshot.sequence > initial.sequence);
    assert.equal(snapshot.entries[0]?.id, "state_subscription_agent");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("a host approval change wakes a waiting manifest.watch_state before its timeout", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  let observed: ((event: { type: "snapshot"; connectionId: string; requests: unknown[] }) => void) | null = null;
  const provider = {
    observePermissions: async (_handle: unknown, listener: NonNullable<typeof observed>) => { observed = listener; },
  };
  const daemon = new SupervisorDaemon(paths, "darwin", provider as never);
  try {
    await daemon.start();
    const initial = (await daemonRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: 0, after_sequence: 0, wait_ms: 1_000,
    })).result as { daemon_generation: number; sequence: number };
    const internals = daemon as unknown as {
      hostApprovals: { install: (agentId: string, handle: unknown, generation: string) => () => void };
      liveHandles: Map<string, unknown>;
    };
    const handle = { providerConnection: { kind: "claude_cli", pid: 4242, processIdentity: "birth-1" } };
    internals.liveHandles.set("approval_agent", handle);
    internals.hostApprovals.install("approval_agent", handle, "generation");
    assert.ok(observed, "the broker subscribes to the provider's permission events");

    const startedAt = Date.now();
    const waiting = daemonRequest(paths.socketPath, "manifest.watch_state", {
      after_daemon_generation: initial.daemon_generation, after_sequence: initial.sequence, wait_ms: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    observed!({ type: "snapshot", connectionId: "connection", requests: [] }); // a permission change from the provider
    const woken = (await waiting).result as { sequence: number };
    assert.ok(Date.now() - startedAt < 2_500, "the watch returned early instead of timing out");
    assert.ok(woken.sequence > initial.sequence, "with a higher sequence");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("manifest.list scopes to one room on request and still lists everything without a scope", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const list = async (params?: unknown) => daemonRequest(paths.socketPath, "manifest.list", params);
  try {
    await daemon.start();
    for (const put of [
      { ...entry, id: "scoped_a", room_id: "room_a" },
      { ...entry, id: "scoped_b", room_id: "room_b" },
      // A stopped historical peer: the shape that dominates a long-lived manifest.
      { ...entry, id: "scoped_a2", room_id: "room_a", desired_state: "stopped" as const, observed_state: "stopped" as const },
    ]) assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: put })).ok, true, put.id);

    const ids = (result: unknown) => (result as DaemonManifestEntryView[]).map((row) => row.id).sort();
    // Absent params, and explicit null, keep today's whole-manifest answer.
    assert.deepEqual(ids((await list()).result), ["scoped_a", "scoped_a2", "scoped_b"]);
    assert.deepEqual(ids((await list({})).result), ["scoped_a", "scoped_a2", "scoped_b"]);
    assert.deepEqual(ids((await list({ room_id: null })).result), ["scoped_a", "scoped_a2", "scoped_b"]);

    // A scope is applied by the daemon, before projection and serialization.
    assert.deepEqual(ids((await list({ room_id: "room_a" })).result), ["scoped_a", "scoped_a2"]);
    assert.deepEqual(ids((await list({ room_id: "room_b" })).result), ["scoped_b"]);
    assert.deepEqual(ids((await list({ room_id: "room_absent" })).result), []);
    // The scoped read is a full projection, not the summary shape the pushed
    // state channel uses.
    const scoped = ((await list({ room_id: "room_a" })).result as DaemonManifestEntryView[])
      .find((row) => row.id === "scoped_a")!;
    assert.equal(scoped.room_id, "room_a");
    assert.equal(scoped.condition, "none");
    assert.ok(scoped.workplace_liveness);

    for (const invalid of ["", "  ", " room_a", 7, true]) {
      assert.match(String((await list({ room_id: invalid })).error), /exact non-empty room identifier/);
    }
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("watch_agent_stream long-polls one agent's ephemeral live feed", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (kind: string, method: string, summary: string): DaemonActivityEvent => ({
    observed_at: "2026-07-31T00:00:00.000Z", sequence: 0, provider: "open-model", kind, method,
    summary, status: "working", payload: { m: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  type StreamResult = { sequence: number; stream_generation: number; dropped_events: number; events: Array<{ sequence: number; kind: string; method: string; summary: string | null; payload: unknown }>; ended: boolean };
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      endAgentStream: (entryId: string) => void;
    };

    // Capability advertised for graceful client degradation.
    const status = (await daemonRequest(paths.socketPath, "daemon.status")).result as { capabilities: Record<string, boolean> };
    assert.equal(status.capabilities.agent_activity_stream_v1, true);

    // Events buffered before the first poll are returned since cursor 0.
    internals.pushAgentStreamEvent("agent_a", mk("text_delta", "reasoning/summaryTextDelta", "thinking"));
    internals.pushAgentStreamEvent("agent_a", mk("text_delta", "item/agentMessage/delta", "hello"));
    const first = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_a", after_sequence: 0, wait_ms: 500 })).result as StreamResult;
    assert.equal(first.events.length, 2);
    assert.equal(first.sequence, 2);
    assert.equal(first.stream_generation, 1);
    assert.equal(first.dropped_events, 0);
    assert.equal(first.ended, false);
    assert.equal(first.events[0]!.summary, "thinking");

    // Long-poll blocks, then wakes on the next event (a tool call).
    const pending = daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_a", after_sequence: first.sequence, wait_ms: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    internals.pushAgentStreamEvent("agent_a", mk("tool_lifecycle", "item/toolCall/updated", "bash"));
    const woken = (await pending).result as StreamResult;
    assert.equal(woken.events.length, 1);
    assert.equal(woken.events[0]!.kind, "tool_lifecycle");
    assert.equal(woken.sequence, 3);

    // Strict per-entry isolation: another agent's watcher sees nothing.
    const other = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_b", after_sequence: 0, wait_ms: 50 })).result as StreamResult;
    assert.equal(other.events.length, 0);

    // A torn-down provider closes the feed; the watcher observes ended.
    internals.endAgentStream("agent_a");
    const ended = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_a", after_sequence: woken.sequence, wait_ms: 500 })).result as StreamResult;
    assert.equal(ended.ended, true);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("watch_agent_stream drains a backlog larger than one batch without gaps", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (summary: string): DaemonActivityEvent => ({
    observed_at: "2026-07-31T00:00:00.000Z", sequence: 0, provider: "open-model", kind: "text_delta", method: "item/agentMessage/delta",
    summary, status: "working", payload: { m: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  type StreamResult = { sequence: number; stream_generation: number; dropped_events: number; events: Array<{ sequence: number; summary: string | null }>; ended: boolean };
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      endAgentStream: (entryId: string) => void;
    };
    // Buffer 100 events — more than a single 64-event batch can carry.
    for (let i = 1; i <= 100; i += 1) internals.pushAgentStreamEvent("agent_backlog", mk(`chunk-${i}`));
    internals.endAgentStream("agent_backlog");

    // The first poll returns one capped batch whose cursor is the LAST event it
    // actually carried, not the producer's newest sequence.
    const first = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_backlog", after_sequence: 0, wait_ms: 500 })).result as StreamResult;
    assert.equal(first.events.length, 64);
    assert.equal(first.events[0]!.sequence, 1);
    assert.equal(first.events[63]!.sequence, 64);
    assert.equal(first.sequence, 64, "cursor must be the last delivered event, never the producer high-water mark");
    assert.equal(first.stream_generation, 1);
    assert.equal(first.dropped_events, 0);
    assert.equal(first.ended, false, "a capped batch cannot end the viewer before retained backlog is delivered");

    // Resuming at that cursor drains the remainder; nothing past the cap is skipped.
    const second = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", { entry_id: "agent_backlog", after_sequence: first.sequence, wait_ms: 500 })).result as StreamResult;
    assert.equal(second.events.length, 36);
    assert.equal(second.events[0]!.sequence, 65);
    assert.equal(second.events[35]!.sequence, 100);
    assert.equal(second.sequence, 100);
    assert.equal(second.ended, true, "ended is emitted only with the generation high-water mark");

    // The two polls together reconstruct the full ordered backlog.
    const drained = [...first.events, ...second.events].map((event) => event.sequence);
    assert.deepEqual(drained, Array.from({ length: 100 }, (_, index) => index + 1));
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("watch_agent_stream reports bounded-history gaps and never replays a prior generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (summary: string): DaemonActivityEvent => ({
    observed_at: "2026-08-06T00:00:00.000Z", sequence: 0, provider: "cursor", kind: "text_delta", method: "item/agentMessage/delta",
    summary, status: "working", payload: { delta: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  type StreamResult = { sequence: number; stream_generation: number; dropped_events: number; events: Array<{ sequence: number; summary: string | null }>; ended: boolean };
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      resetAgentStream: (entryId: string) => void;
    };
    for (let i = 1; i <= 450; i += 1) internals.pushAgentStreamEvent("cursor_live", mk(`old-${i}`));

    const overflowed = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", {
      entry_id: "cursor_live", after_sequence: 0, wait_ms: 0,
    })).result as StreamResult;
    assert.equal(overflowed.stream_generation, 1);
    assert.equal(overflowed.dropped_events, 50, "the viewer is told exactly how much bounded history was evicted");
    assert.equal(overflowed.events[0]?.sequence, 51);
    assert.equal(overflowed.events[0]?.summary, "old-51");

    internals.resetAgentStream("cursor_live");
    internals.pushAgentStreamEvent("cursor_live", mk("new-turn-only"));
    const nextGeneration = (await daemonRequest(paths.socketPath, "supervisor.watch_agent_stream", {
      entry_id: "cursor_live", after_sequence: 0, wait_ms: 0,
    })).result as StreamResult;
    assert.equal(nextGeneration.stream_generation, 2);
    assert.equal(nextGeneration.dropped_events, 0, "a deliberate generation reset is not mislabeled as overflow");
    assert.deepEqual(nextGeneration.events.map((event) => event.summary), ["new-turn-only"]);
    assert.equal(nextGeneration.events[0]?.sequence, 451, "sequence remains monotonic across display generations");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("purgeAgent drops the ephemeral live feed and settles its outstanding waiters", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const mk = (summary: string): DaemonActivityEvent => ({
    observed_at: "2026-07-31T00:00:00.000Z", sequence: 0, provider: "open-model", kind: "text_delta", method: "item/agentMessage/delta",
    summary, status: "working", payload: { m: summary }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      pushAgentStreamEvent: (entryId: string, event: DaemonActivityEvent) => void;
      watchAgentStream: (input: { entryId: string; afterSequence: number; waitMs: number }) => Promise<{
        events: DaemonAgentStreamEvent[];
      }>;
    };
    const status = (await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number };
    // A fully stopped durable identity carrying a live-feed transcript.
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "purge_streams", desired_state: "stopped", observed_state: "stopped",
    } })).ok, true);
    internals.pushAgentStreamEvent("purge_streams", mk("hello"));
    assert.equal((await internals.watchAgentStream({ entryId: "purge_streams", afterSequence: 0, waitMs: 0 })).events.length, 1);

    // A drained watcher blocks before purge wakes it.
    const pending = internals.watchAgentStream({ entryId: "purge_streams", afterSequence: 1, waitMs: 5_000 });

    // A successful purge settles the waiter and drops the entry's ephemeral state.
    const purge = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: "purge_streams", daemon_generation: status.generation, revoked_agent_session_id: null,
    })).result as { outcome: string };
    assert.equal(purge.outcome, "purged");
    const replay = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: "purge_streams", daemon_generation: status.generation, revoked_agent_session_id: null,
    })).result as { outcome: string };
    assert.equal(replay.outcome, "purged", "a completed purge tombstone remains replayable after the identity row is gone");
    await pending; // the blocked watcher returns rather than hanging to its own timeout
    assert.deepEqual(
      (await internals.watchAgentStream({ entryId: "purge_streams", afterSequence: 0, waitMs: 0 })).events,
      [],
    );
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("purge fences an unattached exact Cursor wrapper before committing profile cleanup authority", async () => {
  const env = await fixture();
  const id = "purge_unattached_cursor";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id,
  });
  await durability.close();
  const connection = { kind: "cursor_cli" as const, pid: 7331, processIdentity: "cursor-wrapper-birth" };
  let stopRefs = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
      transcriptAccess: false, permissionPromptBridging: false, survivesRestart: true,
    }),
    spawn: async () => { throw new Error("purge test must not spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("purge test must not resume"); },
    poke: async () => {},
    stop: async () => { throw new Error("purge must use the unattached exact-reference fence"); },
    stopRef: async (ref) => {
      stopRefs += 1;
      assert.equal(ref.workAttemptId, attempt.work_attempt_id);
      assert.deepEqual(ref.providerConnection, connection);
      return {
        endedAt: new Date().toISOString(), exitCode: 0, signal: null,
        terminalCause: "stopped", providerContinuationId: ref.providerContinuationId,
      };
    },
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      durability: WorkDurabilityStore;
      requestConvergence: (entryId: string) => void;
    };
    internals.requestConvergence = () => {};
    const execution = await internals.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id,
      provider: "cursor",
      delivery_mode: "daemon_inbox",
      permission_profile_id: "read_only",
      desired_state: "stopped",
      observed_state: "stopped",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
      last_worker_binding: null,
      run_id: execution.execution_generation_id,
      deployment_id: serializeDaemonDeploymentId(id, execution.execution_generation_id),
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "sess-purge-cursor",
        provider_connection: connection,
        execution_generation_id: execution.execution_generation_id,
      },
    } });
    assert.equal(put.ok, true, put.error);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id, desired_state: "running",
    })).ok, true);
    let generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const refusedWhileRunning = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: id, daemon_generation: generation, revoked_agent_session_id: null,
    })).result as { outcome: string; error?: string };
    assert.equal(refusedWhileRunning.outcome, "invalid");
    assert.match(refusedWhileRunning.error ?? "", /fully stopped durable lifecycle/);
    assert.equal(stopRefs, 0, "an invalid purge never stops an unattached wrapper owned by a running lifecycle");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id, desired_state: "stopped",
    })).ok, true);
    generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const prepared = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: id, daemon_generation: generation, revoked_agent_session_id: null,
    })).result as { outcome: string; revocation_kind?: string };
    assert.equal(prepared.outcome, "revocation_required", JSON.stringify(prepared));
    assert.equal(prepared.revocation_kind, "grant_only");
    assert.equal(stopRefs, 1, "purge fences the recorded wrapper before asking Electron to revoke authority");
    const committed = (await daemonRequest(paths.socketPath, "supervisor.purge_agent", {
      entry_id: id, daemon_generation: generation, revoked_agent_session_id: null,
      grant_revoked_without_worker_session: true,
    })).result as { outcome: string; purged_work_attempt_id?: string };
    assert.equal(committed.outcome, "purged");
    assert.equal(committed.purged_work_attempt_id, attempt.work_attempt_id);
    assert.equal(stopRefs, 2, "the commit retry re-proves exact wrapper absence before destructive cleanup");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("desired-state compare-and-set cannot resurrect a concurrently stopped launch", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "resume_cas",
      desired_state: "paused",
      observed_state: "starting",
    } })).ok, true);
    const activated = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "running",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(activated.applied, true);
    assert.equal(activated.entry.desired_state, "running");
    const staleRollback = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "stopped",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(staleRollback.applied, false, "a losing resume cannot roll back another activation");
    assert.equal(staleRollback.entry.desired_state, "running");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "resume_cas", desired_state: "stopped" });
    const staleActivation = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "running",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(staleActivation.applied, false, "a concurrent Stop wins over resume");
    assert.equal(staleActivation.entry.desired_state, "stopped");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("agent inspector detail socket requests require an exact string-or-null source fence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    for (const params of [
      { entry_id: "agent_1", room_id: "room_1" },
      { entry_id: "agent_1", room_id: "room_1", source_message_id: 7 },
      { entry_id: 7, room_id: "room_1", source_message_id: null },
      { entry_id: "agent_1", room_id: 7, source_message_id: null },
    ]) {
      const response = await daemonRequest(paths.socketPath, "supervisor.get_agent_inspector_detail", params);
      assert.equal(response.ok, false);
      assert.match(response.error ?? "", /requires string entry_id, string room_id, and source_message_id as string or null/);
    }
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("inspector snapshot runtime identity distinguishes reused PIDs and missing birth evidence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      entryWithDerivedLiveness(entry: DaemonManifestEntry): Promise<DaemonManifestEntryView>;
    };
    await internals.putManifestEntry({ ...entry, desired_state: "paused", provider: "codex" });
    const readIdentity = async (processIdentity: string | null) => {
      const projected = await internals.entryWithDerivedLiveness({ ...entry, desired_state: "paused", provider: "codex",
        work_attempt_id: "identity-attempt",
        provider_ref: { work_attempt_id: "identity-attempt", execution_generation_id: "identity-execution",
          provider_continuation_id: "identity-thread",
          provider_connection: { kind: "codex_app_server", url: "ws://127.0.0.1:65534", pid: 44661, processIdentity } },
      });
      return projected.runtime_generation_id;
    };
    const first = await readIdentity("birth-one");
    assert.match(first ?? "", /^runtime-[a-f0-9]{64}$/);
    assert.equal(await readIdentity("birth-one"), first, "the same process retains its opaque identity");
    const replacement = await readIdentity("birth-two");
    assert.match(replacement ?? "", /^runtime-[a-f0-9]{64}$/);
    assert.notEqual(replacement, first, "PID reuse in the same execution must invalidate cached provider health");
    assert.equal(await readIdentity(null), null, "missing process-birth evidence cannot authorize cached health");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("GIF publication falls back to text only on a known pre-commit disabled response", async () => {
  const previousFetch = globalThis.fetch;
  const input = { roomId: "room_1", apiUrl: "https://letagents.test", bearer: "token", text: "Nice work!",
    gif: { provider: "giphy" as const, id: "abc123", title: "Nice work" }, clientMessageId: "same-id",
    replyTo: "msg_4", threadRootId: "msg_4", signal: new AbortController().signal };
  try {
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return sent.length === 1
        ? new Response(JSON.stringify({ error: "expressions_disabled: GIF sending is disabled in this room. Send text instead." }), { status: 400 })
        : new Response(JSON.stringify({ id: "msg_5", room_id: "room_1" }), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await productionSupervisedDeliveryHttp.publish(input), { messageId: "msg_5", roomId: "room_1" });
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].gif, input.gif); assert.equal(sent[1].gif, undefined);
    assert.equal(sent[0].client_message_id, sent[1].client_message_id);
    assert.equal(sent[1].text, input.text); assert.equal(sent[1].thread_root_id, "msg_4");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("acknowledgment lost"); }) as typeof fetch;
    await assert.rejects(productionSupervisedDeliveryHttp.publish(input), /acknowledgment lost/);
    assert.equal(calls, 1, "ambiguous publication must not be retried with changed content");
  } finally { globalThis.fetch = previousFetch; }
});

test("a worker stages a reply attachment with its own bearer, and the reply carries the upload id", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
  try {
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? Buffer.from(init.body as Uint8Array).toString() : null;
      calls.push({ url: String(url), method: init?.method ?? "GET", authorization: headers.get("authorization"), body });
      if (String(url).endsWith("/attachments/uploads")) {
        return new Response(JSON.stringify({ upload_id: "upl_9", upload_url: "https://storage.test/put", method: "PUT", headers: { "Content-Type": "image/png" } }), { status: 201 });
      }
      if (String(url).startsWith("https://storage.test/")) return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ id: "msg_6", room_id: "github.com/org/repo" }), { status: 200 });
    }) as typeof fetch;
    const room = { roomId: "github.com/org/repo", apiUrl: "https://letagents.test", bearer: "worker-token", signal: new AbortController().signal };
    assert.deepEqual(await productionSupervisedDeliveryHttp.stageAttachment!({ ...room, fileName: "shot.png", mimeType: "image/png", bytes: Buffer.from("png") }), { uploadId: "upl_9" });
    await productionSupervisedDeliveryHttp.publish({ ...room, text: "Done.", clientMessageId: "reply-1", attachments: [{ upload_id: "upl_9" }], replyTo: null, threadRootId: null });
    assert.deepEqual(calls.map(({ url, method, authorization }) => [url, method, authorization]), [
      ["https://letagents.test/rooms/github.com/org/repo/attachments/uploads", "POST", "Bearer worker-token"],
      ["https://storage.test/put", "PUT", null],
      ["https://letagents.test/rooms/github.com/org/repo/messages", "POST", "Bearer worker-token"],
    ]);
    assert.deepEqual(calls[0]!.body, { filename: "shot.png", content_type: "image/png", byte_size: 3 });
    assert.equal(calls[1]!.body, "png");
    assert.deepEqual((calls[2]!.body as { attachments: unknown }).attachments, [{ upload_id: "upl_9" }]);
  } finally { globalThis.fetch = previousFetch; }
});

test("production publication requires a nonempty canonical id in the requested room", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const body of [{ id: "", room_id: "room_1" }, { id: "msg_1", room_id: "room_2" }]) {
      globalThis.fetch = (async () => ({ ok: true, json: async () => body })) as typeof fetch;
      await assert.rejects(
        () => productionSupervisedDeliveryHttp.publish({ roomId: "room_1", apiUrl: "https://letagents.test", bearer: "token", text: "reply", clientMessageId: "client_1", replyTo: null, threadRootId: null }),
        /omitted its canonical message identity/,
      );
    }
    const publishedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      publishedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, json: async () => ({ id: "msg_1", room_id: "room_1" }) };
    }) as typeof fetch;
    assert.deepEqual(
      await productionSupervisedDeliveryHttp.publish({ roomId: "room_1", apiUrl: "https://letagents.test", bearer: "token", text: "reply", clientMessageId: "client_1", replyTo: "msg_45", threadRootId: "msg_44" }),
      { messageId: "msg_1", roomId: "room_1" },
    );
    assert.deepEqual(publishedBodies, [{
      sender: "supervised-daemon",
      text: "reply",
      client_message_id: "client_1",
      reply_to: "msg_45",
      thread_root_id: "msg_44",
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("process birth identity compares the stable birth prefix, not the whole ps line", () => {
  // A recorded identity is start-time only (defaultGetProcessIdentity = `ps -o lstart=`),
  // while a later read may be `lstart + command`. Comparing whole strings would
  // never match a live process.
  const recorded = "Wed Jul 16 02:22:00 2026";
  // Same live process, read start-time-only, is the same birth identity -> stays live.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 02:22:00 2026", recorded), true);
  // ps column padding varies; the stable prefix normalizes whitespace.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16  02:22:00 2026", recorded), true);
  // Pre-2.0.12 identities appended the mutable command; the stable prefix still
  // matches a start-time-only read (live-upgrade compatibility), both directions.
  assert.equal(sameProcessBirthIdentity(
    "Wed Jul 16 02:22:00 2026",
    "Wed Jul 16 02:22:00 2026 /Applications/LetAgents.app/Contents/MacOS/Electron",
  ), true);
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 02:22:00 2026 node dist-daemon/main.js", recorded), true);
  // A different start time (PID reuse) is a different process and must read dead.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 09:00:00 2026", recorded), false);
});

test("supervised native stream extracts only explicit LetAgents wait cursors", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code",
    kind: "text_delta",
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_3064", agent_session_id: "agent_session_exact" },
      }] },
    },
  }), "msg_3064");
  assert.deepEqual(supervisedWaitEvidenceFromProviderEvent({
    ...base,
    payload: {
      type: "tool_use",
      name: "wait_for_messages",
      input: { after_message_id: "msg_3065", agent_session_id: "agent_session_exact" },
    },
  }), { roomCursor: "msg_3065", agentSessionId: "agent_session_exact" });
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "tool_use", name: "wait_for_messages", input: { after_message_id: "msg_3065" } },
  }), null, "a cursor without exact worker-session evidence is unusable");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "text", text: "wait_for_messages after msg_999" }] } },
  }), null, "free text cannot advance durable room progress");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__other__wait_for_messages", input: { after_message_id: "not-a-message" } }] } },
  }), null, "malformed cursors are ignored");
});

test("supervised native stream classifies structured Claude and Codex room waits as quiet polling", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code" as const,
    kind: "tool_lifecycle" as const,
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    payload: { type: "tool_use", name: "mcp__letagents__wait_for_messages", input: {} },
  }), true);
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    provider: "codex",
    method: "item/started",
    payload: { item: { type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "inProgress" } },
  }), true);
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    kind: "text_delta",
    payload: { type: "assistant", message: { content: [{ type: "text", text: "call wait_for_messages next" }] } },
  }), false, "free text cannot hide genuine user-facing work");
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    provider: "codex",
    method: "item/started",
    payload: { item: { type: "mcpToolCall", id: "read_codex", server: "letagents", tool: "read_messages", status: "inProgress" } },
  }), false, "other room tools remain visible as real work");
});

test("supervised native stream keeps correlated empty wait results and handoffs quiet", () => {
  const claudeWait = {
    method: "assistant",
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: "wait_claude",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_10", agent_session_id: "agent_session_exact" },
      }] },
    },
  };
  const claudeResult = (body: object, overrides: object = {}) => ({
    method: "user",
    payload: {
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "wait_claude",
        content: [{ type: "text", text: JSON.stringify(body) }],
        ...overrides,
      }] },
    },
  });
  const emptyResult = claudeResult({ messages: [], room_id: "focus_37" });
  assert.equal(isSupervisedQuietPollContinuation(emptyResult, [claudeWait]), true);
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [], last_observed_message_id: "msg_11", skipped_message_count: 1 }),
    [claudeWait],
  ), true, "silent/skipped cursor progress remains an idle poll result");
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [{ id: "msg_11", text: "please act" }] }),
    [claudeWait],
  ), false, "an addressed result wakes the worker visibly");
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [] }, { is_error: true }),
    [claudeWait],
  ), false, "poll errors are never hidden as idle");
  assert.equal(isSupervisedQuietPollContinuation(
    { method: "assistant", payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "bounded provider thought" }] } } },
    [claudeWait, emptyResult],
  ), true, "the thinking-only beat before the immediate re-wait does not flash working");
  assert.equal(isSupervisedQuietPollContinuation(
    { method: "assistant", payload: { type: "assistant", message: { content: [{ type: "text", text: "Starting the requested review" }] } } },
    [claudeWait, emptyResult],
  ), false, "user-facing assistant work remains visible without free-text heuristics");

  const codexWait = {
    method: "item/started",
    payload: {
      item: { type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "inProgress" },
      threadId: "thread_codex",
      turnId: "turn_codex",
    },
  };
  const codexProgress = {
    method: "item/mcpToolCall/progress",
    payload: { itemId: "wait_codex", message: "waiting", threadId: "thread_codex", turnId: "turn_codex" },
  };
  const codexResult = {
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "completed",
        result: { content: [{ type: "text", text: JSON.stringify({ messages: [], last_observed_message_id: "msg_12" }) }], structuredContent: null, _meta: null },
        error: null,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
    },
  };
  assert.equal(isSupervisedQuietPollContinuation(codexProgress, [codexWait]), true, "real Codex progress correlates by params.itemId");
  assert.equal(isSupervisedQuietPollContinuation(codexResult, [codexWait, codexProgress]), true, "real Codex completion correlates by params.item.id");
  assert.equal(isSupervisedQuietPollContinuation({
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "completed",
        result: { content: [], structuredContent: { messages: [{ id: "msg_13", text: "please act" }] }, _meta: null },
        error: null,
      },
    },
  }, [codexWait]), false, "an addressed real Codex completion remains visible work");
  assert.equal(isSupervisedQuietPollContinuation({
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "failed",
        result: null, error: { message: "poll failed" },
      },
    },
  }, [codexWait]), false, "a failed real Codex completion is never hidden");
  for (let index = 0; index < 10; index += 1) {
    assert.equal(isSupervisedQuietPollContinuation(emptyResult, [claudeWait]), true, `staggered idle agent ${index + 1} stays quiet`);
  }
});
