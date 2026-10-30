import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderInstallError, providerLaunchCommand } from "./provider-executable.mjs";

export { resolveWindowsCommand } from "./provider-executable.mjs";

// Process trees and process birth identity, one implementation for every
// platform. On POSIX each function does exactly what the daemon has always
// done: a detached child leads its own process group, the group is signalled
// with process.kill(-pid), and a process's birth is its `ps -o lstart=`.
//
// Windows has neither process groups nor signals, and killing the process
// Node spawned leaves its children (an npm .cmd shim's node, then the native
// binary) running. There a tree is started through letagents-process-tree.exe
// (apps/desktop/native/win-process-tree), which holds it in a Job Object
// named after the helper's own pid and creation time. The ChildProcess the
// caller gets is the helper's: its pid, stdio, IPC channel and exit code
// stand for the whole tree, and when it exits the tree is gone. A process is
// only ever ended through that job, or after its creation time was checked
// against the recorded one while a handle to it was held, so a pid that
// Windows gave to another process is never killed.
//
// Ending a job is asynchronous, and a process can outlast it (a driver that
// never completes its I/O). The helper waits for an ended job to empty for a
// bounded time only; what is left then is reported "unkillable", which is
// neither success nor an ordinary failure. The helper is used only when its
// bytes are the sealed build (shared/letagents-process-tree.seal.json).

export const PROCESS_TREE_HELPER_NAME = "letagents-process-tree.exe";
/** The birth identity of a Windows process: its creation FILETIME in decimal. */
export const WINDOWS_BIRTH_PREFIX = "win32-ft:";
const WINDOWS_BIRTH = /^win32-ft:([1-9]\d{0,19})$/;
const HELPER_TIMEOUT_MS = 15_000;
/**
 * The exit code of a helper-held child whose job still held processes when
 * the helper's wait ran out after the job was ended: the tree is unkillable.
 * It stands in for the program's own exit code.
 */
export const PROCESS_TREE_UNKILLABLE_EXIT_CODE = 0xE04C5401;
/** How long the helper waits for an ended tree to empty, unless a caller names another bound. */
export const PROCESS_TREE_UNKILLABLE_AFTER_MS = 5_000;
const MAX_UNKILLABLE_AFTER_MS = 600_000;
const SEAL_URL = new URL("./letagents-process-tree.seal.json", import.meta.url);

/** Children this process started through the helper and that have not exited. */
const liveTrees = new Map();
/** Helper children a kill reported unkillable: later answers about them stay unkillable. */
const unkillableTrees = new WeakSet();

const MAX_FILETIME = 2n ** 64n - 1n;

/** A FILETIME in decimal: 1 to 2^64 - 1, no leading zero. */
function isCreationTime(text) {
  return /^[1-9]\d{0,19}$/.test(text) && BigInt(text) <= MAX_FILETIME;
}

export function isWindowsBirth(identity) {
  if (typeof identity !== "string") return false;
  const match = WINDOWS_BIRTH.exec(identity.trim());
  return Boolean(match && isCreationTime(match[1]));
}

/** The start of a `ps -o lstart=` birth: "Tue Oct 29 01:02:03 2026". */
export const PS_BIRTH_EVIDENCE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+\d{4}(?:\s|$)/;

/**
 * Whether a recorded or read birth is hard evidence on this platform: a
 * `ps lstart` string on POSIX, a `win32-ft:` creation time on Windows. A
 * record in the other platform's format is never evidence.
 */
export function isBirthEvidence(identity, platform = process.platform) {
  if (typeof identity !== "string") return false;
  return platform === "win32" ? isWindowsBirth(identity) : PS_BIRTH_EVIDENCE.test(identity.trim());
}

/**
 * Where letagents-process-tree.exe is, or null when it is not there: the
 * LETAGENTS_PROCESS_TREE_HELPER path, then `<resources>/app/runtime/`, where
 * the packaged app ships it, then the local build beside its source. A file
 * whose sha256 is not the sealed build's for this architecture is refused as
 * if it were absent; `processTreeHelperRefusal()` says why.
 */
