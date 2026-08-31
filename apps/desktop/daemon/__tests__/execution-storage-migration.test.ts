import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema, openDaemonStateDatabase, openDaemonStateObservationDatabase } from "../daemon-state-database.js";
import { applyExecutionStorageSchema, validateExecutionStorageSchema } from "../execution-storage-schema.js";
import { validatePollingActivationSchema, validatePollingOfferSchema } from "../custodial-polling-activation.js";

type Row = Record<string, unknown>;
const now = "2026-08-30T00:00:00.000Z";
const cutover = '{ "phase": "uncertain", "action_id": "original", "extension": { "untouched": true } }';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "letagents-execution-migration-"));
  const path = join(directory, "daemon-state.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  new DaemonStateSchema().createSchema(database);
  return { path, database, cleanup: async () => { database.close(); await rm(directory, { recursive: true, force: true }); } };
}

/** Physically restore the preceding constraint, not merely its version marker. */
function restoreV19TerminalFixture(database: DatabaseSync): void {
  const schemaVersion = Number(database.prepare("PRAGMA schema_version").get()!.schema_version);
  database.exec("PRAGMA writable_schema=ON");
  database.prepare("UPDATE sqlite_master SET sql=replace(replace(sql, ?, ''), ?, '') WHERE name='supervised_agent_terminal_results'").run(
    ",'failed','interrupted'",
    ",CHECK(outcome NOT IN ('failed','interrupted') OR (normalized_text IS NULL AND evidence_source <> 'none'))",
  );
  database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
}

function restoreV17Fixture(database: DatabaseSync): void {
  restoreV22Fixture(database);
  restoreV19TerminalFixture(database);
  database.exec("PRAGMA foreign_keys=OFF");
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'execution_*'").all() as Row[]) {
    database.exec(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`);
  }
  const schemaVersion = Number((database.prepare("PRAGMA schema_version").get() as Row).schema_version);
  database.exec("PRAGMA writable_schema=ON");
  database.prepare("UPDATE sqlite_master SET sql=replace(sql, ?, '') WHERE name='supervised_agent_inbox'").run(",'acknowledged_failed'");
  database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1};
    UPDATE manifest_metadata SET schema_version=17, generation=42 WHERE singleton=1;
    PRAGMA user_version=17; PRAGMA foreign_keys=ON`);
}

function restoreV18Fixture(database: DatabaseSync): void {
  restoreV22Fixture(database);
  restoreV19TerminalFixture(database);
  database.exec("PRAGMA foreign_keys=OFF");
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'execution_*'").all() as Row[]) {
    database.exec(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`);
  }
  applyExecutionStorageSchema(database, 18);
  database.exec("UPDATE manifest_metadata SET schema_version=18 WHERE singleton=1; PRAGMA user_version=18; PRAGMA foreign_keys=ON");
}

function restoreV19Fixture(database: DatabaseSync): void {
  restoreV20Fixture(database);
  restoreV19TerminalFixture(database);
  database.exec("UPDATE manifest_metadata SET schema_version=19 WHERE singleton=1; PRAGMA user_version=19");
}

function restoreV20Fixture(database: DatabaseSync): void {
  restoreV21Fixture(database);
  database.exec(`DROP TABLE execution_observer_sources;
    ALTER TABLE execution_observers DROP COLUMN source_id;
    UPDATE manifest_metadata SET schema_version=20 WHERE singleton=1; PRAGMA user_version=20`);
  validateExecutionStorageSchema(database, 19);
}

function restoreV21Fixture(database: DatabaseSync): void {
  restoreV22Fixture(database);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM execution_cutover_v2").get()!.count, 0);
  const previous = new DatabaseSync(":memory:");
  try {
    applyExecutionStorageSchema(previous, 20);
    const definitions = previous.prepare(`SELECT sql FROM sqlite_master
      WHERE tbl_name='execution_cutover_v2' AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`).all();
    database.exec("DROP TABLE execution_cutover_v2");
    for (const row of definitions) database.exec(String(row.sql));
  } finally { previous.close(); }
  database.exec("UPDATE manifest_metadata SET schema_version=21 WHERE singleton=1; PRAGMA user_version=21");
  validateExecutionStorageSchema(database, 20);
}

function restoreV22Fixture(database: DatabaseSync): void {
  restoreV23Fixture(database);
  database.exec("ALTER TABLE agent_configurations DROP COLUMN polling_contract; UPDATE manifest_metadata SET schema_version=22 WHERE singleton=1; PRAGMA user_version=22");
}

function restoreV23Fixture(database: DatabaseSync): void {
  restoreV24Fixture(database);
  database.exec("DROP TABLE custodial_polling_activations; ALTER TABLE runtime_deployments DROP COLUMN custodial_launch_agent_session_id; UPDATE manifest_metadata SET schema_version=23 WHERE singleton=1; PRAGMA user_version=23");
}

function restoreV24Fixture(database: DatabaseSync): void {
  database.exec("DROP TABLE custodial_polling_offers; UPDATE manifest_metadata SET schema_version=24 WHERE singleton=1; PRAGMA user_version=24");
}

function seedV18Evidence(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO execution_generations VALUES('generation','agent',100);
    INSERT INTO execution_runtime_generations
      (runtime_generation_id,execution_generation_id,agent_id,provider,runtime_state,control_state,continuation_state,config_revision,created_at_ms)
      VALUES('runtime','generation','agent','codex','ready','responsive','available',1,100);
    INSERT INTO execution_message_attempts
      (attempt_id,agent_id,room_id,source_message_id,state,created_at_ms)
      VALUES('attempt','agent','room','source','active',100);
    INSERT INTO execution_attempt_generations VALUES('attempt','agent','room','generation','workspace',100);
    INSERT INTO execution_turns
      (turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms)
      VALUES('turn','attempt','agent','room','generation','runtime','continuation','native-turn','terminal','possible',100,120);
    INSERT INTO execution_facts
      (fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,source_sequence,turn_id,domain,kind,state,side_effects,observed_at_ms)
      VALUES('terminal','agent','generation','runtime',1,1,'turn','turn','state_changed','terminal','possible',120),
      ('control-lost','agent','generation','runtime',1,2,NULL,'control','state_changed','lost','none',121);
    INSERT INTO execution_approval_requests
      (request_id,request_version,agent_id,room_id,execution_generation_id,runtime_generation_id,turn_id,provider_continuation_id,provider_turn_id,connection_id,native_request_id_type,native_request_id,kind,risk,delegatable,request_sha256,state,recovery_boundary,created_at_ms,expires_at_ms)
      VALUES('request',1,'agent','room','generation','runtime','turn','continuation','native-turn','connection','string','native-request','command','high',0,'${"a".repeat(64)}','dispatching','connection',100,200);
    INSERT INTO execution_approval_decisions
      (decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256,decision,source,actor_id,dispatch_state,dispatch_id,decided_at_ms,dispatch_started_at_ms)
      VALUES('decision','request',1,'agent','room','generation','turn',0,'${"a".repeat(64)}','deny','host','owner','uncertain','dispatch',110,111);
  `);
}

