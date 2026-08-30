import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RECEIPT_KEY = "encrypted-state-recovery-backup";
const MAGIC = "letagents-state-recovery-v1";
const HEADER_LIMIT = 64 * 1_024;
type Header = {
  format: typeof MAGIC;
  sourceVersion: number;
  targetVersion: number;
  createdAt: string;
  sealedKey: string;
  nonce: string;
};
export type StateRecoveryBackup = Readonly<Header & { path: string; sha256: string }>;
export type StateRecoveryBackupKey = { key: Buffer; sealedKey: string };
export type StateRecoveryBackupWarning = "recovery_snapshot_missing" | "recovery_snapshot_unreadable"
  | "recovery_snapshot_changed" | "recovery_snapshot_receipt_missing" | "recovery_snapshot_receipt_invalid"
  | "recovery_snapshot_schema_mismatch" | "recovery_snapshot_cleanup_failed";
export type StateRecoveryBackupValidation = { status: "absent" | "validated" }
  | { status: "unverified"; warning: StateRecoveryBackupWarning };
// Only a just-authenticated prepare operation can authorize a new receipt. A
// restart cannot recreate this proof by trusting the retained file's header.
const authenticatedSnapshots = new WeakSet<StateRecoveryBackup>();
type Cell = ["null"] | ["integer" | "real" | "text" | "blob", string];
type TableRecord = { kind: "table"; name: string; sql: string | null; columns: string[]; rowid: string | null };
type SnapshotRecord = TableRecord | { kind: "row"; cells: Cell[] }
  | { kind: "ddl"; sql: string } | { kind: "end"; applicationId: number };

type StateRecoveryFailureCode = "desktop_channel_missing" | "key_unavailable" | "snapshot_refused" | "verify_failed";
/** Fixed codes reach the existing startup log through Error.message, never a source exception. */
export class StateRecoveryError extends Error {
  constructor(readonly code: StateRecoveryFailureCode) {
    super(`Encrypted daemon recovery snapshot could not be verified safely. [${code}]`);
  }
}
function failure(code: StateRecoveryFailureCode = "verify_failed"): StateRecoveryError { return new StateRecoveryError(code); }
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
function backupPath(databasePath: string): string { return `${resolve(databasePath)}.recovery.enc`; }

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(dirname(path));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) throw failure();
}

async function regularFile(path: string, privateOnly = false): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || (process.getuid && info.uid !== process.getuid())
      || (privateOnly && (info.mode & 0o077) !== 0)) throw failure();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

function encode(value: SQLOutputValue): Cell {
  if (value === null) return ["null"];
  if (typeof value === "bigint") return ["integer", String(value)];
  if (typeof value === "number") return ["real", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "string") return ["text", value];
  return ["blob", Buffer.from(value).toString("base64")];
}

function decode(cell: Cell): SQLInputValue {
  switch (cell[0]) {
    case "null": return null;
    case "integer": return BigInt(cell[1]);
    case "real": { const value = Number(cell[1]); if (Number.isNaN(value)) throw failure(); return value; }
    case "text": return cell[1];
    case "blob": return Buffer.from(cell[1], "base64");
    default: throw failure();
  }
}

function checkDatabase(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || rows[0].integrity_check !== "ok"
    || database.prepare("PRAGMA foreign_key_check").all().length) throw failure();
}

