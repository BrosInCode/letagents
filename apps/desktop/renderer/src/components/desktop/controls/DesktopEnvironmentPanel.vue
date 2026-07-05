<template>
  <aside class="desktop-environment-panel" :aria-label="title" data-testid="desktop-environment-panel">
    <header class="desktop-environment-panel-header">
      <h2>{{ title }}</h2>
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
  showAdd?: boolean;
  addLabel?: string;
}>(), {
  title: "Environment",
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
  gap: 22px;
  width: min(360px, calc(100vw - 32px));
  max-height: min(620px, calc(100% - 20px));
  padding: 24px 28px 32px;
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

.desktop-environment-panel-header h2 {
  margin: 0;
  color: rgba(255, 255, 255, 0.34);
  font-size: 0.82rem;
  font-weight: 500;
  line-height: 1;
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
  gap: 22px;
  padding-bottom: 20px;
}
</style>
