/**
 * Schema v4 (1004) -> v5 (1005) migration tests:
 * - Marker-only fence (zero DDL change) so older v4 (.27) daemons refuse a v5
 *   database before external `@review1:` workspace review references are written
 * - Rolls back cleanly on interrupted migration
 * - First .28 upgrade of a .27 (1004) database with inline-only reviews and no
 *   `.reviews/` or `.reviews-recovery/` folders succeeds without failing closed,
 *   continues to pass backups on v5 while reviews remain inline, and round-trips
 *   through background externalization + recovery restore
 * - Future modern schema (1006) fails closed with zero modification
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DAEMON_STATE_APPLICATION_ID,
  DAEMON_STATE_SCHEMA_VERSION,
  DAEMON_STATE_USER_VERSION,
  DaemonStateDatabase,
  DaemonStateSchema,
  applySchemaV1,
  runNumberedMigrations,
  toSqliteUserVersion,
  validateDaemonStateShape,
} from "../daemon-state-database.js";
import { normalizeSchemaSql } from "../daemon-state-database/shared.js";
import { RoomWorkspaceStore } from "../room-workspace-store.js";
import { decryptStateRecoveryBackup, prepareStateRecoveryBackup } from "../state-recovery-backup.js";
import { withProtectedStateUpgrade } from "../state-recovery-key.js";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { REVIEW_PAGE_SIZE } from "../../../../shared/workspace-review.mjs";
import { REVIEW_ARCHIVE_MIN_USER_VERSION, readArchivedReview, reviewArchiveReference } from "../../../../shared/workspace-review-archive.mjs";
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

function seedPopulatedV4Database(dbPath: string, reviews: ReadonlyArray<{ id: string; data: string; digest: string; uploadedPages: number }>): void {
  const now = "2026-11-24T08:00:00.000Z";
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    db.exec("BEGIN IMMEDIATE");
    applySchemaV1(db);
    runNumberedMigrations(db, 1, 4);
    db.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${toSqliteUserVersion(4)}`);

    db.prepare(`
      INSERT INTO agents (
        agent_id, sort_order, version, created_by, created_at, display_name, room_id, provider,
        charter, config_revision, runtime_configuration_revision, desired_state, observed_state,
        condition, last_turn_control_sequence
      ) VALUES ('agent_v4', 0, 1, 'owner', ?, 'V4 Agent', 'room_alpha', 'codex', 'Assist', 1, 1, 'stopped', 'stopped', 'none', 0)
    `).run(now);

    for (const review of reviews) {
      db.prepare(`
        INSERT INTO room_work_publications (
          agent_id, room_id, source_message_id, api_origin, agent_key, agent_instance_id,
          host_id, installation_id, source_session_id, state, revision, acknowledged_revision
        ) VALUES ('agent_v4', 'room_alpha', ?, 'https://letagents.chat', 'owner/agent_v4', 'inst_1',
          'host_1', 'install_1', 'sess_1', 'open', 0, 0)
      `).run(review.id);
      db.prepare(`
        INSERT INTO room_workspace_captures (
          agent_id, room_id, source_message_id, work_attempt_id, inbox_item_id, baseline, settled_json
        ) VALUES ('agent_v4', 'room_alpha', ?, 'attempt_1', ?, NULL, NULL)
      `).run(review.id, `inbox_${review.id}`);
      db.prepare(`
        INSERT INTO room_workspace_reviews (
          agent_id, room_id, source_message_id, digest, data, uploaded_pages
        ) VALUES ('agent_v4', 'room_alpha', ?, ?, ?, ?)
      `).run(review.id, review.digest, review.data, review.uploadedPages);
    }

    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

test("v4 (1004) -> v5 (1005) marker-only fence matches fresh v5 1:1 and rolls back on interruption", async () => {
  assert.equal(REVIEW_ARCHIVE_MIN_USER_VERSION, toSqliteUserVersion(5));
  assert.ok(DAEMON_STATE_SCHEMA_VERSION >= 5);
  assert.ok(DAEMON_STATE_USER_VERSION >= 1005);

  const env = await tempDir("letagents-mig-v4-v5-fence-");
  const v4Path = join(env.root, "v4.sqlite");
  const freshPath = join(env.root, "fresh.sqlite");
  try {
    seedPopulatedV4Database(v4Path, []);

    const db = new DatabaseSync(v4Path);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      assert.throws(
        () => new DaemonStateSchema(() => { throw new Error("interrupt archive upgrade"); }).createSchema(db),
        /interrupt archive upgrade/,
      );
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(4));

      new DaemonStateSchema().createSchema(db);
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      validateDaemonStateShape(db);
    } finally {
      db.close();
    }

    const fresh = await DaemonStateDatabase.open(freshPath);
    const upgraded = await DaemonStateDatabase.open(v4Path);
    try {
      assert.deepEqual(
        normalizedSchemaEntries(upgraded.connection),
        normalizedSchemaEntries(fresh.connection),
        "v4 -> v5 is marker-only and must match fresh v5 DDL 1:1",
      );
    } finally {
      fresh.close();
      upgraded.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("first .28 upgrade of a .27 (1004) DB with inline-only reviews and no archive directories succeeds and externalizes cleanly", async () => {
  const env = await tempDir("letagents-mig-v4-v5-inline-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const key = randomBytes(32);
  const reviewOne = "A".repeat(REVIEW_PAGE_SIZE) + "B".repeat(REVIEW_PAGE_SIZE) + "TAIL_ONE";
  const reviewTwo = "C".repeat(REVIEW_PAGE_SIZE) + "TAIL_TWO";
  const reviews = [
    { id: "msg_1", data: reviewOne, digest: createHash("sha256").update(reviewOne).digest("hex"), uploadedPages: 1 },
    { id: "msg_2", data: reviewTwo, digest: createHash("sha256").update(reviewTwo).digest("hex"), uploadedPages: 0 },
  ] as const;

  try {
    seedPopulatedV4Database(dbPath, reviews);
    assert.equal(existsSync(dbPath + ".reviews"), false);
    assert.equal(existsSync(dbPath + ".reviews-recovery"), false);

    // Step 1: Protected 1004 -> 1005 upgrade with all reviews inline and no .reviews/.reviews-recovery folders yet.
    await withProtectedStateUpgrade(
      dbPath,
      async (stateDb) => {
        assert.equal(Number(stateDb.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
        validateDaemonStateShape(stateDb.connection);
      },
      {
        getBackupKey: async () => ({ key: Buffer.from(key), sealedKey: "sealed-v4-to-v5" }),
      },
    );

    assert.equal(existsSync(dbPath + ".recovery.enc"), true);
    assert.equal(existsSync(dbPath + ".reviews"), false, "upgrade alone does not create archive dirs before background conversion");
    assert.equal(existsSync(dbPath + ".reviews-recovery"), false);

    // Restoring the pre-upgrade .recovery.enc returns both exact inline reviews.
    const restoredPreUpgrade = await decryptStateRecoveryBackup(dbPath + ".recovery.enc", key);
    try {
      const rows = restoredPreUpgrade.prepare(
        "SELECT source_message_id, digest, data, uploaded_pages FROM room_workspace_reviews ORDER BY source_message_id",
      ).all().map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { source_message_id: "msg_1", digest: reviews[0].digest, data: reviewOne, uploaded_pages: 1 },
        { source_message_id: "msg_2", digest: reviews[1].digest, data: reviewTwo, uploaded_pages: 0 },
      ]);
    } finally {
      restoredPreUpgrade.close();
    }

    // Step 2: While still at 1005 with all reviews still inline and no archive dirs on disk,
    // a new recovery backup must also succeed (verifyWorkspaceReviewRecoverySet must not fail closed).
    const key2 = randomBytes(32);
    const inlineBackup = await prepareStateRecoveryBackup(
      dbPath,
      DAEMON_STATE_USER_VERSION + 1,
      async () => ({ key: Buffer.from(key2), sealedKey: "sealed-v5-inline" }),
    );
    assert.ok(inlineBackup);

    // Step 3: Background archive conversion externalizes both inline rows and preserves upload cursors.
    const opened = await DaemonStateDatabase.open(dbPath);
    try {
      const store = new RoomWorkspaceStore(opened.connection);
      assert.equal(store.maintainArchives(1_000), true);
      assert.equal(store.maintainArchives(2_000), true);
      assert.equal(store.maintainArchives(3_000), false);

      assert.equal(readdirSync(dbPath + ".reviews").filter((name) => name.endsWith(".review")).length, 2);
      assert.equal(readdirSync(dbPath + ".reviews-recovery").filter((name) => name.endsWith(".review")).length, 2);

      const page1 = store.pendingPage("agent_v4", "room_alpha", "msg_1");
      assert.deepEqual(page1, { digest: reviews[0].digest, index: 1, total: 3, data: "B".repeat(REVIEW_PAGE_SIZE) });
    } finally {
      opened.close();
    }

    // Step 4: Backup after externalization verifies both archive mirrors and restores full reviews through references.
    const key3 = randomBytes(32);
    const archivedBackup = await prepareStateRecoveryBackup(
      dbPath,
      DAEMON_STATE_USER_VERSION + 1,
      async () => ({ key: Buffer.from(key3), sealedKey: "sealed-v5-archived" }),
    );
    assert.ok(archivedBackup);

    const restoredArchived = await decryptStateRecoveryBackup(archivedBackup.path, key3);
    try {
      const rows = restoredArchived.prepare(
        "SELECT source_message_id, digest, data, uploaded_pages FROM room_workspace_reviews ORDER BY source_message_id",
      ).all() as Array<{ source_message_id: string; digest: string; data: string; uploaded_pages: number }>;
      assert.equal(rows.length, 2);
      for (const [index, row] of rows.entries()) {
        assert.ok(row.data.startsWith("@review1:"), "restored backup row holds compact archive reference");
        const ref = reviewArchiveReference(row.data);
        assert.ok(ref);
        assert.equal(readArchivedReview(dbPath, ref, row.digest), reviews[index]!.data);
        assert.equal(row.uploaded_pages, reviews[index]!.uploadedPages);
      }
    } finally {
      restoredArchived.close();
    }
  } finally {
    await env.cleanup();
  }
});

test("future modern schema v6 (1006) fails closed with zero modification and no move-aside", async () => {
  const env = await tempDir("letagents-mig-v4-v5-future-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}; PRAGMA user_version = ${toSqliteUserVersion(DAEMON_STATE_SCHEMA_VERSION + 1)};`);
      seed.exec("CREATE TABLE canary (v TEXT); INSERT INTO canary VALUES ('future-v6');");
    } finally {
      seed.close();
    }
    const beforeBytes = await readFile(dbPath);
    const beforeMtimeMs = (await stat(dbPath)).mtimeMs;

    await assert.rejects(
      DaemonStateDatabase.open(dbPath),
      /Unsupported daemon state schema version/i,
    );

    assert.deepEqual(await readFile(dbPath), beforeBytes, "future database bytes must stay untouched");
    assert.equal((await stat(dbPath)).mtimeMs, beforeMtimeMs);
    assert.deepEqual(
      readdirSync(env.root).filter((name) => name.includes("legacy")),
      [],
      "future modern schema must never be moved aside",
    );
  } finally {
    await env.cleanup();
  }
});
