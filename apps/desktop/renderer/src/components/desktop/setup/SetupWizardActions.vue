<template>
  <div class="mcp-wizard-actions" data-testid="mcp-wizard-actions">
    <button
      v-if="wizardStep !== 'choose'"
      class="ghost-button"
      type="button"
      :disabled="busy"
      data-testid="mcp-back-button"
      @click="$emit('back')"
    >
      Back
    </button>

    <button
      v-if="wizardStep === 'choose'"
      class="primary-button"
      type="button"
      :disabled="!selectedTargets.length || busy"
      data-testid="mcp-continue-button"
      @click="$emit('continue')"
    >
      Continue
    </button>

    <button
      v-else-if="wizardStep === 'install'"
      class="primary-button"
      type="button"
      :disabled="!selectedTargets.length || busy || !canInstall"
      data-testid="mcp-install-button"
      @click="$emit('install-targets')"
    >
      {{ installButtonLabel }}
    </button>

    <button
      v-else
      class="primary-button"
      type="button"
      :disabled="busy"
      data-testid="mcp-finish-button"
      @click="$emit('finish')"
    >
      Continue
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopMcpInstallTarget } from "../../../../../electron/ipc-types";
import type { DesktopMcpWizardStep } from "./types";

const props = defineProps<{
  wizardStep: DesktopMcpWizardStep;
  selectedTargets: DesktopMcpInstallTarget[];
  busy: boolean;
  canInstall: boolean;
}>();

defineEmits<{
  continue: [];
  back: [];
  "install-targets": [];
  finish: [];
}>();

const installButtonLabel = computed(() => {
  if (props.busy) return "Installing...";
  if (props.selectedTargets.length <= 1) return "Install LetAgents bridge";
  return `Install in ${props.selectedTargets.length} apps`;
});
</script>
