import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { codexLaunchCommand, isWindowsBatchExecutable, parseNodeShim } from "./codex-executable.mjs";
import { ProviderInstallError, windowsInstalledProgram } from "./provider-windows-install.mjs";

export { ProviderInstallError } from "./provider-windows-install.mjs";

// What to start for a provider program (Claude Code, Codex, OpenCode, Cursor)
// and how, one answer for every launch and every check of one. On POSIX the
// program and its arguments are exactly what the caller gave.
//
// On Windows a bare name is looked up on PATH (never in the working
// directory, which is the user's repository), and an npm `.cmd` shim, which
// Node cannot spawn without a shell, is replaced by the `node <script.js>`
// it runs (see codexLaunchCommand). When no node.exe sits beside the shim,
// that node is process.execPath. In the desktop and the supervisor daemon
// that is Electron, which runs a script only with ELECTRON_RUN_AS_NODE=1, so
// the launch says to add it to the child's environment. An npm shim of a
// native program and Cursor's own launcher are replaced by what they run
// (see provider-windows-install.mjs).

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
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

function isBareName(command) {
  return !path.win32.isAbsolute(command) && !/[\\/]/.test(command);
}

/** Where a program that is on no PATH entry is "spawned": a folder below the Windows folder that nothing makes. */
export function notFoundPath(command, env) {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "letagents-not-on-path", command);
}

/** What a batch file runs, read as codexLaunchCommand reads it, with no shell: both null for a batch file only cmd.exe can start. */
function batchProgramOf(program, execPath, env, launchOptions = {}) {
  const readFile = launchOptions.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  let text;
  try { text = readFile(program); } catch { return { nodeShim: null, installed: null }; }
  const nodeShim = parseNodeShim(program, text, { execPath, exists: launchOptions.exists });
  return { nodeShim, installed: nodeShim ? null : windowsInstalledProgram(program, text, { ...launchOptions, env }) };
}

/** A Windows batch file that is neither an npm or pnpm shim nor a known install: only cmd.exe could start it. */
export class ProviderBatchFileError extends Error {
  constructor(program) {
    super(`${path.win32.basename(program)} is a batch file that LetAgents can start only through cmd.exe, `
      + "which changes quotes, percent signs and line breaks in what it is given. "
      + "Install the program with npm, or set its LETAGENTS_*_BIN variable to its .exe.");
    this.name = "ProviderBatchFileError";
    this.code = "EPROVIDERBATCH";
  }
}

/**
 * What to spawn for the provider program `command <args>`.
 *
 * POSIX: `{ file: command, args }`, nothing else. Windows: `resolved` is the
 * program found for `command` (null when none was; a bare name then gets a
 * path that cannot exist, so the spawn fails with ENOENT and never runs a
 * program of that name from the working directory), and `file`/`args` are
 * what starts it, with no shell: a native program as it is, an npm or pnpm
 * shim as the node and script it runs, an npm shim of a native program as that
 * program, Cursor's launcher as its node.exe and index.js, each followed by
 * `args` unchanged. `envAdditions` is what the child's environment needs on
 * top of the caller's: `{ ELECTRON_RUN_AS_NODE: "1" }` when a script runs on
 * this Electron, what Cursor's launcher sets, else null. A batch file that is
 * none of these throws ProviderBatchFileError: cmd.exe would re-read every
 * argument, and a prompt holds line breaks and quotes. Only `allowCmd: true`
 * (spawnTree's earlier behaviour for such a file) starts it through cmd.exe,
 * with `argv0` and `windowsVerbatimArguments`. A known install that does not
 * hold up throws ProviderInstallError, with `allowCmd` too: cmd.exe would run
 * what was refused.
 */
export function providerLaunchCommand(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args: [...args], resolved: command, envAdditions: null };
  const env = options.env ?? process.env;
  const resolved = resolveWindowsCommand(command, { env, cwd: options.cwd, exists: options.exists });
  const execPath = options.launchOptions?.execPath ?? process.execPath;
  // Not found: spawned as it is, so the caller sees Node's own ENOENT, a missing `tool.cmd` too, and
  // never a cmd.exe error or a batch-file refusal. A bare name given to spawn would be looked for in
  // the working directory first, which is the user's repository, so it gets a path that cannot exist.
  if (resolved === null) {
    return { file: isBareName(command) ? notFoundPath(command, env) : command, args: [...args], resolved: null, envAdditions: null };
  }
  const program = resolved ?? command;
  // Decided before any argument is quoted for cmd.exe: a shim's script or a known install runs with no shell, anything else is refused.
  if (isWindowsBatchExecutable(program, platform)) {
    const { nodeShim, installed } = batchProgramOf(program, execPath, env, { exists: options.exists, ...options.launchOptions });
    if (installed) return { file: installed.file, args: [...installed.args, ...args], resolved, envAdditions: installed.envAdditions };
    if (options.allowCmd !== true && !nodeShim) throw new ProviderBatchFileError(program);
  }
  const launch = codexLaunchCommand(program, args, { ...options.launchOptions, execPath, platform, env });
  const electron = options.electron ?? Boolean(process.versions.electron);
  const runsShimOnElectron = electron && resolved !== null && resolved !== execPath && launch.file === execPath;
  return { ...launch, resolved, envAdditions: runsShimOnElectron ? { ELECTRON_RUN_AS_NODE: "1" } : null };
}

/**
 * `execFile` for a provider program, for a version or status check. POSIX:
 * exactly `execFile(command, args, options, callback)`. Windows: the program
 * `providerLaunchCommand` names, with no console window (a batch file that is
 * no npm shim through cmd.exe, as spawnTree starts one).
 */
export function execProviderFile(command, args, options, callback, providerOptions = {}) {
  const platform = providerOptions.platform ?? process.platform;
  const run = providerOptions.execFile ?? execFile;
  if (platform !== "win32") return run(command, args, options, callback);
  // A check passes fixed arguments (`--version`, a model listing), so a plain batch file may still go
  // through cmd.exe here, which refuses any quote or line break; its callers read errors from the callback.
  let launch;
  try {
    launch = providerLaunchCommand(command, args, { allowCmd: true, ...providerOptions, platform, env: options.env, cwd: options.cwd });
  } catch (error) {
    if (!(error instanceof ProviderInstallError)) throw error;
    // Nothing ran. The caller's check fails with the reason, in the place it reads a failed program's.
    setImmediate(callback, error, "", error.message);
    return new EventEmitter();
  }
  return run(launch.file, launch.args, {
    ...options,
    ...(launch.envAdditions ? { env: { ...(options.env ?? process.env), ...launch.envAdditions } } : {}),
    windowsHide: true,
    ...(launch.argv0 ? { argv0: launch.argv0 } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }, callback);
}
