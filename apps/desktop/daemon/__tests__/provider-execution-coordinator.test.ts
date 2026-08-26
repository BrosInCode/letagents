import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderExecutionCoordinator,
  type ProviderExecutionCoordinatorOptions,
} from "../provider-execution-coordinator.js";
import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionTerminal,
} from "../provider-action-port.js";
import type { DaemonManifestEntry, ExecutionTerminalPayload } from "../types.js";

const baseEntry = (): DaemonManifestEntry => ({
  id: "agent-1",
  room_id: "room-1",
  display_name: "Agent",
  provider: "codex",
  model: null,
  charter: "Help",
  desired_state: "running",
  observed_state: "absent",
  condition: "none",
  permission_profile_id: "full_access",
  provider_launch_policy: {},
  created_by: "test",
  created_at: "2026-08-26T00:00:00.000Z",
  workspace_path: "/tmp/work",
  work_attempt_id: "attempt-1",
});

const returnedHandle: ProviderActionHandle = {
  workAttemptId: "attempt-1",
  pid: 4242,
  providerContinuationId: "continuation-1",
  providerConnection: {
    kind: "codex_app_server",
    url: "http://127.0.0.1:4242",
    pid: 4242,
    processIdentity: "birth-4242",
  },
  appliedConfigurationRevision: 1,
  observedState: "working",
};

function terminal(current: ProviderActionHandle): ProviderActionTerminal {
  return {
    endedAt: "2026-08-26T00:00:02.000Z",
    exitCode: 0,
    signal: null,
    terminalCause: "stopped",
    providerContinuationId: current.providerContinuationId,
  };
}

function provider(overrides: Partial<ProviderActionPort> = {}): ProviderActionPort {
  return {
    capabilities: async () => ({
      deliveryModes: ["mcp_polling", "daemon_inbox"],
      resume: false,
      midTurnInjection: false,
      transcriptAccess: false,
      permissionPromptBridging: false,
      survivesRestart: false,
    }),
    spawn: async () => returnedHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => returnedHandle,
    poke: async () => {},
    stop: async (current) => terminal(current),
    onExit: async () => () => {},
    ...overrides,
  };
}

