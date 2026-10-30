import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { DAEMON_PIPE_ADDON_NAME, loadDaemonPipeAddon } from "../../../../shared/daemon-pipe-native.mjs";
import { CURSOR_MCP_CONNECTOR_PARENT } from "../main/agents/cursor-provider-constants.js";
import { prepareCursorTurnRuntimeDataDir } from "../main/agents/cursor-sandbox-policy.js";
import { defaultLaunchTurn } from "../main/agents/cursor/turn-launcher.js";
import { WINDOWS_CONNECTOR_PIPE_SEAL_SOURCE } from "../main/agents/cursor/turn-wrapper-setup.js";
import {
  CURSOR_MCP_CONNECTOR_SERVER_FILE,
  cursorMcpConnectorListenPath,
  cursorMcpPipeConnectorArgs,
  cursorWindowsMcpRuntimeEnv,
  prepareCursorWindowsConnectorRoot,
} from "../main/agents/cursor/windows-turn.js";
import { materializeAttestableMcpRuntime, withLoopAlive, wrapperMcpRuntimeEnv } from "./cursor-provider-adapter.fixture.js";

// Cursor's MCP connector pipe on Windows, against a hostile server. The
// connector opens the pipe through the sealed daemon pipe addon (as the
// supervisor daemon's clients do, #1812) and sends the turn's proof only to
// this turn's wrapper; the wrapper's pipe admits this user alone, and a name
// a squatter holds first fails the turn before Cursor starts. The squatter is
// #1812's (apps/desktop/native/win-daemon-pipe/pipe-squatter.cs). Windows only,
// with the addon built (build.mjs), as in CI's desktop-tests-windows shards.

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = join(here, "..", "..", "native", "win-daemon-pipe");
const addonPath = join(nativeDir, "build", process.arch === "arm64" ? "arm64" : "x64", DAEMON_PIPE_ADDON_NAME);
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(addonPath) ? "build the daemon pipe addon first (build.mjs)" : false;
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");

/** An elevated administrator: `net session` answers only one. */
function elevated(): boolean {
  return spawnSync(join(system32, "net.exe"), ["session"], { stdio: "ignore", windowsHide: true }).status === 0;
}
// A scheduled task as SYSTEM is created only on a CI runner, never on a developer's machine.
const systemSkip = skip || (process.env.CI !== "true" ? "creates a SYSTEM scheduled task: CI only" : !elevated() ? "needs an elevated administrator" : false);

