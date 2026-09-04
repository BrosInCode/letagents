import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cleanupStateRecoveryBackup, decryptStateRecoveryBackup, markStateRecoveryBackupValidated,
  prepareStateRecoveryBackup, StateRecoveryError, type StateRecoveryBackup,
} from "../state-recovery-backup.js";
import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema, openDaemonStateDatabase } from "../daemon-state-database.js";
import { requestStateRecoveryKey, withProtectedStateUpgrade } from "../state-recovery-key.js";
import { DaemonLifecycleLog, daemonLifecycleErrorDetail } from "../lifecycle-log.js";

const ERROR = /Encrypted daemon recovery snapshot could not be verified safely\./;
const OLD = new Date("2026-08-30T00:00:00.000Z");
const secret = "worker-bearer-do-not-copy-to-plaintext-recovery";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "letagents-encrypted-state-"));
  const path = join(directory, "daemon.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=17;
    PRAGMA application_id=123456;
    CREATE TABLE manifest_metadata(singleton INTEGER PRIMARY KEY, schema_version INTEGER);
    INSERT INTO manifest_metadata VALUES(1,17);
    CREATE TABLE migration_records(migration_key TEXT PRIMARY KEY, checksum TEXT, imported_at TEXT);
    CREATE TABLE migration_failures(migration_key TEXT PRIMARY KEY, reason TEXT, failed_at TEXT, quarantined_path TEXT NOT NULL);
    CREATE TABLE retained_worker_bindings(agent_id TEXT PRIMARY KEY, token TEXT);
    CREATE TABLE supervised_worker_mint_states(id TEXT PRIMARY KEY, token BLOB);`);
  database.prepare("INSERT INTO retained_worker_bindings VALUES(?,?)").run("agent", secret);
  database.prepare("INSERT INTO supervised_worker_mint_states VALUES(?,?)").run("mint", Buffer.from(secret));
  const key = randomBytes(32);
  t.after(async () => { try { database.close(); } catch { /* test may close */ } await rm(directory, { recursive: true, force: true }); });
  let freshBackup: StateRecoveryBackup | null = null;
  const prepare = async () => freshBackup = await prepareStateRecoveryBackup(path, 18, async () => ({ key: Buffer.from(key), sealedKey: "electron-sealed-one-time-key" }), { now: OLD });
  const validate = async () => {
    database.exec("PRAGMA user_version=18; UPDATE manifest_metadata SET schema_version=18");
    const result = await markStateRecoveryBackupValidated(path, database, { freshBackup, now: OLD });
    freshBackup = null;
    assert.equal(result.status, "validated");
    return result;
  };
  return { directory, path, backup: `${path}.recovery.enc`, database, key, prepare, validate };
}

test("encrypted consistent snapshot includes WAL rows and roundtrips SQLite identities and storage types", async (t) => {
  const env = await fixture(t);
  env.database.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(parent_id INTEGER REFERENCES parent(id), payload ANY) STRICT;
    INSERT INTO parent VALUES(99);
    INSERT INTO child(rowid,parent_id,payload) VALUES(77,99,9223372036854775807);
    CREATE TABLE floats(value REAL); INSERT INTO floats VALUES(1.25);
    CREATE TABLE generated(id INTEGER, doubled INTEGER GENERATED ALWAYS AS(id*2) STORED);
    INSERT INTO generated(rowid,id) VALUES(88,5);
    CREATE TABLE z_auto(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
    INSERT INTO z_auto(id,value) VALUES(200,'then deleted'); DELETE FROM z_auto;
    CREATE TABLE compact(id TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
    INSERT INTO compact VALUES('blob',X'0001FF');
    CREATE INDEX child_payload ON child(payload);
    CREATE VIEW child_view AS SELECT payload FROM child;
    CREATE TRIGGER parent_deleted AFTER DELETE ON parent BEGIN DELETE FROM child WHERE parent_id=old.id; END;
    ANALYZE;`);
  const statistics = env.database.prepare("SELECT * FROM sqlite_stat1").all();
  assert.ok(statistics.length > 0, "ANALYZE generated optimizer statistics in the source");
  assert.ok((await lstat(`${env.path}-wal`)).size > 0, "committed content is still in the live WAL");
  const result = await env.prepare();
  assert.equal(result?.sourceVersion, 17);
  assert.equal(result?.targetVersion, 18);
  assert.equal((await lstat(env.backup)).mode & 0o777, 0o600);
  assert.equal((await readFile(env.backup)).includes(Buffer.from(secret)), false);
  assert.deepEqual((await readdir(env.directory)).filter((name) => name.includes("recovery")), ["daemon.sqlite.recovery.enc"]);
  const restored = await decryptStateRecoveryBackup(env.backup, env.key);
  try {
    assert.equal(restored.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB 'sqlite_stat*'").get(), undefined);
    const userDdl = "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name";
    assert.deepEqual(restored.prepare(userDdl).all(), env.database.prepare(userDdl).all(), "only derived statistics are omitted, not user DDL");
    assert.equal(restored.prepare("SELECT token FROM retained_worker_bindings").get()!.token, secret);
    assert.deepEqual(Buffer.from(restored.prepare("SELECT token FROM supervised_worker_mint_states").get()!.token as Uint8Array), Buffer.from(secret));
    const child = restored.prepare("SELECT rowid,parent_id,payload FROM child"); child.setReadBigInts(true);
    assert.deepEqual({ ...child.get() }, { rowid: 77n, parent_id: 99n, payload: 9223372036854775807n });
    assert.equal(restored.prepare("SELECT value FROM floats").get()!.value, 1.25);
    assert.deepEqual({ ...restored.prepare("SELECT rowid,id,doubled FROM generated").get() }, { rowid: 88, id: 5, doubled: 10 });
    assert.equal(restored.prepare("INSERT INTO z_auto(value) VALUES('next') RETURNING id").get()!.id, 201);
    assert.deepEqual(Buffer.from(restored.prepare("SELECT value FROM compact").get()!.value as Uint8Array), Buffer.from([0, 1, 255]));
    assert.equal(restored.prepare("PRAGMA user_version").get()!.user_version, 17);
    assert.equal(restored.prepare("PRAGMA application_id").get()!.application_id, 123456);
    assert.equal(restored.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.equal(restored.prepare("PRAGMA temp_store").get()!.temp_store, 2, "index/sort work cannot spill plaintext to temporary SQLite files");
    restored.exec("DELETE FROM parent WHERE id=99");
    assert.equal(restored.prepare("SELECT count(*) AS count FROM child_view").get()!.count, 0);
  } finally { restored.close(); }
  assert.deepEqual(env.database.prepare("SELECT * FROM sqlite_stat1").all(), statistics, "snapshotting leaves source statistics intact");
  assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, 17, "inspection does not migrate or replace live state");
});

