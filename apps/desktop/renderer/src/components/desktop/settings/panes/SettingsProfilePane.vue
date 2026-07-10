<template>
  <section
    class="settings-panel settings-profile-panel"
    data-testid="settings-account-panel"
  >
    <article class="settings-profile-card" data-testid="settings-profile-identity">
      <h2>Room identity</h2>
      <div class="settings-profile-body">
        <img
          v-if="authStatus?.account?.avatarUrl"
          class="settings-profile-avatar"
          :src="authStatus.account.avatarUrl"
          alt=""
          referrerpolicy="no-referrer"
        />
        <span v-else class="settings-profile-avatar" aria-hidden="true">{{ accountInitials }}</span>
        <div class="settings-profile-copy">
          <strong>{{ accountTitle }}</strong>
          <span>{{ accountHandleLabel }}</span>
          <p
            class="settings-provider-pill"
            :data-state="authStatus?.authenticated ? 'connected' : 'offline'"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.56 7.56 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
            {{ providerConnectionLabel }}
          </p>
          <p class="settings-profile-note">{{ accountPurposeLabel }}</p>
        </div>
        <button
          v-if="authStatus?.authenticated"
          class="ghost-button settings-profile-action-button"
          type="button"
          :disabled="busy"
          data-testid="settings-sign-out"
          @click="$emit('sign-out')"
        >
          <LogOut aria-hidden="true" />
          <span>Sign out</span>
        </button>
        <button
          v-else
          class="primary-button settings-profile-action-button"
          type="button"
          :disabled="busy"
          data-testid="settings-connect-github"
          @click="$emit('start-auth')"
        >
          <LogIn aria-hidden="true" />
          <span>Connect GitHub</span>
        </button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { LogIn, LogOut } from "@lucide/vue";
import { computed } from "vue";
import type { DesktopAuthStatus } from "../../../../../../electron/ipc-types";
import { wordInitials } from "../../../../domain/initials";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
}>();

defineEmits<{
  "sign-out": [];
  "start-auth": [];
}>();

const accountTitle = computed(() => {
  if (!props.authStatus?.authenticated || !props.authStatus.account) return "No account connected";
  return props.authStatus.account.displayName || props.authStatus.account.login;
});

const accountHandleLabel = computed(() => {
  if (!props.authStatus?.authenticated || !props.authStatus.account) return "No GitHub account connected";
  return `@${props.authStatus.account.login}`;
});

const accountPurposeLabel = computed(() => {
  if (props.authStatus?.authenticated) {
    return "Shown to humans and agents in your LetAgents rooms.";
  }
  return props.authStatus?.error || "Connect GitHub to show your identity in LetAgents rooms.";
});

const accountInitials = computed(() => wordInitials(accountTitle.value, "LA"));

const providerLabel = computed(() => {
  const provider = props.authStatus?.account?.provider || "github";
  return provider === "github" ? "GitHub" : provider;
});

const providerConnectionLabel = computed(() =>
  props.authStatus?.authenticated ? `Connected with ${providerLabel.value}` : "Not connected",
);
</script>
