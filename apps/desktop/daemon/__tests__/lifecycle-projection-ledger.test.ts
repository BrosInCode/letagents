import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DaemonStateSchema } from "../daemon-state-database.js";
import {
  LifecycleProjectionLedger,
  validateLifecycleProjectionLedgerSchema,
  type LifecycleProjectionObservation,
  type LifecycleTypedProjectionObservation,
} from "../lifecycle-projection-ledger.js";

const base = {
  agentId: "agent",
  provider: "codex" as const,
  workAttemptId: "work-attempt",
  executionGenerationId: "execution-generation",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "letagents-lifecycle-projection-"));
  const path = join(directory, "daemon-state.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  new DaemonStateSchema().createSchema(database);
  return { path, database, cleanup: async () => {
    try { database.close(); } catch { /* a restart test may already have closed this handle */ }
    await rm(directory, { recursive: true, force: true });
  } };
}

function recordTyped(database: DatabaseSync, ledger: LifecycleProjectionLedger,
  observation: LifecycleTypedProjectionObservation): void {
  database.exec("BEGIN IMMEDIATE");
  try { ledger.recordTypedInCurrentTransaction(observation); database.exec("COMMIT"); }
  catch (error) { try { database.exec("ROLLBACK"); } catch { /* already closed */ } throw error; }
}

test("paired terminal checkpoints close a durable segment in either arrival order", async () => {
  const env = await fixture();
  try {
    let now = 100;
    const ledger = new LifecycleProjectionLedger(env.database, () => now++);
    const active = { ...base, nativeEventId: "native-active", phase: "turn_active" as const, state: "working" as const };
    const terminal = { ...base, nativeEventId: "native-terminal", phase: "turn_terminal" as const, state: "terminal" as const };
    ledger.recordLegacy(active);
    recordTyped(env.database, ledger, active);
    recordTyped(env.database, ledger, terminal);

    assert.equal(ledger.diagnostics().providers.codex.comparedSegments, 0,
      "elapsed time and one terminal lane never close a comparison window");
    assert.deepEqual(env.database.prepare("SELECT classification,accounted FROM lifecycle_projection_pairs ORDER BY native_event_id")
      .all().map((row) => ({ ...row })), [
      { classification: "incomplete", accounted: 0 },
      { classification: "incomplete", accounted: 0 },
    ]);

    ledger.recordLegacy(terminal);
    assert.deepEqual(ledger.diagnostics().providers.codex, {
      comparedSegments: 1,
      matched: 2,
      missingInTyped: 0,
      missingInLegacy: 0,
      pairedButDifferent: 0,
      conflicts: 0,
      observationUnavailable: 0,
    });
    const durable = ledger.diagnostics();
    const restartedDatabase = new DatabaseSync(env.path);
    restartedDatabase.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    validateLifecycleProjectionLedgerSchema(restartedDatabase);
    assert.deepEqual(new LifecycleProjectionLedger(restartedDatabase).diagnostics(), durable,
      "a reopened daemon database sees the same durable aggregate evidence");
    restartedDatabase.close();

    const reverse = { ...base, provider: "cursor" as const, workAttemptId: "reverse-attempt",
      executionGenerationId: "reverse-generation" };
    ledger.recordLegacy({ ...reverse, nativeEventId: "reverse-active", phase: "turn_active", state: "working" });
    ledger.recordLegacy({ ...reverse, nativeEventId: "reverse-terminal", phase: "turn_terminal", state: "terminal" });
    assert.equal(ledger.diagnostics().providers.cursor.comparedSegments, 0,
      "a legacy terminal alone cannot close a segment");
    recordTyped(env.database, ledger, { ...reverse, nativeEventId: "reverse-active", phase: "turn_active", state: "working" });
    recordTyped(env.database, ledger, { ...reverse, nativeEventId: "reverse-terminal", phase: "turn_terminal", state: "terminal" });
    assert.deepEqual(ledger.diagnostics().providers.cursor, {
      comparedSegments: 1,
      matched: 2,
      missingInTyped: 0,
      missingInLegacy: 0,
      pairedButDifferent: 0,
      conflicts: 0,
      observationUnavailable: 0,
    });
  } finally { await env.cleanup(); }
});

