<template>
  <LongMessageContent
    :text="text"
    :html="html"
    :message-id="messageId"
    :sender="sender"
    :room-identifier="roomIdentifier"
    content-class="desktop-long-message-html"
    :intercept-click="interceptDesktopClick"
    @message-reference-click="emit('message-reference-click', $event)"
    @task-reference-click="emit('task-reference-click', $event)"
  />
</template>

<script setup lang="ts">
import LongMessageContent from "../../../../../../../shared/ui/LongMessageContent.vue";
import type { MessageReaderSender } from "../../../../../../../shared/ui/message-reader";
import type { PersonMenuPosition } from "../../../domain/person-context-menu";
import { mentionKeyForClick, mentionMenuPosition } from "../../../domain/room-mention-links";
import { LETAGENTS_ROOM_ORIGIN, resolveSameRoomMessageReference } from "../../../domain/room-urls";

const props = withDefaults(defineProps<{
  text: string;
  html: string;
  messageId: string;
  roomIdentifier?: string | null;
  sender?: MessageReaderSender;
}>(), {
  roomIdentifier: null,
});

const emit = defineEmits<{
  "message-reference-click": [messageId: string];
  "task-reference-click": [taskId: string];
  "mention-click": [mentionKey: string, position: PersonMenuPosition];
}>();

/** Mentions open the person menu; links to this room scroll to the message. */
function interceptDesktopClick(event: MouseEvent): (() => void) | null {
  const mentionKey = mentionKeyForClick(event, window.getSelection?.()?.toString() ?? "");
  if (mentionKey) {
    const element = (event.target as Element).closest("[data-mention-key]");
    const position = mentionMenuPosition(event, element);
    return () => emit("mention-click", mentionKey, position);
  }

  const anchor = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>("a[href]")
    : null;
  const targetMessageId = anchor
    ? resolveSameRoomMessageReference(anchor.getAttribute("href") || "", props.roomIdentifier, LETAGENTS_ROOM_ORIGIN)
    : null;
  if (!targetMessageId) return null;
  return () => emit("message-reference-click", targetMessageId);
}
</script>
