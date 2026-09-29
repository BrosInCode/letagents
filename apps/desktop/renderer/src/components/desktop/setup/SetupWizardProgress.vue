<template>
  <div class="mcp-progress" data-testid="mcp-wizard-progress">
    <span
      v-for="(step, index) in steps"
      :key="step.id"
      :data-active="step.id === currentStep"
      :data-complete="step.complete"
      :data-testid="`mcp-progress-${step.id}`"
      :aria-current="step.id === currentStep ? 'step' : undefined"
      :aria-label="`${step.label}, ${step.complete ? 'complete' : step.id === currentStep ? 'current step' : 'up next'}`"
    >
      <strong aria-hidden="true">
        <Transition name="first-run-progress-glyph" mode="out-in">
          <svg v-if="step.complete" key="complete" viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span v-else key="number">{{ step.step }}</span>
        </Transition>
      </strong>
      <small>{{ step.label }}</small>
      <i v-if="index < steps.length - 1" class="mcp-progress-connector" aria-hidden="true" />
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
