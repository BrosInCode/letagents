import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isOwnerPrivate, ownerPrivatePlatform, protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { signalTree } from "../../../../shared/process-tree.mjs";
import { renameWithRetryAsync } from "../../../../shared/rename-retry.mjs";
import { processBirthState } from "../process-identity.js";
import { DaemonStateSchema } from "./schema.js";
import { SCHEMA_VERSION, type Row } from "./shared.js";
import { assertDaemonStateVersionSupported, inspectDaemonStateDatabase } from "./version-gate.js";

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

function isSqliteBusyOrLocked(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException;
  const code = String(candidate?.code ?? "").toUpperCase();
  const message = String(candidate?.message ?? error).toUpperCase();
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_(BUSY|LOCKED)|DATABASE IS (BUSY|LOCKED)/.test(message);
}

async function syncDirectory(path: string): Promise<void> {
  if (ownerPrivatePlatform() === "win32") return;
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function ensureOwnerPrivateFilesOnWindows(path: string): Promise<void> {
  if (ownerPrivatePlatform() !== "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info || await isOwnerPrivate(candidate, info)) continue;
    try { await protectOwnerPrivate(candidate, "file", { force: true }); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function uniqueLegacyDestination(path: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = suffix === 0 ? `${path}.legacy-${stamp}` : `${path}.legacy-${stamp}-${suffix}`;
    const existing = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) return candidate;
  }
  throw new Error("Could not allocate a unique path to move aside the legacy daemon database.");
}

type LegacyLiveRuntime = { pid: number; birth: string };

/**
 * Reads only exact (pid, process_identity) pairs from a pre-reset database so
 * surviving provider processes (Codex / Open Model) can be stopped cleanly by
 * exact OS birth before the legacy file is moved aside. Never migrates or loads
 * any operational state into schema v1.
 */
function readLegacyLiveRuntimes(database: DatabaseSync): LegacyLiveRuntime[] {
  try {
    const columns = new Set(
      (database.prepare("PRAGMA table_info('runtime_deployments')").all() as Row[]).map((row) => String(row.name)),
    );
    if (!columns.has("provider_connection_pid") || !columns.has("provider_process_identity")) return [];
    const rows = database.prepare(`
      SELECT DISTINCT provider_connection_pid AS pid, provider_process_identity AS birth
      FROM runtime_deployments
      WHERE provider_connection_pid IS NOT NULL AND provider_process_identity IS NOT NULL
    `).all() as Row[];
    const seen = new Set<string>();
    const targets: LegacyLiveRuntime[] = [];
    for (const row of rows) {
      const pid = Number(row.pid);
      const birth = String(row.birth).trim();
      if (!Number.isSafeInteger(pid) || pid < 1 || !birth) continue;
      const key = `${pid}:${birth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ pid, birth });
    }
    return targets;
  } catch {
    return [];
  }
}

async function stopLegacyLiveRuntimes(targets: readonly LegacyLiveRuntime[]): Promise<void> {
  await Promise.all(targets.map(async ({ pid, birth }) => {
    if (processBirthState(pid, birth) !== "live") return;
    if (process.platform === "win32") {
      signalTree(pid, "SIGTERM", { identity: birth, platform: "win32" });
      return;
    }
    signalTree(pid, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && processBirthState(pid, birth) === "live") {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (processBirthState(pid, birth) === "live") {
      signalTree(pid, "SIGKILL");
      const killDeadline = Date.now() + 1_000;
      while (Date.now() < killDeadline && processBirthState(pid, birth) === "live") {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    } else {
      // Leader exited on SIGTERM; clear any surviving grandchildren in its process group
      // without touching a potentially reused leader PID.
      signalTree(pid, "SIGKILL", { groupOnly: true });
    }
  }));
}

/**
 * Inspects an existing database read-only before backup or open. Any pre-reset
 * legacy database (application_id = 0 with user_version > 0 or existing tables)
 * has its surviving exact-birth provider runtimes stopped, then is moved aside
 * untouched along with its -wal, -shm, and .recovery.enc sidecars so the daemon
 * starts clean on schema v1. Future modern schemas and foreign SQLite files
 * fail closed without being moved or modified.
 */
export async function moveAsideLegacyDaemonStateDatabase(
  path: string,
  options: { now?: Date } = {},
): Promise<string | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Daemon state path must be a regular file.");
  }
  await ensureOwnerPrivateFilesOnWindows(path);
  let inspection: ReturnType<typeof inspectDaemonStateDatabase> | null = null;
  let legacyRuntimes: LegacyLiveRuntime[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      database.exec("PRAGMA busy_timeout = 5000");
      inspection = inspectDaemonStateDatabase(database);
      if (inspection.kind === "legacy") legacyRuntimes = readLegacyLiveRuntimes(database);
      break;
    } catch (error) {
      if (attempt === 7 || !isSqliteBusyOrLocked(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    } finally {
      try { database?.close(); } catch { /* ignore */ }
    }
  }
  if (!inspection) return null;
  if (inspection.kind === "foreign") {
    throw new Error(`Unsupported SQLite database application_id ${inspection.applicationId}.`);
  }
  if (inspection.kind === "modern") {
    if (inspection.schemaVersion < 1 || inspection.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`Unsupported daemon state schema version ${inspection.schemaVersion} (user_version=${inspection.userVersion}).`);
    }
    return null;
  }
  if (inspection.kind !== "legacy") return null;

  await stopLegacyLiveRuntimes(legacyRuntimes);
  const destination = await uniqueLegacyDestination(path, options.now ?? new Date());
  await renameWithRetryAsync(path, destination);
  for (const suffix of ["-wal", "-shm", ".recovery.enc", ".recovery.enc.pending"]) {
    const sidecar = `${path}${suffix}`;
    const sidecarInfo = await lstat(sidecar).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (sidecarInfo && sidecarInfo.isFile() && !sidecarInfo.isSymbolicLink()) {
      await renameWithRetryAsync(sidecar, `${destination}${suffix}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  await syncDirectory(destination);
  console.warn(`[daemon_state] moved aside legacy schema v${inspection.userVersion} database to ${destination}; starting clean on schema v${SCHEMA_VERSION}`);
  return destination;
}

/** Opens the single daemon state connection with the non-negotiable durability settings. */
export async function openDaemonStateDatabase(
  path: string,
  initializeSchema: (database: DatabaseSync) => void | Promise<void> = (opened) => new DaemonStateSchema().createSchema(opened),
): Promise<DatabaseSync> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await protectOwnerPrivate(directory, "directory");
  await moveAsideLegacyDaemonStateDatabase(path);
  await ensureOwnerPrivateFilesOnWindows(path);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout = 5000");
      assertDaemonStateVersionSupported(database);
      const mode = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (mode.toLowerCase() !== "wal") database.exec("PRAGMA journal_mode = WAL");
      const confirmed = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (confirmed.toLowerCase() !== "wal") {
        throw new Error(`Daemon state requires WAL journal mode, received ${confirmed}.`);
      }
      configureDaemonStateConnection(database);
      if (ownerPrivatePlatform() !== "win32") {
        for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
          try { await protectOwnerPrivate(candidate, "file"); }
          catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
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
 * Process-wide owner for the daemon's single SQLite connection.
 * All domain stores and publishers share this handle; close() runs once on stop/handoff.
 */
export class DaemonStateDatabase {
  private closed = false;

  private constructor(
    readonly path: string,
    readonly connection: DatabaseSync,
  ) {}

  static async open(
    path: string,
    initializeSchema?: (database: DatabaseSync) => void | Promise<void>,
  ): Promise<DaemonStateDatabase> {
    const connection = await openDaemonStateDatabase(path, initializeSchema);
    return new DaemonStateDatabase(path, connection);
  }

  static fromConnection(path: string, connection: DatabaseSync): DaemonStateDatabase {
    return new DaemonStateDatabase(path, connection);
  }

  get isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.connection.isOpen) this.connection.close();
  }
}

/** Initialise or upgrade the complete daemon-state schema without retaining a connection. */
export async function ensureDaemonStateDatabase(path: string): Promise<void> {
  const database = await openDaemonStateDatabase(path, (opened) => new DaemonStateSchema().createSchema(opened));
  database.close();
}
