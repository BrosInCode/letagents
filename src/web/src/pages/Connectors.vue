<template>
  <div class="web-connectors">
    <WorkspaceNav />
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
import WorkspaceNav from "../components/layout/WorkspaceNav.vue";
import { onMounted, onScopeDispose, shallowRef, watch } from "vue";
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
  .web-connectors-content {
    padding: 28px 16px;
  }
}

@media (max-width: 640px) {
  .web-connectors :deep(.connectors-header) { flex-wrap: wrap; gap: 16px; }
  .web-connectors :deep(:is(.connector-secondary, .connector-primary, .connector-danger-button, .connector-text, .connector-tabs button, .work-filter-trigger, .work-menu-option, .ghost-button, .primary-button)) { min-height: 44px; }
  .web-connectors :deep(.connector-icon) { width: 44px; height: 44px; flex-shrink: 0; }
  .web-connectors :deep(.connector-dialog-toolbar) { padding: max(12px, env(safe-area-inset-top, 0px)) 16px 12px; }
  .web-connectors :deep(.connector-detail-body) { padding: 20px 16px max(20px, env(safe-area-inset-bottom, 0px)); }
  .web-connectors :deep(:is(.connector-dialog input, .connector-dialog select, .connector-dialog textarea, .work-menu-search input)) { min-height: 44px; font-size: 16px; }
  .web-connectors :deep(.connector-map-row) { grid-template-columns: minmax(0, 1fr) 44px; }
  .web-connectors :deep(.connector-map-row > span) { grid-column: 1 / -1; }
  .web-connectors :deep(:is(.connector-detail-heading, .connector-detail-state)) { flex-wrap: wrap; }
  .web-connectors :deep(.connector-detail-heading > div) { min-width: 0; overflow-wrap: anywhere; }
  .web-connectors :deep(.connector-catalog) { max-width: calc(100vw - 24px); }
}
</style>
