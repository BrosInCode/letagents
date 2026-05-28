<template>
  <div class="activity-history-view">
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
      <span v-if="activityHistory">{{ historyPageLabel }}</span>
    </div>

    <div v-if="activityHistoryLoading" class="activity-empty">
      <h3>Loading room history</h3>
      <p>Pulling room-family activity and task history.</p>
    </div>

    <div v-else-if="activityHistoryError" class="activity-empty">
      <h3>History unavailable</h3>
      <p>{{ activityHistoryError }}</p>
    </div>

    <div v-else-if="historyEntriesCount === 0" class="activity-empty">
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

          <ActivityRosterList
            :participants="historyAgents"
            :selectedKey="selectedHistoryParticipantKey"
            mode="history"
            emptyMessage="No agents match this room history scope yet."
            @select="selectedHistoryParticipantKey = $event"
          />
        </section>

        <section v-if="showHistoryHumanSection" class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Humans seen in room</h3>
              <p>Record of human participants in this room.</p>
            </div>
            <span class="activity-group-count">{{ historyHumans.length }}</span>
          </div>

          <ActivityRosterList
            :participants="historyHumans"
            :selectedKey="selectedHistoryParticipantKey"
            mode="history"
            showHumanKind
            emptyMessage="No human room activity is recorded for this scope yet."
            @select="selectedHistoryParticipantKey = $event"
          />
        </section>
      </div>

      <ActivityHistoryDetail
        v-if="selectedHistoryParticipant"
        :participant="selectedHistoryParticipant"
        :roomOption="selectedHistoryRoomOption"
        :taskGithubStatus="taskGithubStatus"
      />
    </div>

    <div v-if="activityHistory && activityHistory.page_count > 1" class="activity-history-pagination">
      <button
        class="activity-pagination-button"
        type="button"
        :disabled="activityHistory.page <= 1 || activityHistoryLoading"
        @click="emit('changePage', (activityHistory?.page || 1) - 1)"
      >
        Previous
      </button>
      <button
        class="activity-pagination-button"
        type="button"
        :disabled="activityHistory.page >= activityHistory.page_count || activityHistoryLoading"
        @click="emit('changePage', (activityHistory?.page || 1) + 1)"
      >
        Next
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  RoomActivityHistoryKind,
  RoomActivityHistoryPage,
  TaskGitHubArtifactStatus,
} from '@/composables/useRoom'
import { AppSelect } from '@/components/ui'
import ActivityHistoryDetail from './ActivityHistoryDetail.vue'
import ActivityRosterList from './ActivityRosterList.vue'
import type {
  HistoryParticipant,
  HistoryRoomOption,
} from './types'

defineProps<{
  activityHistory: RoomActivityHistoryPage | null
  activityHistoryLoading: boolean
  activityHistoryError: string
  historyRoomOptions: readonly HistoryRoomOption[]
  selectedHistoryRoomOption: HistoryRoomOption | null
  historyCountLabel: string
  historyPageLabel: string
  historyEntriesCount: number
  historyAgents: readonly HistoryParticipant[]
  historyHumans: readonly HistoryParticipant[]
  showHistoryAgentSection: boolean
  showHistoryHumanSection: boolean
  selectedHistoryParticipant: HistoryParticipant | null
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

const emit = defineEmits<{
  changePage: [page: number]
}>()

const historyRoomId = defineModel<string>('historyRoomId', { required: true })
const historyQuery = defineModel<string>('historyQuery', { required: true })
const historyKind = defineModel<RoomActivityHistoryKind>('historyKind', { required: true })
const selectedHistoryParticipantKey = defineModel<string | null>('selectedHistoryParticipantKey', { required: true })
</script>
