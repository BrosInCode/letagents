<template>
  <div class="web-connectors">
    <header class="web-connectors-nav">
      <RouterLink to="/">LetAgents</RouterLink>
      <nav aria-label="Workspace">
        <RouterLink to="/my-work">My work</RouterLink
        ><RouterLink to="/messages">Messages</RouterLink
        ><RouterLink to="/connectors" aria-current="page">Connectors</RouterLink
        ><RouterLink to="/">Home</RouterLink>
      </nav>
    </header>
    <div class="web-connectors-content">
      <ConnectorsPage
        v-if="isSignedIn && user?.id && api"
        :key="user.id"
        :api="api"
        :remote-url="remoteUrl"
      />
      <section v-else class="web-connectors-signin">
        <h1>Connectors</h1>
        <p>Sign in to manage your trackers and connected apps.</p>
        <button :disabled="isSigningIn" @click="signIn('/connectors')">
          {{ isSigningIn ? "Opening…" : "Sign in with GitHub" }}
        </button>
      </section>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onScopeDispose, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import ConnectorsPage from "../../../../shared/ui/connectors/ConnectorsPage.vue";
import type { ConnectorsApi } from "../../../../shared/ui/connectors/types";
import { useAuth } from "../composables/useAuth";
import { apiFetch } from "../composables/room/api";
import { createConnectorsApi } from "../composables/connectors-api";
const { isSignedIn, user, isSigningIn, signIn, checkSession } = useAuth();
const api = shallowRef<ConnectorsApi | null>(null);
const remoteUrl = `${window.location.origin}/mcp`;
let controller: AbortController | null = null;
watch(
  () => (isSignedIn.value ? user.value?.id : null),
  (accountId) => {
    controller?.abort();
    controller = null;
    api.value = null;
    if (!accountId) return;
    const session = new AbortController();
    controller = session;
    api.value = createConnectorsApi(async (path, options) => {
      if (
        session.signal.aborted ||
        user.value?.id !== accountId ||
        !isSignedIn.value
      )
        throw new Error("Your account changed. Reopen Connectors.");
      const result = await apiFetch(path, {
        ...options,
        signal: session.signal,
      });
      if (
        session.signal.aborted ||
        user.value?.id !== accountId ||
        !isSignedIn.value
      )
        throw new Error("Your account changed. Reopen Connectors.");
      return result;
    });
  },
  { immediate: true, flush: "sync" },
);
onMounted(() => void checkSession());
onScopeDispose(() => controller?.abort());
</script>
<style scoped>
.web-connectors {
  min-height: 100dvh;
  background: var(--bg);
  color: var(--text);
}
.web-connectors-nav {
  height: 70px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 34px;
  border-bottom: 1px solid var(--border);
}
.web-connectors-nav a {
  text-decoration: none;
  color: var(--text-secondary);
  font-size: 13px;
}
.web-connectors-nav > a,
.web-connectors-nav a[aria-current] {
  color: var(--text);
}
.web-connectors-nav nav {
  display: flex;
  gap: 24px;
}
.web-connectors-content {
  max-width: 1098px;
  margin: 0 auto;
  padding: 40px 32px;
}
.web-connectors-signin {
  padding: 60px 0;
}
.web-connectors-signin h1 {
  font-size: 28px;
  margin: 0 0 12px;
}
.web-connectors-signin p {
  color: var(--text-secondary);
}
.web-connectors-signin button {
  background: var(--text);
  color: var(--bg);
  border: 0;
  border-radius: 7px;
  padding: 11px 18px;
  cursor: pointer;
}
@media (max-width: 600px) {
  .web-connectors-nav {
    padding: 0 16px;
    gap: 12px;
  }
  .web-connectors-nav nav {
    gap: 14px;
  }
  .web-connectors-nav a {
    font-size: 12px;
  }
  .web-connectors-content {
    padding: 28px 16px;
  }
}
</style>
