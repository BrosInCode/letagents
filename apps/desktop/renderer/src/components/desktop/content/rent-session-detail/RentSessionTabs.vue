<template>
  <nav class="rent-detail-tabs" role="tablist" aria-label="Session sections">
    <button
      v-for="tab in rentSessionDetailTabs"
      :key="tab.id"
      type="button"
      role="tab"
      :data-active="modelValue === tab.id"
      :data-testid="`rent-detail-tab-${tab.id}`"
      @click="$emit('update:modelValue', tab.id)"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>

<script setup lang="ts">
import { rentSessionDetailTabs, type RentSessionDetailTab } from "./tabs";

defineProps<{
  modelValue: RentSessionDetailTab;
}>();

defineEmits<{
  "update:modelValue": [value: RentSessionDetailTab];
}>();
</script>

<style scoped>
.rent-detail-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1.25rem 0.5rem;
}
.rent-detail-tabs button {
  appearance: none;
  background: transparent;
  color: inherit;
  border: none;
  padding: 0.4rem 0.85rem;
  font: inherit;
  font-size: 0.85rem;
  border-radius: 999px;
  cursor: pointer;
}
.rent-detail-tabs button[data-active="true"] {
  background: var(--color-accent, #4f7cff);
  color: white;
}
</style>
