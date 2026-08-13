import { computed } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopAgentProviderModelSource,
  DesktopGitRoomInfo,
  RepoStatus,
} from "../../../../../../electron/ipc-types";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import {
  agentAuthCommand,
  agentProviderNeedsDesktopRepo,
  branchScopedGitRoomExpectedBranch,
  cursorMcpPolicyDescription,
  externalMcpProviderJoinPrompt,
  hasDesktopManagedRuntime,
  hasSupervisedRuntime,
  isAgentSetupConfirmationActive,
  isExternalMcpProviderReady,
  matchingManagedAgentWorktreesForBranch,
  shouldShowCursorMcpPolicySelector,
  shouldShowDeliveryModeSelector,
  shouldShowManagedModelSelector,
  shouldShowOpenModelConfig,
  supervisedCursorPermissionProfilePresentation,
} from "../../../../domain/managed-agents";
import type { DesktopSelectOption } from "../../controls/DesktopSelectField.vue";
import type { useAddAgentConfiguration } from "./useAddAgentConfiguration";
import type { useAddAgentSetup } from "./useAddAgentSetup";

interface AddAgentPresentationProps {
  roomIdentifier: string;
  roomGitRoom: DesktopGitRoomInfo | null;
  gitRoomMatchesActiveRepo: boolean;
  roomDisplayName: string | null;
  repoRootPath: string | null;
  repoStatus: RepoStatus | null;
}

