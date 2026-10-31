import type { ChatScrollPosition } from "../../domain/chat-scroll";
import { computed, ref } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentRunResult,
  DesktopAppAgentSettingsStatus,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopChatStorageSettings,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopUpdateStatus,
  DesktopProjectBinding,
  DesktopRoomLatestMessage,
  DesktopRoomSnapshot,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../electron/ipc-types";
import type { RoomEntry } from "../../components/desktop/types";
import { readRepositoryRootBindings } from "../../domain/room-project-context";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "../../components/desktop/setup/types";
import type { SettingsPaneId } from "../../components/desktop/settings/types";
import { recentProjectFoldersFromRooms } from "../useDesktopNewRoomModal";
import { readStoredString } from "../../domain/desktop-storage";
import { readStoredRecentRootRooms } from "../../domain/sidebar-rooms";
import type { SidebarRoomBatchActionId } from "../../domain/sidebar-room-selection";
import { readStoredSidebarRoomOrder } from "../../domain/sidebar-room-order";
import type { AttentionNavigationIntent } from "../../components/desktop/content/room-shell/types";
import type { InboxSection } from "../../components/desktop/content/room-inbox/universal";
import type { DesktopRentalRequest } from "../../../../electron/ipc-types.js";

/** App-wide refs and constants. Created first, before any watcher or composable runs. */
export function useAppState() {
  const loading = ref(false);
  const appInfo = ref<DesktopAppInfo | null>(null);
  const updateStatus = ref<DesktopUpdateStatus | null>(null);
  const repoStatus = ref<RepoStatus | null>(null);
  const workers = ref<WorkerSnapshot[]>([]);
  const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const authStatus = ref<DesktopAuthStatus | null>(null);
  const sessionGeneration = ref(0);
  const authDialogOpen = ref(false);
  const selectedRootRoomStorageKey = "letagents-desktop:selected-root-room";
  const activeEntryStorageKey = "letagents-desktop:active-entry";
  const recentRootRoomsStorageKey = "letagents-desktop:recent-root-rooms";
  const legacyRepositoryRootBindingsStorageKey = "letagents-desktop:repository-root-bindings";
  const readRoomMessagesStorageKey = "letagents-desktop:read-room-message-ids";
  const sidebarWidthStorageKey = "letagents-desktop:sidebar-width";
  const sidebarRoomOrderStorageKey = "letagents-desktop:sidebar-room-order";
  const sidebarMinWidth = 260;
  const sidebarMaxWidth = 440;
  const sidebarDefaultWidth = 296;
  // Sidebar room metadata poll cadence. Since PR #820 this is one light
  // `/account/rooms` request per tick, and `refreshForegroundData` already fires
  // the same work on focus/visibility, so a 15s steady-state interval is plenty —
  // an aggressive 5s cadence was redundant against the foreground-return refresh.
  const SIDEBAR_METADATA_REFRESH_INTERVAL_MS = 15_000;
  const selectedRootRoomIdentifier = ref<string | null>(readStoredString(selectedRootRoomStorageKey));
  const recentRootRooms = ref(readStoredRecentRootRooms(recentRootRoomsStorageKey));
  const newRoomRecentProjectFolders = computed(() => recentProjectFoldersFromRooms(recentRootRooms.value));
  const legacyRepositoryRootBindings = readRepositoryRootBindings(
    window.localStorage,
    legacyRepositoryRootBindingsStorageKey,
    recentRootRooms.value,
  );
  const projectBindings = ref<DesktopProjectBinding[]>([]);
  const windowFocused = ref(document.hasFocus());
  const windowHidden = ref(document.hidden);
  const readRoomMessageIds = ref<Record<string, string>>({});
  const sidebarWidth = ref(readStoredSidebarWidth());
  const sidebarRoomOrder = ref(readStoredSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey));
  const sidebarRevealRequest = ref<{ entryId: string; sequence: number } | null>(null);
  const isSidebarResizing = ref(false);
  const sidebarLatestMessages = ref<Record<string, DesktopRoomLatestMessage>>({});
  const chatScrollPositionsByRoom = ref<Record<string, ChatScrollPosition>>({});
  const loadingChatScrollRoomIdentifiers = ref<Set<string>>(new Set());
  const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
  const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
  // Shared by the metadata refresh, its watcher, and the periodic room-list tick.
  const sidebarMetadataRefresh = { inFlight: false, lastAt: 0 };
  const rentalRequestCount = ref(0);
  const inboxRentals = ref<DesktopRentalRequest[]>([]);
  const inboxRentalError = ref('');
  const messagesUnread = ref(0);
  const openConversationId = ref<string | null>(null);
  const openConversationNonce = ref(0);
  const inboxSection = ref<InboxSection>('needs-you');
  const attentionIntent = ref<AttentionNavigationIntent | null>(null);
  const rentMarketplaceRole = ref<"renter" | "provider">("renter");
  const openAddAgentAfterRepoPick = ref(false);
  const notificationRevealMessageId = ref<string | null>(null);
  const notificationRevealNonce = ref(0);
  const chatStorageSettings = ref<DesktopChatStorageSettings | null>(null);
  const chatStorageAvailable = ref(true);
  const chatStorageBusy = ref(false);
  const chatStorageFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
  const appAgentSettingsStatus = ref<DesktopAppAgentSettingsStatus | null>(null);
  const appAgentActions = ref<DesktopAppAgentActionMetadata[]>([]);
  const appAgentBusy = ref(false);
  const appAgentResult = ref<DesktopAppAgentRunResult | null>(null);
  const appAgentFeedback = ref<{ message: string; state: "error" | "info" | "success" } | null>(null);
  const diagnostics = ref<DiagnosticsSnapshot | null>(null);
  const mcpInstallState = ref<DesktopMcpInstallState | null>(null);
  const selectedMcpTargetIds = ref<DesktopMcpInstallTargetId[]>([]);
  const mcpInstallBusy = ref(false);
  const mcpInstallFeedback = ref<string | null>(null);
  const setupLoadError = ref<string | null>(null);
  const mcpWizardStep = ref<DesktopMcpWizardStep>("choose");
  const firstRunStage = ref<FirstRunWizardStage>("welcome");
  const sidebarFocusRoomConclusionTarget = ref<RoomEntry | null>(null);
  const sidebarFocusRoomConclusionParent = ref<RoomEntry | null>(null);
  const sidebarFocusRoomConclusionReturnFocusId = ref<string | null>(null);
  const sidebarFocusRoomConclusionError = ref<string | null>(null);
  const sidebarFocusRoomConclusionPendingToast = ref<{
    message: string;
    state: "error" | "success";
  } | null>(null);
  const sidebarSelectionActive = ref(false);
  const sidebarSelectedEntryIds = ref<string[]>([]);
  const sidebarBatchActionBusy = ref<SidebarRoomBatchActionId | null>(null);
  const sidebarBatchDialogAction = ref<"conclude" | "hide" | null>(null);
  const sidebarBatchDialogTargets = ref<RoomEntry[]>([]);
  const sidebarBatchDialogError = ref<string | null>(null);
  const sidebarBatchPendingToast = ref<{
    message: string;
    state: "error" | "success";
  } | null>(null);

  const requestedSettingsPane = ref<SettingsPaneId | null>(null);

  function readStoredSidebarWidth(): number {
    const parsed = Number(readStoredString(sidebarWidthStorageKey));
    return clampSidebarWidth(Number.isFinite(parsed) ? parsed : sidebarDefaultWidth);
  }

  function clampSidebarWidth(value: number): number {
    return Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, Math.round(value)));
  }
  return {
    loading, appInfo, updateStatus, repoStatus, workers, rootRoomSnapshot, selectedSnapshot,
    authStatus, sessionGeneration, authDialogOpen, selectedRootRoomStorageKey,
    activeEntryStorageKey, recentRootRoomsStorageKey, legacyRepositoryRootBindingsStorageKey,
    readRoomMessagesStorageKey, sidebarWidthStorageKey, sidebarRoomOrderStorageKey,
    sidebarMinWidth, sidebarMaxWidth, sidebarDefaultWidth, SIDEBAR_METADATA_REFRESH_INTERVAL_MS,
    selectedRootRoomIdentifier, recentRootRooms, newRoomRecentProjectFolders,
    legacyRepositoryRootBindings, projectBindings, windowFocused, windowHidden, readRoomMessageIds,
    sidebarWidth, sidebarRoomOrder, sidebarRevealRequest, isSidebarResizing, sidebarLatestMessages,
    chatScrollPositionsByRoom, loadingChatScrollRoomIdentifiers, accountRooms,
    settingsAccountRooms, sidebarMetadataRefresh, rentalRequestCount, inboxRentals,
    inboxRentalError, messagesUnread, openConversationId, openConversationNonce, inboxSection,
    attentionIntent, rentMarketplaceRole, openAddAgentAfterRepoPick, notificationRevealMessageId,
    notificationRevealNonce, chatStorageSettings, chatStorageAvailable, chatStorageBusy,
    chatStorageFeedback, appAgentSettingsStatus, appAgentActions, appAgentBusy, appAgentResult,
    appAgentFeedback, diagnostics, mcpInstallState, selectedMcpTargetIds, mcpInstallBusy,
    mcpInstallFeedback, setupLoadError, mcpWizardStep, firstRunStage,
    sidebarFocusRoomConclusionTarget, sidebarFocusRoomConclusionParent,
    sidebarFocusRoomConclusionReturnFocusId, sidebarFocusRoomConclusionError,
    sidebarFocusRoomConclusionPendingToast, sidebarSelectionActive, sidebarSelectedEntryIds,
    sidebarBatchActionBusy, sidebarBatchDialogAction, sidebarBatchDialogTargets,
    sidebarBatchDialogError, sidebarBatchPendingToast, requestedSettingsPane,
    readStoredSidebarWidth, clampSidebarWidth,
  };
}
