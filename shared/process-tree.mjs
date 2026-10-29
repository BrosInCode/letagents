import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { codexLaunchCommand } from "./codex-executable.mjs";

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

export const PROCESS_TREE_HELPER_NAME = "letagents-process-tree.exe";
/** The birth identity of a Windows process: its creation FILETIME in decimal. */
export const WINDOWS_BIRTH_PREFIX = "win32-ft:";
const WINDOWS_BIRTH = /^win32-ft:([1-9]\d{0,19})$/;
const HELPER_TIMEOUT_MS = 10_000;

/** Children this process started through the helper and that have not exited. */
const liveTrees = new Map();

export function isWindowsBirth(identity) {
  return typeof identity === "string" && WINDOWS_BIRTH.test(identity.trim());
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
 * the packaged app ships it, then the local build beside its source.
 */
export function processTreeHelperPath(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const resourcesPath = options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  const arch = options.arch ?? process.arch;
  const candidates = [];
  const configured = env.LETAGENTS_PROCESS_TREE_HELPER?.trim();
  if (configured) {
    // A configured helper that is missing is an error to see, not a reason to use another.
    return path.win32.isAbsolute(configured) && exists(configured) ? configured : null;
  }
  if (resourcesPath.trim()) candidates.push(path.win32.join(resourcesPath, "app", "runtime", PROCESS_TREE_HELPER_NAME));
  if (options.includeLocalBuild !== false) {
    candidates.push(fileURLToPath(new URL(`../apps/desktop/native/win-process-tree/build/${arch === "arm64" ? "arm64" : "x64"}/${PROCESS_TREE_HELPER_NAME}`, import.meta.url)));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
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
 * program name up to the next quote or blank, then arguments with the
 * backslash-quote rules (and `""` inside quotes as one quote).
 */
export function parseWindowsCommandLine(line) {
  const args = [];
  const blank = (character) => character === " " || character === "\t";
  let index = 0;
  let program = "";
  if (line[index] === '"') {
    index += 1;
    while (index < line.length && line[index] !== '"') program += line[index++];
    if (index < line.length) index += 1;
  } else {
    while (index < line.length && !blank(line[index])) program += line[index++];
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
 * The absolute program a Windows spawn of `command` runs, or null. A bare
 * name is looked up on PATH only, never in the working directory (the
 * user's repository); a name without an extension gets .com, .exe, .cmd,
 * then .bat, as cmd.exe would try them.
 */
export function resolveWindowsCommand(command, options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const { win32 } = path;
  const names = (base) => (win32.extname(base) ? [base] : [".com", ".exe", ".cmd", ".bat"].map((extension) => base + extension));
  if (win32.isAbsolute(command)) return names(command).find(exists) ?? null;
  if (/[\\/]/.test(command)) return names(win32.resolve(options.cwd ?? process.cwd(), command)).find(exists) ?? null;
  for (const entry of (env.PATH ?? env.Path ?? "").split(";").map((value) => value.trim()).filter(Boolean)) {
    if (!win32.isAbsolute(entry)) continue;
    const found = names(win32.join(entry, command)).find(exists);
    if (found) return found;
  }
  return null;
}

/**
 * `spawn` for a program whose whole process tree must end together. POSIX:
 * exactly `spawn(command, args, options)`; a caller that wants a process
 * group passes `detached: true` as before. Windows: the program runs inside
 * the helper's job (a .cmd/.bat as `codexLaunchCommand` starts it), and the
 * returned child is the helper. Without the helper, the program is spawned
 * directly as before, and only it can be ended.
 */
export function spawnTree(command, args, spawnOptions = {}, treeOptions = {}) {
  const platform = treeOptions.platform ?? process.platform;
  const spawnProcess = treeOptions.spawn ?? spawn;
  if (platform !== "win32") return spawnProcess(command, args, spawnOptions);
  const env = treeOptions.env ?? spawnOptions.env ?? process.env;
  const resolved = resolveWindowsCommand(command, { env, cwd: spawnOptions.cwd, exists: treeOptions.exists });
  const launch = codexLaunchCommand(resolved ?? command, args, { ...treeOptions.launchOptions, platform, env });
  const helper = treeOptions.helperPath === undefined ? processTreeHelperPath({ platform, env: treeOptions.helperEnv }) : treeOptions.helperPath;
  const direct = {
    ...spawnOptions,
    windowsHide: true,
    ...(launch.argv0 ? { argv0: launch.argv0 } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
  // Not found: spawn it as given, so the caller sees Node's own ENOENT.
  if (!helper || !resolved) return remember(spawnProcess(launch.file, launch.args, direct), null);
  const commandLine = launch.windowsVerbatimArguments
    ? [launch.argv0 ?? quoteWindowsArgument(launch.file), ...launch.args].join(" ")
    : windowsCommandLine(launch.file, launch.args);
  const { argv0: _argv0, windowsVerbatimArguments: _verbatim, ...helperOptions } = spawnOptions;
  return remember(spawnProcess(helper, ["spawn", launch.file, commandLine], { ...helperOptions, windowsHide: true }), helper);
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
  const run = options.runHelper ?? ((file, helperArgs) => spawnSync(file, helperArgs, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: HELPER_TIMEOUT_MS,
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
    if (info?.pid !== pid || typeof info.creationTime !== "string" || !/^[1-9]\d{0,19}$/.test(info.creationTime)) return undefined;
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
 * Returns false when nothing was ended on Windows, or when `groupOnly` found
 * no group on POSIX; otherwise true.
 */
export function signalTree(pid, signal, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const kill = options.kill ?? ((target, sent) => process.kill(target, sent));
    try {
      kill(-pid, signal);
      return true;
    } catch {
      // groupOnly: the group is gone, and the pid alone may be someone else's.
      if (options.groupOnly) return false;
      // Fall through to the direct child pid. The process group may already be
      // gone while the child exit event is still in flight.
    }
    try {
      kill(pid, signal);
    } catch {
      // Already terminal. The observed exit promise remains authoritative.
    }
    return true;
  }
  return endWindowsTree(pid, options);
}

function endWindowsTree(pid, options) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const live = (options.liveTrees ?? liveTrees).get(pid);
  const child = live?.child ?? options.child;
  const held = child && child.pid === pid && child.exitCode === null && child.signalCode === null;
  const helper = live?.helper
    ?? (options.helperPath === undefined ? processTreeHelperPath({ platform: "win32", env: options.helperEnv }) : options.helperPath);
  if (held) {
    // Node holds this child's handle, so its pid cannot belong to anyone else.
    // A helper's own exit closes its job, so child.kill() ends the tree too.
    if (live?.helper) {
      const birth = processBirth(pid, { ...options, platform: "win32", helperPath: helper });
      if (isWindowsBirth(birth) && killByBirth(helper, pid, birth, options) === "ended") return true;
    }
    try { return child.kill() !== false; } catch { return false; }
  }
  const identity = options.identity?.trim();
  if (!helper || !isWindowsBirth(identity)) return false;
  return killByBirth(helper, pid, identity, options) === "ended";
}

function killByBirth(helper, pid, identity, options) {
  const creation = WINDOWS_BIRTH.exec(identity.trim())[1];
  const result = runHelper(helper, ["kill", String(pid), creation], options);
  if (!result || result.error) return "unknown";
  // 0: the job was ended and is empty; 5: the one process with that birth was ended;
  // 4: ended, with processes still dying after the helper's wait.
  if (result.status === 0 || result.status === 5 || result.status === 4) return "ended";
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

function exitedPromise(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function wait(ms) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/**
 * Stop a tree this process started. Graceful: POSIX sends SIGTERM to the
 * group as before; Windows, which has no signal, calls `requestStop` (the
 * child's stop message: an IPC message or a stdin frame). Either way the
 * child gets `graceMs` to exit, then the tree is killed (POSIX: SIGKILL to
 * the group). Resolves true when the child has exited.
 */
export async function terminateTree(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 5_000;
  const exited = exitedPromise(child);
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return child.exitCode !== null || child.signalCode !== null;
  if (options.graceful) {
    if (platform === "win32") {
      try { options.requestStop?.(); } catch { /* the stop message is best effort; the kill below is not */ }
    } else {
      signalTree(pid, "SIGTERM", options);
    }
    const timedOut = await Promise.race([exited.then(() => false), wait(graceMs).then(() => true)]);
    if (!timedOut) {
      // The leader exited; on POSIX its group may still hold children. Only
      // the group: the leader's own pid may already be someone else's.
      if (platform !== "win32") {
        signalTree(pid, "SIGKILL", { ...options, groupOnly: true });
      }
      return true;
    }
  }
  signalTree(pid, platform === "win32" ? "SIGTERM" : "SIGKILL", { ...options, child });
  await Promise.race([exited, wait(options.killWaitMs ?? 5_000)]);
  return child.exitCode !== null || child.signalCode !== null;
}
