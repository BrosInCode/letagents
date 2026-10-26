<template>
  <article class="room-first-message" :data-testid="`room-first-message-${agent.id}`" :aria-label="`First message to ${name}`">
    <div class="room-first-message-meta">
      <Send :size="12" aria-hidden="true" />
      <span class="room-first-message-label">First message · {{ name }}</span>
      <span class="room-first-message-private" title="It went to the agent directly. Other people in the room don't see it.">only you see this</span>
      <time :datetime="agent.createdAt">{{ time }}</time>
    </div>
    <p class="room-first-message-text">{{ agent.charter.trim() }}</p>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Send } from "@lucide/vue";
import type { DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import { formatDate } from "../../../../domain/formatters";

const props = defineProps<{
  agent: DesktopSupervisorManifestEntry;
}>();

const name = computed(() => props.agent.displayName?.trim() || "the new agent");
const time = computed(() => formatDate("hourMinute", props.agent.createdAt));
</script>
