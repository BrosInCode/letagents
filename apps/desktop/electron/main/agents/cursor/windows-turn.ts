// Windows pieces of a Cursor turn launch. Cursor runs without an operating-
// system sandbox there (cursorOsSandbox), and these replace what macOS gets
// from the shell and Unix sockets: the wrapper as an owner-private file, the
// exact program Cursor's launcher runs, a named pipe for the MCP connector,
// and a graceful stop over IPC before the process tree is ended.

import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentWindowsAccount,
  DAEMON_STATE_DIR_ENV,
  resolveDaemonProofPath,
  windowsPipeName,
} from "../../../../../../shared/daemon-endpoint.mjs";
import { findDaemonPipeAddon } from "../../../../../../shared/daemon-pipe-native.mjs";
import { createPrivateDirSync, privateEntryCreatedSync } from "../../../../../../shared/owner-private-fs.mjs";
import {
  processTreeHelperPath,
  quoteWindowsArgument,
  resolveWindowsCommand,
  terminateTree,
} from "../../../../../../shared/process-tree.mjs";
import { ProviderBatchFileError, providerLaunchCommand, type ProviderLaunchOptions } from "../../../../../../shared/provider-executable.mjs";
import { DEFAULT_STOP_GRACE_MS } from "../provider-evidence.js";
import { CURSOR_MCP_PIPE_CONNECTOR_SOURCE } from "./profile-types.js";

/** What the Windows wrapper embeds to start Cursor inside its own process-tree job. */
export interface CursorWindowsTurnValues {
  /** letagents-process-tree.exe: its exit proves Cursor's job is empty. */
  helper: string;
  /** The program Cursor's launcher runs (cursor-agent.exe, or a node.exe for a Node shim or Cursor's own install). */
  application: string;
  /** The quoted command line up to Cursor's own arguments. */
  head: string;
  /** The quoted adapter arguments (policy flags, workspace, prompt). */
  tail: string;
  /** What Cursor's launcher would have set in Cursor's environment. */
  environment: Readonly<Record<string, string>>;
  /** The named pipe the wrapper listens on for Cursor's one MCP connection, or "". */
  connectorListenPath: string;
  /** The parent of Cursor's per-turn data folder (cursorTemporaryRoot). */
  temporaryRoot: string;
}

/**
 * Where the wrapper listens for Cursor's one MCP connection. POSIX: the
 * socket path itself, unchanged. Windows: a named pipe whose name binds the
 * turn's private connector path and this account (shared/daemon-endpoint.mjs).
 * libuv creates the first pipe instance exclusively, so a squatted name fails
 * the listen and the turn does not start. Node gives the pipe the default
 * named-pipe DACL, which lets other local accounts connect, so once it listens
 * the wrapper replaces that DACL with one for this user alone
 * (WINDOWS_CONNECTOR_PIPE_SEAL_SOURCE), and admits only a client that first
 * sends the turn's proof (CURSOR_MCP_CONNECTOR_PROOF_FILE, readable only by
 * this account). The connector sends it only to this turn's wrapper
 * (CURSOR_MCP_PIPE_CONNECTOR_SOURCE).
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
 * The program Cursor's command runs on Windows, without cmd.exe, as the
 * shared provider resolver finds it (shared/provider-executable.mjs): a
 * native program as it is, an npm shim as the Node program it runs, the
 * official install's launcher as its own node.exe and index.js. One that
 * only cmd.exe can run is refused: the room message holds line breaks and
 * quotes that cmd.exe cannot pass on. So is a Node launcher with no node.exe
 * of its own inside the packaged app, where this process is Electron, not
 * Node: the wrapper starts Cursor with its own environment. `environment` is
 * what the launcher would have added to Cursor's.
 */
export function cursorWindowsProgram(
  cursorBin: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } & Pick<ProviderLaunchOptions, "exists" | "launchOptions" | "electron"> = {},
): { file: string; args: string[]; environment: Readonly<Record<string, string>> } {
  const env = options.env ?? process.env;
  let launch: ReturnType<typeof providerLaunchCommand>;
  try {
    launch = providerLaunchCommand(cursorBin, [], {
      platform: "win32", env, cwd: options.cwd, exists: options.exists, launchOptions: options.launchOptions, electron: options.electron,
    });
  } catch (error) {
    if (!(error instanceof ProviderBatchFileError)) throw error;
    const resolved = resolveWindowsCommand(cursorBin, { env, cwd: options.cwd, exists: options.exists });
    throw new Error(`Cursor's launcher ${resolved ?? cursorBin} is a batch file that only cmd.exe can run, and cmd.exe cannot pass a room message to it. Set LETAGENTS_CURSOR_AGENT_BIN to the program it starts.`);
  }
  if (!launch.resolved) throw new Error(`Cursor's command '${cursorBin}' was not found on this computer.`);
  if (launch.envAdditions?.ELECTRON_RUN_AS_NODE) {
    throw new Error(`Cursor's launcher ${launch.resolved} runs Node.js, and no node.exe is beside it. Install Node.js or set LETAGENTS_CURSOR_AGENT_BIN to Cursor's own program.`);
  }
  return { file: launch.file, args: launch.args, environment: launch.envAdditions ?? {} };
}

