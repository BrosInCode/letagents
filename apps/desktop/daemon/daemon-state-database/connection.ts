import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { SCHEMA_VERSION } from "./shared.js";
import { assertDaemonStateVersionSupported } from "./version-gate.js";
import { DaemonStateSchema } from "./schema.js";
import { isOwnerPrivate, ownerPrivatePlatform, protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";

function configureDaemonStateConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  if (database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) {
    throw new Error("Daemon state requires foreign key enforcement.");
  }
  database.exec("PRAGMA synchronous = FULL");
  // Temporary row snapshots must not spill a second plaintext copy to disk.
  database.exec("PRAGMA temp_store = MEMORY");
  // Deleted secret-bearing cells must not remain in reusable SQLite pages.
  database.exec("PRAGMA secure_delete = ON");
}

/**
 * Optional observation writer, opened only after protected migration while the
 * caller holds the daemon singleton. No creation, repair, WAL conversion or retries.
 */
export function openDaemonStateObservationDatabase(path: string): DatabaseSync {
  // A rejected read-write connection can checkpoint an existing WAL on close.
  // Preflight read-only so even a future or malformed WAL remains untouched.
  const inspection = new DatabaseSync(path, { readOnly: true });
  try {
    inspection.exec("PRAGMA busy_timeout = 0");
    configureDaemonStateConnection(inspection);
    new DaemonStateSchema().validateCurrentShape(inspection);
    if (String(inspection.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !== "wal") {
      throw new Error("Daemon observation storage requires existing WAL journal mode.");
    }
  } finally { inspection.close(); }

  // SQLite's URI mode=rw excludes CREATE atomically; an existence check followed
  // by the default constructor would recreate a database removed in between.
  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", "rw");
  const database = new DatabaseSync(uri.href);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    if (assertDaemonStateVersionSupported(database) !== SCHEMA_VERSION
      || String(database.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !== "wal") {
      throw new Error("Daemon observation storage changed after validation.");
    }
    configureDaemonStateConnection(database);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* preserve the triggering error */ }
    throw error;
  }
}

/** Opens a daemon state connection with the non-negotiable durability settings. */
export async function openDaemonStateDatabase(path: string, initializeSchema: (database: DatabaseSync) => void | Promise<void>): Promise<DatabaseSync> {
  const { lstat, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await protectOwnerPrivate(directory, "directory");
  // Windows: an existing database, -wal or -shm file is checked now, before
  // this process opens it, and protected only when it is not private (one
  // that another account made fails, as chmod would). Another process may
  // have it open, so a private one is only read, never changed; no tool runs
  // on it while this process has it open. A new one inherits the folder.
  if (ownerPrivatePlatform() === "win32") {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info || await isOwnerPrivate(candidate, info)) continue;
      try { await protectOwnerPrivate(candidate, "file", { force: true }); }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  // Fresh sibling daemons can race at the one-time WAL conversion or schema
  // DDL before busy_timeout is fully effective. Close each failed handle and
  // back off outside SQLite; never turn an unrelated initialization error into
  // a retry loop.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout = 5000");
      // A newer daemon owns this schema. Reject before journal-mode conversion,
      // checkpointing, or initialization can persist changes to its database.
      assertDaemonStateVersionSupported(database);
      const mode = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (mode.toLowerCase() !== "wal") database.exec("PRAGMA journal_mode = WAL");
      const confirmed = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (confirmed.toLowerCase() !== "wal") throw new Error(`Daemon state requires WAL journal mode, received ${confirmed}.`);
      configureDaemonStateConnection(database);
      // Windows did this before the open (above): no tool may change the DACL of an open SQLite file.
      if (ownerPrivatePlatform() !== "win32") {
        for (const candidate of [path, `${path}-wal`, `${path}-shm`]) { try { await protectOwnerPrivate(candidate, "file"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      }
      await initializeSchema(database);
      return database;
    } catch (error) {
      try { database?.close(); } catch { /* preserve the triggering error */ }
      if (attempt === 7 || !isSqliteBusyOrLocked(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error("Daemon state initialization retry loop exited unexpectedly.");
}

/**
 * Opens an operational handle after the singleton owner completed the protected
 * schema upgrade. Critical authority is still checked before the handle can be
 * used, but the historical repair/validation chain is not repeated per store.
 */
export async function openPreparedDaemonStateDatabase(path: string): Promise<DatabaseSync> {
  // The protected upgrade already created and migrated this file. Inspect it
  // read-only first so a missing, replaced, or non-WAL database cannot be
  // created or changed by an operational store racing after preparation.
  const inspection = new DatabaseSync(path, { readOnly: true });
  try {
    inspection.exec("PRAGMA busy_timeout = 0");
    if (assertDaemonStateVersionSupported(inspection) !== SCHEMA_VERSION) {
      throw new Error("Daemon operational storage requires the already-current schema.");
    }
    if (String(inspection.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !== "wal") {
      throw new Error("Daemon operational storage requires existing WAL journal mode.");
    }
  } finally { inspection.close(); }

  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", "rw");
  const database = new DatabaseSync(uri.href);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    if (assertDaemonStateVersionSupported(database) !== SCHEMA_VERSION
      || String(database.prepare("PRAGMA journal_mode").get()!.journal_mode).toLowerCase() !== "wal") {
      throw new Error("Daemon operational storage changed after preparation.");
    }
    configureDaemonStateConnection(database);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* preserve the triggering error */ }
    throw error;
  }
}

function isSqliteBusyOrLocked(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException;
  const code = String(candidate?.code ?? "").toUpperCase();
  const message = String(candidate?.message ?? error).toUpperCase();
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_(BUSY|LOCKED)|DATABASE IS (BUSY|LOCKED)/.test(message);
}

/** Initialise or upgrade the complete daemon-state schema without retaining a connection. */
export async function ensureDaemonStateDatabase(path: string): Promise<void> {
  const database = await openDaemonStateDatabase(path, (opened) => new DaemonStateSchema().createSchema(opened));
  database.close();
}
