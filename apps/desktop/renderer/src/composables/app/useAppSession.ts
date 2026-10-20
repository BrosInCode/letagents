import { roomUnread } from "../roomUnread";
import { invalidateRoomWakeRules } from "../useRoomWakeRules";
import { invalidateRoomMessageLinkPreviews, setMessageLinkPreviewViewer } from "../useRoomMessageLinkPreviews";
import { invalidateRoomMessagePins, setMessagePinViewer } from "../useRoomMessagePins";
import { receiveRoomTyping, setTypingAccount } from "../useRoomTyping";
import { invalidateRoomMessageReactions, setMessageReactionViewer } from "../useRoomMessageReactions";
import { computed, watch } from "vue";
import type { DesktopNotificationTarget, DesktopRoomStreamEvent } from "../../../../electron/ipc-types";
import { clearDesktopMessageDrafts, setDesktopMessageDraftAccount } from "../../domain/desktop-message-drafts";
import { clearDesktopMessageOutbox } from "../../domain/message-outbox";
import { useDesktopAuthFlow } from "../useDesktopAuthFlow";
import { invalidateRentalProviderDashboard } from "../useRentalProviderEvents";
import { setReminderAccount, refreshMessageReminders } from "../useMessageReminders";
import { resetHostApprovals } from "../../components/desktop/content/room-chat/host-approvals";
import { roomNotificationPreferences } from "../useRoomNotificationPreferences";
import type { AppContextOf } from "./context";

/** Window focus and visibility, the desktop session, sign-in entry points, and notification activation. */
export function useAppSessionActions(context: unknown) {
  const app = context as AppContextOf<
      "useAppArchivedRooms"
    | "useAppAuthFlow"
    | "useAppInboxActions"
    | "useAppInboxState"
    | "useAppNavigation"
    | "useAppProjectRepo"
    | "useAppRentalActions"
    | "useAppRoomData"
    | "useAppSidebarMessages"
    | "useAppState"
  >;
  const {
    accountRooms, attentionIntent, authDialogOpen, authStatus, firstRunStage, inboxRentalError,
    inboxRentals, inboxSection, loading, notificationRevealMessageId, notificationRevealNonce,
    rentalRequestCount, repoStatus, rootRoomSnapshot, selectedSnapshot, settingsAccountRooms,
    sidebarLatestMessages, windowFocused, windowHidden, workers,
  } = app;
  function refreshForegroundData(): void {
    if (app.authSessionLocked.value) return;
    if (!authStatus.value?.authenticated) {
      // A locked OS credential store at startup is retryable on foreground return.
      if (!loading.value && !app.authBusy.value) void app.refresh();
      return;
    }
    if (app.activeEntry.value.type === "inbox") void refreshMessageReminders();
    // The main-process Git watcher retains invalidations while hidden and drains
    // them on BrowserWindow focus/show. Avoid racing it with a second full status
    // reconstruction from the renderer.
    void app.refreshProjectBindings();
    void app.refreshSidebarRoomMetadata();
    // Poll-only metadata catch-up: the periodic tick early-returns while hidden,
    // so refresh once on foreground return. Metadata-only, NOT the full snapshot —
    // SSE kept running while hidden, so event-fed sections are already current.
    void app.refreshSelectedRoomLiveMetadata().catch(() => undefined);
    void app.refreshRentalRequestCount();
  }

  function handleVisibilityChange(): void {
    windowHidden.value = document.hidden;
    windowFocused.value = document.hasFocus();
    app.markActiveRoomRead();
    if (document.visibilityState !== "visible") return;
    refreshForegroundData();
  }

  function handleWindowFocus(): void {
    windowFocused.value = true;
    windowHidden.value = document.hidden;
    app.markActiveRoomRead();
    refreshForegroundData();
    void roomNotificationPreferences.refreshAll();
    if (app.selectedRoomIdentifier.value) void roomNotificationPreferences.refresh(app.selectedRoomIdentifier.value);
  }

  function handleWindowBlur(): void {
    windowFocused.value = false;
  }

  function handleDesktopRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    if (event.type === "typing") { receiveRoomTyping(event.roomIdentifier, event.signal); return; }
    if (event.type === "open" || event.type === "error" || event.type === "session_disconnect") receiveRoomTyping(event.roomIdentifier);
    if (["open", "github_event", "artifact_update"].includes(event.type)) invalidateRoomMessageLinkPreviews(event.roomIdentifier);
    if (event.type === "resource_invalidation") {
      if (event.resource === "wake_rules") invalidateRoomWakeRules(event.roomIdentifier);
      else if (event.resource === "message_pins") invalidateRoomMessagePins(event.roomIdentifier);
      else if (event.resource === "message_reactions") invalidateRoomMessageReactions(event.roomIdentifier);
      else app.invalidateSelectedRoomAgentWork(event.roomIdentifier);
      return;
    }
    // A stream that just (re)connected may have missed a reaction or pin change.
    if (event.type === "open") { invalidateRoomMessageReactions(event.roomIdentifier); invalidateRoomMessagePins(event.roomIdentifier); }
    app.handleRoomStreamEvent(event);
  }

  function startSignedOutAuthFlow(): Promise<void> {
    return app.startAuthFlow(null);
  }

  function clearDesktopSessionState(): void {
    invalidateRentalProviderDashboard();
    attentionIntent.value = null;
    inboxRentals.value = []; inboxRentalError.value = ''; app.inboxRooms.value = []; inboxSection.value = 'needs-you';
    app.resetNeedsYou();
    resetHostApprovals();
    clearDesktopMessageOutbox();
    clearDesktopMessageDrafts();
    app.invalidateSession();
    app.clearLiveMetadataRefreshTimer();
    app.clearLiveMetadataRefreshInterval();
    app.clearSelectedRoomAgentWork();
    rootRoomSnapshot.value = null;
    selectedSnapshot.value = null;
    workers.value = [];
    accountRooms.value = [];
    settingsAccountRooms.value = [];
    sidebarLatestMessages.value = {};
    rentalRequestCount.value = 0;
    repoStatus.value = null;
    authDialogOpen.value = false;
    void app.syncSelectedRoomStream(null).catch(() => undefined);
    void app.restartRepoStatusWatch(null);
  }

  async function openAccountAuthFlow(): Promise<void> {
    authDialogOpen.value = true;
    if (authStatus.value?.pendingDeviceAuth) {
      app.scheduleAuthPoll();
      return;
    }
    await app.startAuthFlow();
  }

  async function startFirstRunRoomAuth(): Promise<void> {
    firstRunStage.value = "github";
    await app.startAuthFlow();
  }

  async function handleNotificationActivation(target: DesktopNotificationTarget): Promise<void> {
    try {
      if (target.conversationId) { app.openMessages(target.conversationId); return; }
      if (!target.roomIdentifier) return;
      await app.openRoomFromAppAgent(target.roomIdentifier);
      notificationRevealMessageId.value = target.messageId;
      notificationRevealNonce.value += 1;
    } catch (error) {
      console.warn("Could not open the room for this notification.", error);
    }
  }
  return {
    refreshForegroundData, handleVisibilityChange, handleWindowFocus, handleWindowBlur,
    handleDesktopRoomStreamEvent, startSignedOutAuthFlow, clearDesktopSessionState,
    openAccountAuthFlow, startFirstRunRoomAuth, handleNotificationActivation,
  };
}

