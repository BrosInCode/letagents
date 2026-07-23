import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configurationDraft,
  configurationHasRuntimeLag,
  roomMovePresentation,
} from "../src/domain/agent-inspector-settings";

const configuration = {
  entryId: "agent_a", daemonGeneration: 7, provider: "codex", model: "gpt-next", reasoningEffort: "high" as const,
  charter: "Coordinate work.", permissionProfileId: "read_only", providerLaunchPolicy: { sandbox: true }, configRevision: 4, runtimeConfigurationRevision: 3,
};

test("settings draft preserves daemon-owned policy and makes saved/runtime revision truth explicit", () => {
  assert.deepEqual(configurationDraft(configuration), {
    model: "gpt-next", reasoningEffort: "high", charter: "Coordinate work.", permissionProfileId: "read_only", providerLaunchPolicy: { sandbox: true },
  });
  assert.equal(configurationHasRuntimeLag(configuration), true);
  assert.equal(configurationHasRuntimeLag({ ...configuration, runtimeConfigurationRevision: 4 }), false);
});

test("room-move presentation never treats transitional phases as a completed move", () => {
  const base = { operationId: "move", requestId: "request", entryId: "agent_a", sourceRoomId: "source", destinationRoomId: "destination", daemonGeneration: 7, workAttemptId: "attempt", executionGenerationId: "execution", agentSessionId: "session", remoteRoomId: null, destinationCursor: null, error: null, createdAt: "now", updatedAt: "now" };
  for (const phase of ["prepared", "waiting_for_current_turn", "joining_destination", "membership_committed", "rotating_credentials", "bootstrapping_destination_tail", "rollback_required"] as const) assert.equal(roomMovePresentation({ ...base, phase }).terminal, false, phase);
  assert.equal(roomMovePresentation({ ...base, phase: "active" }).terminal, true);
  assert.equal(roomMovePresentation({ ...base, phase: "failed" }).terminal, true);
});

test("settings surface preserves the local conflict draft, immutable provider, typed purge, and phase recovery controls", () => {
  const file = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSettings.vue", import.meta.url)), "utf8");
  assert.match(file, /Provider is fixed when this agent is created/);
  assert.match(file, /Your draft is preserved/);
  assert.match(file, /Overwrite/);
  assert.match(file, /PURGE \{\{ entryId \}\}/);
  assert.match(file, /Check recovery/);
  assert.match(file, /worktree/);
});
