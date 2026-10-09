import assert from "node:assert/strict";
import test from "node:test";
import { mapEntry } from "../../electron/main/supervisor-daemon.js";
import { agentInspectorOverallState, projectAgentInspector } from "../../renderer/src/domain/agent-inspector.js";

import {
  bindingMatchesRoomAgentGeneration,
  hasExactRoomAgentDeliveryOwner,
  projectRoomAgentManifestEntry,
  RECORD_RESTART_PENDING_DETAIL,
  type RoomAgentStateProjectionInput,
} from "../room-agent-state-projection.js";
import type { SupervisedInboxReceiptWithTimeline } from "../supervised-agent-inbox-store.js";
import { DaemonReadModel } from "../daemon-read-model.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import type { DaemonManifestEntry } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";

const entry: DaemonManifestEntry = {
  id: "agent_1",
  room_id: "room_1",
  display_name: "Agent One",
  provider: "codex",
  model: null,
  charter: "Handle room work.",
  desired_state: "running",
  observed_state: "working",
  condition: "none",
  permission_profile_id: null,
  delivery_mode: "daemon_inbox",
  created_by: "user_1",
  created_at: "2026-08-26T00:00:00.000Z",
  work_attempt_id: "attempt_1",
  provider_ref: {
    work_attempt_id: "attempt_1",
    provider_continuation_id: "continuation_1",
    provider_connection: null,
    execution_generation_id: "generation_1",
  },
  workplace_liveness: {
    state: "reachable",
    observed_at: "2026-08-26T00:00:00.000Z",
    detail: null,
  },
  native_liveness: {
    state: "active",
    observed_at: "2026-08-26T00:01:00.000Z",
    detail: "Provider activity observed.",
  },
};

const binding: WorkerSessionBinding = {
  entry_id: entry.id,
  room_id: entry.room_id,
  work_attempt_id: "attempt_1",
  execution_generation_id: "generation_1",
  agent_session_id: "session_1",
  credential_ref: "credential_ref_1",
  api_url: "https://letagents.chat",
  room_cursor: "message_0",
  last_sequence: 4,
  last_observed_at_ms: Date.parse("2026-08-26T00:01:30.000Z"),
  updated_at: "2026-08-26T00:01:30.000Z",
};

function receipt(
  overrides: Partial<SupervisedInboxReceiptWithTimeline> = {},
): SupervisedInboxReceiptWithTimeline {
  return {
    inbox_item_id: "inbox_1",
    agent_id: entry.id,
    room_id: entry.room_id,
    source_message_id: "message_1",
    source_message: { id: "message_1", text: "Please investigate." },
    activation: {},
    fifo_sequence: 1,
    state: "pending",
    receipt_state: "pending",
    attempt_count: 0,
    action_id: "action_1",
    reply_client_message_id: "reply_1",
    provider_turn_id: null,
    outcome: null,
    last_error: null,
    failure_code: null,
    blocked_by_inbox_item_id: null,
    next_attempt_at_ms: null,
    terminal_reason: null,
    created_at: "2026-08-26T00:01:00.000Z",
    updated_at: "2026-08-26T00:01:00.000Z",
    acknowledged_at: null,
    timeline: [],
    canonical_message_id: null,
    ...overrides,
  };
}

function facts(overrides: Partial<RoomAgentStateProjectionInput> = {}): RoomAgentStateProjectionInput {
  return {
    entry,
    binding,
    credentialAvailable: true,
    currentHostGrantAvailable: true,
    liveHandle: {
      workAttemptId: "attempt_1",
      providerContinuationId: "continuation_1",
    },
    ingressHealth: {
      room_id: "room_1",
      state: "observing",
      detail: null,
      execution_generation_id: "generation_1",
    },
    continuationRepair: null,
    receipts: [receipt()],
    activeTurn: {
      inboxItemId: "inbox_1",
      sourceMessageId: "message_1",
      phase: "responding",
    },
    nowMs: Date.parse("2026-08-26T00:02:00.000Z"),
    workplaceLivenessStaleAfterMs: 210_000,
    nativeLivenessStaleAfterMs: 90_000,
    ...overrides,
  };
}

test("a failed delivery receipt is terminal without marking its healthy runtime failed", () => {
  const projected = projectRoomAgentManifestEntry(facts({ receipts: [receipt({
    state: "acknowledged_failed", receipt_state: "acknowledged_failed", outcome: JSON.stringify({ kind: "failed", text: null, evidence: "stream" }),
  })] }));
  assert.equal(projected.delivery_receipts?.[0]?.state, "acknowledged_failed");
  assert.equal(projected.room_agent_state?.inbox.state, "empty");
  assert.equal(projected.room_agent_state?.inbox.pending_count, 0);
  assert.equal(projected.room_agent_state?.turn.state, "idle");
  assert.equal(projected.room_agent_state?.connection.state, "connected");
  assert.equal(projected.observed_state, "working");
});