test("failed-migration retry snapshots new source data and supersedes only with verified ciphertext", async (t) => {
  const env = await fixture(t);
  const first = await env.prepare();
  env.database.prepare("UPDATE retained_worker_bindings SET token=?").run(`${secret}-rotated`);
  const consumedKey = Buffer.from(env.key);
  const second = await prepareStateRecoveryBackup(env.path, 18, async () => ({ key: consumedKey, sealedKey: "new-seal" }));
  assert.ok(consumedKey.every((byte) => byte === 0), "one-time key ownership is consumed");
  assert.notEqual(first!.sha256, second!.sha256);
  const restored = await decryptStateRecoveryBackup(env.backup, env.key);
  try { assert.equal(restored.prepare("SELECT token FROM retained_worker_bindings").get()!.token, `${secret}-rotated`); } finally { restored.close(); }
  assert.deepEqual((await readdir(env.directory)).filter((name) => name.includes("recovery")), ["daemon.sqlite.recovery.enc"]);
});

test("one read transaction does not mix concurrent committed WAL generations", async (t) => {
  const env = await fixture(t);
  await prepareStateRecoveryBackup(env.path, 18, async () => {
    env.database.prepare("UPDATE retained_worker_bindings SET token=?").run("new-writer-generation");
    return { key: Buffer.from(env.key), sealedKey: "sealed" };
  });
  assert.equal(env.database.prepare("SELECT token FROM retained_worker_bindings").get()!.token, "new-writer-generation");
  const restored = await decryptStateRecoveryBackup(env.backup, env.key);
  try { assert.equal(restored.prepare("SELECT token FROM retained_worker_bindings").get()!.token, secret); } finally { restored.close(); }
});

