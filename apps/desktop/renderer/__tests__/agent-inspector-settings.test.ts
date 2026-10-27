import assert from "node:assert/strict";
import test from "node:test";
import {
  agentInspectorSettingsFenceCurrent,
  agentInspectorProviderSupportsEffort,
  configurationDraft,
  configurationHasRuntimeLag,
  IMAGE_INPUT_DESCRIPTION,
  IMAGE_INPUT_TITLE,
  isStaleDaemonGenerationError,
  permissionPendingBadge,
  permissionTimingNote,
  recoveredRoomMoveState,
  roomMovePresentation,
  settleConfigurationAlreadyApplied,
  settleConfigurationConflict,
  settleConfigurationUpdate,
  snapshotConfigurationApply,
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
  supervisedPermissionProfiles: [],
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
  assert.equal(agentInspectorProviderSupportsEffort("open-model"), false);
  assert.equal(agentInspectorProviderSupportsEffort("claude-code"), true);
  assert.equal(agentInspectorProviderSupportsEffort("cursor"), false);
});

test("settings draft keeps the image-input choice when the saved settings have one and omits it otherwise", () => {
  for (const imageInput of [true, false]) {
    const draft = configurationDraft({ ...configuration, imageInput });
    assert.equal(Object.hasOwn(draft, "imageInput"), true, String(imageInput));
    assert.equal(draft.imageInput, imageInput, "an explicit off is kept, not dropped");
    assert.deepEqual(draft, {
      model: "gpt-next",
      reasoningEffort: "high",
      charter: "Coordinate work.",
      permissionProfileId: "read_only",
      imageInput,
    });
  }
  // An agent app that does not ask, or an older background service, leaves no key at all.
  assert.equal(Object.hasOwn(configurationDraft(configuration), "imageInput"), false);
  assert.equal(Object.hasOwn(configurationDraft({ ...configuration, imageInput: undefined }), "imageInput"), false);
});

test("the image-input choice travels in the saved snapshot and the saved response replaces the draft with it", () => {
  const withChoice = { ...configuration, imageInput: false };
  const initial: AgentInspectorConfigurationResource = {
    status: "ready", configuration: withChoice, draft: { ...configurationDraft(withChoice), imageInput: true }, error: null,
  };
  const snapshot = snapshotConfigurationSave(initial, 2, 7);
  assert.ok(snapshot);
  assert.equal(snapshot.draft.imageInput, true, "the submitted draft carries the owner's edit");
  assert.equal(snapshot.expectedRevision, 4);

  const accepted = settleConfigurationUpdate(initial, 2, snapshot, { ...withChoice, imageInput: true, configRevision: 5 });
  assert.equal(accepted.resource.draft?.imageInput, true);
  assert.equal(accepted.resource.configuration?.imageInput, true);

  // A newer local edit made while the save was in flight is not overwritten by the older response.
  const edited = { ...initial, draft: { ...initial.draft!, imageInput: false } };
  const preserved = settleConfigurationUpdate(edited, 3, snapshot, { ...withChoice, imageInput: true, configRevision: 5 });
  assert.equal(preserved.resource.draft?.imageInput, false);
  assert.equal(preserved.resource.configuration?.imageInput, true);

  const withoutChoice = resource();
  assert.equal(Object.hasOwn(snapshotConfigurationSave(withoutChoice, 1, 7)!.draft, "imageInput"), false);
});

test("the image-input switch says what it does and when it applies", () => {
  assert.equal(IMAGE_INPUT_TITLE, "This model can read images");
  assert.match(IMAGE_INPUT_DESCRIPTION, /the images that people attach to the message that wakes it/);
  assert.match(IMAGE_INPUT_DESCRIPTION, /Turn it on only if your model accepts image input\./);
  assert.match(IMAGE_INPUT_DESCRIPTION, /It applies the next time the agent starts\.$/);
});

test("configuration apply snapshots exact authority coordinates and preserves the local draft", () => {
  const initial = resource();
  initial.draft = { ...initial.draft!, charter: "Unsaved local edit." };
  const snapshot = snapshotConfigurationApply(initial, "agent_a");
  assert.deepEqual(snapshot, {
    entryId: "agent_a",
    daemonGeneration: 7,
    expectedConfigurationRevision: 4,
    preservedDraft: { ...initial.draft },
  });
  assert.equal(snapshotConfigurationApply(initial, "another_agent"), null);
  assert.equal(snapshotConfigurationApply({ ...initial, status: "refreshing" }, "agent_a"), null);
  assert.equal(snapshotConfigurationApply({
    ...initial,
    configuration: { ...configuration, runtimeConfigurationRevision: configuration.configRevision },
  }, "agent_a"), null);

  const settled = settleConfigurationAlreadyApplied(initial, 4);
  assert.equal(settled.configuration?.runtimeConfigurationRevision, 4);
  assert.equal(settled.draft?.charter, "Unsaved local edit.");
  assert.equal(settleConfigurationAlreadyApplied(initial, 5), initial, "a response for another revision cannot settle this resource");
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

test("a saved access level that has not reached the running agent is marked, and said in a sentence that tells when it will", () => {
  const badge = permissionPendingBadge("daemon_inbox");
  assert.equal(badge.label, "Settings pending");
  assert.equal(badge.title, "You changed this agent's access level. It applies when the current turn ends, or when the agent restarts.");
  for (const mode of ["mcp_polling", undefined]) {
    assert.equal(permissionPendingBadge(mode).label, "Settings pending");
    assert.equal(permissionPendingBadge(mode).title, "You changed this agent's access level. It applies the next time the agent starts.", String(mode));
  }
  // The label stays short so the agent's name keeps its room.
  assert.ok(badge.label.length <= 16);
  // An agent that LetAgents delivers messages to switches as soon as it is idle, and a turn that is running is not stopped.
  assert.equal(permissionTimingNote("daemon_inbox", false),
    "Choose what the agent can access. A new level applies as soon as the agent is idle. A turn that is running is not stopped.");
  assert.equal(permissionTimingNote("daemon_inbox", true),
    "Your new access level is saved. The agent switches to it when its current turn ends, or when it restarts.");
  // Any other agent gets it when it starts again, and nothing promises more.
  for (const mode of ["mcp_polling", undefined]) {
    assert.equal(permissionTimingNote(mode, false), "Choose what the agent can access the next time it starts.");
    assert.equal(permissionTimingNote(mode, true), "Your new access level is saved. The agent gets it the next time it starts.");
  }
  assert.equal(permissionTimingNote("daemon_inbox"), permissionTimingNote("daemon_inbox", false));
});
