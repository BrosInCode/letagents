/**
 * Unified EffectJournal and EffectExecutor crash, fencing, idempotency, backoff,
 * and shutdown/handoff drain test matrix.
 *
 * Covers every state step (prepared, executing before external commit, executing
 * after external commit before receipt persistence, uncertain, completed, failed)
 * with both deterministic in-process fault injection and real child-process SIGKILL
 * crashes followed by restart on the next daemon generation.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { DaemonStateDatabase } from "../daemon-state-database.js";
import {
  EffectExecutor,
  EffectFenceError,
  EffectIdempotencyConflictError,
  EffectValidationError,
  MAX_EFFECT_PAYLOAD_BYTES,
  claimEffectForExecution,
  completeEffect,
  computeEffectBackoffMs,
  failEffect,
  getEffect,
  getEffectByIdempotencyKey,
  listEffectsForAgent,
  markEffectUncertain,
  prepareEffect,
  prepareEffectInTransaction,
  recoverInterruptedEffectsOnStartup,
  rescheduleEffectForRetry,
  resolveUncertainEffect,
  withFencedEffectTransaction,
} from "../effect-journal/index.js";
import { SupervisorDaemon } from "../main.js";
import { DaemonFenceLostError } from "../singleton.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { testDaemonEndpoint } from "./helpers/daemon-fixture.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DB_MODULE_URL = pathToFileURL(join(THIS_DIR, "../daemon-state-database.ts")).href;
const EFFECT_MODULE_URL = pathToFileURL(join(THIS_DIR, "../effect-journal/index.ts")).href;

async function tempEnv(prefix = "letagents-effect-journal-"): Promise<{
  root: string;
  dbPath: string;
  stateDb: DaemonStateDatabase;
  db: DatabaseSync;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  return {
    root,
    dbPath,
    stateDb,
    db: stateDb.connection,
    cleanup: async () => {
      stateDb.close();
      await removeTestDirectory(root);
    },
  };
}

/**
 * Spawns a real child process that runs a script against `dbPath`, waits for
 * the child to emit `readyMarker` on stdout, and then sends SIGKILL immediately.
 */
async function spawnAndKillAtMarker(
  script: string,
  env: Record<string, string>,
  readyMarker: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--conditions=letagents-source", "--import", "tsx", "--input-type=module", "-e", script],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${readyMarker}: ${stderr}`)), 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(readyMarker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before ${readyMarker} (code=${code}, signal=${signal}): ${stderr}`));
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("effect journal enforces plain wire payloads, canonical idempotency, atomic domain+effect commits, and SQLite immutability triggers", async () => {
  const env = await tempEnv();
  try {
    // 1. Non-wire payloads (getters, BigInt, symbols, NaN, cycles, class instances, oversize) are rejected.
    let getterInvoked = false;
    const withGetter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() { getterInvoked = true; return "boom"; },
    });
    assert.throws(() => prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "k", idempotency_key: "bad-getter", epoch: 1, payload: withGetter,
    }), EffectValidationError);
    assert.equal(getterInvoked, false, "payload validation must reject getters without invoking them");

    for (const badPayload of [
      { n: 1n },
      { n: Number.NaN },
      { fn: () => {} },
      { date: new Date() },
      { big: "x".repeat(MAX_EFFECT_PAYLOAD_BYTES + 1) },
    ]) {
      assert.throws(() => prepareEffect(env.db, () => {}, {
        agent_id: "agent_1", kind: "k", idempotency_key: "bad-wire", epoch: 1, payload: badPayload,
      }), EffectValidationError);
    }

    // 2. Canonical JSON key ordering makes reordered payloads idempotently equal; different payloads conflict.
    const first = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "notify", idempotency_key: "key-1", epoch: 1,
      payload: { b: 2, a: { y: true, x: [1, 2] } },
    });
    assert.equal(first.created, true);
    const replay = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "notify", idempotency_key: "key-1", epoch: 2,
      payload: { a: { x: [1, 2], y: true }, b: 2 },
    });
    assert.equal(replay.created, false);
    assert.equal(replay.effect.id, first.effect.id);

    assert.throws(() => prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "notify", idempotency_key: "key-1", epoch: 2,
      payload: { a: { x: [1, 3], y: true }, b: 2 },
    }), EffectIdempotencyConflictError);

    assert.throws(() => prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "notify", idempotency_key: "key-1", epoch: 2,
      payload: { a: { x: [1, 2], y: true }, b: 2 },
      retryable: true,
    }), EffectIdempotencyConflictError);

    // Explicit ID bound to another idempotency key conflicts.
    assert.throws(() => prepareEffect(env.db, () => {}, {
      id: first.effect.id,
      agent_id: "agent_1", kind: "notify", idempotency_key: "key-other", epoch: 2,
      payload: { a: 1 },
    }), EffectIdempotencyConflictError);

    // 3. Atomic internal-state + outbound-effect commit via prepareEffectInTransaction.
    assert.throws(() => withFencedEffectTransaction(env.db, () => {}, () => {
      env.db.prepare(`
        INSERT INTO agents (
          agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
          charter, desired_state, observed_state, condition
        ) VALUES ('agent_atomic', 0, 1, 'owner', '2026-11-21T00:00:00.000Z', 'Atomic', 'room_1', 'codex', 'c', 'running', 'idle', 'none')
      `).run();
      prepareEffectInTransaction(env.db, {
        agent_id: "agent_atomic", kind: "external_call", idempotency_key: "atomic-1", epoch: 1, payload: { step: 1 },
      });
      throw new Error("rollback both state and effect");
    }), /rollback both state and effect/);
    assert.equal(env.db.prepare("SELECT 1 FROM agents WHERE agent_id='agent_atomic'").get(), undefined);
    assert.equal(getEffectByIdempotencyKey(env.db, "agent_atomic", "external_call", "atomic-1"), null);

    // Now commit both atomically.
    const atomicEffect = withFencedEffectTransaction(env.db, () => {}, () => {
      env.db.prepare(`
        INSERT INTO agents (
          agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
          charter, desired_state, observed_state, condition
        ) VALUES ('agent_atomic', 0, 1, 'owner', '2026-11-21T00:00:00.000Z', 'Atomic', 'room_1', 'codex', 'c', 'running', 'idle', 'none')
      `).run();
      return prepareEffectInTransaction(env.db, {
        agent_id: "agent_atomic", kind: "external_call", idempotency_key: "atomic-1", epoch: 1, payload: { step: 1 },
      }).effect;
    });
    assert.ok(env.db.prepare("SELECT 1 FROM agents WHERE agent_id='agent_atomic'").get());
    assert.equal(getEffect(env.db, atomicEffect.id)?.state, "prepared");

    // Non-retryable effects cannot have max_attempts > 1.
    assert.throws(() => prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "notify", idempotency_key: "bad-max", epoch: 1,
      payload: { a: 1 }, retryable: false, max_attempts: 2,
    }), EffectValidationError);

    // 4. SQLite immutability and transition triggers block tampering directly at the DB layer.
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET payload='{}' WHERE id=?").run(first.effect.id), /invalid/i);
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET idempotency_key='tampered' WHERE id=?").run(first.effect.id), /invalid/i);
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET state='completed' WHERE id=?").run(first.effect.id), /invalid/i);
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET state='uncertain', last_error='never ran' WHERE id=?").run(first.effect.id), /invalid/i);
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET next_attempt_at_ms=999 WHERE id=?").run(first.effect.id), /invalid/i);
    const claimed = claimEffectForExecution(env.db, () => {}, { id: first.effect.id, daemonGeneration: 2, nowMs: 1_000 });
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET epoch=1 WHERE id=?").run(claimed.id), /invalid/i);
    // Non-retryable row cannot transition executing -> prepared at either store or SQLite trigger level.
    assert.throws(() => rescheduleEffectForRetry(env.db, () => {}, {
      id: claimed.id, expectedEpoch: 2, expectedAttemptCount: 1, nextAttemptAtMs: 5_000, error: "no retry",
    }), EffectFenceError);
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET state='prepared', next_attempt_at_ms=5000 WHERE id=?").run(claimed.id), /invalid/i);
    completeEffect(env.db, () => {}, { id: claimed.id, expectedEpoch: 2, expectedAttemptCount: 1, outcome: { ok: true } });
    // Terminal immutability: completed row cannot be mutated even to failed.
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET state='failed', last_error='nope' WHERE id=?").run(claimed.id), /invalid/i);

    // Uncertain rows can never transition back to prepared for automatic replay.
    const uncertainPrep = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "notify", idempotency_key: "key-uncertain-lock", epoch: 2, payload: { u: 1 }, retryable: false,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: uncertainPrep.id, daemonGeneration: 2, nowMs: 1_000 });
    markEffectUncertain(env.db, () => {}, { id: uncertainPrep.id, expectedEpoch: 2, expectedAttemptCount: 1, error: "unknown" });
    assert.throws(() => env.db.prepare("UPDATE effect_journal SET state='prepared', next_attempt_at_ms=5000 WHERE id=?").run(uncertainPrep.id), /invalid/i);
  } finally {
    await env.cleanup();
  }
});

