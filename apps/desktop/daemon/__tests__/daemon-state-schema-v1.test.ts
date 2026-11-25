import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { renameWithRetryAsync } from "../../../../shared/rename-retry.mjs";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { testDaemonEndpoint } from "../../electron/__tests__/platform.js";
import { provisionedWorkspace } from "./helpers/daemon-fixture.js";
import {
  DAEMON_STATE_APPLICATION_ID,
  DAEMON_STATE_SCHEMA_VERSION,
  DAEMON_STATE_USER_VERSION,
  DAEMON_STATE_USER_VERSION_OFFSET,
  DaemonStateDatabase,
  DaemonStateSchema,
  areWindowsFiletimesCompatibleAtWmiPrecision,
  fromSqliteUserVersion,
  moveAsideLegacyDaemonStateDatabase,
  openDaemonStateDatabase,
  parseWindowsBirthFiletime,
  parseWindowsCimDateTimeToFiletimeUtc,
  runNumberedMigrations,
  toSqliteUserVersion,
  validateDaemonStateShape,
} from "../daemon-state-database.js";
import { WorkDurabilityStore } from "../durability-store.js";
import {
  EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
  EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
  ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
  ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
  ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
  RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND,
} from "../effect-journal/index.js";
import { EphemeralWorkspaceProvisioner } from "../ephemeral-workspace-provisioner.js";
import { ExecutionApprovalPublicationStore } from "../execution-approval-publication-store.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { processBirthState, systemProcessIdentity } from "../process-identity.js";
import { RoomWorkPublicationStore } from "../room-work-publication-store.js";
import { RoomWorkspaceStore } from "../room-workspace-store.js";
import { DaemonFenceLostError } from "../singleton.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";

async function tempDir(prefix: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, cleanup: async () => removeTestDirectory(root) };
}

