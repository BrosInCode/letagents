import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isOwnerPrivate, ownerPrivatePlatform, protectOwnerPrivate, windowsToolPaths } from "../../../../shared/owner-private-fs.mjs";
import { isBirthEvidence, signalTree, signalTreeOutcome, windowsProcessInfo, type TreeSignalOutcome } from "../../../../shared/process-tree.mjs";
import { renameWithRetryAsync } from "../../../../shared/rename-retry.mjs";
import { processBirthState, sameProcessBirthIdentity } from "../process-identity.js";
import { DaemonStateSchema, validateDaemonStateShapeForVersion } from "./schema.js";
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
    const isTransientSidecar = candidate !== path;
    for (let attempt = 0; attempt < (isTransientSidecar ? 4 : 1); attempt += 1) {
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info || await isOwnerPrivate(candidate, info)) break;
      try {
        await protectOwnerPrivate(candidate, "file", { force: true });
        break;
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") break;
        // SQLite deletes and recreates -wal/-shm during concurrent close/open.
        // Retry only transient replacement on sidecars; never suppress ownership
        // or symlink errors.
        if (isTransientSidecar
          && attempt < 3
          && err.code === "EOWNERPRIVATE"
          && /was replaced while it was being made private/i.test(err.message)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
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

export type PosixBirthReadResult =
  | { kind: "birth"; birth: string }
  | { kind: "absent" }
  | { kind: "error" };

export type MoveAsideLegacyOptions = {
  now?: Date;
  platform?: NodeJS.Platform;
  birthState?: (pid: number, birth: string) => "live" | "gone" | "unknown";
  probePid?: (pid: number) => void;
  readPosixBirth?: (pid: number) => PosixBirthReadResult;
  queryWindowsWmiCreations?: (pids: readonly number[]) => Map<number, string> | null;
  checkWindowsProcessAbsent?: (pid: number) => boolean;
  signalProcessTree?: typeof signalTree;
  signalProcessTreeOutcome?: typeof signalTreeOutcome;
  renameFile?: (from: string, to: string) => Promise<void>;
  lstatFile?: typeof lstat;
  graceMs?: number;
  killWaitMs?: number;
};

export type OpenDaemonStateDatabaseOptions = Pick<MoveAsideLegacyOptions, "lstatFile">;

const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n;
const MAX_FILETIME = (1n << 64n) - 1n;
const WINDOWS_BIRTH_PATTERN = /^win32-ft:([1-9]\d{0,19})$/;
const CIM_DATETIME_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;

/**
 * Parses a recorded `win32-ft:<FILETIME>` string into an exact 64-bit unsigned
 * integer (100-ns ticks since 1601-01-01T00:00:00Z).
 */
export function parseWindowsBirthFiletime(birth: string): bigint | null {
  const match = WINDOWS_BIRTH_PATTERN.exec(birth.trim());
  if (!match) return null;
  const value = BigInt(match[1]!);
  return value >= 1n && value <= MAX_FILETIME ? value : null;
}

/**
 * Parses a WMI CIM_DATETIME string (`YYYYMMDDHHMMSS.mmmmmm±OOO`) into an exact
 * UTC FILETIME (100-ns ticks since 1601-01-01T00:00:00Z) using BigInt math,
 * preserving the UTC offset and exact microsecond digits without float loss.
 * Returns null for any malformed date, invalid calendar date, or invalid offset.
 */
export function parseWindowsCimDateTimeToFiletimeUtc(raw: string): bigint | null {
  const match = CIM_DATETIME_PATTERN.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const microseconds = BigInt(match[7]!);
  const offsetSign = match[8] === "-" ? -1n : 1n;
  const offsetMinutes = BigInt(match[9]!);
  if (year < 1601 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59 || offsetMinutes > 840n) {
    return null;
  }
  const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const verified = new Date(localUtcMs);
  if (verified.getUTCFullYear() !== year || verified.getUTCMonth() !== month - 1
    || verified.getUTCDate() !== day || verified.getUTCHours() !== hour
    || verified.getUTCMinutes() !== minute || verified.getUTCSeconds() !== second) {
    return null;
  }
  const utcMs = BigInt(localUtcMs) - offsetSign * offsetMinutes * 60_000n;
  const filetime = (utcMs + FILETIME_UNIX_EPOCH_MS) * 10_000n + microseconds * 10n;
  if (filetime < 1n || filetime > MAX_FILETIME) return null;
  return filetime;
}

/**
 * Compares a 100-ns helper FILETIME against a microsecond-precision WMI
 * FILETIME. Values within 1 microsecond (10 FILETIME ticks) are treated as
 * compatible (same process) so WMI's lower precision can never become false
 * proof of PID reuse.
 */
export function areWindowsFiletimesCompatibleAtWmiPrecision(recorded100ns: bigint, wmi100ns: bigint): boolean {
  const diff = recorded100ns >= wmi100ns ? recorded100ns - wmi100ns : wmi100ns - recorded100ns;
  return diff <= 10n;
}

function defaultReadPosixBirth(pid: number): PosixBirthReadResult {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (result.error || result.signal) return { kind: "error" };
  const output = String(result.stdout ?? "").trim();
  if (result.status === 0) {
    return output ? { kind: "birth", birth: output } : { kind: "error" };
  }
  // `ps -p <pid>` exits 1 with empty output when no process has that PID.
  if (result.status === 1 && !output) return { kind: "absent" };
  return { kind: "error" };
}

/**
 * Batched single-invocation WMI query for Windows `Win32_Process.CreationDate`
 * in raw CIM_DATETIME format (`YYYYMMDDHHMMSS.mmmmmm±OOO`). Used only during
 * legacy reset when `letagents-process-tree.exe info <pid>` cannot open a
 * system/protected process without elevation (measured on Windows 11 desktop
 * session: WMI reads `CreationDate` for System(4), csrss, lsass, MsMpEng, and
 * svchost without elevation). Returns null on any invocation/parse failure.
 */
function defaultQueryWindowsWmiCreations(pids: readonly number[]): Map<number, string> | null {
  const validPids = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid >= 1 && pid <= 0xffffffff))];
  if (validPids.length === 0) return new Map();
  const filter = validPids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = `$ErrorActionPreference='Stop'; $s=[wmisearcher]"SELECT ProcessId,CreationDate FROM Win32_Process WHERE ${filter}"; $s.Get() | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate)" }`;
  const result = spawnSync(
    windowsToolPaths().powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15_000 },
  );
  if (result.error || result.signal || result.status !== 0) return null;
  const creations = new Map<number, string>();
  for (const rawLine of String(result.stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf("|");
    if (sep <= 0) return null;
    const pidText = line.slice(0, sep).trim();
    const cimDate = line.slice(sep + 1).trim();
    if (!/^[1-9]\d{0,9}$/.test(pidText) || !cimDate) return null;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) return null;
    creations.set(pid, cimDate);
  }
  return creations;
}