function typedRows(database: DatabaseSync): Record<string, unknown> {
  return Object.fromEntries((database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'execution_*' AND name NOT IN ('execution_observers','execution_observer_sources') ORDER BY name").all() as Row[])
    .map(({ name }) => {
      const columns = (database.prepare(`PRAGMA table_info(${name})`).all() as Row[])
        .map((column) => String(column.name)).filter((column) => !["turn_outcome", "control_evidence", "projection_sha256"].includes(column));
      return [String(name), database.prepare(`SELECT ${columns.join(",")} FROM ${name} ORDER BY rowid`).all()];
    }));
}

function seedV19Observer(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO execution_generations VALUES('observer-generation','agent',200);
    INSERT INTO execution_runtime_generations
      (runtime_generation_id,execution_generation_id,agent_id,provider,runtime_state,control_state,continuation_state,config_revision,created_at_ms)
      VALUES('observer-runtime','observer-generation','agent','codex','ready','responsive','available',1,200);
    INSERT INTO execution_observers
      (agent_id,execution_generation_id,runtime_generation_id,observer_execution_generation_id,observer_runtime_generation_id,
       daemon_generation_id,observer_epoch,last_source_sequence,max_observed_sequence,recovery_turn_id,bound_at_ms)
      VALUES('agent','generation','runtime','observer-generation','observer-runtime','daemon-generation',7,42,50,'turn',200);
  `);
}

function seedDormantCutovers(database: DatabaseSync): void {
  database.exec(`INSERT INTO execution_generations VALUES('dispatch-generation','dispatching-agent',100);
    INSERT INTO execution_cutover_v2
      (rowid,operation_id,request_id,agent_id,execution_generation_id,target_turn_id,predecessor_operation_id,
       from_mode,to_mode,strategy,phase,created_at_ms,updated_at_ms) VALUES
      (71,'old-complete','request-complete','agent','generation','turn',NULL,'mcp_polling','daemon_inbox','force','complete',100,101),
      (88,'old-uncertain','request-uncertain','agent','generation','turn','old-complete','daemon_inbox','mcp_polling','force','uncertain',102,103),
      (95,'old-dispatching','request-dispatching','dispatching-agent','dispatch-generation',NULL,NULL,'mcp_polling','daemon_inbox','drain','dispatching',100,104)`);
}

function seedLegacyEvidence(database: DatabaseSync): void {
  database.prepare("INSERT INTO agent_identities VALUES(?,?,?,?)").run("agent", "owner", now, 0);
  database.prepare(`INSERT INTO agent_configurations
    (agent_id,provider,model,charter,permission_profile_id,delivery_mode,delivery_cutover_json,
     provider_launch_policy_present,provider_launch_policy_undefined,provider_launch_policy_json)
    VALUES('agent','codex','model','charter','full_access','daemon_inbox',?,0,0,NULL)`).run(cutover);
  database.prepare("INSERT INTO agent_identities VALUES(?,?,?,?)").run("dispatching-agent", "owner", now, 1);
  database.prepare(`INSERT INTO agent_configurations
    (agent_id,provider,model,charter,permission_profile_id,delivery_mode,delivery_cutover_json,
     provider_launch_policy_present,provider_launch_policy_undefined,provider_launch_policy_json)
    VALUES('dispatching-agent','codex','model','charter','full_access','mcp_polling',?,0,0,NULL)`)
    .run('{ "phase": "dispatching", "action_id": "in-flight" }');
  const insert = database.prepare(`INSERT INTO supervised_agent_inbox
    (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,
     fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,
     outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
    VALUES(?,'agent','room',?,'{"text":"original"}','{"decision":"activate"}',?,?,2,?,?,?,NULL,?,NULL,?,123,?,?,NULL)`);
  insert.run("head", "source-head", 1, "blocked", "action-head", "reply-head", "turn-head", "ambiguous transport", null, now, now);
  insert.run("tail", "source-tail", 2, "blocked", "action-tail", "reply-tail", null, "waiting for original head", "head", now, now);
  database.prepare("INSERT INTO supervised_agent_inbox_events VALUES('head',1,'original','blocked',?,?)").run(now, "original diagnostic");
  database.prepare(`INSERT INTO supervised_agent_terminal_results VALUES
    ('head','agent','generation','turn-head','reply','partial result','stream','{"native":true}',?,?)`).run(now, now);
  database.prepare("INSERT INTO supervised_agent_publications VALUES('head','agent','room','reply-head','canonical-head',?)").run(now);
  database.prepare(`INSERT INTO provider_continuation_repairs VALUES
    ('repair','agent','room','head',1,'generation','attempt',123,'birth:123','old',NULL,'probing',1,NULL,?,?)`).run(now, now);
  database.prepare(`INSERT INTO supervised_agent_provider_turn_bindings VALUES
    ('head','agent','room','attempt','generation','continuation','turn-head')`).run();
}

function legacyRows(database: DatabaseSync): Record<string, unknown> {
  return Object.fromEntries((database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'execution_*'
      AND name NOT IN ('manifest_metadata','custodial_polling_activations','custodial_polling_offers') ORDER BY name`).all() as Row[])
    .map((row) => {
      // Compare predecessor fields exactly; the new nullable custody column
      // has separate migration assertions and must never become a backfill.
      const columns = database.prepare(`PRAGMA table_info("${row.name}")`).all()
        .map((column) => String(column.name)).filter((column) => column !== "polling_contract" && column !== "custodial_launch_agent_session_id");
      return [String(row.name), database.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(",")} FROM "${row.name}" ORDER BY rowid`).all()];
    }));
}

function versionPair(database: DatabaseSync): unknown[] {
  return [database.prepare("PRAGMA user_version").get(), database.prepare("SELECT generation,schema_version FROM manifest_metadata WHERE singleton=1").get()];
}

test("v18 preserves blocked FIFO, all child authority and uncertain cutover bytes", async () => {
  const env = await fixture();
  try {
    restoreV17Fixture(env.database);
    seedLegacyEvidence(env.database);
    const before = legacyRows(env.database);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before);
    assert.equal((env.database.prepare("SELECT delivery_cutover_json FROM agent_configurations").get() as Row).delivery_cutover_json, cutover);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((env.database.prepare("PRAGMA foreign_keys").get() as Row).foreign_keys, 1);
    assert.equal((env.database.prepare("SELECT generation FROM manifest_metadata").get() as Row).generation, 42);
    assert.equal((env.database.prepare("PRAGMA user_version").get() as Row).user_version, DAEMON_STATE_SCHEMA_VERSION);
    validateExecutionStorageSchema(env.database);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before, "reopening cannot synthesize or rewrite a legacy outcome");
    env.database.prepare("UPDATE supervised_agent_inbox SET state='acknowledged_failed' WHERE inbox_item_id='tail'").run();
    assert.throws(() => new DaemonStateSchema().createSchema(env.database), /exact native terminal/,
      "the reserved state alone is not operational failure evidence");
    assert.throws(() => env.database.prepare("UPDATE supervised_agent_inbox SET state='invented' WHERE inbox_item_id='tail'").run(), /CHECK/);
    assert.throws(() => env.database.prepare("UPDATE supervised_agent_inbox SET blocked_by_inbox_item_id='missing' WHERE inbox_item_id='tail'").run(), /FOREIGN KEY/);
    assert.throws(() => env.database.prepare("UPDATE supervised_agent_provider_turn_bindings SET room_id='other' WHERE inbox_item_id='head'").run(), /FOREIGN KEY/);
  } finally { await env.cleanup(); }
});

test("v18 rebuild and journals roll back together before either version advances", async () => {
  const env = await fixture();
  try {
    restoreV17Fixture(env.database);
    seedLegacyEvidence(env.database);
    const before = legacyRows(env.database);
    const versions = versionPair(env.database);
    const schema = env.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const interrupted = new DaemonStateSchema(() => { throw new Error("interrupt v18 before markers"); });
    assert.throws(() => interrupted.createSchema(env.database), /interrupt v18/);
    assert.deepEqual(legacyRows(env.database), before);
    assert.deepEqual(versionPair(env.database), versions);
    assert.deepEqual(env.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    assert.deepEqual(env.database.prepare("SELECT name FROM temp.sqlite_master WHERE name GLOB 'v18_snapshot_*'").all(), []);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before);
  } finally { await env.cleanup(); }
});

for (const version of [17, 19, 20, 21, 22, 24]) test(`a killed migrator leaves the complete v${version} graph recoverable from WAL`, async () => {
  const env = await fixture();
  try {
    (version === 17 ? restoreV17Fixture : version === 19 ? restoreV19Fixture : version === 20 ? restoreV20Fixture : version === 21 ? restoreV21Fixture : version === 22 ? restoreV22Fixture : restoreV24Fixture)(env.database);
    seedLegacyEvidence(env.database);
    if (version === 21) { seedV18Evidence(env.database); seedDormantCutovers(env.database); }
    const before = legacyRows(env.database);
    const cutovers = version === 21 ? env.database.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all() : undefined;
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { DaemonStateSchema } from ${JSON.stringify(new URL("../daemon-state-database.ts", import.meta.url).href)};
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
      new DaemonStateSchema(() => process.kill(process.pid, 'SIGKILL')).createSchema(database);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, env.path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.deepEqual(legacyRows(env.database), before);
    if (cutovers) assert.deepEqual(env.database.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all(), cutovers);
    assert.equal((env.database.prepare("PRAGMA user_version").get() as Row).user_version, version);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before);
  } finally { await env.cleanup(); }
});

for (const version of [20, 21, 22]) test(`v${version} predecessor repair preserves native-turn authority and failed terminal evidence`, async () => {
  const env = await fixture();
  try {
    if (version === 20) restoreV20Fixture(env.database);
    if (version === 21) restoreV21Fixture(env.database);
    seedLegacyEvidence(env.database);
    env.database.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_failed',provider_turn_id='turn-tail',
      outcome='{"kind":"failed","text":null,"evidence":"transcript"}' WHERE inbox_item_id='tail'`).run();
    env.database.prepare(`INSERT INTO supervised_agent_provider_turn_bindings VALUES
      ('tail','agent','room','attempt','generation','continuation','turn-tail')`).run();
    env.database.prepare(`INSERT INTO supervised_agent_terminal_results VALUES
      ('tail','agent','generation','turn-tail','failed',NULL,'transcript',?, ?,?)`)
      .run(JSON.stringify({ turnId: "turn-tail", providerContinuationId: "continuation", outcome: "failed", text: null, evidence: "transcript" }), now, now);
    const before = legacyRows(env.database);
    const schemaVersion = Number((env.database.prepare("PRAGMA schema_version").get() as Row).schema_version);
    env.database.exec("PRAGMA writable_schema=ON");
    env.database.prepare("UPDATE sqlite_master SET sql=replace(sql, ?, ?) WHERE name='supervised_agent_inbox'").run(
      "failure_code TEXT CHECK(failure_code IS NULL OR failure_code='provider_continuation_missing')", "failure_code TEXT",
    );
    env.database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    const keys = env.database.prepare("PRAGMA foreign_key_list(supervised_agent_provider_turn_bindings)").all() as Row[];
    assert.ok(keys.every((key) => key.table === "supervised_agent_inbox"));
  } finally { await env.cleanup(); }
});