test("projects exact room authority without exposing credentials", () => {
  const input = facts();
  assert.equal(bindingMatchesRoomAgentGeneration(input.entry, input.binding), true);
  assert.equal(hasExactRoomAgentDeliveryOwner(input), true);

  const projected = projectRoomAgentManifestEntry(input);

  assert.deepEqual(projected.worker_binding, {
    agent_session_id: "session_1",
    work_attempt_id: "attempt_1",
    execution_generation_id: "generation_1",
    updated_at: "2026-08-26T00:01:30.000Z",
  });
  assert.deepEqual(projected.workplace_liveness, {
    state: "reachable",
    observed_at: "2026-08-26T00:01:30.000Z",
    detail: "supervised worker session bound",
  });
  assert.deepEqual(projected.room_agent_state, {
    connection: {
      state: "connected",
      observed_at: "2026-08-26T00:01:30.000Z",
      detail: "Live provider and exact worker binding are available.",
    },
    ingress: {
      state: "observing",
      observed_at: "2026-08-26T00:01:30.000Z",
      detail: null,
    },
    inbox: {
      state: "queued",
      pending_count: 1,
      blocked_by_message_id: null,
      detail: "Room delivery is queued.",
    },
    turn: {
      state: "responding",
      inbox_item_id: "inbox_1",
      source_message_id: "message_1",
      provider_turn_id: null,
      detail: null,
    },
    task: { state: "none", task_id: null, title: null },
  });
  assert.equal(projected.delivery_receipts?.[0]?.state, "pending");
  assert.equal(projected.delivery_receipts?.[0]?.fifo_sequence, 1);
  assert.equal("credential_ref" in projected.worker_binding!, false);
});

test("typed admission gates the room view without rewriting lifecycle or claiming recovery", () => {
  const recovering = { ...entry, observed_state: "recovering" as const };
  const before = structuredClone(recovering);
  for (const lifecycleAdmission of ["pending", "unavailable"] as const) {
    const input = facts({ entry: recovering, lifecycleAdmission });
    assert.equal(hasExactRoomAgentDeliveryOwner(input), false,
      "a live handle and worker credentials cannot bypass typed admission");
    const projected = projectRoomAgentManifestEntry(input);
    assert.equal(projected.room_agent_state?.connection.state,
      lifecycleAdmission === "pending" ? "reconnecting" : "disconnected");
    assert.equal(projected.room_agent_state?.inbox.state, lifecycleAdmission === "pending" ? "queued" : "blocked");
    assert.equal(projected.room_agent_state?.ingress.state, lifecycleAdmission === "pending" ? "starting" : "blocked",
      "persisted observation health cannot bypass the same admission gate");
    assert.match(projected.room_agent_state?.inbox.detail ?? "", /readiness evidence/i);
    assert.notEqual(projected.room_agent_state?.turn.state, "responding",
      "unadmitted physical activity is not an operational turn");
    assert.equal(projected.condition, lifecycleAdmission === "pending" ? "none" : "coordination_blocked");
    assert.equal(agentInspectorOverallState(mapEntry(projected)),
      lifecycleAdmission === "pending" ? "reconnecting" : "needs_attention",
      "ordinary asynchronous admission must not flash Needs attention in the product");
    assert.equal(projected.observed_state, "recovering", "absence of evidence is not native process failure");
    const inspector = projectAgentInspector(mapEntry({ ...projected, runtime_generation_id: "exact-runtime" }), { roomId: entry.room_id })!;
    assert.equal(inspector.actions.find(action => action.kind === "recover")?.available, false,
      "a delivery admission blocker cannot authorize missing-runtime recovery");
    assert.equal(inspector.actions.find(action => action.kind === "recovery_options")?.available, lifecycleAdmission === "unavailable",
      "only blocked admission needs a choice; ordinary pending promotion remains progress");
    assert.deepEqual(recovering, before, "projection never writes lifecycle or clears historical uncertainty");
  }
  const ready = projectRoomAgentManifestEntry(facts({ entry: recovering, lifecycleAdmission: "ready" }));
  assert.equal(ready.room_agent_state?.connection.state, "connected");
  assert.equal(ready.room_agent_state?.inbox.state, "queued");
  assert.equal(ready.condition, "none", "only actual admission removes the derived blocker");
  assert.equal(ready.room_agent_state?.ingress.state, "observing");
  const readyInspector = projectAgentInspector(mapEntry({ ...ready, runtime_generation_id: "exact-runtime" }), { roomId: entry.room_id })!;
  assert.ok(readyInspector.actions.filter(action => ["recover", "recovery_options"].includes(action.kind)).every(action => !action.available));
  const noBindingYet = projectRoomAgentManifestEntry(facts({ entry: recovering, lifecycleAdmission: "pending",
    binding: null, credentialAvailable: false, receipts: [],
  }));
  assert.equal(agentInspectorOverallState(mapEntry(noBindingYet)), "reconnecting",
    "pending admission before binding is progress, not a credential intervention");
  assert.equal(noBindingYet.room_agent_state?.inbox.state, "empty");

  const deliveryBlocked = projectRoomAgentManifestEntry(facts({ entry: recovering, lifecycleAdmission: "unavailable",
    receipts: [receipt({ state: "blocked", receipt_state: "blocked", last_error: "Existing uncertain effect." })],
  }));
  assert.equal(deliveryBlocked.last_error, "Existing uncertain effect.");
  assert.equal(deliveryBlocked.room_agent_state?.inbox.blocked_by_message_id, "message_1");
  assert.equal(deliveryBlocked.room_agent_state?.inbox.detail, "Existing uncertain effect.");
  assert.equal(deliveryBlocked.delivery_receipts?.[0]?.error, "Existing uncertain effect.");

  const authBlocked = projectRoomAgentManifestEntry(facts({
    entry: { ...recovering, condition: "auth_blocked", last_error: "Sign in required." },
    lifecycleAdmission: "unavailable",
  }));
  assert.equal(authBlocked.condition, "auth_blocked");
  assert.equal(authBlocked.last_error, "Sign in required.");
  for (const desired_state of ["paused", "stopped"] as const) {
    const inactive = projectRoomAgentManifestEntry(facts({
      entry: { ...recovering, desired_state }, lifecycleAdmission: "unavailable",
    }));
    assert.equal(inactive.condition, "none", "an inactive agent does not inherit a live admission blocker");
  }
});

