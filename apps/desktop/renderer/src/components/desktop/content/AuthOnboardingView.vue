<template>
  <section class="auth-onboarding surface-page" data-testid="auth-onboarding-view">
    <div class="auth-access-card" :data-access-state="cardState" data-testid="auth-access-panel">
      <p class="auth-room-line">
        <span class="auth-dot" aria-hidden="true"></span>
        <code>{{ roomLabel }}</code>
        <span v-if="roomSuffix" class="auth-room-suffix">· {{ roomSuffix }}</span>
      </p>

      <Transition name="auth-state" mode="out-in">
        <div :key="cardState" class="auth-state">
          <template v-if="cardState === 'loading'">
            <h1>Opening the room…</h1>
            <div class="auth-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>
          </template>

          <template v-else-if="cardState === 'connect'">
            <h1>Connect GitHub to open this room</h1>
            <p>Approve once in your browser. This app remembers access after that.</p>
            <div class="auth-actions">
              <button
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="auth-start-button"
                @click="$emit('start-auth')"
              >
                {{ busy ? "Starting…" : "Continue with GitHub" }}
              </button>
            </div>
            <div class="auth-stepper" aria-label="Sign-in progress">
              <span class="auth-step" data-step-state="current"><span>1</span> Request code</span>
              <span class="auth-step-divider"></span>
              <span class="auth-step"><span>2</span> Approve in browser</span>
              <span class="auth-step-divider"></span>
              <span class="auth-step"><span>3</span> Back here</span>
            </div>
          </template>

          <template v-else-if="cardState === 'code' && pendingAuth">
            <div class="auth-code-block" data-testid="auth-pending-device-flow">
              <small>Enter this code on GitHub</small>
              <strong data-testid="auth-user-code">{{ pendingAuth.userCode }}</strong>
              <small>Expires {{ pendingExpiryLabel }}</small>
            </div>
            <div class="auth-actions">
              <button
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="auth-open-github-button"
                @click="$emit('open-verification', pendingAuth.verificationUri)"
              >
                Open GitHub
              </button>
              <button
                class="ghost-button"
                :class="{ 'auth-copied': codeCopied }"
                type="button"
                data-testid="auth-copy-code-button"
                @click="copyUserCode"
              >
                {{ codeCopied ? "Copied" : "Copy code" }}
              </button>
              <button
                class="auth-quiet-button"
                type="button"
                :disabled="busy"
                data-testid="auth-poll-button"
                @click="$emit('poll-auth')"
              >
                {{ busy ? "Checking…" : "Check now" }}
              </button>
            </div>
            <p class="auth-waiting" role="status">
              <span class="auth-waiting-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              Waiting for approval — this updates by itself
            </p>
            <div class="auth-stepper" aria-label="Sign-in progress">
              <span class="auth-step" data-step-state="done"><span>✓</span> Request code</span>
              <span class="auth-step-divider"></span>
              <span class="auth-step" data-step-state="current"><span>2</span> Approve in browser</span>
              <span class="auth-step-divider"></span>
              <span class="auth-step"><span>3</span> Back here</span>
            </div>
          </template>

          <template v-else-if="cardState === 'connected'">
            <h1>GitHub connected</h1>
            <p>Open the room to load its messages, tasks, and agents.</p>
            <div class="auth-actions">
              <button
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="auth-refresh-room-button"
                @click="$emit('refresh-room')"
              >
                Open the room
              </button>
              <button
                class="auth-quiet-button"
                type="button"
                :disabled="busy"
                data-testid="auth-sign-out-button"
                @click="$emit('sign-out')"
              >
                Use another account
              </button>
            </div>
          </template>

          <template v-else-if="cardState === 'forbidden'">
            <h1>{{ forbiddenTitle }}</h1>
            <p>This account doesn't have access to the repository behind it. Switch accounts, or ask a repo admin for access.</p>
            <span v-if="authStatus?.account" class="auth-account-chip" data-testid="auth-account">
              <span class="auth-avatar" aria-hidden="true">{{ loginInitials(authStatus.account.login) }}</span>
              <span>
                <strong>{{ authStatus.account.displayName || authStatus.account.login }}</strong>
                <small>· signed in</small>
              </span>
            </span>
            <div class="auth-actions">
              <button
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="auth-sign-out-button"
                @click="$emit('sign-out')"
              >
                Use another account
              </button>
              <button
                class="ghost-button"
                type="button"
                :disabled="busy"
                data-testid="auth-refresh-room-button"
                @click="$emit('refresh-room')"
              >
                Try again
              </button>
            </div>
          </template>

          <template v-else-if="cardState === 'missing'">
            <h1>Choose a room to begin</h1>
            <p>Pick a room from the sidebar, or create one to start working with agents.</p>
          </template>

          <template v-else>
            <h1>This room didn't load</h1>
            <p>
              LetAgents couldn't reach the room server.
              <template v-if="retrySecondsLeft !== null">
                <template v-if="retrySecondsLeft > 0">
                  It usually recovers on its own — retrying in
                  <b data-testid="auth-retry-countdown">{{ retrySecondsLeft }}</b>s.
                </template>
                <template v-else>Retrying…</template>
              </template>
            </p>
            <div class="auth-actions">
              <button
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="auth-refresh-room-button"
                @click="retryNow"
              >
                Retry now
              </button>
            </div>
          </template>
        </div>
      </Transition>

      <p v-if="effectiveFeedback" class="auth-feedback" data-testid="auth-feedback">{{ effectiveFeedback }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopAuthStatus,
  DesktopPendingDeviceAuth,
  DesktopRoomAccess,
} from "../../../../../electron/ipc-types";
import { friendlyRoomLabel } from "../../../domain/git-rooms";
import { loginInitials } from "../../../domain/initials";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import {
  nextRetryStep,
  resolveAuthCardState,
  retryDeadlineAt,
  retrySecondsLeft as computeRetrySecondsLeft,
} from "./auth-onboarding";