test("v18 refuses an unrecognized inbox dependency without cascading its rows away", async () => {
  const env = await fixture();
  try {
    restoreV17Fixture(env.database);
    seedLegacyEvidence(env.database);
    env.database.exec("CREATE TABLE future_inbox_child(id TEXT PRIMARY KEY,inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE) STRICT; INSERT INTO future_inbox_child VALUES('evidence','head')");
    const before = legacyRows(env.database);
    assert.throws(() => new DaemonStateSchema().createSchema(env.database), /unrecognized inbox dependency/);
    assert.deepEqual(legacyRows(env.database), before);
    assert.equal((env.database.prepare("PRAGMA user_version").get() as Row).user_version, 17);
  } finally { await env.cleanup(); }
});

test("a current schema with a lost typed journal fails closed rather than recreating empty authority", async () => {
  const env = await fixture();
  try {
    env.database.exec("DROP TABLE execution_retention_pins");
    assert.throws(() => new DaemonStateSchema().createSchema(env.database), /execution_retention_pins/);
    assert.equal(env.database.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_retention_pins'").get(), undefined);
  } finally { await env.cleanup(); }
});

test("v18 validates empty native-authority foreign keys, not only populated rows", async () => {
  const env = await fixture();
  try {
    const schemaVersion = Number((env.database.prepare("PRAGMA schema_version").get() as Row).schema_version);
    env.database.exec("PRAGMA writable_schema=ON");
    env.database.prepare("UPDATE sqlite_master SET sql=replace(sql, ?, ?) WHERE name='supervised_agent_provider_turn_bindings'").run(
      "REFERENCES supervised_agent_inbox", "REFERENCES missing_inbox",
    );
    env.database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
    assert.throws(() => new DaemonStateSchema().createSchema(env.database), /invalid inbox authority foreign key/);
  } finally { await env.cleanup(); }
});

test("future schema refusal precedes WAL conversion and initializer writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-future-schema-"));
  const path = join(directory, "daemon-state.sqlite");
  try {
    const future = new DatabaseSync(path);
    future.exec(`CREATE TABLE manifest_metadata(singleton INTEGER PRIMARY KEY,generation INTEGER,schema_version INTEGER);
      INSERT INTO manifest_metadata VALUES(1,7,${DAEMON_STATE_SCHEMA_VERSION + 1});
      PRAGMA user_version=${DAEMON_STATE_SCHEMA_VERSION + 1}`);
    future.close();
    const before = await readFile(path);
    let initialized = false;
    await assert.rejects(() => openDaemonStateDatabase(path, () => { initialized = true; }), /Unsupported daemon state schema version/);
    assert.equal(initialized, false);
    assert.deepEqual(await readFile(path), before);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try { assert.equal((inspection.prepare("PRAGMA journal_mode").get() as Row).journal_mode, "delete"); }
    finally { inspection.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("migration temporary row snapshots cannot spill plaintext to disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-migration-temp-"));
  try {
    const database = await openDaemonStateDatabase(join(directory, "state.sqlite"), (opened) => {
      assert.equal(opened.prepare("PRAGMA temp_store").get()!.temp_store, 2);
      new DaemonStateSchema().createSchema(opened);
    });
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("observation opener accepts current WAL with durable settings and no migration", async () => {
  const env = await fixture();
  try {
    const before = { version: versionPair(env.database), schema: env.database.prepare("SELECT * FROM sqlite_master ORDER BY name").all() };
    const observer = openDaemonStateObservationDatabase(env.path);
    try {
      for (const [pragma, expected] of Object.entries({ busy_timeout: 0, foreign_keys: 1, synchronous: 2, temp_store: 2, secure_delete: 1, journal_mode: "wal" })) {
        assert.equal(Object.values(observer.prepare(`PRAGMA ${pragma}`).get()!)[0], expected, pragma);
      }
      observer.exec("BEGIN IMMEDIATE; INSERT INTO execution_generations VALUES('writable-proof','agent',1); ROLLBACK");
      assert.equal(observer.prepare("SELECT 1 FROM execution_generations WHERE execution_generation_id='writable-proof'").get(), undefined);
      assert.deepEqual({ version: versionPair(observer), schema: observer.prepare("SELECT * FROM sqlite_master ORDER BY name").all() }, before);
    } finally { observer.close(); }
  } finally { await env.cleanup(); }
});

test("observation writer fails immediately behind a live writer without waiting or retrying", async () => {
  const env = await fixture();
  try {
    env.database.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const observer = openDaemonStateObservationDatabase(env.path);
    try {
      assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /database is locked|SQLITE_BUSY/i);
      assert.ok(performance.now() - started < 1000, "optional observation must not inherit the operational five-second busy timeout");
      env.database.exec("ROLLBACK");
      observer.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally { observer.close(); }
    env.database.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    const readBlockedAt = performance.now();
    assert.throws(() => openDaemonStateObservationDatabase(env.path), /database is locked|SQLITE_BUSY/i);
    assert.ok(performance.now() - readBlockedAt < 1000, "opening optional observation must also fail without a retry loop");
  } finally {
    try { env.database.exec("ROLLBACK"); } catch { /* the writer may already be released */ }
    await env.cleanup();
  }
});

test("observation opener never creates absent databases or directories and rejects an empty database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-observation-existing-"));
  try {
    assert.throws(() => openDaemonStateObservationDatabase(join(directory, "missing.sqlite")), /unable to open database file/);
    assert.throws(() => openDaemonStateObservationDatabase(join(directory, "missing-directory", "state.sqlite")), /unable to open database file/);
    assert.deepEqual(await readdir(directory), []);
    const path = join(directory, "empty.sqlite");
    new DatabaseSync(path).close();
    const before = await readFile(path);
    assert.throws(() => openDaemonStateObservationDatabase(path), /already-current schema/);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(directory), ["empty.sqlite"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("observation opener escapes URI metacharacters in existing local paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-observation-uri-"));
  try {
    const path = join(directory, "state space?#%.sqlite");
    const operational = await openDaemonStateDatabase(path, (database) => new DaemonStateSchema().createSchema(database));
    try {
      const observer = openDaemonStateObservationDatabase(path);
      try {
        observer.exec("BEGIN IMMEDIATE; INSERT INTO execution_generations VALUES('uri-proof','agent',1); COMMIT");
        assert.ok(operational.prepare("SELECT 1 FROM execution_generations WHERE execution_generation_id='uri-proof'").get());
      } finally { observer.close(); }
      assert.ok((await readdir(directory)).every((name) => name.startsWith("state space?#%.sqlite")));
    } finally { operational.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const invalid of ["older17", "older20", "older21", "newer", "non_wal", "typed_journal_missing", "legacy_journal_missing"] as const) {
  test(`observation opener rejects ${invalid} without migration, repair or WAL conversion`, async () => {
    const env = await fixture();
    try {
      if (invalid === "older17") restoreV17Fixture(env.database);
      if (invalid === "older20") restoreV20Fixture(env.database);
      if (invalid === "older21") restoreV21Fixture(env.database);
      if (invalid === "newer") env.database.exec(`UPDATE manifest_metadata SET schema_version=${DAEMON_STATE_SCHEMA_VERSION + 1}; PRAGMA user_version=${DAEMON_STATE_SCHEMA_VERSION + 1}`);
      if (invalid === "typed_journal_missing") env.database.exec("DROP TABLE execution_observer_sources");
      if (invalid === "legacy_journal_missing") env.database.exec("DROP TABLE supervised_agent_inbox_events");
      env.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (invalid === "non_wal") env.database.exec("PRAGMA journal_mode=DELETE");
      const before = await readFile(env.path);
      const schema = env.database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      const versions = versionPair(env.database);
      assert.throws(() => openDaemonStateObservationDatabase(env.path), /already-current schema|Unsupported daemon state schema|existing WAL journal mode|Execution storage schema mismatch|invalid strict schema/);
      assert.deepEqual(await readFile(env.path), before);
      assert.deepEqual(versionPair(env.database), versions);
      assert.deepEqual(env.database.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), schema);
      assert.equal(env.database.prepare("PRAGMA journal_mode").get()!.journal_mode, invalid === "non_wal" ? "delete" : "wal");
      if (invalid !== "non_wal") assert.equal((await readFile(`${env.path}-wal`)).length, 0);
    } finally { await env.cleanup(); }
  });
}

test("rejected future observation database does not checkpoint an unowned WAL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-observation-future-wal-"));
  const path = join(directory, "state.sqlite");
  try {
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE manifest_metadata(singleton INTEGER PRIMARY KEY,generation INTEGER,schema_version INTEGER); INSERT INTO manifest_metadata VALUES(1,1,${DAEMON_STATE_SCHEMA_VERSION + 1}); PRAGMA user_version=${DAEMON_STATE_SCHEMA_VERSION + 1}');
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const before = { database: await readFile(path), wal: await readFile(`${path}-wal`) };
    assert.ok(before.wal.length > 0);
    assert.throws(() => openDaemonStateObservationDatabase(path), /Unsupported daemon state schema version/);
    assert.deepEqual({ database: await readFile(path), wal: await readFile(`${path}-wal`) }, before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("v19 adds observer and proof slots without rewriting v18 evidence or rebuilding the inbox", async () => {
  const env = await fixture();
  try {
    restoreV18Fixture(env.database);
    seedLegacyEvidence(env.database); seedV18Evidence(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database) };
    const inboxSchema = env.database.prepare("SELECT rootpage,sql FROM sqlite_master WHERE name='supervised_agent_inbox'").get();
    const sequence = env.database.prepare("SELECT seq FROM sqlite_sequence WHERE name='execution_facts'").get();
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
    assert.deepEqual(env.database.prepare("SELECT rootpage,sql FROM sqlite_master WHERE name='supervised_agent_inbox'").get(), inboxSchema);
    assert.deepEqual(env.database.prepare("SELECT seq FROM sqlite_sequence WHERE name='execution_facts'").get(), sequence);
    assert.deepEqual(env.database.prepare("SELECT turn_outcome,control_evidence FROM execution_facts").all().map((row) => ({ ...row })), [
      { turn_outcome: null, control_evidence: null }, { turn_outcome: null, control_evidence: null },
    ]);
    assert.equal(env.database.prepare("SELECT projection_sha256 FROM execution_approval_decisions").get()!.projection_sha256, null);
    assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM execution_observers").get()!.count, 0);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => env.database.exec(`UPDATE execution_approval_decisions SET projection_sha256='${"a".repeat(64)}'`), /immutable/);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
  } finally { await env.cleanup(); }
});

test("v19 rolls its additive schema and immutable trigger back with the paired markers", async () => {
  const env = await fixture();
  try {
    restoreV18Fixture(env.database); seedLegacyEvidence(env.database); seedV18Evidence(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database) };
    const schema = env.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    assert.throws(() => new DaemonStateSchema((database) => {
      validateExecutionStorageSchema(database);
      throw new Error("interrupt v19 before markers");
    }).createSchema(env.database), /interrupt v19/);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database) }, before);
    assert.deepEqual(env.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    validateExecutionStorageSchema(env.database, 18);
    new DaemonStateSchema().createSchema(env.database);
    validateExecutionStorageSchema(env.database);
  } finally { await env.cleanup(); }
});

