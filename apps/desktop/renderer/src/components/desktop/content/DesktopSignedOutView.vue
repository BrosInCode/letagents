<template>
  <section class="signed-out-view" data-testid="desktop-signed-out-view">
    <header class="signed-out-brand">
      <span class="signed-out-logo"><LetAgentsLogoMark /></span>
      <span>LetAgents</span>
    </header>

    <div class="signed-out-layout">
      <div class="signed-out-intro">
        <div class="signed-out-network" aria-hidden="true">
          <svg viewBox="0 0 720 540" preserveAspectRatio="xMidYMid slice">
            <g class="network-connections">
              <path d="M84 126 194 84 284 160 401 92 526 146 636 96" />
              <path d="M84 126 148 246 284 160 344 286 526 146 592 268 636 96" />
              <path d="M148 246 76 366 226 424 344 286 456 412 592 268 654 408" />
              <path d="M76 366 186 324 226 424 376 472 456 412 654 408" />
              <path d="M194 84 186 324M401 92 456 412M284 160 592 268M344 286 654 408" />
            </g>
            <g class="network-nodes network-nodes-a">
              <circle cx="84" cy="126" r="5" /><circle cx="284" cy="160" r="7" />
              <circle cx="526" cy="146" r="5" /><circle cx="76" cy="366" r="4" />
              <circle cx="344" cy="286" r="8" /><circle cx="654" cy="408" r="5" />
            </g>
            <g class="network-nodes network-nodes-b">
              <circle cx="194" cy="84" r="4" /><circle cx="401" cy="92" r="5" />
              <circle cx="636" cy="96" r="4" /><circle cx="148" cy="246" r="5" />
              <circle cx="592" cy="268" r="7" /><circle cx="186" cy="324" r="4" />
              <circle cx="226" cy="424" r="6" /><circle cx="376" cy="472" r="4" />
              <circle cx="456" cy="412" r="6" />
            </g>
          </svg>
        </div>

        <h1 :aria-label="collaborationStatement">
          <span class="signed-out-wordmark" aria-hidden="true">LetAgents</span>
          <span class="signed-out-phrase-window" aria-hidden="true">
            <Transition name="signed-out-phrase" mode="out-in">
              <span :key="activePhrase" class="signed-out-phrase">{{ activePhrase }}</span>
            </Transition>
          </span>
        </h1>
      </div>

      <article class="signed-out-auth-card" :data-state="pendingAuth ? 'code' : 'connect'">
        <div class="signed-out-github-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.95.68 1.92v2.8c0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
          </svg>
        </div>

        <template v-if="pendingAuth">
          <div class="signed-out-card-heading">
            <p>GitHub device sign-in</p>
            <h2>Enter this code on GitHub</h2>
            <span>It is one-time and expires {{ expiryLabel }}.</span>
          </div>

          <button
            class="signed-out-code"
            :class="{ 'is-copied': copied }"
            type="button"
            data-testid="signed-out-device-code"
            :aria-label="copied ? 'GitHub device code copied' : 'Copy GitHub device code'"
            @click="copyCode"
          >
            <small>One-time code</small>
            <code>{{ pendingAuth.userCode }}</code>
            <span aria-live="polite"><Check v-if="copied" aria-hidden="true" /><Copy v-else aria-hidden="true" />{{ copied ? "Copied" : "Copy code" }}</span>
          </button>

          <div class="signed-out-actions">
            <button
              class="signed-out-primary"
              type="button"
              :disabled="busy"
              data-testid="signed-out-open-github"
              @click="$emit('open-verification', pendingAuth.verificationUri)"
            >
              Open GitHub <ArrowUpRight aria-hidden="true" />
            </button>
            <button
              class="signed-out-secondary"
              type="button"
              :disabled="busy"
              data-testid="signed-out-check-now"
              @click="$emit('poll-auth')"
            >
              <LoaderCircle v-if="busy" class="signed-out-spinner" aria-hidden="true" />
              <RefreshCw v-else aria-hidden="true" />
              {{ busy ? "Checking…" : "Check now" }}
            </button>
          </div>

          <div class="signed-out-waiting" role="status">
            <span aria-hidden="true"><i></i><i></i><i></i></span>
            <p><strong>Waiting for approval</strong><small>This screen updates automatically.</small></p>
          </div>
        </template>

        <template v-else>
          <div class="signed-out-card-heading">
            <p>GitHub device sign-in</p>
            <h2>Continue with GitHub</h2>
            <span>LetAgents will show a one-time code here before opening your browser.</span>
          </div>

          <button
            class="signed-out-primary signed-out-connect"
            type="button"
            :disabled="busy"
            data-testid="signed-out-start-auth"
            @click="$emit('start-auth')"
          >
            <LoaderCircle v-if="busy" class="signed-out-spinner" aria-hidden="true" />
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.95.68 1.92v2.8c0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
            </svg>
            {{ busy ? "Creating your code…" : "Continue with GitHub" }}
          </button>

          <ol class="signed-out-steps" aria-label="Sign-in steps">
            <li><span>1</span>Get a one-time code</li>
            <li><span>2</span>Approve it on GitHub</li>
            <li><span>3</span>Return to your rooms</li>
          </ol>
        </template>

        <p v-if="effectiveFeedback" class="signed-out-feedback" role="status" data-testid="signed-out-auth-feedback">
          {{ effectiveFeedback }}
        </p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  ArrowUpRight,
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { DesktopAuthStatus } from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  feedback: string | null;
}>();

