import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonLifecycleLog } from "../lifecycle-log.js";
import { RoomLatencyTrace, setRoomLatencyReporter, type RoomLatencySample } from "../room-latency-trace.js";

test("fast checks emit nothing; a delayed check separates waiting from execution", () => {
  let time = 0;
  const samples: RoomLatencySample[] = [];
  const fast = new RoomLatencyTrace("authority", () => time, sample => samples.push(sample));
  time = 999;
  fast.finish();
  assert.equal(samples.length, 0);

  const slow = new RoomLatencyTrace("inbox_write", () => time, sample => samples.push(sample));
  time += 25_800;
  slow.mark("queue_wait");
  time += 2;
  slow.mark("database");
  time += 7;
  slow.mark("operation");
  slow.finish();
  slow.finish();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].elapsed_ms, 25_809);
  assert.deepEqual(samples[0].phases_ms, { queue_wait: 25_800, database: 2, operation: 7, remaining: 0 });
});

test("a diagnostic sink failure does not replace the original operation error", async () => {
  let time = 0;
  const error = new Error("original operation failure");
  const timing = new RoomLatencyTrace("authority", () => time, () => { throw new Error("sink unavailable"); });
  await assert.rejects(async () => {
    try { time = 4_000; throw error; }
    finally { timing.finish(); }
  }, e => e === error);
});

test("clock failures at construction, a phase, or finish disable the sample without escaping", () => {
  for (const throwAt of [1, 2, 3]) {
    let reads = 0;
    const samples: RoomLatencySample[] = [];
    const timing = new RoomLatencyTrace("inbox_write", () => {
      reads += 1;
      if (reads === throwAt) throw new Error("clock unavailable");
      return reads * 2_000;
    }, sample => samples.push(sample));
    timing.mark("queue_wait");
    timing.finish();
    timing.finish();
    assert.deepEqual(samples, []);
  }
});

test("packaged diagnostics survive discarded stderr and are bounded per path", async t => {
  const directory = await mkdtemp(join(tmpdir(), "room-latency-"));
  const path = join(directory, "lifecycle.jsonl");
  const log = new DaemonLifecycleLog(path);
  t.after(async () => { setRoomLatencyReporter(null); log.close(); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(console, "warn", () => { throw new Error("stderr unavailable"); });
  setRoomLatencyReporter(sample => log.append({ event: "room_latency", detail: JSON.stringify(sample) }));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let time = 0;
    const timing = new RoomLatencyTrace("worker_binding_store", () => time);
    time = 2_000;
    timing.mark("queue_wait");
    timing.finish();
  }
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, "room_latency");
  assert.ok(entry.at);
  assert.deepEqual(Object.keys(JSON.parse(entry.detail)).sort(), [
    "elapsed_ms", "event_loop_active_ms", "event_loop_idle_ms", "operation", "phases_ms",
  ]);
});