/** A read transaction includes committed WAL pages without creating a plaintext copy. */
function* snapshot(database: DatabaseSync): Generator<SnapshotRecord> {
  checkDatabase(database);
  if (database.prepare("PRAGMA encoding").get()!.encoding !== "UTF-8") throw failure();
  const tables = database.prepare("PRAGMA main.table_list").all();
  if (tables.some((table) => table.schema === "main" && table.type !== "table" && table.type !== "view")) throw failure();
  const schema = database.prepare("SELECT type,name,sql,CAST(name AS BLOB) AS name_bytes,CAST(sql AS BLOB) AS sql_bytes FROM sqlite_schema ORDER BY type,name").all();
  for (const entry of schema) {
    if (!Buffer.from(String(entry.name)).equals(entry.name_bytes as Uint8Array)
      || (entry.sql !== null && !Buffer.from(String(entry.sql)).equals(entry.sql_bytes as Uint8Array))) throw failure();
  }
  for (const entry of schema.filter((entry) => entry.type === "table").sort((a, b) =>
    Number(a.name === "sqlite_sequence") - Number(b.name === "sqlite_sequence"))) {
    const name = String(entry.name);
    // ANALYZE statistics are derived, not user data. Only known statistics are
    // omitted; sequence state is preserved and all other internals fail closed.
    if (/^sqlite_stat[1-4]$/.test(name)) continue;
    if (name.startsWith("sqlite_") && name !== "sqlite_sequence") throw failure();
    const table = tables.find((table) => table.name === name);
    if (!table) throw failure();
    const allColumns = database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    const columns = allColumns.filter((column) => column.hidden === 0).map((column) => String(column.name));
    const rowid = table.wr === 1 ? null : ["rowid", "_rowid_", "oid"].find((alias) =>
      !allColumns.some((column) => String(column.name).toLowerCase() === alias));
    if (table.wr !== 1 && !rowid) throw failure();
    yield { kind: "table", name, sql: name === "sqlite_sequence" ? null : String(entry.sql), columns, rowid: rowid ?? null };
    const selected = [...(rowid ? [rowid] : []), ...columns];
    const statement = database.prepare(`SELECT ${selected.flatMap((column, i) => [
      `${quote(column)} AS ${quote(`c${i}`)}`,
      `CASE WHEN typeof(${quote(column)})='text' THEN CAST(${quote(column)} AS BLOB) END AS ${quote(`b${i}`)}`,
    ]).join(",")} FROM ${quote(name)}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) yield { kind: "row", cells: selected.map((_, i) => {
      let value = row[`c${i}`];
      // Invalid UTF-8 TEXT cannot roundtrip through JavaScript strings. Refuse
      // it instead of retaining an apparently valid but lossy recovery point.
      if (typeof value === "string") {
        const bytes = Buffer.from(row[`b${i}`] as Uint8Array);
        value = bytes.toString("utf8"); // node:sqlite versions can truncate TEXT at NUL.
        if (!Buffer.from(value).equals(bytes)) throw failure();
      }
      return encode(value);
    }) };
  }
  for (const entry of schema.filter((entry) => entry.type !== "table" && entry.sql !== null)) {
    if (!["index", "trigger", "view"].includes(String(entry.type))) throw failure();
    yield { kind: "ddl", sql: String(entry.sql) };
  }
  yield { kind: "end", applicationId: Number(database.prepare("PRAGMA application_id").get()!.application_id) };
}

function parseEnvelope(bytes: Buffer): { header: Header; aad: Buffer; ciphertext: Buffer; tag: Buffer } {
  const end = bytes.indexOf(10);
  if (end < 0 || end > HEADER_LIMIT || bytes.length < end + 1 + 16) throw failure();
  const aad = bytes.subarray(0, end + 1);
  const header = JSON.parse(aad.toString("utf8")) as Header;
  if (header.format !== MAGIC || !Number.isSafeInteger(header.sourceVersion) || header.sourceVersion < 1
    || !Number.isSafeInteger(header.targetVersion) || header.targetVersion <= header.sourceVersion
    || !Number.isFinite(Date.parse(header.createdAt)) || typeof header.sealedKey !== "string" || !header.sealedKey
    || typeof header.nonce !== "string" || Buffer.from(header.nonce, "base64").length !== 12) throw failure();
  return { header, aad, ciphertext: bytes.subarray(end + 1, -16), tag: bytes.subarray(-16) };
}

async function readEnvelope(path: string): Promise<{ bytes: Buffer; header: Header }> {
  await privateDirectory(path);
  if (!await regularFile(path, true)) throw failure();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await file.readFile();
    return { bytes, header: parseEnvelope(bytes).header };
  } finally { await file.close(); }
}

/**
 * Recovery inspection only: never opens or replaces the live database. A future
 * restore flow must fence the daemon and revoke/remint restored worker credentials.
 */
export async function decryptStateRecoveryBackup(path: string, key: Buffer): Promise<DatabaseSync> {
  let restored: DatabaseSync | undefined;
  let plaintext: Buffer | undefined;
  try {
    const { bytes } = await readEnvelope(path);
    const { header, aad, ciphertext, tag } = parseEnvelope(bytes);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    // Authenticate completely before interpreting any SQL.
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    restored = new DatabaseSync(":memory:");
    restored.exec("PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=OFF; PRAGMA trusted_schema=OFF; BEGIN");
    let insert: ReturnType<DatabaseSync["prepare"]> | undefined;
    let ended = false;
    for (const line of plaintext.toString("utf8").trimEnd().split("\n")) {
      if (ended) throw failure();
      const record = JSON.parse(line) as SnapshotRecord;
      switch (record.kind) {
        case "table": {
          if (record.sql) restored.exec(record.sql);
          else if (record.name !== "sqlite_sequence") throw failure();
          else {
            // SQLite retains this table after the last AUTOINCREMENT table is
            // dropped (including a rolled-back feature schema). Recreate that
            // state through supported DDL, never writable_schema.
            if (!restored.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
              const seed = quote(`recovery_sequence_${randomBytes(12).toString("hex")}`);
              restored.exec(`CREATE TABLE ${seed}(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE ${seed}`);
            }
            restored.exec("DELETE FROM sqlite_sequence");
          }
          const columns = [...(record.rowid ? [record.rowid] : []), ...record.columns];
          insert = restored.prepare(`INSERT INTO ${quote(record.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
          break;
        }
        case "row": if (!insert) throw failure(); else insert.run(...record.cells.map(decode)); break;
        case "ddl": insert = undefined; restored.exec(record.sql); break;
        case "end": {
          if (!Number.isSafeInteger(record.applicationId)) throw failure();
          restored.exec(`PRAGMA user_version=${header.sourceVersion}; PRAGMA application_id=${record.applicationId}`);
          ended = true;
          break;
        }
        default: throw failure();
      }
    }
    if (!ended) throw failure();
    checkDatabase(restored);
    restored.exec("COMMIT; PRAGMA foreign_keys=ON");
    return restored;
  } catch {
    try { restored?.close(); } catch { /* no database content in errors */ }
    throw failure();
  } finally { plaintext?.fill(0); }
}

/**
 * Caller holds the daemon singleton/migration fence. Owns and wipes the one-time
 * key returned by getKey. Only encrypted candidate and retained files touch disk.
 */
export async function prepareStateRecoveryBackup(
  databasePath: string,
  targetVersion: number,
  getKey: () => Promise<StateRecoveryBackupKey>,
  options: { now?: Date } = {},
): Promise<StateRecoveryBackup | null> {
  const path = backupPath(databasePath);
  const candidate = `${path}.pending`;
  let database: DatabaseSync | undefined;
  let key: Buffer | undefined;
  let ownedCandidate = false;
  let failureCode: StateRecoveryFailureCode = "snapshot_refused";
  try {
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw failure();
    if (!await regularFile(databasePath)) return null;
    await privateDirectory(path);
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA temp_store=MEMORY; BEGIN");
    const sourceVersion = Number(database.prepare("PRAGMA user_version").get()!.user_version);
    if (sourceVersion > targetVersion) throw failure();
    if (sourceVersion === targetVersion || sourceVersion === 0) return null;
    const hasMetadata = database.prepare("SELECT 1 FROM sqlite_schema WHERE name='manifest_metadata'").get();
    if (hasMetadata && Number(database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get()?.schema_version) !== sourceVersion) throw failure();
    await regularFile(path, true);
    // A prior crash can leave only ciphertext here. Never follow or truncate a link.
    if (await regularFile(candidate, true)) await unlink(candidate);
    failureCode = "key_unavailable";
    const material = await getKey();
    key = material.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || !material.sealedKey) throw failure();
    failureCode = "snapshot_refused";
    const header: Header = { format: MAGIC, sourceVersion, targetVersion, createdAt: (options.now ?? new Date()).toISOString(), sealedKey: material.sealedKey, nonce: randomBytes(12).toString("base64") };
    const aad = Buffer.from(`${JSON.stringify(header)}\n`);
    if (aad.length > HEADER_LIMIT) throw failure();
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
    cipher.setAAD(aad);
    const file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownedCandidate = true;
    const hash = createHash("sha256");
    const write = async (bytes: Buffer): Promise<void> => {
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) {
        const result = await file.write(bytes, offset, bytes.length - offset);
        if (result.bytesWritten === 0) throw failure();
        offset += result.bytesWritten;
      }
    };
    try {
      await write(aad);
      for (const record of snapshot(database)) await write(cipher.update(`${JSON.stringify(record)}\n`, "utf8"));
      await write(cipher.final());
      await write(cipher.getAuthTag());
      await file.sync();
    } finally { await file.close(); }
    failureCode = "verify_failed";
    const verified = await decryptStateRecoveryBackup(candidate, key);
    verified.close();
    failureCode = "snapshot_refused";
    await regularFile(path, true);
    await rename(candidate, path);
    ownedCandidate = false;
    await syncDirectory(path);
    const result = Object.freeze({ ...header, path, sha256: hash.digest("hex") });
    authenticatedSnapshots.add(result);
    return result;
  } catch (error) {
    // Preserve only the known bootstrap distinction, not arbitrary error codes,
    // messages, stacks, or causes supplied by key storage / SQLite / filesystem.
    if (failureCode === "key_unavailable" && error instanceof StateRecoveryError
      && error.code === "desktop_channel_missing") failureCode = "desktop_channel_missing";
    throw failure(failureCode);
  }
  finally {
    key?.fill(0);
    try { database?.close(); } catch { /* read transaction rolls back */ }
    if (ownedCandidate) {
      try { if (await regularFile(candidate, true)) { await unlink(candidate); await syncDirectory(candidate); } } catch { /* next fenced startup rejects unsafe paths */ }
    }
  }
}

