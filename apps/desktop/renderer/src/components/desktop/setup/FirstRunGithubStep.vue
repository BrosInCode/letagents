<template>
  <div class="first-run-github-step" data-testid="first-run-github-step">
    <section class="github-access-panel" data-testid="github-access-panel">
      <aside
        class="github-signin-card"
        :data-state="githubState"
        data-testid="github-signin-card"
      >
        <div v-if="!authStatus?.authenticated" class="github-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.28 9.28 0 0 1 12 6.94c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.95.68 1.92v2.8c0 .27.18.59.69.49A10.13 10.13 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
          </svg>
        </div>

        <Transition name="first-run-pop" mode="out-in">
          <div v-if="authStatus?.authenticated" key="authenticated" class="github-auth-state">
            <div v-if="authStatus.account" class="auth-account" data-testid="first-run-auth-account">
              <span class="auth-avatar" aria-hidden="true">
                <img
                  v-if="authStatus.account.avatarUrl"
                  :src="authStatus.account.avatarUrl"
                  alt=""
                >
                <template v-else>{{ loginInitials(authStatus.account.login) }}</template>
              </span>
              <span class="auth-account-copy">
                <strong>{{ authStatus.account.displayName || authStatus.account.login }}</strong>
                <small>@{{ authStatus.account.login }}</small>
              </span>
              <span class="github-connected-check" aria-hidden="true">
                <Check aria-hidden="true" />
              </span>
            </div>

            <span v-else class="github-connected-fallback">
              <Check aria-hidden="true" />
              GitHub connected
            </span>

            <button
              class="github-account-switch"
              type="button"
              :disabled="busy"
              data-testid="first-run-auth-sign-out"
              @click="$emit('sign-out')"
            >
              Switch account
            </button>
          </div>

          <div v-else-if="pendingAuth" key="pending" class="github-auth-state">
            <strong>Finish on GitHub.</strong>
            <p>Enter this code in the browser.</p>
            <div class="auth-code-block" data-testid="first-run-device-code">
              <strong>{{ pendingAuth.userCode }}</strong>
              <button
                class="auth-code-copy"
                type="button"
                :aria-label="copied ? 'Code copied' : 'Copy GitHub code'"
                data-testid="first-run-auth-copy-code"
                @click="copyCode"
              >
                <Transition name="first-run-icon" mode="out-in">
                  <Check v-if="copied" key="copied" aria-hidden="true" />
                  <CopyIcon v-else key="copy" aria-hidden="true" />
                </Transition>
                {{ copied ? "Copied" : "Copy" }}
              </button>
            </div>
          </div>
        </Transition>

        <Transition name="first-run-pop">
          <div v-if="pendingAuth" class="auth-actions">
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
              v-if="pendingAuth"
              class="ghost-button"
              type="button"
              :disabled="busy"
              data-testid="first-run-auth-cancel"
              @click="$emit('cancel-auth')"
            >
              Cancel sign-in
            </button>

          </div>
        </Transition>
      </aside>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Check, Copy as CopyIcon } from "@lucide/vue";
import { computed } from "vue";
import type {
  DesktopAuthStatus,
  DesktopPendingDeviceAuth,
} from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { loginInitials } from "../../../domain/initials";

const props = defineProps<{
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
}>();

defineEmits<{
  "cancel-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
}>();

const pendingAuth = computed<DesktopPendingDeviceAuth | null>(() => {
  return props.authStatus?.pendingDeviceAuth || null;
});

const githubState = computed(() => {
  if (props.authStatus?.authenticated) return "authenticated";
  if (pendingAuth.value) return "pending";
  return "idle";
});

const { copied, copy } = useCopyIndicator();

async function copyCode(): Promise<void> {
  if (pendingAuth.value?.userCode) await copy(pendingAuth.value.userCode);
}
</script>
