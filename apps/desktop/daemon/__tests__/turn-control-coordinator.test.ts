import assert from "node:assert/strict";
import test from "node:test";

import {
  TurnControlCoordinator,
  type TurnControlCoordinatorPorts,
  type TurnControlInput,
} from "../turn-control-coordinator.js";
import type { SupervisedInboxItem } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, DaemonManifestEntryView } from "../types.js";

const NOW_ISO = "2026-08-26T10:00:00.000Z";

test("input validation happens before concurrency admission and normalizes corrections", async () => {
  const harness = fixture();

  assert.throws(
    () => harness.subject.control({ ...turnInput(), actionId: "spaces are forbidden" }),
    /letters, numbers/,
  );
  assert.throws(
    () => harness.subject.control({ ...turnInput(), correction: "x".repeat(32 * 1024 + 1) }),
    /32 KiB/,
  );
  assert.throws(
    () => harness.subject.control({ ...turnInput(), daemonGeneration: 0 }),
    /positive safe integer/,
  );
  assert.equal(harness.admissions, 0);

  const pending = deferred<void>();
  harness.assertCurrent = () => pending.promise;
  const first = harness.subject.control({ ...turnInput(), correction: "  redirect  " });
  const duplicate = harness.subject.control({ ...turnInput(), correction: "redirect" });
  assert.strictEqual(first, duplicate, "normalization occurs before in-flight request dedupe");
  pending.reject(new Error("stop fixture"));
  await assert.rejects(first, /stop fixture/);
});

test("in-flight actions dedupe exact fenced input and reject action-id reuse", async () => {
  const harness = fixture();
  const pending = deferred<void>();
  harness.assertCurrent = () => pending.promise;

  const first = harness.subject.control(turnInput());
  const duplicate = harness.subject.control(turnInput());
  assert.strictEqual(first, duplicate);
  assert.equal(harness.admissions, 1, "one entry turn-control lease is acquired");
  assert.throws(
    () => harness.subject.control({ ...turnInput(), sourceMessageId: "other-message" }),
    /reused with different fenced input/,
  );

  pending.reject(new Error("stop fixture"));
  await assert.rejects(first, /stop fixture/);
  assert.equal(harness.releases, 1, "the turn-control lease is released exactly once");
});

test("new actions use an isolated 24-per-minute budget that recovers at the exact window", () => {
  let now = 1_000_000;
  const first = fixture({ nowMs: () => now });

  for (let index = 0; index < 24; index += 1) first.subject.admitNew("agent-1");
  assert.throws(() => first.subject.admitNew("agent-1"), /temporarily rate limited/);
  assert.doesNotThrow(() => first.subject.admitNew("agent-2"));

  now += 60_000;
  assert.doesNotThrow(
    () => first.subject.admitNew("agent-1"),
    "timestamps at the cutoff are outside the strict rolling window",
  );
});

test("a completed durable action returns its exact outcome without touching runtime custody", async () => {
  const completed = entry({
    turn_control: {
      action_id: "action-1",
      action_sequence: 3,
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
      target_room_id: "room-1",
      target_source_message_id: "message-1",
      target_provider_continuation_id: "continuation-1",
      inbox_item_id: "inbox-1",
      provider_turn_id: "turn-1",
      has_correction: false,
      correction_text: null,
      correction_strategy: null,
      operator_resolution: null,
      status: "completed",
      capability: "native_interrupt",
      interrupted: true,
      resumed: false,
      state: "idle",
      stages: ["delivered", "interrupting", "applied"],
      error: null,
      recorded_at: NOW_ISO,
      updated_at: NOW_ISO,
    },
  });
  const harness = fixture({ manifestEntry: completed });

  const result = await harness.subject.control(turnInput());

  assert.deepEqual(result, {
    entryId: "agent-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "execution-1",
    actionId: "action-1",
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
    duplicate: true,
    stages: ["delivered", "interrupting", "applied"],
  });
  assert.equal(harness.attachments, 0);
  assert.equal(harness.bindingReads, 0);
  assert.equal(harness.releases, 1);
});