/** Point account-scoped stores at the signed-in account. */
export function useAppAccountScope(context: unknown) {
  const app = context as AppContextOf<"useAppState">;
  const {
    authStatus,
  } = app;
  watch(() => authStatus.value?.authenticated ? authStatus.value.account?.id ?? null : null,
    setDesktopMessageDraftAccount, { immediate: true, flush: "sync" });
  watch(() => authStatus.value?.authenticated ? authStatus.value.account ?? null : null,
    (account) => { setMessageReactionViewer(account); setMessagePinViewer(account); setMessageLinkPreviewViewer(account); roomUnread.account.value = account?.id ?? null; }, { immediate: true, flush: "sync" });
  watch(() => authStatus.value?.authenticated ? authStatus.value.account?.id ?? null : null,
    (account) => { setTypingAccount(account); setReminderAccount(account); }, { immediate: true, flush: "sync" });
}

/** The GitHub device sign-in flow. */
export function useAppAuthFlow(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomData"
    | "useAppSessionActions"
    | "useAppState"
  >;
  const {
    authStatus, clearDesktopSessionState, firstRunStage, getAuthRoomIdentifier, mcpInstallState,
    refresh,
  } = app;
  const {
    authBusy,
    authFeedback,
    authSessionLocked,
    cancelAuthFlow,
    clearAuthPollTimer,
    openVerification,
    pollAuthFlow,
    scheduleAuthPoll,
    signOut,
    startAuthFlow,
  } = useDesktopAuthFlow({
    authStatus,
    getRoomIdentifier: () => getAuthRoomIdentifier(),
    isFirstRunGate: () => Boolean(mcpInstallState.value && !mcpInstallState.value.completed),
    onFirstRunAuthorized: async () => {
      firstRunStage.value = "room";
    },
    onAuthorized: () => refresh(),
    onSigningOut: clearDesktopSessionState,
    onSignedOut: async () => undefined,
  });
  Object.assign(app, { authBusy, authSessionLocked, scheduleAuthPoll, startAuthFlow });
  return {
    authBusy, authFeedback, authSessionLocked, cancelAuthFlow, clearAuthPollTimer,
    openVerification, pollAuthFlow, scheduleAuthPoll, signOut, startAuthFlow,
  };
}

/** Reset account-scoped inbox state when the account changes. */
export function useAppAccountSwitch(context: unknown) {
  const app = context as AppContextOf<
      "useAppAuthFlow"
    | "useAppInboxActions"
    | "useAppInboxState"
    | "useAppState"
  >;
  const {
    authSessionLocked, authStatus, inboxRentalError, inboxRentals, inboxSection, refreshNeedsYou,
    reloadInboxRooms, rentalRequestCount, resetNeedsYou,
  } = app;
  watch(() => authStatus.value?.account?.id ?? null, (next, previous) => {
    if (next !== previous) { invalidateRentalProviderDashboard(); inboxRentals.value = []; inboxRentalError.value = ''; rentalRequestCount.value = 0; reloadInboxRooms(); inboxSection.value = 'needs-you'; clearDesktopMessageOutbox(); resetNeedsYou(); resetHostApprovals(); if (next) void refreshNeedsYou(); }
  }, { flush: "sync" });

  const showSignedOutGate = computed(() => (
    authSessionLocked.value || !authStatus.value?.authenticated
  ));
  return {
    showSignedOutGate,
  };
}

/** Device sign-in polling and the account dialog. */
export function useAppAuthWatchers(context: unknown) {
  const app = context as AppContextOf<"useAppAuthFlow" | "useAppState">;
  const {
    authDialogOpen, authStatus, clearAuthPollTimer, scheduleAuthPoll,
  } = app;
  watch(
    () => authStatus.value?.pendingDeviceAuth?.requestId,
    (requestId) => {
      if (requestId) {
        scheduleAuthPoll();
        return;
      }
      clearAuthPollTimer();
    }
  );

  watch(
    () => authStatus.value?.authenticated,
    (authenticated) => {
      if (authenticated) authDialogOpen.value = false;
    },
  );
}