let folder = "";
let lowFolder = "";
let squatterExe = "";
before(() => {
  if (skip) return;
  folder = mkdtempSync(join(tmpdir(), "letagents-cursor-pipe-"));
  squatterExe = join(folder, "pipe-squatter.exe");
  const source = join(nativeDir, "pipe-squatter.cs");
  execFileSync(powershell, [
    "-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source.replaceAll("'", "''")}')) -OutputAssembly '${squatterExe.replaceAll("'", "''")}' -OutputType ConsoleApplication`,
  ], { stdio: "inherit", windowsHide: true, timeout: 120_000 });
  // As in daemon-pipe.windows.test.mjs: reports go below a low label, and Everyone reaches the program.
  lowFolder = join(folder, "reports");
  mkdirSync(lowFolder);
  execFileSync(join(system32, "icacls.exe"), [lowFolder, "/setintegritylevel", "(OI)(CI)L"], { stdio: "ignore", windowsHide: true });
  execFileSync(join(system32, "icacls.exe"), [folder, "/grant", "*S-1-1-0:(OI)(CI)RX"], { stdio: "ignore", windowsHide: true });
  execFileSync(join(system32, "icacls.exe"), [lowFolder, "/grant", "*S-1-1-0:(OI)(CI)M"], { stdio: "ignore", windowsHide: true });
});
after(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

async function waitFor<T>(check: () => T | false | null | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface Scene {
  connectorRoot: string;
  socketPath: string;
  pipe: string;
  proof: string;
  report: string;
  ready: string;
  config: string;
}

let rounds = 0;
/**
 * A turn's connector folder as main and the wrapper leave it (the proof, and
 * the pid of the process that should serve the pipe), its pipe name, and a
 * squatter's config for that name.
 */
function scene(serverPid = process.pid): Scene {
  rounds += 1;
  const connectorRoot = join(folder, `letagents-cursor-mcp-${randomUUID()}`);
  prepareCursorWindowsConnectorRoot(connectorRoot);
  writeFileSync(join(connectorRoot, CURSOR_MCP_CONNECTOR_SERVER_FILE), String(serverPid));
  const socketPath = join(connectorRoot, "stdio.sock");
  const pipe = cursorMcpConnectorListenPath(socketPath);
  const report = join(lowFolder, `report-${rounds}.json`);
  const ready = join(lowFolder, `ready-${rounds}`);
  const probe = join(folder, `probe-${rounds}.txt`);
  writeFileSync(probe, "only the client's own token opens this\n");
  const config = join(folder, `config-${rounds}.txt`);
  writeFileSync(config, [pipe, report, probe, ready].join("\r\n"));
  return { connectorRoot, socketPath, pipe, proof: readFileSync(join(connectorRoot, "connector.proof"), "utf8").trim(), report, ready, config };
}

/**
 * Run the squatter as this user ("squat", or "shared" for a pipe that allows
 * more instances), at low integrity ("low"), or with this user's SID for deny
 * only ("denyonly").
 */
async function squat(state: Scene, mode: "squat" | "shared" | "low" | "denyonly") {
  const child = spawn(squatterExe, [mode, state.config], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await waitFor(() => existsSync(state.ready) || existsSync(state.report), "the squatter's pipe");
  return { pid: child.pid!, exited, kill: () => child.kill() };
}

/** Run `command` as SYSTEM through a scheduled task, as a service would; returns the task's remover. */
function runAsSystem(command: string): () => void {
  const task = `letagents-cursor-pipe-${process.pid}-${rounds}-${randomBytes(4).toString("hex")}`;
  const schtasks = join(system32, "schtasks.exe");
  execFileSync(schtasks, ["/create", "/tn", task, "/tr", command, "/sc", "once", "/st", "23:59", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"], { stdio: "ignore", windowsHide: true });
  execFileSync(schtasks, ["/run", "/tn", task], { stdio: "ignore", windowsHide: true });
  return () => { spawnSync(schtasks, ["/delete", "/tn", task, "/f"], { stdio: "ignore", windowsHide: true }); };
}

function report(state: Scene): Promise<Record<string, any>> {
  return waitFor(() => existsSync(state.report) && JSON.parse(readFileSync(state.report, "utf8")), "the squatter's report");
}

/** Start Cursor's connector for `state` as Cursor would (mcp.json's command), send `input`, and collect the outcome. */
function runConnector(state: Scene, input = "") {
  const child = spawn(process.execPath, cursorMcpPipeConnectorArgs(state.socketPath), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  if (input) child.stdin.write(input);
  return {
    child,
    result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

/** A pipe server in this process, as the wrapper's: every connection goes to `onConnection`. */
async function listen(pipe: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, () => resolve()); });
  return server;
}

/** The wrapper's windowsSealConnectorPipe, from the same text the wrapper embeds. */
const sealConnectorPipe = skip ? null : new Function("path", "process", "require",
  `${WINDOWS_CONNECTOR_PIPE_SEAL_SOURCE}\nreturn windowsSealConnectorPipe;`)(path, process, createRequire(import.meta.url)) as (pipe: string) => Promise<void>;

/** Open the pipe as SYSTEM from PowerShell: "connected", or the exception's type name. */
async function systemClient(pipe: string): Promise<string> {
  rounds += 1;
  const script = join(folder, `system-client-${rounds}.ps1`);
  const out = join(lowFolder, `system-client-${rounds}.txt`);
  writeFileSync(script, [
    "$result = 'none'",
    `try { $p = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipe.slice("\\\\.\\pipe\\".length)}', [System.IO.Pipes.PipeDirection]::InOut); $p.Connect(5000); $result = 'connected'; $p.Dispose() }`,
    "catch { $result = $_.Exception.InnerException.GetType().FullName + '|' + $_.Exception.GetType().FullName }",
    `[IO.File]::WriteAllText('${out}', $result)`,
  ].join("\r\n"));
  const remove = runAsSystem(`"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`);
  try {
    return await waitFor(() => existsSync(out) && readFileSync(out, "utf8"), "the SYSTEM client's answer", 60_000);
  } finally { remove(); }
}

test("the connector reaches its own wrapper through the addon and sends the proof first", { skip }, async () => {
  const state = scene();
  let received = "";
  const server = await listen(state.pipe, (socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("ping\n")) socket.end("pong\n");
    });
  });
  try {
    const { result } = runConnector(state, "ping\n");
    const outcome = await result;
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(received, `${state.proof}\nping\n`, "the proof line, then Cursor's bytes");
    assert.equal(outcome.stdout, "pong\n");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a same-user squatter is not this turn's wrapper: the connector closes the pipe before it writes", { skip }, async () => {
  const state = scene();
  const squatter = await squat(state, "squat");
  const { result } = runConnector(state, "secret-request\n");
  const outcome = await result;
  const seen = await report(state);
  await squatter.exited;
  assert.equal(outcome.code, 67, outcome.stderr);
  assert.match(outcome.stderr, /not this turn's wrapper/);
  assert.equal(seen.bytesRead, 0, "the squatter read nothing, so not the proof");
  assert.equal(outcome.stdout, "");
});

for (const [mode, refusal] of [["low", /lower integrity level/], ["denyonly", /deny only/]] as const) {
  test(`a squatter ${mode === "low" ? "at low integrity" : "with this user's SID for deny only"} is refused by the addon before the connector writes`, { skip }, async () => {
    const state = scene();
    const squatter = await squat(state, mode);
    const { result } = runConnector(state, "secret-request\n");
    const outcome = await result;
    const seen = await report(state);
    await squatter.exited;
    assert.equal(outcome.code, 67, outcome.stderr);
    assert.match(outcome.stderr, refusal);
    assert.equal(seen.bytesRead, 0, "the squatter read nothing");
  });
}

test("a SYSTEM squatter (SeImpersonatePrivilege) gets not one byte, and no token it can use", { skip: systemSkip }, async () => {
  const state = scene();
  const remove = runAsSystem(`"${squatterExe}" squat "${state.config}"`);
  try {
    await waitFor(() => existsSync(state.ready) || existsSync(state.report), "the SYSTEM squatter's pipe");
    const { result } = runConnector(state, "secret-request\n");
    const outcome = await result;
    const seen = await report(state);
    assert.match(seen.user, /SYSTEM$/i);
    assert.equal(outcome.code, 67, outcome.stderr);
    assert.match(outcome.stderr, /another user|cannot be (opened|read)/);
    assert.equal(seen.bytesRead, 0, "the connector wrote nothing to it");
    if (seen.beforeRead.ok) assert.ok(seen.beforeRead.level <= 1, `impersonation level ${seen.beforeRead.level}`);
  } finally { remove(); }
});

test("the wrapper's seal limits the pipe to this user, for the instances libuv adds later too", { skip }, async () => {
  const state = scene();
  const connections: Socket[] = [];
  let proven: Socket | null = null;
  const server = await listen(state.pipe, (socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
    let received = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      received += chunk;
      if (received === `${state.proof}\n`) proven = socket;
    });
  });
  const opened: number[] = [];
  try {
    await sealConnectorPipe!(state.pipe);
    // libuv starts a new instance for each accepted one, on its next loop
    // turn: hold more than it created at listen, waiting while all are busy.
    const addon = loadDaemonPipeAddon();
    const deadline = Date.now() + 10_000;
    while (opened.length < 6) {
      let pipe: { fd: number; serverPid: number };
      try {
        pipe = addon.open(state.pipe);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      opened.push(pipe.fd);
      assert.equal(pipe.serverPid, process.pid);
    }
    // Cursor's connector (this user) still reaches it, on an instance made after the seal.
    const { result } = runConnector(state);
    const connector = await waitFor(() => proven, "the connector's proof");
    connector.end();
    const outcome = await result;
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.ok(connections.length >= 8, `${connections.length} connections`);
  } finally {
    for (const socket of connections) socket.destroy();
    for (const fd of opened) { try { closeSync(fd); } catch { /* closed */ } }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("SYSTEM opens an unsealed pipe, and not the sealed one", { skip: systemSkip }, async () => {
  const unsealed = scene();
  const control = await listen(unsealed.pipe, (socket) => { socket.on("error", () => undefined); socket.destroy(); });
  try {
    assert.equal(await systemClient(unsealed.pipe), "connected", "Node's default DACL gives SYSTEM full control");
  } finally {
    await new Promise((resolve) => control.close(resolve));
  }
  const state = scene();
  const server = await listen(state.pipe, (socket) => { socket.on("error", () => undefined); socket.destroy(); });
  try {
    await sealConnectorPipe!(state.pipe);
    assert.match(await systemClient(state.pipe), /UnauthorizedAccessException/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a squatter that holds the pipe name first fails the turn closed: Cursor never starts", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-windows-squat-"));
  const statePath = join(root, "turn.jsonl");
  const homeDir = join(root, "home");
  const connectorRoot = join(CURSOR_MCP_CONNECTOR_PARENT, `letagents-cursor-mcp-${randomUUID()}`);
  const socketPath = join(connectorRoot, "stdio.sock");
  const runtimeDataRoot = prepareCursorTurnRuntimeDataDir();
  const startedPath = join(root, "cursor-started");
  writeFileSync(statePath, "");
  mkdirSync(join(homeDir, ".cursor"), { recursive: true });
  writeFileSync(join(root, "fake-cursor.js"), `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started"); process.exit(0);\n`);
  const cursorBin = join(root, "fake-cursor.cmd");
  writeFileSync(cursorBin, "@ECHO off\r\nnode \"%~dp0\\fake-cursor.js\" %*\r\n");
  // The squatter takes the name the wrapper will listen on.
  rounds += 1;
  const squatScene: Scene = {
    connectorRoot, socketPath, pipe: cursorMcpConnectorListenPath(socketPath), proof: "",
    report: join(lowFolder, `report-${rounds}.json`), ready: join(lowFolder, `ready-${rounds}`), config: join(folder, `config-${rounds}.txt`),
  };
  writeFileSync(join(folder, `probe-${rounds}.txt`), "probe\n");
  writeFileSync(squatScene.config, [squatScene.pipe, squatScene.report, join(folder, `probe-${rounds}.txt`), squatScene.ready].join("\r\n"));
  // Its pipe allows more instances, so only libuv's first-instance flag keeps the wrapper from joining it.
  const squatter = await squat(squatScene, "shared");
  try {
    // The control: a server that does not ask for the first instance adds one beside the squatter's.
    const joined = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      `try { $s = [System.IO.Pipes.NamedPipeServerStream]::new('${squatScene.pipe.slice("\\\\.\\pipe\\".length)}', 'InOut', -1); $s.Dispose(); 'joined' } catch { $_.Exception.Message }`],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.equal(joined.stdout.trim(), "joined", joined.stderr);
    const child = defaultLaunchTurn({
      cursorBin,
      args: ["-p", "--output-format", "stream-json", "squatted pipe"],
      cwd: root,
      env: { ...process.env, HOME: homeDir, CURSOR_DATA_DIR: runtimeDataRoot },
      deferStart: true,
      statePath,
      mcpConnectorSocketPath: socketPath,
      mcpRuntimeEntryPath: materializeAttestableMcpRuntime(join(root, "attestable-mcp-runtime")),
      mcpRuntimeCwd: root,
      mcpRuntimeEnv: { ...wrapperMcpRuntimeEnv(connectorRoot, "cursor:windows-squat"), ...cursorWindowsMcpRuntimeEnv(connectorRoot, undefined) },
      providerAuthorization: "Bearer windows-squat-provider-proof",
      restrictRemoteAuthority: true,
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
    });
    await child.prepared;
    child.release();
    const exit = await withLoopAlive(child.exited);
    assert.notDeepEqual(exit, { type: "exit", code: 0, signal: null }, child.stderrTail());
    const terminal = JSON.parse(readFileSync(`${statePath}.terminal.json`, "utf8")) as Record<string, unknown>;
    assert.equal(terminal.type, "not_started", JSON.stringify(terminal));
    assert.match(String(terminal.error), /listen EADDRINUSE/);
    assert.equal(existsSync(startedPath), false, "Cursor never started");
    assert.equal(existsSync(squatScene.report), false, "nothing connected to the squatter");
  } finally {
    squatter.kill();
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
