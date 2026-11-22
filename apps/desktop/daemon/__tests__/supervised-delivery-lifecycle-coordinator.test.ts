import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderActionHandle } from "../provider-action-port.js";
import { SupervisedDeliveryLifecycleCoordinator } from "../supervised-delivery-lifecycle-coordinator.js";
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
  providerContinuationId: "thread-1",
  observedState: "idle",
  providerConnection: connection,
  appliedConfigurationRevision: 1,
};

function makeEntry(overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent",
    provider: "codex",
    model: null,
    charter: "Help",
    desired_state: "running",
    observed_state: "idle",
    condition: "none",
    permission_profile_id: "supervised",
    created_by: "test",
    created_at: "2026-08-26T00:00:00.000Z",
    work_attempt_id: "attempt-1",
    delivery_mode: "daemon_inbox",
    provider_ref: {
      work_attempt_id: "attempt-1",
      execution_generation_id: "generation-1",
      provider_continuation_id: "thread-1",
      provider_connection: connection,
    },
    ...overrides,
  };
}

test("start, laneOutlook, and exactActiveBoundedContext read manifest entries in summary mode", async () => {
  const modes: Array<{ entryId: string; mode: "full" | "summary" | undefined }> = [];
  const entry = makeEntry();
  const binding = {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "generation-1",
    agent_session_id: "session-1",
    credential_ref: "credential-1",
    api_url: "https://letagents.test",
    updated_at: "2026-08-26T00:00:00.000Z",
    room_cursor: null,
  };
  let capturedLaneOutlook: (() => Promise<"restarts" | "needs_owner" | undefined>) | undefined;
  const coordinator = new SupervisedDeliveryLifecycleCoordinator({
    isHandoffScheduled: () => false,
    supportsRoomTurns: () => true,
    isLifecycleActive: () => false,
    isOperationallyAdmitted: () => true,
    currentDaemonGeneration: () => 7,
    delivery: {
      activeTurn: () => ({ inboxItemId: "inbox-1", sourceMessageId: "msg-1", providerTurnId: "turn-1" }) as never,
      ensureStarted: async (agent) => { capturedLaneOutlook = agent.laneOutlook; },
      refresh: async (agent) => { capturedLaneOutlook = agent.laneOutlook; },
      wake: () => {},
    },
    manifest: {
      unresolvedDeliveryDrain: async () => null,
      getEntry: async (entryId, activityMode) => {
        modes.push({ entryId, mode: activityMode });
        return entry;
      },
      getAgentConfiguration: async () => ({}),
      pendingRoomMoves: async () => [],
    },
    roomMoves: { reconcile: async (move) => move },
    cutovers: { start: async () => {} },
    inbox: {
      get: async () => ({
        inbox_item_id: "inbox-1",
        agent_id: "agent-1",
        room_id: "room-1",
        provider_turn_id: "turn-1",
      }) as never,
      preparedRoomMove: async () => null,
      providerTurnBinding: async () => ({
        inbox_item_id: "inbox-1",
        agent_id: "agent-1",
        room_id: "room-1",
        work_attempt_id: "attempt-1",
        provider_continuation_id: "thread-1",
        provider_turn_id: "turn-1",
        origin_execution_generation_id: "generation-1",
      }) as never,
      receipts: async () => [],
    },
    bindings: {
      get: async () => binding,
      credentialFor: async () => "secret-bearer",
    },
    liveHandle: () => handle,
    providerAuthority: { isExactAuthority: async () => true },
    scheduleRecovery: () => {},
  });

  await coordinator.start("agent-1");
  assert.ok(capturedLaneOutlook, "start passes laneOutlook to delivery");
  assert.equal(await capturedLaneOutlook!(), "restarts");

  const context = await coordinator.exactActiveBoundedContext({
    entryId: "agent-1",
    workAttemptId: "attempt-1",
    executionGenerationId: "generation-1",
    daemonGeneration: 7,
    providerTurnId: "turn-1",
  });
  assert.equal(context.entry.id, "agent-1");

  assert.deepEqual(modes, [
    { entryId: "agent-1", mode: "summary" },
    { entryId: "agent-1", mode: "summary" },
    { entryId: "agent-1", mode: "summary" },
  ]);

  let cutoverStarts = 0;
  const legacyCoordinator = new SupervisedDeliveryLifecycleCoordinator({
    isHandoffScheduled: () => false,
    supportsRoomTurns: () => true,
    isLifecycleActive: () => false,
    isOperationallyAdmitted: () => false,
    currentDaemonGeneration: () => 7,
    delivery: {
      activeTurn: () => null,
      ensureStarted: async () => {},
      refresh: async () => {},
      wake: () => {},
    },
    manifest: {
      unresolvedDeliveryDrain: async () => null,
      getEntry: async (entryId, activityMode) => {
        modes.push({ entryId, mode: activityMode });
        return makeEntry({ desired_state: "stopped", observed_state: "stopped", delivery_mode: "mcp_polling" });
      },
      getAgentConfiguration: async () => ({ polling_contract: null }),
      pendingRoomMoves: async () => [],
    },
    roomMoves: { reconcile: async (move) => move },
    cutovers: { start: async () => { cutoverStarts += 1; } },
    inbox: {
      get: async () => null,
      preparedRoomMove: async () => null,
      providerTurnBinding: async () => null,
      receipts: async () => [],
    },
    bindings: {
      get: async () => null,
      credentialFor: async () => null,
    },
    liveHandle: () => undefined,
    providerAuthority: { isExactAuthority: async () => false },
    scheduleRecovery: () => {},
  });

  await legacyCoordinator.start("agent-1");
  assert.equal(cutoverStarts, 1);
  assert.deepEqual(modes.at(-1), { entryId: "agent-1", mode: "summary" });
});
