<template>
  <div class="onboarding-flow" data-testid="onboarding-flow">
    <OnboardingWelcome v-if="stage === 'welcome' || morphing" ref="welcome"
      :auth-status="authStatus" :auth-busy="authBusy" :feedback="authFeedback"
      @start-auth="emit('start-auth')" @cancel-auth="emit('cancel-auth')"
      @open-verification="emit('open-verification', $event)" @continue="leaveWelcome" />

    <Transition name="onboarding-step" mode="out-in" :css="!morphing">
      <OnboardingCompanyStep v-if="stage === 'company'" key="company" ref="companyStep"
        v-model:organization-id="companyId" v-model:theme-id="companyTheme"
        :organizations="ownedOrganizations" :busy="companyBusy" :error="companyError"
        :access="companyAccess" :access-opened="accessOpened"
        @continue="setUpCompany" @skip="enterAgentStep" @allow="allowCompanyAccess" @retry="checkCompanyAccess" />
      <OnboardingAgentStep v-else-if="stage === 'agent' || stage === 'setup'" key="agent" ref="agentStep"
        :phase="stage === 'setup' ? 'setup' : 'pick'" :accent="companyAccent"
        :providers="agents.providers.value" :selected-id="selectedProviderId"
        :agent-name="firstRoom.agent.value?.displayName ?? ONBOARDING_AGENT_DEFAULT_NAME"
        :agent-avatar="firstRoom.agent.value?.avatar ?? ONBOARDING_AGENT_DEFAULT_AVATAR"
        :load-error="agents.error.value" :sign-in-error="agents.signInError.value"
        :setup-task="firstRoom.task.value" :setup-state="firstRoom.state.value" :setup-error="firstRoom.error.value"
        @select="selectedProviderId = $event" @sign-in="agents.signIn($event)" @cancel-sign-in="agents.cancelSignIn($event)"
        @open-link="agents.openSignInLink($event)" @submit-code="(id, code) => agents.submitCode(id, code)"
        @install="agents.openInstall($event)" @start="startSetup" @retry="startSetup" @back="stage = 'agent'"
        @skip="emit('finish')" />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { roomThemePresets, type RoomThemeId } from "../../../../../../../shared/room-themes.mjs";
import type { DesktopAgentProviderId, DesktopAuthStatus } from "../../../../../electron/ipc-types";
import type { DesktopGitHubAccessReason, DesktopOrganization } from "../../../../../electron/ipc-types/organizations";
import OnboardingAgentStep from "./OnboardingAgentStep.vue";
import OnboardingCompanyStep from "./OnboardingCompanyStep.vue";
import OnboardingWelcome from "./OnboardingWelcome.vue";
import { useOnboardingAgents } from "./useOnboardingAgents";
import {
  ONBOARDING_AGENT_DEFAULT_AVATAR,
  ONBOARDING_AGENT_DEFAULT_NAME,
  useOnboardingFirstRoom,
} from "./useOnboardingFirstRoom";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  authBusy: boolean;
  authFeedback: string | null;
  /** The person's GitHub organizations as LetAgents knows them, and whether that list has loaded. */
  organizations: DesktopOrganization[];
  organizationsLoading: boolean;
  /** GitHub has not shared the person's organizations yet (the list's status), and why. */
  organizationsAccess: DesktopGitHubAccessReason | null;
  openOrganizationAccess: () => Promise<void>;
  refreshOrganizations: () => Promise<void>;
  /** The company the app already has selected, if any. */
  selectedCompanyId: string | null;
  /** A company link opened the app: join that company during setup. */
  invitedCompanyId: string | null;
  chooseCompany: (id: string) => Promise<boolean>;
  saveCompanyTheme: (id: string, theme: RoomThemeId) => Promise<void>;
}>();
const emit = defineEmits<{
  "start-auth": [];
  "cancel-auth": [];
  "open-verification": [url: string];
  /** Setup made the first room: open it and close onboarding. */
  "open-room": [roomIdentifier: string];
  /** Skip: enter the app without a first room. */
  finish: [];
}>();

// Sign-in happens on the welcome page itself. Owners of a company that is not set up yet see
// one extra screen to make it theirs; everyone then picks an agent, and setup makes the room.
type Stage = "welcome" | "company" | "agent" | "setup";
const stage = ref<Stage>("welcome");
const welcome = ref<InstanceType<typeof OnboardingWelcome> | null>(null);
const companyStep = ref<InstanceType<typeof OnboardingCompanyStep> | null>(null);
const agentStep = ref<InstanceType<typeof OnboardingAgentStep> | null>(null);
const morphing = ref(false);

// ---- Company (owners only)
// Every company the person owns, set up or not: an owner can give it its colour here.
// Companies that still need setting up come first.
const ownedOrganizations = computed(() => props.organizations
  .filter(org => org.role === "owner")
  .sort((a, b) => Number(a.setup) - Number(b.setup)));
