<template>
  <MyWork
    :api="api"
    :tasks-changed-at="tasksChangedAt"
    :connected="connected"
    @open-card="(room, task) => emit('open-card', room, task)"
    @open-thread="(room, thread) => emit('open-thread', room, thread)"
    @open-trackers="emit('open-trackers')"
  />
</template>
<script setup lang="ts">
import MyWork from "../../../../../../../shared/ui/my-work/MyWork.vue";
import type { MyWorkApi } from "../../../../../../../shared/ui/my-work/types";
import { desktopBridgeUpgradeMessage, desktopIpc } from "../../../ipc/index";
defineProps<{
  tasksChangedAt: Readonly<Record<string, string | null>>;
  connected: boolean;
}>();
const emit = defineEmits<{
  "open-card": [roomId: string, taskId: string];
  "open-thread": [roomId: string, threadRootId: string];
  "open-trackers": [];
}>();
const askNeedsMe = desktopIpc.room?.askMyWorkNeedsMe;
const api: MyWorkApi = {
  read: (query) => {
    const read = desktopIpc.room?.getMyWork;
    if (!read) return Promise.reject(new Error(desktopBridgeUpgradeMessage()));
    return read(query);
  },
  mentions: (card) =>
    desktopIpc.room.getTaskMentions(card.room_id, card.task_id),
  ...(askNeedsMe
    ? {
        askNeedsMe: (
          card: Parameters<NonNullable<MyWorkApi["askNeedsMe"]>>[0],
        ) => askNeedsMe(card.room_id, card.task_id),
      }
    : {}),
};
</script>