test("completed operator resolution is idempotent but rejects the opposite answer", async () => {
  const resolved = entry({
    turn_control: {
      action_id: "action-1",
      action_sequence: 3,
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
      target_room_id: "room-1",
      target_source_message_id: "message-1",
      target_provider_continuation_id: "continuation-1",
      inbox_item_id: "inbox-1",
      provider_turn_id: "turn-1",
      has_correction: false,
      correction_text: null,
      correction_strategy: null,
      operator_resolution: "applied",
      status: "completed",
      capability: "native_interrupt",
      interrupted: true,
      resumed: false,
      state: "idle",
      stages: ["already_applied"],
      error: null,
      recorded_at: NOW_ISO,
      updated_at: NOW_ISO,
    },
  });
  const harness = fixture({ manifestEntry: resolved });

  const projected = await harness.subject.resolve({
    entryId: "agent-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "execution-1",
    actionId: "action-1",
    resolution: "applied",
  });
  assert.equal(projected.id, "agent-1");
  assert.equal(harness.projections, 1);

  await assert.rejects(harness.subject.resolve({
    entryId: "agent-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "execution-1",
    actionId: "action-1",
    resolution: "not_applied",
  }), /different operator resolution/);
});

test("native stop preserves prepare-dispatch-provider-commit-delivery ordering", async () => {
  const events: string[] = [];
  let generation = 7;
  let current = entry();
  const handle = {
    workAttemptId: "attempt-1",
    providerContinuationId: "continuation-1",
    providerConnection: null,
    pid: null,
    observedState: "working" as const,
  };
  const ports: TurnControlCoordinatorPorts = {
    authority: {
      currentGeneration: () => 7,
      assertCurrent: async () => { events.push("authority"); },
      manifestGeneration: () => generation,
      setManifestGeneration: (next) => { generation = next; },
      fenceCommit: async (commit) => commit(),
    },
    store: {
      getEntry: async () => current,
      load: async () => ({ generation, entries: [current] }),
      prepareTurnControlState: async (_expected, input) => {
        events.push("journal.prepare");
        current = {
          ...current,
          turn_control: {
            action_id: input.actionId,
            action_sequence: input.actionSequence,
            work_attempt_id: input.workAttemptId,
            execution_generation_id: input.executionGenerationId,
            target_room_id: input.roomId,
            target_source_message_id: input.expectedSourceMessageId,
            target_provider_continuation_id: input.providerContinuationId,
            inbox_item_id: input.expectedInboxItemId,
            provider_turn_id: input.expectedProviderTurnId,
            has_correction: input.hasCorrection,
            correction_text: input.correctionText,
            correction_strategy: input.correctionStrategy,
            operator_resolution: null,
            status: "prepared",
            capability: input.capability,
            interrupted: null,
            resumed: null,
            state: null,
            stages: [],
            error: null,
            recorded_at: input.recordedAt,
            updated_at: input.recordedAt,
          },
        };
        generation += 1;
        return {
          generation,
          entry: current,
          linkedInboxItemId: "inbox-1",
          providerTurnId: "turn-1",
          linkedState: "awaiting_result",
        };
      },
      checkpointTurnControlTarget: async () => { throw new Error("unexpected target checkpoint"); },
      commitTurnControlState: async (_expected, _input, buildEntry) => {
        events.push("journal.commit");
        current = buildEntry(current, {
          original: "cancelled",
          inboxItemId: "inbox-1",
          correctionInboxItemId: null,
          providerTurnId: "turn-1",
        });
        generation += 1;
        return {
          generation,
          entry: current,
          original: "cancelled",
          correctionInboxItemId: null,
          providerTurnId: "turn-1",
        };
      },
    },
    durability: {
      getAttempt: async () => attempt(),
    },
    workerBindings: {
      get: async () => ({
        entry_id: "agent-1",
        room_id: "room-1",
        work_attempt_id: "attempt-1",
        execution_generation_id: "execution-1",
        agent_session_id: "session-1",
        credential_ref: "credential-1",
        api_url: "https://letagents.test",
        room_cursor: null,
        last_sequence: 0,
        last_observed_at_ms: 0,
        updated_at: NOW_ISO,
      }),
    },
    inbox: { get: async () => null, nativeFailure: async () => null },
    delivery: {
      activeTurn: () => null,
      captureActiveDeliveryInterrupt: (agent, actionId) => {
        events.push("delivery.capture");
        return {
          reservationId: 1,
          invocationId: 1,
          actionId,
          inboxItemId: "inbox-1",
          providerTurnId: "turn-1",
          agent,
        };
      },
      finishActiveDeliveryInterrupt: (_reservation, disposition) => {
        events.push(`delivery.finish:${disposition}`);
      },
      finishActiveDeliveryInterruptByAction: () => false,
      prepareActiveDeliveryInterrupt: async () => {
        events.push("delivery.prepare");
        return "interruptible";
      },
      resolveActiveDeliveryInterrupt: (_reservation, disposition) => {
        events.push(`delivery.resolve:${disposition}`);
      },
    },
    providerPort: {
      capabilities: async () => capabilities(),
      controlTurn: async (_handle, correction, options) => {
        assert.equal(correction, null);
        events.push("provider.begin");
        await options?.markDispatched?.();
        events.push("provider.applied");
        return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
      },
    },
    entryConcurrency: {
      beginTurnControl: () => () => { events.push("admission.release"); },
    },
    currentHandle: () => handle,
    attachLiveProvider: async () => { throw new Error("unexpected attach"); },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async (operation) => operation(),
    updateManifestEntry: async (_entryId, update) => {
      current = update(current);
      events.push(`journal.${current.turn_control?.status}`);
      return current;
    },
    entryWithDerivedLiveness: async (item) => item as DaemonManifestEntryView,
    wakeDelivery: async () => { events.push("delivery.wake"); },
    scheduleRecovery: () => { events.push("recovery.schedule"); },
    requestConvergence: () => { events.push("convergence.request"); },
    nowMs: () => 1_000,
  };

  const result = await new TurnControlCoordinator(ports).control(turnInput());

  assert.deepEqual(result, {
    entryId: "agent-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "execution-1",
    actionId: "action-1",
    duplicate: false,
    stages: ["delivered", "interrupting", "applied"],
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.deepEqual(events, [
    "authority",
    "authority",
    "journal.prepare",
    "delivery.capture",
    "provider.begin",
    "journal.dispatching",
    "provider.applied",
    "delivery.prepare",
    "authority",
    "journal.commit",
    "delivery.finish:cancelled",
    "admission.release",
  ]);
});

test("target-turn checkpoint is fenced by the exact live handle on both sides", async () => {
  const harness = effectFixture({ checkpointHandleSwap: true });

  await assert.rejects(harness.subject.control(turnInput()), /provider changed after exact target checkpoint/);

  assert.deepEqual(harness.checkpointedTurns, ["turn-checkpointed"]);
  assert.equal(harness.current.turn_control?.status, "retryable");
  assert.deepEqual(harness.deliveryDecisions, ["resolve:resume"]);
  assert.equal(harness.providerCalls, 1);
});

test("daemon-inbox correction is stop-then-resend while a legacy lane keeps native correction", async () => {
  const daemonInbox = effectFixture({ deliveryMode: "daemon_inbox" });
  const daemonResult = await daemonInbox.subject.control({ ...turnInput(), correction: "redirect" });
  assert.deepEqual(daemonInbox.nativeCorrections, [null]);
  assert.deepEqual(daemonInbox.preparedStrategies, ["stop_then_resend"]);
  assert.deepEqual(daemonInbox.commitActivations, [true]);
  assert.equal(daemonResult.resumed, true, "durable correction activation is the resumed outcome");

  const legacy = effectFixture({ deliveryMode: "mcp_polling" });
  await legacy.subject.control({ ...turnInput(), correction: "redirect" });
  assert.deepEqual(legacy.nativeCorrections, ["redirect"]);
  assert.deepEqual(legacy.preparedStrategies, ["native"]);
  assert.deepEqual(legacy.commitActivations, [false]);
});

test("provider uncertain freezes while explicit not-applied resumes, and both redact durable errors", async () => {
  for (const [outcome, expectedStatus, expectedDecision] of [
    ["uncertain", "uncertain", "resolve:freeze"],
    ["not_applied", "retryable", "resolve:resume"],
  ] as const) {
    const harness = effectFixture({ providerFailure: outcome });
    await assert.rejects(harness.subject.control(turnInput()), /secret-token/);
    assert.equal(harness.current.turn_control?.status, expectedStatus);
    assert.equal(harness.current.turn_control?.error?.includes("secret-token"), false);
    assert.deepEqual(harness.deliveryDecisions, [expectedDecision]);
  }
});

test("a missing exact FIFO reservation becomes retryable without native latest-turn dispatch", async () => {
  const harness = effectFixture({ missingReservation: true });

  await assert.rejects(
    harness.subject.control(turnInput()),
    /waiting for its exact admitted FIFO invocation/,
  );

  assert.equal(harness.current.turn_control?.status, "retryable");
  assert.equal(harness.providerCalls, 0);
  assert.equal(harness.wakes, 1);
  assert.equal(harness.convergenceRequests, 1);
});

test("interrupt preparation failure freezes the reservation and journals uncertainty", async () => {
  const harness = effectFixture({ interruptPrepareFailure: true });

  await assert.rejects(harness.subject.control(turnInput()), /interrupt preparation failed/);

  assert.deepEqual(harness.deliveryDecisions, ["finish:freeze"]);
  assert.equal(harness.current.turn_control?.status, "uncertain");
  assert.match(harness.current.turn_control?.error ?? "", /interrupt preparation failed/);
  assert.equal(harness.commits, 0, "the manifest/FIFO completion never runs after failed interrupt preparation");
});

test("post-COMMIT prepare and completion errors recover from exact durable readback", async () => {
  const harness = effectFixture({ preparePostCommitError: true, commitPostCommitError: true });

  const result = await harness.subject.control(turnInput());

  assert.equal(result.duplicate, false);
  assert.equal(result.interrupted, true);
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.prepares, 1);
  assert.equal(harness.commits, 1);
  assert.equal(harness.current.turn_control?.status, "completed");
  assert.deepEqual(harness.deliveryDecisions, ["finish:cancelled"]);
});

test("an exact failed terminal wins Stop without native dispatch, cancellation, or replay", async () => {
  for (const nativeFailure of ["failed", "interrupted"] as const) {
    for (const commitPostCommitError of [false, true]) {
      const harness = effectFixture({ nativeFailure, missingReservation: true, commitPostCommitError });

      const result = await harness.subject.control(turnInput());

      assert.equal(result.interrupted, false, "Stop did not interrupt an already ended turn");
      assert.equal(result.resumed, false, "failed work is not replayed");
      assert.equal(harness.providerCalls, 0, "no latest native turn may be stopped");
      assert.equal(harness.commits, 1);
      assert.equal(harness.current.turn_control?.status, "completed");
      assert.match(harness.current.activity?.at(-1)?.summary ?? "", /ended unsuccessfully/);
      assert.doesNotMatch(harness.current.activity?.at(-1)?.summary ?? "", /reply stands|cancelled/);
      assert.equal(harness.deliveryDecisions.every((decision) => decision === "finish:resume"), true,
        "release the reservation only for terminal fast-forward, never cancel or freeze it");
    }
  }
});

test("an exact terminal wins a race with native Stop without claiming Stop caused the failure", async () => {
  const harness = effectFixture({ nativeFailure: "failed" });

  const result = await harness.subject.control(turnInput());

  assert.equal(harness.providerCalls, 1, "the Stop was already sent to the exact native turn");
  assert.equal(result.interrupted, false, "the durable native terminal, not Stop, owns the outcome");
  assert.equal(result.resumed, false);
  assert.deepEqual(harness.deliveryDecisions, ["finish:resume"]);
  assert.match(harness.current.activity?.at(-1)?.summary ?? "", /ended unsuccessfully/);
});

test("uncertain Stop resolution preserves exact native failure even after completion readback", async () => {
  for (const resolution of ["applied", "not_applied"] as const) {
    const harness = effectFixture({
      nativeFailure: "interrupted", providerFailure: "uncertain", commitPostCommitError: true,
    });
    await assert.rejects(() => harness.subject.control(turnInput()), /secret-token/);

    const resolved = await harness.subject.resolve({
      entryId: "agent-1", workAttemptId: "attempt-1", executionGenerationId: "execution-1",
      actionId: "action-1", resolution,
    });

    assert.equal(resolved.turn_control?.status, "completed");
    assert.equal(resolved.turn_control?.interrupted, false);
    assert.equal(resolved.turn_control?.resumed, false);
    assert.match(resolved.turn_control?.error ?? "", /terminal outcome was preserved, not cancelled or replayed/);
    assert.equal(harness.providerCalls, 1, "operator resolution never invokes a new native effect");
    assert.match(resolved.activity?.at(-1)?.summary ?? "", /ended unsuccessfully/);
  }
});

test("a correction after an exact failed terminal queues only the new instruction", async () => {
  const harness = effectFixture({ nativeFailure: "failed", missingReservation: true });

  const result = await harness.subject.control({ ...turnInput(), correction: "use the revised approach" });

  assert.equal(result.interrupted, false);
  assert.equal(result.resumed, true, "only the durable correction was activated");
  assert.equal(harness.providerCalls, 0);
  assert.deepEqual(harness.commitActivations, [true]);
  assert.match(harness.current.activity?.at(-1)?.summary ?? "", /ended unsuccessfully.*correction queued/);
});

test("historical terminal execution permits exact uncertain operator resolution", async () => {
  const control = {
    action_id: "action-1",
    action_sequence: 3,
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-old",
    target_room_id: "room-1",
    target_source_message_id: "message-1",
    target_provider_continuation_id: "continuation-1",
    inbox_item_id: "inbox-1",
    provider_turn_id: "turn-1",
    has_correction: false,
    correction_text: null,
    correction_strategy: null,
    operator_resolution: null,
    status: "uncertain" as const,
    capability: "native_interrupt" as const,
    interrupted: null,
    resumed: null,
    state: null,
    stages: [],
    error: "ambiguous",
    recorded_at: NOW_ISO,
    updated_at: NOW_ISO,
  };
  let current = entry({
    provider_ref: { ...entry().provider_ref!, execution_generation_id: "execution-new" },
    turn_control: control,
  });
  let committedMode: string | null = null;
  let recoveryScheduled = 0;
  let convergenceRequested = 0;
  const base = fixture({ manifestEntry: current });
  const ports = base.ports;
  ports.durability.getAttempt = async () => ({
    ...attempt(),
    execution_generations: [{
      ...attempt().execution_generations[0]!,
      execution_generation_id: "execution-old",
      terminal: {
        ended_at: NOW_ISO,
        exit_code: 0,
        signal: null,
        stdio_archive_ref: null,
        stdio_tail: "",
        terminal_cause: "stopped",
        actor: "daemon-provider",
        generation: 1,
        provider_continuation_id: "continuation-1",
      },
    }],
  });
  ports.store.getEntry = async () => current;
  ports.store.load = async () => ({ generation: 8, entries: [current] });
  ports.store.commitTurnControlState = async (_generation, input, buildEntry) => {
    committedMode = input.mode;
    current = buildEntry(current, {
      original: "none",
      inboxItemId: "inbox-1",
      correctionInboxItemId: null,
      providerTurnId: "turn-1",
    });
    return { generation: 9, entry: current, original: "none", correctionInboxItemId: null, providerTurnId: "turn-1" };
  };
  ports.wakeDelivery = async () => { throw new Error("wake unavailable"); };
  ports.scheduleRecovery = () => { recoveryScheduled += 1; };
  ports.requestConvergence = () => { convergenceRequested += 1; };
  const subject = new TurnControlCoordinator(ports);

  const resolved = await subject.resolve({
    entryId: "agent-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "execution-old",
    actionId: "action-1",
    resolution: "applied",
  });

  assert.equal(committedMode, "operator_applied");
  assert.equal(resolved.turn_control?.status, "completed");
  assert.equal(recoveryScheduled, 1, "failed wake schedules bounded delivery recovery");
  assert.equal(convergenceRequested, 1, "durable resolution always requests runtime convergence");
});

type Harness = ReturnType<typeof fixture>;

function effectFixture(options: {
  deliveryMode?: "daemon_inbox" | "mcp_polling";
  checkpointHandleSwap?: boolean;
  missingReservation?: boolean;
  providerFailure?: "uncertain" | "not_applied";
  interruptPrepareFailure?: boolean;
  preparePostCommitError?: boolean;
  commitPostCommitError?: boolean;
  nativeFailure?: "failed" | "interrupted";
} = {}) {
  const deliveryMode = options.deliveryMode ?? "daemon_inbox";
  let current = entry({ delivery_mode: deliveryMode });
  let generation = 7;
  const handle = {
    workAttemptId: "attempt-1",
    providerContinuationId: "continuation-1",
    providerConnection: null,
    pid: null,
    observedState: "working" as const,
  };
  let activeHandle = handle;
  let providerCalls = 0;
  let prepares = 0;
  let commits = 0;
  let wakes = 0;
  let convergenceRequests = 0;
  const checkpointedTurns: string[] = [];
  const nativeCorrections: Array<string | null> = [];
  const preparedStrategies: Array<"native" | "stop_then_resend" | null> = [];
  const commitActivations: boolean[] = [];
  const deliveryDecisions: string[] = [];

  const ports: TurnControlCoordinatorPorts = {
    authority: {
      currentGeneration: () => 7,
      assertCurrent: async () => undefined,
      manifestGeneration: () => generation,
      setManifestGeneration: (next) => { generation = next; },
      fenceCommit: async (commit) => commit(),
    },
    store: {
      getEntry: async () => current,
      load: async () => ({ generation, entries: [current] }),
      prepareTurnControlState: async (_expected, input) => {
        prepares += 1;
        const linkedInboxItemId = deliveryMode === "daemon_inbox" ? input.expectedInboxItemId : null;
        const providerTurnId = deliveryMode === "daemon_inbox" ? input.expectedProviderTurnId : null;
        preparedStrategies.push(input.correctionStrategy);
        current = {
          ...current,
          turn_control: {
            action_id: input.actionId,
            action_sequence: input.actionSequence,
            work_attempt_id: input.workAttemptId,
            execution_generation_id: input.executionGenerationId,
            target_room_id: input.roomId,
            target_source_message_id: input.expectedSourceMessageId,
            target_provider_continuation_id: input.providerContinuationId,
            inbox_item_id: linkedInboxItemId,
            provider_turn_id: providerTurnId,
            has_correction: input.hasCorrection,
            correction_text: input.correctionText,
            correction_strategy: input.correctionStrategy,
            operator_resolution: null,
            status: "prepared",
            capability: input.capability,
            interrupted: null,
            resumed: null,
            state: null,
            stages: [],
            error: null,
            recorded_at: input.recordedAt,
            updated_at: input.recordedAt,
          },
        };
        generation += 1;
        if (options.preparePostCommitError) throw new Error("prepare transport failed after commit");
        return { generation, entry: current, linkedInboxItemId, providerTurnId, linkedState: "awaiting_result" };
      },
      checkpointTurnControlTarget: async (_expected, input) => {
        checkpointedTurns.push(input.providerTurnId);
        current = {
          ...current,
          turn_control: { ...current.turn_control!, provider_turn_id: input.providerTurnId },
        };
        generation += 1;
        if (options.checkpointHandleSwap) {
          activeHandle = { ...handle, providerContinuationId: "continuation-replacement" };
        }
        return { generation, entry: current };
      },
      commitTurnControlState: async (_expected, input, buildEntry) => {
        commits += 1;
        commitActivations.push(input.activateCorrection);
        const linkedInboxItemId = deliveryMode === "daemon_inbox" ? "inbox-1" : null;
        const original = deliveryMode !== "daemon_inbox" ? "none" as const
          : options.nativeFailure ? "terminal_won" as const : "cancelled" as const;
        current = buildEntry(current, {
          original,
          inboxItemId: linkedInboxItemId,
          correctionInboxItemId: input.activateCorrection ? "correction-1" : null,
          providerTurnId: deliveryMode === "daemon_inbox" ? "turn-1" : null,
        });
        generation += 1;
        if (options.commitPostCommitError) throw new Error("commit transport failed after commit");
        return {
          generation,
          entry: current,
          original,
          correctionInboxItemId: input.activateCorrection ? "correction-1" : null,
          providerTurnId: deliveryMode === "daemon_inbox" ? "turn-1" : null,
        };
      },
    },
    durability: { getAttempt: async () => attempt() },
    workerBindings: {
      get: async () => ({
        entry_id: "agent-1",
        room_id: "room-1",
        work_attempt_id: "attempt-1",
        execution_generation_id: "execution-1",
        agent_session_id: "session-1",
        credential_ref: "credential-1",
        api_url: "https://letagents.test",
        room_cursor: null,
        last_sequence: 0,
        last_observed_at_ms: 0,
        updated_at: NOW_ISO,
      }),
    },
    inbox: {
      get: async () => inboxItem(options.nativeFailure ? "acknowledged_failed"
        : current.turn_control?.status === "completed" ? "cancelled_by_user" : "awaiting_result"),
      nativeFailure: async () => options.nativeFailure ?? null,
    },
    delivery: {
      activeTurn: () => null,
      captureActiveDeliveryInterrupt: (agent, actionId) => options.missingReservation
        ? null
        : {
          reservationId: 1,
          invocationId: 1,
          actionId,
          inboxItemId: "inbox-1",
          providerTurnId: "turn-1",
          agent,
        },
      finishActiveDeliveryInterrupt: (_reservation, disposition) => {
        deliveryDecisions.push(`finish:${disposition}`);
      },
      finishActiveDeliveryInterruptByAction: () => false,
      prepareActiveDeliveryInterrupt: async () => {
        if (options.interruptPrepareFailure) throw new Error("interrupt preparation failed");
        return "interruptible";
      },
      resolveActiveDeliveryInterrupt: (_reservation, disposition) => {
        deliveryDecisions.push(`resolve:${disposition}`);
      },
    },
    providerPort: {
      capabilities: async () => capabilities(),
      controlTurn: async (_providerHandle, nativeCorrection, controlOptions) => {
        providerCalls += 1;
        nativeCorrections.push(nativeCorrection ?? null);
        if (options.checkpointHandleSwap) {
          await controlOptions?.checkpointTurnStarted?.("turn-checkpointed");
        }
        await controlOptions?.markDispatched?.();
        if (options.providerFailure) {
          throw Object.assign(
            new Error("Authorization: Bearer secret-token"),
            { turnControlOutcome: options.providerFailure },
          );
        }
        return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
      },
    },
    entryConcurrency: { beginTurnControl: () => () => undefined },
    currentHandle: () => activeHandle,
    attachLiveProvider: async () => { throw new Error("unexpected attach"); },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async (operation) => operation(),
    updateManifestEntry: async (_entryId, update) => {
      current = update(current);
      return current;
    },
    entryWithDerivedLiveness: async (item) => item as DaemonManifestEntryView,
    wakeDelivery: async () => { wakes += 1; },
    scheduleRecovery: () => undefined,
    requestConvergence: () => { convergenceRequests += 1; },
    nowMs: () => 1_000,
    delay: async () => undefined,
  };

  return {
    subject: new TurnControlCoordinator(ports),
    get current() { return current; },
    get providerCalls() { return providerCalls; },
    get prepares() { return prepares; },
    get commits() { return commits; },
    get wakes() { return wakes; },
    get convergenceRequests() { return convergenceRequests; },
    checkpointedTurns,
    nativeCorrections,
    preparedStrategies,
    commitActivations,
    deliveryDecisions,
  };
}

function fixture(options: {
  manifestEntry?: DaemonManifestEntry;
  nowMs?: () => number;
} = {}) {
  let manifestGeneration = 7;
  let assertCurrent: () => Promise<void> = async () => undefined;
  let admissions = 0;
  let releases = 0;
  let attachments = 0;
  let bindingReads = 0;
  let projections = 0;
  const manifestEntry = options.manifestEntry ?? entry();

  const ports: TurnControlCoordinatorPorts = {
    authority: {
      currentGeneration: () => 7,
      assertCurrent: () => assertCurrent(),
      manifestGeneration: () => manifestGeneration,
      setManifestGeneration: (generation) => { manifestGeneration = generation; },
      fenceCommit: async (commit) => commit(),
    },
    store: {
      getEntry: async () => manifestEntry,
      load: async () => ({ generation: manifestGeneration, entries: [manifestEntry] }),
      checkpointTurnControlTarget: async () => { throw new Error("unexpected checkpoint"); },
      commitTurnControlState: async () => { throw new Error("unexpected commit"); },
      prepareTurnControlState: async () => { throw new Error("unexpected prepare"); },
    },
    durability: {
      getAttempt: async () => { throw new Error("unexpected durability read"); },
    },
    workerBindings: {
      get: async () => { bindingReads += 1; return null; },
    },
    inbox: {
      get: async () => null,
      nativeFailure: async () => null,
    },
    delivery: null,
    providerPort: {
      capabilities: async () => capabilities(),
      controlTurn: async () => { throw new Error("unexpected provider control"); },
    },
    entryConcurrency: {
      beginTurnControl: () => {
        admissions += 1;
        return () => { releases += 1; };
      },
    },
    currentHandle: () => null,
    attachLiveProvider: async () => { attachments += 1; return null; },
    serializeEntry: async (_entryId, operation) => operation(),
    serializeManifest: async (operation) => operation(),
    updateManifestEntry: async (_entryId, update) => update(manifestEntry),
    entryWithDerivedLiveness: async (item) => {
      projections += 1;
      return item as DaemonManifestEntryView;
    },
    wakeDelivery: async () => undefined,
    scheduleRecovery: () => undefined,
    requestConvergence: () => undefined,
    nowMs: options.nowMs,
    delay: async () => undefined,
  };
  const subject = new TurnControlCoordinator(ports);
  return {
    subject,
    ports,
    get admissions() { return admissions; },
    get releases() { return releases; },
    get attachments() { return attachments; },
    get bindingReads() { return bindingReads; },
    get projections() { return projections; },
    set assertCurrent(value: () => Promise<void>) { assertCurrent = value; },
  };
}

function entry(overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent One",
    provider: "codex",
    model: null,
    charter: "Handle room work.",
    desired_state: "running",
    observed_state: "working",
    condition: "none",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "user-1",
    created_at: NOW_ISO,
    work_attempt_id: "attempt-1",
    provider_ref: {
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
      provider_continuation_id: "continuation-1",
      provider_connection: null,
    },
    ...overrides,
  };
}

