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

import { desktopMessageOutbox, enqueueDesktopMessage, reconcileDesktopMessageOutbox, retryDesktopOutgoingMessage } from "../../../../domain/message-outbox";

const messageHistoryPageSize = 150;
const maxAutoHistoryBackfillPages = 5;
const maxExplicitMessageRevealPages = 5;

export function useDesktopRoomMessages(options: {
  room: Readonly<Ref<DesktopRoomInfo>>;
  messageNamespace?: Readonly<Ref<string>>;
  messages: Readonly<Ref<readonly DesktopRoomMessage[]>>;
  githubEventsVisible: Readonly<Ref<boolean>>;
  playRoomSound(kind: "send" | "notification"): void;
  onMessageSent(message: DesktopRoomMessage): void;
}) {
  let roomGeneration = 0;
  const sendingMessage = ref(false);
  const sendError = ref<string | null>(null);
  const olderMessages = ref<DesktopRoomMessage[]>([]);
  const localMessages = computed(() => desktopMessageOutbox.value
    .filter(entry => entry.roomIdentifier === options.room.value.identifier && entry.messageNamespace === (options.messageNamespace?.value ?? null))
    .map(entry => entry.message));
  const hasOlderMessages = ref(true);
  const loadingOlderMessages = ref(false);
  const olderMessagesError = ref<string | null>(null);
  let roomHistoryGeneration = 0;
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
    () => options.messages.value.map((message) => `${message.id}:${message.clientMessageId || ""}`).join("|"),
    () => {
      autoHistoryBackfillCount.value = 0;
      reconcileDesktopMessageOutbox(options.room.value.identifier, options.messages.value, options.messageNamespace?.value ?? null);
    },
    { immediate: true },
  );

  watch(
    () => options.room.value.identifier,
    () => {
      roomGeneration += 1;
      sendingMessage.value = false;
      roomHistoryGeneration += 1;
      olderMessagesError.value = null;
      olderMessages.value = [];
      hasOlderMessages.value = true;
      loadingOlderMessages.value = false;
      sendError.value = null;
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
    const roomIdentifier = options.room.value.identifier;
    if ((!trimmedText && attachments.length === 0) || !roomIdentifier
      || replyTo?.startsWith("pending:") || threadRootId?.startsWith("pending:")) {
      complete(false);
      return;
    }
    const generation = roomGeneration;
    const messageNamespace = options.messageNamespace?.value ?? null;
    const reply = visibleMessages.value.find(message => message.id === replyTo);
    const clientMessageId = enqueueDesktopMessage({
      roomIdentifier, messageNamespace, text: trimmedText, replyTo, threadRootId, attachments,
      replyPreview: reply ? {
        id: reply.id, sender: reply.sender, text: reply.text, source: reply.source,
        timestamp: reply.timestamp, agentIdentity: reply.agentIdentity,
      } : null,
      onConfirmed: (message) => {
        if (generation !== roomGeneration || roomIdentifier !== options.room.value.identifier || messageNamespace !== (options.messageNamespace?.value ?? null)) return;
        ownMessageIds.add(message.id);
        options.onMessageSent(message);
      },
    });
    ownMessageIds.add(`pending:${clientMessageId}`);
    sendError.value = null;
    // Local acceptance releases the composer synchronously. Delivery progress
    // belongs to its message row, so the next draft remains editable.
    complete(true);
    options.playRoomSound("send");
    await retryDesktopOutgoingMessage(clientMessageId);
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