test("a record the daemon is about to get past by itself is progress; one it could not get past needs the owner, with the reason", () => {
  const idle = { ...entry, observed_state: "idle" as const };
  // No word on a restart: the long-standing blocker, as before.
  const unexplained = projectRoomAgentManifestEntry(facts({ entry: idle, lifecycleAdmission: "unavailable" }));
  assert.equal(unexplained.condition, "coordination_blocked");
  assert.match(unexplained.last_error ?? "", /readiness evidence is unavailable/);

  const restarting = projectRoomAgentManifestEntry(facts({ entry: idle, lifecycleAdmission: "unavailable", recordRecovery: null }));
  assert.equal(restarting.condition, "none", "the daemon is going to restart the agent: nothing for the owner to do");
  assert.equal(restarting.last_error ?? null, idle.last_error ?? null);
  assert.equal(restarting.room_agent_state?.inbox.state, "queued", "its messages wait; they are not blocked");
  assert.equal(restarting.room_agent_state?.connection.state, "reconnecting");
  assert.equal(restarting.room_agent_state?.ingress.state, "starting");
  assert.equal(restarting.room_agent_state?.inbox.detail, RECORD_RESTART_PENDING_DETAIL);
  assert.equal(agentInspectorOverallState(mapEntry(restarting)), "reconnecting");
  assert.equal(hasExactRoomAgentDeliveryOwner(facts({ entry: idle, lifecycleAdmission: "unavailable", recordRecovery: null })), false,
    "delivery is still not admitted");

  const reason = "Part of this agent's activity record is missing, and restarting the agent did not get past it. Messages wait until you use Restart and resume in Diagnostics.";
  const waiting = projectRoomAgentManifestEntry(facts({ entry: idle, lifecycleAdmission: "unavailable", recordRecovery: reason }));
  assert.equal(waiting.condition, "coordination_blocked");
  assert.equal(waiting.last_error, reason);
  assert.equal(waiting.room_agent_state?.inbox.state, "blocked");
  assert.equal(waiting.room_agent_state?.inbox.detail, reason);
  assert.equal(agentInspectorOverallState(mapEntry(waiting)), "needs_attention");
  const inspector = projectAgentInspector(mapEntry({ ...waiting, runtime_generation_id: "exact-runtime" }), { roomId: entry.room_id })!;
  assert.equal(inspector.actions.find(action => action.kind === "recovery_options")?.available, true, "with the manual recovery actions");

  // The word on a restart never overrides an admission that is not blocked.
  for (const lifecycleAdmission of ["pending", "ready"] as const) {
    assert.deepEqual(projectRoomAgentManifestEntry(facts({ entry: idle, lifecycleAdmission, recordRecovery: reason })),
      projectRoomAgentManifestEntry(facts({ entry: idle, lifecycleAdmission })));
  }
});

test("rejects a stale binding and derives stale persisted liveness", () => {
  const staleBinding = { ...binding, execution_generation_id: "generation_old" };
  const input = facts({
    binding: staleBinding,
    nowMs: Date.parse("2026-08-26T00:10:00.001Z"),
  });

  assert.equal(bindingMatchesRoomAgentGeneration(input.entry, input.binding), false);
  assert.equal(hasExactRoomAgentDeliveryOwner(input), false);

  const projected = projectRoomAgentManifestEntry(input);
  assert.equal(projected.worker_binding, null);
  assert.equal(projected.workplace_liveness?.state, "stale");
  assert.equal(projected.native_liveness?.state, "stale");
  assert.deepEqual(projected.room_agent_state?.connection, {
    state: "disconnected",
    observed_at: "2026-08-26T00:01:00.000Z",
    detail: "The current worker binding or credential is unavailable.",
  });
  assert.deepEqual(projected.room_agent_state?.ingress, {
    state: "stopped",
    observed_at: "2026-08-26T00:01:00.000Z",
    detail: "Room observation is stopped because its exact binding or credential is unavailable.",
  });
  assert.equal(projected.room_agent_state?.inbox.detail, "A current worker binding is required before delivery can start.");
  assert.equal(projected.room_agent_state?.turn.state, "idle");
});

