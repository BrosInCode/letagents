import assert from "node:assert/strict";
import test from "node:test";
import { createApp, reactive, ref, shallowRef } from "vue";

import type { DesktopAgentProvider, DesktopAgentProviderModelsResult, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import type { SupervisorEntriesResource } from "../src/domain/agent-inspector-identity";
import { supervisorEntriesKey } from "../src/components/desktop/content/add-agent/supervisor-entries-context";
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

/**
 * The Add agent form's first task wired to a launch, as the controller wires
 * them. `pushed` is the room shell's supervisor entry list, which the launch follows.
 */
function addAgentForm(
  supervisor: Record<string, unknown> = {},
  pushed: readonly DesktopSupervisorManifestEntry[] = [entry()],
) {
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
    entries: () => pushed,
    entriesState: () => "ready",
    entriesError: () => null,
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
async function openAddAgentDialog(
  supervisor: Record<string, unknown>,
  pushed = shallowRef<readonly DesktopSupervisorManifestEntry[]>([]),
  listModels?: (providerId: string) => Promise<DesktopAgentProviderModelsResult>,
) {
  const quiet = async () => null;
  addAgentForm(supervisor);
  const bridge = (globalThis as unknown as { window: { letagentsDesktop: Record<string, unknown> } }).window;
  bridge.letagentsDesktop = {
    ...bridge.letagentsDesktop,
    workers: {
      listAgentProviders: async () => [provider("claude-code", "Claude Code"), provider("codex", "Codex")],
      runAgentProviderPreflight: async () => ({ providerId: "claude-code", status: "ready", canStart: true, checks: [], nextAction: null }),
      listAgentProviderModels: listModels ?? (async (providerId: string) => ({ providerId, status: "ready", models: [], defaultModel: null, error: null })),
    },
    supervisorGrant: { getStorageStatus: async () => ({ available: true, detail: "", canOpenCredentialStorage: false }) },
    openModel: { getSettingsStatus: quiet },
  };
  const app = createApp({ render: () => null });
  app.provide(supervisorEntriesKey, {
    entries: pushed,
    state: ref<SupervisorEntriesResource["state"]>("ready"),
    error: ref<string | null>(null),
    refresh: async () => undefined,
  });
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
  const events: Array<[string, unknown]> = [];
  const presentations: Array<{ fromActiveForm: boolean }> = [];
  const controller = app.runWithContext(() => useAddAgentController(props, ((type: string, value: unknown, presentation: { fromActiveForm: boolean }) => {
    events.push([type, value]);
    if (type === "launch-saved") presentations.push(presentation);
  }) as never));
  props.open = true;
  await settle();
  controller.selectProvider("claude-code");
  await settle();
  assert.equal(controller.selectedProviderId.value, "claude-code");
  return { controller, props, events, presentations };
}

test("reopening a failed saved launch restores its exact model as the catalog arrives and retries only that agent", async () => {
  let saved: DesktopSupervisorManifestEntry | null = null;
  let createCount = 0;
  const retries: unknown[][] = [];
  let delayCatalog = false;
  let includeModel = true;
  const pendingCatalogs: Array<() => void> = [];
  const { controller, props } = await openAddAgentDialog({
    listAgents: async () => saved ? [saved] : [],
    createAgent: async (input: Record<string, unknown>) => {
      createCount++;
      saved = entry({ provider: "codex", model: input.model as string,
        observedState: "failed", condition: "coordination_blocked",
        lastError: "The project is not a Git repository.", permissionProfileId: "read_only" });
      return saved;
    },
    setDesiredState: async (...args: unknown[]) => { retries.push(args); return saved!; },
  }, undefined, async providerId => {
    if (delayCatalog) await new Promise<void>(resolve => pendingCatalogs.push(resolve));
    return { providerId: providerId as "codex", status: "ready", models: includeModel
      ? [{ id: "gpt-6-luna", label: "GPT-6-Luna", source: "provider" }] : [], defaultModel: null, error: null };
  });
  try {
    controller.selectProvider("codex");
    await settle();
    controller.handleModelChoiceValue("option:gpt-6-luna");
    await settle();
    await controller.startManagedAgent();
    assert.equal(saved?.model, "gpt-6-luna");
    props.open = false;
    await settle();
    assert.equal(controller.selectedModelChoice.value, "default");
    delayCatalog = true;
    props.open = true;
    await settle();
    assert.equal(controller.supervisedUi.launch.conflict.value?.id, saved?.id);
    assert.equal(controller.selectedModelChoice.value, "custom", "a loading catalog cannot discard the durable model ID");
    assert.equal(controller.customModelId.value, "gpt-6-luna");
    delayCatalog = false;
    pendingCatalogs.splice(0).forEach(resolve => resolve());
    await settle();
    assert.equal(controller.selectedModelChoice.value, "option:gpt-6-luna", "the picker and brain regain the actual model");
    assert.equal(controller.modelSelectOptions.value.find(option => option.value === controller.selectedModelChoice.value)?.label, "GPT-6-Luna");
    assert.equal(controller.selectedPermissionProfile.value?.id, "read_only");
    await controller.supervisedUi.launch.handleRecover("retry");
    assert.deepEqual(retries, [[saved!.id, "running"]], "retry sends no draft model or replacement creation");
    assert.equal(createCount, 1);
    assert.equal(saved?.model, "gpt-6-luna");
    includeModel = false;
    controller.refreshProviderModels();
    await settle();
    assert.equal(controller.selectedModelChoice.value, "custom", "a removed catalog option remains the saved exact ID");
    assert.equal(controller.customModelId.value, "gpt-6-luna");
    controller.handleModelChoiceValue("default");
    controller.refreshProviderModels();
    await settle();
    assert.equal(controller.selectedModelChoice.value, "default", "a later explicit draft choice is not overwritten");
  } finally {
    pendingCatalogs.splice(0).forEach(resolve => resolve());
    props.open = false;
    await settle();
  }
});

test("a blank custom model blocks both Start and direct launch; provider default remains a valid null model", async () => {
  const createCalls: Array<Record<string, unknown>> = [];
  const { controller, props } = await openAddAgentDialog({
    listAgents: async () => [],
    createAgent: async (input: Record<string, unknown>) => {
      createCalls.push(input);
      return entry({ model: input.model as string | null });
    },
  });
  try {
    assert.equal(controller.canStartManagedAgent.value, true);
    assert.equal(controller.customModelError.value, null);
    controller.handleModelChoiceValue("custom");
    for (const blank of ["", " \n\t "]) {
      controller.customModelId.value = blank;
      await settle();
      assert.equal(controller.canStartManagedAgent.value, false);
      assert.equal(controller.customModelError.value, "Enter a model ID or choose provider default.");
      await controller.startManagedAgent();
      assert.equal(createCalls.length, 0, "programmatic launch must not silently choose provider default");
      assert.equal(controller.startingAgent.value, false);
    }
    controller.handleModelChoiceValue("default");
    await settle();
    assert.equal(controller.customModelError.value, null, "switching away clears the inline error");
    assert.equal(controller.canStartManagedAgent.value, true);
    await controller.startManagedAgent();
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]?.model, null, "explicit provider default retains its existing null mapping");
  } finally {
    props.open = false;
    await settle();
  }
});

