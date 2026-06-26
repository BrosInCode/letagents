<template>
  <form class="app-agent-form" :data-busy="busy" @submit.prevent="$emit('submit')">
    <label class="app-agent-command-surface">
      <span class="sr-only">Ask App Agent</span>
      <textarea
        :value="prompt"
        :disabled="busy"
        rows="3"
        placeholder="Ask App Agent to summarize, find, or update this room..."
        data-testid="app-agent-prompt"
        @input="$emit('update:prompt', ($event.target as HTMLTextAreaElement).value)"
      ></textarea>
    </label>
    <div class="app-agent-actions">
      <button
        class="ghost-button app-agent-command-button"
        type="button"
        title="App Agent settings"
        aria-label="Open App Agent settings"
        @click="$emit('open-settings')"
      >
        <Settings aria-hidden="true" />
      </button>
      <button
        class="ghost-button app-agent-command-button app-agent-send-button"
        type="submit"
        :disabled="busy || !prompt.trim()"
        :title="busy ? 'App Agent is working' : 'Ask App Agent'"
        :aria-label="busy ? 'App Agent is working' : 'Ask App Agent'"
        data-testid="app-agent-submit"
      >
        <Send aria-hidden="true" />
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { Send, Settings } from "@lucide/vue";

defineProps<{
  busy: boolean;
  prompt: string;
}>();

defineEmits<{
  "update:prompt": [prompt: string];
  "open-settings": [];
  submit: [];
}>();
</script>
