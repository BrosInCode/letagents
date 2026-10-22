<template>
  <section class="settings-panel" data-testid="settings-mcp-panel">
    <div class="settings-mcp-head">
      <p class="settings-control-description">Agent apps on this computer that run LetAgents as a local MCP server.</p>
      <button class="ghost-button" type="button" data-testid="settings-mcp-connect" @click="$emit('connect')">Connect an agent app</button>
    </div>
    <div class="surface-list settings-system-list">
      <article
        v-for="target in mcpInstallState.targets"
        :key="target.id"
        class="surface-row"
        :data-testid="`settings-mcp-target-${target.id}`"
      >
        <div>
          <p class="surface-title">{{ target.name }}</p>
          <p class="surface-subtitle">{{ target.configPath }}</p>
          <p v-if="target.configIssue" class="surface-subtitle">{{ target.configIssue }}</p>
          <ul v-if="target.configPaths?.length" class="settings-mcp-config-paths">
            <li v-for="configPath in target.configPaths" :key="configPath.path">
              <span>{{ configPath.label }}:</span>
              <em :data-status="configPath.status">{{ configPathStatusLabel(configPath.status) }}</em>
              <code>{{ configPath.path }}</code>
              <small v-if="configPath.issue">{{ configPath.issue }}</small>
            </li>
          </ul>
        </div>
        <div class="surface-meta">
          <span class="state-pill" :data-state="target.status === 'installed' ? 'installed' : 'starting'">
            {{ target.status.replace(/_/g, " ") }}
          </span>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DesktopMcpInstallState } from "../../../../../../electron/ipc-types";
import { configPathStatusLabel } from "../presentation";

defineProps<{
  mcpInstallState: DesktopMcpInstallState;
}>();

defineEmits<{
  /** Open the setup flow for another agent app. */
  connect: [];
}>();
</script>

<style scoped>
.settings-mcp-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.settings-mcp-head p {
  margin: 0;
}
</style>
