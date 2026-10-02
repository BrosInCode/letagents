import { ManagedRuntimeRefreshDeferred } from "../provider-action-port.js";
import { providerRuntimeGoneFailure, schedulerErrorDetail } from "../daemon-error-policy.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { ProviderActionPort } from "../provider-action-port.js";

import { DaemonAuthority } from "../daemon-authority.js";
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
import type { DaemonManifestEntry, ExecutionTerminalPayload } from "../types.js";

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

const terminalAuthority: ProviderTerminalPorts["authority"] = {
  assertCurrent: async () => {},
  isClosing: () => false,
  fenceCommit: async commit => { await commit(); },
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
  isAdmissionPaused?: () => boolean;
  beforeProviderStop?: () => void;
  head?: () => Promise<{ state: string; provider_turn_id: string | null } | null>;
  afterDeliveryInstallation?: ProviderInstallationToken;
  configurationRevisionOnRead?: (read: number) => number;
  /** The installed process, when it is not the plain one: for instance one started with its owner's setup. */
  installed?: ProviderInstallationToken;
  /** The saved configuration cannot be read. */
  configurationUnreadable?: () => boolean;
  stopFailure?: () => Error | null;
} = {}) {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: input.isAdmissionPaused ?? (() => false) });
  const entry = manifestEntry();
  const configuration = {
    provider: "codex", model: null, reasoning_effort: null, charter: "Help",
    permission_profile_id: "supervised", provider_launch_policy: {},
    config_revision: 2, runtime_configuration_revision: 1, polling_contract: null, delivery_mode: "daemon_inbox",
  };
  const installed = input.installed ?? installation;
  let currentInstallation = installed;
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
        if (input.configurationUnreadable?.()) throw new Error("the saved configuration could not be read");
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
        assert.equal(stoppedHandle, installed.handle);
        assert.equal(deliveryReserved, true, "delivery remains fenced through native stop");
        input.beforeProviderStop?.();
        const failure = input.stopFailure?.();
        if (failure) throw failure;
        providerStops += 1;
        return terminal;
      },
    },
    streams: { currentInstallation: () => currentInstallation },
    terminals: {
      replaceConfiguration: async (exact, stop) => {
        assert.equal(exact, installed);
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
    configurationReads: () => configurationReads,
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
    authority: terminalAuthority,
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
    authority: terminalAuthority,
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

for (const ending of ["close", "superseded-result", "superseded-error"] as const) test(`configuration replacement cancels before terminal admission on ${ending}`, async () => {
  const liveHandles = new Map([["agent-1", handle]]);
  let current = true, resolve!: (terminal: ProviderActionTerminal) => void, reject!: (error: Error) => void;
  const stopping = new Promise<ProviderActionTerminal>((accept, decline) => { resolve = accept; reject = decline; });
  const coordinator = new ProviderTerminalCoordinator({
    authority: terminalAuthority, currentDaemonGeneration: () => 7, liveHandles,
    streams: { isLatestInstallation: () => current, remove: () => { throw new Error("obsolete terminal cannot revoke a handle"); } },
  } as unknown as ProviderTerminalPorts);
  const operation = coordinator.replaceConfiguration(installation, () => stopping).then(
    () => "resolved", error => String(error),
  );
  if (ending === "close") {
    coordinator.close();
    await assert.rejects(coordinator.replaceConfiguration(installation, async () => {
      throw new Error("closed coordinator must never invoke native stop");
    }), /Provider installation changed/);
  }
  else {
    current = false;
    liveHandles.set("agent-1", { ...handle, pid: 43 });
    if (ending === "superseded-result") resolve(terminal); else reject(new Error("native stop failed after supersession"));
  }
  const outcome = await Promise.race([operation, new Promise<string>(resolve => setImmediate(() => resolve("pending")))]);
  assert.match(outcome, ending === "close" ? /replacement closed/ : /lost its exact installation|stop failed after supersession/);
  assert.equal((coordinator as unknown as { plannedConfigurationReplacements: Map<unknown, unknown> }).plannedConfigurationReplacements.size, 0);
  resolve(terminal); // a late native result cannot re-admit work after cancellation
  await coordinator.handleTerminal(installation, terminal);
  assert.equal(liveHandles.get("agent-1")?.pid, ending === "close" ? 42 : 43);
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

for (const retry of ["callback", "automatic", "superseded", "closed", "generation-loss", "invalid-cleanup", "replacement", "quarantine"] as const) for (const failedStage of ["cleanup", "record", "record-committed", "approvals", "fence", "projection", "projection-committed"] as const) {
  if (retry === "invalid-cleanup" && failedStage !== "cleanup") continue;
  test(`terminal settlement resumes the exact retired installation after ${failedStage} fails via ${retry}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const liveHandles = new Map([["agent-1", handle]]);
    const entry = manifestEntry();
    if (failedStage === "fence") entry.desired_state = "stopped";
    let failed = false, generation = 7;
    if (retry === "quarantine") entry.condition = "quarantined";
    const failOnce = (stage: string) => {
      if (stage === failedStage && !failed) { failed = true; throw new Error(`injected ${stage} failure`); }
    };
    let saved: ReturnType<ProviderTerminalCoordinator["terminalPayload"]> | null = null;
    let records = 0, approvals = 0, projections = 0, convergence = 0, fenceReleases = 0;
    const ports: ProviderTerminalPorts = {
      authority: terminalAuthority,
      currentDaemonGeneration: () => generation,
      nowMs: () => Date.parse(terminal.endedAt),
      liveHandles,
      manifest: { getEntry: async () => entry, load: async () => ({ entries: [entry] }) },
      durability: {
        getAttempt: async () => ({ execution_generations: [{ execution_generation_id: "generation-1",
          actor: "daemon-provider", generation: 7, terminal: saved }] }) as never,
        recordTerminal: async (_attempt, _execution, payload) => {
          failOnce("record");
          assert.equal(saved, null, "a committed terminal must never be written again");
          saved = structuredClone(payload); records += 1;
          failOnce("record-committed");
          return {} as never;
        },
        releaseTerminalExecutionFence: async () => { failOnce("fence"); fenceReleases += 1; },
      },
      runtimeCustody: { deletePendingResumeBinding: () => {} },
      streams: {
        remove: exact => {
          if (exact !== installation || liveHandles.get("agent-1") !== handle) return false;
          liveHandles.delete("agent-1"); failOnce("cleanup"); return true;
        },
        isLatestInstallation: exact => exact === installation,
      },
      settleRuntimeApprovals: async () => { failOnce("approvals"); approvals += 1; },
      delivery: { start: async () => {} },
      serializeEntry: async (_id, operation) => operation(),
      serializeManifest: async operation => operation(),
      transitionOnce: async (_id, state, condition, _cause, _actor, reconciliation) => {
        failOnce("projection");
        entry.observed_state = state; entry.condition = condition; entry.reconciliation = reconciliation;
        projections += 1; failOnce("projection-committed");
      },
      requestConvergence: () => { convergence += 1; },
    };
    const coordinator = new ProviderTerminalCoordinator(ports);
    const observed = retry === "invalid-cleanup" ? { ...terminal,
      nativeRuntimeDeath: { kind: "codex_app_server" as const, pid: 42, processIdentity: "wrong-birth" } } : terminal;
    let replaced: Promise<void> | undefined;
    if (retry === "replacement") {
      replaced = coordinator.replaceConfiguration(installation, async () => {
        await assert.rejects(coordinator.handleTerminal(installation, observed), /injected .* failure/);
        throw new Error("stop failed after exact onExit");
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    } else await assert.rejects(coordinator.handleTerminal(installation, observed), /injected .* failure/);
    assert.equal(liveHandles.has("agent-1"), false, "failed persistence cannot restore dead publication authority");
    if (retry === "superseded" || retry === "closed" || retry === "generation-loss" || retry === "invalid-cleanup") {
      const before = [records, approvals, projections, convergence, fenceReleases];
      const successor = { ...handle, pid: 43, providerContinuationId: "successor" };
      if (retry === "superseded") liveHandles.set("agent-1", successor);
      else if (retry === "closed") coordinator.close();
      else if (retry === "generation-loss") generation = 8;
      t.mock.timers.tick(30_000);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual([records, approvals, projections, convergence, fenceReleases], before,
        "an obsolete retry cannot complete another owner's bookkeeping");
      if (retry === "superseded") assert.equal(liveHandles.get("agent-1"), successor);
      return;
    }
    if (retry === "callback") await coordinator.handleTerminal(installation, { ...terminal, terminalCause: "protocol_error" });
    else {
      t.mock.timers.tick(25);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (replaced) await replaced;
    assert.equal(records, 1, "the first exact terminal is eventually persisted once");
    assert.equal(saved!.terminal_cause, "stopped", "a repeated callback cannot replace the retained first terminal");
    assert.ok(approvals >= 1, "approval settlement eventually completes");
    assert.equal(projections, 1, "committed projection is recognized without duplicate notices");
    if (retry === "replacement") assert.equal(entry.observed_state, "recovering");
    assert.equal(entry.reconciliation?.last_terminal?.terminal_cause, "stopped");
    assert.equal(convergence, retry === "replacement" ? 0 : 1, "a successful terminal settlement requests one successor reconciliation");
    assert.equal(fenceReleases, failedStage === "fence" ? 1 : 0);
    await coordinator.handleTerminal(installation, terminal);
    assert.equal(records, 1); assert.equal(convergence, retry === "replacement" ? 0 : 1, "a completed obligation is not dispatched twice");
  });
}

for (const change of ["successor", "closed", "closed-error", "generation", "retiring"] as const) for (const stage of ["record", "approvals", "fence", "projection"] as const) test(`terminal commit guard preserves authority during ${stage} on ${change}`, async () => {
  const liveHandles = new Map([["agent-1", handle]]);
  const entry = manifestEntry();
  entry.desired_state = "stopped";
  let saved: ReturnType<ProviderTerminalCoordinator["terminalPayload"]> | null = null;
  let generation = 7, closing = false;
  const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => closing, notifyStateChanged: () => {} });
  let heldStage = "", effects = 0, entered!: () => void, unblock!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const guarded = async (name: string, commit: () => Promise<void>, fence?: (commit: () => Promise<void>) => Promise<void>) => {
    heldStage = name;
    assert.ok(fence, "every terminal mutation supplies the exact-owner commit guard");
    await fence(async () => { effects++; await commit(); });
  };
  const ports: ProviderTerminalPorts = {
    authority: { ...terminalAuthority, isClosing: () => closing, fenceCommit: async commit => {
      if (heldStage === stage) {
        entered(); await gate;
        if (change === "closed-error") throw new Error("real local failure during close");
      }
      await authority.fenceAdmittedTransitionCommit(commit);
    } },
    currentDaemonGeneration: () => generation, nowMs: () => Date.parse(terminal.endedAt), liveHandles,
    manifest: { getEntry: async () => entry, load: async () => ({ entries: [entry] }) },
    durability: {
      getAttempt: async () => ({ execution_generations: [{ execution_generation_id: "generation-1",
        actor: "daemon-provider", generation: 7, terminal: saved }] }) as never,
      recordTerminal: async (_attempt, _execution, payload, _limit, fence) => {
        await guarded("record", async () => { saved = payload; }, fence); return {} as never;
      },
      releaseTerminalExecutionFence: async (_attempt, _execution, fence) => guarded("fence", async () => {}, fence),
    },
    runtimeCustody: { deletePendingResumeBinding: () => {} },
    streams: { remove: () => { liveHandles.delete("agent-1"); return true; }, isLatestInstallation: exact => exact === installation },
    settleRuntimeApprovals: async (_id, fence) => guarded("approvals", async () => {}, fence),
    delivery: { start: async () => { throw new Error("superseded terminal cannot deliver"); } },
    serializeEntry: async (_id, run) => run(), serializeManifest: async run => run(),
    transitionOnce: async (_id, _state, _condition, _cause, _actor, _reconciliation, _notice, _terminal, fence) =>
      guarded("projection", async () => {}, fence),
    requestConvergence: () => { throw new Error("superseded terminal cannot converge"); },
  };
  const coordinator = new ProviderTerminalCoordinator(ports);
  const operation = coordinator.handleTerminal(installation, terminal);
  await entering;
  const before = effects;
  const successor = { ...handle, pid: 43 };
  if (change === "successor") liveHandles.set("agent-1", successor);
  else if (change === "closed" || change === "closed-error") coordinator.close();
  else if (change === "generation") generation = 8;
  else { coordinator.beginRetirement(); closing = true; }
  unblock();
  if (change === "retiring") {
    await operation;
    assert.equal(effects, 4, "an exact terminal admitted before retirement finishes under the existing authority");
  } else {
    if (change === "closed") await operation;
    else await assert.rejects(operation, change === "closed-error" ? /real local failure during close/ : /lost its exact installation authority/);
    assert.equal(effects, before, "a guard after asynchronous authority acquisition prevents the stale commit itself");
    if (change === "successor") assert.equal(liveHandles.get("agent-1"), successor);
  }
  coordinator.close();
});

for (const variant of ["different-observation", "canonical-unknown-death", "callback-unknown-death",
  "wrong-actor", "wrong-generation", "wrong-continuation", "wrong-birth", "wrong-callback-birth",
  "wrong-callback-continuation"] as const) {
  test(`terminal settlement completes only exact committed evidence: ${variant}`, async () => {
    const entry = manifestEntry();
    entry.desired_state = "stopped";
    entry.observed_state = "stopping";
    const death = { kind: connection.kind, pid: connection.pid, processIdentity: connection.processIdentity };
    const callback: ProviderActionTerminal = { ...terminal, signal: "SIGTERM", exitCode: 143,
      endedAt: "2026-09-02T00:00:00.009Z", terminalCause: "killed", nativeRuntimeDeath: death };
    const saved: ExecutionTerminalPayload = { ended_at: "2026-09-02T00:00:00.010Z", exit_code: null,
      signal: null, terminal_cause: "stopped", actor: "daemon-provider", generation: 7,
      provider_continuation_id: "continuation-1", native_runtime_death: death,
      stdio_archive_ref: null, stdio_tail: "" };
    if (variant === "canonical-unknown-death") delete saved.native_runtime_death;
    if (variant === "callback-unknown-death") delete callback.nativeRuntimeDeath;
    if (variant === "wrong-actor") saved.actor = "another-owner";
    if (variant === "wrong-generation") saved.generation = 8;
    if (variant === "wrong-continuation") saved.provider_continuation_id = "another-continuation";
    if (variant === "wrong-birth") saved.native_runtime_death = { ...death, processIdentity: "another-birth" };
    if (variant === "wrong-callback-birth") callback.nativeRuntimeDeath = { ...death, processIdentity: "another-birth" };
    if (variant === "wrong-callback-continuation") callback.providerContinuationId = "another-continuation";
    const original = structuredClone(saved);
    const liveHandles = new Map([[entry.id, handle]]);
    let approvals = 0, approvalAttempts = 0, fenceReleases = 0, projections = 0;
    const diagnostics: string[] = [];
    const coordinator = new ProviderTerminalCoordinator({
      authority: terminalAuthority, currentDaemonGeneration: () => 7, nowMs: () => Date.parse(saved.ended_at), liveHandles,
      manifest: { getEntry: async () => entry, load: async () => ({ entries: [entry] }) },
      durability: {
        getAttempt: async () => ({ execution_generations: [{ execution_generation_id: "generation-1",
          actor: "daemon-provider", generation: 7, terminal: saved }] }) as never,
        recordTerminal: async () => { throw new Error("committed evidence must never be overwritten"); },
        releaseTerminalExecutionFence: async () => { fenceReleases += 1; },
      },
      runtimeCustody: { deletePendingResumeBinding: () => {} },
      streams: { isLatestInstallation: exact => exact === installation,
        remove: () => { liveHandles.delete(entry.id); return true; } },
      delivery: { start: async () => {} },
      serializeEntry: async (_id, operation) => operation(), serializeManifest: operation => operation(),
      transitionOnce: async (_id, state, condition, _cause, _actor, reconciliation) => {
        projections += 1; entry.observed_state = state; entry.condition = condition; entry.reconciliation = reconciliation;
      },
      requestConvergence: () => {}, settleRuntimeApprovals: async () => {
        if (++approvalAttempts === 1) throw new Error("local approval storage unavailable once");
        approvals += 1;
      },
      diagnostic: (_id, error) => { diagnostics.push(String(error)); },
    });
    try {
      if (variant.startsWith("wrong-")) {
        await assert.rejects(coordinator.handleTerminal(installation, callback), /exact execution identity|exact provider installation/);
        assert.deepEqual([approvals, fenceReleases, projections], [0, 0, 0]);
        assert.equal(entry.observed_state, "stopping");
      } else {
        await assert.rejects(coordinator.handleTerminal(installation, callback), /local approval storage unavailable once/);
        await coordinator.handleTerminal(installation, callback);
        assert.deepEqual([approvals, fenceReleases, projections], [1, 1, 1]);
        assert.equal(entry.observed_state, "stopped");
        assert.deepEqual(entry.reconciliation?.last_terminal, original,
          "remaining projection uses the committed result, including honest unknown death");
        assert.equal(diagnostics.filter(message => message.includes("differing terminal observations")).length, 1,
          "a repeated local settlement reports the observation difference only once");
      }
      assert.deepEqual(saved, original, "all historical evidence remains immutable");
      await coordinator.drain();
    } finally { coordinator.close(); }
  });
}

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


test("configuration preflight admitted before update cannot reserve lifecycle after the pause", async () => {
  let paused = false;
  let release!: () => void;
  let entered!: () => void;
  const preflight = new Promise<void>(resolve => { release = resolve; });
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const h = applyHarness({ isAdmissionPaused: () => paused,
    head: async () => { entered(); await preflight; return null; } });
  const applying = h.coordinator.apply({ entryId: "agent-1", daemonGeneration: 7, expectedConfigurationRevision: 2 });
  await inspecting;
  paused = true;
  release();
  assert.deepEqual(await applying, { outcome: "conflict" });
  assert.deepEqual(h.counts(), { providerStops: 0, replacements: 0 });
  assert.equal(h.deliveryReserved(), false);
  assert.equal(await h.gate.run("agent-1", async () => "current turn can commit"), "current turn can commit");
});

function deliveryAgentFor(token: ProviderInstallationToken) {
  return { agentId: token.entryId, roomId: "room-1", provider: "codex", deliveryMode: "daemon_inbox" as const,
    apiUrl: "http://127.0.0.1:4000", agentSessionId: "session", bearer: "memory",
    executionGenerationId: token.executionGenerationId, daemonGeneration: 7, handle: token.handle,
    workAttemptId: token.workAttemptId, providerContinuationId: token.providerContinuationId,
    providerConnection: token.providerConnection };
}

// The owner's own setup, as it is stored: on is an exact false, and each change is a key named for its revision.
const OWNER_SETUP_ON = { letagentsOwnerIsolation: false };
const changedAt = (...revisions: number[]) => Object.fromEntries(revisions.map((revision) => [`letagentsOwnerIsolationChangedAt${revision}`, false]));
/** A process that was started with its owner's setup: its handle says so, from the launch or from the daemon's record at a re-attach. */
const ownerSetupInstallation = (): ProviderInstallationToken => ({ ...installation, handle: { ...handle, ownerSetup: true } });
const pendingHead = async () => ({ state: "pending", provider_turn_id: null });

test("once the owner turns their setup off, no new turn starts on the process that still has it, and it is replaced as soon as it is idle", async () => {
  // The installed process started at revision 1 with the setup. It was turned off at revision 2.
  let turnRunning = true;
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, stopIfIdle: async () => !turnRunning, head: pendingHead });
  env.configuration.provider_launch_policy = changedAt(2);
  const agent = deliveryAgentFor(installed);
  const demand = {};

  // The next room message is not handed to that process, however often delivery asks.
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, demand), false);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, demand), false);
  assert.equal(env.convergenceLifecycleStates.length, 1, "one wake asks for the replacement once");
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 }, "asking never stops anything itself");

  // While its turn is still running it is left alone: a turn is never interrupted. It is asked again later.
  assert.deepEqual(await env.coordinator.refreshManaged("agent-1"), { retryAfterMs: 1_000 });
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, {}), false, "and still no new turn starts on it");

  // The turn ends, normally or not. The convergence that follows replaces the process.
  turnRunning = false;
  const wakes = env.convergenceLifecycleStates.length;
  assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined);
  assert.deepEqual(env.counts(), { providerStops: 1, replacements: 1 });
  assert.equal(env.deliveryReserved(), false);
  assert.equal(env.convergenceLifecycleStates.length, wakes + 1, "the replacement is started at once");

  // Its successor starts at the saved revision, without the setup, and takes the waiting turn.
  env.configuration.runtime_configuration_revision = 2;
  env.options.streams = { currentInstallation: () => ({ ...installation, handle: { ...handle, appliedConfigurationRevision: 2 } }) };
  const reads = env.configurationReads();
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, demand), true);
  assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined);
  assert.deepEqual(env.counts(), { providerStops: 1, replacements: 1 }, "nothing is replaced twice");
  assert.equal(env.configurationReads(), reads, "and nothing more is read for it");
});

test("a replacement that cannot happen yet is tried again, later each time, until it does", async () => {
  // The coordinator's own answer drives the retry: the scheduler converges again after each wait.
  let busy = true;
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, stopIfIdle: async () => !busy, head: pendingHead });
  env.configuration.provider_launch_policy = changedAt(2);
  const waits: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pending = await env.coordinator.refreshManaged("agent-1");
    assert.ok(pending, "still to be replaced");
    assert.equal(pending.notice, undefined, "an agent that is working is waited for without comment");
    waits.push(pending.retryAfterMs);
  }
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000], "each wait is longer, up to half a minute");
  assert.deepEqual(env.convergenceLifecycleStates, [], "a try that replaced nothing does not converge again at once: there is no loop");
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
  // The first try found it busy; a later one succeeds, and convergence then starts the successor.
  busy = false;
  assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined);
  assert.deepEqual(env.counts(), { providerStops: 1, replacements: 1 });
  assert.equal(env.convergenceLifecycleStates.length, 1);
});

test("a try that had taken the agent's delivery over and then replaced nothing hands delivery back at once", async () => {
  // Between taking delivery over and stopping the process, the installed process changed: nothing is replaced.
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, head: pendingHead, afterDeliveryInstallation: { ...installed, nonce: Symbol("another birth") } });
  env.configuration.provider_launch_policy = changedAt(2);
  assert.deepEqual(await env.coordinator.refreshManaged("agent-1"), { retryAfterMs: 1_000 }, "and it is tried again later, like any other try");
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
  assert.equal(env.deliveryReserved(), false);
  // Delivery was stopped for the try. Convergence is what starts it again, so it is asked for now and not after the wait.
  assert.deepEqual(env.convergenceLifecycleStates, [false]);
});

test("an agent that is neither working nor replaceable is still tried again, and its owner is told once that it is waiting", async () => {
  // The agent is held for another reason: the ordinary apply path answers that it cannot replace it now.
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, head: pendingHead });
  env.configuration.provider_launch_policy = changedAt(2);
  env.entry.condition = "coordination_blocked";
  const answers: Array<{ retryAfterMs: number; notice?: string }> = [];
  for (let attempt = 0; attempt < 7; attempt += 1) answers.push((await env.coordinator.refreshManaged("agent-1"))!);
  assert.deepEqual(answers.map((answer) => answer.retryAfterMs), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.deepEqual(answers.map((answer) => Boolean(answer.notice)), [false, false, false, false, true, false, false], "said once, after the fifth try");
  assert.match(answers[4]!.notice!, /^Still waiting to restart this agent so it stops running with your own setup\. Its messages wait until then\. Pause the agent and resume it to do it now\.$/);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), {}), false, "no turn runs on it meanwhile");
  // What held it up clears: the next try replaces it.
  env.entry.condition = "none";
  assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined);
  assert.deepEqual(env.counts(), { providerStops: 1, replacements: 1 });
});

test("an agent that cannot be restarted to end the owner's setup ends in an error its owner sees", async () => {
  const gone = Object.assign(new Error("native stop failed"), { providerRuntimeGone: true });
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, head: pendingHead, stopFailure: () => gone });
  env.configuration.provider_launch_policy = changedAt(2);
  const failure = await env.coordinator.refreshManaged("agent-1").then(() => null, (error: Error) => error);
  assert.ok(failure, "the failure is not swallowed, so the scheduler records it as the agent's error");
  assert.equal(failure.message, "LetAgents could not restart this agent to stop it running with your own setup, so its messages are waiting. "
    + "Pause the agent and resume it to finish switching your setup off");
  // What the scheduler shows, and what it decides from, both keep the provider's own failure.
  assert.equal(schedulerErrorDetail(failure), `${failure.message}; cause: native stop failed`);
  assert.equal(providerRuntimeGoneFailure(failure), true);
  assert.equal(env.deliveryReserved(), false);
  assert.equal(env.counts().providerStops, 0, "the process is still there");
  assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), {}), false, "and no turn runs with the setup meanwhile");
});

test("a process the daemon re-attached to is held back and replaced when its record says it was started with the setup", async () => {
  // Nothing was asked of this coordinator before: it is a new one, as after a restart of the background service.
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, head: pendingHead });
  env.configuration.provider_launch_policy = { approvalPolicy: "never", ...changedAt(2) };
  assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), {}), false);
  assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined);
  assert.deepEqual(env.counts(), { providerStops: 1, replacements: 1 });
});

test("only a process that still has a setup its owner turned off is held back or replaced", async () => {
  // A process that was started with the setup, whose owner has it on: it keeps it.
  for (const [name, policy] of [
    ["has it, and it is still on", { ...OWNER_SETUP_ON, ...changedAt(1) }],
    // Turned off and back on while the agent was busy: the process has had it all along, and may keep it.
    ["on, off and on again while busy", { ...OWNER_SETUP_ON, ...changedAt(2, 3) }],
  ] as const) {
    const installed = ownerSetupInstallation();
    const env = applyHarness({ installed, head: pendingHead });
    env.configuration.provider_launch_policy = policy;
    assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), {}), true, name);
    assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined, name);
    assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 }, name);
    assert.deepEqual(env.convergenceLifecycleStates, [], name);
  }
  // A process that was not started with it has nothing to lose, whatever is saved since.
  for (const [name, policy] of [
    ["never had it", {}],
    ["saved on, not started with it yet", { ...OWNER_SETUP_ON, ...changedAt(2) }],
    ["on and off again before any restart", changedAt(2, 3)],
    ["restarted since it was turned off", changedAt(2)],
  ] as const) {
    const env = applyHarness({ head: pendingHead });
    env.configuration.provider_launch_policy = policy;
    assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installation), {}), true, name);
    assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined, name);
    assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 }, name);
    assert.deepEqual(env.convergenceLifecycleStates, [], name);
  }
  // A process with the setup whose agent may no longer have it at all is replaced like one whose owner turned it off.
  for (const [entryId, provider, deliveryMode] of [["supervised_rental_0123", "codex", "daemon_inbox"], ["agent-1", "cursor", "daemon_inbox"], ["agent-1", "codex", "mcp_polling"]] as const) {
    const installed = ownerSetupInstallation();
    const env = applyHarness({ installed });
    Object.assign(env.configuration, { provider, delivery_mode: deliveryMode, provider_launch_policy: OWNER_SETUP_ON });
    assert.equal(await env.coordinator.canAdmitManagedDelivery({ ...deliveryAgentFor(installed), agentId: entryId }, {}), false, `${entryId}/${provider}/${deliveryMode}`);
  }
});

test("an agent whose process was not started with its owner's setup is admitted without reading anything, even when nothing can be read", async () => {
  // Every agent that never had the setup: Codex, Claude Code, Cursor, Open Model, whatever is stored for it.
  for (const provider of ["codex", "claude-code", "cursor", "open-model"]) {
    for (const policy of [{}, changedAt(2), { ...OWNER_SETUP_ON, ...changedAt(2) }]) {
      const env = applyHarness({ head: pendingHead, configurationUnreadable: () => true });
      Object.assign(env.configuration, { provider, provider_launch_policy: policy });
      // A read that never comes back would hold the turn up just the same, so it must not be started at all.
      env.options.store.getAgentConfiguration = () => assert.fail("nothing is read for an agent that never had the setup");
      const admitted = await env.coordinator.canAdmitManagedDelivery({ ...deliveryAgentFor(installation), provider }, {});
      assert.equal(admitted, true, provider);
      assert.equal(env.configurationReads(), 0, provider);
      assert.deepEqual(env.convergenceLifecycleStates, [], provider);
    }
  }
});

test("when the saved choice cannot be read, a process that has the owner's setup takes no turn, and the read is tried again", async () => {
  let unreadable = true;
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, head: pendingHead, configurationUnreadable: () => unreadable });
  env.configuration.provider_launch_policy = { ...OWNER_SETUP_ON, ...changedAt(1) };
  const demand = {};
  assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), demand), false, "not known to be allowed, so not started");
  assert.equal(env.convergenceLifecycleStates.length, 1, "convergence is asked for, which is what tries again");
  assert.deepEqual(await env.coordinator.refreshManaged("agent-1"), { retryAfterMs: 1_000 });
  assert.deepEqual(await env.coordinator.refreshManaged("agent-1"), { retryAfterMs: 2_000 });
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 }, "nothing is stopped on a guess");
  // The read works again and the setup is still on: the agent keeps it and takes its turn.
  unreadable = false;
  assert.equal(await env.coordinator.refreshManaged("agent-1"), undefined);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), demand), true);
  assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 });
});

test("an agent that is paused or stopped is not restarted to end the owner's setup, and still takes no turn on the old process", async () => {
  for (const desired of ["paused", "stopped"] as const) {
    const installed = ownerSetupInstallation();
    const env = applyHarness({ installed });
    env.configuration.provider_launch_policy = changedAt(2);
    env.entry.desired_state = desired;
    const pending = await env.coordinator.refreshManaged("agent-1");
    assert.deepEqual(pending, { retryAfterMs: 1_000 }, desired);
    assert.deepEqual(env.counts(), { providerStops: 0, replacements: 0 }, desired);
    assert.equal(await env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installed), {}), false, desired);
    // Its owner paused or stopped it: nothing is waiting on it, so nothing is said about waiting however long it lasts.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      assert.equal((await env.coordinator.refreshManaged("agent-1"))?.notice, undefined, desired);
    }
  }
});

test("a turn held back for the end of the owner's setup is delivered by itself once the agent is replaced, even when the first try finds it busy", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-owner-setup-end-"));
  const inbox = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const installed = ownerSetupInstallation();
  const env = applyHarness({ installed, head: pendingHead });
  // The owner turned the setup off at revision 2, while the process that started with it was still there.
  env.configuration.provider_launch_policy = changedAt(2);
  let current = installed;
  const invoked: string[] = [];
  const waits: number[] = [];
  const scheduled: Promise<void>[] = [];
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true,
      permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { throw new Error("unused"); }, attach: async () => null,
    attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unused"); },
    poke: async () => {}, stop: async () => terminal, onExit: async () => () => {},
    runRoomTurn: async (native, request, options) => {
      assert.notEqual(native, installed.handle, "no turn runs on the process that still has the owner's setup");
      invoked.push(request.inboxItemId);
      await options?.beforeNativeDispatch?.();
      const turnId = `turn-${request.inboxItemId}`;
      await options?.checkpointTurnStarted?.(turnId);
      return { turnId, outcome: "no_reply", text: null };
    },
  };
  const delivery = new SupervisedAgentDelivery(inbox, port, {
    poll: async ({ signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true })),
    publish: async () => {},
  },
    async agent => agent.handle === current.handle && agent.executionGenerationId === current.executionGenerationId,
    0, undefined, async () => {}, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    (agent, demand) => env.coordinator.canAdmitManagedDelivery(agent, demand));
  env.options.inbox = inbox;
  // The first try to replace it finds the agent busy; later ones find it idle.
  let busyOnce = true;
  env.options.delivery = { reserveIdle: async (entryId) => {
    if (busyOnce) { busyOnce = false; return null; }
    return delivery.reserveIdle(entryId);
  } };
  env.options.provider!.stop = async () => terminal;
  env.options.streams.currentInstallation = () => current;
  env.options.terminals.replaceConfiguration = async (exact, stop) => {
    assert.equal(exact, installed);
    await stop();
    // The successor starts at the saved revision, where the setup is off: its handle does not carry it.
    current = { ...installation, nonce: Symbol("replacement"), executionGenerationId: "generation-2", configurationRevision: 2,
      handle: { ...handle, pid: 43, appliedConfigurationRevision: 2, providerConnection: { ...connection, pid: 43, processIdentity: "codex:43" } },
      providerConnection: { ...connection, pid: 43, processIdentity: "codex:43" } };
    env.entry.provider_ref = { ...env.entry.provider_ref!, execution_generation_id: current.executionGenerationId,
      provider_connection: current.providerConnection };
    env.configuration.runtime_configuration_revision = 2;
  };
  // The scheduler, as the daemon runs it: converge, and when the coordinator says the agent is still to
  // be replaced, converge again after the wait it names. Nobody sends the message a second time.
  const converge = () => {
    scheduled.push(Promise.resolve().then(async () => {
      const pending = await env.coordinator.refreshManaged("agent-1");
      if (pending) {
        waits.push(pending.retryAfterMs);
        assert.ok(waits.length <= 3, "the retry must not turn into a loop");
        converge();
      } else if (current !== installed) await delivery.pump(deliveryAgentFor(current));
    }));
  };
  env.options.requestConvergence = () => converge();
  try {
    await inbox.ingestPoll({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "2",
      messages: ["1", "2"].map(id => ({ source_message_id: id, source_message: { id, text: "check" }, activation: {} })) });
    await delivery.pump(deliveryAgentFor(current));
    for (let index = 0; index < scheduled.length; index += 1) await scheduled[index];
    assert.deepEqual(waits, [1_000], "the first try found it busy and named when to try again");
    assert.notEqual(current, installed, "the second try replaced it");
    const receipts = await inbox.receipts("agent-1");
    assert.equal(receipts.length, 2);
    assert.deepEqual(invoked, receipts.map(receipt => receipt.inbox_item_id), "both waiting messages were delivered, in order, to the successor");
    for (const receipt of receipts) {
      assert.equal(receipt.state, "acknowledged_no_reply");
      assert.equal(receipt.attempt_count, 1);
      assert.equal((await inbox.providerTurnBinding(receipt.inbox_item_id))!.origin_execution_generation_id, "generation-2");
    }
  } finally { await delivery.fenceAndDrain(); await inbox.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed delivery admission coalesces one demand but permits later wakes on the same installation", async () => {
  const env = managedHarness();
  const agent = deliveryAgentFor(installation);
  const demand = {};
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, demand), false);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, demand), false);
  assert.equal(env.convergenceLifecycleStates.length, 1);
  assert.equal(env.state.nativeStops, 0, "admission only observes, never drains its caller");
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, {}), false);
  assert.equal(env.convergenceLifecycleStates.length, 2);
  env.state.receipt = "a".repeat(64);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, demand), true);
  assert.equal(env.state.desiredReads, 1);
  assert.equal(env.convergenceLifecycleStates.length, 2);
});

test("an older admission read cannot overwrite or consume a newer delivery demand", async () => {
  const env = managedHarness();
  const agent = deliveryAgentFor(installation);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  env.options.managed!.store.readManagedLaunchContract = async () => {
    if (++reads === 1) { entered(); await barrier; }
    return "b".repeat(64);
  };
  const older = {};
  const newer = {};
  const pending = env.coordinator.canAdmitManagedDelivery(agent, older);
  await reading;
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, newer), false);
  assert.equal(env.convergenceLifecycleStates.length, 1);
  release();
  assert.equal(await pending, false);
  assert.equal(env.convergenceLifecycleStates.length, 2);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, newer), false);
  assert.equal(await env.coordinator.canAdmitManagedDelivery(agent, older), false);
  assert.equal(env.convergenceLifecycleStates.length, 2, "each demand is consumed only once despite out-of-order reads");
});

for (const change of ["installation", "handle", "execution", "continuation", "birth", "daemon", "handoff"] as const) {
  test(`managed admission rejects ${change} replacement during its receipt read`, async () => {
    const env = managedHarness();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    env.options.managed!.store.readManagedLaunchContract = async () => { entered(); await barrier; return "a".repeat(64); };
    const pending = env.coordinator.canAdmitManagedDelivery(deliveryAgentFor(installation), {});
    await reading;
    const candidate = { ...installation };
    if (change === "handle") candidate.handle = { ...handle };
    if (change === "execution") candidate.executionGenerationId = "other-generation";
    if (change === "continuation") candidate.providerContinuationId = "other-thread";
    if (change === "birth") candidate.providerConnection = { ...connection, processIdentity: "other-birth" };
    if (change === "daemon") env.options.authority.currentDaemonGeneration = () => 8;
    else if (change === "handoff") env.options.authority.isHandoffScheduled = () => true;
    else env.options.streams.currentInstallation = () => candidate;
    release();
    assert.equal(await pending, false);
    assert.equal(env.convergenceLifecycleStates.length, 0, "stale observations cannot request replacement");
    assert.equal(env.state.nativeStops, 0);
  });
}

for (const trigger of ["arrival", "retry", "deferred", "descriptor failure", "receipt failure"] as const) {
  test(`managed ${trigger} waits for guarded replacement before exact-continuation FIFO delivery`, { timeout: 5_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-managed-admission-"));
    const inbox = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const env = managedHarness();
    let current = installation;
    let wakes = 0;
    let sawRequest!: () => void;
    let requested = new Promise<void>(resolve => { sawRequest = resolve; });
    const scheduled: Promise<void>[] = [];
    const invoked: string[] = [];
    const demands: object[] = [];
    const recoveryDelays: number[] = [];
    let resumedObserved!: () => void;
    const resumedObservation = new Promise<void>(resolve => { resumedObserved = resolve; });
    let polls = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true,
        permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => { throw new Error("unused"); }, attach: async () => null,
      attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unused"); },
      poke: async () => {}, stop: async () => terminal, onExit: async () => () => {},
      runRoomTurn: async (native, request, options) => {
        assert.notEqual(native, handle, "the old managed runtime must never reach native preflight");
        assert.equal(native.providerContinuationId, installation.providerContinuationId);
        invoked.push(request.inboxItemId);
        await options?.beforeNativeDispatch?.();
        const turnId = `turn-${request.inboxItemId}`;
        await options?.checkpointTurnStarted?.(turnId);
        return { turnId, outcome: "no_reply", text: null };
      },
    };
    const delivery = new SupervisedAgentDelivery(inbox, port, { poll: async ({ signal }) => {
      polls += 1;
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true }));
    }, publish: async () => {} },
      async agent => agent.handle === current.handle && agent.executionGenerationId === current.executionGenerationId,
      0, undefined, async delay => { recoveryDelays.push(delay); }, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      (agent, demand) => {
        demands.push(demand);
        if (env.state.resumedDelivery && current === installation) resumedObserved();
        return env.coordinator.canAdmitManagedDelivery(agent, demand);
      });
    env.options.inbox = inbox;
    env.options.delivery = delivery;
    env.options.streams.currentInstallation = () => current;
    env.options.managed!.bindings.get = async () => ({ entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
      execution_generation_id: current.executionGenerationId, agent_session_id: "session", credential_ref: "opaque",
      api_url: "http://127.0.0.1:4000", room_cursor: null, last_sequence: 0, last_observed_at_ms: 0, updated_at: "now" });
    env.options.managed!.store.readManagedLaunchContract = async () => current === installation ? "b".repeat(64) : "a".repeat(64);
    if (trigger === "descriptor failure" || trigger === "receipt failure") {
      let failed = false;
      const faultOnce = () => {
        if (failed) return;
        failed = true;
        throw new Error("managed contract read temporarily unavailable");
      };
      if (trigger === "descriptor failure") {
        const describe = env.options.provider!.describeManagedLaunchContract!;
        env.options.provider!.describeManagedLaunchContract = async input => { faultOnce(); return describe(input); };
      } else {
        const read = env.options.managed!.store.readManagedLaunchContract;
        env.options.managed!.store.readManagedLaunchContract = async input => { faultOnce(); return read(input); };
      }
    }
    env.options.managed!.resumeDelivery = async () => {
      env.state.resumedDelivery += 1;
      await delivery.refresh(deliveryAgentFor(current));
      await resumedObservation;
      await delivery.drainAdmittedTurns(["agent-1"]);
    };
    env.options.provider!.stopIdle = async (_native, guard) => {
      assert.equal(env.state.approvalHeld, true);
      guard();
      if (trigger === "deferred" && env.state.resumedDelivery === 0) {
        throw new ManagedRuntimeRefreshDeferred("native idle boundary temporarily unreadable");
      }
      env.state.nativeStops += 1;
      return terminal;
    };
    env.options.terminals.replaceConfiguration = async (exact, stop) => {
      assert.equal(exact, installation);
      await stop();
      current = { ...installation, nonce: Symbol("replacement"), executionGenerationId: "generation-2",
        handle: { ...handle, pid: 43, providerConnection: { ...connection, pid: 43, processIdentity: "codex:43" } },
        providerConnection: { ...connection, pid: 43, processIdentity: "codex:43" } };
      env.entry.provider_ref = { ...env.entry.provider_ref!, execution_generation_id: current.executionGenerationId,
        provider_connection: current.providerConnection };
    };
    env.options.requestConvergence = () => {
      wakes += 1;
      sawRequest();
      assert.ok(wakes <= 3, "deferred ingress must not create a convergence storm");
      scheduled.push(Promise.resolve().then(async () => {
        await env.coordinator.refreshManaged("agent-1");
        if (current !== installation) await delivery.pump(deliveryAgentFor(current));
      }));
    };
    try {
      await inbox.ingestPoll({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "2",
        messages: ["1", "2"].map(id => ({ source_message_id: id, source_message: { id, text: "check" }, activation: {} })) });
      const originalHead = await inbox.head("agent-1");
      if (trigger === "retry") {
        await inbox.transition(originalHead!.inbox_item_id, "dispatching");
        await inbox.transition(originalHead!.inbox_item_id, "blocked", { last_error: "preflight unavailable" });
        await delivery.retry(deliveryAgentFor(current), "1");
      }
      if (trigger === "deferred") await delivery.start(deliveryAgentFor(current));
      else await delivery.pump(deliveryAgentFor(current));
      await requested;
      for (let index = 0; index < scheduled.length; index += 1) await scheduled[index];
      if (trigger === "deferred") {
        assert.equal(wakes, 1);
        assert.deepEqual(invoked, []);
        assert.equal((await inbox.head("agent-1"))!.state, "pending");
        assert.equal(env.state.resumedDelivery, 1);
        assert.equal(current, installation, "deferral retains the exact original native installation");
        assert.equal(polls, 2, "deferral restarted the real observation loop");
        assert.equal(demands[0], demands[1], "loop replacement retains its original delivery demand");
        requested = new Promise<void>(resolve => { sawRequest = resolve; });
        // Native idle becomes readable without emitting a provider/approval
        // event. Only an independent delivery wake retries the same runtime.
        assert.equal(delivery.wake(deliveryAgentFor(current)), true);
        await requested;
        for (let index = 0; index < scheduled.length; index += 1) await scheduled[index];
      }
      assert.equal(env.state.nativeStops, 1);
      if (trigger === "descriptor failure" || trigger === "receipt failure") {
        assert.deepEqual(recoveryDelays, [250], "existing tracked fault recovery owns the read retry");
        assert.equal(demands[0], demands[1], "the failed read did not consume or replace its delivery demand");
      }
      const receipts = await inbox.receipts("agent-1");
      assert.equal(receipts.length, 2);
      assert.deepEqual(invoked, receipts.map(receipt => receipt.inbox_item_id));
      for (const receipt of receipts) {
        assert.equal(receipt.state, "acknowledged_no_reply");
        assert.equal(receipt.attempt_count, 1);
        assert.equal((await inbox.providerTurnBinding(receipt.inbox_item_id))!.origin_execution_generation_id, "generation-2");
        assert.equal((await inbox.providerTurnBinding(receipt.inbox_item_id))!.provider_continuation_id, installation.providerContinuationId);
      }
    } finally { await delivery.fenceAndDrain(); await inbox.close(); await rm(root, { recursive: true, force: true }); }
  });
}
