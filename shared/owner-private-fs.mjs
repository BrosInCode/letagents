/**
 * Owner-private files and folders, on POSIX and on Windows.
 *
 * Tokens, the approval signing key, the state database and agent homes are
 * kept in files only this account may read or change. On POSIX that is the
 * file's mode and uid: a private file has no group or other bits and belongs
 * to process.getuid(). These helpers keep that exact rule.
 *
 * Windows has no mode bits (Node reports 0o666 for every file) and no uid
 * (stat.uid is 0). There a private folder has:
 *   - an owner that is the current user's SID;
 *   - a protected DACL (inheritance disabled), so a change to a parent
 *     folder's permissions never reaches it;
 *   - allow entries for only the current user and SYSTEM, marked to be
 *     inherited by everything made inside it. Deny entries are accepted,
 *     because they only take access away. Administrators get no entry: an
 *     administrator can take ownership of any file anyway, so an entry adds
 *     nothing for them and only widens what other code running as an
 *     administrator could read without asking.
 * A file or folder made inside a private folder inherits those entries, so it
 * is private from birth, and nothing runs per file (see "verified folders").
 * A path outside any private folder is private only with the same entries
 * and a protected DACL of its own.
 *
 * The Windows facts are read with built-in tools by absolute path:
 * whoami.exe gives the current user's SID; PowerShell's Get-Acl gives each
 * path's security descriptor as SDDL (owner and DACL, written with SIDs, so
 * the answer does not depend on the display language); icacls.exe sets the
 * owner (the current user, also for an elevated administrator) and the
 * protected DACL, and its /save form reads the DACL back right after. Every
 * answer that cannot be read or parsed counts as "not private".
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
export function overrideOwnerPrivatePlatformForTesting(value) { testOverride = value; forgetOwnerPrivateCache(); }
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
    // A tool that cannot start (Node says ENOENT) must never read as "the file is missing".
    child.once("error", error => finish(toolError(file, error)));
    child.once("close", (code) => {
      if (code !== 0) finish(privateError(`${file} exited with code ${code}.`));
      else finish(null, Buffer.concat(out).toString("utf8"));
    });
  });
}

function toolError(file, error) {
  return Object.assign(privateError(`${file} failed: ${error?.message ?? String(error)}`), { cause: error });
}

function runToolSync(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
      timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_OUTPUT_LIMIT, encoding: "utf8",
    });
  } catch (error) { throw toolError(file, error); }
}

/** `whoami /user /fo csv /nh` prints `"machine\name","S-1-5-21-…"`; only the SID is read. */
export function parseWhoamiUserSid(output) {
  return parseWhoamiUser(output).sid;
}

/** The SID, and the account's domain (the machine name for a local account). */
export function parseWhoamiUser(output) {
  const match = /^"([^"\\]*)\\[^"]*","(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/i.exec(String(output).trim())
    ?? /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/i.exec(String(output).trim());
  if (!match) throw privateError("The current Windows account's SID could not be read.");
  return match.length === 3 ? { sid: match[2].toUpperCase(), domain: match[1] } : { sid: match[1].toUpperCase(), domain: null };
}

/**
 * SDDL writes this machine's built-in Administrator (RID 500) as "LA". It
 * names the current user only when that user is that account: a local account
 * (its domain is this computer's name) whose SID ends in -500. A domain
 * account with RID 500 is a different account.
 */
export function userSidAliases(user, computerName) {
  return user.domain && computerName && user.domain.toUpperCase() === String(computerName).toUpperCase()
    && /-500$/.test(user.sid) ? ["LA"] : [];
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

function assertProtectable(path, sid) {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) throw privateError("A private path must be absolute.");
  if (!SID_PATTERN.test(sid)) throw privateError("The current Windows account's SID is invalid.");
}

/**
 * The arguments that make `sid` the owner. An elevated administrator's new
 * files are owned by the Administrators group by default; the account itself
 * may always take ownership of what it may change.
 */
export function icaclsSetOwnerArguments(path, sid) {
  assertProtectable(path, sid);
  return [path, "/setowner", `*${sid}`, "/q"];
}

