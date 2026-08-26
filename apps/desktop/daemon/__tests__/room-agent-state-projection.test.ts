import assert from "node:assert/strict";
import test from "node:test";

import {
  bindingMatchesRoomAgentGeneration,
  hasExactRoomAgentDeliveryOwner,
  projectRoomAgentManifestEntry,
  type RoomAgentStateProjectionInput,
} from "../room-agent-state-projection.js";
import type { SupervisedInboxReceiptWithTimeline } from "../supervised-agent-inbox-store.js";
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
  assert.equal("credential_ref" in projected.worker_binding!, false);
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
