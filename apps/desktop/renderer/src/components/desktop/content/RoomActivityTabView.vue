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

    <div v-if="activeView === 'live'" class="desktop-activity-layout" :data-empty="!hasLiveActivity">
      <article v-if="!hasLiveActivity" class="desktop-activity-live-empty">
        <span>Live activity</span>
        <h3>No agents are live right now</h3>
        <p>Agents you can message will appear here when they are online or working in this room.</p>
        <div class="desktop-activity-empty-actions">
          <button type="button" @click="emit('open-add-agent')">Add agent</button>
          <button type="button" @click="refreshActivity">Refresh</button>
        </div>
      </article>

      <template v-else>
        <div class="desktop-activity-groups">
          <section
            v-for="group in inspectorTruthfulGroups"
            :key="group.key"
            v-show="group.agents.length"
            class="desktop-activity-group"
            :data-room-agent-state="group.key"
          >
            <header><div><h3>{{ group.label }}</h3><p v-if="group.description">{{ group.description }}</p></div><strong>{{ group.agents.length }}</strong></header>
            <button
              v-for="agent in group.agents"
              :key="agent.entryId"
              class="desktop-activity-roster-item"
              :data-selected="selectedInspectorAgent?.entryId === agent.entryId"
              :data-state="group.key"
              type="button"
              @click="selectInspectorAgent(agent)"
            >
              <span class="desktop-activity-avatar" :data-state="group.key">{{ initials(agent.displayName) }}</span>
              <span>
                <strong>{{ agent.displayName }}</strong>
                <small v-if="agent.resourceFreshness === 'stale'">Waiting for fresh supervisor state.</small>
                <small v-else-if="agent.overallDetail">{{ agent.overallDetail }}</small>
              </span>
              <span class="desktop-activity-row-meta">
                <span class="state-pill" :data-state="group.key">
                  {{ group.key === "status_unavailable" ? "Status unavailable" : agent.overallLabel }}
                </span>
              </span>
            </button>
          </section>

          <section v-if="legacyReachableAgents.length" class="desktop-activity-group">
            <header>
              <div>
                <h3>Available now</h3>
                <p>Agents available for new room messages.</p>
              </div>
              <strong>{{ legacyReachableAgents.length }}</strong>
            </header>

            <button
              v-for="agent in legacyReachableAgents"
              :key="agent.key"
              class="desktop-activity-roster-item"
              :data-selected="selectedLiveKey === agent.key"
              :data-state="agent.activityState || 'offline'"
              type="button"
              @click="selectParticipantAgent(agent)"
            >
              <span class="desktop-activity-avatar" :data-state="agent.activityState || 'offline'">{{ initials(agent.label) }}</span>
              <span>
                <strong>{{ agent.label }}</strong>
                <small>{{ agent.statusText || branchLabel(agent) || agent.workLabel || agent.runtime || "Ready for room messages" }}</small>
              </span>
              <span class="desktop-activity-row-meta">
                <span class="state-pill" :data-state="agent.activityState || 'offline'">{{ connectionLabel(agent) }}</span>
                <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
              </span>
            </button>
          </section>

          <section v-if="legacyWorkingAgents.length" class="desktop-activity-group">
            <header>
              <div>
                <h3>Working</h3>
                <p>Recent task, status, or progress updates from agents at work.</p>
              </div>
              <strong>{{ legacyWorkingAgents.length }}</strong>
            </header>

            <button
              v-for="agent in legacyWorkingAgents"
              :key="agent.key"
              class="desktop-activity-roster-item"
              :data-selected="selectedLiveKey === agent.key"
              :data-state="agent.workState || 'working'"
              type="button"
              @click="selectParticipantAgent(agent)"
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
                <span class="desktop-activity-mini-pill">work update</span>
                <span v-if="agent.activeReasoning.length" class="desktop-activity-mini-pill">{{ agent.activeReasoning.length }} progress</span>
                <small>{{ formatRelativeTime(agent.lastSeenAt) }}</small>
              </span>
            </button>
          </section>
        </div>
      </template>
    </div>

    <div v-else class="desktop-activity-layout">
      <div class="desktop-activity-groups">
        <section
          v-if="roomAgentWorkStatus !== 'unavailable' && (roomAgentWorkStatus !== 'idle' || roomAgentWork.length)"
          class="desktop-activity-group"
          data-testid="desktop-recorded-room-work"
        >
          <header>
            <div>
              <h3>Recorded work</h3>
              <p>
                Retained structural outcomes — not live status.
                <template v-if="roomAgentWorkTruncated"> Showing the latest 50 records.</template>
              </p>
            </div>
            <span class="desktop-activity-artifact-header-actions">
              <span v-if="roomAgentWorkStatus === 'stale'" class="desktop-activity-mini-pill">Refresh pending</span>
              <strong>{{ roomAgentWork.length }}</strong>
            </span>
          </header>

          <button
            v-for="work in roomAgentWork"
            :key="`${work.attemptId}:${work.agentKey}`"
            class="desktop-activity-roster-item"
            data-state="recorded"
            type="button"
            @click="emit('reveal-message', work.sourceMessageId)"
          >
            <span class="desktop-activity-avatar" data-state="recorded">{{ initials(work.agentKey) }}</span>
            <span>
              <strong>{{ work.agentKey }}</strong>
              <small>{{ recordedWorkDetail(work) }}</small>
            </span>
            <span class="desktop-activity-row-meta">
              <span class="desktop-activity-mini-pill">{{ recordedWorkStateLabel(work) }}</span>
              <span
                v-if="recordedWorkEvidenceIncomplete(work)"
                class="desktop-activity-mini-pill"
              >
                Incomplete evidence
              </span>
              <small>{{ formatRelativeTime(work.updatedAt) }}</small>
            </span>
          </button>

          <article v-if="!roomAgentWork.length" class="desktop-activity-empty">
            <template v-if="roomAgentWorkStatus === 'loading'">Loading retained room work…</template>
            <template v-else-if="roomAgentWorkStatus === 'error'">Retained room work is temporarily unavailable.</template>
            <template v-else>No retained agent work has been published to this room yet.</template>
          </article>
        </section>

        <section v-if="artifactTimeline.length || artifactTaskFilterId" class="desktop-activity-group">
          <header>
            <div>
              <h3>{{ artifactTimelineTitle }}</h3>
              <p>{{ artifactTimelineDescription }}</p>
            </div>
            <span class="desktop-activity-artifact-header-actions">
              <button
                v-if="artifactTaskFilterId"
                type="button"
                @click="emit('clear-artifact-task-filter')"
              >
                Show all
              </button>
              <strong>{{ artifactTimeline.length }}</strong>
            </span>
          </header>

          <ol v-if="artifactTimeline.length" class="desktop-activity-artifact-timeline">
            <li
              v-for="item in artifactTimeline"
              :key="item.artifact.identityKey"
              class="desktop-activity-artifact-event"
            >
              <span class="desktop-activity-artifact-marker" :data-kind="item.artifact.kind" aria-hidden="true"></span>
              <div class="desktop-activity-artifact-content">
                <span class="desktop-activity-artifact-title-line">
                  <span class="desktop-activity-mini-pill">{{ item.kindLabel }}</span>
                  <a
                    v-if="item.artifact.url"
                    :href="item.artifact.url"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ item.title }}
                  </a>
                  <strong v-else>{{ item.title }}</strong>
                </span>
                <small v-if="item.metaLabel">{{ item.metaLabel }}</small>
                <small v-if="item.occurredAt">
                  {{ item.wasUpdated ? "Updated" : "First seen" }} {{ formatRelativeTime(item.occurredAt) }}
                  <template v-if="item.wasUpdated && item.firstSeenAt">
                    · first seen {{ formatRelativeTime(item.firstSeenAt) }}
                  </template>
                </small>
                <ChangeSummaryFilePanel
                  v-if="item.artifact.kind === 'change_summary' && item.artifact.detail"
                  :detail="item.artifact.detail"
                  :expanded="isChangeExpanded(item.artifact)"
                  :list-id="fileListId(item.artifact)"
                  :label="item.title"
                  :linked-pull-request="findLinkedPullRequest(item.artifact, roomArtifacts, changePrRepoScope)"
                  @toggle="toggleChange(item.artifact)"
                />
              </div>
              <span v-if="item.taskCountLabel" class="desktop-activity-row-meta">
                <span class="desktop-activity-mini-pill">{{ item.taskCountLabel }}</span>
              </span>
            </li>
          </ol>
          <article v-else class="desktop-activity-empty">
            No artifacts are linked to this task yet.
          </article>
        </section>

        <section class="desktop-activity-group">
          <header>
            <div>
              <h3>Room history</h3>
              <p>Participants ordered by latest activity in this room and related focus rooms.</p>
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
              <small>
                {{ entry.room?.displayName || "This room" }} · {{ entry.participantKind }}
                <template v-if="entry.repoBranch"> · branch {{ entry.repoBranch }}</template>
              </small>
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
              <template v-if="selectedHistoryEntry.repoBranch">
                · branch {{ selectedHistoryEntry.repoBranch }}
              </template>
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
import { computed, onMounted, ref, useId, watch } from "vue";
import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopGitRoomInfo,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomAgentWork,
  DesktopRoomMessage,
  DesktopRoomSharedArtifact,
  DesktopSupervisorManifestEntry,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import {
  agentInspectorActivityGroupState,
  type AgentInspectorActivityGroupState,
  type AgentInspectorProjection,
} from "../../../domain/agent-inspector";
import { activityParticipantToAgentTarget, ownerAttribution } from "./room-activity/agentTarget";
import {
  participantAgentInspectorRequest,
  supervisedAgentInspectorRequest,
} from "../../../domain/agent-inspector-identity";
import { managedAgentRoomBranchMismatchLabel } from "../../../domain/managed-agents";
import { isProjectedSupervisedActivityParticipant, supervisedActivityIdentity } from "../../../domain/room-agent-delivery";
import {
  findLinkedPullRequest,
  retainExpandableChangeArtifacts,
  roomArtifactTimelineItems,
} from "../../../domain/room-artifacts";
import ChangeSummaryFilePanel from "./room-activity/ChangeSummaryFilePanel.vue";
import { useRoomActivityViewModel } from "./room-activity/useRoomActivityViewModel";
import type { AgentInspectorRequest } from "./desktop-chat-message/types";

