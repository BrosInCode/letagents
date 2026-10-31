import { computed, watch } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopAgentProviderModelOption,
  DesktopAgentProviderModelSource,
  DesktopGitRoomInfo,
  RepoStatus,
} from "../../../../../../electron/ipc-types";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import {
  autoReviewNotice,
  agentAuthCommand,
  agentProviderNeedsDesktopRepo,
  branchScopedGitRoomExpectedBranch,
  externalMcpProviderJoinPrompt,
  hasSupervisedRuntime,
  isAgentSetupConfirmationActive,
  isExternalMcpProviderReady,
  matchingManagedAgentWorktreesForBranch,
  shouldShowManagedModelSelector,
  shouldShowOpenModelConfig,
  supervisedPermissionProfilePresentation,
} from "../../../../domain/managed-agents";
import type { DesktopSelectOption } from "../../controls/DesktopSelectField.vue";
import type { useAddAgentConfiguration } from "./useAddAgentConfiguration";
import type { useAddAgentSetup } from "./useAddAgentSetup";
import { cursorWindowsSandboxNotice, thisComputerLabel } from "../../../../domain/supervised-agents-support";

interface AddAgentPresentationProps {
  roomIdentifier: string;
  roomStorageMode?: "local" | "cloud";
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
    supervisedCharter,
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
  // Secure storage, the first task and the recovery scan belong to a supervised
  // launch. A provider without a supervised runtime is only handed off.
  const supervisedProvider = computed(() => hasSupervisedRuntime(selectedProvider.value));
  const showSecureStorage = computed(() => props.roomStorageMode !== "local" && supervisedProvider.value);
  const selectedPermissionProfiles = computed(() => {
    const profiles = selectedProvider.value?.permissionProfiles ?? [];
    return profiles.map((profile) => supervisedPermissionProfilePresentation(selectedProviderId.value, profile, { hasProject: Boolean(props.repoRootPath?.trim()) }));
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
      (props.roomStorageMode === "local" || secureStorageStatus.value?.available === true) &&
      (!loadingPreflight.value || Boolean(preflight.value)) &&
      (selectedModelMode.value !== "option" || !loadingProviderModels.value) &&
      (
        !selectedPermissionProfiles.value.length ||
        selectedPermissionProfile.value?.status === "available"
      ) &&
      Boolean(supervisedCharter.value.trim())
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
    if (loadError.value) return "Could not check the agent app";
    if (!preflight.value) return "Choose an agent app";
    if (showSecureStorage.value && secureStorageStatus.value?.available === false) {
      return "Unlock secure credential storage";
    }
    if (preflight.value.status === "ready") return "Choose how it works here";
    return safeUserVisibleErrorDetail(preflight.value.message, "Agent setup needs attention");
  });
  const statusDescription = computed(() => {
    if (loadError.value) return "We couldn't check this agent app. Choose Check again to retry.";
    if (!preflight.value) return "Checking the agent app…";
    if (showSecureStorage.value && secureStorageStatus.value?.available === false) {
      return secureStorageStatus.value.detail;
    }
    if (preflight.value.status !== "ready") {
      return safeUserVisibleErrorDetail(
        preflight.value.detail || preflight.value.message,
        "Agent setup needs attention. Check the agent app, then try again.",
      );
    }
    if (!supervisedProvider.value) {
      return "Use the handoff below to bring it into this room.";
    }
    return "Choose a model, set its access, and give it something to work on.";
  });
  const preflightStatusLabel = computed(() => {
    if ((loadingProviders.value || loadingPreflight.value) && !preflight.value) return "Checking";
    if (loadError.value || preflight.value?.status === "error") return "Needs attention";
    if (showSecureStorage.value && secureStorageStatus.value?.available === false) return "Needs attention";
    if (preflight.value?.status === "ready") return "Ready";
    if (!preflight.value) return "Not checked";
    return "Setup needed";
  });
  const runtimeLabel = computed(() => {
    if (preflight.value?.version) return preflight.value.version;
    if (preflight.value?.status === "missing_runtime") return "Missing";
    if (supervisedProvider.value) return "Required";
    return "External app";
  });
  const bridgeLabel = computed(() => {
    if (selectedProviderId.value === "claude-code" || selectedProviderId.value === "codex") {
      return "Managed at launch";
    }
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
    if (props.repoRootPath) return props.repoRootPath;
    // A repo-less room (no git binding, no resolved repo path) launches the
    // agent in a private, empty scratch folder the daemon provisions — it does
    // NOT need a repo. Only a repo-backed room still prompts for one.
    if (props.roomGitRoom == null) return "Private scratch workspace";
    return "Required before local agents can start";
  });
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

