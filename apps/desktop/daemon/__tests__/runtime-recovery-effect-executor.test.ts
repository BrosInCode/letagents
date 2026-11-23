import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { SupervisorGrantRequestError, type SupervisorGrantHttp } from "../cloud-http.js";
import { DaemonStateDatabase } from "../daemon-state-database.js";
import {
  applyEffectJournalSchema,
  EffectClaimRefusedError,
  EffectExecutor,
  EffectFenceError,
  getEffect,
  listEffectsForAgent,
  RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS,
  RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
  RUNTIME_RECOVERY_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
  runtimeRecoveryEndWorkerSessionIdempotencyKey,
} from "../effect-journal/index.js";
import { LifecycleAdministrationCoordinator } from "../lifecycle-administration-coordinator.js";
import { ManifestStore } from "../manifest-store.js";
import { RuntimeRecoveryCoordinator, type RuntimeRecoveryCoordinatorOptions } from "../runtime-recovery-coordinator.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type InstalledHostGrant } from "../worker-runtime-custody.js";

const GENERATION = 11;
const NOW_ISO = "2026-08-28T10:00:00.000Z";

function makeGrant(overrides: Partial<InstalledHostGrant> = {}): InstalledHostGrant {
  return {
    entryId: "agent-1",
    roomId: "room-1",
    agentKey: "owner/agent-1",
    grantId: "grant-secret-id-1",
    supervisorGrant: "SUPER_SECRET_SUPERVISOR_GRANT_TOKEN",
    grantGeneration: 4,
    apiUrl: "https://letagents.chat",
    daemonGeneration: GENERATION,
    hostId: "host-1",
    installationId: "install-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type EndSessionCallInput = {
  agentId: string;
  roomId: string;
  operationId: string | null;
  executionGenerationId: string | null;
  sessionId: string;
  grant: InstalledHostGrant;
};

function createHarness() {
  const effectDb = new DatabaseSync(":memory:");
  applyEffectJournalSchema(effectDb);
  let currentNowMs = Date.parse(NOW_ISO);
  let handoff = false;
  let assertCurrentFn: () => Promise<void> = async () => {};
  let endWorkerSessionFn: NonNullable<SupervisorGrantHttp["endWorkerSession"]> = async () => {};

  const custody = new WorkerRuntimeCustody();
  const initialGrant = custody.installHostGrant(makeGrant());

  const supervisorGrantHttp = {
    endWorkerSession: (input: Parameters<NonNullable<SupervisorGrantHttp["endWorkerSession"]>>[0]) =>
      endWorkerSessionFn(input),
  } as unknown as SupervisorGrantHttp;

  const coordinator = new RuntimeRecoveryCoordinator({
    settleRuntimeApprovals: async () => {},
    store: {} as RuntimeRecoveryCoordinatorOptions["store"],
    durability: {} as RuntimeRecoveryCoordinatorOptions["durability"],
    inbox: {} as RuntimeRecoveryCoordinatorOptions["inbox"],
    bindings: {} as RuntimeRecoveryCoordinatorOptions["bindings"],
    workerAuthority: {} as RuntimeRecoveryCoordinatorOptions["workerAuthority"],
    runtimeCustody: custody,
    delivery: null,
    supervisorGrantHttp,
    streams: {
      currentInstallation: () => undefined,
      install: async () => {},
      remove: () => {},
    },
    liveHandles: new Map(),
    authority: {
      currentDaemonGeneration: () => GENERATION,
      isHandoffScheduled: () => handoff,
      assertCurrent: async () => assertCurrentFn(),
      serializeManifest: async (op) => op(),
      fenceCommit: async (commit) => commit(),
    },
    beginLifecycle: () => () => {},
    bumpControlEpoch: () => 1,
    clearRecovery: () => {},
    serializeEntry: async (_entryId, op) => op(),
    updateEntry: async () => { throw new Error("unused"); },
    requestConvergence: () => {},
    entryWithDerivedLiveness: async (e) => e as never,
    nowMs: () => currentNowMs,
  });

  const executor = new EffectExecutor({
    getDatabase: () => effectDb,
    currentDaemonGeneration: () => GENERATION,
    assertCurrent: async () => assertCurrentFn(),
    assertWriteFence: () => {},
    isClosing: () => handoff,
    nowMs: () => currentNowMs,
    nowIso: () => new Date(currentNowMs).toISOString(),
  });
  coordinator.attachEffectExecutor(executor, effectDb, () => {});

  const callEndSession = (overrides: Partial<EndSessionCallInput> = {}) =>
    (coordinator as unknown as { endWorkerSessionForRestart(input: EndSessionCallInput): Promise<void> })
      .endWorkerSessionForRestart({
        agentId: "agent-1",
        roomId: "room-1",
        operationId: "recovery-op-1",
        executionGenerationId: "exec-gen-1",
        sessionId: "worker-session-1",
        grant: custody.hostGrant("agent-1") ?? initialGrant,
        ...overrides,
      });

  return {
    coordinator,
    effectDb,
    executor,
    custody,
    initialGrant,
    callEndSession,
    nowMs: () => currentNowMs,
    advanceNow: (deltaMs: number) => { currentNowMs += deltaMs; },
    setHandoff: (next: boolean) => { handoff = next; },
    setAssertCurrent: (fn: () => Promise<void>) => { assertCurrentFn = fn; },
    setEndWorkerSession: (fn: NonNullable<SupervisorGrantHttp["endWorkerSession"]>) => {
      endWorkerSessionFn = fn;
    },
  };
}

test("EffectExecutor replays interrupted runtime-recovery session retirement on startup and deduplicates completed outcomes across crashes", async () => {
  const h = createHarness();
  const key = runtimeRecoveryEndWorkerSessionIdempotencyKey({
    operationId: "recovery-op-1",
    roomId: "room-1",
    executionGenerationId: "exec-gen-1",
    sessionId: "worker-session-1",
  });
  // Seed an interrupted executing row from a predecessor daemon generation.
  h.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-rr-crash', 'agent-1', ?, ?, ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    key,
    GENERATION - 1,
    JSON.stringify({
      execution_generation_id: "exec-gen-1",
      operation_id: "recovery-op-1",
      restarting: true,
      room_id: "room-1",
      session_id: "worker-session-1",
    }),
    NOW_ISO,
    NOW_ISO,
  );

  const recovery = await h.executor.recoverOnStartup();
  assert.deepEqual(recovery.requeuedIds, ["eff-rr-crash"]);
  assert.equal(getEffect(h.effectDb, "eff-rr-crash")?.state, "prepared");
  assert.equal(getEffect(h.effectDb, "eff-rr-crash")?.epoch, GENERATION);

  const seenSessions: string[] = [];
  h.setEndWorkerSession(async (input) => {
    seenSessions.push(input.sessionId);
    assert.equal(input.restarting, true);
    assert.equal(input.grantId, "grant-secret-id-1");
    assert.ok(input.signal instanceof AbortSignal);
  });

  await h.callEndSession();
  assert.deepEqual(seenSessions, ["worker-session-1"]);
  const completed = getEffect(h.effectDb, "eff-rr-crash");
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.attempt_count, 2);

  // Crash replay before completeRuntimeRecovery/replaceEntry reuses the durable completion receipt with ZERO duplicate HTTP.
  await h.callEndSession();
  assert.deepEqual(seenSessions, ["worker-session-1"], "completed effect prevents duplicate endWorkerSession HTTP on crash replay");

  // Also works for explicit recoverAgentRuntimeExclusive (operationId: null) and keeps all secrets out of SQLite.
  await h.callEndSession({ operationId: null, sessionId: "worker-session-explicit" });
  await h.callEndSession({ operationId: null, sessionId: "worker-session-explicit" });
  assert.deepEqual(seenSessions, ["worker-session-1", "worker-session-explicit"]);

  const dumped = JSON.stringify(h.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all());
  assert.doesNotMatch(dumped, /SUPER_SECRET_SUPERVISOR_GRANT_TOKEN|grant-secret-id-1/);
});