test("malformed v18 and missing current observers fail before WAL or initializer writes", async () => {
  const env = await fixture();
  try {
    restoreV18Fixture(env.database); seedV18Evidence(env.database);
    env.database.exec("DROP INDEX execution_facts_agent_sequence; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const before = await readFile(env.path);
    let initialized = false;
    await assert.rejects(() => openDaemonStateDatabase(env.path, () => { initialized = true; }), /Execution storage schema mismatch/);
    assert.equal(initialized, false);
    assert.deepEqual(await readFile(env.path), before);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, 18);
    env.database.exec("CREATE INDEX execution_facts_agent_sequence ON execution_facts(agent_id,sequence)");
    new DaemonStateSchema().createSchema(env.database);
    env.database.exec("DROP TABLE execution_observers");
    assert.throws(() => new DaemonStateSchema().createSchema(env.database), /execution_observers/);
    assert.equal(env.database.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_observers'").get(), undefined);
  } finally { await env.cleanup(); }
});

test("v19 upgrade preserves old outcomes, identity and rowids while advancing terminal, source and cutover storage", async () => {
  const env = await fixture();
  try {
    restoreV19Fixture(env.database); seedLegacyEvidence(env.database); seedV18Evidence(env.database);
    env.database.exec(`UPDATE supervised_agent_terminal_results SET rowid=71;
      INSERT INTO supervised_agent_terminal_results VALUES('tail','agent','generation','turn-tail','no_reply',NULL,'none','{ "opaque": true }','then','now');
      INSERT INTO supervised_agent_inbox(inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,created_at,updated_at)
        VALUES('unreadable','agent','room','unreadable','{}','{}',3,'blocked',1,'unreadable','unreadable','then','now');
      INSERT INTO supervised_agent_terminal_results VALUES('unreadable','agent','generation','turn-unreadable','unreadable',NULL,'none','{ "original": "unreadable" }','then','now')`);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database) };
    const retainedSchema = () => env.database.prepare(`SELECT type,name,rootpage,sql FROM sqlite_master
      WHERE tbl_name NOT IN ('agent_configurations','runtime_deployments','supervised_agent_terminal_results','execution_observers','execution_observer_sources','execution_cutover_v2','custodial_polling_activations','custodial_polling_offers') ORDER BY type,name`).all();
    const unrelatedSchema = retainedSchema();
    const rowids = env.database.prepare("SELECT rowid,* FROM supervised_agent_terminal_results ORDER BY rowid").all();
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
    assert.deepEqual(retainedSchema(), unrelatedSchema, "no unrelated table, index or trigger is rebuilt");
    assert.deepEqual(env.database.prepare("SELECT rowid,* FROM supervised_agent_terminal_results ORDER BY rowid").all(), rowids);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => env.database.exec("UPDATE supervised_agent_terminal_results SET provider_turn_id='turn-head' WHERE inbox_item_id='tail'"), /UNIQUE/);
    assert.throws(() => env.database.exec("UPDATE supervised_agent_terminal_results SET inbox_item_id='missing' WHERE inbox_item_id='tail'"), /FOREIGN KEY/);
    assert.equal(env.database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
  } finally { await env.cleanup(); }
});

