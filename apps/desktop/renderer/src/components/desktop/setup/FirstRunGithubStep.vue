<template>
  <div class="first-run-github-step" data-testid="first-run-github-step">
    <section class="github-access-panel" data-testid="github-access-panel">
      <div class="github-access-main">
        <span class="github-access-eyebrow">Optional for public rooms</span>
        <h2>Needed when a room belongs to a private repository.</h2>
        <p>LetAgents uses GitHub to confirm repo access and attach rooms to the right owner/repo. Invite codes and public rooms work without this.</p>

        <div class="github-access-list" data-testid="github-reasons">
          <article v-for="reason in reasons" :key="reason.title">
            <span aria-hidden="true">{{ reason.step }}</span>
            <div>
              <strong>{{ reason.title }}</strong>
              <p>{{ reason.copy }}</p>
            </div>
          </article>
        </div>
      </div>

      <aside class="github-signin-card" data-testid="github-signin-card">
        <div class="github-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.95.68 1.92v2.8c0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
          </svg>
        </div>

        <div v-if="authStatus?.account" class="github-auth-state">
          <span class="github-access-eyebrow">Connected account</span>
          <div class="auth-account" data-testid="first-run-auth-account">
            <span class="auth-avatar" aria-hidden="true">
              {{ authStatus.account.login.slice(0, 2).toUpperCase() }}
            </span>
            <span>
              <strong>{{ authStatus.account.displayName || authStatus.account.login }}</strong>
              <small>@{{ authStatus.account.login }}</small>
            </span>
          </div>
        </div>

        <div v-else-if="pendingAuth" class="github-auth-state">
          <span class="github-access-eyebrow">Device approval</span>
          <strong>Approve in GitHub.</strong>
          <p>Use this code in the browser, then come back here.</p>
          <div class="auth-code-block" data-testid="first-run-device-code">
            <span>GitHub code</span>
            <strong>{{ pendingAuth.userCode }}</strong>
            <small>Waiting for approval</small>
          </div>
        </div>

        <div v-else class="github-auth-state">
          <span class="github-access-eyebrow">One-time setup</span>
          <strong>Connect GitHub.</strong>
          <p>A browser approval links your account to LetAgents on this device.</p>
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
    </section>
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
    step: "01",
    title: "Private repo rooms",
    copy: "Verify that this account can open the repository behind a room.",
  },
  {
    step: "02",
    title: "Repository list",
    copy: "Show the repos this account can access, then open the right repo room from a list.",
  },
  {
    step: "03",
    title: "Correct room context",
    copy: "Keep agent work tied to the codebase it belongs to.",
  },
];
</script>