test("host-grant custody removal or replacement during EffectExecutor's final pre-settlement await refuses completed settlement", async () => {
  for (const mode of ["removed", "replaced"] as const) {
    const h = createHarness();
    let httpReturned = false;
    let assertsAfterHttp = 0;
    let intercepted = false;
    h.setEndWorkerSession(async () => { httpReturned = true; });
    h.setAssertCurrent(async () => {
      if (httpReturned) {
        assertsAfterHttp += 1;
        // Call 1 after HTTP is execute()'s post-HTTP assertExternalAuthority();
        // Call 2 is EffectExecutor's final pre-settlement await assertAuthority().
        if (assertsAfterHttp === 2) {
          intercepted = true;
          if (mode === "removed") {
            h.custody.deleteHostGrant("agent-1");
          } else {
            h.custody.installHostGrant(makeGrant({ grantId: "grant-replacement", grantGeneration: 5 }));
          }
        }
      }
    });

    await assert.rejects(() => h.callEndSession(), /Host grant custody changed/);
    assert.equal(intercepted, true, `must intercept EffectExecutor's final await (${mode})`);
    const [row] = listEffectsForAgent(h.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
    assert.equal(row?.state, "prepared", `stale receipt must not commit completed when grant is ${mode}`);
    assert.equal(row?.last_error, "grant_authority_changed");
    assert.equal(row?.next_attempt_at_ms, h.nowMs() + RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
  }

  // Unchanged custody control commits completed cleanly.
  const control = createHarness();
  let calls = 0;
  control.setEndWorkerSession(async () => { calls += 1; });
  await control.callEndSession();
  assert.equal(calls, 1);
  const [controlRow] = listEffectsForAgent(control.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(controlRow?.state, "completed");
});

test("planned handoff fences runtime-recovery settlement without aborting unrelated in-flight effects on the shared EffectExecutor", async () => {
  const h = createHarness();
  let otherSignalAborted = false;
  let releaseOther!: () => void;
  h.executor.registerHandler("test_unrelated_bounded_effect", {
    retryable: false,
    autoPump: false,
    execute: async (_claimed, context) => {
      context.signal.addEventListener("abort", () => { otherSignalAborted = true; });
      await new Promise<void>((resolve) => { releaseOther = resolve; });
      return { status: "completed", outcome: { ok: true } };
    },
  });
  const other = await h.executor.prepare({
    agent_id: "agent-other",
    kind: "test_unrelated_bounded_effect",
    idempotency_key: "other-rr-1",
    payload: { ok: true },
    retryable: false,
  });
  const otherRunning = h.executor.runEffect(other.effect.id);
  await new Promise((resolve) => setTimeout(resolve, 10));

  h.setEndWorkerSession(async () => { h.setHandoff(true); });
  await assert.rejects(() => h.callEndSession(), EffectFenceError);
  assert.equal(otherSignalAborted, false, "planned handoff in runtime-recovery handler must not abort unrelated effects");
  const [row] = listEffectsForAgent(h.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(row?.state, "executing", "handoff leaves effect executing for successor startup recovery");

  releaseOther();
  assert.equal((await otherRunning).state, "completed");
});

test("authorizeClaim and pre-settlement phase checks fence stale agent_runtime_recoveries rows and prune terminal rows to 512", async () => {
  const h = createHarness();
  h.effectDb.exec(`
    CREATE TABLE agent_runtime_recoveries (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL
    );
    INSERT INTO agent_runtime_recoveries (operation_id, agent_id, phase, execution_generation_id)
    VALUES ('op-already-complete', 'agent-1', 'complete', 'exec-gen-1');
  `);
  let calls = 0;
  h.setEndWorkerSession(async () => { calls += 1; });
  const stalePrepared = await h.executor.prepare({
    agent_id: "agent-1",
    kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
      operationId: "op-already-complete",
      roomId: "room-1",
      executionGenerationId: "exec-gen-1",
      sessionId: "worker-session-stale",
    }),
    payload: {
      operation_id: "op-already-complete",
      room_id: "room-1",
      execution_generation_id: "exec-gen-1",
      session_id: "worker-session-stale",
      restarting: true,
    },
    retryable: true,
    max_attempts: 1_000_000,
  });
  await assert.rejects(() => h.executor.runEffect(stalePrepared.effect.id), EffectClaimRefusedError);
  assert.equal(calls, 0);
  assert.equal(getEffect(h.effectDb, stalePrepared.effect.id)?.state, "failed");
  assert.equal(getEffect(h.effectDb, stalePrepared.effect.id)?.last_error, "recovery_phase_disallowed");

  // Phase transitioning stopped -> complete during EffectExecutor's final pre-settlement await settles failed atomically.
  h.effectDb.prepare(`
    INSERT INTO agent_runtime_recoveries (operation_id, agent_id, phase, execution_generation_id)
    VALUES ('op-phase-race', 'agent-1', 'stopped', 'exec-gen-1')
  `).run();
  let raceHttpDone = false;
  let raceAsserts = 0;
  h.setEndWorkerSession(async () => { raceHttpDone = true; });
  h.setAssertCurrent(async () => {
    if (raceHttpDone) {
      raceAsserts += 1;
      if (raceAsserts === 2) {
        h.effectDb.prepare("UPDATE agent_runtime_recoveries SET phase = 'complete' WHERE operation_id = 'op-phase-race'").run();
      }
    }
  });
  await assert.rejects(() => h.callEndSession({ operationId: "op-phase-race", sessionId: "session-race" }), /recovery_phase_disallowed/);
  const raceKey = runtimeRecoveryEndWorkerSessionIdempotencyKey({
    operationId: "op-phase-race",
    roomId: "room-1",
    executionGenerationId: "exec-gen-1",
    sessionId: "session-race",
  });
  const raceRow = h.effectDb.prepare("SELECT state, outcome, last_error FROM effects WHERE idempotency_key = ?").get(raceKey) as Record<string, unknown>;
  assert.equal(raceRow.state, "failed");
  assert.equal(raceRow.outcome, null);
  assert.equal(raceRow.last_error, "recovery_phase_disallowed");

  // Terminal retention cap keeps exact 512 terminal rows while preserving active prepared rows.
  h.setAssertCurrent(async () => {});
  h.setEndWorkerSession(async () => {});
  const seedCount = RUNTIME_RECOVERY_RETAINED_TERMINAL_EFFECTS_PER_AGENT + 15;
  h.effectDb.exec("BEGIN IMMEDIATE");
  const insert = h.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES (?, 'agent-1', ?, ?, ?, 'completed', '{"seeded":true}', '{"restarting":true}', 1, 1, 1000000, NULL, NULL, ?, ?)
  `);
  for (let i = 0; i < seedCount; i += 1) {
    const ts = new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000).toISOString();
    insert.run(`eff-rr-old-${i}`, RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND, `rrews:v1:seed-${i}`, GENERATION, ts, ts);
  }
  h.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-rr-keep-active', 'agent-1', ?, 'rrews:v1:keep-active', ?, 'prepared', '{"keep":true}', NULL, 1, 0, 1000000, NULL, NULL, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run(RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND, GENERATION);
  h.effectDb.prepare(`
    INSERT INTO agent_runtime_recoveries (operation_id, agent_id, phase, execution_generation_id)
    VALUES ('op-prune', 'agent-1', 'stopped', 'exec-gen-1')
  `).run();
  h.effectDb.exec("COMMIT");

  await h.callEndSession({ operationId: "op-prune", sessionId: "session-prune" });
  assert.equal(getEffect(h.effectDb, "eff-rr-keep-active")?.state, "prepared");
  assert.equal(getEffect(h.effectDb, "eff-rr-old-0"), null);
  const terminalCount = Number((h.effectDb.prepare(`
    SELECT COUNT(*) AS n FROM effects
    WHERE agent_id = 'agent-1' AND kind = ? AND state IN ('completed', 'failed')
  `).get(RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND) as { n: number }).n);
  assert.equal(terminalCount, RUNTIME_RECOVERY_RETAINED_TERMINAL_EFFECTS_PER_AGENT);
});

test("settlement outages recover without restart (Layer 1 + Layer 2), live in-flight effects join without duplication, and future-epoch rows fail closed", async () => {
  // Layer 1: completion-only SQLite trigger reschedules executing -> prepared with durable nonzero backoff.
  const l1 = createHarness();
  let l1Calls = 0;
  l1.setEndWorkerSession(async () => { l1Calls += 1; });
  l1.effectDb.exec(`
    CREATE TRIGGER fail_rr_complete
    BEFORE UPDATE OF state ON effects
    WHEN NEW.kind = '${RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND}' AND NEW.state = 'completed'
    BEGIN SELECT RAISE(ABORT, 'simulated_rr_complete_failure'); END;
  `);
  await assert.rejects(() => l1.callEndSession(), /settlement_write_failed/);
  assert.equal(l1Calls, 1);
  const [l1Row] = listEffectsForAgent(l1.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(l1Row?.state, "prepared");
  assert.equal(l1Row?.last_error, "settlement_write_failed");
  assert.equal(l1Row?.next_attempt_at_ms, l1.nowMs() + RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);

  l1.effectDb.exec("DROP TRIGGER fail_rr_complete;");
  await assert.rejects(() => l1.callEndSession(), /backing off/);
  assert.equal(l1Calls, 1, "Layer 1 backoff blocks immediate replay before deadline");
  l1.advanceNow(RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
  await l1.callEndSession();
  assert.equal(l1Calls, 2);
  assert.equal(getEffect(l1.effectDb, l1Row!.id)?.state, "completed");

  // Layer 2: full update outage leaves executing; next call recovers to prepared with durable nonzero backoff and succeeds when due.
  const l2 = createHarness();
  let l2Calls = 0;
  l2.setEndWorkerSession(async () => { l2Calls += 1; });
  l2.effectDb.exec(`
    CREATE TRIGGER fail_rr_all_updates
    BEFORE UPDATE ON effects
    WHEN OLD.kind = '${RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND}' AND OLD.state = 'executing'
    BEGIN SELECT RAISE(ABORT, 'simulated_rr_outage'); END;
  `);
  await assert.rejects(() => l2.callEndSession(), /settlement storage write failed/);
  assert.equal(l2Calls, 1);
  const [stuck] = listEffectsForAgent(l2.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(stuck?.state, "executing");

  l2.effectDb.exec("DROP TRIGGER fail_rr_all_updates;");
  await assert.rejects(() => l2.callEndSession(), /backing off/);
  assert.equal(l2Calls, 1, "Layer 2 recovery enforces durable nonzero backoff before replaying HTTP");
  const requeued = getEffect(l2.effectDb, stuck!.id);
  assert.equal(requeued?.state, "prepared");
  assert.equal(requeued?.last_error, "recovered_inactive_executing_effect");
  assert.equal(requeued?.next_attempt_at_ms, l2.nowMs() + RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);

  l2.advanceNow(RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
  await l2.callEndSession();
  assert.equal(l2Calls, 2);
  assert.equal(getEffect(l2.effectDb, stuck!.id)?.state, "completed");

  // Live in-flight executing row (isEffectActive === true) joins rather than rescheduling or duplicating HTTP.
  const live = createHarness();
  let liveCalls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseHttp!: () => void;
  live.setEndWorkerSession(async () => {
    liveCalls += 1;
    markStarted();
    await new Promise<void>((resolve) => { releaseHttp = resolve; });
  });
  const prePrepared = await live.executor.prepare({
    agent_id: "agent-1",
    kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
      operationId: "recovery-op-1",
      roomId: "room-1",
      executionGenerationId: "exec-gen-1",
      sessionId: "worker-session-1",
    }),
    payload: {
      operation_id: "recovery-op-1",
      room_id: "room-1",
      execution_generation_id: "exec-gen-1",
      session_id: "worker-session-1",
      restarting: true,
    },
    retryable: true,
    max_attempts: 1_000_000,
  });
  const direct = live.executor.runEffect(prePrepared.effect.id);
  await started;
  assert.equal(live.executor.isEffectActive(prePrepared.effect.id), true);
  const joined = live.callEndSession();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(liveCalls, 1, "caller joins live in-flight executing effect with zero duplicate HTTP");
  releaseHttp();
  assert.equal((await direct).state, "completed");
  await joined;
  assert.equal(liveCalls, 1);

  // Future-epoch executing row fails closed without replaying HTTP.
  const future = createHarness();
  let futureCalls = 0;
  future.setEndWorkerSession(async () => { futureCalls += 1; });
  future.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-rr-future', 'agent-1', ?, ?, ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    runtimeRecoveryEndWorkerSessionIdempotencyKey({
      operationId: "recovery-op-1",
      roomId: "room-1",
      executionGenerationId: "exec-gen-1",
      sessionId: "worker-session-1",
    }),
    GENERATION + 4,
    JSON.stringify({
      execution_generation_id: "exec-gen-1",
      operation_id: "recovery-op-1",
      restarting: true,
      room_id: "room-1",
      session_id: "worker-session-1",
    }),
    NOW_ISO,
    NOW_ISO,
  );
  await assert.rejects(() => future.callEndSession(), EffectFenceError);
  assert.equal(futureCalls, 0);
  assert.equal(getEffect(future.effectDb, "eff-rr-future")?.state, "executing");
});

test("allowlisted error hygiene and durable nonzero EffectExecutor backoff hold across HTTP errors, malformed JSON, grant resolution faults, and restart", async () => {
  const h = createHarness();
  let calls = 0;
  h.setEndWorkerSession(async () => {
    calls += 1;
    if (calls === 1) throw new SupervisorGrantRequestError(403, "Supervisor worker session end");
    if (calls === 2) throw new SyntaxError("Unexpected token 'P', \"RAW_SERVER_RESPONSE_BODY\" is not valid JSON");
    if (calls === 3) throw new Error("raw network fault PRIVATE_ERROR_EXCERPT");
  });

  const t0 = h.nowMs();
  // Attempt 1: HTTP 403 -> durable backoff 1000ms, allowlisted http_403.
  await assert.rejects(() => h.callEndSession(), /HTTP 403/);
  const [eff1] = listEffectsForAgent(h.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(eff1?.state, "prepared");
  assert.equal(eff1?.last_error, "http_403");
  assert.equal(eff1?.next_attempt_at_ms, t0 + RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);

  // Immediate retry, direct executor.runEffect, and simulated restart at t0 are all blocked by durable deadline.
  await assert.rejects(() => h.callEndSession(), /backing off/);
  await assert.rejects(() => h.executor.runEffect(eff1!.id), EffectFenceError);
  await h.executor.recoverOnStartup();
  await assert.rejects(() => h.callEndSession(), /backing off/);
  assert.equal(calls, 1);

  // Attempt 2 after 1000ms: malformed JSON -> allowlisted invalid_json_response, exponential backoff 2000ms.
  h.advanceNow(RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
  await assert.rejects(() => h.callEndSession());
  const eff2 = getEffect(h.effectDb, eff1!.id);
  assert.equal(eff2?.last_error, "invalid_json_response");
  assert.equal(eff2?.next_attempt_at_ms, h.nowMs() + 2 * RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);

  // Attempt 3 after 2000ms: arbitrary Error -> allowlisted transport_error.
  h.advanceNow(2 * RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
  await assert.rejects(() => h.callEndSession(), /PRIVATE_ERROR_EXCERPT/);
  const eff3 = getEffect(h.effectDb, eff1!.id);
  assert.equal(eff3?.last_error, "transport_error");

  // Attempt 4 after 4000ms: succeeds cleanly under the same idempotency_key.
  h.advanceNow(4 * RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
  await h.callEndSession();
  assert.equal(calls, 4);
  assert.equal(getEffect(h.effectDb, eff1!.id)?.state, "completed");

  // Grant resolution exception during direct executor.runEffect() also persists only an allowlisted code.
  const fault = createHarness();
  fault.custody.currentHostGrant = () => {
    throw new Error("vault error containing RAW_VAULT_SECRET");
  };
  const prepFault = await fault.executor.prepare({
    agent_id: "agent-1",
    kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
      operationId: "op-grant-fault",
      roomId: "room-1",
      executionGenerationId: "exec-gen-1",
      sessionId: "session-fault",
    }),
    payload: {
      operation_id: "op-grant-fault",
      room_id: "room-1",
      execution_generation_id: "exec-gen-1",
      session_id: "session-fault",
      restarting: true,
    },
    retryable: true,
    max_attempts: 1_000_000,
  });
  const afterFault = await fault.executor.runEffect(prepFault.effect.id);
  assert.equal(afterFault.state, "prepared");
  assert.equal(afterFault.last_error, "grant_resolution_failed");

  const dumped = JSON.stringify([
    ...h.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all(),
    ...fault.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all(),
  ]);
  assert.doesNotMatch(dumped, /RAW_SERVER_RESPONSE_BODY|PRIVATE_ERROR_EXCERPT|RAW_VAULT_SECRET|SUPER_SECRET_SUPERVISOR_GRANT_TOKEN|grant-secret-id-1/);
});

test("permanent 4xx endWorkerSession statuses settle failed without retrying or falsely completing, while 401/403/409/5xx remain retryable", async () => {
  for (const status of [400, 404, 405, 410, 422] as const) {
    const h = createHarness();
    let calls = 0;
    h.setEndWorkerSession(async () => {
      calls += 1;
      throw new SupervisorGrantRequestError(status, "Supervisor worker session end");
    });

    await assert.rejects(() => h.callEndSession({ sessionId: `sess-perm-${status}` }), new RegExp(`HTTP ${status}`));
    const [row] = listEffectsForAgent(h.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
    assert.equal(row?.state, "failed", `HTTP ${status} must settle failed (never prepared or completed)`);
    assert.equal(row?.last_error, `http_${status}`);
    assert.equal(row?.attempt_count, 1);
    assert.equal(row?.next_attempt_at_ms, null);

    // Repeating past backoff and after startup recovery issues ZERO additional HTTP calls.
    h.advanceNow(24 * 60 * 60 * 1_000);
    await h.executor.recoverOnStartup();
    await assert.rejects(() => h.callEndSession({ sessionId: `sess-perm-${status}` }), new RegExp(`http_${status}`));
    assert.equal(calls, 1, `HTTP ${status} must not replay on repeated recovery calls`);
  }

  for (const status of [401, 403, 409, 408, 429, 503] as const) {
    const h = createHarness();
    let calls = 0;
    h.setEndWorkerSession(async () => {
      calls += 1;
      if (calls === 1) throw new SupervisorGrantRequestError(status, "Supervisor worker session end");
    });

    await assert.rejects(() => h.callEndSession({ sessionId: `sess-retry-${status}` }), new RegExp(`HTTP ${status}`));
    const [pending] = listEffectsForAgent(h.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
    assert.equal(pending?.state, "prepared", `HTTP ${status} must remain retryable`);
    assert.equal(pending?.last_error, `http_${status}`);
    assert.equal(pending?.next_attempt_at_ms, h.nowMs() + RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);

    h.advanceNow(RUNTIME_RECOVERY_EFFECT_RETRY_DELAY_MS);
    await h.callEndSession({ sessionId: `sess-retry-${status}` });
    assert.equal(calls, 2);
    assert.equal(getEffect(h.effectDb, pending!.id)?.state, "completed");
  }
});

test("racing retry, custody-changed, and inactive-executing recoveries never resurrect prepared rows after agent_runtime_recoveries completes", async () => {
  // 1. Retryable HTTP 503 returning after recovery transitioned stopped -> complete settles failed, not prepared.
  const h = createHarness();
  h.effectDb.exec(`
    CREATE TABLE agent_runtime_recoveries (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL
    );
    INSERT INTO agent_runtime_recoveries (operation_id, agent_id, phase, execution_generation_id)
    VALUES ('op-retry-race', 'agent-1', 'stopped', 'exec-gen-1');
  `);
  let threwHttp = false;
  h.setEndWorkerSession(async () => {
    threwHttp = true;
    throw new SupervisorGrantRequestError(503, "Supervisor worker session end");
  });
  h.setAssertCurrent(async () => {
    if (threwHttp) {
      h.effectDb.prepare("UPDATE agent_runtime_recoveries SET phase = 'complete' WHERE operation_id = 'op-retry-race'").run();
    }
  });
  await assert.rejects(() => h.callEndSession({ operationId: "op-retry-race", sessionId: "sess-retry-race" }));
  const [retryRaceRow] = listEffectsForAgent(h.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(retryRaceRow?.state, "failed", "racing retry must not resurrect a prepared row after recovery completes");
  assert.equal(retryRaceRow?.last_error, "recovery_phase_disallowed");
  assert.equal(retryRaceRow?.next_attempt_at_ms, null);

  // 2. Grant custody removed AND recovery transitioned stopped -> complete before settlement settles failed (not prepared).
  const h2 = createHarness();
  h2.effectDb.exec(`
    CREATE TABLE agent_runtime_recoveries (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL
    );
    INSERT INTO agent_runtime_recoveries (operation_id, agent_id, phase, execution_generation_id)
    VALUES ('op-custody-race', 'agent-1', 'stopped', 'exec-gen-1');
  `);
  let done2 = false;
  let asserts2 = 0;
  h2.setEndWorkerSession(async () => { done2 = true; });
  h2.setAssertCurrent(async () => {
    if (done2) {
      asserts2 += 1;
      if (asserts2 === 2) {
        h2.custody.deleteHostGrant("agent-1");
        h2.effectDb.prepare("UPDATE agent_runtime_recoveries SET phase = 'complete' WHERE operation_id = 'op-custody-race'").run();
      }
    }
  });
  await assert.rejects(() => h2.callEndSession({ operationId: "op-custody-race", sessionId: "sess-custody-race" }), /recovery_phase_disallowed/);
  const [custodyRaceRow] = listEffectsForAgent(h2.effectDb, "agent-1", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
  assert.equal(custodyRaceRow?.state, "failed");
  assert.equal(custodyRaceRow?.last_error, "recovery_phase_disallowed");

  // 3. Inactive executing row whose recovery already completed settles failed (never resurrected to prepared).
  const h3 = createHarness();
  h3.effectDb.exec(`
    CREATE TABLE agent_runtime_recoveries (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL
    );
    INSERT INTO agent_runtime_recoveries (operation_id, agent_id, phase, execution_generation_id)
    VALUES ('op-inactive-done', 'agent-1', 'complete', 'exec-gen-1');
  `);
  const inactiveKey = runtimeRecoveryEndWorkerSessionIdempotencyKey({
    operationId: "op-inactive-done",
    roomId: "room-1",
    executionGenerationId: "exec-gen-1",
    sessionId: "sess-inactive-done",
  });
  h3.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-inactive-done', 'agent-1', ?, ?, ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
    inactiveKey,
    GENERATION,
    JSON.stringify({
      execution_generation_id: "exec-gen-1",
      operation_id: "op-inactive-done",
      restarting: true,
      room_id: "room-1",
      session_id: "sess-inactive-done",
    }),
    NOW_ISO,
    NOW_ISO,
  );
  await assert.rejects(() => h3.callEndSession({ operationId: "op-inactive-done", sessionId: "sess-inactive-done" }), /recovery_phase_disallowed/);
  const settledInactive = getEffect(h3.effectDb, "eff-inactive-done");
  assert.equal(settledInactive?.state, "failed");
  assert.equal(settledInactive?.last_error, "recovery_phase_disallowed");
});

function manifestEntry(id: string, overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id,
    room_id: "room-1",
    display_name: `Agent ${id}`,
    provider: "codex",
    model: "gpt-5.3-codex",
    charter: "Keep working.",
    desired_state: "running",
    observed_state: "idle",
    condition: "none",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "owner",
    created_at: NOW_ISO,
    ...overrides,
  };
}

test("real ManifestStore + RuntimeRecoveryCoordinator + LifecycleAdministrationCoordinator retire stale effects on completeRuntimeRecovery, startup, retireAgent, and purge while rolling back atomically on blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-rr-purge-"));
  const dbPath = join(root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const db = stateDb.connection;
  const store = new ManifestStore(dbPath);
  const bindings = new WorkerBindingStore(join(root, "worker-bindings.json"), undefined, dbPath);
  store.attachDatabase(db);
  bindings.attachDatabase(db);

  let currentNowMs = Date.parse(NOW_ISO);
  let httpCalls = 0;
  let endWorkerSessionFn: NonNullable<SupervisorGrantHttp["endWorkerSession"]> = async () => {
    httpCalls += 1;
  };
  const custody = new WorkerRuntimeCustody();
  const executor = new EffectExecutor({
    getDatabase: () => db,
    currentDaemonGeneration: () => GENERATION,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    isClosing: () => false,
    nowMs: () => currentNowMs,
    nowIso: () => new Date(currentNowMs).toISOString(),
  });
  const coordinator = new RuntimeRecoveryCoordinator({
    settleRuntimeApprovals: async () => {},
    store,
    durability: {} as RuntimeRecoveryCoordinatorOptions["durability"],
    inbox: {} as RuntimeRecoveryCoordinatorOptions["inbox"],
    bindings,
    workerAuthority: {} as RuntimeRecoveryCoordinatorOptions["workerAuthority"],
    runtimeCustody: custody,
    delivery: null,
    supervisorGrantHttp: {
      endWorkerSession: (input) => endWorkerSessionFn(input),
    } as unknown as SupervisorGrantHttp,
    streams: {
      currentInstallation: () => undefined,
      install: async () => {},
      remove: () => {},
    },
    liveHandles: new Map(),
    authority: {
      currentDaemonGeneration: () => GENERATION,
      isHandoffScheduled: () => false,
      assertCurrent: async () => {},
      serializeManifest: async (op) => op(),
      fenceCommit: async (commit) => commit(),
    },
    beginLifecycle: () => () => {},
    bumpControlEpoch: () => 1,
    clearRecovery: () => {},
    serializeEntry: async (_entryId, op) => op(),
    updateEntry: async (entryId, update) => {
      const loaded = await store.getEntryWithVersion(entryId);
      if (!loaded) throw new Error(`missing ${entryId}`);
      return (await store.replaceEntry(loaded.version, update(loaded.entry))).entry;
    },
    requestConvergence: () => {},
    entryWithDerivedLiveness: async (e) => e as never,
    nowMs: () => currentNowMs,
  });
  coordinator.attachEffectExecutor(executor, db, () => {});

  const lifecycle = new LifecycleAdministrationCoordinator({
    store,
    bindings,
    durability: {
      getAttempt: async () => { throw new Error("unused"); },
      listAttempts: async () => [],
      recordTerminal: async () => {},
      releaseTerminalExecutionFence: async () => {},
      concludeAttempt: async () => { throw new Error("unused"); },
      garbageCollectEphemeralAttempt: async () => false,
    },
    authority: {
      currentDaemonGeneration: () => GENERATION,
      assertCurrent: async () => {},
      fenceCommit: async (commit) => commit(),
      serializeManifestMutation: async (op) => op(),
    },
    beginLifecycle: () => () => {},
    serializeEntry: async (_entryId, op) => op(),
    setDesiredStateExclusive: async (entryId, desiredState) => {
      const loaded = await store.getEntryWithVersion(entryId);
      return (await store.replaceEntry(loaded!.version, {
        ...loaded!.entry,
        desired_state: desiredState,
        observed_state: desiredState === "stopped" ? "stopped" : loaded!.entry.observed_state,
      })).entry;
    },
    updateManifestEntry: async (entryId, update) => {
      const loaded = await store.getEntryWithVersion(entryId);
      return (await store.replaceEntry(loaded!.version, update(loaded!.entry))).entry;
    },
    entryWithDerivedLiveness: async (e) => e as never,
    stopDelivery: async () => {},
    hasLiveHandle: () => false,
    runtimeCustody: custody,
    deleteAgentStream: () => {},
    reconcileRuntimeRecoveriesForPurge: (entryId) => { coordinator.recoverInactiveExecutingForAgent(entryId); },
    retireStaleRuntimeRecoveryEffects: (entryId) => { coordinator.retireStalePreparedEffects(entryId); },
    ephemeralProvisioner: { garbageCollectOrphans: async () => [] },
    nowMs: () => currentNowMs,
  });

  const callEndSession = (input: EndSessionCallInput) =>
    (coordinator as unknown as { endWorkerSessionForRestart(i: EndSessionCallInput): Promise<void> })
      .endWorkerSessionForRestart(input);

  try {
    // 1. completeRuntimeRecovery atomically retires prepared effects for that operation while preserving executing & unrelated ops,
    //    and rolls back on future-epoch prepared rows.
    await store.createEntry(manifestEntry("agent-complete", {
      desired_state: "running",
      observed_state: "recovering",
      provider_ref: null,
    }));
    await store.createEntry(manifestEntry("agent-other", {
      desired_state: "running",
      observed_state: "idle",
      last_worker_binding: {
        agent_session_id: "sess-other",
        work_attempt_id: "att-other",
        execution_generation_id: "exec-other",
        updated_at: NOW_ISO,
      },
    }));
    db.prepare(`
      INSERT INTO agent_runtime_recoveries (
        operation_id, agent_id, room_id, execution_generation_id, runtime_generation_id,
        mode, phase, provider_ref_json, observer_json, created_at, updated_at
      ) VALUES ('op-complete-1', 'agent-complete', 'room-1', 'exec-c1', 'rt-c1', 'fresh', 'stopped', '{}', NULL, ?, ?)
    `).run(NOW_ISO, NOW_ISO);
    const prepOp = await executor.prepare({
      agent_id: "agent-complete",
      kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
        operationId: "op-complete-1",
        roomId: "room-1",
        executionGenerationId: "exec-c1",
        sessionId: "sess-c1",
      }),
      payload: {
        operation_id: "op-complete-1",
        room_id: "room-1",
        execution_generation_id: "exec-c1",
        session_id: "sess-c1",
        restarting: true,
      },
      retryable: true,
      max_attempts: 1_000_000,
    });
    const prepOther = await executor.prepare({
      agent_id: "agent-other",
      kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
        operationId: null,
        roomId: "room-1",
        executionGenerationId: "exec-other",
        sessionId: "sess-other",
      }),
      payload: {
        operation_id: null,
        room_id: "room-1",
        execution_generation_id: "exec-other",
        session_id: "sess-other",
        restarting: true,
      },
      retryable: true,
      max_attempts: 1_000_000,
    });
    // Future-epoch check: rolls back phase update and earlier prepared retirement atomically.
    db.prepare(`
      INSERT INTO effects (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES ('eff-op-future', 'agent-complete', ?, 'rrews:v1:op-complete-future', ?, 'prepared', ?, NULL, 1, 0, 1000000, NULL, NULL, ?, ?)
    `).run(
      RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      GENERATION + 5,
      JSON.stringify({
        execution_generation_id: "exec-c1",
        operation_id: "op-complete-1",
        restarting: true,
        room_id: "room-1",
        session_id: "sess-c1-future",
      }),
      NOW_ISO,
      NOW_ISO,
    );
    await assert.rejects(
      () => store.completeRuntimeRecovery("op-complete-1", async (commit) => commit(), GENERATION),
      EffectFenceError,
    );
    assert.equal(
      (db.prepare("SELECT phase FROM agent_runtime_recoveries WHERE operation_id = 'op-complete-1'").get() as { phase: string }).phase,
      "stopped",
      "future-epoch effect must roll back completeRuntimeRecovery atomically",
    );
    assert.equal(getEffect(db, prepOp.effect.id)?.state, "prepared", "rollback must restore earlier prepared effect too");
    // Remove the tampered future-epoch row and complete cleanly.
    db.prepare("DELETE FROM effects WHERE id = 'eff-op-future'").run();
    await store.completeRuntimeRecovery("op-complete-1", async (commit) => commit(), GENERATION);
    assert.equal(getEffect(db, prepOp.effect.id)?.state, "failed");
    assert.equal(getEffect(db, prepOp.effect.id)?.last_error, "runtime_recovery_complete");
    assert.equal(getEffect(db, prepOther.effect.id)?.state, "prepared", "unrelated agent effect must stay untouched");

    // 2. Refused endWorkerSession (HTTP 403 -> prepared) -> stop + purge succeeds with 0 post-purge HTTP past +24h & startup recovery.
    const grantStopPurge = custody.installHostGrant(makeGrant({ entryId: "agent-stop-purge" }));
    await store.createEntry(manifestEntry("agent-stop-purge", {
      desired_state: "running",
      observed_state: "idle",
      last_worker_binding: {
        agent_session_id: "sess-stop-purge",
        work_attempt_id: "att-sp",
        execution_generation_id: "exec-sp",
        updated_at: NOW_ISO,
      },
    }));
    endWorkerSessionFn = async () => {
      httpCalls += 1;
      throw new SupervisorGrantRequestError(403, "Supervisor worker session end");
    };
    await assert.rejects(
      () => callEndSession({
        agentId: "agent-stop-purge",
        roomId: "room-1",
        operationId: null,
        executionGenerationId: "exec-sp",
        sessionId: "sess-stop-purge",
        grant: grantStopPurge,
      }),
      /HTTP 403/,
    );
    const [spEffect] = listEffectsForAgent(db, "agent-stop-purge", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
    assert.equal(spEffect?.state, "prepared");
    assert.equal(spEffect?.last_error, "http_403");
    assert.equal(httpCalls, 1);

    // Non-stopped agent refuses purge and leaves prepared row untouched.
    const refusedRunning = await lifecycle.purgeAgent("agent-stop-purge", GENERATION, "sess-stop-purge", false);
    assert.equal(refusedRunning.outcome, "invalid");
    assert.equal(getEffect(db, spEffect!.id)?.state, "prepared");

    // Stop the agent (clearing last_worker_binding) -> purge succeeds cleanly.
    const spLoaded = await store.getEntryWithVersion("agent-stop-purge");
    await store.replaceEntry(spLoaded!.version, {
      ...spLoaded!.entry,
      desired_state: "stopped",
      observed_state: "stopped",
      last_worker_binding: null,
    });
    const purged = await lifecycle.purgeAgent("agent-stop-purge", GENERATION, "sess-stop-purge", false);
    assert.deepEqual(purged, { outcome: "purged" });
    currentNowMs += 24 * 60 * 60 * 1_000;
    await executor.recoverOnStartup();
    assert.equal(listEffectsForAgent(db, "agent-stop-purge").length, 0);
    assert.equal(httpCalls, 1, "zero post-purge HTTP calls past retry deadline and startup recovery");

    // 3. retireAgent immediately retires stale prepared runtime-recovery effects even before purgeAgent.
    const grantRetire = custody.installHostGrant(makeGrant({ entryId: "agent-retire" }));
    await store.createEntry(manifestEntry("agent-retire", {
      desired_state: "running",
      observed_state: "idle",
      last_worker_binding: {
        agent_session_id: "sess-retire",
        work_attempt_id: "att-retire",
        execution_generation_id: "exec-retire",
        updated_at: NOW_ISO,
      },
    }));
    await assert.rejects(
      () => callEndSession({
        agentId: "agent-retire",
        roomId: "room-1",
        operationId: null,
        executionGenerationId: "exec-retire",
        sessionId: "sess-retire",
        grant: grantRetire,
      }),
      /HTTP 403/,
    );
    const [retireEff] = listEffectsForAgent(db, "agent-retire", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND });
    assert.equal(retireEff?.state, "prepared");
    const retired = await lifecycle.retireAgent("agent-retire", GENERATION, "sess-retire", false);
    assert.equal(retired.outcome, "retired");
    assert.equal(getEffect(db, retireEff!.id)?.state, "failed");
    assert.equal(getEffect(db, retireEff!.id)?.last_error, "agent_stopped");

    // 4. Startup healing retires stale prepared rows for completed recoveries and removed bindings while preserving active ones.
    await store.createEntry(manifestEntry("agent-startup", {
      desired_state: "running",
      observed_state: "idle",
      last_worker_binding: null,
    }));
    db.prepare(`
      INSERT INTO agent_runtime_recoveries (
        operation_id, agent_id, room_id, execution_generation_id, runtime_generation_id,
        mode, phase, provider_ref_json, observer_json, created_at, updated_at
      ) VALUES ('op-startup-done', 'agent-startup', 'room-1', 'exec-st', 'rt-st', 'fresh', 'complete', '{}', NULL, ?, ?)
    `).run(NOW_ISO, NOW_ISO);
    const staleByOp = await executor.prepare({
      agent_id: "agent-startup",
      kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
        operationId: "op-startup-done",
        roomId: "room-1",
        executionGenerationId: "exec-st",
        sessionId: "sess-st-op",
      }),
      payload: {
        operation_id: "op-startup-done",
        room_id: "room-1",
        execution_generation_id: "exec-st",
        session_id: "sess-st-op",
        restarting: true,
      },
      retryable: true,
      max_attempts: 1_000_000,
    });
    const staleByBinding = await executor.prepare({
      agent_id: "agent-startup",
      kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
        operationId: null,
        roomId: "room-1",
        executionGenerationId: "exec-st",
        sessionId: "sess-st-gone",
      }),
      payload: {
        operation_id: null,
        room_id: "room-1",
        execution_generation_id: "exec-st",
        session_id: "sess-st-gone",
        restarting: true,
      },
      retryable: true,
      max_attempts: 1_000_000,
    });
    await coordinator.recoverTurnControls();
    assert.equal(getEffect(db, staleByOp.effect.id)?.state, "failed");
    assert.equal(getEffect(db, staleByOp.effect.id)?.last_error, "recovery_phase_disallowed");
    assert.equal(getEffect(db, staleByBinding.effect.id)?.state, "failed");
    assert.equal(getEffect(db, staleByBinding.effect.id)?.last_error, "worker_session_absent");
    assert.equal(getEffect(db, prepOther.effect.id)?.state, "prepared", "still-bound running agent effect survives startup healing");

    // 5. Purge blockers & rollback atomicity:
    //    (a) pending agent_runtime_recoveries blocks purge & keeps prepared row untouched
    //    (b) live in-flight executing row (isEffectActive === true) blocks purge & rolls back sibling prepared row
    //    (c) inactive executing row (isEffectActive === false, epoch <= GENERATION) recovers and purges cleanly
    //    (d) future-epoch executing or prepared row fails closed and rolls back atomically
    await store.createEntry(manifestEntry("agent-blockers", {
      desired_state: "stopped",
      observed_state: "stopped",
      last_worker_binding: null,
    }));
    db.prepare(`
      INSERT INTO agent_runtime_recoveries (
        operation_id, agent_id, room_id, execution_generation_id, runtime_generation_id,
        mode, phase, provider_ref_json, observer_json, created_at, updated_at
      ) VALUES ('op-pending-block', 'agent-blockers', 'room-1', 'exec-blk', 'rt-blk', 'fresh', 'stopped', '{}', NULL, ?, ?)
    `).run(NOW_ISO, NOW_ISO);
    const prepBlocker = await executor.prepare({
      agent_id: "agent-blockers",
      kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      idempotency_key: runtimeRecoveryEndWorkerSessionIdempotencyKey({
        operationId: "op-pending-block",
        roomId: "room-1",
        executionGenerationId: "exec-blk",
        sessionId: "sess-blk-1",
      }),
      payload: {
        operation_id: "op-pending-block",
        room_id: "room-1",
        execution_generation_id: "exec-blk",
        session_id: "sess-blk-1",
        restarting: true,
      },
      retryable: true,
      max_attempts: 1_000_000,
    });
    const blockedByPending = await lifecycle.purgeAgent("agent-blockers", GENERATION, null, true);
    assert.equal(blockedByPending.outcome, "invalid");
    assert.equal(getEffect(db, prepBlocker.effect.id)?.state, "prepared", "pending recovery keeps prepared row intact on refused purge");

    // Mark recovery complete, then test live executing row vs sibling prepared row.
    db.prepare("UPDATE agent_runtime_recoveries SET phase = 'complete' WHERE operation_id = 'op-pending-block'").run();
    const liveGrant = custody.installHostGrant(makeGrant({ entryId: "agent-blockers" }));
    // Prepare a second op that stays valid in agent_runtime_recoveries so executor claims & holds it in-flight.
    db.prepare(`
      INSERT INTO agent_runtime_recoveries (
        operation_id, agent_id, room_id, execution_generation_id, runtime_generation_id,
        mode, phase, provider_ref_json, observer_json, created_at, updated_at
      ) VALUES ('op-live-flight', 'agent-blockers', 'room-1', 'exec-blk-live', 'rt-blk-live', 'fresh', 'stopped', '{}', NULL, ?, ?)
    `).run(NOW_ISO, NOW_ISO);
    let markInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => { markInFlight = resolve; });
    let releaseInFlight!: () => void;
    endWorkerSessionFn = async () => {
      httpCalls += 1;
      markInFlight();
      await new Promise<void>((resolve) => { releaseInFlight = resolve; });
    };
    const liveRun = callEndSession({
      agentId: "agent-blockers",
      roomId: "room-1",
      operationId: "op-live-flight",
      executionGenerationId: "exec-blk-live",
      sessionId: "sess-blk-live",
      grant: liveGrant,
    });
    await inFlight;
    // Complete op-live-flight in DB so ONLY the live executing effect blocks purge, proving isEffectActive + rollback of prepBlocker!
    db.prepare("UPDATE agent_runtime_recoveries SET phase = 'complete' WHERE operation_id = 'op-live-flight'").run();
    const liveEff = listEffectsForAgent(db, "agent-blockers", { kind: RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND, states: ["executing"] })[0]!;
    assert.equal(executor.isEffectActive(liveEff.id), true);
    const blockedByLive = await lifecycle.purgeAgent("agent-blockers", GENERATION, null, true);
    assert.equal(blockedByLive.outcome, "invalid");
    assert.equal(getEffect(db, liveEff.id)?.state, "executing", "live executing row must not be touched by purge reconciliation");
    assert.equal(getEffect(db, prepBlocker.effect.id)?.state, "prepared", "refused purge must roll back sibling prepared retirement atomically");
    releaseInFlight();
    await assert.rejects(() => liveRun, /recovery_phase_disallowed/);
    assert.equal(getEffect(db, liveEff.id)?.state, "failed");

    // Seed a future-epoch prepared row -> purge fails closed and rolls back prepBlocker too.
    db.prepare(`
      INSERT INTO effects (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES ('eff-blk-future', 'agent-blockers', ?, 'rrews:v1:future-blk', ?, 'prepared', ?, NULL, 1, 0, 1000000, NULL, NULL, ?, ?)
    `).run(
      RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      GENERATION + 3,
      JSON.stringify({
        execution_generation_id: "exec-blk",
        operation_id: null,
        restarting: true,
        room_id: "room-1",
        session_id: "sess-future",
      }),
      NOW_ISO,
      NOW_ISO,
    );
    const blockedByFuture = await lifecycle.purgeAgent("agent-blockers", GENERATION, null, true);
    assert.equal(blockedByFuture.outcome, "invalid");
    assert.equal(getEffect(db, "eff-blk-future")?.state, "prepared");
    assert.equal(getEffect(db, prepBlocker.effect.id)?.state, "prepared", "future-epoch refusal rolls back earlier prepared retirement atomically");
    db.prepare("DELETE FROM effects WHERE id = 'eff-blk-future'").run();

    // Seed an inactive (crashed storage outage) executing row -> reconcileRuntimeRecoveriesForPurge recovers it and purge succeeds!
    db.prepare(`
      INSERT INTO effects (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES ('eff-blk-inactive-exec', 'agent-blockers', ?, 'rrews:v1:inactive-exec-blk', ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
    `).run(
      RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
      GENERATION,
      JSON.stringify({
        execution_generation_id: "exec-blk",
        operation_id: null,
        restarting: true,
        room_id: "room-1",
        session_id: "sess-inactive",
      }),
      NOW_ISO,
      NOW_ISO,
    );
    const purgedAfterInactive = await lifecycle.purgeAgent("agent-blockers", GENERATION, null, true);
    assert.deepEqual(purgedAfterInactive, { outcome: "purged" });
    assert.equal(listEffectsForAgent(db, "agent-blockers").length, 0);
  } finally {
    await store.close();
    await bindings.close();
    stateDb.close();
    await removeTestDirectory(root);
  }
});