test("crash matrix (real SIGKILL at every state step): prepared, executing-before-side-effect, executing-after-side-effect-before-receipt, uncertain, completed, failed", async () => {
  const env = await tempEnv("letagents-effect-crash-matrix-");
  const ledgerPath = join(env.root, "external-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ nonIdempotentCalls: [], idempotentByKey: {}, idempotentRequests: 0 }), "utf8");
  env.stateDb.close();

  const readLedger = async () => JSON.parse(await readFile(ledgerPath, "utf8")) as {
    nonIdempotentCalls: Array<{ key: string; epoch: number }>;
    idempotentByKey: Record<string, { remoteId: string; firstEpoch: number }>;
    idempotentRequests: number;
  };

  try {
    // -------------------------------------------------------------------------
    // STEP 1: SIGKILL while `prepared` (before claim). External side effect = 0.
    // -------------------------------------------------------------------------
    await spawnAndKillAtMarker(`
      const { DaemonStateDatabase } = await import(process.env.DB_URL);
      const { prepareEffect } = await import(process.env.EFFECT_URL);
      const sdb = await DaemonStateDatabase.open(process.env.DB_PATH);
      prepareEffect(sdb.connection, () => {}, {
        id: "eff-step1-prepared",
        agent_id: "agent_1",
        kind: "external_mut",
        idempotency_key: "step1-key",
        epoch: 1,
        payload: { action: "create-pr" },
        retryable: false,
      });
      process.stdout.write("KILLED_IN_PREPARED\\n");
      setInterval(() => {}, 60_000);
    `, { DB_PATH: env.dbPath, DB_URL: DB_MODULE_URL, EFFECT_URL: EFFECT_MODULE_URL }, "KILLED_IN_PREPARED");

    // -------------------------------------------------------------------------
    // STEP 2A: SIGKILL while `executing` BEFORE external side effect (retryable = false).
    // -------------------------------------------------------------------------
    await spawnAndKillAtMarker(`
      const { DaemonStateDatabase } = await import(process.env.DB_URL);
      const { prepareEffect, claimEffectForExecution } = await import(process.env.EFFECT_URL);
      const sdb = await DaemonStateDatabase.open(process.env.DB_PATH);
      prepareEffect(sdb.connection, () => {}, {
        id: "eff-step2a-exec-before-nonretry",
        agent_id: "agent_1",
        kind: "external_mut",
        idempotency_key: "step2a-key",
        epoch: 1,
        payload: { action: "charge-once" },
        retryable: false,
      });
      claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step2a-exec-before-nonretry", daemonGeneration: 1, nowMs: 1_000 });
      process.stdout.write("KILLED_IN_EXECUTING_BEFORE_IO\\n");
      setInterval(() => {}, 60_000);
    `, { DB_PATH: env.dbPath, DB_URL: DB_MODULE_URL, EFFECT_URL: EFFECT_MODULE_URL }, "KILLED_IN_EXECUTING_BEFORE_IO");

    // -------------------------------------------------------------------------
    // STEP 2B: SIGKILL while `executing` BEFORE external side effect (retryable = true).
    // -------------------------------------------------------------------------
    await spawnAndKillAtMarker(`
      const { DaemonStateDatabase } = await import(process.env.DB_URL);
      const { prepareEffect, claimEffectForExecution } = await import(process.env.EFFECT_URL);
      const sdb = await DaemonStateDatabase.open(process.env.DB_PATH);
      prepareEffect(sdb.connection, () => {}, {
        id: "eff-step2b-exec-before-retry",
        agent_id: "agent_1",
        kind: "external_idempotent",
        idempotency_key: "step2b-key",
        epoch: 1,
        payload: { action: "idempotent-sync" },
        retryable: true,
        max_attempts: 3,
      });
      claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step2b-exec-before-retry", daemonGeneration: 1, nowMs: 1_000 });
      process.stdout.write("KILLED_IN_EXECUTING_BEFORE_IO_RETRY\\n");
      setInterval(() => {}, 60_000);
    `, { DB_PATH: env.dbPath, DB_URL: DB_MODULE_URL, EFFECT_URL: EFFECT_MODULE_URL }, "KILLED_IN_EXECUTING_BEFORE_IO_RETRY");

    // -------------------------------------------------------------------------
    // STEP 3A: SIGKILL while `executing` AFTER external side effect SUCCEEDED,
    //          BEFORE receipt stored (non-idempotent, retryable = false).
    // -------------------------------------------------------------------------
    await spawnAndKillAtMarker(`
      import { readFileSync, writeFileSync } from "node:fs";
      const { DaemonStateDatabase } = await import(process.env.DB_URL);
      const { prepareEffect, claimEffectForExecution } = await import(process.env.EFFECT_URL);
      const sdb = await DaemonStateDatabase.open(process.env.DB_PATH);
      prepareEffect(sdb.connection, () => {}, {
        id: "eff-step3a-after-io-nonretry",
        agent_id: "agent_1",
        kind: "external_mut",
        idempotency_key: "step3a-key",
        epoch: 1,
        payload: { action: "post-once" },
        retryable: false,
      });
      const claimed = claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step3a-after-io-nonretry", daemonGeneration: 1, nowMs: 1_000 });
      // External side effect commits to the outside world BEFORE daemon crashes.
      const ledger = JSON.parse(readFileSync(process.env.LEDGER_PATH, "utf8"));
      ledger.nonIdempotentCalls.push({ key: claimed.idempotency_key, epoch: claimed.epoch });
      writeFileSync(process.env.LEDGER_PATH, JSON.stringify(ledger), "utf8");
      process.stdout.write("KILLED_AFTER_IO_BEFORE_RECEIPT_NONRETRY\\n");
      setInterval(() => {}, 60_000);
    `, { DB_PATH: env.dbPath, LEDGER_PATH: ledgerPath, DB_URL: DB_MODULE_URL, EFFECT_URL: EFFECT_MODULE_URL }, "KILLED_AFTER_IO_BEFORE_RECEIPT_NONRETRY");

    // -------------------------------------------------------------------------
    // STEP 3B: SIGKILL while `executing` AFTER external side effect SUCCEEDED,
    //          BEFORE receipt stored (idempotent endpoint keyed by idempotency_key).
    // -------------------------------------------------------------------------
    await spawnAndKillAtMarker(`
      import { readFileSync, writeFileSync } from "node:fs";
      const { DaemonStateDatabase } = await import(process.env.DB_URL);
      const { prepareEffect, claimEffectForExecution } = await import(process.env.EFFECT_URL);
      const sdb = await DaemonStateDatabase.open(process.env.DB_PATH);
      prepareEffect(sdb.connection, () => {}, {
        id: "eff-step3b-after-io-retry",
        agent_id: "agent_1",
        kind: "external_idempotent",
        idempotency_key: "step3b-key",
        epoch: 1,
        payload: { action: "upsert-by-key" },
        retryable: true,
        max_attempts: 3,
      });
      const claimed = claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step3b-after-io-retry", daemonGeneration: 1, nowMs: 1_000 });
      const ledger = JSON.parse(readFileSync(process.env.LEDGER_PATH, "utf8"));
      ledger.idempotentRequests += 1;
      ledger.idempotentByKey[claimed.idempotency_key] = { remoteId: "remote-3b", firstEpoch: claimed.epoch };
      writeFileSync(process.env.LEDGER_PATH, JSON.stringify(ledger), "utf8");
      process.stdout.write("KILLED_AFTER_IO_BEFORE_RECEIPT_RETRY\\n");
      setInterval(() => {}, 60_000);
    `, { DB_PATH: env.dbPath, LEDGER_PATH: ledgerPath, DB_URL: DB_MODULE_URL, EFFECT_URL: EFFECT_MODULE_URL }, "KILLED_AFTER_IO_BEFORE_RECEIPT_RETRY");

    // -------------------------------------------------------------------------
    // STEP 4 & 5: Seed `uncertain`, `completed`, and `failed` rows, then SIGKILL.
    // -------------------------------------------------------------------------
    await spawnAndKillAtMarker(`
      const { DaemonStateDatabase } = await import(process.env.DB_URL);
      const { prepareEffect, claimEffectForExecution, markEffectUncertain, completeEffect, failEffect } = await import(process.env.EFFECT_URL);
      const sdb = await DaemonStateDatabase.open(process.env.DB_PATH);
      prepareEffect(sdb.connection, () => {}, { id: "eff-step4-uncertain", agent_id: "agent_1", kind: "external_mut", idempotency_key: "step4-key", epoch: 1, payload: { s: 4 } });
      claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step4-uncertain", daemonGeneration: 1, nowMs: 1_000 });
      markEffectUncertain(sdb.connection, () => {}, { id: "eff-step4-uncertain", expectedEpoch: 1, expectedAttemptCount: 1, error: "already uncertain" });

      prepareEffect(sdb.connection, () => {}, { id: "eff-step5a-completed", agent_id: "agent_1", kind: "external_mut", idempotency_key: "step5a-key", epoch: 1, payload: { s: "5a" } });
      claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step5a-completed", daemonGeneration: 1, nowMs: 1_000 });
      completeEffect(sdb.connection, () => {}, { id: "eff-step5a-completed", expectedEpoch: 1, expectedAttemptCount: 1, outcome: { done: true } });

      prepareEffect(sdb.connection, () => {}, { id: "eff-step5b-failed", agent_id: "agent_1", kind: "external_mut", idempotency_key: "step5b-key", epoch: 1, payload: { s: "5b" } });
      claimEffectForExecution(sdb.connection, () => {}, { id: "eff-step5b-failed", daemonGeneration: 1, nowMs: 1_000 });
      failEffect(sdb.connection, () => {}, { id: "eff-step5b-failed", expectedEpoch: 1, expectedAttemptCount: 1, error: "authoritative 422" });

      process.stdout.write("KILLED_WITH_TERMINAL_STATES\\n");
      setInterval(() => {}, 60_000);
    `, { DB_PATH: env.dbPath, DB_URL: DB_MODULE_URL, EFFECT_URL: EFFECT_MODULE_URL }, "KILLED_WITH_TERMINAL_STATES");

    // -------------------------------------------------------------------------
    // RESTART ON DAEMON GENERATION 2: recoverOnStartup() + pump + reconcileUncertain
    // -------------------------------------------------------------------------
    // Load external mock ledger into memory once so concurrent effects in pumpNow()
    // update it synchronously without clobbering a shared JSON file on disk.
    const ledger = await readLedger();
    const gen2Db = await DaemonStateDatabase.open(env.dbPath);
    try {
      const executor = new EffectExecutor({
        getDatabase: () => gen2Db.connection,
        currentDaemonGeneration: () => 2,
        assertCurrent: async () => {},
        assertWriteFence: () => {},
        isClosing: () => false,
        nowMs: () => 5_000,
      });

      executor.registerHandler("external_mut", {
        retryable: false,
        execute: async (effect) => {
          ledger.nonIdempotentCalls.push({ key: effect.idempotency_key, epoch: effect.epoch });
          return { status: "completed", outcome: { committedKey: effect.idempotency_key, epoch: effect.epoch } };
        },
        reconcileUncertain: async (effect) => {
          const hit = ledger.nonIdempotentCalls.find((call) => call.key === effect.idempotency_key);
          if (hit) {
            return { status: "completed", outcome: { reconciledKey: hit.key, originalEpoch: hit.epoch } };
          }
          return { status: "failed", error: "Verified absent on external system." };
        },
      });

      executor.registerHandler("external_idempotent", {
        retryable: true,
        execute: async (effect) => {
          ledger.idempotentRequests += 1;
          const existing = ledger.idempotentByKey[effect.idempotency_key];
          if (existing) {
            return { status: "completed", outcome: { remoteId: existing.remoteId, deduplicated: true, firstEpoch: existing.firstEpoch } };
          }
          const created = { remoteId: `remote-${effect.idempotency_key}`, firstEpoch: effect.epoch };
          ledger.idempotentByKey[effect.idempotency_key] = created;
          return { status: "completed", outcome: { remoteId: created.remoteId, deduplicated: false, firstEpoch: created.firstEpoch } };
        },
      });

      const report = await executor.recoverOnStartup();
      // Interrupted retryable rows (step 2b, step 3b) are requeued; non-retryable (step 2a, step 3a) become uncertain.
      assert.deepEqual(report.requeuedIds.sort(), ["eff-step2b-exec-before-retry", "eff-step3b-after-io-retry"]);
      assert.deepEqual(report.uncertainIds.sort(), ["eff-step2a-exec-before-nonretry", "eff-step3a-after-io-nonretry"]);
      assert.ok(report.allUncertainIds.includes("eff-step4-uncertain"));

      await executor.pumpNow();

      // Step 1 (`prepared` at crash): ran once on gen 2 and completed.
      const step1 = getEffect(gen2Db.connection, "eff-step1-prepared")!;
      assert.equal(step1.state, "completed");
      assert.equal(step1.epoch, 2);
      assert.equal(step1.attempt_count, 1);
      assert.deepEqual(step1.outcome, { committedKey: "step1-key", epoch: 2 });

      // Step 2a (`executing` before I/O, non-retryable): marked uncertain, NOT replayed automatically.
      const step2aBeforeReconcile = getEffect(gen2Db.connection, "eff-step2a-exec-before-nonretry")!;
      assert.equal(step2aBeforeReconcile.state, "uncertain");
      assert.equal(ledger.nonIdempotentCalls.filter((c) => c.key === "step2a-key").length, 0);
      // Read-only reconciliation proves absence and settles as failed without executing side effect.
      const step2aAfter = await executor.reconcileUncertain("eff-step2a-exec-before-nonretry");
      assert.equal(step2aAfter.state, "failed");
      assert.equal(ledger.nonIdempotentCalls.filter((c) => c.key === "step2a-key").length, 0);

      // Step 2b (`executing` before I/O, retryable): requeued with same idempotency key, executed once, completed.
      const step2b = getEffect(gen2Db.connection, "eff-step2b-exec-before-retry")!;
      assert.equal(step2b.state, "completed");
      assert.equal(step2b.epoch, 2);
      assert.equal(step2b.attempt_count, 2);
      assert.deepEqual(step2b.outcome, { remoteId: "remote-step2b-key", deduplicated: false, firstEpoch: 2 });

      // Step 3a (`executing` AFTER I/O before receipt, non-retryable): marked uncertain, NEVER replayed!
      const step3aBeforeReconcile = getEffect(gen2Db.connection, "eff-step3a-after-io-nonretry")!;
      assert.equal(step3aBeforeReconcile.state, "uncertain");
      assert.equal(ledger.nonIdempotentCalls.filter((c) => c.key === "step3a-key").length, 1);
      // Read-only reconciliation discovers the gen-1 external commit and settles completed with count STILL 1!
      const step3aAfter = await executor.reconcileUncertain("eff-step3a-after-io-nonretry");
      assert.equal(step3aAfter.state, "completed");
      assert.deepEqual(step3aAfter.outcome, { reconciledKey: "step3a-key", originalEpoch: 1 });
      assert.equal(ledger.nonIdempotentCalls.filter((c) => c.key === "step3a-key").length, 1);

      // Step 3b (`executing` AFTER I/O before receipt, idempotent retryable): retried with EXACT same
      // idempotency key; server deduplicated to the gen-1 commit and settled completed without duplicate effect!
      const step3b = getEffect(gen2Db.connection, "eff-step3b-after-io-retry")!;
      assert.equal(step3b.state, "completed");
      assert.equal(step3b.epoch, 2);
      assert.equal(step3b.attempt_count, 2);
      assert.deepEqual(step3b.outcome, { remoteId: "remote-3b", deduplicated: true, firstEpoch: 1 });
      assert.equal(Object.keys(ledger.idempotentByKey).filter((k) => k === "step3b-key").length, 1);

      // Step 4 (`uncertain` at crash): stayed uncertain across restart until explicitly reconciled.
      assert.equal(getEffect(gen2Db.connection, "eff-step4-uncertain")!.state, "uncertain");

      // Step 5a/5b (`completed` and `failed` at crash): stayed terminal; duplicate prepare returns existing without re-running.
      assert.equal(getEffect(gen2Db.connection, "eff-step5a-completed")!.state, "completed");
      assert.equal(getEffect(gen2Db.connection, "eff-step5b-failed")!.state, "failed");
      const replayCompleted = await executor.prepare({
        agent_id: "agent_1", kind: "external_mut", idempotency_key: "step5a-key", payload: { s: "5a" },
      });
      assert.equal(replayCompleted.created, false);
      assert.equal(replayCompleted.effect.state, "completed");
      assert.equal(ledger.nonIdempotentCalls.filter((c) => c.key === "step5a-key").length, 0);

      await executor.fenceAndDrain();
    } finally {
      gen2Db.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("stale daemon generation is rejected on prepare, claim, settle, retry, resolve, startup recovery, and lost write-fence before receipt", async () => {
  const env = await tempEnv();
  try {
    // Prepare at gen 2.
    const prepared = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "fence_test", idempotency_key: "k-fence", epoch: 2, payload: { v: 1 }, retryable: true, max_attempts: 3,
    }).effect;

    // Stale gen 1 cannot prepare, claim, or fail against epoch 2 rows.
    assert.throws(() => prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "fence_test", idempotency_key: "k-fence", epoch: 1, payload: { v: 1 }, retryable: true, max_attempts: 3,
    }), EffectFenceError);
    assert.throws(() => claimEffectForExecution(env.db, () => {}, {
      id: prepared.id, daemonGeneration: 1, nowMs: 1_000,
    }), EffectFenceError);
    assert.throws(() => failEffect(env.db, () => {}, {
      id: prepared.id, expectedEpoch: 1, error: "stale cancel",
    }), EffectFenceError);

    // Gen 2 claims and completes? First test stale attempt_count / epoch on settlement.
    const claimed = claimEffectForExecution(env.db, () => {}, {
      id: prepared.id, daemonGeneration: 2, nowMs: 1_000,
    });
    assert.equal(claimed.attempt_count, 1);
    assert.throws(() => completeEffect(env.db, () => {}, {
      id: claimed.id, expectedEpoch: 1, expectedAttemptCount: 1, outcome: { stale: true },
    }), EffectFenceError);
    assert.throws(() => completeEffect(env.db, () => {}, {
      id: claimed.id, expectedEpoch: 2, expectedAttemptCount: 2, outcome: { wrongAttempt: true },
    }), EffectFenceError);
    assert.throws(() => rescheduleEffectForRetry(env.db, () => {}, {
      id: claimed.id, expectedEpoch: 1, expectedAttemptCount: 1, nextAttemptAtMs: 2_000, error: "stale",
    }), EffectFenceError);
    assert.throws(() => markEffectUncertain(env.db, () => {}, {
      id: claimed.id, expectedEpoch: 1, expectedAttemptCount: 1, error: "stale",
    }), EffectFenceError);

    // Transition to uncertain at gen 2; stale gen 1 cannot resolve it, gen 3 can.
    markEffectUncertain(env.db, () => {}, { id: claimed.id, expectedEpoch: 2, expectedAttemptCount: 1, error: "ambiguous" });
    assert.throws(() => resolveUncertainEffect(env.db, () => {}, {
      id: claimed.id, daemonGeneration: 1, state: "completed", outcome: { nope: true },
    }), EffectFenceError);
    const resolved = resolveUncertainEffect(env.db, () => {}, {
      id: claimed.id, daemonGeneration: 3, state: "completed", outcome: { verified: true },
    });
    assert.equal(resolved.state, "completed");
    assert.equal(resolved.epoch, 3);

    // Lost singleton write-fence right after external action succeeds leaves row `executing`
    // (never silently dropped or falsely failed), ready for successor startup recovery.
    let fenceLost = false;
    let externalSideEffects = 0;
    const executor = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 3,
      assertCurrent: async () => { if (fenceLost) throw new DaemonFenceLostError("deposed"); },
      assertWriteFence: () => { if (fenceLost) throw new DaemonFenceLostError("deposed"); },
      isClosing: () => false,
      nowMs: () => 10_000,
    });
    executor.registerHandler("fenced_mut", {
      retryable: false,
      execute: async () => {
        externalSideEffects += 1;
        fenceLost = true; // Deposed right after external action succeeded, before receipt write!
        return { status: "completed", outcome: { ok: true } };
      },
    });
    const eff = (await executor.prepare({
      agent_id: "agent_1", kind: "fenced_mut", idempotency_key: "fenced-after-io", payload: { x: 1 }, retryable: false,
    })).effect;
    await assert.rejects(() => executor.runEffect(eff.id), DaemonFenceLostError);
    assert.equal(externalSideEffects, 1);
    assert.equal(getEffect(env.db, eff.id)!.state, "executing", "deposed daemon must leave row untouched for successor");

    // Successor gen 4 runs startup recovery -> marks non-retryable row uncertain (never replays).
    const recovery = recoverInterruptedEffectsOnStartup(env.db, () => {}, { daemonGeneration: 4, nowMs: 11_000 });
    assert.deepEqual(recovery.uncertainIds, [eff.id]);
    assert.equal(getEffect(env.db, eff.id)!.state, "uncertain");
    assert.equal(externalSideEffects, 1);
  } finally {
    await env.cleanup();
  }
});