test("paired differences retain both closed state tokens without normalization", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    recordTyped(env.database, ledger, { ...base, nativeEventId: "active", phase: "turn_active", state: "working" });
    ledger.recordLegacy({ ...base, nativeEventId: "active", phase: "turn_active", state: "idle" });
    ledger.recordLegacy({ ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "failed" });
    recordTyped(env.database, ledger, { ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "terminal" });

    assert.equal(ledger.diagnostics().providers.codex.pairedButDifferent, 2);
    assert.deepEqual(env.database.prepare(`SELECT native_event_id,typed_phase,typed_state,legacy_phase,legacy_state,classification
      FROM lifecycle_projection_pairs ORDER BY native_event_id`).all().map((row) => ({ ...row })), [
      { native_event_id: "active", typed_phase: "turn_active", typed_state: "working",
        legacy_phase: "turn_active", legacy_state: "idle", classification: "divergent" },
      { native_event_id: "terminal", typed_phase: "turn_terminal", typed_state: "terminal",
        legacy_phase: "turn_terminal", legacy_state: "failed", classification: "divergent" },
    ]);
  } finally { await env.cleanup(); }
});

test("terminal pairing accounts lane-local omissions exactly once", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    recordTyped(env.database, ledger, { ...base, nativeEventId: "common", phase: "turn_active", state: "working" });
    recordTyped(env.database, ledger, { ...base, nativeEventId: "typed-only", phase: "turn_active", state: "working" });
    recordTyped(env.database, ledger, { ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "terminal" });
    ledger.recordLegacy({ ...base, nativeEventId: "common", phase: "turn_active", state: "working" });
    ledger.recordLegacy({ ...base, nativeEventId: "legacy-only", phase: "turn_active", state: "working" });
    ledger.recordLegacy({ ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "terminal" });

    assert.deepEqual(ledger.diagnostics().providers.codex, {
      comparedSegments: 1,
      matched: 2,
      missingInTyped: 1,
      missingInLegacy: 1,
      pairedButDifferent: 0,
      conflicts: 0,
      observationUnavailable: 0,
    });
    ledger.recordLegacy({ ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "terminal" });
    assert.equal(ledger.diagnostics().providers.codex.comparedSegments, 1, "exact replay cannot double-count a closed window");
  } finally { await env.cleanup(); }
});

test("a witness that crosses one lane's terminal boundary is a conflict, never a match", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    for (const event of [
      { nativeEventId: "active", phase: "turn_active" as const, state: "working" as const },
      { nativeEventId: "terminal-one", phase: "turn_terminal" as const, state: "terminal" as const },
      { nativeEventId: "crossed", phase: "turn_active" as const, state: "working" as const },
      { nativeEventId: "terminal-two", phase: "turn_terminal" as const, state: "terminal" as const },
    ]) recordTyped(env.database, ledger, { ...base, ...event });
    for (const event of [
      { nativeEventId: "active", phase: "turn_active" as const, state: "working" as const },
      { nativeEventId: "crossed", phase: "turn_active" as const, state: "working" as const },
      { nativeEventId: "terminal-one", phase: "turn_terminal" as const, state: "terminal" as const },
    ]) ledger.recordLegacy({ ...base, ...event });

    assert.deepEqual({ ...env.database.prepare(`SELECT classification,conflict,accounted FROM lifecycle_projection_pairs
      WHERE native_event_id='crossed'`).get() }, { classification: "conflict", conflict: 1, accounted: 0 });
    assert.deepEqual(ledger.diagnostics().providers.codex, {
      comparedSegments: 1, matched: 2, missingInTyped: 0, missingInLegacy: 0,
      pairedButDifferent: 0, conflicts: 1, observationUnavailable: 0,
    });

    ledger.recordLegacy({ ...base, nativeEventId: "terminal-two", phase: "turn_terminal", state: "terminal" });
    assert.deepEqual({ ...env.database.prepare(`SELECT classification,conflict,accounted FROM lifecycle_projection_pairs
      WHERE native_event_id='crossed'`).get() }, { classification: "conflict", conflict: 1, accounted: 1 });
    assert.deepEqual(ledger.diagnostics().providers.codex, {
      comparedSegments: 2, matched: 3, missingInTyped: 0, missingInLegacy: 0,
      pairedButDifferent: 0, conflicts: 1, observationUnavailable: 0,
    });
    validateLifecycleProjectionLedgerSchema(env.database);
  } finally { await env.cleanup(); }
});