test("a filled custom model clears validation and sends the exact trimmed ID", async () => {
  const createCalls: Array<Record<string, unknown>> = [];
  const { controller, props } = await openAddAgentDialog({
    listAgents: async () => [],
    createAgent: async (input: Record<string, unknown>) => {
      createCalls.push(input);
      return entry({ model: input.model as string | null });
    },
  });
  try {
    controller.handleModelChoiceValue("custom");
    assert.ok(controller.customModelError.value);
    controller.customModelId.value = "  claude-custom-model  ";
    await settle();
    // This fixture does not run debounce timers; complete the same preflight
    // through Check again before asserting that Start becomes available.
    await controller.retryProviderSetup();
    await settle();
    assert.equal(controller.customModelError.value, null);
    assert.equal(controller.canStartManagedAgent.value, true);
    await controller.startManagedAgent();
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]?.model, "claude-custom-model");
  } finally {
    props.open = false;
    await settle();
  }
});

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
  const pushed = shallowRef<readonly DesktopSupervisorManifestEntry[]>([]);
  const { controller, props } = await openAddAgentDialog({
    listAgents: async () => saved ? [entry({ charter: managerCharter })] : [],
    createAgent: async () => {
      // The daemon saved the agent and pushed its entry; only the response was lost.
      saved = true;
      pushed.value = [entry({ charter: managerCharter })];
      throw new Error("create response was lost");
    },
  }, pushed);

  controller.supervisedCharter.value = managerCharter;
  await controller.startManagedAgent();
  await settle();

  assert.equal(controller.supervisedCharter.value, defaultSupervisedCharter);
  props.open = false;
  await settle();
});


