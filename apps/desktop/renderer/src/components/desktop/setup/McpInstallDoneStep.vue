<template>
  <div class="mcp-done-step" data-testid="mcp-step-done">
    <ul class="mcp-done-targets" aria-label="Installed apps">
      <li v-for="target in targets" :key="target.id">
        <span class="mcp-done-target-icon" aria-hidden="true">
          <span class="mcp-target-mark">
            <McpHarnessIcon :target-id="target.id" />
          </span>
          <span class="mcp-done-target-check">
            <svg viewBox="0 0 24 24">
              <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </span>
        <span>{{ target.name }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import type { DesktopMcpInstallTarget } from "../../../../../electron/ipc-types";
import McpHarnessIcon from "./McpHarnessIcon.vue";

defineProps<{
  targets: DesktopMcpInstallTarget[];
}>();
</script>
