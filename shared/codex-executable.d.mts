import type { ChildProcess, SpawnOptions } from "node:child_process";

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
  windowsVerbatimArguments?: true;
}

export function parseNodeShim(
  shimPath: string,
  shimText: string,
  options?: Pick<CodexLaunchCommandOptions, "execPath" | "exists">,
): { file: string; args: string[] } | null;
export function quoteCmdBatchArgument(argument: string): string;
export function codexLaunchCommand(
  executable: string,
  args: readonly string[],
  options?: CodexLaunchCommandOptions,
): CodexLaunchCommand;
export function spawnCodex(executable: string, args: readonly string[], spawnOptions?: SpawnOptions): ChildProcess;
