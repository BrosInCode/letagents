<template>
  <div class="onboarding-flow" data-testid="onboarding-flow">
    <OnboardingWelcome v-if="stage === 'welcome' || morphing" ref="welcome"
      :auth-status="authStatus" :auth-busy="authBusy" :feedback="authFeedback"
      @start-auth="emit('start-auth')" @cancel-auth="emit('cancel-auth')"
      @open-verification="emit('open-verification', $event)" @continue="leaveWelcome" />

    <Transition name="onboarding-step" mode="out-in" :css="!morphing">
      <OnboardingCompanyStep v-if="stage === 'company'" key="company" ref="companyStep"
        v-model:organization-id="companyId" :theme-id="companyTheme" @update:theme-id="pickTheme"
        :organizations="ownedOrganizations" :busy="companyBusy" :error="companyError"
        :access="companyAccess" :access-opened="accessOpened" :unavailable="organizationsStatus === 'unavailable'"
        @continue="setUpCompany" @skip="enterAgentStep" @allow="allowCompanyAccess" @retry="checkCompanyAccess" />
      <OnboardingAgentStep v-else-if="stage === 'agent' || stage === 'setup'" key="agent" ref="agentStep"
        :phase="stage === 'setup' ? 'setup' : 'pick'" :accent="companyAccent"
        :providers="agents.providers.value" :selected-id="selectedProviderId"
        :agent-name="firstRoom.agent.value?.displayName ?? ONBOARDING_AGENT_DEFAULT_NAME"
        :agent-avatar="firstRoom.agent.value?.avatar ?? ONBOARDING_AGENT_DEFAULT_AVATAR"
        :load-error="finishError ?? agents.error.value" :sign-in-error="agents.signInError.value"
        :setup-task="setupFailure ? setupFailure.task : firstRoom.task.value"
        :setup-state="setupFailure ? 'failed' : firstRoom.state.value"
        :setup-error="setupFailure ? setupFailure.message : firstRoom.error.value"
        @select="selectedProviderId = $event" @sign-in="agents.signIn($event)" @cancel-sign-in="agents.cancelSignIn($event)"
        @open-link="agents.openSignInLink($event)" @submit-code="(id, code) => agents.submitCode(id, code)"
        @install="agents.openInstall($event)" @recheck="agents.recheck($event)" @start="startSetup" @retry="startSetup" @back="backToAgents"
        @skip="skipSetup" />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { roomThemePresets, type RoomThemeId } from "../../../../../../../shared/room-themes.mjs";