/** Safe, bounded diagnostics: no payload, source error, or quarantine path. */
export function recordStateRecoveryBackupWarning(
  database: DatabaseSync, warning: StateRecoveryBackupWarning, now = new Date(),
): StateRecoveryBackupValidation {
  database.prepare(`INSERT INTO migration_failures(migration_key,reason,failed_at,quarantined_path) VALUES(?,?,?,'')
    ON CONFLICT(migration_key) DO UPDATE SET reason=excluded.reason,
      failed_at=CASE WHEN migration_failures.reason=excluded.reason THEN migration_failures.failed_at ELSE excluded.failed_at END,
      quarantined_path=''`).run(RECEIPT_KEY, warning, now.toISOString());
  return { status: "unverified", warning };
}

/**
 * Retention starts only with fresh authenticated proof after schema validation.
 * A crash between migration commit and this receipt leaves one unverified file:
 * preserve it without auto-expiry until explicit clear/recovery or supersession.
 * Damaged or unverified recovery artifacts never disable a healthy current DB.
 */
export async function markStateRecoveryBackupValidated(
  databasePath: string, database: DatabaseSync,
  options: { freshBackup?: StateRecoveryBackup | null; now?: Date } = {},
): Promise<StateRecoveryBackupValidation> {
  const path = backupPath(databasePath);
  const now = options.now ?? new Date();
  const fresh = options.freshBackup;
  const authenticated = fresh ? authenticatedSnapshots.delete(fresh) && fresh.path === path : false;
  const warn = (warning: StateRecoveryBackupWarning) => recordStateRecoveryBackupWarning(database, warning, now);
  const receipt = database.prepare("SELECT checksum,imported_at FROM migration_records WHERE migration_key=?").get(RECEIPT_KEY);
  let envelope: Awaited<ReturnType<typeof readEnvelope>>;
  try {
    if (!await regularFile(path, true)) {
      if (fresh || receipt) return warn("recovery_snapshot_missing");
      database.prepare("DELETE FROM migration_failures WHERE migration_key=?").run(RECEIPT_KEY);
      return { status: "absent" };
    }
    envelope = await readEnvelope(path);
  } catch { return warn("recovery_snapshot_unreadable"); }
  const { bytes, header } = envelope;
  if (Number(database.prepare("PRAGMA user_version").get()!.user_version) !== header.targetVersion) return warn("recovery_snapshot_schema_mismatch");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const matchesReceipt = receipt?.checksum === checksum;
  if (!matchesReceipt || !Number.isFinite(Date.parse(String(receipt?.imported_at)))) {
    if (!authenticated || fresh!.sha256 !== checksum || fresh!.targetVersion !== header.targetVersion) {
      return warn(!receipt ? "recovery_snapshot_receipt_missing" : matchesReceipt
        ? "recovery_snapshot_receipt_invalid" : "recovery_snapshot_changed");
    }
    database.prepare(`INSERT INTO migration_records(migration_key,checksum,imported_at) VALUES(?,?,?)
      ON CONFLICT(migration_key) DO UPDATE SET checksum=excluded.checksum,imported_at=excluded.imported_at`)
      .run(RECEIPT_KEY, checksum, now.toISOString());
  }
  database.prepare("DELETE FROM migration_failures WHERE migration_key=?").run(RECEIPT_KEY);
  return { status: "validated" };
}

