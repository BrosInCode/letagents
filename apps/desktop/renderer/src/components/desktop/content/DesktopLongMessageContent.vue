<template>
  <div class="desktop-long-message" data-testid="desktop-long-message">
    <div
      :id="contentId"
      class="desktop-long-message-content"
      :class="{ collapsed: isLong && !expanded }"
      :data-testid="`desktop-long-message-content-${safeMessageId}`"
    >
      <div class="desktop-long-message-html" v-html="html" @click="handleInlineReferenceClick" />
      <span v-if="isLong && !expanded" class="desktop-long-message-fade" aria-hidden="true" />
    </div>

    <div v-if="isLong" class="desktop-long-message-actions">
      <span>{{ statsLabel }}</span>
      <button
        type="button"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        data-testid="desktop-long-message-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? "Collapse" : "Read more" }}
      </button>
      <button type="button" data-testid="desktop-open-reader" @click="openReader">
        Open reader
      </button>
    </div>

    <MessageReader v-if="readerOpen" :text="text" :html="html" :sender="sender" :room-identifier="roomIdentifier"
      @close="closeReader" @content-click="handleInlineReferenceClick" />
  </div>
</template>

<script setup lang="ts">
import { formatDecimalNumber } from "../../../domain/formatters";
import { computed, ref } from "vue";

import MessageReader from "../../../../../../../shared/ui/MessageReader.vue";
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
  collapseAfterChars?: number;
  collapseAfterLines?: number;
}>(), {
  roomIdentifier: null,
  collapseAfterChars: 1400,
  collapseAfterLines: 18,
});

const emit = defineEmits<{
  "message-reference-click": [messageId: string];
  "task-reference-click": [taskId: string];
  "mention-click": [mentionKey: string, position: PersonMenuPosition];
}>();

const expanded = ref(false);
const readerOpen = ref(false);

const lineCount = computed(() => props.text ? props.text.split(/\r\n|\r|\n/).length : 0);
const characterCount = computed(() => props.text.length);
const isLong = computed(() =>
  characterCount.value > props.collapseAfterChars || lineCount.value > props.collapseAfterLines
);
const safeMessageId = computed(() => props.messageId.replace(/[^A-Za-z0-9_-]/g, "-") || "message");
const contentId = computed(() => `desktop-message-content-${safeMessageId.value}`);
const statsLabel = computed(() => {
  const lines = lineCount.value;
  const chars = formatDecimalNumber(characterCount.value);
  return `${lines} ${lines === 1 ? "line" : "lines"} / ${chars} chars`;
});

function openReader(): void {
  readerOpen.value = true;
}

function closeReader(): void {
  readerOpen.value = false;
}

function handleInlineReferenceClick(event: MouseEvent): void {
  const mentionKey = mentionKeyForClick(event, window.getSelection?.()?.toString() ?? "");
  if (mentionKey) {
    event.preventDefault();
    event.stopPropagation();
    const element = (event.target as Element).closest("[data-mention-key]");
    const position = mentionMenuPosition(event, element);
    readerOpen.value = false;
    emit("mention-click", mentionKey, position);
    return;
  }

  const anchorTarget = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>("a[href]")
    : null;
  if (anchorTarget) {
    const href = anchorTarget.getAttribute("href") || "";
    const targetMessageId = resolveSameRoomMessageReference(
      href,
      props.roomIdentifier,
      LETAGENTS_ROOM_ORIGIN,
    );
    if (targetMessageId) {
      event.preventDefault();
      event.stopPropagation();
      readerOpen.value = false;
      emit("message-reference-click", targetMessageId);
      return;
    }
  }

  const messageTarget = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-message-reference-id]")
    : null;
  const taskTarget = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-task-reference-id]")
    : null;
  const messageId = messageTarget?.dataset.messageReferenceId || "";
  const taskId = taskTarget?.dataset.taskReferenceId || "";
  if (!messageId && !taskId) return;
  event.preventDefault();
  event.stopPropagation();
  readerOpen.value = false;
  if (messageId) {
    emit("message-reference-click", messageId);
    return;
  }
  emit("task-reference-click", taskId);
}

</script>
