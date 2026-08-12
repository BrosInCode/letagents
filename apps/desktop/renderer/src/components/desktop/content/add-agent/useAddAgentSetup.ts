import {
  getCurrentInstance,
  onBeforeUnmount,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelSource,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopCursorMcpPolicy,
  DesktopGitRoomInfo,
  DesktopManagedAgentEffort,
  DesktopManagedAgentPermissionProfile,
} from "../../../../../../electron/ipc-types";
import {
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  hasDesktopManagedRuntime,
  hasSupervisedRuntime,
  isAgentSetupConfirmationActive,
  visibleDesktopAgentProviders,
  type AgentSetupConfirmation,
} from "../../../../domain/managed-agents";
import { copyTextToClipboard } from "../../../../domain/clipboard";
import { createManagedAgentWorktree } from "../../../../domain/managed-agent-worktrees";
import { desktopIpc } from "../../../../ipc/index.js";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";

const MODEL_PREFLIGHT_DEBOUNCE_MS = 400;

interface SetupBindings {
  open: () => boolean;
  roomIdentifier: () => string;
  roomGitRoom: () => DesktopGitRoomInfo | null;
  repoRootPath: () => string | null;
  selectedProvider: ComputedRef<DesktopAgentProvider | null>;
  selectedPermissionProfile: ComputedRef<DesktopManagedAgentPermissionProfile | null>;
  expectedWorktreeBranch: ComputedRef<string | null>;
  authCommand: ComputedRef<string | null>;
  externalJoinPrompt: ComputedRef<string | null>;
  selectedCursorMcpPolicy: Ref<DesktopCursorMcpPolicy>;
  selectedModel: ComputedRef<string | null>;
  selectedModelSource: ComputedRef<DesktopAgentProviderModelSource | null>;
  selectedEffort: Ref<DesktopManagedAgentEffort | "">;
  launchMode: Ref<"legacy" | "supervised">;
  loadOpenModelSettings: () => Promise<void>;
  loadProviderModels: (options?: { refresh?: boolean }) => Promise<void>;
  syncPermissionProfileSelection: () => void;
  syncDeliveryModeSelection: () => void;
  invalidateConfigurationRequests: () => void;
  resetConfigurationModelSelection: () => void;
  resetConfigurationTransientState: () => void;
  onDetectRecoverableLaunch: () => void;
  onResetSupervisedLaunch: () => void;
  onCleanupSupervisedLaunch: () => void;
  onResetStartingAgent: () => void;
  onChooseWorktree: (rootPath: string) => void;
}