for (const version of [0, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]) test(`fresh/legacy v${version} reaches current schema with constrained native failure slots and source identity`, async () => {
  const env = await fixture();
  try {
    if (version === 17) restoreV17Fixture(env.database);
    else if (version === 18) restoreV18Fixture(env.database);
    else if (version === 19) restoreV19Fixture(env.database);
    else if (version === 20) restoreV20Fixture(env.database);
    else if (version === 21) restoreV21Fixture(env.database);
    else if (version === 22) restoreV22Fixture(env.database);
    else if (version === 23) restoreV23Fixture(env.database);
    else if (version === 24) restoreV24Fixture(env.database);
    else if (version) {
      restoreV17Fixture(env.database);
      env.database.exec(`UPDATE manifest_metadata SET schema_version=${version} WHERE singleton=1; PRAGMA user_version=${version}`);
    }
    seedLegacyEvidence(env.database);
    const before = legacyRows(env.database);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before);
    assert.ok(env.database.prepare("SELECT polling_contract FROM agent_configurations").all().every((row) => row.polling_contract === null));
    validatePollingActivationSchema(env.database);
    assert.equal(env.database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_activations").get()!.n, 0, "upgrades cannot manufacture operator activation intent");
    validatePollingOfferSchema(env.database);
    assert.equal(env.database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_offers").get()!.n, 0, "upgrades cannot manufacture released polling coverage");
    env.database.exec("DELETE FROM supervised_agent_publications WHERE inbox_item_id='head'");
    const update = env.database.prepare("UPDATE supervised_agent_terminal_results SET outcome=?,normalized_text=?,evidence_source=? WHERE inbox_item_id='head'");
    for (const outcome of ["failed", "interrupted"]) {
      assert.throws(() => update.run(outcome, "not a reply", "stream"), /CHECK/);
      assert.throws(() => update.run(outcome, null, "none"), /CHECK/);
      for (const source of ["transcript", "stream"]) update.run(outcome, null, source);
      env.database.prepare("UPDATE supervised_agent_inbox SET outcome=? WHERE inbox_item_id='head'")
        .run(JSON.stringify({ kind: outcome, text: null, evidence: "stream" }));
      env.database.prepare("UPDATE supervised_agent_terminal_results SET terminal_evidence_json=? WHERE inbox_item_id='head'")
        .run(JSON.stringify({ turnId: "turn-head", providerContinuationId: "continuation", outcome, text: null, evidence: "stream" }));
      new DaemonStateSchema().createSchema(env.database);
      assert.equal(env.database.prepare("SELECT outcome FROM supervised_agent_terminal_results WHERE inbox_item_id='head'").get()!.outcome, outcome);
    }
    update.run("unreadable", null, "none");
    assert.throws(() => update.run("invented", null, "stream"), /CHECK/);
    assert.equal(env.database.prepare("SELECT state FROM supervised_agent_inbox WHERE inbox_item_id='head'").get()!.state, "blocked", "storage never settles delivery");
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    validateExecutionStorageSchema(env.database);
    assert.ok(env.database.prepare("PRAGMA table_info(execution_observers)").all().some((row) => row.name === "source_id"));
  } finally { await env.cleanup(); }
});

test("v20 terminal rebuild and paired markers roll back together after validation", async () => {
  const env = await fixture();
  try {
    restoreV19Fixture(env.database); seedLegacyEvidence(env.database); seedV18Evidence(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database) };
    const schema = env.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    assert.throws(() => new DaemonStateSchema((database) => {
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 19);
      assert.equal(database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, 19);
      database.exec("UPDATE supervised_agent_terminal_results SET outcome='interrupted',normalized_text=NULL,evidence_source='stream'");
      throw new Error("interrupt v20 after evidence validation");
    }).createSchema(env.database), /interrupt v20/);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database) }, before);
    assert.deepEqual(env.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    assert.throws(() => env.database.exec("UPDATE supervised_agent_terminal_results SET outcome='failed'"), /CHECK/);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, { legacy: before.legacy, typed: before.typed });
  } finally { await env.cleanup(); }
});

test("v21 adds unknown source provenance without resetting cursors or rebuilding existing tables", async () => {
  const env = await fixture();
  try {
    restoreV20Fixture(env.database);
    seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedV19Observer(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database) };
    const observer = env.database.prepare("SELECT rowid,* FROM execution_observers").get();
    const rootpage = env.database.prepare("SELECT rootpage FROM sqlite_master WHERE name='execution_observers'").get();
    const unrelatedSchema = () => env.database.prepare(`SELECT type,name,rootpage,sql FROM sqlite_master
      WHERE tbl_name NOT IN ('agent_configurations','runtime_deployments','execution_observers','execution_observer_sources','execution_cutover_v2','custodial_polling_activations','custodial_polling_offers') ORDER BY type,name`).all();
    const schema = unrelatedSchema();
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
    assert.deepEqual({ ...env.database.prepare("SELECT rowid,* FROM execution_observers").get() }, { ...observer, source_id: null });
    assert.deepEqual(env.database.prepare("SELECT rootpage FROM sqlite_master WHERE name='execution_observers'").get(), rootpage);
    assert.deepEqual(unrelatedSchema(), schema);
    assert.deepEqual(env.database.prepare("SELECT * FROM execution_observer_sources").all(), [], "migration never manufactures admitted sources");
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal(env.database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, DAEMON_STATE_SCHEMA_VERSION);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ ...env.database.prepare("SELECT rowid,* FROM execution_observers").get() }, { ...observer, source_id: null });
    env.database.exec(`UPDATE execution_observers SET source_id='new-source';
      INSERT INTO execution_observer_sources VALUES('agent','new-source')`);
    const reopened = await openDaemonStateDatabase(env.path, (database) => new DaemonStateSchema().createSchema(database));
    try {
      assert.deepEqual({ ...reopened.prepare("SELECT source_id,last_source_sequence,max_observed_sequence FROM execution_observers").get() },
        { source_id: "new-source", last_source_sequence: 42, max_observed_sequence: 50 });
      assert.deepEqual(reopened.prepare("SELECT * FROM execution_observer_sources").all().map((row) => ({ ...row })),
        [{ agent_id: "agent", source_id: "new-source" }]);
    } finally { reopened.close(); }
  } finally { await env.cleanup(); }
});

test("v21 source column and admission memory roll back atomically with the old observer and version pair", async () => {
  const env = await fixture();
  try {
    restoreV20Fixture(env.database);
    seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedV19Observer(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database), observer: env.database.prepare("SELECT * FROM execution_observers").all(), versions: versionPair(env.database) };
    const schema = env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all();
    assert.throws(() => new DaemonStateSchema((database) => {
      validateExecutionStorageSchema(database);
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 20);
      assert.equal(database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, 20);
      assert.equal(database.prepare("SELECT source_id FROM execution_observers").get()!.source_id, null);
      database.exec("INSERT INTO execution_observer_sources VALUES('agent','uncommitted-source')");
      throw new Error("interrupt v21 before markers");
    }).createSchema(env.database), /interrupt v21/);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database), observer: env.database.prepare("SELECT * FROM execution_observers").all(), versions: versionPair(env.database) }, before);
    assert.deepEqual(env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    validateExecutionStorageSchema(env.database, 19);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(env.database.prepare("SELECT * FROM execution_observer_sources").all(), []);
    assert.equal(env.database.prepare("SELECT last_source_sequence FROM execution_observers").get()!.last_source_sequence, 42);
  } finally { await env.cleanup(); }
});

