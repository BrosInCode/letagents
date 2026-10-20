import { onBeforeUnmount, onMounted } from "vue";
import { ACCOUNT_ROOMS_REFRESH_WHILE_STREAMING_MS } from "../../domain/account-activity";
import { desktopIpc } from "../../ipc/index.js";
import type { AppContextOf } from "./context";

/** Mount and unmount: IPC subscriptions, intervals, window listeners, and initial loads. */
export function useAppLifecycle(context: unknown) {
  const app = context as AppContextOf<
      "useAppAccountActivityFeed"
    | "useAppArchivedRooms"
    | "useAppAuthFlow"
    | "useAppInboxActions"
    | "useAppProjectRepo"
    | "useAppRentalActions"
    | "useAppRoomData"
    | "useAppSessionActions"
    | "useAppSettingsActions"
    | "useAppSetupOnboarding"
    | "useAppSidebarEntries"
    | "useAppSidebarLayout"
    | "useAppSidebarMessages"
    | "useAppState"
  >;
  const {
    SIDEBAR_METADATA_REFRESH_INTERVAL_MS, accountActivity, clearAuthPollTimer,
    clearLiveMetadataRefreshInterval, clearLiveMetadataRefreshTimer, handleDesktopRoomStreamEvent,
    handleNotificationActivation, handleRepoStatusChanged, handleVisibilityChange,
    handleWindowBlur, handleWindowFocus, initializeProjectBindings,
    leaveArchivedSelectedRoomFromSettingsList, loadAppAgentActions, loadAppAgentSettingsStatus,
    loadChatStorageSettings, loadFirstRunSetup, openSettingsSurface, openUpdatesSurface,
    refreshDesktopUpdateStatus, refreshNeedsYou, refreshRentalRequestCount,
    refreshSidebarLatestMessages, refreshSidebarRoomMetadata, refreshUnreadCounts, roomHistoryMode,
    sidebarMetadataRefresh, sidebarRoomIdentifiers, updateStatus,
  } = app;
  let needsYouInterval: number | null = null;

  let unsubscribeRoomStream: (() => void) | null = null;
  let unsubscribeOpenSettings: (() => void) | null = null;
  let unsubscribeOpenUpdates: (() => void) | null = null;
  let unsubscribeUpdateStatus: (() => void) | null = null;
  let unsubscribeNotificationReceived: (() => void) | null = null;
  let unsubscribeNotificationActivation: (() => void) | null = null;
  let unsubscribeRepoStatusChanged: (() => void) | null = null;
  let accountRoomsRefreshInterval: number | null = null;

  onMounted(() => {
    void refreshNeedsYou();
    needsYouInterval = window.setInterval(() => { if (!document.hidden) void refreshNeedsYou(); }, 60_000);
    unsubscribeRoomStream = desktopIpc.room?.onStreamEvent?.(handleDesktopRoomStreamEvent) || null;
    unsubscribeOpenSettings = desktopIpc.ui?.onOpenSettings(openSettingsSurface) || null;
    unsubscribeOpenUpdates = desktopIpc.ui?.onOpenUpdates?.(openUpdatesSurface) || null;
    void desktopIpc.maintenance?.getStatus().then(status => { if (status.held) openUpdatesSurface(); }).catch(() => undefined);
    unsubscribeUpdateStatus = desktopIpc.updates?.onStatusChanged?.((status) => {
      updateStatus.value = status;
    }) || null;
    unsubscribeNotificationReceived = desktopIpc.notifications?.onReceived?.(() => {
      void refreshSidebarRoomMetadata();
    }) || null;
    unsubscribeNotificationActivation = desktopIpc.notifications?.onActivated?.((target) => {
      void handleNotificationActivation(target);
    }) || null;
    void desktopIpc.notifications?.takePendingActivation?.().then((target) => {
      if (target) void handleNotificationActivation(target);
    });
    unsubscribeRepoStatusChanged = desktopIpc.repos?.onStatusChanged?.(handleRepoStatusChanged) || null;
    // Keep the fallback room-list refresh alive while hidden for badges.
    // A connected account activity stream still avoids routine room-list polling.
    accountRoomsRefreshInterval = window.setInterval(() => {
      void refreshUnreadCounts();
      // Retry leaving an archived active room: the room list keeps its identity
      // on an unchanged poll, so its watcher does not fire again by itself.
      void leaveArchivedSelectedRoomFromSettingsList();
      // While the activity stream is open it pushes messages and work as they
      // happen; the room list is then refreshed only rarely, to pick up rooms
      // that were renamed or created elsewhere.
      if (accountActivity.connected.value
        && Date.now() - sidebarMetadataRefresh.lastAt < ACCOUNT_ROOMS_REFRESH_WHILE_STREAMING_MS) {
        // Local workers do not appear in the cloud activity stream.
        if (sidebarRoomIdentifiers().some((id) => roomHistoryMode(id) === "local")) void refreshSidebarLatestMessages();
        return;
      }
      void refreshSidebarRoomMetadata();
    }, SIDEBAR_METADATA_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void loadChatStorageSettings();
    void loadAppAgentSettingsStatus();
    void loadAppAgentActions();
    void loadFirstRunSetup(initializeProjectBindings());
    void refreshRentalRequestCount();
    void refreshDesktopUpdateStatus();
  });

  onBeforeUnmount(() => {
    if (needsYouInterval) window.clearInterval(needsYouInterval);
    clearAuthPollTimer();
    clearLiveMetadataRefreshTimer();
    clearLiveMetadataRefreshInterval();
    if (accountRoomsRefreshInterval) {
      window.clearInterval(accountRoomsRefreshInterval);
      accountRoomsRefreshInterval = null;
    }
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("blur", handleWindowBlur);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    unsubscribeRoomStream?.();
    unsubscribeRoomStream = null;
    unsubscribeOpenSettings?.();
    unsubscribeOpenSettings = null;
    unsubscribeOpenUpdates?.();
    unsubscribeOpenUpdates = null;
    unsubscribeUpdateStatus?.();
    unsubscribeUpdateStatus = null;
    unsubscribeNotificationReceived?.();
    unsubscribeNotificationReceived = null;
    unsubscribeNotificationActivation?.();
    unsubscribeNotificationActivation = null;
    unsubscribeRepoStatusChanged?.();
    unsubscribeRepoStatusChanged = null;
    void desktopIpc.repos?.stopStatusWatch?.();
    void desktopIpc.room?.stopStream?.();
  });
}
