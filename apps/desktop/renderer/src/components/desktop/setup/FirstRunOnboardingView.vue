<template>
  <section class="first-run-wizard surface-page" :data-stage="stage" :data-company-flow="stage === 'organization' || (stage === 'room' && Boolean(companyName))" data-testid="first-run-wizard">
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

              <FirstRunOrganizationStep
                v-else-if="stage === 'organization' && companyStep"
                v-model:pick="companyPick"
                :status="companyStep.status"
                :access-reason="companyStep.accessReason"
                :organizations="companyStep.organizations"
                :invitations="companyStep.invitations"
                :sso-required="companyStep.ssoRequired"
                :error="companyStep.error"
                :invited-id="invitedCompanyId ?? null"
                @retry="$emit('retry-organizations')"
                @open-github="$emit('open-company-github', $event)"
              />

              <div v-else class="first-run-room-stage">
                <FirstRunCompanyRooms
                  v-if="companyName"
                  :company-name="companyName"
                  :avatar-url="companyAvatarUrl ?? null"
                  :rooms="companyRooms || []"
                  :selected-room-identifier="selectedRoomIdentifier"
                  :busy="busy"
                  @choose-room="$emit('join-room-code', $event)"
                />
              <FirstRunRoomStep
                :selected-room-name="selectedRoomName"
                :selected-room-identifier="selectedCompanyRoom ? null : selectedRoomIdentifier"
                :selected-room-access-status="selectedRoomAccessStatus"
                :room-needs-github-access="roomNeedsGithubAccess"
                :created-invite-code="createdInviteCode"
                :busy="busy"
                :feedback="feedback"
                @pick-repo="$emit('pick-repo')"
                @create-room="$emit('create-room')"
                @join-room-code="$emit('join-room-code', $event)"
              />
              </div>
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

              <template v-else-if="stage === 'organization' && companyStep">
                <button
                  v-if="companyStep.status === 'github_access_required'"
                  class="ghost-button"
                  type="button"
                  data-testid="first-run-company-skip"
                  @click="$emit('choose-organization', null)"
                >
                  Skip for now
                </button>
                <button
                  class="primary-button"
                  type="button"
                  :disabled="companyAction.disabled"
                  data-testid="first-run-company-continue"
                  @click="runCompanyAction"
                >
                  {{ companyAction.label }}
                </button>
              </template>

              <button
                v-else-if="stage === 'room'"
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="first-run-open-room"
                @click="roomNeedsGithubAccess ? $emit('connect-room-auth') : $emit('finish')"
              >
                {{ roomActionLabel }}
              </button>
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
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRoomAccess,
} from "../../../../../electron/ipc-types";
import FirstRunCompanyRooms from "./FirstRunCompanyRooms.vue";
import FirstRunOrganizationStep from "./FirstRunOrganizationStep.vue";
import type {
  DesktopOrganizationGitHubPage,
  DesktopOrganizationRoom,
} from "../../../../../electron/ipc-types/organizations.js";
import FirstRunGithubStep from "./FirstRunGithubStep.vue";
import FirstRunRoomStep from "./FirstRunRoomStep.vue";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
import McpHarnessChoiceStep from "./McpHarnessChoiceStep.vue";
import McpInstallConfirmStep from "./McpInstallConfirmStep.vue";
import SetupWizardProgress from "./SetupWizardProgress.vue";
import type { DesktopMcpWizardStep, FirstRunCompanyStepState, FirstRunWizardStage } from "./types";

