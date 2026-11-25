import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { WorkDurabilityStore } from "../durability-store.js";
import type { EphemeralWorkspaceProvisioner } from "../ephemeral-workspace-provisioner.js";
import { SupervisorDaemon } from "../main.js";
import type { ManifestTransitionCommit } from "../manifest-store.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import type { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { fixture, testDaemonEndpoint } from "./helpers/daemon-fixture.js";

type ActivityMode = "full" | "summary";
type StoreInternals = {
  supervisedInbox: SupervisedAgentInboxStore;
  durability: WorkDurabilityStore;
  ephemeralProvisioner: EphemeralWorkspaceProvisioner;
  providerExecution: { drainConvergence(): Promise<void> } | null;
  supervisedDeliveryLifecycle: {
    start(entryId: string, mode?: "refresh" | "ensure" | "wake"): Promise<void>;
  };
  runtimeConfigurationApply: {
    refreshManaged(entryId: string): Promise<unknown>;
  };
  store: {
    write(entries: DaemonManifestEntry[]): Promise<unknown>;
    load(activityMode?: ActivityMode): Promise<{ entries: DaemonManifestEntry[]; versions: Record<string, number> }>;
    listEntryIds(): Promise<string[]>;
    listUnresolvedTurnControlRecovery(): Promise<{ agentIds: string[] }>;
    getEntry(agentId: string, activityMode?: ActivityMode): Promise<DaemonManifestEntry | undefined>;
    getEntryWithVersion(agentId: string, activityMode?: ActivityMode): Promise<{ entry: DaemonManifestEntry; version: number } | undefined>;
    replaceEntry(
      expectedVersion: number,
      entry: DaemonManifestEntry,
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
      roomMoveCancellation?: { agentId: string; detail: string },
    ): Promise<{ version: number; entry: DaemonManifestEntry }>;
    commitTransition(
      expectedVersion: number,
      input: ManifestTransitionCommit,
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
    ): Promise<{ version: number }>;
    replaceEntriesBatch(
      expectedVersions: Readonly<Record<string, number>>,
      entries: DaemonManifestEntry[],
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
    ): Promise<{ versions: Record<string, number>; entries: DaemonManifestEntry[] }>;
  };
  startSupervisedDelivery(entryId: string): Promise<void>;
};

function stubProviderPort(): ProviderActionPort {
  return {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox"],
      resume: false,
      midTurnInjection: false,
      transcriptAccess: false,
      permissionPromptBridging: false,
      survivesRestart: false,
    }),
    spawn: async () => { throw new Error("unexpected provider spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("unexpected provider resume"); },
    poke: async () => { throw new Error("unexpected provider poke"); },
    stop: async () => { throw new Error("unexpected provider stop"); },
    onExit: async () => () => undefined,
    onStream: async () => () => undefined,
    runRoomTurn: async () => { throw new Error("unexpected room turn"); },
    controlExactTurn: async () => { throw new Error("unexpected exact turn control"); },
    stopIdle: async () => { throw new Error("unexpected idle stop"); },
    describeManagedLaunchContract: async () => null,
  };
}

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

