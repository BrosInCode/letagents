import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { codexLaunchCommand, isWindowsBatchExecutable, parseNodeShim } from "./codex-executable.mjs";

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
// the launch says to add it to the child's environment.

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
function notFoundPath(command, env) {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "letagents-not-on-path", command);
}

/** The `node <script>` an npm or pnpm shim runs, read as codexLaunchCommand reads it; null for any other batch file. */
function nodeShimOf(program, execPath, launchOptions = {}) {
  const readFile = launchOptions.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  let text;
  try { text = readFile(program); } catch { return null; }
  return parseNodeShim(program, text, { execPath, exists: launchOptions.exists });
}

/** A Windows batch file that is not an npm or pnpm shim: only cmd.exe could start it. */
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
 * shim as the node and script it runs, followed by `args` unchanged.
 * `envAdditions` is `{ ELECTRON_RUN_AS_NODE: "1" }` when that script runs on
 * this Electron, else null. A batch file that is no such shim throws
 * ProviderBatchFileError: cmd.exe would re-read every argument, and a prompt
 * holds line breaks and quotes. Only `allowCmd: true` (spawnTree's earlier
 * behaviour for such a file) starts it through cmd.exe, with `argv0` and
 * `windowsVerbatimArguments`.
 */
export function providerLaunchCommand(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args: [...args], resolved: command, envAdditions: null };
  const env = options.env ?? process.env;
  const resolved = resolveWindowsCommand(command, { env, cwd: options.cwd, exists: options.exists });
  const execPath = options.launchOptions?.execPath ?? process.execPath;
  // Not found: a bare name given to spawn as it is would be looked for in the working directory
  // first, which is the user's repository. A path that cannot exist fails with Node's own ENOENT,
  // and is spawned as it is, so a missing `tool.cmd` is ENOENT too and never a cmd.exe error.
  if (resolved === null && isBareName(command)) {
    return { file: notFoundPath(command, env), args: [...args], resolved: null, envAdditions: null };
  }
  const program = resolved ?? command;
  // Decided before any argument is quoted for cmd.exe: a shim's script runs with no shell, anything else is refused.
  if (options.allowCmd !== true && isWindowsBatchExecutable(program, platform) && !nodeShimOf(program, execPath, options.launchOptions)) {
    throw new ProviderBatchFileError(program);
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
  const launch = providerLaunchCommand(command, args, { allowCmd: true, ...providerOptions, platform, env: options.env, cwd: options.cwd });
  return run(launch.file, launch.args, {
    ...options,
    ...(launch.envAdditions ? { env: { ...(options.env ?? process.env), ...launch.envAdditions } } : {}),
    windowsHide: true,
    ...(launch.argv0 ? { argv0: launch.argv0 } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }, callback);
}
