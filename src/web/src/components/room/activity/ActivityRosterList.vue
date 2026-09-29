<template>
  <div v-if="participants.length > 0" class="activity-roster">
    <button
      v-for="participant in participants"
      :key="participant.key"
      class="activity-roster-item"
      :data-selected="selectedKey === participant.key"
      :data-kind="participant.kind"
      :data-connection="participant.activityState"
      type="button"
      @click="emit('select', participant.key)"
    >
      <div class="activity-roster-header">
        <div>
          <div class="activity-roster-name">
            {{ participant.label }}
            <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
          </div>
          <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
        </div>
        <div v-if="showAgentBadges(participant)" class="activity-roster-badges">
          <span class="activity-connection-pill" :data-connection="participant.activityState">
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
        <span v-else-if="showHumanKind && participant.kind === 'human'" class="activity-kind-pill">Human</span>
      </div>
      <div class="activity-roster-status">
        <span
          v-if="mode === 'live' && participant.status"
          class="activity-status-dot"
          :data-status="participant.status"
        />
        <span>{{ participantNoteText(participant) }}</span>
        <span
          v-if="mode === 'live' && participant.workSignal?.detail"
          class="activity-work-detail"
        >
          {{ participant.workSignal.detail }}
        </span>
        <span
          v-if="participant.kind === 'agent' && participant.repoBranch"
          class="activity-work-detail"
        >
          branch {{ participant.repoBranch }}
        </span>
        <span
          v-if="activeReasoningCount(participant) > 0"
          class="activity-reasoning-pill"
        >
          {{ activeReasoningLabel(participant) }}
        </span>
        <span class="activity-roster-seen">{{ seenLabel(participant) }}</span>
      </div>
    </button>
  </div>

  <div v-else class="activity-group-empty">
    {{ emptyMessage }}
  </div>
</template>

<script setup lang="ts">
import {
  connectionLabel,
  historyLastSeenLabel,
  historyParticipantNote,
  participantMeta,
  participantNote,
} from './displayHelpers'
import { formatLastSeen } from './time'
import type {
  ActivityParticipant,
  ActivityRosterParticipant,
  HistoryParticipant,
} from './types'

const props = defineProps<{
  participants: readonly ActivityRosterParticipant[]
  selectedKey: string | null
  mode: 'live' | 'history'
  emptyMessage: string
  showConnectionBadges?: boolean
  showHumanKind?: boolean
}>()

const emit = defineEmits<{
  select: [key: string]
}>()

function participantNoteText(participant: ActivityRosterParticipant): string {
  return props.mode === 'history'
    ? historyParticipantNote(participant as HistoryParticipant)
    : participantNote(participant)
}

function seenLabel(participant: ActivityRosterParticipant): string {
  return props.mode === 'history'
    ? historyLastSeenLabel(participant.lastSeenAt)
    : formatLastSeen(participant.lastSeenAt)
}

function showAgentBadges(participant: ActivityRosterParticipant): boolean {
  return Boolean(props.showConnectionBadges && props.mode === 'live' && participant.kind === 'agent')
}

function activeReasoningCount(participant: ActivityRosterParticipant): number {
  return 'activeReasoning' in participant
    ? (participant as ActivityParticipant).activeReasoning.length
    : 0
}

function activeReasoningLabel(participant: ActivityRosterParticipant): string {
  const count = activeReasoningCount(participant)
  return count === 1 ? '1 live work stream' : `${count} live work streams`
}
</script>
