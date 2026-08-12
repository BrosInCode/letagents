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
    <p>{{ actionCopy }}</p>
    <p class="mcp-install-note">{{ noteCopy }}</p>
    <ul class="mcp-config-paths" aria-label="Config paths">
      <li v-for="configPath in configPaths" :key="configPath.path" :data-status="configPath.status">
        <span class="mcp-config-path-heading">
          <span>{{ configPath.label }}</span>
          <em :data-status="configPath.status">{{ configPathStatusLabel(configPath.status) }}</em>
        </span>
        <code>{{ configPath.path }}</code>
        <small v-if="configPath.issue">{{ configPath.issue }}</small>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopMcpInstallConfigPath,
  DesktopMcpInstallTarget,
} from "../../../../../electron/ipc-types";
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

const configPaths = computed<DesktopMcpInstallConfigPath[]>(() => {
  return props.targets.flatMap((target) =>
    target.configPaths?.length
      ? target.configPaths
      : [{
          path: target.configPath,
          label: target.name,
          status: target.status,
          hasLetAgents: target.status !== "not_installed",
          issue: target.configIssue,
        }]
  );
});

function configPathStatusLabel(
  status: DesktopMcpInstallConfigPath["status"],
): string {
  if (status === "installed") return "Ready";
  if (status === "needs_attention") return "Repair";
  return "Not installed";
}

const actionCopy = computed(() =>
  `LetAgents will add the MCP connection to ${targetLabel.value}. Provider CLIs stay user-managed.`,
);

const noteCopy = computed(() => {
  return "LetAgents updates the app's local MCP settings. Your code stays on this machine.";
});
</script>
