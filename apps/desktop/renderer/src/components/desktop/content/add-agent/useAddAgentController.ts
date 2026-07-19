import { computed, ref, watch, type ComputedRef } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopGitRoomInfo,
  DesktopManagedAgentSession,
  DesktopManagedAgentPermissionProfileId,
  DesktopSupervisorCreateInput,
  DesktopSupervisorManifestEntry,
  RepoStatus,
} from "../../../../../../electron/ipc-types";
import {
  hasDesktopManagedRuntime,
  hasSupervisedRuntime,
  supervisedProviderLaunchPolicy,
} from "../../../../domain/managed-agents";
import { desktopIpc } from "../../../../ipc/index.js";
import { useManagedAgentSessionsContext } from "./managed-agent-sessions-context";
import { useSupervisedAgentLaunch } from "./useSupervisedAgentLaunch";
import { useManagedAgentLaunch } from "./useManagedAgentLaunch";
import { useAddAgentConfiguration } from "./useAddAgentConfiguration";
import { useAddAgentSetup } from "./useAddAgentSetup";
import { useAddAgentPresentation } from "./useAddAgentPresentation";
import { contextualAddAgentError } from "./add-agent-errors";
import { suggestSupervisedCodexCodename } from "../../../../domain/codenames";
import {
  canStartNewSupervisedLaunch,
  recoveryScanAllowsNewLaunch,
} from "./useSupervisedLaunchRecovery";

export interface AddAgentModalProps {
  open: boolean;
  roomIdentifier: string;
  roomGitRoom: DesktopGitRoomInfo | null;
  gitRoomMatchesActiveRepo: boolean;
  roomDisplayName: string | null;
  repoRootPath: string | null;
  repoStatus: RepoStatus | null;
}

export interface AddAgentModalEvents {
  close: [];
  "choose-repo": [];
  "choose-worktree": [rootPath: string];
  "managed-session-started": [session: DesktopManagedAgentSession];
}

export type AddAgentModalEmit = <Event extends keyof AddAgentModalEvents>(
  event: Event,
  ...args: AddAgentModalEvents[Event]
) => void;

export interface AddAgentSupervisedUi {
  launch: ReturnType<typeof useSupervisedAgentLaunch>;
  recoverableProviderName: ComputedRef<string | null>;
}

export interface SupervisedLaunchCreateSnapshot {
  creationRequestId: string;
  providerId: DesktopAgentProviderId;
  providerName: string;
  roomIdentifier: string;
  repoRootPath: string;
  charter: string;
  permissionProfileId: DesktopManagedAgentPermissionProfileId | null;
  launchPolicy: unknown;
  model: string | null;
}

type SupervisedCreateClient = Pick<typeof desktopIpc.supervisor, "listAgents" | "createAgent">;

/**
 * The click-time snapshot is intentionally complete: controls remain editable
 * while the name lookup awaits, but they must not change the authority of the
 * durable agent that click already requested.
 */
export async function createSupervisedAgentFromSnapshot(
  client: SupervisedCreateClient,
  snapshot: SupervisedLaunchCreateSnapshot,
  isCurrent: () => boolean,
): Promise<DesktopSupervisorManifestEntry | null> {
  let existingDisplayNames: string[] = [];
  try {
    existingDisplayNames = (await client.listAgents(snapshot.roomIdentifier))
      .map((entry) => entry.displayName);
  } catch {
    // A recovery scan can legitimately be unavailable while create still
    // succeeds. The request id still gives this attempt a unique display
    // suffix; the daemon remains the identity authority.
  }
  const displayName = snapshot.providerId === "codex"
    ? suggestSupervisedCodexCodename(existingDisplayNames, snapshot.creationRequestId)
    : `${snapshot.providerName} supervised agent`;
  // listAgents is an async gap before the durable boundary. Modal close,
  // provider switch, and request invalidation must all fence createAgent here,
  // not only after a durable agent has already been created.
  if (!isCurrent()) return null;
  const input: DesktopSupervisorCreateInput = {
    creationRequestId: snapshot.creationRequestId,
    providerId: snapshot.providerId,
    roomIdentifier: snapshot.roomIdentifier,
    displayName,
    repoRootPath: snapshot.repoRootPath,
    charter: snapshot.charter,
    permissionProfileId: snapshot.permissionProfileId,
    launchPolicy: snapshot.launchPolicy,
    model: snapshot.model,
  };
  return client.createAgent(input);
}

