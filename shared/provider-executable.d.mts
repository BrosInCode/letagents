import type { ChildProcess, ExecFileException, ExecFileOptions } from "node:child_process";
import type { CodexLaunchCommand, CodexLaunchCommandOptions } from "./codex-executable.mjs";

export function resolveWindowsCommand(command: string, options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string | URL;
  exists?: (filePath: string) => boolean;
}): string | null;

export interface ProviderLaunchOptions {
  platform?: NodeJS.Platform;
  /** The environment the program is looked up in. */
  env?: NodeJS.ProcessEnv;
  cwd?: string | URL;
  exists?: (filePath: string) => boolean;
  launchOptions?: Omit<CodexLaunchCommandOptions, "platform" | "env">;
  /** Whether this process is Electron (default: `process.versions.electron` is set). */
  electron?: boolean;
}

export interface ProviderLaunchCommand extends CodexLaunchCommand {
  /** Windows: the program found for the command, or null. POSIX: the command. */
  resolved: string | null;
  /** What the child's environment needs on top of the caller's. */
  envAdditions: { ELECTRON_RUN_AS_NODE: "1" } | null;
}

export function providerLaunchCommand(
  command: string,
  args: readonly string[],
  options?: ProviderLaunchOptions,
): ProviderLaunchCommand;

type ExecFileCallback = (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void;
export function execProviderFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding?: BufferEncoding | null },
  callback: ExecFileCallback,
  providerOptions?: Omit<ProviderLaunchOptions, "env" | "cwd"> & {
    execFile?: (file: string, args: readonly string[], options: ExecFileOptions, callback: ExecFileCallback) => ChildProcess;
  },
): ChildProcess;