test("closing after durable creation still hands the exact saved identity to the room without marking it ready", async () => {
  let resolveCreate!: (entry: DesktopSupervisorManifestEntry) => void;
  let request: Record<string, unknown> | undefined;
  const { controller, props, events } = await openAddAgentDialog({
    listAgents: async () => [],
    createAgent: (input: Record<string, unknown>) => {
      request = input;
      return new Promise<DesktopSupervisorManifestEntry>(resolve => { resolveCreate = resolve; });
    },
  });
  controller.configuredName.value = "Atlas";
  controller.configuredAvatar.value = { kind: "character", character: "orbit", color: "sage" };
  controller.supervisedCharter.value = managerCharter;
  const started = controller.startManagedAgent();
  await settle();
  assert.equal(request?.displayName, "Atlas");
  assert.deepEqual(request?.avatar, { kind: "character", character: "orbit", color: "sage" });
  props.open = false;
  await settle();
  const saved = entry({ displayName: "Atlas", avatar: { kind: "character", character: "orbit", color: "sage" } });
  resolveCreate(saved);
  await started;
  assert.deepEqual(events.filter(([type]) => type === "launch-saved"), [["launch-saved", saved]]);
  assert.equal(saved.observedState, "starting");
  assert.equal(controller.supervisedCharter.value, defaultSupervisedCharter);
});

test("a saved create result from a room left behind never presents progress in the new room", async () => {
  let resolveCreate!: (entry: DesktopSupervisorManifestEntry) => void;
  const { controller, props, events } = await openAddAgentDialog({
    listAgents: async () => [],
    createAgent: () => new Promise<DesktopSupervisorManifestEntry>(resolve => { resolveCreate = resolve; }),
  });
  controller.supervisedCharter.value = managerCharter;
  const started = controller.startManagedAgent();
  await settle();
  props.roomIdentifier = "room-2";
  await settle();
  resolveCreate(entry());
  await started;
  assert.equal(events.some(([type]) => type === "launch-saved"), false);
  props.open = false;
  await settle();
});


test("a lost create response after closing still points to the durable agent, without creating again", async () => {
  let rejectCreate!: (reason: Error) => void;
  let saved = false;
  let createCount = 0;
  const confirmed = entry();
  const { controller, props, events } = await openAddAgentDialog({
    listAgents: async () => saved ? [confirmed] : [],
    createAgent: () => { createCount++; return new Promise<DesktopSupervisorManifestEntry>((_, reject) => { rejectCreate = reject; }); },
  });
  controller.supervisedCharter.value = managerCharter;
  const started = controller.startManagedAgent();
  await settle();
  props.open = false;
  await settle();
  saved = true;
  rejectCreate(new Error("Response lost after save"));
  await started;
  await settle();
  assert.equal(createCount, 1);
  assert.deepEqual(events.filter(([type]) => type === "launch-saved"), [["launch-saved", confirmed]]);
  assert.equal(controller.supervisedCharter.value, defaultSupervisedCharter);
});


test("a previous form's save does not animate or close a new form opened in the same room", async () => {
  let resolveCreate!: (entry: DesktopSupervisorManifestEntry) => void;
  const { controller, props, presentations } = await openAddAgentDialog({
    listAgents: async () => [],
    createAgent: () => new Promise<DesktopSupervisorManifestEntry>(resolve => { resolveCreate = resolve; }),
  });
  controller.supervisedCharter.value = managerCharter;
  const started = controller.startManagedAgent();
  await settle();
  props.open = false;
  await settle();
  props.open = true;
  await settle();
  controller.supervisedCharter.value = "A separate new draft";
  resolveCreate(entry());
  await started;
  assert.deepEqual(presentations, [{ fromActiveForm: false }]);
  assert.equal(controller.supervisedCharter.value, "A separate new draft");
  props.open = false;
  await settle();
});
