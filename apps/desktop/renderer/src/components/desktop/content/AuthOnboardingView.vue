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
import { copyTextToClipboard } from "../../../domain/clipboard";
import { friendlyRoomLabel } from "../../../domain/git-rooms";
import { loginInitials } from "../../../domain/initials";

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

type CardState = "loading" | "connect" | "code" | "connected" | "forbidden" | "missing" | "unavailable";

const cardState = computed<CardState>(() => {
  // A snapshot still in flight is not a verdict — never render it as one.
  if (props.snapshotPending) return "loading";
  switch (props.access.status) {
    case "missing_room":
      return "missing";
    case "forbidden":
      return "forbidden";
    case "unavailable":
      return "unavailable";
    case "auth_required":
      if (pendingAuth.value) return "code";
      return props.authStatus?.authenticated ? "connected" : "connect";
    default:
      return "loading";
  }
});

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

// One shared ticker drives the expiry label, the approval poll, and the retry
// countdown. Deadlines are absolute timestamps, never tick counts: throttled
// or occluded windows batch timers, and a decrement-per-tick countdown
// silently stalls when that happens.
const now = ref(Date.now());
let ticker: number | null = null;

const pendingExpiryLabel = computed(() => {
  if (!pendingAuth.value?.expiresAt) return "soon";
  const diffMs = Date.parse(pendingAuth.value.expiresAt) - now.value;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "soon";
  const minutes = Math.max(1, Math.ceil(diffMs / 60000));
  return `in ${minutes} min`;
});

const POLL_MIN_INTERVAL_SECONDS = 5;
let nextPollAt = 0;

function armPollDeadline(pending: DesktopPendingDeviceAuth): void {
  const seconds = Math.max(pending.intervalSeconds || 0, POLL_MIN_INTERVAL_SECONDS);
  nextPollAt = Date.now() + seconds * 1000;
}

watch(
  pendingAuth,
  (pending) => {
    if (pending) armPollDeadline(pending);
    else nextPollAt = 0;
  },
  { immediate: true }
);

const RETRY_BACKOFF_SECONDS = [8, 15, 30];
const retryStep = ref(0);
const retryDeadline = ref(0);

const retrySecondsLeft = computed(() => {
  if (retryDeadline.value === 0) return null;
  return Math.max(0, Math.ceil((retryDeadline.value - now.value) / 1000));
});

watch(
  cardState,
  (state) => {
    if (state === "unavailable") {
      if (retryDeadline.value === 0) {
        retryDeadline.value = Date.now() + RETRY_BACKOFF_SECONDS[retryStep.value] * 1000;
      }
      return;
    }
    // Loading keeps the schedule: an in-flight auto-retry flips the card to
    // loading, and a failure lands back here to continue the backoff.
    if (state !== "loading") {
      retryStep.value = 0;
      retryDeadline.value = 0;
    }
  },
  { immediate: true }
);

function retryNow(): void {
  retryStep.value = 0;
  retryDeadline.value = Date.now() + RETRY_BACKOFF_SECONDS[0] * 1000;
  emit("refresh-room");
}

function onTick(): void {
  now.value = Date.now();
  if (props.busy) return;

  if (pendingAuth.value && nextPollAt !== 0 && now.value >= nextPollAt) {
    armPollDeadline(pendingAuth.value);
    emit("poll-auth");
  }

  if (cardState.value === "unavailable" && retryDeadline.value !== 0 && now.value >= retryDeadline.value) {
    retryStep.value = Math.min(retryStep.value + 1, RETRY_BACKOFF_SECONDS.length - 1);
    retryDeadline.value = Date.now() + RETRY_BACKOFF_SECONDS[retryStep.value] * 1000;
    emit("refresh-room");
  }
}

const codeCopied = ref(false);
let copyResetTimer: number | null = null;

async function copyUserCode(): Promise<void> {
  const code = pendingAuth.value?.userCode;
  if (!code) return;
  await copyTextToClipboard(code);
  codeCopied.value = true;
  if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
  copyResetTimer = window.setTimeout(() => {
    codeCopied.value = false;
    copyResetTimer = null;
  }, 1600);
}

onMounted(() => {
  ticker = window.setInterval(onTick, 500);
});

onBeforeUnmount(() => {
  if (ticker !== null) window.clearInterval(ticker);
  if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
});
</script>
