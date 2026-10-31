// letagents-daemon-pipe.node on a real Windows host, through
// shared/daemon-endpoint.mjs. Runs in CI's desktop-tests-windows job after
// build.mjs built the addon:
//   node --test apps/desktop/native/win-daemon-pipe/daemon-pipe.windows.test.mjs
// Elsewhere, or without a build, every test is skipped.
//
// A squatter (pipe-squatter.cs) takes the daemon's pipe name first and tries
// to impersonate whoever connects. Through libuv's own connect it gets an
// Impersonation token that opens the client's files. Through connectDaemon
// it gets an Identification token that opens nothing, and a squatter of
// another account, or at a lower integrity level, receives not one byte.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acceptDaemonPeer, connectDaemon, daemonEndpoint, ensureDaemonProof } from "../../../../shared/daemon-endpoint.mjs";
import { DAEMON_PIPE_ADDON_NAME, findDaemonPipeAddon, loadDaemonPipeAddon } from "../../../../shared/daemon-pipe-native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const addonPath = join(here, "build", process.arch === "arm64" ? "arm64" : "x64", DAEMON_PIPE_ADDON_NAME);
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(addonPath) ? "build the addon first (build.mjs)" : false;
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const ERROR_BAD_IMPERSONATION_LEVEL = 1346;
const SecurityIdentification = 1;
const SecurityImpersonation = 2;

/** An elevated administrator: `net session` answers only one. */
function elevated() {
  return spawnSync(join(system32, "net.exe"), ["session"], { stdio: "ignore", windowsHide: true }).status === 0;
}
// A scheduled task as SYSTEM is created only on a CI runner, never on a developer's machine.
const systemSkip = skip || (process.env.CI !== "true" ? "creates a SYSTEM scheduled task: CI only" : !elevated() ? "needs an elevated administrator" : false);