test("missing, fresh, current, and future schemas never ask Electron for a migration key", async (t) => {
  const env = await fixture(t);
  let calls = 0;
  const key = async () => { calls++; throw new Error("not expected"); };
  assert.equal(await prepareStateRecoveryBackup(join(env.directory, "missing.sqlite"), 18, key), null);
  env.database.exec("PRAGMA user_version=0");
  assert.equal(await prepareStateRecoveryBackup(env.path, 18, key), null);
  env.database.exec("PRAGMA user_version=18");
  assert.equal(await prepareStateRecoveryBackup(env.path, 18, key), null);
  env.database.exec("PRAGMA user_version=19");
  await assert.rejects(prepareStateRecoveryBackup(env.path, 18, key), ERROR);
  assert.equal(calls, 0);
  assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, 19);
  assert.equal((await readdir(env.directory)).some((name) => name.includes("recovery")), false);
});

test("unroundtrippable shapes fail closed without replacing the last valid recovery point", async (t) => {
  const env = await fixture(t);
  await env.prepare();
  const before = await readFile(env.backup);
  for (const ddl of [
    "CREATE TABLE unsupported(rowid TEXT,_rowid_ TEXT,oid TEXT)",
    // Synthetic unknown internal table: a broad sqlite_stat* skip would lose it.
    "PRAGMA writable_schema=ON; CREATE TABLE sqlite_stat999(value TEXT); PRAGMA writable_schema=OFF",
  ]) {
    env.database.exec(ddl);
    await assert.rejects(env.prepare(), { code: "snapshot_refused" });
    assert.deepEqual(await readFile(env.backup), before);
    assert.equal((await readdir(env.directory)).some((name) => name.endsWith(".pending")), false);
    env.database.exec("DROP TABLE IF EXISTS unsupported");
  }
});

test("valid Unicode and NUL text roundtrip, while invalid UTF-8 TEXT is refused without a lossy backup", async (t) => {
  const env = await fixture(t);
  const value = "before\u0000after 🪴";
  env.database.prepare("UPDATE retained_worker_bindings SET token=?").run(value);
  await env.prepare();
  const restored = await decryptStateRecoveryBackup(env.backup, env.key);
  try {
    assert.equal(Buffer.from(restored.prepare("SELECT CAST(token AS BLOB) AS token FROM retained_worker_bindings").get()!.token as Uint8Array).toString("utf8"), value);
  } finally { restored.close(); }
  const safe = await readFile(env.backup);
  env.database.exec("UPDATE retained_worker_bindings SET token=CAST(X'FF' AS TEXT)");
  await assert.rejects(env.prepare(), ERROR);
  assert.deepEqual(await readFile(env.backup), safe);
});

test("recovery failures reach startup logs as fixed codes without original exception payloads", async (t) => {
  const env = await fixture(t);
  const logPath = join(env.directory, "lifecycle.jsonl");
  const log = new DaemonLifecycleLog(logPath);
  t.after(() => log.close());
  const logged = (code: string) => (error: Error) => {
    assert.ok(error instanceof StateRecoveryError);
    assert.equal(error.code, code);
    assert.match(error.message, ERROR);
    assert.equal(error.cause, undefined);
    // The real entrypoint uses this formatter + consumer, not Error.code.
    log.append({ event: "entrypoint_failure", detail: daemonLifecycleErrorDetail(error) });
    return true;
  };
  await assert.rejects(withProtectedStateUpgrade(env.path, async () => assert.fail("must not migrate"), {
    getBackupKey: async () => { throw Object.assign(new Error(secret), { code: "desktop_channel_missing", cause: secret }); },
  }), logged("key_unavailable"));
  assert.equal(process.connected, undefined, "test process has no Desktop bootstrap IPC");
  await assert.rejects(withProtectedStateUpgrade(env.path, async () => assert.fail("must not migrate"), {
    getBackupKey: requestStateRecoveryKey,
  }), logged("desktop_channel_missing"));
  assert.equal((await readdir(env.directory)).some((name) => name.includes("recovery")), false);
  env.database.exec("CREATE TABLE unsupported(rowid TEXT,_rowid_ TEXT,oid TEXT)");
  await assert.rejects(env.prepare(), logged("snapshot_refused"));
  env.database.exec("DROP TABLE unsupported");
  await env.prepare();
  await assert.rejects(decryptStateRecoveryBackup(env.backup, randomBytes(32)), logged("verify_failed"));
  log.close();
  const persisted = await readFile(logPath, "utf8");
  assert.equal(persisted.includes(secret), false);
  const details = persisted.trim().split("\n").map((line) => JSON.parse(line).detail as string);
  assert.equal(details.length, 4);
  ["key_unavailable", "desktop_channel_missing", "snapshot_refused", "verify_failed"].forEach((code, i) => {
    assert.ok(details[i].includes(`[${code}]`));
  });
  assert.deepEqual((await readdir(env.directory)).filter((name) => name.includes("recovery")), ["daemon.sqlite.recovery.enc"]);
});

