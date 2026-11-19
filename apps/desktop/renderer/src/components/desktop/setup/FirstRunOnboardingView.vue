<template>
  <section class="first-run-wizard" :data-stage="stage" data-testid="first-run-wizard">
    <Transition name="first-run-shell" @after-enter="focusHeading">
      <FirstRunWelcome v-if="stage === 'welcome'" key="welcome" :busy="busy" :feedback="feedback" @start="emit('start-setup')" />
      <article v-else ref="card" key="setup" class="onboarding-card" :data-step="stage" data-testid="first-run-card">
        <span class="setup-brand"><LetAgentsLogoMark aria-hidden="true" />LetAgents</span>
        <Transition name="setup-step" mode="out-in" @after-enter="focusHeading">
          <div :key="stage" class="onboarding-content">
            <header class="onboarding-heading" :aria-live="stage === 'github' ? 'polite' : undefined">
              <h1 tabindex="-1">{{ headline }}</h1>
              <p v-if="description">{{ description }}</p>
            </header>

            <FirstRunGithubStep v-if="stage === 'github'" :auth-status="authStatus" :busy="authBusy"
              @cancel-auth="emit('cancel-auth')" @open-verification="emit('open-verification', $event)"
              @poll-auth="emit('poll-auth')" @sign-out="emit('sign-out')" />

            <FirstRunOrganizationStep v-else-if="stage === 'organization' && companyStep"
              v-model:pick="companyPick" :status="companyStep.status" :access-reason="companyStep.accessReason"
              :organizations="companyStep.organizations" :invitations="companyStep.invitations"
              :sso-required="companyStep.ssoRequired" :error="companyStep.error" :invited-id="invitedCompanyId ?? null"
              @retry="emit('retry-organizations')" @open-github="emit('open-company-github', $event)" />

            <div v-else-if="stage === 'theme'" :aria-busy="savingCompanyTheme">
              <RoomThemePicker label="Room theme" :model-value="roomTheme?.personal.value ?? null"
                :inherited="roomTheme?.company.value?.theme" :company="companyName" :disabled="savingCompanyTheme"
                preview @update:model-value="roomTheme?.choose($event)" />
              <label v-if="canShareTheme" class="first-run-share-theme">
                <input v-model="shareTheme" type="checkbox" :disabled="savingCompanyTheme || !roomTheme?.personal.value">
                Use this as {{ companyName }}’s default
              </label>
              <p v-if="themeSaveError" class="onboarding-feedback" role="alert">{{ themeSaveError }}</p>
            </div>

            <template v-else-if="stage === 'room'">
              <FirstRunCompanyRooms v-if="rooms.length"
                :company-name="companyName ?? null" :rooms="rooms"
                :selected-room-identifier="selectedRoomIdentifier" :busy="busy"
                @choose-room="emit('choose-room', $event)" />
              <div class="onboarding-room-actions" aria-label="Open another room">
                <button type="button" :disabled="busy" data-testid="room-choice-create" @click="emit('new-room', 'create')">
                  <Plus aria-hidden="true" /><span>New room</span><ArrowRight aria-hidden="true" />
                </button>
                <button type="button" :disabled="busy" data-testid="room-choice-join" @click="emit('new-room', 'join')">
                  <KeyRound aria-hidden="true" /><span>Join with an invite</span><ArrowRight aria-hidden="true" />
                </button>
                <button type="button" :disabled="busy" data-testid="room-choice-pick-repo" @click="emit('new-room', 'project')">
                  <FolderGit2 aria-hidden="true" /><span>Open a repository</span><ArrowRight aria-hidden="true" />
                </button>
              </div>
            </template>

            <p v-if="feedback" class="onboarding-feedback" role="status" data-testid="first-run-feedback">{{ feedback }}</p>

            <footer class="onboarding-actions">
              <button v-if="!authStatus?.pendingDeviceAuth || stage !== 'github'" class="onboarding-quiet"
                :disabled="busy || savingCompanyTheme" type="button" data-testid="first-run-back" @click="emit('back')">
                <ArrowLeft aria-hidden="true" /> Back
              </button>
              <template v-if="stage === 'github'">
                <button v-if="authStatus?.authenticated" class="primary-button" type="button" :disabled="busy"
                  data-testid="first-run-to-room" @click="emit('continue-to-room')">
                  Continue <ArrowRight aria-hidden="true" />
                </button>
                <button v-else-if="!authStatus?.pendingDeviceAuth" class="primary-button" type="button" :disabled="authBusy"
                  data-testid="first-run-auth-start" @click="emit('start-auth')">
                  {{ authBusy ? "Opening GitHub…" : "Sign in with GitHub" }} <ArrowUpRight aria-hidden="true" />
                </button>
              </template>
              <template v-else-if="stage === 'organization' && companyStep">
                <button v-if="companyStep.status === 'github_access_required'" class="onboarding-quiet" type="button"
                  :disabled="busy" data-testid="first-run-company-skip" @click="emit('choose-organization', null)">
                  Skip for now
                </button>
                <button class="primary-button" type="button" :disabled="companyAction.disabled || busy"
                  data-testid="first-run-company-continue" @click="runCompanyAction">
                  {{ companyAction.label }} <ArrowRight aria-hidden="true" />
                </button>
              </template>
              <button v-else-if="stage === 'theme'" class="primary-button" type="button" :disabled="busy || savingCompanyTheme"
                data-testid="first-run-theme-continue" @click="continueTheme">
                {{ savingCompanyTheme ? "Saving…" : "Continue" }} <ArrowRight aria-hidden="true" />
              </button>
              <button v-else-if="stage === 'room'" :class="selectedRoomIdentifier ? 'primary-button' : 'onboarding-quiet'"
                type="button" :disabled="busy" data-testid="first-run-open-room"
                @click="roomNeedsGithubAccess ? emit('connect-room-auth') : emit('finish')">
                {{ roomNeedsGithubAccess ? "Connect GitHub" : selectedRoomIdentifier ? "Open room" : "Skip for now" }}
                <ArrowRight aria-hidden="true" />
              </button>
            </footer>
          </div>
        </Transition>
      </article>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, ArrowUpRight, FolderGit2, KeyRound, Plus } from "@lucide/vue";