/**
 * The well-known groups a user profile, the temporary folder or a drive root
 * gives by inheritance. On Windows Server 2022, `/inheritance:r` keeps an
 * object's inherited entries as explicit ones, so they are removed by name.
 * protectOwnerPrivate reads the result back and removes any other entry by
 * its SID, or throws.
 */
export const INHERITED_GROUP_SIDS = Object.freeze([
  "S-1-5-32-544", // Administrators
  "S-1-5-32-545", // Users
  "S-1-5-32-546", // Guests
  "S-1-5-32-547", // Power Users
  "S-1-5-32-555", // Remote Desktop Users
  "S-1-5-11", // Authenticated Users
  "S-1-5-4", // Interactive
  "S-1-5-7", // Anonymous
  "S-1-1-0", // Everyone
  "S-1-3-0", // Creator Owner
  "S-1-3-1", // Creator Group
  "S-1-3-4", // Owner Rights
  "S-1-15-2-1", // All application packages
  "S-1-15-2-2", // All restricted application packages
]);

/** The arguments that remove every allow entry for these SIDs. */
export function icaclsRemoveArguments(path, sids) {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) throw privateError("A private path must be absolute.");
  if (!sids.length || !sids.every(sid => SID_PATTERN.test(sid))) throw privateError("Only SIDs can be removed.");
  return [path, "/remove:g", ...sids.map(sid => `*${sid}`), "/q"];
}

/**
 * The arguments that give a path a protected DACL for only `sid` and SYSTEM:
 * inheritance off, the inherited groups removed, then the two grants.
 */
export function icaclsProtectArguments(path, kind, sid) {
  assertProtectable(path, sid);
  const rights = kind === "directory" ? "(OI)(CI)F" : "F";
  return [path, "/inheritance:r", "/remove:g", ...INHERITED_GROUP_SIDS.map(group => `*${group}`),
    "/grant:r", `*${sid}:${rights}`, `*${SYSTEM_SID}:${rights}`, "/q"];
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
  let aliases = null;
  const remember = (output) => {
    const user = parseWhoamiUser(output);
    aliases = userSidAliases(user, env.COMPUTERNAME);
    return user.sid;
  };
  const environment = paths => ({ ...env, [PATHS_VARIABLE]: JSON.stringify(paths) });
  return {
    async currentUserSid() {
      sid ??= remember(await run(tools.whoami, ["/user", "/fo", "csv", "/nh"], { env }));
      return sid;
    },
    currentUserSidSync() {
      sid ??= remember(runSync(tools.whoami, ["/user", "/fo", "csv", "/nh"], { env }));
      return sid;
    },
    async currentUserAliases() { await this.currentUserSid(); return aliases; },
    currentUserAliasesSync() { this.currentUserSidSync(); return aliases; },
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
      const user = await this.currentUserSid();
      await run(tools.icacls, icaclsSetOwnerArguments(path, user), { env });
      await run(tools.icacls, icaclsProtectArguments(path, kind, user), { env });
    },
    protectSync(path, kind) {
      const user = this.currentUserSidSync();
      runSync(tools.icacls, icaclsSetOwnerArguments(path, user), { env });
      runSync(tools.icacls, icaclsProtectArguments(path, kind, user), { env });
    },
    async removeGrants(path, sids) {
      await run(tools.icacls, icaclsRemoveArguments(path, sids), { env });
    },
    removeGrantsSync(path, sids) {
      runSync(tools.icacls, icaclsRemoveArguments(path, sids), { env });
    },
    // The DACL alone, as SDDL, from `icacls /save` (fast; no owner). Used only
    // to read back a protect, right after /setowner made this account the owner.
    async readDacl(path) {
      const file = aclSaveFile(env);
      try {
        await run(tools.icacls, icaclsSaveArguments(path, file), { env });
        return parseIcaclsSave(await readFile(file));
      } finally { await rm(file, { force: true }).catch(() => undefined); }
    },
    readDaclSync(path) {
      const file = aclSaveFile(env);
      try {
        runSync(tools.icacls, icaclsSaveArguments(path, file), { env });
        return parseIcaclsSave(readFileSync(file));
      } finally { try { rmSync(file, { force: true }); } catch { /* best effort */ } }
    },
  };
}

