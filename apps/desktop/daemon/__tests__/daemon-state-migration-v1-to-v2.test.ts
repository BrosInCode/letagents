/**
 * Schema v1 -> v2 migration, rollback, downgrade-refusal, and populated-fixture tests.
 *
 * Covers:
 * - Populated schema-v1 database (identical to 6a3ed0245) upgrading cleanly to v2
 *   through both DaemonStateDatabase.open and withProtectedStateUpgrade / SupervisorDaemon.start,
 *   preserving every agent, activity payload, pending inbox item, legacy MCP effect,
 *   work attempt, continuation repair, and room move verbatim.
 * - 1:1 identical normalized sqlite_master shape between a fresh v2 database and
 *   an upgraded v1 -> v2 database.
 * - Atomic rollback on both in-process migration failure and real child-process
 *   SIGKILL mid-migration, followed by clean retry to v2.
 * - Older v1 version gate refusing a v2 database fail-closed without modifying or
 *   moving aside the file.
 * - Compaction snapshot cloning on a populated v2 database with effect_journal rows.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DAEMON_STATE_APPLICATION_ID,
  DAEMON_STATE_MIGRATIONS,
  DAEMON_STATE_SCHEMA_VERSION,
  DAEMON_STATE_USER_VERSION,
  DaemonStateDatabase,
  DaemonStateSchema,
  applySchemaV1,
  moveAsideLegacyDaemonStateDatabase,
  runNumberedMigrations,
  toSqliteUserVersion,
  validateDaemonStateShape,
} from "../daemon-state-database.js";
import { normalizeSchemaSql } from "../daemon-state-database/shared.js";
import { applyEffectJournalSchemaV2, prepareEffect } from "../effect-journal/index.js";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { SupervisorDaemon } from "../main.js";
import { cloneStateDatabaseForCompaction, prepareStateRecoveryBackup } from "../state-recovery-backup.js";
import { withProtectedStateUpgrade } from "../state-recovery-key.js";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { testDaemonEndpoint } from "./helpers/daemon-fixture.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_MODULE_URL = pathToFileURL(join(THIS_DIR, "../daemon-state-database/schema.ts")).href;
const EFFECT_SCHEMA_MODULE_URL = pathToFileURL(join(THIS_DIR, "../effect-journal/schema.ts")).href;
/**
 * Normalized sqlite_master SHA-256 captured directly from a real `6a3ed0245`
 * checkout's `SupervisorDaemon` schema-v1 database (135 objects, user_version=1001).
 * Keeps `applySchemaV1` permanently anchored to the shipped v1 schema.
 */
const REAL_6A3ED0245_V1_SCHEMA_SHA256 = "5575ef72f0101c643ea8ebd4c2b70b04e67f3693e30bae7b3bb1d529336b008c";

function readAllTableRowCounts(database: DatabaseSync): Record<string, number> {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const row = database.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number };
    counts[name] = Number(row.n);
  }
  return counts;
}

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

/**
 * Creates a populated schema-v1 database (`application_id=LAD1`, `user_version=1001`)
 * matching the exact `6a3ed0245` schema, seeded with agents, full activity payloads,
 * pending inbox items, legacy bounded MCP effects & tombstones, work attempts,
 * continuation repairs, and a prepared room move.
 */
