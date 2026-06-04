<template>
  <aside class="settings-shell-sidebar" data-testid="settings-sidebar">
    <button class="settings-back-button" type="button" data-testid="settings-back-to-app" @click="$emit('back')">
      <ArrowLeft aria-hidden="true" />
      <span>Back to app</span>
    </button>

    <div class="settings-brand">
      <span class="settings-brand-mark" aria-hidden="true">LA</span>
      <div>
        <h2>Settings</h2>
        <p>Account, storage, setup</p>
      </div>
    </div>

    <nav class="settings-nav" aria-label="Settings sections">
      <section v-for="group in groups" :key="group.label" class="settings-nav-group">
        <p class="settings-nav-heading">{{ group.label }}</p>
        <button
          v-for="item in group.items"
          :key="item.id"
          class="settings-nav-row"
          :data-active="activePane === item.id"
          type="button"
          :data-testid="`settings-nav-${item.id}`"
          @click="$emit('select', item.id)"
        >
          <span class="settings-nav-icon" aria-hidden="true">
            <component :is="item.icon" />
          </span>
          <span class="settings-nav-copy">
            <span>{{ item.title }}</span>
            <small>{{ item.description }}</small>
          </span>
        </button>
      </section>
    </nav>
  </aside>
</template>

<script setup lang="ts">
import { ArrowLeft } from "@lucide/vue";
import type { SettingsNavGroup, SettingsPaneId } from "./types";

defineProps<{
  groups: SettingsNavGroup[];
  activePane: SettingsPaneId;
}>();

defineEmits<{
  back: [];
  select: [paneId: SettingsPaneId];
}>();
</script>