const props = defineProps<{
  recentActivity: DesktopActivityEntry[];
  participants: DesktopParticipantSummary[];
  liveClearedCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  roomGitRoom: DesktopGitRoomInfo | null;
  roomIdentifier: string | null;
  roomArtifacts: DesktopRoomSharedArtifact[];
  roomAgentWork: DesktopRoomAgentWork[];
  roomAgentWorkStatus: "idle" | "loading" | "ready" | "stale" | "error" | "unavailable";
  roomAgentWorkTruncated: boolean;
  activityHistoryRequest: number;
  artifactTaskFilterId: string | null;
  tasks: DesktopTaskSummary[];
  messages: DesktopRoomMessage[];
  workers: WorkerSnapshot[];
  supervisorEntries: DesktopSupervisorManifestEntry[];
  agentProjections: AgentInspectorProjection[];
}>();

const emit = defineEmits<{
  "open-reasoning": [sessionId: string];
  "open-add-agent": [];
  "open-agent-detail": [request: AgentInspectorRequest];
  "refresh-room": [];
  "reveal-message": [messageId: string];
  "clear-artifact-task-filter": [];
}>();

const expandedChangeArtifacts = ref<Set<string>>(new Set());
// Globally-unique, collision-safe DOM ids: an SSR-stable per-instance base
// (useId) plus a per-artifact counter keyed by the full unique identityKey —
// unique across multiple panels in one document.
const changePanelIdBase = useId();
const fileListIds = new Map<string, string>();
let fileListIdSeq = 0;