export async function cleanupStateRecoveryBackup(
  databasePath: string, database: DatabaseSync, options: { now?: Date; clear?: boolean } = {},
): Promise<boolean> {
  try {
    const path = backupPath(databasePath);
    await privateDirectory(path);
    const candidate = `${path}.pending`;
    const hadCandidate = await regularFile(candidate, true);
    if (hadCandidate) { await unlink(candidate); await syncDirectory(candidate); }
    if (!await regularFile(path, true)) {
      if (options.clear) {
        database.prepare("DELETE FROM migration_records WHERE migration_key=?").run(RECEIPT_KEY);
        database.prepare("DELETE FROM migration_failures WHERE migration_key=?").run(RECEIPT_KEY);
      }
      return hadCandidate;
    }
    if (!options.clear) {
      const { bytes } = await readEnvelope(path);
      const receipt = database.prepare("SELECT checksum, imported_at FROM migration_records WHERE migration_key=?").get(RECEIPT_KEY);
      if (!receipt || receipt.checksum !== createHash("sha256").update(bytes).digest("hex")) return false;
      const validatedAt = Date.parse(String(receipt.imported_at));
      const now = (options.now ?? new Date()).getTime();
      if (!Number.isFinite(now)) throw failure();
      if (!Number.isFinite(validatedAt) || now - validatedAt < RETENTION_MS) return false;
    }
    await unlink(path);
    await syncDirectory(path);
    database.prepare("DELETE FROM migration_records WHERE migration_key=?").run(RECEIPT_KEY);
    database.prepare("DELETE FROM migration_failures WHERE migration_key=?").run(RECEIPT_KEY);
    return true;
  } catch { throw failure(); }
}
