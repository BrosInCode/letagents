/**
 * The like-for-like TypeScript side: the same store-level work the Rust spike
 * does, run in-process on the real ManifestStore, with no view derivation and
 * no socket. It gives TypeScript an advantage (no socket, no request parsing).
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> --import tsx spikes/rust-daemon/bench/ts-store.ts [writes]
 */
import { cp, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { ManifestStore } from "../../../apps/desktop/daemon/manifest-store.js";
import type { DaemonManifestEntry } from "../../../apps/desktop/daemon/types.js";

const RUN = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".run");
const WRITES = Number(process.argv[2] ?? 147);

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!.toFixed(2));
};
const cpuSeconds = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1e6; };

async function main(): Promise<void> {
  const home = join(RUN, "ts-store");
  await rm(home, { recursive: true, force: true });
  await cp(join(RUN, "seed", ".letagents"), join(home, ".letagents"), { recursive: true });
  const store = new ManifestStore(join(home, ".letagents", "daemon-state.sqlite"), undefined, undefined, undefined, true);
  await store.load("summary");

  const list = async (mode: "summary" | "full", count: number) => {
    const times: number[] = [];
    let bytes = 0;
    const before = cpuSeconds();
    for (let index = 0; index < count; index += 1) {
      const began = performance.now();
      const manifest = await store.load(mode);
      const frame = `${JSON.stringify({ version: 3, id: "x", ok: true, result: manifest.entries })}\n`;
      times.push(performance.now() - began);
      bytes = Buffer.byteLength(frame);
    }
    return { p50_ms: quantile(times, 0.5), p90_ms: quantile(times, 0.9), bytes, cpu_s: Number((cpuSeconds() - before).toFixed(2)) };
  };
  const summary = await list("summary", 30);
  const full = await list("full", 10);
  const rssAfterReads = process.memoryUsage().rss;

  // One liveness write, then what one state-watch wake does at store level:
  // loadForStateWatch, compare each entry with the last snapshot, serialize the changed ones.
  let generation = (await store.load("summary")).generation;
  let previous = new Map<string, DaemonManifestEntry>((await store.loadForStateWatch()).entries.map((entry) => [entry.id, entry]));
  const before = cpuSeconds();
  let changedTotal = 0;
  let bytes = 0;
  for (let index = 0; index < WRITES; index += 1) {
    const written = await store.updateWorkplaceLiveness(generation, `agent_${index % 218}`, {
      state: index % 2 ? "stale" : "reachable", observed_at: new Date().toISOString(), detail: `spike ${index}`,
    });
    generation = written.generation;
    const snapshot = await store.loadForStateWatch();
    const changed = snapshot.entries.filter((entry) => !isDeepStrictEqual(previous.get(entry.id), entry));
    changedTotal += changed.length;
    const frame = JSON.stringify({ version: 3, id: "x", ok: true, result: {
      daemon_generation: 1, sequence: index, complete: false, entries: changed, removed_entry_ids: [], entry_order: snapshot.entries.map((entry) => entry.id),
    } });
    bytes += Buffer.byteLength(frame);
    previous = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  }
  const watchCpu = cpuSeconds() - before;
  await store.close();
  console.log(JSON.stringify({
    kind: "ts-store (in-process, no views, no socket)",
    list_summary: summary,
    list_full: full,
    rss_mb_after_reads: Number((rssAfterReads / 2 ** 20).toFixed(1)),
    watch_equivalent: {
      writes: WRITES, cpu_s: Number(watchCpu.toFixed(2)),
      mean_entries_per_wake: Number((changedTotal / WRITES).toFixed(2)), mean_wake_bytes: Math.round(bytes / WRITES),
    },
  }, null, 2));
}

await main();
