import assert from "node:assert/strict";
import test from "node:test";
import { computed, nextTick, ref } from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
} from "../../electron/ipc-types";
import { useAddAgentConfiguration } from "../src/components/desktop/content/add-agent/useAddAgentConfiguration";
import { useAddAgentSetup } from "../src/components/desktop/content/add-agent/useAddAgentSetup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function provider(id: "codex" | "cursor"): DesktopAgentProvider {
  return {
    id,
    name: id === "codex" ? "Codex" : "Cursor",
    description: "Agent provider",
    capabilities: ["desktop_managed_runtime"],
    runtimeCommand: id,
    mcpTargetId: id,
    permissionProfiles: [],
    defaultPermissionProfileId: null,
  };
}

test("provider switching invalidates an in-flight setup preflight", async () => {
  const oldPreflight = deferred<DesktopAgentProviderPreflight>();
  let preflightCalls = 0;
  const preflightInputs: DesktopAgentProviderPreflightInput[] = [];
  let laterPreflight: Promise<DesktopAgentProviderPreflight> | null = null;
  Object.assign(globalThis, {
    window: {
      clearTimeout: () => undefined,
      setTimeout: () => 1,
      letagentsDesktop: {
        workers: {
          runAgentProviderPreflight: (providerId: string, input: DesktopAgentProviderPreflightInput) => {
            preflightCalls += 1;
            preflightInputs.push(input);
            if (preflightCalls === 1) return oldPreflight.promise;
            if (laterPreflight) return laterPreflight;
            return Promise.resolve({
              providerId,
              status: "ready",
              canStart: true,
              message: "Current provider ready",
              detail: null,
              nextAction: null,
              version: "2",
              mcpStatus: "installed",
            });
          },
        },
      },
    },
  });
  let open = false;
  const setup = useAddAgentSetup();
  const selectedProvider = computed(() =>
    setup.providers.value.find((item) => item.id === setup.selectedProviderId.value) ?? null,
  );
  const actions = setup.bind({
    open: () => open,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProvider,
    selectedPermissionProfile: computed(() => null),
    expectedWorktreeBranch: computed(() => null),
    authCommand: computed(() => null),
    externalJoinPrompt: computed(() => null),
    selectedCursorMcpPolicy: ref("filter_letagents"),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    selectedEffort: ref(""),
    launchMode: ref("legacy"),
    loadOpenModelSettings: async () => undefined,
    loadProviderModels: async () => undefined,
    syncPermissionProfileSelection: () => undefined,
    syncDeliveryModeSelection: () => undefined,
    invalidateConfigurationRequests: () => undefined,
    resetConfigurationModelSelection: () => undefined,
    resetConfigurationTransientState: () => undefined,
    onDetectRecoverableLaunch: () => undefined,
    onResetSupervisedLaunch: () => undefined,
    onCleanupSupervisedLaunch: () => undefined,
    onResetStartingAgent: () => undefined,
    onChooseWorktree: () => undefined,
  });
  setup.providers.value = [provider("codex"), provider("cursor")];
  setup.selectedProviderId.value = "codex";
  await nextTick();
  open = true;

  const pending = actions.runPreflight();
  actions.selectProvider("cursor");
  oldPreflight.resolve({
    providerId: "codex",
    status: "ready",
    canStart: true,
    message: "Ready",
    detail: null,
    nextAction: null,
    version: "1",
    mcpStatus: "installed",
  });
  await pending;
  await nextTick();
  await Promise.resolve();

  assert.notEqual(setup.preflight.value?.providerId, "codex");
  assert.equal(setup.selectedProviderId.value, "cursor");

  const backgroundResult = deferred<DesktopAgentProviderPreflight>();
  laterPreflight = backgroundResult.promise;
  const stableSnapshot = setup.preflight.value;
  const backgroundCheck = actions.runPreflight();
  assert.equal(setup.loadingPreflight.value, true, "revalidation keeps the snapshot but disables duplicate checks");
  assert.equal(setup.preflight.value, stableSnapshot);
  backgroundResult.resolve({
    providerId: "cursor",
    status: "ready",
    canStart: true,
    message: "Still ready",
    detail: null,
    nextAction: null,
    version: "3",
    mcpStatus: "installed",
  });
  await backgroundCheck;
  assert.equal(setup.preflight.value?.message, "Still ready");
  const sameProviderSnapshot = setup.preflight.value;
  actions.selectProvider("cursor");
  assert.equal(setup.preflight.value, sameProviderSnapshot, "clicking the selected provider is a no-op");

  const retryResult = deferred<DesktopAgentProviderPreflight>();
  laterPreflight = retryResult.promise;
  const callsBeforeRetry = preflightCalls;
  const retry = actions.retryProviderSetup();
  await actions.retryProviderSetup();
  assert.equal(preflightCalls, callsBeforeRetry + 1, "duplicate Check again clicks share one in-flight preflight");
  retryResult.resolve({
    providerId: "cursor",
    status: "ready",
    canStart: true,
    message: "Refreshed",
    detail: null,
    nextAction: null,
    version: "4",
    mcpStatus: "installed",
  });
  await retry;
  assert.equal(preflightInputs.at(-1)?.refreshEnvironment, true);
  assert.equal(preflightInputs.at(-1)?.refreshModels, true);
});

