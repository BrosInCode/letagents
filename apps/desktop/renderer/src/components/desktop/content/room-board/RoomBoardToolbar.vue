<template>
  <div class="desktop-board-toolbar">
    <header class="desktop-board-header">
      <div class="desktop-board-heading">
        <h2>Board</h2>
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
            <strong>Manager</strong>
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
          <Plus :size="16" aria-hidden="true" />
          New task
        </button>
      </div>
    </header>
    <div class="desktop-board-controls">
      <div class="desktop-board-filter-groups">
        <DesktopSegmentedControl
          class="desktop-board-segmented"
          :model-value="activeFilter"
          :options="filterOptions"
          label="Board view filters"
          @update:model-value="emit('update:active-filter', $event)"
        />
      </div>
      <label class="desktop-board-search" for="room-board-search">
        <Search :size="16" aria-hidden="true" />
        <span class="sr-only">Search tasks</span>
        <input
          id="room-board-search"
          ref="searchInput"
          :value="searchQuery"
          type="search"
          placeholder="Search tasks..."
          @input="onSearchInput"
        />
      </label>
      <div class="desktop-board-refinements" role="group" aria-label="Task filters and sorting">
        <select :value="ownerFilter" aria-label="Filter by owner" @change="emit('update:owner-filter', selectValue($event))">
          <option v-for="option in ownerOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
        <select :value="statusFilter" aria-label="Filter by status" @change="emit('update:status-filter', selectValue($event))">
          <option v-for="option in statusOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
        <select :value="sort" aria-label="Sort tasks" @change="emit('update:sort', selectValue($event))">
          <option value="recent">Recently updated</option>
          <option value="oldest">Oldest first</option>
          <option value="title">Title A-Z</option>
        </select>
        <button
          v-if="hasFilters"
          class="desktop-board-clear-filter"
          type="button"
          @click="clearFilters"
        >
          <X :size="14" aria-hidden="true" />
          Clear filters
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, Search, X } from "@lucide/vue";
import DesktopSegmentedControl from "../../controls/DesktopSegmentedControl.vue";

const props = defineProps<{
  searchQuery: string;
  activeFilter: string;
  filterOptions: Array<{ id: string; label: string; count?: number }>;
  ownerFilter: string;
  ownerOptions: Array<{ id: string; label: string }>;
  statusFilter: string;
  statusOptions: Array<{ id: string; label: string }>;
  sort: string;
  busy: boolean;
  managerMode: string;
  managerTitle: string;
  pendingIntentCount: number;
  governanceOpen: boolean;
}>();

const countFor = (id: string): number => Number(
  props.filterOptions.find((option) => option.id === id)?.count || 0
);
const searchInput = ref<HTMLInputElement | null>(null);
const hasFilters = computed(() => Boolean(props.searchQuery.trim())
  || props.ownerFilter !== "all" || props.statusFilter !== "all");
const summaryText = computed(() => {
  const open = countFor("open");
  const review = countFor("needs-review");
  const closeout = countFor("closeout");
  if (open === 0 && closeout === 0) return "No tasks yet";
  const openText = `${open} active ${open === 1 ? "task" : "tasks"}`;
  if (review > 0) return `${openText} · ${review} ${review === 1 ? "needs" : "need"} review`;
  if (open === 0) return `${closeout} ${closeout === 1 ? "task" : "tasks"} in closeout`;
  return openText;
});

const emit = defineEmits<{
  "update:search-query": [value: string];
  "update:active-filter": [value: string];
  "update:owner-filter": [value: string];
  "update:status-filter": [value: string];
  "update:sort": [value: string];
  "clear-filters": [];
  "open-governance": [];
  "add-task": [];
}>();

function clearFilters(): void {
  emit("clear-filters");
  searchInput.value?.focus();
}

function onSearchInput(event: Event): void {
  emit("update:search-query", (event.target as HTMLInputElement).value);
}

function selectValue(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}
</script>
