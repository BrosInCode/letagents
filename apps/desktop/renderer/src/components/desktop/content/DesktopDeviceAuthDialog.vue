<template>
  <DesktopDialogShell
    :open="open"
    aria-labelledby="desktop-device-auth-title"
    backdrop-class="desktop-task-modal-backdrop desktop-device-auth-backdrop"
    panel-class="desktop-device-auth-dialog"
    :focus-key="pendingAuth?.requestId || (busy ? 'requesting' : 'ready')"
    :initial-focus="pendingAuth ? '[data-testid=desktop-auth-copy-code]' : undefined"
    test-id="desktop-device-auth-dialog"
    @close="$emit('close')"
  >
    <div class="desktop-device-auth-content">
      <div class="desktop-device-auth-mark" aria-hidden="true">
        <GitFork />
      </div>

      <header>
        <p>GitHub device sign-in</p>
        <h2 id="desktop-device-auth-title">Connect GitHub</h2>
        <span v-if="pendingAuth">Copy this one-time code, then enter it on GitHub.</span>
        <span v-else-if="busy">Requesting a one-time code from GitHub…</span>
        <span v-else>Request a one-time code to connect your account.</span>
      </header>

      <template v-if="pendingAuth">
        <div class="desktop-device-auth-code-card" data-testid="desktop-auth-pending-device-flow">
          <span>One-time code</span>
          <code data-testid="desktop-auth-device-code">{{ pendingAuth.userCode }}</code>
          <small>Expires {{ expiryLabel }}</small>
        </div>

        <div class="desktop-device-auth-actions">
          <button
            class="desktop-device-auth-primary"
            :class="{ 'is-copied': copied }"
            type="button"
            data-testid="desktop-auth-copy-code"
            @click="copyCode"
          >
            <Check v-if="copied" aria-hidden="true" />
            <Copy v-else aria-hidden="true" />
            {{ copied ? "Code copied" : "Copy code" }}
          </button>
          <button
            type="button"
            :disabled="busy"
            data-testid="desktop-auth-open-github"
            @click="$emit('open-verification', pendingAuth.verificationUri)"
          >
            <ExternalLink aria-hidden="true" />
            Open GitHub
          </button>
        </div>

        <div class="desktop-device-auth-waiting" role="status">
          <span><i></i><i></i><i></i></span>
          <p>
            <strong>Waiting for approval</strong>
            <small>LetAgents checks automatically after you enter the code.</small>
          </p>
          <button type="button" :disabled="busy" data-testid="desktop-auth-check-now" @click="$emit('poll-auth')">
            <LoaderCircle v-if="busy" class="desktop-device-auth-spinner" aria-hidden="true" />
            <RefreshCw v-else aria-hidden="true" />
            {{ busy ? "Checking…" : "Check now" }}
          </button>
        </div>
      </template>

      <template v-else>
        <div class="desktop-device-auth-requesting" :data-state="busy ? 'busy' : 'idle'">
          <LoaderCircle v-if="busy" aria-hidden="true" />
          <KeyRound v-else aria-hidden="true" />
          <p>
            <strong>{{ busy ? "Creating your code" : "No active code" }}</strong>
            <small>{{ busy ? "This normally takes a moment." : "Request a new code to continue." }}</small>
          </p>
        </div>
        <button
          v-if="!busy"
          class="desktop-device-auth-primary desktop-device-auth-retry"
          type="button"
          data-testid="desktop-auth-request-code"
          @click="$emit('start-auth')"
        >
          Request a new code
        </button>
      </template>

      <p v-if="effectiveFeedback" class="desktop-device-auth-feedback" role="status">
        {{ effectiveFeedback }}
      </p>

      <p class="desktop-device-auth-footnote">
        The code only connects LetAgents. Never enter a password or personal access token here.
      </p>
    </div>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { Check, Copy, ExternalLink, GitFork, KeyRound, LoaderCircle, RefreshCw } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { DesktopAuthStatus } from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import DesktopDialogShell from "./DesktopDialogShell.vue";

const props = defineProps<{
  open: boolean;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  feedback: string | null;
}>();

defineEmits<{
  close: [];
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
:deep(.desktop-device-auth-backdrop) {
  backdrop-filter: blur(8px);
}

:deep(.desktop-device-auth-dialog) {
  position: relative;
  width: min(468px, calc(100vw - 40px));
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-strong) 78%, white 8%);
  border-radius: 20px;
  outline: none;
  background: color-mix(in srgb, var(--bg-elevated) 96%, #0b1018);
  color: var(--text);
  box-shadow: var(--shadow-xl);
}

:deep(.desktop-device-auth-dialog .desktop-task-modal-close) {
  position: absolute;
  top: 18px;
  right: 18px;
  margin: 0;
  background: color-mix(in srgb, var(--bg-elevated) 84%, white 4%);
}

.desktop-device-auth-content {
  display: grid;
  gap: 18px;
  padding: 28px;
}

.desktop-device-auth-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  background: color-mix(in srgb, var(--accent-active) 82%, white 3%);
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 10%, transparent);
}

.desktop-device-auth-mark svg { width: 21px; height: 21px; }

header {
  display: grid;
  gap: 5px;
  padding-right: 44px;
}

header p,
header h2,
header span,
.desktop-device-auth-waiting p,
.desktop-device-auth-requesting p,
.desktop-device-auth-feedback,
.desktop-device-auth-footnote { margin: 0; }