export function useAddAgentController(
  props: AddAgentModalProps,
  emit: AddAgentModalEmit,
) {

const managedSessionsContext = useManagedAgentSessionsContext();
const managedLaunch = useManagedAgentLaunch({
  onStarted: (session) => emit("managed-session-started", session),
});

const startingAgent = ref(false);
let startOperationInFlight = false;
const setup = useAddAgentSetup();
const {
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
} = setup;
const configuration = useAddAgentConfiguration();
const {
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
} = configuration;

const {
  selectedProvider,
  selectedPermissionProfiles,
  selectedPermissionProfile,
  canStartManagedAgent,
  authCommand,
  authCommandForProvider,
  roomLabel,
  externalJoinPrompt,
  activeSetupConfirmation,
  statusTitle,
  statusDescription,
  preflightStatusLabel,
  runtimeLabel,
  bridgeLabel,
  repoLabel,
  supervisedPermissionBridgeUnavailable,
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
} = useAddAgentPresentation(props, setup, configuration);
let setupActions!: ReturnType<typeof setup.bind>;
const {
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
  invalidateRequests: invalidateConfigurationRequests,
  resetModelSelection: resetConfigurationModelSelection,
  resetTransientState: resetConfigurationTransientState,
} = configuration.bind({
  open: () => props.open,
  roomIdentifier: () => props.roomIdentifier,
  roomGitRoom: () => props.roomGitRoom,
  repoRootPath: () => props.repoRootPath,
  selectedProviderId,
  selectedProvider,
  selectedPermissionProfile,
  showOpenModelConfig,
  showModelSelector,
  showEffortSelector,
  providerModelOptions,
  selectedModel,
  selectedModelSource,
  requestPreflight: (options) => setupActions.requestPreflight(options),
  runPreflight: (options) => setupActions.runPreflight(options),
  onMessage: setSetupMessage,
});
const supervisedLaunch = useSupervisedAgentLaunch({
  open: () => props.open,
  roomIdentifier: () => props.roomIdentifier,
  roomLabel,
  providerId: selectedProviderId,
  authCommand,
  authCommandForProvider,
  currentVersion: setup.currentVersion,
  isCurrentRequest: (version) => props.open && version === setup.currentVersion(),
  onChooseRepo: () => emit("choose-repo"),
  onCopyAuthCommand: (command) => void setupActions.copyAgentAuthCommand(command),
  onRetry: () => void startManagedAgent(),
  onMessage: setSetupMessage,
});
const launchStarted = supervisedLaunch.launchStarted;
const supervisedConflict = supervisedLaunch.conflict;
const supervisedConflictLookupError = supervisedLaunch.conflictLookupError;
const supervisedConflictLookupTone = supervisedLaunch.conflictLookupTone;
const supervisedRecoveryScanStatus = supervisedLaunch.recoveryScanStatus;
const stoppingSupervisorEntryId = supervisedLaunch.stoppingEntryId;
const supervisedLaunchView = supervisedLaunch.view;
const supervisedRecoveryCandidate = supervisedLaunch.recoveryCandidate;
const recoveringSupervisedCandidate = supervisedLaunch.recoveringCandidate;
const recoverableProviderName = computed(() => {
  const candidate = supervisedRecoveryCandidate.value;
  if (!candidate || candidate.provider !== selectedProviderId.value) return null;
  return providers.value.find((provider) => provider.id === candidate.provider)?.name
    ?? candidate.provider.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
});
const supervisedUi: AddAgentSupervisedUi = { launch: supervisedLaunch, recoverableProviderName };
watch([supervisedRecoveryCandidate, supervisedConflict, selectedProvider], ([candidate, activeEntry, provider]) => {
  const recoveryEntry = candidate ?? activeEntry;
  if (recoveryEntry && provider?.id === recoveryEntry.provider && hasSupervisedRuntime(provider)) {
    launchMode.value = "supervised";
  }
}, { immediate: true });
const detectRecoverableSupervisedLaunch = supervisedLaunch.detectRecoverableLaunch;
const recoverSupervisedLaunch = supervisedLaunch.recoverDetectedLaunch;
const stopSupervisedConflict = supervisedLaunch.stop;
const dismissLaunch = supervisedLaunch.dismiss;
const handleLaunchRecover = supervisedLaunch.handleRecover;
setupActions = setup.bind({
  open: () => props.open,
  roomIdentifier: () => props.roomIdentifier,
  roomGitRoom: () => props.roomGitRoom,
  repoRootPath: () => props.repoRootPath,
  selectedProvider,
  selectedPermissionProfile,
  expectedWorktreeBranch,
  authCommand,
  externalJoinPrompt,
  selectedCursorMcpPolicy,
  selectedModel,
  selectedModelSource,
  selectedEffort,
  launchMode,
  loadOpenModelSettings,
  loadProviderModels,
  syncPermissionProfileSelection,
  syncDeliveryModeSelection,
  invalidateConfigurationRequests,
  resetConfigurationModelSelection,
  resetConfigurationTransientState,
  onDetectRecoverableLaunch: () => { void detectRecoverableSupervisedLaunch(); },
  onResetSupervisedLaunch: supervisedLaunch.resetActiveLaunch,
  onCleanupSupervisedLaunch: supervisedLaunch.cleanup,
  onResetStartingAgent: () => { startingAgent.value = startOperationInFlight; },
  onChooseWorktree: (rootPath) => emit("choose-worktree", rootPath),
});
const {
  refreshSelectedProvider,
  retryProviderSetup,
  selectProvider,
  runSetupAction,
  chooseWorktree,
  createWorktree,
  setupActionButtonText,
  copyAgentAuthCommand,
  copyExternalJoinPrompt,
} = setupActions;

async function startManagedAgent(): Promise<void> {
  if (!selectedProviderId.value || !props.repoRootPath || startOperationInFlight) return;
  if (!hasDesktopManagedRuntime(selectedProvider.value)) return;
  const requestVersion = setup.currentVersion();
  const requestRoomIdentifier = props.roomIdentifier;
  const requestLaunchMode = launchMode.value;
  const requestProviderId = selectedProviderId.value;
  const requestProviderName = selectedProvider.value?.name ?? "Agent";
  const requestRepoRootPath = props.repoRootPath;
  const requestCharter = supervisedCharter.value.trim();
  const requestPermissionProfileId = selectedPermissionProfile.value?.id ?? null;
  const requestLaunchPolicy = supervisedProviderLaunchPolicy(
    requestProviderId,
    requestPermissionProfileId,
  );
  const requestModel = selectedModel.value;
  let supervisedCreationRequestId: string | null = null;
  startingAgent.value = true;
  startOperationInFlight = true;
  setSetupMessage(null);
  try {
    if (requestLaunchMode === "supervised") {
      const scanAllowsNewLaunch = recoveryScanAllowsNewLaunch(supervisedRecoveryScanStatus.value);
      if (!scanAllowsNewLaunch) {
        throw new Error("Check for previous supervised agents before starting a new one.");
      }
      if (!canStartNewSupervisedLaunch({
        providerId: requestProviderId,
        scanStatus: supervisedRecoveryScanStatus.value,
        hasActiveLaunch: Boolean(supervisedLaunchView.value || supervisedConflict.value || launchStarted.value),
        hasRecoveryCandidate: Boolean(supervisedRecoveryCandidate.value),
        recoveringCandidate: recoveringSupervisedCandidate.value,
      })) return;
      if (supervisedPermissionBridgeUnavailable.value) {
        throw new Error("Supervised Claude Code cannot use Ask before writes yet because native permission prompts are not bridged. Choose Read-only or Full access.");
      }
      if (!hasSupervisedRuntime(selectedProvider.value)) {
        throw new Error("This provider has not passed the durable supervision evidence gate.");
      }
      // The launch card must appear the instant Start is clicked — before the
      // create request returns — and advance from the ordered launch-event
      // stream Electron emits for this exact launch id (connect → save →
      // activate). Subscribe first so no early fact is missed.
      const creationRequestId = supervisedLaunch.begin();
      supervisedCreationRequestId = creationRequestId;
      const creationSnapshot: SupervisedLaunchCreateSnapshot = {
        creationRequestId,
        providerId: requestProviderId,
        providerName: requestProviderName,
        roomIdentifier: requestRoomIdentifier,
        repoRootPath: requestRepoRootPath,
        charter: requestCharter,
        permissionProfileId: requestPermissionProfileId,
        launchPolicy: requestLaunchPolicy,
        model: requestModel,
      };
      // A name is presentation, never identity. The helper reads the room's
      // labels while retaining every click-time launch input above.
      const entry = await createSupervisedAgentFromSnapshot(
        desktopIpc.supervisor,
        creationSnapshot,
        () => setupActions.isCurrentRequest(requestVersion),
      );
      if (!entry) {
        supervisedLaunch.dismiss();
        return;
      }
      if (!setupActions.isCurrentRequest(requestVersion)) {
        if (props.open && props.roomIdentifier === requestRoomIdentifier) {
          supervisedLaunch.offerRecoveryCandidate(entry);
        }
        return;
      }
      // The durable claim now exists: from here the journey is derived from the
      // manifest the daemon owns. Keep the same card; feed it the entry.
      supervisedLaunch.complete(entry);
      void managedSessionsContext.refresh();
      return;
    }
    const startMessage = await managedLaunch.start({
      providerId: selectedProviderId.value,
      roomIdentifier: props.roomIdentifier,
      roomGitRoom: props.roomGitRoom,
      roomDisplayName: props.roomDisplayName,
      repoRootPath: props.repoRootPath,
      deliveryMode: deliveryMode.value,
      permissionProfileId: selectedPermissionProfile.value?.id ?? null,
      cursorMcpPolicy: selectedProviderId.value === "cursor" ? selectedCursorMcpPolicy.value : null,
      model: selectedModel.value,
      modelSource: selectedModelSource.value,
      effort: selectedEffort.value || null,
    });
    if (!setupActions.isCurrentRequest(requestVersion)) return;
    setSetupMessage(startMessage);
    await setupActions.runPreflight();
  } catch (error) {
    if (!setupActions.isCurrentRequest(requestVersion)) {
      if (
        requestLaunchMode === "supervised"
        && supervisedCreationRequestId
        && props.roomIdentifier === requestRoomIdentifier
      ) {
        await supervisedLaunch.offerAmbiguousCreationCandidate(
          supervisedCreationRequestId,
          requestRoomIdentifier,
        );
      }
      return;
    }
    if (requestLaunchMode === "supervised") {
      await supervisedLaunch.recoverFailedCreation(error);
      if (!setupActions.isCurrentRequest(requestVersion)) return;
      // The event-backed launch card owns failure display with safe product
      // copy; keep the raw supervised error out of the primary UI. A pre-launch
      // guard that fails before the card appears still surfaces its own message.
      setSetupMessage(launchStarted.value
        ? null
        : contextualAddAgentError(
          `Couldn't start ${selectedProvider.value?.name || "the agent"}`,
          error,
          "Review the setup details and try again.",
        ), launchStarted.value ? "status" : "error");
    } else {
      setSetupMessage(contextualAddAgentError(
        `Couldn't start ${selectedProvider.value?.name || "the agent"}`,
        error,
        "Review the setup details and try again.",
      ), "error");
    }
  } finally {
    startOperationInFlight = false;
    startingAgent.value = false;
  }
}

  return { roomLabel, providers, selectedProviderId, selectProvider, selectedProvider, preflight, loadingProviders, loadingPreflight, loadError, statusTitle, statusDescription, preflightStatusLabel, runtimeLabel, bridgeLabel, repoLabel, showWorktreePicker, matchingWorktrees, worktreePickerDescription, authCommand, retryProviderSetup, chooseWorktree, showOpenModelConfig, openModelBaseUrl, openModelModel, openModelApiKey, openModelStatus, openModelError, savingOpenModelSettings, saveOpenModelSettings, clearOpenModelApiKey, showModelSelector, loadingProviderModels, selectedModelChoice, modelSelectOptions, selectedModelMode, customModelId, modelSelectorDescription, showEffortSelector, selectedEffort, effortSelectOptions, effortSelectorDescription, providerModelCatalogLabel, providerModelCatalogIsError, refreshProviderModels, handleModelChoiceValue, handleEffortValue, launchMode, lifecycleDescription, supervisedCharter, showDeliverySelector, deliveryMode, deliveryModeDescription, selectedPermissionProfiles, selectedPermissionProfile, supervisedPermissionBridgeUnavailable, showCursorMcpPolicySelector, selectedCursorMcpPolicy, selectedCursorMcpPolicyDescription, externalJoinPrompt, copyingExternalPrompt, selectPermissionProfile, copyExternalJoinPrompt, setupMessage, setupMessageTone, supervisedUi, setupBusy, setupActionButtonText, copyingAuthCommand, canCreateWorktree, creatingWorktree, createWorktreeButtonLabel, canStartManagedAgent, startingAgent, activeSetupConfirmation, selectedPermissionProfileWarning, runSetupAction, copyAgentAuthCommand, createWorktree, startManagedAgent };
}
