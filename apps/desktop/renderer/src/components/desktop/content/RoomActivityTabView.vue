<template>
  <section class="room-tab-page room-activity-page" data-testid="room-activity-tab-view">
    <div class="desktop-activity-summary">
      <article v-for="card in summaryCards" :key="card.label" class="desktop-activity-stat" :data-tone="card.tone">
        <span class="desktop-activity-stat-top">
          <span class="desktop-activity-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path :d="activityIconPath(card.icon)" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <strong>{{ card.value }}</strong>
        </span>
        <span>{{ card.label }}</span>
      </article>
    </div>

    <div class="desktop-activity-toolbar">
      <div class="desktop-activity-switcher" role="tablist" aria-label="Activity view">
        <button type="button" :data-active="activeView === 'live'" @click="activeView = 'live'">Live</button>
        <button type="button" :data-active="activeView === 'history'" @click="activeView = 'history'">History</button>
      </div>
      <span>{{ toolbarNote }}</span>
    </div>

    <div v-if="activeView === 'live'" class="desktop-activity-layout">
      <div class="desktop-activity-groups">
        <section class="desktop-activity-group">
          <header>
            <span class="desktop-activity-header-icon" data-tone="reachable" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path :d="activityIconPath('radio')" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <h3>Reachable agents</h3>
              <p>Delivery-backed worker sessions that can receive room messages now.</p>
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
              <small>{{ agent.ownerLabel || agent.runtime || "Agent" }}<template v-if="agent.ideLabel"> · {{ agent.ideLabel }}</template></small>
            </span>
            <span class="desktop-activity-row-meta">
              <span class="state-pill" :data-state="agent.activityState || 'offline'">{{ connectionLabel(agent) }}</span>
              <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!reachableAgents.length" class="desktop-activity-empty">No reachable worker sessions right now.</article>
        </section>

        <section class="desktop-activity-group">
          <header>
            <span class="desktop-activity-header-icon" data-tone="signal" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path :d="activityIconPath('pulse')" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <h3>Agent signals</h3>
              <p>Status, leases, reasoning, and host liveness from worker sessions.</p>
            </div>
            <strong>{{ agentSignalAgents.length }}</strong>
          </header>

          <button
            v-for="agent in agentSignalAgents"
            :key="agent.key"
            class="desktop-activity-roster-item"
            :data-selected="selectedLiveParticipant?.key === agent.key"
            :data-state="agent.workState || (hasRecentLivenessObservation(agent) ? 'active' : agent.activityState || 'offline')"
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
              <span v-if="!isReachableParticipant(agent)" class="desktop-activity-mini-pill">signal only</span>
              <span v-if="agent.activeReasoning.length" class="desktop-activity-mini-pill">{{ agent.activeReasoning.length }} reasoning</span>
              <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!agentSignalAgents.length" class="desktop-activity-empty">No active agent signals are exposed yet.</article>
        </section>

        <section class="desktop-activity-group">
          <header>
            <span class="desktop-activity-header-icon" data-tone="offline" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path :d="activityIconPath('power')" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <h3>Recently disconnected</h3>
              <p>Worker sessions that were recently known but are no longer reachable.</p>
            </div>
            <strong>{{ disconnectedAgents.length }}</strong>
          </header>

          <button
            v-for="agent in disconnectedAgents"
            :key="agent.key"
            class="desktop-activity-roster-item"
            :data-selected="selectedLiveParticipant?.key === agent.key"
            data-state="offline"
            type="button"
            @click="selectedLiveKey = agent.key"
          >
            <span class="desktop-activity-avatar" data-state="offline">{{ initials(agent.label) }}</span>
            <span>
              <strong>{{ agent.label }}</strong>
              <small>{{ agent.ownerLabel || "Agent" }}</small>
            </span>
            <span class="desktop-activity-row-meta">
              <span class="state-pill" data-state="offline">offline</span>
              <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!disconnectedAgents.length" class="desktop-activity-empty">
            {{ liveClearedCount > 0 ? "Disconnected agents were cleared from the live roster." : "No recently disconnected agents." }}
          </article>
        </section>

        <section class="desktop-activity-group">
          <header>
            <span class="desktop-activity-header-icon" data-tone="human" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path :d="activityIconPath('user')" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <h3>Humans seen in room</h3>
              <p>Human participants currently active in the room.</p>
            </div>
            <strong>{{ humans.length }}</strong>
          </header>

          <button
            v-for="human in humans"
            :key="human.key"
            class="desktop-activity-roster-item"
            :data-selected="selectedLiveParticipant?.key === human.key"
            data-state="human"
            type="button"
            @click="selectedLiveKey = human.key"
          >
            <span class="desktop-activity-avatar" data-state="human">{{ initials(human.label) }}</span>
            <span>
              <strong>{{ human.label }}</strong>
              <small>Human participant</small>
            </span>
            <span class="desktop-activity-row-meta">
              <span class="state-pill" data-state="human">human</span>
              <small>{{ formatRelativeTime(human.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!humans.length" class="desktop-activity-empty">No human room activity has been seen yet.</article>
        </section>
      </div>

      <aside v-if="selectedLiveParticipant" class="desktop-activity-detail" :data-kind="selectedLiveParticipant.kind">
        <div class="desktop-activity-detail-header">
          <div>
            <span>{{ selectedLiveParticipant.kind === "agent" ? "Agent status" : "Human activity" }}</span>
            <h3>{{ selectedLiveParticipant.label }}</h3>
            <p>{{ participantSubtitle(selectedLiveParticipant) }}</p>
          </div>
          <span class="state-pill" :data-state="selectedLiveParticipant.activityState || 'offline'">
            {{ connectionLabel(selectedLiveParticipant) }}
          </span>
        </div>

        <div class="desktop-activity-detail-stats">
          <article>
            <strong>{{ selectedLiveParticipant.messageCount }}</strong>
            <span>Messages</span>
          </article>
          <article>
            <strong>{{ selectedLiveParticipant.currentTasks.length }}</strong>
            <span>Open tasks</span>
          </article>
          <article>
            <strong>{{ selectedLiveParticipant.reasoningCount }}</strong>
            <span>Reasoning</span>
          </article>
          <article>
            <strong>{{ formatRelativeTime(selectedLiveParticipant.lastSeenAt) }}</strong>
            <span>Last signal</span>
          </article>
        </div>

        <section v-if="selectedLiveParticipant.statusText" class="desktop-activity-note">
          <span>Status</span>
          <p>{{ selectedLiveParticipant.statusText }}</p>
        </section>

        <section class="desktop-activity-detail-section">
          <header>
            <h4>Session liveness</h4>
            <span>{{ selectedLiveParticipant.livenessObservation ? "Enriched" : "Basic" }}</span>
          </header>
          <article v-if="selectedLiveParticipant.livenessObservation" class="desktop-activity-note">
            <span>{{ livenessCapabilityLabel(selectedLiveParticipant.livenessObservation.livenessCapability) }}</span>
            <p>
              {{ selectedLiveParticipant.livenessObservation.hostLabel || selectedLiveParticipant.livenessObservation.hostKind || "Agent host" }}
              observed this session {{ formatRelativeTime(selectedLiveParticipant.livenessObservation.lastObservedAt) }}.
            </p>
          </article>
          <p v-else class="desktop-activity-muted">
            Standard room presence only. LetAgents Desktop can enrich this when the agent host reports session activity.
          </p>
          <div class="desktop-activity-source-grid">
            <span
              v-for="source in sourceBadges(selectedLiveParticipant)"
              :key="source.label"
              :data-active="source.active"
            >
              {{ source.label }}
            </span>
          </div>
        </section>

        <section class="desktop-activity-detail-section">
          <header>
            <h4>Current work</h4>
            <span>{{ selectedLiveParticipant.currentTasks.length }}</span>
          </header>
          <article v-for="task in selectedLiveParticipant.currentTasks" :key="task.id" class="desktop-activity-task">
            <strong>{{ task.title }}</strong>
            <span>{{ taskStatusLabel(task.status) }}</span>
          </article>
          <p v-if="!selectedLiveParticipant.currentTasks.length" class="desktop-activity-muted">No open tasks linked to this participant.</p>
        </section>

        <section class="desktop-activity-detail-section">
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
          <p v-if="!selectedLiveParticipant.activeReasoning.length" class="desktop-activity-muted">No active reasoning stream exposed right now.</p>
        </section>
      </aside>
    </div>

    <div v-else class="desktop-activity-layout">
      <div class="desktop-activity-groups">
        <section class="desktop-activity-group">
          <header>
            <span class="desktop-activity-header-icon" data-tone="history" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path :d="activityIconPath('clock')" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
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
import { computed, ref, watch } from "vue";
import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import { displayNameFromActor, ideFromActor, normalizeAgentKey, ownerFromActor } from "../../../domain/agents";
import { reasoningSummary, reasoningTitle } from "../../../domain/reasoning";
import { sortTasksByUpdated } from "../../../domain/tasks";
import { formatRelativeTime, latestTimestamp, timestampValue } from "../../../domain/time";

type ActivityState = "active" | "away" | "offline";
type ParticipantKind = "agent" | "human";
type ActivityIcon = "radio" | "pulse" | "power" | "user" | "brain" | "clock" | "task";
type ActivityTone = "reachable" | "signal" | "offline" | "human" | "reasoning" | "history" | "task";

interface ActivitySummaryCard {
  value: number;
  label: string;
  icon: ActivityIcon;
  tone: ActivityTone;
}

interface ActivityParticipant {
  key: string;
  kind: ParticipantKind;
  label: string;
  actorLabel: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  runtime: string | null;
  activityState: ActivityState | null;
  status: DesktopAgentPresence["status"] | null;
  statusText: string | null;
  livenessObservation: DesktopAgentPresence["livenessObservation"];
  workState: string | null;
  workLabel: string | null;
  lastSeenAt: string | null;
  messageCount: number;
  reasoningCount: number;
  currentTasks: DesktopTaskSummary[];
  completedTasks: DesktopTaskSummary[];
  activeReasoning: DesktopReasoningSession[];
  sources: string[];
}

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
}>();

const activeView = ref<"live" | "history">("live");
const selectedLiveKey = ref<string | null>(null);
const selectedHistoryKey = ref<string | null>(null);

const openTaskStatuses = new Set(["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review"]);
const completedTaskStatuses = new Set(["merged", "done"]);
const inactiveReasoningStatuses = new Set(["completed", "done", "dismissed", "closed"]);
const recentSignalWindowMs = 15 * 60 * 1000;

const hiddenAgentActors = computed(() => new Set(
  props.participants
    .filter((participant) => participant.kind === "agent" && participant.hiddenAt && participant.actorLabel)
    .map((participant) => participant.actorLabel as string)
));
const participantsByActor = computed(() => new Map(
  props.participants
    .filter((participant) => participant.kind === "agent" && !participant.hiddenAt && participant.actorLabel)
    .map((participant) => [participant.actorLabel as string, participant])
));

const agentMessagesByActor = computed(() => {
  const grouped = new Map<string, DesktopRoomMessage[]>();
  for (const message of props.messages) {
    const actor = message.actorLabel || message.agentIdentity?.actorLabel || (!isHumanMessage(message) ? message.sender : null);
    if (!actor) continue;
    grouped.set(actor, [...(grouped.get(actor) || []), message]);
  }
  return grouped;
});

const activityEntriesByActor = computed(() => {
  const grouped = new Map<string, DesktopActivityEntry>();
  for (const entry of props.recentActivity) {
    if (entry.participantKind !== "agent") continue;
    for (const key of [
      entry.participantActorLabel,
      entry.participantDisplayName,
    ].map(normalizeAgentKey).filter(Boolean)) {
      const existing = grouped.get(key);
      if (!existing || timestampValue(entry.lastRoomActivityAt) > timestampValue(existing.lastRoomActivityAt)) {
        grouped.set(key, entry);
      }
    }
  }
  return grouped;
});

const liveParticipants = computed(() => {
  const agents = new Map<string, ActivityParticipant>();

  for (const presence of props.presence) {
    if (presence.sessionKind !== "worker") continue;
    if (hiddenAgentActors.value.has(presence.actorLabel) && !isReachablePresence(presence)) continue;
    const participant = participantsByActor.value.get(presence.actorLabel) || null;
    const key = `agent:${presence.agentSessionId || presence.actorLabel}`;
    agents.set(key, buildAgentParticipant(key, presence.actorLabel, participant, presence));
  }

  return [
    ...[...agents.values()].sort(compareActivityParticipants),
    ...props.participants
      .filter((participant) => participant.kind === "human" && !participant.hiddenAt)
      .map(buildHumanParticipant)
      .sort(compareActivityParticipants),
  ];
});

const reachableAgents = computed(() =>
  liveParticipants.value.filter((participant) =>
    participant.kind === "agent" && (participant.activityState === "active" || participant.activityState === "away")
  )
);
const disconnectedAgents = computed(() =>
  liveParticipants.value.filter((participant) =>
    participant.kind === "agent"
    && participant.activityState === "offline"
    && hasDeliverySignal(participant)
    && !hasAgentSignal(participant)
  )
);
const agentSignalAgents = computed(() =>
  liveParticipants.value
    .filter((participant) => participant.kind === "agent" && hasAgentSignal(participant))
    .sort(compareSignalParticipants)
);
const humans = computed(() => liveParticipants.value.filter((participant) => participant.kind === "human"));
const visibleLiveParticipants = computed(() => {
  const participants = new Map<string, ActivityParticipant>();
  for (const participant of [
    ...reachableAgents.value,
    ...agentSignalAgents.value,
    ...disconnectedAgents.value,
    ...humans.value,
  ]) {
    participants.set(participant.key, participant);
  }
  return [...participants.values()];
});
const selectedLiveParticipant = computed(() =>
  visibleLiveParticipants.value.find((participant) => participant.key === selectedLiveKey.value) || visibleLiveParticipants.value[0] || null
);
const selectedHistoryEntry = computed(() =>
  props.recentActivity.find((entry) => entry.id === selectedHistoryKey.value) || props.recentActivity[0] || null
);

const summaryCards = computed<ActivitySummaryCard[]>(() => activeView.value === "live"
  ? [
      { value: reachableAgents.value.length, label: "Reachable agents", icon: "radio", tone: "reachable" },
      { value: agentSignalAgents.value.length, label: "Agent signals", icon: "pulse", tone: "signal" },
      { value: disconnectedAgents.value.length, label: "Disconnected", icon: "power", tone: "offline" },
      { value: humans.value.length, label: "Humans seen", icon: "user", tone: "human" },
      { value: activeReasoningSessions.value.length, label: "Reasoning streams", icon: "brain", tone: "reasoning" },
    ]
  : [
      { value: props.recentActivity.filter((entry) => entry.participantKind === "agent").length, label: "Agents in history", icon: "clock", tone: "history" },
      { value: props.recentActivity.filter((entry) => entry.participantKind === "human").length, label: "Humans in history", icon: "user", tone: "human" },
      { value: props.recentActivity.reduce((total, entry) => total + entry.currentTasks.length, 0), label: "Open tasks linked", icon: "task", tone: "task" },
      { value: props.recentActivity.reduce((total, entry) => total + entry.completedTasks.length, 0), label: "Completed tasks", icon: "task", tone: "reachable" },
    ]);
const activeReasoningSessions = computed(() =>
  liveParticipants.value.flatMap((participant) => participant.activeReasoning)
);
const liveClearedCount = computed(() => props.liveClearedCount || 0);
const toolbarNote = computed(() => activeView.value === "live"
  ? liveClearedCount.value > 0
    ? `${liveClearedCount.value} cleared from the live roster.`
    : "Desktop separates message reachability from worker status, tasks, reasoning, and session liveness."
  : "History is the shared web-compatible room record.");

watch(visibleLiveParticipants, (next) => {
  if (!next.length) {
    selectedLiveKey.value = null;
    return;
  }
  if (!selectedLiveKey.value || !next.some((participant) => participant.key === selectedLiveKey.value)) {
    selectedLiveKey.value = next[0].key;
  }
}, { immediate: true });

watch(() => props.recentActivity, (next) => {
  if (!next.length) {
    selectedHistoryKey.value = null;
    return;
  }
  if (!selectedHistoryKey.value || !next.some((entry) => entry.id === selectedHistoryKey.value)) {
    selectedHistoryKey.value = next[0].id;
  }
}, { immediate: true });

function buildAgentParticipant(
  key: string,
  actorLabel: string,
  participant: DesktopParticipantSummary | null,
  presence: DesktopAgentPresence | null
): ActivityParticipant {
  const messages = agentMessagesByActor.value.get(actorLabel) || [];
  const activeReasoning = props.reasoningSessions
    .filter((session) => sessionMatchesAgent(actorLabel, participant?.displayName || presence?.displayName || actorLabel, session))
    .filter(isActiveReasoningSession)
    .sort((left, right) => timestampValue(right.updatedAt || right.createdAt) - timestampValue(left.updatedAt || left.createdAt));
  const assignedTasks = props.tasks.filter((task) => participantMatchesActor(actorLabel, participant?.displayName, task.assignee));
  const activityEntry = activityEntryForAgent(actorLabel, participant?.displayName || presence?.displayName || null);
  const currentTasks = mergeTasks(
    activityTasksToDesktopTasks(activityEntry?.currentTasks || []),
    sortTasksByUpdated(assignedTasks.filter((task) => openTaskStatuses.has(task.status)))
  );
  const completedTasks = mergeTasks(
    activityTasksToDesktopTasks(activityEntry?.completedTasks || []),
    sortTasksByUpdated(assignedTasks.filter((task) => completedTaskStatuses.has(task.status)))
  ).slice(0, 6);
  const statusText = presence?.statusText || latestStatusMessage(messages) || null;
  const activityState = resolveActivityState(participant, presence);
  const workSignal = workSignalFrom(presence, statusText, currentTasks.length, activeReasoning.length);
  const messageCount = Math.max(messages.length, activityEntry?.messageCount || 0);
  const reasoningCount = Math.max(activeReasoning.length, activityEntry?.reasoningSessionCount || 0);

  return {
    key,
    kind: "agent",
    label: participant?.displayName || presence?.displayName || displayNameFromActor(actorLabel),
    actorLabel,
    ownerLabel: participant?.ownerLabel || presence?.ownerLabel || ownerFromActor(actorLabel),
    ideLabel: participant?.ideLabel || presence?.ideLabel || ideFromActor(actorLabel),
    runtime: presence?.runtime || null,
    activityState,
    status: presence?.status || null,
    statusText,
    livenessObservation: presence?.livenessObservation || null,
    workState: workSignal?.state || null,
    workLabel: workSignal?.label || null,
    lastSeenAt: latestTimestamp(
      participant?.lastLiveHeartbeatAt,
      presence?.lastHeartbeatAt,
      presence?.livenessObservation?.lastObservedAt,
      participant?.lastRoomActivityAt,
      participant?.lastSeenAt,
      messages.at(-1)?.timestamp,
      activeReasoning[0]?.updatedAt,
      currentTasks[0]?.updatedAt
    ),
    messageCount,
    reasoningCount,
    currentTasks,
    completedTasks,
    activeReasoning,
    sources: [
      ...(presence?.sourceFlags || []),
      ...(participant?.sourceFlags || []),
      messageCount > 0 ? "messages" : null,
      currentTasks.length || completedTasks.length ? "tasks" : null,
      presence?.livenessObservation ? "session liveness" : null,
      presence?.sourceFlags.includes("delivery") ? "desktop delivery" : null,
      props.workers.some((worker) => worker.roomId && worker.roomId === presence?.roomId) ? "local worker" : null,
    ].filter((source): source is string => Boolean(source)),
  };
}

function buildHumanParticipant(participant: DesktopParticipantSummary): ActivityParticipant {
  const messages = props.messages.filter((message) => isHumanMessage(message) && participantMatchesHuman(participant, message.sender));
  const assignedTasks = props.tasks.filter((task) => participantMatchesHuman(participant, task.assignee));
  return {
    key: `human:${participant.participantKey}`,
    kind: "human",
    label: participant.displayName || participant.githubLogin || "Human",
    actorLabel: participant.githubLogin || participant.displayName,
    ownerLabel: null,
    ideLabel: null,
    runtime: null,
    activityState: participant.activityState,
    status: null,
    statusText: messages.at(-1)?.text || null,
    livenessObservation: null,
    workState: null,
    workLabel: null,
    lastSeenAt: latestTimestamp(participant.lastRoomActivityAt, participant.lastSeenAt, messages.at(-1)?.timestamp),
    messageCount: messages.length,
    reasoningCount: 0,
    currentTasks: sortTasksByUpdated(assignedTasks.filter((task) => openTaskStatuses.has(task.status))),
    completedTasks: sortTasksByUpdated(assignedTasks.filter((task) => completedTaskStatuses.has(task.status))).slice(0, 6),
    activeReasoning: [],
    sources: participant.sourceFlags,
  };
}

function resolveActivityState(participant: DesktopParticipantSummary | null, presence: DesktopAgentPresence | null): ActivityState {
  if (presence && isReachablePresence(presence)) {
    return presence.status === "idle" ? "away" : "active";
  }
  if (participant?.hiddenAt) return "offline";
  if (presence?.activityState) return presence.activityState;
  return participant?.activityState || "offline";
}

function activityEntryForAgent(actorLabel: string, displayName: string | null): DesktopActivityEntry | null {
  return [
    actorLabel,
    displayName,
  ].map(normalizeAgentKey)
    .filter(Boolean)
    .map((key) => activityEntriesByActor.value.get(key) || null)
    .find((entry): entry is DesktopActivityEntry => Boolean(entry)) || null;
}

function isReachablePresence(presence: DesktopAgentPresence): boolean {
  return presence.sessionKind === "worker" && presence.sourceFlags.includes("delivery") && presence.freshness === "active";
}

function isReachableParticipant(participant: ActivityParticipant): boolean {
  return participant.kind === "agent" && (participant.activityState === "active" || participant.activityState === "away");
}

function hasDeliverySignal(participant: ActivityParticipant): boolean {
  return participant.sources.includes("delivery") || participant.sources.includes("desktop delivery");
}

function hasRecentParticipantSignal(participant: ActivityParticipant): boolean {
  return isRecentTimestamp(participant.lastSeenAt);
}

function hasRecentLivenessObservation(participant: ActivityParticipant): boolean {
  return isRecentTimestamp(participant.livenessObservation?.lastObservedAt);
}

function isRecentTimestamp(value: string | null | undefined): boolean {
  const signalTime = timestampValue(value);
  return signalTime >= 0 && Date.now() - signalTime <= recentSignalWindowMs;
}

function hasAgentSignal(participant: ActivityParticipant): boolean {
  if (participant.kind !== "agent") return false;
  if (participant.currentTasks.length || participant.activeReasoning.length) return true;
  if (participant.livenessObservation && hasRecentLivenessObservation(participant)) return true;
  return Boolean((participant.workState || participant.statusText) && hasRecentParticipantSignal(participant));
}

function signalLabel(participant: ActivityParticipant): string {
  if (participant.workLabel) return participant.workLabel;
  if (participant.livenessObservation && hasRecentLivenessObservation(participant)) {
    return livenessCapabilityLabel(participant.livenessObservation.livenessCapability);
  }
  if (participant.statusText) return "Status";
  return "Signal";
}

function workSignalFrom(
  presence: DesktopAgentPresence | null,
  statusText: string | null,
  currentTaskCount: number,
  reasoningCount: number
): { state: string; label: string } | null {
  if (presence?.status === "blocked") return { state: "blocked", label: "Blocked" };
  if (presence?.status === "reviewing") return { state: "reviewing", label: "Reviewing" };
  if (presence?.status === "working") return { state: "working", label: statusText ? "Working" : "In progress" };
  if (reasoningCount > 0) return { state: "responding", label: "Reasoning" };
  if (currentTaskCount > 0) return { state: "working", label: "Assigned" };
  return null;
}

function isActiveReasoningSession(session: DesktopReasoningSession): boolean {
  if (session.closedAt) return false;
  return !inactiveReasoningStatuses.has(String(session.status || "").toLowerCase());
}

function sessionMatchesAgent(actorLabel: string, label: string, session: DesktopReasoningSession): boolean {
  const sessionActor = String(session.actorLabel || "").trim();
  return sessionActor === actorLabel || displayNameFromActor(sessionActor) === label;
}

function compareActivityParticipants(left: ActivityParticipant, right: ActivityParticipant): number {
  const stateRank = (participant: ActivityParticipant) =>
    participant.activityState === "active" ? 0 : participant.activityState === "away" ? 1 : participant.kind === "agent" ? 2 : 3;
  const byState = stateRank(left) - stateRank(right);
  if (byState) return byState;
  return timestampValue(right.lastSeenAt) - timestampValue(left.lastSeenAt) || left.label.localeCompare(right.label);
}

function compareSignalParticipants(left: ActivityParticipant, right: ActivityParticipant): number {
  const leftReachable = isReachableParticipant(left) ? 0 : 1;
  const rightReachable = isReachableParticipant(right) ? 0 : 1;
  return leftReachable - rightReachable || compareActivityParticipants(left, right);
}

function participantMatchesActor(actorLabel: string, displayName: string | null | undefined, value: string | null): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return normalized === actorLabel || normalized === displayName || displayNameFromActor(normalized) === displayName;
}

function participantMatchesHuman(participant: DesktopParticipantSummary, value: string | null): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized && [participant.displayName, participant.githubLogin].some((candidate) => String(candidate || "").trim().toLowerCase() === normalized));
}