function aclSaveFile(env) {
  return join(env.TEMP || env.TMP || tmpdir(), `letagents-acl-${randomUUID()}.txt`);
}

export function icaclsSaveArguments(path, file) {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) throw privateError("A private path must be absolute.");
  return [path, "/save", file, "/q"];
}

/**
 * `icacls <path> /save <file>` writes the object's name on one line and its
 * DACL as SDDL ("D:...") on the next, in UTF-16LE. The name line may itself
 * start with a drive ("D:\a\..."), so only a later line is read.
 */
export function parseIcaclsSave(bytes) {
  const buffer = Buffer.from(bytes);
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString("utf16le")
    : buffer.length > 1 && buffer[1] === 0 ? buffer.toString("utf16le") : buffer.toString("utf8");
  const dacl = text.split(/\r?\n/).slice(1).map(line => line.trim()).find(line => /^D:[A-Z_]*(?:\(.*\))*$/.test(line));
  if (!dacl) throw privateError("The saved Windows permissions could not be read.");
  return dacl;
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

/** SDDL aliases of fixed, machine-independent SIDs (domain-relative ones are left out). */
const FIXED_SID_ALIASES = Object.freeze({
  AN: "S-1-5-7", AU: "S-1-5-11", BA: "S-1-5-32-544", BG: "S-1-5-32-546", BO: "S-1-5-32-551", BU: "S-1-5-32-545",
  CG: "S-1-3-1", CO: "S-1-3-0", IU: "S-1-5-4", LS: "S-1-5-19", NS: "S-1-5-20", NU: "S-1-5-2", OW: "S-1-3-4",
  PO: "S-1-5-32-550", PS: "S-1-5-10", PU: "S-1-5-32-547", RC: "S-1-5-12", RD: "S-1-5-32-555", RE: "S-1-5-32-552",
  RU: "S-1-5-32-554", SO: "S-1-5-32-549", SU: "S-1-5-6", WD: "S-1-1-0", WR: "S-1-5-33", AC: "S-1-15-2-1",
  AO: "S-1-5-32-548", NO: "S-1-5-32-556", MU: "S-1-5-32-558", LU: "S-1-5-32-559", ER: "S-1-5-32-573",
  RA: "S-1-5-32-575", HA: "S-1-5-32-578",
});

const DENY_TYPES = new Set(["D", "OD"]);
const ALLOW_TYPES = new Set(["A", "OA"]);

/** `user` is a SID string, or `{ sid, aliases }` where aliases are SDDL aliases that name it ("LA"). */
function who(user) {
  return typeof user === "string" ? { sid: user.toUpperCase(), aliases: [] }
    : { sid: String(user.sid).toUpperCase(), aliases: user.aliases ?? [] };
}

function sidIsUser(sid, user) {
  return sid === user.sid || user.aliases.includes(sid);
}

export function sddlIsOwnedBy(sddl, sid) {
  const owner = parseSddl(sddl)?.owner;
  return Boolean(owner && sidIsUser(owner, who(sid)));
}

/** Owner is `sid`; the DACL is protected; every allow entry is for `sid` or SYSTEM. */
export function sddlIsOwnerPrivate(sddl, sid) {
  return sddlHasPrivateEntries(sddl, sid) && parseSddl(sddl).dacl.flags.includes("P");
}

/**
 * As sddlIsOwnerPrivate, but inheritance may be on: the entries alone are
 * private. Such an object is private only while its parent is (see
 * windowsPathIsPrivate).
 */
export function sddlHasPrivateEntries(sddl, sid) {
  const parsed = parseSddl(sddl);
  const user = who(sid);
  if (!parsed || !sidIsUser(parsed.owner, user) || !parsed.dacl) return false;
  const { flags, aces } = parsed.dacl;
  if (flags.includes("NO_ACCESS_CONTROL")) return false;
  return aces.every(ace => DENY_TYPES.has(ace.type)
    || (ALLOW_TYPES.has(ace.type) && (sidIsUser(ace.sid, user) || ace.sid === "SY" || ace.sid === SYSTEM_SID)));
}

/**
 * The access a new folder in a user profile inherits: owned by the user, and
 * allow entries for only the user, SYSTEM and Administrators (inherited or
 * not). This reads the current DACL only: it cannot show that another account
 * never had access, nor revoke a handle opened while it did (a known Windows
 * limit of making an existing folder private in place).
 */
export function sddlHasProfileDefaultAccess(sddl, sid) {
  const parsed = parseSddl(sddl);
  const user = who(sid);
  if (!parsed || !sidIsUser(parsed.owner, user) || !parsed.dacl || parsed.dacl.flags.includes("NO_ACCESS_CONTROL")) return false;
  return parsed.dacl.aces.every(ace => DENY_TYPES.has(ace.type)
    || (ALLOW_TYPES.has(ace.type) && (sidIsUser(ace.sid, user) || ["SY", SYSTEM_SID, "BA", "S-1-5-32-544"].includes(ace.sid))));
}

/**
 * The SIDs whose allow entries keep a descriptor from being private, when
 * removing them is all it needs; null when something else is wrong (owner,
 * inheritance, an alias that names no fixed SID, an unknown entry type).
 */
export function sddlExtraGrantSids(sddl, sid) {
  const parsed = parseSddl(sddl);
  const user = who(sid);
  if (!parsed?.dacl || !sidIsUser(parsed.owner, user)) return null;
  const { flags, aces } = parsed.dacl;
  if (flags.includes("NO_ACCESS_CONTROL") || !flags.includes("P")) return null;
  const extra = new Set();
  for (const ace of aces) {
    if (DENY_TYPES.has(ace.type) || (ALLOW_TYPES.has(ace.type) && (sidIsUser(ace.sid, user) || ace.sid === "SY" || ace.sid === SYSTEM_SID))) continue;
    if (!ALLOW_TYPES.has(ace.type)) return null;
    const full = SID_PATTERN.test(ace.sid) ? ace.sid : FIXED_SID_ALIASES[ace.sid];
    if (!full) return null;
    extra.add(full);
  }
  return [...extra];
}

// ---------------------------------------------------------------- checks

async function currentUser(security) {
  return { sid: await security.currentUserSid(), aliases: (await security.currentUserAliases?.()) ?? [] };
}

function currentUserSync(security) {
  return { sid: security.currentUserSidSync(), aliases: security.currentUserAliasesSync?.() ?? [] };
}

/**
 * Windows reads permissions by path, not from the caller's open file. So the
 * path must still be the file the caller's stat describes (volume and file
 * index), before and after the read: a file swapped in for the read is refused.
 */
function pathIsInfo(path, info) {
  if (info?.ino === undefined || info?.dev === undefined) return true;
  try {
    const current = lstatSync(path, { bigint: typeof info.ino === "bigint" });
    return current.dev === info.dev && current.ino === info.ino;
  } catch { return false; }
}

function isDirectoryInfo(info) {
  return typeof info?.isDirectory === "function" && info.isDirectory();
}

// ---------------------------------------------------------------- Windows: verified folders
//
// Starting icacls or PowerShell costs tens to hundreds of milliseconds, so it
// must not happen for every file. A private folder (owner: this account; a
// protected DACL for only this account and SYSTEM, inheritable) passes its
// entries to every file and folder made in it. Inside it, only this account,
// SYSTEM and Administrators can make an entry or change one's DACL, and they
// are the principals a POSIX 0600/0700 check also cannot keep out (this
// account and root). So once a folder is verified, nothing below it is read
// again or protected again in this process: a file written there inherits the
// private entries at creation. A folder is verified by reading it (or by this
// process protecting it), and the result is kept for the life of the process.

let verifiedFolders = new WeakMap();

/** Forget every verified folder (tests that change a DACL behind the cache's back). */
export function forgetOwnerPrivateCache() { verifiedFolders = new WeakMap(); }

/** The key of an existing path: its real path (no junctions, long names), lowercased. */
function folderKey(path) {
  let real;
  try { real = realpathSync.native(path); } catch { real = resolve(path); }
  return real.toLowerCase();
}

function rememberPrivateFolder(security, path) {
  let set = verifiedFolders.get(security);
  if (!set) { set = new Set(); verifiedFolders.set(security, set); }
  set.add(folderKey(path));
}

/** Whether `path` (if `self`) or a folder above it was verified private in this process. */
function insideVerifiedFolder(security, path, self) {
  const set = verifiedFolders.get(security);
  if (!set?.size) return false;
  let current = folderKey(path);
  if (self && set.has(current)) return true;
  for (let depth = 0; depth < 256; depth += 1) {
    const parent = dirname(current);
    if (parent === current) return false;
    if (set.has(parent)) return true;
    current = parent;
  }
  return false;
}

/** `path` and every folder above it, nearest first. */
function chainOf(path) {
  const chain = [];
  for (let current = resolve(path); chain.length < 64; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }
  return chain;
}

/**
 * Private when the path's own entries are private and so are those of every
 * folder above it, up to the first one with a protected DACL (inheritance off).
 * The folders on the way are remembered as verified.
 */
function decideChain(security, chain, answers, user, pathIsFolder) {
  for (let index = 0; index < chain.length; index += 1) {
    if (!sddlHasPrivateEntries(answers.get(chain[index]), user)) return false;
    if (parseSddl(answers.get(chain[index])).dacl.flags.includes("P")) {
      for (let folder = pathIsFolder ? 0 : 1; folder <= index; folder += 1) rememberPrivateFolder(security, chain[folder]);
      return true;
    }
  }
  return false;
}

async function readAll(security, paths) {
  const unique = [...new Set(paths)];
  const sddls = await security.readSddl(unique);
  return new Map(unique.map((path, index) => [path, sddls[index]]));
}

function readAllSync(security, paths) {
  const unique = [...new Set(paths)];
  const sddls = security.readSddlSync(unique);
  return new Map(unique.map((path, index) => [path, sddls[index]]));
}

/** Windows: is each entry private? Entries under a verified folder need no read; the rest are read in one call. */
async function windowsEntriesArePrivate(security, entries) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return false;
  const pending = entries.filter(entry => !insideVerifiedFolder(security, entry.path, isDirectoryInfo(entry.info)));
  if (!pending.length) return true;
  const chains = pending.map(entry => chainOf(entry.path));
  const answers = await readAll(security, chains.flat());
  const user = await currentUser(security);
  return pending.every((entry, index) => decideChain(security, chains[index], answers, user, isDirectoryInfo(entry.info)))
    && entries.every(entry => pathIsInfo(entry.path, entry.info));
}

