import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { connectDaemon, daemonEndpoint } from "../../../../shared/daemon-endpoint.mjs";
import { isolatePackagedBundle } from "./packaged-artifact-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const windows = process.platform === "win32";
const builtBundle = windows ? join(root, "release", "LetAgents-win32", "LetAgents") : join(root, "release", "LetAgents-darwin", "LetAgents.app");
// Every check of the packaged app uses a copy outside the checkout: see packaged-artifact-isolation.mjs.
const isolated = await isolatePackagedBundle(builtBundle);
const bundle = isolated.bundle;
const executable = windows ? join(bundle, "LetAgents.exe") : join(bundle, "Contents", "MacOS", "LetAgents");
const developmentDaemon = join(root, "dist-daemon", "main.js");
const daemonTypes = await import(pathToFileURL(join(root, "dist-daemon", "types.js")).href);
// A Windows daemon's first start takes about 8 s in an emulated x64 VM.
const launchTimeoutMs = windows ? 90_000 : 15_000;
const daemonReadyTimeoutMs = windows ? 30_000 : 5_000;
const home = await mkdtemp(join(tmpdir(), "letagents-packaged-smoke-"));
// macOS: <home>/.letagents/daemon.sock. Windows: the named pipe for that folder.
const socketPath = daemonEndpoint(join(home, ".letagents")).connectPath;
const protocolVersion = daemonTypes.DAEMON_PROTOCOL_VERSION;
const appRoot = windows ? join(bundle, "resources", "app") : join(bundle, "Contents", "Resources", "app");
const importCheck = join(dirname(fileURLToPath(import.meta.url)), "packaged-app-import-check.mjs");

/**
 * The daemon runs the packaged program in Node mode and loads a provider
 * adapter only when an agent starts, so a start of the app does not prove
 * that the adapters load. Run the same program in the same mode on the
 * import check, once as the app starts it and once with the condition that
 * the repository's tests use, which must not change what a shipped app loads.
 */
function assertPackagedAppImports() {
  for (const nodeOptions of ["", "--conditions=letagents-source"]) {
    const result = spawnSync(executable, [importCheck, appRoot], {
      cwd: appRoot,
      encoding: "utf8",
      // No NODE_PATH: it would let the check load packages from outside the app.
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: nodeOptions, NODE_PATH: "" },
      timeout: 120_000,
    });
    process.stdout.write(result.stdout ?? "");
    if (result.status !== 0) {
      throw new Error(`packaged import check failed (NODE_OPTIONS=${JSON.stringify(nodeOptions)}): ${result.error?.message ?? result.stderr}`);
    }
  }
}

async function assertPackagedDaemonExecutorSeal() {
  const verifierPath = join(appRoot, "dist-electron", "main", "agents", "letagents-mcp-runtime.js");
  const executorPath = join(appRoot, "runtime", "letagents", "node_modules", "letagents", "dist", "mcp", "server", "daemon-tool-executor.js");
  const loader = await import(pathToFileURL(join(appRoot, "dist-daemon", "supervised-tool-runtime.js")).href);
  const verifier = await import(pathToFileURL(verifierPath).href);
  const runtime = await loader.loadSupervisedToolRuntimeAt(executorPath, {
    verifierPath,
    expectedTreeSha256: verifier.LETAGENTS_MCP_RUNTIME_TREE_SHA256,
  });
  if (typeof runtime.executeDaemonTool !== "function") {
    throw new Error("packaged daemon executor did not pass its sealed runtime contract");
  }
}