import RoomThemePicker from "../../../../../../../shared/ui/RoomThemePicker.vue";
import { useRoomTheme } from "../../../../../../../shared/ui/room-theme";
import type { RoomThemeId } from "../../../../../../../shared/room-themes.mjs";
import type { DesktopAuthStatus } from "../../../../../electron/ipc-types";
import type { DesktopOrganizationGitHubPage, DesktopOrganizationRoom } from "../../../../../electron/ipc-types/organizations";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
import FirstRunCompanyRooms from "./FirstRunCompanyRooms.vue";
import FirstRunGithubStep from "./FirstRunGithubStep.vue";
import FirstRunOrganizationStep from "./FirstRunOrganizationStep.vue";
import FirstRunWelcome from "./FirstRunWelcome.vue";
import type { FirstRunCompanyStepState, FirstRunWizardStage } from "./types";

const props = defineProps<{
  stage: FirstRunWizardStage;
  companyStep?: FirstRunCompanyStepState | null;
  invitedCompanyId?: string | null;
  companyName?: string | null;
  rooms: Array<Pick<DesktopOrganizationRoom, "kind" | "room_id" | "display_name" | "full_name" | "visibility">>;
  saveCompanyTheme?: (id: string, theme: RoomThemeId) => Promise<void>;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  authBusy: boolean;
  feedback: string | null;
  selectedRoomIdentifier: string | null;
  roomNeedsGithubAccess: boolean;
}>();
const emit = defineEmits<{
  "start-setup": [];
  "start-auth": [];
  "cancel-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
  "continue-to-room": [];
  "continue-theme": [];
  "choose-organization": [id: string | null];
  "retry-organizations": [];
  "open-company-github": [page: DesktopOrganizationGitHubPage];
  "connect-room-auth": [];
  "new-room": [mode: "create" | "join" | "project"];
  "choose-room": [id: string];
  back: [];
  finish: [];
}>();

