import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

// One hit per PATH: the desktop runs git with its imported PATH and with its own process PATH.
const cached = new Map();

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

/** A folder as Windows reads it: either slash, optional quotes; null unless it is absolute (a drive or a UNC share). */
function absoluteFolder(entry) {
  const folder = String(entry ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\//g, "\\");
  return /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(folder) ? folder : null;
}

/** Each absolute folder of a Windows PATH value. A relative entry (cmd.exe's current-folder rule) is never searched. */
function pathFolders(value) {
  return String(value ?? "").split(";").map(absoluteFolder).filter(Boolean);
}

/**
 * A string value of a registry key, unexpanded, or null when it is not there.
 * Read with `reg export`, which writes UTF-16, so a folder name outside the
 * console's code page reads back whole (`reg query` output would not), as
 * daemon-pipe-native.mjs reads its install folder.
 */
export function readRegistryValue(key, name, env = process.env) {
  const reg = windowsSystemTool("reg.exe", env);
  let folder = null;
  try {
    folder = mkdtempSync(path.win32.join(tmpdir(), "letagents-git-"));
    const exported = path.win32.join(folder, "key.reg");
    execFileSync(reg, ["export", key, exported, "/y"], {
      cwd: path.win32.dirname(reg),
      stdio: "ignore",
      timeout: REGISTRY_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseRegistryExport(readFileSync(exported), name);
  } catch {
    return null;
  } finally {
    // Best effort: a scanner holding the export must not undo what was read.
    try { if (folder) rmSync(folder, { recursive: true, force: true }); } catch { /* left in the user's temp folder */ }
  }
}

/**
 * The string value `name` in a `reg export` file (UTF-16LE with a byte-order
 * mark): `"Name"="C:\\a"` for REG_SZ, or `"Name"=hex(2):43,00,...` (UTF-16LE
 * bytes, wrapped over lines ending in a backslash) for REG_EXPAND_SZ.
 */
export function parseRegistryExport(bytes, name) {
  const text = (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8"))
    .replace(/\\\r?\n[ \t]*/g, "");
  const wanted = name.toLowerCase();
  for (const line of text.split(/\r?\n/)) {
    const match = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line.trim());
    if (!match || match[1].replace(/\\(.)/g, "$1").toLowerCase() !== wanted) continue;
    const string = /^"((?:[^"\\]|\\.)*)"$/.exec(match[2]);
    if (string) return string[1].replace(/\\(.)/g, "$1");
    const expand = /^hex\(2\):([0-9a-fA-F,\s]*)$/.exec(match[2]);
    if (!expand) return null;
    const hex = expand[1].replace(/[,\s]/g, "");
    return Buffer.from(hex, "hex").toString("utf16le").replace(/\0+$/, "");
  }
  return null;
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
    const root = absoluteFolder(lookup(env, name));
    if (root) yield path.win32.join(root, "Git", "cmd", "git.exe");
  }
  const localAppData = absoluteFolder(lookup(env, "LOCALAPPDATA"));
  if (localAppData) yield path.win32.join(localAppData, "Programs", "Git", "cmd", "git.exe");
  for (const [key, name] of REGISTRY_INSTALL_PATHS) {
    const value = readRegistry(key, name);
    const root = value ? absoluteFolder(expandWindowsVariables(value, env)) : null;
    if (root) yield path.win32.join(root, "cmd", "git.exe");
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
  const hit = cached.get(key);
  if (hit !== undefined && exists(hit)) return hit;
  cached.delete(key);
  for (const candidate of windowsGitCandidates(env, readRegistry)) {
    // Built only as <folder>\git.exe; the check keeps a batch file out whatever changes above.
    if (/\.exe$/i.test(candidate) && exists(candidate)) {
      cached.set(key, candidate);
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
  cached.clear();
}
