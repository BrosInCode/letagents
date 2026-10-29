import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";

import { processBirth, processTreeHelperPath } from "../../../../shared/process-tree.mjs";
import {
  CURSOR_WINDOWS_UNSANDBOXED_NOTICE,
  cursorPermissionProfileInstructionLines,
  cursorPermissionProfileReadyDetail,
} from "../main/agents/cursor-permission-profile.js";
import { CURSOR_MCP_CONNECTOR_PARENT } from "../main/agents/cursor-provider-constants.js";
import { cursorOsSandbox, prepareCursorTurnRuntimeDataDir } from "../main/agents/cursor-sandbox-policy.js";
import { defaultCursorSignalProcess } from "../main/agents/cursor/dependencies.js";
import { CURSOR_MCP_PIPE_CONNECTOR_SOURCE } from "../main/agents/cursor/profile-types.js";
import { cursorTurnWrapperSource, defaultLaunchTurn, type CursorCliChild } from "../main/agents/cursor/turn-launcher.js";
import { cursorMcpConnectorRootPattern } from "../main/agents/cursor/turn-wrapper-setup.js";
import {
  cursorMcpConnectorListenPath,
  cursorWrapperProgramBootstrap,
  requestCursorWrapperStop,
  writeCursorWrapperProgram,
} from "../main/agents/cursor/windows-turn.js";
import {
  cursorMcpAttestationFixtureSource,
  materializeAttestableMcpRuntime,
  useTestProcessTreeHelper,
  waitForPath,
  withLoopAlive,
  wrapperMcpRuntimeEnv,
} from "./cursor-provider-adapter.fixture.js";

// Cursor on Windows (tier 3): no operating-system sandbox, the wrapper runs
// from an owner-private file, Cursor starts inside the process-tree helper's
// job, the MCP connector is a named pipe, and a stop is an IPC request before
// the tree is ended. The first tests run everywhere; the last ones start real
// processes and run only on Windows.
useTestProcessTreeHelper();

const launchValues = {
  agentUpstreamEndpoint: "https://api2.cursor.sh",
  controlPlaneUpstreamEndpoint: "https://api2.cursor.sh",
  deniedDelegatingExecutablePaths: ["/bin/launchctl"],
};
const windowsValues = {
  helper: "C:\\Program Files\\LetAgents\\resources\\app\\runtime\\letagents-process-tree.exe",
  application: "C:\\Users\\you\\AppData\\Local\\cursor-agent\\cursor-agent.exe",
  head: "\"C:\\Users\\you\\AppData\\Local\\cursor-agent\\cursor-agent.exe\"",
  tail: "-p \"room message\"",
  connectorListenPath: "\\\\.\\pipe\\letagents-cursor-mcp-0123456789abcdef0123456789abcdef",
  temporaryRoot: "C:\\Users\\you\\AppData\\Local\\Temp",
};

test("one decision point names the operating-system sandbox for each platform", () => {
  assert.equal(cursorOsSandbox("darwin"), "macos-sandbox-exec");
  assert.equal(cursorOsSandbox("win32"), "windows-unsandboxed");
  assert.equal(cursorOsSandbox("linux"), "unconfined");
});

test("the macOS wrapper keeps sandbox-exec and has no Windows text", () => {
  const source = cursorTurnWrapperSource(launchValues, "darwin");
  assert.match(source, /const nativeCommand = sandboxed \? "\/usr\/bin\/sandbox-exec" : bin;/);
  assert.doesNotMatch(source, /windowsTurn/);
  assert.doesNotThrow(() => new Script(source));
});

