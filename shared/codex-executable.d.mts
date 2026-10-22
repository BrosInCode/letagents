import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from "node:child_process";

export interface CodexExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  /** Replaces the `access(X_OK)` check, for tests. */
  isExecutable?: (filePath: string) => boolean;
}

export function installedCodexExecutablePath(options?: CodexExecutableResolutionOptions): string;
export function resolveCodexExecutable(options?: CodexExecutableResolutionOptions): string;
export function isWindowsBatchExecutable(executable: string, platform?: NodeJS.Platform): boolean;

export interface CodexLaunchCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The Node that runs an npm shim's script when no node.exe sits beside the shim. */
  execPath?: string;
  readFile?: (filePath: string) => string;
  exists?: (filePath: string) => boolean;
}

export interface CodexLaunchCommand {
  file: string;
  args: string[];
  argv0?: string;
  windowsVerbatimArguments?: true;
}

export function parseNodeShim(
  shimPath: string,
  shimText: string,
  options?: Pick<CodexLaunchCommandOptions, "execPath" | "exists">,
): { file: string; args: string[] } | null;
export function quoteCmdBatchArgument(argument: string): string;
/** `<SystemRoot>\System32\<name>`, never a bare name that the current directory could shadow. */
export function windowsSystemExecutable(name: string, env?: NodeJS.ProcessEnv): string;
export function codexLaunchCommand(
  executable: string,
  args: readonly string[],
  options?: CodexLaunchCommandOptions,
): CodexLaunchCommand;
export function spawnCodex(
  executable: string,
  args: readonly string[],
  spawnOptions?: SpawnOptions,
  launchOptions?: CodexLaunchCommandOptions,
): ChildProcess;
/** On Windows ends the process tree below `pid` with taskkill and returns true; elsewhere does nothing and returns false. */
export function terminateCodexProcessTree(
  pid: number | null | undefined,
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    runSync?: (file: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "error"> | undefined;
  },
): boolean;
