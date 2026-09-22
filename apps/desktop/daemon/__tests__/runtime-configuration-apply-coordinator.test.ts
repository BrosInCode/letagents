import { ManagedRuntimeRefreshDeferred } from "../provider-action-port.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { ProviderActionPort } from "../provider-action-port.js";

import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import type { ProviderActionHandle, ProviderActionTerminal } from "../provider-action-port.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import {
  ProviderTerminalCoordinator,
  type ProviderTerminalPorts,
} from "../provider-terminal-coordinator.js";
import {
  RuntimeConfigurationApplyCoordinator,
  type RuntimeConfigurationApplyCoordinatorOptions,
} from "../runtime-configuration-apply-coordinator.js";
import type { DaemonManifestEntry } from "../types.js";

const connection = {
  kind: "codex_app_server" as const,
  url: "http://127.0.0.1:4311",
  pid: 42,
  processIdentity: "codex:42",
};
const handle: ProviderActionHandle = {
  workAttemptId: "attempt-1",
  pid: 42,
  providerContinuationId: "continuation-1",
  observedState: "idle",
  providerConnection: connection,
  appliedConfigurationRevision: 1,
};
const installation: ProviderInstallationToken = {
  nonce: Symbol("installation"),
  listenerLeaseNonce: Symbol("lease"),
  entryId: "agent-1",
  handle,
  executionGenerationId: "generation-1",
  workAttemptId: "attempt-1",
  providerContinuationId: "continuation-1",
  providerConnection: connection,
  configurationRevision: 1,
  authorityMode: "typed_shadow",
};
const terminal: ProviderActionTerminal = {
  endedAt: "2026-09-02T00:00:00.000Z",
  exitCode: 0,
  signal: null,
  terminalCause: "stopped",
  providerContinuationId: "continuation-1",
};

function manifestEntry(): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent",
    provider: "codex",
    model: null,
    charter: "Help",
    config_revision: 2,
    runtime_configuration_revision: 1,
    desired_state: "running",
    observed_state: "idle",
    condition: "none",
    permission_profile_id: "supervised",
    created_by: "test",
    created_at: "2026-09-02T00:00:00.000Z",
    work_attempt_id: "attempt-1",
    delivery_mode: "daemon_inbox",
    provider_ref: {
      work_attempt_id: "attempt-1",
      execution_generation_id: "generation-1",
      provider_continuation_id: "continuation-1",
      provider_connection: connection,
    },
  };
}

function applyHarness(input: {
  stopIfIdle?: () => Promise<boolean>;
  beforeProviderStop?: () => void;
  head?: () => Promise<{ state: string; provider_turn_id: string | null } | null>;
  afterDeliveryInstallation?: ProviderInstallationToken;
  configurationRevisionOnRead?: (read: number) => number;
} = {}) {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
  const entry = manifestEntry();
  const configuration = {
    provider: "codex", model: null, reasoning_effort: null, charter: "Help",
    permission_profile_id: "supervised", provider_launch_policy: {},
    config_revision: 2, runtime_configuration_revision: 1, polling_contract: null,
  };
  let currentInstallation = installation;
  let deliveryReserved = false;
  let providerStops = 0;
  let replacements = 0;
  let configurationReads = 0;
  const convergenceLifecycleStates: boolean[] = [];
  const options: RuntimeConfigurationApplyCoordinatorOptions = {
    store: {
      getEntry: async () => entry,
      getAgentConfiguration: async () => {
        configurationReads += 1;
        return input.configurationRevisionOnRead
          ? { ...configuration, config_revision: input.configurationRevisionOnRead(configurationReads) }
          : configuration;
      },
      pendingRoomMoves: async () => [],
      unresolvedDeliveryDrain: async () => null,
      unresolvedPollingActivation: async () => null,
    },
    inbox: { head: input.head ?? (async () => null) } as RuntimeConfigurationApplyCoordinatorOptions["inbox"],
    delivery: {
      reserveIdle: async () => {
        if (input.stopIfIdle && !await input.stopIfIdle()) return null;
        if (input.afterDeliveryInstallation) currentInstallation = input.afterDeliveryInstallation;
        deliveryReserved = true;
        return () => { deliveryReserved = false; };
      },
    },
    provider: {
      stop: async (stoppedHandle) => {
        assert.equal(stoppedHandle, handle);
        assert.equal(deliveryReserved, true, "delivery remains fenced through native stop");
        input.beforeProviderStop?.();
        providerStops += 1;
        return terminal;
      },
    },
    streams: { currentInstallation: () => currentInstallation },
    terminals: {
      replaceConfiguration: async (exact, stop) => {
        assert.equal(exact, installation);
        replacements += 1;
        await stop();
      },
    },
    entryConcurrency: gate,
    authority: {
      assertCurrent: async () => {},
      currentDaemonGeneration: () => 7,
      isHandoffScheduled: () => false,
    },
    requestConvergence: () => convergenceLifecycleStates.push(gate.isLifecycleActive("agent-1")),
  };
  return {
    coordinator: new RuntimeConfigurationApplyCoordinator(options),
    options, entry,
    configuration,
    gate,
    counts: () => ({ providerStops, replacements }),
    convergenceLifecycleStates,
    deliveryReserved: () => deliveryReserved,
  };
}