test("same-side mutation and late evidence become conflicts without rewriting witnesses", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    recordTyped(env.database, ledger, { ...base, nativeEventId: "changed", phase: "turn_active", state: "working" });
    recordTyped(env.database, ledger, { ...base, nativeEventId: "changed", phase: "turn_active", state: "working" });
    assert.equal(ledger.diagnostics().providers.codex.conflicts, 0, "exact same-side replay is idempotent");
    recordTyped(env.database, ledger, { ...base, nativeEventId: "changed", phase: "turn_terminal", state: "terminal" });

    recordTyped(env.database, ledger, { ...base, nativeEventId: "late", phase: "turn_active", state: "working" });
    recordTyped(env.database, ledger, { ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "terminal" });
    ledger.recordLegacy({ ...base, nativeEventId: "terminal", phase: "turn_terminal", state: "terminal" });
    assert.equal(ledger.diagnostics().providers.codex.missingInLegacy, 1,
      "the already-conflicted row is not also counted as missing");
    ledger.recordLegacy({ ...base, nativeEventId: "late", phase: "turn_active", state: "working" });

    assert.equal(ledger.diagnostics().providers.codex.conflicts, 2);
    const rows = env.database.prepare(`SELECT native_event_id,typed_phase,typed_state,legacy_phase,legacy_state,classification,conflict
      FROM lifecycle_projection_pairs WHERE native_event_id IN ('changed','late') ORDER BY native_event_id`).all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { native_event_id: "changed", typed_phase: "turn_active", typed_state: "working",
        legacy_phase: null, legacy_state: null, classification: "conflict", conflict: 1 },
      { native_event_id: "late", typed_phase: "turn_active", typed_state: "working",
        legacy_phase: null, legacy_state: null, classification: "conflict", conflict: 1 },
    ]);
  } finally { await env.cleanup(); }
});

test("opposite sides cannot assign different phases to one opaque checkpoint", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    recordTyped(env.database, ledger, { ...base, nativeEventId: "phase-conflict", phase: "turn_terminal", state: "terminal" });
    ledger.recordLegacy({ ...base, nativeEventId: "phase-conflict", phase: "turn_active", state: "working" });
    assert.deepEqual({ ...env.database.prepare(`SELECT typed_phase,legacy_phase,classification,conflict,accounted
      FROM lifecycle_projection_pairs WHERE native_event_id='phase-conflict'`).get() }, {
      typed_phase: "turn_terminal", legacy_phase: "turn_active", classification: "conflict", conflict: 1, accounted: 0,
    });
    assert.equal(ledger.diagnostics().providers.codex.conflicts, 1);
    validateLifecycleProjectionLedgerSchema(env.database);
  } finally { await env.cleanup(); }
});

test("unknown providers, phases, and typed states are rejected rather than folded", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    assert.throws(() => ledger.recordLegacy({ ...base, provider: "novel" } as unknown as LifecycleProjectionObservation),
      /Lifecycle projection evidence/);
    assert.throws(() => ledger.recordLegacy({ ...base, nativeEventId: "event", phase: "novel", state: "working" } as unknown as LifecycleProjectionObservation),
      /Lifecycle projection evidence/);
    env.database.exec("BEGIN IMMEDIATE");
    assert.throws(() => ledger.recordTypedInCurrentTransaction({ ...base, nativeEventId: "event", phase: "turn_active", state: "idle" } as unknown as LifecycleTypedProjectionObservation),
      /Lifecycle projection evidence/);
    assert.throws(() => ledger.recordTypedInCurrentTransaction({ ...base, nativeEventId: "event", phase: "turn_active", state: "terminal" }),
      /Lifecycle projection evidence/);
    assert.throws(() => ledger.recordTypedInCurrentTransaction({ ...base, nativeEventId: "event", phase: "turn_terminal", state: "working" }),
      /Lifecycle projection evidence/);
    env.database.exec("ROLLBACK");
    assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 0);
  } finally { await env.cleanup(); }
});

