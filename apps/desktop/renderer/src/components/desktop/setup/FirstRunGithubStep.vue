<template>
  <section class="github-onboarding" :data-state="state" data-testid="first-run-github-step">
    <div class="github-connection" aria-hidden="true">
      <span class="connection-origin"><LetAgentsLogoMark data-onboarding-logo-seat /></span>
      <svg class="connection-thread" viewBox="0 0 68 26" fill="none">
        <path class="thread-secondary" d="M0 11C18 8 49 12 68 16M0 16C22 6 49 9 68 13" pathLength="1" />
        <path class="thread-main" d="M0 14C24 17 45 9 68 13" pathLength="1" />
        <circle v-if="busy && state === 'idle' || state === 'pending'" class="thread-signal" cx="0" cy="0" r="2" />
        <path v-if="state === 'authenticated'" class="thread-check" d="m28 13 4 4L41 8" pathLength="1" />
      </svg>
      <svg class="connection-github" viewBox="0 0 24 24">
        <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.95.68 1.92v2.8c0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
      </svg>
    </div>

    <Transition name="github-phase" mode="out-in" @after-enter="focusHeading">
      <div :key="state" class="github-phase">
        <header class="github-heading">
          <h1 ref="heading" tabindex="-1">{{ headline }}</h1>
          <p>{{ description }}</p>
        </header>

        <div v-if="state === 'authenticated' && authStatus?.account" class="connected-account" data-testid="first-run-auth-account">
          <span class="connected-avatar" aria-hidden="true">
            <img v-if="authStatus.account.avatarUrl" :src="authStatus.account.avatarUrl" alt="">
            <template v-else>{{ loginInitials(authStatus.account.login) }}</template>
          </span>
          <span>{{ authStatus.account.displayName || '@' + authStatus.account.login }}</span>
          <small v-if="authStatus.account.displayName">@{{ authStatus.account.login }}</small>
        </div>

        <div v-if="state === 'pending' && pendingAuth" class="approval-code" data-testid="first-run-device-code">
          <strong>{{ pendingAuth.userCode }}</strong>
          <button class="github-quiet" type="button" :data-copied="copied"
            :aria-label="copied ? 'Code copied' : 'Copy approval code'" data-testid="first-run-auth-copy-code" @click="copy(pendingAuth.userCode)">
            <Check v-if="copied" aria-hidden="true" /><Copy v-else aria-hidden="true" />
            {{ copied ? "Copied" : "Copy" }}
          </button>
        </div>

        <footer v-if="state === 'authenticated'" class="github-controls">
          <button class="primary-button onboarding-primary" type="button" :disabled="setupBusy"
            data-testid="first-run-to-room" @click="emit('continue')">Continue <ArrowRight aria-hidden="true" /></button>
          <button class="github-quiet" type="button" :disabled="busy" data-testid="first-run-auth-sign-out"
            @click="emit('sign-out')">Switch account</button>
        </footer>
        <footer v-else-if="pendingAuth" class="github-controls">
          <div class="github-browser-actions">
            <button class="primary-button onboarding-primary onboarding-external" type="button" :disabled="busy"
              data-testid="first-run-auth-open" @click="emit('open-verification', pendingAuth.verificationUri)">
              Open GitHub <ArrowUpRight aria-hidden="true" />
            </button>
            <button class="github-quiet" type="button" :disabled="busy" data-testid="first-run-auth-poll"
              @click="emit('poll-auth')">{{ busy ? "Checking…" : "Check now" }}</button>
          </div>
          <button class="github-quiet" type="button" :disabled="busy" data-testid="first-run-auth-cancel"
            @click="emit('cancel-auth')">Cancel sign-in</button>
        </footer>
        <footer v-else class="github-controls">
          <button class="primary-button onboarding-primary onboarding-external" type="button" :disabled="busy"
            data-testid="first-run-auth-start" @click="emit('start-auth')">
            {{ busy ? "Opening GitHub…" : "Sign in with GitHub" }} <ArrowUpRight aria-hidden="true" />
          </button>
          <button class="github-quiet" type="button" :disabled="setupBusy" data-testid="first-run-back"
            @click="emit('back')"><ArrowLeft aria-hidden="true" /> Back</button>
        </footer>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy } from "@lucide/vue";
import { computed, ref } from "vue";
import type { DesktopAuthStatus } from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { loginInitials } from "../../../domain/initials";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";

const props = defineProps<{ authStatus: DesktopAuthStatus | null; busy: boolean; setupBusy: boolean }>();
const emit = defineEmits<{
  "start-auth": [];
  back: [];
  continue: [];
  "cancel-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
}>();

