import type { RoomGif } from "../../../../../../../../shared/room-expressions.mjs";
import { computed, getCurrentScope, onScopeDispose, provide, ref, watch, type Ref } from "vue";
import type {
  DesktopOutgoingMessageAttachment,
  DesktopRoomInfo,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import {
  compareRoomMessages,
  createMessageIdentityVersion,
  isHiddenChatMessage,
  mergeRoomMessages,
} from "./messages";
import {
  isGitHubRoomMessage,
} from "../desktop-chat-message/github-event";
import { roomTimelineMessages } from "../room-chat/thread-utils";
import { desktopIpc } from "../../../../ipc/index.js";

import {
  desktopMessageOutbox,
  enqueueDesktopMessage,
  parseOutgoingSendError,
  persistAndEnqueueDesktopMessage,
  reconcileDesktopMessageOutbox,
  registerDesktopOutboxConfirmationListener,
  retryDesktopOutgoingMessage,
} from "../../../../domain/message-outbox";

import { unreadRevealKey } from "../../../../composables/roomUnread";

const messageHistoryPageSize = 150;
const maxAutoHistoryBackfillPages = 5;
const maxExplicitMessageRevealPages = 20;

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
  let olderMessagesRequest: Promise<void> | null = null;
  const autoHistoryBackfillCount = ref(0);
  const ownMessageIds = new Set<string>();
  let persistingSubmission = false;
  let stopConfirmationListener: (() => void) | null = null;

  watch(
    () => [options.room.value.identifier, options.messageNamespace?.value ?? null] as const,
    ([roomIdentifier, messageNamespace]) => {
      stopConfirmationListener?.();
      stopConfirmationListener = roomIdentifier
        ? registerDesktopOutboxConfirmationListener(roomIdentifier, messageNamespace, (event) => {
            if (
              event.roomIdentifier !== options.room.value.identifier
              || event.messageNamespace !== (options.messageNamespace?.value ?? null)
            ) {
              return;
            }
            ownMessageIds.add(event.message.id);
            options.onMessageSent(event.message);
          })
        : null;
    },
    { immediate: true, flush: "sync" },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      stopConfirmationListener?.();
      stopConfirmationListener = null;
    });
  }

  const loadedServerMessages = computed(() => {
    return mergeRoomMessages(olderMessages.value, options.messages.value);
  });
  const visibleMessages = computed(() => {
    // `loadedServerMessages` is already merged, hidden-filtered and sorted. With
    // no unsent local messages a second merge would return the same list, so it
    // is skipped. The merge stays for the pending-send case.
    const merged = localMessages.value.length
      ? mergeRoomMessages(loadedServerMessages.value, localMessages.value)
      : loadedServerMessages.value;
    return merged
      .filter((message) =>
        options.githubEventsVisible.value || !isGitHubRoomMessage(message)
      );
  });
  const hasFilteredRoomActivity = computed(() => {
    if (visibleMessages.value.length) return false;
    return [...olderMessages.value, ...options.messages.value, ...localMessages.value]
      .some((message) =>
        isUserFacingFilteredMessage(message)
        || (!options.githubEventsVisible.value && isGitHubRoomMessage(message))
      );
  });
  const timelineMessages = computed(() => roomTimelineMessages(visibleMessages.value));
  const roomMessagesForAgentInsight = computed(() =>
    [...olderMessages.value, ...options.messages.value, ...localMessages.value].sort(compareRoomMessages)
  );

  const messageIdentityVersion = createMessageIdentityVersion();
  watch(
    [
      () => messageIdentityVersion(options.messages.value),
      () => desktopMessageOutbox.value.length,
      () => options.room.value.identifier,
      () => options.messageNamespace?.value ?? null,
    ],
    ([version], [previousVersion]) => {
      if (version !== previousVersion) {
        autoHistoryBackfillCount.value = 0;
      }
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
      olderMessagesRequest = null;
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
    attachments: DesktopOutgoingMessageAttachment[] = [],
    threadRootId: string | null = null,
    complete: (sent: boolean) => void = () => undefined,
    gif?: RoomGif | null,
  ): Promise<void> {
    const trimmedText = text.trim();
    const roomIdentifier = options.room.value.identifier;
    if ((!trimmedText && !gif && attachments.length === 0) || !roomIdentifier
      || replyTo?.startsWith("pending:") || threadRootId?.startsWith("pending:")) {
      complete(false);
      return;
    }
    if (persistingSubmission) {
      complete(false);
      return;
    }
    const messageNamespace = options.messageNamespace?.value ?? null;
    const reply = visibleMessages.value.find(message => message.id === replyTo);
    const enqueueInput = {
      roomIdentifier,
      messageNamespace,
      text: trimmedText,
      replyTo,
      threadRootId,
      attachments,
      gif,
      replyPreview: reply ? {
        id: reply.id, sender: reply.sender, text: reply.text, source: reply.source,
        timestamp: reply.timestamp, agentIdentity: reply.agentIdentity,
      } : null,
      onConfirmed: () => undefined,
    };

    const isScopeOrValidationFailure = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error ?? "");
      return (
        message.includes("precommit_refusal:")
        || message.includes("Invalid outgoing message identity.")
        || message.includes("Choose a room before sending a message.")
        || message.includes("Write a message before sending.")
        || message.includes("different room storage mode")
        || message.includes("different account")
        || message.includes("GIFs require a cloud room.")
      );
    };

    const generatedClientMessageId = `desktop-send:${crypto.randomUUID()}`;
    let clientMessageId: string | null;
    if (typeof desktopIpc.room?.saveOutgoingMessage === "function") {
      persistingSubmission = true;
      try {
        clientMessageId = await persistAndEnqueueDesktopMessage({
          ...enqueueInput,
          clientMessageId: generatedClientMessageId,
        });
      } catch (error) {
        const isLocalStorage = Boolean(messageNamespace && /:local:/i.test(messageNamespace));
        if (isLocalStorage || isScopeOrValidationFailure(error)) {
          sendError.value = parseOutgoingSendError(error).message;
          complete(false);
          return;
        }
        // Cloud room + local SQLite fault: keep the draft intact in the composer
        // (never clear before either durable save or server confirmation) and
        // deliver directly so a broken local DB does not deadlock cloud chat.
        try {
          const wireAttachments = attachments.map(({ upload_id }) => ({ upload_id }));
          const result = await desktopIpc.room.sendMessage(
            roomIdentifier,
            trimmedText,
            replyTo,
            wireAttachments,
            threadRootId,
            generatedClientMessageId,
            messageNamespace,
            gif,
          );
          const confirmed = { ...result.message, clientMessageId: generatedClientMessageId };
          ownMessageIds.add(confirmed.id);
          options.onMessageSent(confirmed);
          sendError.value = null;
          complete(true);
          options.playRoomSound("send");
        } catch (sendFailure) {
          sendError.value = parseOutgoingSendError(sendFailure).message;
          complete(false);
        }
        return;
      } finally {
        persistingSubmission = false;
      }
      if (!clientMessageId) {
        complete(false);
        return;
      }
    } else {
      clientMessageId = enqueueDesktopMessage({
        ...enqueueInput,
        clientMessageId: generatedClientMessageId,
      });
    }
    ownMessageIds.add(`pending:${clientMessageId}`);
    sendError.value = null;
    // Durable local acceptance releases the composer right away. Delivery progress
    // belongs to its message row, so the next draft remains editable while sending.
    complete(true);
    options.playRoomSound("send");
    await retryDesktopOutgoingMessage(clientMessageId);
  }

  async function discardAttachment(uploadId: string): Promise<void> {
    await desktopIpc.room.discardAttachment(options.room.value.identifier, uploadId);
  }

  function loadOlderMessages(): Promise<void> {
    if (olderMessagesRequest) return olderMessagesRequest;
    const request = fetchOlderMessages();
    olderMessagesRequest = request;
    void request.finally(() => {
      if (olderMessagesRequest !== request) return;
      // Backfill can request another page as soon as loading becomes false.
      olderMessagesRequest = null;
      loadingOlderMessages.value = false;
    });
    return request;
  }

  async function fetchOlderMessages(): Promise<void> {
    if (loadingOlderMessages.value || !hasOlderMessages.value) return;
    const roomIdentifier = options.room.value.identifier;
    // A page of filtered notices still advances the room's history cursor.
    const firstMessageId = oldestRoomHistoryCursor([...olderMessages.value, ...options.messages.value]);
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
    }
  }

  /**
   * Reveal an explicit causal link without unboundedly walking room history.
   * Failure outcomes are intentionally surfaced by the App shell rather than
   * silently leaving a link that appears to have worked.
   */
  async function revealMessage(
    messageId: string,
  ): Promise<"revealed" | "not_found" | "too_far_back" | "unavailable"> {
    const generation = roomHistoryGeneration;
    const targetId = messageId.trim();
    if (!targetId) return "unavailable";

    if (visibleMessages.value.some((message) => message.id === targetId)) return "revealed";

    // Pre-flight check: tell "not found" / hidden from "too far back"
    if (typeof desktopIpc.room?.getMessage === "function") {
      try {
        const targetMessage = await desktopIpc.room.getMessage(options.room.value.identifier, targetId);
        if (!targetMessage || isHiddenChatMessage(targetMessage)) {
          return "not_found";
        }
      } catch {
        // Thrown error means lookup failed (network, timeout, 500); fall through to paging.
      }
    }

    let pagesRequested = 0;
    while (roomHistoryGeneration === generation) {
      if (visibleMessages.value.some((message) => message.id === targetId)) return "revealed";
      if (!olderMessagesRequest && !hasOlderMessages.value) return "unavailable";
      if (pagesRequested >= maxExplicitMessageRevealPages) return "too_far_back";
      pagesRequested += 1;
      await loadOlderMessages();
      if (roomHistoryGeneration !== generation || olderMessagesError.value) {
        return "unavailable";
      }
    }
    return "unavailable";
  }

  provide(unreadRevealKey, async (id) => {
    const outcome = await revealMessage(id);
    return outcome === "revealed" && timelineMessages.value.some(message => message.id === id);
  });

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
