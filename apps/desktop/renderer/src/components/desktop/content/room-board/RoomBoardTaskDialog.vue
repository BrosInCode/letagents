<template>
  <DesktopDialogShell
    :open="Boolean(task)"
    :focus-key="task?.id"
    :aria-label="task ? `Task details for ${task.title}` : undefined"
    close-label="Close task details"
    @close="emit('close')"
  >
    <RoomBoardTaskInspector
      v-if="task"
      :task="task"
      :actions="actions"
      :busy-action="busyAction"
      :review-assignment-candidates="reviewAssignmentCandidates"
      :selected-reviewer="selectedReviewer"
      @assign-review="emit('assign-review')"
      @run-action="emit('run-action', $event)"
      @update:selected-reviewer="emit('update:selected-reviewer', $event)"
      @view-events="emit('view-events', $event)"
      @view-artifacts="emit('view-artifacts', $event)"
    />
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import type {
  DesktopAgentPresence,
  DesktopTaskSummary,
} from "../../../../../../electron/ipc-types";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import RoomBoardTaskInspector from "./RoomBoardTaskInspector.vue";
import type { TaskAction } from "./types";

defineProps<{
  task: DesktopTaskSummary | null;
  actions: TaskAction[];
  busyAction: string | null;
  reviewAssignmentCandidates: DesktopAgentPresence[];
  selectedReviewer: string;
}>();

const emit = defineEmits<{
  close: [];
  "assign-review": [];
  "run-action": [action: TaskAction];
  "update:selected-reviewer": [value: string];
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
}>();
</script>
