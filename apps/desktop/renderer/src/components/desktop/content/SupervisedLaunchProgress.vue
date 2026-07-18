<template>
  <div
    class="supervised-launch-progress"
    data-testid="supervised-launch-progress"
    :data-state="progress.status === 'stopping' ? 'stopping' : progress.ready ? 'ready' : progress.failed ? 'failed' : progress.stopped ? 'stopped' : 'launching'"
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
        :aria-current="phase.state === 'active' || phase.state === 'stopping' ? 'step' : undefined"
      >
        <span class="supervised-launch-phase-marker" aria-hidden="true">
          <Check v-if="phase.state === 'done'" :size="12" />
          <X v-else-if="phase.state === 'failed'" :size="12" />
          <Minus v-else-if="phase.state === 'cancelled'" :size="12" />
          <span v-else-if="phase.state === 'active' || phase.state === 'stopping'" class="supervised-launch-phase-spinner" />
          <span v-else class="supervised-launch-phase-dot" />
        </span>
        <span class="supervised-launch-phase-text">
          <span class="supervised-launch-phase-label">{{ phase.label }}</span>
          <small
            v-if="phase.state === 'active' || phase.state === 'stopping' || phase.state === 'failed'"
            class="supervised-launch-phase-detail"
          >{{ phase.detail }}</small>
        </span>
        <span class="supervised-launch-phase-status">{{ phaseStatusText(phase.state) }}</span>
      </li>
    </ol>

    <!-- One polite, card-level live region: announces the current step or the
         terminal outcome without narrating every phase individually. -->
    <p class="supervised-launch-sr-live" aria-live="polite">{{ liveAnnouncement }}</p>

    <p
      v-if="progress.joinHint"
      class="supervised-launch-progress-hint"
      data-testid="supervised-launch-join-hint"
    >{{ progress.joinHint }}</p>

    <div
      v-if="progress.failed && progress.failureDetail"
      class="supervised-launch-progress-failure"
      data-testid="supervised-launch-failure"
      role="alert"
    >
      <p>{{ progress.failureDetail }}</p>
      <button
        v-if="progress.recovery"
        type="button"
        class="supervised-launch-recovery"
        data-testid="supervised-launch-recovery"
        @click="emit('recover', progress.recovery)"
      >{{ recoveryLabel(progress.recovery) }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Check, Minus, X } from "@lucide/vue";
import type { DesktopLaunchRecoveryAction } from "../../../../../electron/ipc-types";
import type { LaunchJourneyPhaseState, LaunchJourneyView } from "../../../domain/launch-journey";

const props = defineProps<{ progress: LaunchJourneyView }>();

const emit = defineEmits<{ recover: [action: DesktopLaunchRecoveryAction] }>();

// Product-grammar state vocabulary (msg_5190).
function phaseStatusText(state: LaunchJourneyPhaseState): string {
  switch (state) {
    case "done": return "Complete";
    case "active": return "In progress";
    case "stopping": return "Cancelling";
    case "failed": return "Needs attention";
    case "cancelled": return "Cancelled";
    default: return "Waiting";
  }
}

function recoveryLabel(action: DesktopLaunchRecoveryAction): string {
  switch (action) {
    case "retry": return "Try again";
    case "reconnect": return "Reconnect";
    case "sign_in": return "Copy sign-in command";
    case "choose_project": return "Choose project";
  }
}

const liveAnnouncement = computed(() => {
  const p = props.progress;
  if (p.status === "stopping") return p.headline;
  if (p.ready) return p.headline;
  if (p.failed) return "";
  if (p.stopped) return p.headline;
  const active = p.phases.find((phase) => phase.state === "active");
  return active ? active.label : p.headline;
});
</script>

<style scoped src="./SupervisedLaunchProgress.css"></style>

<style scoped>
.supervised-launch-sr-live {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
</style>
