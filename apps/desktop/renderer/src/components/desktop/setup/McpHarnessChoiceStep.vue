<template>
  <div
    class="mcp-choice-step"
    role="group"
    aria-label="Choose where to install the LetAgents MCP"
    data-testid="mcp-step-choose"
  >
    <button
      v-for="target in targets"
      :key="target.id"
      class="mcp-choice-card"
      type="button"
      :data-selected="selectedTargetIdSet.has(target.id)"
      :data-status="target.status"
      :data-testid="`mcp-target-${target.id}`"
      :aria-label="`${target.name}. Install the LetAgents MCP here.`"
      :aria-pressed="selectedTargetIdSet.has(target.id)"
      @click="$emit('select-target', target.id)"
    >
      <span class="mcp-choice-icon" aria-hidden="true">
        <span class="mcp-target-mark">
          <McpHarnessIcon :target-id="target.id" />
        </span>
        <span class="mcp-choice-check">
          <svg viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </span>
      <strong class="mcp-choice-name">{{ target.name }}</strong>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopMcpInstallTarget, DesktopMcpInstallTargetId } from "../../../../../electron/ipc-types";
import McpHarnessIcon from "./McpHarnessIcon.vue";

const props = defineProps<{
  targets: DesktopMcpInstallTarget[];
  selectedTargetIds: DesktopMcpInstallTargetId[];
}>();

defineEmits<{
  "select-target": [targetId: DesktopMcpInstallTargetId];
}>();

const selectedTargetIdSet = computed(() => new Set(props.selectedTargetIds));
</script>
