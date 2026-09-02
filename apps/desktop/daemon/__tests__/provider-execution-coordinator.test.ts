import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { WorkerSessionBinding } from "../worker-binding-store.js";
import type { BoundWorkerAuthorization, InstalledHostGrant } from "../worker-runtime-custody.js";
import type { PollingActivationRecord } from "../custodial-polling-activation.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";

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

const openModelHandle: ProviderActionHandle = {
  ...returnedHandle,
  providerConnection: {
    kind: "opencode_server",
    url: "http://127.0.0.1:4343",
    pid: 4343,
    processIdentity: "birth-4343",
    serverAuthPath: "/tmp/opencode-auth.json",
  },
};

const claudeHandle: ProviderActionHandle = {
  ...returnedHandle,
  providerConnection: {
    kind: "claude_cli",
    pid: 4444,
    processIdentity: "birth-4444",
  },
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
  frozenAuthorityMode?: "legacy" | "typed_shadow" | "typed" | null;
  currentInstallation?: (entryId: string) => ProviderInstallationToken | undefined;
} = {}) {
  let manifestEntry = input.entry ?? baseEntry();
  let manifestGeneration = 1;
  let handoff = input.handoff ?? false;
  let controlEpoch = input.controlEpoch ?? 0;
  let frozenAuthorityMode: "legacy" | "typed_shadow" | "typed" | null =
    input.frozenAuthorityMode !== undefined
      ? input.frozenAuthorityMode
      : manifestEntry.provider_ref?.provider_connection?.pid != null ? "legacy" : null;
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
      unresolvedDeliveryDrain: async () => null,
      unresolvedPollingActivation: async () => null,
      load: async () => ({ generation: manifestGeneration, entries: [manifestEntry] }),
      getEntry: async (entryId) => entryId === manifestEntry.id ? manifestEntry : undefined,
      getAgentConfiguration: async () => ({
        provider: manifestEntry.provider,
        model: manifestEntry.model,
        reasoning_effort: null,
        permission_profile_id: manifestEntry.permission_profile_id,
        provider_launch_policy: manifestEntry.provider_launch_policy,
        config_revision: 1,
        runtime_configuration_revision: 1,
      }),
      readRuntimeLifecycleAuthority: async () => frozenAuthorityMode,
      checkpointProviderBirth: async (expectedGeneration, input, commitFence) => {
        assert.equal(expectedGeneration, manifestGeneration);
        await commitFence(async () => {
          manifestEntry = input.entry;
          manifestGeneration += 1;
        });
        if (input.providerConnection.pid !== null && frozenAuthorityMode === null) {
          frozenAuthorityMode = input.requestedAuthorityMode;
        }
        return {
          generation: manifestGeneration,
          entry: manifestEntry,
          authorityMode: input.providerConnection.pid === null
            ? null
            : frozenAuthorityMode,
        };
      },
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
      currentInstallation: input.currentInstallation ?? (() => undefined),
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
    inbox: { cursor: async () => ({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "1" }) },
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
      currentOpenModelCredential: (entryId, daemonGeneration) => manifestEntry.provider === "open-model"
        ? { entryId, apiKey: "test-key", baseUrl: "https://models.example.test/v1", model: "test-model", daemonGeneration }
        : null,
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
    options,
    liveHandles,
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

test("delivery handoff freezes convergence and draining never creates a successor", async () => {
  for (const phase of ["draining", "dispatching", "uncertain"] as const) {
    let launches = 0;
    const runtime = harness({ provider: provider({ spawn: async () => { launches++; return returnedHandle; }, resume: async () => { launches++; return returnedHandle; } }) });
    runtime.options.store.unresolvedDeliveryDrain = async () => ({ phase } as never);
    await runtime.coordinator.converge("agent-1");
    assert.equal(launches, 0, phase);
    assert.equal(runtime.executionGenerations.length, 0, phase);
  }
});

for (const { label, providerId, handle } of [
  { label: "Codex", providerId: "codex", handle: returnedHandle },
  { label: "Claude Code", providerId: "claude-code", handle: claudeHandle },
  { label: "Open Model", providerId: "open-model", handle: openModelHandle },
] as const) {
  test(`new daemon-owned ${label} births launch and freeze with typed authority`, async () => {
    let requestedAuthority: "legacy" | "typed_shadow" | "typed" | undefined;
    const runtime = harness({
      entry: { ...baseEntry(), provider: providerId, delivery_mode: "daemon_inbox" },
      provider: provider({
        spawn: async request => {
          requestedAuthority = request.lifecycleAuthorityMode;
          return handle;
        },
      }),
    });

    await runtime.coordinator.converge("agent-1");

    assert.equal(requestedAuthority, "typed");
    assert.equal(runtime.installed.length, 1);
    assert.equal(await runtime.options.store.readRuntimeLifecycleAuthority({
      agentId: "agent-1",
      executionGenerationId: "generation-1",
      providerConnection: handle.providerConnection!,
      configurationRevision: 1,
    }), "typed", `the exact ${label} birth keeps the requested authority mode`);
  });
}

for (const { label, providerId, handle, frozenAuthorityMode } of [
  { label: "Codex", providerId: "codex", handle: returnedHandle, frozenAuthorityMode: "typed" },
  { label: "Claude Code", providerId: "claude-code", handle: claudeHandle, frozenAuthorityMode: "typed_shadow" },
  { label: "Open Model", providerId: "open-model", handle: openModelHandle, frozenAuthorityMode: "typed_shadow" },
] as const) {
  test(`${label} reattach preserves the exact birth's frozen authority`, async () => {
    let attachedAuthority: "legacy" | "typed_shadow" | "typed" | undefined;
    const current = {
      ...baseEntry(),
      provider: providerId,
      delivery_mode: "daemon_inbox" as const,
      observed_state: "recovering" as const,
      provider_ref: {
        work_attempt_id: "attempt-1",
        execution_generation_id: "generation-1",
        provider_continuation_id: "continuation-1",
        provider_connection: handle.providerConnection,
      },
    };
    const runtime = harness({
      entry: current,
      frozenAuthorityMode,
      provider: provider({
        attach: async ref => {
          attachedAuthority = ref.lifecycleAuthorityMode;
          return handle;
        },
      }),
    });
    runtime.executionGenerations.push({
      execution_generation_id: "generation-1",
      work_attempt_id: "attempt-1",
      started_at: "2026-08-26T00:00:00.000Z",
      actor: "test",
      generation: 1,
      terminal: null,
    });

    await runtime.coordinator.converge("agent-1");

    assert.equal(attachedAuthority, frozenAuthorityMode);
    assert.equal(runtime.installed.length, 1);
    assert.equal(runtime.executionGenerations.length, 1, "reattach cannot mint a successor generation");
    assert.equal(await runtime.options.store.readRuntimeLifecycleAuthority({
      agentId: "agent-1",
      executionGenerationId: "generation-1",
      providerConnection: handle.providerConnection!,
      configurationRevision: 1,
    }), frozenAuthorityMode, `the release cutover cannot relabel an existing ${label} birth`);
  });
}

test("typed durable terminal authority fences a stale live handle without reopening delivery", async () => {
  let runtime!: ReturnType<typeof harness>;
  let stopCalls = 0;
  let deliveryStarts = 0;
  const current = {
    ...baseEntry(),
    delivery_mode: "daemon_inbox" as const,
    observed_state: "failed" as const,
    provider_ref: {
      work_attempt_id: "attempt-1",
      execution_generation_id: "generation-1",
      provider_continuation_id: "continuation-1",
      provider_connection: returnedHandle.providerConnection,
    },
  };
  runtime = harness({
    entry: current,
    frozenAuthorityMode: "typed",
    provider: provider({
      stop: async currentHandle => {
        stopCalls += 1;
        return terminal(currentHandle);
      },
    }),
    currentInstallation: () => ({
      nonce: Symbol("installation"),
      listenerLeaseNonce: Symbol("lease"),
      entryId: "agent-1",
      handle: returnedHandle,
      executionGenerationId: "generation-1",
      workAttemptId: "attempt-1",
      providerContinuationId: "continuation-1",
      providerConnection: returnedHandle.providerConnection!,
      configurationRevision: 1,
      authorityMode: "typed",
    }),
  });
  runtime.liveHandles.set("agent-1", returnedHandle);
  runtime.executionGenerations.push({
    execution_generation_id: "generation-1",
    work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z",
    actor: "test",
    generation: 1,
    terminal: null,
  });
  runtime.options.delivery.start = async () => { deliveryStarts += 1; };

  await runtime.coordinator.converge("agent-1");

  assert.equal(stopCalls, 1);
  assert.equal(deliveryStarts, 0);
  assert.equal(runtime.entry().observed_state, "failed",
    "raw handle state cannot overwrite durable typed terminal authority");
});

test("handoff during native dispatch journals the exact returned provider without installing listeners", async () => {
  let runtime!: ReturnType<typeof harness>;
  const port = provider({
    spawn: async () => {
      runtime.setHandoff(true);
      return { ...returnedHandle, custodyLaunchAgentSessionId: "launched-worker" };
    },
  });
  runtime = harness({ provider: port });

  await runtime.coordinator.converge("agent-1");

  assert.equal(runtime.entry().provider_ref?.provider_continuation_id, "continuation-1");
  assert.equal(runtime.entry().provider_ref?.execution_generation_id, "generation-1");
  assert.equal(runtime.entry().provider_ref?.custodial_launch_agent_session_id, "launched-worker");
  assert.deepEqual(
    runtime.checkpoints,
    [],
    "handoff may fence later configuration/checkpoint bookkeeping once provider_ref is durable",
  );
  assert.equal(runtime.installed.length, 0, "retiring daemon never owns returned-handle callbacks");
  await runtime.coordinator.drainDispatches();
});

test("ordinary persistence keeps only the worker identity receipted by the native launch", async () => {
  const runtime = harness();
  await runtime.coordinator.persistProviderHandle("agent-1", { ...returnedHandle, custodyLaunchAgentSessionId: "launched-worker" }, "generation-1");
  assert.equal(runtime.entry().provider_ref?.custodial_launch_agent_session_id, "launched-worker");
  await runtime.coordinator.persistProviderHandle("agent-1", returnedHandle, "generation-2");
  assert.equal(runtime.entry().provider_ref?.custodial_launch_agent_session_id, undefined, "a successor cannot inherit an unreceipted worker identity");
});

test("ordinary provider birth holds manifest mutation authority through generation acceptance", async () => {
  const runtime = harness();
  let mutationTail = Promise.resolve();
  runtime.options.authority.serializeManifestMutation = async (operation) => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const originalCheckpoint = runtime.options.store.checkpointProviderBirth;
  let checkpointEntered!: () => void;
  const checkpointStarted = new Promise<void>((resolve) => { checkpointEntered = resolve; });
  let releaseCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  let birthCommitted!: () => void;
  const birthCommit = new Promise<void>((resolve) => { birthCommitted = resolve; });
  runtime.options.store.checkpointProviderBirth = async (...args) => {
    checkpointEntered();
    await checkpointGate;
    const result = await originalCheckpoint(...args);
    birthCommitted();
    return result;
  };

  const persistence = runtime.coordinator.persistProviderHandle(
    "agent-1",
    returnedHandle,
    "generation-1",
    1,
    "typed_shadow",
  );
  await checkpointStarted;
  let peerEntered = false;
  const peerMutation = runtime.options.authority.serializeManifestMutation(async () => {
    peerEntered = true;
    const expectedGeneration = runtime.options.authority.currentManifestGeneration();
    await birthCommit;
    assert.equal(
      runtime.options.authority.currentManifestGeneration(),
      expectedGeneration,
      "a peer manifest transition must not capture generation before provider birth commits",
    );
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peerEntered, false, "provider birth keeps a peer transition outside the mutation lane");
  releaseCheckpoint();

  await Promise.all([persistence, peerMutation]);
});

test("legacy resume stages wait authority from the persisted successor rather than the predecessor snapshot", async () => {
  const runtime = harness({
    entry: {
      ...baseEntry(), delivery_mode: "mcp_polling",
      provider_ref: {
        work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
        provider_continuation_id: "continuation-1", provider_connection: returnedHandle.providerConnection,
      },
    },
    provider: provider({ capabilities: async () => ({
      resume: true, midTurnInjection: false, transcriptAccess: false,
      permissionPromptBridging: false, survivesRestart: false,
    }) }),
  });
  runtime.executionGenerations.push({
    execution_generation_id: "generation-1", work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z", actor: "test", generation: 1,
    terminal: runtime.options.terminalPayload(terminal(returnedHandle), "test"),
  });
  runtime.options.bindings.get = async () => ({
    entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
    execution_generation_id: "generation-1", agent_session_id: "session-1",
    credential_ref: "legacy-ref", api_url: "https://letagents.test", room_cursor: "7",
    last_sequence: 9, last_observed_at_ms: 1_000, updated_at: "2026-08-26T00:00:00.000Z",
  });
  let stagedGeneration: string | null = null;
  runtime.options.streams.stageWorkerBindingAfterResume = async (entry, prior, successor, handle) => {
    assert.equal(entry.provider_ref?.execution_generation_id, successor);
    assert.equal(entry.provider_ref?.execution_generation_id, runtime.entry().provider_ref?.execution_generation_id);
    assert.equal(prior.execution_generation_id, "generation-1");
    assert.equal(handle, returnedHandle);
    stagedGeneration = successor;
  };

  await runtime.coordinator.converge("agent-1");

  assert.equal(stagedGeneration, "generation-2");
  assert.equal(runtime.entry().last_error, "resumed provider awaits exact worker wait evidence");
});

function ownedRecoveryHarness() {
  const runtime = harness({
    entry: {
      ...baseEntry(), delivery_mode: "daemon_inbox", observed_state: "recovering",
      condition: "coordination_blocked", last_error: "resumed provider awaits exact worker wait evidence",
      provider_ref: {
        work_attempt_id: "attempt-1", execution_generation_id: "generation-2",
        provider_continuation_id: "continuation-1", provider_connection: returnedHandle.providerConnection,
      },
    },
    provider: provider({ attach: async () => returnedHandle }),
  });
  runtime.executionGenerations.push({
    execution_generation_id: "generation-2", work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:01.000Z", actor: "test", generation: 2, terminal: null,
  });
  let grant: InstalledHostGrant = {
    entryId: "agent-1", roomId: "room-1", agentKey: "owner/agent-1",
    grantId: "grant-1", supervisorGrant: "supervisor-secret", grantGeneration: 1,
    apiUrl: "https://letagents.test", daemonGeneration: 7, hostId: "host-1",
    installationId: "installation-1", expiresAt: "2099-01-01T00:00:00.000Z",
  };
  let binding: WorkerSessionBinding = {
    entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
    execution_generation_id: "generation-1", agent_session_id: "session-1",
    credential_ref: "old-bearer-id", api_url: grant.apiUrl, room_cursor: "7",
    last_sequence: 9, last_observed_at_ms: 1_000, updated_at: "2026-08-26T00:00:00.000Z",
  };
  let credential = "old-secret";
  let mintCalls = 0;
  let deliveryStarts = 0;
  let waitStages = 0;
  const failures: unknown[] = [];
  runtime.options.bindings = {
    get: async () => binding,
    credentialFor: async () => credential,
    supervisedWorkerSession: async () => null,
  };
  runtime.options.host = {
    ...runtime.options.host,
    requiresGrant: () => true,
    currentGrant: () => grant,
    ensureGrantFresh: async () => grant,
    mintSession: async (entry, executionGenerationId): Promise<BoundWorkerAuthorization> => {
      mintCalls += 1;
      return {
        executionGenerationId, agentSessionId: "session-1", bearer: "current-secret",
        bearerId: "current-bearer-id", expiresAt: grant.expiresAt, apiUrl: grant.apiUrl,
        authority: { entryId: entry.id, roomId: entry.room_id, workAttemptId: entry.work_attempt_id!, grant },
      };
    },
    bindMintedSession: async (_entryId, minted) => {
      binding = {
        ...binding, entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
        execution_generation_id: minted.executionGenerationId, agent_session_id: minted.agentSessionId,
        credential_ref: minted.bearerId, api_url: minted.apiUrl,
      };
      credential = minted.bearer;
      runtime.setEntry({ ...runtime.entry(), condition: "none", last_error: null });
    },
    recordBindingRecoveryFailure: async (_id, _generation, error) => { failures.push(error); },
  };
  runtime.options.streams.stageWorkerBindingAfterResume = async () => { waitStages += 1; throw new Error("owned agents never poll"); };
  runtime.options.delivery.start = async () => { deliveryStarts += 1; };
  return {
    ...runtime, failures,
    get binding() { return binding; },
    get mintCalls() { return mintCalls; },
    get deliveryStarts() { return deliveryStarts; },
    get waitStages() { return waitStages; },
    replaceGrant: () => { grant = { ...grant, grantId: "grant-2" }; },
  };
}

test("daemon-owned reattach binds the current generation despite a still-present predecessor credential", async () => {
  const runtime = ownedRecoveryHarness();
  await runtime.coordinator.converge("agent-1");
  assert.equal(runtime.mintCalls, 1);
  assert.equal(runtime.binding.execution_generation_id, "generation-2");
  assert.equal(runtime.binding.agent_session_id, "session-1");
  assert.equal(runtime.binding.room_cursor, "7", "recovery retains worker cursor and durable ingress owns polling");
  assert.equal(runtime.binding.last_sequence, 9);
  assert.equal(runtime.entry().condition, "none");
  assert.equal(runtime.entry().observed_state, "working");
  assert.equal(runtime.deliveryStarts, 1);
  assert.equal(runtime.waitStages, 0);
  assert.deepEqual(runtime.failures, []);
});

test("unresolved polling activation permits exact recovery and explicit stop but never a successor", async () => {
  for (const phase of ["prepared", "dispatching", "uncertain", "active"] as const) {
    const runtime = ownedRecoveryHarness();
    runtime.setEntry({ ...runtime.entry(), delivery_mode: "mcp_polling", provider_ref: {
      ...runtime.entry().provider_ref!, custodial_launch_agent_session_id: "session-1",
    } });
    runtime.options.store.getAgentConfiguration = async () => ({ provider: "codex", model: null, reasoning_effort: null,
      permission_profile_id: "full_access", provider_launch_policy: {}, config_revision: 1,
      runtime_configuration_revision: 1, polling_contract: "custodial_polling_v1" });
    const activation: PollingActivationRecord = {
      operation_id: "activation-1", request_id: "activate-1", reverse_operation_id: "reverse-1",
      agent_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "generation-2",
      native_continuation_id: "continuation-1", native_connection_kind: "codex_app_server", native_pid: 4242,
      native_process_identity: "birth-4242", native_connection_sha256: createHash("sha256").update(JSON.stringify([
        "codex_app_server", "http://127.0.0.1:4242", 4242, "birth-4242",
      ])).digest("hex"), config_revision: 1, agent_session_id: "session-1", room_cursor: "7", phase,
      provider_turn_id: phase === "active" ? "native-turn" : null, terminal_outcome: null, created_at_ms: 1, updated_at_ms: 1,
    };
    runtime.options.store.unresolvedPollingActivation = async () => activation;
    await runtime.coordinator.converge("agent-1");
    assert.equal(runtime.installed.length, 1, phase);
    assert.equal(runtime.mintCalls, 1, "the exact runtime can recover its worker without polling evidence");
    assert.equal(runtime.waitStages, 0);
    assert.equal(runtime.deliveryStarts, 0);
    assert.equal(runtime.executionGenerations.length, 1);

    runtime.executionGenerations[0]!.terminal = runtime.options.terminalPayload(terminal(returnedHandle), "test");
    runtime.liveHandles.clear();
    await runtime.coordinator.converge("agent-1");
    assert.equal(runtime.executionGenerations.length, 1, "a terminal runtime cannot replay an unresolved activation in a successor");
    let stops = 0;
    runtime.options.provider.stopRef = async (ref) => {
      stops++;
      assert.equal(ref.providerConnection?.processIdentity, activation.native_process_identity);
      return terminal(returnedHandle);
    };
    runtime.options.provider.stop = async () => { throw new Error("cached stop cannot prove activation writer death"); };
    runtime.setEntry({ ...runtime.entry(), desired_state: phase === "active" ? "stopped" : "paused" });
    if (phase !== "uncertain") runtime.liveHandles.set("agent-1", returnedHandle);
    await runtime.coordinator.converge("agent-1");
    assert.equal(stops, 1, "Pause/Stop is available both attached and after transport loss");
    runtime.setEntry({ ...runtime.entry(), provider_ref: { ...runtime.entry().provider_ref!, provider_continuation_id: "successor" } });
    await runtime.coordinator.converge("agent-1");
    assert.equal(stops, 1, "the old activation never stops a replacement runtime");
  }
});

test("draining preserves exact old-provider recovery while dispatching refuses attach", async () => {
  const runtime = ownedRecoveryHarness();
  runtime.options.store.unresolvedDeliveryDrain = async () => ({ phase: "draining" } as never);
  await runtime.coordinator.converge("agent-1");
  assert.equal(runtime.mintCalls, 1);
  assert.equal(runtime.deliveryStarts, 1);
  assert.equal(runtime.waitStages, 0);
  runtime.options.store.unresolvedDeliveryDrain = async () => ({ phase: "dispatching" } as never);
  assert.equal(await runtime.coordinator.attachLiveProvider(runtime.entry()), null);
  await runtime.coordinator.converge("agent-1");
  assert.equal(runtime.mintCalls, 1);
  assert.equal(runtime.deliveryStarts, 1);
});

test("a resolved mint/bind call without exact read-back never makes an owned provider ready", async () => {
  const runtime = ownedRecoveryHarness();
  runtime.options.host.bindMintedSession = async () => {};
  await runtime.coordinator.converge("agent-1");
  assert.equal(runtime.entry().condition, "coordination_blocked");
  assert.equal(runtime.entry().observed_state, "recovering");
  assert.equal(runtime.deliveryStarts, 0);
  assert.equal(runtime.failures.length, 1);
  assert.equal(runtime.waitStages, 0);
});

test("owned convergence rejects a cursor for another room before attaching or minting", async () => {
  const runtime = ownedRecoveryHarness();
  runtime.options.inbox.cursor = async () => ({ agent_id: "agent-1", room_id: "other-room", last_observed_message_id: "7" });
  await runtime.coordinator.converge("agent-1");
  assert.equal(runtime.installed.length, 0);
  assert.equal(runtime.mintCalls, 0);
  assert.equal(runtime.deliveryStarts, 0);
});

test("owned recovery cannot start delivery after grant, daemon, continuation, or handle changes", async () => {
  for (const move of ["grant", "daemon", "continuation", "handle"] as const) {
    const runtime = ownedRecoveryHarness();
    const bind = runtime.options.host.bindMintedSession;
    runtime.options.host.bindMintedSession = async (...args) => {
      await bind(...args);
      if (move === "grant") runtime.replaceGrant();
      if (move === "daemon") runtime.setHandoff(true);
      if (move === "continuation") runtime.setEntry({
        ...runtime.entry(), provider_ref: { ...runtime.entry().provider_ref!, provider_continuation_id: "replacement" },
      });
      if (move === "handle") runtime.liveHandles.set("agent-1", { ...returnedHandle });
    };
    await runtime.coordinator.converge("agent-1");
    assert.equal(runtime.deliveryStarts, 0, move);
    assert.equal(runtime.waitStages, 0, move);
  }
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
