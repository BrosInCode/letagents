import assert from "node:assert/strict";
import test from "node:test";
import { computed, nextTick, ref } from "vue";
import type {
  DesktopGitRoomInfo,
  DesktopAgentProvider,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
} from "../../electron/ipc-types";
import { listManagedAgentPermissionProfiles } from "../../electron/main/agents/managed-agent-permission-profiles";
import { useAddAgentConfiguration } from "../src/components/desktop/content/add-agent/useAddAgentConfiguration";
import { useAddAgentSetup } from "../src/components/desktop/content/add-agent/useAddAgentSetup";
import { supervisedPermissionProfilePresentation } from "../src/domain/managed-agents";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function provider(id: "codex" | "cursor"): DesktopAgentProvider {
  return {
    id,
    name: id === "codex" ? "Codex" : "Cursor",
    description: "Agent provider",
    capabilities: ["supervised_runtime"],
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
  let focusListener: (() => void) | undefined;
  Object.assign(globalThis, {
    window: {
      clearTimeout: () => undefined,
      setTimeout: () => 1,
      addEventListener: (event: string, listener: () => void) => { if (event === "focus") focusListener = listener; },
      letagentsDesktop: {
        supervisorGrant: { getStorageStatus: async () => ({ available: true }) },
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
  const roomSnapshot = ref<{ path: string; git: DesktopGitRoomInfo }>({ path: "/repo", git: {
    provider: "github", host: "github.com", repository: { id: null, fullName: "owner/repo", owner: "owner", name: "repo" },
    ref: { type: "branch", name: "main", defaultBranch: "main", baseRef: null, headRef: null, headRepository: null },
    visibility: "public", accessMode: "public", isDefault: true, source: "test",
  } });
  let open = false;
  const setup = useAddAgentSetup();
  const selectedProvider = computed(() =>
    setup.providers.value.find((item) => item.id === setup.selectedProviderId.value) ?? null,
  );
  const actions = setup.bind({
    open: () => open,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => roomSnapshot.value.git,
    repoRootPath: () => roomSnapshot.value.path,
    selectedProvider,
    selectedPermissionProfile: computed(() => null),
    expectedWorktreeBranch: computed(() => null),
    authCommand: computed(() => null),
    externalJoinPrompt: computed(() => null),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    loadOpenModelSettings: async () => undefined,
    loadProviderModels: async () => undefined,
    syncPermissionProfileSelection: () => undefined,
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
  const pendingCalls = preflightCalls;
  for (let i = 0; i < 3; i++) {
    roomSnapshot.value = { ...roomSnapshot.value, git: { ...roomSnapshot.value.git, ref: { ...roomSnapshot.value.git.ref } } };
    await nextTick();
  }
  assert.equal(preflightCalls, pendingCalls, "equivalent snapshots preserve the pending check");
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
  laterPreflight = null;
  for (const change of [
    () => { roomSnapshot.value.path = "/other-repo"; },
    () => { roomSnapshot.value.git.ref.name = "feature"; },
    () => { roomSnapshot.value.git.ref.type = "tag"; },
  ]) {
    const before = preflightCalls;
    change();
    await nextTick();
    await Promise.resolve();
    assert.equal(preflightCalls, before + 1, "actual repository/ref changes refresh setup");
  }

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
  for (const input of preflightInputs) {
    assert.equal("launchMode" in input, false, "preflight never names a launch mode");
    assert.equal("cursorMcpPolicy" in input, false, "preflight never carries a Cursor MCP policy");
    assert.equal("effort" in input, false, "preflight never reads the effort, so it never carries it");
  }

  setup.secureStorageStatus.value = { available: false, detail: "Locked" } as never;
  actions.armSecureStorageFocusRecheck();
  const beforeFocus = preflightCalls;
  assert.ok(focusListener);
  focusListener();
  await nextTick();
  await Promise.resolve();
  assert.equal(preflightCalls, beforeFocus + 1, "returning from storage unlock rechecks readiness");
  assert.equal(preflightInputs.at(-1)?.refreshEnvironment, undefined,
    "focus must not replace the service that owns live approvals");
  focusListener();
  assert.equal(preflightCalls, beforeFocus + 1, "the storage focus recheck is one-shot");
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
    selectedPermissionProfiles: computed(() => selectedProvider.value.permissionProfiles),
    selectedPermissionProfile: computed(() => null),
    showOpenModelConfig: computed(() => false),
    showModelSelector: computed(() => true),
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

test("Cursor defaults to sandboxed writes and keeps repo-less authority separate", async () => {
  const configuration = useAddAgentConfiguration();
  const selectedProviderId = ref<DesktopAgentProvider["id"] | null>("cursor");
  const roomIdentifier = ref("room-1");
  const repoRootPath = ref<string | null>("/repo");
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
    roomIdentifier: () => roomIdentifier.value,
    roomGitRoom: () => null,
    repoRootPath: () => repoRootPath.value,
    selectedProviderId,
    selectedProvider,
    selectedPermissionProfiles: computed(() => profiles),
    selectedPermissionProfile: computed(() =>
      profiles.find((profile) => profile.id === configuration.selectedPermissionProfileId.value) ?? null
    ),
    showOpenModelConfig: computed(() => false),
    showModelSelector: computed(() => false),
    providerModelOptions: computed(() => []),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    requestPreflight: () => undefined,
    runPreflight: async () => undefined,
    onMessage: () => undefined,
  });

  actions.syncPermissionProfileSelection();
  assert.equal(configuration.selectedPermissionProfileId.value, "sandboxed_write");

  actions.selectPermissionProfile(profiles[2]!);
  assert.equal(configuration.selectedPermissionProfileId.value, "full_access");

  repoRootPath.value = null;
  assert.equal(
    configuration.selectedPermissionProfileId.value,
    "read_only",
    "a repo-backed broad selection never becomes the default authority in a repo-less room",
  );

  repoRootPath.value = "/repo";
  assert.equal(
    configuration.selectedPermissionProfileId.value,
    "full_access",
    "returning to the repo restores its independent remembered authority",
  );

  repoRootPath.value = null;
  profiles[0]!.status = "gated";
  actions.syncPermissionProfileSelection();
  assert.equal(configuration.selectedPermissionProfileId.value, "read_only");
  assert.equal(
    profiles.find((profile) => profile.id === configuration.selectedPermissionProfileId.value)?.status,
    "gated",
    "the existing start gate remains authoritative until the human chooses an available profile",
  );
  actions.selectPermissionProfile(profiles[2]!);
  assert.equal(configuration.selectedPermissionProfileId.value, "full_access");
  actions.syncPermissionProfileSelection();
  assert.equal(
    configuration.selectedPermissionProfileId.value,
    "full_access",
    "catalog refresh retains the explicit available repo-less choice",
  );

  roomIdentifier.value = "room-2";
  actions.resetTransientState();
  assert.equal(
    configuration.selectedPermissionProfileId.value,
    "read_only",
    "a new repo-less room is safe before its provider refresh resolves",
  );
});

test("Codex in a room with no project is offered Read-only first, and can start with it", () => {
  const configuration = useAddAgentConfiguration();
  const selectedProviderId = ref<DesktopAgentProvider["id"] | null>("codex");
  const repoRootPath = ref<string | null>(null);
  // The real catalog, presented as Add Agent presents it for a supervised agent.
  const catalog = listManagedAgentPermissionProfiles("codex");
  const selectedPermissionProfiles = computed(() =>
    catalog.map((profile) => supervisedPermissionProfilePresentation("codex", profile, { hasProject: Boolean(repoRootPath.value) })));
  const selectedPermissionProfile = computed(() =>
    selectedPermissionProfiles.value.find((profile) => profile.id === configuration.selectedPermissionProfileId.value) ?? null);
  const actions = configuration.bind({
    open: () => true,
    roomIdentifier: () => "room-without-project",
    roomGitRoom: () => null,
    repoRootPath: () => repoRootPath.value,
    selectedProviderId,
    selectedProvider: computed<DesktopAgentProvider>(() => ({ ...provider("codex"), permissionProfiles: catalog, defaultPermissionProfileId: "full_access" })),
    selectedPermissionProfiles,
    selectedPermissionProfile,
    showOpenModelConfig: computed(() => false),
    showModelSelector: computed(() => false),
    providerModelOptions: computed(() => []),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    requestPreflight: () => undefined,
    runPreflight: async () => undefined,
    onMessage: () => undefined,
  });

  // No project: a scratch folder is not a trusted boundary, so the most restrictive level is the one offered.
  actions.syncPermissionProfileSelection();
  assert.equal(configuration.selectedPermissionProfileId.value, "read_only");
  // Start is enabled only for a level that is available. Before Codex had Read-only this choice was
  // shown as unavailable, and the owner had to pick another level before the agent could start.
  assert.equal(selectedPermissionProfile.value?.status, "available");
  assert.equal(selectedPermissionProfile.value?.label, "Read-only");

  // The owner's own choice in that room is kept over the offered one.
  actions.selectPermissionProfile(selectedPermissionProfiles.value.find((profile) => profile.id === "ask_before_write")!);
  actions.syncPermissionProfileSelection();
  assert.equal(configuration.selectedPermissionProfileId.value, "ask_before_write");

  // With a project Codex is offered its default level, as before.
  repoRootPath.value = "/repo";
  actions.syncPermissionProfileSelection();
  assert.equal(configuration.selectedPermissionProfileId.value, "full_access");
  assert.equal(catalog.find((profile) => profile.isDefault)?.id, "full_access");
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
    capabilities: ["supervised_runtime"],
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
    selectedPermissionProfiles: computed(() => selectedProvider.value.permissionProfiles),
    selectedPermissionProfile: computed(() => null),
    showOpenModelConfig: computed(() => true),
    showModelSelector: computed(() => false),
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
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    loadOpenModelSettings: async () => undefined,
    loadProviderModels: async () => undefined,
    syncPermissionProfileSelection: () => undefined,
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

test("successful secure-storage recovery clears only its own stale warning", async () => {
  let storageAvailable = false;
  Object.assign(globalThis, {
    window: {
      clearTimeout: () => undefined,
      setTimeout: () => 1,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      letagentsDesktop: {
        workers: {
          runAgentProviderPreflight: async () => ({
            providerId: "codex",
            status: "ready",
            canStart: true,
            message: "Ready",
            detail: null,
            nextAction: null,
            version: "1",
            mcpStatus: "installed",
          }),
        },
        supervisorGrant: {
          getStorageStatus: async () => ({
            available: storageAvailable,
            detail: storageAvailable ? "Secure storage ready" : "Unlock your login Keychain",
            canOpenCredentialStorage: !storageAvailable,
          }),
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
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    loadOpenModelSettings: async () => undefined,
    loadProviderModels: async () => undefined,
    syncPermissionProfileSelection: () => undefined,
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

  await actions.runPreflight();
  assert.equal(setup.secureStorageStatus.value?.available, false);
  setup.setSecureStorageRecoveryMessage("Unlock, then return");
  storageAvailable = true;
  await actions.runPreflight();
  assert.equal(setup.secureStorageStatus.value?.available, true);
  assert.equal(setup.setupMessage.value, null);

  setup.setSecureStorageRecoveryMessage("Unlock, then return");
  setup.setSetupMessage("An unrelated provider warning", "error");
  await actions.runPreflight();
  assert.equal(setup.setupMessage.value, "An unrelated provider warning");
  open = false;
  actions.resetTransientState();
});

test("changing the effort does not run preflight, while a model change still does", async () => {
  Object.assign(globalThis, {
    window: { clearTimeout: () => undefined, setTimeout: () => 1, letagentsDesktop: {} },
  });
  const configuration = useAddAgentConfiguration();
  const selectedProviderId = ref<DesktopAgentProvider["id"] | null>("codex");
  const selectedProvider = computed(() => provider("codex"));
  let preflightRequests = 0;
  const actions = configuration.bind({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProviderId,
    selectedProvider,
    selectedPermissionProfiles: computed(() => selectedProvider.value.permissionProfiles),
    selectedPermissionProfile: computed(() => null),
    showOpenModelConfig: computed(() => false),
    showModelSelector: computed(() => true),
    providerModelOptions: computed(() => []),
    selectedModel: computed(() => null),
    selectedModelSource: computed(() => null),
    requestPreflight: () => { preflightRequests += 1; },
    runPreflight: async () => undefined,
    onMessage: () => undefined,
  });

  configuration.selectedEffort.value = "high";
  await nextTick();
  actions.handleEffortValue("low");
  await nextTick();
  actions.handleEffortValue("");
  await nextTick();
  assert.equal(configuration.selectedEffort.value, "");
  assert.equal(preflightRequests, 0, "preflight never reads the effort, so an effort change must not run it");

  configuration.selectedModelMode.value = "option";
  await nextTick();
  assert.equal(preflightRequests, 1, "a model change still re-runs preflight");
});

/** Add Agent setup wired to a preflight IPC that answers only when the test resolves a call. */
function preflightBurstHarness() {
  const calls: DesktopAgentProviderPreflightInput[] = [];
  const providerIds: string[] = [];
  const results: Array<ReturnType<typeof deferred<DesktopAgentProviderPreflight>>> = [];
  Object.assign(globalThis, {
    window: {
      clearTimeout: () => undefined,
      setTimeout: () => 1,
      addEventListener: () => undefined,
      letagentsDesktop: {
        supervisorGrant: { getStorageStatus: async () => ({ available: true }) },
        workers: {
          runAgentProviderPreflight: (providerId: string, input: DesktopAgentProviderPreflightInput) => {
            providerIds.push(providerId);
            calls.push(input);
            const result = deferred<DesktopAgentProviderPreflight>();
            results.push(result);
            return result.promise;
          },
        },
      },
    },
  });
  const model = ref<string | null>(null);
  const setup = useAddAgentSetup();
  const actions = setup.bind({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomGitRoom: () => null,
    repoRootPath: () => "/repo",
    selectedProvider: computed(() => provider("codex")),
    selectedPermissionProfile: computed(() => null),
    expectedWorktreeBranch: computed(() => null),
    authCommand: computed(() => null),
    externalJoinPrompt: computed(() => null),
    selectedModel: computed(() => model.value),
    selectedModelSource: computed(() => (model.value ? "custom" : null)),
    loadOpenModelSettings: async () => undefined,
    loadProviderModels: async () => undefined,
    syncPermissionProfileSelection: () => undefined,
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
  const readyPreflight = (message: string): DesktopAgentProviderPreflight => ({
    providerId: "codex",
    status: "ready",
    canStart: true,
    message,
    detail: null,
    nextAction: null,
    version: "1",
    mcpStatus: "installed",
  });
  const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await nextTick();
  };
  return { setup, actions, calls, providerIds, results, model, readyPreflight, settle };
}

test("identical preflight requests in one burst share one IPC call and a changed request issues another", async () => {
  const { setup, actions, calls, results, model, readyPreflight, settle } = preflightBurstHarness();

  actions.requestPreflight();
  actions.requestPreflight();
  assert.equal(calls.length, 1, "two identical requests in one burst make one IPC call");
  assert.equal("effort" in calls[0]!, false, "preflight does not send the effort");
  results[0]!.resolve(readyPreflight("First"));
  await settle();
  assert.equal(setup.preflight.value?.message, "First", "the one shared call delivers the result");
  assert.equal(setup.loadingPreflight.value, false);

  actions.requestPreflight();
  assert.equal(calls.length, 2, "once the first request has finished, an identical request runs again");
  results[1]!.resolve(readyPreflight("Second"));
  await settle();
  assert.equal(setup.preflight.value?.message, "Second");

  void actions.runPreflight();
  void actions.runPreflight();
  assert.equal(calls.length, 3, "direct runPreflight calls with the same request also share one IPC call");

  model.value = "gpt-5-custom";
  actions.requestPreflight();
  assert.equal(calls.length, 4, "a changed request issues a second IPC call");
  assert.equal(calls[3]!.model, "gpt-5-custom");
  assert.equal(calls[3]!.modelSource, "custom");

  void actions.runPreflight({ refreshEnvironment: true });
  void actions.runPreflight({ refreshEnvironment: true });
  assert.equal(calls.length, 6, "Check again is never shared, so each click reaches the main process");
  assert.equal(calls[5]!.refreshEnvironment, true);
  void actions.runPreflight({ refreshModels: true });
  assert.equal(calls.length, 7, "a model refresh is never shared either");
  for (const result of results) result.resolve(readyPreflight("Done"));
  await settle();
  actions.resetTransientState();
});

test("a preflight request shared with an in-flight run still shows loading and still delivers its result", async () => {
  const { setup, actions, calls, results, readyPreflight, settle } = preflightBurstHarness();

  // Opening the modal: the provider sync starts a run, then watchers ask again.
  const first = actions.runPreflight();
  actions.requestPreflight();
  actions.requestPreflight();
  assert.equal(calls.length, 1, "the watcher requests share the run that is in flight");
  assert.equal(setup.loadingPreflight.value, true, "the shared check is still shown as loading");
  results[0]!.resolve(readyPreflight("Shared with a run"));
  await first;
  await settle();
  assert.equal(setup.preflight.value?.message, "Shared with a run", "the shared result is assigned");
  assert.equal(setup.loadingPreflight.value, false);
  actions.resetTransientState();
});

test("two identical back-to-back preflight requests still show loading and still deliver one result", async () => {
  const { setup, actions, calls, results, readyPreflight, settle } = preflightBurstHarness();

  actions.requestPreflight();
  actions.requestPreflight();
  assert.equal(calls.length, 1);
  assert.equal(setup.loadingPreflight.value, true, "the shared check is still shown as loading");
  results[0]!.resolve(readyPreflight("Shared pair"));
  await settle();
  assert.equal(setup.preflight.value?.message, "Shared pair", "the shared result is assigned");
  assert.equal(setup.loadingPreflight.value, false);
  actions.resetTransientState();
});

test("switching provider during an in-flight preflight does not adopt it, and the old result never lands", async () => {
  const { setup, actions, calls, providerIds, results, readyPreflight, settle } = preflightBurstHarness();
  setup.providers.value = [provider("codex"), provider("cursor")];

  void actions.runPreflight();
  assert.deepEqual(providerIds, ["codex"]);

  // Away and back: the request is identical to the one in flight, but it
  // belongs to an older provider selection and must not be shared.
  actions.selectProvider("cursor");
  actions.selectProvider("codex");
  void actions.runPreflight();
  assert.equal(calls.length, 2, "a request made after a provider switch is not served by the older request");
  assert.deepEqual(providerIds, ["codex", "codex"]);

  results[0]!.resolve(readyPreflight("Old selection"));
  await settle();
  assert.equal(setup.preflight.value, null, "the result of the older selection never lands");
  assert.equal(setup.loadingPreflight.value, true, "the newer request is still loading");

  results[1]!.resolve(readyPreflight("Current selection"));
  await settle();
  assert.equal(setup.preflight.value?.message, "Current selection");
  assert.equal(setup.loadingPreflight.value, false);
  actions.resetTransientState();
});

test("switching to another provider during an in-flight preflight issues its own request", async () => {
  const { setup, actions, calls, providerIds, results, readyPreflight, settle } = preflightBurstHarness();
  setup.providers.value = [provider("codex"), provider("cursor")];

  void actions.runPreflight();
  actions.selectProvider("cursor");
  void actions.runPreflight();
  assert.equal(calls.length, 2);
  assert.deepEqual(providerIds, ["codex", "cursor"]);

  results[0]!.resolve(readyPreflight("Codex result"));
  await settle();
  assert.equal(setup.preflight.value, null, "the result of the previous provider never lands");

  results[1]!.resolve({ ...readyPreflight("Cursor result"), providerId: "cursor" });
  await settle();
  assert.equal(setup.preflight.value?.message, "Cursor result");
  assert.equal(setup.loadingPreflight.value, false);
  actions.resetTransientState();
});
