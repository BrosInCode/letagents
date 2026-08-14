import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = join(root, "release", "LetAgents-darwin", "LetAgents.app");
const executable = join(bundle, "Contents", "MacOS", "LetAgents");
const developmentDaemon = join(root, "dist-daemon", "main.js");
const home = await mkdtemp(join(tmpdir(), "letagents-packaged-smoke-"));
const socketPath = join(home, ".letagents", "daemon.sock");
const protocolVersion = 2;

async function assertPackagedDaemonExecutorSeal() {
  const appRoot = join(bundle, "Contents", "Resources", "app");
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
    const socket = createConnection(socketPath);
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
      env: { ...process.env, HOME: home, LETAGENTS_PACKAGED_SUPERVISOR_SMOKE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let ready = false;
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`packaged Electron launch timed out: ${output}`)); }, 15_000);
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

async function launchDevelopmentDaemon() {
  const child = spawn(process.execPath, [developmentDaemon], {
    detached: true,
    env: {
      ...process.env,
      HOME: home,
      LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT: "packaged-smoke-stale-development-runtime",
    },
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await request("daemon.status"); }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
  }
  throw new Error("development daemon did not become ready");
}

try {
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
} finally {
  await request("daemon.prepare_handoff").catch(() => undefined);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await rm(home, { recursive: true, force: true });
}
