<template>
  <section class="desktop-add-agent-delivery desktop-add-agent-model" aria-label="Agent model">
    <div class="desktop-add-agent-section-heading">
      <span>Model &amp; reasoning</span>
      <button type="button" :disabled="loading" data-testid="desktop-add-agent-model-refresh" @click="emit('refresh')">
        {{ loading ? "Loading..." : "Refresh models" }}
      </button>
    </div>
    <div class="desktop-add-agent-model-grid" :data-single="!showEffort">
      <div class="desktop-add-agent-setting">
        <DesktopModelPicker
          :model-value="modelChoice"
          :options="modelOptions"
          label="Model"
          id="desktop-add-agent-model-select"
          described-by="desktop-add-agent-model-description"
          test-id="desktop-add-agent-model-select"
          @update:model-value="emit('update:modelChoice', $event)"
        />
        <label v-if="custom" class="desktop-add-agent-model-custom-input">
          <small>Model id</small>
          <input
            :value="customModelId"
            type="text"
            placeholder="provider/model-or-alias"
            data-testid="desktop-add-agent-model-custom-input"
            @input="emit('update:customModelId', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <p id="desktop-add-agent-model-description">{{ modelDescription }}</p>
      </div>
      <div v-if="showEffort" class="desktop-add-agent-setting">
        <DesktopSelectField
          :model-value="effort"
          :options="effortOptions"
          label="Effort"
          id="desktop-add-agent-effort-select"
          described-by="desktop-add-agent-effort-description"
          test-id="desktop-add-agent-effort-select"
          @update:model-value="emit('update:effort', $event)"
        />
        <p id="desktop-add-agent-effort-description">{{ effortDescription }}</p>
      </div>
    </div>
    <p
      class="desktop-add-agent-model-catalog"
      :data-tone="catalogError ? 'error' : 'status'"
      :role="catalogError ? 'alert' : 'status'"
      :aria-live="catalogError ? 'assertive' : 'polite'"
      aria-atomic="true"
    >{{ catalogLabel }}</p>
  </section>
</template>

<script setup lang="ts">
import type { DesktopSelectOption } from "../../controls/DesktopSelectField.vue";
import DesktopSelectField from "../../controls/DesktopSelectField.vue";
import DesktopModelPicker from "../../controls/DesktopModelPicker.vue";

defineProps<{
  loading: boolean;
  modelChoice: string;
  modelOptions: DesktopSelectOption[];
  custom: boolean;
  customModelId: string;
  modelDescription: string;
  showEffort: boolean;
  effort: string;
  effortOptions: DesktopSelectOption[];
  effortDescription: string;
  catalogLabel: string;
  catalogError: boolean;
}>();
const emit = defineEmits<{
  refresh: [];
  "update:modelChoice": [value: string];
  "update:customModelId": [value: string];
  "update:effort": [value: string];
}>();
</script>
<style scoped src="./AddAgentFormField.css"></style>
<style scoped src="./AddAgentModelSettings.css"></style>
