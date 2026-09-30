import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import {
  defaultSupervisedCharter,
  useAddAgentConfiguration,
} from "../src/components/desktop/content/add-agent/useAddAgentConfiguration";
import { useSupervisedAgentLaunch } from "../src/components/desktop/content/add-agent/useSupervisedAgentLaunch";

const managerCharter = "You are this room's board manager. Accept proposed tasks and keep the board moving.";

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_launch-1",
    roomId: "room-1",
    displayName: "SparrowOtter",
    provider: "claude-code",
    model: null,
    charter: managerCharter,
    desiredState: "running",
    observedState: "starting",
    condition: "none",
    lastError: null,
    permissionProfileId: null,
    createdBy: "desktop",
    createdAt: "2026-09-30T00:00:00.000Z",
    workspacePath: null,
    workAttemptId: null,
    agentSessionId: null,
    agentSessionBindingState: "none",
    bindingUpdatedAt: null,
    executionGenerationId: null,
    providerContinuationId: null,
    providerPid: null,
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    ...overrides,
  };
}

function memorySessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

/** The Add agent form's first task wired to a launch, as the controller wires them. */
function addAgentForm(supervisor: Record<string, unknown> = {}) {
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [],
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
          ...supervisor,
        },
      },
    },
  });
  const configuration = useAddAgentConfiguration();
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "claude-code",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
    onSavedEntry: (saved) => configuration.consumeSupervisedCharter(saved.charter),
  });
  return { charter: configuration.supervisedCharter, launch };
}

test("a launched first task does not pre-fill the next agent's form", () => {
  const { charter, launch } = addAgentForm();
  assert.equal(charter.value, defaultSupervisedCharter);
  charter.value = `  ${managerCharter}\n`;
  launch.begin();
  launch.complete(entry());
  assert.equal(charter.value, defaultSupervisedCharter);
  launch.cleanup();
});

test("a first task is also consumed when a failed create turns out to have saved the agent", async () => {
  const { charter, launch } = addAgentForm({ listAgents: async () => [entry()] });
  charter.value = managerCharter;
  launch.begin();
  await launch.recoverFailedCreation(new Error("create timed out"));
  assert.equal(launch.conflict.value?.id, "supervised_launch-1");
  assert.equal(charter.value, defaultSupervisedCharter);
  launch.cleanup();
});

test("a first task is consumed when the saved agent is only offered back for recovery", () => {
  const { charter, launch } = addAgentForm();
  charter.value = managerCharter;
  launch.offerRecoveryCandidate(entry());
  assert.equal(charter.value, defaultSupervisedCharter);
  launch.cleanup();
});

test("text typed after the click survives, and later updates of the same agent never clear it", () => {
  const { charter, launch } = addAgentForm();
  charter.value = "Review PR #4 and report back.";
  launch.begin();
  launch.complete(entry());
  assert.equal(charter.value, "Review PR #4 and report back.");
  // Retyping the same task for a second agent must not be undone by the
  // first agent's later status updates.
  charter.value = managerCharter;
  launch.complete(entry({ observedState: "idle" }));
  assert.equal(charter.value, managerCharter);
  launch.cleanup();
});

test("the Add agent controller feeds every saved launch to the first-task draft", () => {
  const controllerSource = readFileSync(fileURLToPath(new URL(
    "../src/components/desktop/content/add-agent/useAddAgentController.ts",
    import.meta.url,
  )), "utf8");
  // Mounting the controller needs the full setup stack; its wiring is this one line.
  assert.match(controllerSource, /onSavedEntry: \(entry\) => configuration\.consumeSupervisedCharter\(entry\.charter\),/);
});