test("v22 preserves dormant cutover rows, rowids and legacy uncertainty without manufacturing native authority", async () => {
  const env = await fixture();
  try {
    restoreV21Fixture(env.database);
    seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedDormantCutovers(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database) };
    const rows = env.database.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all();
    const oldColumns = Object.keys(rows[0]!);
    const unrelatedSchema = () => env.database.prepare(`SELECT type,name,rootpage,sql FROM sqlite_master
      WHERE tbl_name NOT IN ('agent_configurations','runtime_deployments','execution_cutover_v2','custodial_polling_activations','custodial_polling_offers') ORDER BY type,name`).all();
    const schema = unrelatedSchema();
    new DaemonStateSchema().createSchema(env.database);
    const migrated = env.database.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all();
    assert.deepEqual(migrated.map(row => Object.fromEntries(oldColumns.map(column => [column, row[column]]))), rows.map(row => ({ ...row })));
    const addedColumns = Object.keys(migrated[0]!).filter(column => !oldColumns.includes(column));
    assert.deepEqual([...addedColumns].sort(), ["authority_version", "room_id", "work_attempt_id", "provider", "native_continuation_id",
      "native_connection_kind", "native_connection_sha256", "native_pid", "native_process_identity", "native_target_turn_id",
      "admitted_inbox_item_id", "admitted_source_message_id", "admitted_action_id"].sort());
    for (const row of migrated) for (const column of addedColumns) assert.equal(row[column], null, column);
    assert.deepEqual(legacyRows(env.database), before.legacy);
    const typed = typedRows(env.database);
    for (const [table, original] of Object.entries(before.typed)) if (table !== "execution_cutover_v2") assert.deepEqual(typed[table], original, table);
    assert.deepEqual(unrelatedSchema(), schema, "only cutover storage and the later polling configuration column may change");
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal(env.database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.throws(() => validateExecutionStorageSchema(env.database, 20), /Execution storage schema mismatch/);
    const reopened = await openDaemonStateDatabase(env.path, database => new DaemonStateSchema().createSchema(database));
    try {
      assert.deepEqual(reopened.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all(), migrated);
      assert.deepEqual(legacyRows(reopened), before.legacy);
    } finally { reopened.close(); }
  } finally { await env.cleanup(); }
});

test("v22 cutover rebuild and both markers roll back together after validation", async () => {
  const env = await fixture();
  try {
    restoreV21Fixture(env.database);
    seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedDormantCutovers(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database),
      cutovers: env.database.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all() };
    const schema = env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all();
    assert.throws(() => new DaemonStateSchema(database => {
      validateExecutionStorageSchema(database);
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 21);
      assert.equal(database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, 21);
      throw new Error("interrupt v22 before markers");
    }).createSchema(env.database), /interrupt v22/);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database),
      cutovers: env.database.prepare("SELECT rowid,* FROM execution_cutover_v2 ORDER BY rowid").all() }, before);
    assert.deepEqual(env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    validateExecutionStorageSchema(env.database, 20);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before.legacy);
  } finally { await env.cleanup(); }
});

test("v23 adds nullable polling custody without reinterpreting modes, cutovers or native authority", async () => {
  const env = await fixture();
  try {
    restoreV22Fixture(env.database); seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedDormantCutovers(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database) };
    const configurations = env.database.prepare("SELECT rowid,* FROM agent_configurations ORDER BY rowid").all();
    const unrelatedSchema = () => env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master WHERE tbl_name NOT IN ('agent_configurations','runtime_deployments','custodial_polling_activations','custodial_polling_offers') ORDER BY type,name").all();
    const schema = unrelatedSchema();
    const rootpage = env.database.prepare("SELECT rootpage FROM sqlite_master WHERE name='agent_configurations'").get();
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
    assert.deepEqual(env.database.prepare("SELECT rowid,* FROM agent_configurations ORDER BY rowid").all().map(row => ({ ...row })),
      configurations.map(row => ({ ...row, polling_contract: null })));
    assert.deepEqual(unrelatedSchema(), schema);
    assert.deepEqual(env.database.prepare("SELECT rootpage FROM sqlite_master WHERE name='agent_configurations'").get(), rootpage);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.deepEqual({ ...env.database.prepare("SELECT generation,schema_version FROM manifest_metadata").get() },
      { generation: 0, schema_version: DAEMON_STATE_SCHEMA_VERSION });
    validateExecutionStorageSchema(env.database, 21);
    assert.throws(() => env.database.exec("UPDATE agent_configurations SET polling_contract='custodial_polling_v1' WHERE agent_id='agent'"), /CHECK/);
    assert.throws(() => env.database.exec("UPDATE agent_configurations SET polling_contract='invented' WHERE agent_id='dispatching-agent'"), /CHECK/);
    env.database.exec("UPDATE agent_configurations SET polling_contract='custodial_polling_v1' WHERE agent_id='dispatching-agent'");
    assert.throws(() => env.database.exec("UPDATE agent_configurations SET delivery_mode='daemon_inbox' WHERE agent_id='dispatching-agent'"), /CHECK/);
    new DaemonStateSchema().createSchema(env.database);
    const reopened = await openDaemonStateDatabase(env.path, database => new DaemonStateSchema().createSchema(database));
    try {
      assert.equal(reopened.prepare("SELECT polling_contract FROM agent_configurations WHERE agent_id='dispatching-agent'").get()!.polling_contract, "custodial_polling_v1");
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { reopened.close(); }
  } finally { await env.cleanup(); }
});

test("v23 custody addition and version markers roll back together before commit", async () => {
  const env = await fixture();
  try {
    restoreV22Fixture(env.database); seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedDormantCutovers(env.database);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database),
      schema: env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all() };
    assert.throws(() => new DaemonStateSchema(database => {
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 22);
      assert.equal(database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, 22);
      assert.ok(database.prepare("SELECT polling_contract FROM agent_configurations").all().every(row => row.polling_contract === null));
      throw new Error("interrupt v23 before markers");
    }).createSchema(env.database), /interrupt v23/);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database), versions: versionPair(env.database),
      schema: env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all() }, before);
    new DaemonStateSchema().createSchema(env.database);
    assert.ok(env.database.prepare("SELECT polling_contract FROM agent_configurations").all().every(row => row.polling_contract === null));
  } finally { await env.cleanup(); }
});

