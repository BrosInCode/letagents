<template>
  <div class="activity-panel" :data-loading="isLoading">
    <div v-if="isLoading" class="activity-refresh-indicator" role="status" aria-live="polite">
      <span class="activity-spinner" aria-hidden="true" />
      <span>Refreshing activity…</span>
    </div>

    <div ref="surface" class="agents-ui">
    <header v-if="activeView === 'live'" class="agents-heading"><h2>Agents</h2></header>
    <ActivityApprovalEvidence
      v-if="activeView === 'live'"
      :entries="approvalEntries"
      :agents="[...props.presence, ...props.participants]"
      :loading="approvalLoading"
      :loading-more="approvalLoadingMore"
      :error="approvalError"
      :has-more="approvalHasMore"
      @refresh="refreshApprovals"
      @load-more="loadMoreApprovals"
      @review="loadApprovalEvidence"
      @decide="decideApproval"
    />

    <ActivityHistoryView
      v-if="activeView === 'history'"
      v-model:mode="archiveMode"
      v-model:history-room-id="historyRoomId"
      v-model:history-query="historyQuery"
      :activity-history="props.activityHistory"
      :activity-history-loading="props.activityHistoryLoading"
      :activity-history-error="props.activityHistoryError"
      :history-room-options="historyRoomOptions"
      :history-page-label="historyPageLabel"
      :task-github-status="historyRoomId === (props.currentRoom?.identifier || props.roomIdentifier) ? props.taskGithubStatus : {}"
      @change-page="changeHistoryPage"
      @back="navigate('live', $event)"
    >
      <template #changes="{ query }"><ActivityArtifactsPanel v-if="historyRoomId === (props.currentRoom?.identifier || props.roomIdentifier)" :artifacts="filteredArtifacts(query)" :tasks="props.tasks" :pr-repo="props.currentRoom?.gitRoom ? { host: props.currentRoom.gitRoom.host, owner: props.currentRoom.gitRoom.repository.owner, name: props.currentRoom.gitRoom.repository.name } : null" /><p v-else class="agents-empty">Open this room to see its changes and pull requests.</p><p v-if="historyRoomId === (props.currentRoom?.identifier || props.roomIdentifier) && !filteredArtifacts(query).length" class="agents-empty">No matching changes or pull requests.</p></template>
    </ActivityHistoryView>

    <div v-show="activeView === 'live'">
    <ActivityLiveView
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
      :room-identifier="props.roomIdentifier"
      :active-wake-rules="activeWakeRules"
      :recent-wake-rules="recentWakeRules"
      :wake-rule-api="wakeRuleApi"
      @clear-disconnected="handleClearDisconnected"
      @open-reasoning="selectedReasoningId = $event"
      @open-message="emit('openMessage', $event)"
    />

    </div>
    <footer v-if="activeView === 'live'" class="agents-footer"><button ref="pastButton" class="agents-quiet" type="button" @click="archiveMode = 'past'; navigate('history', $event)">Past agents →</button></footer>
    </div>

    <ReasoningTraceModal
      :open="Boolean(selectedReasoningSession)"
      :roomIdentifier="roomIdentifier"
      :session="selectedReasoningSession"
      @close="selectedReasoningId = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, toRef } from 'vue'
import { useAgentsNavigation } from '../../../../../shared/ui/agents/useAgentsNavigation'
import { useRoomAgentApprovals } from '@/composables/roomAgentApprovals'
import { useRoomWakeRules } from '@/composables/roomWakeRules'
import ReasoningTraceModal from './ReasoningTraceModal.vue'
import ActivityApprovalEvidence from './activity/ActivityApprovalEvidence.vue'
import ActivityArtifactsPanel from './activity/ActivityArtifactsPanel.vue'
import ActivityHistoryView from './activity/ActivityHistoryView.vue'
import ActivityLiveView from './activity/ActivityLiveView.vue'
import type { ActivityViewProps } from './activity/types'
import { useActivityViewModel } from './activity/useActivityViewModel'

const props = defineProps<ActivityViewProps>()
const emit = defineEmits<{
  /** Show a room message in the chat, e.g. the one that woke an agent. */
  openMessage: [messageId: string]
}>()

const {
  activeByAgentKey: activeWakeRules,
  recentByAgentKey: recentWakeRules,
  api: wakeRuleApi,
} = useRoomWakeRules(toRef(props, 'roomIdentifier'))

const {
  entries: approvalEntries,
  loading: approvalLoading,
  loadingMore: approvalLoadingMore,
  error: approvalError,
  hasMore: approvalHasMore,
  refresh: refreshApprovals,
  loadMore: loadMoreApprovals,
  loadEvidence: loadApprovalEvidence,
  decide: decideApproval,
} = useRoomAgentApprovals(toRef(props, 'roomIdentifier'))

const {
  activeView,
  selectedParticipantKey,
  selectedReasoningId,
  historyQuery,
  historyRoomId,
  clearBusy,
  connectedAgents,
  recentlyDisconnectedAgents,
  humans,
  participants,
  clearedLiveCount,
  historyRoomOptions,
  historyPageLabel,
  selectedParticipant,
  selectedReasoningSession,
  changeHistoryPage,
  handleClearDisconnected,
} = useActivityViewModel(props)
const surface = ref<HTMLElement>();
const archiveMode = ref<'past' | 'history'>('past');
const { navigate, pastButton } = useAgentsNavigation(activeView, surface);
function filteredArtifacts(query: string) { return props.roomArtifacts.filter(artifact => [artifact.title, artifact.ref, artifact.state, artifact.kind].join(' ').toLowerCase().includes(query.trim().toLowerCase())); }
</script>

<style src="./activity/styles/base.css"></style>
<style src="./activity/styles/roster.css"></style>
<style src="./activity/styles/detail.css"></style>
<style src="./activity/styles/toolbar-history.css"></style>
<style src="./activity/styles/responsive.css"></style>

<style scoped>
.activity-panel { padding: 28px 32px; }
.activity-panel :deep(.activity-artifacts) { border: 0; background: transparent; padding: 0 12px; margin: 0; }
.activity-panel :deep(.activity-artifacts-header) { display: none; }
.activity-panel :deep(.activity-artifact-list) { max-height: none; overflow: visible; grid-template-columns: minmax(0, 1fr); gap: 0; }
.activity-panel :deep(.activity-artifact-row) { border: 0; border-top: 1px solid var(--agents-line); border-radius: 0; background: none; padding: 18px 0; }
.activity-panel :deep(.activity-artifact-kind) { background: none; padding: 0; color: var(--agents-muted); font-size: 11px; }
.activity-panel :deep(.activity-artifact-title-line a), .activity-panel :deep(.activity-artifact-title-line strong) { font-size: 14px; font-weight: 500; }
@media(max-width:640px) { .activity-panel { padding: 22px 16px; } }
</style>