export function processTreeHelperPath(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const resourcesPath = options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  const arch = options.arch ?? process.arch;
  const sealed = (candidate) => helperMatchesSeal(candidate, { ...options, arch });
  const candidates = [];
  const configured = env.LETAGENTS_PROCESS_TREE_HELPER?.trim();
  if (configured) {
    // A configured helper that is missing (or not sealed) is an error to see, not a reason to use another.
    return path.win32.isAbsolute(configured) && exists(configured) && sealed(configured) ? configured : null;
  }
  if (resourcesPath.trim()) candidates.push(path.win32.join(resourcesPath, "app", "runtime", PROCESS_TREE_HELPER_NAME));
  if (options.includeLocalBuild !== false) {
    candidates.push(fileURLToPath(new URL(`../apps/desktop/native/win-process-tree/build/${arch === "arm64" ? "arm64" : "x64"}/${PROCESS_TREE_HELPER_NAME}`, import.meta.url)));
  }
  return candidates.find((candidate) => exists(candidate) && sealed(candidate)) ?? null;
}

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

let loadedSeal;
/** shared/letagents-process-tree.seal.json, or null when it cannot be read. */
function processTreeSeal() {
  if (loadedSeal === undefined) {
    try { loadedSeal = JSON.parse(readFileSync(SEAL_URL, "utf8")); } catch { loadedSeal = null; }
  }
  return loadedSeal;
}

