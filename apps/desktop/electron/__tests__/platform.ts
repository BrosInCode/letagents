import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";

import { forgetOwnerPrivateCache, isOwnerPrivate, windowsSystemTool } from "../../../../shared/owner-private-fs.mjs";
import { acceptDaemonPeer, daemonEndpoint, ensureDaemonProof, isWindowsPipePath, resolveDaemonProofPath } from "../../../../shared/daemon-endpoint.mjs";

// Windows test helpers, in one place.
//
// A test that needs something Windows lacks skips itself there with a
// one-line reason, for `test(name, { skip: reason }, fn)`. Each reason is
// defined here, so the list of what does not run on Windows stays short and
// can be read at once. False off Windows.

/**
 * The daemon endpoint under a test root: `<root>/daemon.sock` on POSIX, a
 * per-root named pipe with its proof file on Windows.
 */
export function testDaemonEndpoint(root: string): { socketPath: string; peerProofPath: string | null } {
  const endpoint = daemonEndpoint(root);
  return { socketPath: endpoint.listenPath, peerProofPath: endpoint.proofPath };
}

/**
 * A stand-in daemon server for `socketPath`. On Windows it answers the proof
 * handshake first, as every daemon pipe does; elsewhere it is net.createServer.
 */
export function createTestDaemonServer(socketPath: string, onConnection: (socket: Socket) => void): Server {
  if (!isWindowsPipePath(socketPath)) return createServer(onConnection);
  const proofPath = resolveDaemonProofPath(socketPath);
  if (!proofPath) throw new Error(`No daemon proof is known for ${socketPath}.`);
  const proof = ensureDaemonProof(proofPath);
  proof.catch(() => undefined); // A test may remove its folder before any client connects.
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("error", () => undefined); // A client that gives up mid-handshake, as the real daemon allows.
    socket.once("close", () => open.delete(socket));
    void proof.then((value) => acceptDaemonPeer(socket, value, onConnection));
  });
  // A daemon writes its proof before it listens: a client reads the proof first and
  // would find no daemon if the pipe opened before the file exists.
  const listen = server.listen.bind(server) as (...args: unknown[]) => Server;
  server.listen = ((...args: unknown[]) => {
    proof.then(() => listen(...args), (error) => { server.emit("error", error); });
    return server;
  }) as typeof server.listen;
  // A pipe name stays taken while any client is still connected, so a stand-in
  // daemon that "exits" must drop its clients, as a real exit does.
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    const result = close(callback);
    for (const socket of open) socket.destroy();
    return result;
  };
  return server;
}

/**
 * A stand-in provider program (Codex, Claude Code, Cursor) that runs `source` as Node code, and the
 * path to start it by. POSIX: `path` itself, a script with a node shebang. Windows: `<path>.cmd`,
 * the shim npm makes, beside `<path>.js`; the provider resolver replaces the shim by `node <script>`,
 * so no shell runs. The path to use is returned, as the name may have a dot that Windows reads as an extension.
 */
export function writeFakeProvider(path: string, source: string): string {
  if (process.platform !== "win32") {
    writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  }
  const script = `${basename(path)}.js`;
  writeFileSync(join(dirname(path), script), source);
  const shim = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
    `node "%dp0%\\${script}" %*`, ""].join("\r\n");
  writeFileSync(`${path}.cmd`, shim);
  return `${path}.cmd`;
}

/**
 * Two process births that differ, in the form this platform records: `ps` start text on POSIX, a
 * `win32-ft:` creation time on Windows. A test that fakes a process birth takes them from here.
 */
export const OS_BIRTH = process.platform === "win32"
  ? { first: "win32-ft:134000000000000000", second: "win32-ft:134000000100000000", third: "win32-ft:134000000200000000" }
  : { first: "Mon Aug 31 08:00:00 2026", second: "Mon Aug 31 09:00:00 2026", third: "Fri Oct  2 19:00:00 2026" };

/** The Cursor tests that start a fake `cursor-agent` through the production wrapper: not yet ported to Windows (#1819 follow-up 4). */
export const needsWindowsFakeCursorAgent: string | false = process.platform === "win32"
  ? "needs a Windows fake cursor-agent (#1819 follow-up 4)"
  : false;

/** Tests of the macOS sandbox (sandbox-exec, seatbelt profiles): Cursor on Windows runs without an operating-system sandbox. */
export const macOsSandboxOnly: string | false = process.platform === "win32"
  ? "tests the macOS sandbox (sandbox-exec), which Windows does not have"
  : false;

/** Tests of POSIX process groups (a PGID that can be recycled or signalled): Windows ends a process tree through a job object instead. */
export const needsPosixProcessGroups: string | false = process.platform === "win32"
  ? "uses POSIX process groups, which Windows does not have"
  : false;

/**
 * Let other accounts read `path`, so a test can prove the app refuses it. POSIX: mode 0644.
 * Windows: a read grant to Everyone. Undo it with protectOwnerPrivate(path, kind, { force: true }).
 */
export function makeReadableByOthers(path: string): void {
  if (process.platform !== "win32") { chmodSync(path, 0o644); return; }
  execFileSync(windowsSystemTool("icacls.exe"), [path, "/grant", "*S-1-1-0:R", "/q"], { stdio: "ignore", windowsHide: true });
  forgetOwnerPrivateCache(); // The app remembers a file it found private; this changed its ACL behind that memory.
}

/** Tests that run the `ps` program or a stand-in for it: Windows has none, and reads a command line through the process-tree helper. */
export const needsPs: string | false = process.platform === "win32"
  ? "uses ps, which Windows does not have (the process-tree helper reads a command line there)"
  : false;

