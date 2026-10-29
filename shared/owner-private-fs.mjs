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
 * protected DACL, and Get-Acl reads the result back (owner included). Every
 * answer that cannot be read or parsed counts as "not private".
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { renameSyncWithRetry, renameWithRetryAsync } from "./rename-retry.mjs";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const SYSTEM_SID = "S-1-5-18";
const SID_PATTERN = /^S-1-[0-9]+(?:-[0-9]+)+$/;
/** Paths are passed to PowerShell in one environment variable; Windows caps a value at 32,767 characters. */
const PATHS_PER_CALL_CHARACTERS = 24_000;
const TOOL_TIMEOUT_MS = 30_000;
const TOOL_OUTPUT_LIMIT = 16 * 1024 * 1024;
/** The largest secret file read through a handle (its bytes come back in base64). */
const OBJECT_LIMIT = 8 * 1024 * 1024;
const PATHS_VARIABLE = "LETAGENTS_OWNER_PRIVATE_PATHS";
// One line per path, in order: "ok:<SDDL>" or "error:". The paths arrive in an
// environment variable, one per line (a Windows path cannot hold a line
// break), never in the command text, so no path is parsed as code. (Not JSON:
// Windows PowerShell 5.1 does not unroll the array ConvertFrom-Json returns.)
//
// Two requests act on one open handle instead of the path, so a folder above
// the file renamed meanwhile cannot make the answer describe another file:
//   "object:<path>"  the owner and DACL of the handle, and the file's bytes
//                    read through it: "ok:<SDDL>|<base64>";
//   "upgrade:<path>" if the handle's owner is this account or Administrators
//                    and only this account, SYSTEM and Administrators are
//                    allowed in (plain allow and deny entries only), make it
//                    this account's with a protected DACL
//                    for only this account and SYSTEM, through that handle:
//                    "ok:<new SDDL>"; anything else is "error:".
const ANSWER_FUNCTION = [
  "function LetAgentsAnswer([string]$p) {",
  "  try {",
  "    if ($p.StartsWith('object:')) {",
  "      $fs = [System.IO.File]::Open($p.Substring(7), 'Open', 'Read', 'ReadWrite, Delete')",
  "      try {",
  // The length is read once: a file that grows meanwhile fails the end-of-file check below.
  `        $length = $fs.Length; if ($length -gt ${OBJECT_LIMIT}) { return 'error:' }`,
  "        $sddl = $fs.GetAccessControl().GetSecurityDescriptorSddlForm('Owner, Access')",
  "        $bytes = New-Object byte[] $length; $read = 0",
  "        while ($read -lt $bytes.Length) { $n = $fs.Read($bytes, $read, $bytes.Length - $read); if ($n -le 0) { break }; $read += $n }",
  "        if ($read -ne $bytes.Length -or $fs.ReadByte() -ne -1) { return 'error:' }",
  "        return 'ok:' + $sddl + '|' + [Convert]::ToBase64String($bytes)",
  "      } finally { $fs.Dispose() }",
  "    }",
  "    if ($p.StartsWith('upgrade:')) {",
  "      $rights = [System.Security.AccessControl.FileSystemRights]'ReadData, ReadPermissions, ChangePermissions, TakeOwnership'",
  "      $fs = New-Object System.IO.FileStream($p.Substring(8), [System.IO.FileMode]::Open, $rights, [System.IO.FileShare]'ReadWrite, Delete', 4096, [System.IO.FileOptions]::None)",
  "      try {",
  "        $sid = [System.Security.Principal.SecurityIdentifier]; $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "        $allowed = @($me.Value, 'S-1-5-18', 'S-1-5-32-544'); $acl = $fs.GetAccessControl()",
  "        $owner = $acl.GetOwner($sid).Value",
  "        if ($owner -ne $me.Value -and $owner -ne 'S-1-5-32-544') { return 'error:' }",
  // GetAccessRules leaves out entries it cannot express (a conditional allow, say): only plain allow and deny pass.
  "        if (([regex]::Matches($acl.GetSecurityDescriptorSddlForm('Access'), '\\(([A-Z]+);') | Where-Object { $_.Groups[1].Value -ne 'A' -and $_.Groups[1].Value -ne 'D' }).Count -gt 0) { return 'error:' }",
  "        foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) { if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { return 'error:' } }",
  "        $new = New-Object System.Security.AccessControl.FileSecurity",
  "        $new.SetOwner($me); $new.SetAccessRuleProtection($true, $false)",
  "        $new.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))",
  "        $new.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'), 'FullControl', 'Allow')))",
  "        $fs.SetAccessControl($new)",
  "        return 'ok:' + $fs.GetAccessControl().GetSecurityDescriptorSddlForm('Owner, Access')",
  "      } finally { $fs.Dispose() }",
  "    }",
  "    return 'ok:' + (Get-Acl -LiteralPath $p).Sddl",
  "  } catch { return 'error:' }",
  "}",
].join("\n");

const READ_SDDL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  ANSWER_FUNCTION,
  `$paths = $env:${PATHS_VARIABLE} -split "\`n"`,
  "foreach ($p in $paths) { LetAgentsAnswer $p }",
].join("; ");

/** The environment value that carries `paths` to the PowerShell script. */
export function encodeSddlPaths(paths) {
  if (paths.some(path => /[\r\n]/.test(path))) throw privateError("A path cannot hold a line break.");
  return paths.join("\n");
}

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

/**
 * A tool runs in its own folder: Windows locks a process's current folder, so
 * a tool started in the caller's current folder (a temporary folder, say)
 * would keep it from being deleted while it runs.
 */
function toolFolder(file) {
  return isAbsolute(file) ? dirname(file) : win32.isAbsolute(file) ? win32.dirname(file) : undefined;
}

function runTool(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? process.env, cwd: toolFolder(file), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
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
      env: options.env ?? process.env, cwd: toolFolder(file), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
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
    const cost = path.length + 1;
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

// Starting PowerShell costs about half a second, so asynchronous reads go to
// one long-lived PowerShell per process: a path per line in, "ok:<SDDL>" or
// "error:" per line out, and an empty line ends a request ("done:"). Only
// printable ASCII paths go this way (no code-page guessing); any other path,
// and a reader that fails, stops or does not answer, use the one-shot script
// above, which reads the paths from the environment. Synchronous reads have a
// reader of their own (see createSyncSddlServer).
const SERVER_SCRIPT = "$ErrorActionPreference = 'Continue'; " + ANSWER_FUNCTION + "\nwhile ($true) { $line = [Console]::In.ReadLine(); "
  + "if ($null -eq $line) { break }; if ($line -eq '') { [Console]::Out.WriteLine('done:'); [Console]::Out.Flush(); continue }; "
  + "[Console]::Out.WriteLine((LetAgentsAnswer $line)) }";

const SERVER_ARGUMENTS = Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SERVER_SCRIPT]);

