import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
} from "vue";
import type {
  DesktopAgentPresence,
  DesktopGitHubEventsPage,
  DesktopReasoningSession,
  DesktopRoomInfo,
  DesktopRoomThreadInboxPage,
  DesktopSnapshotSourceStates,
  DesktopTaskSummary,
} from "../../../../../../electron/ipc-types";
import {
  loadRentalProviderDashboard,
  useRentalProviderEvents,
} from "../../../../composables/useRentalProviderEvents";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  buildDesktopInboxItems,
  deriveInboxDegradation,
  desktopInboxItemFingerprint,
  type DesktopInboxFilter,
  type DesktopInboxItem,
} from "../room-inbox/items";
import type { RoomTabId } from "./types";

export function useDesktopRoomInbox(options: {
  room: Readonly<Ref<DesktopRoomInfo>>;
  namespace: Readonly<Ref<string>>;
  activeTab: Ref<RoomTabId>;
  tasks: Readonly<Ref<DesktopTaskSummary[]>>;
  githubEvents: Readonly<Ref<DesktopGitHubEventsPage | null>>;
  reasoningSessions: Readonly<Ref<DesktopReasoningSession[]>>;
  presence: Readonly<Ref<DesktopAgentPresence[]>>;
  sourceStates: Readonly<Ref<DesktopSnapshotSourceStates | null>>;
  fallbackRepository: Readonly<Ref<string | null>>;
  openThread(rootMessageId: string): void | Promise<void>;
  openBoardTask(taskId: string): void;
  openGitHubEvent(eventId: string): void;
  refreshRoom(): void;
}) {
  const inboxFilter = ref<DesktopInboxFilter>("actionable");
  const threadInboxPage = ref<DesktopRoomThreadInboxPage | null>(null);
  const inboxLoading = ref(false);
  const inboxLoadingOlder = ref(false);
  const inboxError = ref<string | null>(null);
  const inboxLoadedKey = ref<string | null>(null);
  const inboxDismissals = ref<Record<string, string>>({});
  const lastClearedInboxItem = ref<DesktopInboxItem | null>(null);
  const inboxSeenFingerprints = ref<string[]>([]);
  const inboxUnseenCount = ref(0);
  const inboxSeenInitialized = ref(false);
  const rentalRequests = ref<Awaited<ReturnType<typeof loadRentalProviderDashboard>>["pendingRequests"]>([]);
  const rentalRequestsUnavailable = ref(false);
  let inboxRefreshTimer: number | null = null;
  let inboxUndoTimer: number | null = null;
  let inboxReloadAfterCurrentLoad = false;
  let inboxThreadBaselinePending = false;

  const rawInboxItems = computed(() =>
    buildDesktopInboxItems({
      filter: inboxFilter.value,
      threadPage: threadInboxPage.value,
      tasks: options.tasks.value,
      githubEvents: options.githubEvents.value?.events || [],
      reasoningSessions: options.reasoningSessions.value,
      presence: options.presence.value,
      rentalRequests: rentalRequests.value,
      fallbackRepository: options.fallbackRepository.value,
    })
  );
  const inboxItems = computed(() =>
    rawInboxItems.value.filter((item) => !isInboxItemDismissed(item))
  );
  const inboxActionableCount = computed(() =>
    inboxItems.value.filter((item) => item.actionable).length
  );
  const inboxActionableFingerprints = computed(() =>
    inboxItems.value
      .filter((item) => item.actionable)
      .map(desktopInboxItemFingerprint)
  );
  const inboxHasMore = computed(() => Boolean(threadInboxPage.value?.hasMore));
  const inboxDegradation = computed(() => {
    const snapshotDegradation = deriveInboxDegradation(options.sourceStates.value);
    return rentalRequestsUnavailable.value
      ? { ...snapshotDegradation, sources: [...snapshotDegradation.sources, "Rental requests"] }
      : snapshotDegradation;
  });

  watch(options.namespace, (namespace) => {
    inboxDismissals.value = readInboxDismissals(namespace);
    clearInboxUndoState();
    const hasSeenState = hydrateInboxIndicatorState(namespace);
    resetInboxState();
    inboxThreadBaselinePending = !hasSeenState;
    if (inboxThreadBaselinePending) acknowledgeInboxItems();
    void loadInboxThreads({ baselineIndicator: inboxThreadBaselinePending }).catch(() => undefined);
  }, { immediate: true });

  watch(options.activeTab, (tab) => {
    if (tab !== "inbox") return;
    if (inboxLoadedKey.value !== currentInboxLoadKey() && !inboxLoading.value) {
      void loadInboxThreads().catch(() => undefined);
    }
    void loadRentalRequests();
    acknowledgeInboxItems();
  }, { flush: "sync" });

  watch(inboxFilter, () => {
    resetInboxState();
    void loadInboxThreads({ baselineIndicator: !inboxSeenInitialized.value }).catch(() => undefined);
  });

  watch(inboxActionableFingerprints, (fingerprints) => {
    if (options.activeTab.value === "inbox") {
      acknowledgeInboxItems(fingerprints);
      return;
    }
    if (!inboxSeenInitialized.value) {
      inboxUnseenCount.value = 0;
      return;
    }
    const seen = new Set(inboxSeenFingerprints.value);
    inboxUnseenCount.value = fingerprints.filter((fingerprint) => !seen.has(fingerprint)).length;
  }, { immediate: true });

  onMounted(() => void loadRentalRequests());
  onBeforeUnmount(() => {
    if (inboxRefreshTimer !== null) {
      window.clearTimeout(inboxRefreshTimer);
      inboxRefreshTimer = null;
    }
    if (inboxUndoTimer !== null) {
      window.clearTimeout(inboxUndoTimer);
      inboxUndoTimer = null;
    }
  });
  useRentalProviderEvents(() => void loadRentalRequests());

  function currentInboxLoadKey(): string {
    return `${options.namespace.value}:${inboxFilter.value}`;
  }

  function resetInboxIndicatorState(): void {
    inboxSeenFingerprints.value = [];
    inboxUnseenCount.value = 0;
    inboxSeenInitialized.value = false;
  }

  function acknowledgeInboxItems(fingerprints = inboxActionableFingerprints.value): void {
    inboxSeenFingerprints.value = [...new Set(fingerprints)];
    inboxUnseenCount.value = 0;
    inboxSeenInitialized.value = true;
    writeInboxSeenFingerprints(options.namespace.value, inboxSeenFingerprints.value);
  }

  function hydrateInboxIndicatorState(namespace: string): boolean {
    const fingerprints = readInboxSeenFingerprints(namespace);
    if (fingerprints === null) {
      resetInboxIndicatorState();
      return false;
    }
    inboxSeenFingerprints.value = fingerprints;
    inboxUnseenCount.value = 0;
    inboxSeenInitialized.value = true;
    return true;
  }

  function resetInboxState(): void {
    threadInboxPage.value = null;
    inboxLoading.value = false;
    inboxLoadingOlder.value = false;
    inboxError.value = null;
    inboxLoadedKey.value = null;
    inboxReloadAfterCurrentLoad = false;
    if (inboxRefreshTimer !== null) {
      window.clearTimeout(inboxRefreshTimer);
      inboxRefreshTimer = null;
    }
  }

  async function loadInboxThreads(loadOptions: { append?: boolean; baselineIndicator?: boolean } = {}): Promise<void> {
    const roomApi = desktopIpc.room;
    const requestKey = currentInboxLoadKey();
    const append = Boolean(loadOptions.append);
    const shouldBaselineIndicator = !append && (loadOptions.baselineIndicator || inboxThreadBaselinePending);
    if (!roomApi?.getThreads) {
      threadInboxPage.value = { threads: [], hasMore: false, unreadThreadCount: 0 };
      inboxLoadedKey.value = requestKey;
      if (shouldBaselineIndicator) {
        acknowledgeInboxItems();
        inboxThreadBaselinePending = false;
      }
      return;
    }
    if (append) {
      if (inboxLoadingOlder.value || !threadInboxPage.value?.hasMore) return;
    } else if (inboxLoading.value) {
      inboxReloadAfterCurrentLoad = true;
      return;
    }

    const before = append
      ? threadInboxPage.value?.threads.at(-1)?.summary.latestReply?.id || null
      : null;
    if (append && !before) return;
    if (append) inboxLoadingOlder.value = true;
    else inboxLoading.value = true;
    inboxError.value = null;

    try {
      const page = await roomApi.getThreads(
        options.room.value.identifier,
        inboxFilter.value === "actionable" ? "unread" : "all",
        before,
        75,
      );
      if (currentInboxLoadKey() !== requestKey) return;
      threadInboxPage.value = append && threadInboxPage.value
        ? mergeThreadInboxPages(threadInboxPage.value, page)
        : page;
      inboxLoadedKey.value = requestKey;
      if (shouldBaselineIndicator) {
        acknowledgeInboxItems();
        inboxThreadBaselinePending = false;
      }
    } catch (error) {
      if (currentInboxLoadKey() === requestKey) {
        inboxError.value = error instanceof Error ? error.message : "Inbox could not be loaded.";
      }
    } finally {
      const shouldReload = !append && inboxReloadAfterCurrentLoad && currentInboxLoadKey() === requestKey;
      if (currentInboxLoadKey() === requestKey) {
        inboxLoading.value = false;
        inboxLoadingOlder.value = false;
      }
      if (shouldReload) {
        inboxReloadAfterCurrentLoad = false;
        void loadInboxThreads().catch(() => undefined);
      }
    }
  }

  function loadOlderInboxThreads(): void {
    void loadInboxThreads({ append: true });
  }

  function handleInboxRefresh(): void {
    // Thread paging is independent of the snapshot-backed inbox sources. When
    // either class is degraded, request both repairs just as the shell did.
    void loadInboxThreads().catch(() => undefined);
    void loadRentalRequests();
    if (inboxDegradation.value.degraded) options.refreshRoom();
  }

  async function loadRentalRequests(): Promise<void> {
    if (!desktopIpc.rental?.getProviderDashboard) return;
    try {
      const dashboard = await loadRentalProviderDashboard();
      rentalRequests.value = Array.isArray(dashboard.pendingRequests) ? dashboard.pendingRequests : [];
      rentalRequestsUnavailable.value = false;
    } catch {
      rentalRequests.value = [];
      rentalRequestsUnavailable.value = true;
    }
  }

  async function openInboxThread(item: Extract<DesktopInboxItem, { kind: "thread" }>): Promise<void> {
    await options.openThread(item.root.id);
  }

  function clearInboxItem(item: DesktopInboxItem): void {
    const nextDismissals = {
      ...inboxDismissals.value,
      [item.id]: desktopInboxItemFingerprint(item),
    };
    inboxDismissals.value = nextDismissals;
    writeInboxDismissals(options.namespace.value, nextDismissals);
    showInboxUndo(item);
  }

  function restoreInboxItem(item: DesktopInboxItem): void {
    const nextDismissals = { ...inboxDismissals.value };
    delete nextDismissals[item.id];
    inboxDismissals.value = nextDismissals;
    writeInboxDismissals(options.namespace.value, nextDismissals);
    clearInboxUndoState();
  }

  function showInboxUndo(item: DesktopInboxItem): void {
    lastClearedInboxItem.value = item;
    if (inboxUndoTimer !== null) window.clearTimeout(inboxUndoTimer);
    inboxUndoTimer = window.setTimeout(clearInboxUndoState, 8_000);
  }

  function clearInboxUndoState(): void {
    lastClearedInboxItem.value = null;
    if (inboxUndoTimer !== null) {
      window.clearTimeout(inboxUndoTimer);
      inboxUndoTimer = null;
    }
  }

  function isInboxItemDismissed(item: DesktopInboxItem): boolean {
    return inboxDismissals.value[item.id] === desktopInboxItemFingerprint(item);
  }

  function handleThreadRead(
    threadRootId: string,
    summary: DesktopRoomThreadInboxPage["threads"][number]["summary"],
  ): void {
    const page = threadInboxPage.value;
    if (!page) return;
    const previous = page.threads.find((item) => item.root.id === threadRootId);
    if (!previous) return;
    const previousUnread = previous.summary.unreadCount > 0 ? 1 : 0;
    const nextUnread = summary.unreadCount > 0 ? 1 : 0;
    threadInboxPage.value = {
      ...page,
      unreadThreadCount: Math.max(0, page.unreadThreadCount - previousUnread + nextUnread),
      threads: page.threads.map((item) =>
        item.root.id === threadRootId
          ? { ...item, root: { ...item.root, thread: summary }, summary }
          : item
      ),
    };
  }

  function scheduleInboxRefresh(delayMs: number): void {
    if (inboxRefreshTimer !== null) window.clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = window.setTimeout(() => {
      inboxRefreshTimer = null;
      void loadInboxThreads().catch(() => undefined);
    }, delayMs);
  }

  return {
    inboxFilter,
    inboxLoading,
    inboxLoadingOlder,
    inboxError,
    lastClearedInboxItem,
    inboxUnseenCount,
    inboxItems,
    inboxActionableCount,
    inboxHasMore,
    inboxDegradation,
    loadOlderInboxThreads,
    handleInboxRefresh,
    openInboxThread,
    clearInboxItem,
    restoreInboxItem,
    handleThreadRead,
    openBoardTask: options.openBoardTask,
    openInboxGitHubEvent: options.openGitHubEvent,
    scheduleInboxRefresh,
  };
}