test("v23 refuses missing, weakened or invalid polling custody before WAL and repair writes", async () => {
  for (const corruption of [
    "ALTER TABLE agent_configurations DROP COLUMN polling_contract",
    "ALTER TABLE agent_configurations DROP COLUMN polling_contract; ALTER TABLE agent_configurations ADD COLUMN polling_contract TEXT",
    "ALTER TABLE agent_configurations DROP COLUMN polling_contract; ALTER TABLE agent_configurations ADD COLUMN polling_contract TEXT CHECK(polling_contract IS NULL OR (polling_contract='custodial_polling_v1' AND delivery_mode='mcp_polling')) COLLATE NOCASE",
    "PRAGMA ignore_check_constraints=ON; UPDATE agent_configurations SET polling_contract='unknown' WHERE agent_id='dispatching-agent'",
    "PRAGMA ignore_check_constraints=ON; UPDATE agent_configurations SET polling_contract='custodial_polling_v1' WHERE agent_id='agent'",
  ]) {
    const env = await fixture();
    try {
      seedLegacyEvidence(env.database);
      env.database.exec(`${corruption}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path);
      let initialized = false;
      await assert.rejects(() => openDaemonStateDatabase(env.path, () => { initialized = true; }), /polling custody/);
      assert.equal(initialized, false);
      assert.deepEqual(await readFile(env.path), before);
      assert.throws(() => new DaemonStateSchema().createSchema(env.database), /polling custody/);
      assert.deepEqual(await readFile(env.path), before);
      assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    } finally { await env.cleanup(); }
  }
});

test("v24 creates an empty activation journal and nullable launch receipt without backfilling v23 authority", async () => {
  const env = await fixture();
  try {
    restoreV23Fixture(env.database); seedLegacyEvidence(env.database); seedV18Evidence(env.database); seedDormantCutovers(env.database);
    env.database.exec(`INSERT INTO runtime_deployments
      (agent_id,observed_state,workspace_path_present,work_attempt_id_present,provider_ref_present,provider_process_identity_present,
       workplace_liveness_present,native_liveness_present,activity_present) VALUES('agent','stopped',0,0,0,0,0,0,0)`);
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database) };
    const retainedSchema = () => env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master WHERE tbl_name NOT IN ('custodial_polling_activations','custodial_polling_offers','runtime_deployments') ORDER BY type,name").all();
    const schema = retainedSchema();
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database) }, before);
    assert.deepEqual(retainedSchema(), schema);
    assert.equal(env.database.prepare("SELECT COUNT(*) AS n FROM custodial_polling_activations").get()!.n, 0);
    assert.equal(env.database.prepare("SELECT COUNT(*) AS n FROM runtime_deployments WHERE custodial_launch_agent_session_id IS NOT NULL").get()!.n, 0);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    validateExecutionStorageSchema(env.database, 21); validatePollingActivationSchema(env.database);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_list(custodial_polling_activations)").all(), [],
      "the journal cannot be erased by compatibility manifest replacement");
    const columns = env.database.prepare("PRAGMA table_info(custodial_polling_activations)").all().map(row => String(row.name));
    assert.ok(columns.every(column => !/token|bearer|secret|output|prompt/.test(column)));
    const reopened = await openDaemonStateDatabase(env.path, database => new DaemonStateSchema().createSchema(database));
    try { validatePollingActivationSchema(reopened); assert.deepEqual(legacyRows(reopened), before.legacy); }
    finally { reopened.close(); }
  } finally { await env.cleanup(); }
});

test("v24 journal DDL and paired version markers roll back together", async () => {
  const env = await fixture();
  try {
    restoreV23Fixture(env.database); seedLegacyEvidence(env.database);
    const before = { versions: versionPair(env.database), legacy: legacyRows(env.database),
      schema: env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all() };
    assert.throws(() => new DaemonStateSchema(database => {
      validatePollingActivationSchema(database);
      assert.deepEqual(versionPair(database), before.versions);
      throw new Error("interrupt activation migration");
    }).createSchema(env.database), /interrupt activation migration/);
    assert.deepEqual({ versions: versionPair(env.database), legacy: legacyRows(env.database),
      schema: env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all() }, before);
    assert.equal(env.database.prepare("SELECT 1 FROM sqlite_master WHERE name='custodial_polling_activations'").get(), undefined);
    new DaemonStateSchema().createSchema(env.database);
    validatePollingActivationSchema(env.database);
  } finally { await env.cleanup(); }
});

test("v24 refuses lost or weakened activation authority before WAL or repair writes", async () => {
  for (const corruption of [
    "DROP TABLE custodial_polling_activations",
    "DROP INDEX custodial_polling_activation_one_unresolved",
    "DROP TRIGGER custodial_polling_activation_identity_immutable",
    "DROP TRIGGER custodial_polling_activation_phase",
    "DROP TRIGGER custodial_polling_activation_predecessor",
    "ALTER TABLE custodial_polling_activations ADD COLUMN unrelated TEXT",
  ]) {
    const env = await fixture();
    try {
      env.database.exec(`${corruption}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path); let initialized = false;
      await assert.rejects(openDaemonStateDatabase(env.path, () => { initialized = true; }), /activation journal/);
      assert.equal(initialized, false);
      assert.deepEqual(await readFile(env.path), before);
      assert.throws(() => new DaemonStateSchema().createSchema(env.database), /activation journal/);
      assert.deepEqual(await readFile(env.path), before);
    } finally { await env.cleanup(); }
  }
});

