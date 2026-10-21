/**
 * Measures one `manifest.watch_state` wake on a large manifest.
 *
 * Drives the real daemon (SupervisorDaemon, its stores and read model) in a
 * temporary directory. The manifest is shaped like a long-lived desktop: most
 * entries are stopped agents that keep their bounded delivery history, a few
 * are running. A wake is what the state watch does after a sequence change:
 * load the summary manifest, derive every entry's view, project it for the
 * room-level channel, and serialize it once.
 *
 *   node --import tsx daemon/__tests__/watch-state-wake.bench.ts [entries] [running] [wakes] [stopped-receipts]
 *
 * Reports SQLite statements executed per wake, wall time per wake, the
 * serialized payload size, the time to serialize and parse that payload, and
 * the time the desktop client's `mapEntry` takes to validate and map it.
 * The "changed" rows write one running agent's inbox before every wake, as a
 * busy room does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";

import { mapEntry } from "../../electron/main/supervisor-daemon.js";
import { SupervisorDaemon } from "../main.js";
import type { DaemonManifestEntry } from "../types.js";

const ENTRIES = Number(process.argv[2] ?? 150);
const RUNNING = Number(process.argv[3] ?? 8);
const WAKES = Number(process.argv[4] ?? 20);
const STOPPED_RECEIPTS = Number(process.argv[5] ?? 120);
const RUNNING_RECEIPTS = 40;
const EVENTS_PER_RECEIPT = 6;

let statements = 0;
for (const method of ["get", "all", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    statements += 1;
    return original.apply(this, args);
  };
}

function agentEntry(index: number, running: boolean): DaemonManifestEntry {
  const id = `agent_${index}`;
  return {
    id, room_id: `room_${index % 12}`, display_name: `Agent${index}`, provider: "codex", model: "gpt-5.6-codex",
    charter: "Work on the room's tasks.", desired_state: running ? "running" : "stopped",
    observed_state: running ? "idle" : "stopped", condition: "none", last_error: null,
    permission_profile_id: "workspace-write", provider_launch_policy: { deliveryMode: "mcp_polling" },
    created_by: "user_1", created_at: "2026-10-01T00:00:00.000Z",
    workplace_liveness: { state: "reachable", observed_at: "2026-10-19T00:01:00.000Z", detail: null },
    native_liveness: { state: "active", observed_at: "2026-10-19T00:01:01.000Z", detail: "streaming" },
    ready_reached_at: "2026-10-19T00:01:00.000Z",
  } as DaemonManifestEntry;
}

function seedInbox(database: DatabaseSync, agentId: string, roomId: string, receipts: number, offset: number): void {
  const insert = database.prepare(`INSERT INTO supervised_agent_inbox
    (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,?)`);
  const event = database.prepare(`INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
    VALUES (?,?,?,?,?,NULL)`);
  const phases = ["received", "queued", "turn_started", "turn_finished", "publish_started", "published"];
  for (let index = 0; index < receipts; index += 1) {
    const sequence = offset + index + 1;
    const item = `${agentId}:item:${sequence}`;
    const at = new Date(Date.parse("2026-10-18T00:00:00.000Z") + sequence * 1000).toISOString();
    insert.run(item, agentId, roomId, String(1000 + sequence), JSON.stringify({ id: String(1000 + sequence), text: "hello" }), "{}",
      sequence, "acknowledged", `${item}:action`, `${item}:reply`, `${item}:turn`, at, at, at);
    for (let phase = 0; phase < EVENTS_PER_RECEIPT; phase += 1) {
      event.run(item, phase + 1, `${phases[phase % phases.length]}:${phase}`, phases[phase % phases.length]!, at);
    }
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "letagents-watch-state-bench-"));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const internals = daemon as unknown as {
    store: { write(generation: number, entries: DaemonManifestEntry[]): Promise<unknown>; load(view?: "summary"): Promise<{ generation: number }> };
    supervisedInbox: { ingestPoll(input: unknown): Promise<unknown> };
    watchState(input: { afterDaemonGeneration: number; afterSequence: number; waitMs: number }): Promise<{ entries: unknown[] }>;
    notifyStateChanged(agentId?: string): void;
  };
  try {
    await daemon.start();
    await internals.store.write((await internals.store.load("summary")).generation, Array.from({ length: ENTRIES }, (_, index) => agentEntry(index, index < RUNNING)));
    const seed = new DatabaseSync(paths.manifestPath);
    seed.exec("PRAGMA busy_timeout = 5000");
    seed.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < ENTRIES; index += 1) {
      seedInbox(seed, `agent_${index}`, `room_${index % 12}`, index < RUNNING ? RUNNING_RECEIPTS : STOPPED_RECEIPTS, 0);
    }
    seed.exec("COMMIT");
    seed.close();

    // Wall time spent inside each per-entry input read, summed over a wake.
    const inputMs = new Map<string, number>();
    const owners = daemon as unknown as Record<string, Record<string, unknown>>;
    for (const [owner, methods] of [
      ["supervisedInbox", ["receiptProjection", "latestContinuationRepair", "ingressHealth", "blockedHeadSkip"]],
      ["store", ["pendingRuntimeRecovery", "getAgentConfiguration", "load"]],
      ["workerBindings", ["credentialFor", "list", "get"]],
      ["workerAuthority", ["pollingContract"]],
    ] as const) {
      const target = owners[owner]!;
      for (const method of methods) {
        const original = target[method] as (...args: unknown[]) => Promise<unknown>;
        if (typeof original !== "function") continue;
        target[method] = async (...args: unknown[]) => {
          const start = performance.now();
          try { return await original.apply(target, args); } finally {
            inputMs.set(`${owner}.${method}`, (inputMs.get(`${owner}.${method}`) ?? 0) + performance.now() - start);
          }
        };
      }
    }

    let next = 1_000_000;
    const measure = async (label: string, change: boolean) => {
      const times: number[] = []; const counts: number[] = []; let bytes = 0; let serializeMs = 0; let parseMs = 0; let mapMs = 0;
      for (let wake = 0; wake < WAKES; wake += 1) {
        if (change) {
          next += 1;
          await internals.supervisedInbox.ingestPoll({ agent_id: "agent_0", room_id: "room_0", last_observed_message_id: String(next),
            messages: [{ source_message_id: String(next), source_message: { id: String(next) }, activation: {} }] });
        }
        internals.notifyStateChanged();
        inputMs.clear();
        const before = statements;
        const start = performance.now();
        const snapshot = await internals.watchState({ afterDaemonGeneration: 0, afterSequence: 0, waitMs: 0 });
        times.push(performance.now() - start);
        counts.push(statements - before);
        const serializeStart = performance.now();
        const frame = JSON.stringify({ version: 1, id: "x", ok: true, result: snapshot });
        serializeMs += performance.now() - serializeStart;
        bytes = Buffer.byteLength(frame);
        // What the desktop client pays to read the frame.
        const parseStart = performance.now();
        const parsed = JSON.parse(frame) as { result: { entries: Parameters<typeof mapEntry>[0][] } };
        parseMs += performance.now() - parseStart;
        const mapStart = performance.now();
        for (const wire of parsed.result.entries) mapEntry(wire);
        mapMs += performance.now() - mapStart;
      }
      const last = await internals.watchState({ afterDaemonGeneration: 0, afterSequence: 0, waitMs: 0 }) as { entries: Array<{ delivery_receipts?: Array<{ timeline?: unknown[] }> }> };
      const receiptBytes = Buffer.byteLength(JSON.stringify(last.entries.map((entry) => entry.delivery_receipts ?? [])));
      const timelineBytes = Buffer.byteLength(JSON.stringify(last.entries.map((entry) => (entry.delivery_receipts ?? []).map((receipt) => receipt.timeline ?? []))));
      console.log(JSON.stringify({ label, receipt_bytes: receiptBytes, timeline_bytes: timelineBytes,
        input_ms_last_wake: Object.fromEntries([...inputMs].map(([key, value]) => [key, Number(value.toFixed(1))])) }));
      times.sort((left, right) => left - right); counts.sort((left, right) => left - right);
      console.log(JSON.stringify({ label, entries: ENTRIES, running: RUNNING, wakes: WAKES,
        statements_median: counts[Math.floor(counts.length / 2)], ms_median: Number(times[Math.floor(times.length / 2)]!.toFixed(2)),
        ms_p90: Number(times[Math.floor(times.length * 0.9)]!.toFixed(2)), payload_bytes: bytes,
        serialize_ms_mean: Number((serializeMs / WAKES).toFixed(2)), parse_ms_mean: Number((parseMs / WAKES).toFixed(2)),
        client_map_ms_mean: Number((mapMs / WAKES).toFixed(2)) }));
    };
    await measure("warm-up", false);
    await measure("unchanged", false);
    await measure("changed (one agent's inbox per wake)", true);
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
