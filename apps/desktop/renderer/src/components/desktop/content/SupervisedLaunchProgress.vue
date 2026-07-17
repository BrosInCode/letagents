<template>
  <div
    class="supervised-launch-progress"
    data-testid="supervised-launch-progress"
    :data-state="progress.ready ? 'ready' : progress.failed ? 'failed' : progress.stopped ? 'stopped' : 'launching'"
  >
    <div class="supervised-launch-progress-header">
      <span class="supervised-launch-progress-provider">{{ progress.providerLabel }}</span>
      <strong data-testid="supervised-launch-headline">{{ progress.headline }}</strong>
      <small
        v-if="progress.ready && progress.agentName"
        data-testid="supervised-launch-ready-name"
      >{{ progress.agentName }} joined the room.</small>
    </div>

    <ol class="supervised-launch-phases" aria-label="Launch progress">
      <li
        v-for="phase in progress.phases"
        :key="phase.id"
        class="supervised-launch-phase"
        :data-state="phase.state"
        :data-testid="`supervised-launch-phase-${phase.id}`"
      >
        <span class="supervised-launch-phase-marker" aria-hidden="true">
          <Check v-if="phase.state === 'done'" :size="12" />
          <X v-else-if="phase.state === 'failed'" :size="12" />
          <span v-else-if="phase.state === 'active'" class="supervised-launch-phase-spinner" />
          <span v-else class="supervised-launch-phase-dot" />
        </span>
        <span class="supervised-launch-phase-label">{{ phase.label }}</span>
        <span class="supervised-launch-phase-status" aria-live="polite">{{ phaseStatusText(phase.state) }}</span>
      </li>
    </ol>

    <p
      v-if="progress.joinHint"
      class="supervised-launch-progress-hint"
      data-testid="supervised-launch-join-hint"
      aria-live="polite"
    >{{ progress.joinHint }}</p>

    <p
      v-if="progress.failed && progress.failureDetail"
      class="supervised-launch-progress-failure"
      data-testid="supervised-launch-failure"
      role="alert"
    >{{ progress.failureDetail }}</p>
  </div>
</template>

<script setup lang="ts">
import { Check, X } from "@lucide/vue";
import type { SupervisedLaunchPhaseState, SupervisedLaunchProgress } from "../../../domain/supervised-launch";

defineProps<{ progress: SupervisedLaunchProgress }>();

function phaseStatusText(state: SupervisedLaunchPhaseState): string {
  switch (state) {
    case "done": return "Done";
    case "active": return "In progress";
    case "failed": return "Needs attention";
    default: return "Pending";
  }
}
</script>