/** The sealed sha256 of the helper built for `arch`, or null when no build for it is sealed. */
export function sealedProcessTreeHelperSha256(arch = process.arch, seal = processTreeSeal()) {
  const digest = seal?.builds?.[arch === "arm64" ? "arm64" : "x64"]?.sha256;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/**
 * sha256 of a file, null when unreadable. Read on every use (the helper is
 * small): size, time and file id can all be kept by an edit in place.
 */
function fileSha256(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

let helperRefusal = null;
const reportedRefusals = new Set();
/** Why the last helper found was not used (its bytes are not the sealed build), or null. */
export function processTreeHelperRefusal() {
  return helperRefusal;
}

function helperMatchesSeal(filePath, options) {
  const expected = sealedProcessTreeHelperSha256(options.arch, options.seal === undefined ? processTreeSeal() : options.seal);
  let actual = null;
  if (options.readFile) {
    try { actual = createHash("sha256").update(options.readFile(filePath)).digest("hex"); } catch { actual = null; }
  } else {
    actual = fileSha256(filePath);
  }
  if (expected && actual === expected) return true;
  helperRefusal = expected
    ? `${filePath} is not the sealed ${PROCESS_TREE_HELPER_NAME} (sha256 ${actual ?? "unreadable"}, sealed ${expected}), so it is not used.`
    : `No ${options.arch} build of ${PROCESS_TREE_HELPER_NAME} is sealed, so ${filePath} is not used.`;
  if (!reportedRefusals.has(helperRefusal)) {
    reportedRefusals.add(helperRefusal);
    process.emitWarning(helperRefusal, { code: "LETAGENTS_PROCESS_TREE_UNSEALED" });
  }
  return false;
}

/** The helper's optional <wait-ms> argument: none for its default bound. */
function waitArgument(options) {
  const wait = options.unkillableAfterMs;
  if (wait === undefined) return [];
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > MAX_UNKILLABLE_AFTER_MS) {
    throw new RangeError(`unkillableAfterMs must be a whole number of milliseconds from 0 to ${MAX_UNKILLABLE_AFTER_MS}.`);
  }
  return [String(wait)];
}

/**
 * One argument for a Windows command line, quoted as libuv quotes it for
 * Node's spawn, so the C runtime of the program reads it back unchanged.
 */
export function quoteWindowsArgument(argument) {
  if (argument.includes("\0")) throw new Error("A Windows command-line argument cannot contain a NUL character.");
  if (argument === "") return '""';
  if (!/[ \t"]/.test(argument)) return argument;
  if (!/["\\]/.test(argument)) return `"${argument}"`;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") { backslashes += 1; continue; }
    quoted += character === '"' ? "\\".repeat(backslashes * 2 + 1) + '"' : "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function windowsCommandLine(file, args) {
  return [file, ...args].map(quoteWindowsArgument).join(" ");
}

/**
 * The argv a Windows program's C runtime reads from its command line: the
 * program name up to the first blank outside quotes (quotes toggle, no
 * escapes), then arguments with the backslash-quote rules (and `""` inside
 * quotes as one quote).
 */
export function parseWindowsCommandLine(line) {
  const args = [];
  const blank = (character) => character === " " || character === "\t";
  let index = 0;
  let program = "";
  // The program name: quotes toggle anywhere in it, backslashes are literal.
  for (let quoted = false; index < line.length && (quoted || !blank(line[index])); index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else program += line[index];
  }
  args.push(program);
  for (;;) {
    while (index < line.length && blank(line[index])) index += 1;
    if (index >= line.length) return args;
    let argument = "";
    let quoted = false;
    while (index < line.length && (quoted || !blank(line[index]))) {
      if (line[index] === "\\") {
        let count = 0;
        while (line[index] === "\\") { count += 1; index += 1; }
        if (line[index] === '"') {
          argument += "\\".repeat(count >> 1);
          if (count % 2) { argument += '"'; index += 1; }
        } else {
          argument += "\\".repeat(count);
        }
      } else if (line[index] === '"') {
        if (quoted && line[index + 1] === '"') { argument += '"'; index += 2; }
        else { quoted = !quoted; index += 1; }
      } else {
        argument += line[index++];
      }
    }
    args.push(argument);
  }
}

/**
 * `spawn` for a program whose whole process tree must end together. POSIX:
 * exactly `spawn(command, args, options)`; a caller that wants a process
 * group passes `detached: true` as before. Windows: the program runs inside
 * the helper's job (a .cmd/.bat as `codexLaunchCommand` starts it), and the
 * returned child is the helper. Without the helper, the program is spawned
 * directly as before, and only it can be ended. A shim whose script runs on
 * this Electron gets ELECTRON_RUN_AS_NODE=1 (see providerLaunchCommand).
 */
export function spawnTree(command, args, spawnOptions = {}, treeOptions = {}) {
  const platform = treeOptions.platform ?? process.platform;
  const spawnProcess = treeOptions.spawn ?? spawn;
  if (platform !== "win32") return spawnProcess(command, args, spawnOptions);
  const env = treeOptions.env ?? spawnOptions.env ?? process.env;
  const launch = providerLaunchCommand(command, args, {
    platform, env, cwd: spawnOptions.cwd, exists: treeOptions.exists, launchOptions: treeOptions.launchOptions, electron: treeOptions.electron,
  });
  const resolved = launch.resolved;
  const helper = treeOptions.helperPath === undefined ? processTreeHelperPath({ platform, env: treeOptions.helperEnv }) : treeOptions.helperPath;
  // An npm shim's script on this Electron needs ELECTRON_RUN_AS_NODE; the helper passes its environment on.
  const childEnv = launch.envAdditions ? { ...(spawnOptions.env ?? process.env), ...launch.envAdditions } : spawnOptions.env;
  const direct = {
    ...spawnOptions,
    ...(childEnv ? { env: childEnv } : {}),
    windowsHide: true,
    ...(launch.argv0 ? { argv0: launch.argv0 } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
  // Not found: the path providerLaunchCommand gives (one that cannot exist, for a bare name), so the caller sees Node's own ENOENT.
  if (resolved && !helper && (treeOptions.requireHelper ?? packagedApp())) {
    throw new ProviderInstallError(path.win32.basename(launch.file), processTreeHelperRefusal() ?? `${PROCESS_TREE_HELPER_NAME} is missing from this installation.`);
  }
  if (!helper || !resolved) return remember(spawnProcess(launch.file, launch.args, direct), null);
  const wait = waitArgument(treeOptions);
  const commandLine = launch.windowsVerbatimArguments
    ? [launch.argv0 ?? quoteWindowsArgument(launch.file), ...launch.args].join(" ")
    : windowsCommandLine(launch.file, launch.args);
  const { argv0: _argv0, windowsVerbatimArguments: _verbatim, ...helperOptions } = spawnOptions;
  return remember(spawnProcess(helper, ["spawn", launch.file, commandLine, ...wait], { ...helperOptions, ...(childEnv ? { env: childEnv } : {}), windowsHide: true }), helper);
}

/** An installed app ships the helper, so nothing it starts runs outside the job; a development run may not have built it. */
function packagedApp() {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return Boolean(resources.trim()) && !/[\\/]node_modules[\\/]/.test(resources);
}

/** Windows: keep a spawned child findable by pid until it exits; `helper` null for a direct child. */
function remember(child, helper) {
  if (Number.isSafeInteger(child.pid) && child.pid > 0) {
    const pid = child.pid;
    liveTrees.set(pid, { child, helper });
    child.once("exit", () => { if (liveTrees.get(pid)?.child === child) liveTrees.delete(pid); });
  }
  return child;
}

/** True when `child` is a live tree in the helper's job (Windows), so ending it ends what it started. */
export function isProcessTree(child) {
  const live = child && liveTrees.get(child.pid);
  return Boolean(live && live.child === child && live.helper);
}

function runHelper(helper, args, options) {
  // A kill waits up to its bound for the job to empty: the timeout leaves room for it.
  const timeout = Math.max(HELPER_TIMEOUT_MS, (options.unkillableAfterMs ?? PROCESS_TREE_UNKILLABLE_AFTER_MS) + 10_000);
  const run = options.runHelper ?? ((file, helperArgs) => spawnSync(file, helperArgs, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout,
  }));
  return run(helper, args);
}

/**
 * Birth identity of a live process: POSIX `ps -o lstart=` exactly as the
 * daemon has always read it; Windows `win32-ft:<creation FILETIME>`. null is
 * verified absence; undefined is "could not be verified".
 */
export function processBirth(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      // argv/command is mutable (`claude` rewrites its process title after init),
      // so it cannot be part of a durable birth identity. PID is carried beside
      // this value; the kernel-recorded start time distinguishes PID reuse while
      // remaining stable for the process lifetime.
      const identity = (options.execFileSync ?? execFileSync)(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...(options.timeout ? { timeout: options.timeout } : {}) },
      ).trim();
      return identity || undefined;
    } catch {
      return probeAbsence(pid, options);
    }
  }
  const info = windowsProcessInfo(pid, options);
  if (info === null) return null;
  if (info === undefined) return probeAbsence(pid, options);
  // A process that has ended still has a record while any handle to it is open (the parent's own
  // handle, for one). The helper waited on the process itself: it is gone, not a live birth.
  if (info.exited) return null;
  return `${WINDOWS_BIRTH_PREFIX}${info.creationTime}`;
}

function probeAbsence(pid, options) {
  try {
    (options.probe ?? ((target) => process.kill(target, 0)))(pid);
    return undefined;
  } catch (error) {
    return error?.code === "ESRCH" ? null : undefined;
  }
}

/**
 * What Windows knows of a process: `{ pid, parentPid, creationTime, exited,
 * image, commandLine }`, null when no process has that pid, undefined when it cannot be
 * read (no helper, access denied, helper failure). Windows only.
 */
export function windowsProcessInfo(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) return undefined;
  const helper = options.helperPath === undefined ? processTreeHelperPath({ platform: "win32", env: options.helperEnv }) : options.helperPath;
  if (!helper) return undefined;
  const result = runHelper(helper, ["info", String(pid)], options);
  if (!result || result.error) return undefined;
  if (result.status === 2) return null;
  if (result.status !== 0) return undefined;
  try {
    const info = JSON.parse(String(result.stdout).trim());
    if (info?.pid !== pid || typeof info.creationTime !== "string" || !isCreationTime(info.creationTime)) return undefined;
    return {
      pid,
      parentPid: Number.isSafeInteger(info.parentPid) ? info.parentPid : null,
      creationTime: info.creationTime,
      exited: info.exited === true,
      image: typeof info.image === "string" ? info.image : null,
      commandLine: typeof info.commandLine === "string" ? info.commandLine : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Send `signal` to the process tree led by `pid`.
 *
 * POSIX: exactly the daemon's former `defaultSignalProcess`: the process
 * group first, then the pid alone when the group is already gone (with
 * `groupOnly`, only the group, as the probes that stop an npm wrapper's
 * group did).
 *
 * Windows: there are no signals; every signal ends the tree. A tree this
 * process started and still holds is ended through its job. Any other pid is
 * ended only with `identity`, its recorded birth: through its job when the
 * helper started it, else that one process after the helper checked its
 * creation time while holding it. Without a recorded birth nothing is
 * ended. A child spawned without the helper is ended alone, as before.
 * Returns false when the tree was not ended on Windows (nothing matched, or
 * it is unkillable: see `signalTreeOutcome`), or when `groupOnly` found no
 * group on POSIX; otherwise true.
 */
export function signalTree(pid, signal, options = {}) {
  return signalTreeOutcome(pid, signal, options) === "ended";
}

/**
 * `signalTree`, with the Windows outcome told apart: "ended"; "unkillable"
 * when the job (or the one process) was ended but processes were still
 * there when the helper's bounded wait (`unkillableAfterMs`) ran out; "none"
 * when nothing was ended. POSIX gives "ended" or "none".
 */
export function signalTreeOutcome(pid, signal, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const kill = options.kill ?? ((target, sent) => process.kill(target, sent));
    try {
      kill(-pid, signal);
      return "ended";
    } catch {
      // groupOnly: the group is gone, and the pid alone may be someone else's.
      if (options.groupOnly) return "none";
      // Fall through to the direct child pid. The process group may already be
      // gone while the child exit event is still in flight.
    }
    try {
      kill(pid, signal);
    } catch {
      // Already terminal. The observed exit promise remains authoritative.
    }
    return "ended";
  }
  return endWindowsTree(pid, options);
}

/** What a kill reported, as signalTreeOutcome names it. */
function killOutcome(ended) {
  return ended === "ended" || ended === "unkillable" ? ended : "none";
}

function endWindowsTree(pid, options) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "none";
  const identity = options.identity?.trim() || null;
  // The caller's own child decides: a held tree under the same pid is another
  // process once the caller's child has exited.
  const registered = (options.liveTrees ?? liveTrees).get(pid);
  const live = registered && (!options.child || registered.child === options.child) ? registered : undefined;
  const child = options.child ?? live?.child;
  const held = child && child.pid === pid && child.exitCode === null && child.signalCode === null;
  const helper = live?.helper
    ?? (options.helperPath === undefined ? processTreeHelperPath({ platform: "win32", env: options.helperEnv }) : options.helperPath);
  if (held) {
    // Node holds this child's handle, so its pid cannot belong to anyone else.
    const birth = live?.helper || (identity && !options.child)
      ? processBirth(pid, { ...options, platform: "win32", helperPath: helper })
      : undefined;
    // A child found only by its pid is the one the caller recorded only if its
    // birth is proved to be that record; unreadable is not proof, so then the
    // helper's own handle-held check of the recorded birth decides.
    if (identity && !options.child && birth !== identity) {
      if (isWindowsBirth(birth) || !live?.helper || !isWindowsBirth(identity)) return "none";
      const outcome = killOutcome(killByBirth(helper, pid, identity, options));
      if (outcome === "unkillable") unkillableTrees.add(child);
      return outcome;
    }
    if (live?.helper && isWindowsBirth(birth)) {
      const ended = killByBirth(helper, pid, birth, options);
      // Unkillable: the helper process stays, and the answer is kept for this child.
      if (ended === "unkillable") unkillableTrees.add(child);
      if (ended === "ended" || ended === "unkillable") return ended;
      if (ended === "absent") return "none";
    }
    // The helper could not be asked: a helper's own exit closes its job, so
    // child.kill() ends the tree too.
    try { return child.kill() !== false ? "ended" : "none"; } catch { return "none"; }
  }
  if (!helper || !isWindowsBirth(identity)) return "none";
  return killOutcome(killByBirth(helper, pid, identity, options));
}

function killByBirth(helper, pid, identity, options) {
  const creation = WINDOWS_BIRTH.exec(identity.trim())[1];
  const result = runHelper(helper, ["kill", String(pid), creation, ...waitArgument(options)], options);
  // The helper ends the job first and then waits for it to empty: a timeout
  // means the tree is being ended, not that it could not be. A held tree's
  // helper still reports the end of its bounded wait with its exit code.
  if (result?.error?.code === "ETIMEDOUT") return "ended";
  if (!result || result.error) return "unknown";
  // 0: the job was ended and is empty; 5: the one process with that birth was ended.
  if (result.status === 0 || result.status === 5) return "ended";
  // 4: ended, but processes were still there when the helper's wait ran out.
  if (result.status === 4) return "unkillable";
  if (result.status === 2) return "absent";
  return "unknown";
}

/**
 * Number of live processes in the job of the helper `pid` born `identity`,
 * 0 when the job is gone, undefined when it cannot be read. Windows only.
 */
export function windowsTreeSize(pid, identity, options = {}) {
  const helper = options.helperPath === undefined ? processTreeHelperPath({ platform: "win32", env: options.helperEnv }) : options.helperPath;
  if (!helper || !isWindowsBirth(identity) || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  const result = runHelper(helper, ["query", String(pid), WINDOWS_BIRTH.exec(identity.trim())[1]], options);
  if (!result || result.error) return undefined;
  if (result.status === 2) return 0;
  if (result.status !== 0) return undefined;
  const count = Number(String(result.stdout).trim());
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** Settles on the process's exit only: an 'error' (an IPC send failing, a kill failing) is not one. */
function exitedPromise(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once("exit", () => resolve()); });
}

/** Resolves true when `promise` settles first, false after `ms`; the timer never outlives the race. */
async function settlesWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a tree this process started. Graceful: POSIX sends SIGTERM to the
 * group as before; Windows, which has no signal, calls `requestStop` (the
 * child's stop message: an IPC message or a stdin frame). Either way the
 * child gets `graceMs` to exit, then the tree is killed (POSIX: SIGKILL to
 * the group). Resolves true when the tree is gone: the child has exited and,
 * on Windows, its job did not report processes it could not end. Use
 * `terminateTreeOutcome` to tell an unkillable tree from a running one.
 */
export async function terminateTree(child, options = {}) {
  return (await terminateTreeOutcome(child, options)) === "exited";
}

/**
 * `terminateTree`, with its outcome named: "exited" (the tree is gone);
 * "unkillable" (Windows: the job was ended, but processes were still in it
 * when the helper's bounded wait ran out; they may never end, so do not
 * wait for them); "running" (the child had not exited within `killWaitMs`).
 */
export async function terminateTreeOutcome(child, options = {}) {
  // A stop message that cannot be sent is reported as an 'error' on the next
  // tick; while this runs it is neither an exit nor an uncaught exception.
  const ignoreError = () => {};
  child.on("error", ignoreError);
  try {
    return await terminateChildTree(child, options);
  } finally {
    child.off("error", ignoreError);
  }
}

async function terminateChildTree(child, options) {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 5_000;
  const exited = exitedPromise(child);
  const pid = child.pid;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  // A Windows helper exits with this code instead of its program's when the job it ended did not empty;
  // a kill's earlier unkillable answer about this child stands too.
  const exitOutcome = () => (platform === "win32" && (child.exitCode === PROCESS_TREE_UNKILLABLE_EXIT_CODE || unkillableTrees.has(child))
    ? "unkillable"
    : "exited");
  if (!Number.isSafeInteger(pid) || pid < 1) return hasExited() ? exitOutcome() : "running";
  if (hasExited()) {
    // Already exited: no stop request (it could only fail), only what is
    // left of its POSIX group; a Windows helper's exit already emptied its job.
    if (platform !== "win32") signalTree(pid, "SIGKILL", { ...options, groupOnly: true });
    return exitOutcome();
  }
  if (options.graceful) {
    if (platform === "win32") {
      try { options.requestStop?.(); } catch { /* the stop message is best effort; the kill below is not */ }
    } else {
      signalTree(pid, "SIGTERM", options);
    }
    if (await settlesWithin(exited, graceMs)) {
      // The leader exited; on POSIX its group may still hold children. Only
      // the group: the leader's own pid may already be someone else's.
      if (platform !== "win32") {
        signalTree(pid, "SIGKILL", { ...options, groupOnly: true });
      }
      return exitOutcome();
    }
  }
  const signalled = signalTreeOutcome(pid, platform === "win32" ? "SIGTERM" : "SIGKILL", { ...options, child });
  await settlesWithin(exited, options.killWaitMs ?? 5_000);
  // The kill's answer wins over the helper's exit code: once a kill has ended
  // the job, the job no longer lists the processes the kill waited on, so the
  // helper cannot see one that is still there.
  if (signalled === "unkillable") {
    unkillableTrees.add(child);
    return "unkillable";
  }
  return hasExited() ? exitOutcome() : "running";
}
