import type { ChildProcess, ChildProcessByStdio, SpawnOptions, SpawnOptionsWithStdioTuple, SpawnSyncReturns, StdioPipe } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CodexLaunchCommandOptions } from "./codex-executable.mjs";

export const PROCESS_TREE_HELPER_NAME: "letagents-process-tree.exe";
export const WINDOWS_BIRTH_PREFIX: "win32-ft:";
/** A helper-held child's exit code when its job still held processes after the helper's bounded wait. */
export const PROCESS_TREE_UNKILLABLE_EXIT_CODE: 0xE04C5401;
export const PROCESS_TREE_UNKILLABLE_AFTER_MS: 5000;

type HelperRun = (file: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "error"> | undefined;

export interface ProcessTreeHelperOptions {
  /** The helper to use; null means none. Found with `processTreeHelperPath` when not given. */
  helperPath?: string | null;
  /** The environment `processTreeHelperPath` reads LETAGENTS_PROCESS_TREE_HELPER from. */
  helperEnv?: NodeJS.ProcessEnv;
  /** Replaces the helper's spawnSync, for tests. */
  runHelper?: HelperRun;
  /**
   * How long the helper waits for an ended tree to empty before it reports it unkillable
   * (0 to 600000; default PROCESS_TREE_UNKILLABLE_AFTER_MS).
   */
  unkillableAfterMs?: number;
}

export function isWindowsBirth(identity: unknown): identity is string;
export const PS_BIRTH_EVIDENCE: RegExp;
/** POSIX: a `ps lstart` birth; Windows: a `win32-ft:` birth. */
export function isBirthEvidence(identity: unknown, platform?: NodeJS.Platform): identity is string;
export function processTreeHelperPath(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: string;
  exists?: (filePath: string) => boolean;
  includeLocalBuild?: boolean;
  /** The seal to check against (default shared/letagents-process-tree.seal.json), for tests. */
  seal?: { builds?: Record<string, { sha256?: string }> } | null;
  /** Reads a candidate's bytes for the seal check, for tests. */
  readFile?: (filePath: string) => Uint8Array;
}): string | null;
/** Why the last helper found was not used (its bytes are not the sealed build), or null. */
export function processTreeHelperRefusal(): string | null;
/** The sealed sha256 of the helper built for `arch`, or null when no build for it is sealed. */
export function sealedProcessTreeHelperSha256(arch?: string, seal?: { builds?: Record<string, { sha256?: string }> } | null): string | null;
export function quoteWindowsArgument(argument: string): string;
export function windowsCommandLine(file: string, args: readonly string[]): string;
export function parseWindowsCommandLine(line: string): string[];
export { resolveWindowsCommand } from "./provider-executable.mjs";

export interface SpawnTreeOptions extends ProcessTreeHelperOptions {
  platform?: NodeJS.Platform;
  /** The environment the program is looked up in (default: the spawn's env). */
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  launchOptions?: Omit<CodexLaunchCommandOptions, "platform" | "env">;
  /** Whether this process is Electron (default: `process.versions.electron` is set). */
  electron?: boolean;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}
export function spawnTree(
  command: string,
  args: readonly string[],
  spawnOptions: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
  treeOptions?: SpawnTreeOptions,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnTree(command: string, args: readonly string[], spawnOptions?: SpawnOptions, treeOptions?: SpawnTreeOptions): ChildProcess;

export interface ProcessBirthOptions extends ProcessTreeHelperOptions {
  platform?: NodeJS.Platform;
  execFileSync?: (file: string, args: string[], options: object) => string;
  probe?: (pid: number) => void;
  timeout?: number;
}
/** POSIX `ps -o lstart=`; Windows `win32-ft:<creation FILETIME>`. null: verified absent; undefined: unknown. */
export function processBirth(pid: number, options?: ProcessBirthOptions): string | null | undefined;

export interface WindowsProcessInfo {
  pid: number;
  parentPid: number | null;
  creationTime: string;
  exited: boolean;
  image: string | null;
  commandLine: string | null;
}
export function windowsProcessInfo(pid: number, options?: ProcessTreeHelperOptions): WindowsProcessInfo | null | undefined;

export interface SignalTreeOptions extends ProcessTreeHelperOptions {
  platform?: NodeJS.Platform;
  /** The recorded birth of `pid`. On Windows a pid this process does not hold is ended only with it. */
  identity?: string | null;
  /** The child when the caller holds it. */
  child?: ChildProcess;
  /** Windows: the kill(0) probe used when a birth cannot be read. */
  probe?: (pid: number) => void;
  /** POSIX: signal only the group, never the pid alone. */
  groupOnly?: boolean;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  liveTrees?: Map<number, { child: ChildProcess; helper: string }>;
}
export function isProcessTree(child: ChildProcess | null | undefined): boolean;
export function signalTree(pid: number, signal: NodeJS.Signals, options?: SignalTreeOptions): boolean;
/** "unkillable" (Windows): ended, but processes were still there when the helper's bounded wait ran out. */
export type TreeSignalOutcome = "ended" | "unkillable" | "none";
export function signalTreeOutcome(pid: number, signal: NodeJS.Signals, options?: SignalTreeOptions): TreeSignalOutcome;
export function windowsTreeSize(pid: number, identity: string, options?: ProcessTreeHelperOptions): number | undefined;
export type TerminateTreeOptions = SignalTreeOptions & {
  graceful?: boolean;
  graceMs?: number;
  killWaitMs?: number;
  /** Windows: ask the child to stop (an IPC message or a stdin frame) before the grace period. */
  requestStop?: () => void;
};
/** True when the tree is gone; an unkillable tree is false (see terminateTreeOutcome). */
export function terminateTree(child: ChildProcess, options?: TerminateTreeOptions): Promise<boolean>;
/** "unkillable" (Windows): the job was ended but did not empty in the helper's bounded wait; do not wait on it. */
export type TerminateTreeOutcome = "exited" | "unkillable" | "running";
export function terminateTreeOutcome(child: ChildProcess, options?: TerminateTreeOptions): Promise<TerminateTreeOutcome>;
