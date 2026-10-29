/**
 * Owner-private files and folders, on POSIX and on Windows.
 *
 * Tokens, the approval signing key, the state database and agent homes are
 * kept in files only this account may read or change. On POSIX that is the
 * file's mode and uid: a private file has no group or other bits and belongs
 * to process.getuid(). These helpers keep that exact rule.
 *
 * Windows has no mode bits (Node reports 0o666 for every file) and no uid
 * (stat.uid is 0). There a private file has:
 *   - an owner that is the current user's SID;
 *   - a protected DACL (inheritance disabled), so a change to a parent
 *     folder's permissions never reaches it;
 *   - allow entries for only the current user and SYSTEM. Deny entries are
 *     accepted, because they only take access away. Administrators get no
 *     entry: an administrator can take ownership of any file anyway, so an
 *     entry adds nothing for them and only widens what other code running
 *     as an administrator could read without asking.
 * A private folder has the same entries, marked to be inherited by the files
 * and folders made inside it, so a file written there is private from birth.
 *
 * The Windows facts are read with built-in tools by absolute path:
 * whoami.exe gives the current user's SID; PowerShell's Get-Acl gives each
 * path's security descriptor as SDDL (owner and DACL, written with SIDs, so
 * the answer does not depend on the display language); icacls.exe sets the
 * protected DACL. icacls is not used to read, because it cannot show the
 * owner. Every answer that cannot be read or parsed counts as "not private".
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { renameSyncWithRetry, renameWithRetryAsync } from "./rename-retry.mjs";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const SYSTEM_SID = "S-1-5-18";
const SID_PATTERN = /^S-1-[0-9]+(?:-[0-9]+)+$/;
/** Paths are passed to PowerShell in one environment variable; Windows caps a value at 32,767 characters. */
const PATHS_PER_CALL_CHARACTERS = 24_000;
const TOOL_TIMEOUT_MS = 30_000;
const TOOL_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PATHS_VARIABLE = "LETAGENTS_OWNER_PRIVATE_PATHS";
// One line per path, in order: "ok:<SDDL>" or "error:". The paths arrive in an
// environment variable, never in the command text, so no path is parsed as code.
const READ_SDDL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$paths = @(ConvertFrom-Json $env:${PATHS_VARIABLE})`,
  "foreach ($p in $paths) { try { 'ok:' + (Get-Acl -LiteralPath $p).Sddl } catch { 'error:' } }",
].join("; ");

let testOverride = null;
/**
 * Tests only: use this platform and WindowsSecurity wherever a call passes no
 * options, so a caller's Windows branch can run on a macOS or Linux host.
 * Pass null to restore the real ones.
 */
export function overrideOwnerPrivatePlatformForTesting(value) { testOverride = value; }
/** process.platform, or the test override. Callers branch on this, not on process.platform. */
export function ownerPrivatePlatform(options) { return options?.platform ?? testOverride?.platform ?? process.platform; }
const isWindows = (options) => ownerPrivatePlatform(options) === "win32";

function privateError(message, code = "EOWNERPRIVATE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------- Windows tools

/** `%SystemRoot%\System32\<name>`, never a bare name: a bare name is searched in the current folder first. */
export function windowsSystemTool(name, env = process.env) {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir]
    .find(value => typeof value === "string" && /^[A-Za-z]:\\[^"<>|?*\r\n]*$/.test(value)) ?? "C:\\Windows";
  return win32.join(root, "System32", name);
}

export function windowsToolPaths(env = process.env) {
  return {
    whoami: windowsSystemTool("whoami.exe", env),
    icacls: windowsSystemTool("icacls.exe", env),
    powershell: windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe", env),
  };
}

function runTool(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    const out = []; let size = 0; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => { child.kill(); finish(privateError(`${file} did not answer in time.`)); }, TOOL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > TOOL_OUTPUT_LIMIT) { child.kill(); finish(privateError(`${file} wrote too much output.`)); return; }
      out.push(chunk);
    });
    child.stderr.resume();
    child.once("error", error => finish(error));
    child.once("close", (code) => {
      if (code !== 0) finish(privateError(`${file} exited with code ${code}.`));
      else finish(null, Buffer.concat(out).toString("utf8"));
    });
  });
}

function runToolSync(file, args, options = {}) {
  return execFileSync(file, args, {
    env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_OUTPUT_LIMIT, encoding: "utf8",
  });
}

/** `whoami /user /fo csv /nh` prints `"machine\name","S-1-5-21-…"`; only the SID is read. */
export function parseWhoamiUserSid(output) {
  const match = /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/i.exec(String(output).trim());
  if (!match) throw privateError("The current Windows account's SID could not be read.");
  return match[1].toUpperCase();
}

function chunkPaths(paths) {
  const chunks = []; let current = []; let length = 2;
  for (const path of paths) {
    const cost = JSON.stringify(path).length + 1;
    if (current.length && length + cost > PATHS_PER_CALL_CHARACTERS) { chunks.push(current); current = []; length = 2; }
    current.push(path); length += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** The SDDL per path from the PowerShell script's lines; null where Get-Acl failed. */
export function parseSddlLines(output, count) {
  const lines = String(output).split(/\r?\n/).filter(line => line.startsWith("ok:") || line === "error:");
  if (lines.length !== count) throw privateError("The Windows permissions answer did not match the paths asked.");
  return lines.map(line => (line.startsWith("ok:") ? line.slice(3).trim() || null : null));
}

/** The arguments that give a path a protected DACL for only `sid` and SYSTEM. */
export function icaclsProtectArguments(path, kind, sid) {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) throw privateError("A private path must be absolute.");
  if (!SID_PATTERN.test(sid)) throw privateError("The current Windows account's SID is invalid.");
  const rights = kind === "directory" ? "(OI)(CI)F" : "F";
  return [path, "/inheritance:r", "/grant:r", `*${sid}:${rights}`, `*${SYSTEM_SID}:${rights}`, "/q"];
}

function powershellArguments() {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_SDDL_SCRIPT];
}

/**
 * The Windows facts, from injectable runners. A native helper may replace
 * this object later; it only needs these six methods.
 */
export function createWindowsSecurity({ run = runTool, runSync = runToolSync, env = process.env } = {}) {
  const tools = windowsToolPaths(env);
  let sid = null;
  const environment = paths => ({ ...env, [PATHS_VARIABLE]: JSON.stringify(paths) });
  return {
    async currentUserSid() {
      sid ??= parseWhoamiUserSid(await run(tools.whoami, ["/user", "/fo", "csv", "/nh"], { env }));
      return sid;
    },
    currentUserSidSync() {
      sid ??= parseWhoamiUserSid(runSync(tools.whoami, ["/user", "/fo", "csv", "/nh"], { env }));
      return sid;
    },
    async readSddl(paths) {
      const result = [];
      for (const chunk of chunkPaths(paths)) {
        result.push(...parseSddlLines(await run(tools.powershell, powershellArguments(), { env: environment(chunk) }), chunk.length));
      }
      return result;
    },
    readSddlSync(paths) {
      const result = [];
      for (const chunk of chunkPaths(paths)) {
        result.push(...parseSddlLines(runSync(tools.powershell, powershellArguments(), { env: environment(chunk) }), chunk.length));
      }
      return result;
    },
    async protect(path, kind) {
      await run(tools.icacls, icaclsProtectArguments(path, kind, await this.currentUserSid()), { env });
    },
    protectSync(path, kind) {
      runSync(tools.icacls, icaclsProtectArguments(path, kind, this.currentUserSidSync()), { env });
    },
  };
}

let defaultWindowsSecurity = null;
function windowsSecurity(options) {
  if (options?.windowsSecurity) return options.windowsSecurity;
  if (testOverride?.windowsSecurity) return testOverride.windowsSecurity;
  defaultWindowsSecurity ??= createWindowsSecurity();
  return defaultWindowsSecurity;
}

// ---------------------------------------------------------------- SDDL

function readSid(text, index) {
  const match = /^(S-1-[0-9]+(?:-[0-9]+)+|[A-Z]{2})/.exec(text.slice(index));
  return match ? match[1] : null;
}

/**
 * The owner and DACL of an SDDL string, or null when it is not in the plain
 * form Get-Acl writes. Anything unexpected (a conditional entry, an unknown
 * section) returns null, and null means "not private".
 */
export function parseSddl(sddl) {
  if (typeof sddl !== "string") return null;
  let index = 0; let owner = null; let dacl = null;
  while (index < sddl.length) {
    const section = sddl.slice(index, index + 2);
    index += 2;
    if (section === "O:" || section === "G:") {
      const sid = readSid(sddl, index);
      if (!sid) return null;
      if (section === "O:") owner = sid.toUpperCase();
      index += sid.length;
    } else if (section === "D:" || section === "S:") {
      const flags = /^[A-Z_]*/.exec(sddl.slice(index))[0];
      index += flags.length;
      const aces = [];
      while (sddl[index] === "(") {
        const end = sddl.indexOf(")", index);
        if (end < 0) return null;
        const body = sddl.slice(index + 1, end);
        if (body.includes("(")) return null;
        const fields = body.split(";");
        if (fields.length < 6) return null;
        aces.push({ type: fields[0], flags: fields[1], rights: fields[2], sid: fields[5].toUpperCase() });
        index = end + 1;
      }
      if (section === "D:") dacl = { flags, aces };
    } else return null;
  }
  return owner ? { owner, dacl } : null;
}

const DENY_TYPES = new Set(["D", "OD"]);
const ALLOW_TYPES = new Set(["A", "OA"]);

export function sddlIsOwnedBy(sddl, sid) {
  return parseSddl(sddl)?.owner === String(sid).toUpperCase();
}

/** Owner is `sid`; the DACL is protected; every allow entry is for `sid` or SYSTEM. */
export function sddlIsOwnerPrivate(sddl, sid) {
  const parsed = parseSddl(sddl);
  const user = String(sid).toUpperCase();
  if (!parsed || parsed.owner !== user || !parsed.dacl) return false;
  const { flags, aces } = parsed.dacl;
  if (flags.includes("NO_ACCESS_CONTROL") || !flags.includes("P")) return false;
  return aces.every(ace => DENY_TYPES.has(ace.type)
    || (ALLOW_TYPES.has(ace.type) && (ace.sid === user || ace.sid === "SY" || ace.sid === SYSTEM_SID)));
}

// ---------------------------------------------------------------- checks

function posixOwned(info) {
  return info.uid === process.getuid?.();
}

function posixPrivate(info, exactMode) {
  return posixOwned(info) && (exactMode === undefined ? (info.mode & 0o077) === 0 : (info.mode & 0o777) === exactMode);
}

/**
 * Whether `path` (whose lstat/fstat is `info`) belongs to this account. POSIX
 * reads only `info`; Windows reads the owner SID of `path`.
 */
export async function isOwnedByCurrentUser(path, info, options = {}) {
  if (!isWindows(options)) return posixOwned(info);
  const security = windowsSecurity(options);
  try {
    const [sddl] = await security.readSddl([path]);
    return sddlIsOwnedBy(sddl, await security.currentUserSid());
  } catch { return false; }
}

export function isOwnedByCurrentUserSync(path, info, options = {}) {
  if (!isWindows(options)) return posixOwned(info);
  const security = windowsSecurity(options);
  try {
    const [sddl] = security.readSddlSync([path]);
    return sddlIsOwnedBy(sddl, security.currentUserSidSync());
  } catch { return false; }
}

/** Every entry belongs to this account; Windows reads them all in one call. */
export function everyOwnedByCurrentUserSync(entries, options = {}) {
  if (!isWindows(options)) return entries.every(entry => posixOwned(entry.info));
  if (!entries.length) return true;
  const security = windowsSecurity(options);
  try {
    const sid = security.currentUserSidSync();
    return security.readSddlSync(entries.map(entry => entry.path)).every(sddl => sddlIsOwnedBy(sddl, sid));
  } catch { return false; }
}

/**
 * Whether `path` is private to this account. POSIX: `info` is this account's
 * and has no group/other bits (or, with `exactMode`, exactly that mode).
 * Windows: the owner, protected DACL and entries described at the top.
 */
export async function isOwnerPrivate(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  const security = windowsSecurity(options);
  try {
    const [sddl] = await security.readSddl([path]);
    return sddlIsOwnerPrivate(sddl, await security.currentUserSid());
  } catch { return false; }
}

export function isOwnerPrivateSync(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  const security = windowsSecurity(options);
  try {
    const [sddl] = security.readSddlSync([path]);
    return sddlIsOwnerPrivate(sddl, security.currentUserSidSync());
  } catch { return false; }
}

function kindMatches(info, kind) {
  return !info.isSymbolicLink() && (kind === "directory" ? info.isDirectory() : info.isFile());
}

/** Throws unless `path` is a real file or folder (not a link) that is private to this account. */
export async function assertOwnerPrivate(path, options = {}) {
  const kind = options.kind ?? "file";
  const info = await lstat(path);
  if (!kindMatches(info, kind) || !await isOwnerPrivate(path, info, options)) {
    throw privateError(`${kind === "directory" ? "Folder" : "File"} is not private to this account: ${path}`);
  }
  return info;
}

export function assertOwnerPrivateSync(path, options = {}) {
  const kind = options.kind ?? "file";
  const info = lstatSync(path);
  if (!kindMatches(info, kind) || !isOwnerPrivateSync(path, info, options)) {
    throw privateError(`${kind === "directory" ? "Folder" : "File"} is not private to this account: ${path}`);
  }
  return info;
}

// ---------------------------------------------------------------- making private paths

/** POSIX: chmod 0700/0600. Windows: a protected DACL for this account and SYSTEM. */
export async function protectOwnerPrivate(path, kind, options = {}) {
  if (!isWindows(options)) return chmod(path, kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
  // A missing path fails with ENOENT, as chmod does, so callers that skip a missing file still can.
  await lstat(path);
  await windowsSecurity(options).protect(path, kind);
}

export function protectOwnerPrivateSync(path, kind, options = {}) {
  if (!isWindows(options)) return chmodSync(path, kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
  lstatSync(path);
  windowsSecurity(options).protectSync(path, kind);
}

/** The folders a recursive mkdir made: from the first one it made down to `path`. */
function madeFolders(first, path) {
  const folders = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    folders.unshift(current);
    if (current === resolve(first) || dirname(current) === current) break;
  }
  return folders;
}

/**
 * mkdir with mode 0700, exactly as on POSIX today (an existing folder is left
 * as it is). On Windows each folder it makes gets the private DACL.
 */
export async function createPrivateDir(path, { recursive = false } = {}, options = {}) {
  const made = await mkdir(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  if (isWindows(options)) {
    const folders = recursive ? (made === undefined ? [] : madeFolders(made, path)) : [resolve(path)];
    for (const folder of folders) await protectOwnerPrivate(folder, "directory", options);
  }
  return made;
}

export function createPrivateDirSync(path, { recursive = false } = {}, options = {}) {
  const made = mkdirSync(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  if (isWindows(options)) {
    const folders = recursive ? (made === undefined ? [] : madeFolders(made, path)) : [resolve(path)];
    for (const folder of folders) protectOwnerPrivateSync(folder, "directory", options);
  }
  return made;
}

/** fsync a folder so a rename in it is durable. Windows cannot fsync a folder handle; NTFS journals the rename. */
export async function syncDirectory(path, options = {}) {
  if (isWindows(options)) return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export function syncDirectorySync(path, options = {}) {
  if (isWindows(options)) return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function linkError(path) {
  return privateError(`Refusing to follow a link at ${path}.`, "ELOOP");
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * open() that never follows a final link. POSIX adds O_NOFOLLOW, as today.
 * Windows has no O_NOFOLLOW (Node's constant is undefined), so the path is
 * lstat-ed before the open (a link or junction is refused) and after it, and
 * the open handle must be that same file (volume and file index). A link
 * swapped in during the open is detected; the open itself cannot be stopped.
 */
export async function openNoFollow(path, flags, mode, options = {}) {
  if (!isWindows(options)) return open(path, flags | constants.O_NOFOLLOW, mode);
  const before = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (before?.isSymbolicLink()) throw linkError(path);
  const handle = await open(path, flags, mode);
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (after.isSymbolicLink() || !sameFile(opened, after) || (before && !sameFile(before, after))) throw linkError(path);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function openNoFollowSync(path, flags, mode, options = {}) {
  if (!isWindows(options)) return openSync(path, flags | constants.O_NOFOLLOW, mode);
  let before = null;
  try { before = lstatSync(path, { bigint: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (before?.isSymbolicLink()) throw linkError(path);
  const descriptor = openSync(path, flags, mode);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || !sameFile(opened, after) || (before && !sameFile(before, after))) throw linkError(path);
    return descriptor;
  } catch (error) {
    try { closeSync(descriptor); } catch { /* already failing */ }
    throw error;
  }
}

const EXCLUSIVE_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

/**
 * Write `data` to `path` so a reader sees the old file or the whole new one,
 * never a part: a private temporary file beside it, fsync, rename, then fsync
 * the folder. On Windows the temporary file gets the private DACL before any
 * byte is written, and the rename has the bounded retry.
 */
export async function writePrivateFileAtomically(path, data, options = {}) {
  const temporary = join(dirname(path), `.${randomUUID()}.${pathName(path)}.tmp`);
  const handle = await openNoFollow(temporary, EXCLUSIVE_WRITE, PRIVATE_FILE_MODE, options);
  let closed = false;
  try {
    if (isWindows(options)) await protectOwnerPrivate(temporary, "file", options);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    closed = true;
    await renameWithRetryAsync(temporary, path, { platform: ownerPrivatePlatform(options) });
    if (options.syncDirectory !== false) await syncDirectory(dirname(path), options);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function writePrivateFileAtomicallySync(path, data, options = {}) {
  const temporary = join(dirname(path), `.${randomUUID()}.${pathName(path)}.tmp`);
  const descriptor = openNoFollowSync(temporary, EXCLUSIVE_WRITE, PRIVATE_FILE_MODE, options);
  let closed = false;
  try {
    if (isWindows(options)) protectOwnerPrivateSync(temporary, "file", options);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    for (let offset = 0; offset < bytes.length;) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
    renameSyncWithRetry(temporary, path, { platform: ownerPrivatePlatform(options) });
    if (options.syncDirectory !== false) syncDirectorySync(dirname(path), options);
  } catch (error) {
    if (!closed) { try { closeSync(descriptor); } catch { /* already failing */ } }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function pathName(path) {
  return resolve(path).split(/[\\/]/).pop();
}

/** The null device for a child process: `/dev/null`, or `\\.\nul` on Windows (as os.devNull there). */
export function nullDevice(options = {}) {
  return isWindows(options) ? "\\\\.\\nul" : "/dev/null";
}
