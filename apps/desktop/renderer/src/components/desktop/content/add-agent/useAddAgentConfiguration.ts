import { ref, watch, type ComputedRef, type Ref } from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelOption,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderModelSource,
  DesktopCursorMcpPolicy,
  DesktopGitRoomInfo,
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentEffort,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
  DesktopOpenModelSettingsStatus,
} from "../../../../../../electron/ipc-types";
import {
  defaultCursorMcpPolicy,
  managedAgentPermissionProfileSelectionForProvider,
  shouldShowDeliveryModeSelector,
} from "../../../../domain/managed-agents";
import { desktopIpc } from "../../../../ipc/index.js";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";

export type AddAgentModelSelectionMode = "default" | "option" | "custom";

interface ConfigurationBindings {
  open: () => boolean;
  roomIdentifier: () => string;
  roomGitRoom: () => DesktopGitRoomInfo | null;
  repoRootPath: () => string | null;
  selectedProviderId: Ref<DesktopAgentProviderId | null>;
  selectedProvider: ComputedRef<DesktopAgentProvider | null>;
  selectedPermissionProfile: ComputedRef<DesktopManagedAgentPermissionProfile | null>;
  showOpenModelConfig: ComputedRef<boolean>;
  showModelSelector: ComputedRef<boolean>;
  showEffortSelector: ComputedRef<boolean>;
  providerModelOptions: ComputedRef<DesktopAgentProviderModelOption[]>;
  selectedModel: ComputedRef<string | null>;
  selectedModelSource: ComputedRef<DesktopAgentProviderModelSource | null>;
  requestPreflight: (options?: { debounce?: boolean }) => void;
  runPreflight: (options?: { refreshModels?: boolean }) => Promise<void>;
  onMessage: (message: string | null, tone?: AddAgentFeedbackTone) => void;
}