defineEmits<{
  "start-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
}>();

const pendingAuth = computed(() => props.authStatus?.pendingDeviceAuth || null);
const effectiveFeedback = computed(() => props.feedback || props.authStatus?.error || null);
const now = ref(Date.now());
const phrases = [
  "work with you.",
  "think with you.",
  "build with you.",
  "collaborate with you.",
  "ship with you.",
] as const;
const phraseIndex = ref(0);
const activePhrase = computed(() => phrases[phraseIndex.value]);
const collaborationStatement = "LetAgents work with you, think with you, build with you, collaborate with you, and ship with you.";
const { copied, copy } = useCopyIndicator();
let clock: number | null = null;
let phraseClock: number | null = null;

const expiryLabel = computed(() => {
  const expiresAt = pendingAuth.value?.expiresAt;
  if (!expiresAt) return "soon";
  const remainingMs = Date.parse(expiresAt) - now.value;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "soon";
  return `in ${Math.max(1, Math.ceil(remainingMs / 60_000))} min`;
});

async function copyCode(): Promise<void> {
  const code = pendingAuth.value?.userCode;
  if (code) await copy(code);
}

onMounted(() => {
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 15_000);
  phraseClock = window.setInterval(() => {
    phraseIndex.value = (phraseIndex.value + 1) % phrases.length;
  }, 3_200);
});

onBeforeUnmount(() => {
  if (clock !== null) window.clearInterval(clock);
  if (phraseClock !== null) window.clearInterval(phraseClock);
});
</script>

<style scoped>
.signed-out-view {
  width: min(1180px, 100%);
  min-height: calc(100vh - 56px);
  display: grid;
  grid-template-rows: auto 1fr;
  gap: clamp(30px, 5vh, 56px);
}

.signed-out-brand {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  color: var(--text);
  font-size: 0.92rem;
  font-weight: 720;
  letter-spacing: -0.015em;
}

.signed-out-logo {
  width: 27px;
  height: 27px;
  color: var(--text);
  --letagents-logo-accent: var(--text);
}

.signed-out-layout {
  align-self: center;
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(330px, 0.72fr);
  align-items: center;
  gap: clamp(56px, 9vw, 128px);
}

.signed-out-intro {
  position: relative;
  display: flex;
  min-height: clamp(390px, 54vh, 560px);
  align-items: center;
  isolation: isolate;
}

.signed-out-card-heading p,
.signed-out-card-heading h2,
.signed-out-card-heading span,
.signed-out-waiting p,
.signed-out-feedback {
  margin: 0;
}

