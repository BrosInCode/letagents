import assert from "node:assert/strict";
import test from "node:test";
import { createApp, reactive, ref } from "vue";

import type { DesktopAgentProvider, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import { managedAgentSessionsKey } from "../src/components/desktop/content/add-agent/managed-agent-sessions-context";
import {
  useAddAgentController,
  type AddAgentModalProps,
} from "../src/components/desktop/content/add-agent/useAddAgentController";
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

function provider(id: DesktopAgentProvider["id"], name: string): DesktopAgentProvider {
  return {
    id,
    name,
    description: name,
    capabilities: ["supervised_runtime"],
    supervisedDeliveryMode: "daemon_inbox",
    runtimeCommand: id,
    mcpTargetId: null,
    permissionProfiles: [{
      id: "read_only", label: "Read-only", description: "Read the project.", status: "available",
      risk: "low", detail: null, isDefault: true,
    }],
    defaultPermissionProfileId: "read_only",
  } as DesktopAgentProvider;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The real Add agent controller over a stubbed desktop bridge, open on Claude Code. */
async function openAddAgentDialog(supervisor: Record<string, unknown>) {
  const quiet = async () => null;
  addAgentForm(supervisor);
  const bridge = (globalThis as unknown as { window: { letagentsDesktop: Record<string, unknown> } }).window;
  bridge.letagentsDesktop = {
    ...bridge.letagentsDesktop,
    workers: {
      listAgentProviders: async () => [provider("claude-code", "Claude Code"), provider("codex", "Codex")],
      runAgentProviderPreflight: async () => ({ providerId: "claude-code", status: "ready", checks: [], nextAction: null }),
      listAgentProviderModels: async (providerId: string) => ({ providerId, status: "ready", models: [], defaultModel: null, error: null }),
    },
    supervisorGrant: { getStorageStatus: async () => ({ available: true, detail: "", canOpenCredentialStorage: false }) },
    openModel: { getSettingsStatus: quiet },
  };
  const app = createApp({ render: () => null });
  app.provide(managedAgentSessionsKey, { sessions: ref([]), refresh: async () => undefined, upsert: () => undefined });
  const props = reactive<AddAgentModalProps>({
    open: false,
    roomStorageMode: "local",
    roomIdentifier: "room-1",
    roomGitRoom: null,
    gitRoomMatchesActiveRepo: false,
    roomDisplayName: "Room one",
    repoRootPath: "/repo",
    repoStatus: null,
  });
  const controller = app.runWithContext(() => useAddAgentController(props, () => undefined));
  props.open = true;
  await settle();
  controller.selectProvider("claude-code");
  await settle();
  assert.equal(controller.selectedProviderId.value, "claude-code");
  return { controller, props };
}

test("the Add agent dialog consumes a first task whose agent was saved after the user switched provider", async () => {
  let resolveCreate!: (entry: DesktopSupervisorManifestEntry) => void;
  const createCalls: Array<Record<string, unknown>> = [];
  const { controller, props } = await openAddAgentDialog({
    listAgents: async () => [],
    createAgent: (input: Record<string, unknown>) => {
      createCalls.push(input);
      return new Promise<DesktopSupervisorManifestEntry>((resolve) => { resolveCreate = resolve; });
    },
  });

  controller.supervisedCharter.value = managerCharter;
  const started = controller.startManagedAgent();
  await settle();
  assert.equal(createCalls.length, 1, "the create request is in flight");
  assert.equal(createCalls[0]?.charter, managerCharter);

  // The user moves on to Codex before the Claude agent's save returns.
  controller.selectProvider("codex");
  resolveCreate(entry({ provider: "claude-code", charter: managerCharter }));
  await started;
  await settle();

  assert.equal(controller.selectedProviderId.value, "codex");
  assert.equal(controller.supervisedCharter.value, defaultSupervisedCharter,
    "the Codex form must not offer the Claude agent's first task again");
  props.open = false;
  await settle();
});

test("the Add agent dialog consumes a first task when a failed create turns out to have saved the agent", async () => {
  let saved = false;
  const { controller, props } = await openAddAgentDialog({
    listAgents: async () => saved ? [entry({ charter: managerCharter })] : [],
    createAgent: async () => {
      saved = true;
      throw new Error("create response was lost");
    },
  });

  controller.supervisedCharter.value = managerCharter;
  await controller.startManagedAgent();
  await settle();

  assert.equal(controller.supervisedCharter.value, defaultSupervisedCharter);
  props.open = false;
  await settle();
});