test("v24 refuses a missing or weakened native launch receipt before WAL and never reconstructs it", async () => {
  for (const corruption of [
    "ALTER TABLE runtime_deployments DROP COLUMN custodial_launch_agent_session_id",
    "ALTER TABLE runtime_deployments DROP COLUMN custodial_launch_agent_session_id; ALTER TABLE runtime_deployments ADD COLUMN custodial_launch_agent_session_id TEXT",
  ]) {
    const env = await fixture();
    try {
      env.database.exec(`${corruption}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path); let initialized = false;
      await assert.rejects(openDaemonStateDatabase(env.path, () => { initialized = true; }), /launch receipt/);
      assert.equal(initialized, false); assert.deepEqual(await readFile(env.path), before);
      assert.throws(() => new DaemonStateSchema().createSchema(env.database), /launch receipt/);
      assert.deepEqual(await readFile(env.path), before);
    } finally { await env.cleanup(); }
  }
});

test("v25 adds empty offer storage without manufacturing coverage for old activations", async () => {
  const env = await fixture();
  try {
    restoreV24Fixture(env.database); seedLegacyEvidence(env.database);
    env.database.exec(`INSERT INTO execution_cutover_v2
      (operation_id,request_id,agent_id,execution_generation_id,from_mode,to_mode,strategy,phase,created_at_ms,updated_at_ms,
       authority_version,room_id,work_attempt_id,provider,native_continuation_id,native_connection_kind,native_connection_sha256,native_pid,native_process_identity)
      VALUES('reverse','reverse-request','agent','reverse-generation','daemon_inbox','mcp_polling','drain','complete',100,110,
       1,'room','attempt','codex','continuation','codex_app_server','${"a".repeat(64)}',123,'birth:123')`);
    const insert = env.database.prepare(`INSERT INTO custodial_polling_activations
      (operation_id,request_id,agent_id,room_id,work_attempt_id,execution_generation_id,reverse_operation_id,native_continuation_id,
       native_connection_kind,native_connection_sha256,native_pid,native_process_identity,config_revision,agent_session_id,room_cursor,
       phase,provider_turn_id,terminal_outcome,created_at_ms,updated_at_ms)
      VALUES(?,?,'agent','room','attempt','polling-generation','reverse','continuation','codex_app_server',?,123,'birth:123',2,'session','msg_47',
       'prepared',NULL,NULL,120,120)`);
    for (const phase of ["complete", "uncertain"]) {
      insert.run(phase, `request-${phase}`, "b".repeat(64));
      env.database.prepare("UPDATE custodial_polling_activations SET phase='dispatching' WHERE operation_id=?").run(phase);
      env.database.prepare("UPDATE custodial_polling_activations SET phase='active',provider_turn_id=? WHERE operation_id=?").run(`native-${phase}`, phase);
      env.database.prepare("UPDATE custodial_polling_activations SET phase=?,terminal_outcome=? WHERE operation_id=?")
        .run(phase, phase === "complete" ? "completed" : null, phase);
    }
    const before = { legacy: legacyRows(env.database), typed: typedRows(env.database),
      activations: env.database.prepare("SELECT rowid,* FROM custodial_polling_activations ORDER BY rowid").all() };
    const retainedSchema = () => env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master WHERE tbl_name<>'custodial_polling_offers' ORDER BY type,name").all();
    const schema = retainedSchema();
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual({ legacy: legacyRows(env.database), typed: typedRows(env.database),
      activations: env.database.prepare("SELECT rowid,* FROM custodial_polling_activations ORDER BY rowid").all() }, before);
    assert.deepEqual(retainedSchema(), schema, "offer DDL does not rebuild any existing journal or table");
    assert.deepEqual(env.database.prepare("SELECT * FROM custodial_polling_offers").all(), [], "old activations have no inferred offer or ACK evidence");
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.deepEqual({ ...env.database.prepare("SELECT generation,schema_version FROM manifest_metadata").get() },
      { generation: 0, schema_version: DAEMON_STATE_SCHEMA_VERSION });
    validatePollingOfferSchema(env.database); validatePollingActivationSchema(env.database); validateExecutionStorageSchema(env.database, 21);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    const columns = env.database.prepare("PRAGMA table_info(custodial_polling_offers)").all().map(row => String(row.name));
    assert.ok(columns.every(column => !/token|bearer|secret|output|prompt/.test(column)));
    const reopened = await openDaemonStateDatabase(env.path, database => new DaemonStateSchema().createSchema(database));
    try {
      validatePollingOfferSchema(reopened);
      assert.deepEqual(reopened.prepare("SELECT * FROM custodial_polling_offers").all(), []);
      assert.deepEqual(reopened.prepare("SELECT rowid,* FROM custodial_polling_activations ORDER BY rowid").all(), before.activations);
      assert.deepEqual(legacyRows(reopened), before.legacy);
    } finally { reopened.close(); }
  } finally { await env.cleanup(); }
});

test("v25 offer DDL and paired markers roll back together before commit", async () => {
  const env = await fixture();
  try {
    restoreV24Fixture(env.database); seedLegacyEvidence(env.database);
    const before = { versions: versionPair(env.database), legacy: legacyRows(env.database), typed: typedRows(env.database),
      schema: env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all() };
    assert.throws(() => new DaemonStateSchema(database => {
      validatePollingOfferSchema(database);
      assert.deepEqual(versionPair(database), before.versions);
      throw new Error("interrupt offer migration");
    }).createSchema(env.database), /interrupt offer migration/);
    assert.deepEqual({ versions: versionPair(env.database), legacy: legacyRows(env.database), typed: typedRows(env.database),
      schema: env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all() }, before);
    assert.equal(env.database.prepare("SELECT 1 FROM sqlite_master WHERE name='custodial_polling_offers'").get(), undefined);
    new DaemonStateSchema().createSchema(env.database);
    validatePollingOfferSchema(env.database);
    assert.deepEqual(env.database.prepare("SELECT * FROM custodial_polling_offers").all(), []);
  } finally { await env.cleanup(); }
});

test("v25 refuses lost or weakened offer authority before WAL or initializer writes", async () => {
  for (const corruption of [
    "DROP TABLE custodial_polling_offers",
    "DROP INDEX custodial_polling_offer_one_root",
    "DROP TRIGGER custodial_polling_offer_append",
    "DROP TRIGGER custodial_polling_offer_immutable",
    "DROP TRIGGER custodial_polling_offer_no_delete",
    "ALTER TABLE custodial_polling_offers ADD COLUMN unrelated TEXT",
    "UPDATE sqlite_master SET sql=replace(sql, 'CHECK(length(process_incarnation_id)=36)', '') WHERE name='custodial_polling_offers'",
    "UPDATE sqlite_master SET sql=replace(sql, 'ON DELETE RESTRICT', 'ON DELETE CASCADE') WHERE name='custodial_polling_offers'",
  ]) {
    const env = await fixture();
    try {
      const schemaVersion = Number(env.database.prepare("PRAGMA schema_version").get()!.schema_version);
      env.database.exec(`PRAGMA writable_schema=ON; ${corruption}; PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1};
        PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path); let initialized = false;
      const versions = versionPair(env.database);
      const schema = env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all();
      await assert.rejects(openDaemonStateDatabase(env.path, () => { initialized = true; }), /offer journal/);
      assert.equal(initialized, false);
      assert.deepEqual(await readFile(env.path), before);
      assert.throws(() => new DaemonStateSchema().createSchema(env.database), /offer journal/);
      assert.deepEqual(await readFile(env.path), before);
      assert.deepEqual(versionPair(env.database), versions);
      assert.deepEqual(env.database.prepare("SELECT type,name,rootpage,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    } finally { await env.cleanup(); }
  }
});

for (const version of [21, 22]) test(`v${version} refuses missing or weakened cutover authority before WAL or initializer writes`, async () => {
  for (const corruption of ["DROP TABLE execution_cutover_v2", "DROP INDEX execution_cutover_one_unresolved"]) {
    const env = await fixture();
    try {
      if (version === 21) restoreV21Fixture(env.database);
      else restoreV22Fixture(env.database);
      env.database.exec(`${corruption}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path);
      let initialized = false;
      await assert.rejects(() => openDaemonStateDatabase(env.path, () => { initialized = true; }), /Execution storage schema mismatch/);
      assert.equal(initialized, false);
      assert.deepEqual(await readFile(env.path), before);
      assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, version);
    } finally { await env.cleanup(); }
  }
});

for (const version of [20, 21, 22]) test(`v${version} rejects malformed source storage before WAL or initializer writes`, async () => {
  for (const corruption of version === 20
    ? ["ALTER TABLE execution_observers ADD COLUMN source_id TEXT", "DROP TABLE execution_observers"]
    : ["ALTER TABLE execution_observers DROP COLUMN source_id", "DROP TABLE execution_observer_sources"]) {
    const env = await fixture();
    try {
      if (version === 20) restoreV20Fixture(env.database);
      if (version === 21) restoreV21Fixture(env.database);
      if (version === 22) restoreV22Fixture(env.database);
      env.database.exec(`${corruption}; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path);
      let initialized = false;
      await assert.rejects(() => openDaemonStateDatabase(env.path, () => { initialized = true; }), /Execution storage schema mismatch/);
      assert.equal(initialized, false);
      assert.deepEqual(await readFile(env.path), before);
      assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, version);
    } finally { await env.cleanup(); }
  }
});

for (const version of [19, 20, 21, 22]) test(`v${version} refuses missing or weakened terminal authority before WAL or repair writes`, async () => {
  const corruptions = [
    "DROP TABLE supervised_agent_terminal_results",
    "UPDATE sqlite_master SET sql=replace(sql, 'outcome TEXT NOT NULL CHECK(outcome IN (''reply'',''no_reply'',''unreadable''))', 'outcome TEXT NOT NULL') WHERE name='supervised_agent_terminal_results'",
    "UPDATE sqlite_master SET sql=replace(sql, 'ON DELETE CASCADE', 'ON DELETE SET NULL') WHERE name='supervised_agent_terminal_results'",
    "UPDATE sqlite_master SET sql=replace(sql, 'REFERENCES supervised_agent_inbox', 'REFERENCES missing_inbox') WHERE name='supervised_agent_terminal_results'",
    "UPDATE sqlite_master SET sql=replace(sql, '''reply''', '''REPLY''') WHERE name='supervised_agent_terminal_results'",
    "DROP INDEX supervised_agent_terminal_result_turn; CREATE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id)",
    "DROP INDEX supervised_agent_terminal_result_turn; CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,provider_turn_id)",
    "CREATE TABLE unexpected_terminal_child(inbox_item_id TEXT REFERENCES supervised_agent_terminal_results(inbox_item_id) ON DELETE CASCADE) STRICT",
  ];
  if (version >= 20) corruptions[1] = "UPDATE sqlite_master SET sql=replace(sql, ',CHECK(outcome NOT IN (''failed'',''interrupted'') OR (normalized_text IS NULL AND evidence_source <> ''none''))', '') WHERE name='supervised_agent_terminal_results'";
  for (const corruption of corruptions) {
    const env = await fixture();
    try {
      if (version === 19) restoreV19Fixture(env.database);
      if (version === 20) restoreV20Fixture(env.database);
      if (version === 21) restoreV21Fixture(env.database);
      if (version === 22) restoreV22Fixture(env.database);
      const schemaVersion = Number(env.database.prepare("PRAGMA schema_version").get()!.schema_version);
      env.database.exec(`PRAGMA writable_schema=ON; ${corruption}; PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1};
        PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE`);
      const before = await readFile(env.path);
      let initialized = false;
      await assert.rejects(() => openDaemonStateDatabase(env.path, () => { initialized = true; }), /terminal-result authority/, corruption);
      assert.equal(initialized, false);
      assert.deepEqual(await readFile(env.path), before);
      assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, version);
    } finally { await env.cleanup(); }
  }
});

test("v19 refuses an unexpected populated terminal dependency without cascading its evidence", async () => {
  const env = await fixture();
  try {
    restoreV19Fixture(env.database); seedLegacyEvidence(env.database);
    env.database.exec(`CREATE TABLE unexpected_terminal_child(inbox_item_id TEXT REFERENCES supervised_agent_terminal_results(inbox_item_id) ON DELETE CASCADE) STRICT;
      INSERT INTO unexpected_terminal_child VALUES('head')`);
    const before = legacyRows(env.database);
    assert.throws(() => new DaemonStateSchema().createSchema(env.database), /unrecognized inbound dependency/);
    assert.deepEqual(legacyRows(env.database), before);
    assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, 19);
  } finally { await env.cleanup(); }
});

test("v20 refuses populated orphan or fabricated terminal evidence without changing it", async () => {
  for (const corruption of [
    "PRAGMA foreign_keys=OFF; UPDATE supervised_agent_terminal_results SET inbox_item_id='missing'",
    "PRAGMA ignore_check_constraints=ON; UPDATE supervised_agent_terminal_results SET outcome='failed',evidence_source='none'",
  ]) {
    const env = await fixture();
    try {
      seedLegacyEvidence(env.database); env.database.exec(corruption);
      const before = legacyRows(env.database);
      assert.throws(() => new DaemonStateSchema().createSchema(env.database), /terminal-result authority contains invalid evidence/);
      assert.deepEqual(legacyRows(env.database), before);
    } finally { await env.cleanup(); }
  }
});
