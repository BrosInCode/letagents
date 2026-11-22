import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SupervisorGrantRequestError, type SupervisorGrantHttp } from "../cloud-http.js";
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
import { RuntimeRecoveryCoordinator, type RuntimeRecoveryCoordinatorOptions } from "../runtime-recovery-coordinator.js";
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
