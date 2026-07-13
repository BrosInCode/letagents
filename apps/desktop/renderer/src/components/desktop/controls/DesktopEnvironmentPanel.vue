<template>
  <aside class="desktop-environment-panel" :aria-label="title" data-testid="desktop-environment-panel">
    <header class="desktop-environment-panel-header">
      <div class="desktop-environment-panel-heading">
        <h2 v-if="showTitle">{{ title }}</h2>
        <span v-if="subtitle">{{ subtitle }}</span>
      </div>
      <button
        v-if="showAdd"
        class="desktop-environment-panel-icon-button"
        type="button"
        :aria-label="addLabel"
        @click="emit('add')"
      >
        <Plus :size="20" aria-hidden="true" />
      </button>
    </header>
    <div class="desktop-environment-panel-body">
      <slot />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { Plus } from "@lucide/vue";

withDefaults(defineProps<{
  title?: string;
  subtitle?: string | null;
  showTitle?: boolean;
  showAdd?: boolean;
  addLabel?: string;
}>(), {
  title: "Environment",
  subtitle: null,
  showTitle: true,
  showAdd: false,
  addLabel: "Add environment item",
});

const emit = defineEmits<{
  add: [];
}>();
</script>

<style scoped>
.desktop-environment-panel {
  display: grid;
  gap: 26px;
  width: min(320px, calc(100vw - 32px));
  max-height: min(620px, calc(100% - 20px));
  padding: 27px 30px 44px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 16px;
  background: rgba(18, 18, 18, 0.98);
  box-shadow:
    0 24px 58px rgba(0, 0, 0, 0.46),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.78);
  overflow: auto;
}

.desktop-environment-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.desktop-environment-panel-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.desktop-environment-panel-header h2 {
  margin: 0;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.82);
  font-size: 0.84rem;
  font-weight: 720;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-environment-panel-heading > span {
  flex: 0 1 auto;
  overflow: hidden;
  padding: 4px 7px;
  border: 1px solid rgba(119, 197, 232, 0.18);
  border-radius: 999px;
  background: rgba(119, 197, 232, 0.075);
  color: rgba(181, 222, 241, 0.72);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.64rem;
  font-weight: 650;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-environment-panel-icon-button {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  appearance: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.38);
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}

.desktop-environment-panel-icon-button:hover,
.desktop-environment-panel-icon-button:focus-visible {
  color: rgba(255, 255, 255, 0.78);
  transform: translateY(-1px);
}

.desktop-environment-panel-body {
  display: grid;
  gap: 24px;
}
</style>
