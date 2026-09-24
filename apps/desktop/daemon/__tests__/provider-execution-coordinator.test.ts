import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerAcquisitionIdentity, retainProviderAcquisitionEvidence } from "../../../../shared/provider-acquisition-evidence.mjs";
import { validatedNativeRuntimeDeath } from "../provider-action-port.js";

import {
  ProviderExecutionCoordinator,
  type ProviderExecutionCoordinatorOptions,
} from "../provider-execution-coordinator.js";
import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionSpawn,
  ProviderActionTerminal,
} from "../provider-action-port.js";
import type { DaemonManifestEntry, ExecutionTerminalPayload, TaskWorkAttempt } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";
import type { BoundWorkerAuthorization, InstalledHostGrant } from "../worker-runtime-custody.js";
import type { PollingActivationRecord } from "../custodial-polling-activation.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import { ExecutionDelegationCoordinator } from "../execution-delegation-coordinator.js";

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
  workspaceIdentity?: TaskWorkAttempt["workspace_identity"];
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
    settleRuntimeApprovals: async () => {},
    provider: port,
    store: {
      unresolvedDeliveryDrain: async () => null,
      pendingRuntimeRecovery: async () => null,
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
        workspace_identity: input.workspaceIdentity ?? {
          repo: "repo",
          remote_url: "https://example.test/repo.git",
          resolved_revision: "a".repeat(40),
          bare_path: "/tmp/repo.git",
        },
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
      ...(value.nativeRuntimeDeath ? { native_runtime_death: value.nativeRuntimeDeath } : {}),
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
    inbox: { head: async () => null, cursor: async () => ({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "1" }) },
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

for (const mismatch of [null, "workAttemptId", "roomId", "supervisorEntryId", "supervisorExecutionGenerationId", "provider", "death", "continuation"] as const) {
  test(`failed acquisition terminal uses only its exact launch evidence: ${mismatch ?? "matching"}`, async () => {
    const port = provider();
    const original = new Error("Claude bootstrap_turn deadline");
    const connection = { kind: "claude_cli" as const, pid: 4444, processIdentity: "new-birth-4444" };
    port.spawn = async request => {
      const supplied = { ...request, ...(mismatch && ["workAttemptId", "roomId", "supervisorEntryId", "supervisorExecutionGenerationId"].includes(mismatch)
        ? { [mismatch]: "wrong-launch" } : {}) };
      const identity = providerAcquisitionIdentity(mismatch === "provider" ? "codex" : "claude-code", supplied,
        mismatch === "continuation" ? "wrong-continuation" : null);
      const receipt = { endedAt: "2026-08-26T00:00:03.000Z", exitCode: null, signal: "SIGTERM",
        terminalCause: "protocol_error" as const, providerContinuationId: "new-continuation",
        nativeRuntimeDeath: { ...connection, processIdentity: mismatch === "death" ? "wrong-birth" : connection.processIdentity } };
      retainProviderAcquisitionEvidence(original, identity, connection, receipt);
      // The transfer must retain the acquired identity, not later mutable objects.
      connection.pid = 5555;
      receipt.providerContinuationId = "later-mutation";
      throw original;
    };
    const runtime = harness({ provider: port, entry: { ...baseEntry(), provider: "claude-code", delivery_mode: "daemon_inbox" } });
    const format = runtime.options.terminalPayload;
    runtime.options.terminalPayload = (value, actor, expected) => {
      validatedNativeRuntimeDeath(value, expected);
      return format(value, actor, expected);
    };
    let releases = 0;
    runtime.options.durability.releaseTerminalExecutionFence = async () => { releases += 1; };
    await assert.rejects(runtime.coordinator.converge("agent-1"), mismatch ? /does not match/ : error => error === original);
    assert.equal(runtime.installed.length, 0);
    assert.equal(runtime.liveHandles.size, 0);
    assert.equal(runtime.terminalWrites.length, mismatch ? 0 : 1);
    assert.equal(releases, mismatch ? 0 : 1);
    if (!mismatch) {
      const saved = runtime.terminalWrites[0]!.terminal;
      assert.deepEqual(saved.native_runtime_death, { kind: "claude_cli", pid: 4444, processIdentity: "new-birth-4444" });
      assert.equal(saved.signal, "SIGTERM");
      assert.equal(saved.provider_continuation_id, "new-continuation");
      assert.equal(saved.terminal_cause, "protocol_error");
    }
  });
}

test("rehydration reminders share one failed native admission and retain its diagnostic", async () => {
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let launches = 0;
  const runtime = harness({ provider: provider({ spawn: async () => {
    launches++; started(); await gate; throw new Error("native bootstrap failed");
  } }) });
  runtime.options.recordSchedulerFailure = async () => {
    runtime.setEntry({ ...runtime.entry(), observed_state: "failed", condition: "coordination_blocked", last_error: "native bootstrap failed" });
  };
  runtime.coordinator.request("agent-1", "rehydration");
  await launched;
  for (let i = 0; i < 5; i++) runtime.coordinator.request("agent-1", "rehydration");
  const drained = runtime.coordinator.drainConvergence();
  release();
  await drained;
  assert.equal(launches, 1);
  assert.equal(runtime.executionGenerations.length, 1);
  assert.equal(runtime.entry().last_error, "native bootstrap failed");
  // Timestamp, projection and inbox progress are not new launch authority.
  runtime.setEntry({ ...runtime.entry(), updated_at: "2099-01-01T00:00:00.000Z" });
  runtime.options.inbox.cursor = async () => ({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "999" });
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 1);
  assert.equal(runtime.entry().observed_state, "failed");
});