function isChangeExpanded(artifact: DesktopRoomSharedArtifact): boolean {
  return expandedChangeArtifacts.value.has(artifact.identityKey);
}
function toggleChange(artifact: DesktopRoomSharedArtifact): void {
  const next = new Set(expandedChangeArtifacts.value);
  if (next.has(artifact.identityKey)) next.delete(artifact.identityKey);
  else next.add(artifact.identityKey);
  expandedChangeArtifacts.value = next;
}
function fileListId(artifact: DesktopRoomSharedArtifact): string {
  let id = fileListIds.get(artifact.identityKey);
  if (!id) {
    id = `${changePanelIdBase}-change-files-${fileListIdSeq++}`;
    fileListIds.set(artifact.identityKey, id);
  }
  return id;
}

// Repository scope for PR linking — the room's known Git repo, or null (which
// suppresses linking) when the room isn't a single known repo.
const changePrRepoScope = computed(() =>
  props.roomGitRoom
    ? {
        host: props.roomGitRoom.host,
        owner: props.roomGitRoom.repository.owner,
        name: props.roomGitRoom.repository.name,
      }
    : null,
);

// Prune stale expansion when artifacts update, so a row that went clean (or
// dropped to <= the collapsed limit) never silently reopens expanded on return.
watch(
  () => props.roomArtifacts,
  (artifacts) => {
    const pruned = retainExpandableChangeArtifacts(expandedChangeArtifacts.value, artifacts);
    if (pruned.size !== expandedChangeArtifacts.value.size) {
      expandedChangeArtifacts.value = pruned;
    }
  },
);

