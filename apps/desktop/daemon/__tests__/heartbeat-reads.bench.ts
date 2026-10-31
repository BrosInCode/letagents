/**
 * Times the daemon reads the native heartbeat and the activity-summary check
 * make for one working agent, at the activity size of a busy agent (200 events
 * with 8 KiB payloads). Run under Electron as Node with a clean HOME:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     --no-warnings --import tsx daemon/__tests__/heartbeat-reads.bench.ts [iterations]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ManifestStore } from "../manifest-store.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";

const iterations = Number(process.argv[2] ?? 300);

function event(sequence: number): DaemonActivityEvent {
  return {
    observed_at: new Date().toISOString(), sequence, provider: "codex", kind: "tool",
    method: "item/commandExecution", summary: "Ran a command", status: "working",
    payload: { output: randomBytes(5800).toString("base64") }, payload_truncated: false,
    payload_redacted: false, durable_payload_ref: null,
  } as DaemonActivityEvent;
}

const entry = {
  id: "agent_0", room_id: "room_1", display_name: "Agent0", provider: "codex", model: "gpt-5.6-codex",
  charter: "Work.", desired_state: "running", observed_state: "working", condition: "none", last_error: null,
  permission_profile_id: "workspace-write", provider_launch_policy: { deliveryMode: "mcp_polling" },
  created_by: "user_1", created_at: "2026-10-19T00:00:00.000Z", source_repo_path: "/repo",
  workspace_path: "/worktrees/agent_0", work_attempt_id: "attempt_0",
  provider_ref: {
    work_attempt_id: "attempt_0", provider_continuation_id: "thread_0",
    provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4300", pid: 4300, processIdentity: null },
    execution_generation_id: "run_0",
  },
  workplace_liveness: { state: "reachable", observed_at: "2026-10-19T00:01:00.000Z", detail: null },
  native_liveness: { state: "active", observed_at: "2026-10-19T00:01:01.000Z", detail: "streaming" },
  ready_reached_at: "2026-10-19T00:01:00.000Z",
  activity: Array.from({ length: 200 }, (_, i) => event(i + 1)),
} as DaemonManifestEntry;

async function time(label: string, operation: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 20; i += 1) await operation();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`${label.padEnd(44)} mean ${mean.toFixed(3)} ms  p95 ${samples[Math.floor(samples.length * 0.95)]!.toFixed(3)} ms`);
}

const root = await mkdtemp(join(tmpdir(), "letagents-heartbeat-reads-"));
const store = new ManifestStore(join(root, "daemon-state.sqlite"));
try {
  await store.write(0, [entry]);
  const stored = await store.getEntry("agent_0");
  console.log(`stored events: ${stored?.activity?.length}`);
  await time("getEntry full (heartbeat today)", () => store.getEntry("agent_0"));
  await time("getEntry summary", () => store.getEntry("agent_0", "summary"));
  await time("getAgentConfiguration", () => store.getAgentConfiguration("agent_0"));
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