import type { DesktopAgentProviderId, DesktopAuthStatus } from "../../../../../electron/ipc-types";
import type { DesktopGitHubAccessReason, DesktopOrganization } from "../../../../../electron/ipc-types/organizations";
import type { CompanyListStatus } from "../../../composables/useDesktopOrganizations";
import OnboardingAgentStep from "./OnboardingAgentStep.vue";
import OnboardingCompanyStep from "./OnboardingCompanyStep.vue";
import OnboardingWelcome from "./OnboardingWelcome.vue";
import { useOnboardingAgents } from "./useOnboardingAgents";
import {
  firstRoomProgressKey,
  ONBOARDING_AGENT_DEFAULT_AVATAR,
  ONBOARDING_AGENT_DEFAULT_NAME,
  useOnboardingFirstRoom,
  type FirstRoomTask,
} from "./useOnboardingFirstRoom";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  authBusy: boolean;
  authFeedback: string | null;
  /** The person's GitHub organizations as LetAgents knows them, and whether that list has loaded. */
  organizations: DesktopOrganization[];
  organizationsStatus: CompanyListStatus;
  /** Why the last company choice failed, in the company list's own words. */
  organizationsError: string | null;
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
  /** Setup made the first room: open it and close onboarding. Resolves null once it opened, else why not. */
  openRoom: (roomIdentifier: string) => Promise<string | null>;
  /** Skip: enter the app without a first room. Resolves null once it closed, else why not. */
  finish: () => Promise<string | null>;
}>();
const emit = defineEmits<{
  "start-auth": [];
  "cancel-auth": [];
  "open-verification": [url: string];
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
/** The company chosen first: the active one, else a set-up one, so Continue never sets up a new company by itself. */
function defaultCompanyId(): string | null {
  const owned = ownedOrganizations.value;
  return owned.find(org => org.github_org_id === props.selectedCompanyId)?.github_org_id
    ?? owned.find(org => org.setup)?.github_org_id
    ?? owned[0]?.github_org_id
    ?? null;
}
const organizationsLoading = computed(() => props.organizationsStatus === "loading" || props.organizationsStatus === "idle");
// Each GitHub check sets the list to loading; keep the last reason meanwhile, so the screen does not flash.
const lastAccess = ref<DesktopGitHubAccessReason | null>(props.organizationsAccess);
watch(() => [props.organizationsAccess, organizationsLoading.value] as const, ([access, loading]) => {
  if (!loading) lastAccess.value = access;
});
// No organizations from GitHub yet: the company step asks for that access first.
const companyAccess = computed(() => ownedOrganizations.value.length
  ? null
  : props.organizationsAccess ?? (organizationsLoading.value ? lastAccess.value : null));
const accessOpened = ref(false);
async function allowCompanyAccess() {
  accessOpened.value = true;
  try { await props.openOrganizationAccess(); } catch { companyError.value = "Couldn’t open GitHub. Try again."; }
}
async function checkCompanyAccess() {
  if (companyBusy.value) return;
  companyBusy.value = true;
  companyError.value = null;
  try { await props.refreshOrganizations(); } catch { /* The list's status says what happened. */ } finally { companyBusy.value = false; }
  if (companyAccess.value) companyError.value = "GitHub hasn’t shared your organizations yet. Allow it on GitHub, then check again.";
}
// Access came through (on return to the window, or Check again): owners pick their company; others go on.
// Only a list that loaded decides: a list GitHub could not give stays here with Try again.
watch(() => [ownedOrganizations.value.length, companyAccess.value, props.organizationsStatus] as const, ([owned, access, status]) => {
  if (stage.value !== "company" || access || status !== "ready") return;
  if (owned && !companyId.value) companyId.value = defaultCompanyId();
  if (!owned) enterAgentStep();
});
const currentTheme = (id: string | null) => ownedOrganizations.value.find(org => org.github_org_id === id)?.theme_id ?? null;
const companyId = ref<string | null>(null);
const companyTheme = ref<RoomThemeId>("mint");
const companyBusy = ref(false);
const companyError = ref<string | null>(null);
const chosenCompanyId = ref<string | null>(null);
/** The owner picked a colour on this screen. Only then does Continue save one. */
const themeTouched = ref(false);
function pickTheme(theme: RoomThemeId) {
  companyTheme.value = theme;
  themeTouched.value = true;
}
// Show the company's own colour first, so Continue changes nothing unless the owner picks a new one.
watch(companyId, id => {
  companyTheme.value = currentTheme(id) ?? "mint";
  themeTouched.value = false;
});
const companyAccent = computed(() => chosenCompanyId.value
  ? roomThemePresets.find(theme => theme.id === companyTheme.value)?.accent
  : undefined);

async function setUpCompany() {
  const id = companyId.value ?? ownedOrganizations.value[0]?.github_org_id;
  if (!id || companyBusy.value) return;
  companyBusy.value = true;
  companyError.value = null;
  try {
    const themeBefore = currentTheme(id);
    if (!(await props.chooseCompany(id))) {
      throw new Error(props.organizationsError || "Couldn’t set up the company. Check your connection and try again.");
    }
    chosenCompanyId.value = id;
    try {
      // An untouched colour is never written: a company with no colour keeps the default, and a
      // list that is out of date cannot overwrite a colour a co-owner chose meanwhile.
      if (themeTouched.value && companyTheme.value !== themeBefore) await props.saveCompanyTheme(id, companyTheme.value);
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
const firstRoom = useOnboardingFirstRoom({ storageKey: () => firstRoomProgressKey(props.authStatus) });
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

/** A failure outside the room setup itself: joining the invited company, or opening the room at the end. */
const setupFailure = ref<{ task: FirstRoomTask | null; message: string } | null>(null);
const finishError = ref<string | null>(null);
let setupBusy = false;
let invitedJoined = false;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function startSetup() {
  const providerId = selectedProviderId.value;
  if (!providerId || setupBusy || firstRoom.state.value === "running") return;
  setupBusy = true;
  setupFailure.value = null;
  finishError.value = null;
  firstRoom.prepare(providerId);
  stage.value = "setup";
  try {
    let organizationId = chosenCompanyId.value ?? props.selectedCompanyId;
    // A company link: join that company now, so the room is made in it. A room from an earlier
    // try already has its company.
    if (props.invitedCompanyId && !chosenCompanyId.value && !firstRoom.room.value) {
      if (!invitedJoined) {
        let joined = false;
        try { joined = await props.chooseCompany(props.invitedCompanyId); } catch { joined = false; }
        if (!joined) {
          setupFailure.value = {
            task: "room",
            message: props.organizationsError || "Couldn’t join the company from your invite. Check your connection and try again.",
          };
          return;
        }
        invitedJoined = true;
      }
      organizationId = props.invitedCompanyId;
    }
    // Setup already finished and only the opening failed: open again, nothing else.
    const ok = firstRoom.state.value === "done" && firstRoom.room.value
      ? true
      : await firstRoom.run({ providerId, organizationId });
    const room = firstRoom.room.value;
    if (!ok || !room || stage.value !== "setup") return;
    // Let the last check land before the room takes over.
    await pause(420);
    if (stage.value !== "setup") return;
    let failure: string | null;
    try { failure = await props.openRoom(room.roomIdentifier); } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    if (failure !== null) {
      if (stage.value === "setup") setupFailure.value = { task: null, message: failure || "Couldn’t open your Welcome room. Try again." };
      return;
    }
    firstRoom.forget();
  } finally {
    setupBusy = false;
  }
}

function backToAgents() {
  setupFailure.value = null;
  stage.value = "agent";
}

let finishing = false;
async function skipSetup() {
  if (finishing) return;
  finishing = true;
  finishError.value = null;
  try {
    let failure: string | null;
    try { failure = await props.finish(); } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    // The error shows on the agent screen; Skip for now tries again.
    if (failure !== null) finishError.value = failure || "Couldn’t close setup. Try again.";
    else firstRoom.forget();
  } finally {
    finishing = false;
  }
}

// ---- Welcome → next screen: the welcome stays on top and morphs into the screen beneath it.
async function leaveWelcome() {
  if (morphing.value || stage.value !== "welcome") return;
  // The organization list loads right after sign-in; give it a moment before choosing the next screen.
  const deadline = performance.now() + 2000;
  while (organizationsLoading.value && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!props.authStatus?.authenticated || stage.value !== "welcome") return;
  // A list GitHub could not give is shown with Try again, not skipped. A loaded list with no
  // company to own goes on to the agent.
  const listUnavailable = props.organizationsStatus === "unavailable" && !ownedOrganizations.value.length;
  const next: Stage = ownedOrganizations.value.length || companyAccess.value || listUnavailable ? "company" : "agent";
  if (next === "company") companyId.value = defaultCompanyId();
  morphing.value = true;
  if (next === "agent") enterAgentStep(); else stage.value = "company";
  await nextTick();
  const target = (next === "company" ? companyStep.value : agentStep.value)?.$el as HTMLElement | undefined;
  await welcome.value?.morphTo(target ?? null);
  morphing.value = false;
  // Signed out while the welcome morphed: go back now (the watch below skipped it).
  if (!props.authStatus?.authenticated) { stage.value = "welcome"; return; }
  await nextTick();
  (next === "company" ? companyStep.value : agentStep.value)?.focusHeading();
}

/** Another person (or nobody) is signed in now: nothing chosen for the last account carries over. */
function forgetAccountState() {
  companyId.value = null;
  companyTheme.value = "mint";
  themeTouched.value = false;
  chosenCompanyId.value = null;
  companyError.value = null;
  accessOpened.value = false;
  setupFailure.value = null;
  finishError.value = null;
  invitedJoined = false;
  firstRoom.reset();
}

// Signed out in another window while on a later screen: back to the welcome page.
// (During the morph, leaveWelcome goes back once the morph ends.)
watch(() => props.authStatus?.authenticated, (signedIn) => {
  if (!signedIn && stage.value !== "welcome" && !morphing.value) stage.value = "welcome";
});
watch(() => (props.authStatus?.authenticated ? props.authStatus.account?.id ?? null : null), (account, before) => {
  if (account !== before) forgetAccountState();
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