test("executor owns exponential retry backoff, max_attempts bounds, unexpected-throw safety, and oversized outcome omission", async () => {
  const env = await tempEnv();
  try {
    assert.equal(computeEffectBackoffMs(1, { baseDelayMs: 100, factor: 2, maxDelayMs: 500 }), 100);
    assert.equal(computeEffectBackoffMs(2, { baseDelayMs: 100, factor: 2, maxDelayMs: 500 }), 200);
    assert.equal(computeEffectBackoffMs(3, { baseDelayMs: 100, factor: 2, maxDelayMs: 500 }), 400);
    assert.equal(computeEffectBackoffMs(4, { baseDelayMs: 100, factor: 2, maxDelayMs: 500 }), 500);

    let now = 10_000;
    const seenKeys: string[] = [];
    let attempts = 0;
    const executor = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 1,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => false,
      nowMs: () => now,
      defaultBackoff: { baseDelayMs: 250, maxDelayMs: 2_000, factor: 2 },
    });

    assert.throws(() => executor.registerHandler("bad_policy", {
      retryable: false,
      defaultMaxAttempts: 2,
      execute: async () => ({ status: "completed" }),
    }), EffectValidationError);

    let mutatingThrowsCalls = 0;
    let mutatingRetryBugCalls = 0;
    executor.registerHandler("flaky_idempotent", {
      retryable: true,
      execute: async (effect) => {
        attempts += 1;
        seenKeys.push(effect.idempotency_key);
        if (attempts < 3) return { status: "retry", error: `transient ${attempts}` };
        return { status: "completed", outcome: { attempt: attempts } };
      },
    });
    executor.registerHandler("always_retry", {
      retryable: true,
      execute: async () => ({ status: "retry", error: "still busy", retryAfterMs: 100 }),
    });
    executor.registerHandler("throws_nonretry", {
      retryable: false,
      execute: async () => {
        // Simulates remote mutation succeeding before a dropped transport response throws.
        mutatingThrowsCalls += 1;
        throw new Error("socket reset mid-flight");
      },
      reconcileUncertain: async () => ({
        status: "completed",
        outcome: { huge: "r".repeat(MAX_EFFECT_PAYLOAD_BYTES + 100) },
      }),
    });
    executor.registerHandler("retry_bug_nonretry", {
      retryable: false,
      execute: async () => {
        mutatingRetryBugCalls += 1;
        return { status: "retry", error: "handler mistakenly requested retry" };
      },
    });
    executor.registerHandler("huge_outcome", {
      retryable: false,
      execute: async () => ({ status: "completed", outcome: { huge: "z".repeat(MAX_EFFECT_PAYLOAD_BYTES + 100) } }),
    });

    // Attempting to prepare retryable=true on a non-retryable kind is rejected upfront.
    await assert.rejects(() => executor.prepare({
      agent_id: "agent_1", kind: "throws_nonretry", idempotency_key: "illegal-retry", payload: {}, retryable: true,
    }), EffectValidationError);

    // 1. Retries with exponential backoff (250ms, then 500ms), never running early, same idempotency_key.
    const flaky = (await executor.prepare({
      agent_id: "agent_1", kind: "flaky_idempotent", idempotency_key: "retry-key", payload: { n: 1 }, retryable: true, max_attempts: 4,
    })).effect;
    const afterAttempt1 = await executor.runEffect(flaky.id);
    assert.equal(afterAttempt1.state, "prepared");
    assert.equal(afterAttempt1.attempt_count, 1);
    assert.equal(afterAttempt1.next_attempt_at_ms, 10_250);

    // Before backoff deadline, pumpNow() must NOT claim it.
    now = 10_200;
    await executor.pumpNow();
    assert.equal(attempts, 1);

    // Advance past 1st backoff -> attempt 2 schedules 500ms backoff (10_750).
    now = 10_250;
    await executor.pumpNow();
    assert.equal(attempts, 2);
    assert.equal(getEffect(env.db, flaky.id)!.next_attempt_at_ms, 10_750);

    // Advance past 2nd backoff -> attempt 3 completes with identical idempotency key.
    now = 10_750;
    await executor.pumpNow();
    const done = getEffect(env.db, flaky.id)!;
    assert.equal(done.state, "completed");
    assert.equal(done.attempt_count, 3);
    assert.deepEqual(done.outcome, { attempt: 3 });
    assert.deepEqual(seenKeys, ["retry-key", "retry-key", "retry-key"]);

    // 2. Exhausting max_attempts on explicit retry settles as failed (never infinite loop).
    const capped = (await executor.prepare({
      agent_id: "agent_1", kind: "always_retry", idempotency_key: "cap-key", payload: {}, retryable: true, max_attempts: 2,
    })).effect;
    await executor.runEffect(capped.id);
    assert.equal(getEffect(env.db, capped.id)!.state, "prepared");
    now += 100;
    const exhausted = await executor.runEffect(capped.id);
    assert.equal(exhausted.state, "failed");
    assert.equal(exhausted.attempt_count, 2);

    // 3. Unexpected throw after external mutation on non-retryable kind settles as uncertain
    //    (NEVER failed, NEVER replayed by pumpNow or recovery).
    const boom = (await executor.prepare({
      agent_id: "agent_1", kind: "throws_nonretry", idempotency_key: "boom-key", payload: {},
    })).effect;
    assert.equal(boom.retryable, false);
    assert.equal(boom.max_attempts, 1);
    const uncertain = await executor.runEffect(boom.id);
    assert.equal(uncertain.state, "uncertain");
    assert.match(uncertain.last_error ?? "", /socket reset mid-flight/);
    await executor.pumpNow();
    assert.equal(mutatingThrowsCalls, 1, "at-most-once kind must never replay after transport throw");
    // Reconciling with an oversized outcome still records completion via omission marker.
    const reconciledOversize = await executor.reconcileUncertain(boom.id);
    assert.equal(reconciledOversize.state, "completed");
    assert.equal((reconciledOversize.outcome as { effect_outcome_omitted?: boolean }).effect_outcome_omitted, true);

    // 3b. Even if a non-retryable handler erroneously returns `{ status: "retry" }`,
    //     executor preserves at-most-once by marking it `uncertain` with zero replays.
    const retryBug = (await executor.prepare({
      agent_id: "agent_1", kind: "retry_bug_nonretry", idempotency_key: "retry-bug-key", payload: {},
    })).effect;
    const retryBugSettled = await executor.runEffect(retryBug.id);
    assert.equal(retryBugSettled.state, "uncertain");
    await executor.pumpNow();
    assert.equal(mutatingRetryBugCalls, 1);

    // 4. Real external success with oversized outcome stores bounded omission marker instead of failing.
    const huge = (await executor.prepare({
      agent_id: "agent_1", kind: "huge_outcome", idempotency_key: "huge-key", payload: {}, retryable: false,
    })).effect;
    const hugeDone = await executor.runEffect(huge.id);
    assert.equal(hugeDone.state, "completed");
    assert.equal((hugeDone.outcome as { effect_outcome_omitted?: boolean }).effect_outcome_omitted, true);

    assert.equal(listEffectsForAgent(env.db, "agent_1", { states: ["completed"] }).length, 3);
    await executor.fenceAndDrain();
  } finally {
    await env.cleanup();
  }
});

