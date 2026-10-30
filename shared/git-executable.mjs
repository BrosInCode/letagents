import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

import { windowsSystemTool } from "./owner-private-fs.mjs";
import { notFoundPath } from "./provider-executable.mjs";

// The one answer to "which git does LetAgents run". On POSIX it is the bare
// name `git`, exactly as before: the spawn looks it up on the child's PATH.
//
// On Windows a process gets its PATH once, when it starts, and Explorer keeps
// its own old copy until it is told the environment changed. So an app that
// started before Git for Windows was installed (or was started from a stale
// Explorer) can have no Git on its PATH while Git is installed. The resolver
// then reads the PATH the registry holds now, and then the places Git for
// Windows installs to. It returns an absolute git.exe, never git.cmd or a
// batch file (only cmd.exe could run those), and the caller spawns it with no
// shell. A bare `git` is never spawned on Windows: Windows looks for it in the
// working directory first, and that is the user's repository.
//
// A hit is cached while it still exists; a miss is not, so Git installed
// while the app is open is found on the next call, with no restart.

export const GIT_FOR_WINDOWS_DOWNLOAD_URL = "https://git-scm.com/download/win";
export const GIT_NOT_FOUND_MESSAGE = "Git is not installed or not found. "
  + `Install Git for Windows from ${GIT_FOR_WINDOWS_DOWNLOAD_URL}, then try again.`;

// Windows builds a new process's PATH as the machine PATH, then the user PATH.
const REGISTRY_PATHS = [
  ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Path"],
  ["HKCU\\Environment", "Path"],
];
const REGISTRY_INSTALL_PATHS = [
  ["HKLM\\SOFTWARE\\GitForWindows", "InstallPath"],
  ["HKCU\\SOFTWARE\\GitForWindows", "InstallPath"],
];
const REGISTRY_TIMEOUT_MS = 5_000;

let cached = null;

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

/** A variable of a Windows environment, by its name in any case. */
function lookup(env, name) {
  if (typeof env[name] === "string") return env[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && typeof value === "string") return value;
  }
  return undefined;
}

/** `%NAME%` replaced by its value; an unknown name stays as it is. */
export function expandWindowsVariables(value, env) {
  return value.replace(/%([^%;]+)%/g, (whole, name) => lookup(env, name) ?? whole);
}

function isAbsoluteFolder(entry) {
  return /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(entry);
}

/** Each absolute folder of a Windows PATH value. A relative entry (cmd.exe's current-folder rule) is never searched. */
function pathFolders(value) {
  return String(value ?? "").split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(isAbsoluteFolder);
}

/** A string value from `reg.exe query`, unexpanded, or null when it is not there. */
export function readRegistryValue(key, name, env = process.env) {
  const reg = windowsSystemTool("reg.exe", env);
  let output;
  try {
    output = execFileSync(reg, ["query", key, "/v", name], {
      cwd: path.win32.dirname(reg),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REGISTRY_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  return parseRegistryQuery(output, name);
}

/** The string value `name` in `reg.exe query` output: `    Path    REG_EXPAND_SZ    C:\\a;%USERPROFILE%\\b`. */
export function parseRegistryQuery(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s+${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, "im").exec(output);
  return match ? match[1] : null;
}

/** Every git.exe to try, in order, read lazily: the registry is read only when the PATH has no Git. */
function* windowsGitCandidates(env, readRegistry) {
  const inFolder = (folder) => path.win32.join(folder, "git.exe");
  // a. The PATH this process (or the caller's environment) has now.
  for (const folder of pathFolders(env.PATH ?? env.Path ?? lookup(env, "PATH"))) yield inFolder(folder);
  // b. The PATH the registry holds now, which a new process would get.
  for (const [key, name] of REGISTRY_PATHS) {
    const value = readRegistry(key, name);
    if (value) for (const folder of pathFolders(expandWindowsVariables(value, env))) yield inFolder(folder);
  }
  // c. Where Git for Windows installs: for all users, for one user, and where its installer says it did.
  for (const name of ["ProgramFiles", "ProgramW6432"]) {
    const root = lookup(env, name);
    if (root && isAbsoluteFolder(root)) yield path.win32.join(root, "Git", "cmd", "git.exe");
  }
  const localAppData = lookup(env, "LOCALAPPDATA");
  if (localAppData && isAbsoluteFolder(localAppData)) yield path.win32.join(localAppData, "Programs", "Git", "cmd", "git.exe");
  for (const [key, name] of REGISTRY_INSTALL_PATHS) {
    const value = readRegistry(key, name);
    const root = value ? expandWindowsVariables(value, env).trim().replace(/^"(.*)"$/, "$1") : null;
    if (root && isAbsoluteFolder(root)) yield path.win32.join(root, "cmd", "git.exe");
  }
}

/**
 * The git to run. POSIX: "git". Windows: the absolute path of git.exe, or
 * null when Git for Windows is in none of the places above.
 */
export function resolveGitExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "git";
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const readRegistry = options.readRegistry ?? ((key, name) => readRegistryValue(key, name, env));
  const key = String(env.PATH ?? env.Path ?? lookup(env, "PATH") ?? "");
  if (cached?.key === key && exists(cached.path)) return cached.path;
  cached = null;
  for (const candidate of windowsGitCandidates(env, readRegistry)) {
    // Built only as <folder>\git.exe; the check keeps a batch file out whatever changes above.
    if (/\.exe$/i.test(candidate) && exists(candidate)) {
      cached = { key, path: candidate };
      return candidate;
    }
  }
  return null;
}

/**
 * What to spawn for git, with no shell. POSIX: "git". Windows: the git.exe
 * resolveGitExecutable finds, else a path that cannot exist, so the spawn
 * fails with ENOENT as a missing Git always did, and never runs a git.exe
 * from the working directory.
 */
export function gitSpawnFile(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "git";
  return resolveGitExecutable(options) ?? notFoundPath("git.exe", options.env ?? process.env);
}

export function resetGitExecutableCacheForTests() {
  cached = null;
}
