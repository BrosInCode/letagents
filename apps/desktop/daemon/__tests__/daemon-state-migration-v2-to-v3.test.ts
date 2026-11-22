/**
 * Schema v2 -> v3 migration, direct v1 -> v3 jump, consecutive v1 -> v2 -> v3
 * upgrade, post-DROP/pre-RENAME rollback, and downgrade-refusal tests.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DAEMON_STATE_APPLICATION_ID,
  DAEMON_STATE_MIGRATIONS,
  DAEMON_STATE_SCHEMA_VERSION,
  DAEMON_STATE_USER_VERSION,
  DaemonStateDatabase,
  applySchemaV1,
  migrateV2ToV3,
  moveAsideLegacyDaemonStateDatabase,
  runNumberedMigrations,
  toSqliteUserVersion,
  validateDaemonStateShape,
} from "../daemon-state-database.js";
import { normalizeSchemaSql } from "../daemon-state-database/shared.js";
import {
  BOUNDED_MCP_EFFECT_KIND,
  BOUNDED_MCP_MAX_READ_ATTEMPTS,
  getEffect,
  rowToBoundedMcpEffect,
} from "../effect-journal/index.js";
import { SupervisorDaemon } from "../main.js";
import { cloneStateDatabaseForCompaction, prepareStateRecoveryBackup } from "../state-recovery-backup.js";
import { withProtectedStateUpgrade } from "../state-recovery-key.js";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { testDaemonEndpoint } from "./helpers/daemon-fixture.js";

async function tempDir(prefix: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  if (process.platform === "win32") await protectOwnerPrivate(root, "directory", { force: true });
  return { root, cleanup: () => removeTestDirectory(root) };
}

function normalizedSchemaEntries(database: DatabaseSync): Array<{ type: string; name: string; tblName: string; sql: string }> {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tblName: String(row.tbl_name),
    sql: normalizeSchemaSql(String(row.sql)),
  }));
}

function schemaFingerprint(database: DatabaseSync): string {
  return createHash("sha256").update(JSON.stringify(normalizedSchemaEntries(database))).digest("hex");
}

function seedPopulatedV2Database(dbPath: string): {
  legacyIds: Record<string, string>;
  existingJournalId: string;
  tombstoneId: string;
} {
  const now = "2026-11-22T00:30:00.000Z";
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    db.exec("BEGIN IMMEDIATE");
    applySchemaV1(db);
    runNumberedMigrations(db, 1, 2);
    db.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${toSqliteUserVersion(2)}`);

    db.prepare(`
      INSERT INTO agents (
        agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
        charter, config_revision, runtime_configuration_revision, desired_state, observed_state,
        condition, last_turn_control_sequence
      ) VALUES ('agent_v2', 0, 3, 'owner', ?, 'V2 Agent', 'room_alpha', 'codex', 'Assist', 1, 1, 'stopped', 'stopped', 'none', 0)
    `).run(now);

    const legacyIds = {
      preparedOrdinary: "eff_legacy_prepared_ordinary",
      preparedJoinRoom: "eff_legacy_prepared_join_room",
      executingRead: "eff_legacy_executing_read",
      executingMutation: "eff_legacy_executing_mutation",
      executingCompletion: "eff_legacy_executing_completion",
      uncertainMutation: "eff_legacy_uncertain_mutation",
      completedMutation: "eff_legacy_completed_mutation",
      failedMutation: "eff_legacy_failed_mutation",
    };

    const insertLegacy = db.prepare(`
      INSERT INTO effects (
        effect_id, agent_id, room_id, execution_generation_id, provider_turn_id, mcp_request_id,
        tool_name, request_json, mutation, state, result_json, error, created_at, updated_at
      ) VALUES (?, 'agent_v2', 'room_alpha', 'gen_1', 'turn_1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertLegacy.run(legacyIds.preparedOrdinary, "req_1", "send_message", JSON.stringify({ text: "prepared" }), 1, "prepared", null, null, now, now);
    // Legacy join_room row intentionally carries non-null result_json while state='prepared'.
    insertLegacy.run(
      legacyIds.preparedJoinRoom,
      "req_2",
      "join_room",
      JSON.stringify({ name: "room_beta" }),
      1,
      "prepared",
      JSON.stringify({ destination_room: "room_beta", phase: "prepared", room_move_operation_id: `room_move:${legacyIds.preparedJoinRoom}` }),
      null,
      now,
      now,
    );
    insertLegacy.run(legacyIds.executingRead, "req_3", "get_board", JSON.stringify({}), 0, "executing", null, null, now, now);
    insertLegacy.run(legacyIds.executingMutation, "req_4", "send_message", JSON.stringify({ text: "in-flight" }), 1, "executing", null, null, now, now);
    insertLegacy.run(legacyIds.executingCompletion, "req_5", "complete_room_turn", JSON.stringify({ outcome: "reply", text: "done" }), 1, "executing", null, null, now, now);
    insertLegacy.run(legacyIds.uncertainMutation, "req_6", "post_status", JSON.stringify({ status: "working" }), 1, "uncertain", null, "network timeout", now, now);
    insertLegacy.run(legacyIds.completedMutation, "req_7", "send_message", JSON.stringify({ text: "sent" }), 1, "completed", JSON.stringify({ id: "msg_9" }), null, now, now);
    insertLegacy.run(legacyIds.failedMutation, "req_8", "claim_task", JSON.stringify({ task_id: "t1" }), 1, "failed", null, "HTTP 409 conflict", now, now);

    const existingJournalId = "ej_existing_v2_row";
    db.prepare(`
      INSERT INTO effect_journal (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES (?, 'agent_v2', 'probe_external', 'probe-k-1', 2, 'completed', '{"k":1}', '{"ok":true}', 1, 1, 3, NULL, NULL, ?, ?)
    `).run(existingJournalId, now, now);

    const tombstoneId = "eff_legacy_tombstone_1";
    db.prepare(`
      INSERT INTO effect_tombstones (
        effect_id, agent_id, room_id, execution_generation_id, provider_turn_id, mcp_request_id,
        tool_name, request_sha256, request_bytes, mutation, state, result_json, error, created_at, updated_at
      ) VALUES (?, 'agent_v2', 'room_alpha', 'gen_1', 'turn_0', 'req_0', 'send_message', ?, 14, 1, 'uncertain', NULL, 'compacted', ?, ?)
    `).run(tombstoneId, "b".repeat(64), now, now);

    db.exec("COMMIT");
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(2));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='effect_journal'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_state_versions_effect_journal_inbox_insert'").get());
    return { legacyIds, existingJournalId, tombstoneId };
  } finally {
    db.close();
  }
}

test("populated v2 fixture migrates every legacy effects state cleanly to v3, drops effect_journal, matches fresh v3 1:1, and compacts cleanly", async () => {
  const env = await tempDir("letagents-migrate-v2-v3-");
  const v2Path = join(env.root, "v2.sqlite");
  const freshPath = join(env.root, "fresh-v3.sqlite");
  const key = randomBytes(32);

  try {
    const seeded = seedPopulatedV2Database(v2Path);

    await withProtectedStateUpgrade(
      v2Path,
      async (stateDb) => {
        assert.equal(Number(stateDb.connection.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(3));
        validateDaemonStateShape(stateDb.connection);
      },
      {
        getBackupKey: async () => ({ key: Buffer.from(key), sealedKey: "sealed-v2-to-v3" }),
      },
    );

    const freshDb = await DaemonStateDatabase.open(freshPath);
    const upgradedDb = await DaemonStateDatabase.open(v2Path);
    try {
      assert.deepEqual(
        normalizedSchemaEntries(upgradedDb.connection),
        normalizedSchemaEntries(freshDb.connection),
        "upgraded v2 -> v3 sqlite_master must be 1:1 identical to fresh v3",
      );
      assert.equal(schemaFingerprint(upgradedDb.connection), schemaFingerprint(freshDb.connection));

      const db = upgradedDb.connection;
      // Zero leftover staging effect_journal table, indexes, or triggers.
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%effect_journal%'").get(),
        undefined,
        "no effect_journal table, index, or trigger may remain after v2 -> v3 cutover",
      );
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='effects_bounded_mcp_turn'").get());
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='effects_immutable_identity'").get());
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_state_versions_effects_inbox_insert'").get());

      // Verify pre-existing v2 effect_journal row survived with exact id and payload.
      const preservedJournal = getEffect(db, seeded.existingJournalId)!;
      assert.equal(preservedJournal.kind, "probe_external");
      assert.equal(preservedJournal.state, "completed");
      assert.deepEqual(preservedJournal.outcome, { ok: true });

      // Verify every single legacy effects row migrated with exact id, kind, retry policy, outcome, and error.
      const readRaw = (id: string) => db.prepare("SELECT * FROM effects WHERE id=?").get(id) as Record<string, unknown>;

      const preparedOrdinary = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.preparedOrdinary!));
      assert.equal(preparedOrdinary.state, "prepared");
      assert.equal(preparedOrdinary.tool_name, "send_message");
      assert.equal(preparedOrdinary.attempt_count, 0);
      assert.equal(preparedOrdinary.max_attempts, 1);
      assert.equal(preparedOrdinary.result, null);

      const preparedJoin = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.preparedJoinRoom!));
      assert.equal(preparedJoin.state, "prepared");
      assert.equal(preparedJoin.tool_name, "join_room");
      assert.equal(preparedJoin.attempt_count, 0);
      assert.equal(preparedJoin.result, null, "legacy prepared join_room result_json is cleared to satisfy CHECK (state='prepared' AND outcome IS NULL)");

      const executingRead = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.executingRead!));
      assert.equal(executingRead.state, "executing");
      assert.equal(executingRead.mutation, false);
      assert.equal(executingRead.attempt_count, 1);
      assert.equal(executingRead.max_attempts, BOUNDED_MCP_MAX_READ_ATTEMPTS);
      assert.equal(Number(readRaw(seeded.legacyIds.executingRead!).retryable), 1);

      const executingMutation = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.executingMutation!));
      assert.equal(executingMutation.state, "executing");
      assert.equal(executingMutation.mutation, true);
      assert.equal(executingMutation.attempt_count, 1);
      assert.equal(executingMutation.max_attempts, 1);
      assert.equal(Number(readRaw(seeded.legacyIds.executingMutation!).retryable), 0);

      const executingCompletion = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.executingCompletion!));
      assert.equal(executingCompletion.state, "executing");
      assert.equal(executingCompletion.tool_name, "complete_room_turn");
      assert.equal(Number(readRaw(seeded.legacyIds.executingCompletion!).retryable), 1, "legacy executing complete_room_turn remains safely recoverable");
      assert.equal(executingCompletion.max_attempts, BOUNDED_MCP_MAX_READ_ATTEMPTS);

      const uncertain = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.uncertainMutation!));
      assert.equal(uncertain.state, "uncertain");
      assert.equal(uncertain.error, "network timeout");

      const completed = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.completedMutation!));
      assert.equal(completed.state, "completed");
      assert.deepEqual(completed.result, { id: "msg_9" });
      assert.equal(completed.error, null);

      const failed = rowToBoundedMcpEffect(readRaw(seeded.legacyIds.failedMutation!));
      assert.equal(failed.state, "failed");
      assert.equal(failed.error, "HTTP 409 conflict");

      assert.equal(
        Number((db.prepare("SELECT COUNT(*) AS n FROM effects WHERE kind=?").get(BOUNDED_MCP_EFFECT_KIND) as { n: number }).n),
        Object.keys(seeded.legacyIds).length,
      );
      assert.equal(
        Number((db.prepare("SELECT COUNT(*) AS n FROM effect_tombstones WHERE effect_id=?").get(seeded.tombstoneId) as { n: number }).n),
        1,
      );

      // Verify compaction clone works cleanly on migrated v3 DB.
      const cloned = cloneStateDatabaseForCompaction(db);
      try {
        validateDaemonStateShape(cloned);
        assert.equal(
          Number((cloned.prepare("SELECT COUNT(*) AS n FROM effects").get() as { n: number }).n),
          Object.keys(seeded.legacyIds).length + 1,
        );
      } finally {
        cloned.close();
      }
    } finally {
      freshDb.close();
      upgradedDb.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("consecutive v1 -> v2 -> v3 upgrade replaces encrypted recovery backup cleanly and direct v1 -> v3 SupervisorDaemon.start succeeds", async () => {
  const env = await tempDir("letagents-migrate-v1-v2-v3-");
  const consecutivePath = join(env.root, "consecutive.sqlite");
  const directPath = join(env.root, "direct.sqlite");
  const key = randomBytes(32);

  try {
    // 1. Seed a clean v1 database, upgrade v1 -> v2 (backup #1), then upgrade v2 -> v3 (backup #2).
    const seedV1 = (path: string) => {
      const db = new DatabaseSync(path);
      try {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
        db.exec("BEGIN IMMEDIATE");
        applySchemaV1(db);
        db.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
        db.exec(`PRAGMA user_version = ${toSqliteUserVersion(1)}`);
        db.prepare(`
          INSERT INTO agents (
            agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
            charter, config_revision, runtime_configuration_revision, desired_state, observed_state,
            condition, last_turn_control_sequence
          ) VALUES ('agent_seq', 0, 1, 'owner', '2026-11-22T00:00:00.000Z', 'Seq', 'room_1', 'codex', 'c', 1, 1, 'stopped', 'stopped', 'none', 0)
        `).run();
        db.prepare(`
          INSERT INTO effects (
            effect_id, agent_id, room_id, execution_generation_id, provider_turn_id, mcp_request_id,
            tool_name, request_json, mutation, state, result_json, error, created_at, updated_at
          ) VALUES ('eff_v1_jump', 'agent_seq', 'room_1', 'gen_1', 'turn_1', 'req_1', 'send_message', '{"text":"hi"}', 1, 'executing', NULL, NULL, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z')
        `).run();
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    };

    seedV1(consecutivePath);
    // Simulate step 1 (.11 taking encrypted backup #1 and upgrading v1 -> v2).
    await prepareStateRecoveryBackup(consecutivePath, toSqliteUserVersion(2), async () => ({
      key: Buffer.from(key),
      sealedKey: "sealed-step-1",
    }));
    const v2Conn = new DatabaseSync(consecutivePath);
    try {
      v2Conn.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      v2Conn.exec("BEGIN IMMEDIATE");
      runNumberedMigrations(v2Conn, 1, 2);
      v2Conn.exec("COMMIT");
    } finally {
      v2Conn.close();
    }

    // Step 2 (.13 replacing existing .recovery.enc atomically and upgrading v2 -> v3).
    await withProtectedStateUpgrade(
      consecutivePath,
      async (stateDb) => {
        assert.equal(Number(stateDb.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
        validateDaemonStateShape(stateDb.connection);
        const migrated = rowToBoundedMcpEffect(
          stateDb.connection.prepare("SELECT * FROM effects WHERE id='eff_v1_jump'").get() as Record<string, unknown>,
        );
        assert.equal(migrated.state, "executing");
        assert.equal(migrated.tool_name, "send_message");
      },
      {
        getBackupKey: async () => ({ key: Buffer.from(key), sealedKey: "sealed-step-2" }),
      },
    );

    const files = await readdir(env.root);
    assert.equal(files.some((name) => name.endsWith(".pending")), false, "no leftover .pending backup candidate after consecutive upgrade");
    assert.equal(files.includes("consecutive.sqlite.recovery.enc"), true, "replaced encrypted recovery snapshot exists");

    // 2. Direct v1 -> v3 jump through SupervisorDaemon.start() (also runs EffectExecutor recovery on migrated executing mutation).
    seedV1(directPath);
    const paths = {
      lockPath: join(env.root, "daemon.lock"),
      ...testDaemonEndpoint(env.root),
      manifestPath: directPath,
      auditPath: join(env.root, "audit.log"),
      attemptsPath: join(env.root, "attempts.sqlite"),
      attemptsRoot: join(env.root, "attempts"),
      workspaceRoot: env.root,
      workerBindingsPath: join(env.root, "bindings.sqlite"),
    };
    const daemon = new SupervisorDaemon(paths, "darwin");
    try {
      await daemon.start({
        getBackupKey: async () => ({ key: Buffer.from(key), sealedKey: "sealed-direct-v1-v3" }),
      });
    } finally {
      await daemon.stop().catch(() => undefined);
    }
    const inspect = new DatabaseSync(directPath, { readOnly: true });
    try {
      assert.equal(Number(inspect.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(inspect);
      const recovered = getEffect(inspect, "eff_v1_jump")!;
      assert.equal(recovered.kind, BOUNDED_MCP_EFFECT_KIND);
      assert.equal(recovered.state, "uncertain", "SupervisorDaemon startup recovery transitions migrated executing mutation to uncertain");
    } finally {
      inspect.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("v2 -> v3 rollback after DROP TABLE effects and before ALTER TABLE effect_journal RENAME TO effects leaves DB cleanly at v2", async () => {
  const env = await tempDir("letagents-migrate-v2-v3-rollback-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    const seeded = seedPopulatedV2Database(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      assert.throws(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          runNumberedMigrations(db, 2, 3, {
            ...DAEMON_STATE_MIGRATIONS,
            2(connection) {
              migrateV2ToV3(connection, {
                afterDropLegacyEffects() {
                  throw new Error("injected post-DROP pre-RENAME failure");
                },
              });
            },
          });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }, /injected post-DROP pre-RENAME failure/);

      // Database must remain cleanly at v2 (user_version 1002) with legacy `effects` and `effect_journal` completely intact.
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(2));
      assert.equal(db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check, "ok");
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='effect_journal'").get());
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='effects'").get());
      assert.equal(
        Number((db.prepare("SELECT COUNT(*) AS n FROM effects").get() as { n: number }).n),
        Object.keys(seeded.legacyIds).length,
      );
      assert.equal(
        Number((db.prepare("SELECT COUNT(*) AS n FROM effect_journal").get() as { n: number }).n),
        1,
      );
      const legacyJoin = db.prepare("SELECT effect_id, state, result_json FROM effects WHERE effect_id=?")
        .get(seeded.legacyIds.preparedJoinRoom!) as Record<string, unknown>;
      assert.equal(legacyJoin.state, "prepared");
      assert.ok(typeof legacyJoin.result_json === "string" && legacyJoin.result_json.includes("room_move_operation_id"));
    } finally {
      db.close();
    }

    // Reopening via DaemonStateDatabase.open retries v2 -> v3 cleanly and passes 1:1 shape validation.
    const retried = await DaemonStateDatabase.open(dbPath);
    try {
      assert.equal(Number(retried.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(retried.connection);
      assert.equal(
        Number((retried.connection.prepare("SELECT COUNT(*) AS n FROM effects").get() as { n: number }).n),
        Object.keys(seeded.legacyIds).length + 1,
      );
    } finally {
      retried.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("older v1/v2 backup gates refuse v3 and current v3 binary refuses future v4 fail-closed without modifying bytes or mtime", async () => {
  const env = await tempDir("letagents-v3-downgrade-refusal-");
  const v3Path = join(env.root, "v3.sqlite");
  try {
    const opened = await DaemonStateDatabase.open(v3Path);
    try {
      opened.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      opened.close();
    }
    const beforeBytes = await readFile(v3Path);
    const beforeMtime = (await stat(v3Path)).mtimeMs;

    for (const olderVersion of [1, 2] as const) {
      let keyRequested = false;
      await assert.rejects(
        () => prepareStateRecoveryBackup(v3Path, toSqliteUserVersion(olderVersion), async () => {
          keyRequested = true;
          return { key: randomBytes(32), sealedKey: "must-not-be-used" };
        }),
        /recovery snapshot|snapshot_refused/i,
      );
      assert.equal(keyRequested, false, `v${olderVersion} backup gate must fail closed before requesting key`);
    }
    assert.deepEqual(await readFile(v3Path), beforeBytes);
    assert.equal((await stat(v3Path)).mtimeMs, beforeMtime);

    // Future v4 (1004) database refused fail-closed by v3 binary.
    const futurePath = join(env.root, "future-v4.sqlite");
    const seedFuture = new DatabaseSync(futurePath);
    try {
      seedFuture.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}; PRAGMA user_version = ${toSqliteUserVersion(DAEMON_STATE_SCHEMA_VERSION + 1)};`);
      seedFuture.exec("CREATE TABLE future_canary (v TEXT); INSERT INTO future_canary VALUES ('v4');");
    } finally {
      seedFuture.close();
    }
    const futureBytes = await readFile(futurePath);
    const futureMtime = (await stat(futurePath)).mtimeMs;
    await assert.rejects(() => moveAsideLegacyDaemonStateDatabase(futurePath), /Unsupported daemon state schema version/i);
    await assert.rejects(() => DaemonStateDatabase.open(futurePath), /Unsupported daemon state schema version/i);
    assert.deepEqual(await readFile(futurePath), futureBytes);
    assert.equal((await stat(futurePath)).mtimeMs, futureMtime);
  } finally {
    await env.cleanup();
  }
});