test("configuration invalidation rejects a stale model-catalog response", async () => {
  const oldCatalog = deferred<DesktopAgentProviderModelsResult>();
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: {
        workers: { listAgentProviderModels: () => oldCatalog.promise },
      },
    },
  });
  const configuration = useAddAgentConfiguration();
  const selectedProviderId = ref<DesktopAgentProvider["id"] | null>("codex");
  const selectedProvider = computed(() => provider(
    selectedProviderId.value === "cursor" ? "cursor" : "codex",
  ));
  const actions = configuration.bind({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProviderId,
    selectedProvider,
    selectedPermissionProfile: computed(() => null),
    showOpenModelConfig: computed(() => false),
    showModelSelector: computed(() => true),
    showEffortSelector: computed(() => true),
    providerModelOptions: computed(() => configuration.providerModels.value?.models ?? []),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    requestPreflight: () => undefined,
    runPreflight: async () => undefined,
    onMessage: () => undefined,
  });

  const pending = actions.loadProviderModels();
  selectedProviderId.value = "cursor";
  actions.invalidateRequests();
  oldCatalog.resolve({
    providerId: "codex",
    status: "ready",
    models: [{ id: "old-model", label: "Old model", description: null, recommended: false }],
    defaultModel: "old-model",
    error: null,
  });
  await pending;

  assert.equal(configuration.providerModels.value, null);
});

test("Cursor keeps legacy read-only and supervised repo-write defaults independent", async () => {
  const configuration = useAddAgentConfiguration();
  const selectedProviderId = ref<DesktopAgentProvider["id"] | null>("cursor");
  const profiles: DesktopAgentProvider["permissionProfiles"] = [
    {
      id: "read_only", label: "Read-only", description: "Inspect only.",
      status: "available", risk: "low", detail: null, isDefault: true,
    },
    {
      id: "sandboxed_write", label: "Sandboxed writes", description: "Repo-scoped writes.",
      status: "available", risk: "medium", detail: null, isDefault: false,
    },
    {
      id: "full_access", label: "Full access", description: "Trusted repo access.",
      status: "available", risk: "high", detail: null, isDefault: false,
    },
  ];
  const selectedProvider = computed<DesktopAgentProvider>(() => ({
    ...provider("cursor"),
    permissionProfiles: profiles,
    defaultPermissionProfileId: "read_only",
  }));
  const actions = configuration.bind({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProviderId,
    selectedProvider,
    selectedPermissionProfile: computed(() =>
      profiles.find((profile) => profile.id === configuration.selectedPermissionProfileId.value) ?? null
    ),
    showOpenModelConfig: computed(() => false),
    showModelSelector: computed(() => false),
    showEffortSelector: computed(() => false),
    providerModelOptions: computed(() => []),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    requestPreflight: () => undefined,
    runPreflight: async () => undefined,
    onMessage: () => undefined,
  });

  actions.syncPermissionProfileSelection();
  assert.equal(configuration.selectedPermissionProfileId.value, "read_only");

  configuration.launchMode.value = "supervised";
  assert.equal(configuration.selectedPermissionProfileId.value, "sandboxed_write");
  actions.selectPermissionProfile(profiles[2]!);
  assert.equal(configuration.selectedPermissionProfileId.value, "full_access");

  configuration.launchMode.value = "legacy";
  assert.equal(configuration.selectedPermissionProfileId.value, "read_only");
  configuration.launchMode.value = "supervised";
  assert.equal(configuration.selectedPermissionProfileId.value, "full_access");
});

