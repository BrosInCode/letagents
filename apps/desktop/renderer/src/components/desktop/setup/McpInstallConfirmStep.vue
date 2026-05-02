<template>
  <div class="mcp-install-step" data-testid="mcp-step-install">
    <div class="mcp-selected-app" data-testid="mcp-selected-app">
      <span class="mcp-target-stack" aria-hidden="true">
        <span
          v-for="target in targets"
          :key="target.id"
          class="mcp-target-mark"
        >
          <McpHarnessIcon :target-id="target.id" />
        </span>
      </span>
      <span>
        <strong>{{ title }}</strong>
        <small>{{ subtitle }}</small>
      </span>
    </div>
    <p>LetAgents will add the MCP connection to {{ targetLabel }}.</p>
    <p class="mcp-install-note">LetAgents updates the app's local MCP settings. Your code stays on this machine.</p>
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
  if (props.targets.length === 1) return props.targets[0]?.name || "Choose an app";
  return `${props.targets.length} apps selected`;
});

const subtitle = computed(() => {
  if (props.targets.length === 1) return props.targets[0]?.configPath || "No app selected yet.";
  return props.targets.map((target) => target.name).join(", ");
});

const targetLabel = computed(() => {
  if (props.targets.length === 1) return props.targets[0]?.name || "this app";
  return "these apps";
});
</script>