const pendingAuth = computed(() => props.authStatus?.pendingDeviceAuth ?? null);
const state = computed(() => props.authStatus?.authenticated ? "authenticated" : pendingAuth.value ? "pending" : "idle");
const headline = computed(() => state.value === "authenticated" ? "GitHub connected"
  : state.value === "pending" ? "Finish in your browser" : "Sign in to LetAgents");
const description = computed(() => state.value === "authenticated" ? "Choose where you’ll work."
  : state.value === "pending" ? "Confirm that this code matches on GitHub." : "Use GitHub to open rooms for your repositories.");
const heading = ref<HTMLElement | null>(null);
function focusHeading() {
  heading.value?.focus({ preventScroll: true });
}
const { copied, copy } = useCopyIndicator();
</script>

<style scoped>
.github-onboarding { min-height: 286px; color: #eeefe8; }
.github-connection { display: flex; align-items: center; width: fit-content; height: 38px; gap: 6px; margin: 0 0 19px 2px; }
.connection-origin { display: grid; place-items: center; width: 32px; height: 32px; color: #e1e6df; }
.connection-origin svg { width: 24px; height: 23px; --letagents-logo-accent: var(--onboarding-accent); }
.connection-github { width: 31px; height: 31px; color: #eeefe8; }
.connection-thread { width: 68px; height: 26px; overflow: visible; color: var(--onboarding-accent); }
.thread-main, .thread-secondary { stroke: currentColor; opacity: .39; }
.thread-secondary { opacity: .20; }
.thread-signal { fill: currentColor; filter: drop-shadow(0 0 4px currentColor); offset-path: path("M0 14C24 17 45 9 68 13"); animation: github-signal 1.65s ease-in-out infinite; }
.thread-check { stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; animation: github-thread-draw 360ms var(--first-run-motion-ease) both; }
.github-onboarding[data-state="authenticated"] .thread-main { opacity: .24; }
.github-heading h1 { margin: 0; font-size: clamp(28px, 5vw, 36px); font-weight: 625; letter-spacing: -.045em; line-height: 1.12; outline: none; text-wrap: balance; }
.github-heading p { margin: 9px 0 0; color: #abb3af; font-size: 14px; line-height: 1.55; text-wrap: pretty; }
.github-controls, .github-browser-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.github-controls { justify-content: space-between; margin-top: 23px; }
.github-quiet { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 6px; border: 0; border-radius: 7px; background: transparent; color: #abb3af; font: inherit; font-size: 13px; cursor: pointer; transition: color 160ms ease, background-color 160ms ease; }
.github-quiet:enabled:is(:hover, :focus-visible) { color: #eeefe8; background: #ffffff0b; }
.github-quiet svg { width: 14px; height: 14px; }
.approval-code { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding: 5px 8px 5px 12px; background: #ffffff06; border: 1px solid #ffffff19; border-radius: 10px; }
.approval-code strong { font-family: ui-monospace, monospace; font-weight: 540; font-size: 16px; letter-spacing: .11em; }
.approval-code .github-quiet[data-copied="true"] { color: var(--onboarding-accent); }
.connected-account { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 9px; margin-top: 18px; font-size: 13px; }
.connected-account small { color: #abb3af; }
.connected-avatar { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: #a8dec720; overflow: hidden; }
.connected-avatar img { width: 100%; height: 100%; object-fit: cover; }
.github-phase-enter-active { transition: opacity 220ms ease, transform 300ms var(--first-run-motion-ease); }
.github-phase-leave-active { transition: opacity 90ms ease; pointer-events: none; }
.github-phase-enter-from { opacity: 0; transform: translateY(6px); }
.github-phase-leave-to { opacity: 0; }
[data-handoff="true"] .connection-origin { animation: github-origin-in 230ms ease 360ms both; }
[data-handoff="true"] .thread-main,
[data-handoff="true"] .thread-secondary { stroke-dasharray: 1; animation: github-thread-draw 430ms var(--first-run-motion-ease) 350ms both; }
[data-handoff="true"] .connection-github { animation: github-mark-in 420ms var(--first-run-motion-ease) 390ms both; }
[data-handoff="true"] .github-phase { animation: github-content-in 430ms var(--first-run-motion-ease) 220ms both; }
@keyframes github-origin-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes github-mark-in { from { opacity: 0; transform: translateX(-4px) scale(.92); } to { opacity: 1; transform: none; } }
@keyframes github-content-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }
@keyframes github-thread-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes github-signal { 0% { offset-distance: 0%; opacity: 0; } 22% { opacity: 1; } 76%, 100% { offset-distance: 100%; opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .github-connection *, .github-phase { animation: none !important; transition: none !important; }
  .github-phase-enter-from { transform: none; }
  .thread-signal { offset-distance: 50%; }
}
</style>
