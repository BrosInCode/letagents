import { win32 } from "node:path";

import { DAEMON_STATE_DIR_ENV, isWindowsPipePath, resolveDaemonProofPath } from "../../../../../shared/daemon-endpoint.mjs";

/**
 * What a Windows program needs in its environment to start and to work: the
 * Windows and program folders, the command processor, the program
 * extensions, the temp folders and the user's profile folders. Without
 * SystemRoot, for one, a program cannot open a network connection. None of
 * them holds a credential. An environment that keeps only named variables
 * (an OpenCode runtime's, a rental's, a Codex check's) keeps these on
 * Windows too; off Windows none of them is added.
 */
export const WINDOWS_SYSTEM_ENVIRONMENT_KEYS: readonly string[] = [
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
];

/**
 * The value of `key` in `source`. Windows reads variable names without case,
 * and a copy of process.env there keeps each name as Windows spelled it
 * (`Path`, `SystemRoot`), so on Windows the name is matched without case.
 */
export function environmentValue(source: Readonly<NodeJS.ProcessEnv>, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (source[key] !== undefined || platform !== "win32") return source[key];
  const folded = key.toLowerCase();
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && name.toLowerCase() === folded) return value;
  }
  return undefined;
}

/** Whether `key` is one of WINDOWS_SYSTEM_ENVIRONMENT_KEYS, without case. False off Windows. */
export function isWindowsSystemEnvironmentKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const folded = key.toLowerCase();
  return WINDOWS_SYSTEM_ENVIRONMENT_KEYS.some((name) => name.toLowerCase() === folded);
}

/**
 * The Windows system variables of `source`, each under its usual spelling,
 * so a later variable of the same name replaces it instead of standing
 * beside it. Empty off Windows.
 */
export function windowsSystemEnvironment(source: Readonly<NodeJS.ProcessEnv>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "win32") return {};
  const environment: Record<string, string> = {};
  for (const key of WINDOWS_SYSTEM_ENVIRONMENT_KEYS) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/**
 * The variables that name a user's home and temp folder, every one of them
 * pointed at `folder`: a home of its own for a program that must not read or
 * write the user's. POSIX: HOME and TMPDIR. Windows adds what programs read
 * there instead: USERPROFILE (os.homedir()), HOMEDRIVE and HOMEPATH (Git),
 * APPDATA and LOCALAPPDATA (per-user settings), TEMP and TMP.
 */
export function shadowProfileEnvironment(folder: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "win32") return { HOME: folder, TMPDIR: folder };
  const { root } = win32.parse(folder);
  return {
    HOME: folder,
    TMPDIR: folder,
    USERPROFILE: folder,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: folder.slice(root.length - (/[\\/]$/.test(root) ? 1 : 0)) || "\\",
    APPDATA: folder,
    LOCALAPPDATA: folder,
    TEMP: folder,
    TMP: folder,
  };
}

/**
 * Windows: where an MCP worker finds the daemon's state folder, for a worker
 * whose USERPROFILE is not the daemon's. A worker knows the daemon only by its
 * pipe name, and proves itself with the proof file in that folder; without
 * this it looks only in its own profile. The daemon runs the adapters, so it
 * knows the folder of the pipe it serves. Empty off Windows, and for a socket
 * that is no pipe of this daemon.
 */
export function daemonStateDirEnvironment(socketPath: string | null | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "win32" || !socketPath || !isWindowsPipePath(socketPath)) return {};
  const proofPath = resolveDaemonProofPath(socketPath);
  return proofPath ? { [DAEMON_STATE_DIR_ENV]: win32.dirname(proofPath) } : {};
}