export function useAddAgentPresentation(
  props: AddAgentPresentationProps,
  setup: ReturnType<typeof useAddAgentSetup>,
  configuration: ReturnType<typeof useAddAgentConfiguration>,
) {
  const {
    providers,
    selectedProviderId,
    preflight,
    secureStorageStatus,
    loadingProviders,
    loadingPreflight,
    creatingWorktree,
    setupConfirmation,
    loadError,
  } = setup;
  const {
    deliveryMode,
    launchMode,
    supervisedCharter,
    selectedCursorMcpPolicy,
    providerModels,
    loadingProviderModels,
    selectedModelMode,
    selectedProviderModelId,
    customModelId,
    selectedEffort,
    selectedPermissionProfileId,
  } = configuration;

  const selectedProvider = computed(() =>
    providers.value.find((provider) => provider.id === selectedProviderId.value) || null
  );
  const selectedPermissionProfiles = computed(() => {
    const profiles = selectedProvider.value?.permissionProfiles ?? [];
    return selectedProviderId.value === "cursor" && launchMode.value === "supervised"
      ? profiles.map(supervisedCursorPermissionProfilePresentation)
      : profiles;
  });
  const selectedPermissionProfile = computed(() =>
    selectedPermissionProfiles.value.find((profile) => profile.id === selectedPermissionProfileId.value) ??
    selectedPermissionProfiles.value.find((profile) => profile.id === selectedProvider.value?.defaultPermissionProfileId) ??
    selectedPermissionProfiles.value.find((profile) => profile.status === "available") ??
    selectedPermissionProfiles.value[0] ??
    null
  );
  const canStartManagedAgent = computed(() =>
    Boolean(
      preflight.value?.canStart &&
      (launchMode.value !== "supervised" || secureStorageStatus.value?.available === true) &&
      (!loadingPreflight.value || Boolean(preflight.value)) &&
      (selectedModelMode.value !== "option" || !loadingProviderModels.value) &&
      (
        !selectedPermissionProfiles.value.length ||
        selectedPermissionProfile.value?.status === "available"
      ) &&
      (launchMode.value === "legacy" || Boolean(supervisedCharter.value.trim()))
    )
  );
  const authCommand = computed(() => agentAuthCommand(selectedProvider.value));
  const installCommand = computed(() =>
    selectedProvider.value?.runtimeInstallCommand?.trim() || null
  );
  const installUrl = computed(() =>
    selectedProvider.value?.runtimeInstallUrl?.trim() || null
  );
  const authCommandForProvider = (providerId: string | null): string | null =>
    agentAuthCommand(providers.value.find((provider) => provider.id === providerId));
  const roomLabel = computed(() => props.roomDisplayName?.trim() || props.roomIdentifier);
  const externalJoinPrompt = computed(() =>
    isExternalMcpProviderReady(selectedProvider.value, preflight.value)
      ? externalMcpProviderJoinPrompt(selectedProvider.value, props.roomIdentifier, props.repoRootPath)
      : null
  );

  const activeSetupConfirmation = computed(() => {
    const nextAction = preflight.value?.nextAction;
    if (nextAction !== "install_runtime" && nextAction !== "install_mcp_bridge") return null;
    return isAgentSetupConfirmationActive(setupConfirmation.value, selectedProviderId.value, nextAction)
      ? setupConfirmation.value
      : null;
  });
  const statusTitle = computed(() => {
    if ((loadingProviders.value || loadingPreflight.value) && !preflight.value) return "Checking setup";
    if (loadError.value) return "Provider check failed";
    if (!preflight.value) return "Choose a provider";
    if (launchMode.value === "supervised" && secureStorageStatus.value?.available === false) {
      return "Unlock secure credential storage";
    }
    if (preflight.value.status === "ready") return "Choose how it works here";
    return safeUserVisibleErrorDetail(preflight.value.message, "Provider setup needs attention");
  });
  const statusDescription = computed(() => {
    if (loadError.value) return "We couldn't verify this provider's setup. Use Check again to retry.";
    if (!preflight.value) return "Checking provider readiness...";
    if (launchMode.value === "supervised" && secureStorageStatus.value?.available === false) {
      return secureStorageStatus.value.detail;
    }
    if (preflight.value.status !== "ready") {
      return safeUserVisibleErrorDetail(
        preflight.value.detail || preflight.value.message,
        "Provider setup needs attention. Check the provider app, then try again.",
      );
    }
    if (
      !hasDesktopManagedRuntime(selectedProvider.value)
      && !hasSupervisedRuntime(selectedProvider.value)
    ) {
      return "Use the handoff below to bring it into this room.";
    }
    return hasSupervisedRuntime(selectedProvider.value)
      ? "Set its model, lifecycle, and access before launch."
      : "Set its model and access before launch.";
  });
  const preflightStatusLabel = computed(() => {
    if ((loadingProviders.value || loadingPreflight.value) && !preflight.value) return "Checking";
    if (loadError.value || preflight.value?.status === "error") return "Needs attention";
    if (launchMode.value === "supervised" && secureStorageStatus.value?.available === false) return "Needs attention";
    if (preflight.value?.status === "ready") return "Ready";
    if (!preflight.value) return "Not checked";
    return "Setup needed";
  });
  const runtimeLabel = computed(() => {
    if (preflight.value?.version) return preflight.value.version;
    if (preflight.value?.status === "missing_runtime") return "Missing";
    if (
      selectedProvider.value?.capabilities.includes("desktop_managed_runtime")
      || selectedProvider.value?.capabilities.includes("supervised_runtime")
    ) return "Required";
    return "External app";
  });
  const bridgeLabel = computed(() => {
    if (
      selectedProviderId.value === "claude-code" &&
      launchMode.value === "supervised"
    ) return "Managed at launch";
    if (preflight.value?.mcpStatus === "installed") return "Installed";
    if (preflight.value?.mcpStatus === "needs_attention") return "Needs repair";
    if (preflight.value?.mcpStatus === "not_installed") return "Not installed";
    return "Unknown";
  });
  const repoLabel = computed(() => {
    if (!agentProviderNeedsDesktopRepo(selectedProvider.value)) return "Handled by provider app";
    const mismatch = preflight.value?.branchMismatch;
    if (mismatch) {
      return mismatch.currentBranch
        ? `${mismatch.currentBranch} - expected ${mismatch.expectedBranch}`
        : `Expected ${mismatch.expectedBranch}`;
    }
    return props.repoRootPath || "Required before local agents can start";
  });
  const showSecureStorage = computed(() => launchMode.value === "supervised");
  const secureStorageLabel = computed(() => {
    if (!showSecureStorage.value) return null;
    if (!secureStorageStatus.value) return "Checking";
    return secureStorageStatus.value.available ? "Available" : "Unlock required";
  });
  const secureStorageNeedsAttention = computed(() =>
    showSecureStorage.value && secureStorageStatus.value?.available === false
  );
  const canOpenSecureStorage = computed(() =>
    secureStorageNeedsAttention.value && secureStorageStatus.value?.canOpenCredentialStorage === true
  );
  const expectedWorktreeBranch = computed(() =>
    preflight.value?.branchMismatch?.expectedBranch ||
    branchScopedGitRoomExpectedBranch(props.roomGitRoom, props.repoStatus)
  );
  const matchingWorktrees = computed(() =>
    props.roomGitRoom && !props.gitRoomMatchesActiveRepo
      ? []
      : matchingManagedAgentWorktreesForBranch(props.repoStatus, expectedWorktreeBranch.value)
  );
  const showWorktreePicker = computed(() => preflight.value?.nextAction === "choose_worktree");
  const canCreateWorktree = computed(() => Boolean(
    props.repoRootPath?.trim() &&
    expectedWorktreeBranch.value?.trim() &&
    (!props.roomGitRoom || props.gitRoomMatchesActiveRepo)
  ));
  const createWorktreeButtonLabel = computed(() =>
    creatingWorktree.value
      ? "Creating worktree..."
      : `Create worktree on ${expectedWorktreeBranch.value}`
  );
  const worktreePickerDescription = computed(() => {
    const expectedBranch = expectedWorktreeBranch.value || "this branch";
    return matchingWorktrees.value.length
      ? `Pick an existing checkout on ${expectedBranch}.`
      : `Open an existing worktree on ${expectedBranch}, then check again.`;
  });

  const deliveryModeDescription = computed(() =>
    deliveryMode.value === "desktop_events"
      ? "This desktop app sends room updates to the local agent."
      : "The agent app joins the room through its LetAgents connection."
  );
  const lifecycleDescription = computed(() => {
    if (launchMode.value === "legacy") {
      return "The current app-owned path stays unchanged and stops with its normal lifecycle.";
    }
    if (/^local[_-]/i.test(props.roomIdentifier) || /^git-room:local:/i.test(props.roomIdentifier)) {
      return "Supervision needs a cloud room for durable workplace reachability. Local-only rooms keep the existing path.";
    }
    return "A detached daemon owns desired state and recovery. Closing this app does not stop the supervised agent.";
  });
  const showCursorMcpPolicySelector = computed(() =>
    launchMode.value === "legacy" && shouldShowCursorMcpPolicySelector(selectedProvider.value)
  );
  const showDeliverySelector = computed(() => shouldShowDeliveryModeSelector(selectedProvider.value));
  const showOpenModelConfig = computed(() => shouldShowOpenModelConfig(selectedProvider.value));
  const showModelSelector = computed(() => shouldShowManagedModelSelector(selectedProvider.value));
  const showEffortSelector = computed(() =>
    selectedProviderId.value === "codex"
  );

  const providerModelOptions = computed(() => providerModels.value?.models ?? []);
  const providerModelCatalogLabel = computed(() => {
    if (loadingProviderModels.value) return "Loading the provider model catalog...";
    if (providerModels.value?.error) {
      const providerName = selectedProvider.value?.name || "provider";
      return `${providerModels.value.error} You can keep the ${providerName} default or try Refresh models again.`;
    }
    const count = providerModelOptions.value.length;
    return count
      ? `${count} provider model${count === 1 ? "" : "s"} available.`
      : "Provider default and custom model ids are available.";
  });
  const providerModelCatalogIsError = computed(() => Boolean(providerModels.value?.error));
  const modelSelectOptions = computed<DesktopSelectOption[]>(() => [
    { value: "default", label: "Use provider default" },
    ...providerModelOptions.value.map((option) => ({
      value: `option:${option.id}`,
      label: option.label,
    })),
    { value: "custom", label: "Custom model id" },
  ]);
  const effortSelectOptions = computed<DesktopSelectOption[]>(() => [
    { value: "", label: "Use provider default" },
    ...managedAgentEffortOptionsForProvider(selectedProviderId.value),
  ]);
  const selectedProviderModel = computed(() =>
    providerModelOptions.value.find((option) => option.id === selectedProviderModelId.value) ?? null
  );
  const selectedModelChoice = computed(() =>
    selectedModelMode.value === "option" && selectedProviderModelId.value
      ? `option:${selectedProviderModelId.value}`
      : selectedModelMode.value
  );
  const selectedModel = computed(() => {
    if (selectedModelMode.value === "option") return selectedProviderModelId.value.trim() || null;
    if (selectedModelMode.value === "custom") return customModelId.value.trim() || null;
    return null;
  });
  const selectedModelSource = computed<DesktopAgentProviderModelSource | null>(() => {
    if (selectedModelMode.value === "option") return selectedProviderModel.value?.source ?? "provider";
    if (selectedModelMode.value === "custom") return "custom";
    return null;
  });
  const selectedCursorMcpPolicyDescription = computed(() =>
    cursorMcpPolicyDescription(selectedCursorMcpPolicy.value)
  );
  const modelSelectorDescription = computed(() => {
    if (loadingProviderModels.value) return "Loading available models...";
    if (selectedModelMode.value === "default") {
      const defaultModel = providerModels.value?.defaultModel;
      return defaultModel
        ? `Use the provider default (${defaultModel}).`
        : "Use the model configured by the provider app.";
    }
    if (selectedModelMode.value === "custom") {
      if (selectedProviderId.value === "cursor") {
        return selectedModel.value
          ? "Pass this model id directly to Cursor. Cursor effort overrides can use Cursor's parameterized model syntax."
          : "Enter a Cursor model id or parameterized model string for this agent session.";
      }
      return selectedModel.value
        ? "Pass this model id directly to the provider for this agent session."
        : "Enter a provider model id or alias for this agent session.";
    }
    return selectedProviderModel.value
      ? `Use ${selectedProviderModel.value.label} for this agent session.`
      : "Choose another model or return to provider default.";
  });
  const effortSelectorDescription = computed(() => {
    if (!selectedEffort.value) {
      return "Use the provider's configured reasoning effort for this agent session.";
    }
    return `Use ${managedAgentEffortLabel(selectedEffort.value).toLowerCase()} reasoning effort for this agent session.`;
  });
  const selectedPermissionProfileWarning = computed(() => {
    if (
      !hasDesktopManagedRuntime(selectedProvider.value)
      && !hasSupervisedRuntime(selectedProvider.value)
    ) return null;
    const profile = selectedPermissionProfile.value;
    if (!profile || profile.status !== "available") return null;
    const providerName = selectedProvider.value?.name?.trim() || "this agent";
    if (launchMode.value === "supervised" && selectedProviderId.value === "cursor") {
      if (profile.id === "full_access") {
        return "Full access disables Cursor's native sandbox inside a private turn workspace. LetAgents carries back only conflict-checked, nonignored file edits; Git history and ignored output are not persisted. Only daemon-mediated room tools are exposed.";
      }
      if (profile.id === "sandboxed_write") {
        return "LetAgents runs Cursor in a private turn workspace and carries back conflict-checked, nonignored file edits. Ignored dependencies stay read-only and Git history is not changed. Daemon-mediated LetAgents room tools remain available.";
      }
    }
    if (profile.risk === "high") {
      return `${profile.label} gives ${providerName} broad write and shell access. Use only with trusted repos and MCPs.`;
    }
    if (
      selectedProviderId.value === "cursor" &&
      launchMode.value === "legacy" &&
      profile.id === "sandboxed_write" &&
      selectedCursorMcpPolicy.value !== "none"
    ) {
      return "Sandboxed writes still allow the selected Cursor MCP tools.";
    }
    return null;
  });

  return {
    selectedProvider,
    selectedPermissionProfiles,
    selectedPermissionProfile,
    canStartManagedAgent,
    authCommand,
    authCommandForProvider,
    installCommand,
    installUrl,
    roomLabel,
    externalJoinPrompt,
    activeSetupConfirmation,
    statusTitle,
    statusDescription,
    preflightStatusLabel,
    runtimeLabel,
    bridgeLabel,
    repoLabel,
    showSecureStorage,
    secureStorageLabel,
    secureStorageNeedsAttention,
    canOpenSecureStorage,
    expectedWorktreeBranch,
    matchingWorktrees,
    showWorktreePicker,
    canCreateWorktree,
    createWorktreeButtonLabel,
    worktreePickerDescription,
    deliveryModeDescription,
    lifecycleDescription,
    showCursorMcpPolicySelector,
    showDeliverySelector,
    showOpenModelConfig,
    showModelSelector,
    showEffortSelector,
    providerModelOptions,
    providerModelCatalogLabel,
    providerModelCatalogIsError,
    modelSelectOptions,
    effortSelectOptions,
    selectedProviderModel,
    selectedModelChoice,
    selectedModel,
    selectedModelSource,
    selectedCursorMcpPolicyDescription,
    modelSelectorDescription,
    effortSelectorDescription,
    selectedPermissionProfileWarning,
  };
}

function managedAgentEffortOptionsForProvider(
  providerId: DesktopAgentProviderId | null,
): DesktopSelectOption[] {
  const shared = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
  ];
  return providerId === "claude-code"
    ? [...shared, { value: "max", label: "Max" }]
    : providerId === "codex" ? shared : [];
}

function managedAgentEffortLabel(effort: string | null | undefined): string {
  if (effort === "low") return "Low";
  if (effort === "medium") return "Medium";
  if (effort === "high") return "High";
  if (effort === "xhigh") return "Extra high";
  if (effort === "max") return "Max";
  return "";
}
