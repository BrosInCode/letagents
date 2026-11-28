<template>
  <span
    v-if="count > 0 || markedUnread"
    :class="count > 0 ? 'room-unread-badge' : 'room-unread-dot'"
    :data-mention="mentioned ? 'true' : undefined"
    :aria-label="resolvedLabel"
    :title="resolvedLabel"
  >{{ text }}</span>
</template>

<!-- An unread mention of the viewer turns the number into "@", a different
     kind of notification from "new messages". The exact counts stay in the
     label and tooltip. -->
<script setup lang="ts">
import { computed } from "vue";
import { describeUnreadMentions } from "../../../domain/sidebar-room-display";

const props = defineProps<{ count: number; markedUnread?: boolean; label?: string; mentionCount?: number }>();
const mentioned = computed(() => props.count > 0 && (props.mentionCount || 0) > 0);
const text = computed(() => {
  if (mentioned.value) return "@";
  return props.count > 0 ? (props.count > 99 ? "99+" : String(props.count)) : "";
});
const resolvedLabel = computed(() => {
  const base = props.label
    || (props.count > 0 ? `${props.count} unread message${props.count === 1 ? "" : "s"}` : "Marked unread");
  return mentioned.value ? `${base}, ${describeUnreadMentions(props.mentionCount || 0)}` : base;
});
</script>
