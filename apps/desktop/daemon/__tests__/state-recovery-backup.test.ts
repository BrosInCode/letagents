import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cleanupStateRecoveryBackup, decryptStateRecoveryBackup, markStateRecoveryBackupValidated,
  prepareStateRecoveryBackup, StateRecoveryError, type StateRecoveryBackup,
} from "../state-recovery-backup.js";
import { DAEMON_STATE_APPLICATION_ID, DAEMON_STATE_USER_VERSION, DaemonStateSchema, openDaemonStateDatabase } from "../daemon-state-database.js";
import { compactDaemonStateDatabase } from "../daemon-state-maintenance.js";
import { cloneStateDatabaseForCompaction } from "../state-recovery-backup.js";
import { requestStateRecoveryKey, withProtectedStateUpgrade } from "../state-recovery-key.js";
import { DaemonLifecycleLog, daemonLifecycleErrorDetail } from "../lifecycle-log.js";
import { assertKilledBySelf, CHILD_PROCESS_TIMEOUT_MS } from "../../electron/__tests__/platform.js";
import { forgetOwnerPrivateCache, protectOwnerPrivate, windowsSystemTool } from "../../../../shared/owner-private-fs.mjs";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";

/** A new temporary folder. The recovery code accepts only an owner-private parent; on Windows a temp folder inherits other entries, so its access list is set. */
async function privateTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  if (process.platform === "win32") await protectOwnerPrivate(directory, "directory", { force: true });
  return directory;
}

/** Gives a path an access that is not the owner's: group and other read on POSIX, an Everyone entry on Windows. */
async function loosen(path: string, folder: boolean): Promise<void> {
  if (process.platform !== "win32") { await chmod(path, folder ? 0o755 : 0o644); return; }
  execFileSync(windowsSystemTool("icacls.exe"), [path, "/grant", folder ? "*S-1-1-0:(OI)(CI)R" : "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
  forgetOwnerPrivateCache();
}
async function tighten(path: string, folder: boolean): Promise<void> {
  if (process.platform !== "win32") { await chmod(path, folder ? 0o700 : 0o600); return; }
  execFileSync(windowsSystemTool("icacls.exe"), [path, "/remove:g", "*S-1-1-0"], { stdio: "ignore", windowsHide: true });
  forgetOwnerPrivateCache();
}

const ERROR = /Encrypted daemon recovery snapshot could not be verified safely\./;
const OLD = new Date("2026-08-30T00:00:00.000Z");
const secret = "worker-bearer-do-not-copy-to-plaintext-recovery";

async function fixture(t: test.TestContext) {
  const directory = await privateTempDirectory("letagents-encrypted-state-");
  const path = join(directory, "daemon.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${DAEMON_STATE_USER_VERSION};
    PRAGMA application_id=${DAEMON_STATE_APPLICATION_ID};
    CREATE TABLE daemon_maintenance_state(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE retained_worker_bindings(agent_id TEXT PRIMARY KEY, token TEXT);
    CREATE TABLE supervised_worker_mint_states(id TEXT PRIMARY KEY, token BLOB);`);
  database.prepare("INSERT INTO retained_worker_bindings VALUES(?,?)").run("agent", secret);
  database.prepare("INSERT INTO supervised_worker_mint_states VALUES(?,?)").run("mint", Buffer.from(secret));
  const key = randomBytes(32);
  t.after(async () => { try { database.close(); } catch { /* test may close */ } await removeTestDirectory(directory); });
  let freshBackup: StateRecoveryBackup | null = null;
  const prepare = async () => freshBackup = await prepareStateRecoveryBackup(path, DAEMON_STATE_USER_VERSION + 1, async () => ({ key: Buffer.from(key), sealedKey: "electron-sealed-one-time-key" }), { now: OLD });
  const validate = async () => {
    database.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION + 1}`);
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
  assert.equal(result?.sourceVersion, DAEMON_STATE_USER_VERSION);
  assert.equal(result?.targetVersion, DAEMON_STATE_USER_VERSION + 1);
  if (process.platform !== "win32") assert.equal((await lstat(env.backup)).mode & 0o777, 0o600);
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
    assert.equal(restored.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_USER_VERSION);
    assert.equal(restored.prepare("PRAGMA application_id").get()!.application_id, DAEMON_STATE_APPLICATION_ID);
    assert.equal(restored.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.equal(restored.prepare("PRAGMA temp_store").get()!.temp_store, 2, "index/sort work cannot spill plaintext to temporary SQLite files");
    restored.exec("DELETE FROM parent WHERE id=99");
    assert.equal(restored.prepare("SELECT count(*) AS count FROM child_view").get()!.count, 0);
  } finally { restored.close(); }
  assert.deepEqual(env.database.prepare("SELECT * FROM sqlite_stat1").all(), statistics, "snapshotting leaves source statistics intact");
  assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_USER_VERSION, "inspection does not migrate or replace live state");
});

test("failed-migration retry snapshots new source data and supersedes only with verified ciphertext", async (t) => {
  const env = await fixture(t);
  const first = await env.prepare();
  env.database.prepare("UPDATE retained_worker_bindings SET token=?").run(`${secret}-rotated`);
  const consumedKey = Buffer.from(env.key);
  const second = await prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, async () => ({ key: consumedKey, sealedKey: "new-seal" }));
  assert.ok(consumedKey.every((byte) => byte === 0), "one-time key ownership is consumed");
  assert.notEqual(first!.sha256, second!.sha256);
  const restored = await decryptStateRecoveryBackup(env.backup, env.key);
  try { assert.equal(restored.prepare("SELECT token FROM retained_worker_bindings").get()!.token, `${secret}-rotated`); } finally { restored.close(); }
  assert.deepEqual((await readdir(env.directory)).filter((name) => name.includes("recovery")), ["daemon.sqlite.recovery.enc"]);
});

