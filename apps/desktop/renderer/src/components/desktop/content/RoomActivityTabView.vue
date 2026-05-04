<template>
  <section class="room-tab-page room-activity-page" data-testid="room-activity-tab-view">
    <div class="desktop-activity-summary">
      <article v-for="card in summaryCards" :key="card.label" class="desktop-activity-stat">
        <strong>{{ card.value }}</strong>
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
              <small>{{ formatRelative(agent.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!reachableAgents.length" class="desktop-activity-empty">No reachable worker sessions right now.</article>
        </section>

        <section class="desktop-activity-group">
          <header>
            <div>
              <h3>Work signals</h3>
              <p>Status, leases, and reasoning streams exposed by active agents.</p>
            </div>
            <strong>{{ workSignalAgents.length }}</strong>
          </header>

          <button
            v-for="agent in workSignalAgents"
            :key="agent.key"
            class="desktop-activity-roster-item"
            :data-selected="selectedLiveParticipant?.key === agent.key"
            :data-state="agent.workState || agent.activityState || 'offline'"
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
              <small>{{ agent.workLabel || "Working" }}<template v-if="agent.statusText"> · {{ agent.statusText }}</template></small>
            </span>
            <span class="desktop-activity-row-meta">
              <span v-if="agent.activeReasoning.length" class="desktop-activity-mini-pill">{{ agent.activeReasoning.length }} reasoning</span>
              <small>{{ formatRelative(agent.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!workSignalAgents.length" class="desktop-activity-empty">No active work signals are exposed yet.</article>
        </section>

        <section class="desktop-activity-group">
          <header>
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
              <small>{{ formatRelative(agent.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!disconnectedAgents.length" class="desktop-activity-empty">
            {{ liveClearedCount > 0 ? "Disconnected agents were cleared from the live roster." : "No recently disconnected agents." }}
          </article>
        </section>

        <section class="desktop-activity-group">
          <header>
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
              <small>{{ formatRelative(human.lastSeenAt) }}</small>
            </span>
          </button>

          <article v-if="!humans.length" class="desktop-activity-empty">No human room activity has been seen yet.</article>
        </section>
      </div>

      <aside v-if="selectedLiveParticipant" class="desktop-activity-detail" :data-kind="selectedLiveParticipant.kind">
        <div class="desktop-activity-detail-header">
          <div>
            <span>{{ selectedLiveParticipant.kind === "agent" ? "Agent liveness" : "Human activity" }}</span>
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
            <strong>{{ selectedLiveParticipant.activeReasoning.length }}</strong>
            <span>Reasoning</span>
          </article>
          <article>
            <strong>{{ formatRelative(selectedLiveParticipant.lastSeenAt) }}</strong>
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
              observed this session {{ formatRelative(selectedLiveParticipant.livenessObservation.lastObservedAt) }}.
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
            <span>{{ reasoningStatus(session) }} · {{ formatRelative(session.updatedAt || session.createdAt) }}</span>
          </article>
          <p v-if="!selectedLiveParticipant.activeReasoning.length" class="desktop-activity-muted">No active reasoning stream exposed right now.</p>
        </section>
      </aside>
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
              <small>{{ formatRelative(entry.lastRoomActivityAt) }}</small>
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
              · last active {{ formatRelative(selectedHistoryEntry.lastRoomActivityAt) }}
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
            <strong>{{ formatRelative(selectedHistoryEntry.firstSeenAt) }}</strong>
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

type ActivityState = "active" | "away" | "offline";
type ParticipantKind = "agent" | "human";

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

const activeView = ref<"live" | "history">("live");
const selectedLiveKey = ref<string | null>(null);
const selectedHistoryKey = ref<string | null>(null);

const openTaskStatuses = new Set(["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review"]);
const completedTaskStatuses = new Set(["merged", "done"]);
const inactiveReasoningStatuses = new Set(["completed", "done", "dismissed", "closed"]);

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

const liveParticipants = computed(() => {
  const agents = new Map<string, ActivityParticipant>();

  for (const presence of props.presence) {
    if (presence.sessionKind !== "worker") continue;
    if (!presence.sourceFlags.includes("delivery")) continue;
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
  liveParticipants.value.filter((participant) => participant.kind === "agent" && participant.activityState === "offline")
);
const workSignalAgents = computed(() =>
  reachableAgents.value.filter((participant) =>
    participant.workState || participant.currentTasks.length || participant.activeReasoning.length
  )
);
const humans = computed(() => liveParticipants.value.filter((participant) => participant.kind === "human"));
const selectedLiveParticipant = computed(() =>
  liveParticipants.value.find((participant) => participant.key === selectedLiveKey.value) || liveParticipants.value[0] || null
);
const selectedHistoryEntry = computed(() =>
  props.recentActivity.find((entry) => entry.id === selectedHistoryKey.value) || props.recentActivity[0] || null
);

const summaryCards = computed(() => activeView.value === "live"
  ? [
      { value: reachableAgents.value.length, label: "Reachable agents" },
      { value: workSignalAgents.value.length, label: "Work signals" },
      { value: disconnectedAgents.value.length, label: "Disconnected" },
      { value: humans.value.length, label: "Humans seen" },
      { value: activeReasoningSessions.value.length, label: "Reasoning streams" },
    ]
  : [
      { value: props.recentActivity.filter((entry) => entry.participantKind === "agent").length, label: "Agents in history" },
      { value: props.recentActivity.filter((entry) => entry.participantKind === "human").length, label: "Humans in history" },
      { value: props.recentActivity.reduce((total, entry) => total + entry.currentTasks.length, 0), label: "Open tasks linked" },
      { value: props.recentActivity.reduce((total, entry) => total + entry.completedTasks.length, 0), label: "Completed tasks" },
    ]);
const activeReasoningSessions = computed(() =>
  liveParticipants.value.flatMap((participant) => participant.activeReasoning)
);
const liveClearedCount = computed(() => props.liveClearedCount || 0);
const toolbarNote = computed(() => activeView.value === "live"
  ? liveClearedCount.value > 0
    ? `${liveClearedCount.value} cleared from the live roster.`
    : "Desktop adds delivery heartbeats, worker reachability, and local app signals on top of room history."
  : "History is the shared web-compatible room record.");

watch(liveParticipants, (next) => {
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
  const currentTasks = sortTasks(assignedTasks.filter((task) => openTaskStatuses.has(task.status)));
  const completedTasks = sortTasks(assignedTasks.filter((task) => completedTaskStatuses.has(task.status))).slice(0, 6);
  const statusText = presence?.statusText || latestStatusMessage(messages) || null;
  const activityState = resolveActivityState(participant, presence);
  const workSignal = workSignalFrom(presence, statusText, currentTasks.length, activeReasoning.length);

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
    statusText: activityState === "offline" ? null : statusText,
    livenessObservation: presence?.livenessObservation || null,
    workState: workSignal?.state || null,
    workLabel: workSignal?.label || null,
    lastSeenAt: latestTimestamp(
      participant?.lastLiveHeartbeatAt,
      presence?.lastHeartbeatAt,
      participant?.lastRoomActivityAt,
      participant?.lastSeenAt,
      messages.at(-1)?.timestamp,
      activeReasoning[0]?.updatedAt,
      currentTasks[0]?.updatedAt
    ),
    messageCount: messages.length,
    currentTasks,
    completedTasks,
    activeReasoning,
    sources: [
      ...(presence?.sourceFlags || []),
      ...(participant?.sourceFlags || []),
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
    currentTasks: sortTasks(assignedTasks.filter((task) => openTaskStatuses.has(task.status))),
    completedTasks: sortTasks(assignedTasks.filter((task) => completedTaskStatuses.has(task.status))).slice(0, 6),
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

function isReachablePresence(presence: DesktopAgentPresence): boolean {
  return presence.sessionKind === "worker" && presence.sourceFlags.includes("delivery") && presence.freshness === "active";
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

function livenessCapabilityLabel(value: string | null | undefined): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "session_activity") return "Session activity";
  if (normalized === "process_observed") return "Process observed";
  if (normalized === "tool_bridge_only") return "Tool bridge";
  return "Liveness signal";
}

function sortTasks(tasks: DesktopTaskSummary[]): DesktopTaskSummary[] {
  return [...tasks].sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  return values.reduce<string | null>((best, value) => timestampValue(value) > timestampValue(best) ? value || null : best, null);
}

function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : -1;
}

function formatRelative(value: string | null | undefined): string {
  const time = timestampValue(value);
  if (time < 0) return "unknown";
  const diffMinutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.round(diffHours / 24)}d ago`;
}

function connectionLabel(participant: ActivityParticipant): string {
  if (participant.kind === "human") return "human";
  if (participant.activityState === "active") return "connected";
  if (participant.activityState === "away") return "idle";
  return "offline";
}

function participantSubtitle(participant: ActivityParticipant): string {
  if (participant.kind === "human") return "Seen through room messages and tasks.";
  if (participant.activityState === "offline") return "Delivery session is no longer reachable.";
  return "Can receive room messages now.";
}

function taskStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function reasoningTitle(session: DesktopReasoningSession): string {
  return session.title || session.summary || session.goal || "Reasoning stream";
}

function reasoningSummary(session: DesktopReasoningSession): string {
  return session.latestPayload?.checking
    || session.latestPayload?.next_action
    || session.latestPayload?.hypothesis
    || session.checking
    || session.nextAction
    || session.hypothesis
    || session.summary
    || "No summary published yet.";
}

function reasoningStatus(session: DesktopReasoningSession): string {
  return session.closedAt ? "Closed" : taskStatusLabel(session.status || "active");
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function displayNameFromActor(actorLabel: string): string {
  const parts = String(actorLabel || "").split("|").map((part) => part.trim()).filter(Boolean);
  return parts[0] || actorLabel || "Agent";
}

function ownerFromActor(actorLabel: string): string | null {
  const parts = String(actorLabel || "").split("|").map((part) => part.trim()).filter(Boolean);
  return parts[1]?.replace(/'s agent$/i, "") || null;
}

function ideFromActor(actorLabel: string): string | null {
  const parts = String(actorLabel || "").split("|").map((part) => part.trim()).filter(Boolean);
  return parts[2] || null;
}
</script>