for (const change of ["configuration", "control", "grant", "expiry", "continuation", "daemon"] as const) {
  test(`rehydration preserves ${change} changed during failure projection`, async () => {
    let launches = 0;
    const runtime = harness({ provider: provider({ spawn: async () => { launches++; throw new Error("bootstrap failed"); } }) });
    let revision = 1;
    const readConfiguration = runtime.options.store.getAgentConfiguration;
    runtime.options.store.getAgentConfiguration = async id => ({ ...(await readConfiguration(id))!, config_revision: revision });
    let grant: InstalledHostGrant = {
      entryId: "agent-1", roomId: "room-1", agentKey: "agent-key", grantId: "grant-1", grantGeneration: 1,
      supervisorGrant: "secret", apiUrl: "https://example.test", daemonGeneration: 7, hostId: "host-1",
      installationId: "installation-1", ownerAccountId: "owner", scopeKey: "scope", expiresAt: "2099-01-01T00:00:00.000Z",
    };
    runtime.options.host.currentGrant = () => grant;
    let projecting!: () => void;
    const projected = new Promise<void>(resolve => { projecting = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    runtime.options.recordSchedulerFailure = async () => { projecting(); await gate; };
    runtime.coordinator.request("agent-1", "rehydration");
    await projected;
    if (change === "configuration") revision++;
    if (change === "control") runtime.bumpControlEpoch();
    if (change === "grant") grant = { ...grant, grantId: "grant-2" };
    if (change === "expiry") grant = { ...grant, expiresAt: "2099-02-01T00:00:00.000Z" };
    if (change === "daemon") runtime.options.authority.currentDaemonGeneration = () => 8;
    if (change === "continuation") runtime.setEntry({ ...runtime.entry(), provider_ref: {
      work_attempt_id: "attempt-1", execution_generation_id: runtime.executionGenerations[0]!.execution_generation_id, provider_continuation_id: "saved-conversation",
      provider_connection: returnedHandle.providerConnection,
    } });
    runtime.coordinator.request("agent-1", "rehydration");
    runtime.coordinator.request("agent-1", "rehydration");
    const drained = runtime.coordinator.drainConvergence();
    release();
    await drained;
    assert.equal(launches, 2, "exactly one follow-up uses the changed inputs");
    runtime.coordinator.request("agent-1", "rehydration");
    await runtime.coordinator.drainConvergence();
    assert.equal(launches, 2, "the new failed inputs are retained");
  });
}

for (const trigger of ["grant_replay", "room_pointer"] as const) {
  for (const hasDelegation of [false, true]) {
    test(`${trigger} with ${hasDelegation ? "a reconciled" : "no"} delegation preserves failed-launch admission`, async () => {
      let launches = 0;
      const runtime = harness({ provider: provider({ spawn: async () => {
        launches++;
        throw new Error("native bootstrap failed");
      } }) });
      const grant: InstalledHostGrant = {
        entryId: "agent-1", roomId: "room-1", agentKey: "agent-key", grantId: "grant-1", grantGeneration: 1,
        supervisorGrant: "secret", apiUrl: "https://example.test", daemonGeneration: 7, hostId: "host-1",
        installationId: "installation-1", ownerAccountId: "owner", scopeKey: "owner", expiresAt: "2099-01-01T00:00:00.000Z",
      };
      runtime.options.host.currentGrant = () => grant;
      let revision = 1;
      const readConfiguration = runtime.options.store.getAgentConfiguration;
      runtime.options.store.getAgentConfiguration = async id => ({ ...(await readConfiguration(id))!, config_revision: revision });
      let wakes = 0, reconciliations = 0;
      const diagnostics: unknown[] = [];
      const delegations = new ExecutionDelegationCoordinator({
        entries: {
          getEntry: async () => runtime.entry(), listRoomEntries: async () => [runtime.entry()],
          listExecutionDelegationInstanceIds: async () => [], getExecutionApproval: async () => null,
          listExecutionDelegationsForApprovalPublication: async () => [], readExecutionApprovalProjection: async () => null,
        },
        authority: {
          currentHostGrant: () => grant, installHostGrant: async () => ({ status: "installed" as const }),
          syncExecutionDelegation: async () => { reconciliations++; },
          recordDelegatedApproval: async () => { throw new Error("unexpected approval"); },
          validateExecutionDelegation: async () => { throw new Error("unexpected delegation validation"); },
        },
        approvals: { admitDelegatable: async () => [], applyRecordedDecision: async () => {} },
        remote: { listExecutionDelegationIds: async () => ({ delegationInstanceIds: hasDelegation ? ["delegation-1"] : [], nextCursor: null }) },
        requestConvergence: (id, kind) => { wakes++; runtime.coordinator.request(id, kind); },
        diagnostic: (_domain, _id, error) => { diagnostics.push(error); },
      });
      async function reconcile() {
        const previousWakes = wakes;
        if (trigger === "grant_replay") await delegations.installHostGrant({ entry_id: "agent-1" } as never);
        else delegations.requestRoom("room-1");
        for (let i = 0; i < 20 && wakes === previousWakes; i++) await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(wakes, previousWakes + 1);
        await runtime.coordinator.drainConvergence();
      }
      try {
        runtime.coordinator.request("agent-1", "rehydration");
        await runtime.coordinator.drainConvergence();
        assert.equal(launches, 1);
        await reconcile();
        assert.deepEqual(diagnostics, []);
        assert.equal(reconciliations, hasDelegation ? 1 : 0);
        assert.equal(launches, hasDelegation ? 2 : 1, "an empty inventory is not new launch authority");
        if (!hasDelegation) {
          revision++;
          await reconcile();
          assert.equal(launches, 2, "changed launch inputs remain eligible through an empty inventory reminder");
          await reconcile();
          assert.equal(launches, 2, "unchanged failed inputs remain suppressed after that change");
        }
      } finally {
        await delegations.fenceAndDrain();
      }
    });
  }
}

test("owned convergence and the existing single recovery timer bypass reminder suppression", async () => {
  let launches = 0;
  const runtime = harness({ provider: provider({ spawn: async () => { launches++; throw new Error("bootstrap failed"); } }) });
  const timers: Array<() => void> = [];
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    setTimeout: ((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as unknown as typeof setTimeout,
  });
  coordinator.request("agent-1", "rehydration");
  await coordinator.drainConvergence();
  coordinator.request("agent-1");
  await coordinator.drainConvergence();
  assert.equal(launches, 2);
  coordinator.scheduleRecovery("agent-1", 100);
  coordinator.scheduleRecovery("agent-1", 100);
  assert.equal(timers.length, 1);
  timers[0]!();
  await coordinator.drainConvergence();
  assert.equal(launches, 3);
});

test("reminders before inbox admission and grant refresh do not poison launch identity", async () => {
  let launches = 0;
  const runtime = harness({ entry: { ...baseEntry(), delivery_mode: "daemon_inbox" },
    provider: provider({ spawn: async () => { launches++; throw new Error("bootstrap failed"); } }),
  });
  runtime.options.inbox.cursor = async () => null;
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 0);
  runtime.options.inbox.cursor = async () => ({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "5" });
  runtime.options.host.requiresGrant = () => true;
  let grant: InstalledHostGrant | null = null;
  runtime.options.host.currentGrant = () => grant;
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 0);
  grant = { entryId: "agent-1", roomId: "room-1", agentKey: "agent", grantId: "old", grantGeneration: 1,
    supervisorGrant: "secret", apiUrl: "https://example.test", daemonGeneration: 7, hostId: "host", installationId: "installation",
    ownerAccountId: "owner", scopeKey: "scope", expiresAt: "2099-01-01T00:00:00.000Z" };
  runtime.options.host.ensureGrantFresh = async () => { grant = { ...grant!, grantId: "renewed" }; return grant; };
  runtime.options.host.mintAuthorization = async () => ({ agentSessionId: "session-1", bearer: "secret", bearerId: "bearer-1",
    expiresAt: grant!.expiresAt, apiUrl: grant!.apiUrl, authority: { entryId: "agent-1", roomId: "room-1", workAttemptId: "attempt-1", grant: grant! } });
  runtime.options.host.recordMintedSession = async (_entry, id, minted) => ({ ...minted, executionGenerationId: id });
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 1, "the actual renewed grant is the failure identity");
});