const card = ref<HTMLElement | null>(null);
function focusHeading() {
  card.value?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
}

const headline = computed(() => {
  if (props.stage === "github") {
    if (props.authStatus?.authenticated) return "GitHub connected";
    return props.authStatus?.pendingDeviceAuth ? "Finish in your browser" : "Sign in to LetAgents";
  }
  if (props.stage === "organization") return "Where will you work?";
  if (props.stage === "theme") return "Pick your theme.";
  return "Find your first room.";
});

const description = computed(() => {
  if (props.stage === "github") {
    if (props.authStatus?.authenticated) return "Choose where you’ll work.";
    return props.authStatus?.pendingDeviceAuth ? "Confirm that this code matches on GitHub." : "Use GitHub to open rooms for your repositories.";
  }
  if (props.stage === "organization") return "See all your rooms or focus on a company.";
  if (props.stage === "theme") return props.companyName ? `Use ${props.companyName}’s theme or choose your own.` : "Choose how your rooms look.";
  return "You can switch rooms anytime.";
});

const companyPick = ref("all");
watch(() => props.stage, stage => {
  if (stage === "organization") companyPick.value = props.companyStep?.selectedId ?? "all";
}, { immediate: true });

const selectedCompany = computed(() => props.companyStep?.organizations.find(org => org.github_org_id === companyPick.value));
const companyAction = computed(() => {
  const step = props.companyStep;
  if (!step || step.status === "idle" || step.status === "loading") return { label: "Continue", disabled: true };
  if (step.status === "github_access_required") return { label: "Open GitHub", disabled: false };
  if (step.status === "unavailable") return { label: "Continue with all rooms", disabled: false };
  const selected = selectedCompany.value;
  if (step.joiningId) return { label: "Opening…", disabled: true };
  if (!selected) return { label: "Continue", disabled: companyPick.value !== "all" };
  if (selected.joined) return { label: "Continue", disabled: false };
  if (selected.setup) return { label: `Join ${selected.login}`, disabled: false };
  return { label: `Set up ${selected.login}`, disabled: selected.role !== "owner" };
});

function runCompanyAction() {
  if (props.companyStep?.status === "github_access_required") emit("open-company-github", { kind: "allow" });
  else if (props.companyStep?.status === "unavailable") emit("choose-organization", null);
  else emit("choose-organization", selectedCompany.value?.github_org_id ?? null);
}

const roomTheme = useRoomTheme();
const canShareTheme = computed(() => Boolean(props.saveCompanyTheme && roomTheme?.company.value && !roomTheme.company.value.theme));
const shareTheme = ref(false);
const savingCompanyTheme = ref(false);
const themeSaveError = ref("");

watch([() => roomTheme?.company.value?.id, () => props.stage], () => {
  shareTheme.value = false;
  themeSaveError.value = "";
});

async function continueTheme() {
  if (savingCompanyTheme.value) return;
  const company = roomTheme?.company.value;
  const theme = roomTheme?.personal.value;
  if (shareTheme.value && canShareTheme.value && company && theme && props.saveCompanyTheme) {
    savingCompanyTheme.value = true;
    themeSaveError.value = "";
    try {
      await props.saveCompanyTheme(company.id, theme);
      if (props.stage !== "theme" || roomTheme.company.value?.id !== company.id) return;
      if (roomTheme.personal.value === theme && roomTheme.company.value.theme === theme) roomTheme.choose(null);
    } catch {
      themeSaveError.value = "Couldn’t save the company theme. Try again.";
      return;
    } finally {
      savingCompanyTheme.value = false;
    }
  }
  emit("continue-theme");
}
</script>

