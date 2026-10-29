import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

import { codexLaunchCommand } from "./codex-executable.mjs";

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

/**
 * What to spawn for the provider program `command <args>`.
 *
 * POSIX: `{ file: command, args }`, nothing else. Windows: `resolved` is the
 * program found for `command` (null when none was), and `file`/`args` (with
 * `argv0` and `windowsVerbatimArguments` for a batch file that goes through
 * cmd.exe) are what starts it. `envAdditions` is `{ ELECTRON_RUN_AS_NODE: "1" }`
 * when an npm shim's script runs on this Electron, else null.
 */
export function providerLaunchCommand(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args: [...args], resolved: command, envAdditions: null };
  const env = options.env ?? process.env;
  const resolved = resolveWindowsCommand(command, { env, cwd: options.cwd, exists: options.exists });
  const execPath = options.launchOptions?.execPath ?? process.execPath;
  const launch = codexLaunchCommand(resolved ?? command, args, { ...options.launchOptions, execPath, platform, env });
  const electron = options.electron ?? Boolean(process.versions.electron);
  const runsShimOnElectron = electron && resolved !== null && resolved !== execPath && launch.file === execPath;
  return { ...launch, resolved, envAdditions: runsShimOnElectron ? { ELECTRON_RUN_AS_NODE: "1" } : null };
}

/**
 * `execFile` for a provider program, for a version or status check. POSIX:
 * exactly `execFile(command, args, options, callback)`. Windows: the program
 * `providerLaunchCommand` names, with no console window.
 */
export function execProviderFile(command, args, options, callback, providerOptions = {}) {
  const platform = providerOptions.platform ?? process.platform;
  const run = providerOptions.execFile ?? execFile;
  if (platform !== "win32") return run(command, args, options, callback);
  const launch = providerLaunchCommand(command, args, { ...providerOptions, platform, env: options.env, cwd: options.cwd });
  return run(launch.file, launch.args, {
    ...options,
    ...(launch.envAdditions ? { env: { ...(options.env ?? process.env), ...launch.envAdditions } } : {}),
    windowsHide: true,
    ...(launch.argv0 ? { argv0: launch.argv0 } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }, callback);
}