const {
  activeView,
  selectedLiveKey,
  selectedHistoryKey,
  reachableAgents,
  workingAgents,
  selectedHistoryEntry,
  initials,
  connectionLabel,
  formatRelativeTime,
  signalLabel,
  taskStatusLabel,
} = useRoomActivityViewModel(props, { autoSelectLive: false });

const selectedTruthfulId = ref<string | null>(null);
const inspectorTruthfulAgents = computed(() =>
  props.agentProjections.filter((agent) => agent.overallState !== "retired"),
);
const projectedSupervisedIdentity = computed(() => supervisedActivityIdentity(
  props.agentProjections.map((agent) => agent.entry),
  props.roomIdentifier,
));
const isProjectedSupervisedAgent = (agent: Parameters<typeof isProjectedSupervisedActivityParticipant>[1]) => isProjectedSupervisedActivityParticipant(
  projectedSupervisedIdentity.value,
  agent,
);
const legacyReachableAgents = computed(() => reachableAgents.value.filter((agent) => !isProjectedSupervisedAgent(agent)));
const legacyWorkingAgents = computed(() => workingAgents.value.filter((agent) => !isProjectedSupervisedAgent(agent)));
const hasLiveActivity = computed(() => Boolean(
  inspectorTruthfulAgents.value.length
    || legacyReachableAgents.value.length
    || legacyWorkingAgents.value.length,
));
const inspectorTruthfulGroups = computed(() => {
  const groups: Array<{
    key: AgentInspectorActivityGroupState;
    label: string;
    description: string | null;
    agents: AgentInspectorProjection[];
  }> = [
    { key: "online", label: "Online", description: null, agents: [] as AgentInspectorProjection[] },
    { key: "responding", label: "Responding", description: "A bounded room turn is in progress.", agents: [] as AgentInspectorProjection[] },
    { key: "restoring_conversation", label: "Restoring conversation", description: "Recovering a missing private conversation without restarting the provider.", agents: [] as AgentInspectorProjection[] },
    { key: "recovering", label: "Recovering agent", description: "Restoring room access for the running provider.", agents: [] as AgentInspectorProjection[] },
    { key: "reconnecting", label: "Reconnecting", description: "Restoring the room observation path.", agents: [] as AgentInspectorProjection[] },
    { key: "needs_attention", label: "Needs attention", description: "A runtime or delivery step needs your input.", agents: [] as AgentInspectorProjection[] },
    { key: "starting", label: "Starting", description: "Preparing the provider and room observation path.", agents: [] as AgentInspectorProjection[] },
    { key: "paused", label: "Paused", description: "Room work is held until the agent resumes.", agents: [] as AgentInspectorProjection[] },
    { key: "disconnected", label: "Disconnected", description: "The provider is not currently reachable.", agents: [] as AgentInspectorProjection[] },
    { key: "status_unavailable", label: "Status unavailable", description: "Waiting for fresh supervisor state.", agents: [] as AgentInspectorProjection[] },
  ];
  for (const agent of inspectorTruthfulAgents.value) {
    const groupState = agentInspectorActivityGroupState(agent);
    const group = groups.find((candidate) => candidate.key === groupState);
    if (group) group.agents.push(agent);
  }
  return groups;
});
const selectedInspectorAgent = computed(() => inspectorTruthfulAgents.value.find((agent) => agent.entryId === selectedTruthfulId.value) || null);
watch(inspectorTruthfulAgents, (agents) => {
  if (selectedTruthfulId.value && !agents.some((agent) => agent.entryId === selectedTruthfulId.value)) {
    selectedTruthfulId.value = null;
  }
});
function selectInspectorAgent(agent: AgentInspectorProjection): void {
  selectedLiveKey.value = null;
  selectedTruthfulId.value = agent.entryId;
  emit("open-agent-detail", supervisedAgentInspectorRequest(agent.entry, {
    ownerAttribution: ownerAttribution(agent.entry.createdBy),
  }));
}