function turnInput(): TurnControlInput {
  return {
    entryId: "agent-1",
    daemonGeneration: 7,
    roomId: "room-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "execution-1",
    providerContinuationId: "continuation-1",
    providerTurnId: "turn-1",
    inboxItemId: "inbox-1",
    sourceMessageId: "message-1",
    actionId: "action-1",
    actionSequence: 3,
    correction: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function capabilities() {
  return {
    resume: true,
    midTurnInjection: false,
    transcriptAccess: true,
    permissionPromptBridging: false,
    survivesRestart: true,
    turnControl: "native_interrupt" as const,
  };
}

function inboxItem(state: SupervisedInboxItem["state"]): SupervisedInboxItem {
  return {
    inbox_item_id: "inbox-1",
    agent_id: "agent-1",
    room_id: "room-1",
    source_message_id: "message-1",
    source_message: {},
    activation: { decision: "activate", reason: "addressed", addressed: true },
    fifo_sequence: 1,
    state,
    attempt_count: 1,
    action_id: "inbox-action-1",
    reply_client_message_id: "reply-1",
    provider_turn_id: "turn-1",
    outcome: null,
    last_error: null,
    failure_code: null,
    blocked_by_inbox_item_id: null,
    next_attempt_at_ms: null,
    terminal_reason: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    acknowledged_at: state === "cancelled_by_user" ? NOW_ISO : null,
  };
}

function attempt() {
  return {
    work_attempt_id: "attempt-1",
    task_id: "task-1",
    lease_id: "lease-1",
    current_lease_epoch: 1,
    epoch_history: [{ lease_id: "lease-1", epoch: 1, recorded_at: NOW_ISO }],
    workspace_path: "/tmp/attempt-1",
    workspace_identity: {
      repo: "repo",
      remote_url: "https://example.test/repo.git",
      resolved_revision: "a".repeat(40),
      bare_path: "/tmp/repo.git",
    },
    state: "active" as const,
    created_at: NOW_ISO,
    concluded_at: null,
    conclusion_cause: null,
    postmortem_diff: null,
    checkpoints: [],
    execution_generations: [{
      execution_generation_id: "execution-1",
      work_attempt_id: "attempt-1",
      started_at: NOW_ISO,
      actor: "daemon-provider",
      generation: 1,
      terminal: null,
    }],
  };
}