function sampleEntry(id: string): DaemonManifestEntry {
  return {
    id,
    room_id: "room_v1",
    display_name: `Agent ${id}`,
    provider: "codex",
    model: "gpt-5.3-codex",
    charter: "Keep working.",
    desired_state: "paused",
    observed_state: "paused",
    condition: "none",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "owner",
    created_at: "2026-11-21T00:00:00.000Z",
  };
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

test("fresh current schema enforces application_id, user_version=1005, downgrade-safe table layout, and 1:1 shape checks", async () => {
  const env = await tempDir("letagents-schema-v1-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    assert.equal(DAEMON_STATE_SCHEMA_VERSION, 5);
    assert.equal(DAEMON_STATE_USER_VERSION_OFFSET, 1000);
    assert.equal(DAEMON_STATE_USER_VERSION, 1005);
    assert.equal(toSqliteUserVersion(1), 1001);
    assert.equal(fromSqliteUserVersion(1001), 1);
    assert.equal(toSqliteUserVersion(2), 1002);
    assert.equal(fromSqliteUserVersion(1002), 2);
    assert.equal(toSqliteUserVersion(3), 1003);
    assert.equal(fromSqliteUserVersion(1003), 3);
    assert.equal(toSqliteUserVersion(4), 1004);
    assert.equal(fromSqliteUserVersion(1004), 4);
    assert.equal(toSqliteUserVersion(5), 1005);
    assert.equal(fromSqliteUserVersion(1005), 5);

    const stateDb = await DaemonStateDatabase.open(dbPath);
    try {
      const db = stateDb.connection;
      assert.equal(Number(db.prepare("PRAGMA application_id").get()?.application_id), DAEMON_STATE_APPLICATION_ID);
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      assert.ok(DAEMON_STATE_USER_VERSION > 52, "SQLite user_version must stay above legacy v52 so older released daemons fail closed with zero writes");
      assert.equal(String(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase(), "wal");
      assert.equal(Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys), 1);
      assert.equal(Number(db.prepare("PRAGMA synchronous").get()?.synchronous), 2);
      assert.equal(Number(db.prepare("PRAGMA secure_delete").get()?.secure_delete), 1);
      assert.equal(Number(db.prepare("PRAGMA temp_store").get()?.temp_store), 2);

      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      // Downgrade-safety invariant: schema v1 MUST NOT create `manifest_metadata`.
      // Older released daemons check PRAGMA user_version (1001 > 52) before touching
      // the disk, and omitting `manifest_metadata` guarantees no legacy path can
      // mistake a schema v1 file for a pre-v1 manifest database.
      assert.equal(tables.has("manifest_metadata"), false, "manifest_metadata must not exist in schema v1");
      for (const expected of ["agents", "runs", "inbox_items", "effects", "effect_tombstones", "execution_facts", "daemon_maintenance_state"]) {
        assert.equal(tables.has(expected), true, `expected domain table ${expected}`);
      }
      assert.equal(tables.has("effect_journal"), false, "staging effect_journal table is promoted to effects in schema v3");
      for (const obsolete of [
        "execution_lifecycle_effects",
        "agent_identities",
        "agent_configurations",
        "agent_profiles",
        "runtime_deployments",
        "execution_turns",
        "supervised_agent_inbox",
        "supervised_agent_effects",
        "supervised_agent_effect_tombstones",
      ]) {
        assert.equal(tables.has(obsolete), false, `obsolete table ${obsolete} must be absent in schema v1`);
      }
      validateDaemonStateShape(db);
    } finally {
      stateDb.close();
    }

    // Tamper 1: unexpected extra table fails 1:1 sqlite_master shape check.
    {
      const tampered = new DatabaseSync(dbPath);
      try {
        tampered.exec("CREATE TABLE rogue_table (id TEXT PRIMARY KEY)");
        assert.throws(() => validateDaemonStateShape(tampered), /unexpected table/i);
        tampered.exec("DROP TABLE rogue_table");
      } finally { tampered.close(); }
    }

    // Tamper 2: dropped index fails 1:1 sqlite_master shape check.
    {
      const tampered = new DatabaseSync(dbPath);
      try {
        const indexName = (tampered.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL LIMIT 1").get() as { name: string }).name;
        const indexSql = (tampered.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(indexName) as { sql: string }).sql;
        tampered.exec(`DROP INDEX "${indexName}"`);
        assert.throws(() => validateDaemonStateShape(tampered), /schema mismatch on index/i);
        tampered.exec(indexSql);
      } finally { tampered.close(); }
    }

    // Tamper 3: CHECK violation written with ignore_check_constraints is caught by integrity_check(1).
    {
      const tampered = new DatabaseSync(dbPath);
      try {
        tampered.exec("PRAGMA ignore_check_constraints = ON");
        tampered.exec(`
          INSERT INTO agents(agent_id,sort_order,version,created_by,created_at,display_name,room_id,provider,charter,desired_state,observed_state,condition,image_input)
          VALUES('bad_check',0,1,'owner','2026-11-21T00:00:00.000Z','Bad','room','codex','c','running','idle','none',9)
        `);
        tampered.exec("PRAGMA ignore_check_constraints = OFF");
        assert.throws(() => validateDaemonStateShape(tampered), /integrity/i);
        tampered.exec("DELETE FROM agents WHERE agent_id='bad_check'");
      } finally { tampered.close(); }
    }

    // Tamper 4: foreign-key corruption written with foreign_keys=OFF is caught by foreign_key_check.
    {
      const tampered = new DatabaseSync(dbPath);
      try {
        tampered.exec("PRAGMA foreign_keys = OFF");
        tampered.exec(`
          INSERT INTO activity_events VALUES('missing_agent',0,'2026-11-21T00:00:00.000Z',1,'codex','k','m','s','idle','{}',0,0,NULL)
        `);
        tampered.exec("PRAGMA foreign_keys = ON");
        assert.throws(() => validateDaemonStateShape(tampered), /foreign-key/i);
        tampered.exec("DELETE FROM activity_events WHERE agent_id='missing_agent'");
      } finally { tampered.close(); }
    }
  } finally {
    await env.cleanup();
  }
});

test("legacy DB move-aside stops only exact-birth legacy processes, preserves legacy DB + sidecars intact, and starts clean v1", async () => {
  const env = await tempDir("letagents-legacy-move-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const matchingChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  const mismatchedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    assert.ok(matchingChild.pid && mismatchedChild.pid);
    const matchingBirth = systemProcessIdentity.readBirthIdentity(matchingChild.pid).trim();
    const mismatchedActualBirth = systemProcessIdentity.readBirthIdentity(mismatchedChild.pid).trim();
    assert.equal(processBirthState(matchingChild.pid, matchingBirth), "live");
    assert.equal(processBirthState(mismatchedChild.pid, mismatchedActualBirth), "live");

    // Seed a pre-v1 (legacy v52) SQLite database with runtime_deployments + WAL + .recovery.enc sidecar.
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA application_id = 0;
        PRAGMA user_version = 52;
        CREATE TABLE runtime_deployments (
          agent_id TEXT PRIMARY KEY,
          provider_connection_pid INTEGER,
          provider_process_identity TEXT
        );
        CREATE TABLE legacy_canary (note TEXT NOT NULL);
        INSERT INTO legacy_canary VALUES ('legacy-row-preserved');
      `);
      const mismatchedBirth = process.platform === "win32" ? "win32-ft:1" : "Mon Jan  1 00:00:00 1990";
      legacy.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("legacy_match", matchingChild.pid, matchingBirth);
      legacy.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("legacy_mismatch", mismatchedChild.pid, mismatchedBirth);
    } finally {
      legacy.close();
    }
    await writeFile(`${dbPath}.recovery.enc`, "legacy-encrypted-sidecar", "utf8");
    await protectOwnerPrivate(dbPath, "file", { force: true });

    const opened = await DaemonStateDatabase.open(dbPath);
    try {
      assert.equal(Number(opened.connection.prepare("PRAGMA application_id").get()?.application_id), DAEMON_STATE_APPLICATION_ID);
      assert.equal(Number(opened.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      assert.equal(Number(opened.connection.prepare("SELECT COUNT(*) AS count FROM agents").get()?.count), 0);
    } finally {
      opened.close();
    }

    // Matching legacy child must be stopped; mismatched live child must be untouched.
    assert.equal(await waitForExit(matchingChild, 5_000), true, "exact-birth legacy provider process must be stopped before move-aside");
    assert.notEqual(processBirthState(matchingChild.pid, matchingBirth), "live");
    assert.equal(processBirthState(mismatchedChild.pid, mismatchedActualBirth), "live", "non-matching live process must NOT be killed");

    // Verify intact moved-aside DB + sidecar.
    const entries = await readdir(env.root);
    const archivedBases = entries.filter((name) => /^daemon-state\.sqlite\.legacy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/.test(name));
    assert.equal(archivedBases.length, 1);
    const archivedBase = join(env.root, archivedBases[0]!);
    assert.equal(await readFile(`${archivedBase}.recovery.enc`, "utf8"), "legacy-encrypted-sidecar");
    const archivedDb = new DatabaseSync(archivedBase, { readOnly: true });
    try {
      assert.equal(archivedDb.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(Number(archivedDb.prepare("PRAGMA user_version").get()?.user_version), 52);
      assert.equal(archivedDb.prepare("SELECT note FROM legacy_canary").get()?.note, "legacy-row-preserved");
    } finally {
      archivedDb.close();
    }
  } finally {
    if (matchingChild.exitCode === null && matchingChild.signalCode === null) matchingChild.kill("SIGKILL");
    if (mismatchedChild.exitCode === null && mismatchedChild.signalCode === null) mismatchedChild.kill("SIGKILL");
    await env.cleanup();
  }
});

test("unknown/future modern DBs (application_id=LAD1) and foreign DBs fail closed without modifying or moving aside", async () => {
  const cases = [
    { name: "future modern v6 (user_version=1006)", appId: DAEMON_STATE_APPLICATION_ID, userVersion: DAEMON_STATE_USER_VERSION + 1, table: true, pattern: /Unsupported daemon state schema version/i },
    { name: "offset boundary (user_version=1000)", appId: DAEMON_STATE_APPLICATION_ID, userVersion: DAEMON_STATE_USER_VERSION_OFFSET, table: true, pattern: /Unsupported daemon state schema version/i },
    { name: "pre-offset modern collision (user_version=1)", appId: DAEMON_STATE_APPLICATION_ID, userVersion: 1, table: true, pattern: /Unsupported daemon state schema version/i },
    { name: "modern application_id with user_version=0 and tables", appId: DAEMON_STATE_APPLICATION_ID, userVersion: 0, table: true, pattern: /Unsupported daemon state schema version/i },
    { name: "foreign application_id", appId: 0x12345678, userVersion: 1, table: true, pattern: /Unsupported SQLite database application_id/i },
  ] as const;

  for (const item of cases) {
    const env = await tempDir("letagents-fail-closed-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      const seed = new DatabaseSync(dbPath);
      try {
        seed.exec(`PRAGMA application_id = ${item.appId}; PRAGMA user_version = ${item.userVersion};`);
        if (item.table) seed.exec("CREATE TABLE canary (v TEXT); INSERT INTO canary VALUES ('untouched');");
      } finally { seed.close(); }
      const beforeBytes = await readFile(dbPath);
      const beforeStat = await stat(dbPath);

      await assert.rejects(() => DaemonStateDatabase.open(dbPath), item.pattern, item.name);

      const files = await readdir(env.root);
      assert.equal(files.some((name) => name.includes(".legacy-")), false, `${item.name}: must not move aside`);
      assert.deepEqual(await readFile(dbPath), beforeBytes, `${item.name}: bytes must remain untouched`);
      assert.equal((await stat(dbPath)).mtimeMs, beforeStat.mtimeMs, `${item.name}: file must not be modified`);
    } finally {
      await env.cleanup();
    }
  }
});

test("runNumberedMigrations applies future v2->v3 migrations atomically inside a transaction and rolls back on failure", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new DaemonStateSchema().createSchema(db);
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);

    assert.throws(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        runNumberedMigrations(db, 2, 3, {
          2(conn) {
            conn.exec("CREATE TABLE synthetic_v3 (id TEXT PRIMARY KEY)");
            throw new Error("simulated migration failure");
          },
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }, /simulated migration failure/);
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synthetic_v3'").get(), undefined);

    db.exec("BEGIN IMMEDIATE");
    runNumberedMigrations(db, 2, 3, {
      2(conn) {
        conn.exec("CREATE TABLE synthetic_v3 (id TEXT PRIMARY KEY); INSERT INTO synthetic_v3 VALUES ('ok');");
      },
    });
    db.exec("COMMIT");
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(3));
    assert.equal(db.prepare("SELECT id FROM synthetic_v3").get()?.id, "ok");
  } finally {
    db.close();
  }
});

test("per-agent version optimistic concurrency isolates independent agents and rejects stale versions", async () => {
  const env = await tempDir("letagents-per-agent-cas-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const store = new ManifestStore(dbPath);
  try {
    const initial = await store.write([sampleEntry("agent_a"), sampleEntry("agent_b")]);
    assert.deepEqual(initial.versions, { agent_a: 1, agent_b: 1 });

    // Advance agent_a to version 2.
    const updatedA = await store.replaceEntry(1, { ...sampleEntry("agent_a"), observed_state: "idle" });
    assert.equal(updatedA.version, 2);

    // Updating agent_b with its original version 1 still succeeds without conflicting with agent_a.
    const updatedB = await store.replaceEntry(1, { ...sampleEntry("agent_b"), observed_state: "working" });
    assert.equal(updatedB.version, 2);

    // Stale version 1 on agent_a fails with ManifestConflictError.
    await assert.rejects(
      () => store.replaceEntry(1, { ...sampleEntry("agent_a"), observed_state: "stopped" }),
      ManifestConflictError,
    );
    assert.equal((await store.getEntry("agent_a"))?.observed_state, "idle");
    assert.equal((await store.getEntry("agent_b"))?.observed_state, "working");
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("SupervisorDaemon owns one shared SQLite connection across all stores and publishers and closes it once on stop, handoff, and maintenance", async () => {
  const env = await tempDir("letagents-single-conn-");
  const paths = {
    stateDir: env.root,
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  try {
    // 1. Normal start & stop(): all 4 stores + 3 publishers share the exact same DatabaseSync instance.
    const minimalPort = {
      capabilities: async () => ({ deliveryModes: ["daemon_inbox" as const], resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { throw new Error("unused"); },
      attach: async () => null,
      resume: async () => { throw new Error("unused"); },
      poke: async () => {},
      stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const }),
      onExit: async () => () => {},
      onStream: async () => () => {},
      onExecution: () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", minimalPort);
    let shared: DatabaseSync | undefined;
    try {
      await daemon.start();
      const internals = daemon as unknown as {
        stateDatabase: DaemonStateDatabase | null;
        store: { database: DatabaseSync | null };
        durability: { database: DatabaseSync | null };
        workerBindings: { database: DatabaseSync | null };
        supervisedInbox: { database: DatabaseSync | null };
        executionCapture: { database: DatabaseSync } | null;
        roomWorkPublisher: { database: DatabaseSync; executor: unknown } | null;
        effectExecutor: { hasHandler(kind: string): boolean } | null;
        roomMoves: { effectExecutor: unknown; effectDatabase: DatabaseSync | null };
        runtimeRecovery: { effectExecutor: unknown; effectDatabase: DatabaseSync | null };
        executionDelegations: { approvalPublisher?: { database: DatabaseSync; executor: unknown } | null };
      };
      shared = internals.stateDatabase?.connection;
      assert.ok(shared && shared.isOpen, "daemon must own an open shared connection");
      assert.equal(internals.store.database, shared, "ManifestStore must share the single connection");
      assert.equal(internals.durability.database, shared, "WorkDurabilityStore must share the single connection");
      assert.equal(internals.workerBindings.database, shared, "WorkerBindingStore must share the single connection");
      assert.equal(internals.supervisedInbox.database, shared, "SupervisedAgentInboxStore must share the single connection");
      assert.equal(internals.executionCapture?.database, shared, "ExecutionCaptureCoordinator must share the single connection");
      assert.equal(internals.roomWorkPublisher?.database, shared, "RoomWorkPublisher must share the single connection");
      assert.equal(internals.roomWorkPublisher?.executor, internals.effectExecutor, "RoomWorkPublisher must share the daemon EffectExecutor");
      assert.equal(internals.effectExecutor?.hasHandler("room_work_publish"), true, "daemon EffectExecutor must register room_work_publish");
      assert.equal(internals.effectExecutor?.hasHandler("room_work_grouped_no_reply"), true, "daemon EffectExecutor must register room_work_grouped_no_reply");
      assert.equal(internals.executionDelegations.approvalPublisher?.database, shared, "ExecutionApprovalPublisher must share the single connection");
      assert.equal(internals.runtimeRecovery.effectDatabase, shared, "RuntimeRecoveryCoordinator must share the single connection");
      assert.equal(internals.runtimeRecovery.effectExecutor, internals.effectExecutor, "RuntimeRecoveryCoordinator must share the process-wide EffectExecutor");
      assert.equal(internals.effectExecutor?.hasHandler(RUNTIME_RECOVERY_END_WORKER_SESSION_EFFECT_KIND), true);
      assert.equal(internals.roomMoves.effectDatabase, shared, "RoomMoveCoordinator must share the single connection");
      assert.equal(internals.roomMoves.effectExecutor, internals.effectExecutor, "RoomMoveCoordinator must share the process-wide EffectExecutor");
      assert.equal(internals.effectExecutor?.hasHandler(ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND), true);
      assert.equal(internals.effectExecutor?.hasHandler(ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND), true);
      assert.equal(internals.effectExecutor?.hasHandler(ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND), true);
      assert.equal(
        internals.executionDelegations.approvalPublisher?.executor,
        internals.effectExecutor,
        "ExecutionApprovalPublisher must share the process-wide EffectExecutor",
      );
      assert.equal(internals.effectExecutor?.hasHandler(EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND), true);
      assert.equal(internals.effectExecutor?.hasHandler(EXECUTION_APPROVAL_CLOSE_EFFECT_KIND), true);
    } finally {
      await daemon.stop().catch(() => undefined);
    }
    assert.equal(shared?.isOpen, false, "stop() must close the shared connection");

    // 2. stopForHandoff() also closes the shared connection cleanly.
    const handoffDaemon = new SupervisorDaemon(paths, "darwin");
    let handoffShared: DatabaseSync | undefined;
    try {
      await handoffDaemon.start();
      handoffShared = (handoffDaemon as unknown as { stateDatabase: DaemonStateDatabase | null }).stateDatabase?.connection;
      assert.ok(handoffShared && handoffShared.isOpen);
    } finally {
      await (handoffDaemon as unknown as { stopForHandoff(): Promise<void> }).stopForHandoff().catch(() => undefined);
    }
    assert.equal(handoffShared?.isOpen, false, "stopForHandoff() must close the shared connection");

    // 3. Maintenance mode opens the shared connection and closes it cleanly on stop().
    const maintDaemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, undefined, {}, undefined, {
      maintenance: { reason: "test-maintenance", startedAt: "2026-11-21T00:00:00.000Z" },
    });
    let maintShared: DatabaseSync | undefined;
    try {
      await maintDaemon.start();
      maintShared = (maintDaemon as unknown as { stateDatabase: DaemonStateDatabase | null }).stateDatabase?.connection;
      assert.ok(maintShared && maintShared.isOpen);
    } finally {
      await maintDaemon.stop().catch(() => undefined);
    }
    assert.equal(maintShared?.isOpen, false, "maintenance stop() must close the shared connection");
  } finally {
    await env.cleanup();
  }
});

test("in-transaction synchronous write fence blocks stale writes across every store and rolls back cleanly", async () => {
  const env = await tempDir("letagents-write-fence-");
  const paths = {
    stateDir: env.root,
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      singleton: { currentGeneration: number; generationPath: string; assertCurrentSync(): void };
      stateDatabase: DaemonStateDatabase;
      store: ManifestStore;
      durability: WorkDurabilityStore;
      workerBindings: WorkerBindingStore;
      supervisedInbox: SupervisedAgentInboxStore;
    };
    const agent = sampleEntry("fenced_agent");
    await internals.store.createEntry(agent);
    const generation = internals.singleton.currentGeneration;
    const workspace = await provisionedWorkspace(env.root, "fenced_agent");
    const createdAttempt = await internals.durability.createAttempt({
      taskId: "fenced_agent",
      leaseId: "fenced_agent",
      leaseEpoch: 1,
      workspacePath: workspace.path,
      workAttemptId: workspace.id,
    });
    const fencedAttemptId = createdAttempt.work_attempt_id;

    // Register a shadow runtime before fencing so we can test ExecutionShadowStore.ingest too.
    const runtimeGenerationId = executionRuntimeStorageIdentity("fenced_agent", "gen-1", "codex_app_server", 4321, "birth-1");
    const shadow = new ExecutionShadowStore(internals.stateDatabase.connection, {
      assertWriteFence: () => internals.singleton.assertCurrentSync(),
    });
    const workPubStore = new RoomWorkPublicationStore(
      internals.stateDatabase.connection,
      () => internals.singleton.assertCurrentSync(),
    );
    const workspaceStore = new RoomWorkspaceStore(
      internals.stateDatabase.connection,
      () => internals.singleton.assertCurrentSync(),
    );
    const approvalPubStore = new ExecutionApprovalPublicationStore(
      internals.stateDatabase.connection,
      () => internals.singleton.assertCurrentSync(),
    );
    // Pin one room_work_publications row before fencing so workspace capture FK exists.
    workPubStore.pin({
      agentId: "fenced_agent",
      roomId: "room_v1",
      apiOrigin: "https://letagents.test",
      agentKey: "owner/fenced",
      agentInstanceId: "instance-1",
      hostId: "host-1",
      installationId: "install-1",
      sourceSessionId: "session-1",
    }, ["msg_1"]);
    shadow.registerRuntime({
      agentId: "fenced_agent",
      executionGenerationId: "gen-1",
      runtimeGenerationId,
      provider: "codex",
      authorityMode: "typed",
      configRevision: 1,
      createdAtMs: 100,
    });
    const observer = shadow.bindObserver({
      agentId: "fenced_agent",
      subjectRuntimeGenerationId: runtimeGenerationId,
      observerRuntimeGenerationId: runtimeGenerationId,
      sourceId: "source-1",
      daemonGenerationId: String(generation),
      expectedEpoch: 0,
      boundAtMs: 100,
    });

    // Advance the singleton generation on disk behind this daemon's back.
    await writeFile(internals.singleton.generationPath, `${generation + 1}\n`, "utf8");

    await assert.rejects(
      () => internals.store.replaceEntry(1, { ...agent, observed_state: "idle" }),
      DaemonFenceLostError,
      "ManifestStore write must fail closed inside BEGIN IMMEDIATE",
    );
    await assert.rejects(
      () => internals.workerBindings.bind({
        entry_id: "fenced_agent",
        room_id: "room_v1",
        work_attempt_id: "attempt-1",
        execution_generation_id: "gen-1",
        agent_session_id: "session-1",
        agent_session_token: "secret-1",
        api_url: "https://letagents.test",
      }),
      DaemonFenceLostError,
      "WorkerBindingStore write must fail closed inside BEGIN IMMEDIATE",
    );
    await assert.rejects(
      () => internals.supervisedInbox.ingestPoll({
        agent_id: "fenced_agent",
        room_id: "room_v1",
        last_observed_message_id: "msg_1",
        messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1" }, activation: {} }],
      }),
      DaemonFenceLostError,
      "SupervisedAgentInboxStore write must fail closed inside BEGIN IMMEDIATE",
    );
    await assert.rejects(
      () => internals.durability.startGeneration(fencedAttemptId, "daemon-provider", generation),
      DaemonFenceLostError,
      "WorkDurabilityStore write must fail closed inside BEGIN IMMEDIATE",
    );
    assert.throws(
      () => shadow.ingest("source-1", observer, {
        factId: "fact-after-fence",
        agentId: "fenced_agent",
        executionGenerationId: "gen-1",
        runtimeGenerationId,
        observerEpoch: 1,
        sourceSequence: 1,
        observedAtMs: 200,
        domain: "runtime",
        kind: "state_changed",
        state: "ready",
        sideEffects: "none",
      }),
      DaemonFenceLostError,
      "ExecutionShadowStore.ingest must fail closed inside BEGIN IMMEDIATE",
    );
    assert.throws(
      () => workPubStore.pin({
        agentId: "fenced_agent",
        roomId: "room_v1",
        apiOrigin: "https://letagents.test",
        agentKey: "owner/fenced",
        agentInstanceId: "instance-1",
        hostId: "host-1",
        installationId: "install-1",
        sourceSessionId: "session-1",
      }, ["msg_2"]),
      DaemonFenceLostError,
      "RoomWorkPublicationStore write must fail closed inside BEGIN IMMEDIATE",
    );
    assert.throws(
      () => workspaceStore.begin({
        agentId: "fenced_agent",
        roomId: "room_v1",
        sourceMessageId: "msg_1",
        workAttemptId: fencedAttemptId,
        inboxItemId: "inbox-1",
      }),
      DaemonFenceLostError,
      "RoomWorkspaceStore write must fail closed inside BEGIN IMMEDIATE",
    );
    const hex64 = "a".repeat(64);
    assert.throws(
      () => approvalPubStore.pin({
        agentId: "fenced_agent",
        roomId: "room_v1",
        apiOrigin: "https://letagents.test",
        agentKey: "owner/fenced",
        agentInstanceId: "instance-1",
        hostId: "host-1",
        installationId: "install-1",
        sourceSessionId: "session-1",
        sourceMessageId: "msg_1",
        inboxItemId: "inbox-1",
        workAttemptId: fencedAttemptId,
        delegationInstanceId: "del-1",
        delegationRevision: 1,
        delegationScopeSha256: hex64,
        approverAccountId: "acct-1",
        expected: {
          requestId: "req-1",
          requestVersion: 1,
          requestSha256: hex64,
          agentId: "fenced_agent",
          roomId: "room_v1",
          executionGenerationId: "gen-1",
          runtimeGenerationId,
          turnId: "turn-1",
          providerContinuationId: "cont-1",
          providerTurnId: "pturn-1",
          connectionId: "conn-1",
          nativeRequestId: "nreq-1",
        },
        projectionSha256: hex64,
        producedAtMs: 100,
        expiresAtMs: 200,
      }),
      DaemonFenceLostError,
      "ExecutionApprovalPublicationStore write must fail closed inside BEGIN IMMEDIATE",
    );

    // Verify zero partial writes committed across any table.
    const db = internals.stateDatabase.connection;
    assert.equal(db.prepare("SELECT observed_state FROM agents WHERE agent_id='fenced_agent'").get()?.observed_state, "paused");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM worker_session_bindings").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM work_attempt_executions").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM room_work_publications").get()?.n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM room_workspace_captures").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM execution_approval_publications").get()?.n), 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("fenced transactions roll back synchronously inside commit() before rejecting so shared-connection continuations never see an open transaction", async () => {
  const env = await tempDir("letagents-sync-rollback-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const db = stateDb.connection;
  const manifest = new ManifestStore(dbPath);
  const inbox = new SupervisedAgentInboxStore(dbPath);
  manifest.attachDatabase(db);
  inbox.attachDatabase(db);
  try {
    await manifest.createEntry(sampleEntry("agent_rollback"));

    let probeCounter = 0;
    const makeAsyncUnwindFence = (label: string) => async (commit: () => Promise<void>): Promise<void> => {
      await Promise.resolve();
      let seenOpen = false;
      try {
        await commit();
      } finally {
        // Every microtask after commit() rejects MUST see db.isTransaction === false,
        // and unrelated writes on the same connection MUST commit and survive.
        for (let tick = 0; tick < 3; tick += 1) {
          if (db.isTransaction) seenOpen = true;
          await Promise.resolve();
        }
        assert.equal(seenOpen, false, `${label}: database.isTransaction must never be true after commit() rejects`);
        const key = `surviving-${label}-${++probeCounter}`;
        db.prepare("INSERT INTO daemon_maintenance_state(key,value_json,updated_at) VALUES(?,?,?)")
          .run(key, JSON.stringify({ ok: true }), "2026-11-21T00:00:00.000Z");
        db.exec("BEGIN IMMEDIATE");
        db.prepare("INSERT INTO daemon_maintenance_state(key,value_json,updated_at) VALUES(?,?,?)")
          .run(`${key}-tx`, JSON.stringify({ tx: true }), "2026-11-21T00:00:00.000Z");
        db.exec("COMMIT");
      }
    };

    // 1. ManifestStore.replaceEntry (writeAgent) throws ManifestConflictError inside BEGIN IMMEDIATE.
    await assert.rejects(
      () => manifest.replaceEntry(99, { ...sampleEntry("agent_rollback"), observed_state: "idle" }, makeAsyncUnwindFence("writeAgent")),
      ManifestConflictError,
    );
    // 2. ManifestStore.replaceEntriesBatch (writeOperationalJournal) throws ManifestConflictError inside BEGIN IMMEDIATE.
    await assert.rejects(
      () => manifest.replaceEntriesBatch({ agent_rollback: 99 }, [{ ...sampleEntry("agent_rollback"), observed_state: "idle" }], makeAsyncUnwindFence("writeOperationalJournal")),
      ManifestConflictError,
    );
    // 3. ManifestStore.createEntry throws ManifestConflictError on duplicate id inside BEGIN IMMEDIATE.
    await assert.rejects(
      () => manifest.createEntry(sampleEntry("agent_rollback"), makeAsyncUnwindFence("createEntry")),
      ManifestConflictError,
    );
    // 4. ManifestStore.updateAgentConfiguration throws when writeFence fails inside BEGIN IMMEDIATE.
    manifest.attachDatabase(db, () => { throw new DaemonFenceLostError("stale-gen"); });
    await assert.rejects(
      () => manifest.updateAgentConfiguration(1, {
        agentId: "agent_rollback",
        expectedRevision: 1,
        model: null,
        reasoningEffort: null,
        charter: "changed",
        permissionProfileId: null,
        providerLaunchPolicy: null,
        imageInput: false,
      }, makeAsyncUnwindFence("updateAgentConfiguration")),
      DaemonFenceLostError,
    );
    // 5. ManifestStore.write throws when writeFence fails inside BEGIN IMMEDIATE.
    await assert.rejects(
      () => manifest.write([sampleEntry("agent_rollback")], makeAsyncUnwindFence("write")),
      DaemonFenceLostError,
    );
    // 6. ManifestStore.setAgentLiveSharing (writeLiveSharing) throws when writeFence fails inside BEGIN IMMEDIATE.
    await assert.rejects(
      () => manifest.setAgentLiveSharing({ agentId: "agent_rollback", enabled: true }, makeAsyncUnwindFence("writeLiveSharing")),
      DaemonFenceLostError,
    );
    // 7. ManifestStore.prepareRoomMove throws when writeFence fails inside BEGIN IMMEDIATE.
    await assert.rejects(
      () => manifest.prepareRoomMove({
        operation_id: "move-1",
        request_id: "req-1",
        agent_id: "agent_rollback",
        source_room_id: "room_v1",
        destination_room_id: "room_v2",
        daemon_generation: 1,
        work_attempt_id: null,
        execution_generation_id: null,
        agent_session_id: null,
        activating_inbox_item_id: null,
        provider_turn_id: null,
        effect_id: null,
        phase: "prepared",
      }, makeAsyncUnwindFence("prepareRoomMove")),
      DaemonFenceLostError,
    );
    // 8. SupervisedAgentInboxStore.ingestPoll (transactionFenced) throws when writeFence fails inside BEGIN IMMEDIATE.
    inbox.attachDatabase(db, () => { throw new DaemonFenceLostError("stale-inbox"); });
    await assert.rejects(
      () => inbox.ingestPoll({
        agent_id: "agent_rollback",
        room_id: "room_v1",
        last_observed_message_id: "msg_1",
        messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1" }, activation: {} }],
      }, makeAsyncUnwindFence("inboxTransactionFenced")),
      DaemonFenceLostError,
    );

    // Every single unrelated write performed during rejection unwind microtasks must have survived!
    assert.equal(db.isTransaction, false);
    const survived = Number(db.prepare("SELECT COUNT(*) AS n FROM daemon_maintenance_state WHERE key LIKE 'surviving-%'").get()?.n);
    assert.equal(survived, probeCounter * 2, "all concurrent writes during rejection unwind must remain committed");
  } finally {
    await manifest.close();
    await inbox.close();
    stateDb.close();
    await env.cleanup();
  }
});

function createSigkilledUncheckpointedLegacyDb(dbPath: string): void {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA application_id = 0; PRAGMA user_version = 52;");
    db.exec("CREATE TABLE canary (id INTEGER PRIMARY KEY, val TEXT NOT NULL);");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);");
    db.exec("INSERT INTO canary VALUES (1, 'wal-one'), (2, 'wal-two'), (3, 'wal-three');");
    db.exec("INSERT INTO notes VALUES (10, 'note-a'), (20, 'note-b');");
    process.kill(process.pid, "SIGKILL");
  `;
  const res = spawnSync(process.execPath, ["-e", script], { stdio: "ignore" });
  assert.ok(res.signal === "SIGKILL" || res.status !== 0, "seed child must terminate abruptly to retain uncheckpointed WAL");
}

test("legacy DB move-aside checkpoints uncheckpointed WAL after SIGKILL, preserves row counts, recovers across rename failures, and fails closed on orphaned WAL", async () => {
  // 1. Complete archive from an uncheckpointed WAL after SIGKILL with exact row counts before and after.
  {
    const env = await tempDir("letagents-legacy-wal-ok-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      createSigkilledUncheckpointedLegacyDb(dbPath);
      const walBefore = await stat(`${dbPath}-wal`);
      assert.ok(walBefore.size > 0, "fixture must start with non-empty uncheckpointed -wal");
      await writeFile(`${dbPath}.recovery.enc`, "enc-bytes", "utf8");
      await protectOwnerPrivate(dbPath, "file", { force: true });

      const opened = await DaemonStateDatabase.open(dbPath);
      try {
        assert.equal(Number(opened.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      } finally {
        opened.close();
      }

      const entries = await readdir(env.root);
      const archived = entries.filter((name) => /^daemon-state\.sqlite\.legacy-.*Z(?:-\d+)?$/.test(name));
      assert.equal(archived.length, 1);
      const archivedPath = join(env.root, archived[0]!);
      assert.equal(entries.includes(`${archived[0]!}-wal`), false, "checkpointed archive must not rely on a -wal sidecar");
      assert.equal(await readFile(`${archivedPath}.recovery.enc`, "utf8"), "enc-bytes");

      const verify = new DatabaseSync(archivedPath, { readOnly: true });
      try {
        assert.equal(verify.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
        assert.equal(Number(verify.prepare("PRAGMA user_version").get()?.user_version), 52);
        assert.equal(Number(verify.prepare("SELECT COUNT(*) AS n FROM canary").get()?.n), 3);
        assert.equal(Number(verify.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n), 2);
      } finally {
        verify.close();
      }
    } finally {
      await env.cleanup();
    }
  }

  // 2. Rename failure (injected EIO on main file rename) rolls back sidecar rename and preserves complete archive on retry.
  {
    const env = await tempDir("letagents-legacy-wal-eio-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      createSigkilledUncheckpointedLegacyDb(dbPath);
      await writeFile(`${dbPath}.recovery.enc`, "enc-rollback", "utf8");
      await protectOwnerPrivate(dbPath, "file", { force: true });

      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          renameFile: async (from, to) => {
            if (from === dbPath) throw Object.assign(new Error("EIO: injected main rename error"), { code: "EIO" });
            await renameWithRetryAsync(from, to);
          },
        }),
        /injected main rename error/,
      );

      // Original DB and .recovery.enc must still be in place with all canary rows readable!
      assert.equal(await readFile(`${dbPath}.recovery.enc`, "utf8"), "enc-rollback");
      const stillThere = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(Number(stillThere.prepare("SELECT COUNT(*) AS n FROM canary").get()?.n), 3);
      } finally {
        stillThere.close();
      }

      // Subsequent normal startup archives the intact DB and opens fresh schema v1.
      const opened = await DaemonStateDatabase.open(dbPath);
      try {
        assert.equal(Number(opened.connection.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);
      } finally {
        opened.close();
      }
      const entries = await readdir(env.root);
      const archived = entries.filter((name) => /^daemon-state\.sqlite\.legacy-.*Z(?:-\d+)?$/.test(name));
      assert.equal(archived.length, 1);
      const verify = new DatabaseSync(join(env.root, archived[0]!), { readOnly: true });
      try {
        assert.equal(Number(verify.prepare("SELECT COUNT(*) AS n FROM canary").get()?.n), 3);
        assert.equal(Number(verify.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n), 2);
      } finally {
        verify.close();
      }
    } finally {
      await env.cleanup();
    }
  }

  // 3. Orphaned non-empty -wal without main DB file fails closed so SQLite never deletes stranded WAL data.
  {
    const env = await tempDir("letagents-orphaned-wal-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      createSigkilledUncheckpointedLegacyDb(dbPath);
      const walSize = (await stat(`${dbPath}-wal`)).size;
      assert.ok(walSize > 0);
      // Simulate an external/manual partial move of only the main file.
      await rename(dbPath, `${dbPath}.manual-partial`);

      await assert.rejects(
        () => DaemonStateDatabase.open(dbPath),
        /orphaned non-empty -wal/i,
      );
      // Stranded -wal must remain untouched on disk!
      assert.equal((await stat(`${dbPath}-wal`)).size, walSize);
    } finally {
      await env.cleanup();
    }
  }
});

test("legacy DB move-aside fails closed before archiving when provider termination fails, birth is unknown, or Windows kill is unkillable/incomplete", async () => {
  const env = await tempDir("letagents-legacy-stop-fail-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    const birth = systemProcessIdentity.readBirthIdentity(child.pid).trim();
    assert.equal(processBirthState(child.pid, birth), "live");

    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        PRAGMA application_id = 0;
        PRAGMA user_version = 52;
        CREATE TABLE runtime_deployments (
          agent_id TEXT PRIMARY KEY,
          provider_connection_pid INTEGER,
          provider_process_identity TEXT
        );
      `);
      seed.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("live_legacy", child.pid, birth);
    } finally {
      seed.close();
    }
    await protectOwnerPrivate(dbPath, "file", { force: true });

    // 1. POSIX failed signalling: signalProcessTree returns false -> fails closed before any rename, child stays live.
    await assert.rejects(
      () => moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "darwin",
        signalProcessTree: () => false,
        graceMs: 50,
        killWaitMs: 50,
      }),
      /could not be confirmed stopped/i,
    );
    assert.equal(processBirthState(child.pid, birth), "live");
    assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);

    // 2. Unresolved birth identity ("unknown"): fails closed without sending any signal.
    let signalled = false;
    await assert.rejects(
      () => moveAsideLegacyDaemonStateDatabase(dbPath, {
        birthState: () => "unknown",
        signalProcessTree: () => { signalled = true; return true; },
      }),
      /birth identity could not be resolved/i,
    );
    assert.equal(signalled, false, "must never signal a process whose birth is unknown");
    assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);

    // 3. Windows signalling outcomes: "unkillable", "none", and "ended"-but-still-live all fail closed.
    await assert.rejects(
      () => moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "live",
        signalProcessTreeOutcome: () => "unkillable",
      }),
      /unkillable/i,
    );
    await assert.rejects(
      () => moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "live",
        signalProcessTreeOutcome: () => "none",
      }),
      /failed to stop legacy provider process/i,
    );
    await assert.rejects(
      () => moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "live",
        signalProcessTreeOutcome: () => "ended",
        killWaitMs: 60,
      }),
      /remained live after Windows termination/i,
    );
    assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);

    // 4. Windows "ended" followed by birth transitioning to "gone" succeeds and archives the DB.
    let winPolls = 0;
    const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
      platform: "win32",
      birthState: () => (++winPolls === 1 ? "live" : "gone"),
      signalProcessTreeOutcome: () => "ended",
      killWaitMs: 200,
    });
    assert.ok(archived && archived.includes(".legacy-"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await env.cleanup();
  }
});

test("presentation-only recordActivityBatch advances only the affected agent version and rejects stale replaceEntry snapshots", async () => {
  const env = await tempDir("letagents-activity-cas-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const store = new ManifestStore(dbPath);
  try {
    await store.write([sampleEntry("agent_a"), sampleEntry("agent_b")]);
    const saved = await store.getEntryWithVersion("agent_a");
    assert.ok(saved);
    assert.equal(saved.version, 1);

    const makeEvent = (sequence: number) => ({
      observed_at: "2026-11-21T00:00:01.000Z",
      sequence,
      provider: "codex" as const,
      kind: "turn_item" as const,
      method: "item/updated",
      summary: `event-${sequence}`,
      status: "working" as const,
      payload: { seq: sequence },
      payload_truncated: false,
      payload_redacted: false,
      durable_payload_ref: null,
    });

    // Presentation-only batch (runtimeUpdate: null) MUST bump agent_a's version without touching agent_b.
    const batch1 = await store.recordActivityBatch([{
      agentId: "agent_a",
      event: makeEvent(1),
      runtimeUpdate: null,
      limit: 200,
    }]);
    assert.equal(batch1.written, 1);

    const afterBatch1A = await store.getEntryWithVersion("agent_a");
    const afterBatch1B = await store.getEntryWithVersion("agent_b");
    assert.equal(afterBatch1A?.version, 2, "presentation-only activity batch must advance agent_a version");
    assert.equal(afterBatch1B?.version, 1, "unrelated agent_b version must remain unchanged");

    // Stale replacement at version 1 must be rejected and committed activity preserved.
    await assert.rejects(
      () => store.replaceEntry(saved.version, saved.entry),
      ManifestConflictError,
    );
    assert.equal((await store.getEntry("agent_a"))?.activity?.length, 1);

    // Batch with runtimeUpdate bumps version by exactly 1 (no double-increment).
    const batch2 = await store.recordActivityBatch([{
      agentId: "agent_a",
      event: makeEvent(2),
      runtimeUpdate: {
        observedState: "working",
        nativeLiveness: { state: "active", observed_at: "2026-11-21T00:00:02.000Z", detail: "active" },
      },
      limit: 200,
    }]);
    assert.equal(batch2.written, 1);
    assert.equal((await store.getEntryWithVersion("agent_a"))?.version, 3);

    // Single appendActivityOnly bumps version by exactly 1 (no double-increment).
    const appended = await store.appendActivityOnly(3, "agent_a", makeEvent(3), 200);
    assert.equal(appended.version, 4);
    assert.equal((await store.getEntryWithVersion("agent_a"))?.version, 4);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("legacy DB move-aside fails closed on unexpected runtime_deployments SQLite read errors without archiving or skipping live providers", async () => {
  const env = await tempDir("letagents-legacy-read-err-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    assert.ok(child.pid);
    const birth = systemProcessIdentity.readBirthIdentity(child.pid).trim();
    assert.equal(processBirthState(child.pid, birth), "live");

    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        PRAGMA application_id = 0;
        PRAGMA user_version = 52;
        CREATE TABLE runtime_deployments (
          agent_id TEXT PRIMARY KEY,
          provider_connection_pid INTEGER,
          provider_process_identity TEXT
        );
      `);
      seed.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("live_io_err", child.pid, birth);
    } finally {
      seed.close();
    }
    await protectOwnerPrivate(dbPath, "file", { force: true });

    DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
      if (sql.includes("FROM runtime_deployments")) {
        throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 });
      }
      return originalPrepare.call(this, sql);
    };

    await assert.rejects(
      () => moveAsideLegacyDaemonStateDatabase(dbPath),
      /disk I\/O error/i,
    );
    assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false,
      "unexpected inspection error must not archive the database");
    assert.ok((await stat(dbPath)).isFile(), "original legacy database must remain in place");
    assert.equal(processBirthState(child.pid, birth), "live", "live provider must remain tracked until inspection succeeds");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await env.cleanup();
  }
});