/** The built process-tree helper that CI and the Windows test machine name, or undefined (always undefined off Windows). */
export const WINDOWS_TEST_HELPER: string | undefined = process.platform === "win32"
  ? process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER?.trim() || undefined
  : undefined;

/** Tests that read a process through the process-tree helper, which the test run has not built. */
export const needsProcessTreeHelper: string | false = process.platform === "win32" && !WINDOWS_TEST_HELPER
  ? "needs the built process-tree helper (LETAGENTS_TEST_PROCESS_TREE_HELPER)"
  : false;

/**
 * `path` is private to its owner: mode 0600 (file) or 0700 (folder) on POSIX, the owner-only ACL the
 * app sets on Windows. For a file, harness.ts has assertOwnerPrivateFile; this one also does a folder.
 */
export async function assertOwnerPrivate(path: string, kind: "file" | "directory"): Promise<void> {
  const info = await lstat(path);
  if (process.platform !== "win32") {
    const mode = info.mode & 0o777;
    if (mode !== (kind === "directory" ? 0o700 : 0o600)) throw new Error(`${path} has mode ${mode.toString(8)}, not owner-only`);
    return;
  }
  if (!(kind === "directory" ? info.isDirectory() : info.isFile()) || !await isOwnerPrivate(path, info, { checkObject: true })) {
    throw new Error(`${path} is not private to this Windows account`);
  }
}

/** Tests of a child that outlives its parent holding the parent's stderr pipe: on Windows Node does not hand the pipe on, so the pipe closes with the parent. */
export const needsSurvivingStderrHolder: string | false = process.platform === "win32"
  ? "a grandchild cannot keep its parent's stderr pipe open on Windows (the pipe closes with the parent)"
  : false;

/** Tests that make a folder unreadable or read-only with mode bits (chmod): Windows has no mode bits, its access lists work otherwise. */
export const needsModeBits: string | false = process.platform === "win32"
  ? "uses mode bits (chmod) to make a folder unreadable, which Windows does not have"
  : false;

/** Tests of the agents' Codex home made of symbolic links: Windows links it with junctions and hard links, which codex-agent-home-windows.test.ts covers. */
export const needsPosixAgentHomeLinks: string | false = process.platform === "win32"
  ? "the agents' Codex home is made of symbolic links on POSIX; Windows uses junctions and hard links (see codex-agent-home-windows.test.ts)"
  : false;

/**
 * A second daemon endpoint inside one test root, for a test that starts more than one daemon or
 * names its socket. POSIX: `<root>/<name>.sock`. Windows: a pipe of its own, in the folder `<root>\<name>`.
 */
export function testNamedDaemonEndpoint(root: string, name: string): { socketPath: string; peerProofPath: string | null } {
  if (process.platform !== "win32") return { socketPath: join(root, `${name}.sock`), peerProofPath: null };
  const stateDir = join(root, name);
  mkdirSync(stateDir, { recursive: true });
  return testDaemonEndpoint(stateDir);
}

/** Tests that delete the working folder of a running process: Windows refuses, as the process holds that folder open. */
export const needsDeletableCwd: string | false = process.platform === "win32"
  ? "deletes the working folder of a running process, which Windows does not allow"
  : false;

/**
 * Extra time for a short request deadline in a test. On Windows a pipe request first reads the proof
 * file and runs the handshake, which a deadline of a few milliseconds cannot cover. Add this to the
 * deadline and to every delay the test sets relative to it, so the order of the two stays as it is.
 */
export const PIPE_ALLOWANCE_MS = process.platform === "win32" ? 1000 : 0;

/** Tests that stand in for `git` with a shell script on the PATH: Windows runs only a git.exe found by name, never a script. */
export const needsShellScriptGit: string | false = process.platform === "win32"
  ? "uses a shell script as a stand-in git, which Windows does not run (it finds only git.exe)"
  : false;

/**
 * Tests that give the approval path rules (the approval projection, the automatic edit rule) an absolute file path
 * as a provider reports it on POSIX. On Windows the path has backslashes and a drive letter; the rules refuse a
 * backslash name as unsafe, so on Windows they refuse the request (they fail closed). Whether they should read a
 * Windows path is a security decision for the path rules, not for a test.
 */
export const needsPosixFilePathReports: string | false = process.platform === "win32"
  ? "the approval path rules read POSIX paths; a Windows path (backslashes) is refused as unsafe"
  : false;

/** Tests that make a folder fsync fail on purpose: Windows cannot fsync a folder, and NTFS journals a rename itself. */
export const needsFolderFsync: string | false = process.platform === "win32"
  ? "needs fsync of a folder, which Windows cannot do"
  : false;

/**
 * A child that ended itself with process.kill(process.pid, "SIGKILL"). POSIX: the signal is SIGKILL. Windows has no
 * signals: the process just ends with exit code 1, so the test also checks that it printed no error (a crash would).
 */
export function assertKilledBySelf(child: { signal: string | null; status: number | null; stderr: string | Buffer; error?: Error }): void {
  const stderr = String(child.stderr);
  assert.equal(child.error, undefined, stderr);
  if (process.platform !== "win32") { assert.equal(child.signal, "SIGKILL", stderr); return; }
  assert.equal(child.status, 1, stderr);
  assert.doesNotMatch(stderr, /Error/, "the child was killed, it did not fail");
}

/** How long a test lets a child Node process run before it gives up: loading TypeScript takes much longer on the Windows test machines. */
export const CHILD_PROCESS_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 15_000;
