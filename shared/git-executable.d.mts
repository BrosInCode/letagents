export const GIT_FOR_WINDOWS_DOWNLOAD_URL: string;
export const GIT_NOT_FOUND_MESSAGE: string;

export interface GitExecutableOptions {
  platform?: NodeJS.Platform;
  /** The environment whose PATH is searched first, and whose variables expand registry values. */
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  /** A registry string value, unexpanded, or null. Tests pass a fake; the default runs reg.exe. */
  readRegistry?: (key: string, name: string) => string | null;
}

export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string;
export function parseRegistryExport(bytes: Buffer, name: string): string | null;
export function readRegistryValue(key: string, name: string, env?: NodeJS.ProcessEnv): string | null;
/** POSIX: "git". Windows: the absolute git.exe, or null when Git for Windows is not found. */
export function resolveGitExecutable(options?: GitExecutableOptions): string | null;
/** POSIX: "git". Windows: the absolute git.exe, or a path that cannot exist (the spawn fails with ENOENT). */
export function gitSpawnFile(options?: GitExecutableOptions): string;
export function resetGitExecutableCacheForTests(): void;