test("the global lane cap records explicit unavailability without creating an extra lane", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    env.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 1_025; index++) ledger.recordTypedInCurrentTransaction({
      ...base,
      agentId: `agent-${index}`,
      workAttemptId: `attempt-${index}`,
      executionGenerationId: `generation-${index}`,
      nativeEventId: "active",
      phase: "turn_active",
      state: "working",
    });
    env.database.exec("COMMIT");
    assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_lanes").get()!.count, 1_024);
    assert.equal(ledger.diagnostics().providers.codex.observationUnavailable, 1);
    validateLifecycleProjectionLedgerSchema(env.database);
  } finally { await env.cleanup(); }
});

test("the per-agent cap latches explicit unavailability without evicting evidence", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    env.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 10_001; index++) ledger.recordTypedInCurrentTransaction({
      ...base,
      nativeEventId: `event-${index}`,
      phase: index === 9_999 ? "turn_terminal" : "turn_active",
      state: index === 9_999 ? "terminal" : "working",
    });
    env.database.exec("COMMIT");
    assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 10_000);
    assert.equal(ledger.diagnostics().providers.codex.observationUnavailable, 1);
    assert.deepEqual({ ...env.database.prepare("SELECT observation_count,retention_limited,observation_unavailable FROM lifecycle_projection_lanes").get() },
      { observation_count: 10_000, retention_limited: 1, observation_unavailable: 1 });
    ledger.recordLegacy({ ...base, nativeEventId: "event-9999", phase: "turn_terminal", state: "terminal" });
    assert.deepEqual(ledger.diagnostics().providers.codex, {
      comparedSegments: 1,
      matched: 1,
      missingInTyped: 0,
      missingInLegacy: 9_999,
      pairedButDifferent: 0,
      conflicts: 0,
      observationUnavailable: 1,
    }, "retention pressure cannot prevent an already-retained terminal witness from closing its segment");
    assert.throws(() => env.database.exec("DELETE FROM lifecycle_projection_pairs"), /cannot be deleted/);
    assert.throws(() => env.database.exec("DELETE FROM lifecycle_projection_lanes"), /cannot be deleted/);
    assert.throws(() => env.database.exec("DELETE FROM lifecycle_projection_totals"), /cannot be deleted/);
    validateLifecycleProjectionLedgerSchema(env.database);
  } finally { await env.cleanup(); }
});

test("a capped agent cannot consume new lanes or starve another agent", async () => {
  const env = await fixture();
  try {
    const ledger = new LifecycleProjectionLedger(env.database, () => 100);
    env.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 10_000; index++) ledger.recordTypedInCurrentTransaction({
      ...base,
      nativeEventId: `event-${index}`,
      phase: "turn_active",
      state: "working",
    });
    for (let index = 0; index < 1_023; index++) ledger.recordTypedInCurrentTransaction({
      ...base,
      workAttemptId: `capped-attempt-${index}`,
      executionGenerationId: `capped-generation-${index}`,
      nativeEventId: "active",
      phase: "turn_active",
      state: "working",
    });
    ledger.recordTypedInCurrentTransaction({
      ...base,
      agentId: "another-agent",
      workAttemptId: "another-attempt",
      executionGenerationId: "another-generation",
      nativeEventId: "active",
      phase: "turn_active",
      state: "working",
    });
    env.database.exec("COMMIT");

    assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_lanes").get()!.count, 2);
    assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_lanes WHERE agent_id='agent'").get()!.count, 1);
    assert.equal(env.database.prepare("SELECT observation_count FROM lifecycle_projection_lanes WHERE agent_id='another-agent'").get()!.observation_count, 1);
    assert.equal(ledger.diagnostics().providers.codex.observationUnavailable, 1_023);
    validateLifecycleProjectionLedgerSchema(env.database);
  } finally { await env.cleanup(); }
});