test("projects credential handoff while a starting provider reconnects", () => {
  const projected = projectRoomAgentManifestEntry(facts({
    entry: { ...entry, observed_state: "starting" },
    credentialAvailable: false,
    currentHostGrantAvailable: false,
  }));

  assert.deepEqual(projected.room_agent_state?.connection, {
    state: "reconnecting",
    observed_at: "2026-08-26T00:00:00.000Z",
    detail: "Waiting for desktop credential handoff.",
  });
  assert.deepEqual(projected.room_agent_state?.inbox, {
    state: "waiting_for_desktop_credentials",
    pending_count: 1,
    blocked_by_message_id: null,
    detail: "Waiting for desktop credential handoff.",
  });
});

test("an active retry presents its current phase while preserving the previous failure in receipts", () => {
  const previousError = "Codex could not read this conversation’s room readiness. No model turn was started. Retry the message.";
  const retry = receipt({ state: "dispatching", receipt_state: "dispatching", attempt_count: 2, last_error: previousError });
  for (const phase of ["dispatching", "responding", "publishing"] as const) {
    const projected = projectRoomAgentManifestEntry(facts({
      receipts: [retry],
      activeTurn: { inboxItemId: retry.inbox_item_id, sourceMessageId: retry.source_message_id, phase },
    }));
    assert.equal(projected.room_agent_state?.turn.state, phase);
    assert.equal(projected.room_agent_state?.turn.detail, null, "an old failure is not current activity");
    assert.equal(projected.delivery_receipts?.[0]?.error, previousError);
    assert.equal(retry.last_error, previousError, "projection never resets the retained receipt");
  }
  for (const state of ["blocked", "result_recovery"] as const) {
    const projected = projectRoomAgentManifestEntry(facts({
      receipts: [{ ...retry, state, receipt_state: state }],
      activeTurn: null,
    }));
    assert.equal(projected.room_agent_state?.turn.state, state === "blocked" ? "failed" : "retrying");
    assert.equal(projected.room_agent_state?.turn.detail, previousError, "unresolved failure remains visible without an active delivery");
  }
});

test("uncertain legacy cutover overrides inbox and turn projection", () => {
  const projected = projectRoomAgentManifestEntry(facts({
    entry: {
      ...entry,
      delivery_mode: "mcp_polling",
      delivery_cutover: {
        work_attempt_id: "attempt_1",
        execution_generation_id: "generation_1",
        provider_continuation_id: "continuation_1",
        provider_turn_id: "turn_uncertain",
        phase: "uncertain",
        error: "Active turn discovery timed out.",
        updated_at: "2026-08-26T00:01:45.000Z",
      },
    },
  }));

  assert.deepEqual(projected.room_agent_state?.inbox, {
    state: "blocked",
    pending_count: 1,
    blocked_by_message_id: null,
    detail: "Daemon inbox cutover needs attention; legacy polling remains fenced. Active turn discovery timed out.",
  });
  assert.deepEqual(projected.room_agent_state?.turn, {
    state: "failed",
    inbox_item_id: null,
    source_message_id: null,
    provider_turn_id: "turn_uncertain",
    detail: "Active turn discovery timed out.",
  });
});

test("active continuation repair marks its receipt and prevents a model turn", () => {
  const blocked = receipt({
    state: "blocked",
    receipt_state: "blocked",
    provider_turn_id: "turn_failed",
    last_error: "Continuation is missing.",
  });
  const projected = projectRoomAgentManifestEntry(facts({
    receipts: [blocked],
    continuationRepair: { inbox_item_id: "inbox_1", phase: "probing" },
  }));

  assert.deepEqual(projected.room_agent_state?.inbox, {
    state: "restoring_conversation",
    pending_count: 1,
    blocked_by_message_id: "message_1",
    detail: "Restoring the blocked message before any model turn starts.",
  });
  assert.deepEqual(projected.room_agent_state?.turn, {
    state: "idle",
    inbox_item_id: "inbox_1",
    source_message_id: "message_1",
    provider_turn_id: null,
    detail: "Conversation restoration is happening before any model turn starts.",
  });
  assert.equal(projected.delivery_receipts?.[0]?.state, "restoring_conversation");
});