test("executor fence and drain waits for admitted external executions to save receipts and rejects new work", async () => {
  const env = await tempEnv();
  try {
    let releaseExternal!: () => void;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const externalGate = new Promise<void>((resolve) => { releaseExternal = resolve; });

    const executor = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 1,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => false,
      nowMs: () => 50_000,
    });
    let observedAbort = false;
    executor.registerHandler("slow_external", {
      retryable: false,
      execute: async (_effect, ctx) => {
        ctx.signal.addEventListener("abort", () => { observedAbort = true; });
        startedResolve();
        await externalGate;
        return { status: "completed", outcome: { drained: true } };
      },
    });

    const prepared = (await executor.enqueue({
      agent_id: "agent_1", kind: "slow_external", idempotency_key: "drain-1", payload: { slow: true },
    })).effect;
    await started;

    // Begin fenceAndDrain while the admitted external execution is in flight.
    let drainFinished = false;
    const drainPromise = executor.fenceAndDrain().then(() => { drainFinished = true; });
    assert.equal(executor.isFenced, true);
    assert.equal(observedAbort, true, "fence() must synchronously abort the executor cancellation signal");

    // New work is refused immediately once fenced.
    await assert.rejects(() => executor.prepare({
      agent_id: "agent_1", kind: "slow_external", idempotency_key: "after-fence", payload: {},
    }), EffectFenceError);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(drainFinished, false, "fenceAndDrain must wait for admitted external execution");

    releaseExternal();
    await drainPromise;
    assert.equal(drainFinished, true);

    const saved = getEffect(env.db, prepared.id)!;
    assert.equal(saved.state, "completed", "admitted execution finishing during drain must commit its receipt");
    assert.deepEqual(saved.outcome, { drained: true });
  } finally {
    await env.cleanup();
  }
});