test("legacy DB move-aside resolves cross-account POSIX PID reuse via verified ps birth while failing closed on matching birth or ps errors", async () => {
  const seedLegacyWithRuntime = async (dbPath: string, pid: number, birth: string) => {
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        PRAGMA application_id = 0;
        PRAGMA user_version = 52;
        CREATE TABLE runtime_deployments (
          agent_id TEXT PRIMARY KEY,
          provider_connection_pid INTEGER,
          provider_process_identity TEXT
        );
      `);
      seed.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("legacy_agent", pid, birth);
    } finally {
      seed.close();
    }
    await protectOwnerPrivate(dbPath, "file", { force: true });
  };

  // 1. Live macOS proof: recorded PID 1 (launchd, EPERM on kill(0)) with an older birth resolves via real /bin/ps and moves cleanly.
  if (process.platform === "darwin") {
    const env = await tempDir("letagents-legacy-launchd-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWithRuntime(dbPath, 1, "Mon Jan  1 00:00:00 1990");
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath);
      assert.ok(archived && archived.includes(".legacy-"), "PID 1 (launchd) with a different birth must not block legacy reset");
    } finally {
      await env.cleanup();
    }
  }

  // 2. EPERM + verified different ps birth (root/other account) -> gone, moves cleanly without signalling.
  {
    const env = await tempDir("letagents-posix-eperm-diff-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWithRuntime(dbPath, 1, "Mon Jan  1 00:00:00 1990");
      let signalled = false;
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "darwin",
        birthState: () => "unknown",
        probePid: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
        readPosixBirth: () => ({ kind: "birth", birth: "Fri Oct 30 03:28:39 2026" }),
        signalProcessTree: () => { signalled = true; return true; },
      });
      assert.ok(archived && archived.includes(".legacy-"));
      assert.equal(signalled, false);
    } finally {
      await env.cleanup();
    }
  }

  // 3. EPERM + matching ps birth -> stays unknown and refuses reset.
  {
    const env = await tempDir("letagents-posix-eperm-same-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWithRuntime(dbPath, 500, "Fri Oct 30 03:28:39 2026");
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "darwin",
          birthState: () => "unknown",
          probePid: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
          readPosixBirth: () => ({ kind: "birth", birth: "Fri Oct 30 03:28:39 2026" }),
        }),
        /birth identity could not be resolved/i,
      );
      assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);
    } finally {
      await env.cleanup();
    }
  }

  // 4. EPERM + ps absent (exited between kill(0) and ps) + ESRCH re-probe -> gone, moves cleanly.
  {
    const env = await tempDir("letagents-posix-eperm-absent-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWithRuntime(dbPath, 501, "Mon Jan  1 00:00:00 1990");
      let probes = 0;
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "darwin",
        birthState: () => "unknown",
        probePid: () => {
          probes += 1;
          throw Object.assign(new Error(probes === 1 ? "EPERM" : "ESRCH"), { code: probes === 1 ? "EPERM" : "ESRCH" });
        },
        readPosixBirth: () => ({ kind: "absent" }),
      });
      assert.ok(archived && archived.includes(".legacy-"));
      assert.equal(probes, 2);
    } finally {
      await env.cleanup();
    }
  }

  // 5. EPERM + ps timeout/error (unreadable birth) -> fails closed (no inference from EPERM alone).
  {
    const env = await tempDir("letagents-posix-eperm-err-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWithRuntime(dbPath, 502, "Mon Jan  1 00:00:00 1990");
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "darwin",
          birthState: () => "unknown",
          probePid: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
          readPosixBirth: () => ({ kind: "error" }),
        }),
        /birth identity could not be resolved/i,
      );
      assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);
    } finally {
      await env.cleanup();
    }
  }

  // 6. Wrong-platform birth string on an absent PID (ESRCH) -> gone, moves cleanly; on a live PID -> fails closed.
  {
    const env = await tempDir("letagents-posix-bad-birth-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWithRuntime(dbPath, 503, "win32-ft:134378009191465763");
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "darwin",
          birthState: () => "unknown",
          probePid: () => {},
          readPosixBirth: () => ({ kind: "birth", birth: "Fri Oct 30 03:28:39 2026" }),
        }),
        /birth identity could not be resolved/i,
      );
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "darwin",
        birthState: () => "unknown",
        probePid: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); },
      });
      assert.ok(archived && archived.includes(".legacy-"));
    } finally {
      await env.cleanup();
    }
  }
});

test("legacy DB move-aside Windows WMI fallback preserves UTC offsets and microsecond precision, batches queries, and fails closed on compatible or invalid timestamps", async () => {
  // 1. Exact BigInt CIM_DATETIME parsing + microsecond precision comparator (CreekPeak's measured System(4) example).
  const recordedSystem4 = parseWindowsBirthFiletime("win32-ft:134378009191465763");
  const wmiSystem4UtcPlus1 = parseWindowsCimDateTimeToFiletimeUtc("20261030032839.146576+060");
  assert.equal(recordedSystem4, 134378009191465763n);
  assert.equal(wmiSystem4UtcPlus1, 134378009191465760n);
  assert.equal(areWindowsFiletimesCompatibleAtWmiPrecision(recordedSystem4!, wmiSystem4UtcPlus1!), true,
    "100-ns helper value vs truncated microsecond WMI value of the same process must be compatible");
  assert.equal(areWindowsFiletimesCompatibleAtWmiPrecision(134378009191465769n, 134378009191465770n), true,
    "1-tick rounding boundary must stay compatible");
  assert.equal(areWindowsFiletimesCompatibleAtWmiPrecision(134378009191465763n, 134378009191465740n), false,
    "genuinely different birth (>1 microsecond apart) must not be compatible");

  // UTC offset preservation across negative, positive, and half-hour offsets for the exact same UTC instant.
  assert.equal(parseWindowsCimDateTimeToFiletimeUtc("20261030022839.146576+000"), wmiSystem4UtcPlus1);
  assert.equal(parseWindowsCimDateTimeToFiletimeUtc("20261029212839.146576-300"), wmiSystem4UtcPlus1);
  assert.equal(parseWindowsCimDateTimeToFiletimeUtc("20261030075839.146576+330"), wmiSystem4UtcPlus1);
  assert.equal(parseWindowsCimDateTimeToFiletimeUtc("20260230032839.146576+060"), null, "invalid calendar date must fail closed");
  assert.equal(parseWindowsCimDateTimeToFiletimeUtc("2026-10-30T03:28:39.1465760"), null, "missing offset must fail closed");
  assert.equal(parseWindowsCimDateTimeToFiletimeUtc("not-a-timestamp"), null);

  const seedLegacyWindowsRuntimes = async (dbPath: string, entries: Array<{ id: string; pid: number; birth: string }>) => {
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        PRAGMA application_id = 0;
        PRAGMA user_version = 52;
        CREATE TABLE runtime_deployments (
          agent_id TEXT PRIMARY KEY,
          provider_connection_pid INTEGER,
          provider_process_identity TEXT
        );
      `);
      for (const item of entries) {
        seed.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run(item.id, item.pid, item.birth);
      }
    } finally {
      seed.close();
    }
    await protectOwnerPrivate(dbPath, "file", { force: true });
  };

  // 2. Live Windows proof: recorded System (PID 4) with an older birth resolves via helper/WMI without blocking reset.
  if (process.platform === "win32") {
    const env = await tempDir("letagents-legacy-win-sys4-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWindowsRuntimes(dbPath, [{ id: "win_sys4", pid: 4, birth: "win32-ft:130000000000000000" }]);
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath);
      assert.ok(archived && archived.includes(".legacy-"), "Windows System (PID 4) with a different birth must not block legacy reset");
    } finally {
      await env.cleanup();
    }
  }

  // 3. Multiple unresolved system PIDs (System 4, csrss 512, lsass 888) resolved in ONE batched WMI call with genuinely different births -> moves cleanly.
  {
    const env = await tempDir("letagents-win-wmi-batch-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWindowsRuntimes(dbPath, [
        { id: "a1", pid: 4, birth: "win32-ft:130000000000000000" },
        { id: "a2", pid: 512, birth: "win32-ft:130000000000000000" },
        { id: "a3", pid: 888, birth: "win32-ft:130000000000000000" },
      ]);
      let wmiCalls = 0;
      let queriedPids: readonly number[] = [];
      let signalled = false;
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "unknown",
        checkWindowsProcessAbsent: () => false,
        queryWindowsWmiCreations: (pids) => {
          wmiCalls += 1;
          queriedPids = pids;
          return new Map([
            [4, "20261030032839.146576+060"],
            [512, "20261030032840.000000+060"],
            [888, "20261030032841.000000+060"],
          ]);
        },
        signalProcessTreeOutcome: () => { signalled = true; return "ended"; },
      });
      assert.ok(archived && archived.includes(".legacy-"));
      assert.equal(wmiCalls, 1, "all unresolved Windows PIDs must share one batched WMI query");
      assert.deepEqual([...queriedPids].sort((a, b) => a - b), [4, 512, 888]);
      assert.equal(signalled, false);
    } finally {
      await env.cleanup();
    }
  }

  // 3. Compatible WMI timestamp (CreekPeak's precision example) -> stays unresolved and refuses reset.
  {
    const env = await tempDir("letagents-win-wmi-compatible-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWindowsRuntimes(dbPath, [
        { id: "same_proc", pid: 4, birth: "win32-ft:134378009191465763" },
      ]);
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "win32",
          birthState: () => "unknown",
          checkWindowsProcessAbsent: () => false,
          queryWindowsWmiCreations: () => new Map([[4, "20261030032839.146576+060"]]),
        }),
        /birth identity could not be resolved/i,
      );
      assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);
    } finally {
      await env.cleanup();
    }
  }

  // 4. Malformed WMI timestamp or WMI query failure/timeout -> stays unresolved and refuses reset.
  {
    const env = await tempDir("letagents-win-wmi-fail-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWindowsRuntimes(dbPath, [
        { id: "sys", pid: 4, birth: "win32-ft:130000000000000000" },
      ]);
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "win32",
          birthState: () => "unknown",
          checkWindowsProcessAbsent: () => false,
          queryWindowsWmiCreations: () => new Map([[4, "bad-cim-date"]]),
        }),
        /birth identity could not be resolved/i,
      );
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "win32",
          birthState: () => "unknown",
          checkWindowsProcessAbsent: () => false,
          queryWindowsWmiCreations: () => null,
        }),
        /birth identity could not be resolved/i,
      );
      assert.equal((await readdir(env.root)).some((name) => name.includes(".legacy-")), false);
    } finally {
      await env.cleanup();
    }
  }

  // 5. Wrong-platform (macOS) birth on Windows: absent PID moves cleanly; live PID fails closed.
  {
    const env = await tempDir("letagents-win-bad-birth-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyWindowsRuntimes(dbPath, [
        { id: "wrong_plat", pid: 4000, birth: "Mon Jan  1 00:00:00 1990" },
      ]);
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "win32",
          birthState: () => "unknown",
          checkWindowsProcessAbsent: () => false,
          queryWindowsWmiCreations: () => new Map([[4000, "20261030032839.146576+060"]]),
        }),
        /birth identity could not be resolved/i,
      );
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "unknown",
        checkWindowsProcessAbsent: () => true,
      });
      assert.ok(archived && archived.includes(".legacy-"));
    } finally {
      await env.cleanup();
    }
  }
});