test("inbox projection preserves cutover, repair, credential, blocked, and queued precedence", () => {
  const blocked = receipt({
    state: "blocked",
    receipt_state: "blocked",
    last_error: "Delivery is blocked.",
  });
  const cutoverEntry: DaemonManifestEntry = {
    ...entry,
    delivery_mode: "mcp_polling",
    delivery_cutover: {
      work_attempt_id: "attempt_1",
      execution_generation_id: "generation_1",
      provider_continuation_id: "continuation_1",
      provider_turn_id: "turn_uncertain",
      phase: "uncertain",
      error: "Cutover is uncertain.",
      updated_at: "2026-08-26T00:01:45.000Z",
    },
  };

  const cutover = projectRoomAgentManifestEntry(facts({
    entry: cutoverEntry,
    credentialAvailable: false,
    receipts: [blocked],
    continuationRepair: { inbox_item_id: "inbox_1", phase: "probing" },
    activeTurn: null,
  }));
  assert.equal(cutover.room_agent_state?.inbox.state, "blocked", "cutover wins over restoration and credentials");
  assert.equal(cutover.room_agent_state?.turn.state, "failed");

  const restoring = projectRoomAgentManifestEntry(facts({
    credentialAvailable: false,
    receipts: [blocked],
    continuationRepair: { inbox_item_id: "inbox_1", phase: "probing" },
    activeTurn: null,
  }));
  assert.equal(restoring.room_agent_state?.inbox.state, "restoring_conversation", "restoration wins over credentials and blockage");

  const credentials = projectRoomAgentManifestEntry(facts({
    credentialAvailable: false,
    receipts: [blocked],
    activeTurn: null,
  }));
  assert.equal(credentials.room_agent_state?.inbox.state, "waiting_for_desktop_credentials", "missing credentials win over blockage");

  const blockedProjection = projectRoomAgentManifestEntry(facts({
    receipts: [blocked],
    activeTurn: null,
  }));
  assert.equal(blockedProjection.room_agent_state?.inbox.state, "blocked", "blockage wins over a nonfinal queue");

  const queued = projectRoomAgentManifestEntry(facts({ activeTurn: null }));
  assert.equal(queued.room_agent_state?.inbox.state, "queued");
});

test("an idle Cursor replacement cannot hide a failed FIFO head", () => {
  const cursorEntry = { ...entry, provider: "cursor", observed_state: "idle" as const, last_error: null };
  const failed = receipt({ state: "blocked", receipt_state: "blocked", attempt_count: 1,
    provider_turn_id: "crashed-turn", last_error: "Cursor's live MCP connector ended before the turn became terminal." });
  const later = receipt({ inbox_item_id: "inbox_2", source_message_id: "message_2", fifo_sequence: 2 });
  const projected = projectRoomAgentManifestEntry(facts({ entry: cursorEntry, receipts: [failed, later], activeTurn: null }));
  assert.equal(projected.condition, "coordination_blocked");
  assert.equal(projected.last_error, failed.last_error);
  assert.equal(projected.room_agent_state?.inbox.state, "blocked");
  assert.equal(projected.room_agent_state?.turn.state, "failed");
  assert.equal(later.attempt_count, 0, "projection never replays or skips delivery");

  const recovered = projectRoomAgentManifestEntry(facts({ entry: cursorEntry,
    receipts: [{ ...failed, state: "cancelled_by_user", receipt_state: "cancelled_by_user" }, later], activeTurn: null }));
  assert.equal(recovered.condition, "none", "Skip clears the derived error immediately");
  assert.equal(recovered.last_error, null);
  assert.equal(projectRoomAgentManifestEntry(facts({ entry: { ...cursorEntry, condition: "quarantined" },
    receipts: [failed], activeTurn: null })).condition, "quarantined");
});

