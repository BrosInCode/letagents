import { computed, ref, toRef } from "vue";
import type {
  DesktopAgentProvider,
  DesktopSupervisorManifestEntry,
  DesktopAgentStreamEvent,
  DesktopSupervisorDaemonStatus,
  RepoStatus,
} from "../../../../electron/ipc-types";
import { useCopyIndicator } from "../useCopyIndicator";
import { useDesktopActionToasts } from "../useDesktopActionToasts";
import { createRoomDeliveryRetryCoordinator } from "../../domain/room-delivery-retry";
import { resolveAgentInspectorSelection, type SupervisorEntriesResource } from "../../domain/agent-inspector-identity";
import type { AgentInspectorActionState } from "../../domain/agent-inspector";
import type { AgentInspectorConfigurationResource, AgentInspectorRoomMoveResource } from "../../domain/agent-inspector-settings";
import {
  createAgentInspectorBackgroundRefresh,
  createAgentInspectorDetailRequest,
  emptyAgentInspectorWorkResource,
  type AgentInspectorWorkResource,
} from "../../domain/agent-inspector-work";
import PersonActionsHost from "../../components/desktop/content/PersonActionsHost.vue";
import RoomChatView from "../../components/desktop/content/RoomChatView.vue";
import { readEnvironmentPanelOpen, readGitHubEventsVisible } from "../../components/desktop/content/room-shell/preferences";
import { isRoomTabId, type RoomTabId } from "../../components/desktop/content/room-shell/types";
import type { AgentInspectorSelection, AgentInspectorRequest } from "../../components/desktop/content/desktop-chat-message/types";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** The shell's refs, constants, request holders, and simple derived state. Created first. */
export function useRoomShellState(context: unknown) {
  const {
    props,
  } = context as RoomShellContextOf<"inputs">;
  const { pushActionToast } = useDesktopActionToasts();
  const personActions = ref<InstanceType<typeof PersonActionsHost> | null>(null);
  const roomRef = toRef(props, "room");
  const messagesRef = toRef(props, "messages");
  const reasoningSessionsRef = toRef(props, "reasoningSessions");
  const activeTab = ref<RoomTabId>(readRoomActiveTab(props.room.identifier));
  const roomChatView = ref<InstanceType<typeof RoomChatView> | null>(null);
  const revealedMessageId = ref<string | null>(null);
  const actionPanelOpen = ref(false);
  /** The Room settings section to show when the panel opens, or null for the top. */
  const actionPanelSection = ref<string | null>(null);
  const addAgentModalOpen = ref(false);
  const selectedAgentDetailRequest = ref<AgentInspectorRequest | null>(null);
  const selectedAgentDetailRequestVersion = ref(0);
  const agentInspectorInitialTab = ref<"overview" | "live" | "work" | "workspace" | "diagnostics">("overview");
  const agentInspectorActionState = ref<AgentInspectorActionState | null>(null);
  const agentInspectorCompact = ref(false);
  // Agent inspector request tokens and timers. Its loaders, the room-change and
  // inspector watchers, the supervisor status refresh, and unmount all read them.
  const agentInspectorRequestState = {
    agentInspectorLiveIdentity: null as string | null,
    agentInspectorSettingsRequestToken: 0,
    agentInspectorRoomMoveRequestToken: 0,
    agentInspectorRoomMoveRecoveryTimer: null as number | null,
    agentInspectorWorkRequestToken: 0,
  };
  // Ephemeral live feed for the inspected agent's "Live" tab. Not persisted;
  // accumulates raw stream events for the focused entry only, reset on focus
  // change and inspector close.
  const agentInspectorLiveFeed = ref<{ events: DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number }>({ events: [], ended: false, droppedEvents: 0 });
  const agentInspectorWorkResource = ref<AgentInspectorWorkResource>(emptyAgentInspectorWorkResource());
  const agentInspectorWorkSourceMessageId = ref<string | null>(null);
  const agentInspectorConfigurationResource = ref<AgentInspectorConfigurationResource>({ status: "idle", configuration: null, draft: null, error: null });
  const agentInspectorRoomMoveResource = ref<AgentInspectorRoomMoveResource>({ status: "idle", move: null, error: null });
  const agentInspectorProviders = ref<DesktopAgentProvider[]>([]);
  const agentInspectorSettingsConflict = ref(false);
  const agentInspectorBackgroundRefresh = createAgentInspectorBackgroundRefresh();
  const agentInspectorDetailRequest = createAgentInspectorDetailRequest();
  const rulesOpen = ref(false);
  const { copied: roomLinkCopied, copy: copyRoomLinkToClipboard } = useCopyIndicator(1400);
  const deliveryRetryCoordinator = createRoomDeliveryRetryCoordinator();
  const deliveryRetryingKeys = deliveryRetryCoordinator.retryingKeys;
  const continuationRepairCoordinator = createRoomDeliveryRetryCoordinator();
  const continuationRepairingKeys = continuationRepairCoordinator.retryingKeys;
  const roomDeliverySkipCoordinator = createRoomDeliveryRetryCoordinator();
  const roomDeliverySkippingKeys = roomDeliverySkipCoordinator.retryingKeys;
  const deliveryRetryNegotiated = ref(false);
  const deliveryRetryAvailable = computed(() => deliveryRetryNegotiated.value && typeof desktopIpc.supervisor?.retryRoomDelivery === "function");
  const boardSelectedTaskId = ref<string | null>(null);
  const boardGovernanceSection = ref<"pending" | null>(null);
  const activityHistoryRequest = ref(0);
  const artifactTimelineTaskFilterId = ref<string | null>(null);
  const storageBusy = ref(false);
  const storageFeedback = ref<{ message: string; error: boolean } | null>(null);
  const githubEventsVisible = ref(readGitHubEventsVisible(props.room.identifier));
  const environmentPanelOpen = ref(readEnvironmentPanelOpen(props.room.identifier));
  const refreshedEnvironmentRepoStatus = ref<RepoStatus | null>(null);
  const supervisorEntries = ref<DesktopSupervisorManifestEntry[]>([]);
  const supervisorEntriesState = ref<SupervisorEntriesResource["state"]>("loading");
  const supervisorEntriesError = ref<string | null>(null);
  const supervisorEntriesHaveLoaded = ref(false);
  const agentRosterState = computed(() => {
    if (supervisorEntriesState.value === "error" || props.sourceStates?.presence.status === "error") return "error";
    if (props.roomLoading || supervisorEntriesState.value === "loading") return "loading";
    return supervisorEntriesState.value;
  });
  const supervisorEntriesUpdatedAt = ref<string | null>(null);
  const supervisorStatus = ref<DesktopSupervisorDaemonStatus | null>(null);
  // Supervisor status and entries refresh state. The refresh functions, the
  // inspector loaders, the room-change watcher, and unmount all read it.
  const supervisorSyncState = {
    supervisorStatusRequestToken: 0,
    supervisorEntriesRefreshRequestId: 0,
    supervisorEntriesMutationVersion: 0,
    supervisorEntriesRefreshQueued: false,
    supervisorEntriesRefreshOwnerActive: true,
    retirementStatusCheckOperationId: null as string | null,
    supervisorStateLastRepairAtMs: null as number | null,
    supervisorStateDaemonGeneration: 0,
    supervisorStateSequence: 0,
  };
  const agentInspectorRoomMoveAvailable = computed(() =>
    Boolean(supervisorStatus.value?.capabilities.agentRoomMove));
  const continuationRepairAvailable = computed(() =>
    Boolean(supervisorStatus.value?.capabilities.providerContinuationRepair
      && typeof desktopIpc.supervisor?.restoreAgentConversation === "function"));
  const roomDeliverySkipAvailable = computed(() =>
    Boolean(supervisorStatus.value?.capabilities.roomDeliverySkip
      && typeof desktopIpc.supervisor?.skipRoomDelivery === "function"));
  const supervisorEntriesResource = computed<SupervisorEntriesResource>(() => {
    if (supervisorEntriesState.value === "error") {
      return {
        state: "error",
        roomIdentifier: props.room.identifier,
        updatedAt: supervisorEntriesUpdatedAt.value,
        data: supervisorEntries.value,
        error: supervisorEntriesError.value || "Supervisor daemon unavailable.",
      };
    }
    return {
      state: supervisorEntriesState.value,
      roomIdentifier: props.room.identifier,
      updatedAt: supervisorEntriesUpdatedAt.value,
      data: supervisorEntries.value,
      error: null,
    } as SupervisorEntriesResource;
  });
  const selectedAgentDetailTarget = computed<AgentInspectorSelection | null>(() => {
    const request = selectedAgentDetailRequest.value;
    if (!request) return null;
    return resolveAgentInspectorSelection(
      supervisorEntriesResource.value,
      request,
      props.room.identifier,
    );
  });
  const roomIdentifierRef = computed(() => props.room.identifier);

  function roomActiveTabStorageKey(roomIdentifier: string): string {
    return `letagents-desktop:room-active-tab:${roomIdentifier}`;
  }

  function readRoomActiveTab(roomIdentifier: string): RoomTabId {
    try {
      const stored = window.localStorage.getItem(roomActiveTabStorageKey(roomIdentifier));
      return isRoomTabId(stored) ? stored : "chat";
    } catch {
      return "chat";
    }
  }

  const supervisorGenerationChangedMessage =
    "Background agent management restarted. Current state was refreshed; review and retry.";
  const supervisorSettingsGenerationChangedMessage =
    "Background agent management restarted. Your draft is preserved; reload the current configuration before saving.";
  return {
    pushActionToast, personActions, roomRef, messagesRef, reasoningSessionsRef, activeTab,
    roomChatView, revealedMessageId, actionPanelOpen, actionPanelSection, addAgentModalOpen,
    selectedAgentDetailRequest, selectedAgentDetailRequestVersion, agentInspectorInitialTab,
    agentInspectorActionState, agentInspectorCompact, agentInspectorRequestState,
    agentInspectorLiveFeed, agentInspectorWorkResource, agentInspectorWorkSourceMessageId,
    agentInspectorConfigurationResource, agentInspectorRoomMoveResource, agentInspectorProviders,
    agentInspectorSettingsConflict, agentInspectorBackgroundRefresh, agentInspectorDetailRequest,
    rulesOpen, roomLinkCopied, copyRoomLinkToClipboard, deliveryRetryCoordinator,
    deliveryRetryingKeys, continuationRepairCoordinator, continuationRepairingKeys,
    roomDeliverySkipCoordinator, roomDeliverySkippingKeys, deliveryRetryNegotiated,
    deliveryRetryAvailable, boardSelectedTaskId, boardGovernanceSection, activityHistoryRequest,
    artifactTimelineTaskFilterId, storageBusy, storageFeedback, githubEventsVisible,
    environmentPanelOpen, refreshedEnvironmentRepoStatus, supervisorEntries,
    supervisorEntriesState, supervisorEntriesError, supervisorEntriesHaveLoaded, agentRosterState,
    supervisorEntriesUpdatedAt, supervisorStatus, supervisorSyncState,
    agentInspectorRoomMoveAvailable, continuationRepairAvailable, roomDeliverySkipAvailable,
    supervisorEntriesResource, selectedAgentDetailTarget, roomIdentifierRef,
    roomActiveTabStorageKey, readRoomActiveTab, supervisorGenerationChangedMessage,
    supervisorSettingsGenerationChangedMessage,
  };
}