header p {
  color: var(--text-tertiary);
  font-size: 0.67rem;
  font-weight: 720;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

header h2 {
  font-size: 1.45rem;
  font-weight: 720;
  letter-spacing: -0.035em;
}

header span {
  color: var(--text-secondary);
  font-size: 0.84rem;
  line-height: 1.5;
}

.desktop-device-auth-code-card {
  display: grid;
  place-items: center;
  gap: 8px;
  padding: 20px;
  border: 1px solid color-mix(in srgb, var(--blue) 30%, var(--border-strong));
  border-radius: 15px;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--blue) 10%, transparent), transparent 58%),
    color-mix(in srgb, var(--bg) 72%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 6%, transparent);
}

.desktop-device-auth-code-card span,
.desktop-device-auth-code-card small {
  color: var(--text-tertiary);
  font-size: 0.68rem;
  font-weight: 620;
}

.desktop-device-auth-code-card code {
  color: var(--text);
  font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
  font-size: clamp(1.7rem, 7vw, 2.15rem);
  font-weight: 760;
  letter-spacing: 0.12em;
  line-height: 1.2;
  user-select: all;
}

.desktop-device-auth-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
}

.desktop-device-auth-actions button,
.desktop-device-auth-retry,
.desktop-device-auth-waiting button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  padding: 9px 13px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--accent-active);
  color: var(--text);
  font: inherit;
  font-size: 0.79rem;
  font-weight: 650;
  cursor: pointer;
  transition: transform 100ms ease-out, border-color var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out);
}

.desktop-device-auth-actions button:hover:not(:disabled),
.desktop-device-auth-waiting button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--text-secondary) 54%, var(--border-strong)); }
.desktop-device-auth-actions button:active:not(:disabled),
.desktop-device-auth-waiting button:active:not(:disabled),
.desktop-device-auth-retry:active:not(:disabled) { transform: scale(0.98); }
.desktop-device-auth-actions button:focus-visible,
.desktop-device-auth-waiting button:focus-visible,
.desktop-device-auth-retry:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.desktop-device-auth-actions button:disabled,
.desktop-device-auth-waiting button:disabled { opacity: 0.52; cursor: default; }
.desktop-device-auth-actions svg,
.desktop-device-auth-waiting button svg { width: 15px; height: 15px; }

.desktop-device-auth-actions .desktop-device-auth-primary,
.desktop-device-auth-retry {
  border-color: color-mix(in srgb, white 28%, transparent);
  background: var(--text);
  color: var(--bg);
}

.desktop-device-auth-actions .desktop-device-auth-primary.is-copied {
  border-color: color-mix(in srgb, var(--green) 52%, transparent);
  background: color-mix(in srgb, var(--green) 82%, white);
}

.desktop-device-auth-waiting,
.desktop-device-auth-requesting {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg) 64%, transparent);
}

.desktop-device-auth-requesting { grid-template-columns: auto minmax(0, 1fr); }
.desktop-device-auth-requesting > svg { width: 18px; height: 18px; color: var(--text-tertiary); }
.desktop-device-auth-requesting[data-state="busy"] > svg { animation: desktop-device-auth-spin 0.9s linear infinite; }

.desktop-device-auth-waiting > span {
  display: flex;
  gap: 3px;
}

.desktop-device-auth-waiting > span i {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: var(--blue);
  animation: desktop-device-auth-pulse 1.2s ease-in-out infinite;
}

.desktop-device-auth-waiting > span i:nth-child(2) { animation-delay: 120ms; }
.desktop-device-auth-waiting > span i:nth-child(3) { animation-delay: 240ms; }

.desktop-device-auth-waiting p,
.desktop-device-auth-requesting p { display: grid; gap: 2px; }
.desktop-device-auth-waiting strong,
.desktop-device-auth-requesting strong { font-size: 0.76rem; }
.desktop-device-auth-waiting small,
.desktop-device-auth-requesting small { color: var(--text-tertiary); font-size: 0.67rem; line-height: 1.35; }

.desktop-device-auth-waiting button {
  min-height: 32px;
  padding: 6px 9px;
  background: transparent;
  font-size: 0.69rem;
}

.desktop-device-auth-feedback {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--blue) 7%, transparent);
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.45;
}

.desktop-device-auth-footnote {
  color: var(--text-tertiary);
  font-size: 0.65rem;
  line-height: 1.45;
  text-align: center;
}

.desktop-device-auth-retry { width: 100%; }
.desktop-device-auth-spinner { animation: desktop-device-auth-spin 0.9s linear infinite; }

@keyframes desktop-device-auth-spin { to { transform: rotate(360deg); } }
@keyframes desktop-device-auth-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

@media (max-width: 520px) {
  .desktop-device-auth-content { padding: 24px 20px 20px; }
  .desktop-device-auth-actions { grid-template-columns: 1fr; }
  .desktop-device-auth-code-card code { font-size: 1.55rem; }
  .desktop-device-auth-waiting { grid-template-columns: auto minmax(0, 1fr); }
  .desktop-device-auth-waiting button { grid-column: 1 / -1; }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-device-auth-requesting[data-state="busy"] > svg,
  .desktop-device-auth-spinner,
  .desktop-device-auth-waiting > span i { animation: none; }
  .desktop-device-auth-actions button,
  .desktop-device-auth-retry,
  .desktop-device-auth-waiting button { transition: none; }
}
</style>
