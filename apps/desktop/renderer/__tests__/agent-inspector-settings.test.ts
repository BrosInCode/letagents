import assert from "node:assert/strict";
import test from "node:test";
import {
  agentInspectorSettingsFenceCurrent,
  agentInspectorProviderSupportsEffort,
  configurationDraft,
  configurationHasRuntimeLag,
  isStaleDaemonGenerationError,
  recoveredRoomMoveState,
  roomMovePresentation,
  settleConfigurationConflict,
  settleConfigurationUpdate,
  snapshotConfigurationSave,
  supervisorGenerationIsCurrent,
  type AgentInspectorConfigurationResource,
} from "../src/domain/agent-inspector-settings";

const configuration = {
  entryId: "agent_a",
  daemonGeneration: 7,
  provider: "codex",
  model: "gpt-next",
  reasoningEffort: "high" as const,
  charter: "Coordinate work.",
  permissionProfileId: "read_only" as const,
  providerLaunchPolicy: { sandbox: true },
  configRevision: 4,
  runtimeConfigurationRevision: 3,
};

function resource(): AgentInspectorConfigurationResource {
  return {
    status: "ready",
    configuration,
    draft: configurationDraft(configuration),
    error: null,
  };
}

test("settings draft exposes only user-editable settings and makes saved/runtime revision truth explicit", () => {
  assert.deepEqual(configurationDraft(configuration), {
    model: "gpt-next",
    reasoningEffort: "high",
    charter: "Coordinate work.",
    permissionProfileId: "read_only",
  });
  assert.equal(configurationHasRuntimeLag(configuration), true);
  assert.equal(configurationHasRuntimeLag({ ...configuration, runtimeConfigurationRevision: 4 }), false);
  assert.equal(agentInspectorProviderSupportsEffort("codex"), true);
  assert.equal(agentInspectorProviderSupportsEffort("open-model"), true);
  assert.equal(agentInspectorProviderSupportsEffort("claude-code"), false);
  assert.equal(agentInspectorProviderSupportsEffort("cursor"), false);
});

test("configuration CAS settlement never replaces a newer local draft with an older response", () => {
  const initial = resource();
  const snapshot = snapshotConfigurationSave(initial, 2, 7);
  assert.ok(snapshot);
  const edited: AgentInspectorConfigurationResource = {
    ...initial,
    draft: { ...initial.draft!, charter: "Newer local edit." },
  };
  const server = { ...configuration, charter: "Saved snapshot.", configRevision: 5, runtimeConfigurationRevision: 4 };

  const preserved = settleConfigurationUpdate(edited, 3, snapshot, server);
  assert.equal(preserved.resource.configuration, server);
  assert.equal(preserved.resource.draft?.charter, "Newer local edit.");
  assert.equal(preserved.draftVersion, 3);

  const accepted = settleConfigurationUpdate(initial, 2, snapshot, server);
  assert.equal(accepted.resource.draft?.charter, "Saved snapshot.");
  assert.equal(accepted.draftVersion, 3);
});

test("configuration conflicts rebase the saved baseline while preserving the exact submitted draft", () => {
  const initial = resource();
  initial.draft = { ...initial.draft!, charter: "Unpublished local charter." };
  const snapshot = snapshotConfigurationSave(initial, 9, 7);
  assert.ok(snapshot);
  const remote = { ...configuration, charter: "Remote charter.", configRevision: 8 };
  const settled = settleConfigurationConflict({ ...initial, draft: null }, snapshot, remote);
  assert.equal(settled.configuration, remote);
  assert.equal(settled.draft?.charter, "Unpublished local charter.");
  assert.equal(snapshot.expectedRevision, 4);
});

test("save snapshots and response fences reject a daemon generation change", () => {
  assert.equal(snapshotConfigurationSave(resource(), 1, 8), null);
  const fence = { entryId: "agent_a", roomId: "room_a", daemonGeneration: 7, requestToken: 12 };
  assert.equal(agentInspectorSettingsFenceCurrent(fence, {
    entryId: "agent_a", roomId: "room_a", daemonGeneration: 7, requestToken: 12,
  }), true);
  assert.equal(agentInspectorSettingsFenceCurrent(fence, {
    entryId: "agent_a", roomId: "room_a", daemonGeneration: 8, requestToken: 12,
  }), false);
  assert.equal(isStaleDaemonGenerationError(new Error("Agent configuration is fenced by a stale daemon generation.")), true);
  assert.equal(isStaleDaemonGenerationError(new Error("network unavailable")), false);
  assert.equal(supervisorGenerationIsCurrent(8, 7), false, "an older poll cannot replace a newer daemon status");
  assert.equal(supervisorGenerationIsCurrent(8, 9), true);
});

test("room-move presentation never treats transitional phases as completed", () => {
  const base = {
    operationId: "move",
    requestId: "request",
    entryId: "agent_a",
    sourceRoomId: "source",
    destinationRoomId: "destination",
    daemonGeneration: 7,
    workAttemptId: "attempt",
    executionGenerationId: "execution",
    agentSessionId: "session",
    remoteRoomId: null,
    destinationCursor: null,
    error: null,
    createdAt: "now",
    updatedAt: "now",
  };
  for (const phase of ["prepared", "waiting_for_current_turn", "joining_destination", "membership_committed", "rotating_credentials", "bootstrapping_destination_tail", "rollback_required"] as const) {
    assert.equal(roomMovePresentation({ ...base, phase }).terminal, false, phase);
  }
  assert.equal(roomMovePresentation({ ...base, phase: "active" }).terminal, true);
  assert.equal(roomMovePresentation({ ...base, phase: "failed" }).terminal, true);
});

test("durable room-move discovery restores nonterminal work and clears completed authority", () => {
  const base = {
    operationId: "move",
    requestId: "request",
    entryId: "agent_a",
    sourceRoomId: "source",
    destinationRoomId: "destination",
    daemonGeneration: 7,
    workAttemptId: null,
    executionGenerationId: null,
    agentSessionId: null,
    remoteRoomId: null,
    destinationCursor: null,
    error: null,
    createdAt: "now",
    updatedAt: "now",
  };
  const reopenedPrepared = recoveredRoomMoveState({ ...base, phase: "prepared" });
  assert.equal(reopenedPrepared.resource.move?.operationId, "move");
  assert.equal(reopenedPrepared.shouldPoll, false);

  const reopenedRecovery = recoveredRoomMoveState({ ...base, phase: "rotating_credentials" });
  assert.equal(reopenedRecovery.resource.status, "recovering");
  assert.equal(reopenedRecovery.shouldPoll, true);

  const completed = recoveredRoomMoveState({ ...base, phase: "active" });
  assert.equal(completed.resource.move, null);
  assert.equal(completed.shouldPoll, false);
  assert.equal(completed.refreshAgents, true);
});
