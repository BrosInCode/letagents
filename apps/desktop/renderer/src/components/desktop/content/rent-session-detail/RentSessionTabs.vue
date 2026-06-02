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
