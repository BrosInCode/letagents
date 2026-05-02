<template>
  <div class="first-run-github-step" data-testid="first-run-github-step">
    <div class="github-reasons" data-testid="github-reasons">
      <article v-for="reason in reasons" :key="reason.title" class="github-reason-card">
        <span :class="['github-reason-icon', `github-reason-icon-${reason.icon}`]" aria-hidden="true">
          <svg v-if="reason.icon === 'repo'" viewBox="0 0 24 24">
            <path d="M4.75 6.25A2.5 2.5 0 0 1 7.25 3.75h9.5a2.5 2.5 0 0 1 2.5 2.5v11.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5V6.25Z" />
            <path d="M8 8.25h8" />
            <path d="M8 12h8" />
            <path d="M8 15.75h4.5" />
          </svg>
          <svg v-else-if="reason.icon === 'agent'" viewBox="0 0 24 24">
            <path d="M12 5.25v-2" />
            <path d="M7.75 9.5h8.5a3 3 0 0 1 3 3v3.25a3 3 0 0 1-3 3h-8.5a3 3 0 0 1-3-3V12.5a3 3 0 0 1 3-3Z" />
            <path d="M8.75 14h.01" />
            <path d="M15.25 14h.01" />
            <path d="M9.75 18.75v1.5" />
            <path d="M14.25 18.75v1.5" />
            <path d="M19.25 13.25h1.5" />
            <path d="M3.25 13.25h1.5" />
          </svg>
          <svg v-else viewBox="0 0 24 24">
            <path d="M7.25 7.75a3 3 0 1 0 0 6" />
            <path d="M16.75 7.75a3 3 0 1 1 0 6" />
            <path d="M8 16.75a4.75 4.75 0 0 1 8 0" />
            <path d="M12 5.25v3.5" />
            <path d="M12 15.25v3.5" />
            <path d="M9.25 12h5.5" />
          </svg>
        </span>
        <strong>{{ reason.title }}</strong>
        <p>{{ reason.copy }}</p>
      </article>
    </div>

    <aside class="github-signin-card" data-testid="github-signin-card">
      <div v-if="authStatus?.account" class="auth-account" data-testid="first-run-auth-account">
        <span class="auth-avatar" aria-hidden="true">
          {{ authStatus.account.login.slice(0, 2).toUpperCase() }}
        </span>
        <span>
          <strong>{{ authStatus.account.displayName || authStatus.account.login }}</strong>
          <small>@{{ authStatus.account.login }}</small>
        </span>
      </div>

      <template v-else>
        <div class="github-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.95.68 1.92v2.8c0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
          </svg>
        </div>
        <strong>Connect GitHub once.</strong>
        <p>LetAgents uses GitHub to find your repos, confirm access, and keep agent work tied to the right codebase.</p>
      </template>

      <div v-if="pendingAuth" class="auth-code-block" data-testid="first-run-device-code">
        <span>GitHub code</span>
        <strong>{{ pendingAuth.userCode }}</strong>
        <small>Waiting for approval</small>
      </div>

      <div class="auth-actions">
        <button
          v-if="!authStatus?.authenticated && !pendingAuth"
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-auth-start"
          @click="$emit('start-auth')"
        >
          {{ busy ? "Starting..." : "Continue with GitHub" }}
        </button>

        <button
          v-if="pendingAuth"
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-auth-open"
          @click="$emit('open-verification', pendingAuth.verificationUri)"
        >
          Open GitHub
        </button>

        <button
          v-if="pendingAuth"
          class="ghost-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-auth-poll"
          @click="$emit('poll-auth')"
        >
          {{ busy ? "Checking..." : "Check now" }}
        </button>

        <button
          v-if="authStatus?.authenticated"
          class="ghost-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-auth-sign-out"
          @click="$emit('sign-out')"
        >
          Use another account
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAuthStatus,
  DesktopPendingDeviceAuth,
} from "../../../../../electron/ipc-types";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
}>();

defineEmits<{
  "start-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
}>();

const pendingAuth = computed<DesktopPendingDeviceAuth | null>(() => {
  return props.authStatus?.pendingDeviceAuth || null;
});

const reasons = [
  {
    icon: "repo",
    title: "Your repo becomes a room",
    copy: "Each repository gets a shared place where conversation, tasks, and decisions stay close to the code.",
  },
  {
    icon: "agent",
    title: "Bring humans and agents together",
    copy: "Your team and your coding agents can share the same room, discuss repo work, and move tasks forward together.",
  },
  {
    icon: "models",
    title: "Different agents, one project",
    copy: "Codex, Claude, Gemini, Cursor, and other model-powered agents can coordinate in the same repo room.",
  },
];
</script>