function startSddlServer(powershell, env) {
  return spawn(powershell, SERVER_ARGUMENTS, {
    env, cwd: toolFolder(powershell), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
  });
}

const SERVER_PATH = /^[\x20-\x7e]+$/;

/** An "object:" answer: `<SDDL>|<base64 bytes>`, or null. */
export function parseObjectAnswer(answer) {
  if (typeof answer !== "string") return null;
  const bar = answer.indexOf("|");
  if (bar <= 0 || !/^[A-Za-z0-9+/=]*$/.test(answer.slice(bar + 1))) return null;
  return { sddl: answer.slice(0, bar), data: Buffer.from(answer.slice(bar + 1), "base64") };
}

/** One long-lived reader; `start` returns a child process (injectable for tests). */
export function createSddlServer(start) {
  let child = null;
  let broken = false;
  let buffer = "";
  const lines = [];
  let wake = null;
  let queue = Promise.resolve();
  const stopReader = () => { broken = true; try { child?.kill(); } catch { /* already gone */ } child = null; wake?.(); };
  function reader() {
    if (child) return child;
    child = start();
    // The reader must never keep the process alive on its own.
    child.unref?.();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
    child.stderr?.resume();
    child.stdin.on("error", stopReader);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
      // No answer line is longer than a capped object in base64: a reader that writes more is stopped.
      if (buffer.length > TOOL_OUTPUT_LIMIT) stopReader();
      wake?.();
    });
    child.once("error", stopReader);
    child.once("exit", stopReader);
    return child;
  }
  async function request(paths) {
    if (broken) throw privateError("The permissions reader is not available.");
    reader().stdin.write(`${paths.join("\n")}\n\n`);
    const deadline = Date.now() + TOOL_TIMEOUT_MS;
    for (;;) {
      const done = lines.indexOf("done:");
      if (done >= 0) return parseSddlLines(lines.splice(0, done + 1).slice(0, -1).join("\n"), paths.length);
      if (broken) throw privateError("The permissions reader stopped.");
      const left = deadline - Date.now();
      if (left <= 0) { stopReader(); throw privateError("The permissions reader did not answer in time."); }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, left);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = null;
    }
  }
  return {
    get usable() { return !broken; },
    /** Answers for `paths`, or throws (the caller falls back to a one-shot read). */
    read(paths) {
      if (!paths.every(path => SERVER_PATH.test(path))) return Promise.reject(privateError("Only ASCII paths go to the reader."));
      const answer = queue.then(() => request(paths));
      queue = answer.catch(() => undefined);
      return answer;
    },
    stop: stopReader,
  };
}

// A synchronous read cannot await that reader, and a one-shot PowerShell
// costs about a second and a half on a slow machine. So synchronous reads go
// to a second long-lived PowerShell, owned by a worker thread: the caller
// posts the paths and waits in Atomics.wait until the worker has the whole
// answer (about a millisecond per path once PowerShell runs). Same rules as
// above: printable ASCII paths only, and a reader that fails, stops or does
// not answer in time is stopped for good; the one-shot script answers instead.
const SYNC_READER_SOURCE = `"use strict";
let child = null; let buffer = ""; let lines = []; let busy = false; let dead = false; let timer = null; let started = false;
let port = null; let flag = null;
process.on("uncaughtException", () => stop());
const { workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { signal, command, args, env, cwd, timeoutMs, startTimeoutMs, outputLimit } = workerData;
port = workerData.port; flag = new Int32Array(signal);
function answer(message) { clearTimeout(timer); busy = false; lines = []; if (!port) return; port.postMessage(message); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); }
function stop() { if (dead) return; dead = true; try { if (child) child.kill(); } catch {} if (busy) answer({ error: true }); }
function reader() {
  if (child) return child;
  child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  child.stderr.resume();
  child.stdin.on("error", stop);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
      const line = buffer.slice(0, end).replace(/\\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!busy) continue;
      if (line === "done:") answer({ lines }); else lines.push(line);
    }
    if (buffer.length > outputLimit) stop();
  });
  child.once("error", stop);
  child.once("exit", stop);
  return child;
}
port.on("message", (paths) => {
  busy = true;
  if (dead) { answer({ error: true }); return; }
  // A reader that does not answer is killed here, so no PowerShell outlives the wait.
  timer = setTimeout(stop, started ? timeoutMs : startTimeoutMs);
  started = true;
  // An empty request (prepare) only starts PowerShell: its answer is the empty line's "done:".
  try { reader().stdin.write(paths.length ? paths.join("\\n") + "\\n\\n" : "\\n"); } catch { stop(); }
});
`;

/**
 * The caller's thread is blocked while it waits (the Electron main thread
 * among them), so a reader that does not answer is given up sooner than a
 * one-shot tool; the first answer includes the PowerShell start.
 */
const SYNC_READER_TIMEOUT_MS = 10_000;
/** The first answer includes starting PowerShell, which a slow or busy machine can take long for. */
const SYNC_READER_START_TIMEOUT_MS = TOOL_TIMEOUT_MS;

/** Starts the worker that owns a synchronous reader: `command args` speaks the reader protocol above. */
export function syncSddlReaderWorker(command, args, env = process.env) {
  return ({ port, signal, timeoutMs, startTimeoutMs }) => new Worker(SYNC_READER_SOURCE, {
    eval: true, workerData: { port, signal, command, args, env: { ...env }, cwd: toolFolder(command), timeoutMs, startTimeoutMs, outputLimit: TOOL_OUTPUT_LIMIT }, transferList: [port],
    // The process's own flags (--input-type=module, --import <loader>, -e) are not the worker's: its source is CommonJS.
    execArgv: [],
  });
}

