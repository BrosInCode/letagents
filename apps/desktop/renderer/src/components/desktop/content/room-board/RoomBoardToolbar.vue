<template>
  <div class="desktop-board-toolbar">
    <header class="desktop-board-header">
      <div class="desktop-board-heading">
        <h2>Tasks</h2>
        <p>{{ summaryText }}</p>
      </div>
      <div class="desktop-board-header-actions">
        <button
          class="desktop-board-manager-pill"
          type="button"
          :data-mode="managerMode"
          :data-has-pending="pendingIntentCount > 0"
          :title="managerTitle"
          :aria-expanded="governanceOpen"
          aria-haspopup="dialog"
          aria-controls="desktop-board-governance-panel"
          @click="emit('open-governance')"
        >
          <span class="desktop-board-manager-dot" aria-hidden="true"></span>
          <span class="desktop-board-manager-copy">
            <strong>Board manager</strong>
            <small>{{ managerModeLabel }}</small>
          </span>
          <span
            v-if="pendingIntentCount > 0"
            class="desktop-board-manager-pending-count"
            aria-label="Pending board intents"
          >
            {{ pendingIntentCount }}
          </span>
        </button>
        <button
          class="desktop-board-primary-action desktop-board-add-button"
          type="button"
          :disabled="busy"
          @click="emit('add-task')"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          </svg>
          New task
        </button>
      </div>
    </header>
    <div class="desktop-board-controls">
      <label class="desktop-board-search" for="room-board-search">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
        </svg>
        <span class="sr-only">Search tasks</span>
        <input
          id="room-board-search"
          :value="searchQuery"
          type="search"
          placeholder="Search tasks, owners, or links"
          @input="onSearchInput"
        />
      </label>
      <div class="desktop-board-filter-groups">
        <DesktopSegmentedControl
          class="desktop-board-segmented"
          :model-value="activeFilter"
          :options="filterOptions"
          label="Board view filters"
          @update:model-value="emit('update:active-filter', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import DesktopSegmentedControl from "../../controls/DesktopSegmentedControl.vue";

const props = defineProps<{
  searchQuery: string;
  activeFilter: string;
  filterOptions: Array<{ id: string; label: string; count?: number }>;
  busy: boolean;
  managerMode: string;
  managerTitle: string;
  pendingIntentCount: number;
  governanceOpen: boolean;
}>();

const managerModeLabel = computed(() => {
  if (props.managerMode === "intent_required") return "Approval required";
  if (props.managerMode === "off") return "Off";
  return "Optional";
});

const countFor = (id: string): number => Number(
  props.filterOptions.find((option) => option.id === id)?.count || 0
);
const summaryText = computed(() => {
  const open = countFor("open");
  const review = countFor("needs-review");
  const closeout = countFor("closeout");
  if (open === 0 && closeout === 0) return "Track ownership and move work through review.";
  const openText = `${open} active ${open === 1 ? "task" : "tasks"}`;
  if (review > 0) return `${openText} · ${review} ${review === 1 ? "needs" : "need"} review`;
  if (open === 0) return `${closeout} ${closeout === 1 ? "task" : "tasks"} in closeout`;
  return openText;
});

const emit = defineEmits<{
  "update:search-query": [value: string];
  "update:active-filter": [value: string];
  "open-governance": [];
  "add-task": [];
}>();

function onSearchInput(event: Event): void {
  emit("update:search-query", (event.target as HTMLInputElement).value);
}
</script>