test("legacy DB move-aside Windows process-list snapshot proves reused or absent PIDs without WMI, never signals them, and keeps equal or unread births fail-closed", async () => {
  const seed = async (dbPath: string, entries: Array<{ id: string; pid: number; birth: string }>) => {
    const database = new DatabaseSync(dbPath);
    try {
      database.exec(`
        PRAGMA application_id = 0;
        PRAGMA user_version = 52;
        CREATE TABLE runtime_deployments (agent_id TEXT PRIMARY KEY, provider_connection_pid INTEGER, provider_process_identity TEXT);
      `);
      for (const item of entries) database.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run(item.id, item.pid, item.birth);
    } finally {
      database.close();
    }
    await protectOwnerPrivate(dbPath, "file", { force: true });
  };
  type Snapshot = Map<number, { listed: false } | { listed: true; creationTime: string | null }> | undefined;
  /** One reset with the helper refused (unknown), absence unproved, and WMI denied unless a test supplies it. */
  const reset = async (
    entries: Array<{ id: string; pid: number; birth: string }>,
    snapshot: Snapshot,
    wmi: ((pids: readonly number[]) => Map<number, string> | null) = () => null,
  ) => {
    const env = await tempDir("letagents-win-snapshot-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    await seed(dbPath, entries);
    const before = await readFile(dbPath);
    const snapshotCalls: number[][] = [];
    const wmiCalls: number[][] = [];
    const signals: number[] = [];
    let outcome: string | Error | null;
    try {
      outcome = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "unknown",
        checkWindowsProcessAbsent: () => false,
        readWindowsProcessBirths: (pids) => { snapshotCalls.push([...pids]); return snapshot; },
        queryWindowsWmiCreations: (pids) => { wmiCalls.push([...pids]); return wmi(pids); },
        signalProcessTreeOutcome: (pid) => { signals.push(pid); return "ended"; },
      });
    } catch (error) {
      outcome = error as Error;
    }
    const names = await readdir(env.root);
    const unchanged = names.includes("daemon-state.sqlite") && Buffer.compare(before, await readFile(dbPath)) === 0;
    await env.cleanup();
    return { outcome, snapshotCalls, wmiCalls, signals, archived: names.some((name) => name.includes(".legacy-")), unchanged };
  };
  const refused = (result: Awaited<ReturnType<typeof reset>>) => {
    assert.ok(result.outcome instanceof Error && /birth identity could not be resolved/i.test(result.outcome.message), String(result.outcome));
    assert.equal(result.archived, false);
    assert.equal(result.unchanged, true, "an unresolved identity must leave the legacy database byte-for-byte unchanged");
  };

  // W1 with WMI denied: System (4) is listed with a creation time other than the recorded one. The pid names another
  // process: the reset proceeds, nothing is signalled, and WMI is not asked.
  {
    const result = await reset(
      [{ id: "sys", pid: 4, birth: "win32-ft:130000000000000000" }],
      new Map([[4, { listed: true, creationTime: "134381518010039201" }]]),
    );
    assert.ok(typeof result.outcome === "string" && result.outcome.includes(".legacy-"), String(result.outcome));
    assert.deepEqual(result.snapshotCalls, [[4]]);
    assert.deepEqual(result.wmiCalls, []);
    assert.deepEqual(result.signals, [], "a reused pid must never be signalled");
  }

  // Several unresolved records share one snapshot; the same pid with two births is asked for once.
  {
    const result = await reset(
      [
        { id: "a", pid: 4, birth: "win32-ft:130000000000000000" },
        { id: "b", pid: 696, birth: "win32-ft:130000000000000001" },
        { id: "c", pid: 4, birth: "win32-ft:130000000000000002" },
        { id: "d", pid: 556, birth: "win32-ft:130000000000000003" },
      ],
      new Map<number, { listed: false } | { listed: true; creationTime: string | null }>([
        [4, { listed: true, creationTime: "134381518010039201" }],
        [696, { listed: true, creationTime: "134381518101209559" }],
        [556, { listed: false }],
      ]),
    );
    assert.ok(typeof result.outcome === "string" && result.outcome.includes(".legacy-"), String(result.outcome));
    assert.equal(result.snapshotCalls.length, 1);
    assert.deepEqual([...result.snapshotCalls[0]!].sort((a, b) => a - b), [4, 556, 696]);
    assert.deepEqual(result.wmiCalls, []);
    assert.deepEqual(result.signals, []);
  }

  // More than one batch: 300 distinct pids are read as 256 + 44, and a batch that cannot be read leaves only its
  // pids to WMI.
  {
    const env = await tempDir("letagents-win-snapshot-batches-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      const entries = Array.from({ length: 300 }, (_, index) => ({ id: `r${index}`, pid: (index + 1) * 4, birth: "win32-ft:130000000000000000" }));
      await seed(dbPath, entries);
      const batches: number[][] = [];
      const wmiCalls: number[][] = [];
      const archived = await moveAsideLegacyDaemonStateDatabase(dbPath, {
        platform: "win32",
        birthState: () => "unknown",
        checkWindowsProcessAbsent: () => false,
        readWindowsProcessBirths: (pids) => {
          batches.push([...pids]);
          if (batches.length === 2) return undefined;
          return new Map(pids.map((pid) => [pid, { listed: false as const }]));
        },
        queryWindowsWmiCreations: (pids) => {
          wmiCalls.push([...pids]);
          return new Map(pids.map((pid) => [pid, "20261030032839.146576+060"]));
        },
        signalProcessTreeOutcome: () => { throw new Error("no record may be signalled"); },
      });
      assert.ok(archived && archived.includes(".legacy-"));
      assert.deepEqual(batches.map((batch) => batch.length), [256, 44]);
      assert.deepEqual(wmiCalls, [batches[1]], "only the unread batch goes to WMI");
    } finally {
      await env.cleanup();
    }
  }

  // A listed equal creation time is the recorded process itself, still unreadable through the helper: unknown,
  // refused, not signalled, and WMI is not asked to overrule an exact match.
  {
    const result = await reset(
      [{ id: "same", pid: 4, birth: "win32-ft:134381518010039201" }],
      new Map([[4, { listed: true, creationTime: "134381518010039201" }]]),
      () => new Map([[4, "20200101000000.000000+000"]]),
    );
    refused(result);
    assert.deepEqual(result.wmiCalls, []);
    assert.deepEqual(result.signals, []);
  }

  // A pid one tick away is a different birth: the snapshot is exact to 100 ns, unlike WMI.
  {
    const result = await reset(
      [{ id: "tick", pid: 4, birth: "win32-ft:134381518010039202" }],
      new Map([[4, { listed: true, creationTime: "134381518010039201" }]]),
    );
    assert.ok(typeof result.outcome === "string" && result.outcome.includes(".legacy-"), String(result.outcome));
    assert.deepEqual(result.signals, []);
  }

  // A snapshot that cannot be read, or that lists the pid without a positive time, falls through to WMI. With WMI
  // denied too, the identity stays unknown and the reset is refused; with a WMI answer, WMI decides as before.
  for (const snapshot of [undefined, new Map([[4, { listed: true as const, creationTime: null }]])]) {
    const denied = await reset([{ id: "sys", pid: 4, birth: "win32-ft:130000000000000000" }], snapshot);
    refused(denied);
    assert.deepEqual(denied.wmiCalls, [[4]]);
    assert.deepEqual(denied.signals, []);
    const answered = await reset(
      [{ id: "sys", pid: 4, birth: "win32-ft:130000000000000000" }],
      snapshot,
      () => new Map([[4, "20261030032839.146576+060"]]),
    );
    assert.ok(typeof answered.outcome === "string" && answered.outcome.includes(".legacy-"), String(answered.outcome));
    assert.deepEqual(answered.signals, []);
  }

  // A recorded birth that is not a Windows birth cannot be compared: only absence resolves it.
  {
    const listed = await reset(
      [{ id: "posix", pid: 4000, birth: "Mon Jan  1 00:00:00 1990" }],
      new Map([[4000, { listed: true, creationTime: "134381518010039201" }]]),
    );
    refused(listed);
    assert.deepEqual(listed.wmiCalls, []);
    const unlisted = await reset([{ id: "posix", pid: 4000, birth: "Mon Jan  1 00:00:00 1990" }], new Map([[4000, { listed: false }]]));
    assert.ok(typeof unlisted.outcome === "string" && unlisted.outcome.includes(".legacy-"), String(unlisted.outcome));
  }

  // A caller that injects its own birthState without a snapshot reader keeps its exact answer (no default helper run).
  {
    const env = await tempDir("letagents-win-snapshot-injected-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seed(dbPath, [{ id: "sys", pid: 4, birth: "win32-ft:134378009191465763" }]);
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          platform: "win32",
          birthState: () => "unknown",
          checkWindowsProcessAbsent: () => false,
          queryWindowsWmiCreations: () => null,
        }),
        /birth identity could not be resolved/i,
      );
    } finally {
      await env.cleanup();
    }
  }
});

