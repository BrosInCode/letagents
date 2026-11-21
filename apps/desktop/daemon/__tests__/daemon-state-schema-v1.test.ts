import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
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
  fromSqliteUserVersion,
  runNumberedMigrations,
  toSqliteUserVersion,
  validateDaemonStateShape,
} from "../daemon-state-database.js";
import { WorkDurabilityStore } from "../durability-store.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { processBirthState, systemProcessIdentity } from "../process-identity.js";
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

test("fresh schema v1 enforces application_id, user_version=1001, downgrade-safe table layout, and 1:1 shape checks", async () => {
  const env = await tempDir("letagents-schema-v1-");
  const dbPath = join(env.root, "daemon-state.sqlite");
  try {
    assert.equal(DAEMON_STATE_SCHEMA_VERSION, 1);
    assert.equal(DAEMON_STATE_USER_VERSION_OFFSET, 1000);
    assert.equal(DAEMON_STATE_USER_VERSION, 1001);
    assert.equal(toSqliteUserVersion(1), 1001);
    assert.equal(fromSqliteUserVersion(1001), 1);

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
      legacy.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("legacy_match", matchingChild.pid, matchingBirth);
      legacy.prepare("INSERT INTO runtime_deployments VALUES (?, ?, ?)").run("legacy_mismatch", mismatchedChild.pid, "Mon Jan  1 00:00:00 1990");
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
    { name: "future modern v2 (user_version=1002)", appId: DAEMON_STATE_APPLICATION_ID, userVersion: DAEMON_STATE_USER_VERSION + 1, table: true, pattern: /Unsupported daemon state schema version/i },
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

test("runNumberedMigrations applies future v1->v2 migrations atomically inside a transaction and rolls back on failure", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new DaemonStateSchema().createSchema(db);
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), DAEMON_STATE_USER_VERSION);

    assert.throws(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        runNumberedMigrations(db, 1, 2, {
          1(conn) {
            conn.exec("CREATE TABLE synthetic_v2 (id TEXT PRIMARY KEY)");
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
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synthetic_v2'").get(), undefined);

    db.exec("BEGIN IMMEDIATE");
    runNumberedMigrations(db, 1, 2, {
      1(conn) {
        conn.exec("CREATE TABLE synthetic_v2 (id TEXT PRIMARY KEY); INSERT INTO synthetic_v2 VALUES ('ok');");
      },
    });
    db.exec("COMMIT");
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), toSqliteUserVersion(2));
    assert.equal(db.prepare("SELECT id FROM synthetic_v2").get()?.id, "ok");
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
        roomWorkPublisher: { database: DatabaseSync } | null;
        executionDelegations: { approvalPublisher?: { database: DatabaseSync } | null };
      };
      shared = internals.stateDatabase?.connection;
      assert.ok(shared && shared.isOpen, "daemon must own an open shared connection");
      assert.equal(internals.store.database, shared, "ManifestStore must share the single connection");
      assert.equal(internals.durability.database, shared, "WorkDurabilityStore must share the single connection");
      assert.equal(internals.workerBindings.database, shared, "WorkerBindingStore must share the single connection");
      assert.equal(internals.supervisedInbox.database, shared, "SupervisedAgentInboxStore must share the single connection");
      assert.equal(internals.executionCapture?.database, shared, "ExecutionCaptureCoordinator must share the single connection");
      assert.equal(internals.roomWorkPublisher?.database, shared, "RoomWorkPublisher must share the single connection");
      assert.equal(internals.executionDelegations.approvalPublisher?.database, shared, "ExecutionApprovalPublisher must share the single connection");
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

    // Verify zero partial writes committed across any table.
    const db = internals.stateDatabase.connection;
    assert.equal(db.prepare("SELECT observed_state FROM agents WHERE agent_id='fenced_agent'").get()?.observed_state, "paused");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM worker_session_bindings").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM work_attempt_executions").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()?.n), 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});
