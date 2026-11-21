import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SupervisorDaemon } from "../main.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { fixture, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

type ActivityMode = "full" | "summary";
type StoreInternals = {
  store: {
    write(entries: DaemonManifestEntry[]): Promise<unknown>;
    load(activityMode?: ActivityMode): Promise<{ entries: DaemonManifestEntry[] }>;
    listEntryIds(): Promise<string[]>;
    getEntry(agentId: string, activityMode?: ActivityMode): Promise<DaemonManifestEntry | undefined>;
  };
  startSupervisedDelivery(entryId: string): Promise<void>;
};

const PAYLOAD_BYTES = 4096;
const EVENTS_PER_AGENT = 20;

function activity(agent: number): DaemonActivityEvent[] {
  return Array.from({ length: EVENTS_PER_AGENT }, (_, event) => ({
    observed_at: new Date(Date.parse("2026-11-01T00:00:00.000Z") + (agent * EVENTS_PER_AGENT + event) * 1000).toISOString(),
    sequence: event + 1,
    provider: "codex",
    kind: "message",
    method: "item/agentMessage",
    summary: `Event ${event + 1}`,
    status: "idle",
    payload: { text: "x".repeat(PAYLOAD_BYTES) },
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

function daemonPaths(root: string) {
  return {
    lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root),
    manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
    attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
    workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
  };
}

test("daemon start-up reads activity payloads only to check the opened state and to recover turn controls", async () => {
  const env = await fixture();
  const paths = daemonPaths(env.root);
  // The ids are not in sort order, so the test also proves that the id-only passes keep the manifest order.
  const seeded = [stoppedEntry(3), stoppedEntry(1), stoppedEntry(2)];
  let daemon: SupervisorDaemon | null = null;
  try {
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    await (daemon as unknown as StoreInternals).store.write(seeded);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin");
    const internals = daemon as unknown as StoreInternals;
    const store = internals.store;
    const load = store.load.bind(store);
    const listEntryIds = store.listEntryIds.bind(store);
    const manifestReads: Array<{ mode: ActivityMode; entries: number; payloadBytes: number }> = [];
    const idReads: string[][] = [];
    store.load = async (activityMode?: ActivityMode) => {
      const manifest = await load(activityMode);
      manifestReads.push({
        mode: activityMode ?? "full",
        entries: manifest.entries.length,
        payloadBytes: manifest.entries.reduce((total, entry) => total
          + (entry.activity ?? []).reduce((bytes, event) => bytes + JSON.stringify(event.payload ?? null).length, 0), 0),
      });
      return manifest;
    };
    store.listEntryIds = async () => {
      const ids = await listEntryIds();
      idReads.push(ids);
      return ids;
    };
    const deliveryStarts: string[] = [];
    const startSupervisedDelivery = internals.startSupervisedDelivery.bind(daemon);
    internals.startSupervisedDelivery = async (entryId: string) => {
      deliveryStarts.push(entryId);
      return startSupervisedDelivery(entryId);
    };
    await daemon.start();

    const detail = JSON.stringify({ manifestReads, idReads });
    // Full reads that stay: the opened state is read once in full before the daemon uses it, and
    // turn-control recovery writes entries back, so it needs every activity record.
    const full = manifestReads.filter((read) => read.mode === "full");
    assert.equal(full.length, 2, detail);
    assert.ok(full.every((read) => read.payloadBytes >= seeded.length * EVENTS_PER_AGENT * PAYLOAD_BYTES), detail);
    // The other passes read no payload: the workspace recovery and the local room authorities.
    const summary = manifestReads.filter((read) => read.mode === "summary");
    assert.equal(summary.length, 2, detail);
    assert.ok(summary.every((read) => read.payloadBytes < PAYLOAD_BYTES), detail);
    assert.ok(manifestReads.every((read) => read.entries === seeded.length), detail);
    // The delivery pass reads the ids only, in manifest order, and starts each entry once.
    assert.equal(idReads.length, 1, detail);
    assert.deepEqual(idReads[0], seeded.map((entry) => entry.id), detail);
    assert.deepEqual(deliveryStarts, seeded.map((entry) => entry.id));

    // Stored activity is intact: a summary read changes what is read, never what is stored.
    for (const entry of seeded) {
      const stored = await store.getEntry(entry.id, "full");
      assert.deepEqual(stored?.activity?.map((event) => event.sequence), entry.activity?.map((event) => event.sequence));
      assert.equal(JSON.stringify(stored?.activity?.[0]?.payload).length, JSON.stringify(entry.activity?.[0]?.payload).length);
    }
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});

test("listEntryIds returns the ids in the order of load() and reads no entry", async () => {
  const env = await fixture();
  const paths = daemonPaths(env.root);
  let daemon: SupervisorDaemon | null = null;
  try {
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const store = (daemon as unknown as StoreInternals).store;
    assert.deepEqual(await store.listEntryIds(), []);
    await store.write([stoppedEntry(2), stoppedEntry(9), stoppedEntry(1)]);
    const ids = await store.listEntryIds();
    assert.deepEqual(ids, ["agent_2", "agent_9", "agent_1"]);
    assert.deepEqual(ids, (await store.load("summary")).entries.map((entry) => entry.id));
    assert.deepEqual(ids, (await store.load()).entries.map((entry) => entry.id));
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});

test("a summary read keeps each field that the changed start-up passes use", async () => {
  const env = await fixture();
  const paths = daemonPaths(env.root);
  let daemon: SupervisorDaemon | null = null;
  try {
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const store = (daemon as unknown as StoreInternals).store;
    await store.write([{
      ...stoppedEntry(1),
      desired_state: "running",
      local_room_id: "room_1",
      work_attempt_id: "11111111-1111-4111-8111-111111111111",
      provider_ref: {
        work_attempt_id: "22222222-2222-4222-8222-222222222222",
        execution_generation_id: "33333333-3333-4333-8333-333333333333",
        provider_continuation_id: "continuation-1",
        provider_connection: null,
      },
    } as DaemonManifestEntry]);
    const [full] = (await store.load()).entries;
    const [summary] = (await store.load("summary")).entries;
    assert.ok(full && summary);
    // Workspace recovery: both references to a work attempt protect its workspace from collection.
    assert.equal(summary.work_attempt_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(summary.provider_ref?.work_attempt_id, "22222222-2222-4222-8222-222222222222");
    // Local room authorities.
    for (const field of ["id", "room_id", "local_room_id", "desired_state", "display_name", "provider"] as const) {
      assert.equal(summary[field], full[field], field);
    }
    // The only difference between the two reads is the activity.
    assert.deepEqual({ ...summary, activity: undefined }, { ...full, activity: undefined });
    assert.equal(full.activity?.length, EVENTS_PER_AGENT);
    assert.ok((summary.activity?.length ?? 0) <= EVENTS_PER_AGENT);
    assert.ok((summary.activity ?? []).every((event) => event.payload === undefined || event.payload === null));
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});