test("concurrent fresh database opens converge across the main/WAL observation window while orphan, non-regular, foreign, future, and symlink controls still fail closed", async () => {
  // Helper: delay opener A's initial ENOENT from lstat(dbPath) until caller runs
  // a concurrent action and releases the gate, then record all lstat targets.
  function createDelayedMissingMainHook(dbPath: string): {
    lstatFile: typeof lstat;
    sawMissingMain: Promise<void>;
    releaseMissingMain: () => void;
    observedCalls: string[];
  } {
    let signalMissing!: () => void;
    let releaseMissing!: () => void;
    const sawMissingMain = new Promise<void>((resolve) => { signalMissing = resolve; });
    const gate = new Promise<void>((resolve) => { releaseMissing = resolve; });
    const observedCalls: string[] = [];
    let delayedOnce = false;
    const lstatFile = (async (target: Parameters<typeof lstat>[0], ...rest: unknown[]) => {
      const targetPath = String(target);
      observedCalls.push(targetPath);
      if (!delayedOnce && targetPath === dbPath) {
        delayedOnce = true;
        try {
          return await (lstat as (...args: unknown[]) => ReturnType<typeof lstat>)(target, ...rest);
        } catch (error) {
          signalMissing();
          await gate;
          throw error;
        }
      }
      return (lstat as (...args: unknown[]) => ReturnType<typeof lstat>)(target, ...rest);
    }) as typeof lstat;
    return { lstatFile, sawMissingMain, releaseMissingMain: releaseMissing, observedCalls };
  }

  // 1. Controlled interleaving with a real second opener on a fresh path:
  // Opener A observes ENOENT on main, Opener B finishes openDaemonStateDatabase
  // leaving a live non-empty -wal, and Opener A rechecks main and converges.
  {
    const env = await tempDir("letagents-concurrent-wal-race-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    let openerA: DaemonStateDatabase | null = null;
    let openerB: DaemonStateDatabase | null = null;
    try {
      const hook = createDelayedMissingMainHook(dbPath);
      const openerAPromise = DaemonStateDatabase.open(dbPath, undefined, { lstatFile: hook.lstatFile });
      await hook.sawMissingMain;

      openerB = await DaemonStateDatabase.open(dbPath);
      const walSize = (await stat(`${dbPath}-wal`)).size;
      assert.ok(walSize > 0, "expected real second opener to leave a non-empty active -wal file");

      hook.releaseMissingMain();
      openerA = await openerAPromise;

      assert.deepEqual(hook.observedCalls.slice(0, 3), [dbPath, `${dbPath}-wal`, dbPath]);
      assert.equal(
        Number((openerA.connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
        DAEMON_STATE_USER_VERSION,
      );
      assert.equal(
        Number((openerB.connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
        DAEMON_STATE_USER_VERSION,
      );
      // Both handles share the exact same WAL database and observe each other's committed writes.
      openerB.connection.prepare(
        "INSERT INTO daemon_maintenance_state(key, value_json, updated_at) VALUES (?, ?, ?)",
      ).run("task16_canary", JSON.stringify({ ok: true }), "2026-11-22T00:00:00.000Z");
      const observed = openerA.connection.prepare(
        "SELECT value_json FROM daemon_maintenance_state WHERE key = ?",
      ).get("task16_canary") as { value_json: string } | undefined;
      assert.equal(observed?.value_json, JSON.stringify({ ok: true }));
    } finally {
      openerA?.close();
      openerB?.close();
      await env.cleanup();
    }
  }

  // 2. Real parallel fresh openers converge without errors.
  {
    const env = await tempDir("letagents-parallel-fresh-open-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    const handles: DatabaseSync[] = [];
    try {
      const opened = await Promise.all([
        openDaemonStateDatabase(dbPath),
        openDaemonStateDatabase(dbPath),
        openDaemonStateDatabase(dbPath),
      ]);
      handles.push(...opened);
      for (const db of handles) {
        assert.equal(
          Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
          DAEMON_STATE_USER_VERSION,
        );
      }
    } finally {
      for (const db of handles) db.close();
      await env.cleanup();
    }
  }

  // 3. Genuine orphaned non-empty -wal (no main file even on recheck) still fails closed untouched.
  {
    const env = await tempDir("letagents-real-orphan-wal-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await writeFile(`${dbPath}-wal`, Buffer.from("stranded-wal-bytes-must-not-be-deleted", "utf8"));
      const before = await readFile(`${dbPath}-wal`);
      await assert.rejects(
        () => DaemonStateDatabase.open(dbPath),
        /orphaned non-empty -wal/i,
      );
      assert.deepEqual(await readFile(`${dbPath}-wal`), before);
      assert.equal(await stat(dbPath).catch(() => null), null, "main DB must not be created on orphan refusal");
    } finally {
      await env.cleanup();
    }
  }

  // 4. Non-regular -wal (directory, cross-platform) still fails closed even if main DB appears concurrently.
  {
    const env = await tempDir("letagents-nonregular-wal-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      const hook = createDelayedMissingMainHook(dbPath);
      const openerAPromise = DaemonStateDatabase.open(dbPath, undefined, { lstatFile: hook.lstatFile });
      await hook.sawMissingMain;

      // Place a valid main DB (closed so no real -wal) and a directory at `${dbPath}-wal`.
      const seeded = await DaemonStateDatabase.open(dbPath);
      seeded.close();
      await mkdir(`${dbPath}-wal`);

      hook.releaseMissingMain();
      await assert.rejects(openerAPromise, /orphaned non-empty -wal/i);
      assert.equal((await lstat(`${dbPath}-wal`)).isDirectory(), true);
    } finally {
      await env.cleanup();
    }
  }

  // 5. Foreign database with active non-empty -wal appearing mid-race still fails closed untouched.
  {
    const env = await tempDir("letagents-concurrent-foreign-db-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    let foreign: DatabaseSync | null = null;
    try {
      const hook = createDelayedMissingMainHook(dbPath);
      const openerAPromise = DaemonStateDatabase.open(dbPath, undefined, { lstatFile: hook.lstatFile });
      await hook.sawMissingMain;

      foreign = new DatabaseSync(dbPath);
      foreign.exec("PRAGMA journal_mode = WAL; PRAGMA application_id = 305419896; CREATE TABLE foreign_tbl(x TEXT); INSERT INTO foreign_tbl VALUES ('keep');");
      assert.ok((await stat(`${dbPath}-wal`)).size > 0);

      hook.releaseMissingMain();
      await assert.rejects(openerAPromise, /Unsupported SQLite database application_id 305419896/i);
      assert.equal((foreign.prepare("SELECT x FROM foreign_tbl").get() as { x: string }).x, "keep");
    } finally {
      foreign?.close();
      await env.cleanup();
    }
  }

  // 6. Future modern schema database with active non-empty -wal appearing mid-race still fails closed untouched.
  {
    const env = await tempDir("letagents-concurrent-future-db-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    let future: DatabaseSync | null = null;
    try {
      const hook = createDelayedMissingMainHook(dbPath);
      const openerAPromise = DaemonStateDatabase.open(dbPath, undefined, { lstatFile: hook.lstatFile });
      await hook.sawMissingMain;

      future = new DatabaseSync(dbPath);
      future.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID};
        PRAGMA user_version = ${toSqliteUserVersion(DAEMON_STATE_SCHEMA_VERSION + 1)};
        CREATE TABLE future_tbl(x TEXT);
        INSERT INTO future_tbl VALUES ('keep_future');
      `);
      assert.ok((await stat(`${dbPath}-wal`)).size > 0);

      hook.releaseMissingMain();
      await assert.rejects(openerAPromise, /Unsupported daemon state schema version/i);
      assert.equal((future.prepare("SELECT x FROM future_tbl").get() as { x: string }).x, "keep_future");
    } finally {
      future?.close();
      await env.cleanup();
    }
  }

  // 7. Symlink main file or symlink -wal appearing mid-race still fails closed (POSIX / symlink-enabled hosts).
  {
    const env = await tempDir("letagents-concurrent-symlink-db-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    const realTarget = join(env.root, "real-target.sqlite");
    try {
      await writeFile(realTarget, Buffer.from("target-bytes", "utf8"));
      let symlinkSupported = true;
      try {
        await symlink(realTarget, join(env.root, "probe-link"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
          symlinkSupported = false;
        } else {
          throw error;
        }
      }
      if (symlinkSupported) {
        // 7a: symlink main file appearing alongside a non-empty regular -wal.
        const hookMain = createDelayedMissingMainHook(dbPath);
        const openerMain = DaemonStateDatabase.open(dbPath, undefined, { lstatFile: hookMain.lstatFile });
        await hookMain.sawMissingMain;
        await symlink(realTarget, dbPath);
        await writeFile(`${dbPath}-wal`, Buffer.from("non-empty-wal", "utf8"));
        hookMain.releaseMissingMain();
        await assert.rejects(openerMain, /regular file/i);

        // 7b: symlink -wal appearing even when a valid main file exists.
        const dbPath2 = join(env.root, "daemon-state-2.sqlite");
        const hookWal = createDelayedMissingMainHook(dbPath2);
        const openerWal = DaemonStateDatabase.open(dbPath2, undefined, { lstatFile: hookWal.lstatFile });
        await hookWal.sawMissingMain;
        const seeded = await DaemonStateDatabase.open(dbPath2);
        seeded.close();
        await symlink(realTarget, `${dbPath2}-wal`);
        hookWal.releaseMissingMain();
        await assert.rejects(openerWal, /orphaned non-empty -wal/i);
      }
    } finally {
      await env.cleanup();
    }
  }

  // 8. Legacy database with uncheckpointed non-empty -wal appearing mid-race still checkpoints and moves aside cleanly.
  {
    const env = await tempDir("letagents-concurrent-legacy-wal-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    let opened: DaemonStateDatabase | null = null;
    try {
      const hook = createDelayedMissingMainHook(dbPath);
      const openerPromise = DaemonStateDatabase.open(dbPath, undefined, { lstatFile: hook.lstatFile });
      await hook.sawMissingMain;

      createSigkilledUncheckpointedLegacyDb(dbPath);
      assert.ok((await stat(`${dbPath}-wal`)).size > 0);
      await protectOwnerPrivate(dbPath, "file", { force: true });

      hook.releaseMissingMain();
      opened = await openerPromise;
      assert.equal(
        Number((opened.connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
        DAEMON_STATE_USER_VERSION,
      );
      const entries = await readdir(env.root);
      const archived = entries.filter((name) => /^daemon-state\.sqlite\.legacy-.*Z(?:-\d+)?$/.test(name));
      assert.equal(archived.length, 1);
      const verify = new DatabaseSync(join(env.root, archived[0]!), { readOnly: true });
      try {
        assert.equal(Number(verify.prepare("SELECT COUNT(*) AS n FROM canary").get()?.n), 3);
        assert.equal(Number(verify.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n), 2);
      } finally {
        verify.close();
      }
    } finally {
      opened?.close();
      await env.cleanup();
    }
  }
});

test("listEntryIds and listUnresolvedTurnControlRecovery read scalar rows in sort order without hydrating payloads", async () => {
  const env = await tempDir("letagents-scalar-turn-controls-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  const store = new ManifestStore(dbPath);
  try {
    const baseControl = {
      action_id: "ctrl",
      action_sequence: 1,
      work_attempt_id: "attempt",
      execution_generation_id: "exec",
      has_correction: false,
      capability: "interrupt_and_resume" as const,
      interrupted: null,
      resumed: null,
      state: "working" as const,
      stages: ["delivered" as const],
      error: null,
      recorded_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    };
    const activity = [{
      observed_at: "2026-10-01T00:00:00.000Z",
      sequence: 1,
      provider: "codex" as const,
      kind: "tool" as const,
      method: "item/x",
      summary: "x",
      status: "idle" as const,
      payload: { big: "payload" },
      payload_truncated: false,
      payload_redacted: false,
      durable_payload_ref: null,
    }];
    const absent = { ...sampleEntry("z-absent"), turn_control: undefined, last_turn_control_sequence: 0, activity: undefined, reconciliation: undefined, reconciliation_notices: undefined };
    const nulled = { ...sampleEntry("a-null"), turn_control: null, last_turn_control_sequence: 0, activity };
    const completed = { ...sampleEntry("m-done"), last_turn_control_sequence: 1, turn_control: { ...baseControl, status: "completed" as const }, activity };
    const prepared = { ...sampleEntry("b-prep"), last_turn_control_sequence: 1, turn_control: { ...baseControl, status: "prepared" as const }, activity };
    const dispatching = { ...sampleEntry("c-disp"), last_turn_control_sequence: 1, turn_control: { ...baseControl, status: "dispatching" as const }, activity };
    await store.write([absent, nulled, completed, prepared, dispatching]);
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("UPDATE activity_events SET payload_json='invalid-json'");
      assert.deepEqual(await store.listEntryIds(), ["z-absent", "a-null", "m-done", "b-prep", "c-disp"]);
      assert.deepEqual(await store.listUnresolvedTurnControlRecovery(), {
        agentIds: ["b-prep", "c-disp"],
      });
      const summaryAbsent = await store.getEntry("z-absent", "summary");
      assert.deepEqual(summaryAbsent?.activity, []);
      assert.equal(summaryAbsent?.turn_control, undefined);
      assert.equal(summaryAbsent?.reconciliation, undefined);
      assert.equal(summaryAbsent?.reconciliation_notices, undefined);
      const summaryNulled = await store.getEntry("a-null", "summary");
      assert.equal(summaryNulled?.activity?.length, 1);
      assert.equal(summaryNulled?.activity?.[0]?.payload, null);
    } finally {
      database.close();
    }
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("legacy reset preserves room-only workspaces and review archives across restarts, rolls back on rename error, fails closed on symlinks, and reports one-time reset status", async () => {
  const seedLegacyV54 = async (dbPath: string) => {
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        PRAGMA application_id = 0;
        PRAGMA user_version = 54;
        CREATE TABLE runtime_deployments (
          agent_id TEXT PRIMARY KEY,
          provider_connection_pid INTEGER,
          provider_process_identity TEXT
        );
      `);
    } finally {
      seed.close();
    }
    await protectOwnerPrivate(dbPath, "file", { force: true });
  };

  // 1. Rollback on main DB rename failure + full SupervisorDaemon restart #1 and #2 preservation + status notice.
  {
    const env = await tempDir("letagents-legacy-preserve-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    const attemptId = "77d37322-4a2b-4c5d-8e9f-1234567890ab";
    const reviewFileName = `${"a".repeat(64)}.review`;
    try {
      await seedLegacyV54(dbPath);
      await writeFile(`${dbPath}.recovery.enc`, "legacy-recovery-envelope", "utf8");
      await mkdir(`${dbPath}.reviews`, { recursive: true, mode: 0o700 });
      await mkdir(`${dbPath}.reviews-recovery`, { recursive: true, mode: 0o700 });
      await writeFile(join(`${dbPath}.reviews`, reviewFileName), "legacy-review-ciphertext", "utf8");
      await writeFile(join(`${dbPath}.reviews-recovery`, reviewFileName), "legacy-review-recovery", "utf8");

      const provisioner = new EphemeralWorkspaceProvisioner(env.root);
      const provisioned = await provisioner.provision({ workAttemptId: attemptId, taskId: "task-room-only" });
      await writeFile(join(provisioned.path, "uncommitted-work.txt"), "keep-me-safe\n", "utf8");

      // Injected failure on main DB rename must roll back .recovery.enc, .reviews, .reviews-recovery, and worktrees/room-only.
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath, {
          workspaceRoot: env.root,
          renameFile: async (from, to) => {
            if (from === dbPath) throw Object.assign(new Error("EIO: injected main rename failure"), { code: "EIO" });
            await renameWithRetryAsync(from, to);
          },
        }),
        /injected main rename failure/,
      );
      assert.equal(await readFile(join(provisioned.path, "uncommitted-work.txt"), "utf8"), "keep-me-safe\n");
      assert.equal(await readFile(join(`${dbPath}.reviews`, reviewFileName), "utf8"), "legacy-review-ciphertext");
      assert.equal(await readFile(join(`${dbPath}.reviews-recovery`, reviewFileName), "utf8"), "legacy-review-recovery");
      assert.equal(await readFile(`${dbPath}.recovery.enc`, "utf8"), "legacy-recovery-envelope");

      const paths = {
        stateDir: env.root,
        ...testDaemonEndpoint(env.root, "legacy-preserve"),
        lockPath: join(env.root, "daemon.lock"),
        manifestPath: dbPath,
        auditPath: join(env.root, "audit.log"),
        workspaceRoot: env.root,
      };

      const daemonPlatform: NodeJS.Platform = process.platform === "win32" ? "win32" : "darwin";
      // Startup #1: moves legacy DB + reviews + worktrees/room-only aside, runs recoverEphemeralWorkspaces & review pruning.
      let backupName = "";
      const daemon1 = new SupervisorDaemon(paths, daemonPlatform);
      try {
        await daemon1.start();
        const internals = daemon1 as unknown as {
          stateDatabase: DaemonStateDatabase | null;
          status(): { legacy_state_reset?: { reset_at: string; backup_name: string; legacy_schema_version: number; preserved_room_only_workspaces: boolean; preserved_review_archives: boolean } | null };
        };
        const status1 = internals.status();
        assert.ok(status1.legacy_state_reset, "daemon status must report one-time legacy reset after moving aside v54 DB");
        assert.equal(status1.legacy_state_reset.legacy_schema_version, 54);
        assert.equal(status1.legacy_state_reset.preserved_room_only_workspaces, true);
        assert.equal(status1.legacy_state_reset.preserved_review_archives, true);
        backupName = status1.legacy_state_reset.backup_name;
        assert.match(backupName, /^daemon-state\.sqlite\.legacy-.*Z(?:-\d+)?$/);

        // Explicitly run review archive maintenance/pruning against the fresh v1005 DB.
        const reviewStore = new RoomWorkspaceStore(internals.stateDatabase!.connection);
        reviewStore.maintainArchives(Date.now());
      } finally {
        await daemon1.stop().catch(() => undefined);
      }

      // Verify legacy reviews and room-only uncommitted file survived startup #1 intact.
      assert.equal(await readFile(join(env.root, `${backupName}.reviews`, reviewFileName), "utf8"), "legacy-review-ciphertext");
      assert.equal(await readFile(join(env.root, `${backupName}.reviews-recovery`, reviewFileName), "utf8"), "legacy-review-recovery");
      const worktreesEntries = await readdir(join(env.root, "worktrees"));
      const legacyRoomOnly = worktreesEntries.filter((name) => name.startsWith("room-only.legacy-"));
      assert.equal(legacyRoomOnly.length, 1, "non-empty worktrees/room-only must be moved aside with .legacy- prefix");
      assert.equal(
        await readFile(join(env.root, "worktrees", legacyRoomOnly[0]!, attemptId, "uncommitted-work.txt"), "utf8"),
        "keep-me-safe\n",
      );

      // Startup #2 on the now-modern v1005 DB: preserved backups must survive and reset status stays readable.
      const daemon2 = new SupervisorDaemon(paths, daemonPlatform);
      try {
        await daemon2.start();
        const internals = daemon2 as unknown as {
          status(): { legacy_state_reset?: { backup_name: string; legacy_schema_version: number; preserved_room_only_workspaces: boolean; preserved_review_archives: boolean } | null };
        };
        const status2 = internals.status();
        assert.equal(status2.legacy_state_reset?.backup_name, backupName);
        assert.equal(status2.legacy_state_reset?.preserved_room_only_workspaces, true);
        assert.equal(status2.legacy_state_reset?.preserved_review_archives, true);
      } finally {
        await daemon2.stop().catch(() => undefined);
      }
      assert.equal(
        await readFile(join(env.root, "worktrees", legacyRoomOnly[0]!, attemptId, "uncommitted-work.txt"), "utf8"),
        "keep-me-safe\n",
      );
      assert.equal(await readFile(join(env.root, `${backupName}.reviews`, reviewFileName), "utf8"), "legacy-review-ciphertext");
    } finally {
      await env.cleanup();
    }
  }

  // 2. Fresh v1005 start (no legacy DB) must NOT surface legacy_state_reset in status.
  {
    const env = await tempDir("letagents-fresh-no-reset-");
    const paths = {
      stateDir: env.root,
      ...testDaemonEndpoint(env.root, "fresh-no-reset"),
      lockPath: join(env.root, "daemon.lock"),
      manifestPath: join(env.root, "daemon-state.sqlite"),
      auditPath: join(env.root, "audit.log"),
      workspaceRoot: env.root,
    };
    const daemon = new SupervisorDaemon(paths, process.platform === "win32" ? "win32" : "darwin");
    try {
      await daemon.start();
      const status = (daemon as unknown as { status(): { legacy_state_reset?: unknown } }).status();
      assert.equal(status.legacy_state_reset, undefined);
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  }

  // 3. Empty worktrees/room-only and empty .reviews are not moved unnecessarily; symlinked .reviews fails closed.
  {
    const env = await tempDir("letagents-legacy-empty-and-symlink-");
    const dbPath = join(env.root, "daemon-state.sqlite");
    try {
      await seedLegacyV54(dbPath);
      await mkdir(join(env.root, "worktrees", "room-only"), { recursive: true, mode: 0o700 });
      await mkdir(`${dbPath}.reviews`, { recursive: true, mode: 0o700 });
      const movedState: { info: { preservedReviews: boolean; preservedRoomOnlyWorkspaces: boolean } | null } = { info: null };
      await moveAsideLegacyDaemonStateDatabase(dbPath, {
        workspaceRoot: env.root,
        onMovedAside: (info) => { movedState.info = info; },
      });
      assert.deepEqual(
        movedState.info && {
          preservedReviews: movedState.info.preservedReviews,
          preservedRoomOnlyWorkspaces: movedState.info.preservedRoomOnlyWorkspaces,
        },
        { preservedReviews: false, preservedRoomOnlyWorkspaces: false },
      );
      assert.equal((await readdir(join(env.root, "worktrees"))).some((name) => name.startsWith("room-only.legacy-")), false);
      assert.equal((await readdir(env.root)).some((name) => name.endsWith(".reviews") && name.includes(".legacy-")), false);

      // Non-directory file or symlink/junction at .reviews must fail closed before moving the database.
      const dbPath2 = join(env.root, "symlink-test.sqlite");
      const externalTarget = join(env.root, "external-dir");
      await mkdir(externalTarget, { recursive: true, mode: 0o700 });
      await seedLegacyV54(dbPath2);
      await symlink(externalTarget, `${dbPath2}.reviews`, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath2, { workspaceRoot: env.root }),
        /non-directory legacy review archive path/i,
      );
      assert.ok((await lstat(dbPath2)).isFile(), "legacy DB must remain untouched when .reviews is a symlink");

      const dbPath3 = join(env.root, "file-reviews-test.sqlite");
      await seedLegacyV54(dbPath3);
      await writeFile(`${dbPath3}.reviews`, "not-a-directory", "utf8");
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath3, { workspaceRoot: env.root }),
        /non-directory legacy review archive path/i,
      );
      assert.ok((await lstat(dbPath3)).isFile(), "legacy DB must remain untouched when .reviews is a regular file");

      const unsafeWorktreeRoot = join(env.root, "unsafe-room-only");
      const dbPath4 = join(unsafeWorktreeRoot, "daemon-state.sqlite");
      await mkdir(join(unsafeWorktreeRoot, "worktrees"), { recursive: true, mode: 0o700 });
      await seedLegacyV54(dbPath4);
      await writeFile(join(unsafeWorktreeRoot, "worktrees", "room-only"), "not-a-directory", "utf8");
      await assert.rejects(
        () => moveAsideLegacyDaemonStateDatabase(dbPath4, { workspaceRoot: unsafeWorktreeRoot }),
        /unsafe legacy room-only workspace directory/i,
      );
      assert.ok((await lstat(dbPath4)).isFile(), "legacy DB must remain untouched when worktrees/room-only is not a directory");
    } finally {
      await env.cleanup();
    }
  }
});