test("one read transaction does not mix concurrent committed WAL generations", async (t) => {
  const env = await fixture(t);
  await prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, async () => {
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
  assert.equal(await prepareStateRecoveryBackup(join(env.directory, "missing.sqlite"), DAEMON_STATE_USER_VERSION + 1, key), null);
  env.database.exec("PRAGMA user_version=0");
  assert.equal(await prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, key), null);
  env.database.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION + 1}`);
  assert.equal(await prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, key), null);
  env.database.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION + 2}`);
  await assert.rejects(prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, key), ERROR);
  assert.equal(calls, 0);
  assert.equal(env.database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_USER_VERSION + 2);
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
    log.append({ event: "entrypoint_failure", detail: daemonLifecycleErrorDetail(error) });
    return true;
  };
  await assert.rejects(prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, async () => {
    throw Object.assign(new Error(secret), { code: "desktop_channel_missing", cause: secret });
  }), logged("key_unavailable"));
  assert.equal(process.connected, undefined, "test process has no Desktop bootstrap IPC");
  await assert.rejects(prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, requestStateRecoveryKey), logged("desktop_channel_missing"));
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
  await assert.rejects(prepareStateRecoveryBackup(databaseLink, 2, async () => ({ key: Buffer.from(env.key), sealedKey: "sealed" })), ERROR);
});