function request(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = randomUUID();
    const socket = connectDaemon(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error(`timeout: ${method}`)); });
    socket.once("error", (error) => { socket.destroy(); reject(error); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      socket.destroy();
      if (!response.ok) reject(new Error(response.error));
      else resolveRequest(response.result);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: protocolVersion, id, method, params })}\n`));
  });
}

function launch() {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, [], {
      // Its own APPDATA: an installed app holds the single-instance lock of the real one.
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LETAGENTS_PACKAGED_SUPERVISOR_SMOKE: "1", ELECTRON_ENABLE_LOGGING: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let ready = false;
    const timeout = setTimeout(() => {
      // Report where the app waits before the kill; a timeout with no evidence cannot tell a hang from a slow start.
      void launchTimeoutEvidence(child.pid).then((evidence) => {
        child.kill("SIGKILL");
        reject(new Error(`packaged Electron launch timed out after ${launchTimeoutMs} ms: ${output}\n${evidence}`));
      });
    }, launchTimeoutMs);
    const capture = (chunk) => {
      output += chunk;
      if (!ready && output.includes("LETAGENTS_PACKAGED_SUPERVISOR_READY")) {
        ready = true;
        // Model the user quitting the packaged desktop process. The detached
        // daemon must remain live and answer after this process is gone.
        child.kill("SIGTERM");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        clearTimeout(timeout);
        resolveLaunch(output);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(`packaged Electron exited ${code}: ${output}`));
    });
  });
}

/** What is known at a launch timeout: the app's call stacks (macOS), the daemon's answer, and the log files of the scratch home. */
async function launchTimeoutEvidence(pid) {
  const parts = [];
  if (process.platform === "darwin" && pid) {
    const sampled = spawnSync("sample", [String(pid), "3"], { encoding: "utf8", timeout: 20_000 });
    parts.push(`sample of pid ${pid}:\n${`${sampled.stdout ?? ""}${sampled.stderr ?? ""}`.split("\n").slice(0, 160).join("\n")}`);
  }
  parts.push(`daemon.status: ${await request("daemon.status").then((status) => JSON.stringify(status), (error) => `no answer (${error instanceof Error ? error.message : String(error)})`)}`);
  const entries = await readdir(home, { recursive: true }).catch(() => []);
  parts.push(`files in the scratch home: ${entries.length}`);
  for (const entry of entries.filter((name) => name.endsWith(".log")).slice(0, 8)) {
    const text = await readFile(join(home, entry), "utf8").catch(() => "");
    parts.push(`${entry} (last lines):\n${text.split("\n").slice(-40).join("\n")}`);
  }
  return parts.join("\n");
}

async function launchDevelopmentDaemon() {
  const child = spawn(process.execPath, [developmentDaemon], {
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT: "packaged-smoke-stale-development-runtime",
    },
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + daemonReadyTimeoutMs;
  while (Date.now() < deadline) {
    try { return await request("daemon.status"); }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
  }
  throw new Error("development daemon did not become ready");
}

// The import checks start no app, so they register no letagents:// link
// handler. A developer machine with an installed app can run them alone.
const importsOnly = process.env.LETAGENTS_PACKAGED_SMOKE_IMPORTS_ONLY === "1";
try {
  console.log(`packaged-smoke: copy of the packaged app at ${bundle}`);
  console.log("packaged-smoke: import names and provider adapters");
  assertPackagedAppImports();
  if (importsOnly) {
    console.log(JSON.stringify({ packagedApp: bundle, importsOnly: true }));
    process.exitCode = 0;
  } else {
    await runLaunchChecks();
  }
} finally {
  if (!importsOnly) {
    await request("daemon.prepare_handoff").catch(() => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await rm(isolated.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function runLaunchChecks() {
  console.log("packaged-smoke: sealed daemon executor");
  await assertPackagedDaemonExecutorSeal();
  console.log("packaged-smoke: cross-install predecessor");
  const predecessor = await launchDevelopmentDaemon();
  console.log(`packaged-smoke: development daemon ${predecessor.pid} generation ${predecessor.generation}`);
  console.log("packaged-smoke: first packaged launch");
  await launch();
  const first = await request("daemon.status");
  if (first.pid === predecessor.pid || first.generation <= predecessor.generation) {
    throw new Error(`packaged app did not replace the development daemon: ${JSON.stringify({ predecessor, first })}`);
  }
  console.log(`packaged-smoke: daemon ${first.pid} generation ${first.generation} survived first app exit`);
  console.log("packaged-smoke: relaunch");
  await launch();
  const second = await request("daemon.status");
  if (first.pid !== second.pid || first.generation !== second.generation) {
    throw new Error(`daemon did not survive packaged app relaunch: ${JSON.stringify({ first, second })}`);
  }
  console.log(JSON.stringify({ packagedApp: bundle, daemonPid: first.pid, generation: first.generation, survivedRelaunch: true }));
}
