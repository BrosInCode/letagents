<template>
  <AgentHistory
    v-model:mode="mode"
    v-model:query="historyQuery"
    :people="people"
    :work="work"
    :loading="activityHistoryLoading"
    @back="emit('back', $event)"
  >
    <template #provider="{ person }"
      ><IdeBadge v-if="person.kind === 'agent'" :label="person.provider" /><span
        v-else
        >{{ person.name.slice(0, 1) }}</span
      ></template
    >
    <template #scope
      ><select
        v-if="historyRoomOptions.length > 1"
        v-model="historyRoomId"
        aria-label="History room"
      >
        <option
          v-for="option in historyRoomOptions"
          :key="option.id"
          :value="option.id"
        >
          {{ option.label }}
        </option>
      </select></template
    >
    <template #status
      ><p v-if="activityHistoryLoading" class="agents-note" role="status">
        Loading history…
      </p>
      <p v-else-if="activityHistoryError" class="agents-note" role="alert">
        {{ activityHistoryError }}
        <button
          type="button"
          class="agents-quiet"
          @click="emit('changePage', activityHistory?.page || 1)"
        >
          Retry
        </button>
      </p></template
    >
    <template #changes="slotProps"
      ><slot name="changes" v-bind="slotProps"
    /></template>
    <template #footer
      ><span
        >{{ historyPageLabel
        }}<template v-if="activityHistory && activityHistory.page_count > 1">
          · People and linked work on this page</template
        ></span
      >
      <div v-if="activityHistory && activityHistory.page_count > 1">
        <button
          class="agents-quiet"
          type="button"
          :disabled="activityHistory.page <= 1 || activityHistoryLoading"
          @click="emit('changePage', activityHistory.page - 1)"
        >
          ← Previous</button
        ><button
          class="agents-quiet"
          type="button"
          :disabled="
            activityHistory.page >= activityHistory.page_count ||
            activityHistoryLoading
          "
          @click="emit('changePage', activityHistory.page + 1)"
        >
          Next →
        </button>
      </div></template
    >
  </AgentHistory>
</template>
<script setup lang="ts">
import { computed } from "vue";
import AgentHistory from "../../../../../../shared/ui/agents/AgentHistory.vue";
import {
  mergeHistoryWork,
  type AgentHistoryPerson,
} from "../../../../../../shared/ui/agents/types";
import IdeBadge from "../chat-message/IdeBadge.vue";
import type {
  RoomActivityHistoryPage,
  TaskGitHubArtifactStatus,
  RoomActivityHistoryTaskSummary,
} from "@/composables/useRoom";
import type { HistoryRoomOption } from "./types";
import { getActivityTaskLink } from "./displayHelpers";
const props = defineProps<{
  activityHistory: RoomActivityHistoryPage | null;
  activityHistoryLoading: boolean;
  activityHistoryError: string;
  historyRoomOptions: readonly HistoryRoomOption[];
  historyPageLabel: string;
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>;
}>();
const mode = defineModel<"past" | "history">("mode", { required: true });
const historyQuery = defineModel<string>("historyQuery", { required: true });
const historyRoomId = defineModel<string>("historyRoomId", { required: true });
const emit = defineEmits<{
  back: [event: MouseEvent];
  changePage: [page: number];
}>();
const people = computed<AgentHistoryPerson[]>(() =>
  (props.activityHistory?.entries || []).map((entry) => ({
    id: entry.id,
    name: entry.participant.display_name,
    kind: entry.participant.kind,
    provider: entry.participant.ide_label || "Agent",
    owner: entry.participant.owner_label || "",
    room: entry.room.display_name,
    branch: entry.participant.repo_branch,
    firstSeen: entry.first_seen_at,
    lastSeen: entry.last_room_activity_at,
    past:
      entry.participant.activity_state !== "active" &&
      entry.participant.activity_state !== "away",
  })),
);
function workLinks(task: RoomActivityHistoryTaskSummary) {
  const link = getActivityTaskLink(task, props.taskGithubStatus);
  return link && !task.workflow_refs.some((ref) => ref.url === link.url)
    ? [link, ...task.workflow_refs]
    : task.workflow_refs;
}
const work = computed(() =>
  mergeHistoryWork(
    (props.activityHistory?.entries || []).flatMap((entry) =>
      [
        ...entry.current_tasks,
        ...entry.completed_tasks,
        ...entry.created_tasks,
      ].map((task) => ({
        id: task.id,
        title: task.title,
        people: [entry.id],
        byline: entry.participant.display_name,
        state: task.status.replace(/_/g, " "),
        time: task.updated_at,
        links: workLinks(task),
      })),
    ),
  ),
);
</script>
