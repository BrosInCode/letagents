<template>
  <section class="settings-panel settings-setup-panel" data-testid="settings-setup-panel">
    <McpInstallOnboardingView
      :state="mcpInstallState"
      :selected-target-ids="selectedMcpTargetIds"
      :wizard-step="mcpWizardStep"
      :busy="mcpInstallBusy"
      :feedback="mcpInstallFeedback"
      :can-install="setupApiAvailable"
      @select-target="$emit('select-mcp-target', $event)"
      @select-all-targets="$emit('select-all-mcp-targets')"
      @clear-target-selection="$emit('clear-mcp-target-selection')"
      @continue="$emit('continue-mcp')"
      @back="$emit('back-mcp')"
      @install-targets="$emit('install-mcp-targets')"
      @finish="$emit('finish-mcp')"
    />
  </section>
</template>

<script setup lang="ts">
import type {
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
} from "../../../../../../electron/ipc-types";
import McpInstallOnboardingView from "../../content/McpInstallOnboardingView.vue";
import type { DesktopMcpWizardStep } from "../../setup/types";

defineProps<{
  mcpInstallState: DesktopMcpInstallState;
  selectedMcpTargetIds: DesktopMcpInstallTargetId[];
  mcpWizardStep: DesktopMcpWizardStep;
  mcpInstallBusy: boolean;
  mcpInstallFeedback: string | null;
  setupApiAvailable: boolean;
}>();

defineEmits<{
  "back-mcp": [];
  "clear-mcp-target-selection": [];
  "continue-mcp": [];
  "finish-mcp": [];
  "install-mcp-targets": [];
  "select-all-mcp-targets": [];
  "select-mcp-target": [targetId: DesktopMcpInstallTargetId];
}>();
</script>
