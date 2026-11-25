<template>
  <LongMessageContent
    ref="content"
    :text="text"
    :html="html"
    :message-id="messageId"
    :sender="sender"
    :room-identifier="roomIdentifier"
    content-class="desktop-long-message-html"
    :show-reader-button="false"
    :excerpt="messageExcerpt"
    :intercept-click="interceptDesktopClick"
    @message-reference-click="emit('message-reference-click', $event)"
    @task-reference-click="emit('task-reference-click', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
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
const content = ref<InstanceType<typeof LongMessageContent> | null>(null);
const canOpenReader = computed(() => content.value?.isLong ?? false);
function openReader(): void { content.value?.openReader(); }
defineExpose({ canOpenReader, openReader });

/** Keep complete blocks and list items in the preview of an already sanitized message. */
function messageExcerpt(html: string): string | null {
  if (typeof document === "undefined" || html.includes('class="message-search-hit"')) return null;
  const source = document.createElement("template");
  source.innerHTML = html;
  let characters = 0;
  let lines = 0;
  let end: Element | null = null;
  for (const block of source.content.children) {
    const items = block.matches("ul, ol") ? block.children : [block];
    for (const item of items) {
      const text = item.textContent ?? "";
      characters += text.trim().length;
      lines += Math.max(text.split("\n").length, item.querySelectorAll("br, li").length + 1);
      if (characters > 520 || lines > 10 || item.matches("pre, .markdown-table-scroll")) {
        if (!end) return null;
        const range = document.createRange();
        range.selectNodeContents(source.content);
        range.setEndAfter(end);
        const excerpt = document.createElement("template");
        excerpt.content.append(range.cloneContents());
        return excerpt.innerHTML;
      }
      if (!item.matches("h1, h2, h3, h4, h5, h6, hr")) end = item;
    }
  }
  return null;
}

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
