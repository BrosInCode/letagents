<template>
  <div v-if="participants.length === 0" class="activity-empty">
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

        <ActivityRosterList
          :participants="connectedAgents"
          :selectedKey="selectedParticipantKey"
          mode="live"
          showConnectionBadges
          emptyMessage="No agents are connected to this room right now."
          @select="selectedParticipantKey = $event"
        />
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
              v-if="canManageParticipants && recentlyDisconnectedAgents.length > 0"
              class="activity-action-button"
              type="button"
              :disabled="clearBusy"
              @click="emit('clearDisconnected')"
            >
              {{ clearBusy ? 'Clearing…' : 'Clear disconnected' }}
            </button>
          </div>
        </div>

        <ActivityRosterList
          :participants="recentlyDisconnectedAgents"
          :selectedKey="selectedParticipantKey"
          mode="live"
          showConnectionBadges
          :emptyMessage="clearedLiveCount > 0 ? 'Disconnected agents were cleared from the live roster.' : 'No recently disconnected agents have been seen yet.'"
          @select="selectedParticipantKey = $event"
        />
      </section>

      <section class="activity-group">
        <div class="activity-group-header">
          <div>
            <h3>Humans seen in room</h3>
            <p>Human participants currently active in the room.</p>
          </div>
          <span class="activity-group-count">{{ humans.length }}</span>
        </div>

        <ActivityRosterList
          :participants="humans"
          :selectedKey="selectedParticipantKey"
          mode="live"
          showHumanKind
          emptyMessage="No human browser activity has been seen yet."
          @select="selectedParticipantKey = $event"
        />
      </section>
    </div>

    <ActivityLiveDetail
      v-if="selectedParticipant"
      :participant="selectedParticipant"
      :taskGithubStatus="taskGithubStatus"
      @openReasoning="emit('openReasoning', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import type { TaskGitHubArtifactStatus } from '@/composables/useRoom'
import ActivityLiveDetail from './ActivityLiveDetail.vue'
import ActivityRosterList from './ActivityRosterList.vue'
import type { ActivityParticipant } from './types'

defineProps<{
  participants: readonly ActivityParticipant[]
  connectedAgents: readonly ActivityParticipant[]
  recentlyDisconnectedAgents: readonly ActivityParticipant[]
  humans: readonly ActivityParticipant[]
  selectedParticipant: ActivityParticipant | null
  clearedLiveCount: number
  canManageParticipants: boolean
  clearBusy: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

const emit = defineEmits<{
  clearDisconnected: []
  openReasoning: [sessionId: string]
}>()

const selectedParticipantKey = defineModel<string | null>('selectedParticipantKey', { required: true })
</script>
