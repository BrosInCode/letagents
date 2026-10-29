import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { acceptDaemonPeer, daemonEndpoint, rememberPrivateDaemonProof, resolveDaemonProofPath } from "../../../../shared/daemon-endpoint.mjs";
import { isOwnerPrivateSync, writePrivateFileAtomicallySync } from "../../../../shared/owner-private-fs.mjs";

// Platform facts the MCP test suites share. The suites run on Windows in CI;
// what cannot run there is skipped through these constants, in one place,
// with the reason beside it.

/**
 * Where a fake daemon under `root` listens: `<root>/daemon.sock` on POSIX, the
 * root's named pipe on Windows (the same endpoint the product computes).
 */
export function testDaemonSocketPath(root: string): string {
  return process.platform === "win32" ? daemonEndpoint(root).connectPath : join(root, "daemon.sock");
}

const gatedServers = new WeakSet<Server>();

/**
 * `server.listen(socketPath, callback)` for a fake daemon. On Windows the
 * product client runs the pipe handshake first, so each connection listener
 * is put behind the daemon's side of it, with a proof written for the root.
 */
export function listenTestDaemon(server: Server, socketPath: string, callback?: () => void): Server {
  if (process.platform === "win32" && !gatedServers.has(server)) {
    const proofPath = resolveDaemonProofPath(socketPath);
    if (!proofPath) throw new Error(`No test state directory owns ${socketPath}; build it with testDaemonSocketPath.`);
    // The product client accepts only a proof private to this account, so the
    // fake writes it the way the daemon does.
    let proof: string;
    try {
      if (!isOwnerPrivateSync(proofPath, lstatSync(proofPath))) throw new Error("not private");
      proof = readFileSync(proofPath, "utf8").trim();
    } catch {
      proof = randomBytes(32).toString("hex");
      writePrivateFileAtomicallySync(proofPath, `${proof}\n`);
    }
    // As the daemon does for its own proof: remember the identity just checked.
    const checked = lstatSync(proofPath);
    if (isOwnerPrivateSync(proofPath, checked)) rememberPrivateDaemonProof(proofPath, checked);
    for (const listener of server.listeners("connection") as Array<(socket: Socket) => void>) {
      server.off("connection", listener);
      server.on("connection", (socket: Socket) => acceptDaemonPeer(socket, proof, listener));
    }
    gatedServers.add(server);
  }
  return callback ? server.listen(socketPath, callback) : server.listen(socketPath);
}

/**
 * Skip reason for a step that sends SIGTERM as a request a handler can answer.
 * On Windows process.kill() ends the process at once, whatever the name, so
 * nothing in the process can announce its exit.
 */
export const posixSignalsOnly = process.platform === "win32"
  ? "needs a handled SIGTERM, which Windows does not have"
  : false;

// Node on Windows needs these to start (DLL search, Winsock), find its temp
// directory and its home, and run `.cmd` launchers.
const windowsSystemVariables = [
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "PUBLIC",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "USERNAME", "USERDOMAIN",
];

/**
 * The environment for a spawned Node process that must see only what a test
 * gives it: PATH, the variables Windows itself needs, and `variables`. A child
 * started with PATH alone exits at once on Windows.
 */
export function childProcessEnv(variables: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", ...(process.platform === "win32" ? windowsSystemVariables : [])]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...variables };
}

/**
 * Connects a client to a spawned MCP server. When the server exits before it
 * answers, the SDK reports only "Connection closed"; this keeps what the
 * server wrote to stderr and puts it in the error, so a start-up failure on
 * another platform names its cause.
 */
export async function connectOrExplain(client: Client, transport: StdioClientTransport): Promise<void> {
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await client.connect(transport);
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nserver stderr:\n${detail}` : " (the server wrote nothing to stderr)"}`, { cause: error });
  }
}

/**
 * A file that holds the owner's LetAgents token. On POSIX its mode must be
 * exactly 0600. Windows keeps no POSIX mode (stat reports 0o666 for every
 * file); there the protection is the per-user profile ACL of the directory
 * the product writes into, so the check is that a regular file exists and
 * resolves inside the test's private root. An explicit ACL check belongs to
 * the tier 3 owner-private helper.
 */
export function assertOwnerPrivateFile(filePath: string, privateRoot: string): void {
  const stats = statSync(filePath);
  assert.ok(stats.isFile(), `${filePath} is a regular file`);
  if (process.platform !== "win32") {
    assert.equal(stats.mode & 0o777, 0o600, `${filePath} is readable by its owner only`);
    return;
  }
  const inside = relative(realpathSync.native(privateRoot), realpathSync.native(filePath));
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), `${filePath} resolves inside ${privateRoot}`);
}