/** One long-lived reader for synchronous reads; `start` returns its worker (injectable for tests). */
export function createSyncSddlServer(start, { timeoutMs = SYNC_READER_TIMEOUT_MS, startTimeoutMs = SYNC_READER_START_TIMEOUT_MS } = {}) {
  let worker = null; let port = null; let flag = null; let broken = false;
  /** The worker's first answer (the PowerShell start) has a longer budget. */
  let answered = false;
  let answeredOnce = false;
  /** A prepare() request whose answer has not been taken yet. */
  let warming = false;
  const stop = () => {
    broken = true;
    try { void worker?.terminate(); } catch { /* already gone */ }
    try { port?.close(); } catch { /* already closed */ }
    worker = null; port = null;
  };
  function post(paths) {
    if (!worker) {
      const channel = new MessageChannel();
      flag = new Int32Array(new SharedArrayBuffer(4));
      worker = start({ port: channel.port2, signal: flag.buffer, timeoutMs, startTimeoutMs });
      // Neither the worker nor its port may keep the process alive on its own.
      worker.unref?.();
      // Seen between reads only: a worker that dies during a read answers through `flag` first.
      worker.once?.("error", stop);
      worker.once?.("exit", stop);
      port = channel.port1;
      port.unref?.();
    }
    Atomics.store(flag, 0, 0);
    port.postMessage(paths);
  }
  /** The worker's answer to the request just posted, or a throw (and the reader is stopped). */
  function answer() {
    // The worker gives up after its budget and answers; this wait is the backstop.
    const budget = answered ? timeoutMs : startTimeoutMs;
    answered = true;
    if (Atomics.wait(flag, 0, 0, budget + 1_000) === "timed-out") { stop(); throw privateError("The permissions reader did not answer in time."); }
    const message = receiveMessageOnPort(port)?.message;
    if (!Array.isArray(message?.lines)) { stop(); throw privateError("The permissions reader stopped."); }
    answeredOnce = true;
    return message.lines;
  }
  return {
    get usable() { return !broken; },
    /** Whether the worker ever answered: a reader that never started is not worth starting again. */
    get answeredOnce() { return answeredOnce; },
    /** Start the reader (and PowerShell) now, without waiting, so the first read does not pay for the start. */
    prepare() {
      if (broken || worker) return;
      post([]);
      warming = true;
    },
    /** Answers for `paths`, or throws (the caller falls back to a one-shot read). */
    read(paths) {
      if (broken) throw privateError("The permissions reader is not available.");
      if (!paths.every(path => SERVER_PATH.test(path))) throw privateError("Only ASCII paths go to the reader.");
      // A worker cannot start once the process is exiting (an "exit" listener that writes a
      // private file); the one-shot read answers then. (process._exiting is set before "exit".)
      if (!worker && process._exiting) throw privateError("The process is exiting.");
      if (warming) { warming = false; answer(); }
      post(paths);
      const lines = answer();
      try { return parseSddlLines(lines.join("\n"), paths.length); }
      catch (error) { stop(); throw error; }
    },
    stop,
  };
}

/**
 * The Windows facts, from injectable runners. A native helper may replace
 * this object later; it only needs these six methods.
 */