test("failed admission retains the Open Model credential actually consumed before a late replacement", async () => {
  const consumed: Array<string | null | undefined> = [];
  const runtime = harness({ entry: { ...baseEntry(), provider: "open-model" }, provider: provider({ spawn: async input => {
    consumed.push(input.providerCredential?.apiKey); throw new Error("bootstrap failed");
  } }) });
  let credential = { entryId: "agent-1", apiKey: "old-key", baseUrl: "https://models.example.test/v1", model: "test-model", daemonGeneration: 7 };
  runtime.options.host.currentOpenModelCredential = () => credential;
  const startGeneration = runtime.options.durability.startGeneration;
  runtime.options.durability.startGeneration = async (...args) => {
    const execution = await startGeneration(...args);
    credential = { ...credential, apiKey: "new-key" };
    return execution;
  };
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.deepEqual(consumed, ["old-key", "new-key"]);
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(consumed.length, 2);
});

test("failed admission uses the work attempt created inside convergence", async () => {
  let launches = 0, provisions = 0;
  const runtime = harness({ entry: { ...baseEntry(), workspace_path: null, work_attempt_id: null },
    provider: provider({ spawn: async () => { launches++; throw new Error("bootstrap failed"); } }),
  });
  runtime.options.workspace.ephemeral.provision = async () => { provisions++; return { path: "/tmp/work" } as never; };
  runtime.options.durability.createAttempt = async () => runtime.options.durability.getAttempt("attempt-1");
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(runtime.entry().work_attempt_id, "attempt-1");
  assert.equal(provisions, 1);
  assert.equal(launches, 1);
});