test("steady-state daemon start-up performs zero full manifest loads and preserves stored activity payloads", async () => {
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
    const readEntry = store.getEntry.bind(store);
    const readEntryWithVersion = store.getEntryWithVersion.bind(store);
    const listEntryIds = store.listEntryIds.bind(store);
    const listUnresolvedTurnControlRecovery = store.listUnresolvedTurnControlRecovery.bind(store);
    const manifestReads: Array<{ mode: ActivityMode; entries: number; payloadBytes: number }> = [];
    const entryReads: Array<{ id: string; mode: ActivityMode }> = [];
    const versionReads: Array<{ id: string; mode: ActivityMode }> = [];
    const idReads: string[][] = [];
    let unresolvedTurnControlCalls = 0;
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
    store.getEntry = async (agentId: string, activityMode?: ActivityMode) => {
      entryReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntry(agentId, activityMode);
    };
    store.getEntryWithVersion = async (agentId: string, activityMode?: ActivityMode) => {
      versionReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntryWithVersion(agentId, activityMode);
    };
    store.listEntryIds = async () => {
      const ids = await listEntryIds();
      idReads.push(ids);
      return ids;
    };
    store.listUnresolvedTurnControlRecovery = async () => {
      unresolvedTurnControlCalls += 1;
      return listUnresolvedTurnControlRecovery();
    };
    const deliveryStarts: string[] = [];
    const startSupervisedDelivery = internals.startSupervisedDelivery.bind(daemon);
    internals.startSupervisedDelivery = async (entryId: string) => {
      deliveryStarts.push(entryId);
      return startSupervisedDelivery(entryId);
    };
    await daemon.start();

    const detail = JSON.stringify({ manifestReads, idReads, entryReads, versionReads });
    // Steady-state startup performs zero full loads: validation only runs after
    // upgrades/compaction/unvalidated backups, and turn-control recovery queries IDs first.
    const full = manifestReads.filter((read) => read.mode === "full");
    assert.equal(full.length, 0, detail);
    // The other passes read no payload: the workspace recovery and the local room authorities.
    const summary = manifestReads.filter((read) => read.mode === "summary");
    assert.equal(summary.length, 2, detail);
    assert.ok(summary.every((read) => read.payloadBytes < PAYLOAD_BYTES), detail);
    assert.ok(manifestReads.every((read) => read.entries === seeded.length), detail);
    // The delivery pass reads the ids only, in manifest order, and starts each entry once.
    assert.equal(idReads.length, 1, detail);
    assert.deepEqual(idReads[0], seeded.map((entry) => entry.id), detail);
    assert.equal(unresolvedTurnControlCalls, 1);
    assert.deepEqual(entryReads, []);
    assert.deepEqual(versionReads, []);
    assert.deepEqual(deliveryStarts, seeded.map((entry) => entry.id));

    // Stored activity is intact: a summary read changes what is read, never what is stored.
    for (const entry of seeded) {
      const stored = await readEntry(entry.id, "full");
      assert.deepEqual(stored?.activity?.map((event) => event.sequence), entry.activity?.map((event) => event.sequence));
      assert.equal(JSON.stringify(stored?.activity?.[0]?.payload).length, JSON.stringify(entry.activity?.[0]?.payload).length);
    }
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});

