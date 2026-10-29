// Windows pieces of a Cursor turn launch. Cursor runs without an operating-
// system sandbox there (cursorOsSandbox), and these replace what macOS gets
// from the shell and Unix sockets: the wrapper as an owner-private file, the
// exact program Cursor's launcher runs, a named pipe for the MCP connector,
// and a graceful stop over IPC before the process tree is ended.

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { codexLaunchCommand } from "../../../../../../shared/codex-executable.mjs";
import { currentWindowsAccount, windowsPipeName } from "../../../../../../shared/daemon-endpoint.mjs";
import { createPrivateDirSync, privateEntryCreatedSync } from "../../../../../../shared/owner-private-fs.mjs";
import {
  processTreeHelperPath,
  quoteWindowsArgument,
  resolveWindowsCommand,
  terminateTree,
} from "../../../../../../shared/process-tree.mjs";
import { DEFAULT_STOP_GRACE_MS } from "../provider-evidence.js";

/** What the Windows wrapper embeds to start Cursor inside its own process-tree job. */
export interface CursorWindowsTurnValues {
  /** letagents-process-tree.exe: its exit proves Cursor's job is empty. */
  helper: string;
  /** The program Cursor's launcher runs (cursor-agent.exe, or node.exe for a Node shim). */
  application: string;
  /** The quoted command line up to Cursor's own arguments. */
  head: string;
  /** The quoted adapter arguments (policy flags, workspace, prompt). */
  tail: string;
  /** The named pipe the wrapper listens on for Cursor's one MCP connection, or "". */
  connectorListenPath: string;
  /** The parent of Cursor's per-turn data folder (cursorTemporaryRoot). */
  temporaryRoot: string;
}

/**
 * Where the wrapper listens for Cursor's one MCP connection. POSIX: the
 * socket path itself, unchanged. Windows: a named pipe whose name binds the
 * turn's private connector path and this account (shared/daemon-endpoint.mjs).
 * The path holds a random UUID, so the name cannot be guessed; libuv creates
 * the first pipe instance exclusively, so a squatted name fails the listen;
 * and the wrapper admits exactly one connection, so a stranger who connects
 * first fails the turn closed instead of reaching the MCP runtime.
 */
export function cursorMcpConnectorListenPath(
  socketPath: string,
  options: { platform?: NodeJS.Platform; account?: string } = {},
): string {
  if ((options.platform ?? process.platform) !== "win32") return socketPath;
  return windowsPipeName(
    "letagents-cursor-mcp",
    win32.resolve(socketPath).toLowerCase(),
    options.account ?? currentWindowsAccount(),
  );
}

/**
 * The program Cursor's command runs on Windows, without cmd.exe. A batch
 * launcher is replaced by the Node program it runs (shared/codex-executable.mjs).
 * One that only cmd.exe can run is refused: the room message holds line
 * breaks and quotes that cmd.exe cannot pass on. So is a Node launcher with
 * no node.exe of its own inside the packaged app, where this process is
 * Electron, not Node.
 */
export function cursorWindowsProgram(
  cursorBin: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): { file: string; args: string[] } {
  const env = options.env ?? process.env;
  const resolved = resolveWindowsCommand(cursorBin, { env, cwd: options.cwd });
  if (!resolved) throw new Error(`Cursor's command '${cursorBin}' was not found on this computer.`);
  const launch = codexLaunchCommand(resolved, [], { platform: "win32", env });
  if (launch.windowsVerbatimArguments) {
    throw new Error(`Cursor's launcher ${resolved} is a batch file that only cmd.exe can run, and cmd.exe cannot pass a room message to it. Set LETAGENTS_CURSOR_AGENT_BIN to the program it starts.`);
  }
  if (process.versions.electron && launch.file === process.execPath) {
    throw new Error(`Cursor's launcher ${resolved} runs Node.js, and no node.exe is beside it. Install Node.js or set LETAGENTS_CURSOR_AGENT_BIN to Cursor's own program.`);
  }
  return { file: launch.file, args: launch.args };
}

/** Cursor's program and the quoted command line that the wrapper hands to the process-tree helper. */
export function cursorWindowsNativeLaunch(
  cursorBin: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; helper?: string | null } = {},
): Pick<CursorWindowsTurnValues, "helper" | "application" | "head" | "tail"> {
  const helper = options.helper === undefined ? processTreeHelperPath() : options.helper;
  if (!helper) {
    throw new Error("Cursor on Windows needs letagents-process-tree.exe, which ends Cursor's process tree. Reinstall LetAgents.");
  }
  const program = cursorWindowsProgram(cursorBin, options);
  return {
    helper,
    application: program.file,
    head: [program.file, ...program.args].map(quoteWindowsArgument).join(" "),
    tail: args.map(quoteWindowsArgument).join(" "),
  };
}

/**
 * Write the wrapper program to an owner-private file. It is ~85 KB, above
 * the 32,767-character Windows command-line limit, so `node -e <source>`
 * cannot carry it there. The folder is created private first, so the file
 * inherits its protected DACL and no other account can change it before Node
 * reads it.
 */
export function writeCursorWrapperProgram(source: string, parent = tmpdir()): { path: string; remove(): void } {
  const directory = join(parent, `letagents-cursor-wrapper-${randomUUID()}`);
  createPrivateDirSync(directory);
  const path = join(directory, "turn-wrapper.cjs");
  try {
    writeFileSync(path, source, { flag: "wx", mode: 0o600 });
    privateEntryCreatedSync(path, "file");
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { path, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/** `node -e` text that runs the wrapper file with the same process.argv as `node -e <source>`. */
export function cursorWrapperProgramBootstrap(path: string): string {
  return `require(${JSON.stringify(path)})`;
}

/** Create the turn's connector folder private before the wrapper fills it; the wrapper only checks it. */
export function prepareCursorWindowsConnectorRoot(root: string): void {
  createPrivateDirSync(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Cursor's MCP connector folder is not a real folder.");
  }
}

const liveWrappers = new Map<number, ChildProcess>();

/** Windows: remember a live wrapper so a stop request reaches it over IPC first. */
export function rememberCursorWrapperForStop(child: ChildProcess): void {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid) return;
  liveWrappers.set(pid, child);
  child.once("exit", () => {
    if (liveWrappers.get(pid) === child) liveWrappers.delete(pid);
  });
}

/**
 * Windows has no SIGTERM. For a wrapper this process holds, the stop request
 * is the wrapper's IPC "terminate" message: it retires its proxies and MCP
 * connector, ends Cursor's job and writes its terminal record. terminateTree
 * ends the whole tree when the wrapper has not exited after the grace period.
 * Returns false when no live wrapper with this pid is held here; the caller
 * then ends the pid by its recorded birth as before.
 */
export function requestCursorWrapperStop(pid: number, graceMs = DEFAULT_STOP_GRACE_MS): boolean {
  const child = liveWrappers.get(pid);
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  void terminateTree(child, {
    graceful: true,
    graceMs,
    requestStop: () => { child.send?.({ type: "terminate" }); },
  });
  return true;
}