test("tampered headers, ciphertext, truncation, and wrong keys never execute snapshot SQL", async (t) => {
  const env = await fixture(t);
  await env.prepare();
  const original = await readFile(env.backup);
  const ciphertext = Buffer.from(original); ciphertext[ciphertext.length - 20] ^= 1;
  const actualHeader = Buffer.from(original); actualHeader[actualHeader.indexOf(Buffer.from("electron-sealed"))] ^= 1;
  for (const bytes of [ciphertext, actualHeader, original.subarray(0, original.length - 1)]) {
    await writeFile(env.backup, bytes);
    await assert.rejects(decryptStateRecoveryBackup(env.backup, env.key), ERROR);
  }
  await writeFile(env.backup, original);
  await assert.rejects(decryptStateRecoveryBackup(env.backup, randomBytes(32)), ERROR);
});

test("sqlite_sequence survives even after the final AUTOINCREMENT table was dropped", async (t) => {
  const env = await fixture(t);
  env.database.exec("CREATE TABLE gone(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE gone");
  assert.ok(env.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get());
  await env.prepare();
  const restored = await decryptStateRecoveryBackup(env.backup, env.key);
  try {
    assert.ok(restored.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get());
    assert.equal(restored.prepare("SELECT count(*) AS count FROM sqlite_sequence").get()!.count, 0);
    assert.equal(restored.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE 'recovery_sequence_%'").get(), undefined);
  } finally { restored.close(); }
});

test("all prepare/read/clear paths reject symlinks without touching their targets", async (t) => {
  const env = await fixture(t);
  const target = join(env.directory, "unrelated");
  await writeFile(target, "untouched", { mode: 0o600 });
  await symlink(target, env.backup);
  await assert.rejects(env.prepare(), ERROR);
  await assert.rejects(decryptStateRecoveryBackup(env.backup, env.key), ERROR);
  await assert.rejects(cleanupStateRecoveryBackup(env.path, env.database, { clear: true }), ERROR);
  assert.deepEqual(await markStateRecoveryBackupValidated(env.path, env.database), { status: "unverified", warning: "recovery_snapshot_unreadable" });
  assert.equal(await readFile(target, "utf8"), "untouched");
  await unlink(env.backup);
  await symlink(target, `${env.backup}.pending`);
  await assert.rejects(env.prepare(), ERROR);
  assert.equal(await readFile(target, "utf8"), "untouched");
  const databaseLink = join(env.directory, "linked.sqlite");
  await symlink(env.path, databaseLink);
  await assert.rejects(prepareStateRecoveryBackup(databaseLink, 18, async () => ({ key: Buffer.from(env.key), sealedKey: "sealed" })), ERROR);
});

test("insecure directory or recovery file permissions fail closed", async (t) => {
  const env = await fixture(t);
  await chmod(env.directory, 0o755);
  await assert.rejects(env.prepare(), ERROR);
  await chmod(env.directory, 0o700);
  await env.prepare();
  await chmod(env.backup, 0o644);
  await assert.rejects(decryptStateRecoveryBackup(env.backup, env.key), ERROR);
  await assert.rejects(cleanupStateRecoveryBackup(env.path, env.database, { clear: true }), ERROR);
});

test("a crash-left encrypted candidate is discarded and rebuilt under the migration fence", async (t) => {
  const env = await fixture(t);
  await writeFile(`${env.backup}.pending`, randomBytes(130), { mode: 0o600 });
  await env.prepare();
  const restored = await decryptStateRecoveryBackup(env.backup, env.key); restored.close();
  assert.equal((await readdir(env.directory)).some((name) => name.endsWith(".pending")), false);
});

test("verified startup and explicit clear also remove incomplete ciphertext, never following links", async (t) => {
  const env = await fixture(t);
  await writeFile(`${env.backup}.pending`, randomBytes(130), { mode: 0o600 });
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { clear: true }), true);
  assert.equal((await readdir(env.directory)).some((name) => name.includes("recovery")), false);
  const target = join(env.directory, "unrelated");
  await writeFile(target, "untouched", { mode: 0o600 });
  await symlink(target, `${env.backup}.pending`);
  await assert.rejects(cleanupStateRecoveryBackup(env.path, env.database, { clear: true }), ERROR);
  assert.equal(await readFile(target, "utf8"), "untouched");
});

