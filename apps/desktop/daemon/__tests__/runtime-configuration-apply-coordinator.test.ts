import assert from "node:assert/strict";
import test from "node:test";

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
      stopIfIdle: input.stopIfIdle ?? (async () => {
        if (input.afterDeliveryInstallation) currentInstallation = input.afterDeliveryInstallation;
        return true;
      }),
    },
    provider: {
      stop: async (stoppedHandle) => {
        assert.equal(stoppedHandle, handle);
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
    configuration,
    gate,
    counts: () => ({ providerStops, replacements }),
    convergenceLifecycleStates,
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
