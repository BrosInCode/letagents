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
  deliveryCutoverExecution: {
    drive(entryId: string, detachSignal: AbortSignal): Promise<void>;
  };
  runtimeConfigurationApply: {
    refreshManaged(entryId: string): Promise<unknown>;
  };
  store: {
    write(generation: number, entries: DaemonManifestEntry[]): Promise<unknown>;
    load(activityMode?: ActivityMode): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
    getEntry(agentId: string, activityMode?: ActivityMode): Promise<DaemonManifestEntry | undefined>;
    readGeneration(): Promise<number>;
    listEntryIds(): Promise<string[]>;
    listUnresolvedTurnControlRecovery(): Promise<{ generation: number; agentIds: string[] }>;
    replaceEntry(
      expectedGeneration: number,
      entry: DaemonManifestEntry,
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
      roomMoveCancellation?: { operationId: string; error: string },
    ): Promise<{ generation: number; entry: DaemonManifestEntry }>;
    commitTransition(
      expectedGeneration: number,
      input: ManifestTransitionCommit,
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
    ): Promise<{ generation: number }>;
    replaceEntriesBatch(
      expectedGeneration: number,
      entries: DaemonManifestEntry[],
      commitFence?: (commit: () => Promise<void>) => Promise<void>,
    ): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
  };
};

function stubProviderPort(): ProviderActionPort {
  return {
    capabilities: async () => ({
      deliveryModes: ["daemon_inbox", "mcp_polling"],
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

test("daemon start-up with providerPort and autoConverge converges rich-activity agents using summary reads and targeted transitions only", async () => {
  const env = await fixture();
  const root = await realpath(env.root);
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
      // Legacy codex mcp_polling stopped agent (triggers delivery -> cutover drive + convergence).
      stoppedEntry(1),
      // Legacy codex mcp_polling agent transitioning failed -> stopped via commitTransition.
      {
        ...stoppedEntry(2),
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
    await seedInternals.store.write((await seedInternals.store.load("summary")).generation, seeded);
    await daemon.stop();
    daemon = null;

    daemon = new SupervisorDaemon(paths, "darwin", stubProviderPort(), true);
    const internals = daemon as unknown as StoreInternals;
    const { store } = internals;
    const read = store.load.bind(store);
    const readEntry = store.getEntry.bind(store);
    const readGeneration = store.readGeneration.bind(store);
    const listEntryIds = store.listEntryIds.bind(store);
    const listUnresolvedTurnControlRecovery = store.listUnresolvedTurnControlRecovery.bind(store);
    const replaceEntry = store.replaceEntry.bind(store);
    const commitTransition = store.commitTransition.bind(store);
    const startDelivery = internals.supervisedDeliveryLifecycle.start.bind(internals.supervisedDeliveryLifecycle);
    const driveCutover = internals.deliveryCutoverExecution.drive.bind(internals.deliveryCutoverExecution);
    const refreshManaged = internals.runtimeConfigurationApply.refreshManaged.bind(internals.runtimeConfigurationApply);

    const loads: Array<{ mode: ActivityMode; entries: number }> = [];
    const entryReads: Array<{ id: string; mode: ActivityMode }> = [];
    const replacedEntries: string[] = [];
    const committedTransitions: string[] = [];
    const deliveryStartIds: string[] = [];
    const cutoverDriveIds: string[] = [];
    const refreshedManagedIds: string[] = [];
    const pendingDeliveryStarts: Promise<void>[] = [];
    const pendingCutoverDrives: Promise<void>[] = [];
    let readGenerationCalls = 0;
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
    store.replaceEntry = async (expectedGeneration, entry, commitFence, roomMoveCancellation) => {
      replacedEntries.push(entry.id);
      return replaceEntry(expectedGeneration, entry, commitFence, roomMoveCancellation);
    };
    store.commitTransition = async (expectedGeneration, input, commitFence) => {
      committedTransitions.push(input.agentId);
      return commitTransition(expectedGeneration, input, commitFence);
    };
    internals.supervisedDeliveryLifecycle.start = (entryId, mode) => {
      deliveryStartIds.push(entryId);
      const op = startDelivery(entryId, mode);
      pendingDeliveryStarts.push(op);
      return op;
    };
    internals.deliveryCutoverExecution.drive = (entryId, detachSignal) => {
      cutoverDriveIds.push(entryId);
      const op = driveCutover(entryId, detachSignal);
      pendingCutoverDrives.push(op);
      return op;
    };
    internals.runtimeConfigurationApply.refreshManaged = async (entryId) => {
      refreshedManagedIds.push(entryId);
      return refreshManaged(entryId);
    };

    await daemon.start();
    // Deterministically drain async delivery starts, cutover drives, and rehydration convergence.
    for (let pass = 0; pass < 5; pass += 1) {
      const beforeStarts = pendingDeliveryStarts.length;
      const beforeDrives = pendingCutoverDrives.length;
      await Promise.allSettled([...pendingDeliveryStarts, ...pendingCutoverDrives]);
      await internals.providerExecution?.drainConvergence();
      if (pendingDeliveryStarts.length === beforeStarts && pendingCutoverDrives.length === beforeDrives) break;
    }

    assert.equal(loads.filter((entry) => entry.mode === "full").length, 0, JSON.stringify(loads));
    assert.equal(loads.filter((entry) => entry.mode === "summary").length, 2, JSON.stringify(loads));
    assert.equal(readGenerationCalls, 1);
    assert.equal(listEntryIdsCalls, 2);
    assert.equal(unresolvedTurnControlCalls, 1);

    assert.deepEqual(
      entryReads.filter((entry) => entry.mode === "full"),
      [],
      `expected zero full getEntry() calls during startup & convergence, saw: ${JSON.stringify(entryReads)}`,
    );
    const summaryReadIds = new Set(entryReads.filter((entry) => entry.mode === "summary").map((entry) => entry.id));
    assert.deepEqual([...summaryReadIds].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.ok(entryReads.length >= 12, `expected delivery, cutover, convergence, and transition summary reads, saw ${entryReads.length}`);

    assert.deepEqual(replacedEntries, [], "startup & convergence must not call replaceEntry()");
    assert.deepEqual([...new Set(committedTransitions)].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.deepEqual([...new Set(deliveryStartIds)].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.deepEqual([...new Set(cutoverDriveIds)].sort(), ["agent_1", "agent_2"]);
    assert.deepEqual([...new Set(refreshedManagedIds)].sort(), ["agent_1", "agent_2", "agent_3", "agent_4"]);

    const after = await read("full");
    assert.deepEqual(after.entries.map((entry) => entry.id), ["agent_1", "agent_2", "agent_3", "agent_4"]);
    assert.equal(after.entries[1]!.observed_state, "stopped");
    assert.equal(after.entries[1]!.condition, "none");
    assert.equal(after.entries[1]!.last_error, null);
    assert.equal(after.entries[1]!.reconciliation_notices?.length, 1);
    assert.equal(after.entries[3]!.observed_state, "paused");
    assert.equal(after.entries[3]!.work_attempt_id, workAttemptId);
    const attemptsAfter = await internals.durability.listAttempts();
    assert.deepEqual(attemptsAfter.map((item) => item.work_attempt_id), [workAttemptId]);
    for (let i = 0; i < seeded.length; i += 1) {
      assert.equal(after.entries[i]!.activity?.length, 20);
      assert.deepEqual(after.entries[i]!.activity, seeded[i]!.activity);
    }
  } finally {
    await daemon?.stop();
    await env.cleanup();
  }
});
