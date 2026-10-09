import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerAcquisitionIdentity, retainProviderAcquisitionEvidence } from "../../../../shared/provider-acquisition-evidence.mjs";
import { validatedNativeRuntimeDeath } from "../provider-action-port.js";
import { advanceReconciliationState } from "../reconciler-state.js";
import { RETIREMENT_SETTLEMENT_WAIT_MS } from "../provider-execution-coordinator.js";
import { SupervisedAgentDelivery, SupervisedRoomAuthorizationError } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";

import {
  ProviderExecutionCoordinator,
  type ProviderExecutionCoordinatorOptions,
} from "../provider-execution-coordinator.js";
import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionRef,
  ProviderActionSpawn,
  ProviderActionTerminal,
} from "../provider-action-port.js";
import type { DaemonManifestEntry, ExecutionTerminalPayload, TaskWorkAttempt } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";
import type { BoundWorkerAuthorization, InstalledHostGrant } from "../worker-runtime-custody.js";
import type { PollingActivationRecord } from "../custodial-polling-activation.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import { ExecutionDelegationCoordinator } from "../execution-delegation-coordinator.js";
import { providerRef as recoveryProviderRef } from "../runtime-recovery-coordinator.js";

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
      awaitsBindingConfirmation: () => false,
      confirmExactBinding: async () => {},
      bearerNeedsRotation: async () => false,
      blockExpiredAuthority: async () => {},
      currentOpenModelCredential: (entryId, daemonGeneration) => manifestEntry.provider === "open-model"
        ? { entryId, apiKey: "test-key", baseUrl: "https://models.example.test/v1", model: "test-model", daemonGeneration }
        : null,
      recordBindingRecoveryFailure: async () => {},
      clearSuccessfulRecovery: () => {},
    },
    workspace: {
      ephemeral: {
        provision: async () => { throw new Error("unused"); },
        ensureRepository: async () => "present" as const,
      },
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
  for (const delegationState of ["empty", "unchanged", "changed"] as const) {
    test(`${trigger} with ${delegationState} delegation inventory preserves failed-launch admission`, async () => {
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
          syncExecutionDelegation: async () => { reconciliations++; return { changed: delegationState === "changed" }; },
          recordDelegatedApproval: async () => { throw new Error("unexpected approval"); },
          validateExecutionDelegation: async () => { throw new Error("unexpected delegation validation"); },
        },
        approvals: { admitDelegatable: async () => [], applyRecordedDecision: async () => {} },
        remote: { listExecutionDelegationIds: async () => ({ delegationInstanceIds: delegationState === "empty" ? [] : ["delegation-1"], nextCursor: null }) },
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
        assert.equal(reconciliations, delegationState === "empty" ? 0 : 1);
        assert.equal(launches, delegationState === "changed" ? 2 : 1, "an unchanged inventory is not new launch authority");
        if (delegationState !== "changed") {
          revision++;
          await reconcile();
          assert.equal(launches, 2, "changed launch inputs remain eligible through an unchanged inventory reminder");
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

test("a cold launch waits for a daemon-wide launch slot and rechecks its authority once admitted", async () => {
  for (const outcome of ["launched", "stopped while queued"] as const) {
    let launches = 0;
    let admit!: () => void;
    let released = false;
    const acquired: string[] = [];
    const heldDuringLaunch: boolean[] = [];
    const heldDuringInstall: boolean[] = [];
    const runtime = harness({ provider: provider({ spawn: async () => {
      launches++;
      heldDuringLaunch.push(!released);
      return returnedHandle;
    } }) });
    const install = runtime.options.streams.install;
    runtime.options.streams.install = async (...args) => { heldDuringInstall.push(!released); return install(...args); };
    const coordinator = new ProviderExecutionCoordinator({
      ...runtime.options,
      pacing: {
        acquire: async (lane, entryId) => {
          acquired.push(`${lane}:${entryId}`);
          await new Promise<void>((resolve) => { admit = resolve; });
          return () => { released = true; };
        },
        run: async () => { throw new Error("launches pace through acquire"); },
      },
    });
    const converging = coordinator.converge("agent-1");
    for (let turn = 0; turn < 20 && !acquired.length; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(acquired, ["launch:agent-1"], outcome);
    assert.equal(launches, 0, `${outcome}: nothing starts while queued`);
    if (outcome === "stopped while queued") runtime.bumpControlEpoch();
    admit();
    await converging;
    assert.equal(launches, outcome === "launched" ? 1 : 0, outcome);
    assert.equal(runtime.installed.length, outcome === "launched" ? 1 : 0, outcome);
    assert.equal(runtime.executionGenerations.at(-1)?.terminal ? "terminal" : "live",
      outcome === "launched" ? "live" : "terminal", `${outcome}: an unlaunched generation is closed`);
    assert.equal(released, true, `${outcome}: the slot is returned`);
    if (outcome === "launched") {
      assert.deepEqual(heldDuringLaunch, [true], "the slot covers the cold launch itself");
      assert.deepEqual(heldDuringInstall, [false], "and is returned before the post-launch binding work");
    }
  }
});

test("a provider whose process is up returns its launch slot before its remote bootstrap turn finishes", async () => {
  let released = false;
  let releasedOnNativeStart: boolean | null = null;
  let finishBootstrap: (() => void) | null = null;
  const runtime = harness({ provider: provider({ spawn: async (request) => {
    request.onNativeStarted?.();
    releasedOnNativeStart = released;
    await new Promise<void>((resolve) => { finishBootstrap = resolve; });
    return returnedHandle;
  } }) });
  const coordinator = new ProviderExecutionCoordinator({
    ...runtime.options,
    pacing: {
      acquire: async () => () => { released = true; },
      run: async () => { throw new Error("launches pace through acquire"); },
    },
  });
  const converging = coordinator.converge("agent-1");
  for (let turn = 0; turn < 50 && !finishBootstrap; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releasedOnNativeStart, true, "the next agent can launch while this one waits on its model");
  finishBootstrap!();
  await converging;
  assert.equal(runtime.installed.length, 1);
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
    const events: string[] = [];
    const runtime = harness({
      entry: { ...baseEntry(), ...entryPatch },
      workspaceIdentity,
      provider: provider({
        spawn: async request => {
          workspaceKind = request.workspaceKind;
          events.push(`spawn:${request.cwd}`);
          return returnedHandle;
        },
      }),
    });
    runtime.options.workspace.ephemeral.ensureRepository = async (path) => {
      events.push(`repository:${path}`);
      return "created";
    };

    await runtime.coordinator.converge("agent-1");

    assert.equal(workspaceKind, expectedWorkspaceKind);
    const cwd = events.at(-1)?.slice("spawn:".length);
    // Existing room-only workspaces are upgraded before a provider starts in them.
    assert.deepEqual(events, expectedWorkspaceKind === "room_scratch"
      ? [`repository:${cwd}`, `spawn:${cwd}`]
      : [`spawn:${cwd}`]);
  });
}

test("a room-only workspace whose repository cannot be written reports it, never says starting, and retries", async () => {
  let launches = 0;
  const runtime = harness({
    entry: { ...baseEntry(), source_repo_path: null },
    workspaceIdentity: scratchWorkspaceIdentity,
    provider: provider({ spawn: async () => { launches++; return returnedHandle; } }),
  });
  const states: string[] = [];
  const transition = runtime.options.transition;
  runtime.options.transition = async (...args) => { states.push(args[1]); return transition(...args); };
  let failures = 1;
  runtime.options.workspace.ephemeral.ensureRepository = async () => {
    if (failures-- > 0) throw new Error("EROFS: read-only file system");
    return "created";
  };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    setTimeout: ((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return { unref() {} };
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });

  await coordinator.converge("agent-1");

  assert.equal(launches, 0);
  assert.equal(runtime.executionGenerations.length, 0, "no execution generation starts for a launch that cannot happen");
  assert.deepEqual(states, ["failed"], "the entry never claims to be starting");
  assert.equal(runtime.entry().observed_state, "failed");
  assert.equal(runtime.entry().condition, "coordination_blocked");
  assert.equal(runtime.entry().last_error,
    "Could not prepare the agent's room-only workspace (EROFS: read-only file system). Retrying in 5 seconds.");
  assert.deepEqual(timers.map((timer) => timer.delay), [5_000]);

  timers[0].callback();
  await coordinator.drainConvergence();
  assert.equal(launches, 1, "the retry launches once the workspace can be prepared");
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

function typedLaneHarness(input: {
  handle: ProviderActionHandle;
  provider?: DaemonManifestEntry["provider"];
  port?: Partial<ProviderActionPort>;
  /** A runtime born before typed lifecycle keeps the mode it was born with. */
  authorityMode?: "typed" | "typed_shadow";
}) {
  const runtime = harness({
    entry: {
      ...baseEntry(),
      provider: input.provider ?? "codex",
      delivery_mode: "daemon_inbox" as const,
      // No execution fact reported the failure: the entry still looks alive.
      observed_state: "working" as const,
      provider_ref: {
        work_attempt_id: "attempt-1",
        execution_generation_id: "generation-1",
        provider_continuation_id: "continuation-1",
        provider_connection: input.handle.providerConnection,
      },
    },
    frozenAuthorityMode: input.authorityMode ?? "typed",
    provider: provider(input.port),
    currentInstallation: () => {
      const current = runtime.liveHandles.get("agent-1");
      return current ? {
        nonce: Symbol("installation"),
        listenerLeaseNonce: Symbol("lease"),
        entryId: "agent-1",
        handle: current,
        executionGenerationId: runtime.entry().provider_ref!.execution_generation_id,
        workAttemptId: "attempt-1",
        providerContinuationId: "continuation-1",
        providerConnection: current.providerConnection!,
        configurationRevision: 1,
        authorityMode: input.authorityMode ?? "typed",
      } : undefined;
    },
  });
  runtime.liveHandles.set("agent-1", input.handle);
  runtime.executionGenerations.push({
    execution_generation_id: "generation-1",
    work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z",
    actor: "test",
    generation: 1,
    terminal: null,
  });
  return runtime;
}

test("a typed lane whose live handle reports failure is fenced even though no fact failed its entry", async () => {
  for (const [provider, live] of [["codex", returnedHandle], ["claude-code", claudeHandle], ["open-model", openModelHandle]] as const) {
    for (const observedState of ["failed", "stopped"] as const) {
      let stopCalls = 0;
      let deliveryStarts = 0;
      const runtime = typedLaneHarness({
        handle: { ...live, observedState },
        provider,
        port: { stop: async current => { stopCalls += 1; return terminal(current); } },
      });
      runtime.options.delivery.start = async () => { deliveryStarts += 1; };

      await runtime.coordinator.converge("agent-1");

      const label = `${provider} ${observedState}`;
      assert.equal(stopCalls, 1, `${label}: the unusable runtime is stopped so the reconciler can replace it`);
      assert.equal(deliveryStarts, 0, `${label}: delivery is not reopened on a runtime no turn can use`);
      assert.equal(runtime.entry().observed_state, "working",
        `${label}: the entry changes only when the exit is observed, as for any other terminal`);
    }
  }
});

function boundTypedLaneHarness(handle: ProviderActionHandle, authorityMode: "typed" | "typed_shadow" = "typed") {
  let stopCalls = 0;
  let mintCalls = 0;
  let deliveryStarts = 0;
  const runtime = typedLaneHarness({ handle, authorityMode, port: { stop: async current => { stopCalls += 1; return terminal(current); } } });
  const grant: InstalledHostGrant = {
    entryId: "agent-1", roomId: "room-1", agentKey: "owner/agent-1",
    grantId: "grant-1", supervisorGrant: "supervisor-secret", grantGeneration: 1,
    apiUrl: "https://letagents.test", daemonGeneration: 7, hostId: "host-1",
    installationId: "installation-1", expiresAt: "2099-01-01T00:00:00.000Z",
  };
  // The agent's room binding is exact and its bearer is not due for rotation.
  const binding: WorkerSessionBinding = {
    entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
    execution_generation_id: "generation-1", agent_session_id: "session-1",
    credential_ref: "bearer-id", api_url: grant.apiUrl, room_cursor: null,
    last_sequence: 0, last_observed_at_ms: 0, updated_at: "2026-08-26T00:00:00.000Z",
  };
  runtime.options.bindings = {
    get: async () => binding,
    credentialFor: async () => "bearer-secret",
    supervisedWorkerSession: async () => null,
  };
  runtime.options.host = {
    ...runtime.options.host,
    requiresGrant: () => true,
    currentGrant: () => grant,
    ensureGrantFresh: async () => grant,
    bearerNeedsRotation: async () => false,
    mintSession: async () => { mintCalls += 1; throw new Error("no session may be minted here"); },
  };
  runtime.options.delivery.start = async () => { deliveryStarts += 1; };
  return { runtime, counts: () => ({ stopCalls, mintCalls, deliveryStarts }) };
}

test("convergence never mints a session for a bearer that is bound and not due for rotation", async () => {
  // Whatever woke it: the room may have ended the session on purpose, and
  // nothing here is allowed to mint the agent back in.
  const refused = boundTypedLaneHarness({ ...returnedHandle, observedState: "idle" });
  refused.runtime.options.delivery.roomRefusesAccess = () => true;
  await refused.runtime.coordinator.converge("agent-1");
  assert.deepEqual(refused.counts(), { stopCalls: 0, mintCalls: 0, deliveryStarts: 1 });

  // Handed off by the heartbeat because the runtime ended: fenced, not minted.
  const ended = boundTypedLaneHarness({ ...returnedHandle, observedState: "failed" });
  await ended.runtime.coordinator.converge("agent-1");
  assert.deepEqual(ended.counts(), { stopCalls: 1, mintCalls: 0, deliveryStarts: 0 });
});

test("while the room refuses the agent's bearer, a handle that ended without its entry ending is neither replaced nor minted for", async () => {
  // What the daemon sees after a room admin disconnects the agent: its bearer
  // is refused while its grant could still mint. The runtime then ends without
  // a fact reaching its entry, which is the case this change newly recovers.
  let roomRefuses = true;
  const ended = boundTypedLaneHarness({ ...returnedHandle, observedState: "failed" });
  ended.runtime.options.delivery.roomRefusesAccess = () => roomRefuses;
  for (let pass = 0; pass < 3; pass += 1) await ended.runtime.coordinator.converge("agent-1");
  assert.deepEqual(ended.counts(), { stopCalls: 0, mintCalls: 0, deliveryStarts: 0 },
    "the ended runtime is left as it is: replacing it would mint the agent back into the room");
  assert.equal(ended.runtime.liveHandles.size, 1);

  // The room accepts the agent again (a bearer rotated on schedule, or the
  // owner restarted it): the ended runtime is retired as usual.
  roomRefuses = false;
  await ended.runtime.coordinator.converge("agent-1");
  assert.deepEqual(ended.counts(), { stopCalls: 1, mintCalls: 0, deliveryStarts: 0 });

  // An entry that itself ended was retired before this change, refused or
  // not. That is not this change's to alter.
  const entryEnded = boundTypedLaneHarness({ ...returnedHandle, observedState: "failed" });
  entryEnded.runtime.setEntry({ ...entryEnded.runtime.entry(), observed_state: "failed" });
  entryEnded.runtime.options.delivery.roomRefusesAccess = () => true;
  await entryEnded.runtime.coordinator.converge("agent-1");
  assert.deepEqual(entryEnded.counts(), { stopCalls: 1, mintCalls: 0, deliveryStarts: 0 });

  // So was the ended handle of a lane born before typed lifecycle.
  const bornEarlier = boundTypedLaneHarness({ ...returnedHandle, observedState: "failed" }, "typed_shadow");
  bornEarlier.runtime.options.delivery.roomRefusesAccess = () => true;
  await bornEarlier.runtime.coordinator.converge("agent-1");
  assert.deepEqual(bornEarlier.counts(), { stopCalls: 1, mintCalls: 0, deliveryStarts: 0 });
});

test("a runtime that ended while its room refused the agent is replaced in the one pass the end of the refusal asks for", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-refusal-ends-"));
  const inbox = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const live = { ...returnedHandle, observedState: "idle" } as ProviderActionHandle & { observedState: ProviderActionHandle["observedState"] };
  const lane = boundTypedLaneHarness(live);
  let roomAccepts = false;
  let polls = 0;
  /** Each wake is one convergence pass, as the daemon wires it. */
  const passes: Array<Promise<void>> = [];
  const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const delivery = new SupervisedAgentDelivery(inbox, provider(), {
    poll: async ({ signal }) => {
      polls += 1;
      if (!roomAccepts) throw new SupervisedRoomAuthorizationError("Supervised room poll failed with HTTP 401.", 401);
      await pause(5, signal);
      return {};
    },
    publish: async () => { throw new Error("not used"); },
  }, async () => true, 10, undefined, (_delayMs, signal) => pause(2, signal),
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  (agentId) => { passes.push(lane.runtime.coordinator.converge(agentId)); });
  lane.runtime.options.delivery.roomRefusesAccess = (entryId) => delivery.roomRefusesAccess(entryId);
  const until = async (check: () => boolean, label: string) => {
    for (let waited = 0; !check(); waited += 5) {
      assert.ok(waited < 3_000, label);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await inbox.bootstrapCursor({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "0" });
    await delivery.start({
      agentId: "agent-1", roomId: "room-1", provider: "codex", deliveryMode: "daemon_inbox", apiUrl: "https://letagents.test",
      agentSessionId: "session-1", bearer: "bearer-secret", executionGenerationId: "generation-1", daemonGeneration: 7, handle: live,
      workAttemptId: "attempt-1", providerContinuationId: "continuation-1", providerConnection: live.providerConnection ?? null,
    });
    await until(() => delivery.roomRefusesAccess("agent-1"), "the room refuses the agent");

    // The runtime ends while the refusal stands. A heartbeat hand-off finds it held.
    live.observedState = "failed";
    await lane.runtime.coordinator.converge("agent-1");
    assert.deepEqual(lane.counts(), { stopCalls: 0, mintCalls: 0, deliveryStarts: 0 });
    assert.equal(passes.length, 0, "the refusal itself asked for nothing");

    // The room accepts a poll again.
    roomAccepts = true;
    await until(() => passes.length > 0, "the end of the refusal wakes convergence");
    await Promise.all(passes);
    assert.deepEqual(lane.counts(), { stopCalls: 1, mintCalls: 0, deliveryStarts: 0 },
      "that one pass retires the ended runtime; it does not wait for a later heartbeat");
    const accepted = polls;
    await until(() => polls >= accepted + 5, "the room keeps accepting polls");
    assert.equal(passes.length, 1, "exactly one wake: the accepted polls that follow ask for nothing");
  } finally {
    await delivery.fenceAndDrain().catch(() => undefined);
    await inbox.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** An inbox head: by default a message with a turn started and no result saved. */
const inboxHead = (state: string, turn: { provider_turn_id: string | null; outcome: string | null } = { provider_turn_id: "turn-1", outcome: null }) =>
  (async () => ({ state, source_message_id: "1", ...turn })) as unknown as ProviderExecutionCoordinatorOptions["inbox"]["head"];

test("an ended runtime is retired only once its in-flight message is recorded, or its bounded wait has run out", async () => {
  // A typed lane whose entry no fact told (`working`), one whose entry a fact
  // did tell (`failed`), and a lane born before typed lifecycle, which takes
  // its state from the handle. In each a stop now would land before the
  // provider's result for the turn is saved.
  for (const [authorityMode, entryState] of [["typed", "working"], ["typed", "failed"], ["typed_shadow", "working"]] as const) {
    for (const ending of ["the turn is recorded", "the result never comes"] as const) {
      const label = `${authorityMode} lane, ${entryState} entry, ${ending}`;
      let nowMs = 10_000_000;
      let stopCalls = 0;
      let head = inboxHead("awaiting_result");
      const delays: number[] = [];
      const runtime = typedLaneHarness({
        handle: { ...returnedHandle, observedState: "failed" },
        port: { stop: async current => { stopCalls += 1; return terminal(current); } },
        authorityMode,
      });
      runtime.setEntry({ ...runtime.entry(), observed_state: entryState });
      const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
        nowMs: () => nowMs,
        inbox: { ...runtime.options.inbox, head: (entryId) => head(entryId) },
        setTimeout: ((_callback: () => void, delay: number) => { delays.push(delay); return { unref() {} }; }) as unknown as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      });

      await coordinator.converge("agent-1");
      assert.equal(stopCalls, 0, `${label}: the runtime is left while its turn is not recorded`);
      assert.deepEqual(delays, [RETIREMENT_SETTLEMENT_WAIT_MS], `${label}: convergence comes back when the wait runs out`);

      // A pass inside the wait, as each heartbeat hand-off is, extends nothing.
      nowMs += RETIREMENT_SETTLEMENT_WAIT_MS - 1;
      await coordinator.converge("agent-1");
      assert.equal(stopCalls, 0, `${label}: still inside the one wait`);

      // Recorded: the failed message is settled and the next one is at the head.
      if (ending === "the turn is recorded") head = inboxHead("pending", { provider_turn_id: null, outcome: null });
      else nowMs += 1;
      await coordinator.converge("agent-1");
      assert.equal(stopCalls, 1, `${label}: the runtime is retired`);
    }
  }
});

test("only a message whose turn has no saved result holds an ended runtime", async () => {
  const started = { provider_turn_id: "turn-1", outcome: null };
  const untouched = { provider_turn_id: null, outcome: null };
  for (const [label, head, held] of [
    ["dispatching", inboxHead("dispatching", started), true],
    ["dispatching, its turn id not saved yet", inboxHead("dispatching", untouched), true],
    ["awaiting its result", inboxHead("awaiting_result", started), true],
    ["recovering its result", inboxHead("result_recovery", started), true],
    // A delivery lane torn down under its turn hands the started turn back.
    ["pending with a started turn", inboxHead("pending", started), true],
    ["pending, never started", inboxHead("pending", untouched), false],
    ["pending with its result saved", inboxHead("pending", { provider_turn_id: "turn-1", outcome: "reply" }), false],
    // Its result is saved; only the reply is still to be posted.
    ["publishing", inboxHead("publishing", { provider_turn_id: "turn-1", outcome: "reply" }), false],
    // Waiting for its owner, with nothing coming.
    ["blocked with a started turn", inboxHead("blocked", started), false],
    ["retryable", inboxHead("retryable", untouched), false],
    ["an empty inbox", (async () => null) as ProviderExecutionCoordinatorOptions["inbox"]["head"], false],
  ] as const) {
    let stopCalls = 0;
    const runtime = typedLaneHarness({
      handle: { ...returnedHandle, observedState: "failed" },
      port: { stop: async current => { stopCalls += 1; return terminal(current); } },
    });
    runtime.options.inbox.head = head;
    await runtime.coordinator.converge("agent-1");
    assert.equal(stopCalls, held ? 0 : 1, label);
  }
});

test("the wait for an ended runtime's turn belongs to that runtime, not to its agent", async () => {
  let nowMs = 10_000_000;
  let stopCalls = 0;
  const runtime = typedLaneHarness({
    handle: { ...returnedHandle, observedState: "failed" },
    port: { stop: async current => { stopCalls += 1; return terminal(current); } },
  });
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    nowMs: () => nowMs,
    inbox: { ...runtime.options.inbox, head: inboxHead("dispatching") },
    setTimeout: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });
  await coordinator.converge("agent-1");
  nowMs += RETIREMENT_SETTLEMENT_WAIT_MS;
  await coordinator.converge("agent-1");
  assert.equal(stopCalls, 1, "the first runtime's wait ran out");

  // Its replacement ends too, much later, again while holding a turn.
  runtime.liveHandles.set("agent-1", { ...returnedHandle, observedState: "failed" });
  nowMs += 10 * RETIREMENT_SETTLEMENT_WAIT_MS;
  await coordinator.converge("agent-1");
  assert.equal(stopCalls, 1, "it gets its own wait, not the one that already ran out");
  nowMs += RETIREMENT_SETTLEMENT_WAIT_MS;
  await coordinator.converge("agent-1");
  assert.equal(stopCalls, 2, "and is retired when that one runs out");
});

test("a typed lane keeps a live handle that works, and Cursor's ended handle stays with its exit path", async () => {
  for (const candidate of [
    { name: "working Codex", provider: "codex" as const, handle: { ...returnedHandle, observedState: "working" as const } },
    { name: "idle Codex", provider: "codex" as const, handle: { ...returnedHandle, observedState: "idle" as const } },
    { name: "stopping Codex", provider: "codex" as const, handle: { ...returnedHandle, observedState: "stopping" as const } },
    { name: "failed Cursor", provider: "cursor" as const, handle: {
      ...returnedHandle, observedState: "failed" as const,
      providerConnection: { kind: "cursor_cli" as const, pid: 4242, processIdentity: "birth-4242" },
    } },
  ]) {
    let stopCalls = 0;
    let deliveryStarts = 0;
    const runtime = typedLaneHarness({
      handle: candidate.handle,
      provider: candidate.provider,
      port: { stop: async current => { stopCalls += 1; return terminal(current); } },
    });
    runtime.options.delivery.start = async () => { deliveryStarts += 1; };

    await runtime.coordinator.converge("agent-1");

    assert.equal(stopCalls, 0, candidate.name);
    assert.equal(deliveryStarts, 1, candidate.name);
  }
});

// Coordinator rules only: this harness has no execution capture. With real
// capture a replacement can stop earlier, visibly blocked on its readiness
// evidence. A provider that merely refuses a turn never comes here at all;
// its runtime does not end.
test("a typed runtime that keeps ending is replaced once per ending, after its backoff, until the crash-loop limit", async () => {
  let nowMs = 10_000_000;
  let stopCalls = 0;
  let launches = 0;
  const birth = (n: number): ProviderActionHandle => ({
    ...returnedHandle, pid: 5000 + n, observedState: "idle",
    providerConnection: { kind: "codex_app_server", url: `http://127.0.0.1:${5000 + n}`, pid: 5000 + n, processIdentity: `birth-${5000 + n}` },
  });
  const launch = async () => { launches += 1; return birth(launches); };
  const runtime = typedLaneHarness({
    handle: birth(0),
    port: {
      capabilities: async () => ({ deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
        transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      attach: async () => null,
      stop: async current => { stopCalls += 1; return terminal(current); },
      resume: launch,
      spawn: launch,
    },
  });
  runtime.options.nowMs = () => nowMs;
  runtime.setEntry({ ...runtime.entry(), observed_state: "idle" });

  // Each round is one ended runtime: its handle reports failed with no fact
  // reaching the entry, convergence fences it, and its exit is observed as a
  // failed edge the same way the terminal coordinator records one.
  for (let ending = 1; ending <= 5; ending += 1) {
    const live = runtime.liveHandles.get("agent-1")!;
    (live as { observedState: ProviderActionHandle["observedState"] }).observedState = "failed";
    await runtime.coordinator.converge("agent-1");
    assert.equal(stopCalls, ending, "each failed runtime is stopped exactly once");
    runtime.liveHandles.delete("agent-1");
    for (const generation of runtime.executionGenerations) {
      generation.terminal ??= runtime.options.terminalPayload(terminal(live), "test");
    }
    runtime.setEntry({ ...runtime.entry(), observed_state: "failed",
      reconciliation: advanceReconciliationState(runtime.entry().reconciliation, "failed", nowMs) });

    await runtime.coordinator.converge("agent-1");
    assert.equal(launches, ending - 1, "no replacement starts before the restart backoff elapses");

    nowMs += 10_000;
    await runtime.coordinator.converge("agent-1");
    if (ending < 5) {
      assert.equal(launches, ending, "one replacement per failed runtime");
      assert.equal(runtime.liveHandles.get("agent-1")?.pid, 5000 + ending);
      runtime.setEntry({ ...runtime.entry(), observed_state: "idle",
        reconciliation: advanceReconciliationState(runtime.entry().reconciliation, "idle", nowMs) });
    }
  }

  assert.equal(launches, 4, "the fifth failure inside the window starts nothing");
  assert.equal(runtime.liveHandles.size, 0);
  assert.equal(runtime.entry().observed_state, "failed");
  assert.equal(runtime.entry().condition, "quarantined", "the owner sees a failed, quarantined agent");
  nowMs += 60_000;
  await runtime.coordinator.converge("agent-1");
  assert.equal(launches, 4, "a quarantined agent is not restarted again");
  assert.equal(stopCalls, 5);
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

test("a crashed Cursor lane whose failed turn already settled resumes its conversation without manual recovery", async () => {
  const runtime = ownedRecoveryHarness();
  const crash = { ...terminal(returnedHandle), exitCode: 143, terminalCause: "crashed" as const };
  runtime.executionGenerations[0]!.terminal = runtime.options.terminalPayload(crash, "test");
  const idle = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
  runtime.setEntry({
    ...runtime.entry(), provider: "cursor", observed_state: "failed", condition: "none",
    provider_ref: { ...runtime.entry().provider_ref!, provider_connection: idle },
  });
  // Delivery recorded the crashed turn as interrupted, so no blocked head remains.
  runtime.options.inbox.head = async () => null;
  runtime.options.host.requiresGrant = () => false;
  const capabilities = runtime.options.provider.capabilities;
  runtime.options.provider.capabilities = async (...args) => ({ ...await capabilities(...args), resume: true });
  const resumed: Array<string | null> = [];
  runtime.options.provider.resume = async (ref) => {
    resumed.push(ref.providerContinuationId);
    return { ...returnedHandle, pid: null, observedState: "idle", providerConnection: idle };
  };
  runtime.options.provider.spawn = async () => { throw new Error("a settled crash keeps its conversation"); };

  await runtime.coordinator.converge("agent-1");

  assert.deepEqual(resumed, ["continuation-1"], "the lane restarts on the same Cursor conversation");
  assert.equal(runtime.installed.length, 1);
  assert.equal(runtime.executionGenerations.length, 2);
  assert.notEqual(runtime.entry().condition, "coordination_blocked");
});

test("a Cursor lane that ended on a protocol error after its turn settled as lost resumes its conversation without manual recovery", async () => {
  const runtime = ownedRecoveryHarness();
  // An unproven-authority ending retires the lane as a protocol error. The
  // delivery has already settled the lost turn, so no blocked head remains.
  const ended = { ...terminal(returnedHandle), exitCode: 1, terminalCause: "protocol_error" as const };
  runtime.executionGenerations[0]!.terminal = runtime.options.terminalPayload(ended, "test");
  const idle = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
  runtime.setEntry({
    ...runtime.entry(), provider: "cursor", observed_state: "failed", condition: "none",
    provider_ref: { ...runtime.entry().provider_ref!, provider_connection: idle },
  });
  runtime.options.inbox.head = async () => null;
  runtime.options.host.requiresGrant = () => false;
  const capabilities = runtime.options.provider.capabilities;
  runtime.options.provider.capabilities = async (...args) => ({ ...await capabilities(...args), resume: true });
  const resumed: Array<string | null> = [];
  runtime.options.provider.resume = async (ref) => {
    resumed.push(ref.providerContinuationId);
    return { ...returnedHandle, pid: null, observedState: "idle", providerConnection: idle };
  };
  runtime.options.provider.spawn = async () => { throw new Error("a settled protocol ending keeps its conversation"); };

  await runtime.coordinator.converge("agent-1");

  assert.deepEqual(resumed, ["continuation-1"], "the lane restarts on the same Cursor conversation");
  assert.equal(runtime.installed.length, 1);
  assert.notEqual(runtime.entry().condition, "coordination_blocked");
});

test("a Cursor lane that keeps ending on protocol errors stops restarting at the crash-loop limit", async () => {
  const runtime = ownedRecoveryHarness();
  const nowMs = 20_000_000;
  runtime.options.nowMs = () => nowMs;
  const ended = { ...terminal(returnedHandle), exitCode: 1, terminalCause: "protocol_error" as const };
  runtime.executionGenerations[0]!.terminal = runtime.options.terminalPayload(ended, "test");
  const idle = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
  let reconciliation = runtime.entry().reconciliation;
  for (let ending = 0; ending < 5; ending += 1) {
    reconciliation = advanceReconciliationState(advanceReconciliationState(reconciliation, "idle", nowMs - 60_000 + ending), "failed", nowMs - 60_000 + ending);
  }
  runtime.setEntry({
    ...runtime.entry(), provider: "cursor", observed_state: "failed", condition: "none", reconciliation,
    provider_ref: { ...runtime.entry().provider_ref!, provider_connection: idle },
  });
  runtime.options.inbox.head = async () => null;
  runtime.options.host.requiresGrant = () => false;
  let launches = 0;
  runtime.options.provider.resume = async () => { launches++; return returnedHandle; };
  runtime.options.provider.spawn = async () => { launches++; return returnedHandle; };

  await runtime.coordinator.converge("agent-1");

  assert.equal(launches, 0, "five failed lanes inside the window start nothing more");
  assert.equal(runtime.entry().condition, "quarantined", "the owner sees a quarantined agent, not an endless restart loop");
});

test("a live generation without an attachable handle re-checks with capped backoff and one durable write", async () => {
  const runtime = ownedRecoveryHarness();
  let attaches = 0;
  runtime.options.provider.attach = async () => { attaches++; return null; };
  let launches = 0;
  runtime.options.provider.resume = async () => { launches++; return returnedHandle; };
  runtime.options.provider.spawn = async () => { launches++; return returnedHandle; };
  const transition = runtime.options.transition;
  let transitions = 0;
  runtime.options.transition = async (...args) => { transitions++; return transition(...args); };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    setTimeout: ((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return { unref() {} };
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });

  await coordinator.converge("agent-1");
  for (let fired = 0; fired < 6; fired++) {
    timers.at(-1)!.callback();
    await coordinator.drainConvergence();
  }

  assert.equal(runtime.entry().condition, "coordination_blocked");
  assert.equal(runtime.entry().last_error, "durable execution generation remains live without an attachable provider handle");
  assert.equal(launches, 0, "an unproven old runtime never gets a competing successor");
  assert.equal(attaches, 7, "each timer really re-runs attach");
  assert.deepEqual(timers.map(timer => timer.delay), [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
  assert.equal(transitions, 1, "repeated checks of an unchanged state do not rewrite the manifest");
});

for (const desired of ["running", "paused"] as const) test(`while a ${desired} entry's exit is being settled, a pass neither attaches its exited runtime nor starts or stops anything`, async () => {
  const runtime = ownedRecoveryHarness();
  runtime.setEntry({ ...runtime.entry(), desired_state: desired, observed_state: "idle", condition: "none", last_error: null });
  const calls: string[] = [];
  runtime.options.provider.attach = async () => { calls.push("attach"); return returnedHandle; };
  runtime.options.provider.resume = async () => { calls.push("resume"); return returnedHandle; };
  runtime.options.provider.spawn = async () => { calls.push("spawn"); return returnedHandle; };
  runtime.options.provider.stop = async (current) => { calls.push("stop"); return terminal(current); };
  const transition = runtime.options.transition;
  runtime.options.transition = async (...args) => { calls.push(`transition:${args[1]}`); return transition(...args); };
  let settling = true;
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options, exitSettling: () => settling });

  // The exit let go of the runtime; its generation has no terminal yet.
  await coordinator.converge("agent-1");
  assert.equal(await coordinator.attachLiveProvider(runtime.entry()), null, "nor does any other caller get the exited runtime");
  assert.deepEqual(calls, [], "the settlement owns the entry until the exit is recorded");
  assert.deepEqual(runtime.installed, []);
  assert.equal(runtime.entry().observed_state, "idle");

  // Once the exit is recorded the same pass acts as it always did.
  settling = false;
  await coordinator.converge("agent-1");
  assert.equal(calls[0], "attach");
});

test("a sooner recovery replaces a pending later one and never the reverse", async () => {
  const runtime = harness({});
  const scheduled: number[] = [];
  const cleared: number[] = [];
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    setTimeout: ((_callback: () => void, delay: number) => {
      scheduled.push(delay);
      return { unref() {}, delay };
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: { delay: number }) => { cleared.push(timer.delay); }) as unknown as typeof clearTimeout,
  });
  coordinator.scheduleRecovery("agent-1", 60_000);
  coordinator.scheduleRecovery("agent-1", 5_000);
  coordinator.scheduleRecovery("agent-1", 60_000);
  assert.deepEqual(scheduled, [60_000, 5_000]);
  assert.deepEqual(cleared, [60_000]);
});

test("resume after a crashed generation names the frozen lifecycle authority of the saved birth", async () => {
  const resumed: Array<{ ref?: string; request?: string }> = [];
  const runtime = harness({
    entry: {
      ...baseEntry(), provider: "open-model", delivery_mode: "daemon_inbox", observed_state: "failed",
      provider_ref: {
        work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
        provider_continuation_id: "continuation-1", provider_connection: openModelHandle.providerConnection,
      },
    },
    frozenAuthorityMode: "typed",
    provider: provider({
      capabilities: async () => ({
        deliveryModes: ["daemon_inbox"], resume: true, midTurnInjection: false,
        transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true,
      }),
      attach: async () => null,
      resume: async (ref, request) => {
        resumed.push({ ref: ref.lifecycleAuthorityMode, request: request.lifecycleAuthorityMode });
        return openModelHandle;
      },
    }),
  });
  runtime.executionGenerations.push({
    execution_generation_id: "generation-1", work_attempt_id: "attempt-1",
    started_at: "2026-08-26T00:00:00.000Z", actor: "test", generation: 1,
    terminal: runtime.options.terminalPayload({ ...terminal(openModelHandle), exitCode: 1, terminalCause: "crashed" }, "test"),
  });

  await runtime.coordinator.converge("agent-1");

  assert.deepEqual(resumed, [{ ref: "typed", request: "typed" }],
    "a daemon-inbox resume carries the typed birth instead of defaulting to typed_shadow");
});

test("a successful grant-bound resume resets scheduler retry budgets", async () => {
  const runtime = ownedRecoveryHarness();
  const crash = { ...terminal(returnedHandle), exitCode: 1, terminalCause: "crashed" as const };
  for (const generation of runtime.executionGenerations) generation.terminal = runtime.options.terminalPayload(crash, "test");
  runtime.setEntry({ ...runtime.entry(), observed_state: "failed", condition: "none", last_error: null });
  runtime.options.provider.capabilities = async () => ({ deliveryModes: ["daemon_inbox"], resume: true,
    midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true });
  runtime.options.provider.attach = async () => null;
  let resumes = 0;
  runtime.options.provider.resume = async () => { resumes++; return returnedHandle; };
  let cleared = 0;
  runtime.options.host.clearSuccessfulRecovery = () => { cleared++; };
  const grant = runtime.options.host.currentGrant(runtime.entry())!;
  runtime.options.host.mintAuthorization = async () => ({ agentSessionId: "session-1", bearer: "test-only", bearerId: "bearer-1",
    expiresAt: grant.expiresAt, apiUrl: grant.apiUrl,
    authority: { entryId: "agent-1", roomId: "room-1", workAttemptId: "attempt-1", grant } });
  runtime.options.host.recordMintedSession = async (_entry, id, minted) => ({ ...minted, executionGenerationId: id });

  await runtime.coordinator.converge("agent-1");

  assert.equal(resumes, 1, "the saved continuation was resumed");
  assert.equal(cleared, 1, "a live handle on the grant path counts as a successful launch");
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

test("a recovery retry on an exact binding left by a failed bind confirms it instead of skipping it", async () => {
  for (const outcome of ["confirmed", "refused", "not awaiting"] as const) {
    const runtime = ownedRecoveryHarness();
    runtime.binding.execution_generation_id = "generation-2";
    runtime.setEntry({ ...runtime.entry(), observed_state: "recovering", condition: "coordination_blocked",
      last_error: "Restoring room access (attempt 1 of 3) failed: The operation was aborted due to timeout. Retrying automatically." });
    runtime.liveHandles.set("agent-1", { ...returnedHandle, observedState: "idle" });
    let confirmations = 0;
    const refusal = new Error("Native activity endpoint rejected the daemon bridge with HTTP 403.");
    runtime.options.host.awaitsBindingConfirmation = (entryId, executionGenerationId) =>
      outcome !== "not awaiting" && entryId === "agent-1" && executionGenerationId === "generation-2";
    let guard: (() => boolean) | null = null;
    runtime.options.host.confirmExactBinding = async (_entryId, mayPublish) => {
      confirmations += 1;
      guard = mayPublish;
      if (outcome === "refused") throw refusal;
      runtime.setEntry({ ...runtime.entry(), observed_state: "idle", condition: "none", last_error: null });
    };

    await runtime.coordinator.converge("agent-1");

    assert.equal(runtime.mintCalls, 0, outcome);
    assert.equal(runtime.bindCalls, 0, outcome);
    assert.equal(confirmations, outcome === "not awaiting" ? 0 : 1, outcome);
    if (outcome === "confirmed") {
      assert.equal(runtime.entry().observed_state, "idle");
      assert.equal(runtime.entry().condition, "none");
      assert.deepEqual(runtime.failures, []);
      assert.equal(runtime.deliveryStarts, 1);
      assert.equal(guard!(), true);
      runtime.bumpControlEpoch();
      assert.equal(guard!(), false, "a Stop during the retry withdraws its permission to publish");
    } else if (outcome === "refused") {
      assert.deepEqual(runtime.failures, [refusal], "a refused confirmation counts against the retry budget");
      assert.equal(runtime.deliveryStarts, 0);
    } else {
      assert.equal(runtime.entry().condition, "coordination_blocked", "only a failed bind is confirmed");
    }
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

test("room-only workspace retries back off, cap at five minutes, and start over after success or Stop", async () => {
  const runtime = harness({
    entry: { ...baseEntry(), source_repo_path: null },
    workspaceIdentity: scratchWorkspaceIdentity,
    // The provider never comes up, so every convergence tries a fresh launch.
    provider: provider({ spawn: async () => { throw new Error("provider bootstrap failed"); } }),
  });
  let failing = true;
  runtime.options.workspace.ephemeral.ensureRepository = async () => {
    if (failing) throw new Error("EACCES");
    return "present";
  };
  const delays: number[] = [];
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    setTimeout: ((_callback: () => void, delay: number) => { delays.push(delay); return { unref() {} }; }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });
  const attempt = async () => {
    coordinator.clearRecovery("agent-1");
    await coordinator.converge("agent-1").catch(() => {});
  };

  for (let index = 0; index < 9; index++) await attempt();
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.match(runtime.entry().last_error ?? "", /Retrying in 300 seconds\.$/);

  // A success starts the count over.
  failing = false;
  await attempt();
  failing = true;
  delays.length = 0;
  await attempt();
  assert.deepEqual(delays, [5_000]);

  // So does Stop.
  await attempt();
  assert.deepEqual(delays, [5_000, 10_000]);
  runtime.setEntry({ ...runtime.entry(), desired_state: "stopped" });
  await coordinator.converge("agent-1");
  runtime.setEntry({ ...runtime.entry(), desired_state: "running" });
  delays.length = 0;
  await attempt();
  assert.deepEqual(delays, [5_000]);
});

test("a provider's launch notices are recorded in the agent's activity", async () => {
  const runtime = harness({
    entry: { ...baseEntry(), provider: "open-model", delivery_mode: "daemon_inbox", source_repo_path: null },
    workspaceIdentity: scratchWorkspaceIdentity,
    provider: provider({ spawn: async () => ({ ...openModelHandle, launchNotices: ["Plugin boundary not in effect: no git on the launch's PATH."] }) }),
  });
  await runtime.coordinator.converge("agent-1");
  const notices = (runtime.entry().activity ?? []).filter((event) => event.kind === "launch_notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.summary, "Plugin boundary not in effect: no git on the launch's PATH.");
  assert.equal(notices[0]!.method, "workspace_boundary");
});

test("an agent whose record stops under a running runtime, or was carried past a gap at its start, says so once in its activity", async () => {
  const stopped = "LetAgents stopped recording this agent's activity: part of the record could not be kept. The agent keeps working, and its messages are not affected.";
  const continued = "Part of this agent's activity record is missing; LetAgents continued with a new record.";
  let installed: ProviderInstallationToken | undefined;
  let archived: string[] = ["runtime-with-a-gap"];
  const runtime = harness({
    entry: { ...baseEntry(), provider: "open-model", delivery_mode: "daemon_inbox", source_repo_path: null },
    workspaceIdentity: scratchWorkspaceIdentity,
    provider: provider({ spawn: async () => openModelHandle }),
    currentInstallation: () => installed,
  });
  const fences: unknown[] = [];
  runtime.options.store.archiveExitedRuntimes = async (_agentId, commitFence) => { fences.push(commitFence); const now = archived; archived = []; return now; };
  const notices = () => (runtime.entry().activity ?? []).filter((event) => event.kind === "launch_notice").map((event) => event.summary);
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  runtime.coordinator.noteRecordStopped("agent-1");
  await settled();
  assert.deepEqual(notices(), [], "a record that stopped for a runtime that is gone is its replacement's to report");

  // The daemon starts the agent: what its ended runtimes left unfinished is archived first, under the daemon's own fence.
  await runtime.coordinator.converge("agent-1");
  assert.deepEqual(fences, [runtime.options.authority.fenceCommit]);
  assert.deepEqual(notices(), [continued]);

  installed = { entryId: "agent-1" } as ProviderInstallationToken;
  for (let report = 0; report < 3; report += 1) runtime.coordinator.noteRecordStopped("agent-1");
  await settled();
  assert.deepEqual(notices(), [continued, stopped], "however often the record reports it");
  assert.equal(runtime.entry().observed_state === "failed" || runtime.entry().condition !== "none", false, "and nothing is asked of the owner");
});

test("a start goes ahead when the agent's ended runtimes cannot be archived, and says nothing when there was nothing to archive", async () => {
  for (const archive of [async () => { throw new Error("the journal is busy"); }, async () => [] as string[]]) {
    const runtime = harness({
      entry: { ...baseEntry(), provider: "open-model", delivery_mode: "daemon_inbox", source_repo_path: null },
      workspaceIdentity: scratchWorkspaceIdentity,
      provider: provider({ spawn: async () => openModelHandle }),
    });
    runtime.options.store.archiveExitedRuntimes = archive;
    await runtime.coordinator.converge("agent-1");
    assert.equal(runtime.installed.length, 1, "the agent is started");
    assert.deepEqual((runtime.entry().activity ?? []).filter((event) => event.kind === "launch_notice"), []);
  }
});

test("a launch carries the owner's own setup only for the owner's own agent, and never the stored key", async () => {
  const stored = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, letagentsOwnerIsolation: false, letagentsOwnerIsolationChangedAt4: false };
  const launch = async (entry: DaemonManifestEntry) => {
    let request: ProviderActionSpawn | null = null;
    // A process started with its owner's setup says so on its handle, as every provider's does.
    const runtime = harness({ entry, provider: provider({ spawn: async (input) => {
      request = input;
      return input.homeHarness ? { ...returnedHandle, ownerSetup: true as const } : returnedHandle;
    } }) });
    await runtime.coordinator.converge(entry.id);
    return request as ProviderActionSpawn | null;
  };

  // An agent the daemon delivers room messages to: the only kind that may have the owner's setup.
  const delivered = (): DaemonManifestEntry => ({ ...baseEntry(), delivery_mode: "daemon_inbox" });
  const off = await launch(delivered());
  assert.ok(off);
  assert.equal(Object.hasOwn(off, "homeHarness"), false, "an agent without it launches exactly as before");

  const on = await launch({ ...delivered(), provider_launch_policy: stored });
  assert.equal(on?.homeHarness, true);
  assert.deepEqual(on?.launchPolicy, off.launchPolicy, "the provider's own policy never carries LetAgents' keys");

  // An agent that collects its own room messages launches without it, whatever is stored: turning it off could not be enforced.
  for (const deliveryMode of [undefined, "mcp_polling"] as const) {
    const polling = await launch({ ...baseEntry(), ...(deliveryMode ? { delivery_mode: deliveryMode } : {}), provider_launch_policy: stored });
    assert.ok(polling, "it still launches");
    assert.equal(Object.hasOwn(polling, "homeHarness"), false, String(deliveryMode));
    assert.deepEqual(polling.launchPolicy, (await launch(baseEntry()))!.launchPolicy);
  }

  // Only the exact stored form counts.
  const unclear = await launch({ ...delivered(), provider_launch_policy: { ...stored, letagentsOwnerIsolation: true } });
  assert.equal(Object.hasOwn(unclear!, "homeHarness"), false);
  assert.deepEqual(unclear?.launchPolicy, off.launchPolicy);

  // A rental is Cursor in a workspace-rooted profile. Whatever is stored, it launches without the owner's setup.
  const rental = await launch({
    ...baseEntry(), id: "supervised_rental_0123", provider: "cursor", permission_profile_id: "sandboxed_write",
    provider_launch_policy: { force: true, sandbox: "enabled", letagentsOwnerIsolation: false },
  });
  assert.ok(rental, "the rental still launches");
  assert.equal(Object.hasOwn(rental, "homeHarness"), false);
  assert.deepEqual(rental.launchPolicy, { force: true, sandbox: "enabled" });
});

const OWNER_SETUP_NATIVE = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };

test("a launch is refused unless its handle says whether the process was started with the owner's setup", async () => {
  const launched = async (policy: Record<string, unknown>, handle: ProviderActionHandle) => {
    const runtime = harness({ entry: { ...baseEntry(), delivery_mode: "daemon_inbox", provider_launch_policy: policy },
      provider: provider({ spawn: async () => handle }) });
    return runtime.coordinator.converge("agent-1").then(() => runtime, (error: Error) => error);
  };
  const on = { ...OWNER_SETUP_NATIVE, letagentsOwnerIsolation: false, letagentsOwnerIsolationChangedAt1: false };
  const refused = /Provider launch did not attest the complete configuration snapshot/;
  // What ends the setup when its owner turns it off is the handle. A launch that hides it is not accepted.
  assert.match(String(await launched(on, returnedHandle)), refused);
  // Nor one that claims the setup for an agent that was started without it.
  assert.match(String(await launched(OWNER_SETUP_NATIVE, { ...returnedHandle, ownerSetup: true })), refused);
  for (const [policy, handle] of [[on, { ...returnedHandle, ownerSetup: true as const }], [OWNER_SETUP_NATIVE, returnedHandle]] as const) {
    const runtime = await launched(policy, handle);
    assert.ok(!(runtime instanceof Error), String(runtime));
    assert.equal(runtime.installed.length, 1);
  }
});

test("a reference to an agent's process says it was started with the owner's setup only when the daemon's own records do", async () => {
  const attachedWith = async (entry: DaemonManifestEntry) => {
    const current: DaemonManifestEntry = { ...entry, provider_ref: { work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
      provider_continuation_id: "continuation-1", provider_connection: returnedHandle.providerConnection } };
    let seen: ProviderActionRef | null = null;
    const runtime = harness({ entry: current, provider: provider({ attach: async (ref) => { seen = ref; return null; } }) });
    runtime.executionGenerations.push({ execution_generation_id: "generation-1", work_attempt_id: "attempt-1",
      started_at: "2026-08-26T00:00:00.000Z", actor: "daemon-provider", generation: 1, terminal: null });
    await runtime.coordinator.attachLiveProvider(current);
    assert.ok(seen, "the provider was asked to attach");
    // The same record goes on every reference the coordinator builds, a stop's included,
    // and on the one a runtime recovery attaches with.
    assert.equal(runtime.coordinator.providerRef(current).ownerSetup, (seen as ProviderActionRef).ownerSetup);
    assert.equal(recoveryProviderRef(current).ownerSetup, (seen as ProviderActionRef).ownerSetup);
    assert.deepEqual(Object.keys(recoveryProviderRef(current)).sort(),
      ["provider", "providerConnection", "providerContinuationId", "workAttemptId", ...((seen as ProviderActionRef).ownerSetup ? ["ownerSetup"] : [])].sort());
    return seen as ProviderActionRef;
  };
  // The process last started at revision 4.
  const delivered = (policy: unknown, overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry =>
    ({ ...baseEntry(), delivery_mode: "daemon_inbox", runtime_configuration_revision: 4, provider_launch_policy: policy, ...overrides });
  const on = { letagentsOwnerIsolation: false };
  const changed = (...revisions: number[]) => Object.fromEntries(revisions.map((revision) => [`letagentsOwnerIsolationChangedAt${revision}`, false]));

  // An agent that never had the setup: its reference is the one every agent had before, with no such key.
  const never = await attachedWith(delivered(OWNER_SETUP_NATIVE));
  assert.equal(Object.hasOwn(never, "ownerSetup"), false);
  assert.deepEqual(Object.keys(never).sort(), ["launchPolicy", "lifecycleAuthorityMode", "provider", "providerConnection", "providerContinuationId", "workAttemptId"]);

  // Started with it and still on, or turned off since and not restarted yet: the process has it.
  for (const [name, policy] of [
    ["on since before it started", { ...OWNER_SETUP_NATIVE, ...on, ...changed(4) }],
    ["on, with no record of the change left", { ...OWNER_SETUP_NATIVE, ...on }],
    ["turned off after it started", { ...OWNER_SETUP_NATIVE, ...changed(5) }],
    ["off and on again after it started", { ...OWNER_SETUP_NATIVE, ...on, ...changed(5, 6) }],
  ] as const) {
    const ref = await attachedWith(delivered(policy));
    assert.equal(ref.ownerSetup, true, name);
    assert.deepEqual({ ...ref, ownerSetup: undefined }, { ...never, ownerSetup: undefined }, `${name}: nothing else about the reference differs`);
  }

  // Not started with it, whatever is saved now.
  for (const [name, entry] of [
    ["turned on after it started", delivered({ ...OWNER_SETUP_NATIVE, ...on, ...changed(5) })],
    ["on and off again after it started", delivered({ ...OWNER_SETUP_NATIVE, ...changed(5, 6) })],
    ["turned off before it started", delivered({ ...OWNER_SETUP_NATIVE, ...changed(3) })],
    // A start whose revision was never recorded is older than every change.
    ["a start with no recorded revision", delivered({ ...OWNER_SETUP_NATIVE, ...on, ...changed(2) }, { runtime_configuration_revision: undefined })],
    // An agent that may not have the setup never has it, whatever is stored.
    ["an agent that collects its own messages", delivered({ ...OWNER_SETUP_NATIVE, ...on, ...changed(4) }, { delivery_mode: "mcp_polling" })],
    ["an agent with no delivery recorded", delivered({ ...OWNER_SETUP_NATIVE, ...on, ...changed(4) }, { delivery_mode: undefined })],
    ["a rented agent", delivered({ ...OWNER_SETUP_NATIVE, ...on, ...changed(4) }, { id: "supervised_rental_0123" })],
    // A stored value that is not the exact one is not read as on, here or at a launch.
    ["a true", delivered({ ...OWNER_SETUP_NATIVE, letagentsOwnerIsolation: true })],
    ["a string", delivered({ ...OWNER_SETUP_NATIVE, letagentsOwnerIsolation: "false" })],
    ["a null", delivered({ ...OWNER_SETUP_NATIVE, letagentsOwnerIsolation: null })],
    ["a zero", delivered({ ...OWNER_SETUP_NATIVE, letagentsOwnerIsolation: 0 })],
  ] as const) {
    assert.equal(Object.hasOwn(await attachedWith(entry), "ownerSetup"), false, name);
  }
});

test("a reference built from a stored policy that cannot be read says so, for a re-attach and for a recovery alike", () => {
  const runtime = harness();
  for (const unreadable of ["not a policy", ["not", "a", "policy"], 7]) {
    const current: DaemonManifestEntry = { ...baseEntry(), delivery_mode: "daemon_inbox", runtime_configuration_revision: 4, provider_launch_policy: unreadable,
      provider_ref: { work_attempt_id: "attempt-1", execution_generation_id: "generation-1", provider_continuation_id: "continuation-1",
        provider_connection: returnedHandle.providerConnection } };
    assert.equal(runtime.coordinator.providerRef(current).ownerSetup, "unknown", JSON.stringify(unreadable));
    assert.equal(recoveryProviderRef(current).ownerSetup, "unknown", JSON.stringify(unreadable));
  }
});

test("a pause stops the agent's process, and the agent is marked paused only once that process has ended or is proven gone", async () => {
  const paused = (attach: ProviderActionPort["attach"]) => {
    const current: DaemonManifestEntry = { ...baseEntry(), desired_state: "paused", observed_state: "idle", delivery_mode: "daemon_inbox",
      provider_ref: { work_attempt_id: "attempt-1", execution_generation_id: "generation-1", provider_continuation_id: "continuation-1",
        provider_connection: returnedHandle.providerConnection } };
    const stops: ProviderActionHandle[] = [];
    const runtime = harness({ entry: current, provider: provider({ attach, stop: async (handle) => { stops.push(handle); return terminal(handle); } }) });
    runtime.executionGenerations.push({ execution_generation_id: "generation-1", work_attempt_id: "attempt-1",
      started_at: "2026-08-26T00:00:00.000Z", actor: "daemon-provider", generation: 1, terminal: null });
    return { runtime, stops };
  };
  // The daemon holds no process, as after a restart. The process is still there: it is re-attached and stopped.
  // Its exit is what marks the agent paused, so until then it is only stopping.
  const alive = paused(async () => returnedHandle);
  await alive.runtime.coordinator.converge("agent-1");
  assert.equal(alive.stops.length, 1);
  assert.equal(alive.runtime.entry().observed_state, "stopping");
  // The provider proves the process gone: its end is recorded, and then the agent is paused.
  const gone = paused(async () => ({ state: "terminal", terminal: { endedAt: "2026-08-26T00:00:03.000Z", exitCode: null, signal: null,
    terminalCause: "crashed", providerContinuationId: "continuation-1" } }));
  await gone.runtime.coordinator.converge("agent-1");
  assert.equal(gone.runtime.entry().observed_state, "paused");
  assert.equal(gone.runtime.terminalWrites.length, 1);
  // The provider cannot tell: the agent is not marked paused at all.
  const unsure = paused(async () => { throw new Error("attach is ambiguous; the recorded process identity cannot be verified."); });
  await assert.rejects(unsure.runtime.coordinator.converge("agent-1"), /ambiguous/);
  assert.equal(unsure.runtime.entry().observed_state, "idle");
  // The one route with no proof: nothing the provider could attach to. The agent is marked paused with no
  // recorded end, which is why the roster asks for that record before it treats a paused agent's process as gone.
  const unattachable = paused(async () => null);
  await unattachable.runtime.coordinator.converge("agent-1");
  assert.equal(unattachable.runtime.entry().observed_state, "paused");
  assert.deepEqual([unattachable.stops.length, unattachable.runtime.terminalWrites.length], [0, 0]);
});

test("a stored choice that cannot be read starts the agent without the owner's setup, as its re-attach assumes", async () => {
  // The re-attach of such an agent is the plain one (see the test above). That is only right because
  // a launch from the same record gives the agent no setup either.
  for (const unreadable of [true, "false", null, 0, {}, []]) {
    let request: ProviderActionSpawn | null = null;
    const runtime = harness({
      entry: { ...baseEntry(), delivery_mode: "daemon_inbox", provider_launch_policy: { ...OWNER_SETUP_NATIVE, letagentsOwnerIsolation: unreadable } },
      provider: provider({ spawn: async (input) => { request = input; return returnedHandle; } }),
    });
    await runtime.coordinator.converge("agent-1");
    assert.ok(request, JSON.stringify(unreadable));
    assert.equal(Object.hasOwn(request, "homeHarness"), false, JSON.stringify(unreadable));
    assert.deepEqual((request as ProviderActionSpawn).launchPolicy, OWNER_SETUP_NATIVE, JSON.stringify(unreadable));
  }
});

test("while an agent is still to be replaced the scheduler converges again after the wait it is given, and tells the owner what it is told to", async () => {
  const runtime = harness({ entry: { ...baseEntry(), delivery_mode: "daemon_inbox" } });
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const answers: Array<void | { retryAfterMs: number; notice?: string }> = [
    { retryAfterMs: 1_000 },
    { retryAfterMs: 2_000, notice: "Still waiting to restart this agent so it stops running with your own setup." },
    undefined,
  ];
  let refreshes = 0;
  const failures: unknown[] = [];
  const coordinator = new ProviderExecutionCoordinator({ ...runtime.options,
    refreshManagedRuntime: async () => { refreshes += 1; return answers.shift(); },
    recordSchedulerFailure: async (_entryId, error) => { failures.push(error); },
    setTimeout: ((callback: () => void, delay: number) => { timers.push({ callback, delay }); return { unref() {} }; }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });
  const notices = () => (runtime.entry().activity ?? []).filter((event) => event.kind === "launch_notice").map((event) => event.summary);

  coordinator.request("agent-1");
  await coordinator.drainConvergence();
  assert.deepEqual(timers.map((timer) => timer.delay), [1_000], "one wake-up, after the wait it was given");
  assert.deepEqual(notices(), []);

  // Nothing else happens until that wake-up: it is what converges again.
  timers.shift()!.callback();
  await coordinator.drainConvergence();
  assert.equal(refreshes, 2);
  assert.deepEqual(timers.map((timer) => timer.delay), [2_000]);
  assert.deepEqual(notices(), ["Still waiting to restart this agent so it stops running with your own setup."]);

  // Replaced: no further wake-up is set.
  timers.shift()!.callback();
  await coordinator.drainConvergence();
  assert.equal(refreshes, 3);
  assert.deepEqual(timers, []);
  assert.deepEqual(failures, []);

  // A replacement that fails outright is the agent's error, recorded as every scheduler failure is.
  const failed = new Error("LetAgents could not restart this agent to stop it running with your own setup, so its messages are waiting.");
  const failing = new ProviderExecutionCoordinator({ ...runtime.options,
    refreshManagedRuntime: async () => { throw failed; },
    recordSchedulerFailure: async (_entryId, error) => { failures.push(error); },
    setTimeout: ((callback: () => void, delay: number) => { timers.push({ callback, delay }); return { unref() {} }; }) as unknown as typeof setTimeout,
  });
  failing.request("agent-1");
  await failing.drainConvergence();
  assert.deepEqual(failures, [failed]);
  assert.deepEqual(timers, [], "and it is not tried again behind the owner's back");
});