  const lifecycleDescription = computed(() => props.roomStorageMode === "local"
    ? `Runs on ${thisComputerLabel()} and keeps working after you quit LetAgents. Room history is stored on ${thisComputerLabel()}.`
    : `Runs on ${thisComputerLabel()} and keeps working after you quit LetAgents. Room messages are shared in the cloud.`);
  const showOpenModelConfig = computed(() => shouldShowOpenModelConfig(selectedProvider.value));
  const showModelSelector = computed(() => shouldShowManagedModelSelector(selectedProvider.value));
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
  const selectedProviderModel = computed(() =>
    providerModelOptions.value.find((option) => option.id === selectedProviderModelId.value) ?? null
  );
  // The model an Open Model agent would run: the saved one by default, or the
  // chosen option. A custom id has no catalog entry, so it has no efforts.
  const effortModelOption = computed(() => {
    if (selectedModelMode.value === "option") return selectedProviderModel.value;
    if (selectedModelMode.value === "default") {
      const defaultModel = providerModels.value?.defaultModel;
      return providerModelOptions.value.find((option) => option.id === defaultModel) ?? null;
    }
    return null;
  });
  const effortOptions = computed(() =>
    managedAgentEffortOptionsForProvider(selectedProviderId.value, effortModelOption.value)
  );
  const showEffortSelector = computed(() =>
    selectedProviderId.value === "codex"
    || selectedProviderId.value === "claude-code"
    || (selectedProviderId.value === "open-model" && effortOptions.value.length > 0)
  );
  const effortSelectOptions = computed<DesktopSelectOption[]>(() => [
    { value: "", label: "Use provider default" },
    ...effortOptions.value,
  ]);
  // A model that does not list the chosen effort gets its own default instead.
  watch(effortOptions, (options) => {
    if (selectedEffort.value && !options.some((option) => option.value === selectedEffort.value)) {
      selectedEffort.value = "";
    }
  }, { flush: "sync" });
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
    if (!supervisedProvider.value) return null;
    const profile = selectedPermissionProfile.value;
    if (!profile || profile.status !== "available") return null;
    const providerName = selectedProvider.value?.name?.trim() || "this agent";
    if (selectedProviderId.value === "cursor") {
      // Full access has no limits to describe; the other profiles say Windows has no sandbox.
      const windowsNotice = cursorWindowsSandboxNotice("cursor");
      if (windowsNotice && profile.id !== "full_access") {
        return profile.id === "read_only"
          ? `Cursor can inspect the selected workspace but cannot edit it. ${windowsNotice}`
          : `Cursor edits a separate copy of your project. LetAgents checks for conflicts before copying changes back. ${windowsNotice}`;
      }
      if (profile.id === "full_access") {
        return "Cursor edits a separate copy of your project with its own command restrictions off. LetAgents checks for conflicts before copying changes back; files ignored by Git and changes to Git history are not copied back. Only LetAgents room tools are available.";
      }
      if (profile.id === "sandboxed_write") {
        return "Cursor edits a separate copy of your project with restricted file and command access. LetAgents checks for conflicts before copying changes back. Files ignored by Git stay read-only, Git history is kept, and LetAgents room tools remain available.";
      }
    }
    if (profile.id === "auto_review") return autoReviewNotice(providerName, selectedProviderId.value);
    if (profile.risk === "high") {
      return `${providerName} can change files and run commands without asking, including outside your project. Use only with projects and connected tools you trust.`;
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
    lifecycleDescription,
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
    modelSelectorDescription,
    effortSelectorDescription,
    selectedPermissionProfileWarning,
  };
}

/**
 * Codex takes every shared effort, and Claude Code also Max. An Open Model agent takes exactly the
 * efforts its endpoint lists for the model, so a model without that list has
 * no effort setting at all.
 */
export function managedAgentEffortOptionsForProvider(
  providerId: DesktopAgentProviderId | null,
  model: DesktopAgentProviderModelOption | null = null,
): DesktopSelectOption[] {
  const shared = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
  ];
  if (providerId === "open-model") {
    const supported = model?.supportedEfforts ?? [];
    return shared.filter((option) => supported.some((effort) => effort === option.value));
  }
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
