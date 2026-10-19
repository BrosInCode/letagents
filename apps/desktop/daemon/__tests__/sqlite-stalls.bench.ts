/**
 * Measures how long the daemon's synchronous SQLite work blocks the event loop.
 *
 * Drives the real daemon state code (ManifestStore, the daemon schema and its
 * connection settings) in a temporary directory with a write/read load shaped
 * like a busy desktop: activity events from several streaming agents, worker
 * binding publications, and manifest.list / watch_state reads. A 2 ms ticker
 * records every event-loop gap; each gap over 5 ms is charged to the operation
 * that ran during it, and to a checkpoint when SQLite checkpointed in that
 * operation.
 *
 * Run it under the daemon's own runtime (Electron as Node):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     --import tsx daemon/__tests__/sqlite-stalls.bench.ts [mode] [seconds]
 *
 * Modes: default (current behaviour), worker (checkpoint worker), and two
 * attribution-only modes that change durability and must never ship:
 * no-checkpoint (wal_autocheckpoint = 0) and sync-off (synchronous = OFF).
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { ManifestStore } from "../manifest-store.js";
import { openPreparedDaemonStateDatabase } from "../daemon-state-database.js";
import * as stateDatabase from "../daemon-state-database.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";

const mode = process.argv[2] ?? "default";
const seconds = Number(process.argv[3] ?? 30);
const AGENTS = 8;
const SEED_PUBLICATIONS = 40_000;

type Op = { kind: string; start: number; end: number; checkpointed: boolean };

function agentEntry(index: number): DaemonManifestEntry {
  const id = `agent_${index}`;
  return {
    id, room_id: "room_1", display_name: `Agent${index}`, provider: "codex", model: "gpt-5.6-codex",
    charter: "Work on the room's tasks.", desired_state: "running", observed_state: "working",
    condition: "none", last_error: null, permission_profile_id: "workspace-write",
    provider_launch_policy: { deliveryMode: "mcp_polling" }, created_by: "user_1",
    created_at: "2026-10-19T00:00:00.000Z", source_repo_path: "/repo", workspace_path: `/worktrees/${id}`,
    work_attempt_id: `attempt_${index}`,
    provider_ref: {
      work_attempt_id: `attempt_${index}`, provider_continuation_id: `thread_${index}`,
      provider_connection: { kind: "codex_app_server", url: `http://127.0.0.1:${4300 + index}`, pid: 4300 + index, processIdentity: null },
      execution_generation_id: `run_${index}`,
    },
    workplace_liveness: { state: "reachable", observed_at: "2026-10-19T00:01:00.000Z", detail: null },
    native_liveness: { state: "active", observed_at: "2026-10-19T00:01:01.000Z", detail: "streaming" },
    ready_reached_at: "2026-10-19T00:01:00.000Z",
    activity: [],
  } as DaemonManifestEntry;
}

function event(sequence: number, size: number): DaemonActivityEvent {
  return {
    observed_at: new Date().toISOString(), sequence, provider: "codex", kind: "tool",
    method: "item/commandExecution", summary: "Ran a command", status: "working",
    payload: { output: randomBytes(size).toString("base64") }, payload_truncated: false,
    payload_redacted: false, durable_payload_ref: null,
  } as DaemonActivityEvent;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "letagents-sqlite-stalls-"));
  const path = join(root, "daemon-state.sqlite");
  const store = new ManifestStore(path);
  const sqlite = new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS v").get()!.v;
  try {
    await store.write(0, Array.from({ length: AGENTS }, (_, index) => agentEntry(index)));
    // A second operational handle, like the worker binding store's.
    const bindings = await openPreparedDaemonStateDatabase(path);
    // Measurement-only handle. NOOP is a true no-op from SQLite 3.51.
    const observer = new DatabaseSync(Object.assign(pathToFileURL(path), { search: "?mode=rw" }).href);
    const frames = observer.prepare("PRAGMA wal_checkpoint(NOOP)");

    // Seed the publication journal the way a long-lived machine grows it.
    const seed = bindings.prepare(`INSERT INTO worker_binding_publications
      (reservation_id, entry_id, binding_epoch, execution_generation_id, agent_session_id,
       sequence, observed_at, observed_at_ms, state, created_at, finalized_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'accepted', ?, ?)`);
    bindings.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < SEED_PUBLICATIONS; i += 1) {
      const at = new Date(1_700_000_000_000 + i).toISOString();
      seed.run(randomUUID(), `agent_${i % AGENTS}`, `run_${i % AGENTS}`, `session_${i % AGENTS}`, 1_700_000_000_000 + i, at, 1_700_000_000_000 + i, at, at);
    }
    bindings.exec("COMMIT");
    observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const storeDatabase = (store as unknown as { database: DatabaseSync }).database;
    let stopWorker: (() => Promise<void>) | undefined;
    if (mode === "no-checkpoint") for (const db of [storeDatabase, bindings]) db.exec("PRAGMA wal_autocheckpoint = 0");
    if (mode === "sync-off") for (const db of [storeDatabase, bindings]) db.exec("PRAGMA synchronous = OFF");
    if (mode === "worker") {
      const start = (stateDatabase as Record<string, unknown>).startDaemonStateCheckpointWorker as
        undefined | ((path: string) => Promise<{ stop(): Promise<void>; active: boolean }>);
      if (!start) throw new Error("This branch has no checkpoint worker.");
      const worker = await start(path);
      if (!worker.active) throw new Error("The checkpoint worker did not start.");
      stopWorker = () => worker.stop();
    }

    let publicationSequence = 1_800_000_000_000;
    const reserve = bindings.prepare(`INSERT INTO worker_binding_publications (reservation_id, entry_id, binding_epoch, execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'reserved', ?)`);
    const finalize = bindings.prepare("UPDATE worker_binding_publications SET state='accepted', finalized_at=? WHERE reservation_id=? AND state='reserved'");
    const latest = bindings.prepare(`SELECT reservation_id, sequence FROM (
      SELECT reservation_id, sequence FROM worker_binding_publications WHERE entry_id=?
      UNION ALL SELECT reservation_id, sequence FROM worker_generation_verifications WHERE entry_id=?
    ) ORDER BY sequence DESC LIMIT 1`);
    const publish = (agent: number) => {
      const id = randomUUID(); const sequence = ++publicationSequence; const at = new Date().toISOString();
      bindings.exec("BEGIN IMMEDIATE"); reserve.run(id, `agent_${agent}`, `run_${agent}`, `session_${agent}`, sequence, at, sequence, at); bindings.exec("COMMIT");
      bindings.exec("BEGIN IMMEDIATE"); finalize.run(at, id); latest.get(`agent_${agent}`, `agent_${agent}`); bindings.exec("COMMIT");
    };

    const ops: Op[] = [];
    const run = async (kind: string, operation: () => unknown) => {
      const before = frames.get() as { log: number; checkpointed: number };
      const start = performance.now();
      await operation();
      const end = performance.now();
      const after = frames.get() as { log: number; checkpointed: number };
      ops.push({ kind, start, end, checkpointed: after.checkpointed > before.checkpointed || after.log < before.log });
    };

    const gaps: { at: number; gap: number }[] = [];
    let last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); gaps.push({ at: now, gap: now - last }); last = now; }, 2);
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();

    const sequences = new Array(AGENTS).fill(0);
    let generation = (await store.load("summary")).generation;
    const deadline = performance.now() + seconds * 1000;
    let tick = 0;
    while (performance.now() < deadline) {
      tick += 1;
      // ~40 activity events/s across the agents, some with large tool output.
      const agent = tick % AGENTS;
      const size = tick % 10 === 0 ? 24_000 : 1_500;
      await run("activity", async () => {
        generation = (await store.recordActivity(generation, `agent_${agent}`, event(++sequences[agent], size), {
          observedState: "working", nativeLiveness: { state: "active", observed_at: new Date().toISOString(), detail: "streaming" },
        }, 200)).generation;
      });
      if (tick % 20 === 0) await run("publication", () => publish(agent));
      if (tick % 4 === 0) await run("watch_state", () => store.load("summary"));
      if (tick % 20 === 10) await run("manifest.list", () => store.load("full"));
      await new Promise((resolve) => setTimeout(resolve, tick % 200 < 150 ? 15 : 60));
    }
    clearInterval(ticker);
    histogram.disable();
    await stopWorker?.();

    const wal = await stat(`${path}-wal`).then((info) => info.size, () => 0);
    const stalls = gaps.filter((entry) => entry.gap > 5);
    const byCause = new Map<string, { count: number; ms: number }>();
    for (const stall of stalls) {
      const from = stall.at - stall.gap;
      const op = ops.find((candidate) => candidate.start < stall.at && candidate.end > from);
      const cause = !op ? "other" : op.checkpointed ? `${op.kind}+checkpoint` : op.kind;
      const bucket = byCause.get(cause) ?? { count: 0, ms: 0 };
      bucket.count += 1; bucket.ms += stall.gap - 2;
      byCause.set(cause, bucket);
    }
    const opStats: Record<string, { count: number; p50: number; p99: number; max: number; checkpoints: number }> = {};
    for (const kind of new Set(ops.map((op) => op.kind))) {
      const list = ops.filter((op) => op.kind === kind);
      const durations = list.map((op) => op.end - op.start).sort((a, b) => a - b);
      opStats[kind] = {
        count: list.length, p50: +percentile(durations, 0.5).toFixed(2), p99: +percentile(durations, 0.99).toFixed(2),
        max: +durations.at(-1)!.toFixed(2), checkpoints: list.filter((op) => op.checkpointed).length,
      };
    }
    const checkpointOps = ops.filter((op) => op.checkpointed).map((op) => op.end - op.start).sort((a, b) => a - b);
    const plainWrites = ops.filter((op) => !op.checkpointed && (op.kind === "activity" || op.kind === "publication"))
      .map((op) => op.end - op.start).sort((a, b) => a - b);
    const sortedGaps = gaps.map((entry) => entry.gap).sort((a, b) => a - b);
    console.log(JSON.stringify({
      mode, seconds, node: process.versions.node, electron: process.versions.electron ?? null, sqlite,
      ticks: gaps.length, stallsOver5ms: stalls.length,
      gapP99: +percentile(sortedGaps, 0.99).toFixed(2), gapP999: +percentile(sortedGaps, 0.999).toFixed(2),
      maxGap: +(sortedGaps.at(-1) ?? 0).toFixed(2),
      loopDelayP99: +(histogram.percentile(99) / 1e6).toFixed(2), loopDelayMax: +(histogram.max / 1e6).toFixed(2),
      walBytesAtEnd: wal,
      writesWithCheckpoint: { count: checkpointOps.length, p50: +percentile(checkpointOps, 0.5).toFixed(2), max: +(checkpointOps.at(-1) ?? 0).toFixed(2) },
      writesWithoutCheckpoint: { count: plainWrites.length, p50: +percentile(plainWrites, 0.5).toFixed(2), p99: +percentile(plainWrites, 0.99).toFixed(2) },
      stallMsByCause: Object.fromEntries([...byCause].map(([cause, value]) => [cause, { count: value.count, ms: Math.round(value.ms) }])),
      ops: opStats,
    }, null, 2));
    observer.close();
    bindings.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Commit-level split: time every commit of a steady activity insert load on
 * a real daemon connection, and charge it to a checkpoint when SQLite
 * checkpointed inside it. `commits-off` sets synchronous = OFF for attribution.
 */
