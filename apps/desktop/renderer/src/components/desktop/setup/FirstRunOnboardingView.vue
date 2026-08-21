<template>
  <section class="first-run-wizard surface-page" :data-stage="stage" data-testid="first-run-wizard">
    <Transition name="first-run-shell">
      <article v-if="stage === 'welcome'" key="welcome" class="first-run-welcome" data-testid="first-run-welcome">
        <div class="first-run-welcome-brand">
          <span class="first-run-welcome-mark" aria-hidden="true">
            <LetAgentsLogoMark />
          </span>
          <h1>LetAgents</h1>
        </div>
        <button
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-start-setup"
          @click="$emit('start-setup')"
        >
          Set up LetAgents
        </button>
        <Transition name="first-run-feedback">
          <p v-if="feedback" class="mcp-feedback" data-testid="first-run-feedback">{{ feedback }}</p>
        </Transition>
      </article>

      <article
        v-else
        key="wizard"
        class="mcp-wizard-card first-run-card"
        :data-motion-direction="motionDirection"
        :data-mcp-step="stage === 'mcp' ? mcpWizardStep : null"
        data-testid="first-run-card"
      >
        <div class="first-run-hero-row" data-testid="first-run-hero">
          <header class="mcp-wizard-header first-run-header" data-testid="first-run-header">
            <p class="hero-kicker">LetAgents setup</p>
            <SetupWizardProgress :current-step="stage" :steps="progressSteps" />
            <div class="first-run-heading-viewport">
              <Transition :name="stageTransitionName" mode="out-in">
                <div :key="navigationKey" class="first-run-heading-motion">
                  <h1>{{ headline }}</h1>
                  <p>{{ copy }}</p>
                </div>
              </Transition>
            </div>
          </header>
        </div>

        <div class="first-run-stage-viewport">
          <Transition :name="stageTransitionName" mode="out-in">
            <div :key="navigationKey" class="first-run-stage-motion">
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
                  v-else
                  :targets="selectedMcpTargets"
                  :show-result="mcpWizardStep === 'done' || Boolean(feedback)"
                />
              </div>

              <FirstRunGithubStep
                v-else-if="stage === 'github'"
                :auth-status="authStatus"
                :busy="authBusy"
                @cancel-auth="$emit('cancel-auth')"
                @open-verification="$emit('open-verification', $event)"
                @poll-auth="$emit('poll-auth')"
                @sign-out="$emit('sign-out')"
              />

              <FirstRunRoomStep
                v-else-if="stage === 'room'"
                :selected-room-name="selectedRoomName"
                :selected-room-identifier="selectedRoomIdentifier"
                :selected-room-access-status="selectedRoomAccessStatus"
                :room-needs-github-access="roomNeedsGithubAccess"
                :created-invite-code="createdInviteCode"
                :busy="busy"
                :feedback="feedback"
                @pick-repo="$emit('pick-repo')"
                @create-room="$emit('create-room')"
                @join-room-code="$emit('join-room-code', $event)"
              />

              <FirstRunAgentStep
                v-else
                :options="firstAgentOptions"
                :selected-provider-id="selectedFirstAgentProviderId"
                :room-name="selectedRoomName"
                :loading="firstAgentLoading"
                :error="firstAgentError"
                @select="$emit('select-first-agent', $event)"
                @retry="$emit('retry-first-agent')"
              />
            </div>
          </Transition>
        </div>

        <div class="first-run-actions-viewport">
          <Transition name="first-run-action" mode="out-in">
            <div :key="actionKey" class="mcp-wizard-actions" data-testid="first-run-actions">
              <button
                v-if="showBack && !(stage === 'github' && authStatus?.pendingDeviceAuth)"
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
                v-if="stage === 'github' && !authStatus?.authenticated && !authStatus?.pendingDeviceAuth"
                class="primary-button"
                type="button"
                :disabled="authBusy"
                data-testid="first-run-auth-start"
                @click="$emit('start-auth')"
              >
                {{ authBusy ? "Opening GitHub..." : "Sign in with GitHub" }}
              </button>

              <button
                v-if="stage === 'github' && authStatus?.authenticated"
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
                :disabled="busy"
                data-testid="first-run-open-room"
                @click="handleRoomContinue"
              >
                {{ roomActionLabel }}
              </button>

              <template v-else-if="stage === 'agent'">
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="busy"
                  data-testid="first-run-skip-agent"
                  @click="$emit('finish')"
                >
                  Do this later
                </button>
                <button
                  class="primary-button"
                  type="button"
                  :disabled="busy || firstAgentLoading || !selectedFirstAgentProviderId"
                  data-testid="first-run-add-agent"
                  @click="selectedFirstAgentProviderId && $emit('finish-with-agent', selectedFirstAgentProviderId)"
                >
                  {{ firstAgentActionLabel }}
                </button>
              </template>
            </div>
          </Transition>
        </div>

        <Transition name="first-run-feedback">
          <p v-if="showFeedback" class="mcp-feedback" data-testid="first-run-feedback">{{ feedback }}</p>
        </Transition>
      </article>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomAccess,
} from "../../../../../electron/ipc-types";
import FirstRunAgentStep from "./FirstRunAgentStep.vue";
import FirstRunGithubStep from "./FirstRunGithubStep.vue";
import FirstRunRoomStep from "./FirstRunRoomStep.vue";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
import McpHarnessChoiceStep from "./McpHarnessChoiceStep.vue";
import McpInstallConfirmStep from "./McpInstallConfirmStep.vue";
import SetupWizardProgress from "./SetupWizardProgress.vue";
import type {
  DesktopMcpWizardStep,
  FirstRunAgentOption,
  FirstRunWizardStage,
} from "./types";

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
  roomSelected: boolean;
  createdInviteCode: string | null;
  selectedRoomName: string | null;
  selectedRoomIdentifier: string | null;
  selectedRoomAccessStatus: DesktopRoomAccess["status"] | null;
  roomNeedsGithubAccess: boolean;
  firstAgentOptions: FirstRunAgentOption[];
  selectedFirstAgentProviderId: DesktopAgentProviderId | null;
  firstAgentLoading: boolean;
  firstAgentError: string | null;
}>();

