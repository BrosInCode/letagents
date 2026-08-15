<template>
  <section class="signed-out-view" data-testid="desktop-signed-out-view">
    <header class="signed-out-brand">
      <span class="signed-out-logo"><LetAgentsLogoMark /></span>
      <span>LetAgents</span>
    </header>

    <div class="signed-out-layout">
      <div class="signed-out-intro">
        <p class="signed-out-kicker">Signed-out mode</p>
        <h1>Your rooms stay out of sight until you sign in.</h1>
        <p class="signed-out-summary">
          Connect GitHub to restore your rooms, agents, and shared work on this device.
        </p>

        <div class="signed-out-boundary" aria-label="What sign-in restores">
          <span><ShieldCheck aria-hidden="true" /></span>
          <div>
            <strong>One clear privacy boundary</strong>
            <p>The room list, messages, tasks, and composer remain unmounted while you are signed out.</p>
          </div>
        </div>
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
        <p class="signed-out-footnote">No password or personal access token is entered in LetAgents.</p>
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
  ShieldCheck,
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
const { copied, copy } = useCopyIndicator();
let clock: number | null = null;

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
});

onBeforeUnmount(() => {
  if (clock !== null) window.clearInterval(clock);
});
</script>

<style scoped>
.signed-out-view {
  width: min(1120px, 100%);
  min-height: calc(100vh - 56px);
  display: grid;
  grid-template-rows: auto 1fr;
  gap: clamp(42px, 8vh, 84px);
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
  --letagents-logo-accent: var(--setup-accent);
}

.signed-out-layout {
  align-self: start;
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(360px, 0.78fr);
  align-items: center;
  gap: clamp(48px, 8vw, 112px);
}

.signed-out-intro {
  display: grid;
  gap: 20px;
  max-width: 620px;
}

.signed-out-kicker,
.signed-out-summary,
.signed-out-boundary p,
.signed-out-card-heading p,
.signed-out-card-heading h2,
.signed-out-card-heading span,
.signed-out-waiting p,
.signed-out-feedback,
.signed-out-footnote {
  margin: 0;
}

.signed-out-kicker,
.signed-out-card-heading p {
  color: var(--setup-accent);
  font-size: 0.68rem;
  font-weight: 760;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.signed-out-intro h1 {
  max-width: 660px;
  margin: 0;
  color: var(--text);
  font-size: clamp(2.55rem, 5.3vw, 4.65rem);
  font-weight: 670;
  letter-spacing: -0.062em;
  line-height: 0.98;
}

.signed-out-summary {
  max-width: 520px;
  color: var(--text-secondary);
  font-size: 1rem;
  line-height: 1.65;
}

.signed-out-boundary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 13px;
  align-items: start;
  max-width: 510px;
  padding-top: 7px;
}

.signed-out-boundary > span {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid color-mix(in srgb, var(--setup-accent) 30%, var(--border));
  border-radius: 50%;
  color: var(--setup-accent);
  background: var(--setup-accent-soft);
}

.signed-out-boundary svg { width: 16px; height: 16px; }
.signed-out-boundary div { display: grid; gap: 4px; }
.signed-out-boundary strong { color: var(--text); font-size: 0.82rem; }
.signed-out-boundary p { color: var(--text-tertiary); font-size: 0.76rem; line-height: 1.55; }

.signed-out-auth-card {
  position: relative;
  display: grid;
  gap: 19px;
  padding: clamp(24px, 3vw, 32px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 22px;
  background:
    radial-gradient(circle at 100% 0%, var(--setup-accent-soft), transparent 38%),
    var(--setup-surface);
  box-shadow: 0 24px 70px color-mix(in srgb, #000 13%, transparent), inset 0 1px 0 color-mix(in srgb, white 45%, transparent);
}

.signed-out-github-mark {
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  border: 1px solid var(--border-strong);
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
  transition: transform 100ms ease-out, border-color 160ms ease-out, background-color 160ms ease-out;
}

.signed-out-primary {
  border-color: color-mix(in srgb, var(--text) 78%, transparent);
  color: var(--setup-bg);
  background: var(--text);
}

.signed-out-secondary { color: var(--text); background: var(--setup-surface-muted); }
.signed-out-connect { width: 100%; }
.signed-out-primary svg, .signed-out-secondary svg { width: 16px; height: 16px; }
.signed-out-primary:hover:not(:disabled), .signed-out-secondary:hover:not(:disabled) { transform: translateY(-1px); }
.signed-out-primary:active:not(:disabled), .signed-out-secondary:active:not(:disabled) { transform: scale(0.985); }
.signed-out-primary:focus-visible, .signed-out-secondary:focus-visible, .signed-out-code:focus-visible { outline: 2px solid var(--setup-accent); outline-offset: 3px; }
.signed-out-primary:disabled, .signed-out-secondary:disabled { opacity: 0.5; cursor: default; }

.signed-out-actions { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 9px; }

.signed-out-code {
  display: grid;
  place-items: center;
  gap: 7px;
  width: 100%;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--setup-accent) 28%, var(--border));
  border-radius: 15px;
  color: var(--text);
  background: color-mix(in srgb, var(--setup-accent) 6%, var(--setup-surface-muted));
}

.signed-out-code small { color: var(--text-tertiary); font-size: 0.64rem; font-weight: 720; text-transform: uppercase; letter-spacing: 0.12em; }
.signed-out-code code { font-family: var(--font-mono); font-size: clamp(1.65rem, 4vw, 2.08rem); font-weight: 760; letter-spacing: 0.13em; }
.signed-out-code span { display: inline-flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 0.69rem; font-weight: 650; }
.signed-out-code span svg { width: 13px; height: 13px; }
.signed-out-code.is-copied span { color: var(--green); }

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
.signed-out-waiting i { width: 4px; height: 4px; border-radius: 50%; background: var(--setup-accent); animation: signed-out-pulse 1.15s ease-in-out infinite; }
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
.signed-out-footnote { color: var(--text-tertiary); font-size: 0.65rem; line-height: 1.5; text-align: center; }
.signed-out-spinner { animation: signed-out-spin 0.85s linear infinite; }

@keyframes signed-out-spin { to { transform: rotate(360deg); } }
@keyframes signed-out-pulse { 0%, 70%, 100% { opacity: 0.28; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-2px); } }

@media (max-width: 820px) {
  .signed-out-view { gap: 30px; }
  .signed-out-layout { grid-template-columns: 1fr; gap: 34px; }
  .signed-out-intro { max-width: 560px; }
  .signed-out-intro h1 { font-size: clamp(2.4rem, 10vw, 3.65rem); }
  .signed-out-auth-card { width: min(100%, 500px); }
}

@media (max-width: 520px) {
  .signed-out-boundary { display: none; }
  .signed-out-actions { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .signed-out-primary,
  .signed-out-secondary { transition: none; }
  .signed-out-spinner,
  .signed-out-waiting i { animation: none; }
}
</style>