function harness(input: {
  provider?: ProviderActionPort;
  entry?: DaemonManifestEntry;
  handoff?: boolean;
  controlEpoch?: number;
} = {}) {
  let manifestEntry = input.entry ?? baseEntry();
  let manifestGeneration = 1;
  let handoff = input.handoff ?? false;
  let controlEpoch = input.controlEpoch ?? 0;
  const liveHandles = new Map<string, ProviderActionHandle>();
  const installed: ProviderActionHandle[] = [];
  const stoppedDelivery: string[] = [];
  const observedTerminals: ProviderActionTerminal[] = [];
  const terminalWrites: Array<{ executionGenerationId: string; terminal: ExecutionTerminalPayload }> = [];
  const checkpoints: Array<{ room_cursor: string | null; provider_continuation_id: string | null }> = [];
  const executionGenerations: Array<{
    execution_generation_id: string;
    work_attempt_id: string;
    started_at: string;
    actor: string;
    generation: number;
    terminal: ExecutionTerminalPayload | null;
  }> = [];
  const port = input.provider ?? provider();
  const options: ProviderExecutionCoordinatorOptions = {
    provider: port,
    store: {
      load: async () => ({ generation: manifestGeneration, entries: [manifestEntry] }),
      getEntry: async (entryId) => entryId === manifestEntry.id ? manifestEntry : undefined,
      getAgentConfiguration: async () => ({
        provider: "codex",
        model: null,
        reasoning_effort: null,
        permission_profile_id: "full_access",
        provider_launch_policy: {},
        config_revision: 1,
      }),
      replaceEntry: async (expectedGeneration, updated, commitFence) => {
        assert.equal(expectedGeneration, manifestGeneration);
        await commitFence(async () => {
          manifestEntry = updated;
          manifestGeneration += 1;
        });
        return { generation: manifestGeneration };
      },
      markRuntimeConfigurationApplied: async (expectedGeneration, _update, commitFence) => {
        assert.equal(expectedGeneration, manifestGeneration);
        await commitFence(async () => { manifestGeneration += 1; });
        return { generation: manifestGeneration };
      },
    },
    durability: {
      getAttempt: async () => ({
        work_attempt_id: "attempt-1",
        workspace_path: "/tmp/work",
        execution_generations: executionGenerations,
        checkpoints,
      }) as never,
      createAttempt: async () => { throw new Error("existing attempt must be reused"); },
      startGeneration: async (_workAttemptId, actor, generation) => {
        const execution = {
          execution_generation_id: `generation-${generation}`,
          work_attempt_id: "attempt-1",
          started_at: "2026-08-26T00:00:01.000Z",
          actor,
          generation,
          terminal: null,
        };
        executionGenerations.push(execution);
        return execution;
      },
      recordTerminal: async (_workAttemptId, executionGenerationId, payload) => {
        terminalWrites.push({ executionGenerationId, terminal: payload });
        const execution = executionGenerations.find(
          (candidate) => candidate.execution_generation_id === executionGenerationId,
        );
        if (execution) execution.terminal = payload;
        return execution as never;
      },
      releaseTerminalExecutionFence: async () => {},
      recoverExecutionFence: async () => {},
      checkpoint: async (_workAttemptId, checkpoint) => {
        checkpoints.push({
          room_cursor: checkpoint.room_cursor,
          provider_continuation_id: checkpoint.provider_continuation_id,
        });
        return {} as never;
      },
    },
    bindings: {
      get: async () => null,
      credentialFor: async () => null,
      supervisedWorkerSession: async () => null,
    },
    streams: {
      liveHandles,
      get: (entryId) => liveHandles.get(entryId),
      remove: (entryId, expected) => {
        const current = liveHandles.get(entryId);
        if (!current || expected && current !== expected) return false;
        liveHandles.delete(entryId);
        return true;
      },
      install: async (entryId, current) => {
        installed.push(current);
        liveHandles.set(entryId, current);
      },
      stageWorkerBindingAfterResume: async () => {},
      fenceTerminalOnce: async (current, actionId) => {
        await port.stop(current, { actionId });
      },
    },
    authority: {
      isHandoffScheduled: () => handoff,
      currentDaemonGeneration: () => 7,
      currentManifestGeneration: () => manifestGeneration,
      acceptManifestGeneration: (generation) => { manifestGeneration = generation; },
      assertCurrent: async () => {},
      ownsDaemonGeneration: async (generation) => !handoff && generation === 7,
      fenceCommit: async (commit) => {
        if (handoff) throw new Error("ordinary fence closed during handoff");
        await commit();
      },
      serializeManifestMutation: async (operation) => operation(),
      serializeManifestCommit: async (operation) => operation(),
    },
    concurrency: {
      currentControlEpoch: () => controlEpoch,
      serializeEntry: async (_entryId, operation) => operation(),
    },
    updateManifestEntry: async (_entryId, update) => {
      if (handoff) throw new (await import("../singleton.js")).DaemonFenceLostError("handoff");
      manifestEntry = update(manifestEntry);
      manifestGeneration += 1;
      return manifestEntry;
    },
    transition: async (_entryId, observedState, condition, cause) => {
      manifestEntry = {
        ...manifestEntry,
        observed_state: observedState,
        condition,
        last_error: condition === "none" ? null : cause,
      };
    },
    terminalPayload: (value, actor) => ({
      ended_at: value.endedAt,
      exit_code: value.exitCode,
      signal: value.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: value.terminalCause,
      actor,
      generation: 7,
      provider_continuation_id: value.providerContinuationId,
    }),
    observeProviderExit: async (_entryId, value) => { observedTerminals.push(value); },
    completeTurnControlForRuntimeRecovery: async (current) => current,
    delivery: {
      stop: async (entryId) => { stoppedDelivery.push(entryId); },
      start: async () => {},
    },
    inbox: { cursor: async () => ({ last_observed_message_id: "1" }) },
    host: {
      requiresGrant: () => false,
      currentGrant: () => null,
      ensureGrantFresh: async () => null,
      mintAuthorization: async () => null,
      recordMintedSession: async () => null,
      mintSession: async () => null,
      bindMintedSession: async () => {},
      bearerNeedsRotation: async () => false,
      blockExpiredAuthority: async () => {},
      currentOpenModelCredential: () => null,
      recordBindingRecoveryFailure: async () => {},
      clearSuccessfulRecovery: () => {},
    },
    workspace: {
      ephemeral: { provision: async () => { throw new Error("unused"); } },
      git: { provision: async () => { throw new Error("unused"); } },
      gitCommand: async () => "",
    },
    socketPath: "/tmp/daemon.sock",
    autoConverge: true,
    nowMs: () => 1_000,
    recordSchedulerFailure: async () => {},
  };
  const coordinator = new ProviderExecutionCoordinator(options);
  return {
    coordinator,
    installed,
    stoppedDelivery,
    observedTerminals,
    terminalWrites,
    checkpoints,
    executionGenerations,
    entry: () => manifestEntry,
    setEntry: (next: DaemonManifestEntry) => { manifestEntry = next; },
    setHandoff: (next: boolean) => { handoff = next; },
    bumpControlEpoch: () => { controlEpoch += 1; },
  };
}