const emit = defineEmits<{
  "select-target": [targetId: DesktopMcpInstallTargetId];
  "select-all-targets": [];
  "clear-target-selection": [];
  "continue-mcp": [];
  "start-setup": [];
  "install-targets": [];
  "continue-to-github": [];
  "start-auth": [];
  "cancel-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
  "continue-to-room": [];
  "continue-to-agent": [];
  "connect-room-auth": [];
  "pick-repo": [];
  "create-room": [];
  "join-room-code": [roomCode: string];
  "select-first-agent": [providerId: DesktopAgentProviderId];
  "retry-first-agent": [];
  "finish-with-agent": [providerId: DesktopAgentProviderId];
  back: [];
  finish: [];
}>();

const selectedMcpTargets = computed(() => {
  return props.mcpState.targets.filter((target) => props.selectedMcpTargetIds.includes(target.id));
});

const installButtonLabel = computed(() => {
  if (props.busy) return "Installing...";
  if (props.feedback && selectedMcpTargets.value.some((target) => target.status !== "installed")) {
    return "Retry";
  }
  return "Install MCP";
});

const roomActionLabel = computed(() => {
  if (!props.roomSelected) return "Continue";
  if (props.roomNeedsGithubAccess) return "Connect GitHub";
  return "Continue";
});

const firstAgentActionLabel = computed(() => {
  const option = props.firstAgentOptions.find(
    (candidate) => candidate.provider.id === props.selectedFirstAgentProviderId,
  );
  if (!option) return "Add agent";
  return option.preflight?.canStart
    ? `Add ${option.provider.name}`
    : `Set up ${option.provider.name}`;
});

const navigationKey = computed(() => {
  if (props.stage !== "mcp") return props.stage;
  if (props.mcpWizardStep !== "choose") return "mcp-install";
  return `mcp-${props.mcpWizardStep}`;
});

const motionDirection = ref<"forward" | "back">("forward");

watch(
  navigationKey,
  (next, previous) => {
    motionDirection.value = navigationRank(next) >= navigationRank(previous) ? "forward" : "back";
  },
  { flush: "sync" },
);

const stageTransitionName = computed(() => `first-run-${motionDirection.value}`);

const actionKey = computed(() => {
  if (props.stage === "github") {
    if (props.authStatus?.authenticated) return "github-connected";
    if (props.authStatus?.pendingDeviceAuth) return "github-pending";
    return "github-start";
  }
  if (props.stage === "room") {
    return props.roomSelected ? "room-selected" : "room-empty";
  }
  if (props.stage === "agent") return `agent-${props.selectedFirstAgentProviderId || "empty"}`;
  return navigationKey.value;
});

const headline = computed(() => {
  if (props.stage === "github") return "Repositories are rooms.";
  if (props.stage === "room") return "Open your first room.";
  if (props.stage === "agent") return "Add your first agent.";
  if (props.mcpWizardStep === "install") return "Connect your agents.";
  if (props.mcpWizardStep === "done") return "MCP installed.";
  return "Bring your agents into rooms.";
});

const copy = computed(() => {
  if (props.stage === "github") {
    return props.authStatus?.authenticated
      ? "GitHub connected. Continue to open your first room."
      : "Sign in with GitHub to open your repositories as rooms.";
  }
  if (props.stage === "room") {
    return "Start now, or continue and choose one from the sidebar later.";
  }
  if (props.stage === "agent") {
    return "Room messages don't start agents by themselves. Choose a provider this desktop can start.";
  }
  if (props.mcpWizardStep === "install") {
    return "We'll add the LetAgents MCP — the connection these apps use to enter rooms.";
  }
  if (props.mcpWizardStep === "done") {
    return "Restart your agent apps, then continue.";
  }
  return "Choose where your agents run. LetAgents will connect those apps to shared rooms.";
});

const showFeedback = computed(() => {
  return Boolean(
    props.feedback
    && props.stage !== "room"
    && !(props.stage === "mcp" && props.mcpWizardStep === "done"),
  );
});

const progressSteps = computed<Array<{ id: FirstRunWizardStage; step: string; label: string; complete: boolean }>>(() => [
  { id: "mcp", step: "1", label: "Apps", complete: props.stage !== "mcp" },
  { id: "github", step: "2", label: "GitHub", complete: props.stage === "room" || props.stage === "agent" },
  { id: "room", step: "3", label: "Room", complete: props.stage === "agent" },
  { id: "agent", step: "4", label: "Agent", complete: false },
]);

const showBack = computed(() => {
  if (props.stage === "welcome") return false;
  return props.stage !== "mcp" || props.mcpWizardStep !== "choose";
});

function navigationRank(key: string): number {
  const ranks: Record<string, number> = {
    welcome: 0,
    "mcp-choose": 1,
    "mcp-install": 2,
    "mcp-done": 3,
    github: 4,
    room: 5,
    agent: 6,
  };
  return ranks[key] ?? 0;
}

function handleRoomContinue(): void {
  if (props.roomNeedsGithubAccess) {
    emit("connect-room-auth");
    return;
  }
  if (props.roomSelected) {
    emit("continue-to-agent");
    return;
  }
  emit("finish");
}
</script>
