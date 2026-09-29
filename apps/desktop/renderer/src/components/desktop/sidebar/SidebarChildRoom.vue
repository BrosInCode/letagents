<template>
  <button
    class="room-row room-focus"
    :data-kind="entry.kind"
    :data-active="active"
    :data-unread="entry.hasUnread"
    :data-selected="selected"
    :data-sidebar-entry-id="entry.id"
    :aria-current="active ? 'page' : undefined"
    :aria-pressed="selectable ? selected : undefined"
    :aria-describedby="reorderEnabled ? 'sidebar-room-reorder-instructions' : undefined"
    :aria-keyshortcuts="reorderEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
    :draggable="reorderEnabled"
    type="button"
  >
    <span
      v-if="selectable"
      class="sidebar-child-selection-indicator"
      :data-selected="selected"
      aria-hidden="true"
    >
      <Check v-if="selected" />
    </span>
    <span class="room-title-line">
      <span class="room-title">{{ entry.title }}</span>
      <span v-if="entry.currentWorkspace" class="room-workspace-pill">Current</span>
      <span
        v-if="entry.hasUnread"
        class="room-unread-dot"
        aria-label="Unread messages"
        title="Unread messages"
      ></span>
    </span>
    <small v-if="entry.meta" class="room-child-meta">{{ entry.meta }}</small>
    <small
      v-if="entry.suggestedAction && !entry.currentWorkspace"
      class="room-suggested-action"
    >
      {{ entry.suggestedAction }}
    </small>
  </button>
</template>

<script setup lang="ts">
import { Check } from "@lucide/vue";
import type { RoomEntry } from "../types";

defineProps<{
  entry: RoomEntry;
  active: boolean;
  selected: boolean;
  selectable: boolean;
  reorderEnabled: boolean;
}>();
</script>