let folder = "";
let lowFolder = "";
let squatterExe = "";
before(() => {
  if (skip) return;
  folder = mkdtempSync(join(tmpdir(), "letagents-pipe-squat-"));
  squatterExe = join(folder, "pipe-squatter.exe");
  const source = join(here, "pipe-squatter.cs");
  execFileSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source.replaceAll("'", "''")}')) -OutputAssembly '${squatterExe.replaceAll("'", "''")}' -OutputType ConsoleApplication`,
  ], { stdio: "inherit", windowsHide: true, timeout: 120_000 });
  // The squatters write their reports here; a low-integrity one may write only below a low label.
  lowFolder = join(folder, "reports");
  mkdirSync(lowFolder);
  execFileSync(join(system32, "icacls.exe"), [lowFolder, "/setintegritylevel", "(OI)(CI)L"], { stdio: "ignore", windowsHide: true });
  // A squatter with this user's SID for deny only reaches its program and reports through Everyone.
  execFileSync(join(system32, "icacls.exe"), [folder, "/grant", "*S-1-1-0:(OI)(CI)RX"], { stdio: "ignore", windowsHide: true });
  execFileSync(join(system32, "icacls.exe"), [lowFolder, "/grant", "*S-1-1-0:(OI)(CI)M"], { stdio: "ignore", windowsHide: true });
});
after(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

async function waitFor(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let rounds = 0;
/** A state root with a private proof, its pipe name, and a squatter's config. */
async function scene() {
  rounds += 1;
  const root = join(folder, `state-${rounds}`);
  mkdirSync(root);
  const endpoint = daemonEndpoint(root);
  await ensureDaemonProof(endpoint.proofPath);
  const report = join(lowFolder, `report-${rounds}.json`);
  const ready = join(lowFolder, `ready-${rounds}`);
  const probe = join(folder, `probe-${rounds}.txt`);
  writeFileSync(probe, "only the client's own token opens this\n");
  const config = join(folder, `config-${rounds}.txt`);
  writeFileSync(config, [endpoint.connectPath, report, probe, ready].join("\r\n"));
  return { root, endpoint, report, ready, config };
}

/** Run the squatter as this user ("squat"), at low integrity ("low"), or with this user's SID for deny only ("denyonly"). */
async function squat(scene, mode) {
  const child = spawn(squatterExe, [mode, scene.config], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await waitFor(() => existsSync(scene.ready) || existsSync(scene.report), "the squatter's pipe");
  return { exited, kill: () => child.kill() };
}

/** Run the squatter as SYSTEM through a scheduled task, as a service with SeImpersonatePrivilege would. */
async function squatAsSystem(scene) {
  const task = `letagents-pipe-squatter-${process.pid}-${rounds}`;
  const schtasks = join(system32, "schtasks.exe");
  execFileSync(schtasks, ["/create", "/tn", task, "/tr", `"${squatterExe}" squat "${scene.config}"`, "/sc", "once", "/st", "23:59", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"], { stdio: "ignore", windowsHide: true });
  execFileSync(schtasks, ["/run", "/tn", task], { stdio: "ignore", windowsHide: true });
  await waitFor(() => existsSync(scene.ready) || existsSync(scene.report), "the SYSTEM squatter's pipe");
  return { remove: () => spawnSync(schtasks, ["/delete", "/tn", task, "/f"], { stdio: "ignore", windowsHide: true }) };
}

function report(scene) {
  return waitFor(() => existsSync(scene.report) && JSON.parse(readFileSync(scene.report, "utf8")), "the squatter's report");
}

/** Connect, write once connected, and collect what happened. */
function exchange(socket, request) {
  return new Promise((resolve) => {
    let connected = false;
    let data = "";
    let error = null;
    socket.setEncoding("utf8");
    socket.once("connect", () => { connected = true; socket.write(request); });
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) socket.end(); });
    socket.once("error", (failure) => { error = failure; });
    socket.once("close", () => resolve({ connected, data, error }));
  });
}

test("only the sealed addon is loaded", { skip }, () => {
  const loaded = loadDaemonPipeAddon();
  assert.equal(loaded.path, addonPath);
  assert.equal(typeof loaded.open, "function");
  assert.throws(() => findDaemonPipeAddon({ seal: { builds: { x64: { sha256: "0".repeat(64) } } } }),
    (error) => error.code === "ERR_LETAGENTS_DAEMON_PIPE_ADDON" && /not the sealed/.test(error.message));
  assert.throws(() => loaded.open("\\\\server\\pipe\\letagents-daemon-x"), (error) => error.code === "EINVAL", "never a remote pipe");
  assert.throws(() => loaded.open("\\\\.\\pipe\\..\\..\\C:\\Windows\\win.ini"), (error) => error.code === "EINVAL", "never a path out of the pipe namespace");
  assert.throws(() => loaded.open("\\\\.\\pipe\\letagents-daemon-absent"), (error) => error.code === "ENOENT");
});

test("a client reaches its own daemon through the addon, and the daemon is this process", { skip }, async () => {
  const state = await scene();
  const proof = await ensureDaemonProof(state.endpoint.proofPath);
  const server = createServer((socket) => acceptDaemonPeer(socket, proof, (admitted) => {
    admitted.setEncoding("utf8");
    admitted.on("data", (chunk) => admitted.end(`pong:${chunk}`));
  }));
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(state.endpoint.listenPath, resolve); });
    const opened = loadDaemonPipeAddon().open(state.endpoint.connectPath);
    assert.equal(opened.serverPid, process.pid);
    new Socket({ fd: opened.fd, readable: true, writable: true }).destroy();
    const result = await exchange(connectDaemon(state.endpoint.connectPath, { proofPath: state.endpoint.proofPath }), "ping\n");
    assert.deepEqual(result, { connected: true, data: "pong:ping\n", error: null });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Electron runs the addon too: a client inside the app's executable reaches the daemon", { skip }, async (t) => {
  let electron;
  try { electron = createRequire(join(here, "..", "..", "package.json"))("electron"); } catch { electron = null; }
  if (typeof electron !== "string" || !existsSync(electron)) { t.skip("Electron is not installed (npm exec install-electron)"); return; }
  const state = await scene();
  const proof = await ensureDaemonProof(state.endpoint.proofPath);
  const server = createServer((socket) => acceptDaemonPeer(socket, proof, (admitted) => {
    admitted.setEncoding("utf8");
    admitted.on("data", (chunk) => admitted.end(`pong:${chunk}`));
  }));
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(state.endpoint.listenPath, resolve); });
    const script = join(folder, `electron-probe-${rounds}.mjs`);
    writeFileSync(script, [
      `const { connectDaemon } = await import(${JSON.stringify(pathToFileURL(join(here, "..", "..", "..", "..", "shared", "daemon-endpoint.mjs")).href)});`,
      `const socket = connectDaemon(${JSON.stringify(state.endpoint.connectPath)}, { proofPath: ${JSON.stringify(state.endpoint.proofPath)} });`,
      "let data = ''; socket.setEncoding('utf8');",
      "socket.once('connect', () => socket.write('electron\\n'));",
      "socket.on('data', (chunk) => { data += chunk; });",
      "socket.once('error', (error) => { console.error(error); process.exitCode = 1; });",
      "socket.once('close', () => console.log('LETAGENTS_PIPE_PROBE ' + JSON.stringify({ data, electron: process.versions.electron })));",
    ].join("\n"));
    const child = spawn(electron, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stdout);
    const probe = JSON.parse(/LETAGENTS_PIPE_PROBE (.+)/.exec(stdout)?.[1] ?? "null");
    assert.equal(probe?.data, "pong:electron\n");
    assert.ok(probe.electron, "the client ran in Electron");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("libuv's own connect lets a same-user squatter impersonate the client (the risk this addon removes)", { skip }, async () => {
  const state = await scene();
  const squatter = await squat(state, "squat");
  const client = createConnection(state.endpoint.connectPath);
  client.on("error", () => undefined);
  client.once("connect", () => client.write("x\n"));
  const seen = await report(state);
  client.destroy();
  await squatter.exited;
  assert.equal(seen.afterRead.ok, true);
  assert.equal(seen.afterRead.level, SecurityImpersonation);
  assert.equal(seen.afterRead.openError, 0, "the impersonation token opens the client's files");
});