export function createWindowsSecurity({ run = runTool, runSync = runToolSync, env = process.env, startServer, startSyncServer } = {}) {
  const tools = windowsToolPaths(env);
  // The long-lived readers only with the real tools (tests that inject runners get none unless they ask).
  const start = startServer === undefined ? (run === runTool ? () => startSddlServer(tools.powershell, env) : null) : startServer;
  const server = start ? createSddlServer(start) : null;
  const startSync = startSyncServer === undefined
    ? (runSync === runToolSync ? syncSddlReaderWorker(tools.powershell, SERVER_ARGUMENTS, env) : null)
    : startSyncServer;
  let syncServer = startSync ? createSyncSddlServer(startSync) : null;
  // A reader that answered and was then given up (a crash, an answer that did not come in time on a
  // busy machine) is started again, twice at most; without one every synchronous check would start a
  // one-shot PowerShell. One that never answered is not: its start does not work here.
  let syncRestarts = 0;
  const usableSyncServer = () => {
    if (syncServer && !syncServer.usable && syncServer.answeredOnce && syncRestarts < 2 && !process._exiting) {
      syncRestarts += 1;
      syncServer = createSyncSddlServer(startSync);
      syncServer.prepare();
    }
    return syncServer?.usable ? syncServer : null;
  };
  let sid = null;
  let aliases = null;
  const remember = (output) => {
    const user = parseWhoamiUser(output);
    aliases = userSidAliases(user, env.COMPUTERNAME);
    return user.sid;
  };
  const environment = paths => ({ ...env, [PATHS_VARIABLE]: encodeSddlPaths(paths) });
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
      if (server?.usable && paths.length) {
        try { return await server.read(paths); } catch { /* the one-shot read below answers instead */ }
      }
      const result = [];
      for (const chunk of chunkPaths(paths)) {
        result.push(...parseSddlLines(await run(tools.powershell, powershellArguments(), { env: environment(chunk) }), chunk.length));
      }
      return result;
    },
    /** Start the synchronous reader now (see createSyncSddlServer's prepare). */
    prepare() { usableSyncServer()?.prepare(); },
    readSddlSync(paths) {
      const reader = paths.length ? usableSyncServer() : null;
      if (reader) {
        try { return reader.read(paths); } catch { /* the one-shot read below answers instead */ }
      }
      const result = [];
      for (const chunk of chunkPaths(paths)) {
        result.push(...parseSddlLines(runSync(tools.powershell, powershellArguments(), { env: environment(chunk) }), chunk.length));
      }
      return result;
    },
    /** Per path, the owner, DACL and bytes read through one handle ("object:"), or null. */
    async readObjects(paths) {
      return (await this.readSddl(paths.map(path => `object:${resolve(path)}`))).map(parseObjectAnswer);
    },
    readObjectsSync(paths) {
      // Absolute: PowerShell runs in its own folder, not the caller's.
      return this.readSddlSync(paths.map(path => `object:${resolve(path)}`)).map(parseObjectAnswer);
    },
    /** Make an Administrators-only file private through one handle ("upgrade:"): its new SDDL, or null when refused. */
    async upgradeObject(path) {
      const [answer] = await this.readSddl([`upgrade:${resolve(path)}`]);
      return answer;
    },
    upgradeObjectSync(path) {
      const [answer] = this.readSddlSync([`upgrade:${resolve(path)}`]);
      return answer;
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
 * As sddlHasProfileDefaultAccess, but the owner may also be Administrators
 * (what an elevated process gives a new file): only this account, SYSTEM and
 * Administrators can open it. No other account could have read or changed
 * it, and an administrator can take any file anyway, so making it private
 * hides nothing that was exposed.
 */
export function sddlHasOnlyAdministratorAccess(sddl, sid) {
  const parsed = parseSddl(sddl);
  const user = who(sid);
  if (!parsed?.dacl || parsed.dacl.flags.includes("NO_ACCESS_CONTROL")) return false;
  if (!(sidIsUser(parsed.owner, user) || parsed.owner === "BA" || parsed.owner === "S-1-5-32-544")) return false;
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

// ---------------------------------------------------------------- Windows: verified and known entries
//
// Starting icacls or PowerShell costs tens to hundreds of milliseconds, so it
// must not happen for every file. Two per-process sets, keyed by identity
// (volume and file index, so a renamed or replaced entry never matches):
//   - verified folders: a folder whose own entries are private (owner: this
//     account; allow entries only for this account and SYSTEM, inheritable).
//     Whatever is made in it from then on inherits those entries.
//   - known entries: entries this process made inside a verified folder (see
//     privateEntryCreated), protected, or read and found private.
// A known entry is private without another read or protect. An entry that is
// not known, even inside a verified folder, is read once (it may have been
// there, and owned by another account, before the folder was made private),
// and a protect of it runs in full, so another account's entry fails, as
// chmod fails with EPERM on POSIX.

let verifiedFolders = new WeakMap();
let knownEntries = new WeakMap();
/** Per WindowsSecurity: secret file path -> the identity its own DACL was found private for (see readOwnerPrivateFileSync). */
let secretVerdicts = new WeakMap();

/** Forget what this process verified (tests that change a DACL behind the cache's back). */
export function forgetOwnerPrivateCache() { verifiedFolders = new WeakMap(); knownEntries = new WeakMap(); secretVerdicts = new WeakMap(); }

/** The identity of `path` itself, or null for a missing path or a link (a link is never trusted). */
function identityOf(path) {
  try {
    const info = lstatSync(path, { bigint: true });
    // A link is never trusted; a file system without file IDs (ino 0) gives no identity.
    return info.isSymbolicLink() || info.ino === 0n ? null : `${info.dev}:${info.ino}`;
  } catch { return null; }
}

function addId(map, security, id) {
  if (!id) return;
  let set = map.get(security);
  if (!set) { set = new Set(); map.set(security, set); }
  set.add(id);
}

function inSet(map, security, path) {
  const id = identityOf(path);
  return Boolean(id && map.get(security)?.has(id));
}

/** Remember the object with identity `id`: known, and (when it passes private entries on) a verified folder. */
function rememberId(security, id, verifiedFolder) {
  addId(knownEntries, security, id);
  if (verifiedFolder) addId(verifiedFolders, security, id);
}

function isKnown(security, path) {
  return inSet(knownEntries, security, path);
}

/**
 * A folder may vouch for what is made in it only when it passes its private
 * entries on to every generation: an allow entry for this account that both
 * files and folders inherit (OI and CI), without NP. A private folder without
 * one gives new children (or grandchildren) the creator's default DACL.
 */
export function sddlPassesPrivateEntriesOn(sddl, sid) {
  const parsed = parseSddl(sddl);
  const user = who(sid);
  // NP (no propagation) stops after one generation: a folder made inside could not pass entries on again.
  return Boolean(parsed?.dacl?.aces.some(ace => ALLOW_TYPES.has(ace.type) && sidIsUser(ace.sid, user)
    && ace.flags.includes("OI") && ace.flags.includes("CI") && !ace.flags.includes("NP")));
}

/**
 * Whether the folder `path` sits in is verified private. The parent must be
 * verified itself: a link on the way is never followed, and a folder that is
 * only private by inheritance counts once it was read or made here.
 */
function parentIsVerified(security, path) {
  const parent = dirname(resolve(path));
  return parent !== resolve(path) && inSet(verifiedFolders, security, parent);
}

/**
 * Tell the helper that this process has just made `path` (a file or folder)
 * exclusively, for example with open(..., "wx") or mkdir. POSIX: nothing to
 * do (the mode was set at creation). Windows: inside a verified folder the
 * entry inherits the private entries, so it is known and nothing runs;
 * elsewhere it is protected in full. A link is refused.
 */
export async function privateEntryCreated(path, kind, options = {}) {
  if (!isWindows(options)) return;
  const id = identityOf(path);
  if (!id) throw privateError(`Refusing a link (or an entry without a file ID) at ${path}.`);
  const security = windowsSecurity(options);
  // A folder made in a verified folder inherits its OI/CI entries, so it passes them on too.
  if (parentIsVerified(security, path)) { rememberId(security, id, kind === "directory"); return; }
  await protectOwnerPrivate(path, kind, { ...options, force: true, [JUST_CREATED]: true });
}

export function privateEntryCreatedSync(path, kind, options = {}) {
  if (!isWindows(options)) return;
  const id = identityOf(path);
  if (!id) throw privateError(`Refusing a link (or an entry without a file ID) at ${path}.`);
  const security = windowsSecurity(options);
  if (parentIsVerified(security, path)) { rememberId(security, id, kind === "directory"); return; }
  protectOwnerPrivateSync(path, kind, { ...options, force: true, [JUST_CREATED]: true });
}

/** Internal: this process just made the entry, so its owner is this account and need not be read first. */
const JUST_CREATED = Symbol("owner-private just created");
/**
 * Internal: the upgrade of LetAgents' own state folder (see
 * ensurePrivateStateFolderSync). The value is the volume and file ID that
 * were checked; the protect refuses unless the path is still that folder and
 * the DACL it reads before any change still lets only this account, SYSTEM
 * and Administrators in.
 */
const UPGRADE_OF = Symbol("owner-private upgrade of");

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
 * folder above it, up to the first one that is verified in this process or
 * has a protected DACL (inheritance off). Returns what may be remembered (the
 * path and the folders that were read), or null. Nothing is remembered here:
 * the caller first confirms that every path still names the object it read.
 */
function decideChain(security, chain, answers, user, pathIsFolder) {
  const learned = (end) => chain.slice(0, end).map((path, index) => ({
    path,
    folder: index > 0 || pathIsFolder,
    passesOn: (index > 0 || pathIsFolder) && sddlPassesPrivateEntriesOn(answers.get(path), user),
  }));
  for (let index = 0; index < chain.length; index += 1) {
    if (index > 0 && inSet(verifiedFolders, security, chain[index])) return learned(index);
    const sddl = answers.get(chain[index]);
    if (!sddlHasPrivateEntries(sddl, user)) return null;
    if (parseSddl(sddl).dacl.flags.includes("P")) return learned(index + 1);
  }
  return null;
}

/** The paths to read for an entry that is not known: itself, and the folders above up to a verified one. */
function pathsToRead(security, path) {
  const chain = chainOf(path);
  const end = chain.findIndex((folder, index) => index > 0 && inSet(verifiedFolders, security, folder));
  return { chain, read: end < 0 ? chain : chain.slice(0, end) };
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

function privatePlan(security, entries, checkObject = false) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return null;
  // checkObject: the entry's own DACL is read even when it is known, so an
  // explicit grant added to it later is seen; its folders keep the cache.
  const pending = entries.filter(entry => checkObject || !isKnown(security, entry.path));
  const plans = pending.map(entry => pathsToRead(security, entry.path));
  // Identities before the read: only these objects may be remembered, and only if they are still there.
  const identities = new Map(plans.flatMap(item => item.read).map(path => [path, identityOf(path)]));
  return { pending, plans, identities };
}

/** Decide each pending entry and remember what was proved, if every path still names the object read. */
function settlePlan(security, plan, answers, user) {
  for (const [index, entry] of plan.pending.entries()) {
    const learned = decideChain(security, plan.plans[index].chain, answers, user, isDirectoryInfo(entry.info));
    if (!learned) return false;
    if (!learned.every(item => plan.identities.get(item.path) && identityOf(item.path) === plan.identities.get(item.path))) return false;
    for (const item of learned) rememberId(security, plan.identities.get(item.path), item.passesOn);
  }
  return true;
}

/** Windows: is each entry private? Known entries need no read; the rest are read in one call. */
async function windowsEntriesArePrivate(security, entries, checkObject = false) {
  const plan = privatePlan(security, entries, checkObject);
  if (!plan) return false;
  if (plan.pending.length) {
    const answers = await readAll(security, plan.plans.flatMap(item => item.read));
    if (!settlePlan(security, plan, answers, await currentUser(security))) return false;
  }
  return entries.every(entry => pathIsInfo(entry.path, entry.info));
}

function windowsEntriesArePrivateSync(security, entries, checkObject = false) {
  const plan = privatePlan(security, entries, checkObject);
  if (!plan) return false;
  if (plan.pending.length) {
    const answers = readAllSync(security, plan.plans.flatMap(item => item.read));
    if (!settlePlan(security, plan, answers, currentUserSync(security))) return false;
  }
  return entries.every(entry => pathIsInfo(entry.path, entry.info));
}

/** Windows: is each entry owned by this account? Known entries are; the rest are read in one call. */
async function windowsEntriesAreOwned(security, entries) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return false;
  const pending = entries.filter(entry => !isKnown(security, entry.path));
  if (!pending.length) return true;
  const answers = await readAll(security, pending.map(entry => entry.path));
  const user = await currentUser(security);
  return pending.every(entry => sddlIsOwnedBy(answers.get(entry.path), user))
    && entries.every(entry => pathIsInfo(entry.path, entry.info));
}

function windowsEntriesAreOwnedSync(security, entries) {
  if (!entries.every(entry => pathIsInfo(entry.path, entry.info))) return false;
  const pending = entries.filter(entry => !isKnown(security, entry.path));
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
 *
 * `checkObject: true` (for high-value secrets) always reads the object's own
 * DACL, even when this process already knows it, so an explicit grant added to
 * the file later is refused. The folders above still come from the cache.
 */
export async function isOwnerPrivate(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  try { return await windowsEntriesArePrivate(windowsSecurity(options), [{ path, info }], options.checkObject === true); } catch { return false; }
}

/** Windows only: see sddlHasProfileDefaultAccess. POSIX answers as isOwnerPrivate. */
export async function hasProfileDefaultAccess(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  const security = windowsSecurity(options);
  try {
    if (!pathIsInfo(path, info)) return false;
    if (isKnown(security, path)) return true;
    const [sddl] = await security.readSddl([path]);
    return pathIsInfo(path, info) && sddlHasProfileDefaultAccess(sddl, await currentUser(security));
  } catch { return false; }
}

export function isOwnerPrivateSync(path, info, options = {}) {
  if (!isWindows(options)) return posixPrivate(info, options.exactMode);
  try { return windowsEntriesArePrivateSync(windowsSecurity(options), [{ path, info }], options.checkObject === true); } catch { return false; }
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

// ---------------------------------------------------------------- high-value secret files
//
// A token or key file is read on Windows only when its own owner and DACL
// are private to this account, as POSIX refuses a file with group or other
// bits or another uid. The owner, the DACL and the bytes come from one open
// handle (the reader's "object:" request), so a folder above the file that
// another account renames during the check cannot make the answer describe
// one file and the bytes come from another.
//
// The verdict is kept per path for the file's identity (volume, file ID,
// change time, write time, size) and a hash of the bytes that were checked.
// An unchanged file is then read through Node's own handle with no tool: it
// must still have that identity and those bytes, or it is checked again.
// NTFS moves the change time when a DACL changes, so a grant added later is
// checked before the next read. A verdict lasts five minutes at most: a
// program with this account's rights (or an administrator's) can set the
// change time back, and it could read the file anyway, but such a change is
// still seen soon. Only "private" is kept.

const SECRET_VERDICT_MS = 5 * 60_000;
const SECRET_ATTEMPTS = 3;
/** Opening a file another process is replacing can fail for a moment on Windows. */
const BUSY_OPEN_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const BUSY_OPEN_WAIT_MS = 25;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

function secretIdentity(info) {
  return `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}:${info.size}`;
}

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function rememberSecret(security, path, info, data) {
  let verdicts = secretVerdicts.get(security);
  if (!verdicts) { verdicts = new Map(); secretVerdicts.set(security, verdicts); }
  verdicts.set(resolve(path), { identity: secretIdentity(info), digest: digest(data), until: Date.now() + SECRET_VERDICT_MS });
}

function forgetSecret(security, path) {
  secretVerdicts.get(security)?.delete(resolve(path));
}

/** The digest of the bytes checked for this identity, while the verdict lasts; else null. */
function rememberedDigest(security, path, info) {
  const verdict = secretVerdicts.get(security)?.get(resolve(path));
  return verdict && verdict.identity === secretIdentity(info) && Date.now() < verdict.until ? verdict.digest : null;
}

function secretRefused(path, cause) {
  const error = privateError(`LetAgents will not read ${path}: it is not private to this Windows account, or it `
    + "could not be checked. Another account owns it, it is a link, or its permissions let other accounts open "
    + "it. Make it private (only you and SYSTEM may have access) or delete it, then try again.");
  if (cause) error.cause = cause;
  return error;
}

/**
 * A failure before the read: a missing file stays ENOENT (no state yet); a
 * file being replaced by another process gets a short wait and another try;
 * anything else (a link, no access) is a refusal, never "no file", which a
 * caller could read as empty state and then overwrite.
 */
function secretFailure(path, error, attempt) {
  if (error?.code === "ENOENT") return error;
  if (BUSY_OPEN_CODES.has(error?.code) && attempt < SECRET_ATTEMPTS) return null;
  return error?.code === "EOWNERPRIVATE" ? error : secretRefused(path, error);
}

/** The path's own lstat (bigint), or a throw: a link or anything but a regular file is refused. */
function secretInfo(path, info) {
  if (info.isSymbolicLink()) throw secretRefused(path, Object.assign(new Error(`${path} is a link`), { code: "ELOOP" }));
  // No secret is larger than a handle read returns.
  if (!info.isFile() || info.size > BigInt(OBJECT_LIMIT)) throw secretRefused(path);
  return info;
}

/**
 * Exactly `size` bytes from an open file, or null when it holds fewer or more
 * (it changed): never more than one byte past `size` is read.
 */
function readExactlySync(descriptor, size) {
  const buffer = Buffer.alloc(size + 1);
  let read = 0;
  for (let count; read < buffer.length && (count = readSync(descriptor, buffer, read, buffer.length - read, null)) > 0;) read += count;
  return read === size ? buffer.subarray(0, size) : null;
}

async function readExactly(handle, size) {
  const buffer = Buffer.alloc(size + 1);
  let read = 0;
  for (let count; read < buffer.length && (count = (await handle.read(buffer, read, buffer.length - read, null)).bytesRead) > 0;) read += count;
  return read === size ? buffer.subarray(0, size) : null;
}

/**
 * Whether a handle's owner and DACL are private: a protected DACL for only
 * this account and SYSTEM, or those entries inherited from a folder that is
 * private itself (it decides what they become).
 */
function objectIsPrivateSync(path, sddl, user, options) {
  if (sddlIsOwnerPrivate(sddl, user)) return true;
  if (!sddlHasPrivateEntries(sddl, user)) return false;
  const folder = dirname(resolve(path));
  try {
    const info = lstatSync(folder, { bigint: true });
    return info.isDirectory() && !info.isSymbolicLink() && isOwnerPrivateSync(folder, info, options);
  } catch { return false; }
}

async function objectIsPrivate(path, sddl, user, options) {
  if (sddlIsOwnerPrivate(sddl, user)) return true;
  if (!sddlHasPrivateEntries(sddl, user)) return false;
  const folder = dirname(resolve(path));
  try {
    const info = await lstat(folder, { bigint: true });
    return info.isDirectory() && !info.isSymbolicLink() && await isOwnerPrivate(folder, info, options);
  } catch { return false; }
}

/**
 * After a handle check: "replaced" when the path no longer has the identity
 * seen before the check (another process saved it, or it changed), else
 * whether the handle's answer was private.
 */
function settleSecret(path, info, isPrivate) {
  let after = null;
  try { after = lstatSync(path, { bigint: true }); } catch { /* replaced (or removed) */ }
  if (!after || secretIdentity(after) !== secretIdentity(info)) return "replaced";
  return isPrivate ? "private" : "exposed";
}

function decoded(data, encoding) {
  return encoding === undefined ? data : data.toString(encoding);
}

/**
 * Read a high-value secret file (a token, a key). POSIX: exactly
 * readFileSync(path, encoding), as before. Windows: an unchanged file this
 * process checked (or wrote) is read through a no-follow handle and must
 * match what was checked; any other is read through one handle together with
 * its owner and DACL (see "object:"), and returned only when they are
 * private. Otherwise this throws EOWNERPRIVATE naming the file (a missing
 * file is ENOENT). A widened file is never repaired and another account's
 * file is never taken over (see upgradeAdministratorsOnly for the one
 * upgrade). A file replaced during the check is checked again.
 *
 * `upgradeAdministratorsOnly`: a file that is not private only because
 * Administrators have access too (state an older version left) is made
 * private by itself through one handle (see "upgrade:"), then checked again
 * and read. Only this account, SYSTEM and Administrators could ever open
 * such a file; any other grant or owner is refused, and no folder changes.
 */
export function readOwnerPrivateFileSync(path, encoding, options = {}) {
  if (!isWindows(options)) return readFileSync(path, encoding);
  const security = windowsSecurity(options);
  let upgraded = false;
  for (let attempt = 1; ; attempt += 1) {
    let verdict;
    try {
      const info = secretInfo(path, lstatSync(path, { bigint: true }));
      const known = rememberedDigest(security, path, info);
      if (known) {
        const descriptor = openNoFollowSync(path, constants.O_RDONLY, undefined, options);
        try {
          if (openedIsChecked(fstatSync(descriptor, { bigint: true }), info)) {
            const data = readExactlySync(descriptor, Number(info.size));
            if (data && digest(data) === known) return decoded(data, encoding);
          }
        } finally { closeSync(descriptor); }
        // Not what was checked (other bytes under the same identity, or another file): check it again.
        forgetSecret(security, path);
        verdict = "replaced";
      } else {
        if (!security.readObjectsSync) throw secretRefused(path);
        const [object] = security.readObjectsSync([path]);
        const isPrivate = Boolean(object) && objectIsPrivateSync(path, object.sddl, currentUserSync(security), options);
        // The bytes checked must be as long as the file seen around the check, or they are not accepted.
        verdict = settleSecret(path, info, isPrivate && BigInt(object.data.length) === info.size);
        if (verdict === "private") {
          rememberSecret(security, path, info, object.data);
          return decoded(object.data, encoding);
        }
      }
    } catch (error) {
      const failure = secretFailure(path, error, attempt);
      if (failure) throw failure;
      Atomics.wait(PAUSE, 0, 0, BUSY_OPEN_WAIT_MS);
      continue;
    }
    if (verdict === "exposed" && options.upgradeAdministratorsOnly && !upgraded) {
      upgraded = true;
      let answer = null;
      try { answer = security.upgradeObjectSync?.(path) ?? null; } catch { /* refused */ }
      if (answer) continue;
    }
    if (verdict === "exposed" || attempt >= SECRET_ATTEMPTS) throw secretRefused(path);
  }
}

/** As readOwnerPrivateFileSync. POSIX: exactly readFile(path, encoding). */
export async function readOwnerPrivateFile(path, encoding, options = {}) {
  if (!isWindows(options)) return readFile(path, encoding);
  const security = windowsSecurity(options);
  let upgraded = false;
  for (let attempt = 1; ; attempt += 1) {
    let verdict;
    try {
      const info = secretInfo(path, await lstat(path, { bigint: true }));
      const known = rememberedDigest(security, path, info);
      if (known) {
        const handle = await openNoFollow(path, constants.O_RDONLY, undefined, options);
        try {
          if (openedIsChecked(await handle.stat({ bigint: true }), info)) {
            const data = await readExactly(handle, Number(info.size));
            if (data && digest(data) === known) return decoded(data, encoding);
          }
        } finally { await handle.close(); }
        forgetSecret(security, path);
        verdict = "replaced";
      } else {
        if (!security.readObjects) throw secretRefused(path);
        const [object] = await security.readObjects([path]);
        const isPrivate = Boolean(object) && await objectIsPrivate(path, object.sddl, await currentUser(security), options);
        // The bytes checked must be as long as the file seen around the check, or they are not accepted.
        verdict = settleSecret(path, info, isPrivate && BigInt(object.data.length) === info.size);
        if (verdict === "private") {
          rememberSecret(security, path, info, object.data);
          return decoded(object.data, encoding);
        }
      }
    } catch (error) {
      const failure = secretFailure(path, error, attempt);
      if (failure) throw failure;
      await new Promise(resolvePause => setTimeout(resolvePause, BUSY_OPEN_WAIT_MS));
      continue;
    }
    if (verdict === "exposed" && options.upgradeAdministratorsOnly && !upgraded) {
      upgraded = true;
      let answer = null;
      try { answer = (await security.upgradeObject?.(path)) ?? null; } catch { /* refused */ }
      if (answer) continue;
    }
    if (verdict === "exposed" || attempt >= SECRET_ATTEMPTS) throw secretRefused(path);
  }
}

/** The open file must be the one that was checked (same identity, change time included). */
function openedIsChecked(opened, info) {
  return opened.isFile() && secretIdentity(opened) === secretIdentity(info);
}

/** Windows: start the synchronous permissions reader now, so the first secret read does not wait for PowerShell. */
export function prepareOwnerPrivateReads(options = {}) {
  if (!isWindows(options)) return;
  try { windowsSecurity(options).prepare?.(); } catch { /* the first read starts it instead */ }
}

/**
 * Windows: after a write that made `temporary` private (an exclusive create
 * then privateEntryCreated, or a protect) and renamed it to `path`, remember
 * `path` and the bytes written as private when it is still that file,
 * unchanged since `written` (the temporary's bigint lstat after its last
 * write). Any change, the change time included (a rename may move it), leaves
 * it unremembered: the next read checks it.
 */
function rememberWrittenSecret(security, path, written, data) {
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isSymbolicLink() && secretIdentity(current) === secretIdentity(written)) rememberSecret(security, path, current, data);
  } catch { /* not remembered: the next read checks it */ }
}

/**
 * Windows: make LetAgents' own state folder private when only this account,
 * SYSTEM and Administrators have access to it (a fresh profile folder, as an
 * older version left it), so new state files are private from their create
 * with no tool. Nothing is exposed by it, and what the files in it inherit
 * only narrows. A folder that is private is only read (once per process);
 * any other folder (a grant to another account, another owner) is left as it
 * is, and writes into it give each file a protected DACL of its own. Callers
 * pass only LetAgents' own state folder: making a folder private changes what
 * everything below it inherits. Returns whether the folder is private now.
 * POSIX: nothing.
 */
export function ensurePrivateStateFolderSync(folder, options = {}) {
  if (!isWindows(options)) return false;
  let info;
  try { info = lstatSync(folder, { bigint: true }); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (isOwnerPrivateSync(folder, info, options)) return true;
  // The protect refuses unless the folder is still the one checked here and Administrators-only.
  // Any failure leaves the folder as it is: the writer then gives each file a protected DACL of its own.
  try {
    protectOwnerPrivateSync(folder, "directory", { ...options, force: true, [UPGRADE_OF]: `${info.dev}:${info.ino}` });
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- making private paths

/**
 * A failed protect is EOWNERPRIVATE, never a tool's own ENOENT; but when the
 * path itself is gone by then (another process removed it), the answer is the
 * path's ENOENT, as a chmod that lost that race would give. A missing path has
 * nothing to protect.
 */
function protectFailure(path, error) {
  try { lstatSync(path); }
  catch (missing) { if (missing?.code === "ENOENT") return missing; }
  return error?.code === "EOWNERPRIVATE" || error?.code === "EPERM" ? error : toolError("protect", error);
}

function notProtected(path) {
  return privateError(`Could not make ${path} private to this account: other entries remain in its permissions.`);
}

/**
 * POSIX: chmod 0700/0600. Windows: for an entry known private in this process
 * (made here inside a verified folder, or already protected or read) there is
 * nothing to do. Else, if this account owns it (an entry another account owns
 * fails with EPERM, as chmod does), a protected DACL for this account and
 * SYSTEM, set by icacls and read back afterwards: an
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
  if (!options.force && isKnown(security, path)) return;
  let proved;
  try { proved = await protectWindowsPath(security, path, kind, options[JUST_CREATED] === true, options[UPGRADE_OF]); }
  catch (error) { throw protectFailure(path, error); }
  rememberId(security, proved.id, proved.passesOn);
}

function replaced(path) {
  return privateError(`${path} was replaced while it was being made private.`);
}

/**
 * The owner and DACL are read back from the object itself (owner included:
 * the result of /setowner is not assumed), and the path must still name the
 * same object as before the protect, so a swap in a writable folder fails.
 */
/**
 * An entry this process did not just make is protected only when this account
 * (or Administrators, the owner an elevated process gives) owns it: icacls
 * would otherwise take over another account's entry whenever its DACL lets
 * this account change the owner, where chmod fails with EPERM. Another
 * account that planted it could still hold an open handle.
 */
function assertProtectableOwner(path, sddl, user) {
  const owner = parseSddl(sddl)?.owner;
  if (!owner || !(sidIsUser(owner, who(user)) || owner === "BA" || owner === "S-1-5-32-544")) {
    throw privateError(`${path} belongs to another account; it is not taken over.`, "EPERM");
  }
}

/** An upgrade (UPGRADE_OF) changes only the entry that was checked, and only while it is Administrators-only. */
function assertUpgradable(path, before, upgradeOf, sddl, user) {
  if (upgradeOf === undefined) return;
  if (before !== upgradeOf || !sddlHasOnlyAdministratorAccess(sddl, user)) {
    throw privateError(`${path} changed, or other accounts can open it; it is not made private.`);
  }
}

async function protectWindowsPath(security, path, kind, justCreated, upgradeOf) {
  const before = identityOf(path);
  if (!before) throw privateError(`Refusing to protect a link at ${path}.`);
  if (!justCreated) {
    const [current] = await security.readSddl([path]);
    assertProtectableOwner(path, current, await currentUser(security));
    assertUpgradable(path, before, upgradeOf, current, await currentUser(security));
    if (identityOf(path) !== before) throw replaced(path);
  }
  await security.protect(path, kind);
  const user = await currentUser(security);
  let [sddl] = await security.readSddl([path]);
  if (identityOf(path) !== before) throw replaced(path);
  if (!sddlIsOwnerPrivate(sddl, user)) {
    const extra = sddlExtraGrantSids(sddl, user);
    if (!extra?.length || !security.removeGrants) throw notProtected(path);
    await security.removeGrants(path, extra);
    [sddl] = await security.readSddl([path]);
    if (identityOf(path) !== before) throw replaced(path);
    if (!sddlIsOwnerPrivate(sddl, user)) throw notProtected(path);
  }
  return { id: before, passesOn: kind === "directory" && sddlPassesPrivateEntriesOn(sddl, user) };
}

export function protectOwnerPrivateSync(path, kind, options = {}) {
  if (!isWindows(options)) return chmodSync(path, kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
  lstatSync(path);
  const security = windowsSecurity(options);
  if (!options.force && isKnown(security, path)) return;
  let proved;
  try { proved = protectWindowsPathSync(security, path, kind, options[JUST_CREATED] === true, options[UPGRADE_OF]); }
  catch (error) { throw protectFailure(path, error); }
  rememberId(security, proved.id, proved.passesOn);
}

function protectWindowsPathSync(security, path, kind, justCreated, upgradeOf) {
  const before = identityOf(path);
  if (!before) throw privateError(`Refusing to protect a link at ${path}.`);
  if (!justCreated) {
    const [current] = security.readSddlSync([path]);
    assertProtectableOwner(path, current, currentUserSync(security));
    assertUpgradable(path, before, upgradeOf, current, currentUserSync(security));
    if (identityOf(path) !== before) throw replaced(path);
  }
  security.protectSync(path, kind);
  const user = currentUserSync(security);
  let [sddl] = security.readSddlSync([path]);
  if (identityOf(path) !== before) throw replaced(path);
  if (!sddlIsOwnerPrivate(sddl, user)) {
    const extra = sddlExtraGrantSids(sddl, user);
    if (!extra?.length || !security.removeGrantsSync) throw notProtected(path);
    security.removeGrantsSync(path, extra);
    [sddl] = security.readSddlSync([path]);
    if (identityOf(path) !== before) throw replaced(path);
    if (!sddlIsOwnerPrivate(sddl, user)) throw notProtected(path);
  }
  return { id: before, passesOn: kind === "directory" && sddlPassesPrivateEntriesOn(sddl, user) };
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
    await privateEntryCreated(resolve(path), "directory", options);
    return undefined;
  }
  let first;
  for (const folder of missingFolders(path)) {
    try { await mkdir(folder, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { existingFolder(folder, error); continue; }
    first ??= folder;
    await privateEntryCreated(folder, "directory", options);
  }
  assertFolder(path);
  return first;
}

export function createPrivateDirSync(path, { recursive = false } = {}, options = {}) {
  if (!isWindows(options)) return mkdirSync(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  if (!recursive) {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    privateEntryCreatedSync(resolve(path), "directory", options);
    return undefined;
  }
  let first;
  for (const folder of missingFolders(path)) {
    try { mkdirSync(folder, { mode: PRIVATE_DIRECTORY_MODE }); }
    catch (error) { existingFolder(folder, error); continue; }
    first ??= folder;
    privateEntryCreatedSync(folder, "directory", options);
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
  try { await privateEntryCreated(folder, "directory", options); }
  catch (error) { await rm(folder, { recursive: true, force: true }).catch(() => undefined); throw error; }
  return folder;
}

function privateStagingFolderSync(path, options) {
  const folder = mkdtempSync(join(dirname(path), `.${pathName(path)}.letagents-`));
  try { privateEntryCreatedSync(folder, "directory", options); }
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
 * retry. On Windows this process then reads the file back as a private
 * secret (readOwnerPrivateFile) without a new check.
 */
export async function writePrivateFileAtomically(path, data, options = {}) {
  const staging = isWindows(options) && !await folderIsPrivate(path, options) ? await createPrivateStagingFolder(path, options) : null;
  const temporary = staging ? join(staging, "data") : join(dirname(path), `.${randomUUID()}.${pathName(path)}.tmp`);
  try {
    const handle = await openNoFollow(temporary, EXCLUSIVE_WRITE, PRIVATE_FILE_MODE, options);
    let closed = false;
    try {
      // The file leaves the staging folder, so it needs a protected DACL of its own.
      if (staging) await protectOwnerPrivate(temporary, "file", { ...options, force: true, [JUST_CREATED]: true });
      else await privateEntryCreated(temporary, "file", options);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      closed = true;
      const written = isWindows(options) ? await lstat(temporary, { bigint: true }) : null;
      await renameWithRetryAsync(temporary, path, { platform: ownerPrivatePlatform(options) });
      // This process made the file private, so its next read needs no check.
      if (written) rememberWrittenSecret(windowsSecurity(options), path, written, typeof data === "string" ? Buffer.from(data, "utf8") : data);
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
      if (staging) protectOwnerPrivateSync(temporary, "file", { ...options, force: true, [JUST_CREATED]: true });
      else privateEntryCreatedSync(temporary, "file", options);
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      for (let offset = 0; offset < bytes.length;) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
      fsyncSync(descriptor);
      closeSync(descriptor);
      closed = true;
      const written = isWindows(options) ? lstatSync(temporary, { bigint: true }) : null;
      renameSyncWithRetry(temporary, path, { platform: ownerPrivatePlatform(options) });
      if (written) rememberWrittenSecret(windowsSecurity(options), path, written, bytes);
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
