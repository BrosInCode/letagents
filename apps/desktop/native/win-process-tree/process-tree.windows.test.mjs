// letagents-process-tree.exe on a real Windows host, through shared/process-tree.mjs.
// Runs in CI's process-tree-windows job after build.mjs built the helper:
//   node --test apps/desktop/native/win-process-tree/process-tree.windows.test.mjs
// Elsewhere, or without a build, every test is skipped.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isWindowsBirth,
  processBirth,
  signalTree,
  spawnTree,
  terminateTree,
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
  // with "leave" exits at once and leaves a detached grandchild behind.
  const child = fixture("child.cjs", [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const [childFile, grandchildFile, mode] = process.argv.slice(2);",
    `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchild)}, grandchildFile], { stdio: "ignore", detached: mode === "leave" });`,
    "fs.writeFileSync(childFile, String(process.pid));",
    'if (mode === "leave") { grandchild.unref(); const done = () => fs.existsSync(grandchildFile) ? process.exit(0) : setTimeout(done, 20); done(); }',
    "else setInterval(() => {}, 1000);",
  ].join("\n"));
  // The top: a batch file (not an npm shim), so it runs under cmd.exe.
  const shim = fixture("start-child.cmd", `@echo off\r\n"${process.execPath}" "${child}" %*\r\n`);
  return { shim };
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
  const { shim } = setup();
  const id = Math.random().toString(36).slice(2);
  const childFile = join(folder, `child-${id}.pid`);
  const grandchildFile = join(folder, `grandchild-${id}.pid`);
  const tree = spawnTree(shim, [childFile, grandchildFile, mode], { stdio: "ignore" }, helper);
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
  assert.ok(gone(childPid, births.child), "the node under the .cmd shim survived");
  assert.ok(gone(grandchildPid, births.grandchild), "the grandchild survived");
  assert.equal(windowsTreeSize(tree.pid, births.helper, helper), 0, "the job still holds processes");
}

test("each process of a three-deep tree has a Windows birth; the helper reports its job", { skip }, async () => {
  const started = await startTree();
  try {
    for (const birth of Object.values(started.births)) assert.ok(isWindowsBirth(birth), String(birth));
    // The helper, cmd.exe, node and the grandchild node.
    assert.ok(windowsTreeSize(started.tree.pid, started.births.helper, helper) >= 3);
    const info = windowsProcessInfo(started.grandchildPid, helper);
    assert.equal(info.parentPid, started.childPid);
    assert.match(info.image, /node\.exe$/i);
    assert.equal(info.exited, false);
  } finally {
    signalTree(started.tree.pid, "SIGKILL", helper);
    await exited(started.tree);
  }
});

test("a tree this process holds ends whole on any signal (.cmd shim, node, child)", { skip }, async () => {
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