function defaultProbePid(pid: number): void {
  process.kill(pid, 0);
}

function isPidAbsentByProbe(pid: number, probe: (target: number) => void): boolean {
  try {
    probe(pid);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * Reset-local birth state resolver for legacy runtime records. Keeps
 * `processBirthState` in `process-identity.ts` untouched for live recovery,
 * while resolving cross-account PID reuse using only hard OS evidence:
 * - POSIX (`EPERM` on `kill(0)`): reads `/bin/ps -p <pid> -o lstart=` directly;
 *   only a verified different birth (or `ps` absent + `ESRCH` re-probe) proves
 *   `"gone"`. Equal birth, `ps` timeout/error, or unreadable output stays `"unknown"`.
 * - Windows (helper access-denied in non-elevated desktop sessions): performs
 *   one batched WMI `Win32_Process.CreationDate` query for all unresolved PIDs
 *   and compares raw CIM_DATETIME UTC offsets against recorded `win32-ft:` at
 *   microsecond precision (diff > 10 ticks). Compatible timestamps, malformed
 *   output, and query failures stay `"unknown"`.
 */
function resolveLegacyRuntimeStates(
  targets: readonly LegacyLiveRuntime[],
  options: MoveAsideLegacyOptions,
): Map<string, "live" | "gone" | "unknown"> {
  const platform = options.platform ?? process.platform;
  const baseBirthState = options.birthState ?? ((pid, birth) => processBirthState(pid, birth));
  const probe = options.probePid ?? defaultProbePid;
  const results = new Map<string, "live" | "gone" | "unknown">();
  const unresolved: Array<{ key: string; pid: number; birth: string }> = [];

  for (const { pid, birth } of targets) {
    const key = `${pid}:${birth}`;
    const state = baseBirthState(pid, birth);
    results.set(key, state);
    if (state === "unknown") unresolved.push({ key, pid, birth });
  }
  if (unresolved.length === 0) return results;

  // If the caller injected a custom birthState without OS fallback hooks, keep
  // its exact "unknown" answer unless the OS fallback is explicitly provided.
  const hasCustomBirthState = options.birthState !== undefined;

  if (platform !== "win32") {
    if (hasCustomBirthState && !options.probePid && !options.readPosixBirth) return results;
    const readPosix = options.readPosixBirth ?? defaultReadPosixBirth;
    for (const item of unresolved) {
      let probeCode: string | null = null;
      try {
        probe(item.pid);
      } catch (error) {
        probeCode = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
      }
      if (probeCode === "ESRCH") {
        results.set(item.key, "gone");
        continue;
      }
      if (probeCode !== "EPERM" || !isBirthEvidence(item.birth, platform)) {
        continue;
      }
      const ps = readPosix(item.pid);
      if (ps.kind === "birth") {
        if (isBirthEvidence(ps.birth, platform) && !sameProcessBirthIdentity(ps.birth, item.birth)) {
          results.set(item.key, "gone");
        }
      } else if (ps.kind === "absent" && isPidAbsentByProbe(item.pid, probe)) {
        results.set(item.key, "gone");
      }
    }
    return results;
  }

  if (hasCustomBirthState && !options.queryWindowsWmiCreations && !options.checkWindowsProcessAbsent) {
    return results;
  }
  const isWindowsAbsent = options.checkWindowsProcessAbsent
    ?? ((pid: number) => isPidAbsentByProbe(pid, probe) || windowsProcessInfo(pid) === null);
  const wmiCandidates: Array<{ key: string; pid: number; recordedFiletime: bigint }> = [];
  for (const item of unresolved) {
    if (isWindowsAbsent(item.pid)) {
      results.set(item.key, "gone");
      continue;
    }
    const recordedFiletime = parseWindowsBirthFiletime(item.birth);
    if (recordedFiletime !== null) {
      wmiCandidates.push({ key: item.key, pid: item.pid, recordedFiletime });
    }
  }
  if (wmiCandidates.length === 0) return results;

  const queryWmi = options.queryWindowsWmiCreations ?? defaultQueryWindowsWmiCreations;
  const creations = queryWmi(wmiCandidates.map((item) => item.pid));
  if (!creations) return results;

  for (const item of wmiCandidates) {
    const cimDate = creations.get(item.pid);
    if (cimDate === undefined) {
      if (isWindowsAbsent(item.pid)) results.set(item.key, "gone");
      continue;
    }
    const actualFiletime = parseWindowsCimDateTimeToFiletimeUtc(cimDate);
    if (actualFiletime === null) continue;
    if (!areWindowsFiletimesCompatibleAtWmiPrecision(item.recordedFiletime, actualFiletime)) {
      results.set(item.key, "gone");
    }
  }
  return results;
}

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
  } catch (error) {
    if (!isSqliteBusyOrLocked(error)) {
      console.warn("[daemon_state] failed to inspect legacy runtime_deployments before move-aside:", error);
    }
    throw error;
  }
}

