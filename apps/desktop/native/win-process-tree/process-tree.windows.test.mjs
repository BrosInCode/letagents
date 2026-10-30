// letagents-process-tree.exe on a real Windows host, through shared/process-tree.mjs.
// Runs in CI's process-tree-windows job after build.mjs built the helper:
//   node --test apps/desktop/native/win-process-tree/process-tree.windows.test.mjs
// Elsewhere, or without a build, every test is skipped.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isWindowsBirth,
  PROCESS_TREE_UNKILLABLE_EXIT_CODE,
  processBirth,
  processTreeHelperPath,
  processTreeHelperRefusal,
  sealedProcessTreeHelperSha256,
  signalTree,
  signalTreeOutcome,
  spawnTree,
  terminateTree,
  terminateTreeOutcome,
  windowsProcessInfo,
  windowsTreeSize,
} from "../../../../shared/process-tree.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = join(here, "build", process.arch === "arm64" ? "arm64" : "x64", "letagents-process-tree.exe");
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(helperPath) ? "build the helper first (build.mjs)" : false;
const folder = skip ? "" : mkdtempSync(join(tmpdir(), "letagents-process-tree-"));
after(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
const helper = { helperPath };
const noHeldTrees = { ...helper, liveTrees: new Map() };

function fixture(name, text) {
  const file = join(folder, name);
  writeFileSync(file, text);
  return file;
}

function setup() {
  // The deepest process: records its pid and waits.
  const grandchild = fixture("grandchild.cjs", [
    'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  // The middle: starts the grandchild, records its own pid, then waits, or
  // with "leave" exits at once and leaves a detached grandchild behind, or
  // with "leave-on-go" does so once a `<child pid file>.go` file exists.
  const child = fixture("child.cjs", [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const [childFile, grandchildFile, mode] = process.argv.slice(2);",
    `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchild)}, grandchildFile], { stdio: "ignore", detached: mode !== "wait" });`,
    "fs.writeFileSync(childFile, String(process.pid));",
    'if (mode === "leave") { grandchild.unref(); const done = () => fs.existsSync(grandchildFile) ? process.exit(0) : setTimeout(done, 20); done(); }',
    'else if (mode === "leave-on-go") { grandchild.unref(); const done = () => fs.existsSync(grandchildFile) && fs.existsSync(childFile + ".go") ? process.exit(0) : setTimeout(done, 20); done(); }',
    "else setInterval(() => {}, 1000);",
  ].join("\n"));
  return { child };
}

async function waitFor(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readPid(file) {
  try { return Number(readFileSync(file, "utf8")); } catch { return 0; }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** Gone means: no process has the pid, or another process (another birth) has it now. */
function gone(pid, birth) {
  const now = processBirth(pid, helper);
  return now === null || (typeof now === "string" && now !== birth);
}

async function startTree(mode = "wait") {
  const { child } = setup();
  const id = Math.random().toString(36).slice(2);
  const childFile = join(folder, `child-${id}.pid`);
  const grandchildFile = join(folder, `grandchild-${id}.pid`);
  const tree = spawnTree(process.execPath, [child, childFile, grandchildFile, mode], { stdio: "ignore" }, helper);
  const childPid = await waitFor(() => readPid(childFile), "the child's pid");
  const grandchildPid = await waitFor(() => readPid(grandchildFile), "the grandchild's pid");
  const births = {
    helper: processBirth(tree.pid, helper),
    child: processBirth(childPid, helper),
    grandchild: processBirth(grandchildPid, helper),
  };
  return { tree, childPid, grandchildPid, births };
}

function assertAllGone({ tree, childPid, grandchildPid, births }) {
  assert.ok(gone(childPid, births.child), "the node under the helper survived");
  assert.ok(gone(grandchildPid, births.grandchild), "the grandchild survived");
  assert.equal(windowsTreeSize(tree.pid, births.helper, helper), 0, "the job still holds processes");
}

test("each process of a three-deep tree has a Windows birth; the helper reports its job", { skip }, async () => {
  const started = await startTree();
  try {
    for (const birth of Object.values(started.births)) assert.ok(isWindowsBirth(birth), String(birth));
    // The node and the grandchild node, with the helper when its job counts it.
    assert.ok(windowsTreeSize(started.tree.pid, started.births.helper, helper) >= 2);
    const info = windowsProcessInfo(started.grandchildPid, helper);
    assert.equal(info.parentPid, started.childPid);
    assert.match(info.image, /node\.exe$/i);
    assert.equal(info.exited, false);
  } finally {
    signalTree(started.tree.pid, "SIGKILL", helper);
    await exited(started.tree);
  }
});

test("a tree this process holds ends whole on any signal (node, child)", { skip }, async () => {
  const started = await startTree();
  assert.equal(signalTree(started.tree.pid, "SIGTERM", helper), true);
  await exited(started.tree);
  assertAllGone(started);
});

test("a stored pid with its recorded birth ends the tree, as after a daemon restart", { skip }, async () => {
  const started = await startTree();
  assert.equal(signalTree(started.tree.pid, "SIGKILL", { ...noHeldTrees, identity: started.births.helper }), true);
  await exited(started.tree);
  assertAllGone(started);
});

test("a live tree is not ended for a recorded birth that is not its helper's", { skip }, async () => {
  const started = await startTree();
  try {
    const wrong = `win32-ft:${BigInt(started.births.helper.slice("win32-ft:".length)) + 1n}`;
    assert.equal(signalTree(started.tree.pid, "SIGKILL", { ...noHeldTrees, identity: wrong }), false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(started.tree.exitCode, null);
    assert.equal(processBirth(started.grandchildPid, helper), started.births.grandchild);
  } finally {
    signalTree(started.tree.pid, "SIGKILL", helper);
    await exited(started.tree);
  }
});

test("killing only the helper process still ends the tree (the job closes with it)", { skip }, async () => {
  const started = await startTree();
  started.tree.kill();
  await exited(started.tree);
  await waitFor(() => gone(started.childPid, started.births.child) && gone(started.grandchildPid, started.births.grandchild), "the job to end", 5_000);
  assert.equal(windowsTreeSize(started.tree.pid, started.births.helper, helper), 0);
});

test("when the program exits, what it left behind (even detached) ends before the helper exits", { skip }, async () => {
  const started = await startTree("leave");
  const { code } = await exited(started.tree);
  assert.equal(code, 0);
  assert.ok(gone(started.grandchildPid, started.births.grandchild), "the detached grandchild outlived the helper");
});

test("a reused pid is refused: a recorded birth that is not the process's ends nothing", { skip }, async () => {
  // A process that is not ours (not started through the helper) holds the pid.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    const birth = processBirth(stranger.pid, helper);
    assert.ok(isWindowsBirth(birth));
    const earlier = `win32-ft:${BigInt(birth.slice("win32-ft:".length)) - 10_000_000n}`;
    assert.equal(signalTree(stranger.pid, "SIGKILL", { ...noHeldTrees, identity: earlier }), false);
    // No recorded birth at all: nothing to prove the pid is ours.
    assert.equal(signalTree(stranger.pid, "SIGKILL", noHeldTrees), false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(processBirth(stranger.pid, helper), birth, "the stranger was killed");
    assert.equal(stranger.exitCode, null);
    // Its own recorded birth ends exactly that process.
    assert.equal(signalTree(stranger.pid, "SIGKILL", { ...noHeldTrees, identity: birth }), true);
    await exited(stranger);
  } finally {
    stranger.kill();
  }
});

test("a graceful stop asks over IPC first, then the tree is killed after the grace period", { skip }, async () => {
  const script = fixture("stop-on-message.cjs", [
    'process.on("message", (message) => { if (message?.type === "stop") { process.stdout.write("stopping\\n", () => process.exit(3)); } });',
    'process.send({ type: "ready" });',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const child = spawnTree(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit", "ipc"] }, helper);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve) => child.once("message", resolve));
  const result = exited(child);
  assert.equal(await terminateTree(child, { ...helper, graceful: true, graceMs: 5_000, requestStop: () => child.send({ type: "stop" }) }), true);
  assert.equal((await result).code, 3);
  assert.match(output, /stopping/);

  const deaf = spawnTree(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] }, helper);
  const started = Date.now();
  assert.equal(await terminateTree(deaf, { ...helper, graceful: true, graceMs: 300, requestStop: () => deaf.send({ type: "stop" }) }), true);
  assert.ok(Date.now() - started >= 300);
});

test("stdio, the exit code and every argument pass through the helper unchanged", { skip }, async () => {
  const args = ["plain", "two words", 'a "quote"', "trailing\\", "back\\\\slash \\\"", "", "%PATH%", "^&|<>", "ünï"];
  const child = spawnTree(process.execPath, ["-e", [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ args: process.argv.slice(1), input })); process.stderr.write('to stderr'); process.exit(7); });",
  ].join("\n"), ...args], { stdio: ["pipe", "pipe", "pipe"] }, helper);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end("from stdin");
  const { code } = await exited(child);
  await closed;
  assert.equal(code, 7);
  assert.deepEqual(JSON.parse(stdout), { args, input: "from stdin" });
  assert.equal(stderr, "to stderr");
});

test("a program that does not exist fails as Node's own spawn does", { skip }, async () => {
  const child = spawnTree(join(folder, "missing.exe"), [], { stdio: "ignore" }, helper);
  const error = await new Promise((resolve) => child.once("error", resolve));
  assert.equal(error.code, "ENOENT");
});

test("info names an absent pid as absent and reads this process", { skip }, () => {
  assert.equal(windowsProcessInfo(4_294_967_292, helper), null);
  assert.equal(processBirth(4_294_967_292, helper), null);
  const self = windowsProcessInfo(process.pid, helper);
  assert.equal(self.pid, process.pid);
  assert.equal(self.exited, false);
  assert.equal(processBirth(process.pid, helper), `win32-ft:${self.creationTime}`);
});

// The helper's wait for an ended job is bounded. A process whose exit is
// held cannot leave the job: a debugger attached to it receives the
// EXIT_PROCESS debug event before the process leaves its job, and the
// process waits there until the debugger continues. The holder below
// (Windows PowerShell compiling a few lines of C#, both on every Windows
// runner) holds that event for `holdMs`, so the job stays non-empty past the
// helper's bound, deterministically, and empties once it lets go.
const HOLDER = String.raw`
param([int]$TargetPid, [int]$HoldMs)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class ExitHolder {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DebugActiveProcess(int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WaitForDebugEvent(byte[] debugEvent, int milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ContinueDebugEvent(int pid, int tid, uint status);
  const uint Continue = 0x00010002, NotHandled = 0x80010001;
  public static void Run(int pid, int holdMs) {
    if (!DebugActiveProcess(pid)) throw new Exception("DebugActiveProcess failed: " + Marshal.GetLastWin32Error());
    Console.WriteLine("attached");
    byte[] debugEvent = new byte[1024];
    DateTime deadline = DateTime.UtcNow.AddMinutes(2);
    while (DateTime.UtcNow < deadline) {
      if (!WaitForDebugEvent(debugEvent, 1000)) continue;
      int code = BitConverter.ToInt32(debugEvent, 0), processId = BitConverter.ToInt32(debugEvent, 4), threadId = BitConverter.ToInt32(debugEvent, 8);
      if (code == 5) {
        Console.WriteLine("held");
        Thread.Sleep(holdMs);
        ContinueDebugEvent(processId, threadId, Continue);
        return;
      }
      // An exception other than the attach breakpoint (0x80000003) stays the process's own.
      uint exception = code == 1 ? BitConverter.ToUInt32(debugEvent, 16) : 0;
      ContinueDebugEvent(processId, threadId, code == 1 && exception != 0x80000003 ? NotHandled : Continue);
    }
  }
}
'@
[ExitHolder]::Run($TargetPid, $HoldMs)
`;

/** Attaches the holder to `pid`; resolves once it is attached. `held` resolves when it holds the exit, `done` when it let go. */
async function holdExit(pid, holdMs) {
  const script = fixture("hold-exit.ps1", HOLDER);
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, String(pid), String(holdMs)], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  let output = "";
  holder.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const done = exited(holder);
  await waitFor(() => output.includes("attached") || holder.exitCode !== null, "the exit holder to attach", 60_000);
  assert.match(output, /attached/, "the exit holder could not attach");
  return { held: waitFor(() => output.includes("held"), "the held exit", 30_000), done };
}

const HOLD_MS = 10_000;

test("a kill whose bounded wait runs out reports the tree unkillable; the held process ends once let go", { skip }, async () => {
  const started = await startTree();
  const holder = await holdExit(started.grandchildPid, HOLD_MS);
  const before = Date.now();
  // The job is ended; the held grandchild has not exited when the kill's 1 s bound runs out.
  assert.equal(signalTreeOutcome(started.tree.pid, "SIGKILL", { ...noHeldTrees, identity: started.births.helper, unkillableAfterMs: 1_000 }), "unkillable");
  await holder.held;
  assert.ok(Date.now() - before < HOLD_MS, "the kill waited for the held process instead of its bound");
  assert.equal(processBirth(started.grandchildPid, helper), started.births.grandchild, "the held process ended early");
  await exited(started.tree);
  await holder.done;
  await waitFor(() => gone(started.grandchildPid, started.births.grandchild), "the held process to end once let go");
  assert.ok(gone(started.childPid, started.births.child));
});

test("a helper whose own bounded wait runs out exits with the unkillable code", { skip }, async () => {
  // The program exits by itself and leaves a grandchild whose exit is held: the helper ends it and waits 1 s.
  const { child } = setup();
  const id = Math.random().toString(36).slice(2);
  const childFile = join(folder, `child-${id}.pid`);
  const grandchildFile = join(folder, `grandchild-${id}.pid`);
  const tree = spawnTree(process.execPath, [child, childFile, grandchildFile, "leave-on-go"], { stdio: "ignore" }, { ...helper, unkillableAfterMs: 1_000 });
  const grandchildPid = await waitFor(() => readPid(grandchildFile), "the grandchild's pid");
  const grandchildBirth = processBirth(grandchildPid, helper);
  const holder = await holdExit(grandchildPid, HOLD_MS);
  const before = Date.now();
  writeFileSync(`${childFile}.go`, "");
  const { code } = await exited(tree);
  assert.equal(code, PROCESS_TREE_UNKILLABLE_EXIT_CODE);
  assert.ok(Date.now() - before < HOLD_MS, "the helper waited for the held process instead of its bound");
  assert.equal(processBirth(grandchildPid, helper), grandchildBirth, "the held process ended early");
  await holder.done;
  await waitFor(() => gone(grandchildPid, grandchildBirth), "the held process to end once let go");
});

test("a kill while the helper is already waiting on a held process reports it unkillable, not ended", { skip }, async () => {
  // The program exits by itself, so the helper ends its job and waits (5 s) on the held grandchild;
  // a kill then finds the job listing nothing, and must not call that a clean stop.
  const { child } = setup();
  const id = Math.random().toString(36).slice(2);
  const childFile = join(folder, `child-${id}.pid`);
  const grandchildFile = join(folder, `grandchild-${id}.pid`);
  const tree = spawnTree(process.execPath, [child, childFile, grandchildFile, "leave-on-go"], { stdio: "ignore" }, helper);
  const treeBirth = processBirth(tree.pid, helper);
  const grandchildPid = await waitFor(() => readPid(grandchildFile), "the grandchild's pid");
  const grandchildBirth = processBirth(grandchildPid, helper);
  const holder = await holdExit(grandchildPid, HOLD_MS);
  writeFileSync(`${childFile}.go`, "");
  await holder.held;
  assert.equal(signalTreeOutcome(tree.pid, "SIGKILL", { ...noHeldTrees, identity: treeBirth, unkillableAfterMs: 1_000 }), "unkillable");
  const { code } = await exited(tree);
  assert.equal(code, PROCESS_TREE_UNKILLABLE_EXIT_CODE);
  await holder.done;
  await waitFor(() => gone(grandchildPid, grandchildBirth), "the held process to end once let go");
});

test("a second kill while the first still waits on a held process reports it unkillable too", { skip }, async () => {
  const started = await startTree();
  const holder = await holdExit(started.grandchildPid, HOLD_MS);
  // Kill A ends the job and waits (8 s) on the held grandchild; kill B then finds the job listing nothing.
  const first = spawn(helperPath, ["kill", String(started.tree.pid), started.births.helper.slice("win32-ft:".length), "8000"], { stdio: "ignore", windowsHide: true });
  const firstDone = exited(first);
  await holder.held;
  assert.equal(signalTreeOutcome(started.tree.pid, "SIGKILL", { ...noHeldTrees, identity: started.births.helper, unkillableAfterMs: 2_000 }), "unkillable");
  assert.equal((await firstDone).code, 4);
  assert.equal((await exited(started.tree)).code, PROCESS_TREE_UNKILLABLE_EXIT_CODE);
  await holder.done;
  await waitFor(() => gone(started.grandchildPid, started.births.grandchild), "the held process to end once let go");
});

test("terminateTreeOutcome reports a held tree unkillable, and terminateTree resolves false for one", { skip }, async () => {
  const first = await startTree();
  const firstHolder = await holdExit(first.grandchildPid, HOLD_MS);
  assert.equal(await terminateTreeOutcome(first.tree, { ...helper, unkillableAfterMs: 1_000 }), "unkillable");
  // Asked again after its helper exited, whatever code the helper exited with: still unkillable.
  await exited(first.tree);
  assert.equal(await terminateTreeOutcome(first.tree, helper), "unkillable");
  const second = await startTree();
  const secondHolder = await holdExit(second.grandchildPid, HOLD_MS);
  assert.equal(await terminateTree(second.tree, { ...helper, unkillableAfterMs: 1_000 }), false);
  for (const [started, holder] of [[first, firstHolder], [second, secondHolder]]) {
    await holder.done;
    await waitFor(() => gone(started.grandchildPid, started.births.grandchild), "the held process to end once let go");
  }
});

test("with the default bound a tree ends whole and terminateTreeOutcome reports it exited", { skip }, async () => {
  const started = await startTree();
  assert.equal(await terminateTreeOutcome(started.tree, helper), "exited");
  assertAllGone(started);
});

test("the helper refuses a wait bound out of range", { skip }, () => {
  const birth = processBirth(process.pid, helper).slice("win32-ft:".length);
  const run = (args) => spawnSync(helperPath, args, { stdio: "ignore", windowsHide: true }).status;
  assert.equal(run(["kill", String(process.pid), birth, "600001"]), 120);
  assert.equal(run(["kill", String(process.pid), birth, "-1"]), 120);
  assert.equal(run(["kill", String(process.pid), birth, "5", "6"]), 120);
  assert.equal(run(["query", String(process.pid), birth, "5"]), 120);
  assert.equal(run(["spawn", process.execPath, "node -e 0", "x"]), 120);
});

test("the app uses a found helper only when its bytes are the sealed build", { skip }, () => {
  const resources = join(folder, `resources-${Math.random().toString(36).slice(2)}`);
  const runtime = join(resources, "app", "runtime");
  mkdirSync(runtime, { recursive: true });
  const packaged = join(runtime, "letagents-process-tree.exe");
  copyFileSync(helperPath, packaged);
  const built = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  const found = (seal) => processTreeHelperPath({ env: {}, resourcesPath: resources, includeLocalBuild: false, ...(seal === undefined ? {} : { seal }) });
  // This build, sealed: used.
  assert.equal(found({ builds: { x64: { sha256: built } } }), packaged);
  // The committed seal: used exactly when this runner built the sealed bytes.
  assert.equal(found(), built === sealedProcessTreeHelperSha256("x64") ? packaged : null);
  // One byte more: refused, with the reason.
  writeFileSync(packaged, Buffer.concat([readFileSync(helperPath), Buffer.from([0])]));
  assert.equal(found({ builds: { x64: { sha256: built } } }), null);
  assert.match(String(processTreeHelperRefusal()), /is not the sealed/);
  // A configured helper that is not sealed is refused, with no fallback.
  assert.equal(processTreeHelperPath({ env: { LETAGENTS_PROCESS_TREE_HELPER: packaged }, resourcesPath: resources, seal: { builds: { x64: { sha256: built } } } }), null);
});
