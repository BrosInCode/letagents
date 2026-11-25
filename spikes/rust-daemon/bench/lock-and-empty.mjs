/**
 * Two checks that need no seed data:
 * 1. Start-up time and memory of the TypeScript daemon on an empty state folder.
 * 2. The singleton lock across implementations: while one daemon runs, the other must refuse.
 *
 *   node spikes/rust-daemon/bench/lock-and-empty.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SPIKE, "../..");
const RUN = join(SPIKE, ".run");
const ELECTRON = process.env.LETAGENTS_ELECTRON ?? "/Applications/LetAgents.app/Contents/MacOS/LetAgents";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function negotiate(socketPath) {
  return new Promise((done, fail) => {
    const socket = connect(socketPath);
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 3, id: 1, method: "daemon.negotiate", params: {} })}\n`));
    socket.on("data", (chunk) => { socket.end(); done(JSON.parse(chunk.toString())); });
  });
}

function launch(kind, home) {
  const stateDir = join(home, ".letagents");
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LETAGENTS_API_URL: "http://127.0.0.1:9" };
  if (kind === "ts") {
    Object.assign(env, { ELECTRON_RUN_AS_NODE: "1", LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174", LETAGENTS_DEV_MCP_SERVER_ENTRY: join(REPO, "dist", "mcp", "server.js") });
    const child = spawn(ELECTRON, [join(REPO, "apps", "desktop", "dist-daemon", "main.js")], { cwd: home, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const key = randomBytes(32).toString("base64");
    child.on("message", (m) => {
      if (m?.type === "state_recovery_key_request") child.send({ type: "state_recovery_key", id: m.id, key, sealedKey: "spike-sealed-key" });
      if (m?.type === "host_approval_verifier_request") child.send({ type: "host_approval_verifier", id: m.id, publicKey: null });
    });
    return { child, socket: join(stateDir, "daemon.sock") };
  }
  const child = spawn(join(SPIKE, "target", "release", "letagents-daemon-spike"), ["--state-dir", stateDir], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  return { child, socket: join(stateDir, "daemon.sock") };
}

async function ready(daemon, began) {
  const stderr = [];
  daemon.child.stderr.on("data", (c) => stderr.push(c.toString()));
  daemon.child.stdout.on("data", () => undefined);
  for (;;) {
    if (daemon.child.exitCode !== null) return { exited: daemon.child.exitCode, stderr: stderr.join("").trim().split("\n").slice(-2).join(" | ") };
    try { await negotiate(daemon.socket); return { ms: Math.round(performance.now() - began) }; } catch { await sleep(10); }
  }
}

const stop = async (daemon) => {
  if (daemon.child.exitCode !== null) return;
  const exited = new Promise((done) => daemon.child.once("exit", done));
  daemon.child.kill("SIGTERM");
  await exited;
};
const rssMb = (pid) => Number((Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })) / 1024).toFixed(1));

const empty = [];
for (let run = 0; run < (process.argv.includes("--lock-only") ? 0 : 3); run += 1) {
  const home = join(RUN, `ts-empty-${run}`);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const began = performance.now();
  const daemon = launch("ts", home);
  const result = await ready(daemon, began);
  await sleep(5000);
  empty.push({ ...result, rss_mb_after_5s: rssMb(daemon.child.pid) });
  await stop(daemon);
}

const lock = [];
for (const [first, second] of [["ts", "rust"], ["rust", "ts"]]) {
  const home = join(RUN, `lock-${first}-first`);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await cp(join(RUN, "seed", ".letagents"), join(home, ".letagents"), { recursive: true });
  const owner = launch(first, home);
  const owned = await ready(owner, performance.now());
  const intruder = launch(second, home);
  const stderr = [];
  intruder.child.stderr.on("data", (c) => stderr.push(c.toString()));
  intruder.child.stdout.on("data", () => undefined);
  const code = await Promise.race([new Promise((done) => intruder.child.once("exit", (c) => done(c))), sleep(20_000).then(() => "still running")]);
  const answer = await negotiate(owner.socket);
  lock.push({
    first, second, first_ready_ms: owned.ms,
    second_exit: code,
    second_error: stderr.join("").match(/already owns[^\n"]*|Supervisor daemon failed:[^\n]*/)?.[0] ?? stderr.join("").slice(-300),
    socket_still_answered_by_first: answer.result.pid === owner.child.pid,
  });
  await stop(intruder).catch(() => undefined);
  await stop(owner);
}
console.log(JSON.stringify({ ts_on_empty_state_folder: empty, cross_implementation_lock: lock }, null, 2));