function windowsEntriesArePrivateSync(security, entries) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return false;
  const pending = entries.filter(entry => !insideVerifiedFolder(security, entry.path, isDirectoryInfo(entry.info)));
  if (!pending.length) return true;
  const chains = pending.map(entry => chainOf(entry.path));
  const answers = readAllSync(security, chains.flat());
  const user = currentUserSync(security);
  return pending.every((entry, index) => decideChain(security, chains[index], answers, user, isDirectoryInfo(entry.info)))
    && entries.every(entry => pathIsInfo(entry.path, entry.info));
}

/** Windows: is each entry owned by this account? Under a verified folder that holds (see above). */
async function windowsEntriesAreOwned(security, entries) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return false;
  const pending = entries.filter(entry => !insideVerifiedFolder(security, entry.path, true));
  if (!pending.length) return true;
  const answers = await readAll(security, pending.map(entry => entry.path));
  const user = await currentUser(security);
  return pending.every(entry => sddlIsOwnedBy(answers.get(entry.path), user))
    && entries.every(entry => pathIsInfo(entry.path, entry.info));
}

function windowsEntriesAreOwnedSync(security, entries) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return false;
  const pending = entries.filter(entry => !insideVerifiedFolder(security, entry.path, true));
  if (!pending.length) return true;
  const answers = readAllSync(security, pending.map(entry => entry.path));
  const user = currentUserSync(security);
  return pending.every(entry => sddlIsOwnedBy(answers.get(entry.path), user))
    && entries.every(entry => pathIsInfo(entry.path, entry.info));
}