async function commits(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "letagents-sqlite-commits-"));
  const path = join(root, "daemon-state.sqlite");
  const store = new ManifestStore(path);
  try {
    await store.write(0, [agentEntry(0)]);
    const database = await openPreparedDaemonStateDatabase(path);
    const observer = new DatabaseSync(Object.assign(pathToFileURL(path), { search: "?mode=rw" }).href);
    const frames = observer.prepare("PRAGMA wal_checkpoint(NOOP)");
    if (mode === "commits-off") database.exec("PRAGMA synchronous = OFF");
    let worker: { stop(): Promise<void>; active: boolean } | undefined;
    if (mode === "commits-worker") {
      const start = (stateDatabase as Record<string, unknown>).startDaemonStateCheckpointWorker as (path: string) => Promise<{ stop(): Promise<void>; active: boolean }>;
      worker = await start(path);
      if (!worker.active) throw new Error("The checkpoint worker did not start.");
    }
    const insert = database.prepare(`INSERT INTO activity_events(agent_id, sort_order, observed_at, sequence, provider, kind, method, summary,
      status, payload_json, payload_truncated, payload_redacted, durable_payload_ref) VALUES ('agent_0', ?, ?, ?, 'codex', 'tool', 'm', 's', 'working', ?, 0, 0, NULL)`);
    const trim = database.prepare("DELETE FROM activity_events WHERE agent_id='agent_0' AND sort_order < ?");
    const plain: number[] = []; const checkpointed: number[] = [];
    const payload = JSON.stringify({ output: randomBytes(1_500).toString("base64") });
    const count = seconds * 200;
    for (let i = 1; i <= count; i += 1) {
      const before = frames.get() as { log: number; checkpointed: number };
      const start = performance.now();
      database.exec("BEGIN IMMEDIATE");
      insert.run(i, new Date().toISOString(), i, payload);
      trim.run(i - 200);
      database.exec("COMMIT");
      const took = performance.now() - start;
      const after = frames.get() as { log: number; checkpointed: number };
      (after.checkpointed > before.checkpointed || after.log < before.log ? checkpointed : plain).push(took);
      if (i % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await worker?.stop();
    const sum = (list: number[]) => list.reduce((total, value) => total + value, 0);
    const describe = (list: number[]) => { const sorted = [...list].sort((a, b) => a - b); return {
      count: list.length, totalMs: Math.round(sum(list)), p50: +percentile(sorted, 0.5).toFixed(2),
      p99: +percentile(sorted, 0.99).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2), over5ms: list.filter((v) => v > 5).length,
    }; };
    const wal = await stat(`${path}-wal`).then((info) => info.size, () => 0);
    console.log(JSON.stringify({ mode, commits: count, plain: describe(plain), withCheckpoint: describe(checkpointed), walBytesAtEnd: wal }));
    observer.close(); database.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (mode.startsWith("commits")) await commits(); else await main();