function selectParticipantAgent(agent: Parameters<typeof activityParticipantToAgentTarget>[0]): void {
  selectedTruthfulId.value = null;
  selectedLiveKey.value = agent.key;
  emit("open-agent-detail", participantAgentInspectorRequest(activityParticipantToAgentTarget(agent)));
}
const artifactTimeline = computed(() =>
  roomArtifactTimelineItems(props.roomArtifacts, {
    taskId: props.artifactTaskFilterId,
  })
);
const artifactFilterTask = computed(() =>
  props.artifactTaskFilterId
    ? props.tasks.find((task) => task.id === props.artifactTaskFilterId) || null
    : null
);
const artifactTimelineTitle = computed(() =>
  props.artifactTaskFilterId ? "Task artifact timeline" : "Artifact timeline"
);
const artifactTimelineDescription = computed(() => {
  if (!props.artifactTaskFilterId) {
    return "Workflow objects ordered by latest room activity.";
  }
  const task = artifactFilterTask.value;
  return task
    ? `Artifacts linked to ${task.title}.`
    : `Artifacts linked to ${props.artifactTaskFilterId}.`;
});

watch(() => props.activityHistoryRequest, (request) => {
  if (request > 0) activeView.value = "history";
}, { immediate: true });

function refreshActivity(): void {
  emit("refresh-room");
}

function recordedWorkEvidenceIncomplete(work: DesktopRoomAgentWork): boolean {
  return !("availability" in work.summary) && work.summary.evidence_incomplete;
}

function recordedWorkStateLabel(work: DesktopRoomAgentWork): string {
  if ("availability" in work.summary) return "History cleared";
  return work.summary.recorded_state.replaceAll("_", " ");
}

function recordedWorkDetail(work: DesktopRoomAgentWork): string {
  if ("availability" in work.summary) return "Public structural history was cleared by its owner.";
  const counts = work.summary.operation_counts;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const parts = [`${total} recorded ${total === 1 ? "operation" : "operations"}`];
  if (counts.unresolved) parts.push(`${counts.unresolved} unresolved`);
  if (counts.succeeded) parts.push(`${counts.succeeded} succeeded`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.denied_before_start) parts.push(`${counts.denied_before_start} denied before start`);
  if (counts.cancelled_before_start) parts.push(`${counts.cancelled_before_start} cancelled before start`);
  if (counts.interrupted_after_start) parts.push(`${counts.interrupted_after_start} interrupted after start`);
  if (counts.lost_after_start) parts.push(`${counts.lost_after_start} lost after start`);
  if (work.summary.elapsed_ms !== null) parts.push(formatRecordedElapsed(work.summary.elapsed_ms));
  return parts.join(" · ");
}

function formatRecordedElapsed(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${elapsedMs}ms recorded`;
  const seconds = elapsedMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s recorded`;
}

function branchLabel(participant: Parameters<typeof activityParticipantToAgentTarget>[0]): string | null {
  const mismatch = roomBranchMismatchLabel(participant);
  if (mismatch) return mismatch;
  return participant.repoBranch ? `Branch ${participant.repoBranch}` : null;
}

function roomBranchMismatchLabel(participant: { repoBranch: string | null }): string | null {
  return managedAgentRoomBranchMismatchLabel(participant, props.roomGitRoom);
}

onMounted(refreshActivity);
</script>
