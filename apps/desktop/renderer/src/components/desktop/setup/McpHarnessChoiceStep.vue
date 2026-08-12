<template>
  <div class="mcp-choice-step" data-testid="mcp-step-choose">
    <button
      v-for="target in targets"
      :key="target.id"
      class="mcp-choice-card"
      type="button"
      :data-selected="selectedTargetIdSet.has(target.id)"
      :data-status="target.status"
      :data-testid="`mcp-target-${target.id}`"
      :aria-label="targetAriaLabel(target)"
      :aria-pressed="selectedTargetIdSet.has(target.id)"
      @click="$emit('select-target', target.id)"
    >
      <span class="mcp-target-mark" aria-hidden="true">
        <McpHarnessIcon :target-id="target.id" />
      </span>
      <span class="mcp-target-main">
        <strong>{{ target.name }}</strong>
        <small>{{ target.description }}</small>
        <span class="mcp-target-capabilities" aria-hidden="true">
          <span v-for="capability in targetCapabilities(target)" :key="capability">
            {{ capability }}
          </span>
        </span>
        <small v-if="target.configIssue" class="mcp-target-config-issue">
          {{ target.configIssue }}
        </small>
      </span>
      <span class="mcp-target-status" :data-status="target.status">
        {{ statusLabel(target.status) }}
      </span>
      <span class="mcp-choice-check" aria-hidden="true">
        <svg v-if="selectedTargetIdSet.has(target.id)" viewBox="0 0 24 24">
          <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>

    <div class="mcp-choice-tools" data-testid="mcp-choice-tools">
      <button class="ghost-button" type="button" data-testid="mcp-select-all" @click="$emit('select-all')">
        Select all
      </button>
      <button class="ghost-button" type="button" data-testid="mcp-clear-selection" @click="$emit('clear-selection')">
        Clear
      </button>
    </div>
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
  "select-all": [];
  "clear-selection": [];
}>();

const selectedTargetIdSet = computed(() => new Set(props.selectedTargetIds));

function statusLabel(status: DesktopMcpInstallTarget["status"]): string {
  if (status === "installed") return "Ready";
  if (status === "needs_attention") return "Repair";
  return "Not installed";
}

function targetAriaLabel(target: DesktopMcpInstallTarget): string {
  const issue = target.configIssue ? ` Issue: ${target.configIssue}.` : "";
  return `${target.name}. ${target.description} Setup actions: ${targetCapabilities(target).join(", ")}. Status: ${statusLabel(target.status)}.${issue}`;
}

function targetCapabilities(target: DesktopMcpInstallTarget): string[] {
  if (target.id === "codex") return ["Keep your Codex CLI", "Add MCP bridge"];
  return ["Add MCP bridge"];
}
</script>
