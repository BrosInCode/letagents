<template>
  <div class="activity-panel" :data-loading="isLoading">
    <div v-if="isLoading" class="activity-refresh-indicator" role="status" aria-live="polite">
      <span class="activity-spinner" aria-hidden="true" />
      <span>Refreshing activity…</span>
    </div>

    <div class="activity-summary">
      <template v-if="activeView === 'live'">
        <article class="summary-card">
          <strong>{{ connectedAgents.length }}</strong>
          <span>Connected agents</span>
        </article>
        <article class="summary-card">
          <strong>{{ workingAgents.length }}</strong>
          <span>Work signals</span>
        </article>
        <article class="summary-card">
          <strong>{{ recentlyDisconnectedAgents.length }}</strong>
          <span>Recently disconnected</span>
        </article>
        <article class="summary-card">
          <strong>{{ humans.length }}</strong>
          <span>Humans seen</span>
        </article>
        <article class="summary-card">
          <strong>{{ activeReasoningSessions.length }}</strong>
          <span>Active reasoning</span>
        </article>
      </template>
      <template v-else>
        <article
          v-for="card in historySummaryCards"
          :key="card.label"
          class="summary-card"
        >
          <strong>{{ card.value }}</strong>
          <span>{{ card.label }}</span>
        </article>
      </template>
    </div>

    <div class="activity-toolbar-row">
      <div class="activity-view-switcher">
        <button
          class="activity-view-button"
          type="button"
          :data-active="activeView === 'live'"
          @click="activeView = 'live'"
        >
          Live
        </button>
        <button
          class="activity-view-button"
          type="button"
          :data-active="activeView === 'history'"
          @click="activeView = 'history'"
        >
          History
        </button>
      </div>

      <p v-if="activeView === 'live' && clearedLiveCount > 0" class="activity-toolbar-note">
        {{ clearedLiveCount }} cleared from the live roster.
      </p>
    </div>

    <p v-if="activeView === 'live'" class="activity-desktop-note">
      For more accurate agent activity, run LetAgents Desktop on the Mac hosting your agents. Desktop-aware agents can report richer session liveness in addition to room heartbeats.
    </p>

    <div v-if="activeView === 'history'" class="activity-history-view">
      <div class="activity-history-toolbar">
        <label v-if="historyRoomOptions.length > 1" class="activity-history-filter">
          <span>Room</span>
          <AppSelect v-model="historyRoomId">
            <option
              v-for="option in historyRoomOptions"
              :key="option.id"
              :value="option.id"
            >
              {{ option.label }}
            </option>
          </AppSelect>
        </label>

        <label class="activity-history-search">
          <span>Search history</span>
          <input
            v-model="historyQuery"
            type="search"
            placeholder="Agent, owner, or task"
          >
        </label>

        <label class="activity-history-filter">
          <span>Filter</span>
          <AppSelect v-model="historyKind">
            <option value="all">All</option>
            <option value="agent">Agents</option>
            <option value="human">Humans</option>
          </AppSelect>
        </label>
      </div>

      <div class="activity-history-meta">
        <span>{{ historyCountLabel }}</span>
        <span v-if="props.activityHistory">{{ historyPageLabel }}</span>
      </div>

      <div v-if="props.activityHistoryLoading" class="activity-empty">
        <h3>Loading room history</h3>
        <p>Pulling room-family activity and task history.</p>
      </div>

      <div v-else-if="props.activityHistoryError" class="activity-empty">
        <h3>History unavailable</h3>
        <p>{{ props.activityHistoryError }}</p>
      </div>

      <div v-else-if="historyEntries.length === 0" class="activity-empty">
        <h3>No matching history</h3>
        <p>Try a broader query or choose another room scope.</p>
      </div>

      <div v-else class="activity-layout">
        <div class="activity-groups">
          <section v-if="showHistoryAgentSection" class="activity-group">
            <div class="activity-group-header">
              <div>
                <h3>Agents in room history</h3>
                <p>Agents who have been in this room, ordered by when they were last seen here.</p>
              </div>
              <span class="activity-group-count">{{ historyAgents.length }}</span>
            </div>

            <div v-if="historyAgents.length > 0" class="activity-roster">
              <button
                v-for="participant in historyAgents"
                :key="participant.key"
                class="activity-roster-item"
                :data-selected="selectedHistoryParticipant?.key === participant.key"
                :data-kind="participant.kind"
                type="button"
                @click="selectedHistoryParticipantKey = participant.key"
              >
                <div class="activity-roster-header">
                  <div>
                    <div class="activity-roster-name">
                      {{ participant.label }}
                      <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
                    </div>
                    <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                  </div>
                </div>
                <div class="activity-roster-status">
                  <span>{{ historyParticipantNote(participant) }}</span>
                  <span class="activity-roster-seen">{{ historyLastSeenLabel(participant.lastSeenAt) }}</span>
                </div>
              </button>
            </div>

            <div v-else class="activity-group-empty">
              No agents match this room history scope yet.
            </div>
          </section>

          <section v-if="showHistoryHumanSection" class="activity-group">
            <div class="activity-group-header">
              <div>
                <h3>Humans seen in room</h3>
                <p>Record of human participants in this room.</p>
              </div>
              <span class="activity-group-count">{{ historyHumans.length }}</span>
            </div>

            <div v-if="historyHumans.length > 0" class="activity-roster">
              <button
                v-for="participant in historyHumans"
                :key="participant.key"
                class="activity-roster-item"
                :data-selected="selectedHistoryParticipant?.key === participant.key"
                :data-kind="participant.kind"
                type="button"
                @click="selectedHistoryParticipantKey = participant.key"
              >
                <div class="activity-roster-header">
                  <div>
                    <div class="activity-roster-name">
                      {{ participant.label }}
                      <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
                    </div>
                    <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                  </div>
                  <span class="activity-kind-pill">Human</span>
                </div>
                <div class="activity-roster-status">
                  <span>{{ historyParticipantNote(participant) }}</span>
                  <span class="activity-roster-seen">{{ historyLastSeenLabel(participant.lastSeenAt) }}</span>
                </div>
              </button>
            </div>

            <div v-else class="activity-group-empty">
              No human room activity is recorded for this scope yet.
            </div>
          </section>
        </div>

        <aside v-if="selectedHistoryParticipant" class="activity-detail" :data-kind="selectedHistoryParticipant.kind">
          <div class="activity-detail-header">
            <div>
              <div class="activity-detail-kicker">History detail</div>
              <h3>
                {{ selectedHistoryParticipant.label }}
                <span v-if="selectedHistoryParticipant.ideLabel" class="activity-ide-pill">{{ selectedHistoryParticipant.ideLabel }}</span>
              </h3>
              <p>{{ selectedHistoryRoomOption?.label }} · {{ participantMeta(selectedHistoryParticipant) }}</p>
            </div>

            <div class="activity-detail-badges">
              <span class="activity-history-room-pill">
                {{ selectedHistoryRoomOption?.kind === 'focus' ? 'Focus room' : 'Main room' }}
              </span>
            </div>
          </div>

          <p class="activity-detail-description">
            Last in room {{ formatLastSeen(selectedHistoryParticipant.lastSeenAt) }}
            <template v-if="selectedHistoryParticipant.firstSeenAt">
              · first joined {{ formatLastSeen(selectedHistoryParticipant.firstSeenAt) }}
            </template>
          </p>

          <div class="activity-detail-stats">
            <article class="detail-stat">
              <strong>{{ selectedHistoryParticipant.currentTasks.length }}</strong>
              <span>Current work</span>
            </article>
            <article class="detail-stat">
              <strong>{{ selectedHistoryParticipant.completedTasks.length }}</strong>
              <span>Completed</span>
            </article>
            <article class="detail-stat">
              <strong>{{ selectedHistoryParticipant.createdTasks.length }}</strong>
              <span>Created</span>
            </article>
          </div>

          <p
            class="activity-detail-description"
          >
            {{ historyDetailNote(selectedHistoryParticipant) }}
          </p>

          <ActivityTaskList
            title="Current work"
            :tasks="selectedHistoryParticipant.currentTasks"
            emptyMessage="No open tasks linked to this participant in this room."
            :statusLabels="TASK_STATUS_LABELS"
            :getTaskLink="getTaskLink"
            alwaysShow
          />

          <ActivityTaskList
            title="Recent completed work"
            :tasks="selectedHistoryParticipant.completedTasks"
            emptyMessage="No completed or merged tasks tracked yet."
            :statusLabels="TASK_STATUS_LABELS"
            :getTaskLink="getTaskLink"
            alwaysShow
          />

          <ActivityTaskList
            title="Tasks created"
            :tasks="selectedHistoryParticipant.createdTasks"
            emptyMessage=""
            :statusLabels="TASK_STATUS_LABELS"
            :getTaskLink="getTaskLink"
          />
        </aside>
      </div>

      <div v-if="props.activityHistory && props.activityHistory.page_count > 1" class="activity-history-pagination">
        <button
          class="activity-pagination-button"
          type="button"
          :disabled="props.activityHistory.page <= 1 || props.activityHistoryLoading"
          @click="changeHistoryPage((props.activityHistory?.page || 1) - 1)"
        >
          Previous
        </button>
        <button
          class="activity-pagination-button"
          type="button"
          :disabled="props.activityHistory.page >= props.activityHistory.page_count || props.activityHistoryLoading"
          @click="changeHistoryPage((props.activityHistory?.page || 1) + 1)"
        >
          Next
        </button>
      </div>
    </div>

    <div v-else-if="participants.length === 0" class="activity-empty">
      <h3>{{ clearedLiveCount > 0 ? 'Live roster cleared' : 'No live room participants right now' }}</h3>
      <p>
        {{
          clearedLiveCount > 0
            ? 'Disconnected agents were cleared from the live roster. Switch to History to inspect the full room record.'
            : 'Activity will appear here as participants connect or interact with the room.'
        }}
      </p>
    </div>

    <div v-else class="activity-layout">
      <div class="activity-groups">
        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Connected</h3>
              <p>Agents that are currently online and reachable.</p>
            </div>
            <span class="activity-group-count">{{ connectedAgents.length }}</span>
          </div>

          <div v-if="connectedAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in connectedAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.activityState"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">
                    {{ participant.label }}
                    <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
                  </div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <div class="activity-roster-badges">
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
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span
                  v-if="participant.workSignal?.detail"
                  class="activity-work-detail"
                >
                  {{ participant.workSignal.detail }}
                </span>
                <span
                  v-if="participant.activeReasoning.length > 0"
                  class="activity-reasoning-pill"
                >
                  {{ participant.activeReasoning.length === 1 ? '1 live reasoning stream' : `${participant.activeReasoning.length} live reasoning streams` }}
                </span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No agents are connected to this room right now.
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Recently disconnected</h3>
              <p>Agents that recently went offline and are no longer reachable.</p>
            </div>
            <div class="activity-group-header-actions">
              <span class="activity-group-count">{{ recentlyDisconnectedAgents.length }}</span>
              <button
                v-if="props.canManageParticipants && recentlyDisconnectedAgents.length > 0"
                class="activity-action-button"
                type="button"
                :disabled="clearBusy"
                @click="handleClearDisconnected"
              >
                {{ clearBusy ? 'Clearing…' : 'Clear disconnected' }}
              </button>
            </div>
          </div>

          <div v-if="recentlyDisconnectedAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in recentlyDisconnectedAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.activityState"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">
                    {{ participant.label }}
                    <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
                  </div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <div class="activity-roster-badges">
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
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span
                  v-if="participant.workSignal?.detail"
                  class="activity-work-detail"
                >
                  {{ participant.workSignal.detail }}
                </span>
                <span
                  v-if="participant.activeReasoning.length > 0"
                  class="activity-reasoning-pill"
                >
                  {{ participant.activeReasoning.length === 1 ? '1 live reasoning stream' : `${participant.activeReasoning.length} live reasoning streams` }}
                </span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            {{ clearedLiveCount > 0 ? 'Disconnected agents were cleared from the live roster.' : 'No recently disconnected agents have been seen yet.' }}
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Humans seen in room</h3>
              <p>Human participants currently active in the room.</p>
            </div>
            <span class="activity-group-count">{{ humans.length }}</span>
          </div>

          <div v-if="humans.length > 0" class="activity-roster">
            <button
              v-for="participant in humans"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">
                    {{ participant.label }}
                    <span v-if="participant.ideLabel" class="activity-ide-pill">{{ participant.ideLabel }}</span>
                  </div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-kind-pill">Human</span>
              </div>
              <div class="activity-roster-status">
                <span>{{ participantNote(participant) }}</span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No human browser activity has been seen yet.
          </div>
        </section>
      </div>

      <aside v-if="selectedParticipant" class="activity-detail" :data-kind="selectedParticipant.kind">
        <div class="activity-detail-header">
          <div>
            <div class="activity-detail-kicker">
              {{ selectedParticipant.kind === 'agent' ? 'Agent detail' : 'Human detail' }}
            </div>
            <h3>
              {{ selectedParticipant.label }}
              <span v-if="selectedParticipant.ideLabel" class="activity-ide-pill">{{ selectedParticipant.ideLabel }}</span>
            </h3>
            <p>{{ participantMeta(selectedParticipant) }}</p>
          </div>

          <div class="activity-detail-badges">
            <span
              v-if="selectedParticipant.kind === 'agent'"
              class="activity-connection-pill"
              :data-connection="selectedParticipant.activityState"
            >
              {{ connectionLabel(selectedParticipant) }}
            </span>
            <span
              v-if="selectedParticipant.workSignal"
              class="activity-work-pill"
              :data-work-state="selectedParticipant.workSignal.state"
            >
              {{ selectedParticipant.workSignal.label }}
            </span>
          </div>
        </div>

        <div class="activity-detail-stats">
          <article class="detail-stat">
            <strong>{{ selectedParticipant.messageCount }}</strong>
            <span>Messages</span>
          </article>
          <article class="detail-stat">
            <strong>{{ selectedParticipant.currentTasks.length }}</strong>
            <span>Current work</span>
          </article>
          <article class="detail-stat">
            <strong>{{ selectedParticipant.completedTasks.length }}</strong>
            <span>Completed</span>
          </article>
          <article class="detail-stat">
            <strong>{{ formatLastSeen(selectedParticipant.lastSeenAt) }}</strong>
            <span>Last activity</span>
          </article>
        </div>

        <section
          v-if="selectedParticipant.kind === 'agent' && selectedParticipant.thinkingSnapshot"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Reasoning snapshot</h4>
            <span>Live</span>
          </div>

          <AgentThinkingCard
            :card="selectedParticipant.thinkingSnapshot"
            kicker="Latest visible reasoning"
            :timestampLabel="formatLastSeen(selectedParticipant.lastSeenAt)"
          />
        </section>

        <p
          v-else-if="selectedParticipant.kind === 'agent' || selectedParticipant.statusText"
          class="activity-detail-description"
        >
          {{ participantNote(selectedParticipant) }}
        </p>

        <section
          v-if="selectedParticipant.kind === 'agent'"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Session liveness</h4>
            <span>{{ selectedParticipant.livenessObservation ? 'Enriched' : 'Basic' }}</span>
          </div>

          <div v-if="selectedParticipant.livenessObservation" class="activity-liveness-card">
            <div>
              <strong>{{ livenessCapabilityLabel(selectedParticipant.livenessObservation.liveness_capability) }}</strong>
              <span>{{ selectedParticipant.livenessObservation.host_label || selectedParticipant.livenessObservation.host_kind || 'Agent host' }}</span>
            </div>
            <p>
              Last session signal {{ formatLastSeen(selectedParticipant.livenessObservation.last_observed_at) }}.
              {{ selectedParticipant.livenessObservation.detail || 'Room-scoped agent activity was observed.' }}
            </p>
          </div>

          <div v-else class="activity-detail-empty">
            This agent is reporting standard room presence only. LetAgents Desktop can enrich this with host-level session activity.
          </div>
        </section>

        <section
          v-if="selectedParticipant.kind === 'agent'"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Live reasoning</h4>
            <span>{{ selectedParticipant.activeReasoning.length }}</span>
          </div>

          <div
            v-if="selectedParticipant.activeReasoning.length === 0"
            class="activity-detail-empty"
          >
            No active reasoning streams are exposed for this agent right now.
          </div>

          <div v-else class="activity-reasoning-list">
            <article
              v-for="session in selectedParticipant.activeReasoning"
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
                @click="selectedReasoningId = session.id"
              >
                Open reasoning
              </button>
            </article>
          </div>
        </section>

        <section
          v-if="selectedParticipant.kind === 'agent' && selectedParticipant.thinkingTimeline.length > 0"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Reasoning trail</h4>
            <span>{{ selectedParticipant.thinkingTimeline.length }}</span>
          </div>

          <div class="activity-thinking-list">
            <AgentThinkingCard
              v-for="entry in selectedParticipant.thinkingTimeline"
              :key="entry.id"
              :card="entry"
              compact
              :timestampLabel="formatLastSeen(entry.timestamp)"
            />
          </div>
        </section>

        <ActivityTaskList
          title="Current work"
          :tasks="selectedParticipant.currentTasks"
          emptyMessage="No open tasks linked to this participant right now."
          :statusLabels="TASK_STATUS_LABELS"
          :getTaskLink="getTaskLink"
          alwaysShow
        />

        <ActivityTaskList
          title="Recent completed work"
          :tasks="selectedParticipant.completedTasks"
          emptyMessage="No completed or merged tasks tracked yet."
          :statusLabels="TASK_STATUS_LABELS"
          :getTaskLink="getTaskLink"
          alwaysShow
        />

        <ActivityTaskList
          title="Tasks created"
          :tasks="selectedParticipant.createdTasks"
          emptyMessage=""
          :statusLabels="TASK_STATUS_LABELS"
          :getTaskLink="getTaskLink"
        />

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Recent room messages</h4>
            <span>{{ selectedParticipant.recentMessages.length }}</span>
          </div>

          <div v-if="selectedParticipant.recentMessages.length === 0" class="activity-detail-empty">
            No recent room messages from this participant.
          </div>

          <div v-else class="activity-message-list">
            <article
              v-for="message in selectedParticipant.recentMessages"
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
import AgentThinkingCard from './AgentThinkingCard.vue'
import ReasoningTraceModal from './ReasoningTraceModal.vue'
import { AppSelect } from '@/components/ui'
import ActivityTaskList from './activity/ActivityTaskList.vue'
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
  TASK_STATUS_LABELS,
  connectedAgents,
  workingAgents,
  recentlyDisconnectedAgents,
  activeReasoningSessions,
  humans,
  participants,
  historyEntries,
  clearedLiveCount,
  historyRoomOptions,
  selectedHistoryRoomId,
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
  participantMeta,
  participantNote,
  historyLastSeenLabel,
  historyParticipantNote,
  historyDetailNote,
  reasoningCardTitle,
  reasoningCardSummary,
  reasoningStatusLabel,
  livenessCapabilityLabel,
  reasoningTimestamp,
  connectionLabel,
  getTaskLink,
  changeHistoryPage,
  handleClearDisconnected,
  formatLastSeen,
  previewMessage,
} = useActivityViewModel(props)
</script>

<style scoped src="./activity/ActivityView.css"></style>