test("handoff during native dispatch journals the exact returned provider without installing listeners", async () => {
  let runtime!: ReturnType<typeof harness>;
  const port = provider({
    spawn: async () => {
      runtime.setHandoff(true);
      return returnedHandle;
    },
  });
  runtime = harness({ provider: port });

  await runtime.coordinator.converge("agent-1");

  assert.equal(runtime.entry().provider_ref?.provider_continuation_id, "continuation-1");
  assert.equal(runtime.entry().provider_ref?.execution_generation_id, "generation-1");
  assert.deepEqual(
    runtime.checkpoints,
    [],
    "handoff may fence later configuration/checkpoint bookkeeping once provider_ref is durable",
  );
  assert.equal(runtime.installed.length, 0, "retiring daemon never owns returned-handle callbacks");
  await runtime.coordinator.drainDispatches();
});

test("pause winning after native return fences that exact handle and terminalizes its generation", async () => {
  let stopCalls = 0;
  let runtime!: ReturnType<typeof harness>;
  const port = provider({
    spawn: async () => {
      runtime.setEntry({ ...runtime.entry(), desired_state: "paused" });
      runtime.bumpControlEpoch();
      return returnedHandle;
    },
    stop: async (current) => {
      stopCalls += 1;
      assert.equal(current, returnedHandle);
      return terminal(current);
    },
  });
  runtime = harness({ provider: port });

  await runtime.coordinator.converge("agent-1");

  assert.equal(stopCalls, 1);
  assert.deepEqual(runtime.stoppedDelivery, ["agent-1"]);
  assert.equal(runtime.installed.length, 0);
  assert.equal(runtime.terminalWrites.length, 1);
  assert.equal(runtime.terminalWrites[0]?.executionGenerationId, "generation-1");
  assert.equal(runtime.terminalWrites[0]?.terminal.terminal_cause, "stopped");
  assert.equal(runtime.observedTerminals.length, 1);
});

test("attach terminal evidence is durable before the execution fence is released", async () => {
  const ordered: string[] = [];
  const current = baseEntry();
  current.provider_ref = {
    work_attempt_id: "attempt-1",
    execution_generation_id: "generation-1",
    provider_continuation_id: "continuation-1",
    provider_connection: null,
  };
  const attachTerminal: ProviderActionTerminal = {
    endedAt: "2026-08-26T00:00:03.000Z",
    exitCode: 0,
    signal: null,
    terminalCause: "exited",
    providerContinuationId: "continuation-1",
  };
  const runtime = harness({
    entry: current,
    provider: provider({ attach: async () => ({ state: "terminal", terminal: attachTerminal }) }),
  });
  runtime.executionGenerations.push({
    execution_generation_id: "generation-1",
    work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z",
    actor: "daemon-provider",
    generation: 1,
    terminal: null,
  });
  const internals = runtime.coordinator as unknown as {
    options: ProviderExecutionCoordinatorOptions;
  };
  const originalRecord = internals.options.durability.recordTerminal;
  internals.options.durability.recordTerminal = async (...args) => {
    ordered.push("terminal");
    return originalRecord(...args);
  };
  internals.options.durability.releaseTerminalExecutionFence = async () => {
    ordered.push("release");
  };

  const attached = await runtime.coordinator.attachLiveProvider(current);
  assert.equal(attached, null);
  assert.deepEqual(ordered, ["terminal", "release"]);
  assert.equal(runtime.installed.length, 0);
});