test("a blocked FIFO head is projected as delivery attention through to the inspector", () => {
  const idleEntry = { ...entry, provider: "open-model", observed_state: "idle" as const };
  const blocked = receipt({ state: "blocked", receipt_state: "blocked", attempt_count: 1, provider_turn_id: "turn_1",
    outcome: JSON.stringify({ kind: "unreadable", text: null, evidence: "none" }), updated_at: "2026-08-26T00:01:30.000Z",
    last_error: "The provider completed, but its final answer is still unreadable. The same turn was re-read and was not rerun." });
  const later = receipt({ inbox_item_id: "inbox_2", source_message_id: "message_2", fifo_sequence: 2, receipt_state: "queued_behind_blocked" });
  const projected = projectRoomAgentManifestEntry(facts({ entry: idleEntry, receipts: [blocked, later], activeTurn: null,
    blockedHeadSkip: { inbox_item_id: "inbox_1", refusal: null } }));
  assert.equal(projected.condition, "none", "runtime condition stays about the runtime");
  assert.deepEqual(projected.delivery_attention, {
    reason: "message_blocked", source_message_id: "message_1", blocked_since: "2026-08-26T00:01:30.000Z",
    detail: blocked.last_error, waiting_count: 1, provider_work_started: true, retry: "reread_saved_turn",
    can_skip: true, skip_unavailable_reason: null,
  });

  const desktop = mapEntry(projected);
  assert.equal(desktop.deliveryAttention?.canSkip, true);
  assert.equal(desktop.deliveryAttention?.retry, "reread_saved_turn");
  assert.equal(agentInspectorOverallState(desktop), "needs_attention");
  const inspector = projectAgentInspector(desktop, { roomId: entry.room_id, deliveryRetryAvailable: true, roomDeliverySkipAvailable: true });
  const skip = inspector?.actions.find((action) => action.kind === "skip_message");
  assert.deepEqual([skip?.available, skip?.sourceMessageId], [true, "message_1"]);

  const refused = projectRoomAgentManifestEntry(facts({ entry: idleEntry, receipts: [blocked, later], activeTurn: null,
    blockedHeadSkip: { inbox_item_id: "inbox_1", refusal: "Provider work may still be running." } }));
  assert.equal(refused.delivery_attention?.can_skip, false);
  assert.equal(refused.delivery_attention?.skip_unavailable_reason, "Provider work may still be running.");
  assert.equal(projectAgentInspector(mapEntry(refused), { roomId: entry.room_id, roomDeliverySkipAvailable: true })
    ?.actions.find((action) => action.kind === "skip_message")?.available, false);
  assert.equal(projectRoomAgentManifestEntry(facts({ entry: idleEntry, receipts: [blocked], activeTurn: null,
    blockedHeadSkip: { inbox_item_id: "another_inbox", refusal: null } })).delivery_attention?.can_skip, false,
  "a skip decision for another row never applies");

  const unstarted = projectRoomAgentManifestEntry(facts({ entry: idleEntry, activeTurn: null,
    receipts: [receipt({ state: "blocked", receipt_state: "blocked", last_error: "Tools unavailable." })] }));
  assert.equal(unstarted.delivery_attention?.provider_work_started, false);
  assert.equal(unstarted.delivery_attention?.retry, "start_turn");
  const unposted = projectRoomAgentManifestEntry(facts({ entry: idleEntry, activeTurn: null, blockedHeadSkip: { inbox_item_id: "inbox_1", refusal: "saved reply" },
    receipts: [{ ...blocked, outcome: JSON.stringify({ kind: "reply", text: "Saved answer", evidence: "stream" }) }] }));
  assert.equal(unposted.delivery_attention?.retry, "publish_saved_reply", "Retry posts a saved reply; it is not a re-read");
  assert.equal(projectAgentInspector(mapEntry(unposted), { roomId: entry.room_id, deliveryRetryAvailable: true })
    ?.actions.find((action) => action.kind === "retry_delivery")?.label, "Post the saved reply");
  assert.equal(projectRoomAgentManifestEntry(facts({ receipts: [receipt()] })).delivery_attention, null);
  assert.equal(projectRoomAgentManifestEntry(facts({ receipts: [{ ...blocked, state: "cancelled_by_user", receipt_state: "cancelled_by_user" }] }))
    .delivery_attention, null, "Skip clears the attention immediately");
});

test("exact stopped ingress authority clears its observed timestamp", () => {
  const projected = projectRoomAgentManifestEntry(facts({
    ingressHealth: {
      room_id: "room_1",
      state: "stopped",
      detail: "Observation was explicitly stopped.",
      execution_generation_id: "generation_1",
    },
  }));

  assert.deepEqual(projected.room_agent_state?.ingress, {
    state: "stopped",
    observed_at: null,
    detail: "Observation was explicitly stopped.",
  });
});

test("liveness becomes stale only after, not at, its exact threshold", () => {
  const threshold = projectRoomAgentManifestEntry(facts({
    nowMs: Date.parse("2026-08-26T00:02:30.000Z"),
    workplaceLivenessStaleAfterMs: 60_000,
    nativeLivenessStaleAfterMs: 90_000,
  }));
  assert.equal(threshold.workplace_liveness?.state, "reachable");
  assert.equal(threshold.native_liveness?.state, "active");

  const beyond = projectRoomAgentManifestEntry(facts({
    nowMs: Date.parse("2026-08-26T00:02:30.001Z"),
    workplaceLivenessStaleAfterMs: 60_000,
    nativeLivenessStaleAfterMs: 90_000,
  }));
  assert.equal(beyond.workplace_liveness?.state, "stale");
  assert.equal(beyond.native_liveness?.state, "stale");
});

test("committed and failed continuation repairs are ignored", () => {
  const blocked = receipt({
    state: "blocked",
    receipt_state: "blocked",
    provider_turn_id: "turn_failed",
    last_error: "Delivery remains blocked.",
  });

  for (const phase of ["committed", "failed"] as const) {
    const projected = projectRoomAgentManifestEntry(facts({
      receipts: [blocked],
      continuationRepair: { inbox_item_id: "inbox_1", phase },
      activeTurn: null,
    }));
    assert.equal(projected.room_agent_state?.inbox.state, "blocked", `${phase} repair does not override the inbox`);
    assert.equal(projected.room_agent_state?.turn.state, "failed", `${phase} repair does not override the turn`);
    assert.equal(projected.delivery_receipts?.[0]?.state, "blocked", `${phase} repair does not relabel the receipt`);
  }
});

