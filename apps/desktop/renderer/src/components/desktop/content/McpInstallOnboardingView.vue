<template>
  <section class="mcp-onboarding surface-page" data-testid="mcp-install-onboarding">
    <article class="mcp-wizard-card" :data-step="wizardStep" data-testid="mcp-wizard-card">
      <SetupWizardHeader kicker="First setup" :headline="headline" :copy="introCopy" />

      <SetupWizardProgress :current-step="wizardStep" :steps="progressSteps" />

      <Transition name="room-panel" mode="out-in">
        <McpHarnessChoiceStep
          v-if="wizardStep === 'choose'"
          key="choose"
          :targets="state.targets"
          :selected-target-ids="selectedTargetIds"
          @select-target="$emit('select-target', $event)"
          @select-all="$emit('select-all-targets')"
          @clear-selection="$emit('clear-target-selection')"
        />

        <McpInstallConfirmStep v-else-if="wizardStep === 'install'" key="install" :targets="selectedTargets" />

        <McpInstallDoneStep v-else key="done" :targets="selectedTargets" />
      </Transition>

      <SetupWizardActions
        :wizard-step="wizardStep"
        :selected-targets="selectedTargets"
        :busy="busy"
        :can-install="canInstall"
        @continue="$emit('continue')"
        @back="$emit('back')"
        @install-targets="$emit('install-targets')"
        @finish="$emit('finish')"
      />

      <p v-if="feedback" class="mcp-feedback" data-testid="mcp-install-feedback">{{ feedback }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "../../../../../electron/ipc-types";
import McpHarnessChoiceStep from "../setup/McpHarnessChoiceStep.vue";
import McpInstallConfirmStep from "../setup/McpInstallConfirmStep.vue";
import McpInstallDoneStep from "../setup/McpInstallDoneStep.vue";
import SetupWizardActions from "../setup/SetupWizardActions.vue";
import SetupWizardHeader from "../setup/SetupWizardHeader.vue";
import SetupWizardProgress from "../setup/SetupWizardProgress.vue";
import type { DesktopMcpWizardStep } from "../setup/types";

const props = defineProps<{
  state: DesktopMcpInstallState;
  selectedTargetIds: DesktopMcpInstallTargetId[];
  wizardStep: DesktopMcpWizardStep;
  busy: boolean;
  feedback: string | null;
  canInstall: boolean;
}>();

defineEmits<{
  "select-target": [targetId: DesktopMcpInstallTargetId];
  "select-all-targets": [];
  "clear-target-selection": [];
  continue: [];
  back: [];
  "install-targets": [];
  finish: [];
}>();

const selectedTargets = computed<DesktopMcpInstallTarget[]>(() => {
  return props.state.targets.filter((target) => props.selectedTargetIds.includes(target.id));
});

const selectedTargetLabel = computed(() => {
  if (selectedTargets.value.length === 1) return selectedTargets.value[0]?.name || "your app";
  if (selectedTargets.value.length === props.state.targets.length) return "all your apps";
  return `${selectedTargets.value.length} apps`;
});

const headline = computed(() => {
  if (props.wizardStep === "install") return `Add LetAgents to ${selectedTargetLabel.value}.`;
  if (props.wizardStep === "done") return "Your room is ready.";
  return "Where do your agents live?";
});

const introCopy = computed(() => {
  if (props.wizardStep === "install") {
    return "LetAgents will add a small global MCP connection to this app. Room and repo choice stay inside LetAgents.";
  }

  if (props.wizardStep === "done") {
    return "Restart the app you selected. Your agent will see LetAgents the next time it starts.";
  }

  return "Pick where your agents run. Provider CLIs stay user-managed; LetAgents adds the MCP bridge for rooms to every selected app.";
});

const progressSteps = computed<Array<{ id: DesktopMcpWizardStep; step: string; label: string; complete: boolean }>>(() => [
  { id: "choose", step: "1", label: "Choose", complete: props.wizardStep !== "choose" },
  { id: "install", step: "2", label: "Install", complete: props.wizardStep === "done" },
  { id: "done", step: "3", label: "Restart", complete: false },
]);
</script>
