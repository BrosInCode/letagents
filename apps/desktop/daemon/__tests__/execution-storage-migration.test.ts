import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema, openDaemonStateDatabase } from "../daemon-state-database.js";
import { validateExecutionStorageSchema } from "../execution-storage-schema.js";

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
function restoreV17Fixture(database: DatabaseSync): void {
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
      AND name<>'manifest_metadata' ORDER BY name`).all() as Row[])
    .map((row) => [String(row.name), database.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]));
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
    new DaemonStateSchema().createSchema(env.database);
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

test("a killed migrator leaves the complete v17 graph recoverable from WAL", async () => {
  const env = await fixture();
  try {
    restoreV17Fixture(env.database);
    seedLegacyEvidence(env.database);
    const before = legacyRows(env.database);
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
    assert.equal((env.database.prepare("PRAGMA user_version").get() as Row).user_version, 17);
    assert.deepEqual(env.database.prepare("PRAGMA foreign_key_check").all(), []);
    new DaemonStateSchema().createSchema(env.database);
    assert.deepEqual(legacyRows(env.database), before);
  } finally { await env.cleanup(); }
});

test("current predecessor repair preserves populated native-turn authority and the v18 terminal allowance", async () => {
  const env = await fixture();
  try {
    seedLegacyEvidence(env.database);
    env.database.prepare("UPDATE supervised_agent_inbox SET state='acknowledged_failed' WHERE inbox_item_id='tail'").run();
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
