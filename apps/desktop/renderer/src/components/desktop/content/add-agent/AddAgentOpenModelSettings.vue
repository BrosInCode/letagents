<template>
  <section
    class="desktop-add-agent-open-model-config"
    data-testid="desktop-add-agent-open-model-config"
    aria-label="Open model configuration"
  >
    <span>Model endpoint</span>
    <label>
      <small>OpenAI-compatible endpoint URL</small>
      <input
        :value="baseUrl"
        type="url"
        placeholder="https://openrouter.ai/api/v1"
        data-testid="desktop-add-agent-open-model-base-url"
        @input="emit('update:baseUrl', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <label>
      <small>Saved default model</small>
      <input
        :value="model"
        type="text"
        placeholder="qwen/qwen3-coder"
        data-testid="desktop-add-agent-open-model-model"
        @input="emit('update:model', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <label>
      <small>Context window in tokens (optional)</small>
      <input
        :value="contextWindow"
        type="number"
        min="2"
        step="1"
        placeholder="Detect from provider"
        data-testid="desktop-add-agent-open-model-context-window"
        @input="emit('update:contextWindow', ($event.target as HTMLInputElement).value)"
      />
      <small>Set the saved model’s limit if your endpoint does not report it.</small>
    </label>
    <label>
      <small>API key {{ hasApiKey ? "(saved - paste to replace)" : "(optional for local endpoints)" }}</small>
      <input
        :value="apiKey"
        type="password"
        autocomplete="off"
        :placeholder="hasApiKey ? '••••••••' : 'sk-or-...'"
        data-testid="desktop-add-agent-open-model-api-key"
        @input="emit('update:apiKey', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <div class="desktop-add-agent-open-model-config-actions">
      <button type="button" :disabled="saving" data-testid="desktop-add-agent-open-model-save" @click="emit('save')">
        {{ saving ? "Saving..." : "Save model settings" }}
      </button>
      <button v-if="hasApiKey" type="button" :disabled="saving" @click="emit('clear-key')">
        Clear saved key
      </button>
    </div>
    <p class="desktop-add-agent-open-model-config-note">
      OpenCode runs the model on this desktop. No OpenCode account is required.
    </p>
    <AddAgentFeedback v-if="error" :message="error" tone="error" />
  </section>
</template>

<script setup lang="ts">
import AddAgentFeedback from "./AddAgentFeedback.vue";
defineProps<{
  baseUrl: string;
  model: string;
  contextWindow: string;
  apiKey: string;
  hasApiKey: boolean;
  saving: boolean;
  error: string | null;
}>();
const emit = defineEmits<{
  "update:baseUrl": [value: string];
  "update:model": [value: string];
  "update:contextWindow": [value: string];
  "update:apiKey": [value: string];
  save: [];
  "clear-key": [];
}>();
</script>
<style scoped src="./AddAgentOpenModelSettings.css"></style>