test("retention begins with authenticated identity and unchanged valid receipts never extend it", async (t) => {
  const env = await fixture(t);
  await env.prepare();
  const day = 24 * 60 * 60 * 1_000;
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { now: new Date(OLD.getTime() + 30 * day) }), false, "age without successful validation is not cleanup authority");
  await env.validate();
  assert.deepEqual(await markStateRecoveryBackupValidated(env.path, env.database, { now: new Date(OLD.getTime() + 5 * day) }), { status: "validated" });
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { now: new Date(OLD.getTime() + 7 * day - 1) }), false);
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { now: new Date(OLD.getTime() + 7 * day) }), true);
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { now: new Date(OLD.getTime() + 8 * day) }), false);
  assert.equal(env.database.prepare("SELECT count(*) AS count FROM migration_records").get()!.count, 0);
});

test("validation cannot bless the wrong schema and cleanup requires the exact snapshot receipt", async (t) => {
  const env = await fixture(t);
  await env.prepare();
  assert.deepEqual(await markStateRecoveryBackupValidated(env.path, env.database), { status: "unverified", warning: "recovery_snapshot_schema_mismatch" });
  await env.validate();
  const bytes = await readFile(env.backup); bytes[bytes.length - 1] ^= 1; await writeFile(env.backup, bytes);
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { now: new Date("2027-01-01") }), false);
  assert.equal(await cleanupStateRecoveryBackup(env.path, env.database, { clear: true }), true, "explicit clear needs no decrypt or restore");
});

test("a copied metadata object is not fresh authentication proof", async (t) => {
  const env = await fixture(t);
  const fresh = await env.prepare();
  env.database.exec("PRAGMA user_version=18; UPDATE manifest_metadata SET schema_version=18");
  assert.deepEqual(await markStateRecoveryBackupValidated(env.path, env.database, { freshBackup: { ...fresh! }, now: OLD }), {
    status: "unverified", warning: "recovery_snapshot_receipt_missing",
  });
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM migration_records").get()!.count, 0);
  await env.validate();
});

async function realStateFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "letagents-recovery-startup-"));
  const path = join(directory, "daemon.sqlite");
  const database = new DatabaseSync(path);
  new DaemonStateSchema().createSchema(database);
  database.exec("ALTER TABLE agent_configurations DROP COLUMN polling_contract");
  database.exec("PRAGMA foreign_keys=OFF");
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'execution_*'").all()) {
    database.exec(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`);
  }
  const schemaVersion = Number(database.prepare("PRAGMA schema_version").get()!.schema_version);
  database.exec("PRAGMA writable_schema=ON");
  database.prepare("UPDATE sqlite_master SET sql=replace(sql, ?, '') WHERE name='supervised_agent_inbox'").run(",'acknowledged_failed'");
  database.prepare("UPDATE sqlite_master SET sql=replace(replace(sql, ?, ''), ?, '') WHERE name='supervised_agent_terminal_results'").run(
    ",'failed','interrupted'",
    ",CHECK(outcome NOT IN ('failed','interrupted') OR (normalized_text IS NULL AND evidence_source <> 'none'))",
  );
  database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1};
    UPDATE manifest_metadata SET schema_version=17 WHERE singleton=1; PRAGMA user_version=17`);
  database.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  let keyRequests = 0;
  const key = randomBytes(32);
  const getBackupKey = async () => { keyRequests++; return { key: Buffer.from(key), sealedKey: "electron-sealed" }; };
  const initialize = async () => {
    const current = await openDaemonStateDatabase(path, (db) => new DaemonStateSchema().createSchema(db));
    try { return current.prepare("PRAGMA user_version").get()!.user_version; } finally { current.close(); }
  };
  const inspect = (sql: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); }
  };
  return { directory, path, backup: `${path}.recovery.enc`, getBackupKey, initialize, inspect,
    keyRequests: () => keyRequests,
    start: () => withProtectedStateUpgrade(path, async () => {
      const current = new DatabaseSync(path, { readOnly: true });
      try { return current.prepare("PRAGMA user_version").get()!.user_version; }
      finally { current.close(); }
    }, { getBackupKey }),
  };
}