const props = defineProps<{
  access: DesktopRoomAccess;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  feedback: string | null;
  snapshotPending?: boolean;
  roomLabel?: string | null;
}>();

const emit = defineEmits<{
  "start-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "refresh-room": [];
  "sign-out": [];
}>();

const pendingAuth = computed<DesktopPendingDeviceAuth | null>(() => {
  return props.authStatus?.pendingDeviceAuth || null;
});

const effectiveFeedback = computed(() => {
  return props.feedback || props.authStatus?.error || null;
});

const cardState = computed(() =>
  resolveAuthCardState({
    snapshotPending: Boolean(props.snapshotPending),
    status: props.access.status,
    hasPendingAuth: Boolean(pendingAuth.value),
    authenticated: Boolean(props.authStatus?.authenticated),
  }),
);

const roomLabel = computed(() => {
  if (cardState.value === "missing") return "LetAgents";
  // People recognize room names, not canonical identifiers.
  const label = props.roomLabel || props.access.roomIdentifier || "LetAgents";
  return friendlyRoomLabel(label);
});

const roomSuffix = computed(() => {
  switch (cardState.value) {
    case "loading":
      return "opening";
    case "connect":
    case "forbidden":
      return "private repo room";
    case "code":
      return "signing in";
    case "connected":
      return "ready to open";
    case "missing":
      return "no room open";
    default:
      return "";
  }
});

const forbiddenTitle = computed(() => {
  const handle = props.authStatus?.account?.login;
  return handle ? `@${handle} can't open this room` : "This account can't open this room";
});

// Approval polling is owned by useDesktopAuthFlow, which reschedules itself off
// the device-flow interval; the view only surfaces state and reads the clock.
const now = ref(Date.now());
let ticker: number | null = null;

const pendingExpiryLabel = computed(() => {
  if (!pendingAuth.value?.expiresAt) return "soon";
  const diffMs = Date.parse(pendingAuth.value.expiresAt) - now.value;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "soon";
  const minutes = Math.max(1, Math.ceil(diffMs / 60000));
  return `in ${minutes} min`;
});

// A failed room load self-heals: auto-retry on a growing backoff, deadlines as
// absolute timestamps so an occluded window's batched timers can't stall the
// countdown.
const retryStep = ref(0);
const retryDeadline = ref(0);

const retrySecondsLeft = computed(() => computeRetrySecondsLeft(now.value, retryDeadline.value));

function armRetry(fromStep: number): void {
  retryStep.value = fromStep;
  retryDeadline.value = retryDeadlineAt(Date.now(), fromStep);
}

function clearRetry(): void {
  retryStep.value = 0;
  retryDeadline.value = 0;
}

watch(
  cardState,
  (state) => {
    if (state === "unavailable") {
      if (retryDeadline.value === 0) armRetry(retryStep.value);
      return;
    }
    // Loading keeps the schedule: an in-flight auto-retry flips the card to
    // loading, and a failure lands back here to continue the backoff.
    if (state !== "loading") clearRetry();
  },
  { immediate: true },
);

// A different room's failure gets its own fresh backoff — cardState stays
// "unavailable" across the switch, so this reset can't ride on that watcher.
watch(
  [() => props.access.roomIdentifier, () => props.roomLabel],
  () => {
    if (cardState.value === "unavailable") armRetry(0);
    else clearRetry();
  },
);

function retryNow(): void {
  armRetry(0);
  emit("refresh-room");
}

function onTick(): void {
  now.value = Date.now();
  if (props.busy) return;

  if (cardState.value === "unavailable" && retryDeadline.value !== 0 && now.value >= retryDeadline.value) {
    armRetry(nextRetryStep(retryStep.value));
    emit("refresh-room");
  }
}

const { copied: codeCopied, copy: copyToClipboard } = useCopyIndicator(1600);

async function copyUserCode(): Promise<void> {
  const code = pendingAuth.value?.userCode;
  if (!code) return;
  await copyToClipboard(code);
}

onMounted(() => {
  ticker = window.setInterval(onTick, 500);
});

onBeforeUnmount(() => {
  if (ticker !== null) window.clearInterval(ticker);
});
</script>