<style scoped>
.onboarding-card {
  grid-area: 1 / 1;
  position: relative;
  display: grid;
  align-content: center;
  min-width: 0;
  min-height: calc(100dvh - 56px);
  padding: 72px clamp(22px, 5vw, 76px) 50px;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--workspace-accent, var(--setup-accent)) 7%, transparent), transparent 66%);
}
.setup-brand { position: absolute; top: 16px; left: clamp(22px, 5vw, 76px); display: flex; align-items: center; gap: 8px; font-weight: 620; }
.setup-brand svg { width: 23px; height: 23px; }
.onboarding-content { display: grid; gap: 24px; width: min(100%, 580px); margin: 0 auto; }
[data-step="theme"] .onboarding-content { width: min(100%, 760px); gap: 28px; }
[data-step="github"] .onboarding-content { width: min(100%, 420px); gap: 14px; }
.onboarding-heading h1 { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: clamp(38px, 6vw, 66px); font-weight: 500; line-height: 1.04; letter-spacing: -.045em; }
[data-step="github"] h1 { font-family: inherit; font-size: clamp(28px, 5vw, 40px); font-weight: 630; }
.onboarding-heading h1:focus { outline: none; }
.onboarding-heading p, .onboarding-feedback { margin: 9px 0 0; color: var(--setup-muted); line-height: 1.5; }
.onboarding-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; }
.onboarding-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 12px; min-height: 43px; }
.onboarding-actions .primary-button, .onboarding-card :deep(.auth-actions .primary-button) { padding: 0 17px; border: 1px solid var(--workspace-border, var(--setup-border)); border-radius: 11px; background: color-mix(in srgb, var(--workspace-accent, var(--setup-accent)) 16%, var(--setup-surface)); color: var(--setup-text); }
.onboarding-actions svg, .onboarding-room-actions svg { width: 16px; height: 16px; color: var(--workspace-accent, var(--setup-accent)); }
.onboarding-actions .primary-button svg { transition: transform 210ms cubic-bezier(.22,.84,.32,1.25); }
.onboarding-actions .primary-button:hover svg { transform: translateX(3px); }
.onboarding-quiet { border: 0; border-radius: 8px; background: transparent; color: var(--setup-muted); font: inherit; cursor: pointer; }
.onboarding-room-actions { display: grid; gap: 4px; }
.onboarding-room-actions button { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; min-height: 48px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: var(--setup-text); text-align: left; font: inherit; cursor: pointer; }
.onboarding-room-actions button:hover, .onboarding-quiet:hover { background: var(--setup-surface-muted); }
.onboarding-card :deep(.first-run-github-step) { min-height: 0; }
.onboarding-card :deep(.github-access-panel) { place-items: start; }
.onboarding-card :deep(.github-signin-card) { width: 100%; padding: 0; align-items: stretch; justify-items: stretch; text-align: start; border: 0; background: none; box-shadow: none; }
.onboarding-card :deep(.github-auth-state) { justify-items: start; }
.onboarding-card :deep(.auth-actions) { justify-content: flex-start; }
.onboarding-card button:focus-visible { outline: 2px solid var(--workspace-accent, var(--setup-accent)); outline-offset: 3px; }
.onboarding-card button:disabled { opacity: .58; cursor: default; }
.setup-step-enter-active { transition: opacity 200ms ease, transform 240ms var(--first-run-motion-ease); }
.setup-step-leave-active { transition: opacity 120ms ease; }
.setup-step-enter-from { opacity: 0; transform: translateY(7px); }
.setup-step-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .setup-step-enter-active, .setup-step-leave-active, .onboarding-actions .primary-button svg { transition: none; }
  .setup-step-enter-from, .onboarding-actions .primary-button:hover svg { transform: none; }
}
</style>
