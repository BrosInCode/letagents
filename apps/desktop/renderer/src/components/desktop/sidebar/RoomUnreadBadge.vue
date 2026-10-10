<template>
  <span
    v-if="count > 0 || markedUnread"
    :class="count > 0 ? 'room-unread-badge' : 'room-unread-dot'"
    :aria-label="label"
    :title="label"
  >{{ count > 0 ? (count > 99 ? "99+" : count) : "" }}</span>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ count: number; markedUnread?: boolean }>();
const label = computed(() => props.count > 0 ? `${props.count} unread message${props.count === 1 ? "" : "s"}` : "Marked unread");
</script>