test("rejected serialization releases pending reminder demand without caching a launch failure", async () => {
  let launches = 0;
  const runtime = harness({ provider: provider({ spawn: async () => { launches++; throw new Error("bootstrap failed"); } }) });
  const serialize = runtime.options.concurrency.serializeEntry;
  runtime.options.concurrency.serializeEntry = async () => { throw new Error("entry lane unavailable"); };
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 0);
  runtime.options.concurrency.serializeEntry = serialize;
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 1);
});

test("healthy reminders still settle approvals, refresh runtime and start delivery", async () => {
  const runtime = harness({ entry: { ...baseEntry(), delivery_mode: "daemon_inbox" } });
  let settled = 0, refreshed = 0, deliveries = 0;
  runtime.options.settleRuntimeApprovals = async () => { settled++; };
  runtime.options.refreshManagedRuntime = async () => { refreshed++; };
  runtime.options.delivery.start = async () => { deliveries++; };
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  const before = { settled, refreshed, deliveries };
  runtime.coordinator.request("agent-1", "rehydration");
  await runtime.coordinator.drainConvergence();
  assert.equal(runtime.executionGenerations.length, 1);
  assert.ok(settled > before.settled);
  assert.ok(refreshed > before.refreshed);
  assert.ok(deliveries > before.deliveries);
});

test("handoff drains queued reminders without a successor admission", async () => {
  let launches = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const runtime = harness({ provider: provider({ spawn: async () => { launches++; started(); await gate; throw new Error("bootstrap failed"); } }) });
  runtime.coordinator.request("agent-1", "rehydration");
  await launched;
  runtime.coordinator.request("agent-1", "rehydration");
  runtime.setHandoff(true);
  release();
  await runtime.coordinator.drainConvergence();
  assert.equal(launches, 1);
  runtime.coordinator.detachConvergence();
});

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

const repositoryWorkspaceIdentity: TaskWorkAttempt["workspace_identity"] = {
  repo: "repo", remote_url: "https://example.test/repo.git",
  resolved_revision: "a".repeat(40), bare_path: "/tmp/repo.git",
};
const scratchWorkspaceIdentity: TaskWorkAttempt["workspace_identity"] = {
  repo: "room-only", remote_url: "letagents-ephemeral:scratch",
  resolved_revision: "0".repeat(40), bare_path: "/tmp/work",
};