test("the Windows wrapper is valid JavaScript, runs Cursor unsandboxed in the helper's job and listens on the pipe", () => {
  const source = cursorTurnWrapperSource({ ...launchValues, windows: windowsValues }, "win32");
  assert.doesNotThrow(() => new Script(source));
  assert.match(source, /const sandboxed = false;/);
  assert.match(source, /const nativeCommand = windowsTurn\.helper;/);
  assert.match(source, /\["spawn", windowsTurn\.application, windowsNativeCommandLine\(cursorArgs\)\]/);
  assert.match(source, /server\.listen\(windowsTurn\.connectorListenPath,/);
  assert.doesNotMatch(source, /chmodSync\(mcpConnectorSocketPath/);
  // The reason it runs from a file: it does not fit a Windows command line.
  assert.ok(source.length > 32_767, `wrapper is ${source.length} characters`);
  assert.throws(() => cursorTurnWrapperSource(launchValues, "win32"), /needs its launch values/);
});

test("the Windows connector is a per-turn, per-account named pipe; POSIX keeps the socket path", () => {
  const socketPath = "C:\\Users\\you\\AppData\\Local\\Temp\\letagents-cursor-mcp-01234567-89ab-cdef-0123-456789abcdef\\stdio.sock";
  const pipe = cursorMcpConnectorListenPath(socketPath, { platform: "win32", account: "you" });
  assert.match(pipe, /^\\\\\.\\pipe\\letagents-cursor-mcp-[0-9a-f]{32}$/);
  assert.equal(cursorMcpConnectorListenPath(socketPath.toUpperCase(), { platform: "win32", account: "you" }), pipe);
  assert.notEqual(cursorMcpConnectorListenPath(socketPath, { platform: "win32", account: "someone-else" }), pipe);
  assert.notEqual(cursorMcpConnectorListenPath(socketPath.replace("0123", "4567"), { platform: "win32", account: "you" }), pipe);
  assert.equal(cursorMcpConnectorListenPath("/tmp/letagents-cursor-mcp-x/stdio.sock", { platform: "darwin" }), "/tmp/letagents-cursor-mcp-x/stdio.sock");
  const pattern = new RegExp(cursorMcpConnectorRootPattern("C:\\Users\\you\\AppData\\Local\\Temp", "win32"));
  assert.equal(pattern.test("C:\\Users\\you\\AppData\\Local\\Temp\\letagents-cursor-mcp-01234567-89ab-cdef-0123-456789abcdef"), true);
  assert.equal(pattern.test("C:\\Users\\you\\AppData\\Local\\TempX\\letagents-cursor-mcp-01234567-89ab-cdef-0123-456789abcdef"), false);
});

test("the pipe connector refuses anything but a LetAgents Cursor pipe", () => {
  const refused = spawnSync(process.execPath, ["-e", CURSOR_MCP_PIPE_CONNECTOR_SOURCE, "/tmp/letagents-cursor-mcp/stdio.sock"], { encoding: "utf8" });
  assert.equal(refused.status, 64);
});

test("the wrapper file runs with the same process.argv as node -e", () => {
  const program = writeCursorWrapperProgram("process.stdout.write(JSON.stringify(process.argv.slice(1)));");
  try {
    assert.equal(existsSync(program.path), true);
    const run = spawnSync(process.execPath, ["-e", cursorWrapperProgramBootstrap(program.path), "a", "b c", "{\"d\":1}"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ["a", "b c", "{\"d\":1}"]);
  } finally {
    program.remove();
  }
  assert.equal(existsSync(program.path), false);
});

test("Windows users and the agent are told Cursor has no operating-system sandbox; macOS text is unchanged", () => {
  assert.equal(
    CURSOR_WINDOWS_UNSANDBOXED_NOTICE,
    "On Windows, Cursor runs without an operating-system sandbox. LetAgents still limits it to this room's folder and permissions.",
  );
  assert.ok(cursorPermissionProfileReadyDetail("sandboxed_write", "win32").endsWith(CURSOR_WINDOWS_UNSANDBOXED_NOTICE));
  assert.ok(cursorPermissionProfileReadyDetail("read_only", "win32").endsWith(CURSOR_WINDOWS_UNSANDBOXED_NOTICE));
  assert.doesNotMatch(cursorPermissionProfileReadyDetail("sandboxed_write", "darwin"), /Windows/);
  assert.equal(cursorPermissionProfileInstructionLines("sandboxed_write", "win32").some((line) => /runs Windows/.test(line)), true);
  assert.equal(cursorPermissionProfileInstructionLines("sandboxed_write", "darwin").some((line) => /owner's Mac/.test(line)), true);
});

test("a stop request reaches only a wrapper this process holds", () => {
  assert.equal(requestCursorWrapperStop(2_147_483_000), false);
});

// ── Real processes on Windows ──

const windowsOnly = process.platform === "win32" ? false : "starts Cursor's Windows wrapper";

/** An npm-style launcher: LetAgents runs the script with node, never through cmd.exe. */
function fakeCursor(root: string, script: string): string {
  writeFileSync(join(root, "fake-cursor.js"), script);
  const shim = join(root, "fake-cursor.cmd");
  writeFileSync(shim, "@ECHO off\r\nnode \"%~dp0\\fake-cursor.js\" %*\r\n");
  return shim;
}

function readTerminal(statePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${statePath}.terminal.json`, "utf8")) as Record<string, unknown>;
}

async function waitForAbsence(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processBirth(pid) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("Windows: a Cursor turn runs from the wrapper file, keeps the prompt exact, and proves its job empty", { skip: windowsOnly }, async () => {
  assert.ok(processTreeHelperPath(), "letagents-process-tree.exe must be built for Cursor on Windows");
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-windows-turn-"));
  const statePath = join(root, "turn.jsonl");
  const argsPath = join(root, "args.json");
  const descendantPath = join(root, "descendant.pid");
  writeFileSync(statePath, "");
  const prompt = "he said \"hi\"\nthen 100% of it, C:\\path\\ & ^done";
  const cursorBin = fakeCursor(root, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(descendantPath)}, String(descendant.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-windows" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "windows-ok", session_id: "sess-windows" }) + "\\n");
process.exit(0);
`);
  try {
    const child = defaultLaunchTurn({
      cursorBin,
      args: ["-p", "--output-format", "stream-json", prompt],
      cwd: root,
      env: { ...process.env, HOME: root },
      deferStart: true,
      statePath,
    });
    const lines: string[] = [];
    child.onLine((line) => lines.push(line));
    await child.prepared;
    child.release();
    const exit = await withLoopAlive(child.exited);
    assert.deepEqual(exit, { type: "exit", code: 0, signal: null }, child.stderrTail());
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), ["-p", "--output-format", "stream-json", prompt]);
    assert.equal(lines.some((line) => line.includes("\"windows-ok\"")), true);
    const terminal = readTerminal(statePath);
    assert.equal(terminal.native_process_group_reaped, true);
    assert.equal(await waitForAbsence(Number(readFileSync(descendantPath, "utf8"))), true, "Cursor's descendant ended with its job");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows: a stop is the wrapper's IPC request, which ends Cursor's job and writes the terminal record", { skip: windowsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-windows-stop-"));
  const statePath = join(root, "turn.jsonl");
  const descendantPath = join(root, "descendant.pid");
  writeFileSync(statePath, "");
  const cursorBin = fakeCursor(root, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(descendantPath)}, String(descendant.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-windows-stop" }) + "\\n");
setInterval(() => {}, 1000);
`);
  let child: CursorCliChild | null = null;
  try {
    child = defaultLaunchTurn({
      cursorBin,
      args: ["-p", "stop me"],
      cwd: root,
      env: { ...process.env, HOME: root },
      deferStart: true,
      statePath,
    });
    await child.prepared;
    child.release();
    assert.equal(await waitForPath(descendantPath, 15_000), true, child.stderrTail());
    const identity = processBirth(child.pid!);
    assert.ok(identity);
    defaultCursorSignalProcess(child.pid!, "SIGTERM", identity);
    const exit = await withLoopAlive(child.exited);
    assert.equal(exit.type, "exit");
    const terminal = readTerminal(statePath);
    assert.equal(terminal.native_process_group_reaped, true, "the wrapper ended Cursor's job before it exited");
    assert.equal(await waitForAbsence(Number(readFileSync(descendantPath, "utf8"))), true);
  } finally {
    if (child?.pid) defaultCursorSignalProcess(child.pid, "SIGKILL", processBirth(child.pid) ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows: a restricted turn reaches its hosted MCP runtime over the named pipe and revokes it", { skip: windowsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-windows-mcp-"));
  const statePath = join(root, "turn.jsonl");
  const homeDir = join(root, "home");
  const connectorRoot = join(CURSOR_MCP_CONNECTOR_PARENT, `letagents-cursor-mcp-${randomUUID()}`);
  const socketPath = join(connectorRoot, "stdio.sock");
  const runtimeDataRoot = prepareCursorTurnRuntimeDataDir();
  writeFileSync(statePath, "");
  mkdirSync(join(homeDir, ".cursor"), { recursive: true });
  writeFileSync(join(homeDir, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: {
      letagents: {
        command: process.execPath,
        args: ["-e", CURSOR_MCP_PIPE_CONNECTOR_SOURCE, cursorMcpConnectorListenPath(socketPath)],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  }));
  const cursorBin = fakeCursor(root, `
${cursorMcpAttestationFixtureSource}
attestFixtureMcp().then((connector) => {
  detachFixtureMcp(connector);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-windows-mcp" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "windows-mcp-ok", session_id: "sess-windows-mcp" }) + "\\n");
  process.exit(0);
}).catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(83); });
`);
  try {
    const child = defaultLaunchTurn({
      cursorBin,
      args: ["-p", "--output-format", "stream-json", "mcp over a pipe"],
      cwd: root,
      env: { ...process.env, HOME: homeDir, CURSOR_DATA_DIR: runtimeDataRoot },
      deferStart: true,
      statePath,
      mcpConnectorSocketPath: socketPath,
      mcpRuntimeEntryPath: materializeAttestableMcpRuntime(join(root, "attestable-mcp-runtime")),
      mcpRuntimeCwd: root,
      mcpRuntimeEnv: wrapperMcpRuntimeEnv(connectorRoot, "cursor:windows-pipe"),
      providerAuthorization: "Bearer windows-pipe-provider-proof",
      restrictRemoteAuthority: true,
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
    });
    const lines: string[] = [];
    child.onLine((line) => lines.push(line));
    await child.prepared;
    child.release();
    const exit = await withLoopAlive(child.exited);
    assert.deepEqual(exit, { type: "exit", code: 0, signal: null }, child.stderrTail());
    assert.equal(lines.some((line) => line.includes("\"windows-mcp-ok\"")), true);
    const terminal = readTerminal(statePath);
    assert.equal(terminal.native_process_group_reaped, true);
    assert.equal(terminal.remote_authority_revoked, true, JSON.stringify(terminal));
    assert.equal(existsSync(connectorRoot), false, "the wrapper retired its connector folder");
    assert.equal(existsSync(runtimeDataRoot), false, "the wrapper retired Cursor's turn data folder");
  } finally {
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
