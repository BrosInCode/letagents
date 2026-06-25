<template>
  <section class="room-tab-page room-activity-page" data-testid="room-activity-tab-view">
    <div class="desktop-activity-toolbar">
      <div class="desktop-activity-switcher" role="tablist" aria-label="Activity view">
        <button type="button" :data-active="activeView === 'live'" @click="activeView = 'live'">Live</button>
        <button type="button" :data-active="activeView === 'history'" @click="activeView = 'history'">History</button>
      </div>
      <button
        class="desktop-activity-add-agent"
        type="button"
        data-testid="desktop-activity-add-agent"
        @click="emit('open-add-agent')"
      >
        Add agent
      </button>
    </div>

    <div v-if="activeView === 'live'" class="desktop-activity-layout" :data-empty="!liveRosterAgents.length">
      <article v-if="!liveRosterAgents.length" class="desktop-activity-live-empty">
        <span>Live activity</span>
        <h3>No agents are live right now</h3>
        <p>Reachable agents and current work signals appear here when they are active in this room.</p>
        <div class="desktop-activity-empty-actions">
          <button type="button" @click="emit('open-add-agent')">Add agent</button>
          <button type="button" @click="refreshActivity">Refresh</button>
        </div>
      </article>

      <template v-else>
        <div class="desktop-activity-groups">
          <section v-if="reachableAgents.length" class="desktop-activity-group">
            <header>
              <div>
                <h3>Reachable now</h3>
                <p>Agents available for new room messages.</p>
              </div>
              <strong>{{ reachableAgents.length }}</strong>
            </header>

            <button
              v-for="agent in reachableAgents"
              :key="agent.key"
              class="desktop-activity-roster-item"
              :data-selected="selectedLiveParticipant?.key === agent.key"
              :data-state="agent.activityState || 'offline'"
              type="button"
              @click="selectedLiveKey = agent.key"
            >
              <span class="desktop-activity-avatar" :data-state="agent.activityState || 'offline'">{{ initials(agent.label) }}</span>
              <span>
                <strong>{{ agent.label }}</strong>
                <small>{{ agent.statusText || agent.workLabel || agent.runtime || "Ready for room messages" }}</small>
              </span>
              <span class="desktop-activity-row-meta">
                <span class="state-pill" :data-state="agent.activityState || 'offline'">{{ connectionLabel(agent) }}</span>
                <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
              </span>
            </button>
          </section>

          <section v-if="workingAgents.length" class="desktop-activity-group">
            <header>
              <div>
                <h3>Working</h3>
                <p>Recent task, status, or reasoning signals without room delivery.</p>
              </div>
              <strong>{{ workingAgents.length }}</strong>
            </header>

            <button
              v-for="agent in workingAgents"
              :key="agent.key"
              class="desktop-activity-roster-item"
              :data-selected="selectedLiveParticipant?.key === agent.key"
              :data-state="agent.workState || 'working'"
              type="button"
              @click="selectedLiveKey = agent.key"
            >
              <span class="desktop-activity-avatar" :data-state="agent.workState || 'active'">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 8.2 6.5 11 12 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span>
                <strong>{{ agent.label }}</strong>
                <small>{{ signalLabel(agent) }}<template v-if="agent.statusText"> · {{ agent.statusText }}</template></small>
              </span>
              <span class="desktop-activity-row-meta">
                <span class="desktop-activity-mini-pill">work signal</span>
                <span v-if="agent.activeReasoning.length" class="desktop-activity-mini-pill">{{ agent.activeReasoning.length }} reasoning</span>
                <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
              </span>
            </button>
          </section>
        </div>

        <aside v-if="selectedLiveParticipant" class="desktop-activity-detail" data-kind="agent">
          <div class="desktop-activity-detail-header">
            <div class="desktop-activity-detail-identity">
              <span class="desktop-activity-dot" :data-state="connectionTone(selectedLiveParticipant)" aria-hidden="true"></span>
              <div>
                <h3>{{ selectedLiveParticipant.label }}</h3>
                <p>
                  {{ detailSubtitle(selectedLiveParticipant) }}
                  <span aria-hidden="true">·</span>
                  {{ selectedLiveParticipant.runtime || selectedLiveParticipant.ideLabel || "agent" }}
                  <span aria-hidden="true">·</span>
                  {{ formatRelativeTime(selectedLiveParticipant.lastSeenAt) }}
                </p>
              </div>
            </div>
            <div class="desktop-activity-detail-actions">
              <span class="state-pill" :data-state="connectionTone(selectedLiveParticipant)">
                {{ connectionDisplayLabel(selectedLiveParticipant) }}
              </span>
              <button
                type="button"
                data-testid="desktop-activity-open-agent-controls"
                @click="emit('open-agent-detail', activityParticipantToAgentTarget(selectedLiveParticipant))"
              >
                Open controls
              </button>
            </div>
          </div>

          <section class="desktop-activity-inspector-list">
            <article v-if="selectedLiveParticipant.statusText" class="desktop-activity-inspector-row" data-emphasis="true">
              <span>Latest status</span>
              <p>{{ selectedLiveParticipant.statusText }}</p>
            </article>

            <article class="desktop-activity-inspector-row">
              <span>Session</span>
              <p v-if="selectedLiveParticipant.livenessObservation">
                {{ selectedLiveParticipant.livenessObservation.hostLabel || selectedLiveParticipant.livenessObservation.hostKind || "Agent host" }}
                observed {{ formatRelativeTime(selectedLiveParticipant.livenessObservation.lastObservedAt) }}
              </p>
              <p v-else>Room presence only</p>
            </article>

            <article v-if="activeSourceBadges(selectedLiveParticipant).length" class="desktop-activity-inspector-row">
              <span>Sources</span>
              <p>{{ sourceSummary(selectedLiveParticipant) }}</p>
            </article>
          </section>

          <section v-if="selectedLiveParticipant.latestReasoning" class="desktop-activity-detail-section">
            <header>
              <h4>Reasoning</h4>
              <span>{{ reasoningStatus(selectedLiveParticipant.latestReasoning) }}</span>
            </header>
            <article class="desktop-activity-reasoning">
              <strong>{{ reasoningTitle(selectedLiveParticipant.latestReasoning) }}</strong>
              <p>{{ reasoningSummary(selectedLiveParticipant.latestReasoning) }}</p>
              <div v-if="selectedLiveParticipant.latestReasoningFields.length" class="desktop-agent-modal-fields">
                <span v-for="field in selectedLiveParticipant.latestReasoningFields" :key="field.label">
                  <small>{{ field.label }}</small>
                  <strong>{{ field.value }}</strong>
                </span>
              </div>
            </article>
          </section>

          <section v-if="selectedLiveParticipant.currentTasks.length" class="desktop-activity-detail-section">
            <header>
              <h4>Current work</h4>
              <span>{{ selectedLiveParticipant.currentTasks.length }}</span>
            </header>
            <article v-for="task in selectedLiveParticipant.currentTasks" :key="task.id" class="desktop-activity-task">
              <strong>{{ task.title }}</strong>
              <span>{{ taskStatusLabel(task.status) }}</span>
            </article>
          </section>

          <section v-if="selectedLiveParticipant.activeReasoning.length" class="desktop-activity-detail-section">
            <header>
              <h4>Live reasoning</h4>
              <span>{{ selectedLiveParticipant.activeReasoning.length }}</span>
            </header>
            <article v-for="session in selectedLiveParticipant.activeReasoning" :key="session.id" class="desktop-activity-reasoning">
              <strong>{{ reasoningTitle(session) }}</strong>
              <p>{{ reasoningSummary(session) }}</p>
              <span>{{ reasoningStatus(session) }} · {{ formatRelativeTime(session.updatedAt || session.createdAt) }}</span>
              <button type="button" class="desktop-reasoning-open-button" @click="emit('open-reasoning', session.id)">
                Open reasoning
              </button>
            </article>
          </section>
      </aside>
      </template>
    </div>

    <div v-else class="desktop-activity-layout">
      <div class="desktop-activity-groups">
        <section class="desktop-activity-group">
          <header>
            <div>
              <h3>Room history</h3>
              <p>Participants ordered by their latest room-family activity.</p>
            </div>
            <strong>{{ recentActivity.length }}</strong>
          </header>

          <button
            v-for="entry in recentActivity"
            :key="entry.id"
            class="desktop-activity-roster-item"
            :data-selected="selectedHistoryEntry?.id === entry.id"
            :data-state="entry.activityState || 'offline'"
            type="button"
            @click="selectedHistoryKey = entry.id"
          >
            <span class="desktop-activity-avatar" :data-state="entry.activityState || 'offline'">
              {{ initials(entry.participantDisplayName) }}
            </span>
            <span>
              <strong>{{ entry.participantDisplayName }}</strong>
              <small>{{ entry.room?.displayName || "This room" }} · {{ entry.participantKind }}</small>
            </span>
            <span class="desktop-activity-row-meta">
              <span class="desktop-activity-mini-pill">{{ entry.currentTasks.length }} open</span>
              <small>{{ formatRelativeTime(entry.lastRoomActivityAt) }}</small>
            </span>
          </button>

          <article v-if="!recentActivity.length" class="desktop-activity-empty">No room history has been recorded yet.</article>
        </section>
      </div>

      <aside v-if="selectedHistoryEntry" class="desktop-activity-detail">
        <div class="desktop-activity-detail-header">
          <div>
            <span>History detail</span>
            <h3>{{ selectedHistoryEntry.participantDisplayName }}</h3>
            <p>
              {{ selectedHistoryEntry.room?.displayName || "This room" }}
              · last active {{ formatRelativeTime(selectedHistoryEntry.lastRoomActivityAt) }}
            </p>
          </div>
          <span class="state-pill" :data-state="selectedHistoryEntry.activityState || 'offline'">
            {{ selectedHistoryEntry.activityState || "history" }}
          </span>
        </div>

        <div class="desktop-activity-detail-stats">
          <article>
            <strong>{{ selectedHistoryEntry.currentTasks.length }}</strong>
            <span>Current</span>
          </article>
          <article>
            <strong>{{ selectedHistoryEntry.completedTasks.length }}</strong>
            <span>Completed</span>
          </article>
          <article>
            <strong>{{ selectedHistoryEntry.createdTasks.length }}</strong>
            <span>Created</span>
          </article>
          <article>
            <strong>{{ formatRelativeTime(selectedHistoryEntry.firstSeenAt) }}</strong>
            <span>First seen</span>
          </article>
        </div>

        <section class="desktop-activity-detail-section">
          <header>
            <h4>Current work</h4>
            <span>{{ selectedHistoryEntry.currentTasks.length }}</span>
          </header>
          <article v-for="task in selectedHistoryEntry.currentTasks" :key="task.id" class="desktop-activity-task">
            <strong>{{ task.title }}</strong>
            <a v-if="task.workflowRefs[0]" :href="task.workflowRefs[0].url" target="_blank" rel="noopener noreferrer">
              {{ task.workflowRefs[0].label }}
            </a>
            <span v-else>{{ taskStatusLabel(task.status) }}</span>
          </article>
          <p v-if="!selectedHistoryEntry.currentTasks.length" class="desktop-activity-muted">No open tasks linked in this room history scope.</p>
        </section>

        <section class="desktop-activity-detail-section">
          <header>
            <h4>Recent completed work</h4>
            <span>{{ selectedHistoryEntry.completedTasks.length }}</span>
          </header>
          <article v-for="task in selectedHistoryEntry.completedTasks" :key="task.id" class="desktop-activity-task">
            <strong>{{ task.title }}</strong>
            <span>{{ taskStatusLabel(task.status) }}</span>
          </article>
          <p v-if="!selectedHistoryEntry.completedTasks.length" class="desktop-activity-muted">No completed work tracked yet.</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import type { ActivityParticipant } from "./room-activity/types";
