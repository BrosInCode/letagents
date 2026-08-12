import {
  computed,
  onBeforeUnmount,
  ref,
  readonly,
  watch,
  type Ref,
} from "vue";
import type {
  DesktopGitHubEventsPage,
  DesktopRoomInfo,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import { mergeDesktopGitHubEventsPage } from "../../../../domain/desktop-room-snapshots";
import { roomSupportsGitHubIntegration } from "../../../../domain/git-rooms";
import { desktopIpc } from "../../../../ipc/index.js";
import type { ComposerEventPreview } from "../room-chat/RoomComposerEventChips.vue";
import { buildComposerEventPreview } from "../room-chat/composer-event-preview";
import {
  isLowSignalGitHubCheckMessage,
  parseGitHubEvent,
} from "../desktop-chat-message/github-event";
import type { GitHubEventPresentation } from "../desktop-chat-message/types";
import type { RoomTab, RoomTabId } from "./types";

type RoomTabIndicatorTone = NonNullable<NonNullable<RoomTab["indicator"]>["tone"]>;

export function useDesktopRoomGitHubEvents(options: {
  room: Readonly<Ref<DesktopRoomInfo>>;
  messages: Readonly<Ref<DesktopRoomMessage[]>>;
  initialPage: Readonly<Ref<DesktopGitHubEventsPage | null>>;
  activeTab: Ref<RoomTabId>;
  localGitRoom: Readonly<Ref<boolean>>;
  githubConnected: Readonly<Ref<boolean>>;
  connectedRepository: Readonly<Ref<string | null>>;
}) {
  const eventsPage = ref<DesktopGitHubEventsPage | null>(options.initialPage.value);
  const eventsLoading = ref(false);
  const eventsLoadingOlder = ref(false);
  const eventsError = ref<string | null>(null);
  const eventsTaskFilterId = ref<string | null>(null);
  const eventsSelectedEventId = ref<string | null>(null);
  const eventsLoadedOlderWithoutMatches = ref(false);
  const composerGitHubEventPreviews = ref<ComposerEventPreview[]>([]);
  const eventsUnseenCount = ref(0);
  const eventsUnseenTone = ref<RoomTabIndicatorTone>("info");
  const composerGitHubEventTimers = new Map<string, number>();
  let githubEventsRefreshTimer: number | null = null;

  const githubRepository = computed(() =>
    options.connectedRepository.value
    || repoRepositoryFromRoomIdentifier(options.room.value.identifier)
    || eventsPage.value?.githubRoomIdentifier
    || null
  );
  const showEventsTab = computed(() =>
    !options.localGitRoom.value && (
      roomSupportsGitHubIntegration(options.room.value)
      || options.githubConnected.value
      || Boolean(eventsPage.value?.events.length)
      || options.messages.value.some(shouldRefreshEventsForMessage)
    )
  );

  watch(options.initialPage, (nextPage) => {
    if (!nextPage) {
      if (!eventsPage.value || eventsPage.value.roomIdentifier !== options.room.value.identifier) {
        eventsPage.value = null;
      }
      return;
    }
    eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
  }, { immediate: true });

  watch(() => options.room.value.identifier, () => {
    eventsPage.value = options.initialPage.value;
    eventsTaskFilterId.value = null;
    eventsSelectedEventId.value = null;
    eventsError.value = null;
    eventsLoadedOlderWithoutMatches.value = false;
    clearComposerGitHubEventPreviews();
    resetEventsIndicator();
  });

  watch(options.activeTab, (tab) => {
    if (tab === "events" && showEventsTab.value && !eventsPage.value && !eventsLoading.value) {
      void refreshGitHubEvents().catch(() => undefined);
    }
    if (tab === "events") resetEventsIndicator();
  }, { flush: "sync" });

  watch(() => options.messages.value.at(-1)?.id || null, () => {
    const latestMessage = options.messages.value.at(-1);
    if (!latestMessage || !showEventsTab.value || !shouldRefreshEventsForMessage(latestMessage)) return;
    if (!shouldPreviewComposerEvent(latestMessage)) {
      scheduleGitHubEventsRefresh(options.activeTab.value === "events" ? 250 : 900);
      return;
    }
    ingestComposerGitHubEvent(latestMessage);
    scheduleGitHubEventsRefresh(options.activeTab.value === "events" ? 250 : 900);
  });

  onBeforeUnmount(() => {
    if (githubEventsRefreshTimer !== null) {
      window.clearTimeout(githubEventsRefreshTimer);
      githubEventsRefreshTimer = null;
    }
    clearComposerGitHubEventPreviews();
  });

  function openEventsTab(): void {
    if (!showEventsTab.value) return;
    eventsTaskFilterId.value = null;
    eventsSelectedEventId.value = null;
    options.activeTab.value = "events";
  }

  async function refreshGitHubEvents(): Promise<void> {
    if (!showEventsTab.value || !desktopIpc.room?.getGitHubEvents) return;
    eventsLoading.value = true;
    eventsError.value = null;
    try {
      const nextPage = await desktopIpc.room.getGitHubEvents(options.room.value.identifier, { limit: 100 });
      eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
    } catch (error) {
      eventsError.value = error instanceof Error ? error.message : "GitHub events could not be loaded.";
    } finally {
      eventsLoading.value = false;
    }
  }

  async function loadOlderGitHubEvents(): Promise<void> {
    if (!showEventsTab.value || !desktopIpc.room?.getGitHubEvents || eventsLoadingOlder.value) return;
    const after = eventsPage.value?.events.at(-1)?.id || null;
    if (!after) return;
    eventsLoadingOlder.value = true;
    eventsError.value = null;
    eventsLoadedOlderWithoutMatches.value = false;
    const beforeCount = eventsPage.value?.events.length || 0;
    try {
      const nextPage = await desktopIpc.room.getGitHubEvents(options.room.value.identifier, { limit: 100, after });
      eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
      eventsLoadedOlderWithoutMatches.value = Boolean(
        nextPage.events.length && (eventsPage.value?.events.length || 0) === beforeCount,
      );
    } catch (error) {
      eventsError.value = error instanceof Error ? error.message : "Older GitHub events could not be loaded.";
    } finally {
      eventsLoadingOlder.value = false;
    }
  }

  function openEventsForTask(taskId: string): void {
    if (!showEventsTab.value) return;
    eventsTaskFilterId.value = taskId;
    eventsSelectedEventId.value = null;
    options.activeTab.value = "events";
  }

  function openEventById(eventId: string): void {
    eventsTaskFilterId.value = null;
    eventsSelectedEventId.value = eventId;
    options.activeTab.value = "events";
  }

  function clearTaskFilter(): void {
    eventsTaskFilterId.value = null;
  }

  function closeSelectedEvent(): void {
    eventsSelectedEventId.value = null;
  }

  async function openGitHubEventFromChat(url: string): Promise<void> {
    if (!showEventsTab.value) return;
    eventsTaskFilterId.value = null;
    options.activeTab.value = "events";
    const firstMatch = findEventByUrl(url);
    if (firstMatch) {
      eventsSelectedEventId.value = firstMatch.id;
      return;
    }
    await refreshGitHubEvents();
    eventsSelectedEventId.value = findEventByUrl(url)?.id || null;
  }

  async function openGitHubUrlExternally(url: string): Promise<void> {
    if (desktopIpc.app?.openGitHubUrl) {
      await desktopIpc.app.openGitHubUrl(url);
      return;
    }
    await desktopIpc.auth?.openVerification?.(url);
  }

  function scheduleGitHubEventsRefresh(delayMs: number): void {
    if (!showEventsTab.value) return;
    if (githubEventsRefreshTimer !== null) window.clearTimeout(githubEventsRefreshTimer);
    githubEventsRefreshTimer = window.setTimeout(() => {
      githubEventsRefreshTimer = null;
      void refreshGitHubEvents().catch(() => undefined);
    }, delayMs);
  }

  function ingestComposerGitHubEvent(message: DesktopRoomMessage): void {
    if (options.activeTab.value === "events" || isLowSignalGitHubCheckMessage(message)) return;
    const event = parseGitHubEvent(message);
    if (!event) return;
    eventsUnseenCount.value = Math.min(99, eventsUnseenCount.value + 1);
    eventsUnseenTone.value = eventTabIndicatorTone(event.tone);
    addComposerGitHubEventPreview(message.id, event);
  }

  function addComposerGitHubEventPreview(messageId: string, event: GitHubEventPresentation): void {
    const preview = buildComposerEventPreview(
      messageId,
      event,
      options.room.value,
      eventsPage.value?.events || [],
    );
    const existingTimer = composerGitHubEventTimers.get(messageId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    composerGitHubEventPreviews.value = [
      ...composerGitHubEventPreviews.value.filter((item) => item.id !== messageId),
      preview,
    ].slice(-1);
    for (const staleId of [...composerGitHubEventTimers.keys()]) {
      if (composerGitHubEventPreviews.value.some((item) => item.id === staleId)) continue;
      const timer = composerGitHubEventTimers.get(staleId);
      if (timer !== undefined) window.clearTimeout(timer);
      composerGitHubEventTimers.delete(staleId);
    }
    composerGitHubEventTimers.set(messageId, window.setTimeout(() => {
      composerGitHubEventTimers.delete(messageId);
      composerGitHubEventPreviews.value = composerGitHubEventPreviews.value.filter((item) => item.id !== messageId);
    }, 8_000));
  }

  function dismissComposerGitHubEventPreview(messageId: string): void {
    const timer = composerGitHubEventTimers.get(messageId);
    if (timer !== undefined) window.clearTimeout(timer);
    composerGitHubEventTimers.delete(messageId);
    composerGitHubEventPreviews.value = composerGitHubEventPreviews.value.filter((item) => item.id !== messageId);
  }

  function clearComposerGitHubEventPreviews(): void {
    for (const timer of composerGitHubEventTimers.values()) window.clearTimeout(timer);
    composerGitHubEventTimers.clear();
    composerGitHubEventPreviews.value = [];
  }

  function resetEventsIndicator(): void {
    eventsUnseenCount.value = 0;
    eventsUnseenTone.value = "info";
  }

  function findEventByUrl(url: string): NonNullable<DesktopGitHubEventsPage["events"][number]> | null {
    const exactUrl = normalizeExactGitHubUrl(url);
    if (!exactUrl) return null;
    const events = eventsPage.value?.events || [];
    const exactMatch = events.find((event) => normalizeExactGitHubUrl(event.githubObjectUrl) === exactUrl);
    if (exactMatch) return exactMatch;
    const normalizedUrl = normalizeGitHubObjectUrl(url);
    if (!normalizedUrl) return null;
    return events.find((event) => normalizeGitHubObjectUrl(event.githubObjectUrl) === normalizedUrl) || null;
  }

  return {
    eventsPage,
    eventsLoading,
    eventsLoadingOlder,
    eventsError,
    eventsTaskFilterId: readonly(eventsTaskFilterId),
    eventsSelectedEventId: readonly(eventsSelectedEventId),
    eventsLoadedOlderWithoutMatches,
    composerGitHubEventPreviews,
    eventsUnseenCount,
    eventsUnseenTone,
    githubRepository,
    showEventsTab,
    openEventsTab,
    refreshGitHubEvents,
    loadOlderGitHubEvents,
    openEventsForTask,
    openEventById,
    clearTaskFilter,
    closeSelectedEvent,
    openGitHubEventFromChat,
    openGitHubUrlExternally,
    dismissComposerGitHubEventPreview,
  };
}

export function shouldRefreshEventsForMessage(message: DesktopRoomMessage): boolean {
  return (message.source || "").toLowerCase() === "github"
    || (message.sender || "").toLowerCase() === "github";
}

export function shouldPreviewComposerEvent(message: DesktopRoomMessage, now = Date.now()): boolean {
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) && now - timestamp < 30_000;
}

export function repoRepositoryFromRoomIdentifier(identifier: string): string | null {
  return /^github\.com\/([^/]+\/[^/]+)$/i.exec(identifier.trim())?.[1] ?? null;
}

export function normalizeExactGitHubUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  return trimmed ? trimmed.replace(/\/$/, "").toLowerCase() : null;
}

export function normalizeGitHubObjectUrl(url: string | null | undefined): string | null {
  return normalizeExactGitHubUrl(url)?.replace(/[#?].*$/, "") ?? null;
}

function eventTabIndicatorTone(tone: GitHubEventPresentation["tone"]): RoomTabIndicatorTone {
  if (tone === "emerald") return "success";
  if (tone === "rose") return "danger";
  if (tone === "amber") return "warning";
  return "info";
}
