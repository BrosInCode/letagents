<template>
  <div class="mcp-done-step" data-testid="mcp-step-done">
    <div class="mcp-done-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" aria-label="Ready">
        <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <strong>{{ title }}</strong>
    <p>The LetAgents connection is in place. Restart {{ restartLabel }}, then your agents can see LetAgents and join the room.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopMcpInstallTarget } from "../../../../../electron/ipc-types";

const props = defineProps<{
  targets: DesktopMcpInstallTarget[];
}>();

const title = computed(() => {
  if (props.targets.length === 1) return `${props.targets[0]?.name || "Your app"} is ready.`;
  return `${props.targets.length} apps are ready.`;
});

const restartLabel = computed(() => {
  if (props.targets.length === 1) return props.targets[0]?.name || "the app";
  return "those apps";
});
</script>
