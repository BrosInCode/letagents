<template>
  <div class="web-messages">
    <header class="web-messages-nav">
      <RouterLink to="/">LetAgents</RouterLink><span>Messages</span
      ><RouterLink to="/">Back to home</RouterLink>
    </header>
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
import { onMounted } from "vue";
import { RouterLink } from "vue-router";
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
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.web-messages-nav {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-tertiary);
}
.web-messages-nav a:first-child {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.02em;
}
.web-messages-nav a:last-child {
  margin-left: auto;
  color: var(--text-secondary);
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
</style>
