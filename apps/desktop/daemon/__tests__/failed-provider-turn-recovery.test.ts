/**
 * A daemon-inbox agent could go deaf with nothing shown to its owner when its
 * runtime ended without its process exiting and without the manifest learning
 * of it. Three places kept it that way, and these tests pin each:
 *
 *  - Delivery could not record a turn's failed ending on a handle that had
 *    itself failed, so the row went back to `pending` behind "authority
 *    changed before the provider turn became durable".
 *  - The heartbeat skipped its credential checks for such a handle, so the
 *    worker bearer expired, and nothing asked for the runtime to be replaced.
 *  - Every room poll then failed with 401, which looked like "reconnecting".
 *
 * A refused poll is shown to the owner and starts nothing: the daemon sees the
 * same refusal when a room admin has disconnected the agent.
 *
 * A provider that merely refuses a turn no longer ends a Codex runtime at all;
 * that is tested with the adapter in electron/__tests__.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { productionSupervisedDeliveryHttp } from "../cloud-http.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import { ProviderCheckpointCoordinator } from "../provider-checkpoint-coordinator.js";
import { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import { projectRoomAgentManifestEntry } from "../room-agent-state-projection.js";
import { ROOM_REFUSED_ACCESS_DETAIL, SupervisedAgentDelivery, SupervisedRoomAuthorizationError } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type InstalledHostGrant } from "../worker-runtime-custody.js";

const PROVIDER_REFUSAL = "The provider refused this turn.";
const connection = { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 42, processIdentity: "codex:42" };

/** The manifest never learned of the failure: it still says `working`. */
const manifestEntry = (provider: DaemonManifestEntry["provider"] = "codex"): DaemonManifestEntry => ({
  id: "agent-1", room_id: "room-1", display_name: "Agent", provider, model: null,
  charter: "Help", desired_state: "running", observed_state: "working", condition: "none",
  permission_profile_id: "supervised", created_by: "test", created_at: "2026-08-26T00:00:00.000Z",
  work_attempt_id: "attempt-1", delivery_mode: "daemon_inbox",
  provider_ref: {
    work_attempt_id: "attempt-1", execution_generation_id: "generation-1",
    provider_continuation_id: "thread-1", provider_connection: connection,
  },
  activity: [],
});

const binding: WorkerSessionBinding = {
  entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1",
  execution_generation_id: "generation-1", agent_session_id: "session-1", credential_ref: "bearer-1",
  api_url: "https://letagents.test", room_cursor: null, last_sequence: 0, last_observed_at_ms: 0,
  updated_at: "2026-08-26T00:00:00.000Z",
};

const deliveryAgent = (handle: ProviderActionHandle | null, provider = "codex") => ({
  agentId: "agent-1", roomId: "room-1", provider, deliveryMode: "daemon_inbox" as const,
  apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "bearer-1",
  executionGenerationId: "generation-1", daemonGeneration: 1, handle,
  workAttemptId: "attempt-1", providerContinuationId: "thread-1", providerConnection: connection,
});

/** A live handle whose state the adapter can latch, as the Codex handle does. */
function latchingHandle(initial: ProviderActionHandle["observedState"] = "idle"): {
  handle: ProviderActionHandle;
  set(state: ProviderActionHandle["observedState"]): void;
} {
  let observed = initial;
  const handle = {
    workAttemptId: "attempt-1", pid: 42, providerContinuationId: "thread-1",
    providerConnection: connection, appliedConfigurationRevision: 1,
    get observedState() { return observed; },
  } as ProviderActionHandle;
  return { handle, set: (state) => { observed = state; } };
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const roomTurnPort = (runRoomTurn: NonNullable<ProviderActionPort["runRoomTurn"]>) => ({
  capabilities: async () => ({
    resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false,
    survivesRestart: true, turnControl: "unsupported" as const, continuationRepair: "unsupported" as const,
  }),
  spawn: async () => { throw new Error("not used"); },
  attach: async () => null,
  attachAction: async () => ({ state: "absent" as const }),
  resume: async () => { throw new Error("not used"); },
  poke: async () => {},
  stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: null }),
  onExit: async () => () => {},
  runRoomTurn,
} satisfies ProviderActionPort);