test("authorized worker routes reach the real provider MCP configuration on launch and resume", async () => {
  // Exercise default adapter factories, not helpers with a manually supplied
  // URL. Only native process creation is replaced; no credentials or network.
  const { ClaudeCodeProviderAdapter } = await import(new URL("../../electron/main/agents/claude-code-provider-adapter.ts", import.meta.url).href);
  const { CursorProviderAdapter } = await import(new URL("../../electron/main/agents/cursor-provider-adapter.ts", import.meta.url).href);
  const { CodexProviderAdapter } = await import(new URL("../../electron/main/agents/codex-provider-adapter.ts", import.meta.url).href);
  const { LETAGENTS_MCP_RUNTIME_VERSION } = await import(new URL("../../electron/main/agents/letagents-mcp-runtime.ts", import.meta.url).href);
  const { letAgentsRuntimeContract } = await import(new URL("../../../../src/mcp/server/runtime-contract.ts", import.meta.url).href);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "letagents-worker-route-")));
  const env = {
    LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174",
    LETAGENTS_DEV_MCP_SERVER_ENTRY: join(root, "runtime", "server.js"),
    LETAGENTS_STATE_PATH: join(root, "state", "mcp-state.json"),
    LETAGENTS_CURSOR_SOURCE_HOME: join(root, "source-home"),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    for (const directory of ["runtime/node_modules", "workspace", "source-home", "state"]) mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, "runtime/package.json"), JSON.stringify({ name: "letagents", version: LETAGENTS_MCP_RUNTIME_VERSION }));
    writeFileSync(env.LETAGENTS_DEV_MCP_SERVER_ENTRY, "// Never executed by this configuration test.\n");
    Object.assign(process.env, env);
    for (const providerName of ["codex", "claude-code", "cursor"] as const) {
      for (const apiUrl of ["letagents-local://rooms", "https://worker.example.test"]) {
        for (const mode of ["minted", "retained", "reminted"] as const) {
          let checked = false;
          const configure = async (request: ProviderActionSpawn) => {
            assert.equal(request.supervisorWorkerSession?.apiUrl, apiUrl);
            const stoppedBeforeNativeLaunch = new Error("configuration captured; no native process");
            const configRequest = { ...request, cwd: join(root, "workspace") };
            const invoke = async (adapter: InstanceType<typeof ClaudeCodeProviderAdapter>) => {
              if (mode === "minted") return adapter.spawn(configRequest);
              return adapter.resume({ workAttemptId: request.workAttemptId, providerContinuationId: "continuation-1", cwd: configRequest.cwd }, configRequest);
            };
            if (providerName === "claude-code") {
              let configPath = "";
              const adapter = new ClaudeCodeProviderAdapter({ dependencies: {
                readVersion: async () => "2.1.220 (Claude Code)",
                launchChild: (input: { args: string[] }) => {
                  const path = input.args[input.args.indexOf("--mcp-config") + 1]!;
                  configPath = path;
                  const config = JSON.parse(readFileSync(path, "utf8"));
                  assert.equal(config.mcpServers.letagents.env.LETAGENTS_API_URL, apiUrl);
                  assert.doesNotMatch(JSON.stringify(config), /test-only|LETAGENTS_TOKEN|LETAGENTS_AGENT_SESSION_BEARER/);
                  checked = true;
                  throw stoppedBeforeNativeLaunch;
                },
              } });
              await assert.rejects(invoke(adapter), error => error === stoppedBeforeNativeLaunch);
              assert.ok(configPath);
              assert.equal(existsSync(configPath), false, "failed native launch cleans the managed config");
            } else if (providerName === "cursor") {
              const adapter = new CursorProviderAdapter();
              await invoke(adapter);
              const profile = createHash("sha256").update(request.workAttemptId).digest("hex").slice(0, 32);
              const config = JSON.parse(readFileSync(join(root, "state", "cursor-supervised", profile, "home/.cursor/mcp.json"), "utf8"));
              const server = Object.values(config.mcpServers)[0] as { env: Record<string, string> };
              assert.equal(server.env.LETAGENTS_API_URL, apiUrl);
              checked = true;
            } else {
              const adapter = new CodexProviderAdapter({ dependencies: {
                writeSupervisorBridgeContext: async () => {},
                resolveServerUrl: async () => "ws://127.0.0.1:1",
                readMcpRuntimeContract: async (_entry: string, route: string) => {
                  assert.equal(route, apiUrl);
                  return letAgentsRuntimeContract(route);
                },
                launchServer: (_url: string, _bin: string, options: { configOverrides: string[] }) => {
                  assert.ok(options.configOverrides.join("\n").includes(`"LETAGENTS_API_URL" = ${JSON.stringify(apiUrl)}`));
                  checked = true;
                  throw stoppedBeforeNativeLaunch;
                },
              } });
              await assert.rejects(invoke(adapter), error => error === stoppedBeforeNativeLaunch);
            }
            return returnedHandle;
          };
          const runtime = harness({
            entry: { ...baseEntry(), provider: providerName, permission_profile_id: providerName === "codex" ? "ask_before_write" : "read_only", delivery_mode: "daemon_inbox",
              ...(mode !== "minted" ? { provider_ref: {
                work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
                provider_continuation_id: "continuation-1", provider_connection: returnedHandle.providerConnection,
              } } : {}),
            },
            workspaceIdentity: scratchWorkspaceIdentity,
            provider: provider({ spawn: configure, resume: async (_ref, request) => configure(request),
              capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
            }),
          });
          if (mode !== "minted") {
            runtime.executionGenerations.push({ execution_generation_id: "generation-1", work_attempt_id: "attempt-1", started_at: "2026-08-26T00:00:00.000Z", actor: "test", generation: 1, terminal: runtime.options.terminalPayload(terminal(returnedHandle), "test") });
            runtime.options.bindings.get = async () => ({ entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "generation-1", agent_session_id: "session-1", credential_ref: "test", api_url: mode === "reminted" ? "https://old.example.test" : apiUrl, room_cursor: "7", last_sequence: 9, last_observed_at_ms: 1_000, updated_at: "2026-08-26T00:00:00.000Z" });
          }
          if (mode !== "retained") {
            const grant: InstalledHostGrant = { entryId: "agent-1", roomId: "room-1", agentKey: "owner/agent-1", grantId: "grant-1", supervisorGrant: "test-only", grantGeneration: 1, apiUrl, daemonGeneration: 7, hostId: "host-1", installationId: "installation-1", expiresAt: "2099-01-01T00:00:00.000Z" };
            runtime.options.host.requiresGrant = () => true;
            runtime.options.host.currentGrant = () => grant;
            runtime.options.host.ensureGrantFresh = async () => grant;
            runtime.options.host.mintAuthorization = async () => ({ agentSessionId: "session-1", bearer: "test-only", bearerId: "bearer-1", expiresAt: grant.expiresAt, apiUrl, authority: { entryId: "agent-1", roomId: "room-1", workAttemptId: "attempt-1", grant } });
            runtime.options.host.recordMintedSession = async (_entry, executionGenerationId, authorization) => ({ ...authorization, executionGenerationId });
          }
          await runtime.coordinator.converge("agent-1");
          assert.equal(checked, true, `${providerName}/${apiUrl}/${mode}: ${runtime.entry().last_error}`);
        }
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

for (const { label, entryPatch, workspaceIdentity, expectedWorkspaceKind } of [
  {
    label: "explicit scratch",
    entryPatch: { source_repo_path: null },
    workspaceIdentity: scratchWorkspaceIdentity,
    expectedWorkspaceKind: "room_scratch",
  },
  {
    label: "explicit repository",
    entryPatch: { source_repo_path: "/repo" },
    workspaceIdentity: repositoryWorkspaceIdentity,
    expectedWorkspaceKind: "git_worktree",
  },
  {
    label: "legacy repository",
    entryPatch: {},
    workspaceIdentity: repositoryWorkspaceIdentity,
    expectedWorkspaceKind: "git_worktree",
  },
  {
    label: "legacy scratch",
    entryPatch: {},
    workspaceIdentity: scratchWorkspaceIdentity,
    expectedWorkspaceKind: "room_scratch",
  },
] as const) {
  test(`provider births declare the ${label} boundary as ${expectedWorkspaceKind}`, async () => {
    let workspaceKind: "git_worktree" | "room_scratch" | undefined;
    const runtime = harness({
      entry: { ...baseEntry(), ...entryPatch },
      workspaceIdentity,
      provider: provider({
        spawn: async request => {
          workspaceKind = request.workspaceKind;
          return returnedHandle;
        },
      }),
    });

    await runtime.coordinator.converge("agent-1");

    assert.equal(workspaceKind, expectedWorkspaceKind);
  });
}

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
  let bindCalls = 0;
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
      bindCalls += 1;
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
    get bindCalls() { return bindCalls; },
    get deliveryStarts() { return deliveryStarts; },
    get waitStages() { return waitStages; },
    replaceGrant: () => { grant = { ...grant, grantId: "grant-2" }; },
  };
}