test("through the addon, a same-user squatter gets an Identification token that opens nothing", { skip }, async () => {
  const state = await scene();
  const squatter = await squat(state, "squat");
  const result = await exchange(connectDaemon(state.endpoint.connectPath, { proofPath: state.endpoint.proofPath }), "secret-request\n");
  const seen = await report(state);
  await squatter.exited;
  assert.equal(result.connected, false, "the squatter cannot answer the proof");
  // The server runs as this user, so the client wrote its hello (a random nonce), and only that.
  assert.match(seen.text, /^\{"letagents_daemon_hello":"[0-9a-f]{64}"\}\n$/);
  for (const attempt of [seen.beforeRead, seen.afterRead]) {
    if (!attempt.ok) continue;
    assert.ok(attempt.level <= SecurityIdentification, `impersonation level ${attempt.level}`);
    assert.equal(attempt.openError, ERROR_BAD_IMPERSONATION_LEVEL, "the token opens no file");
  }
  assert.equal(seen.afterRead.ok, true, "the squatter did impersonate, at Identification only");
});

test("a squatter at low integrity is refused before the client writes", { skip }, async () => {
  const state = await scene();
  const squatter = await squat(state, "low");
  const result = await exchange(connectDaemon(state.endpoint.connectPath, { proofPath: state.endpoint.proofPath }), "secret-request\n");
  const seen = await report(state);
  await squatter.exited;
  assert.equal(result.connected, false);
  assert.equal(result.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
  assert.match(result.error?.message ?? "", /lower integrity level/);
  assert.equal(seen.bytesRead, 0, "the squatter read nothing");
  if (seen.beforeRead.ok) assert.ok(seen.beforeRead.level <= SecurityIdentification, `impersonation level ${seen.beforeRead.level}`);
});

test("a squatter with this user's SID for deny only is refused before the client writes", { skip }, async () => {
  const state = await scene();
  const squatter = await squat(state, "denyonly");
  const result = await exchange(connectDaemon(state.endpoint.connectPath, { proofPath: state.endpoint.proofPath }), "secret-request\n");
  const seen = await report(state);
  await squatter.exited;
  assert.equal(result.connected, false);
  assert.equal(result.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
  assert.match(result.error?.message ?? "", /deny only/);
  assert.equal(seen.bytesRead, 0, "the squatter read nothing");
});

test("another spelling of the daemon pipe never reaches libuv", { skip }, async () => {
  const state = await scene();
  const proof = await ensureDaemonProof(state.endpoint.proofPath);
  let connections = 0;
  const server = createServer((socket) => { connections += 1; acceptDaemonPeer(socket, proof, () => undefined); });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(state.endpoint.listenPath, resolve); });
    const name = state.endpoint.connectPath.slice("\\\\.\\pipe\\".length);
    for (const alias of [`//./pipe/${name}`, `\\\\localhost\\pipe\\${name}`, `\\\\?\\pipe\\${name}`]) {
      const result = await exchange(connectDaemon(alias, { proofPath: state.endpoint.proofPath }), "secret-request\n");
      assert.equal(result.connected, false, alias);
      assert.equal(result.error?.code, "EINVAL", `${alias}: ${result.error?.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 0, "the daemon saw no connection from any alias");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a SYSTEM squatter (SeImpersonatePrivilege) gets nothing it can use, while libuv's connect hands it the user", { skip: systemSkip }, async () => {
  // The risk: libuv's connect lets SYSTEM impersonate the client at full level.
  const control = await scene();
  const controlTask = await squatAsSystem(control);
  try {
    const client = createConnection(control.endpoint.connectPath);
    client.on("error", () => undefined);
    client.once("connect", () => client.write("x\n"));
    const seen = await report(control);
    client.destroy();
    assert.match(seen.user, /SYSTEM$/i);
    assert.equal(seen.afterRead.level, SecurityImpersonation);
  } finally { controlTask.remove(); }

  const state = await scene();
  const task = await squatAsSystem(state);
  try {
    const result = await exchange(connectDaemon(state.endpoint.connectPath, { proofPath: state.endpoint.proofPath }), "secret-request\n");
    const seen = await report(state);
    assert.equal(result.connected, false);
    assert.equal(result.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.match(result.error?.message ?? "", /another user|cannot be (opened|read)/);
    assert.match(seen.user, /SYSTEM$/i);
    assert.equal(seen.bytesRead, 0, "the client wrote nothing to it");
    if (seen.beforeRead.ok) {
      assert.ok(seen.beforeRead.level <= SecurityIdentification, `impersonation level ${seen.beforeRead.level}`);
      assert.equal(seen.beforeRead.openError, ERROR_BAD_IMPERSONATION_LEVEL);
    }
  } finally { task.remove(); }
});