async function waitForLegacyRuntimeExit(
  pid: number,
  birth: string,
  birthState: (pid: number, birth: string) => "live" | "gone" | "unknown",
  timeoutMs: number,
): Promise<"live" | "gone" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  let state = birthState(pid, birth);
  while (state === "live" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    state = birthState(pid, birth);
  }
  return state;
}

/**
 * Stops surviving exact-birth legacy provider processes and requires hard proof
 * (`"gone"`) before the legacy database can be moved aside. Reused PIDs resolve
 * to `"gone"` and are never signalled; failed signalling, unkillable trees, or
 * unresolved birth identities (`"unknown"`) fail closed.
 */
async function stopLegacyLiveRuntimes(
  targets: readonly LegacyLiveRuntime[],
  options: MoveAsideLegacyOptions = {},
): Promise<void> {
  if (targets.length === 0) return;
  const platform = options.platform ?? process.platform;
  const birthState = options.birthState ?? ((pid, birth) => processBirthState(pid, birth));
  const initialStates = resolveLegacyRuntimeStates(targets, options);
  const graceMs = options.graceMs ?? 2_000;
  const killWaitMs = options.killWaitMs ?? 1_000;
  const sendSignal = options.signalProcessTree ?? signalTree;
  const sendSignalOutcome: (pid: number, signal: NodeJS.Signals, opts: { identity?: string; platform?: NodeJS.Platform }) => TreeSignalOutcome =
    options.signalProcessTreeOutcome
    ?? (options.signalProcessTree
      ? (pid, signal, opts) => (options.signalProcessTree!(pid, signal, opts) ? "ended" : "none")
      : signalTreeOutcome);

  await Promise.all(targets.map(async ({ pid, birth }) => {
    const initialState = initialStates.get(`${pid}:${birth}`) ?? "unknown";
    if (initialState === "gone") return;
    if (initialState === "unknown") {
      throw new Error(`Cannot reset legacy daemon state: legacy provider process ${pid} birth identity could not be resolved.`);
    }
    if (platform === "win32") {
      const outcome = sendSignalOutcome(pid, "SIGTERM", { identity: birth, platform: "win32" });
      if (outcome === "unkillable") {
        throw new Error(`Cannot reset legacy daemon state: legacy provider process ${pid} is unkillable.`);
      }
      if (outcome === "none") {
        const after = birthState(pid, birth);
        if (after === "gone") return;
        throw new Error(`Cannot reset legacy daemon state: failed to stop legacy provider process ${pid} on Windows (${after}).`);
      }
      const finalState = await waitForLegacyRuntimeExit(pid, birth, birthState, killWaitMs);
      if (finalState !== "gone") {
        throw new Error(`Cannot reset legacy daemon state: legacy provider process ${pid} remained ${finalState} after Windows termination.`);
      }
      return;
    }

    const termSent = sendSignal(pid, "SIGTERM");
    let state = termSent ? await waitForLegacyRuntimeExit(pid, birth, birthState, graceMs) : birthState(pid, birth);
    if (state === "live") {
      const killSent = sendSignal(pid, "SIGKILL");
      state = killSent ? await waitForLegacyRuntimeExit(pid, birth, birthState, killWaitMs) : birthState(pid, birth);
    } else if (state === "gone") {
      // Leader exited on SIGTERM; clear any surviving grandchildren in its process group
      // without touching a potentially reused leader PID.
      sendSignal(pid, "SIGKILL", { groupOnly: true });
    }
    const finalState = birthState(pid, birth);
    if (finalState !== "gone") {
      throw new Error(`Cannot reset legacy daemon state: legacy provider process ${pid} could not be confirmed stopped (${finalState}).`);
    }
  }));
}

