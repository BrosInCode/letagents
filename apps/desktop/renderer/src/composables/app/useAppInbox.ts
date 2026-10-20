import { computed, watch } from "vue";
import type { PersonTarget } from "../../domain/person-target";
import { openConversationWithPerson } from "../../domain/open-conversation-with-person";
import { inboxRoomOpenReporter, needsYouEntry, openInboxRoom } from "../../domain/desktop-navigation";
import { safeUserVisibleErrorDetail } from "../../domain/user-visible-error";
import { findSidebarRoomEntryByIdentifier } from "../../domain/sidebar-rooms";
import type { AttentionNavigationIntent } from "../../components/desktop/content/room-shell/types";
import { refreshMessageReminders } from "../useMessageReminders";
import { useNeedsYou, useNeedsYouRoomActivity } from "../useNeedsYou";
import { useNeedsYouSignal } from "../useNeedsYouSignal";
import { useAgentAttention } from "../useAgentAttention";
import { useInboxRoomFilter } from "../useInboxRoomFilter";
import { desktopIpc } from "../../ipc/index.js";
import { roomNotificationPreferences } from "../useRoomNotificationPreferences";
import type { AppContextOf } from "./context";

/** Inbox, Needs you, and private message navigation. */
export function useAppInboxActions(context: unknown) {
  const app = context as AppContextOf<
      "useAppArchivedRooms"
    | "useAppInboxState"
    | "useAppNavigation"
    | "useAppRentalActions"
    | "useAppRoomContext"
    | "useAppState"
  >;
  const {
    attentionIntent, authStatus, inboxSection, notificationRevealMessageId, openConversationId,
    openConversationNonce,
  } = app;
  function openMessages(id?: string) { openConversationId.value = typeof id === 'string' ? id : null; openConversationNonce.value += 1; app.activeEntry.value = { id: 'messages', type: 'messages', title: 'Messages', description: 'Private conversations', sectionLabel: 'LetAgents' }; }
  /** Open the private conversation with a room participant. Create it if it does not exist yet. */
  async function openMessagesWithPerson(target: PersonTarget): Promise<void> {
    const viewerLogin = authStatus.value?.authenticated ? authStatus.value.account?.login ?? null : null;
    const result = await openConversationWithPerson(target, viewerLogin, desktopIpc.conversations);
    if (result.status === "self") {
      app.pushActionToast("That is you.", "info");
      return;
    }
    if (result.status === "not_found") {
      app.pushActionToast(`${target.displayName} is not available for messages.`, "info");
      return;
    }
    if (result.status === "ambiguous") {
      app.pushActionToast("More than one account uses this login. Open Messages and search for the person.", "info");
      return;
    }
    if (result.status === "failed") {
      app.pushActionToast(result.message, "error");
      return;
    }
    openMessages(result.conversationId);
  }
  async function openNeedsYouRoom(intent: AttentionNavigationIntent) {
    attentionIntent.value = null;
    notificationRevealMessageId.value = null;
    try {
      await openInboxRoom(intent.roomIdentifier, {
        findEntry: (room) => findSidebarRoomEntryByIdentifier(app.projectEntries.value, room),
        selectEntry: (entry) => {
          if (app.activeEntry.value.id !== entry.id) app.inboxRoomOpens.opened(entry.id);
          app.selectSidebarEntry(entry);
        },
        openBySnapshot: app.openRoomFromAppAgent,
      });
      attentionIntent.value = intent;
    } catch (error) { app.needsYouError.value = String(error); }
  }
  function openNeedsYou(room?: string) { app.openInboxRooms(room); inboxSection.value = 'needs-you'; app.activeEntry.value = needsYouEntry; void refreshNeedsYou(); }
  async function refreshNeedsYou() { await Promise.all([app.loadNeedsYou(app.activeEntry.value.type === 'inbox'), app.refreshRentalRequestCount(), app.activeEntry.value.type === 'inbox' ? refreshMessageReminders() : undefined]); await app.refreshAgentApprovals(); }
  return {
    openMessages, openMessagesWithPerson, openNeedsYouRoom, openNeedsYou, refreshNeedsYou,
  };
}

