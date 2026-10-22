<template>
  <span class="connector-logo" :data-provider="provider" aria-hidden="true"
    ><img v-if="image" :src="image" alt="" /><svg
      v-else
      viewBox="0 0 24 24"
      fill="none"
    >
      <template v-if="provider === 'jira'">
        <path d="m12 2 10 10-10 10L2 12Z" fill="currentColor" stroke="none" />
        <path d="m12 8 4 4-4 4-4-4Z" fill="var(--connector-bg)" stroke="none" />
      </template>
      <template v-else-if="provider === 'linear'">
        <circle cx="12" cy="12" r="9" />
        <path d="m6 6 12 12M4 10l10 10M10 4l10 10m-16 0 6 6" />
      </template>
      <path
        v-else-if="provider === 'github'"
        d="M9 20c-4 1-4-2-6-2m12 4v-3.5c0-1 .1-1.5-.5-2 3-.3 6-1.5 6-6a4.7 4.7 0 0 0-1.3-3.3A4.5 4.5 0 0 0 19 4s-1.1-.3-3.5 1.3a12 12 0 0 0-7 0C6 3.7 5 4 5 4a4.5 4.5 0 0 0-.2 3.2A4.7 4.7 0 0 0 3.5 10.5c0 4.5 3 5.7 6 6-.6.5-.5 1.1-.5 2V22"
      />
      <path v-else d="M6 18a5 5 0 1 1 1-9 6 6 0 0 1 11 1 4 4 0 0 1 0 8Z" /></svg
  ></span>
</template>
<script setup lang="ts">
import { computed } from "vue";
import codex from "../../../apps/desktop/renderer/src/assets/harness-icons/codex.png";
import claude from "../../../apps/desktop/renderer/src/assets/harness-icons/claude-code.png";
import cursor from "../../../apps/desktop/renderer/src/assets/harness-icons/cursor.png";
import antigravity from "../../../apps/desktop/renderer/src/assets/harness-icons/antigravity.png";
const props = defineProps<{ provider: string }>();
const images: Record<string, string> = {
  codex,
  "claude-code": claude,
  cursor,
  antigravity,
};
const image = computed(() => images[props.provider]);
</script>