/** The read model over fixed facts: one agent, its binding, its queue, and what the daemon holds and has recorded. */
function readModel(input: {
  nowMs: number; receipts?: SupervisedInboxReceiptWithTimeline[]; held?: ProviderActionHandle | null;
  /** The recorded end of the agent's process, a failing read of it, or none recorded. */
  ended?: boolean | "unreadable";
  /** The agent's room credential is missing, so delivery could not run whatever its setup. */
  noCredential?: boolean;
  /** The configuration revision the store records the agent's process as last started at. An entry read from the manifest carries none. */
  lastStartedAt?: number;
}) {
  let durabilityReads = 0;
  const model = new DaemonReadModel({
    currentDaemonGeneration: () => 1, nowMs: () => input.nowMs, startedAt: "2026-08-26T00:00:00.000Z",
    capabilities: { hasDelivery: () => true, supportsRoomTurns: () => true, supportsContinuationRepair: () => false },
    recoveryDiagnostics: () => { throw new Error("unused"); }, deliveryAdmission: () => null,
    manifest: { load: async () => ({ entries: [] }), getEntry: async () => undefined, pendingRuntimeRecovery: async () => null,
      getAgentConfiguration: async () => input.lastStartedAt === undefined ? undefined : { runtime_configuration_revision: input.lastStartedAt } },
    bindings: { credentialFor: async () => input.noCredential ? null : "bearer", get: async () => binding, list: async () => [binding] },
    inbox: { detail: async () => { throw new Error("unused"); }, latestContinuationRepair: async () => null,
      ingressHealth: async () => ({ room_id: "room_1", state: "observing", detail: null, execution_generation_id: "generation_1" }),
      receiptProjection: async () => (input.receipts ?? []) as never },
    durability: { getAttempt: async () => {
      durabilityReads += 1;
      if (input.ended === "unreadable") throw new Error("the attempt could not be read");
      return { execution_generations: [{ execution_generation_id: "generation_1", terminal: input.ended ? { ended_at: "2026-08-26T00:02:00.000Z" } : null }] } as never;
    } },
    workerAuthority: { currentHostGrant: () => ({}) as never, pollingContract: async () => null },
    liveHandles: new Map(input.held ? [[entry.id, input.held]] : []), delivery: null,
  });
  return { model, durabilityReads: () => durabilityReads };
}
// The owner's own setup, as it is stored: on is an exact false, and each change is a key named for its revision.
const ownerSetupOn = { letagentsOwnerIsolation: false };
const ownerSetupChangedAt = (...revisions: number[]) => Object.fromEntries(revisions.map((revision) => [`letagentsOwnerIsolationChangedAt${revision}`, false]));
/** The process the daemon holds, started at the given configuration revision. */
const heldSince = (revision: number): ProviderActionHandle => ({ workAttemptId: "attempt_1", pid: 41, providerContinuationId: "continuation_1",
  observedState: "idle", appliedConfigurationRevision: revision });
const WAITING_SINCE = Date.parse("2026-08-26T00:01:00.000Z");

test("an agent that cannot be restarted to end the owner's setup needs attention once a message has waited for it, and no longer once it is replaced", async () => {
  // Turned off at revision 5. The idle process started at revision 4, with the setup, and two messages wait for its successor.
  const ending: DaemonManifestEntry = { ...entry, observed_state: "idle", provider_launch_policy: ownerSetupChangedAt(5) };
  const queue = [receipt(), receipt({ inbox_item_id: "inbox_2", source_message_id: "message_2", fifo_sequence: 2 })];
  const at = async (seconds: number, agent: DaemonManifestEntry = ending, input: Partial<Parameters<typeof readModel>[0]> = {}) =>
    readModel({ nowMs: WAITING_SINCE + seconds * 1_000, receipts: queue, held: heldSince(4), lastStartedAt: 4, ...input }).model.entryWithDerivedLiveness(agent);

  // While the daemon's own retries are still young nothing is said: a restart normally takes a moment.
  const young = await at(29);
  assert.equal(young.home_harness, "until_restart");
  assert.equal(young.condition, "none");
  assert.notEqual(agentInspectorOverallState(mapEntry(young)), "needs_attention");

  // After that the agent is shown as any stuck agent is, with what is happening, what to do, and how much is waiting.
  const stuck = await at(30);
  assert.equal(stuck.condition, "coordination_blocked");
  assert.equal(stuck.last_error, "This agent could not be restarted yet to turn your own setup off, so it is not taking messages. LetAgents keeps trying. "
    + "Pause and resume this agent to finish now; 2 messages are waiting.");
  assert.equal(agentInspectorOverallState(mapEntry(stuck)), "needs_attention", "which is what puts it in the Inbox as a stuck agent");
  assert.equal(projectAgentInspector(mapEntry(stuck), { roomId: "room_1" })?.now?.summary, stuck.last_error);
  // It is the same state however often and however much later it is read: nothing is raised a second time.
  assert.deepEqual([(await at(31)).last_error, (await at(3_600)).last_error], [stuck.last_error, stuck.last_error]);
  assert.match((await at(60, ending, { receipts: [queue[0]!] })).last_error!, /; 1 message is waiting\.$/);
  // Nothing is stored for it: the entry the daemon keeps is untouched.
  assert.equal(ending.condition, "none");

  // Only that agent, and only while a message really waits on the restart.
  for (const [name, agent, input] of [
    ["its turn is still running", { ...ending, observed_state: "working" }, {}],
    ["its owner paused it", { ...ending, desired_state: "paused" }, {}],
    ["nothing is waiting", ending, { receipts: [] }],
    // Delivery is held for another reason, which is the one that is shown.
    ["its room access is missing", ending, { noCredential: true }],
    ["the setup is still on", { ...ending, provider_launch_policy: { ...ownerSetupOn, ...ownerSetupChangedAt(4) } }, {}],
    ["it never had the setup", { ...ending, provider_launch_policy: {} }, {}],
    ["it was turned on and off again before any restart", { ...ending, provider_launch_policy: ownerSetupChangedAt(5, 6) }, {}],
  ] as const) {
    const view = await at(3_600, agent as DaemonManifestEntry, input);
    assert.equal(view.condition, "none", name);
    assert.equal(view.last_error ?? null, null, name);
  }
  // An agent that already needs attention for another reason keeps that reason.
  const other = await at(3_600, { ...ending, condition: "auth_blocked", last_error: "Sign in again." });
  assert.deepEqual([other.condition, other.last_error], ["auth_blocked", "Sign in again."]);

  // The replacement succeeds: its successor started at revision 5, without the setup, and the state is gone with no one clearing it.
  const replaced = await at(3_600, ending, { held: heldSince(5), lastStartedAt: 5 });
  assert.equal(replaced.home_harness, undefined);
  assert.equal(replaced.condition, "none");
  assert.equal(replaced.last_error ?? null, null);
  assert.notEqual(agentInspectorOverallState(mapEntry(replaced)), "needs_attention");
});