test("a crashed Cursor generation with a blocked FIFO head cannot recover as a healthy idle lane", async () => {
  const runtime = ownedRecoveryHarness();
  const crash = { ...terminal(returnedHandle), exitCode: 1, terminalCause: "crashed" as const };
  runtime.executionGenerations[0]!.terminal = runtime.options.terminalPayload(crash, "test");
  runtime.setEntry({
    ...runtime.entry(), provider: "cursor", observed_state: "failed", condition: "none",
    provider_ref: { ...runtime.entry().provider_ref!,
      provider_connection: { kind: "cursor_cli", pid: null, processIdentity: null } },
  });
  const detail = "Cursor supervised turn failed: Cursor's live MCP connector ended before the turn became terminal.";
  runtime.options.inbox.head = async () => ({ room_id: "room-1", state: "blocked", last_error: detail }) as never;
  let launches = 0;
  runtime.options.provider.resume = async () => { launches++; return returnedHandle; };
  runtime.options.provider.spawn = async () => { launches++; return returnedHandle; };

  await runtime.coordinator.converge("agent-1");
  await runtime.coordinator.converge("agent-1");

  assert.equal(runtime.entry().observed_state, "recovering");
  assert.equal(runtime.entry().condition, "coordination_blocked");
  assert.equal(runtime.entry().last_error, detail);
  assert.equal(launches, 0);
  assert.equal(runtime.installed.length, 0);
  assert.equal(runtime.executionGenerations.length, 1);

  // Explicit recovery clears the runtime reference and settles the failed
  // head. Convergence can then create a fresh lane for the remaining FIFO.
  runtime.setEntry({ ...runtime.entry(), provider_ref: null, observed_state: "starting", condition: "none", last_error: null });
  runtime.options.inbox.head = async () => null;
  runtime.options.host.requiresGrant = () => false;
  runtime.options.provider.spawn = async () => {
    launches++;
    return { ...returnedHandle, pid: null, observedState: "idle",
      providerContinuationId: "replacement-continuation",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null } };
  };
  await runtime.coordinator.converge("agent-1");
  assert.equal(launches, 1);
  assert.equal(runtime.installed.length, 1);
  assert.equal(runtime.executionGenerations.length, 2);
  assert.equal(runtime.entry().provider_ref?.provider_continuation_id, "replacement-continuation");
});