function isHumanMessage(message: DesktopRoomMessage): boolean {
  return message.source === "browser" || !message.agentIdentity;
}

function latestStatusMessage(messages: DesktopRoomMessage[]): string | null {
  const message = [...messages].reverse().find((entry) => /^\[status\]\s*/i.test(entry.text || ""));
  return message ? message.text.replace(/^\[status\]\s*/i, "").trim() : null;
}

function sourceBadges(participant: ActivityParticipant): Array<{ label: string; active: boolean }> {
  const sources = new Set(participant.sources);
  return [
    { label: "Delivery", active: sources.has("delivery") || sources.has("desktop delivery") },
    { label: "Presence", active: sources.has("presence") },
    { label: "Session", active: sources.has("session liveness") },
    { label: "Messages", active: sources.has("messages") },
    { label: "Tasks", active: sources.has("tasks") },
    { label: "Local app", active: sources.has("local worker") },
  ];
}

function activityIconPath(icon: ActivityIcon): string {
  const paths: Record<ActivityIcon, string> = {
    radio: "M4.93 19.07a10 10 0 0 1 0-14.14M8.46 15.54a5 5 0 0 1 0-7.08M12 12h.01M15.54 8.46a5 5 0 0 1 0 7.08M19.07 4.93a10 10 0 0 1 0 14.14",
    pulse: "M3 12h4l2-7 4 14 2-7h6",
    power: "M12 2v10M18.36 5.64a9 9 0 1 1-12.72 0",
    user: "M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
    brain: "M9.5 3a3 3 0 0 0-3 3v.5A3.5 3.5 0 0 0 3 10v1a3 3 0 0 0 3 3h.5V9M14.5 3a3 3 0 0 1 3 3v.5A3.5 3.5 0 0 1 21 10v1a3 3 0 0 1-3 3h-.5V9M8 17a4 4 0 0 0 8 0",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
    task: "M9 11l2 2 4-4M4 5h16M4 19h16M4 12h2M18 12h2",
  };
  return paths[icon];
}

