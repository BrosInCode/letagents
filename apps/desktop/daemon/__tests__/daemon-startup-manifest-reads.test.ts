import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SupervisorDaemon } from "../main.js";
import type { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { fixture, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

type ActivityMode = "full" | "summary";
type StoreInternals = {
  supervisedInbox: SupervisedAgentInboxStore;
  store: {
    write(generation: number, entries: DaemonManifestEntry[]): Promise<unknown>;
    load(activityMode?: ActivityMode): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
    getEntry(agentId: string, activityMode?: ActivityMode): Promise<DaemonManifestEntry | undefined>;
    readGeneration(): Promise<number>;
    listEntryIds(): Promise<string[]>;
    listUnresolvedTurnControlRecovery(): Promise<{ generation: number; agentIds: string[] }>;
    replaceEntriesBatch(
      expectedGeneration: number,
      entries: DaemonManifestEntry[],
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
    ): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
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

test("steady-state daemon start-up performs zero full manifest loads and preserves stored activity payloads", async () => {
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
    const seeded = [stoppedEntry(1), stoppedEntry(2)];
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const seed = (daemon as unknown as StoreInternals).store;
    await seed.write((await seed.load("summary")).generation, seeded);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin");
    const store = (daemon as unknown as StoreInternals).store;
    const read = store.load.bind(store);
    const readEntry = store.getEntry.bind(store);
    const readGeneration = store.readGeneration.bind(store);
    const listEntryIds = store.listEntryIds.bind(store);
    const listUnresolvedTurnControlRecovery = store.listUnresolvedTurnControlRecovery.bind(store);
    const reads: Array<{ mode: ActivityMode; entries: number }> = [];
    const entryReads: Array<{ id: string; mode: ActivityMode }> = [];
    let readGenerationCalls = 0;
    let listEntryIdsCalls = 0;
    let unresolvedTurnControlCalls = 0;
    store.load = async (activityMode?: ActivityMode) => {
      const manifest = await read(activityMode);
      reads.push({ mode: activityMode ?? "full", entries: manifest.entries.length });
      return manifest;
    };
    store.getEntry = async (agentId: string, activityMode?: ActivityMode) => {
      entryReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntry(agentId, activityMode);
    };
    store.readGeneration = async () => {
      readGenerationCalls += 1;
      return readGeneration();
    };
    store.listEntryIds = async () => {
      listEntryIdsCalls += 1;
      return listEntryIds();
    };
    store.listUnresolvedTurnControlRecovery = async () => {
      unresolvedTurnControlCalls += 1;
      return listUnresolvedTurnControlRecovery();
    };
    await daemon.start();

    assert.equal(reads.filter((entry) => entry.mode === "full").length, 0, JSON.stringify(reads));
    assert.equal(reads.filter((entry) => entry.mode === "summary").length, 2, JSON.stringify(reads));
    assert.ok(reads.every((entry) => entry.entries === 2), JSON.stringify(reads));
    assert.equal(readGenerationCalls, 1);
    assert.equal(listEntryIdsCalls, 1);
    assert.equal(unresolvedTurnControlCalls, 1);
    assert.deepEqual(entryReads, []);
    const full = await read("full");
    assert.deepEqual(full.entries.map((entry) => entry.id), ["agent_1", "agent_2"]);
    assert.deepEqual(full.entries[0]!.activity, seeded[0]!.activity);
    assert.deepEqual(full.entries[1]!.activity, seeded[1]!.activity);
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});

test("turn-control recovery at start-up full-loads and replaces only agents with unresolved turn controls", async () => {
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
    const cleanAgent = stoppedEntry(1);
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const internals = daemon as unknown as StoreInternals;
    await internals.supervisedInbox.ingestPoll({
      agent_id: "agent_2",
      room_id: "room_1",
      last_observed_message_id: "msg_1",
      messages: [{
        source_message_id: "msg_1",
        activation: { decision: "activate", reason: "explicit_mention", addressed: true },
        source_message: { id: "msg_1", text: "hi" },
      }],
    });
    const claimed = (await internals.supervisedInbox.claimHead("agent_2"))!;
    await internals.supervisedInbox.checkpointTurnStarted(claimed.inbox_item_id, "turn_2", {
      work_attempt_id: "attempt_2",
      origin_execution_generation_id: "exec_2",
      provider_continuation_id: "cont_2",
    });
    const pendingTurnAgent = {
      ...stoppedEntry(2),
      delivery_mode: "daemon_inbox" as const,
      work_attempt_id: "attempt_2",
      last_turn_control_sequence: 1,
      turn_control: {
        action_id: "ctrl_1",
        action_sequence: 1,
        work_attempt_id: "attempt_2",
        execution_generation_id: "exec_2",
        target_room_id: "room_1",
        target_source_message_id: "msg_1",
        target_provider_continuation_id: "cont_2",
        inbox_item_id: claimed.inbox_item_id,
        provider_turn_id: "turn_2",
        has_correction: false,
        status: "dispatching" as const,
        capability: "interrupt_and_resume" as const,
        interrupted: null,
        resumed: null,
        state: "working" as const,
        stages: ["delivered" as const],
        error: null,
        recorded_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      },
    } as DaemonManifestEntry;
    await internals.store.write((await internals.store.load("summary")).generation, [cleanAgent, pendingTurnAgent]);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin");
    const store = (daemon as unknown as StoreInternals).store;
    const read = store.load.bind(store);
    const readEntry = store.getEntry.bind(store);
    const write = store.write.bind(store);
    const replaceBatch = store.replaceEntriesBatch.bind(store);
    const fullLoads: number[] = [];
    const entryReads: Array<{ id: string; mode: ActivityMode }> = [];
    let fullWrites = 0;
    const batchIds: string[][] = [];
    store.load = async (activityMode?: ActivityMode) => {
      const manifest = await read(activityMode);
      if ((activityMode ?? "full") === "full") fullLoads.push(manifest.entries.length);
      return manifest;
    };
    store.getEntry = async (agentId: string, activityMode?: ActivityMode) => {
      entryReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntry(agentId, activityMode);
    };
    store.write = async (generation: number, entries: DaemonManifestEntry[]) => {
      fullWrites += 1;
      return write(generation, entries);
    };
    store.replaceEntriesBatch = async (expectedGeneration, entries, commitFence) => {
      batchIds.push(entries.map((entry) => entry.id));
      return replaceBatch(expectedGeneration, entries, commitFence);
    };
    await daemon.start();

    assert.deepEqual(fullLoads, [], "turn-control recovery never loads the whole manifest in full mode");
    assert.deepEqual(entryReads, [{ id: "agent_2", mode: "full" }], "only the agent with an unresolved turn control is full-loaded");
    assert.equal(fullWrites, 0, "turn-control recovery uses targeted batch replacement rather than rewriting all entries");
    assert.deepEqual(batchIds, [["agent_2"]]);

    const after = await read("full");
    assert.equal(after.entries[0]!.turn_control, undefined);
    assert.equal(after.entries[1]!.turn_control?.status, "uncertain");
    assert.deepEqual(after.entries[0]!.activity, cleanAgent.activity);
    assert.deepEqual(after.entries[1]!.activity, pendingTurnAgent.activity);
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});
