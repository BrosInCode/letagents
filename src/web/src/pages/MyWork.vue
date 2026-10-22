<template>
  <div class="web-work">
    <header class="web-work-nav">
      <RouterLink to="/">LetAgents</RouterLink>
      <nav aria-label="Workspace">
        <RouterLink to="/my-work" aria-current="page">My work</RouterLink
        ><RouterLink to="/messages">Messages</RouterLink
        ><RouterLink to="/connectors">Connectors</RouterLink
        ><RouterLink to="/">Home</RouterLink>
      </nav>
    </header>
    <MyWork
      v-if="isSignedIn && user?.id"
      :key="user.id"
      :api="api"
      :tasks-changed-at="stamps"
      :connected="connected"
      @open-card="openCard"
      @open-thread="openThread"
    />
    <div v-else class="web-work-signin">
      <h1>My work</h1>
      <p>Sign in to see your tasks and your agents’ work across rooms.</p>
      <button type="button" :disabled="isSigningIn" @click="signIn('/my-work')">
        {{ isSigningIn ? "Opening…" : "Sign in with GitHub" }}
      </button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import MyWork from "../../../../shared/ui/my-work/MyWork.vue";
import type { MyWorkApi } from "../../../../shared/ui/my-work/types";
import { useAuth } from "../composables/useAuth";
import { apiFetch, roomPath } from "../composables/room/api";
const { isSignedIn, user, isSigningIn, signIn, checkSession } = useAuth();
const router = useRouter();
const stamps = ref<Record<string, string | null>>({}),
  connected = ref(false);
const api: MyWorkApi = {
  read: (query) => {
    const params = new URLSearchParams({
      limit: String(query.limit),
      include_completed: "true",
    });
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.roomId) params.set("room", query.roomId);
    if (query.tracker) params.set("tracker", query.tracker);
    if (query.needsMe) params.set("needs_me", "true");
    return apiFetch(`/account/my-work?${params}`);
  },
  mentions: async (card) => {
    const result = await apiFetch(
      `${roomPath(card.room_id)}/tasks/${encodeURIComponent(card.task_id)}/mentions`,
    );
    return (result.mentions || []).map(
      (mention: {
        message_id: string;
        thread_root_id?: string;
        sender: string;
        text: string;
        timestamp: string;
      }) => ({
        messageId: mention.message_id,
        threadRootId: mention.thread_root_id || mention.message_id,
        sender: mention.sender,
        text: mention.text,
        timestamp: mention.timestamp,
      }),
    );
  },
  askNeedsMe: (card) =>
    apiFetch("/account/my-work/needs-me", {
      method: "POST",
      body: JSON.stringify({ room_id: card.room_id, task_id: card.task_id }),
    }),
};
function openCard(room: string, task: string) {
  void router.push({
    name: "room",
    params: { roomId: room },
    query: { view: "board", task },
  });
}
function openThread(room: string, message: string) {
  void router.push({
    name: "room",
    params: { roomId: room },
    query: { view: "chat", message },
  });
}
let stream: EventSource | null = null;
watch(
  () => (isSignedIn.value ? user.value?.id : null),
  (id) => {
    stream?.close();
    stream = null;
    stamps.value = {};
    connected.value = false;
    if (!id) return;
    const current = new EventSource("/account/activity/stream", {
      withCredentials: true,
    });
    stream = current;
    current.addEventListener("snapshot", (event) => {
      if (current !== stream) return;
      try {
        const data = JSON.parse((event as MessageEvent).data);
        stamps.value = Object.fromEntries(
          data.rooms.map(
            (room: { room_id: string; tasks_changed_at: string | null }) => [
              room.room_id,
              room.tasks_changed_at,
            ],
          ),
        );
        connected.value = true;
      } catch {
        /* Ignore malformed frames; keep the last snapshot. */
      }
    });
    current.addEventListener("room", (event) => {
      if (current !== stream) return;
      try {
        const room = JSON.parse((event as MessageEvent).data);
        if (typeof room.room_id === "string")
          stamps.value = {
            ...stamps.value,
            [room.room_id]: room.tasks_changed_at ?? null,
          };
      } catch {
        /* Ignore malformed frames. */
      }
    });
    current.onerror = () => {
      if (current === stream) connected.value = false;
    };
  },
  { immediate: true },
);
onMounted(checkSession);
onScopeDispose(() => {
  stream?.close();
  stream = null;
});
</script>
<style scoped>
.web-work {
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.web-work-nav {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: center;
  padding: 0 24px;
  min-height: 56px;
  border-bottom: 1px solid var(--border-strong);
  font-size: 12px;
  color: var(--text-secondary);
}
.web-work-nav > a {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.web-work-nav nav {
  display: flex;
  gap: 24px;
}
.web-work-nav [aria-current] {
  color: var(--text);
}
@media (max-width: 600px) {
  .web-work-nav {
    gap: 12px;
    padding: 10px 16px;
    font-size: 11px;
  }
  .web-work-nav nav {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px 14px;
  }
  .web-work-nav a {
    white-space: nowrap;
  }
}
.web-work-signin {
  margin: auto;
  padding: 24px;
  text-align: center;
}
.web-work-signin h1 {
  font-size: 30px;
}
.web-work-signin p {
  margin: 16px 0 24px;
  color: var(--text-secondary);
  font-size: 14px;
}
.web-work-signin button {
  border: 0;
  border-radius: 7px;
  padding: 11px 16px;
  font: inherit;
  background: var(--text);
  color: var(--bg);
  cursor: pointer;
}
</style>