function posixOwned(info) {
  return info.uid === process.getuid?.();
}

function posixPrivate(info, exactMode) {
  return posixOwned(info) && (exactMode === undefined ? (info.mode & 0o077) === 0 : (info.mode & 0o777) === exactMode);
}

/**
 * Whether `path` (whose lstat/fstat is `info`) belongs to this account. POSIX
 * reads only `info`; Windows reads the owner SID of `path` (nothing to read
 * under a verified private folder).
 */
export async function isOwnedByCurrentUser(path, info, options = {}) {
  if (!isWindows(options)) return posixOwned(info);
  try { return await windowsEntriesAreOwned(windowsSecurity(options), [{ path, info }]); } catch { return false; }
}

export function isOwnedByCurrentUserSync(path, info, options = {}) {
  if (!isWindows(options)) return posixOwned(info);
  try { return windowsEntriesAreOwnedSync(windowsSecurity(options), [{ path, info }]); } catch { return false; }
}

/** Every entry belongs to this account; Windows reads them all in one call. */
export function everyOwnedByCurrentUserSync(entries, options = {}) {
  if (!isWindows(options)) return entries.every(entry => posixOwned(entry.info));
  if (!entries.length) return true;
  try { return windowsEntriesAreOwnedSync(windowsSecurity(options), entries); } catch { return false; }
}

