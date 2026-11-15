<template>
  <section class="desktop-add-agent-delivery desktop-add-agent-model" aria-label="Agent model">
    <div class="desktop-add-agent-section-heading">
      <button type="button" :disabled="loading" :aria-label="loading ? 'Refreshing models' : 'Refresh models'" title="Refresh models" data-testid="desktop-add-agent-model-refresh" @click="emit('refresh')">
        <RefreshCw :size="14" aria-hidden="true" />
      </button>
    </div>
    <div class="desktop-add-agent-model-grid" :data-single="!showEffort">
      <div class="desktop-add-agent-setting">
        <DesktopModelPicker
          :model-value="modelChoice"
          :options="modelOptions"
          label="Model"
          id="desktop-add-agent-model-select"
          :described-by="cliUpdate ? 'desktop-add-agent-model-description desktop-add-agent-model-cli-update' : 'desktop-add-agent-model-description'"
          test-id="desktop-add-agent-model-select"
          @update:model-value="emit('update:modelChoice', $event)"
        />
        <label v-if="custom" class="desktop-add-agent-model-custom-input">
          <small>Model id</small>
          <input
            :value="customModelId"
            type="text"
            placeholder="provider/model-or-alias"
            :aria-invalid="Boolean(customModelError)"
            :aria-describedby="customModelError ? 'desktop-add-agent-model-custom-error' : undefined"
            data-testid="desktop-add-agent-model-custom-input"
            @input="emit('update:customModelId', ($event.target as HTMLInputElement).value)"
          />
          <span
            v-if="customModelError"
            id="desktop-add-agent-model-custom-error"
            class="desktop-add-agent-model-custom-error"
            role="alert"
          >{{ customModelError }}</span>
        </label>
        <p id="desktop-add-agent-model-description">{{ modelDescription }}</p>
      </div>
      <div v-if="showEffort" class="desktop-add-agent-setting">
        <AgentEffortControl
          :model-value="effort"
          :options="effortOptions"
          data-testid="desktop-add-agent-effort-select"
          @update:model-value="emit('update:effort', $event)"
        />
        <p id="desktop-add-agent-effort-description">{{ effortDescription }}</p>
      </div>
    </div>
    <p
      v-if="catalogError"
      class="desktop-add-agent-model-catalog"
      :data-tone="catalogError ? 'error' : 'status'"
      :role="catalogError ? 'alert' : 'status'"
      :aria-live="catalogError ? 'assertive' : 'polite'"
      aria-atomic="true"
    >{{ catalogLabel }}</p>
    <p
      v-else-if="cliUpdate"
      id="desktop-add-agent-model-cli-update"
      class="desktop-add-agent-model-catalog"
      data-tone="status"
      data-testid="desktop-add-agent-model-cli-update"
    >{{ cliUpdate.message }} Run <code>{{ cliUpdate.command }}</code>, then
      <button type="button" class="desktop-add-agent-model-refresh-link" :disabled="loading" @click="emit('refresh')">{{ loading ? "refreshing…" : "refresh models" }}</button>.</p>
  </section>
</template>

<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
import type { DesktopSelectOption } from "../../controls/DesktopSelectField.vue";
import AgentEffortControl from "../../../../../../../../shared/ui/agent-identity/AgentEffortControl.vue";
import DesktopModelPicker from "../../controls/DesktopModelPicker.vue";

defineProps<{
  loading: boolean;
  modelChoice: string;
  modelOptions: DesktopSelectOption[];
  custom: boolean;
  customModelId: string;
  customModelError?: string | null;
  modelDescription: string;
  showEffort: boolean;
  effort: string;
  effortOptions: DesktopSelectOption[];
  effortDescription: string;
  catalogLabel: string;
  catalogError: boolean;
  /** Models the installed CLI is too old to list, and the command that updates it. */
  cliUpdate?: { message: string; command: string } | null;
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
