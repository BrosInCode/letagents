import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = join(root, "release", "LetAgents-darwin", "LetAgents.app");
const executable = join(bundle, "Contents", "MacOS", "LetAgents");
const home = await mkdtemp(join(tmpdir(), "letagents-packaged-smoke-"));
const socketPath = join(home, ".letagents", "daemon.sock");
const protocolVersion = 2;

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

try {
  console.log("packaged-smoke: first launch");
  await launch();
  const first = await request("daemon.status");
  console.log(`packaged-smoke: daemon ${first.pid} generation ${first.generation} survived first app exit`);
  console.log("packaged-smoke: relaunch");
  await launch();
  const second = await request("daemon.status");
  if (first.pid !== second.pid || first.generation !== second.generation) {
    throw new Error(`daemon did not survive packaged app relaunch: ${JSON.stringify({ first, second })}`);
  }
  console.log(JSON.stringify({ packagedApp: bundle, daemonPid: first.pid, generation: first.generation, survivedRelaunch: true }));
  await request("daemon.prepare_handoff");
} finally {
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await rm(home, { recursive: true, force: true });
}
