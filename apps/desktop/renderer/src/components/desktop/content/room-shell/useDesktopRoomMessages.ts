import { computed, ref, watch, type Ref } from "vue";
import type {
  DesktopRoomInfo,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import {
  compareRoomMessages,
  isHiddenChatMessage,
  mergeRoomMessages,
} from "./messages";
import {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
} from "../desktop-chat-message/github-event";
import { roomTimelineMessages } from "../room-chat/thread-utils";
import { desktopIpc } from "../../../../ipc/index.js";

const messageHistoryPageSize = 150;
const maxAutoHistoryBackfillPages = 5;
const maxExplicitMessageRevealPages = 5;

export function useDesktopRoomMessages(options: {
  room: Readonly<Ref<DesktopRoomInfo>>;
  messages: Readonly<Ref<readonly DesktopRoomMessage[]>>;
  githubEventsVisible: Readonly<Ref<boolean>>;
  playRoomSound(kind: "send" | "notification"): void;
  onMessageSent(message: DesktopRoomMessage): void;
}) {
  let roomGeneration = 0;
  const sendingMessage = ref(false);
  const sendError = ref<string | null>(null);
  const olderMessages = ref<DesktopRoomMessage[]>([]);
  const localMessages = ref<DesktopRoomMessage[]>([]);
  const hasOlderMessages = ref(true);
  const loadingOlderMessages = ref(false);
  const olderMessagesError = ref<string | null>(null);
  let roomHistoryGeneration = 0;
  const chatDraftText = ref("");
  const autoHistoryBackfillCount = ref(0);
  const ownMessageIds = new Set<string>();

  const loadedServerMessages = computed(() => {
    return mergeRoomMessages(olderMessages.value, options.messages.value);
  });
  const visibleMessages = computed(() => {
    return mergeRoomMessages(loadedServerMessages.value, localMessages.value)
      .filter((message) =>
        !isLowSignalGitHubCheckMessage(message)
        && (options.githubEventsVisible.value || !isGitHubRoomMessage(message))
      );
  });
  const hasFilteredRoomActivity = computed(() => {
    if (visibleMessages.value.length) return false;
    return [...olderMessages.value, ...options.messages.value, ...localMessages.value]
      .some((message) =>
        isUserFacingFilteredMessage(message)
        || isLowSignalGitHubCheckMessage(message)
        || (!options.githubEventsVisible.value && isGitHubRoomMessage(message))
      );
  });
  const timelineMessages = computed(() => roomTimelineMessages(visibleMessages.value));
  const roomMessagesForAgentInsight = computed(() =>
    [...olderMessages.value, ...options.messages.value, ...localMessages.value].sort(compareRoomMessages)
  );

  watch(
    () => options.messages.value.map((message) => message.id).join("|"),
    () => {
      autoHistoryBackfillCount.value = 0;
      const serverIds = new Set(options.messages.value.map((message) => message.id));
      localMessages.value = localMessages.value.filter((message) => !serverIds.has(message.id));
    }
  );

  watch(
    () => options.room.value.identifier,
    () => {
      roomGeneration += 1;
      sendingMessage.value = false;
      roomHistoryGeneration += 1;
      olderMessagesError.value = null;
      olderMessages.value = [];
      localMessages.value = [];
      hasOlderMessages.value = true;
      loadingOlderMessages.value = false;
      sendError.value = null;
      chatDraftText.value = "";
      autoHistoryBackfillCount.value = 0;
    },
  );

  watch(
    [
      () => visibleMessages.value.length,
      () => hasFilteredRoomActivity.value,
      () => hasOlderMessages.value,
      () => loadingOlderMessages.value,
      () => olderMessagesError.value,
      () => options.room.value.identifier,
    ],
    ([visibleCount, hasFilteredActivity, hasOlder, loading, historyError, roomIdentifier]) => {
      if (visibleCount > 0 || !hasFilteredActivity || !hasOlder || loading || historyError || !roomIdentifier) return;
      if (autoHistoryBackfillCount.value >= maxAutoHistoryBackfillPages) return;
      autoHistoryBackfillCount.value += 1;
      void loadOlderMessages();
    },
    { immediate: true },
  );

  async function sendRoomMessage(
    text: string,
    replyTo: string | null = null,
    attachments: Array<{ upload_id: string }> = [],
    threadRootId: string | null = null,
    complete: (sent: boolean) => void = () => undefined,
  ): Promise<void> {
    const trimmedText = text.trim();
    if ((!trimmedText && attachments.length === 0) || sendingMessage.value) {
      complete(false);
      return;
    }
    const generation = roomGeneration;
    const roomIdentifier = options.room.value.identifier;
    const isCurrentRoom = () => generation === roomGeneration && roomIdentifier === options.room.value.identifier;

    sendingMessage.value = true;
    sendError.value = null;
    try {
      const result = await desktopIpc.room.sendMessage(
        roomIdentifier,
        trimmedText,
        replyTo,
        attachments,
        threadRootId,
      );
      if (!isCurrentRoom()) return;
      ownMessageIds.add(result.message.id);
      localMessages.value = mergeRoomMessages(localMessages.value, [result.message]);
      options.playRoomSound("send");
      options.onMessageSent(result.message);
      complete(true);
    } catch (error) {
      if (!isCurrentRoom()) return;
      sendError.value = error instanceof Error ? error.message : "Message could not be sent.";
      complete(false);
    } finally {
      if (isCurrentRoom()) sendingMessage.value = false;
    }
  }

  async function discardAttachment(uploadId: string): Promise<void> {
    await desktopIpc.room.discardAttachment(options.room.value.identifier, uploadId);
  }

  async function loadOlderMessages(): Promise<void> {
    if (loadingOlderMessages.value || !hasOlderMessages.value) return;
    const roomIdentifier = options.room.value.identifier;
    const firstMessageId = oldestRoomHistoryCursor(loadedServerMessages.value);
    if (!firstMessageId) {
      hasOlderMessages.value = false;
      return;
    }

    const generation = roomHistoryGeneration;
    const isCurrentHistory = () => roomHistoryGeneration === generation
      && options.room.value.identifier === roomIdentifier;
    loadingOlderMessages.value = true;
    olderMessagesError.value = null;
    try {
      const page = await desktopIpc.room.getMessagesBefore(
        roomIdentifier,
        firstMessageId,
        messageHistoryPageSize
      );
      if (!isCurrentHistory()) return;
      olderMessages.value = [...page.messages, ...olderMessages.value];
      hasOlderMessages.value = page.hasOlder;
    } catch {
      if (!isCurrentHistory()) return;
      olderMessagesError.value = "Earlier messages could not be loaded. Retry to load them.";
    } finally {
      if (isCurrentHistory()) {
        loadingOlderMessages.value = false;
      }
    }
  }

  /**
   * Reveal an explicit causal link without unboundedly walking room history.
   * A false result is intentionally surfaced by the App shell rather than
   * silently leaving a link that appears to have worked.
   */
  async function revealMessage(messageId: string): Promise<boolean> {
    const generation = roomHistoryGeneration;
    const targetId = messageId.trim();
    if (!targetId) return false;
    for (let page = 0; page <= maxExplicitMessageRevealPages; page += 1) {
      if (visibleMessages.value.some((message) => message.id === targetId)) return true;
      if (!hasOlderMessages.value || loadingOlderMessages.value) return false;
      await loadOlderMessages();
      if (roomHistoryGeneration !== generation || olderMessagesError.value) return false;
    }
    return visibleMessages.value.some((message) => message.id === targetId);
  }

  return {
    sendingMessage,
    sendError,
    hasOlderMessages,
    loadingOlderMessages,
    olderMessagesError,
    chatDraftText,
    ownMessageIds,
    hasFilteredRoomActivity,
    visibleMessages,
    timelineMessages,
    roomMessagesForAgentInsight,
    sendRoomMessage,
    discardAttachment,
    loadOlderMessages,
    revealMessage,
  };
}

export function oldestRoomHistoryCursor(messages: readonly DesktopRoomMessage[]): string | null {
  return [...messages].sort(compareRoomMessages)[0]?.id ?? null;
}

function isUserFacingFilteredMessage(message: DesktopRoomMessage): boolean {
  return isHiddenChatMessage(message) && !(message.agentPromptKind === "auto" && !message.text.trim());
}