const props = defineProps<{
  companyStep?: FirstRunCompanyStepState | null;
  /** The organization of a company link that is open during setup. */
  invitedCompanyId?: string | null;
  companyName?: string | null;
  companyAvatarUrl?: string | null;
  companyRooms?: DesktopOrganizationRoom[];
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
  "choose-organization": [id: string | null];
  "retry-organizations": [];
  "open-company-github": [page: DesktopOrganizationGitHubPage];
  "connect-room-auth": [];
  "pick-repo": [];
  "create-room": [];
  "join-room-code": [roomCode: string];
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

/** The company room that is selected on the room step, if the selected room is one. */
const selectedCompanyRoom = computed(() => {
  const selected = props.selectedRoomIdentifier?.toLowerCase();
  if (!selected) return null;
  return props.companyRooms?.find((room) => room.room_id.toLowerCase() === selected) ?? null;
});

const roomActionLabel = computed(() => {
  if (!props.roomSelected) return "Continue";
  if (props.roomNeedsGithubAccess) return "Connect GitHub";
  if (selectedCompanyRoom.value) return `Open ${selectedCompanyRoom.value.full_name ?? selectedCompanyRoom.value.display_name}`;
  return "Open room";
});

/** The chosen company row: "all", or a GitHub organization ID. */
const companyPick = ref("all");
watch(
  () => props.stage === "organization",
  (onCompanyStep) => {
    if (onCompanyStep) companyPick.value = props.companyStep?.selectedId ?? "all";
  },
  { immediate: true },
);

/** The main button of the company step names what will happen. */
const companyAction = computed<{ label: string; disabled: boolean }>(() => {
  const step = props.companyStep;
  if (!step || step.status === "idle" || step.status === "loading") return { label: "Continue", disabled: true };
  if (step.status === "github_access_required") {
    return { label: step.accessReason === "signin" ? "Reconnect on GitHub" : "Allow on GitHub", disabled: false };
  }
  if (step.status === "unavailable") return { label: "Continue with all rooms", disabled: false };
  const org = step.organizations.find((item) => item.github_org_id === companyPick.value);
  if (step.joiningId) {
    const joining = step.organizations.find((item) => item.github_org_id === step.joiningId);
    return { label: joining && !joining.setup ? "Setting up…" : "Joining…", disabled: true };
  }
  if (!org || org.joined) return { label: "Continue", disabled: false };
  if (org.setup) return { label: `Join ${org.login}`, disabled: false };
  if (org.role === "owner") return { label: `Set up ${org.login}`, disabled: false };
  return { label: "Continue", disabled: true };
});

function runCompanyAction(): void {
  const status = props.companyStep?.status;
  if (status === "github_access_required") {
    emit("open-company-github", { kind: "allow" });
    return;
  }
  emit("choose-organization", status === "ready" && companyPick.value !== "all" ? companyPick.value : null);
}

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
  if (props.stage === "organization") return `organization-${props.companyStep?.status ?? "idle"}`;
  return navigationKey.value;
});

const headline = computed(() => {
  if (props.stage === "github") return "Repositories are rooms.";
  if (props.stage === "organization") return "Where will you work?";
  if (props.stage === "room") return props.companyName ? "Pick your first room." : "Open your first room.";
  if (props.mcpWizardStep === "install") return "Connect your agents.";
  if (props.mcpWizardStep === "done") return "MCP installed.";
  return "Where do your agents live?";
});

const copy = computed(() => {
  if (props.stage === "organization") {
    return "Bring your company’s rooms together, or keep all your rooms in view.";
  }
  if (props.stage === "github") {
    return props.authStatus?.authenticated
      ? "GitHub connected. Choose where you’ll work next."
      : "Sign in with GitHub to open your repositories as rooms.";
  }
  if (props.stage === "room") {
    if (props.companyName && props.companyRooms?.length) {
      return `The ${props.companyName} rooms you can open.`;
    }
    return "Start now, or continue and choose one from the sidebar later.";
  }
  if (props.mcpWizardStep === "install") {
    return "We'll add the LetAgents MCP to these apps so their agents can talk in shared rooms.";
  }
  if (props.mcpWizardStep === "done") {
    return "Restart your agent apps, then continue.";
  }
  return "We'll install the LetAgents MCP in the apps you select.";
});

const showFeedback = computed(() => {
  return Boolean(
    props.feedback
    && props.stage !== "room"
    && !(props.stage === "mcp" && props.mcpWizardStep === "done"),
  );
});

const progressSteps = computed<Array<{ id: FirstRunWizardStage; step: string; label: string; complete: boolean }>>(() => [
  { id: "mcp", step: "1", label: "MCP", complete: props.stage !== "mcp" },
  { id: "github", step: "2", label: "GitHub", complete: props.stage === "organization" || props.stage === "room" },
  { id: "organization", step: "3", label: "Company", complete: props.stage === "room" },
  { id: "room", step: "4", label: "Room", complete: false },
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
    organization: 5,
    room: 6,
  };
  return ranks[key] ?? 0;
}
</script>