test("turn-control recovery at start-up full-loads and replaces only agents with unresolved turn controls", async () => {
  const env = await fixture();
  const paths = daemonPaths(env.root);
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
    await internals.store.write([cleanAgent, pendingTurnAgent]);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin");
    const store = (daemon as unknown as StoreInternals).store;
    const read = store.load.bind(store);
    const readEntryWithVersion = store.getEntryWithVersion.bind(store);
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
    store.getEntryWithVersion = async (agentId: string, activityMode?: ActivityMode) => {
      entryReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntryWithVersion(agentId, activityMode);
    };
    store.write = async (entries: DaemonManifestEntry[]) => {
      fullWrites += 1;
      return write(entries);
    };
    store.replaceEntriesBatch = async (expectedVersions, entries, commitFence) => {
      batchIds.push(entries.map((entry) => entry.id));
      return replaceBatch(expectedVersions, entries, commitFence);
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

test("daemon start-up with providerPort and autoConverge converges rich-activity agents using summary reads and targeted transitions only", async () => {
  const env = await fixture();
  const root = await realpath(env.root);
  const paths = daemonPaths(root);
  let daemon: SupervisorDaemon | null = null;
  try {
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const seedInternals = daemon as unknown as StoreInternals;
    const workAttemptId = randomUUID();
    const provisioned = await seedInternals.ephemeralProvisioner.provision({
      workAttemptId,
      taskId: "agent_4",
    });
    const attempt = await seedInternals.durability.createAttempt({
      taskId: "agent_4",
      leaseId: "agent_4",
      leaseEpoch: 0,
      workspacePath: provisioned.path,
      workAttemptId,
    });
    const seeded: DaemonManifestEntry[] = [
      // Stopped codex daemon_inbox agent.
      { ...stoppedEntry(1), delivery_mode: "daemon_inbox" } as DaemonManifestEntry,
      // Failed + coordination_blocked agent transitioning failed -> stopped via commitTransition.
      {
        ...stoppedEntry(2),
        delivery_mode: "daemon_inbox",
        desired_state: "stopped",
        observed_state: "failed",
        condition: "coordination_blocked",
        last_error: "prior crash before restart",
        reconciliation: {
          exit_timestamps_ms: [1700000000000],
          consecutive_action_failures: 1,
          last_observed_state: "failed",
          next_restart_at_ms: null,
          completed_action_ids: ["stop_attempted"],
          last_action_sequence: 1,
          pending_action: null,
        },
        reconciliation_notices: [{
          at: "2026-11-01T00:00:00.000Z",
          kind: "coordination_escalation",
          cause: "prior crash before restart",
        }],
      } as DaemonManifestEntry,
      // Local-room stopped daemon_inbox agent (exercises restoreLocalRoomAuthorities).
      {
        ...stoppedEntry(3),
        room_id: "local_room_3",
        local_room_id: "local_room_3",
        delivery_mode: "daemon_inbox",
      } as DaemonManifestEntry,
      // Paused daemon_inbox agent with an attached ephemeral work attempt (exercises recoverEphemeralWorkspaces + stopped->paused transition).
      {
        ...stoppedEntry(4),
        delivery_mode: "daemon_inbox",
        desired_state: "paused",
        observed_state: "stopped",
        work_attempt_id: attempt.work_attempt_id,
        workspace_path: attempt.workspace_path,
      } as DaemonManifestEntry,
    ];
    await seedInternals.store.write(seeded);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin", stubProviderPort(), true);
    const internals = daemon as unknown as StoreInternals;
    const { store } = internals;
    const read = store.load.bind(store);
    const readEntry = store.getEntry.bind(store);
    const readEntryWithVersion = store.getEntryWithVersion.bind(store);
    const listEntryIds = store.listEntryIds.bind(store);
    const listUnresolvedTurnControlRecovery = store.listUnresolvedTurnControlRecovery.bind(store);
    const replaceEntry = store.replaceEntry.bind(store);
    const commitTransition = store.commitTransition.bind(store);
    const startDelivery = internals.supervisedDeliveryLifecycle.start.bind(internals.supervisedDeliveryLifecycle);
    const refreshManaged = internals.runtimeConfigurationApply.refreshManaged.bind(internals.runtimeConfigurationApply);

    const loads: Array<{ mode: ActivityMode; entries: number }> = [];
    const entryReads: Array<{ id: string; mode: ActivityMode }> = [];
    const versionReads: Array<{ id: string; mode: ActivityMode }> = [];
    const replacedEntries: string[] = [];
    const committedTransitions: string[] = [];
    const deliveryStartIds: string[] = [];
    const refreshedManagedIds: string[] = [];
    const pendingDeliveryStarts: Promise<void>[] = [];
    let listEntryIdsCalls = 0;
    let unresolvedTurnControlCalls = 0;

    store.load = async (activityMode?: ActivityMode) => {
      const manifest = await read(activityMode);
      loads.push({ mode: activityMode ?? "full", entries: manifest.entries.length });
      return manifest;
    };
    store.getEntry = async (agentId: string, activityMode?: ActivityMode) => {
      entryReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntry(agentId, activityMode);
    };
    store.getEntryWithVersion = async (agentId: string, activityMode?: ActivityMode) => {
      versionReads.push({ id: agentId, mode: activityMode ?? "full" });
      return readEntryWithVersion(agentId, activityMode);
    };
    store.listEntryIds = async () => {
      listEntryIdsCalls += 1;
      return listEntryIds();
    };
    store.listUnresolvedTurnControlRecovery = async () => {
      unresolvedTurnControlCalls += 1;
      return listUnresolvedTurnControlRecovery();
    };
    store.replaceEntry = async (expectedVersion, entry, commitFence, roomMoveCancellation) => {
      replacedEntries.push(entry.id);
      return replaceEntry(expectedVersion, entry, commitFence, roomMoveCancellation);
    };
    store.commitTransition = async (expectedVersion, input, commitFence) => {
      committedTransitions.push(input.agentId);
      return commitTransition(expectedVersion, input, commitFence);
    };
    internals.supervisedDeliveryLifecycle.start = (entryId, mode) => {
      deliveryStartIds.push(entryId);
      const op = startDelivery(entryId, mode);
      pendingDeliveryStarts.push(op);
      return op;
    };
    internals.runtimeConfigurationApply.refreshManaged = async (entryId) => {
      refreshedManagedIds.push(entryId);
      return refreshManaged(entryId);
    };

    await daemon.start();
    for (let pass = 0; pass < 5; pass += 1) {
      const beforeStarts = pendingDeliveryStarts.length;
      await Promise.allSettled([...pendingDeliveryStarts]);
      await internals.providerExecution?.drainConvergence();
      if (pendingDeliveryStarts.length === beforeStarts) break;
    }

    assert.equal(loads.filter((entry) => entry.mode === "full").length, 0, JSON.stringify(loads));
    assert.equal(loads.filter((entry) => entry.mode === "summary").length, 2, JSON.stringify(loads));
    assert.equal(listEntryIdsCalls, 2);
    assert.equal(unresolvedTurnControlCalls, 1);

    assert.deepEqual(
      entryReads.filter((entry) => entry.mode === "full"),
      [],
      `expected zero full getEntry() calls during startup & convergence, saw: ${JSON.stringify(entryReads)}`,
    );
    assert.deepEqual(
      versionReads.filter((entry) => entry.mode === "full"),
      [],
      `expected zero full getEntryWithVersion() calls during startup & convergence, saw: ${JSON.stringify(versionReads)}`,
    );
    const summaryReadIds = new Set([...entryReads, ...versionReads].filter((entry) => entry.mode === "summary").map((entry) => entry.id));
    assert.deepEqual([...summaryReadIds].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.ok(entryReads.length + versionReads.length >= 12, `expected delivery, convergence, and transition summary reads, saw ${entryReads.length + versionReads.length}`);

    assert.deepEqual(replacedEntries, [], "startup & convergence must not call replaceEntry()");
    assert.deepEqual([...new Set(committedTransitions)].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.deepEqual([...new Set(deliveryStartIds)].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.deepEqual([...new Set(refreshedManagedIds)].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);

    const after = await read("full");
    assert.deepEqual(after.entries.map((entry) => entry.id), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.equal(after.entries[1]!.observed_state, "stopped");
    assert.equal(after.entries[1]!.condition, "none");
    assert.equal(after.entries[1]!.last_error ?? null, null);
    assert.equal(after.entries[1]!.reconciliation_notices?.length, 1);
    assert.equal(after.entries[3]!.observed_state, "paused");
    assert.equal(after.entries[3]!.work_attempt_id, workAttemptId);
    const attemptsAfter = await internals.durability.listAttempts();
    assert.deepEqual(attemptsAfter.map((item) => item.work_attempt_id), [workAttemptId]);
    for (let i = 0; i < seeded.length; i += 1) {
      assert.equal(after.entries[i]!.activity?.length, EVENTS_PER_AGENT);
      assert.deepEqual(after.entries[i]!.activity, seeded[i]!.activity);
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