/**
 * One delivery lane over the real inbox store and the real authority check,
 * with a provider whose runtime ends (its handle reports `failed`) between the
 * durable turn id and the turn's reported ending.
 */
async function deliveryOnEndedRuntime(
  provider: "codex" | "claude-code" | "open-model",
  ending: { outcome: "failed" | "interrupted"; error: string } | { outcome: "reply"; text: string },
) {
  const root = await mkdtemp(join(tmpdir(), "letagents-failed-turn-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const { handle, set } = latchingHandle();
  // The real authority check the daemon gives delivery, over fakes.
  const checkpoints = new ProviderCheckpointCoordinator({
    store: { getEntry: async () => manifestEntry(provider), unresolvedDeliveryDrain: async () => null } as never,
    bindings: { get: async () => binding, credentialFor: async () => "bearer-1" } as never,
    inbox: store,
    durability: {} as never,
    liveHandles: new Map([["agent-1", handle]]),
    authority: {
      isHandoffScheduled: () => false,
      assertCurrent: async () => {},
      currentDaemonGeneration: () => 1,
      currentManifestGeneration: () => 1,
      acceptManifestGeneration: () => {},
      fenceCommit: async (commit) => commit(),
      fenceAdmittedTransitionCommit: async (commit) => commit(),
    },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async (operation) => operation(),
    scheduleRecovery: () => {},
    nowMs: () => Date.now(),
  });
  const counts = { turns: 0, polls: 0, convergenceRequests: 0 };
  const published: string[] = [];
  /** The inbox head, which is what the supervisor asks before it retires a runtime. */
  const head: { beforeTheResult: Promise<string | undefined> | null; whenConvergenceIsWoken: Promise<string | undefined> | null } = {
    beforeTheResult: null, whenConvergenceIsWoken: null,
  };
  const headNow = () => store.head("agent-1").then((item) => item ? `${item.source_message_id}:${item.state}` : undefined);
  const delivery = new SupervisedAgentDelivery(store, roomTurnPort(async (_handle, _request, options) => {
    counts.turns += 1;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn-1");
    set("failed");
    head.beforeTheResult = headNow();
    const result = ending.outcome === "reply"
      ? { turnId: "turn-1", outcome: "reply" as const, text: ending.text, evidence: "transcript" as const }
      : { turnId: "turn-1", providerContinuationId: "thread-1", outcome: ending.outcome,
        text: null, evidence: "transcript" as const, error: ending.error };
    await options?.checkpointTerminalResult?.(result);
    return result;
  }), {
    poll: async ({ signal }) => {
      counts.polls += 1;
      if (counts.polls === 1) {
        return { messages: [
          { id: "1", activation: { for_current_agent: { decision: "activate" } } },
          { id: "2", activation: { for_current_agent: { decision: "activate" } } },
        ] };
      }
      await pause(25, signal);
      return {};
    },
    publish: async (input) => { published.push(input.text); return { messageId: "reply-1", roomId: input.roomId }; },
  }, (authority, scope) => checkpoints.isExactAuthority(authority, scope), 10,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, () => {
    counts.convergenceRequests += 1;
    head.whenConvergenceIsWoken ??= headNow();
  });
  await delivery.start(deliveryAgent(handle, provider));
  return {
    store, handle, counts, published, head,
    receipt: async (sourceMessageId: string) =>
      (await store.receipts("agent-1")).find((item) => item.source_message_id === sourceMessageId),
    cleanup: async () => {
      await delivery.fenceAndDrain().catch(() => undefined);
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const provider of ["codex", "claude-code", "open-model"] as const) {
  for (const outcome of ["failed", "interrupted"] as const) {
    test(`${provider}: a turn that ended ${outcome} settles with the provider's reason on a runtime that has itself ended`, async () => {
      const lane = await deliveryOnEndedRuntime(provider, { outcome, error: PROVIDER_REFUSAL });
      try {
        // Far longer than the 10 ms retry delay and several poll iterations.
        await eventually(async () => (await lane.receipt("1"))?.state === "acknowledged_failed");
        const settled = await lane.receipt("1");
        assert.equal(settled?.state, "acknowledged_failed",
          `the exact ending must settle its row; it is ${settled?.state} with last_error=${JSON.stringify(settled?.last_error)}`);
        assert.equal(settled?.last_error, PROVIDER_REFUSAL,
          "the owner sees the provider's own reason, not a delivery-authority message");
        assert.equal(settled?.provider_turn_id, "turn-1");
        assert.ok(lane.counts.convergenceRequests >= 1, "settlement wakes convergence, which replaces the ended runtime");
        assert.deepEqual([await lane.head.beforeTheResult, await lane.head.whenConvergenceIsWoken], ["1:dispatching", "2:pending"],
          "the message is in flight until its turn is recorded, and convergence is woken only after that");

        // What the owner's desktop renders under the message and in the inspector.
        const view = projectRoomAgentManifestEntry({
          entry: manifestEntry(provider), binding, credentialAvailable: true, currentHostGrantAvailable: true,
          liveHandle: lane.handle, lifecycleAdmission: "ready", ingressHealth: null, continuationRepair: null,
          receipts: await lane.store.receipts("agent-1"), activeTurn: null, nowMs: Date.now(),
          workplaceLivenessStaleAfterMs: 210_000, nativeLivenessStaleAfterMs: 90_000,
        });
        const shown = view.delivery_receipts?.find((item) => item.source_message_id === "1");
        assert.equal(shown?.state, "acknowledged_failed");
        assert.equal(shown?.error, PROVIDER_REFUSAL);
        assert.equal(view.delivery_attention, null, "a settled failure does not block the queue behind it");

        // The message behind it is for the replacement runtime: nothing is
        // started on the ended one, and the ended turn is never run again.
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(lane.counts.turns, 1);
        assert.equal((await lane.receipt("2"))?.state, "pending");
        assert.equal((await lane.receipt("2"))?.provider_turn_id, null);
        assert.deepEqual(lane.published, []);
      } finally {
        await lane.cleanup();
      }
    });
  }
}

test("an answer reported by a runtime that has itself ended is left for its replacement to recover", async () => {
  // Only a failed or interrupted ending may be recorded under the lane lease.
  // An answer still needs a runtime the daemon may use.
  const lane = await deliveryOnEndedRuntime("codex", { outcome: "reply", text: "An answer." });
  try {
    await eventually(async () => (await lane.receipt("1"))?.state === "pending" && lane.counts.polls > 4);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = await lane.receipt("1");
    assert.equal(row?.state, "pending");
    assert.equal(row?.provider_turn_id, "turn-1", "its exact turn id is kept, so the replacement reads the answer back");
    assert.deepEqual(lane.published, [], "nothing is published from the ended runtime");
    assert.equal(lane.counts.turns, 1, "and the turn is not run again");
  } finally {
    await lane.cleanup();
  }
});

function heartbeatHarness(handle: ProviderActionHandle, rotationDue: boolean, needsDesktopGrant = true) {
  const grant: InstalledHostGrant = {
    entryId: "agent-1", roomId: "room-1", agentKey: "owner/agent-1", grantId: "grant-1",
    supervisorGrant: "supervisor-secret", grantGeneration: 1, apiUrl: "https://letagents.test",
    daemonGeneration: 1, hostId: "host-1", installationId: "installation-1",
    ownerAccountId: null, scopeKey: null, expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const custody = new WorkerRuntimeCustody();
  const counts = { convergence: 0, liveness: 0, probes: 0, rotationChecks: 0 };
  let manifest = manifestEntry();
  let bound = true;
  let tick: (() => void) | null = null;
  const coordinator = new ProviderStreamCoordinator({
    // A typed daemon-inbox birth whose capture was ready when it was admitted.
    typedLifecycleAdmission: () => "ready",
    provider: {
      stop: async (current) => ({ endedAt: "2026-08-26T00:00:00.000Z", exitCode: 0, signal: null,
        terminalCause: "stopped" as const, providerContinuationId: current.providerContinuationId }),
      onExit: async () => () => {},
      onStream: async () => () => {},
      probeControl: async () => { counts.probes += 1; return { state: "responsive" as const }; },
    },
    manifest: {
      getEntry: async () => manifest,
      load: async () => ({ entries: [manifest] }),
      updateEntry: async (_entryId, update) => { manifest = update(manifest); return manifest; },
      readRuntimeLifecycleAuthority: async () => "typed",
    },
    bindings: {
      get: async () => bound ? binding : null,
      credentialFor: async () => null,
      supervisedWorkerSession: async () => null,
      verifyAndAdvanceExecutionGeneration: async () => { throw new Error("unused"); },
      checkpointCursorMonotonic: async () => { throw new Error("unused"); },
    },
    durability: {
      getAttempt: async () => ({ checkpoints: [], execution_generations: [] }) as never,
      checkpoint: async () => ({}) as never,
    },
    runtimeCustody: {
      liveBinding: (entryId) => custody.liveBinding(entryId),
      installLiveBinding: (entryId, identity) => custody.installLiveBinding(entryId, identity),
      deleteLiveBinding: (entryId) => custody.deleteLiveBinding(entryId),
      pendingResumeBinding: (entryId) => custody.pendingResumeBinding(entryId),
      hasPendingResumeBinding: (entryId) => custody.hasPendingResumeBinding(entryId),
      installPendingResumeBinding: (entryId, pending) => custody.installPendingResumeBinding(entryId, pending),
      deletePendingResumeBinding: (entryId) => custody.deletePendingResumeBinding(entryId),
    },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async (operation) => operation(),
    transition: async (_entryId, observed_state, condition) => { manifest = { ...manifest, observed_state, condition }; },
    appendNativeActivity: async () => {},
    publishNativeActivity: async () => { counts.liveness += 1; },
    handleTerminal: async () => {},
    streams: { reset: () => {}, push: () => {}, end: () => {} },
    delivery: { start: async () => {}, startCutover: async () => {} },
    heartbeat: {
      intervalMs: 15_000,
      requiresHostGrant: () => needsDesktopGrant,
      currentHostGrant: () => grant,
      hostGrantNeedsRenewal: () => false,
      hostWorkerBearerNeedsRotation: async () => { counts.rotationChecks += 1; return rotationDue; },
      requestConvergence: () => { counts.convergence += 1; },
    },
    setInterval: ((callback: () => void) => { tick = callback; return { unref() {} }; }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });
  return {
    coordinator, counts,
    entry: () => manifest,
    setEntry: (next: Partial<DaemonManifestEntry>) => { manifest = { ...manifest, ...next }; },
    setBound: (next: boolean) => { bound = next; },
    async admit() {
      await coordinator.install("agent-1", handle, "generation-1");
      await coordinator.drainCallbacks();
      custody.installLiveBinding("agent-1", {
        agentSessionId: "session-1", executionGenerationId: "generation-1", updatedAt: "2026-08-26T00:00:00.000Z",
      });
      assert.ok(tick, "the admitted birth has its heartbeat");
    },
    async beat() {
      tick!();
      await coordinator.drainCallbacks();
    },
  };
}

test("a running agent whose live handle ended still gets its credential checks and is handed to convergence", async () => {
  for (const ended of ["failed", "stopped"] as const) {
    for (const rotationDue of [true, false]) {
      const { handle, set } = latchingHandle();
      const harness = heartbeatHarness(handle, rotationDue);
      try {
        await harness.admit();
        await harness.beat();
        assert.deepEqual(harness.counts, {
          convergence: rotationDue ? 1 : 0, liveness: rotationDue ? 0 : 1, probes: 1, rotationChecks: 1,
        }, "a healthy handle asks for a due rotation, and otherwise announces itself");

        // The runtime ends with no fact reaching the manifest.
        set(ended);
        assert.equal(harness.entry().observed_state, "working");
        await harness.beat();
        assert.equal(harness.counts.rotationChecks, 2, `${ended}: the bearer is still checked for rotation`);
        assert.equal(harness.counts.convergence, rotationDue ? 2 : 1,
          `${ended}: one heartbeat later the daemon asks convergence to rotate the bearer or replace the runtime`);
        assert.equal(harness.counts.liveness, rotationDue ? 0 : 1, `${ended}: an ended runtime is not announced as live`);
        assert.equal(harness.counts.probes, 1, `${ended}: an ended runtime is not probed`);
      } finally {
        await harness.coordinator.disposeAll();
      }
    }
  }
});

test("an ended handle under a recovering entry is handed to convergence too", async () => {
  const { handle, set } = latchingHandle();
  const harness = heartbeatHarness(handle, false);
  try {
    await harness.admit();
    harness.setEntry({ observed_state: "recovering", condition: "coordination_blocked",
      last_error: "Restoring room access (attempt 1 of 3) failed. Retrying automatically." });
    await harness.beat();
    assert.deepEqual(harness.counts, { convergence: 0, liveness: 0, probes: 0, rotationChecks: 1 },
      "a healthy runtime that is recovering only keeps its credentials current");
    set("failed");
    await harness.beat();
    assert.equal(harness.counts.convergence, 1, "its ended runtime still has to be replaced");
    assert.equal(harness.counts.liveness, 0);
  } finally {
    await harness.coordinator.disposeAll();
  }
});

test("an ended handle is handed to convergence at doubling gaps, and not at all without a room binding", async () => {
  const { handle, set } = latchingHandle();
  const harness = heartbeatHarness(handle, false);
  try {
    await harness.admit();
    set("failed");
    const askedOn: number[] = [];
    for (let beat = 1; beat <= 100; beat += 1) {
      const before = harness.counts.convergence;
      await harness.beat();
      if (harness.counts.convergence > before) askedOn.push(beat);
    }
    assert.deepEqual(askedOn, [1, 2, 4, 8, 16, 32, 52, 72, 92],
      "at once, then at doubling gaps, then every twentieth heartbeat: never on every one");

    // The gap belongs to one ending. A runtime that worked again and then
    // ends again is handed off at once, not twelve heartbeats later.
    const beforeRecovery = harness.counts.convergence;
    set("idle");
    await harness.beat();
    set("failed");
    await harness.beat();
    assert.equal(harness.counts.convergence, beforeRecovery + 1, "a runtime that ends again starts from the first gap");
    // Seven more heartbeats: handed off on the second, fourth and eighth, so
    // the next one is not due for another eight.
    for (let beat = 0; beat < 7; beat += 1) await harness.beat();
    assert.equal(harness.counts.convergence, beforeRecovery + 4);

    // Room access was given up, or ended on purpose: there is no binding, and
    // convergence would only mint a session for a runtime it never reaches.
    harness.setBound(false);
    const unbound = harness.counts.convergence;
    for (let beat = 0; beat < 40; beat += 1) await harness.beat();
    assert.equal(harness.counts.convergence, unbound, "no hand-off while the agent has no room binding");

    harness.setBound(true);
    await harness.beat();
    assert.equal(harness.counts.convergence, unbound + 1,
      "a restored binding is handed off on the next heartbeat, not after the gap that was pending before");
  } finally {
    await harness.coordinator.disposeAll();
  }
});

test("an ended handle of an agent that needs no desktop grant is handed to convergence as well", async () => {
  const { handle, set } = latchingHandle();
  const harness = heartbeatHarness(handle, false, false);
  try {
    await harness.admit();
    set("failed");
    await harness.beat();
    assert.deepEqual(harness.counts, { convergence: 1, liveness: 0, probes: 0, rotationChecks: 0 },
      "its room binding is what the hand-off needs, whether or not its credentials come from a grant");
    harness.setBound(false);
    for (let beat = 0; beat < 5; beat += 1) await harness.beat();
    assert.equal(harness.counts.convergence, 1, "and without a binding there is none");
  } finally {
    await harness.coordinator.disposeAll();
  }
});

test("a handle that is starting or stopping is left to its lifecycle owner", async () => {
  for (const state of ["starting", "stopping"] as const) {
    const { handle, set } = latchingHandle();
    const harness = heartbeatHarness(handle, true);
    try {
      await harness.admit();
      set(state);
      await harness.beat();
      assert.deepEqual(harness.counts, { convergence: 0, liveness: 0, probes: 0, rotationChecks: 0 }, state);
    } finally {
      await harness.coordinator.disposeAll();
    }
  }
});

test("a room that refuses the worker bearer is shown to the owner and asks the supervisor for nothing, until the refusal ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-refused-bearer-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let answer: "transport" | "ok" | 401 | 403 = "ok";
  /** How long an accepted poll stays open, as a long poll does. */
  let acceptedPollMs = 5;
  const polledWith: string[] = [];
  const wakes: string[] = [];
  /** Whether the lane still reported the refusal at the moment it woke convergence. */
  const refusedWhenWoken: boolean[] = [];
  const delays: number[] = [];
  /** A poll sent with this bearer stays open until released, then is refused. */
  let heldBearer: string | null = null;
  let releaseHeldPoll: (() => void) | null = null;
  const delivery: SupervisedAgentDelivery = new SupervisedAgentDelivery(store, roomTurnPort(async () => { throw new Error("not used"); }), {
    poll: async ({ bearer, signal }) => {
      polledWith.push(bearer);
      if (bearer === heldBearer) {
        await new Promise<void>((resolve) => {
          releaseHeldPoll = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new SupervisedRoomAuthorizationError("Supervised room poll failed with HTTP 401.", 401);
      }
      if (answer === "transport") throw new Error("Supervised room poll failed with HTTP 503.");
      if (answer !== "ok") throw new SupervisedRoomAuthorizationError(`Supervised room poll failed with HTTP ${answer}.`, answer);
      await pause(acceptedPollMs, signal);
      return {};
    },
    publish: async () => { throw new Error("not used"); },
  }, async () => true, 10, undefined,
  // Keep the loop's real backoff arithmetic but not its wall-clock waits.
  (delayMs, signal) => { delays.push(delayMs); return pause(2, signal); },
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  (agentId) => { wakes.push(agentId); refusedWhenWoken.push(delivery.roomRefusesAccess(agentId)); });
  const health = async () => (await store.ingressHealth("agent-1"));
  const refused = () => delivery.roomRefusesAccess("agent-1");
  const pollsMore = async (count: number) => {
    const from = polledWith.length;
    assert.ok(await eventually(() => polledWith.length >= from + count), "the poll loop keeps running");
  };
  try {
    await store.bootstrapCursor({ agent_id: "agent-1", room_id: "room-1", last_observed_message_id: "0" });
    await delivery.start(deliveryAgent(null));

    await pollsMore(4);
    assert.deepEqual(wakes, [], "an accepted poll with no refusal standing asks for nothing");

    answer = "transport";
    await pollsMore(3);
    assert.equal((await health())?.state, "backoff", "a transport or server failure is only retried");
    assert.equal(refused(), false);

    answer = 401;
    await pollsMore(4);
    assert.deepEqual(await health().then((row) => [row?.state, row?.detail]), ["blocked", ROOM_REFUSED_ACCESS_DETAIL],
      "the owner is told the room refused the agent, not that it is reconnecting");
    assert.equal(refused(), true, "the supervisor can see that the room refuses this bearer");
    const failedPollDelays = () => delays.filter((delay) => delay >= 250);
    assert.ok(await eventually(() => failedPollDelays().length >= 7), "the failed polls are paced");
    assert.deepEqual(failedPollDelays().slice(0, 7), [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000],
      "a refusal is one more failed poll: the backoff keeps growing across it");

    // The room cannot be reached for a while: its refusal still stands.
    answer = "transport";
    await pollsMore(3);
    assert.deepEqual([(await health())?.state, refused()], ["blocked", true], "only an accepted poll ends a refusal");
    assert.deepEqual(wakes, [], "a refusal asks convergence for nothing, however long it stands");

    // A bearer rotated on its schedule is adopted in place. Accepted polls now
    // stay open long enough that nothing below is decided by a later poll.
    answer = "ok";
    acceptedPollMs = 300;
    await delivery.refresh({ ...deliveryAgent(null), bearer: "bearer-2" });
    assert.equal(refused(), false, "the refusal was of the bearer the lane gave up, before any poll with the new one");
    assert.deepEqual(wakes, ["agent-1"], "the end of a standing refusal wakes convergence once: a runtime that ended meanwhile is due its replacement");
    assert.ok(await eventually(async () => (await health())?.state === "observing"), "the rotated bearer observes the room again");
    assert.equal(polledWith.at(-1), "bearer-2");

    // The server revokes the old bearer at a rotation. A long poll sent with
    // it is refused after the lane already holds the new one.
    heldBearer = "bearer-2";
    assert.ok(await eventually(() => releaseHeldPoll !== null), "a poll with the second bearer is open");
    await delivery.refresh({ ...deliveryAgent(null), bearer: "bearer-3" });
    releaseHeldPoll!();
    assert.ok(await eventually(() => polledWith.at(-1) === "bearer-3"), "the next poll uses the adopted bearer");
    assert.equal(refused(), false, "a refusal of a bearer the lane no longer holds is not a refusal of the agent");
    assert.notEqual((await health())?.state, "blocked");
    assert.deepEqual(wakes, ["agent-1"], "adopting a bearer or having a poll accepted wakes nothing when no refusal stood");

    answer = 403;
    acceptedPollMs = 5;
    await pollsMore(4);
    assert.equal((await health())?.state, "blocked");
    assert.equal(refused(), true, "a newly refused bearer is reported again");

    assert.deepEqual(wakes, ["agent-1"]);

    // The room accepts the same bearer again: the refusal is over.
    answer = "ok";
    assert.ok(await eventually(async () => (await health())?.state === "observing"));
    assert.equal(refused(), false);
    await pollsMore(4);
    assert.deepEqual(wakes, ["agent-1", "agent-1"], "the accepted poll that ends a refusal wakes convergence once; the polls after it do not");
    assert.deepEqual(refusedWhenWoken, [false, false], "the refusal is already over when convergence is woken");

    answer = 401;
    assert.ok(await eventually(refused));
    await delivery.stop("agent-1");
    assert.equal(refused(), false, "a stopped lane holds no refusal");
  } finally {
    await delivery.fenceAndDrain().catch(() => undefined);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the production room poll tells a refused bearer apart from any other failure", async () => {
  const previousFetch = globalThis.fetch;
  const poll = () => productionSupervisedDeliveryHttp.poll({
    roomId: "room-1", apiUrl: "https://letagents.test", bearer: "worker-secret",
    afterMessageId: null, signal: new AbortController().signal,
  });
  try {
    for (const status of [401, 403] as const) {
      globalThis.fetch = (async () => new Response("{}", { status })) as typeof fetch;
      await assert.rejects(poll(), (error: unknown) => error instanceof SupervisedRoomAuthorizationError
        && error.status === status && error.message === `Supervised room poll failed with HTTP ${status}.`);
    }
    for (const status of [404, 429, 500, 503]) {
      globalThis.fetch = (async () => new Response("{}", { status })) as typeof fetch;
      await assert.rejects(poll(), (error: unknown) => !(error instanceof SupervisedRoomAuthorizationError)
        && error instanceof Error && error.message === `Supervised room poll failed with HTTP ${status}.`);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
