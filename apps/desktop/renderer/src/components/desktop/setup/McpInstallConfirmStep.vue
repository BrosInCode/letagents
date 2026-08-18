<template>
  <div class="mcp-install-step" data-testid="mcp-step-install">
    <ul class="mcp-confirm-targets" aria-label="Selected apps" data-testid="mcp-selected-app">
      <li v-for="target in targets" :key="target.id">
        <span class="mcp-confirm-target-icon">
          <span class="mcp-target-mark" aria-hidden="true">
            <McpHarnessIcon :target-id="target.id" />
          </span>
          <span
            v-if="target.status === 'installed'"
            class="mcp-confirm-target-result"
            data-status="installed"
            aria-label="Installed"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span
            v-else-if="showResult"
            class="mcp-confirm-target-result"
            data-status="failed"
            aria-label="Installation failed"
          >!</span>
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
  showResult?: boolean;
}>();
</script>
