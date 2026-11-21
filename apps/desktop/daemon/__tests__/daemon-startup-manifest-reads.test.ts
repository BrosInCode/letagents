import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SupervisorDaemon } from "../main.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { fixture, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

type ActivityMode = "full" | "summary";
type StoreInternals = {
  store: {
    write(generation: number, entries: DaemonManifestEntry[]): Promise<unknown>;
    load(activityMode?: ActivityMode): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
  };
};

function activity(agent: number): DaemonActivityEvent[] {
  return Array.from({ length: 20 }, (_, event) => ({
    observed_at: new Date(Date.parse("2026-11-01T00:00:00.000Z") + (agent * 20 + event) * 1000).toISOString(),
    sequence: event + 1,
    provider: "codex",
    kind: "message",
    method: "item/agentMessage",
    summary: `Event ${event + 1}`,
    status: "idle",
    payload: { text: "x".repeat(4096) },
    payload_truncated: false,
    payload_redacted: false,
    durable_payload_ref: null,
  }));
}

function stoppedEntry(agent: number): DaemonManifestEntry {
  return {
    id: `agent_${agent}`, room_id: "room_1", display_name: `Agent${agent}`, provider: "codex", model: null,
    charter: "test", desired_state: "stopped", observed_state: "stopped", condition: "none",
    permission_profile_id: null, created_by: "test", created_at: "2026-01-01T00:00:00.000Z",
    activity: activity(agent),
  } as DaemonManifestEntry;
}

test("daemon start-up reads activity payloads only to check the upgraded state and to recover turn controls", async () => {
  const env = await fixture();
  const root = env.root;
  const paths = {
    lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root),
    manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
    attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
    workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
  };
  let daemon: SupervisorDaemon | null = null;
  try {
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const seed = (daemon as unknown as StoreInternals).store;
    await seed.write((await seed.load("summary")).generation, [stoppedEntry(1), stoppedEntry(2)]);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin");
    const store = (daemon as unknown as StoreInternals).store;
    const read = store.load.bind(store);
    const reads: Array<{ mode: ActivityMode; entries: number }> = [];
    store.load = async (activityMode?: ActivityMode) => {
      const manifest = await read(activityMode);
      reads.push({ mode: activityMode ?? "full", entries: manifest.entries.length });
      return manifest;
    };
    await daemon.start();

    // Full reads: the protected state upgrade, which must parse every stored
    // payload before it marks the recovery backup valid, and turn-control
    // recovery, which writes entries back. The other passes use entry scalars.
    assert.equal(reads.filter((entry) => entry.mode === "full").length, 2, JSON.stringify(reads));
    assert.ok(reads.some((entry) => entry.mode === "summary"), JSON.stringify(reads));
    assert.ok(reads.every((entry) => entry.entries === 2), JSON.stringify(reads));
    const summary = await read("summary");
    assert.deepEqual(summary.entries.map((entry) => entry.id), ["agent_1", "agent_2"]);
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});
