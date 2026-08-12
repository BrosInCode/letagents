<template>
  <div class="mcp-done-step" data-testid="mcp-step-done">
    <div class="mcp-done-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img" aria-label="Ready">
        <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <div class="mcp-done-copy">
      <span>Bridge installed</span>
      <strong>{{ title }}</strong>
      <p>{{ doneCopy }}</p>
    </div>
    <ul class="mcp-done-targets" aria-label="Ready apps">
      <li v-for="target in targets" :key="target.id">
        <span class="mcp-target-mark" aria-hidden="true">
          <McpHarnessIcon :target-id="target.id" />
        </span>
        <span>
          <strong>{{ target.name }}</strong>
          <small>{{ target.id === "codex" ? "CLI checked, bridge added" : "MCP bridge added" }}</small>
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopMcpInstallTarget } from "../../../../../electron/ipc-types";
import McpHarnessIcon from "./McpHarnessIcon.vue";

const props = defineProps<{
  targets: DesktopMcpInstallTarget[];
}>();

const title = computed(() => {
  if (props.targets.length === 1) return `${props.targets[0]?.name || "Your app"} is connected.`;
  return `${props.targets.length} agent apps are connected.`;
});

const restartLabel = computed(() => {
  if (props.targets.length === 1) return props.targets[0]?.name || "the app";
  return "those apps";
});

const doneCopy = computed(() => {
  return `Restart or reconnect ${restartLabel.value} so the new LetAgents bridge is loaded.`;
});
</script>
