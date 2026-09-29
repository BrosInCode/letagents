<template>
  <aside class="settings-shell-sidebar" data-testid="settings-sidebar">
    <button class="settings-back-button" type="button" data-testid="settings-back-to-app" @click="$emit('back')">
      <ArrowLeft aria-hidden="true" />
      <span>Back to app</span>
    </button>

    <div class="settings-brand">
      <div>
        <h2>Settings</h2>
        <p>Make LetAgents yours</p>
      </div>
    </div>

    <label class="settings-sidebar-search">
      <Search aria-hidden="true" />
      <input v-model="query" type="search" aria-label="Find a setting" placeholder="Find a setting…" />
    </label>

    <nav class="settings-nav" aria-label="Settings sections">
      <section v-for="group in visibleGroups" :key="group.label" class="settings-nav-group">
        <p class="settings-nav-heading">{{ group.label }}</p>
        <button
          v-for="item in group.items"
          :key="item.id"
          class="settings-nav-row"
          :data-active="(query.trim() ? activePane : settingsSectionFor(activePane)) === item.id"
          :aria-current="(query.trim() ? activePane : settingsSectionFor(activePane)) === item.id ? 'page' : undefined"
          type="button"
          :data-testid="`settings-nav-${item.id}`"
          @click="$emit('select', item.id)"
        >
          <span class="settings-nav-icon" aria-hidden="true">
            <component :is="item.icon" />
          </span>
          <span class="settings-nav-copy">
            <span>{{ item.title }}</span>
          </span>
        </button>
      </section>
      <p v-if="!visibleGroups.length" class="settings-search-empty" role="status">No settings match “{{ query }}”. Try a different word.</p>
    </nav>
  </aside>
</template>

<script setup lang="ts">
import { ArrowLeft, Search } from "@lucide/vue";
import { computed, ref } from "vue";
import { filterSettingsNavigation, settingsSectionFor } from "./navigation";
import type { SettingsPaneId } from "./types";

defineProps<{
  activePane: SettingsPaneId;
}>();

const query = ref("");
const visibleGroups = computed(() => filterSettingsNavigation(query.value));

defineEmits<{
  back: [];
  select: [paneId: SettingsPaneId];
}>();
</script>
