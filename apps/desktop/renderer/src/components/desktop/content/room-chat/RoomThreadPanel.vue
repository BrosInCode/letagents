<template>
  <aside class="room-thread-panel" data-testid="room-thread-panel" aria-label="Message thread">
    <header class="room-thread-header">
      <div>
        <p>Thread</p>
        <strong>{{ replyCountLabel }}</strong>
      </div>
      <button type="button" aria-label="Close thread" data-testid="room-thread-close" @click="$emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <section class="room-thread-body">
      <article class="room-thread-parent" data-testid="room-thread-parent">
        <div class="room-thread-meta">
          <strong>{{ parentDisplayName }}</strong>
          <time :datetime="parent.timestamp">{{ parentTime }}</time>
        </div>
        <DesktopGitHubEventCard
          v-if="parentGitHubEvent"
          :event="parentGitHubEvent"
          @open-event="$emit('open-github-event', $event)"
        />
        <DesktopLongMessageContent
          v-else
          :text="parent.text || 'No message body.'"
          :html="parentHtml"
          :message-id="`${parent.id}-thread-parent`"
        />
        <DesktopMessageAttachments
          v-if="parent.attachments.length"
          :message-id="parent.id"
          :attachments="parent.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </article>

      <div class="room-thread-divider">
        <span>{{ replyCountLabel }}</span>
      </div>

      <article
        v-for="reply in replies"
        :key="reply.id"
        class="room-thread-reply"
        :class="{ 'is-search-active': reply.id === activeSearchMessageId }"
        :data-testid="`room-thread-reply-${reply.id}`"
      >
        <div class="room-thread-meta">
          <strong>{{ displayName(reply) }}</strong>
          <time :datetime="reply.timestamp">{{ formatTimestamp(reply.timestamp) }}</time>
        </div>
        <DesktopGitHubEventCard
          v-if="githubEvent(reply)"
          :event="githubEvent(reply)!"
          @open-event="$emit('open-github-event', $event)"
        />
        <DesktopLongMessageContent
          v-else
          :text="reply.text || 'No message body.'"
          :html="renderMessageText(reply.text || 'No message body.', searchQuery)"
          :message-id="`${reply.id}-thread-reply`"
        />
        <DesktopMessageAttachments
          v-if="reply.attachments.length"
          :message-id="reply.id"
          :attachments="reply.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </article>

      <p v-if="!replies.length" class="room-thread-empty">No replies yet.</p>
    </section>

    <form class="room-thread-composer" data-testid="room-thread-composer" @submit.prevent="submitThreadReply">
      <textarea
        ref="textareaElement"
        v-model="draft"
        rows="3"
        :disabled="sending || !roomIdentifier"
        :placeholder="composerPlaceholder"
        data-testid="room-thread-composer-input"
        @keydown.enter="handleEnterKey"
      />
      <div class="room-thread-composer-footer">
        <span>{{ roomIdentifier ? "Reply in thread" : "Open a room to reply" }}</span>
        <button type="submit" :disabled="!canSend" data-testid="room-thread-send">
          {{ sending ? "Sending..." : "Reply" }}
        </button>
      </div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import DesktopGitHubEventCard from "../desktop-chat-message/DesktopGitHubEventCard.vue";
import DesktopMessageAttachments from "../desktop-chat-message/DesktopMessageAttachments.vue";
import { parseGitHubEvent } from "../desktop-chat-message/github-event";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import { formatTimestamp, renderMessageText } from "../desktop-chat-message/message-rendering";
import DesktopLongMessageContent from "../DesktopLongMessageContent.vue";

const props = defineProps<{
  parent: DesktopRoomMessage;
  replies: DesktopRoomMessage[];
  roomIdentifier: string | null;
  sending: boolean;
  searchQuery: string;
  activeSearchMessageId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  "open-image": [imageId: string];
  "send-thread-message": [text: string, parentId: string];
  "open-github-event": [url: string];
}>();

const draft = ref("");
const textareaElement = ref<HTMLTextAreaElement | null>(null);

const parentDisplayName = computed(() => displayName(props.parent));
const parentTime = computed(() => formatTimestamp(props.parent.timestamp));
const parentHtml = computed(() => renderMessageText(props.parent.text || "No message body.", ""));
const parentGitHubEvent = computed(() => githubEvent(props.parent));
const replyCountLabel = computed(() => {
  if (props.replies.length === 1) return "1 reply";
  return `${props.replies.length} replies`;
});
const composerPlaceholder = computed(() =>
  props.roomIdentifier ? `Reply to ${parentDisplayName.value}...` : "Open a room to reply"
);
const canSend = computed(() => Boolean(props.roomIdentifier && !props.sending && draft.value.trim()));

watch(
  () => props.parent.id,
  () => {
    draft.value = "";
    void nextTick(() => textareaElement.value?.focus());
  },
  { immediate: true },
);

function displayName(message: DesktopRoomMessage): string {
  return message.agentIdentity?.displayName || parseSenderIdentity(message).displayName;
}

function githubEvent(message: DesktopRoomMessage) {
  return parseGitHubEvent(message);
}

function submitThreadReply(): void {
  const text = draft.value.trim();
  if (!text || !props.roomIdentifier || props.sending) return;
  emit("send-thread-message", text, props.parent.id);
  draft.value = "";
}

function handleEnterKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  submitThreadReply();
}
</script>
