<template>
  <div class="mcp-progress" data-testid="mcp-wizard-progress">
    <span
      v-for="step in steps"
      :key="step.id"
      :data-active="step.id === currentStep"
      :data-complete="step.complete"
      :data-testid="`mcp-progress-${step.id}`"
    >
      <strong>{{ step.step }}</strong>
      <small>{{ step.label }}</small>
    </span>
  </div>
</template>

<script setup lang="ts">
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./types";

type SetupProgressStep = DesktopMcpWizardStep | FirstRunWizardStage;

defineProps<{
  currentStep: SetupProgressStep;
  steps: Array<{
    id: SetupProgressStep;
    step: string;
    label: string;
    complete: boolean;
  }>;
}>();
</script>
