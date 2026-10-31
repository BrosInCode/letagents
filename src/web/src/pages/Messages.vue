<template>
  <div class="web-messages">
    <WorkspaceNav />
    <PrivateMessages
      v-if="isSignedIn && user?.id"
      :key="user.id"
      :api="api"
      :account-id="user.id"
    />
    <div v-else class="web-messages-signin">
      <h1>Your private conversations</h1>
      <p>Sign in to message someone or start a group chat.</p>
      <button :disabled="isSigningIn" @click="signIn('/messages')">
        {{ isSigningIn ? "Opening…" : "Sign in with GitHub" }}
      </button>
    </div>
  </div>
</template>
<script setup lang="ts">
import WorkspaceNav from "../components/layout/WorkspaceNav.vue";
import { onMounted } from "vue";
import PrivateMessages from "../../../../shared/ui/PrivateMessages.vue";
import type { ConversationApi } from "../../../../shared/conversation-contracts.mjs";
import { useAuth } from "../composables/useAuth";
const { isSignedIn, user, isSigningIn, signIn, checkSession } = useAuth();
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Couldn’t load messages. Try again.");
  }
  return response.json();
}
const path = (id: string) => `/conversations/${encodeURIComponent(id)}`;
const api: ConversationApi = {
  list: () => request("/conversations"),
  people: (query) =>
    request(`/conversations/people?q=${encodeURIComponent(query)}`),
  create: (ids, from) =>
    request("/conversations", "POST", {
      account_ids: ids,
      from_conversation_id: from,
    }),
  messages: (id, cursor) => {
    const query = new URLSearchParams();
    if (cursor?.before !== undefined)
      query.set("before", String(cursor.before));
    if (cursor?.after !== undefined) query.set("after", String(cursor.after));
    return request(`${path(id)}/messages?${query}`);
  },
  send: (id, text, clientId) =>
    request(`${path(id)}/messages`, "POST", {
      text,
      client_message_id: clientId,
    }),
  update: (id, changes) => request(path(id), "PATCH", changes),
  block: (id, blocked) =>
    request(`/conversations/blocks/${encodeURIComponent(id)}`, "PUT", {
      blocked,
    }),
  changes: (after) =>
    request(`/conversations/changes?after=${encodeURIComponent(after)}`),
};
onMounted(checkSession);
</script>
<style scoped>
.web-messages {
  container: private-messages / inline-size;
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.web-messages-signin {
  margin: auto;
  text-align: center;
  padding: 32px;
}
.web-messages-signin h1 {
  font-size: 26px;
  letter-spacing: -0.03em;
}
.web-messages-signin p {
  color: var(--text-secondary);
  margin: 16px 0 24px;
}
.web-messages-signin button {
  background: var(--text);
  color: var(--bg);
  border: 0;
  border-radius: 8px;
  padding: 12px 18px;
  font: inherit;
  cursor: pointer;
}

@media (max-width: 640px) {
  .web-messages :deep(:is(.chat-icon-button, .chat-send)) { width: 44px; height: 44px; }
  .web-messages :deep(:is(.conversation-new-chat, .conversation-tabs button, .chat-primary, .chat-secondary, .chat-text-button, .conversation-menu button)) { min-height: 44px; }
  .web-messages :deep(.conversation-menu > div) { top: calc(100% + 6px); }
  .web-messages :deep(:is(.conversation-search input, .conversation-recipient-field input)) { font-size: 16px; min-height: 28px; }
  .web-messages :deep(.conversation-header) { padding: 10px 12px; gap: 8px; }
  .web-messages :deep(.conversation-header-actions) { gap: 2px; }
  .web-messages :deep(.conversation-timeline) { padding: 16px 12px; }
  .web-messages :deep(.conversation-message-meta) { flex-wrap: wrap; overflow-wrap: anywhere; }
  .web-messages :deep(.conversation-composer-wrap) { padding: 8px 12px max(12px, env(safe-area-inset-bottom, 0px)); }
  .web-messages :deep(.conversation-composer) { gap: 8px; padding: 10px; }
  .web-messages :deep(.conversation-compose-people) { padding: 16px 12px; }
  .web-messages :deep(.conversation-recipient) { max-width: 100%; overflow-wrap: anywhere; }
  .web-messages :deep(.conversation-recipient-field input) { min-width: min(170px, 100%); }
  .web-messages :deep(:is(.conversation-person > span:nth-child(2), .conversation-member > span:nth-child(2))) { min-width: 0; overflow-wrap: anywhere; }
  .web-messages :deep(.conversation-members-dialog) { padding: 16px; max-height: calc(100dvh - 32px); }
  .web-messages-signin { overflow-y: auto; padding: 24px; }
}
</style>