test("a healthy processless Cursor lane remains idle and delivery-capable", async () => {
  const runtime = ownedRecoveryHarness();
  runtime.binding.execution_generation_id = "generation-2";
  const connection = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
  runtime.setEntry({ ...runtime.entry(), provider: "cursor", condition: "none", last_error: null,
    provider_ref: { ...runtime.entry().provider_ref!, provider_connection: connection } });
  runtime.liveHandles.set("agent-1", {
    ...returnedHandle, pid: null, providerConnection: connection, observedState: "idle",
  });

  await runtime.coordinator.converge("agent-1");

  assert.equal(runtime.entry().observed_state, "idle");
  assert.equal(runtime.entry().condition, "none");
  assert.equal(runtime.deliveryStarts, 1);
  assert.equal(runtime.mintCalls, 0);
});

test("exact Cursor host binding remains current while its per-turn child is replaced", async () => {
  const runtime = ownedRecoveryHarness();
  const cursorHandle: ProviderActionHandle = {
    ...returnedHandle,
    pid: 81_001,
    providerConnection: { kind: "cursor_cli", pid: 81_001, processIdentity: "wrapper-birth:1" },
  };
  runtime.binding.execution_generation_id = "generation-2";
  runtime.setEntry({
    ...runtime.entry(),
    provider: "cursor",
    observed_state: "idle",
    condition: "none",
    last_error: null,
    provider_ref: {
      work_attempt_id: "attempt-1",
      execution_generation_id: "generation-2",
      provider_continuation_id: "continuation-1",
      provider_connection: { kind: "cursor_cli", pid: null, processIdentity: null },
    },
  });
  runtime.liveHandles.set("agent-1", cursorHandle);
  const getBinding = runtime.options.bindings.get;
  let bindingReads = 0;
  runtime.options.bindings.get = async (entryId) => {
    const current = await getBinding(entryId);
    if (bindingReads++ === 0) {
      cursorHandle.pid = 81_002;
      cursorHandle.providerConnection = {
        kind: "cursor_cli", pid: 81_002, processIdentity: "wrapper-birth:2",
      };
    }
    return current;
  };

  await runtime.coordinator.converge("agent-1");

  assert.equal(runtime.mintCalls, 0);
  assert.equal(runtime.bindCalls, 0);
  assert.equal(runtime.deliveryStarts, 1);
  assert.equal(runtime.entry().condition, "none");
  assert.equal(runtime.entry().observed_state, "working");
});