/** Needs you data, agent attention, and the Inbox room filter. */
export function useAppInboxState(context: unknown) {
  const app = context as AppContextOf<"useAppAccountActivityFeed" | "useAppRoomContext" | "useAppState">;
  const {
    accountActivity, authStatus, rentalRequestCount,
  } = app;
  const { data: needsYouData, loading: needsYouLoading, error: needsYouError, count: humanRequestCount, refresh: loadNeedsYou, refreshRoom: refreshNeedsYouRoom, reset: resetNeedsYou, mergeThreads: mergeInboxThreads } = useNeedsYou();
  Object.assign(app, { needsYouError, loadNeedsYou, resetNeedsYou });
  useNeedsYouRoomActivity(accountActivity.state, refreshNeedsYouRoom);
  const { items: agentAttentionItems, refreshApprovals: refreshAgentApprovals, approvalsReady } = useAgentAttention(needsYouData);
  Object.assign(app, { refreshAgentApprovals });
  const needsYouCount = computed(() => humanRequestCount.value + rentalRequestCount.value + agentAttentionItems.value.length);
  // A room opened from the Inbox loads in place; if that load fails, say so.
  const inboxRoomOpens = inboxRoomOpenReporter((error) => app.pushActionToast(
    `Couldn't load this room. ${safeUserVisibleErrorDetail(error, "Try again from the sidebar.")}`, "error"));
  Object.assign(app, { inboxRoomOpens });
  const inboxStorageKey = computed(() => String(authStatus.value?.account?.id ?? 'local'));
  const { rooms: inboxRooms, open: openInboxRooms, choose: chooseInboxRooms, reload: reloadInboxRooms, prune: pruneInboxRooms } = useInboxRoomFilter(() => inboxStorageKey.value);
  Object.assign(app, { inboxRooms, openInboxRooms });
  watch(needsYouData, pruneInboxRooms);
  return {
    needsYouData, needsYouLoading, needsYouError, humanRequestCount, loadNeedsYou,
    refreshNeedsYouRoom, resetNeedsYou, mergeInboxThreads, agentAttentionItems,
    refreshAgentApprovals, approvalsReady, needsYouCount, inboxRoomOpens, inboxStorageKey,
    inboxRooms, openInboxRooms, chooseInboxRooms, reloadInboxRooms, pruneInboxRooms,
  };
}

/** Per-room attention signals and room notification preferences. */
export function useAppRoomAttention(context: unknown) {
  const app = context as AppContextOf<"useAppInboxState" | "useAppNavigation" | "useAppState">;
  const {
    activeEntry, agentAttentionItems, approvalsReady, authStatus, inboxRooms, inboxSection,
    inboxStorageKey, needsYouData, selectedNeedsAccess, selectedRoomIdentifier, selectedRoomInfo,
  } = app;
  const roomAttention = useNeedsYouSignal(needsYouData, agentAttentionItems, {
    ready: () => approvalsReady.value,
    account: () => inboxStorageKey.value,
    activeRoom: () => activeEntry.value.type === "room" && !selectedNeedsAccess.value ? selectedRoomInfo.value.identifier : null,
    inboxRooms: () => activeEntry.value.type === "inbox" && inboxSection.value === "needs-you" ? inboxRooms.value : null,
  });

  watch(() => authStatus.value?.authenticated ? authStatus.value.account ?? null : null, (account) => {
    roomNotificationPreferences.setViewer(account ? { id: account.id, login: account.login } : null);
    void roomNotificationPreferences.refreshAll();
    if (selectedRoomIdentifier.value) void roomNotificationPreferences.refresh(selectedRoomIdentifier.value);
  }, { immediate: true, flush: "sync" });
  return {
    roomAttention,
  };
}
