import { computed, ref, watch, type Ref } from "vue";
import type {
  DesktopRoomInfo,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import {
  compareRoomMessages,
  mergeRoomMessages,
} from "./messages";

const messageHistoryPageSize = 150;

export function useDesktopRoomMessages(options: {
  room: Readonly<Ref<DesktopRoomInfo>>;
  messages: Readonly<Ref<readonly DesktopRoomMessage[]>>;
  playRoomSound(kind: "send" | "notification"): void;
  onMessageSent(message: DesktopRoomMessage): void;
}) {
  const sendingMessage = ref(false);
  const sendError = ref<string | null>(null);
  const olderMessages = ref<DesktopRoomMessage[]>([]);
  const localMessages = ref<DesktopRoomMessage[]>([]);
  const hasOlderMessages = ref(true);
  const loadingOlderMessages = ref(false);
  const chatDraftText = ref("");
  const ownMessageIds = new Set<string>();

  const visibleMessages = computed(() => {
    return mergeRoomMessages([...olderMessages.value, ...options.messages.value], localMessages.value);
  });
  const roomMessagesForAgentInsight = computed(() =>
    [...olderMessages.value, ...options.messages.value, ...localMessages.value].sort(compareRoomMessages)
  );

  watch(
    () => options.messages.value.map((message) => message.id).join("|"),
    () => {
      const serverIds = new Set(options.messages.value.map((message) => message.id));
      localMessages.value = localMessages.value.filter((message) => !serverIds.has(message.id));
    }
  );

  watch(
    () => options.room.value.identifier,
    () => {
      olderMessages.value = [];
      localMessages.value = [];
      hasOlderMessages.value = true;
      loadingOlderMessages.value = false;
      sendError.value = null;
      chatDraftText.value = "";
    },
  );

  async function sendRoomMessage(
    text: string,
    replyTo: string | null = null,
    attachments: Array<{ upload_id: string }> = []
  ): Promise<void> {
    const trimmedText = text.trim();
    if (!trimmedText && attachments.length === 0) return;

    sendingMessage.value = true;
    sendError.value = null;
    try {
      const result = await window.letagentsDesktop.room.sendMessage(
        options.room.value.identifier,
        trimmedText,
        replyTo,
        attachments
      );
      ownMessageIds.add(result.message.id);
      localMessages.value = mergeRoomMessages(localMessages.value, [result.message]);
      options.playRoomSound("send");
      options.onMessageSent(result.message);
    } catch (error) {
      sendError.value = error instanceof Error ? error.message : "Message could not be sent.";
    } finally {
      sendingMessage.value = false;
    }
  }

  async function discardAttachment(uploadId: string): Promise<void> {
    await window.letagentsDesktop.room.discardAttachment(options.room.value.identifier, uploadId);
  }

  async function loadOlderMessages(): Promise<void> {
    if (loadingOlderMessages.value || !hasOlderMessages.value) return;
    const roomIdentifier = options.room.value.identifier;
    const firstMessageId = visibleMessages.value[0]?.id;
    if (!firstMessageId) {
      hasOlderMessages.value = false;
      return;
    }

    loadingOlderMessages.value = true;
    try {
      const page = await window.letagentsDesktop.room.getMessagesBefore(
        roomIdentifier,
        firstMessageId,
        messageHistoryPageSize
      );
      if (options.room.value.identifier !== roomIdentifier) return;
      olderMessages.value = [...page.messages, ...olderMessages.value];
      hasOlderMessages.value = page.hasOlder;
    } catch {
      if (options.room.value.identifier !== roomIdentifier) return;
      hasOlderMessages.value = false;
    } finally {
      if (options.room.value.identifier === roomIdentifier) {
        loadingOlderMessages.value = false;
      }
    }
  }

  return {
    sendingMessage,
    sendError,
    hasOlderMessages,
    loadingOlderMessages,
    chatDraftText,
    ownMessageIds,
    visibleMessages,
    roomMessagesForAgentInsight,
    sendRoomMessage,
    discardAttachment,
    loadOlderMessages,
  };
}