test("configuration apply replaces only the exact idle runtime and leaves revision advancement to successor birth", async () => {
  const env = applyHarness({
    head: async () => ({ state: "pending", provider_turn_id: null }),
  });
  assert.deepEqual(await env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2,
  }), { outcome: "restarting" });
  assert.deepEqual(env.counts(), { providerStops: 1, replacements: 1 });
  assert.equal(env.deliveryReserved(), false);
  assert.equal(env.configuration.runtime_configuration_revision, 1,
    "the stop path cannot claim that a successor has consumed the saved configuration");
  assert.equal(env.gate.currentControlEpoch("agent-1"), 1);
  assert.deepEqual(env.convergenceLifecycleStates, [false],
    "ordinary convergence resumes only after lifecycle exclusion is released");
});

test("configuration apply cannot interrupt an active turn", async () => {
  const env = applyHarness({ stopIfIdle: async () => false });
  assert.deepEqual(await env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2,
  }), { outcome: "busy_active_turn" });
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("a stale apply request cannot fence launch work or displace a queued room move", async () => {
  const env = applyHarness();
  let enterLane!: () => void;
  let releaseLane!: () => void;
  const entered = new Promise<void>((resolve) => { enterLane = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseLane = resolve; });
  const occupying = env.gate.run("agent-1", async () => {
    enterLane();
    await blocked;
  });
  await entered;
  const roomMove = env.gate.runRoomMove("agent-1", "excluded", async () => "moved");
  const apply = env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 3,
  });
  releaseLane();
  await occupying;
  assert.equal(await roomMove, "moved");
  assert.deepEqual(await apply, { outcome: "conflict" });
  assert.equal(env.gate.currentControlEpoch("agent-1"), 0);
  assert.deepEqual(env.convergenceLifecycleStates, []);
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("an already-applied request is a side-effect-free no-op", async () => {
  const env = applyHarness();
  env.configuration.runtime_configuration_revision = 2;
  assert.deepEqual(await env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2,
  }), { outcome: "already_applied" });
  assert.equal(env.gate.currentControlEpoch("agent-1"), 0);
  assert.deepEqual(env.convergenceLifecycleStates, []);
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("a configuration race after preflight releases lifecycle before requesting repair", async () => {
  const env = applyHarness({
    configurationRevisionOnRead: (read) => read === 1 ? 2 : 3,
  });
  assert.deepEqual(await env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2,
  }), { outcome: "conflict" });
  assert.equal(env.gate.currentControlEpoch("agent-1"), 0);
  assert.deepEqual(env.convergenceLifecycleStates, [false]);
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("configuration apply rejects a provider birth replaced while delivery drains", async () => {
  const successor = { ...installation, nonce: Symbol("successor") };
  const env = applyHarness({ afterDeliveryInstallation: successor });
  assert.deepEqual(await env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2,
  }), { outcome: "conflict" });
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("configuration apply refuses a durable nonterminal inbox head", async () => {
  const env = applyHarness({
    head: async () => ({ state: "dispatching", provider_turn_id: null }),
  });
  assert.deepEqual(await env.coordinator.apply({
    entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2,
  }), { outcome: "busy_active_turn" });
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("intentional replacement classifies an onExit/stop-result race exactly once", async () => {
  const liveHandles = new Map([["agent-1", handle]]);
  const entry = manifestEntry();
  const transitions: Array<{ state: string; cause: string }> = [];
  let removed = false;
  let terminalRecords = 0;
  let convergenceRequests = 0;
  const ports: ProviderTerminalPorts = {
    settleRuntimeApprovals: async () => {},
    currentDaemonGeneration: () => 7,
    nowMs: () => Date.parse("2026-09-02T00:00:00.000Z"),
    liveHandles,
    manifest: { getEntry: async () => entry, load: async () => ({ entries: [entry] }) },
    durability: {
      getAttempt: async () => ({
        execution_generations: [{
          execution_generation_id: "generation-1", actor: "daemon-provider", generation: 7,
          terminal: null,
        }],
      }) as never,
      recordTerminal: async () => { terminalRecords += 1; },
      releaseTerminalExecutionFence: async () => {},
    },
    runtimeCustody: { deletePendingResumeBinding: () => {} },
    streams: {
      remove: (exact) => {
        if (removed || exact !== installation || liveHandles.get("agent-1") !== handle) return false;
        removed = true;
        liveHandles.delete("agent-1");
        return true;
      },
      isLatestInstallation: (exact) => exact === installation,
    },
    delivery: { start: async () => {} },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async operation => operation(),
    transitionOnce: async (_entryId, state, _condition, cause) => {
      transitions.push({ state, cause });
    },
    requestConvergence: () => { convergenceRequests += 1; },
  };
  const coordinator = new ProviderTerminalCoordinator(ports);
  await coordinator.replaceConfiguration(installation, async () => {
    await coordinator.handleTerminal(installation, terminal);
    return terminal;
  });
  assert.equal(terminalRecords, 1);
  assert.deepEqual(transitions, [{
    state: "recovering",
    cause: "provider terminal completed intentional configuration replacement",
  }]);
  assert.equal(convergenceRequests, 0,
    "the apply owner releases lifecycle exclusion before requesting successor convergence");
});

test("a native stop failure clears the replacement reservation without misclassifying the live runtime", async () => {
  const liveHandles = new Map([["agent-1", handle]]);
  const entry = manifestEntry();
  let removed = false;
  let transitions = 0;
  const ports: ProviderTerminalPorts = {
    settleRuntimeApprovals: async () => {},
    currentDaemonGeneration: () => 7,
    nowMs: () => Date.parse("2026-09-02T00:00:00.000Z"),
    liveHandles,
    manifest: { getEntry: async () => entry, load: async () => ({ entries: [entry] }) },
    durability: {
      getAttempt: async () => ({
        execution_generations: [{
          execution_generation_id: "generation-1", actor: "daemon-provider", generation: 7,
          terminal: null,
        }],
      }) as never,
      recordTerminal: async () => {},
      releaseTerminalExecutionFence: async () => {},
    },
    runtimeCustody: { deletePendingResumeBinding: () => {} },
    streams: {
      remove: () => {
        if (removed) return false;
        removed = true;
        liveHandles.delete("agent-1");
        return true;
      },
      isLatestInstallation: (exact) => exact === installation,
    },
    delivery: { start: async () => {} },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async operation => operation(),
    transitionOnce: async () => { transitions += 1; },
    requestConvergence: () => {},
  };
  const coordinator = new ProviderTerminalCoordinator(ports);
  await assert.rejects(
    coordinator.replaceConfiguration(installation, async () => {
      throw new Error("native stop failed");
    }),
    /native stop failed/,
  );
  assert.equal(liveHandles.get("agent-1"), handle);
  assert.equal(transitions, 0);

  await coordinator.replaceConfiguration(installation, async () => terminal);
  assert.equal(transitions, 1, "the exact installation remains replaceable after the failed stop");
});

test("process-death evidence must match the immutable installation, including PID birth", () => {
  const coordinator = new ProviderTerminalCoordinator({ currentDaemonGeneration: () => 7 } as ProviderTerminalPorts);
  const connection = { kind: "codex_app_server" as const, url: "ws://localhost:4000", pid: 4000, processIdentity: "original-birth" };
  const terminal = { endedAt: "2026-09-02T00:00:00.000Z", exitCode: 0, signal: null,
    terminalCause: "exited" as const, providerContinuationId: "continuation",
    nativeRuntimeDeath: { kind: "codex_app_server" as const, pid: 4000, processIdentity: "original-birth" } };
  assert.deepEqual(coordinator.terminalPayload(terminal, "provider", connection).native_runtime_death, terminal.nativeRuntimeDeath);
  for (const wrong of [undefined, { ...connection, pid: 5000 }, { ...connection, processIdentity: "successor-birth" }]) {
    assert.throws(() => coordinator.terminalPayload(terminal, "provider", wrong), /exact provider installation/);
  }
  const { nativeRuntimeDeath, ...transportOnly } = terminal;
  assert.equal(coordinator.terminalPayload({ ...transportOnly, terminalCause: "protocol_error" }, "provider", connection).native_runtime_death, undefined);
});

function managedHarness() {
  const env = applyHarness({ head: async () => ({ state: "pending", provider_turn_id: null }) });
  env.configuration.config_revision = 1;
  env.entry.config_revision = 1;
  const state = { receipt: null as string | null, unclosed: false, permissionBusy: false,
    approvalHeld: false, nativeStops: 0, resumedDelivery: 0, desiredReads: 0,
    durableCurrent: true, permissionCurrent: true, nativeFailure: null as Error | null,
    beforeNativeGuard: null as (() => void) | null };
  env.options.managed = {
    store: {
      readManagedLaunchContract: async () => state.receipt,
      hasUnclosedRuntimeApprovals: async () => state.unclosed,
      validateManagedRuntimeReplacement: async () => () => {
        if (!state.durableCurrent) throw new ManagedRuntimeRefreshDeferred("durable authority changed");
      },
    },
    bindings: { get: async () => ({ entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
      execution_generation_id: "generation-1", agent_session_id: "session", credential_ref: "opaque",
      api_url: "http://127.0.0.1:4000", room_cursor: null, last_sequence: 0, last_observed_at_ms: 0, updated_at: "now" }) },
    reserveApprovalIdle: () => {
      if (state.permissionBusy) return null;
      state.approvalHeld = true;
      return { assertCurrent: () => { if (!state.permissionCurrent) throw new Error("permission changed"); },
        release: () => { state.approvalHeld = false; } };
    },
    resumeDelivery: async () => { state.resumedDelivery += 1; },
  };
  env.options.provider!.describeManagedLaunchContract = async () => { state.desiredReads += 1; return "a".repeat(64); };
  env.options.provider!.stopIdle = async (_handle, assertCurrent) => {
    assert.equal(state.approvalHeld, true);
    assert.equal(env.deliveryReserved(), true);
    state.beforeNativeGuard?.();
    assertCurrent();
    if (state.nativeFailure) throw state.nativeFailure;
    state.nativeStops += 1;
    return terminal;
  };
  return { ...env, state };
}

test("managed refresh normalizes an unknown legacy birth once without editing Inspector revisions or pending work", async () => {
  const env = managedHarness();
  await env.coordinator.refreshManaged("agent-1");
  assert.equal(env.state.nativeStops, 1);
  assert.equal(env.configuration.config_revision, 1);
  assert.equal(env.configuration.runtime_configuration_revision, 1);
  assert.equal(env.state.approvalHeld, false);
  assert.equal(env.deliveryReserved(), false);
  assert.deepEqual(env.convergenceLifecycleStates, [false]);
  // Only the actual successor birth records the descriptor it consumed.
  assert.equal(env.state.receipt, null);
  env.state.receipt = "a".repeat(64);
  await env.coordinator.refreshManaged("agent-1");
  await env.coordinator.refreshManaged("agent-1");
  assert.equal(env.state.nativeStops, 1);
  assert.equal(env.state.desiredReads, 2, "ordinary comparison reuses the daemon's verified desired identity");
});

for (const reason of ["current", "active", "pending-config", "approval", "permission", "unsupported"] as const) {
  test(`managed refresh defers ${reason} without disturbing delivery`, async () => {
    const env = managedHarness();
    if (reason === "current") env.state.receipt = "a".repeat(64);
    if (reason === "active") env.entry.observed_state = "working";
    if (reason === "pending-config") env.configuration.config_revision = 2;
    if (reason === "approval") env.state.unclosed = true;
    if (reason === "permission") env.state.permissionBusy = true;
    if (reason === "unsupported") env.options.provider!.stopIdle = undefined;
    await env.coordinator.refreshManaged("agent-1");
    assert.equal(env.state.nativeStops, 0);
    assert.equal(env.deliveryReserved(), false);
    assert.equal(env.state.approvalHeld, false);
    assert.equal(env.state.resumedDelivery, 0);
    assert.deepEqual(env.convergenceLifecycleStates, [], "deferral cannot schedule itself forever");
  });
}

for (const reason of ["permission", "durable", "installation", "handoff"] as const) {
  test(`managed refresh rechecks ${reason} after native inspection and restores ingress on deferral`, async () => {
    const env = managedHarness();
    env.state.beforeNativeGuard = () => {
      if (reason === "permission") env.state.permissionCurrent = false;
      if (reason === "durable") env.state.durableCurrent = false;
      if (reason === "installation") env.options.streams.currentInstallation = () => ({ ...installation });
      if (reason === "handoff") env.options.authority.isHandoffScheduled = () => true;
    };
    await env.coordinator.refreshManaged("agent-1");
    assert.equal(env.state.nativeStops, 0);
    assert.equal(env.state.approvalHeld, false);
    assert.equal(env.deliveryReserved(), false);
    assert.equal(env.state.resumedDelivery, 1);
    assert.deepEqual(env.convergenceLifecycleStates, []);
  });
}

test("managed refresh releases both reservations on genuine native failure and surfaces it", async () => {
  const env = managedHarness();
  env.state.nativeFailure = new Error("native stop failed");
  await assert.rejects(env.coordinator.refreshManaged("agent-1"), /native stop failed/);
  assert.equal(env.state.approvalHeld, false);
  assert.equal(env.deliveryReserved(), false);
  assert.equal(env.state.resumedDelivery, 1);
  assert.deepEqual(env.convergenceLifecycleStates, []);
});

for (const outcome of ["reply", "no_reply", "approval"] as const) {
  test(`settled ${outcome} delivery wakes deferred managed refresh after releasing its lane`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-refresh-settlement-"));
    const inbox = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const env = managedHarness();
    const agent = {
      agentId: "agent-1", roomId: "room-1", provider: "codex", deliveryMode: "daemon_inbox" as const,
      apiUrl: "http://127.0.0.1:4000", agentSessionId: "session", bearer: "memory",
      executionGenerationId: "generation-1", daemonGeneration: 7, handle,
      workAttemptId: "attempt-1", providerContinuationId: "continuation-1", providerConnection: connection,
    };
    let wakes = 0;
    let workspaceReleased = false;
    let refresh: Promise<void> | undefined;
    let reserved = false;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true,
        permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => { throw new Error("unused"); }, attach: async () => null,
      attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unused"); },
      poke: async () => {}, stop: async () => terminal, onExit: async () => () => {},
      runRoomTurn: async (_handle, _request, options) => {
        await options?.checkpointTurnStarted?.("turn-1");
        // Native idle arrives before the daemon has published/acknowledged the answer.
        await env.coordinator.refreshManaged(agent.agentId);
        assert.equal(env.state.nativeStops, 0);
        return { turnId: "turn-1", outcome: outcome === "no_reply" ? "no_reply" : "reply",
          text: outcome === "no_reply" ? null : "done" };
      },
    };
    const delivery = new SupervisedAgentDelivery(inbox, port, {
      poll: async () => ({}),
      publish: async () => {
        await env.coordinator.refreshManaged(agent.agentId);
        assert.equal(env.state.nativeStops, 0, "publishing is not a safe replacement boundary");
        return { messageId: "published-1", roomId: agent.roomId };
      },
    }, async () => true, 0, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    async () => {
      await env.coordinator.refreshManaged(agent.agentId);
      assert.equal(env.state.nativeStops, 0, "acknowledgment still owns the active delivery lane");
      workspaceReleased = true;
      if (outcome === "approval") env.state.unclosed = true;
    }, entryId => {
      assert.equal(workspaceReleased, true);
      wakes += 1;
      // Match production's queued convergence: never await the current pump from its finalizer.
      refresh = Promise.resolve().then(() => env.coordinator.refreshManaged(entryId));
    });
    env.options.inbox = inbox;
    env.options.delivery = {
      reserveIdle: async entryId => {
        const release = await delivery.reserveIdle(entryId);
        if (!release) return null;
        reserved = true;
        return () => { reserved = false; release(); };
      },
    };
    env.options.provider!.stopIdle = async (_handle, assertCurrent) => {
      assert.equal(reserved, true);
      assert.equal(workspaceReleased, true);
      assert.equal(env.state.approvalHeld, true);
      assertCurrent();
      env.state.nativeStops += 1;
      return terminal;
    };
    try {
      await inbox.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId,
        last_observed_message_id: "1", messages: [{ source_message_id: "1",
          source_message: { id: "1", text: "check" }, activation: {} }] });
      await delivery.pump(agent);
      await refresh;
      assert.equal(wakes, 1, "the final delivery boundary must request another convergence pass");
      assert.equal(env.state.nativeStops, outcome === "approval" ? 0 : 1,
        "a settlement wake schedules ordinary guarded refresh, not permission to stop");
      assert.equal(reserved, false);
      assert.equal(env.state.approvalHeld, false);
      assert.equal((await inbox.receipts(agent.agentId))[0]?.state,
        outcome === "no_reply" ? "acknowledged_no_reply" : "acknowledged");
      await delivery.pump(agent);
      assert.equal(wakes, 1, "an empty pump must not create an incessant convergence loop");
    } finally {
      await delivery.fenceAndDrain();
      await inbox.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
