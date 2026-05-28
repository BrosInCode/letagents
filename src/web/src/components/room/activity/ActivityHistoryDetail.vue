<template>
  <aside class="activity-detail" :data-kind="participant.kind">
    <div class="activity-detail-header">
      <div>
        <div class="activity-detail-kicker">History detail</div>
        <h3>
          {{ participant.label }}
          <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
        </h3>
        <p>{{ roomOption?.label }} · {{ participantMeta(participant) }}</p>
      </div>

      <div class="activity-detail-badges">
        <span class="activity-history-room-pill">
          {{ roomOption?.kind === 'focus' ? 'Focus room' : 'Main room' }}
        </span>
      </div>
    </div>

    <p class="activity-detail-description">
      Last in room {{ formatLastSeen(participant.lastSeenAt) }}
      <template v-if="participant.firstSeenAt">
        · first joined {{ formatLastSeen(participant.firstSeenAt) }}
      </template>
    </p>

    <div class="activity-detail-stats">
      <article class="detail-stat">
        <strong>{{ participant.currentTasks.length }}</strong>
        <span>Current work</span>
      </article>
      <article class="detail-stat">
        <strong>{{ participant.completedTasks.length }}</strong>
        <span>Completed</span>
      </article>
      <article class="detail-stat">
        <strong>{{ participant.createdTasks.length }}</strong>
        <span>Created</span>
      </article>
    </div>

    <p class="activity-detail-description">
      {{ historyDetailNote(participant) }}
    </p>

    <ActivityTaskList
      title="Current work"
      :tasks="participant.currentTasks"
      emptyMessage="No open tasks linked to this participant in this room."
      :statusLabels="TASK_STATUS_LABELS"
      :getTaskLink="getTaskLink"
      alwaysShow
    />

    <ActivityTaskList
      title="Recent completed work"
      :tasks="participant.completedTasks"
      emptyMessage="No completed or merged tasks tracked yet."
      :statusLabels="TASK_STATUS_LABELS"
      :getTaskLink="getTaskLink"
      alwaysShow
    />

    <ActivityTaskList
      title="Tasks created"
      :tasks="participant.createdTasks"
      emptyMessage=""
      :statusLabels="TASK_STATUS_LABELS"
      :getTaskLink="getTaskLink"
    />
  </aside>
</template>

<script setup lang="ts">
import type { TaskGitHubArtifactStatus } from '@/composables/useRoom'
import ActivityTaskList from './ActivityTaskList.vue'
import {
  getActivityTaskLink,
  historyDetailNote,
  participantMeta,
} from './displayHelpers'
import { TASK_STATUS_LABELS } from './labels'
import { formatLastSeen } from './time'
import type {
  ActivityTaskListItem,
  HistoryParticipant,
  HistoryRoomOption,
} from './types'

const props = defineProps<{
  participant: HistoryParticipant
  roomOption: HistoryRoomOption | null
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

function getTaskLink(task: ActivityTaskListItem): { label: string; url: string } | null {
  return getActivityTaskLink(task, props.taskGithubStatus)
}
</script>