import { activityParticipantToAgentTarget } from "./room-activity/agentTarget";
import { useRoomActivityViewModel } from "./room-activity/useRoomActivityViewModel";
import type { AgentModalTarget } from "./desktop-chat-message/types";

const props = defineProps<{
  recentActivity: DesktopActivityEntry[];
  participants: DesktopParticipantSummary[];
  liveClearedCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  tasks: DesktopTaskSummary[];
  messages: DesktopRoomMessage[];
  workers: WorkerSnapshot[];
}>();

const emit = defineEmits<{
  "open-reasoning": [sessionId: string];
  "open-add-agent": [];
  "open-agent-detail": [target: AgentModalTarget];
  "refresh-room": [];
}>();

const {
  activeView,
  selectedLiveKey,
  selectedHistoryKey,
  reachableAgents,
  workingAgents,
  liveRosterAgents,
  selectedLiveParticipant,
  selectedHistoryEntry,
  initials,
  connectionLabel,
  connectionTone,
  formatRelativeTime,
  signalLabel,
  reasoningStatus,
  reasoningTitle,
  reasoningSummary,
  sourceBadges,
  taskStatusLabel,
} = useRoomActivityViewModel(props);

function refreshActivity(): void {
  emit("refresh-room");
}

function activeSourceBadges(participant: ActivityParticipant): Array<{ label: string; active: boolean }> {
  return sourceBadges(participant).filter((source) => source.active);
}

function sourceSummary(participant: ActivityParticipant): string {
  return activeSourceBadges(participant).map((source) => source.label).join(", ");
}

function connectionDisplayLabel(participant: ActivityParticipant): string {
  const label = connectionLabel(participant);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function detailSubtitle(participant: ActivityParticipant): string {
  if (participant.activityState === "active" || participant.activityState === "away") return "Reachable in chat";
  if (connectionLabel(participant) === "work signal") return "Work updates available";
  return "Not reachable in chat";
}

onMounted(refreshActivity);
</script>