test("insecure directory or recovery file permissions fail closed", async (t) => {
  const env = await fixture(t);
  await loosen(env.directory, true);
  await assert.rejects(env.prepare(), ERROR);
  await tighten(env.directory, true);
  await env.prepare();
  await loosen(env.backup, false);
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
  assert.equal(env.database.prepare("SELECT count(*) AS count FROM daemon_maintenance_state WHERE key='encrypted-state-recovery-backup'").get()!.count, 0);
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
  env.database.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION + 1}`);
  assert.deepEqual(await markStateRecoveryBackupValidated(env.path, env.database, { freshBackup: { ...fresh! }, now: OLD }), {
    status: "unverified", warning: "recovery_snapshot_receipt_missing",
  });
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM daemon_maintenance_state WHERE key='encrypted-state-recovery-backup'").get()!.count, 0);
  await env.validate();
});

async function realStateFixture(t: test.TestContext) {
  const directory = await privateTempDirectory("letagents-recovery-startup-");
  const path = join(directory, "daemon.sqlite");
  const database = await openDaemonStateDatabase(path, (db) => new DaemonStateSchema().createSchema(db));
  database.close();
  t.after(() => removeTestDirectory(directory));
  let keyRequests = 0;
  const key = randomBytes(32);
  const getBackupKey = async () => { keyRequests++; return { key: Buffer.from(key), sealedKey: "electron-sealed" }; };
  const inspect = (sql: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); }
  };
  return { directory, path, backup: `${path}.recovery.enc`, getBackupKey, inspect,
    keyRequests: () => keyRequests,
    start: () => withProtectedStateUpgrade(path, async (opened) =>
      opened.connection.prepare("PRAGMA user_version").get()!.user_version,
    { getBackupKey }),
  };
}

test("real startup keeps valid retention unchanged and remains healthy after ciphertext/header damage", async (t) => {
  const env = await realStateFixture(t);
  const db = new DatabaseSync(env.path);
  try {
    db.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION}`);
    // Simulate a validated recovery snapshot retained from a prior modern upgrade.
    const fresh = await prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, env.getBackupKey, { now: OLD });
    db.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION + 1}`);
    assert.equal((await markStateRecoveryBackupValidated(env.path, db, { freshBackup: fresh, now: OLD })).status, "validated");
    // Restore schema v1 target version matching the snapshot header would mismatch; verify current DB survives malformed/changed snapshots cleanly.
    db.exec(`PRAGMA user_version=${DAEMON_STATE_USER_VERSION}`);
  } finally { db.close(); }
  const receiptSql = "SELECT value_json FROM daemon_maintenance_state WHERE key='encrypted-state-recovery-backup'";
  const warningSql = "SELECT value_json FROM daemon_maintenance_state WHERE key='encrypted-state-recovery-backup-warning'";
  const originalReceipt = env.inspect(receiptSql);
  assert.equal(originalReceipt.length, 1);
  const original = await readFile(env.backup);
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  await writeFile(env.backup, damaged);
  assert.equal(await env.start(), DAEMON_STATE_USER_VERSION, "backup damage does not disable healthy current state");
  assert.deepEqual(env.inspect(receiptSql), originalReceipt, "changed ciphertext is never re-blessed");
  assert.equal(JSON.parse(String(env.inspect(warningSql)[0]!.value_json)).warning, "recovery_snapshot_schema_mismatch");
  const malformed = Buffer.from(original); malformed[0] = 0;
  await writeFile(env.backup, malformed);
  assert.equal(await env.start(), DAEMON_STATE_USER_VERSION, "malformed retained metadata remains a recovery warning only");
  assert.equal(JSON.parse(String(env.inspect(warningSql)[0]!.value_json)).warning, "recovery_snapshot_unreadable");
  assert.deepEqual(await readFile(env.backup), malformed);
  assert.equal(env.keyRequests(), 1, "healthy current-schema restart never requests a replacement key");
});

test("protected startup refuses callback schema damage without blessing its recovery snapshot", async (t) => {
  const env = await realStateFixture(t);
  await assert.rejects(withProtectedStateUpgrade(env.path, async (opened) => {
    opened.connection.exec("DROP TABLE inbox_items");
  }, { getBackupKey: env.getBackupKey }), /schema|mismatch/i);
  assert.deepEqual(env.inspect("SELECT value_json FROM daemon_maintenance_state WHERE key='encrypted-state-recovery-backup'"), []);
});

test("post-commit/pre-receipt crash retains one unverified snapshot without fake expiry authority", async (t) => {
  const env = await realStateFixture(t);
  await prepareStateRecoveryBackup(env.path, DAEMON_STATE_USER_VERSION + 1, env.getBackupKey, { now: OLD });
  const original = await readFile(env.backup);
  assert.equal(await env.start(), DAEMON_STATE_USER_VERSION);
  assert.deepEqual(env.inspect("SELECT value_json FROM daemon_maintenance_state WHERE key='encrypted-state-recovery-backup'"), []);
  const db = new DatabaseSync(env.path);
  try {
    assert.equal(await cleanupStateRecoveryBackup(env.path, db, { now: new Date("2030-01-01") }), false);
  } finally { db.close(); }
  assert.equal(await env.start(), DAEMON_STATE_USER_VERSION);
  assert.deepEqual(await readFile(env.backup), original);
  assert.deepEqual((await readdir(env.directory)).filter((name) => name.includes("recovery")), ["daemon.sqlite.recovery.enc"]);
  assert.equal(env.keyRequests(), 1);
  const current = new DatabaseSync(env.path);
  try { assert.equal(await cleanupStateRecoveryBackup(env.path, current, { clear: true }), true); } finally { current.close(); }
  assert.equal(await env.start(), DAEMON_STATE_USER_VERSION);
  assert.equal(env.keyRequests(), 1);
});

async function fragmentedStateFixture(t: test.TestContext) {
  const directory = await privateTempDirectory("letagents-compact-state-");
  const path = join(directory, "daemon.sqlite");
  const initial = new DatabaseSync(path);
  initial.exec("PRAGMA page_size=8192; CREATE TABLE page_size_seed(x); DROP TABLE page_size_seed");
  initial.close();
  const database = await openDaemonStateDatabase(path, db => new DaemonStateSchema().createSchema(db));
  database.exec("PRAGMA wal_autocheckpoint=0");
  // Create >64 MiB of freed pages inside the real schema v1 database without altering schema DDL.
  const pad = "x".repeat(1024 * 1024);
  database.exec("BEGIN");
  const insertPad = database.prepare("INSERT INTO daemon_maintenance_state(key,value_json,updated_at) VALUES(?,?,?)");
  for (let i = 0; i < 80; i++) insertPad.run(`pad-${i}`, JSON.stringify(pad), "2026-09-01T00:00:00.000Z");
  insertPad.run("kept-row", JSON.stringify({ ok: true }), "2026-09-01T00:00:00.000Z");
  database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("DELETE FROM daemon_maintenance_state WHERE key LIKE 'pad-%'");
  database.prepare("INSERT INTO daemon_maintenance_state(key,value_json,updated_at) VALUES('wal-only',?,?)")
    .run(JSON.stringify({ wal: true }), "2026-09-01T00:00:01.000Z");
  assert.ok(Number(database.prepare("PRAGMA freelist_count").get()!.freelist_count) * 8192 > 64 * 1024 * 1024);
  t.after(async () => { try { database.close(); } catch {} await removeTestDirectory(directory); });
  return { database, path };
}

test("compaction clone preserves rowids, WAL rows, sequence, generated columns, WITHOUT ROWID, views and triggers", async t => {
  const env = await fixture(t);
  env.database.exec(`PRAGMA application_id=741;
    CREATE TABLE maintenance_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE maintenance_child(parent_id INTEGER REFERENCES maintenance_parent(id), payload ANY) STRICT;
    INSERT INTO maintenance_parent VALUES(99);
    INSERT INTO maintenance_child(rowid,parent_id,payload) VALUES(77,99,9223372036854775807);
    CREATE TABLE maintenance_generated(id INTEGER, doubled INTEGER GENERATED ALWAYS AS(id*2) STORED);
    INSERT INTO maintenance_generated(rowid,id) VALUES(88,5);
    CREATE TABLE maintenance_auto(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
    INSERT INTO maintenance_auto VALUES(200,'then deleted'); DELETE FROM maintenance_auto;
    CREATE TABLE maintenance_without_rowid(id TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
    INSERT INTO maintenance_without_rowid VALUES('blob',X'0001FF');
    CREATE INDEX maintenance_child_payload ON maintenance_child(payload);
    CREATE VIEW maintenance_view AS SELECT payload FROM maintenance_child;
    CREATE TRIGGER maintenance_parent_deleted AFTER DELETE ON maintenance_parent
      BEGIN DELETE FROM maintenance_child WHERE parent_id=old.id; END;
    INSERT INTO maintenance_auto(value) VALUES('committed only in WAL');`);
  const cloned = cloneStateDatabaseForCompaction(env.database);
  try {
    assert.equal(cloned.prepare("PRAGMA application_id").get()!.application_id, 741);
    const child = cloned.prepare("SELECT rowid,parent_id,payload FROM maintenance_child");
    child.setReadBigInts(true);
    assert.deepEqual({ ...child.get()! }, { rowid: 77n, parent_id: 99n, payload: 9223372036854775807n });
    assert.deepEqual({ ...cloned.prepare("SELECT rowid,* FROM maintenance_generated").get()! }, { rowid: 88, id: 5, doubled: 10 });
    assert.equal(cloned.prepare("SELECT id FROM maintenance_auto").get()!.id, 201);
    cloned.exec("INSERT INTO maintenance_auto(value) VALUES('next'); INSERT INTO maintenance_generated(id) VALUES(6)");
    assert.equal(cloned.prepare("SELECT MAX(id) AS id FROM maintenance_auto").get()!.id, 202);
    assert.equal(cloned.prepare("SELECT MAX(rowid) AS id FROM maintenance_generated").get()!.id, 89);
    assert.equal(Buffer.from(cloned.prepare("SELECT value FROM maintenance_without_rowid").get()!.value as Uint8Array).toString("hex"), "0001ff");
    assert.equal(cloned.prepare("SELECT COUNT(*) AS n FROM maintenance_view").get()!.n, 1);
    cloned.exec("DELETE FROM maintenance_parent");
    assert.equal(cloned.prepare("SELECT COUNT(*) AS n FROM maintenance_child").get()!.n, 0);
    assert.deepEqual(cloned.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(cloned.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { cloned.close(); }
});

test("startup compaction reclaims free pages while preserving WAL rows, page size, and schema v1 shape", async t => {
  const { database, path } = await fragmentedStateFixture(t);
  const before = (await lstat(path)).size;
  let fenceChecks = 0;
  assert.equal(await compactDaemonStateDatabase(path, database, async () => { fenceChecks++; }), "compacted");
  assert.equal(fenceChecks, 2);
  assert.ok((await lstat(path)).size < before / 4);
  assert.equal((await lstat(`${path}-wal`)).size, 0);
  assert.equal(database.prepare("PRAGMA page_size").get()!.page_size, 8192);
  assert.equal(database.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(database.prepare("PRAGMA application_id").get()!.application_id, DAEMON_STATE_APPLICATION_ID);
  assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_USER_VERSION);
  assert.deepEqual(database.prepare("SELECT key FROM daemon_maintenance_state ORDER BY key").all().map((r) => r.key), ["kept-row", "wal-only"]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  assert.equal(await compactDaemonStateDatabase(path, database, async () => assert.fail("small database needs no maintenance")), "not_needed");
});

test("compaction refuses lost ownership before replacement and reports a busy checkpoint after commit", async t => {
  const { database, path } = await fragmentedStateFixture(t);
  let checks = 0;
  const pagesBefore = database.prepare("PRAGMA page_count").get()!.page_count;
  await assert.rejects(compactDaemonStateDatabase(path, database, async () => {
    if (++checks === 2) throw new Error("lost singleton");
  }), /lost singleton/);
  assert.equal(database.prepare("PRAGMA page_count").get()!.page_count, pagesBefore);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM daemon_maintenance_state").get()!.n, 2);
  const reader = new DatabaseSync(path, { readOnly: true });
  database.exec("PRAGMA busy_timeout=0");
  reader.exec("BEGIN");
  reader.prepare("SELECT key FROM daemon_maintenance_state").all();
  try {
    assert.equal(await compactDaemonStateDatabase(path, database, async () => {}), "checkpoint_busy");
    assert.ok(Number(database.prepare("PRAGMA page_count").get()!.page_count) < Number(pagesBefore) / 4,
      "the replacement committed even though the old reader pins WAL pages");
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM daemon_maintenance_state").get()!.n, 2);
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  database.prepare("INSERT OR REPLACE INTO daemon_maintenance_state(key,value_json,updated_at) VALUES('state-space-maintenance',?,'2026-09-01T00:00:00.000Z')")
    .run(JSON.stringify({ reason: "checkpoint_busy" }));
  assert.equal(await compactDaemonStateDatabase(path, database, async () => {}), "compacted",
    "a later startup retries deferred WAL reclamation even though the compact copy has no free pages");
  assert.ok((await lstat(path)).size < Number(pagesBefore) * 8192 / 4);
});

test("typed compaction clone refuses invalid text before any source replacement", async t => {
  const env = await fixture(t);
  env.database.exec("CREATE TABLE invalid_text(value TEXT); INSERT INTO invalid_text VALUES(CAST(X'80FF' AS TEXT))");
  assert.throws(() => cloneStateDatabaseForCompaction(env.database), ERROR);
  assert.equal(env.database.isTransaction, false);
  assert.equal(env.database.prepare("SELECT hex(value) AS value FROM invalid_text").get()!.value, "80FF");
});

test("process death during compact database replacement rolls back the SQLite backup transaction", async t => {
  const { database, path } = await fragmentedStateFixture(t);
  const originalPageCount = database.prepare("PRAGMA page_count").get()!.page_count;
  const moduleUrl = new URL("../state-recovery-backup.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--conditions=letagents-source", "--import", "tsx", "--input-type=module", "-e", `
    import { DatabaseSync, backup } from 'node:sqlite';
    import { cloneStateDatabaseForCompaction } from ${JSON.stringify(moduleUrl)};
    const original = new DatabaseSync(process.argv[1]);
    const compact = cloneStateDatabaseForCompaction(original);
    compact.exec("INSERT INTO daemon_maintenance_state(key,value_json,updated_at) VALUES('must-roll-back','{}','2026-09-01T00:00:02.000Z')");
    await backup(compact, process.argv[1], { rate: 1, progress({ remainingPages, totalPages }) {
      if (remainingPages > 0 && remainingPages < totalPages) process.kill(process.pid, 'SIGKILL');
    }});
    process.exit(99);
  `, path], { encoding: "utf8", timeout: CHILD_PROCESS_TIMEOUT_MS });
  assertKilledBySelf(child);
  assert.equal(database.prepare("PRAGMA page_count").get()!.page_count, originalPageCount);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM daemon_maintenance_state WHERE key='must-roll-back'").get()!.n, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM daemon_maintenance_state").get()!.n, 2);
  assert.equal(database.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(await compactDaemonStateDatabase(path, database, async () => {}), "compacted",
    "a later startup can safely retry after the killed backup");
});

test("a snapshot larger than one read piece survives, with multi-byte text split across pieces", async (t) => {
  // A 1.47 GB state database failed every upgrade: its snapshot was decoded as one string,
  // longer than JavaScript allows. The snapshot is now read in 4 MB pieces; this one spans several.
  const directory = await privateTempDirectory("letagents-large-state-");
  t.after(() => removeTestDirectory(directory));
  const path = join(directory, "daemon.sqlite");
  const database = new DatabaseSync(path);
  let expected: Record<string, unknown> | undefined;
  try {
    database.exec(`PRAGMA user_version=1003; PRAGMA application_id=${DAEMON_STATE_APPLICATION_ID};
      CREATE TABLE daemon_maintenance_state(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE reviews(id INTEGER PRIMARY KEY, body TEXT NOT NULL, data BLOB);`);
    // Rows of odd lengths with four-byte characters, so piece boundaries fall inside characters and lines.
    const insert = database.prepare("INSERT INTO reviews(body, data) VALUES(?, ?)");
    database.exec("BEGIN");
    for (let row = 0; row < 900; row += 1) insert.run(`review ${row} ${"🧠é".repeat(1_500 + row)}`, randomBytes(3_001 + row));
    database.exec("COMMIT");
    expected = database.prepare("SELECT count(*) AS n, sum(length(body)) AS chars, sum(length(data)) AS bytes FROM reviews").get();
  } finally {
    database.close();
  }
  const key = randomBytes(32);
  const backup = await prepareStateRecoveryBackup(path, 1004, async () => ({ key: Buffer.from(key), sealedKey: "sealed" }));
  assert.ok(backup);
  assert.ok((await lstat(backup.path)).size > 3 * 4 * 1_024 * 1_024, "the snapshot spans several read pieces");
  const restored = await decryptStateRecoveryBackup(backup.path, key);
  try {
    assert.deepEqual(restored.prepare("SELECT count(*) AS n, sum(length(body)) AS chars, sum(length(data)) AS bytes FROM reviews").get(), expected);
    assert.match(String(restored.prepare("SELECT body FROM reviews WHERE id=900").get()!.body), /^review 899 (🧠é)+$/);
  } finally { restored.close(); }
  // One changed byte anywhere still fails before any record is read.
  const bytes = await readFile(backup.path);
  bytes[bytes.length - 1024] ^= 1;
  await writeFile(backup.path, bytes);
  await assert.rejects(decryptStateRecoveryBackup(backup.path, key), ERROR);
});
