/**
 * Seeds a daemon state folder for the Rust spike, with the real TypeScript
 * stores, and writes what the TypeScript store reads back as the reference.
 *
 *   node --import tsx spikes/rust-daemon/bench/seed.ts <state-dir> <reference-dir> [entries]
 *
 * The data is synthetic: no user data. Every agent is stopped, so a daemon
 * that opens this folder starts no provider.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SupervisorDaemon } from "../../../apps/desktop/daemon/main.js";
import { defaultDaemonPaths } from "../../../apps/desktop/daemon/singleton.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../../../apps/desktop/daemon/types.js";

const [stateDir, referenceDir] = process.argv.slice(2, 4);
const ENTRIES = Number(process.argv[4] ?? 218);
const ROOMS = 12;
const EVENTS = 40;
const RECEIPTS = 40;
if (!stateDir || !referenceDir) throw new Error("usage: seed.ts <state-dir> <reference-dir> [entries]");

const BIG = "x".repeat(24 * 1024);
const AVATARS = [
  { kind: "character", character: "orbit", color: "sage" },
  { kind: "initials", color: "blue" },
  { kind: "character", character: "comet", color: "rose" },
  undefined,
];

function activity(index: number): DaemonActivityEvent[] {
  return Array.from({ length: EVENTS }, (_, event) => ({
    observed_at: new Date(Date.parse("2026-11-01T00:00:00.000Z") + (index * EVENTS + event) * 1000).toISOString(),
    sequence: event + 1,
    provider: "codex",
    kind: event % 3 === 0 ? "tool" : "message",
    method: event % 3 === 0 ? "item/commandExecution" : "item/agentMessage",
    summary: `Event ${event + 1} of agent ${index}`,
    status: event % 5 === 0 ? "working" : "idle",
    payload: event % 10 === 9 ? { text: BIG } : { text: `payload ${event}`, n: event, nested: { ok: true, list: [1, 2, 3] } },
    payload_truncated: event % 10 === 9,
    payload_redacted: event % 7 === 0,
    durable_payload_ref: event % 10 === 9 ? `attempt-data/agent_${index}/${event}.json` : null,
  }));
}

function agentEntry(index: number): DaemonManifestEntry {
  const id = `agent_${index}`;
  const failed = index % 9 === 0;
  const terminal = {
    ended_at: "2026-11-10T00:00:00.000Z", exit_code: 1, signal: null, stdio_archive_ref: null,
    stdio_tail: "fatal: provider exited", terminal_cause: "process_exit", actor: "provider", generation: 3,
    provider_continuation_id: `thread_${index}`,
  };
  const avatar = AVATARS[index % AVATARS.length];
  return {
    id, room_id: `room_${index % ROOMS}`, display_name: `Agent${index}`, provider: "codex", model: "gpt-5.6-codex",
    charter: "Work on the room's tasks.", desired_state: "stopped",
    observed_state: failed ? "failed" : "stopped", condition: "none", last_error: failed ? "Provider exited with code 1" : null,
    permission_profile_id: "workspace-write", provider_launch_policy: { deliveryMode: "mcp_polling" },
    created_by: "user_1", created_at: "2026-10-01T00:00:00.000Z",
    ...(avatar ? { avatar } : {}),
    ...(index % 4 === 1 ? { source_repo_path: `/tmp/spike/repo_${index}`, workspace_path: `/tmp/spike/ws_${index}` } : {}),
    workplace_liveness: { state: "reachable", observed_at: "2026-11-19T00:01:00.000Z", detail: null },
    native_liveness: { state: "idle", observed_at: "2026-11-19T00:01:01.000Z", detail: index % 2 ? "quiet" : null },
    ready_reached_at: "2026-11-19T00:01:00.000Z",
    activity: activity(index),
    ...(index % 3 === 0 ? { last_worker_binding: null } : {}),
    ...(failed ? {
      reconciliation: {
        exit_timestamps_ms: [1_763_000_000_000, 1_763_000_060_000], consecutive_action_failures: 2,
        last_observed_state: "failed", next_restart_at_ms: 1_763_000_120_000,
        completed_action_ids: [`${id}:a1`, `${id}:a2`], last_action_sequence: 2, pending_action: null,
        last_terminal: terminal,
      },
      reconciliation_notices: [{ at: "2026-11-10T00:00:01.000Z", kind: "quarantine_death", cause: "crash loop", terminal }],
    } : {}),
  } as DaemonManifestEntry;
}

function seedInbox(database: DatabaseSync, agentId: string, roomId: string): void {
  const insert = database.prepare(`INSERT INTO supervised_agent_inbox
    (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,?)`);
  const event = database.prepare(`INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
    VALUES (?,?,?,?,?,NULL)`);
  const phases = ["received", "queued", "turn_started", "turn_finished", "publish_started", "published"];
  for (let index = 0; index < RECEIPTS; index += 1) {
    const sequence = index + 1;
    const item = `${agentId}:item:${sequence}`;
    const at = new Date(Date.parse("2026-11-18T00:00:00.000Z") + sequence * 1000).toISOString();
    insert.run(item, agentId, roomId, String(1000 + sequence), JSON.stringify({ id: String(1000 + sequence), text: "hello" }), "{}",
      sequence, "acknowledged", `${item}:action`, `${item}:reply`, `${item}:turn`, at, at, at);
    phases.forEach((phase, offset) => event.run(item, offset + 1, `${phase}:${offset}`, phase, at));
  }
}

async function main(): Promise<void> {
  await mkdir(stateDir!, { recursive: true, mode: 0o700 });
  await mkdir(referenceDir!, { recursive: true });
  const paths = defaultDaemonPaths(stateDir!);
  const daemon = new SupervisorDaemon(paths, "darwin");
  const internals = daemon as unknown as {
    store: {
      write(generation: number, entries: DaemonManifestEntry[]): Promise<unknown>;
      load(view?: "full" | "summary"): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
    };
  };
  await daemon.start();
  try {
    const before = await internals.store.load("summary");
    await internals.store.write(before.generation, Array.from({ length: ENTRIES }, (_, index) => agentEntry(index)));
    const seed = new DatabaseSync(paths.manifestPath);
    seed.exec("PRAGMA busy_timeout = 5000");
    seed.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < ENTRIES; index += 1) seedInbox(seed, `agent_${index}`, `room_${index % ROOMS}`);
    seed.exec("COMMIT");
    seed.close();
    for (const mode of ["summary", "full"] as const) {
      const manifest = await internals.store.load(mode);
      await writeFile(join(referenceDir!, `manifest-${mode}.json`), JSON.stringify(manifest));
      console.log(JSON.stringify({ mode, generation: manifest.generation, entries: manifest.entries.length }));
    }
  } finally {
    await daemon.stop();
  }
}

await main();