test("closing the modal does not unlock a second Open Model write", async () => {
  const pendingSave = deferred<{
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    error: string | null;
  }>();
  let saves = 0;
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: {
        openModel: {
          saveSettings: () => {
            saves += 1;
            return pendingSave.promise;
          },
        },
      },
    },
  });
  const configuration = useAddAgentConfiguration();
  const selectedProviderId = ref<DesktopAgentProvider["id"] | null>("open-model");
  const selectedProvider = computed<DesktopAgentProvider>(() => ({
    id: "open-model",
    name: "Open Model",
    description: "Bring your own model",
    capabilities: ["desktop_managed_runtime"],
    runtimeCommand: "codex",
    mcpTargetId: "open-model",
    permissionProfiles: [],
    defaultPermissionProfileId: null,
  }));
  const actions = configuration.bind({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProviderId,
    selectedProvider,
    selectedPermissionProfile: computed(() => null),
    showOpenModelConfig: computed(() => true),
    showModelSelector: computed(() => false),
    showEffortSelector: computed(() => false),
    providerModelOptions: computed(() => []),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    requestPreflight: () => undefined,
    runPreflight: async () => undefined,
    onMessage: () => undefined,
  });

  const first = actions.saveOpenModelSettings();
  actions.resetTransientState();
  const second = actions.saveOpenModelSettings();
  assert.equal(saves, 1);
  assert.equal(configuration.savingOpenModelSettings.value, true);

  pendingSave.resolve({ baseUrl: "http://localhost:11434", model: "qwen", hasApiKey: false, error: null });
  await Promise.all([first, second]);
  assert.equal(configuration.savingOpenModelSettings.value, false);
});

test("closing the modal does not unlock duplicate provider setup side effects", async () => {
  const pendingSetup = deferred<{ message: string }>();
  let setupCalls = 0;
  Object.assign(globalThis, {
    window: {
      clearTimeout: () => undefined,
      setTimeout: () => 1,
      letagentsDesktop: {
        workers: {
          runAgentProviderSetup: () => {
            setupCalls += 1;
            return pendingSetup.promise;
          },
        },
      },
    },
  });
  let open = true;
  const setup = useAddAgentSetup();
  const selectedProvider = computed(() => provider("codex"));
  const actions = setup.bind({
    open: () => open,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProvider,
    selectedPermissionProfile: computed(() => null),
    expectedWorktreeBranch: computed(() => null),
    authCommand: computed(() => null),
    externalJoinPrompt: computed(() => null),
    selectedCursorMcpPolicy: ref("filter_letagents"),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    selectedEffort: ref(""),
    launchMode: ref("legacy"),
    loadOpenModelSettings: async () => undefined,
    loadProviderModels: async () => undefined,
    syncPermissionProfileSelection: () => undefined,
    syncDeliveryModeSelection: () => undefined,
    invalidateConfigurationRequests: () => undefined,
    resetConfigurationModelSelection: () => undefined,
    resetConfigurationTransientState: () => undefined,
    onDetectRecoverableLaunch: () => undefined,
    onResetSupervisedLaunch: () => undefined,
    onCleanupSupervisedLaunch: () => undefined,
    onResetStartingAgent: () => undefined,
    onChooseWorktree: () => undefined,
  });
  setup.providers.value = [provider("codex")];
  setup.selectedProviderId.value = "codex";

  void actions.runSetupAction("install_runtime");
  const first = actions.runSetupAction("install_runtime");
  open = false;
  actions.resetTransientState();
  open = true;
  await actions.runSetupAction("install_runtime");
  await actions.runSetupAction("install_runtime");
  assert.equal(setupCalls, 1);
  assert.equal(setup.setupBusy.value, true);

  pendingSetup.resolve({ message: "Installed" });
  await first;
  assert.equal(setup.setupBusy.value, false);
});