.signed-out-card-heading p {
  color: var(--text);
  font-size: 0.68rem;
  font-weight: 760;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.signed-out-intro h1 {
  position: relative;
  z-index: 2;
  display: grid;
  gap: 0.08em;
  width: 100%;
  margin: 0;
  color: var(--text);
  font-size: clamp(3.2rem, 6.1vw, 5.8rem);
  font-weight: 690;
  letter-spacing: -0.068em;
  line-height: 0.93;
}

.signed-out-wordmark {
  display: block;
}

.signed-out-phrase-window {
  position: relative;
  display: block;
  min-height: 1.04em;
  color: var(--text);
}

.signed-out-phrase {
  position: absolute;
  inset: 0 auto auto 0;
  display: block;
  white-space: nowrap;
}

.signed-out-phrase-enter-active {
  transition: opacity 420ms cubic-bezier(0.23, 1, 0.32, 1), transform 420ms cubic-bezier(0.23, 1, 0.32, 1);
}

.signed-out-phrase-leave-active {
  transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.signed-out-phrase-enter-from {
  opacity: 0;
  transform: translateY(0.28em);
}

.signed-out-phrase-leave-to {
  opacity: 0;
  transform: translateY(-0.18em);
}

.signed-out-network {
  position: absolute;
  z-index: 1;
  inset: -7% -10% -7% -14%;
  overflow: hidden;
  color: var(--text);
  opacity: 0.32;
  pointer-events: none;
}

.signed-out-network svg {
  width: 100%;
  height: 100%;
  animation: signed-out-network-drift 18s cubic-bezier(0.77, 0, 0.175, 1) infinite alternate;
}

.network-connections {
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  stroke-linecap: round;
  opacity: 0.28;
  animation: signed-out-network-breathe 5.8s cubic-bezier(0.77, 0, 0.175, 1) infinite;
}

.network-nodes {
  fill: currentColor;
  transform-box: fill-box;
  transform-origin: center;
}

.network-nodes-a {
  animation: signed-out-nodes-a 6.4s cubic-bezier(0.77, 0, 0.175, 1) infinite alternate;
}

.network-nodes-b {
  opacity: 0.52;
  animation: signed-out-nodes-b 7.2s cubic-bezier(0.77, 0, 0.175, 1) infinite alternate;
}

.signed-out-auth-card {
  position: relative;
  display: grid;
  gap: 19px;
  width: min(100%, 390px);
  justify-self: end;
  padding: clamp(10px, 2vw, 20px) 0;
}

.signed-out-github-mark {
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  border-radius: 13px;
  color: var(--text);
  background: var(--setup-surface-muted);
}

.signed-out-github-mark svg { width: 22px; height: 22px; }
.signed-out-card-heading { display: grid; gap: 7px; }
.signed-out-card-heading h2 { color: var(--text); font-size: 1.55rem; font-weight: 700; letter-spacing: -0.04em; }
.signed-out-card-heading span { color: var(--text-secondary); font-size: 0.82rem; line-height: 1.5; }

.signed-out-primary,
.signed-out-secondary,
.signed-out-code {
  font: inherit;
  cursor: pointer;
}

.signed-out-primary,
.signed-out-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 43px;
  padding: 10px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  font-size: 0.8rem;
  font-weight: 680;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), border-color 160ms ease, background-color 160ms ease;
}

.signed-out-primary {
  border-color: color-mix(in srgb, var(--text) 78%, transparent);
  color: var(--setup-bg);
  background: var(--text);
}

.signed-out-secondary { color: var(--text); background: var(--setup-surface-muted); }
.signed-out-connect { width: 100%; }
.signed-out-primary svg, .signed-out-secondary svg { width: 16px; height: 16px; }
.signed-out-primary:active:not(:disabled), .signed-out-secondary:active:not(:disabled) { transform: scale(0.985); }
.signed-out-primary:focus-visible, .signed-out-secondary:focus-visible, .signed-out-code:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
.signed-out-primary:disabled, .signed-out-secondary:disabled { opacity: 0.5; cursor: default; }

.signed-out-actions { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 9px; }

.signed-out-code {
  display: grid;
  place-items: center;
  gap: 7px;
  width: 100%;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--text) 28%, var(--border));
  border-radius: 15px;
  color: var(--text);
  background: color-mix(in srgb, var(--text) 6%, var(--setup-surface-muted));
}