test("malformed Cursor child PIDs cannot satisfy the exact host-binding predicate", async () => {
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const runtime = ownedRecoveryHarness();
    runtime.binding.execution_generation_id = "generation-2";
    runtime.setEntry({
      ...runtime.entry(),
      provider: "cursor",
      observed_state: "idle",
      condition: "none",
      last_error: null,
      provider_ref: {
        work_attempt_id: "attempt-1",
        execution_generation_id: "generation-2",
        provider_continuation_id: "continuation-1",
        provider_connection: { kind: "cursor_cli", pid: null, processIdentity: null },
      },
    });
    runtime.liveHandles.set("agent-1", {
      ...returnedHandle,
      pid,
      providerConnection: { kind: "cursor_cli", pid, processIdentity: "wrapper-birth:1" },
    });

    await runtime.coordinator.converge("agent-1");

    assert.equal(runtime.mintCalls, 1, String(pid));
    assert.equal(runtime.bindCalls, 1, String(pid));
  }
});

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

  internals.options.settleRuntimeApprovals = async () => { ordered.push("close"); };
  const attached = await runtime.coordinator.attachLiveProvider(current);
  assert.equal(attached, null);
  assert.deepEqual(ordered, ["terminal", "close", "release"]);
  assert.equal(runtime.installed.length, 0);
});

test("Codex reattachment carries only the exact applied permission configuration", async () => {
  for (const pendingEdit of [false, true]) {
    const current = baseEntry();
    current.permission_profile_id = "ask_before_write";
    current.provider_ref = { work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
      provider_continuation_id: "continuation-1", provider_connection: returnedHandle.providerConnection };
    let attachedPolicy: unknown = "not called";
    const runtime = harness({ entry: current, provider: provider({ attach: async ref => {
      attachedPolicy = ref.launchPolicy;
      return null;
    } }) });
    runtime.executionGenerations.push({ execution_generation_id: "generation-1", work_attempt_id: "attempt-1",
      started_at: "2026-08-26T00:00:00.000Z", actor: "daemon-provider", generation: 1, terminal: null });
    if (pendingEdit) {
      const { options } = runtime.coordinator as unknown as { options: ProviderExecutionCoordinatorOptions };
      const original = options.store.getAgentConfiguration;
      options.store.getAgentConfiguration = async id => ({ ...(await original(id))!, config_revision: 2 });
    }
    await runtime.coordinator.attachLiveProvider(current);
    assert.deepEqual(attachedPolicy, pendingEdit ? undefined : {
      approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false },
    }, "an unapplied edit cannot overwrite the surviving runtime's permission authority");
  }
});

test("convergence retries durable approval settlement before stopped or recovery early returns", async () => {
  const entry = baseEntry(); entry.desired_state = "stopped";
  const runtime = harness({ entry });
  let attempts = 0;
  runtime.options.settleRuntimeApprovals = async () => {
    attempts++;
    if (attempts === 1) throw new Error("closure write failed");
  };
  runtime.options.store.pendingRuntimeRecovery = async () => ({ operation_id: "recovery" } as never);
  await assert.rejects(runtime.coordinator.converge(entry.id), /closure write failed/);
  await runtime.coordinator.converge(entry.id);
  assert.equal(attempts, 2);
  assert.equal(runtime.executionGenerations.length, 0, "no successor starts ahead of settlement");
});

test("failed attach closure is retried from durable terminal without reattaching", async () => {
  const entry = baseEntry();
  entry.provider_ref = { work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
    provider_continuation_id: "continuation-1", provider_connection: claudeHandle.providerConnection };
  let attaches = 0; let closes = 0; let releases = 0;
  const runtime = harness({ entry, provider: provider({ attach: async () => {
    attaches++;
    return { state: "terminal", terminal: { endedAt: "2026-08-26T00:00:03.000Z", exitCode: 0,
      signal: null, terminalCause: "exited", providerContinuationId: "continuation-1",
      nativeRuntimeDeath: { kind: "claude_cli", pid: 4444, processIdentity: "birth-4444" } } };
  } }) });
  runtime.executionGenerations.push({ execution_generation_id: "generation-1", work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z", actor: "daemon-provider", generation: 1, terminal: null });
  runtime.options.settleRuntimeApprovals = async () => { if (++closes === 1) throw new Error("closure unavailable"); };
  runtime.options.durability.releaseTerminalExecutionFence = async () => { releases++; };
  await assert.rejects(runtime.coordinator.attachLiveProvider(entry), /closure unavailable/);
  assert.equal(runtime.terminalWrites.length, 1);
  assert.equal(releases, 0, "no fence release before closure commits");
  assert.equal(await runtime.coordinator.attachLiveProvider(entry), null);
  assert.equal(closes, 2); assert.equal(attaches, 1); assert.equal(runtime.terminalWrites.length, 1);
  assert.equal(releases, 1, "retry completes the release interrupted by the failed closure");
});