test("a paused agent is shown with the owner's setup until the end of its process is recorded", async () => {
  // Turned off at revision 5 while the process from revision 4 ran. The agent is paused and the daemon holds no process.
  const paused: DaemonManifestEntry = { ...entry, desired_state: "paused", observed_state: "paused",
    provider_launch_policy: ownerSetupChangedAt(5) };
  const shown = async (agent: DaemonManifestEntry, input: Partial<Parameters<typeof readModel>[0]>) => {
    const subject = readModel({ nowMs: WAITING_SINCE, lastStartedAt: 4, ...input });
    return { state: (await subject.model.entryWithDerivedLiveness(agent)).home_harness, reads: subject.durabilityReads() };
  };
  // A pause ends the process and the daemon records that end: then nothing has the setup any more.
  assert.deepEqual(await shown(paused, { ended: true }), { state: undefined, reads: 1 });
  // Marked paused with no recorded end, or an end that cannot be read: the process may still be there, and it is shown so.
  assert.deepEqual(await shown(paused, { ended: false }), { state: "until_restart", reads: 1 });
  assert.deepEqual(await shown(paused, { ended: "unreadable" }), { state: "until_restart", reads: 1 });
  // While the daemon still holds the process, as it does until the pause has stopped it, that process is what is shown.
  assert.deepEqual(await shown(paused, { ended: true, held: heldSince(4) }), { state: "until_restart", reads: 0 });
  // Saved on: the recorded end leaves the saved choice, and a process that may still run without it is "pending".
  const on = { ...paused, provider_launch_policy: { ...ownerSetupOn, ...ownerSetupChangedAt(5) } };
  assert.deepEqual(await shown(on, { ended: true }), { state: "on", reads: 1 });
  assert.deepEqual(await shown(on, { ended: false }), { state: "after_restart", reads: 1 });
  // An agent that never had the setup costs no read at all, paused or not.
  assert.deepEqual(await shown({ ...paused, provider_launch_policy: {} }, { ended: false }), { state: undefined, reads: 0 });
});

test("a process the daemon has not re-attached yet is shown by the revision the store records for it, which the entry does not carry", async () => {
  const shown = async (policy: Record<string, unknown>, lastStartedAt: number | undefined) =>
    (await readModel({ nowMs: WAITING_SINCE, lastStartedAt }).model.entryWithDerivedLiveness(
      { ...entry, observed_state: "idle", provider_launch_policy: policy })).home_harness;
  // Turned on at revision 2, and the agent's process started at revision 2: it has the setup. Re-attached or not.
  assert.equal(await shown({ ...ownerSetupOn, ...ownerSetupChangedAt(2) }, 2), "on");
  // Turned on at revision 2 and the process started at revision 1: not yet.
  assert.equal(await shown({ ...ownerSetupOn, ...ownerSetupChangedAt(2) }, 1), "after_restart");
  // Turned on at 2 and off at 3, the process started at revision 2: it still has the setup. Started at 3: it does not.
  assert.equal(await shown(ownerSetupChangedAt(3), 2), "until_restart");
  assert.equal(await shown(ownerSetupChangedAt(3), 3), undefined);
  // A revision the store could not give is counted as older than every change, never as a start after them all.
  assert.equal(await shown({ ...ownerSetupOn, ...ownerSetupChangedAt(2) }, undefined), "after_restart");
  assert.equal(await shown(ownerSetupChangedAt(3), undefined), "until_restart");
});
