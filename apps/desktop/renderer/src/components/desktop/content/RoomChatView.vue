<template>
  <section class="room-tab-page" data-testid="room-chat-view">
    <div v-if="messages.length" class="room-message-list" data-testid="room-chat-list">
      <article
        v-for="message in messages"
        :key="message.id"
        class="room-message-card"
        :data-testid="`room-message-${message.id}`"
      >
        <div class="room-message-meta">
          <div class="room-message-author-block">
            <strong>{{ message.sender }}</strong>
            <span v-if="message.actorLabel" class="room-message-actor">{{ message.actorLabel }}</span>
          </div>
          <time :datetime="message.timestamp">{{ formatTimestamp(message.timestamp) }}</time>
        </div>

        <div v-if="message.replyTo" class="room-message-reply">
          <span class="room-message-reply-label">Replying to {{ message.replyTo.sender }}</span>
          <p>{{ message.replyTo.text }}</p>
        </div>

        <p class="room-message-body">{{ message.text || "No message body." }}</p>
      </article>
    </div>

    <article v-else class="room-empty-card" data-testid="room-chat-empty">
      <h3>No messages yet</h3>
      <p>This room is ready. Messages will appear here as people and agents start talking.</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { DesktopRoomMessage } from "../../../../../electron/ipc-types";

defineProps<{
  messages: DesktopRoomMessage[];
}>();

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
</script>
