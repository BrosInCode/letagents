<template>
  <section class="first-run-wizard surface-page" :data-stage="stage" data-testid="first-run-wizard">
    <article class="mcp-wizard-card first-run-card" data-testid="first-run-card">
      <div class="first-run-hero-row" data-testid="first-run-hero">
        <header class="mcp-wizard-header first-run-header" data-testid="first-run-header">
          <p class="hero-kicker">LetAgents setup</p>
          <SetupWizardProgress :current-step="stage" :steps="progressSteps" />
          <h1>{{ headline }}</h1>
          <p>{{ copy }}</p>
        </header>
      </div>

      <div v-if="stage === 'mcp'" class="first-run-stage" data-testid="first-run-stage-mcp">
        <McpHarnessChoiceStep
          v-if="mcpWizardStep === 'choose'"
          :targets="mcpState.targets"
          :selected-target-ids="selectedMcpTargetIds"
          @select-target="$emit('select-target', $event)"
          @select-all="$emit('select-all-targets')"
          @clear-selection="$emit('clear-target-selection')"
        />

        <McpInstallConfirmStep
          v-else-if="mcpWizardStep === 'install'"
          :targets="selectedMcpTargets"
        />

        <McpInstallDoneStep v-else :targets="selectedMcpTargets" />
      </div>

      <FirstRunGithubStep
        v-else-if="stage === 'github'"
        :auth-status="authStatus"
        :busy="authBusy"
        @start-auth="$emit('start-auth')"
        @open-verification="$emit('open-verification', $event)"
        @poll-auth="$emit('poll-auth')"
        @sign-out="$emit('sign-out')"
      />

      <FirstRunRoomStep
        v-else
        :room-name="roomName"
        :room-identifier="roomIdentifier"
        :github-connected="!!authStatus?.authenticated"
        :busy="busy"
        @pick-repo="$emit('pick-repo')"
        @join-room-code="$emit('join-room-code', $event)"
      />

      <div class="mcp-wizard-actions" data-testid="first-run-actions">
        <button
          v-if="showBack"
          class="ghost-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-back"
          @click="$emit('back')"
        >
          Back
        </button>

        <button
          v-if="stage === 'mcp' && mcpWizardStep === 'choose'"
          class="primary-button"
          type="button"
          :disabled="!selectedMcpTargetIds.length || busy"
          data-testid="first-run-mcp-continue"
          @click="$emit('continue-mcp')"
        >
          Continue
        </button>

        <button
          v-else-if="stage === 'mcp' && mcpWizardStep === 'install'"
          class="primary-button"
          type="button"
          :disabled="!selectedMcpTargetIds.length || busy || !canInstall"
          data-testid="first-run-mcp-install"
          @click="$emit('install-targets')"
        >
          {{ installButtonLabel }}
        </button>

        <button
          v-else-if="stage === 'mcp'"
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-to-github"
          @click="$emit('continue-to-github')"
        >
          Continue
        </button>

        <button
          v-if="stage === 'github' && !authStatus?.authenticated"
          class="ghost-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-skip-github"
          @click="$emit('continue-to-room')"
        >
          Skip for now
        </button>

        <button
          v-else-if="stage === 'github'"
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-to-room"
          @click="$emit('continue-to-room')"
        >
          Continue
        </button>

        <button
          v-else-if="stage === 'room'"
          class="primary-button"
          type="button"
          :disabled="busy || !roomIdentifier"
          data-testid="first-run-open-room"
          @click="$emit('finish')"
        >
          {{ roomIdentifier ? "Open room" : "Choose a room" }}
        </button>
      </div>

      <p v-if="feedback" class="mcp-feedback" data-testid="first-run-feedback">{{ feedback }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
} from "../../../../../electron/ipc-types";
import FirstRunGithubStep from "./FirstRunGithubStep.vue";
import FirstRunRoomStep from "./FirstRunRoomStep.vue";
import McpHarnessChoiceStep from "./McpHarnessChoiceStep.vue";
import McpInstallConfirmStep from "./McpInstallConfirmStep.vue";
import McpInstallDoneStep from "./McpInstallDoneStep.vue";
import SetupWizardProgress from "./SetupWizardProgress.vue";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./types";

const props = defineProps<{
  stage: FirstRunWizardStage;
  mcpState: DesktopMcpInstallState;
  selectedMcpTargetIds: DesktopMcpInstallTargetId[];
  mcpWizardStep: DesktopMcpWizardStep;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  authBusy: boolean;
  canInstall: boolean;
  feedback: string | null;
  roomName: string;
  roomIdentifier: string | null;
}>();

defineEmits<{
  "select-target": [targetId: DesktopMcpInstallTargetId];
  "select-all-targets": [];
  "clear-target-selection": [];
  "continue-mcp": [];
  "install-targets": [];
  "continue-to-github": [];
  "start-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
  "continue-to-room": [];
  "pick-repo": [];
  "join-room-code": [roomCode: string];
  back: [];
  finish: [];
}>();

const selectedMcpTargets = computed(() => {
  return props.mcpState.targets.filter((target) => props.selectedMcpTargetIds.includes(target.id));
});

const selectedMcpTargetCount = computed(() => selectedMcpTargets.value.length);

const selectedTargetLabel = computed(() => {
  if (selectedMcpTargetCount.value === 1) return selectedMcpTargets.value[0].name;
  if (selectedMcpTargetCount.value === props.mcpState.targets.length) return "all your apps";
  return `${selectedMcpTargetCount.value} apps`;
});

const installButtonLabel = computed(() => {
  if (props.busy) return "Installing...";
  return selectedMcpTargetCount.value > 1
    ? `Install in ${selectedMcpTargetCount.value} apps`
    : "Install LetAgents";
});

const headline = computed(() => {
  if (props.stage === "github") return "Connect GitHub for private rooms.";
  if (props.stage === "room") return "Choose where agents should work.";
  if (props.mcpWizardStep === "install") return `Add LetAgents to ${selectedTargetLabel.value}.`;
  if (props.mcpWizardStep === "done") return `${selectedTargetLabel.value} ${selectedMcpTargetCount.value === 1 ? "is" : "are"} ready.`;
  return "Bring your agent in.";
});

const copy = computed(() => {
  if (props.stage === "github") {
    return "Connect now for private repos and repo discovery, or skip and join a public or invite room.";
  }
  if (props.stage === "room") {
    return "Open a room for a repository, or join one someone has already shared with you.";
  }
  if (props.mcpWizardStep === "install") {
    return "LetAgents will add a small app connection, already pointed at this repository and ready for the right room.";
  }
  if (props.mcpWizardStep === "done") {
    return "Restart or reload the app you selected. Your agents will see LetAgents the next time they start.";
  }
  return "Choose the coding apps your agents use. LetAgents will add the connection there, so agents can join rooms without copy-paste setup.";
});

const progressSteps = computed<Array<{ id: FirstRunWizardStage; step: string; label: string; complete: boolean }>>(() => [
  { id: "mcp", step: "1", label: "Agent app", complete: props.stage !== "mcp" },
  { id: "github", step: "2", label: "Access", complete: props.stage === "room" },
  { id: "room", step: "3", label: "Room", complete: false },
]);

const showBack = computed(() => {
  return props.stage !== "mcp" || props.mcpWizardStep !== "choose";
});
</script>