/**
 * Folds any uncheckpointed WAL frames into the legacy database main file with
 * `PRAGMA synchronous = FULL` and `PRAGMA wal_checkpoint(TRUNCATE)` before any
 * file moves, without altering user tables, rows, `user_version`, or
 * `application_id`. Once closed with no non-empty `-wal` left behind, renaming
 * the main file is a single self-contained commit point.
 */
async function checkpointLegacyDaemonStateDatabase(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA synchronous = FULL");
      const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Row | undefined;
      const busy = Number(result?.busy ?? 0);
      const log = Number(result?.log ?? -1);
      const checkpointed = Number(result?.checkpointed ?? -1);
      if (busy !== 0 || (log >= 0 && checkpointed < log)) {
        if (attempt === 7) {
          throw new Error(`Cannot move aside legacy daemon database: WAL checkpoint incomplete (busy=${busy}, log=${log}, checkpointed=${checkpointed}).`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      break;
    } catch (error) {
      if (attempt === 7 || !isSqliteBusyOrLocked(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    } finally {
      try { database?.close(); } catch { /* ignore */ }
    }
  }
  const walInfo = await lstat(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (walInfo && (!walInfo.isFile() || walInfo.isSymbolicLink() || walInfo.size > 0)) {
    throw new Error("Cannot move aside legacy daemon database: uncheckpointed WAL file remains after checkpoint.");
  }
}

/**
 * Inspects an existing database read-only before backup or open. Any pre-reset
 * legacy database (application_id = 0 with user_version > 0 or existing tables)
 * has its surviving exact-birth provider runtimes stopped and confirmed gone,
 * checkpoints its WAL into the main file so the main file alone is complete,
 * and then moves aside recovery sidecars and the main file so the daemon starts
 * clean on schema v1. Future modern schemas, foreign SQLite files, and orphaned
 * non-empty WAL files with no main database fail closed without modification.
 */
export async function moveAsideLegacyDaemonStateDatabase(
  path: string,
  options: MoveAsideLegacyOptions = {},
): Promise<string | null> {
  const statFile = options.lstatFile ?? lstat;
  let info = await statFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) {
    const strandedWal = await statFile(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (strandedWal) {
      if (!strandedWal.isFile() || strandedWal.isSymbolicLink()) {
        throw new Error("Refusing to initialize a fresh daemon database while an orphaned non-empty -wal file exists.");
      }
      if (strandedWal.size > 0) {
        // Re-check the main database file before refusing: a concurrent fresh
        // opener may have created the main file and its active -wal between
        // our initial lstat(path) and lstat(`${path}-wal`).
        info = await statFile(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info) {
          throw new Error("Refusing to initialize a fresh daemon database while an orphaned non-empty -wal file exists.");
        }
      }
    }
    if (!info) return null;
  }
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
      else if (
        inspection.kind === "modern"
        && inspection.schemaVersion >= 1
        && inspection.schemaVersion < SCHEMA_VERSION
      ) {
        validateDaemonStateShapeForVersion(database, inspection.schemaVersion);
      }
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
      const detail = inspection.schemaVersion >= 1
        ? `${inspection.schemaVersion} (user_version=${inspection.userVersion})`
        : `(user_version=${inspection.userVersion})`;
      throw new Error(`Unsupported daemon state schema version ${detail}.`);
    }
    return null;
  }
  if (inspection.kind !== "legacy") return null;

  await stopLegacyLiveRuntimes(legacyRuntimes, options);
  await checkpointLegacyDaemonStateDatabase(path);

  const destination = await uniqueLegacyDestination(path, options.now ?? new Date());
  const renameFile = options.renameFile ?? renameWithRetryAsync;
  // Move recovery sidecars first (separate filesystem operations) and roll them
  // back if renaming the checkpointed main file fails. Once the main file
  // rename succeeds, `destination` is already complete and self-contained.
  const movedRecovery: Array<{ from: string; to: string }> = [];
  try {
    for (const suffix of [".recovery.enc", ".recovery.enc.pending"]) {
      const sidecar = `${path}${suffix}`;
      const sidecarInfo = await statFile(sidecar).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (sidecarInfo && sidecarInfo.isFile() && !sidecarInfo.isSymbolicLink()) {
        const target = `${destination}${suffix}`;
        await renameFile(sidecar, target);
        movedRecovery.push({ from: sidecar, to: target });
      }
    }
    await renameFile(path, destination);
  } catch (error) {
    for (const entry of movedRecovery.reverse()) {
      await renameFile(entry.to, entry.from).catch(() => undefined);
    }
    throw error;
  }
  // Clean up any leftover 0-byte -wal or -shm files if SQLite left them behind
  // after checkpoint + close; `destination` already holds all committed pages.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    const sidecarInfo = await statFile(sidecar).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (sidecarInfo && sidecarInfo.isFile() && !sidecarInfo.isSymbolicLink()) {
      await renameFile(sidecar, `${destination}${suffix}`).catch((error: NodeJS.ErrnoException) => {
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
  options?: OpenDaemonStateDatabaseOptions,
): Promise<DatabaseSync> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await protectOwnerPrivate(directory, "directory");
  await moveAsideLegacyDaemonStateDatabase(path, options);
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
    options?: OpenDaemonStateDatabaseOptions,
  ): Promise<DaemonStateDatabase> {
    const connection = await openDaemonStateDatabase(path, initializeSchema, options);
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