/** Cursor's program and the quoted command line that the wrapper hands to the process-tree helper. */
export function cursorWindowsNativeLaunch(
  cursorBin: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; helper?: string | null } & Pick<ProviderLaunchOptions, "exists" | "launchOptions" | "electron"> = {},
): Pick<CursorWindowsTurnValues, "helper" | "application" | "head" | "tail" | "environment"> {
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
    environment: program.environment,
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

/** The secret Cursor's pipe connector sends before the wrapper admits it, in the private connector folder. */
export const CURSOR_MCP_CONNECTOR_PROOF_FILE = "connector.proof";

/** The proof file for a connector socket path (`<connector root>\\stdio.sock`). */
export function cursorMcpConnectorProofPath(socketPath: string): string {
  return join(dirname(socketPath), CURSOR_MCP_CONNECTOR_PROOF_FILE);
}

/**
 * Where the wrapper writes its own pid before it listens, beside the proof:
 * the connector sends the proof only to a pipe this process serves.
 */
export const CURSOR_MCP_CONNECTOR_SERVER_FILE = "connector.server";

/**
 * shared/daemon-pipe-native.mjs, which the connector loads to open its pipe
 * (the same relative path as this module's import of it, so the same file in
 * the source tree, the build and the packaged app).
 */
const DAEMON_PIPE_NATIVE_MODULE = fileURLToPath(new URL("../../../../../../shared/daemon-pipe-native.mjs", import.meta.url));

/** Cursor's command arguments for the Windows pipe connector of a connector socket path. */
export function cursorMcpPipeConnectorArgs(socketPath: string, pipeNativeModule = DAEMON_PIPE_NATIVE_MODULE): string[] {
  return ["-e", CURSOR_MCP_PIPE_CONNECTOR_SOURCE, cursorMcpConnectorListenPath(socketPath), cursorMcpConnectorProofPath(socketPath), pipeNativeModule];
}

/**
 * The connector opens its pipe only through the sealed daemon pipe addon, as
 * the daemon's clients do, and never falls back to libuv's connect. Refuse a
 * turn here, with the reason, when this install has no sealed addon, instead
 * of a Cursor turn whose MCP connector cannot start.
 */
export function assertCursorMcpPipeAddon(find: () => unknown = findDaemonPipeAddon): void {
  try {
    find();
  } catch (error) {
    throw new Error(`Cursor on Windows needs letagents-daemon-pipe.node to reach its MCP connector safely. Reinstall LetAgents. (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Create the turn's connector folder private before the wrapper fills it
 * (the wrapper only checks it), with the connector proof inside. Folders and
 * files made in it inherit its protected DACL.
 */
export function prepareCursorWindowsConnectorRoot(root: string): void {
  createPrivateDirSync(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Cursor's MCP connector folder is not a real folder.");
  }
  const proof = join(root, CURSOR_MCP_CONNECTOR_PROOF_FILE);
  writeFileSync(proof, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  privateEntryCreatedSync(proof, "file");
}

/**
 * Windows: the hosted MCP runtime finds its home through USERPROFILE and
 * APPDATA, not HOME, so they point into the turn's connector folder like HOME
 * does; otherwise it would use the owner's own LetAgents state. With
 * USERPROFILE moved, the runtime needs the daemon's state folder named to
 * find the daemon pipe's proof (shared/daemon-endpoint.mjs).
 */
export function cursorWindowsMcpRuntimeEnv(
  connectorRoot: string,
  daemonConnectPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform !== "win32") return {};
  const home = join(connectorRoot, "home");
  const daemonProof = daemonConnectPath ? resolveDaemonProofPath(daemonConnectPath) : null;
  return {
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    ...(daemonProof ? { [DAEMON_STATE_DIR_ENV]: dirname(daemonProof) } : {}),
  };
}

/** Windows' CreateProcess limit, in UTF-16 units, with room for the terminating NUL. */
const WINDOWS_COMMAND_LINE_LIMIT = 32_766;

/**
 * Cursor takes the room message only as an argument, and a Windows command
 * line holds at most 32,767 characters. Refuse a turn whose command lines
 * would not fit, with a reason, instead of an ENAMETOOLONG from spawn. Both
 * helper lines are checked: the one spawnTree starts the wrapper with (the
 * wrapper's line quoted once more) and the one the wrapper starts Cursor with,
 * where the wrapper adds at most PROXY_ARGUMENT_ROOM for its proxy flags.
 */
export function assertCursorWindowsCommandLines(wrapperLine: string, values: Pick<CursorWindowsTurnValues, "helper" | "application" | "head" | "tail">): void {
  const PROXY_ARGUMENT_ROOM = 512;
  const nativeLine = `${values.head} ${"x".repeat(PROXY_ARGUMENT_ROOM)} ${values.tail}`;
  const lines = [
    [values.helper, "spawn", process.execPath, wrapperLine],
    [values.helper, "spawn", values.application, nativeLine],
  ].map((line) => line.map(quoteWindowsArgument).join(" "));
  if (lines.some((line) => line.length > WINDOWS_COMMAND_LINE_LIMIT)) {
    throw new Error("This room turn is too long for a Windows command line, which Cursor needs for its message. Shorten the message or start a new conversation.");
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
    // With a callback, a closed channel is reported here, not as the child's
    // 'error' event, which the launcher would take as the wrapper's end. The
    // tree is still ended after the grace period.
    requestStop: () => {
      if (child.connected) child.send({ type: "terminate" }, () => {});
    },
  });
  return true;
}