// No organizations from GitHub yet: the company step asks for that access first.
const companyAccess = computed(() => ownedOrganizations.value.length ? null : props.organizationsAccess);
const accessOpened = ref(false);
async function allowCompanyAccess() {
  accessOpened.value = true;
  try { await props.openOrganizationAccess(); } catch { companyError.value = "Couldn’t open GitHub. Try again."; }
}
async function checkCompanyAccess() {
  if (companyBusy.value) return;
  companyBusy.value = true;
  companyError.value = null;
  try { await props.refreshOrganizations(); } finally { companyBusy.value = false; }
  if (companyAccess.value) companyError.value = "GitHub hasn’t shared your organizations yet. Allow it on GitHub, then check again.";
}
// Access came through (on return to the window, or Check again): owners pick their company; others go on.
watch(() => [ownedOrganizations.value.length, companyAccess.value, props.organizationsLoading] as const, ([owned, access, loading]) => {
  if (stage.value !== "company" || access || loading) return;
  if (owned && !companyId.value) companyId.value = ownedOrganizations.value[0].github_org_id;
  if (!owned) enterAgentStep();
});
const currentTheme = (id: string | null) => ownedOrganizations.value.find(org => org.github_org_id === id)?.theme_id ?? null;
const companyId = ref<string | null>(null);
const companyTheme = ref<RoomThemeId>("mint");
const companyBusy = ref(false);
const companyError = ref<string | null>(null);
const chosenCompanyId = ref<string | null>(null);
// Show the company's own colour first, so Continue changes nothing unless the owner picks a new one.
watch(companyId, id => { companyTheme.value = currentTheme(id) ?? "mint"; });
const companyAccent = computed(() => chosenCompanyId.value
  ? roomThemePresets.find(theme => theme.id === companyTheme.value)?.accent
  : undefined);

async function setUpCompany() {
  const id = companyId.value ?? ownedOrganizations.value[0]?.github_org_id;
  if (!id || companyBusy.value) return;
  companyBusy.value = true;
  companyError.value = null;
  try {
    // Read before choosing: choosing an unset company sets it up.
    const wasSetUp = Boolean(ownedOrganizations.value.find(org => org.github_org_id === id)?.setup);
    const themeBefore = currentTheme(id);
    if (!(await props.chooseCompany(id))) throw new Error("Couldn’t set up the company. Check your connection and try again.");
    chosenCompanyId.value = id;
    try {
      if (!wasSetUp || companyTheme.value !== themeBefore) await props.saveCompanyTheme(id, companyTheme.value);
    } catch {
      // The company is set up; the colour can be chosen again in Settings. Do not hold the person here.
    }
    enterAgentStep();
  } catch (cause) {
    companyError.value = cause instanceof Error ? cause.message : "Couldn’t set up the company.";
  } finally {
    companyBusy.value = false;
  }
}

// ---- Agent and setup
const agents = useOnboardingAgents({ active: () => stage.value === "agent" });
const firstRoom = useOnboardingFirstRoom();
const selectedProviderId = ref<DesktopAgentProviderId | null>(null);
// The first agent that is ready is chosen for the person; a later sign-in picks the one just signed in.
watch(() => agents.providers.value.map(provider => `${provider.id}:${provider.state}`).join(), (now, before) => {
  const readyNow = agents.providers.value.filter(provider => provider.state === "ready");
  if (!readyNow.length) return;
  const justReady = readyNow.find(provider => before && !before.includes(`${provider.id}:ready`) && before.includes(`${provider.id}:signing-in`));
  if (justReady) { selectedProviderId.value = justReady.id; return; }
  if (!readyNow.some(provider => provider.id === selectedProviderId.value)) selectedProviderId.value = readyNow[0].id;
}, { immediate: true });

function enterAgentStep() {
  stage.value = "agent";
  void agents.refresh();
}

async function startSetup() {
  const providerId = selectedProviderId.value;
  if (!providerId || firstRoom.state.value === "running") return;
  firstRoom.prepare(providerId);
  stage.value = "setup";
  let organizationId = chosenCompanyId.value ?? props.selectedCompanyId;
  // A company link: join that company now, so the room is made in it.
  if (props.invitedCompanyId && !chosenCompanyId.value) {
    if (await props.chooseCompany(props.invitedCompanyId)) organizationId = props.invitedCompanyId;
  }
  const ok = await firstRoom.run({ providerId, organizationId });
  const room = firstRoom.room.value;
  // Let the last check land before the room takes over.
  if (ok && room) setTimeout(() => emit("open-room", room.roomIdentifier), 420);
}

// ---- Welcome → next screen: the welcome stays on top and morphs into the screen beneath it.
async function leaveWelcome() {
  // The organization list loads right after sign-in; give it a moment before choosing the next screen.
  const deadline = performance.now() + 2000;
  while (props.organizationsLoading && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const next: Stage = ownedOrganizations.value.length || companyAccess.value ? "company" : "agent";
  if (next === "company") companyId.value = ownedOrganizations.value[0]?.github_org_id ?? null;
  morphing.value = true;
  if (next === "agent") enterAgentStep(); else stage.value = "company";
  await nextTick();
  const target = (next === "company" ? companyStep.value : agentStep.value)?.$el as HTMLElement | undefined;
  await welcome.value?.morphTo(target ?? null);
  morphing.value = false;
  await nextTick();
  (next === "company" ? companyStep.value : agentStep.value)?.focusHeading();
}

// Signed out in another window while on a later screen: back to the welcome page.
watch(() => props.authStatus?.authenticated, (signedIn) => {
  if (!signedIn && stage.value !== "welcome" && !morphing.value) stage.value = "welcome";
});
</script>

<style scoped>
.onboarding-flow { position: relative; width: 100%; min-height: 100dvh; background: #0a0b0a; }
.onboarding-step-enter-active { transition: opacity 260ms ease, transform 320ms cubic-bezier(.16, 1, .3, 1); }
.onboarding-step-leave-active { transition: opacity 160ms ease; }
.onboarding-step-enter-from { opacity: 0; transform: translateY(8px); }
.onboarding-step-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .onboarding-step-enter-active, .onboarding-step-leave-active { transition: opacity 120ms linear; }
  .onboarding-step-enter-from { transform: none; }
}
</style>