.signed-out-code small { color: var(--text-tertiary); font-size: 0.64rem; font-weight: 720; text-transform: uppercase; letter-spacing: 0.12em; }
.signed-out-code code { font-family: var(--font-mono); font-size: clamp(1.65rem, 4vw, 2.08rem); font-weight: 760; letter-spacing: 0.13em; }
.signed-out-code span { display: inline-flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 0.69rem; font-weight: 650; }
.signed-out-code span svg { width: 13px; height: 13px; }
.signed-out-code.is-copied span { color: var(--text); }

.signed-out-waiting {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 11px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: color-mix(in srgb, var(--setup-surface-muted) 72%, transparent);
}

.signed-out-waiting > span { display: inline-flex; gap: 3px; }
.signed-out-waiting i { width: 4px; height: 4px; border-radius: 50%; background: var(--text); animation: signed-out-pulse 1.15s ease-in-out infinite; }
.signed-out-waiting i:nth-child(2) { animation-delay: 130ms; }
.signed-out-waiting i:nth-child(3) { animation-delay: 260ms; }
.signed-out-waiting p { display: grid; gap: 2px; }
.signed-out-waiting strong { color: var(--text); font-size: 0.73rem; }
.signed-out-waiting small { color: var(--text-tertiary); font-size: 0.67rem; }

.signed-out-steps { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.signed-out-steps li { position: relative; display: grid; grid-template-columns: 28px 1fr; align-items: center; gap: 10px; min-height: 42px; color: var(--text-secondary); font-size: 0.74rem; }
.signed-out-steps li:not(:last-child)::after { content: ""; position: absolute; top: 31px; bottom: -11px; left: 13px; width: 1px; background: var(--border); }
.signed-out-steps span { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: 50%; color: var(--text-tertiary); background: var(--setup-surface-muted); font-size: 0.66rem; font-weight: 700; }

.signed-out-feedback { padding: 10px 12px; border-radius: 9px; color: var(--text-secondary); background: var(--setup-surface-muted); font-size: 0.72rem; line-height: 1.45; }
.signed-out-spinner { animation: signed-out-spin 0.85s linear infinite; }

@keyframes signed-out-spin { to { transform: rotate(360deg); } }
@keyframes signed-out-pulse { 0%, 70%, 100% { opacity: 0.28; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-2px); } }
@keyframes signed-out-network-drift { from { transform: translate3d(-1.2%, 0.8%, 0) scale(1); } to { transform: translate3d(1.4%, -1%, 0) scale(1.025); } }
@keyframes signed-out-network-breathe { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.42; } }
@keyframes signed-out-nodes-a { from { opacity: 0.58; transform: translate3d(-3px, 2px, 0); } to { opacity: 0.95; transform: translate3d(4px, -3px, 0); } }
@keyframes signed-out-nodes-b { from { opacity: 0.34; transform: translate3d(4px, -2px, 0); } to { opacity: 0.72; transform: translate3d(-3px, 3px, 0); } }

@media (max-width: 820px) {
  .signed-out-view { gap: 30px; }
  .signed-out-layout { grid-template-columns: 1fr; gap: 34px; }
  .signed-out-intro { min-height: 310px; }
  .signed-out-intro h1 { font-size: clamp(3rem, 11vw, 4.8rem); }
  .signed-out-auth-card { width: min(100%, 500px); justify-self: start; padding-bottom: 32px; }
}

@media (max-width: 520px) {
  .signed-out-actions { grid-template-columns: 1fr; }
  .signed-out-intro { min-height: 250px; }
  .signed-out-intro h1 { font-size: clamp(2.4rem, 12vw, 3.6rem); }
  .signed-out-network { inset: -10% -30% -10% -24%; }
}

@media (hover: hover) and (pointer: fine) {
  .signed-out-primary:hover:not(:disabled),
  .signed-out-secondary:hover:not(:disabled) { transform: translateY(-1px); }
}

@media (prefers-reduced-motion: reduce) {
  .signed-out-phrase-enter-active,
  .signed-out-phrase-leave-active {
    transition: opacity 150ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .signed-out-phrase-enter-from,
  .signed-out-phrase-leave-to {
    transform: none;
  }

  .signed-out-primary,
  .signed-out-secondary { transition: none; }
  .signed-out-spinner,
  .signed-out-waiting i,
  .signed-out-network svg,
  .network-connections,
  .network-nodes-a,
  .network-nodes-b { animation: none; }
}
</style>