function livenessCapabilityLabel(value: string | null | undefined): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "session_activity") return "Session activity";
  if (normalized === "process_observed") return "Process observed";
  if (normalized === "tool_bridge_only") return "Tool bridge";
  return "Liveness signal";
}

function mergeTasks(...taskLists: DesktopTaskSummary[][]): DesktopTaskSummary[] {
  const merged = new Map<string, DesktopTaskSummary>();
  for (const task of taskLists.flat()) {
    merged.set(task.id, task);
  }
  return sortTasksByUpdated([...merged.values()]);
}

function activityTasksToDesktopTasks(tasks: DesktopActivityEntry["currentTasks"]): DesktopTaskSummary[] {
  return tasks.map((task) => ({
    ...task,
    description: null,
    assignee: null,
    assigneeAgentKey: null,
    createdBy: null,
    prUrl: null,
    workflowArtifacts: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: null,
    updatedAt: task.updatedAt || "",
  }));
}

function connectionLabel(participant: ActivityParticipant): string {
  if (participant.kind === "human") return "human";
  if (participant.activityState === "active") return "connected";
  if (participant.activityState === "away") return "idle";
  if (hasAgentSignal(participant)) return "signal only";
  return "offline";
}

function participantSubtitle(participant: ActivityParticipant): string {
  if (participant.kind === "human") return "Seen through room messages and tasks.";
  if (participant.activityState === "active" || participant.activityState === "away") return "Can receive room messages now.";
  if (hasAgentSignal(participant)) return "Session or work signals are updating, but message delivery is not reachable.";
  if (participant.activityState === "offline") return "Delivery session is no longer reachable.";
  return "No current delivery or session signal.";
}

function taskStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function reasoningStatus(session: DesktopReasoningSession): string {
  return session.closedAt ? "Closed" : taskStatusLabel(session.status || "active");
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

</script>