test("SupervisorDaemon startup runs EffectExecutor recovery pass for interrupted effect_journal rows", async () => {
  const env = await tempEnv("letagents-daemon-effect-recovery-");
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: env.dbPath,
    auditPath: join(env.root, "audit.log"),
    attemptsPath: join(env.root, "attempts.sqlite"),
    attemptsRoot: join(env.root, "attempts"),
    workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "bindings.sqlite"),
  };
  let daemon: SupervisorDaemon | null = null;
  try {
    // Seed one non-retryable and one retryable effect stuck in `executing` from a crashed daemon.
    const nonRetry = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "unregistered_mut", idempotency_key: "k-nr", epoch: 1, payload: { a: 1 }, retryable: false,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: nonRetry.id, daemonGeneration: 1, nowMs: 1_000 });

    const retry = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "unregistered_retry", idempotency_key: "k-r", epoch: 1, payload: { a: 2 }, retryable: true, max_attempts: 3,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: retry.id, daemonGeneration: 1, nowMs: 1_000 });
    env.stateDb.close();

    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    await daemon.stop();
    daemon = null;

    const inspect = new DatabaseSync(env.dbPath, { readOnly: true });
    try {
      assert.equal(getEffect(inspect, nonRetry.id)!.state, "uncertain");
      assert.equal(getEffect(inspect, retry.id)!.state, "prepared");
    } finally {
      inspect.close();
    }
  } finally {
    await daemon?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pump does not starve pending authority I/O, fences on lost authority, and backs off persistent pre-claim errors", async () => {
  // 1. Bounded child-process regression for ReviewAstra P1: direct runEffect() awaiting
  //    async assertCurrent() while a concurrent pumpNow() runs must never starve the
  //    event loop; heartbeat must fire and handler must execute exactly once.
  const probeScript = `
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    const { applySchemaCurrent } = await import(process.env.SCHEMA_URL);
    const { EffectExecutor } = await import(process.env.EFFECT_URL);

    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applySchemaCurrent(db);

    let calls = 0;
    let heartbeatFired = false;
    const heartbeat = new Promise((resolve) => {
      setTimeout(() => { heartbeatFired = true; resolve(); }, 30);
    });

    const executor = new EffectExecutor({
      getDatabase: () => db,
      currentDaemonGeneration: () => 1,
      assertCurrent: () => new Promise((resolve) => setTimeout(resolve, 20)),
      assertWriteFence: () => {},
      isClosing: () => false,
    });
    executor.registerHandler("at_most_once", {
      retryable: false,
      execute: async () => {
        calls += 1;
        return { status: "completed", outcome: { ok: true } };
      },
    });
    const { effect } = await executor.prepare({
      agent_id: "agent_1",
      kind: "at_most_once",
      idempotency_key: "starve-check",
      payload: { x: 1 },
    });
    const direct = executor.runEffect(effect.id);
    const competingPump = executor.pumpNow();
    const [settled] = await Promise.all([direct, competingPump, heartbeat]);
    assert.equal(settled.state, "completed");
    assert.equal(calls, 1);
    assert.equal(heartbeatFired, true);
    await executor.fenceAndDrain();
    db.close();
    process.stdout.write("PROBE_OK\\n");
  `;
  const schemaModuleUrl = pathToFileURL(join(THIS_DIR, "../daemon-state-database/schema.ts")).href;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=letagents-source", "--import", "tsx", "--input-type=module", "-e", probeScript],
      {
        env: { ...process.env, SCHEMA_URL: schemaModuleUrl, EFFECT_URL: EFFECT_MODULE_URL },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Event loop starved in child probe (killed by watchdog): ${stderr}`));
    }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(watchdog);
      if (code === 0 && stdout.includes("PROBE_OK")) resolve();
      else reject(new Error(`Child probe failed (code=${code}, signal=${signal}): stdout=${stdout} stderr=${stderr}`));
    });
  });

  // 2. Pre-claim DaemonFenceLostError fences the executor immediately with zero retries.
  const env = await tempEnv("letagents-pump-backoff-");
  try {
    let deposed = false;
    let authCalls = 0;
    const fencedExecutor = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 1,
      assertCurrent: async () => {
        authCalls += 1;
        if (deposed) throw new DaemonFenceLostError("deposed before claim");
      },
      assertWriteFence: () => {},
      isClosing: () => false,
    });
    let handlerCalls = 0;
    fencedExecutor.registerHandler("fence_pre_claim", {
      retryable: false,
      execute: async () => { handlerCalls += 1; return { status: "completed" }; },
    });
    const prep1 = (await fencedExecutor.prepare({
      agent_id: "agent_1", kind: "fence_pre_claim", idempotency_key: "k-deposed", payload: {},
    })).effect;
    deposed = true;
    authCalls = 0;
    await fencedExecutor.pumpNow();
    assert.equal(fencedExecutor.isFenced, true, "lost singleton authority must fence executor permanently");
    assert.equal(authCalls, 1);
    assert.equal(handlerCalls, 0);
    assert.equal(getEffect(env.db, prep1.id)!.state, "prepared");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(authCalls, 1, "fenced executor must not reschedule any pump after DaemonFenceLostError");

    // 3. Persistent non-fence pre-claim error backs off on a timer and never starves timers.
    let claimChecks = 0;
    let failClaim = false;
    const backoffExecutor = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 1,
      assertCurrent: async () => {
        if (failClaim) {
          claimChecks += 1;
          throw new Error("transient pre-claim I/O failure");
        }
      },
      assertWriteFence: () => {},
      isClosing: () => false,
      defaultBackoff: { baseDelayMs: 40, maxDelayMs: 200, factor: 2 },
    });
    backoffExecutor.registerHandler("claim_err", {
      retryable: false,
      execute: async () => ({ status: "completed" }),
    });
    await backoffExecutor.prepare({
      agent_id: "agent_1", kind: "claim_err", idempotency_key: "k-claim-err", payload: {},
    });
    failClaim = true;
    const timerFiredAt = await new Promise<number>((resolve) => {
      const start = Date.now();
      void backoffExecutor.pumpNow();
      setTimeout(() => resolve(Date.now() - start), 25);
    });
    assert.ok(timerFiredAt < 250, `25ms timer must not be starved by pre-claim pump errors (took ${timerFiredAt}ms)`);
    assert.ok(claimChecks >= 1 && claimChecks <= 3, `pre-claim errors must back off instead of spinning (got ${claimChecks} checks)`);
    await backoffExecutor.fenceAndDrain();
  } finally {
    await env.cleanup();
  }
});

test("current handler retryable=false policy quarantines already-attempted retries in both registration orders with zero second calls", async () => {
  const env = await tempEnv("letagents-policy-tighten-");
  try {
    // Sequence A: old gen left retryable=true row in `executing` after external commit;
    // new gen runs recoverOnStartup() BEFORE registering the now non-retryable handler,
    // then registers handler and invokes runEffect() / pumpNow().
    let externalCallsA = 0;
    const effA = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "tightened_a", idempotency_key: "k-a", epoch: 1,
      payload: { seq: "A" }, retryable: true, max_attempts: 3,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: effA.id, daemonGeneration: 1, nowMs: 1_000 });
    externalCallsA += 1; // External action committed before gen-1 crash.

    const execA = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 2,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => false,
      nowMs: () => 5_000,
    });
    const recA = await execA.recoverOnStartup();
    assert.ok(recA.requeuedIds.includes(effA.id), "unregistered retryable row was requeued before handler registration");
    assert.equal(getEffect(env.db, effA.id)!.state, "prepared");
    assert.equal(getEffect(env.db, effA.id)!.attempt_count, 1);

    execA.registerHandler("tightened_a", {
      retryable: false,
      execute: async () => {
        externalCallsA += 1;
        return { status: "completed" };
      },
    });
    const quarantinedA = await execA.runEffect(effA.id);
    assert.equal(quarantinedA.state, "uncertain");
    assert.equal(quarantinedA.attempt_count, 1);
    await execA.pumpNow();
    assert.equal(externalCallsA, 1, "handler registered after recovery must never replay an already-attempted row");
    await execA.fenceAndDrain();

    // Sequence B: old gen already rescheduled a retryable=true row back to `prepared`
    // (`attempt_count=1`) after a lost response; new gen registers retryable=false
    // BEFORE recoverOnStartup(). Startup recovery must quarantine it to `uncertain` immediately.
    let externalCallsB = 0;
    const effB = prepareEffect(env.db, () => {}, {
      agent_id: "agent_1", kind: "tightened_b", idempotency_key: "k-b", epoch: 1,
      payload: { seq: "B" }, retryable: true, max_attempts: 3,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: effB.id, daemonGeneration: 1, nowMs: 1_000 });
    externalCallsB += 1; // External action committed before lost response.
    rescheduleEffectForRetry(env.db, () => {}, {
      id: effB.id, expectedEpoch: 1, expectedAttemptCount: 1, nextAttemptAtMs: 2_000, error: "lost response",
    });
    assert.equal(getEffect(env.db, effB.id)!.state, "prepared");

    const execB = new EffectExecutor({
      getDatabase: () => env.db,
      currentDaemonGeneration: () => 2,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => false,
      nowMs: () => 5_000,
    });
    execB.registerHandler("tightened_b", {
      retryable: false,
      execute: async () => {
        externalCallsB += 1;
        return { status: "completed" };
      },
    });
    const recB = await execB.recoverOnStartup();
    assert.ok(recB.uncertainIds.includes(effB.id));
    assert.equal(recB.preparedIds.includes(effB.id), false);
    assert.equal(getEffect(env.db, effB.id)!.state, "uncertain");
    assert.equal(getEffect(env.db, effB.id)!.attempt_count, 1);
    await execB.pumpNow();
    assert.equal(externalCallsB, 1, "handler registered before recovery must quarantine existing prepared retries with zero extra calls");
    await execB.fenceAndDrain();
  } finally {
    await env.cleanup();
  }
});

test("startup recovery fences higher-epoch rows fail-closed without bricking SupervisorDaemon startup, and agent removal purges effect_journal rows", async () => {
  const env = await tempEnv("letagents-future-epoch-and-purge-");
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: env.dbPath,
    auditPath: join(env.root, "audit.log"),
    attemptsPath: join(env.root, "attempts.sqlite"),
    attemptsRoot: join(env.root, "attempts"),
    workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "bindings.sqlite"),
  };
  let daemon: SupervisorDaemon | null = null;
  try {
    // Seed rows at epoch 7 (simulating a deleted/reset generation file where next start is generation 1).
    const futurePreparedFresh = prepareEffect(env.db, () => {}, {
      agent_id: "agent_future", kind: "k", idempotency_key: "f-prep-0", epoch: 7, payload: { n: 1 }, retryable: true, max_attempts: 3,
    }).effect;
    const futurePreparedRetry = prepareEffect(env.db, () => {}, {
      agent_id: "agent_future", kind: "k", idempotency_key: "f-prep-1", epoch: 7, payload: { n: 2 }, retryable: true, max_attempts: 3,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: futurePreparedRetry.id, daemonGeneration: 7, nowMs: 1_000 });
    rescheduleEffectForRetry(env.db, () => {}, {
      id: futurePreparedRetry.id, expectedEpoch: 7, expectedAttemptCount: 1, nextAttemptAtMs: 2_000, error: "transient",
    });
    const futureExecuting = prepareEffect(env.db, () => {}, {
      agent_id: "agent_future", kind: "k", idempotency_key: "f-exec", epoch: 7, payload: { n: 3 }, retryable: true, max_attempts: 3,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: futureExecuting.id, daemonGeneration: 7, nowMs: 1_000 });
    const futureUncertain = prepareEffect(env.db, () => {}, {
      agent_id: "agent_keep", kind: "k", idempotency_key: "f-unc", epoch: 7, payload: { n: 4 }, retryable: false,
    }).effect;
    claimEffectForExecution(env.db, () => {}, { id: futureUncertain.id, daemonGeneration: 7, nowMs: 1_000 });
    markEffectUncertain(env.db, () => {}, { id: futureUncertain.id, expectedEpoch: 7, expectedAttemptCount: 1, error: "prior" });
    env.stateDb.close();

    // Real SupervisorDaemon starts cleanly at generation 1 without throwing on epoch-7 rows.
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    await daemon.stop();
    daemon = null;

    const inspect = await DaemonStateDatabase.open(env.dbPath);
    try {
      const p0 = getEffect(inspect.connection, futurePreparedFresh.id)!;
      const p1 = getEffect(inspect.connection, futurePreparedRetry.id)!;
      const ex = getEffect(inspect.connection, futureExecuting.id)!;
      const un = getEffect(inspect.connection, futureUncertain.id)!;
      assert.equal(p0.state, "failed", "unattempted future-epoch row fails closed before dispatch");
      assert.equal(p0.epoch, 7);
      assert.equal(p1.state, "uncertain", "attempted future-epoch retry becomes uncertain without replay");
      assert.equal(p1.epoch, 7);
      assert.equal(ex.state, "uncertain", "executing future-epoch row becomes uncertain without replay");
      assert.equal(ex.epoch, 7);
      assert.equal(un.state, "uncertain");
      assert.equal(un.epoch, 7);

      // Removing agent_future via SupervisedAgentInboxStore.removeAgent purges its effect_journal rows
      // while leaving agent_keep intact.
      const inbox = new SupervisedAgentInboxStore(env.dbPath, { sharedDatabase: inspect });
      await inbox.removeAgent("agent_future");
      assert.equal(listEffectsForAgent(inspect.connection, "agent_future").length, 0);
      assert.equal(listEffectsForAgent(inspect.connection, "agent_keep").length, 1);
    } finally {
      inspect.close();
    }
  } finally {
    await daemon?.stop().catch(() => undefined);
    await env.cleanup();
  }
});