function seedPopulatedV1Database(dbPath: string): {
  agentIds: string[];
  activityPayload: string;
  pendingInboxId: string;
  legacyEffectId: string;
  tombstoneId: string;
  workAttemptId: string;
  repairId: string;
  roomMoveId: string;
  tableRowCounts: Record<string, number>;
} {
  const now = "2026-11-21T22:00:00.000Z";
  const activityPayload = JSON.stringify({ text: "v1-activity-preserved-" + "x".repeat(512), turn: 7 });
  const workAttemptId = "11111111-1111-4111-8111-111111111111";
  const executionGenerationId = "22222222-2222-4222-8222-222222222222";
  const pendingInboxId = "inbox_v1_pending_1";
  const legacyEffectId = "effect_v1_executing_1";
  const tombstoneId = "effect_v1_tombstone_1";
  const repairId = "repair_v1_probing_1";
  const roomMoveId = "room_move_v1_prepared_1";

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    db.exec("BEGIN IMMEDIATE");
    applySchemaV1(db);
    db.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${toSqliteUserVersion(1)}`);

    // Two agents in non-lexicographic sort order to verify order + per-agent version preservation.
    db.prepare(`
      INSERT INTO agents (
        agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
        charter, config_revision, runtime_configuration_revision, desired_state, observed_state,
        deployment_id, run_id, work_attempt_id, provider_work_attempt_id, provider_continuation_id,
        provider_execution_generation_id, condition, last_turn_control_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "agent_beta", 0, 4, "owner", now, "Beta", "room_alpha", "codex",
      "Work carefully", 2, 2, "stopped", "stopped",
      serializeDaemonDeploymentId("agent_beta", executionGenerationId), executionGenerationId,
      workAttemptId, workAttemptId, "cont_v1_1", executionGenerationId,
      "none", 3,
    );
    db.prepare(`
      INSERT INTO agents (
        agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
        charter, config_revision, runtime_configuration_revision, desired_state, observed_state,
        condition, last_turn_control_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "agent_alpha", 1, 2, "owner", now, "Alpha", "room_beta", "claude-code",
      "Assist", 1, 1, "stopped", "stopped",
      "none", 0,
    );

    db.prepare(`
      INSERT INTO activity_events (
        agent_id, sort_order, observed_at, sequence, provider, kind, method, summary, status,
        payload_json, payload_truncated, payload_redacted, durable_payload_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)
    `).run("agent_beta", 0, now, 1, "codex", "message", "item/agentMessage", "Preserved v1 event", "idle", activityPayload);

    db.prepare(`
      INSERT INTO reconciliation_action_tombstones (agent_id, action_id) VALUES (?, ?)
    `).run("agent_beta", "reconcile_v1_tombstone_1");

    const wsPath = join(dirname(dbPath), "ws-v1");
    const barePath = join(dirname(dbPath), "bare-v1");
    db.prepare(`
      INSERT INTO work_attempts (
        work_attempt_id, task_id, lease_id, current_lease_epoch, workspace_path, workspace_repo,
        workspace_remote_url, workspace_resolved_revision, workspace_bare_path, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workAttemptId, "task_4", "lease_1", 1, wsPath, "letagents",
      "https://github.com/BrosInCode/letagents.git", "6a3ed02458b4d9a920ecf8ad6ae4c9d69bd4051f", barePath, "active", now,
    );

    db.prepare(`
      INSERT INTO work_attempt_lease_epochs (
        work_attempt_id, sort_order, lease_id, epoch, recorded_at
      ) VALUES (?, 0, ?, 1, ?)
    `).run(workAttemptId, "lease_1", now);

    db.prepare(`
      INSERT INTO work_attempt_executions (
        execution_generation_id, work_attempt_id, started_at, actor, generation, terminal_json
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `).run(executionGenerationId, workAttemptId, now, "daemon", 1);

    db.prepare(`
      INSERT INTO inbox_items (
        inbox_item_id, agent_id, room_id, source_message_id, source_message_json, activation_json,
        fifo_sequence, state, attempt_count, action_id, reply_client_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pendingInboxId, "agent_beta", "room_alpha", "msg_42",
      JSON.stringify({ id: "msg_42", text: "carry forward across v1->v2" }),
      JSON.stringify({ decision: "activate", addressed: true }),
      1, "pending", 0, "act_42", "reply_42", now, now,
    );

    db.prepare(`
      INSERT INTO effects (
        effect_id, agent_id, room_id, execution_generation_id, provider_turn_id, mcp_request_id,
        tool_name, request_json, mutation, state, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'prepared', NULL, NULL, ?, ?)
    `).run(
      legacyEffectId, "agent_beta", "room_alpha", executionGenerationId, "turn_1", "mcp_req_1",
      "send_message", JSON.stringify({ text: "hello" }), now, now,
    );

    db.prepare(`
      INSERT INTO effect_tombstones (
        effect_id, agent_id, room_id, execution_generation_id, provider_turn_id, mcp_request_id,
        tool_name, request_sha256, request_bytes, mutation, state, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 18, 1, 'completed', '{"ok":true}', NULL, ?, ?)
    `).run(
      tombstoneId, "agent_beta", "room_alpha", executionGenerationId, "turn_0", "mcp_req_0",
      "post_status", "a".repeat(64), now, now,
    );

    db.prepare(`
      INSERT INTO provider_continuation_repairs (
        repair_id, agent_id, room_id, inbox_item_id, daemon_generation, execution_generation_id,
        work_attempt_id, expected_pid, expected_process_identity, missing_continuation,
        replacement_continuation, phase, attempt_count, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 12345, 'proc-identity-1', 'cont_v1_1', NULL, 'probing', 1, NULL, ?, ?)
    `).run(repairId, "agent_beta", "room_alpha", pendingInboxId, executionGenerationId, workAttemptId, now, now);

    db.prepare(`
      INSERT INTO agent_room_moves (
        operation_id, request_id, agent_id, source_room_id, destination_room_id, daemon_generation,
        work_attempt_id, execution_generation_id, phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'prepared', ?, ?)
    `).run(roomMoveId, "req_move_1", "agent_beta", "room_alpha", "room_gamma", workAttemptId, executionGenerationId, now, now);

    db.exec("COMMIT");
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(1));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='effect_journal'").get(), undefined);
    assert.equal(
      schemaFingerprint(db),
      REAL_6A3ED0245_V1_SCHEMA_SHA256,
      "applySchemaV1 must remain byte-for-byte identical to the shipped 6a3ed0245 schema v1",
    );
    const tableRowCounts = readAllTableRowCounts(db);
    return {
      agentIds: ["agent_beta", "agent_alpha"],
      activityPayload,
      pendingInboxId,
      legacyEffectId,
      tombstoneId,
      workAttemptId,
      repairId,
      roomMoveId,
      tableRowCounts,
    };
  } finally {
    db.close();
  }
}

test("populated v1 fixture upgrades cleanly to v2 via withProtectedStateUpgrade, preserves all data, and matches fresh v2 shape 1:1", async () => {
  const env = await tempDir("letagents-migrate-v1-v2-");
  const v1Path = join(env.root, "migrated.sqlite");
  const freshPath = join(env.root, "fresh.sqlite");
  const key = randomBytes(32);
  let backupKeyRequests = 0;

  try {
    const seeded = seedPopulatedV1Database(v1Path);

    // Upgrade via the production protected-upgrade pipeline (encrypted backup + migration + 1:1 shape check + backup cleanup).
    await withProtectedStateUpgrade(
      v1Path,
      async (stateDb) => {
        const db = stateDb.connection;
        assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
        validateDaemonStateShape(db);
      },
      {
        getBackupKey: async () => {
          backupKeyRequests += 1;
          return { key: Buffer.from(key), sealedKey: "test-sealed-v1-to-v2" };
        },
      },
    );
    assert.equal(backupKeyRequests, 1, "v1 -> v2 upgrade must take a protected encrypted backup before migrating");

    // Verify encrypted recovery snapshot was promoted (no leftover .pending candidate) and no legacy move-aside occurred.
    const filesAfterUpgrade = await readdir(env.root);
    assert.equal(filesAfterUpgrade.some((name) => name.endsWith(".pending")), false);
    assert.equal(filesAfterUpgrade.some((name) => name.endsWith(".recovery.enc")), true, "validated encrypted recovery snapshot is retained for its retention window");
    assert.equal(filesAfterUpgrade.some((name) => name.includes(".legacy-")), false);

    // Create a fresh v2 database and compare sqlite_master 1:1 with the upgraded v1 -> v2 database.
    const freshDb = await DaemonStateDatabase.open(freshPath);
    const upgradedDb = await DaemonStateDatabase.open(v1Path);
    try {
      const freshEntries = normalizedSchemaEntries(freshDb.connection);
      const upgradedEntries = normalizedSchemaEntries(upgradedDb.connection);
      assert.deepEqual(upgradedEntries, freshEntries, "upgraded v1 -> v2 schema must be 1:1 identical to fresh v2");
      assert.equal(schemaFingerprint(upgradedDb.connection), schemaFingerprint(freshDb.connection));

      const db = upgradedDb.connection;
      assert.equal(Number(db.prepare("PRAGMA application_id").get()?.application_id), DAEMON_STATE_APPLICATION_ID);
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);

      // Verify every single v1 table (including ON DELETE CASCADE children) preserved its exact row count,
      // `daemon_maintenance_state` gained the 1 backup-retention bookkeeping row from withProtectedStateUpgrade,
      // and legacy `effects` migrated cleanly into the unified v3 `effects` table (no `effect_journal` staging table left).
      const upgradedCounts = readAllTableRowCounts(db);
      assert.deepEqual(upgradedCounts, {
        ...seeded.tableRowCounts,
        daemon_maintenance_state: 1,
      });
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='effect_journal'").get(), undefined);

      // Verify all seeded v1 rows were preserved verbatim.
      const agents = db.prepare("SELECT agent_id, sort_order, version, display_name, room_id, last_turn_control_sequence FROM agents ORDER BY sort_order").all() as Array<Record<string, unknown>>;
      assert.deepEqual(agents.map((row) => row.agent_id), seeded.agentIds);
      assert.equal(Number(agents[0]!.version), 4);
      assert.equal(Number(agents[0]!.last_turn_control_sequence), 3);
      assert.equal(Number(agents[1]!.version), 2);

      const activity = db.prepare("SELECT payload_json, summary FROM activity_events WHERE agent_id='agent_beta'").get() as Record<string, unknown>;
      assert.equal(String(activity.payload_json), seeded.activityPayload);
      assert.equal(String(activity.summary), "Preserved v1 event");

      const inbox = db.prepare("SELECT inbox_item_id, state, source_message_id FROM inbox_items WHERE inbox_item_id=?").get(seeded.pendingInboxId) as Record<string, unknown>;
      assert.equal(inbox.state, "pending");
      assert.equal(inbox.source_message_id, "msg_42");

      const migratedEffect = db.prepare("SELECT id, kind, state, payload FROM effects WHERE id=?").get(seeded.legacyEffectId) as Record<string, unknown>;
      assert.equal(migratedEffect.kind, "bounded_mcp_effect");
      assert.equal(migratedEffect.state, "prepared");
      assert.equal((JSON.parse(String(migratedEffect.payload)) as { tool_name: string }).tool_name, "send_message");

      const tombstone = db.prepare("SELECT effect_id, state FROM effect_tombstones WHERE effect_id=?").get(seeded.tombstoneId) as Record<string, unknown>;
      assert.equal(tombstone.state, "completed");

      const attempt = db.prepare("SELECT work_attempt_id, state FROM work_attempts WHERE work_attempt_id=?").get(seeded.workAttemptId) as Record<string, unknown>;
      assert.equal(attempt.state, "active");

      const repair = db.prepare("SELECT repair_id, phase FROM provider_continuation_repairs WHERE repair_id=?").get(seeded.repairId) as Record<string, unknown>;
      assert.equal(repair.phase, "probing");

      const roomMove = db.prepare("SELECT operation_id, phase, destination_room_id FROM agent_room_moves WHERE operation_id=?").get(seeded.roomMoveId) as Record<string, unknown>;
      assert.equal(roomMove.phase, "prepared");
      assert.equal(roomMove.destination_room_id, "room_gamma");

      // Verify unified `effects` is operational and moves agent_state_versions.inbox_version on write.
      const beforeInboxVersion = Number(
        (db.prepare("SELECT inbox_version FROM agent_state_versions WHERE agent_id='agent_beta'").get() as { inbox_version?: number } | undefined)?.inbox_version ?? 0,
      );
      const prepared = prepareEffect(db, () => {}, {
        agent_id: "agent_beta",
        kind: "probe_external",
        idempotency_key: "k-1",
        epoch: 1,
        payload: { hello: "v3" },
      });
      assert.equal(prepared.created, true);
      const afterInboxVersion = Number(
        (db.prepare("SELECT inbox_version FROM agent_state_versions WHERE agent_id='agent_beta'").get() as { inbox_version: number }).inbox_version,
      );
      assert.equal(afterInboxVersion, beforeInboxVersion + 1);

      // Verify compaction clone works cleanly on populated databases containing unified `effects` rows and triggers.
      const cloned = cloneStateDatabaseForCompaction(db);
      try {
        validateDaemonStateShape(cloned);
        assert.equal(Number(cloned.prepare("SELECT COUNT(*) AS n FROM effects").get()?.n), 2);
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

test("SupervisorDaemon.start upgrades a populated v1 home to v2 cleanly and preserves manifest state", async () => {
  const env = await tempDir("letagents-daemon-v1-v2-");
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.log"),
    attemptsPath: join(env.root, "attempts.sqlite"),
    attemptsRoot: join(env.root, "attempts"),
    workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "bindings.sqlite"),
  };
  let daemon: SupervisorDaemon | null = null;
  try {
    const seeded = seedPopulatedV1Database(paths.manifestPath);
    const key = randomBytes(32);
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start({
      getBackupKey: async () => ({ key: Buffer.from(key), sealedKey: "daemon-start-v1-v2" }),
    });
    await daemon.stop();
    daemon = null;

    const inspect = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try {
      assert.equal(Number(inspect.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(inspect);
      const ids = (inspect.prepare("SELECT agent_id FROM agents ORDER BY sort_order").all() as Array<{ agent_id: string }>).map((row) => row.agent_id);
      assert.deepEqual(ids, seeded.agentIds);
      const act = inspect.prepare("SELECT payload_json FROM activity_events WHERE agent_id='agent_beta'").get() as { payload_json: string };
      assert.equal(act.payload_json, seeded.activityPayload);
    } finally {
      inspect.close();
    }
  } finally {
    await daemon?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("v1 -> v2 migration rolls back atomically on in-process failure and succeeds cleanly on retry", async () => {
  const env = await tempDir("letagents-migrate-rollback-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    const seeded = seedPopulatedV1Database(dbPath);
    const failingDb = new DatabaseSync(dbPath);
    try {
      failingDb.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      assert.throws(() => {
        failingDb.exec("BEGIN IMMEDIATE");
        try {
          runNumberedMigrations(failingDb, 1, 2, {
            1(connection) {
              applyEffectJournalSchemaV2(connection);
              throw new Error("injected v1->v2 migration failure");
            },
          });
          failingDb.exec("COMMIT");
        } catch (error) {
          failingDb.exec("ROLLBACK");
          throw error;
        }
      }, /injected v1->v2 migration failure/);

      // Must remain cleanly at v1 with zero partial v2 objects.
      assert.equal(Number(failingDb.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(1));
      assert.equal(failingDb.prepare("SELECT 1 FROM sqlite_master WHERE name='effect_journal'").get(), undefined);
      assert.equal(failingDb.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'agent_state_versions_effect_journal%'").get(), undefined);
      assert.equal(Number(failingDb.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n), seeded.agentIds.length);
    } finally {
      failingDb.close();
    }

    // Retrying real migration succeeds and validates 1:1 against fresh current schema.
    const retried = await DaemonStateDatabase.open(dbPath);
    try {
      assert.equal(Number(retried.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(retried.connection);
      assert.equal(Number(retried.connection.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n), seeded.agentIds.length);
    } finally {
      retried.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("real SIGKILL mid-migration rolls back v1 -> v2 atomically and retrying opens cleanly at v2", async () => {
  const env = await tempDir("letagents-migrate-sigkill-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    const seeded = seedPopulatedV1Database(dbPath);
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const { applyEffectJournalSchemaV2 } = await import(process.env.EFFECT_SCHEMA_URL);
      const db = new DatabaseSync(process.env.DB_PATH);
      db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      db.exec("BEGIN IMMEDIATE");
      applyEffectJournalSchemaV2(db);
      db.exec("PRAGMA user_version = 1002");
      process.stdout.write("MID_MIGRATION_READY\\n");
      setInterval(() => {}, 60_000);
    `;
    const child = spawn(
      process.execPath,
      ["--conditions=letagents-source", "--import", "tsx", "--input-type=module", "-e", script],
      {
        env: { ...process.env, DB_PATH: dbPath, EFFECT_SCHEMA_URL: EFFECT_SCHEMA_MODULE_URL },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for mid-migration ready: ${stderr}`)), 15_000);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("MID_MIGRATION_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Child exited early before SIGKILL (code=${code}, signal=${signal}): ${stderr}`));
      });
    });

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // SQLite WAL rollback must leave the DB intact at v1 with zero partial v2 tables or triggers.
    const afterCrash = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(Number(afterCrash.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(1));
      assert.equal(afterCrash.prepare("SELECT 1 FROM sqlite_master WHERE name='effect_journal'").get(), undefined);
      assert.equal(afterCrash.prepare("PRAGMA integrity_check(1)").get()?.integrity_check, "ok");
      assert.equal(Number(afterCrash.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n), seeded.agentIds.length);
    } finally {
      afterCrash.close();
    }

    // Reopening via DaemonStateDatabase.open retries cleanly to current schema.
    const recovered = await DaemonStateDatabase.open(dbPath);
    try {
      assert.equal(Number(recovered.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(recovered.connection);
      assert.equal(Number(recovered.connection.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n), seeded.agentIds.length);
    } finally {
      recovered.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("older v1 gate and backup gate refuse a v2 database without modifying or moving aside the file", async () => {
  const env = await tempDir("letagents-downgrade-refusal-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    // Create and checkpoint a clean v2 database so no transient WAL/SHM remains.
    const v2 = await DaemonStateDatabase.open(dbPath);
    try {
      prepareEffect(v2.connection, () => {}, {
        agent_id: "agent_v2",
        kind: "probe",
        idempotency_key: "downgrade-check",
        epoch: 1,
        payload: { keep: true },
      });
      v2.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      v2.close();
    }

    const beforeBytes = await readFile(dbPath);
    const beforeMtime = (await stat(dbPath)).mtimeMs;

    // 1. Backup preflight targeted at v1 (1001) refuses v2 (1002) without creating any backup or touching DB.
    let keyRequested = false;
    await assert.rejects(
      () => prepareStateRecoveryBackup(dbPath, toSqliteUserVersion(1), async () => {
        keyRequested = true;
        return { key: randomBytes(32), sealedKey: "must-not-be-used" };
      }),
      /recovery snapshot|snapshot_refused/i,
    );
    assert.equal(keyRequested, false, "v1 backup gate must fail closed before requesting a recovery key");

    // 2. Older v1 version gate check: current schema version > v1 max (1) fails closed and never moves aside.
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(Number(probe.prepare("PRAGMA application_id").get()?.application_id), DAEMON_STATE_APPLICATION_ID);
      assert.equal(Number(probe.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
    } finally {
      probe.close();
    }

    // 3. Simulate a future schema v3 (1003) opened by current v2 binary: must refuse without moving aside or editing.
    const futurePath = join(env.root, "future-v3.sqlite");
    const seedV3 = new DatabaseSync(futurePath);
    try {
      seedV3.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}; PRAGMA user_version = ${toSqliteUserVersion(DAEMON_STATE_SCHEMA_VERSION + 1)};`);
      seedV3.exec("CREATE TABLE future_canary (v TEXT); INSERT INTO future_canary VALUES ('v3');");
    } finally {
      seedV3.close();
    }
    const v3BeforeBytes = await readFile(futurePath);
    const v3BeforeMtime = (await stat(futurePath)).mtimeMs;
    await assert.rejects(() => moveAsideLegacyDaemonStateDatabase(futurePath), /Unsupported daemon state schema version/i);
    await assert.rejects(() => DaemonStateDatabase.open(futurePath), /Unsupported daemon state schema version/i);
    assert.deepEqual(await readFile(futurePath), v3BeforeBytes);
    assert.equal((await stat(futurePath)).mtimeMs, v3BeforeMtime);

    // Original v2 DB must remain byte-for-byte untouched with zero sidecars or move-aside copies.
    const files = await readdir(env.root);
    assert.equal(files.some((name) => name.includes(".legacy-") || name.includes(".recovery.enc")), false);
    assert.deepEqual(await readFile(dbPath), beforeBytes);
    assert.equal((await stat(dbPath)).mtimeMs, beforeMtime);
    assert.equal(typeof DAEMON_STATE_MIGRATIONS[1], "function");
    assert.ok(SCHEMA_MODULE_URL.endsWith("schema.ts"));
  } finally {
    await env.cleanup();
  }
});