export function useAddAgentConfiguration() {
  const deliveryMode = ref<DesktopManagedAgentDeliveryMode>("desktop_events");
  const launchMode = ref<"legacy" | "supervised">("legacy");
  const supervisedCharter = ref("Work from the room board, coordinate through the room, and help move assigned work forward.");
  const selectedCursorMcpPolicy = ref<DesktopCursorMcpPolicy>(defaultCursorMcpPolicy);
  const openModelStatus = ref<DesktopOpenModelSettingsStatus | null>(null);
  const openModelBaseUrl = ref("");
  const openModelModel = ref("");
  const openModelApiKey = ref("");
  const openModelError = ref<string | null>(null);
  const savingOpenModelSettings = ref(false);
  const providerModels = ref<DesktopAgentProviderModelsResult | null>(null);
  const loadingProviderModels = ref(false);
  const selectedModelMode = ref<AddAgentModelSelectionMode>("default");
  const selectedProviderModelId = ref("");
  const customModelId = ref("");
  const selectedEffort = ref<DesktopManagedAgentEffort | "">("");
  const selectedPermissionProfileId = ref<DesktopManagedAgentPermissionProfileId | null>(null);
  const selectedPermissionProfileIdsByProvider = ref<
    Partial<Record<DesktopAgentProviderId, DesktopManagedAgentPermissionProfileId>>
  >({});
  const selectedSupervisedPermissionProfileIdsByProvider = ref<
    Partial<Record<DesktopAgentProviderId, DesktopManagedAgentPermissionProfileId>>
  >({});
  let modelRequestId = 0;
  let configurationVersion = 0;
  let openModelWrite: Promise<void> | null = null;

  function resetModelSelection(): void {
    modelRequestId += 1;
    providerModels.value = null;
    loadingProviderModels.value = false;
    selectedModelMode.value = "default";
    selectedProviderModelId.value = "";
    customModelId.value = "";
    selectedEffort.value = "";
  }

  function bind(bindings: ConfigurationBindings) {
    const capture = () => ({
      version: configurationVersion,
      roomIdentifier: bindings.roomIdentifier(),
      providerId: bindings.selectedProviderId.value,
    });
    const isCurrent = (request: ReturnType<typeof capture>) =>
      bindings.open() &&
      request.version === configurationVersion &&
      request.roomIdentifier === bindings.roomIdentifier() &&
      request.providerId === bindings.selectedProviderId.value;

    async function loadOpenModelSettings(): Promise<void> {
      if (!bindings.showOpenModelConfig.value) return;
      if (openModelWrite) await openModelWrite;
      if (!bindings.open() || !bindings.showOpenModelConfig.value) return;
      const request = capture();
      openModelError.value = null;
      try {
        const status = await desktopIpc.openModel.getSettingsStatus();
        if (!isCurrent(request)) return;
        openModelStatus.value = status;
        openModelBaseUrl.value = status.baseUrl;
        openModelModel.value = status.model;
        if (status.error) {
          openModelError.value = contextualAddAgentError(
            "Couldn't read Open Model settings",
            status.error,
            "The saved endpoint and model are unavailable.",
          );
        }
      } catch (error) {
        if (isCurrent(request)) {
          openModelError.value = contextualAddAgentError(
            "Couldn't load Open Model settings",
            error,
            "The saved endpoint and model are unavailable.",
          );
        }
      }
    }

    async function loadProviderModels(options: { refresh?: boolean } = {}): Promise<void> {
      if (!bindings.open() || !bindings.selectedProviderId.value || !bindings.showModelSelector.value) {
        providerModels.value = null;
        return;
      }
      const request = capture();
      const requestId = ++modelRequestId;
      const requestProviderId = bindings.selectedProviderId.value;
      const listModels = desktopIpc.workers.listAgentProviderModels;
      if (typeof listModels !== "function") {
        providerModels.value = {
          providerId: requestProviderId,
          status: "unavailable",
          models: [],
          defaultModel: null,
          error: "Restart the desktop app to load provider model options.",
        };
        loadingProviderModels.value = false;
        return;
      }
      loadingProviderModels.value = true;
      try {
        const result = await listModels(requestProviderId, {
          roomIdentifier: bindings.roomIdentifier(),
          roomGitRoom: bindings.roomGitRoom(),
          repoRootPath: bindings.repoRootPath(),
          cursorMcpPolicy: requestProviderId === "cursor" ? selectedCursorMcpPolicy.value : null,
          model: bindings.selectedModel.value,
          modelSource: bindings.selectedModelSource.value,
          effort: selectedEffort.value || null,
          refreshModels: options.refresh,
        });
        if (isCurrent(request) && requestId === modelRequestId) {
          providerModels.value = result;
          syncSelectedProviderModelSelection(result);
        }
      } catch (error) {
        if (isCurrent(request) && requestId === modelRequestId) {
          providerModels.value = {
            providerId: requestProviderId,
            status: "error",
            models: [],
            defaultModel: null,
            error: contextualAddAgentError(
              "Couldn't refresh the model catalog",
              error,
              "The provider model list is unavailable.",
            ),
          };
        }
      } finally {
        if (isCurrent(request) && requestId === modelRequestId) loadingProviderModels.value = false;
      }
    }

    function refreshProviderModels(): void {
      if (!loadingProviderModels.value) void loadProviderModels({ refresh: true });
    }

    function syncSelectedProviderModelSelection(
      result: DesktopAgentProviderModelsResult | null = providerModels.value,
    ): void {
      if (selectedModelMode.value !== "option" || !selectedProviderModelId.value) return;
      if (result?.status !== "ready") return;
      if (!result.models.some((option) => option.id === selectedProviderModelId.value)) selectDefaultModel();
    }

    async function applyOpenModelSettings(input: {
      baseUrl?: string | null;
      model?: string | null;
      apiKey?: string | null;
    }): Promise<void> {
      if (openModelWrite) return openModelWrite;
      const request = capture();
      savingOpenModelSettings.value = true;
      openModelError.value = null;
      bindings.onMessage(null);
      let write!: Promise<void>;
      write = (async () => {
        try {
          const status = await desktopIpc.openModel.saveSettings(input);
          if (!isCurrent(request)) return;
          openModelStatus.value = status;
          openModelBaseUrl.value = status.baseUrl;
          openModelModel.value = status.model;
          openModelApiKey.value = "";
          if (status.error) {
            openModelError.value = `${contextualAddAgentError(
              "Couldn't verify the saved Open Model settings",
              status.error,
              "The settings file could not be read after saving.",
            )} Check the settings file and try again.`;
            return;
          }
          bindings.onMessage("Model settings saved.");
          await loadProviderModels();
          await bindings.runPreflight();
        } catch (error) {
          if (isCurrent(request)) {
            openModelError.value = contextualAddAgentError(
              "Couldn't save Open Model settings",
              error,
              "Check the endpoint, model, and key, then try again.",
            );
          }
        } finally {
          if (openModelWrite === write) {
            openModelWrite = null;
            savingOpenModelSettings.value = false;
          }
        }
      })();
      openModelWrite = write;
      return write;
    }

    function saveOpenModelSettings(): Promise<void> {
      const apiKey = openModelApiKey.value.trim();
      return applyOpenModelSettings({
        baseUrl: openModelBaseUrl.value.trim() || null,
        model: openModelModel.value.trim() || null,
        ...(apiKey ? { apiKey } : {}),
      });
    }

    function clearOpenModelApiKey(): Promise<void> {
      return applyOpenModelSettings({ apiKey: null });
    }

    function selectDefaultModel(): void {
      selectedModelMode.value = "default";
      selectedProviderModelId.value = "";
    }
    function selectProviderModel(option: DesktopAgentProviderModelOption): void {
      selectedModelMode.value = "option";
      selectedProviderModelId.value = option.id;
    }
    function handleModelChoiceValue(value: string): void {
      if (value === "default") return selectDefaultModel();
      if (value === "custom") {
        selectedModelMode.value = "custom";
        return;
      }
      if (!value.startsWith("option:")) return;
      const option = bindings.providerModelOptions.value.find((entry) => entry.id === value.slice(7));
      if (option) selectProviderModel(option);
    }
    function handleEffortValue(value: string): void {
      selectedEffort.value = ["", "low", "medium", "high", "xhigh", "max"].includes(value)
        ? value as DesktopManagedAgentEffort | ""
        : "";
    }
    function syncPermissionProfileSelection(): void {
      const supervised = launchMode.value === "supervised";
      const selections = supervised
        ? selectedSupervisedPermissionProfileIdsByProvider.value
        : selectedPermissionProfileIdsByProvider.value;
      const nextId = managedAgentPermissionProfileSelectionForProvider(
        bindings.selectedProvider.value,
        selections,
        supervised && bindings.selectedProviderId.value === "cursor"
          ? "sandboxed_write"
          : null,
      );
      selectedPermissionProfileId.value = nextId;
      if (bindings.selectedProviderId.value && nextId) {
        if (supervised) {
          selectedSupervisedPermissionProfileIdsByProvider.value = {
            ...selectedSupervisedPermissionProfileIdsByProvider.value,
            [bindings.selectedProviderId.value]: nextId,
          };
        } else {
          selectedPermissionProfileIdsByProvider.value = {
            ...selectedPermissionProfileIdsByProvider.value,
            [bindings.selectedProviderId.value]: nextId,
          };
        }
      }
    }
    function selectPermissionProfile(profile: DesktopManagedAgentPermissionProfile): void {
      if (profile.status !== "available") return;
      selectedPermissionProfileId.value = profile.id;
      if (bindings.selectedProviderId.value) {
        if (launchMode.value === "supervised") {
          selectedSupervisedPermissionProfileIdsByProvider.value = {
            ...selectedSupervisedPermissionProfileIdsByProvider.value,
            [bindings.selectedProviderId.value]: profile.id,
          };
        } else {
          selectedPermissionProfileIdsByProvider.value = {
            ...selectedPermissionProfileIdsByProvider.value,
            [bindings.selectedProviderId.value]: profile.id,
          };
        }
      }
    }
    function syncDeliveryModeSelection(): void {
      if (!shouldShowDeliveryModeSelector(bindings.selectedProvider.value)) deliveryMode.value = "desktop_events";
    }
    function invalidateRequests(): void {
      configurationVersion += 1;
      modelRequestId += 1;
    }
    function resetTransientState(): void {
      invalidateRequests();
      openModelApiKey.value = "";
      openModelError.value = null;
      resetModelSelection();
    }

    watch(
      () => [selectedCursorMcpPolicy.value, selectedPermissionProfileId.value, launchMode.value] as const,
      () => {
        if (bindings.open() && bindings.selectedProviderId.value) {
          void loadProviderModels();
          bindings.requestPreflight();
        }
      },
    );
    watch(launchMode, syncPermissionProfileSelection, { flush: "sync" });
    watch(
      () => [selectedModelMode.value, selectedProviderModelId.value] as const,
      () => {
        if (bindings.open() && bindings.selectedProviderId.value) bindings.requestPreflight();
      },
    );
    watch(customModelId, () => {
      if (bindings.open() && bindings.selectedProviderId.value && selectedModelMode.value === "custom") {
        bindings.requestPreflight({ debounce: true });
      }
    });
    watch(selectedEffort, () => {
      if (bindings.open() && bindings.selectedProviderId.value && bindings.showEffortSelector.value) {
        bindings.requestPreflight();
      }
    });

    return {
      loadOpenModelSettings,
      loadProviderModels,
      refreshProviderModels,
      saveOpenModelSettings,
      clearOpenModelApiKey,
      handleModelChoiceValue,
      handleEffortValue,
      syncPermissionProfileSelection,
      selectPermissionProfile,
      syncDeliveryModeSelection,
      invalidateRequests,
      resetModelSelection,
      resetTransientState,
    };
  }

  return {
    deliveryMode,
    launchMode,
    supervisedCharter,
    selectedCursorMcpPolicy,
    openModelStatus,
    openModelBaseUrl,
    openModelModel,
    openModelApiKey,
    openModelError,
    savingOpenModelSettings,
    providerModels,
    loadingProviderModels,
    selectedModelMode,
    selectedProviderModelId,
    customModelId,
    selectedEffort,
    selectedPermissionProfileId,
    selectedPermissionProfileIdsByProvider,
    resetModelSelection,
    bind,
  };
}