test("real startup keeps valid retention unchanged and remains healthy after ciphertext/header damage", async (t) => {
  const env = await realStateFixture(t);
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION);
  const receiptSql = "SELECT checksum,imported_at FROM migration_records WHERE migration_key='encrypted-state-recovery-backup'";
  const originalReceipt = env.inspect(receiptSql);
  assert.equal(originalReceipt.length, 1);
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION);
  assert.deepEqual(env.inspect(receiptSql), originalReceipt, "current startup does not reset a verified receipt's clock");
  assert.equal(env.keyRequests(), 1);
  const original = await readFile(env.backup);
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  await writeFile(env.backup, damaged);
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION, "backup damage does not disable healthy current state");
  assert.deepEqual(env.inspect(receiptSql), originalReceipt, "changed ciphertext is never re-blessed");
  assert.deepEqual(env.inspect("SELECT reason,quarantined_path FROM migration_failures WHERE migration_key='encrypted-state-recovery-backup'"), [
    { reason: "recovery_snapshot_changed", quarantined_path: "" },
  ]);
  assert.deepEqual(await readFile(env.backup), damaged);
  const malformed = Buffer.from(original); malformed[0] = 0;
  await writeFile(env.backup, malformed);
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION, "malformed retained metadata remains a recovery warning only");
  assert.deepEqual(env.inspect(receiptSql), originalReceipt);
  assert.deepEqual(env.inspect("SELECT reason,quarantined_path FROM migration_failures WHERE migration_key='encrypted-state-recovery-backup'"), [
    { reason: "recovery_snapshot_unreadable", quarantined_path: "" },
  ]);
  assert.deepEqual(await readFile(env.backup), malformed);
  assert.equal(env.keyRequests(), 1, "healthy current-schema restart never requests a replacement key");
});

test("protected startup refuses callback schema damage without blessing its recovery snapshot", async (t) => {
  const env = await realStateFixture(t);
  await assert.rejects(withProtectedStateUpgrade(env.path, async () => {
    const damaged = new DatabaseSync(env.path);
    try {
      const schemaVersion = Number(damaged.prepare("PRAGMA schema_version").get()!.schema_version);
      damaged.exec("PRAGMA writable_schema=ON");
      damaged.prepare("UPDATE sqlite_master SET sql=replace(sql, ?, '') WHERE name='supervised_agent_inbox'").run(",'acknowledged_failed'");
      damaged.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
    }
    finally { damaged.close(); }
  }, { getBackupKey: env.getBackupKey }), /reserved failed-delivery terminal state/i);
  assert.deepEqual(env.inspect("SELECT checksum,imported_at FROM migration_records WHERE migration_key='encrypted-state-recovery-backup'"), []);
});

test("post-commit/pre-receipt crash retains one unverified snapshot without fake expiry authority", async (t) => {
  const env = await realStateFixture(t);
  await prepareStateRecoveryBackup(env.path, DAEMON_STATE_SCHEMA_VERSION, env.getBackupKey, { now: OLD });
  await env.initialize(); // Simulated crash: migration committed, fresh in-process proof was lost.
  const original = await readFile(env.backup);
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION);
  assert.deepEqual(env.inspect("SELECT checksum FROM migration_records WHERE migration_key='encrypted-state-recovery-backup'"), []);
  assert.deepEqual(env.inspect("SELECT reason,quarantined_path FROM migration_failures WHERE migration_key='encrypted-state-recovery-backup'"), [
    { reason: "recovery_snapshot_receipt_missing", quarantined_path: "" },
  ]);
  const db = new DatabaseSync(env.path);
  try {
    assert.equal(await cleanupStateRecoveryBackup(env.path, db, { now: new Date("2030-01-01") }), false);
  } finally { db.close(); }
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION);
  assert.deepEqual(await readFile(env.backup), original);
  assert.deepEqual((await readdir(env.directory)).filter((name) => name.includes("recovery")), ["daemon.sqlite.recovery.enc"]);
  assert.equal(env.keyRequests(), 1);
  const current = new DatabaseSync(env.path);
  try { assert.equal(await cleanupStateRecoveryBackup(env.path, current, { clear: true }), true); } finally { current.close(); }
  assert.equal(await env.start(), DAEMON_STATE_SCHEMA_VERSION);
  assert.equal(env.keyRequests(), 1);
});
