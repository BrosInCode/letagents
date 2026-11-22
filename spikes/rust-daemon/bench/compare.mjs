/**
 * Black-box comparison of the TypeScript daemon and the Rust spike.
 *
 *   node spikes/rust-daemon/bench/compare.mjs [watch-seconds]
 *
 * Needs: the seed from seed.ts in spikes/rust-daemon/.run/seed, a built
 * apps/desktop/dist-daemon, the root dist/mcp, the release spike binary, and an
 * Electron program to run the TypeScript daemon in Node mode
 * (LETAGENTS_ELECTRON, default /Applications/LetAgents.app/Contents/MacOS/LetAgents).
 *
 * Each daemon gets a fresh copy of the same seeded state folder. The script
 * talks to each one only through its control socket, one connection per
 * request, as the desktop app does.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = resolve(HERE, "..");
const REPO = resolve(SPIKE, "../..");
const RUN = join(SPIKE, ".run");
const ELECTRON = process.env.LETAGENTS_ELECTRON ?? "/Applications/LetAgents.app/Contents/MacOS/LetAgents";
const WATCH_SECONDS = Number(process.argv[2] ?? 30);
const STARTS = 3;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function request(socketPath, method, params = {}, timeoutMs = 60_000) {
  return new Promise((done, fail) => {
    const socket = connect(socketPath);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); fail(new Error(`${method} timed out`)); }, timeoutMs);
    socket.on("error", (error) => { clearTimeout(timer); fail(error); });
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 3, id: method, method, params })}\n`));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunk.includes(10)) {
        clearTimeout(timer);
        socket.end();
        const raw = Buffer.concat(chunks);
        const reply = JSON.parse(raw.toString("utf8"));
        if (!reply.ok) fail(new Error(`${method}: ${reply.error}`));
        else done({ result: reply.result, bytes: raw.length });
      }
    });
  });
}

/** CPU seconds and resident KB of a process, from ps. */
function usage(pid) {
  const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
  const parts = time.split(":").map(Number);
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return { rssKb: Number(rss), cpuS: seconds };
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2));
};

async function freshHome(name) {
  const home = join(RUN, name);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await cp(join(RUN, "seed", ".letagents"), join(home, ".letagents"), { recursive: true });
  return home;
}

function launch(kind, home) {
  const stateDir = join(home, ".letagents");
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
    // A closed loopback port: no agent runs, and nothing may reach a real server.
    LETAGENTS_API_URL: "http://127.0.0.1:9",
    LETAGENTS_POLL_MAX_MS: "5000",
  };
  if (kind === "ts") {
    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: "1",
      LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174",
      LETAGENTS_DEV_MCP_SERVER_ENTRY: join(REPO, "dist", "mcp", "server.js"),
    });
    const child = spawn(ELECTRON, [join(REPO, "apps", "desktop", "dist-daemon", "main.js")], {
      cwd: stateDir, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const key = randomBytes(32).toString("base64");
    child.on("message", (message) => {
      if (message?.type === "state_recovery_key_request") child.send({ type: "state_recovery_key", id: message.id, key, sealedKey: "spike-sealed-key" });
      if (message?.type === "host_approval_verifier_request") child.send({ type: "host_approval_verifier", id: message.id, publicKey: null });
    });
    return { child, socket: join(stateDir, "daemon.sock") };
  }
  const child = spawn(join(SPIKE, "target", "release", "letagents-daemon-spike"), ["--state-dir", stateDir], {
    cwd: stateDir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, socket: join(stateDir, "daemon.sock") };
}

async function start(kind, name) {
  const home = await freshHome(name);
  const began = performance.now();
  const daemon = launch(kind, home);
  const stderr = [];
  daemon.child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  daemon.child.stdout.on("data", () => undefined);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (daemon.child.exitCode !== null) throw new Error(`${kind} daemon exited: ${stderr.join("").slice(-2000)}`);
    try {
      const { result } = await request(daemon.socket, "daemon.negotiate", {}, 2000);
      return { ...daemon, kind, startupMs: performance.now() - began, status: result, stderr };
    } catch {
      if (Date.now() > deadline) throw new Error(`${kind} daemon did not answer: ${stderr.join("").slice(-2000)}`);
      await sleep(10);
    }
  }
}

async function stop(daemon) {
  if (daemon.child.exitCode !== null) return;
  const exited = new Promise((done) => daemon.child.once("exit", done));
  daemon.child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (daemon.child.exitCode === null) { daemon.child.kill("SIGKILL"); await exited; }
}

async function timedList(daemon, params, count) {
  const times = [];
  let bytes = 0;
  let result;
  const before = usage(daemon.child.pid);
  for (let index = 0; index < count; index += 1) {
    const began = performance.now();
    ({ result, bytes } = await request(daemon.socket, "manifest.list", params));
    times.push(performance.now() - began);
  }
  const after = usage(daemon.child.pid);
  return { p50_ms: quantile(times, 0.5), p90_ms: quantile(times, 0.9), bytes, cpu_s: Number((after.cpuS - before.cpuS).toFixed(2)), result };
}

