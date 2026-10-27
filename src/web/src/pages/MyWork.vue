<template>
  <div class="web-work">
    <WorkspaceNav />
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
import WorkspaceNav from "../components/layout/WorkspaceNav.vue";
import { onMounted, onScopeDispose, ref, watch } from "vue";
import { useRouter } from "vue-router";
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
  min-width: 0;
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

@media (max-width: 650px) {
  .web-work :deep(.work-content) { padding: 24px 16px max(24px, env(safe-area-inset-bottom, 0px)); }
  .web-work :deep(.work-heading) { flex-wrap: wrap; gap: 12px; }
  .web-work :deep(.work-tabs) { overflow-x: auto; justify-content: flex-start; gap: 18px; padding-inline: 2px; }
  .web-work :deep(.work-tabs > button) { flex-shrink: 0; font-size: 13px; min-height: 44px; padding-bottom: 10px; }
  .web-work :deep(:is(.work-secondary, .work-primary, .work-text-button, .work-filter-trigger, .work-menu-option, .disclosure-trigger, .work-detail-tabs button)) { min-height: 44px; }
  .web-work :deep(.work-search) { height: 44px; }
  .web-work :deep(:is(.work-search input, .work-menu-search input)) { font-size: 16px; }
  .web-work :deep(.work-search kbd) { display: none; }
  .web-work :deep(.work-icon-button) { width: 44px; height: 44px; }
  .web-work :deep(.work-detail-top) { padding: max(8px, env(safe-area-inset-top, 0px)) 16px 8px; }
  .web-work :deep(.work-detail-body) { padding: 20px 16px; }
  .web-work :deep(.work-detail-footer) { padding: 12px 16px max(12px, env(safe-area-inset-bottom, 0px)); }
  .web-work :deep(:is(.work-detail-section a, .work-attention button)) { min-height: 44px; }
  .web-work-signin { overflow-y: auto; }
}
</style>
