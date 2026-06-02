<template>
  <DesktopSurfacePage class="auth-onboarding" data-testid="auth-onboarding-view">
    <div class="auth-panel" :data-access-state="access.status" data-testid="auth-access-panel">
      <div class="auth-copy">
        <p class="hero-kicker">Room access</p>
        <h1>{{ title }}</h1>
        <p>{{ description }}</p>
      </div>

      <div class="auth-action-card" data-testid="auth-action-card">
        <div v-if="authStatus?.account" class="auth-account" data-testid="auth-account">
          <span class="auth-avatar" aria-hidden="true">
            {{ authStatus.account.login.slice(0, 2).toUpperCase() }}
          </span>
          <span>
            <strong>{{ authStatus.account.displayName || authStatus.account.login }}</strong>
            <small>@{{ authStatus.account.login }}</small>
          </span>
        </div>

        <div v-if="pendingAuth" class="auth-code-block" data-testid="auth-pending-device-flow">
          <span>GitHub code</span>
          <strong data-testid="auth-user-code">{{ pendingAuth.userCode }}</strong>
          <small>Expires {{ pendingExpiryLabel }}</small>
        </div>

        <div class="auth-actions">
          <button
            v-if="access.status === 'auth_required' && !pendingAuth"
            class="primary-button"
            type="button"
            :disabled="busy"
            data-testid="auth-start-button"
            @click="$emit('start-auth')"
          >
            {{ busy ? "Starting…" : "Continue with GitHub" }}
          </button>

          <button
            v-if="pendingAuth"
            class="primary-button"
            type="button"
            :disabled="busy"
            data-testid="auth-open-github-button"
            @click="$emit('open-verification', pendingAuth.verificationUri)"
          >
            Open GitHub
          </button>

          <button
            v-if="pendingAuth"
            class="ghost-button"
            type="button"
            :disabled="busy"
            data-testid="auth-poll-button"
            @click="$emit('poll-auth')"
          >
            {{ busy ? "Checking…" : "Check now" }}
          </button>

          <button
            v-if="authStatus?.authenticated || access.status === 'forbidden'"
            class="ghost-button"
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
            Retry room
          </button>
        </div>

        <p v-if="effectiveFeedback" class="auth-feedback" data-testid="auth-feedback">{{ effectiveFeedback }}</p>
      </div>
    </div>

    <div class="auth-steps" data-testid="auth-steps">
      <article
        v-for="step in steps"
        :key="step.title"
        class="auth-step-card"
        :data-step-state="step.state"
        data-testid="auth-step-card"
      >
        <span>{{ step.number }}</span>
        <strong>{{ step.title }}</strong>
        <p>{{ step.copy }}</p>
      </article>
    </div>
  </DesktopSurfacePage>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAuthStatus,
  DesktopPendingDeviceAuth,
  DesktopRoomAccess,
} from "../../../../../electron/ipc-types";
import DesktopSurfacePage from "./ui/DesktopSurfacePage.vue";

const props = defineProps<{
  access: DesktopRoomAccess;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  feedback: string | null;
}>();

defineEmits<{
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

const title = computed(() => {
  if (props.access.status === "forbidden") return "This GitHub account cannot open the room";
  if (props.access.status === "missing_room") return "Choose a room to begin";
  if (props.access.status === "unavailable") return "LetAgents could not load this room";
  if (props.authStatus?.authenticated) return "Refresh the room";
  return "Connect GitHub to open this room";
});

const description = computed(() => {
  if (props.access.status === "forbidden") {
    return "The account signed into this app does not have access to the private repository behind this room. Switch accounts or ask for access, then try again.";
  }

  if (props.access.status === "missing_room" || props.access.status === "unavailable") {
    return props.access.message || "The room is not available right now. Check the room name or try again.";
  }

  if (props.authStatus?.authenticated) {
    return "Your GitHub account is connected. Retry the room so LetAgents can load its messages, tasks, and agents.";
  }

  return "Private repo rooms need a quick GitHub check. Approve once in your browser, then the desktop app remembers access locally.";
});

const pendingExpiryLabel = computed(() => {
  if (!pendingAuth.value?.expiresAt) return "soon";
  const diffMs = Date.parse(pendingAuth.value.expiresAt) - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "soon";
  const minutes = Math.max(1, Math.ceil(diffMs / 60000));
  return `in ${minutes} min`;
});

const steps = computed(() => [
  {
    number: "1",
    title: "Start here",
    copy: "LetAgents asks GitHub for a short approval code.",
    state: pendingAuth.value || props.authStatus?.authenticated ? "done" : "current",
  },
  {
    number: "2",
    title: "Approve in GitHub",
    copy: "Use the code shown here. Your browser handles the secure sign-in.",
    state: pendingAuth.value ? "current" : props.authStatus?.authenticated ? "done" : "next",
  },
  {
    number: "3",
    title: "Return to the room",
    copy: "After approval, the desktop app opens the room with your local LetAgents token.",
    state: props.authStatus?.authenticated ? "current" : "next",
  },
]);
</script>