/** Every entry is private to this account; Windows reads them all in one call. */
export function everyOwnerPrivateSync(entries, options = {}) {
  if (!isWindows(options)) return entries.every(entry => posixPrivate(entry.info, options.exactMode));
  if (!entries.length) return true;
  try { return windowsEntriesArePrivateSync(windowsSecurity(options), entries); } catch { return false; }
}

/**
 * Whether `path` is private to this account. POSIX: `info` is this account's
 * and has no group/other bits (or, with `exactMode`, exactly that mode).
 * Windows: under a folder verified in this process, yes; otherwise one read of
 * the path and the folders above it decides (see decideChain).
 */
export async function isOwnerPrivate(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  try { return await windowsEntriesArePrivate(windowsSecurity(options), [{ path, info }]); } catch { return false; }
}

/** Windows only: see sddlHasProfileDefaultAccess. POSIX answers as isOwnerPrivate. */
export async function hasProfileDefaultAccess(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  const security = windowsSecurity(options);
  try {
    if (!pathIsInfo(path, info)) return false;
    if (insideVerifiedFolder(security, path, true)) return true;
    const [sddl] = await security.readSddl([path]);
    return pathIsInfo(path, info) && sddlHasProfileDefaultAccess(sddl, await currentUser(security));
  } catch { return false; }
}

