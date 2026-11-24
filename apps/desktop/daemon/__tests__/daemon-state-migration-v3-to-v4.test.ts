/**
 * Schema v3 (1003) -> v4 (1004) migration tests:
 * - Widens execution_runtime_generations.provider CHECK to admit 'antigravity'
 * - Preserves every existing runtime birth, exact rowid, and child FK reference
 * - Matches fresh v4 sqlite_master 1:1
 * - Exercises streaming multi-chunk (>12 MB) recovery backup end-to-end on upgrade
 * - Verifies atomic rollback, unexpected dependency refusal, and downgrade/future gates
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
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
  runNumberedMigrations,
  toSqliteUserVersion,
  validateDaemonStateShape,
} from "../daemon-state-database.js";
import { normalizeSchemaSql } from "../daemon-state-database/shared.js";
import { validateExecutionStorageSchema } from "../execution-storage-schema.js";
import { prepareStateRecoveryBackup } from "../state-recovery-backup.js";
import { withProtectedStateUpgrade } from "../state-recovery-key.js";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";

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

function seedPopulatedV3Database(dbPath: string, options?: { largeReviewBytes?: number }): void {
  const now = "2026-11-24T04:00:00.000Z";
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    db.exec("BEGIN IMMEDIATE");
    applySchemaV1(db);
    runNumberedMigrations(db, 1, 3);
    db.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${toSqliteUserVersion(3)}`);

    db.prepare(`
      INSERT INTO agents (
        agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
        charter, config_revision, runtime_configuration_revision, desired_state, observed_state,
        condition, last_turn_control_sequence
      ) VALUES ('agent_v3', 0, 1, 'owner', ?, 'V3 Agent', 'room_alpha', 'codex', 'Assist', 1, 1, 'stopped', 'stopped', 'none', 0)
    `).run(now);

    db.prepare(`
      INSERT INTO execution_generations (execution_generation_id, agent_id, created_at_ms)
      VALUES ('gen_1', 'agent_v3', 1000)
    `).run();

    // Seed all four pre-Antigravity providers with non-sequential explicit rowids to verify rowid preservation.
    const providers = [
      [11, "rt_codex", "codex"],
      [23, "rt_claude", "claude-code"],
      [37, "rt_cursor", "cursor"],
      [41, "rt_open_model", "open-model"],
    ] as const;
    const insertRt = db.prepare(`
      INSERT INTO execution_runtime_generations (
        rowid, runtime_generation_id, execution_generation_id, agent_id, provider,
        authority_mode, runtime_state, control_state, continuation_state, config_revision, created_at_ms
      ) VALUES (?, ?, 'gen_1', 'agent_v3', ?, 'typed', 'ready', 'responsive', 'available', 1, 1000)
    `);
    for (const [rowid, id, provider] of providers) insertRt.run(rowid, id, provider);

    db.prepare(`
      INSERT INTO execution_message_attempts (attempt_id, agent_id, room_id, source_message_id, state, created_at_ms)
      VALUES ('attempt_1', 'agent_v3', 'room_alpha', 'msg_1', 'active', 1000)
    `).run();
    db.prepare(`
      INSERT INTO execution_attempt_generations (attempt_id, agent_id, room_id, execution_generation_id, workspace_id, created_at_ms)
      VALUES ('attempt_1', 'agent_v3', 'room_alpha', 'gen_1', 'ws_1', 1000)
    `).run();
    db.prepare(`
      INSERT INTO runs (
        turn_id, attempt_id, agent_id, room_id, execution_generation_id, runtime_generation_id,
        provider_continuation_id, provider_turn_id, state, side_effects, created_at_ms
      ) VALUES ('turn_1', 'attempt_1', 'agent_v3', 'room_alpha', 'gen_1', 'rt_codex', 'cont_1', 'pt_1', 'active', 'none', 1000)
    `).run();
    db.prepare(`
      INSERT INTO execution_facts (
        fact_id, agent_id, execution_generation_id, turn_id, runtime_generation_id,
        observer_execution_generation_id, observer_runtime_generation_id, observer_epoch,
        source_sequence, execution_id, domain, kind, operation, outcome, side_effects, observed_at_ms
      ) VALUES ('fact_1', 'agent_v3', 'gen_1', 'turn_1', 'rt_codex', 'gen_1', 'rt_codex', 1, 1, 'exec_1', 'execution', 'completed', 'command', 'succeeded', 'none', 1001)
    `).run();
    db.prepare(`
      INSERT INTO execution_observers (
        agent_id, execution_generation_id, runtime_generation_id,
        observer_execution_generation_id, observer_runtime_generation_id, daemon_generation_id,
        observer_epoch, last_source_sequence, max_observed_sequence, bound_at_ms, source_id
      ) VALUES ('agent_v3', 'gen_1', 'rt_codex', 'gen_1', 'rt_codex', 'daemon_1', 1, 1, 1, 1000, 'src_1')
    `).run();

    if (options?.largeReviewBytes) {
      // Multi-byte text payload larger than multiple 4 MB streaming recovery backup chunks.
      const chunk = "café-émoji-🧪-0123456789abcdef\n";
      const repeats = Math.ceil(options.largeReviewBytes / Buffer.byteLength(chunk, "utf8"));
      const bigReview = chunk.repeat(repeats);
      db.prepare(`
        INSERT INTO room_work_publications (
          agent_id, room_id, api_origin, agent_key, agent_instance_id, host_id, installation_id, source_session_id,
          source_message_id
        ) VALUES ('agent_v3', 'room_alpha', 'https://letagents.chat', 'owner/agent_v3', 'inst_1', 'host_1', 'install_1', 'sess_1', 'msg_1')
      `).run();
      db.prepare(`
        INSERT INTO room_workspace_captures (
          agent_id, room_id, source_message_id, work_attempt_id, inbox_item_id
        ) VALUES ('agent_v3', 'room_alpha', 'msg_1', 'ws_1', 'inbox_1')
      `).run();
      db.prepare(`
        INSERT INTO room_workspace_reviews (
          agent_id, room_id, source_message_id, digest, data, uploaded_pages
        ) VALUES ('agent_v3', 'room_alpha', 'msg_1', ?, ?, 0)
      `).run("a".repeat(64), bigReview);
    }

    db.exec("COMMIT");
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(3));
    assert.throws(
      () => db.exec(`INSERT INTO execution_runtime_generations (
        runtime_generation_id, execution_generation_id, agent_id, provider,
        runtime_state, control_state, continuation_state, config_revision, created_at_ms
      ) VALUES ('rt_agy', 'gen_1', 'agent_v3', 'antigravity', 'ready', 'responsive', 'available', 1, 1000)`),
      /CHECK/,
      "v3 database must refuse antigravity before v4 migration",
    );
  } finally {
    db.close();
  }
}

test("populated v3 fixture upgrades cleanly to v4 with multi-piece (>12 MB) streaming backup, preserves exact rowids and children, and matches fresh v4 1:1", async () => {
  const env = await tempDir("letagents-migrate-v3-v4-");
  const v3Path = join(env.root, "v3.sqlite");
  const freshPath = join(env.root, "fresh-v4.sqlite");
  const key = randomBytes(32);

  try {
    seedPopulatedV3Database(v3Path, { largeReviewBytes: 12 * 1024 * 1024 + 12345 });

    const beforeCheck = new DatabaseSync(v3Path);
    let beforeRuntimes: unknown[];
    let beforeRuns: unknown[];
    let beforeFacts: unknown[];
    let beforeObservers: unknown[];
    let beforeReviewLen: number;
    try {
      beforeRuntimes = beforeCheck.prepare("SELECT rowid, * FROM execution_runtime_generations ORDER BY rowid").all();
      beforeRuns = beforeCheck.prepare("SELECT rowid, * FROM runs ORDER BY rowid").all();
      beforeFacts = beforeCheck.prepare("SELECT rowid, * FROM execution_facts ORDER BY rowid").all();
      beforeObservers = beforeCheck.prepare("SELECT rowid, * FROM execution_observers ORDER BY rowid").all();
      beforeReviewLen = Number(beforeCheck.prepare("SELECT length(data) AS n FROM room_workspace_reviews WHERE source_message_id='msg_1'").get()!.n);
    } finally {
      beforeCheck.close();
    }

    await withProtectedStateUpgrade(
      v3Path,
      async (stateDb) => {
        assert.equal(Number(stateDb.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
        assert.equal(DAEMON_STATE_SCHEMA_VERSION, 4);
        assert.equal(DAEMON_STATE_USER_VERSION, 1004);
        validateDaemonStateShape(stateDb.connection);
        validateExecutionStorageSchema(stateDb.connection, 4);
      },
      {
        getBackupKey: async () => ({ key: Buffer.from(key), sealedKey: "sealed-v3-to-v4" }),
      },
    );

    const freshDb = await DaemonStateDatabase.open(freshPath);
    const upgradedDb = await DaemonStateDatabase.open(v3Path);
    try {
      assert.deepEqual(
        normalizedSchemaEntries(upgradedDb.connection),
        normalizedSchemaEntries(freshDb.connection),
        "upgraded v3 -> v4 sqlite_master must be 1:1 identical to fresh v4",
      );
      assert.equal(schemaFingerprint(upgradedDb.connection), schemaFingerprint(freshDb.connection));
      assert.deepEqual(upgradedDb.connection.prepare("PRAGMA foreign_key_check").all(), []);

      assert.deepEqual(
        upgradedDb.connection.prepare("SELECT rowid, * FROM execution_runtime_generations ORDER BY rowid").all(),
        beforeRuntimes,
        "all existing runtime generations and exact rowids must survive unchanged",
      );
      assert.deepEqual(upgradedDb.connection.prepare("SELECT rowid, * FROM runs ORDER BY rowid").all(), beforeRuns);
      assert.deepEqual(upgradedDb.connection.prepare("SELECT rowid, * FROM execution_facts ORDER BY rowid").all(), beforeFacts);
      assert.deepEqual(upgradedDb.connection.prepare("SELECT rowid, * FROM execution_observers ORDER BY rowid").all(), beforeObservers);
      assert.equal(
        Number(upgradedDb.connection.prepare("SELECT length(data) AS n FROM room_workspace_reviews WHERE source_message_id='msg_1'").get()!.n),
        beforeReviewLen,
      );

      // Antigravity is now admitted, and unknown providers are still refused.
      upgradedDb.connection.exec(`
        INSERT INTO execution_runtime_generations (
          runtime_generation_id, execution_generation_id, agent_id, provider,
          runtime_state, control_state, continuation_state, config_revision, created_at_ms
        ) VALUES ('rt_antigravity', 'gen_1', 'agent_v3', 'antigravity', 'ready', 'responsive', 'available', 1, 2000)
      `);
      assert.equal(
        upgradedDb.connection.prepare("SELECT provider FROM execution_runtime_generations WHERE runtime_generation_id='rt_antigravity'").get()?.provider,
        "antigravity",
      );
      assert.throws(
        () => upgradedDb.connection.exec(`
          INSERT INTO execution_runtime_generations (
            runtime_generation_id, execution_generation_id, agent_id, provider,
            runtime_state, control_state, continuation_state, config_revision, created_at_ms
          ) VALUES ('rt_bad', 'gen_1', 'agent_v3', 'gemini', 'ready', 'responsive', 'available', 1, 2001)
        `),
        /CHECK/,
      );
      assert.deepEqual(upgradedDb.connection.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      upgradedDb.close();
      freshDb.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("v3 -> v4 failure rolls back atomically leaving v3 intact and retries cleanly", async () => {
  const env = await tempDir("letagents-v3-v4-rollback-");
  const dbPath = join(env.root, "rollback.sqlite");
  try {
    seedPopulatedV3Database(dbPath);
    const failDb = new DatabaseSync(dbPath);
    try {
      failDb.exec("PRAGMA foreign_keys = ON");
      assert.throws(() => {
        failDb.exec("BEGIN IMMEDIATE");
        try {
          runNumberedMigrations(failDb, 3, 4, {
            3(conn) {
              DAEMON_STATE_MIGRATIONS[3]!(conn);
              throw new Error("simulated crash before commit");
            },
          });
          failDb.exec("COMMIT");
        } catch (error) {
          failDb.exec("ROLLBACK");
          throw error;
        }
      }, /simulated crash before commit/);
      assert.equal(Number(failDb.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(3));
      validateExecutionStorageSchema(failDb, 1);
    } finally {
      failDb.close();
    }

    const retried = await DaemonStateDatabase.open(dbPath);
    try {
      assert.equal(Number(retried.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(retried.connection);
    } finally {
      retried.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("older v1/v2/v3 backup gates refuse v4 and current v4 binary refuses future v5 fail-closed", async () => {
  const env = await tempDir("letagents-v4-gates-");
  const v4Path = join(env.root, "v4.sqlite");
  const futurePath = join(env.root, "future-v5.sqlite");
  try {
    const db = await DaemonStateDatabase.open(v4Path);
    db.close();
    for (const olderVersion of [1, 2, 3] as const) {
      let keyRequested = false;
      await assert.rejects(
        () => prepareStateRecoveryBackup(v4Path, toSqliteUserVersion(olderVersion), async () => {
          keyRequested = true;
          return { key: randomBytes(32), sealedKey: "should-never-run" };
        }),
        /snapshot_refused|newer|future|unsupported|downgrade/i,
        `older v${olderVersion} binary must refuse v4 backup`,
      );
      assert.equal(keyRequested, false);
    }

    const seedFuture = new DatabaseSync(futurePath);
    try {
      seedFuture.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}; PRAGMA user_version = ${toSqliteUserVersion(DAEMON_STATE_SCHEMA_VERSION + 1)};`);
      seedFuture.exec("CREATE TABLE future_canary (note TEXT NOT NULL); INSERT INTO future_canary VALUES ('untouched');");
    } finally {
      seedFuture.close();
    }
    const beforeBytes = await readFile(futurePath);
    const beforeMtime = (await stat(futurePath)).mtimeMs;
    await assert.rejects(() => DaemonStateDatabase.open(futurePath), /Unsupported daemon state schema version/i);
    assert.deepEqual(await readFile(futurePath), beforeBytes);
    assert.equal((await stat(futurePath)).mtimeMs, beforeMtime);
  } finally {
    await env.cleanup();
  }
});