export function mergeThreadInboxPages(
  current: DesktopRoomThreadInboxPage,
  next: DesktopRoomThreadInboxPage,
): DesktopRoomThreadInboxPage {
  const threadsByRoot = new Map(current.threads.map((item) => [item.root.id, item]));
  for (const item of next.threads) threadsByRoot.set(item.root.id, item);
  return {
    threads: [...threadsByRoot.values()],
    hasMore: next.hasMore,
    unreadThreadCount: next.unreadThreadCount,
  };
}

function inboxSeenStorageKey(namespace: string): string {
  return `letagents-desktop:room-inbox-seen:${namespace}`;
}

function readInboxSeenFingerprints(namespace: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(inboxSeenStorageKey(namespace));
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return null;
    return [...new Set(parsed as string[])];
  } catch {
    return null;
  }
}

function writeInboxSeenFingerprints(namespace: string, fingerprints: string[]): void {
  try {
    window.localStorage.setItem(inboxSeenStorageKey(namespace), JSON.stringify(fingerprints));
  } catch {
    // The indicator can fall back to its in-memory baseline.
  }
}

function inboxDismissalsStorageKey(namespace: string): string {
  return `letagents-desktop:room-inbox-dismissals:${namespace}`;
}

function readInboxDismissals(namespace: string): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(inboxDismissalsStorageKey(namespace)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function writeInboxDismissals(namespace: string, dismissals: Record<string, string>): void {
  try {
    window.localStorage.setItem(inboxDismissalsStorageKey(namespace), JSON.stringify(dismissals));
  } catch {
    // Clearing the current view remains useful without persistent storage.
  }
}