export function isOwnerPrivateSync(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  try { return windowsEntriesArePrivateSync(windowsSecurity(options), [{ path, info }]); } catch { return false; }
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

function notProtected(path) {
  return privateError(`Could not make ${path} private to this account: other entries remain in its permissions.`);
}

/**
 * POSIX: chmod 0700/0600. Windows: under a folder verified private in this
 * process there is nothing to do (the path inherits the private entries, and
 * no tool runs on a file that may be open, such as a SQLite database). Else
 * a protected DACL for this account and SYSTEM, read back afterwards: an
 * entry the protect call left behind (a domain group a profile inherits, say)
 * is removed by SID; if the result is still not private, this throws, as a
 * failed chmod would. A protected folder is then verified for the process.
 * `force` (a repair after a check found the path not private) always runs it.
 */
export async function protectOwnerPrivate(path, kind, options = {}) {
  if (!isWindows(options)) return chmod(path, kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
  // A missing path fails with ENOENT, as chmod does, so callers that skip a missing file still can.
  // Every later failure is EOWNERPRIVATE: a tool's own ENOENT must never read as "the file is missing".
  await lstat(path);
  const security = windowsSecurity(options);
  if (!options.force && insideVerifiedFolder(security, path, kind === "directory")) return;
  try { await protectWindowsPath(security, path, kind); }
  catch (error) { throw error?.code === "EOWNERPRIVATE" ? error : toolError("protect", error); }
  if (kind === "directory") rememberPrivateFolder(security, path);
}

/** The DACL after a protect; owner is this account (icacls /setowner just succeeded). */
async function readBack(security, path, user) {
  if (security.readDacl) return `O:${user.sid}${await security.readDacl(path)}`;
  return (await security.readSddl([path]))[0];
}

function readBackSync(security, path, user) {
  if (security.readDaclSync) return `O:${user.sid}${security.readDaclSync(path)}`;
  return security.readSddlSync([path])[0];
}

async function protectWindowsPath(security, path, kind) {
  await security.protect(path, kind);
  const user = await currentUser(security);
  let sddl = await readBack(security, path, user);
  if (sddlIsOwnerPrivate(sddl, user)) return;
  const extra = sddlExtraGrantSids(sddl, user);
  if (!extra?.length || !security.removeGrants) throw notProtected(path);
  await security.removeGrants(path, extra);
  sddl = await readBack(security, path, user);
  if (!sddlIsOwnerPrivate(sddl, user)) throw notProtected(path);
}

export function protectOwnerPrivateSync(path, kind, options = {}) {
  if (!isWindows(options)) return chmodSync(path, kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
  lstatSync(path);
  const security = windowsSecurity(options);
  if (!options.force && insideVerifiedFolder(security, path, kind === "directory")) return;
  try { protectWindowsPathSync(security, path, kind); }
  catch (error) { throw error?.code === "EOWNERPRIVATE" ? error : toolError("protect", error); }
  if (kind === "directory") rememberPrivateFolder(security, path);
}

function protectWindowsPathSync(security, path, kind) {
  security.protectSync(path, kind);
  const user = currentUserSync(security);
  let sddl = readBackSync(security, path, user);
  if (sddlIsOwnerPrivate(sddl, user)) return;
  const extra = sddlExtraGrantSids(sddl, user);
  if (!extra?.length || !security.removeGrantsSync) throw notProtected(path);
  security.removeGrantsSync(path, extra);
  sddl = readBackSync(security, path, user);
  if (!sddlIsOwnerPrivate(sddl, user)) throw notProtected(path);
}

/**
 * `path` and its missing ancestors, nearest the root first. It stops at the
 * first folder that exists, so an existing folder is never changed.
 */
function missingFolders(path) {
  const missing = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { lstatSync(current); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    missing.unshift(current);
    if (dirname(current) === current) break;
  }
  return missing;
}

function existingFolder(folder, error) {
  if (error.code !== "EEXIST") throw error;
  const info = lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw error;
}

/** As recursive mkdir: a target that already exists must be a folder. */
function assertFolder(path) {
  const info = lstatSync(path);
  if (!info.isDirectory()) throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: "EEXIST", path });
}

/**
 * mkdir with mode 0700, exactly as on POSIX today (an existing folder is left
 * as it is). On Windows a recursive call makes the missing folders one at a
 * time and gives the private DACL only to each folder this call made; a
 * folder another process made in the meantime is left alone. (Node's
 * recursive mkdir reports only the first folder it made, and on Windows may
 * spell it another way, such as a short 8.3 name.)
 */
export async function createPrivateDir(path, { recursive = false } = {}, options = {}) {
  if (!isWindows(options)) return mkdir(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  if (!recursive) {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    await protectOwnerPrivate(resolve(path), "directory", options);
    return undefined;
  }
  let first;
  for (const folder of missingFolders(path)) {
    try { await mkdir(folder, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { existingFolder(folder, error); continue; }
    first ??= folder;
    await protectOwnerPrivate(folder, "directory", options);
  }
  assertFolder(path);
  return first;
}

export function createPrivateDirSync(path, { recursive = false } = {}, options = {}) {
  if (!isWindows(options)) return mkdirSync(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  if (!recursive) {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    protectOwnerPrivateSync(resolve(path), "directory", options);
    return undefined;
  }
  let first;
  for (const folder of missingFolders(path)) {
    try { mkdirSync(folder, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { existingFolder(folder, error); continue; }
    first ??= folder;
    protectOwnerPrivateSync(folder, "directory", options);
  }
  assertFolder(path);
  return first;
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
 * Windows: a new folder beside `path`, made private before anything is put in
 * it. A file made inside it inherits only the private entries, so no other
 * account can open it in the moment before its own DACL is set (a handle
 * opened then would keep its access after the DACL changes).
 */
export async function createPrivateStagingFolder(path, options = {}) {
  const folder = await mkdtemp(join(dirname(path), `.${pathName(path)}.letagents-`));
  try { await protectOwnerPrivate(folder, "directory", options); }
  catch (error) { await rm(folder, { recursive: true, force: true }).catch(() => undefined); throw error; }
  return folder;
}

function privateStagingFolderSync(path, options) {
  const folder = mkdtempSync(join(dirname(path), `.${pathName(path)}.letagents-`));
  try { protectOwnerPrivateSync(folder, "directory", options); }
  catch (error) { try { rmSync(folder, { recursive: true, force: true }); } catch { /* already failing */ } throw error; }
  return folder;
}

/** Windows: whether the folder `path` is written in is private, so a new file there is private from birth. */
async function folderIsPrivate(path, options) {
  const folder = dirname(resolve(path));
  const info = await lstat(folder).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink() && await isOwnerPrivate(folder, info, options));
}

function folderIsPrivateSync(path, options) {
  const folder = dirname(resolve(path));
  let info = null;
  try { info = lstatSync(folder); } catch { return false; }
  return info.isDirectory() && !info.isSymbolicLink() && isOwnerPrivateSync(folder, info, options);
}

/**
 * Write `data` to `path` so a reader sees the old file or the whole new one,
 * never a part: a private temporary file beside it, fsync, rename, then fsync
 * the folder. POSIX creates it 0600 in one step. On Windows, in a private
 * folder the temporary file inherits the private entries at creation (no tool
 * runs); in any other folder it is made inside a new private staging folder
 * and gets a protected DACL of its own before any byte is written, so it stays
 * private after the rename out of that folder. Renames have the bounded
 * retry.
 */
export async function writePrivateFileAtomically(path, data, options = {}) {
  const staging = isWindows(options) && !await folderIsPrivate(path, options) ? await createPrivateStagingFolder(path, options) : null;
  const temporary = staging ? join(staging, "data") : join(dirname(path), `.${randomUUID()}.${pathName(path)}.tmp`);
  try {
    const handle = await openNoFollow(temporary, EXCLUSIVE_WRITE, PRIVATE_FILE_MODE, options);
    let closed = false;
    try {
      // The file leaves the staging folder, so it needs a protected DACL of its own.
      if (staging) await protectOwnerPrivate(temporary, "file", { ...options, force: true });
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
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function writePrivateFileAtomicallySync(path, data, options = {}) {
  const staging = isWindows(options) && !folderIsPrivateSync(path, options) ? privateStagingFolderSync(path, options) : null;
  const temporary = staging ? join(staging, "data") : join(dirname(path), `.${randomUUID()}.${pathName(path)}.tmp`);
  try {
    const descriptor = openNoFollowSync(temporary, EXCLUSIVE_WRITE, PRIVATE_FILE_MODE, options);
    let closed = false;
    try {
      if (staging) protectOwnerPrivateSync(temporary, "file", { ...options, force: true });
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
  } finally {
    if (staging) { try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

function pathName(path) {
  return resolve(path).split(/[\\/]/).pop();
}

/** The null device for a child process: `/dev/null`, or `\\.\nul` on Windows (as os.devNull there). */
export function nullDevice(options = {}) {
  return isWindows(options) ? "\\\\.\\nul" : "/dev/null";
}
