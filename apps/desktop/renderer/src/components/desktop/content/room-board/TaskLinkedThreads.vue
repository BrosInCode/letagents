<template>
  <section class="desktop-task-detail-section" aria-label="Linked threads" data-testid="task-linked-threads">
    <h4>Linked threads</h4>
    <p v-if="mentionsError" class="desktop-task-detail-muted">{{ mentionsError }}</p>
    <p v-else-if="mentionsLoading && !mentions.length" class="desktop-task-detail-muted">Loading threads...</p>
    <p v-else-if="!mentions.length" class="desktop-task-detail-muted">No room message names {{ ticketKey }} yet.</p>
    <div v-else class="desktop-task-detail-list">
      <button
        v-for="mention in mentions"
        :key="mention.messageId"
        type="button"
        class="desktop-task-detail-link desktop-task-mention"
        @click="emit('open-thread', mention.threadRootId)"
      >
        <small>{{ compactPerson(mention.sender) || mention.sender }} · {{ relativeTime(mention.timestamp, now) }}</small>
        <span>{{ mention.text }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { DesktopTaskMention } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import { useNow } from "../../../../composables/useNow";
import { compactPerson, relativeTime } from "./formatters";

/**
 * Room messages that name a card's ticket (`task_mentions`). Used by the board
 * inspector and by My work's ticket detail. Only cards that name a ticket
 * render it, so other cards make no call.
 */
const props = defineProps<{
  roomIdentifier?: string;
  taskId: string;
  ticketKey: string;
  /** Re-reads the list when it changes (the card's `updatedAt`). */
  revision?: string | null;
}>();

const emit = defineEmits<{ "open-thread": [threadRootId: string] }>();

// Labels such as "2m ago" move on with the shared clock even when the data is unchanged.
const now = useNow(30_000);
const mentions = ref<DesktopTaskMention[]>([]);
const mentionsLoading = ref(false);
const mentionsError = ref<string | null>(null);
let mentionsRequest = 0;

watch(
  () => [props.roomIdentifier, props.taskId, props.ticketKey, props.revision] as const,
  async ([roomIdentifier, taskId]) => {
    const request = ++mentionsRequest;
    if (!roomIdentifier) {
      mentions.value = [];
      mentionsError.value = null;
      return;
    }
    mentionsLoading.value = true;
    try {
      const next = await desktopIpc.room.getTaskMentions(roomIdentifier, taskId);
      if (request !== mentionsRequest) return;
      mentions.value = next;
      mentionsError.value = null;
    } catch {
      if (request !== mentionsRequest) return;
      mentionsError.value = "Linked threads could not be loaded.";
    } finally {
      if (request === mentionsRequest) mentionsLoading.value = false;
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.desktop-task-mention { width: 100%; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
.desktop-task-mention span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
</style>
