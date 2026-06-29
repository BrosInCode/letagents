<template>
  <aside class="activity-detail" :data-kind="participant.kind">
    <div class="activity-detail-header">
      <div>
        <div class="activity-detail-kicker">
          {{ participant.kind === 'agent' ? 'Agent detail' : 'Human detail' }}
        </div>
        <h3>
          {{ participant.label }}
          <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
        </h3>
        <p>{{ participantMeta(participant) }}</p>
      </div>

      <div class="activity-detail-badges">
        <span
          v-if="participant.kind === 'agent'"
          class="activity-connection-pill"
          :data-connection="participant.activityState"
        >
          {{ connectionLabel(participant) }}
        </span>
        <span
          v-if="participant.workSignal"
          class="activity-work-pill"
          :data-work-state="participant.workSignal.state"
        >
          {{ participant.workSignal.label }}
        </span>
      </div>
    </div>

    <div class="activity-detail-stats">
      <article class="detail-stat">
        <strong>{{ participant.messageCount }}</strong>
        <span>Messages</span>
      </article>
      <article class="detail-stat">
        <strong>{{ participant.currentTasks.length }}</strong>
        <span>Current work</span>
      </article>
      <article class="detail-stat">
        <strong>{{ participant.completedTasks.length }}</strong>
        <span>Completed</span>
      </article>
      <article class="detail-stat">
        <strong>{{ formatLastSeen(participant.lastSeenAt) }}</strong>
        <span>Last activity</span>
      </article>
    </div>

    <section
      v-if="participant.kind === 'agent' && participant.thinkingSnapshot"
      class="activity-detail-section"
    >
      <div class="activity-detail-section-header">
        <h4>Reasoning snapshot</h4>
        <span>Live</span>
      </div>

      <AgentThinkingCard
        :card="participant.thinkingSnapshot"
        kicker="Latest visible reasoning"
        :timestampLabel="formatLastSeen(participant.lastSeenAt)"
      />
    </section>

    <p
      v-else-if="participant.kind === 'agent' || participant.statusText"
      class="activity-detail-description"
    >
      {{ participantNote(participant) }}
    </p>

    <section
      v-if="participant.kind === 'agent'"
      class="activity-detail-section"
    >
      <div class="activity-detail-section-header">
        <h4>Session liveness</h4>
        <span>{{ participant.livenessObservation ? 'Enriched' : 'Basic' }}</span>
      </div>

      <div
        v-if="participant.repoBranch"
        class="activity-liveness-card"
      >
        <div>
          <strong>Branch</strong>
          <span>{{ participant.repoBranch }}</span>
        </div>
        <p>This worker registered from a git checkout on this branch.</p>
      </div>

      <div v-if="participant.livenessObservation" class="activity-liveness-card">
        <div>
          <strong>{{ livenessCapabilityLabel(participant.livenessObservation.liveness_capability) }}</strong>
          <span>{{ participant.livenessObservation.host_label || participant.livenessObservation.host_kind || 'Agent host' }}</span>
        </div>
        <p>
          Last session signal {{ formatLastSeen(participant.livenessObservation.last_observed_at) }}.
          {{ participant.livenessObservation.detail || 'Room-scoped agent activity was observed.' }}
        </p>
      </div>

      <div v-else class="activity-detail-empty">
        This agent is reporting standard room presence only. LetAgents Desktop can enrich this with host-level session activity.
      </div>
    </section>

    <section
      v-if="participant.kind === 'agent'"
      class="activity-detail-section"
    >
      <div class="activity-detail-section-header">
        <h4>Live reasoning</h4>
        <span>{{ participant.activeReasoning.length }}</span>
      </div>

      <div
        v-if="participant.activeReasoning.length === 0"
        class="activity-detail-empty"
      >
        No active reasoning streams are exposed for this agent right now.
      </div>

      <div v-else class="activity-reasoning-list">
        <article
          v-for="session in participant.activeReasoning"
          :key="session.id"
          class="activity-reasoning-card"
        >
          <div class="activity-reasoning-header">
            <strong>{{ reasoningCardTitle(session) }}</strong>
            <span>{{ formatLastSeen(reasoningTimestamp(session)) }}</span>
          </div>
          <p>{{ reasoningCardSummary(session) }}</p>
          <div class="activity-reasoning-meta">
            <span>{{ reasoningStatusLabel(session) }}</span>
            <span v-if="session.task_id">{{ session.task_id }}</span>
          </div>
          <button
            class="activity-reasoning-action"
            type="button"
            @click="emit('openReasoning', session.id)"
          >
            Open reasoning
          </button>
        </article>
      </div>
    </section>

    <section
      v-if="participant.kind === 'agent' && participant.thinkingTimeline.length > 0"
      class="activity-detail-section"
    >
      <div class="activity-detail-section-header">
        <h4>Reasoning trail</h4>
        <span>{{ participant.thinkingTimeline.length }}</span>
      </div>

      <div class="activity-thinking-list">
        <AgentThinkingCard
          v-for="entry in participant.thinkingTimeline"
          :key="entry.id"
          :card="entry"
          compact
          :timestampLabel="formatLastSeen(entry.timestamp)"
        />
      </div>
    </section>

    <ActivityTaskList
      title="Current work"
      :tasks="participant.currentTasks"
      emptyMessage="No open tasks linked to this participant right now."
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

    <section class="activity-detail-section">
      <div class="activity-detail-section-header">
        <h4>Recent room messages</h4>
        <span>{{ participant.recentMessages.length }}</span>
      </div>

      <div v-if="participant.recentMessages.length === 0" class="activity-detail-empty">
        No recent room messages from this participant.
      </div>

      <div v-else class="activity-message-list">
        <article
          v-for="message in participant.recentMessages"
          :key="message.id"
          class="activity-message-card"
        >
          <div class="activity-message-meta">
            <span>{{ message.source === 'browser' ? 'Browser' : 'Agent message' }}</span>
            <span>{{ formatLastSeen(message.timestamp) }}</span>
          </div>
          <p>{{ previewMessage(message.text) }}</p>
        </article>
      </div>
    </section>
  </aside>
</template>

<script setup lang="ts">
import type { TaskGitHubArtifactStatus } from '@/composables/useRoom'
import AgentThinkingCard from '../AgentThinkingCard.vue'
import ActivityTaskList from './ActivityTaskList.vue'
import {
  connectionLabel,
  getActivityTaskLink,
  livenessCapabilityLabel,
  participantMeta,
  participantNote,
  reasoningCardSummary,
  reasoningCardTitle,
  reasoningStatusLabel,
} from './displayHelpers'
import { TASK_STATUS_LABELS } from './labels'
import {
  formatLastSeen,
  previewMessage,
  reasoningTimestamp,
} from './time'
import type {
  ActivityParticipant,
  ActivityTaskListItem,
} from './types'

const props = defineProps<{
  participant: ActivityParticipant
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

const emit = defineEmits<{
  openReasoning: [sessionId: string]
}>()

function getTaskLink(task: ActivityTaskListItem): { label: string; url: string } | null {
  return getActivityTaskLink(task, props.taskGithubStatus)
}
</script>