/** A desktop-like watcher (changed_only) and one writer that changes one agent every 200 ms. */
async function watchLoad(daemon, seconds) {
  const status = await request(daemon.socket, "daemon.status");
  const generation = status.result.generation;
  let sequence = (await request(daemon.socket, "manifest.watch_state", { after_daemon_generation: generation, after_sequence: 0, wait_ms: 0 })).result.sequence;
  const before = usage(daemon.child.pid);
  const end = Date.now() + seconds * 1000;
  const wakes = [];
  let peakRssKb = before.rssKb;
  let writes = 0;
  const sampler = setInterval(() => { try { peakRssKb = Math.max(peakRssKb, usage(daemon.child.pid).rssKb); } catch { /* exited */ } }, 1000);
  const watcher = (async () => {
    while (Date.now() < end) {
      const began = performance.now();
      const { result, bytes } = await request(daemon.socket, "manifest.watch_state", {
        after_daemon_generation: generation, after_sequence: sequence, wait_ms: 5000, changed_only: true,
      });
      wakes.push({ ms: performance.now() - began, bytes, entries: result.entries.length, complete: result.complete !== false });
      sequence = result.sequence;
    }
  })();
  const writer = (async () => {
    let agent = 0;
    while (Date.now() < end) {
      await request(daemon.socket, "manifest.update_workplace_liveness", {
        id: `agent_${agent % 218}`, state: agent % 2 ? "stale" : "reachable", detail: `spike ${agent}`,
        observed_at: new Date().toISOString(),
      });
      agent += 1;
      writes += 1;
      await sleep(200);
    }
  })();
  await Promise.all([watcher, writer]);
  clearInterval(sampler);
  const after = usage(daemon.child.pid);
  const changes = wakes.filter((wake) => !wake.complete);
  return {
    seconds, writes, wakes: wakes.length,
    cpu_s: Number((after.cpuS - before.cpuS).toFixed(2)),
    cpu_percent_of_one_core: Number((100 * (after.cpuS - before.cpuS) / seconds).toFixed(1)),
    mean_entries_per_wake: Number((changes.reduce((sum, wake) => sum + wake.entries, 0) / Math.max(1, changes.length)).toFixed(2)),
    mean_wake_bytes: Math.round(wakes.reduce((sum, wake) => sum + wake.bytes, 0) / Math.max(1, wakes.length)),
    full_snapshots: wakes.length - changes.length,
    rss_mb_after: Number((after.rssKb / 1024).toFixed(1)),
    rss_mb_peak: Number((peakRssKb / 1024).toFixed(1)),
  };
}

function parity(entries, reference, label) {
  const mismatched = [];
  if (entries.length !== reference.length) mismatched.push(`count ${entries.length} != ${reference.length}`);
  for (let index = 0; index < Math.min(entries.length, reference.length); index += 1) {
    if (!isDeepStrictEqual(entries[index], reference[index])) {
      const keys = [...new Set([...Object.keys(entries[index]), ...Object.keys(reference[index])])]
        .filter((key) => !isDeepStrictEqual(entries[index][key], reference[index][key]));
      mismatched.push(`${reference[index].id}: ${keys.join(",")}`);
    }
  }
  const sameBytes = JSON.stringify(entries) === JSON.stringify(reference);
  return { label, entries: entries.length, equal: mismatched.length === 0, byte_identical: sameBytes, mismatched: mismatched.slice(0, 10) };
}

async function measure(kind) {
  const startups = [];
  for (let run = 0; run < STARTS; run += 1) {
    const daemon = await start(kind, `${kind}-start-${run}`);
    startups.push(daemon.startupMs);
    await stop(daemon);
  }
  const daemon = await start(kind, `${kind}-load`);
  try {
    await sleep(5000);
    const idle = usage(daemon.child.pid);
    await sleep(10_000);
    const idleAfter = usage(daemon.child.pid);
    const summary = await timedList(daemon, { activity: "summary" }, 30);
    const full = await timedList(daemon, { activity: "full" }, 10);
    const afterReads = usage(daemon.child.pid);
    const watch = await watchLoad(daemon, WATCH_SECONDS);
    return {
      kind,
      implementation_version: daemon.status.implementation_version,
      startup_ms: startups.map((ms) => Math.round(ms)),
      rss_mb_idle: Number((idle.rssKb / 1024).toFixed(1)),
      idle_cpu_s_10s: Number((idleAfter.cpuS - idle.cpuS).toFixed(2)),
      rss_mb_after_reads: Number((afterReads.rssKb / 1024).toFixed(1)),
      list_summary: { ...summary, result: undefined },
      list_full: { ...full, result: undefined },
      watch,
      status_keys: Object.keys(daemon.status),
      entry_keys: Object.keys(summary.result[0] ?? {}),
      summaryEntries: summary.result,
      fullEntries: full.result,
    };
  } finally {
    await stop(daemon);
  }
}

const reference = {
  summary: JSON.parse(await readFile(join(RUN, "reference", "manifest-summary.json"), "utf8")).entries,
  full: JSON.parse(await readFile(join(RUN, "reference", "manifest-full.json"), "utf8")).entries,
};
const rust = await measure("rust");
const ts = await measure("ts");
const report = {
  measured_at: new Date().toISOString(),
  host: `${execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim()}, ${Math.round(Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" })) / 2 ** 30)} GB`,
  ts_runtime: execFileSync(ELECTRON, ["-p", "`node ${process.versions.node}, sqlite ${process.versions.sqlite}`"], { env: { ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }).trim(),
  parity: [
    parity(rust.summaryEntries, reference.summary, "rust manifest.list summary vs TypeScript store.load(summary)"),
    parity(rust.fullEntries, reference.full, "rust manifest.list full vs TypeScript store.load(full)"),
  ],
  view_only_keys_in_ts_list: ts.entry_keys.filter((key) => !rust.entry_keys.includes(key)),
  status_keys_missing_in_rust: ts.status_keys.filter((key) => !rust.status_keys.includes(key)),
  results: [rust, ts].map(({ summaryEntries, fullEntries, entry_keys, status_keys, ...rest }) => rest),
};
await writeFile(join(RUN, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