export function useAddAgentSetup() {
  const providers = ref<DesktopAgentProvider[]>([]);
  const selectedProviderId = ref<DesktopAgentProviderId | null>(null);
  const preflight = ref<DesktopAgentProviderPreflight | null>(null);
  const loadingProviders = ref(false);
  const loadingPreflight = ref(false);
  const setupBusy = ref(false);
  const creatingWorktree = ref(false);
  const copyingAuthCommand = ref(false);
  const copyingExternalPrompt = ref(false);
  const setupConfirmation = ref<AgentSetupConfirmation | null>(null);
  const loadError = ref<string | null>(null);
  const setupMessage = ref<string | null>(null);
  const setupMessageTone = ref<AddAgentFeedbackTone>("status");
  let setupVersion = 0;
  let preflightRequestId = 0;
  let providerRequestId = 0;
  let worktreeRequestId = 0;
  let modelPreflightTimer: number | null = null;
  let setupActionInFlight = false;
  let worktreeOperationInFlight = false;

  function currentVersion(): number {
    return setupVersion;
  }

  function setSetupMessage(message: string | null, tone: AddAgentFeedbackTone = "status"): void {
    setupMessage.value = message;
    setupMessageTone.value = tone;
  }

  function bind(bindings: SetupBindings) {
    function isCurrentRequest(version: number): boolean {
      return bindings.open() && version === setupVersion;
    }

    function clearScheduledModelPreflight(): void {
      if (modelPreflightTimer === null) return;
      window.clearTimeout(modelPreflightTimer);
      modelPreflightTimer = null;
    }

    function invalidateCurrentPreflight(): void {
      preflight.value = null;
      setupConfirmation.value = null;
      loadingPreflight.value = false;
      preflightRequestId += 1;
    }

    function requestPreflight(options: { debounce?: boolean } = {}): void {
      if (!bindings.open() || !selectedProviderId.value) return;
      clearScheduledModelPreflight();
      invalidateCurrentPreflight();
      if (!options.debounce) {
        void runPreflight();
        return;
      }
      modelPreflightTimer = window.setTimeout(() => {
        modelPreflightTimer = null;
        void runPreflight();
      }, MODEL_PREFLIGHT_DEBOUNCE_MS);
    }

    async function runPreflight(options: { refreshModels?: boolean; refreshEnvironment?: boolean } = {}): Promise<void> {
      if (!selectedProviderId.value) return;
      clearScheduledModelPreflight();
      const providerId = selectedProviderId.value;
      const version = setupVersion;
      const requestId = ++preflightRequestId;
      loadingPreflight.value = true;
      loadError.value = null;
      setupConfirmation.value = null;
      try {
        const result = await desktopIpc.workers.runAgentProviderPreflight(providerId, {
          roomIdentifier: bindings.roomIdentifier(),
          roomGitRoom: bindings.roomGitRoom(),
          repoRootPath: bindings.repoRootPath(),
          launchMode: bindings.launchMode.value,
          permissionProfileId: bindings.selectedPermissionProfile.value?.id ?? null,
          cursorMcpPolicy: providerId === "cursor" ? bindings.selectedCursorMcpPolicy.value : null,
          model: bindings.selectedModel.value,
          modelSource: bindings.selectedModelSource.value,
          effort: bindings.selectedEffort.value || null,
          refreshModels: options.refreshModels,
          refreshEnvironment: options.refreshEnvironment,
        });
        if (isCurrentRequest(version) && requestId === preflightRequestId && selectedProviderId.value === providerId) {
          preflight.value = result;
        }
      } catch (error) {
        if (isCurrentRequest(version) && requestId === preflightRequestId && selectedProviderId.value === providerId) {
          loadError.value = contextualAddAgentError(
            `Couldn't check ${bindings.selectedProvider.value?.name || "provider"} setup`,
            error,
            "Provider readiness could not be checked.",
          );
        }
      } finally {
        if (isCurrentRequest(version) && requestId === preflightRequestId) loadingPreflight.value = false;
      }
    }

    async function refreshSelectedProvider(options: { forceModels?: boolean; refreshEnvironment?: boolean } = {}): Promise<void> {
      if (!bindings.open() || !selectedProviderId.value) return;
      clearScheduledModelPreflight();
      const loadConfiguration = () => {
        void bindings.loadOpenModelSettings();
        void bindings.loadProviderModels({ refresh: options.forceModels });
      };
      if (options.refreshEnvironment) {
        await runPreflight({
          refreshModels: options.forceModels,
          refreshEnvironment: true,
        });
        loadConfiguration();
      } else {
        loadConfiguration();
        await runPreflight({ refreshModels: options.forceModels });
      }
    }

    async function loadProviders(): Promise<void> {
      if (!bindings.open() || loadingProviders.value) return;
      const requestId = ++providerRequestId;
      const roomIdentifier = bindings.roomIdentifier();
      const isCurrent = () => bindings.open()
        && requestId === providerRequestId
        && roomIdentifier === bindings.roomIdentifier();
      loadingProviders.value = true;
      loadError.value = null;
      try {
        const nextProviders = visibleDesktopAgentProviders(await desktopIpc.workers.listAgentProviders());
        if (!isCurrent()) return;
        providers.value = nextProviders;
        const previousProviderId = selectedProviderId.value;
        selectedProviderId.value = selectedProviderId.value
          && nextProviders.some((provider) => provider.id === selectedProviderId.value)
          ? selectedProviderId.value
          : nextProviders.find((provider) => provider.id === "codex")?.id || nextProviders[0]?.id || null;
        if (
          hasSupervisedRuntime(bindings.selectedProvider.value)
          && !hasDesktopManagedRuntime(bindings.selectedProvider.value)
        ) {
          bindings.launchMode.value = "supervised";
        }
        bindings.syncPermissionProfileSelection();
        bindings.syncDeliveryModeSelection();
        if (selectedProviderId.value && selectedProviderId.value === previousProviderId) {
          await refreshSelectedProvider();
        }
      } catch (error) {
        if (isCurrent()) loadError.value = contextualAddAgentError(
          "Couldn't load agent providers",
          error,
          "The provider catalog is unavailable.",
        );
      } finally {
        if (isCurrent()) loadingProviders.value = false;
      }
    }

    async function retryProviderSetup(): Promise<void> {
      if (!bindings.open() || loadingProviders.value || loadingPreflight.value) return;
      if (!providers.value.length || !selectedProviderId.value || !bindings.selectedProvider.value) {
        await loadProviders();
        return;
      }
      await refreshSelectedProvider({ forceModels: true, refreshEnvironment: true });
    }

    function selectProvider(providerId: DesktopAgentProviderId): void {
      if (selectedProviderId.value === providerId) return;
      setupVersion += 1;
      bindings.invalidateConfigurationRequests();
      worktreeRequestId += 1;
      clearScheduledModelPreflight();
      selectedProviderId.value = providerId;
      if (
        hasSupervisedRuntime(bindings.selectedProvider.value)
        && !hasDesktopManagedRuntime(bindings.selectedProvider.value)
      ) {
        bindings.launchMode.value = "supervised";
      } else if (!hasSupervisedRuntime(bindings.selectedProvider.value)) {
        bindings.launchMode.value = "legacy";
      }
      bindings.resetConfigurationModelSelection();
      bindings.syncPermissionProfileSelection();
      bindings.syncDeliveryModeSelection();
      invalidateCurrentPreflight();
      setupBusy.value = setupActionInFlight;
      creatingWorktree.value = worktreeOperationInFlight;
      bindings.onResetStartingAgent();
      bindings.onResetSupervisedLaunch();
      copyingAuthCommand.value = false;
      copyingExternalPrompt.value = false;
      setSetupMessage(null);
    }

    async function runSetupAction(action: DesktopAgentProviderSetupAction): Promise<void> {
      const providerId = selectedProviderId.value;
      if (!providerId || setupActionInFlight) return;
      if (!isAgentSetupConfirmationActive(setupConfirmation.value, providerId, action)) {
        setupConfirmation.value = { providerId, action };
        setSetupMessage(agentSetupConfirmationMessage(action, bindings.selectedProvider.value));
        return;
      }
      setupBusy.value = true;
      setupActionInFlight = true;
      setSetupMessage(null);
      const version = setupVersion;
      try {
        const result = await desktopIpc.workers.runAgentProviderSetup(providerId, {
          action,
          confirmed: true,
          roomIdentifier: bindings.roomIdentifier(),
          repoRootPath: bindings.repoRootPath(),
        });
        if (!isCurrentRequest(version) || selectedProviderId.value !== providerId) return;
        setSetupMessage(result.message);
        setupConfirmation.value = null;
        await runPreflight();
      } catch (error) {
        if (isCurrentRequest(version) && selectedProviderId.value === providerId) {
          setSetupMessage(contextualAddAgentError(
            `Couldn't update ${bindings.selectedProvider.value?.name || "provider"} setup`,
            error,
            "The setup action failed.",
          ), "error");
        }
      } finally {
        setupActionInFlight = false;
        if (isCurrentRequest(version) && selectedProviderId.value === providerId) setupBusy.value = false;
        else if (bindings.open()) setupBusy.value = false;
      }
    }

    function chooseWorktree(rootPath: string): void {
      const trimmed = rootPath.trim();
      if (trimmed) bindings.onChooseWorktree(trimmed);
    }

    async function createWorktree(): Promise<void> {
      const repoRoot = bindings.repoRootPath()?.trim();
      const branch = bindings.expectedWorktreeBranch.value?.trim();
      if (!repoRoot || !branch || worktreeOperationInFlight) return;
      const version = setupVersion;
      const requestId = ++worktreeRequestId;
      const roomIdentifier = bindings.roomIdentifier();
      const isCurrent = () => requestId === worktreeRequestId
        && isCurrentRequest(version)
        && roomIdentifier === bindings.roomIdentifier()
        && bindings.repoRootPath()?.trim() === repoRoot
        && bindings.expectedWorktreeBranch.value?.trim() === branch;
      creatingWorktree.value = true;
      worktreeOperationInFlight = true;
      setSetupMessage(null);
      try {
        const errorMessage = await createManagedAgentWorktree({
          repoRoot,
          branch,
          createWorktree: (root, branchName) => desktopIpc.repos.createWorktree(root, branchName),
          chooseWorktree: (rootPath) => { if (isCurrent()) bindings.onChooseWorktree(rootPath); },
        });
        if (errorMessage && isCurrent()) setSetupMessage(
          contextualAddAgentError("Couldn't create the worktree", errorMessage, "Worktree creation failed."),
          "error",
        );
      } finally {
        worktreeOperationInFlight = false;
        if (requestId === worktreeRequestId || bindings.open()) creatingWorktree.value = false;
      }
    }

    function setupActionButtonText(action: DesktopAgentProviderSetupAction): string {
      return agentSetupActionButtonLabel(
        action,
        bindings.selectedProvider.value,
        isAgentSetupConfirmationActive(setupConfirmation.value, selectedProviderId.value, action),
        setupBusy.value,
      );
    }

    async function copyAgentAuthCommand(commandOverride?: string | null): Promise<void> {
      const command = commandOverride ?? bindings.authCommand.value;
      if (!command || copyingAuthCommand.value) return;
      const version = setupVersion;
      copyingAuthCommand.value = true;
      setSetupMessage(null);
      try {
        const copied = await copyTextToClipboard(command);
        if (isCurrentRequest(version)) setSetupMessage(
          copied ? `Copied: ${command}` : `Clipboard unavailable. Run: ${command}`,
          copied ? "status" : "warning",
        );
      } finally {
        if (isCurrentRequest(version)) copyingAuthCommand.value = false;
      }
    }

    async function copyExternalJoinPrompt(): Promise<void> {
      const prompt = bindings.externalJoinPrompt.value;
      if (!prompt || copyingExternalPrompt.value) return;
      const version = setupVersion;
      copyingExternalPrompt.value = true;
      setSetupMessage(null);
      try {
        const copied = await copyTextToClipboard(prompt);
        if (isCurrentRequest(version)) setSetupMessage(
          copied
            ? "Copied the agent join prompt."
            : "Clipboard unavailable. Open Show full instructions, then copy the prompt manually.",
          copied ? "status" : "warning",
        );
      } finally {
        if (isCurrentRequest(version)) copyingExternalPrompt.value = false;
      }
    }

    function resetTransientState(): void {
      setupVersion += 1;
      preflightRequestId += 1;
      providerRequestId += 1;
      worktreeRequestId += 1;
      clearScheduledModelPreflight();
      loadingProviders.value = false;
      loadingPreflight.value = false;
      setupBusy.value = setupActionInFlight;
      creatingWorktree.value = worktreeOperationInFlight;
      copyingAuthCommand.value = false;
      copyingExternalPrompt.value = false;
      setupConfirmation.value = null;
      loadError.value = null;
      setSetupMessage(null);
      bindings.onResetStartingAgent();
      bindings.onCleanupSupervisedLaunch();
      bindings.resetConfigurationTransientState();
    }

    watch(() => bindings.open(), (open) => {
      if (open) {
        void loadProviders();
        bindings.onDetectRecoverableLaunch();
      } else {
        resetTransientState();
      }
    }, { immediate: true });
    watch(
      () => [
        selectedProviderId.value,
        bindings.repoRootPath(),
        bindings.roomGitRoom()?.ref.type,
        bindings.roomGitRoom()?.ref.name,
      ] as const,
      () => {
        if (bindings.open() && selectedProviderId.value) void refreshSelectedProvider();
      },
    );
    watch(() => bindings.roomIdentifier(), () => {
      if (!bindings.open()) return;
      resetTransientState();
      void loadProviders();
      bindings.onDetectRecoverableLaunch();
    });
    if (getCurrentInstance()) onBeforeUnmount(resetTransientState);

    return {
      currentVersion,
      isCurrentRequest,
      requestPreflight,
      runPreflight,
      refreshSelectedProvider,
      retryProviderSetup,
      loadProviders,
      selectProvider,
      runSetupAction,
      chooseWorktree,
      createWorktree,
      setupActionButtonText,
      copyAgentAuthCommand,
      copyExternalJoinPrompt,
      resetTransientState,
    };
  }

  return {
    providers,
    selectedProviderId,
    preflight,
    loadingProviders,
    loadingPreflight,
    setupBusy,
    creatingWorktree,
    copyingAuthCommand,
    copyingExternalPrompt,
    setupConfirmation,
    loadError,
    setupMessage,
    setupMessageTone,
    setSetupMessage,
    currentVersion,
    bind,
  };
}
