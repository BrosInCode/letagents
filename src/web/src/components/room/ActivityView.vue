<template>
  <div class="activity-panel" :data-loading="isLoading">
    <div v-if="isLoading" class="activity-refresh-indicator" role="status" aria-live="polite">
      <span class="activity-spinner" aria-hidden="true" />
      <span>Refreshing activity…</span>
    </div>

    <ActivitySummary
      :active-view="activeView"
      :connected-agents-count="connectedAgents.length"
      :working-agents-count="workingAgents.length"
      :recently-disconnected-agents-count="recentlyDisconnectedAgents.length"
      :humans-count="humans.length"
      :active-reasoning-sessions-count="activeReasoningSessions.length"
      :history-cards="historySummaryCards"
    />

    <ActivityModeToolbar
      v-model:active-view="activeView"
      :cleared-live-count="clearedLiveCount"
    />

    <p v-if="activeView === 'live'" class="activity-desktop-note">
      For more accurate agent activity, run LetAgents Desktop on the Mac hosting your agents. Desktop-aware agents can report richer session liveness in addition to room heartbeats.
    </p>

    <ActivityHistoryView
      v-if="activeView === 'history'"
      v-model:history-room-id="historyRoomId"
      v-model:history-query="historyQuery"
      v-model:history-kind="historyKind"
      v-model:selected-history-participant-key="selectedHistoryParticipantKey"
      :activity-history="props.activityHistory"
      :activity-history-loading="props.activityHistoryLoading"
      :activity-history-error="props.activityHistoryError"
      :history-room-options="historyRoomOptions"
      :selected-history-room-option="selectedHistoryRoomOption"
      :history-count-label="historyCountLabel"
      :history-page-label="historyPageLabel"
      :history-entries-count="historyEntries.length"
      :history-agents="historyAgents"
      :history-humans="historyHumans"
      :show-history-agent-section="showHistoryAgentSection"
      :show-history-human-section="showHistoryHumanSection"
      :selected-history-participant="selectedHistoryParticipant"
      :task-github-status="props.taskGithubStatus"
      @change-page="changeHistoryPage"
    />

    <ActivityLiveView
      v-else
      v-model:selected-participant-key="selectedParticipantKey"
      :participants="participants"
      :connected-agents="connectedAgents"
      :recently-disconnected-agents="recentlyDisconnectedAgents"
      :humans="humans"
      :selected-participant="selectedParticipant"
      :cleared-live-count="clearedLiveCount"
      :can-manage-participants="props.canManageParticipants"
      :clear-busy="clearBusy"
      :task-github-status="props.taskGithubStatus"
      @clear-disconnected="handleClearDisconnected"
      @open-reasoning="selectedReasoningId = $event"
    />

    <ReasoningTraceModal
      :open="Boolean(selectedReasoningSession)"
      :roomIdentifier="roomIdentifier"
      :session="selectedReasoningSession"
      @close="selectedReasoningId = null"
    />
  </div>
</template>

<script setup lang="ts">
import ReasoningTraceModal from './ReasoningTraceModal.vue'
import ActivityHistoryView from './activity/ActivityHistoryView.vue'
import ActivityLiveView from './activity/ActivityLiveView.vue'
import ActivityModeToolbar from './activity/ActivityModeToolbar.vue'
import ActivitySummary from './activity/ActivitySummary.vue'
import type { ActivityViewProps } from './activity/types'
import { useActivityViewModel } from './activity/useActivityViewModel'

const props = defineProps<ActivityViewProps>()

const {
  activeView,
  selectedParticipantKey,
  selectedHistoryParticipantKey,
  selectedReasoningId,
  historyQuery,
  historyKind,
  historyRoomId,
  clearBusy,
  connectedAgents,
  workingAgents,
  recentlyDisconnectedAgents,
  activeReasoningSessions,
  humans,
  participants,
  historyEntries,
  clearedLiveCount,
  historyRoomOptions,
  selectedHistoryRoomOption,
  historyCountLabel,
  historyPageLabel,
  historyAgents,
  historyHumans,
  showHistoryAgentSection,
  showHistoryHumanSection,
  historySummaryCards,
  selectedParticipant,
  selectedReasoningSession,
  selectedHistoryParticipant,
  changeHistoryPage,
  handleClearDisconnected,
} = useActivityViewModel(props)
</script>

<style src="./activity/styles/base.css"></style>
<style src="./activity/styles/roster.css"></style>
<style src="./activity/styles/detail.css"></style>
<style src="./activity/styles/toolbar-history.css"></style>
<style src="./activity/styles/responsive.css"></style>
