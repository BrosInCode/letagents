<template>
  <section ref="surface" class="room-tab-page room-agents-page agents-ui" data-testid="room-activity-tab-view">
    <div v-show="activeView === 'live'">
      <header class="agents-heading"><h2>Agents</h2><button class="agents-primary" type="button" data-testid="desktop-activity-add-agent" @click="emit('open-add-agent')">+ Add agent</button></header>
      <AgentRoster :rows="rosterRows" @select="selectRosterAgent">
        <template #provider="{ row }"><ProviderBadge :label="row.provider" :agent-key="nativeById.get(row.id)?.agentKey" /></template>
        <template #detail="{ row }"><WakeRuleLine v-if="waitingRules(rosterAgentKey(row.id)).length && row.state === 'Online'" :rules="waitingRules(rosterAgentKey(row.id))" /><template v-else>{{ row.detail }}</template></template>
        <template #badges="{ row }"><template v-for="agent in nativeById.has(row.id) ? [nativeById.get(row.id)!] : []" :key="agent.entryId">
          <span v-if="agent.entry.homeHarness" class="desktop-activity-mini-pill" :title="homeHarnessBadge(agent.provider, agent.entry.homeHarness).title" data-testid="desktop-activity-own-setup">{{ homeHarnessBadge(agent.provider, agent.entry.homeHarness).label }}</span>
          <span v-if="agent.entry.permissionPending" class="desktop-activity-mini-pill" :title="permissionPendingBadge(agent.entry.deliveryMode).title" data-testid="desktop-activity-settings-pending">{{ permissionPendingBadge().label }}</span>
        </template></template>
        <template #action="{ row }"><button v-if="nativeById.get(row.id) && canCorrect(nativeById.get(row.id)!)" class="agents-quiet agents-correct" type="button" :aria-label="`Correct ${row.name}'s current turn`" title="Interrupt this turn and redirect the agent in the same session. Room messages wait until the turn ends." data-testid="desktop-activity-correct-agent" @click="correctAgent(nativeById.get(row.id)!)">Correct</button></template>
        <template #empty><button class="agents-quiet" type="button" @click="refreshActivity">Refresh</button></template>
      </AgentRoster>
      <footer class="agents-footer"><button ref="pastButton" class="agents-quiet" type="button" @click="archiveMode = 'past'; navigate('history', $event)">Past agents →</button></footer>
    </div>
    <AgentHistory v-if="activeView === 'history'" v-model:mode="archiveMode" v-model:tab="archiveTab" v-model:query="historyQuery" :people="historyPeople" :work="historyWork" @back="navigate('live', $event)">
      <template #provider="{ person }"><ProviderBadge v-if="person.kind === 'agent'" :label="person.provider" /><span v-else>{{ person.name.slice(0,1) }}</span></template>
      <template #status><p v-if="roomAgentWorkStatus === 'loading'" class="agents-note" role="status">Loading saved work…</p><p v-else-if="roomAgentWorkStatus === 'error'" class="agents-note" role="status">Saved work is temporarily unavailable. <button class="agents-quiet" type="button" @click="refreshActivity">Retry</button></p><p v-else-if="roomAgentWorkStatus === 'stale'" class="agents-note">Showing saved work while updates reconnect.</p></template>
      <template #work-detail="{ record }"><template v-if="recordedWorkById.get(record.id)"><ContributionDescription :work="recordedWorkById.get(record.id)!" /><p v-if="recordedWorkEvidenceIncomplete(recordedWorkById.get(record.id)!)" class="agents-note">Some work details weren't recorded.</p><button class="agents-quiet" type="button" @click="emit('reveal-message', recordedWorkById.get(record.id)!.sourceMessageId)">View in room →</button></template></template>
      <template #changes="{ query }"><p v-if="artifactTaskFilterId" class="agents-filter-note">{{ artifactTimelineDescription }} <button class="agents-quiet" type="button" @click="emit('clear-artifact-task-filter')">Show all</button></p><div class="agents-changes" :data-query="query">          <ol v-if="filteredArtifacts(query).length" class="desktop-activity-artifact-timeline">
            <li
              v-for="item in filteredArtifacts(query)"
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
            {{ query.trim() ? 'No matching changes.' : artifactTaskFilterId ? 'No changes or pull requests are linked to this task yet.' : 'No changes or pull requests have been shared yet.' }}
          </article></div></template>
      <template #footer><span>{{ roomAgentWorkTruncated ? 'Showing the latest 50 saved work records.' : 'Saved in this room' }}<template v-if="recentActivity.length >= 50"> · Latest 50 participants</template></span><button class="agents-quiet" type="button" @click="refreshActivity">Refresh history</button></template>
    </AgentHistory>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from "vue";
import AgentRoster from "../../../../../../../shared/ui/agents/AgentRoster.vue";
import AgentHistory from "../../../../../../../shared/ui/agents/AgentHistory.vue";
import { mergeHistoryWork, type AgentRosterRow, type AgentHistoryPerson } from "../../../../../../../shared/ui/agents/types";
import { useAgentsNavigation } from "../../../../../../../shared/ui/agents/useAgentsNavigation";
import ProviderBadge from "./desktop-chat-message/ProviderBadge.vue";
import { agentInspectorSignal, agentInspectorProviderLabel } from "../../../domain/agent-inspector-presentation";

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
  type AgentInspectorProjection,
} from "../../../domain/agent-inspector";
import { activityParticipantToAgentTarget, ownerAttribution } from "./room-activity/agentTarget";
import {
  participantAgentInspectorRequest,
  supervisedAgentInspectorRequest,
} from "../../../domain/agent-inspector-identity";
import { managedAgentRoomBranchMismatchLabel } from "../../../domain/managed-agents";
import { homeHarnessBadge } from "../../../domain/agent-home-harness";
import { permissionPendingBadge } from "../../../domain/agent-inspector-settings";
import { isProjectedSupervisedActivityParticipant, supervisedActivityIdentity } from "../../../domain/room-agent-delivery";
import {
  findLinkedPullRequest,
  retainExpandableChangeArtifacts,
  roomArtifactTimelineItems,
} from "../../../domain/room-artifacts";
import ContributionDescription from "./room-chat/ContributionDescription.vue";
import { readableContributionText } from "../../../../../../../shared/contribution-text.mjs";
import ChangeSummaryFilePanel from "./room-activity/ChangeSummaryFilePanel.vue";
import { useRoomActivityViewModel } from "./room-activity/useRoomActivityViewModel";
import WakeRuleLine from "../../../../../../../shared/ui/WakeRuleLine.vue";
import { injectRoomWakeRules } from "../../../composables/useRoomWakeRules";
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
  "open-agent-correction": [entryId: string];
  "refresh-room": [];
  "reveal-message": [messageId: string];
  "clear-artifact-task-filter": [];
}>();

function recordedAgentName(agentKey: string): string {
  return props.supervisorEntries.find(entry => entry.agentKey === agentKey)?.displayName
    || props.presence.find(entry => entry.agentKey === agentKey)?.displayName
    || props.participants.find(entry => entry.agentKey === agentKey)?.displayName
    || props.recentActivity.find(entry => entry.participantAgentKey === agentKey)?.participantDisplayName
    || agentKey.split("/").at(-1) || "Agent";
}

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

const { activeView, selectedLiveKey, reachableAgents, workingAgents, formatRelativeTime } = useRoomActivityViewModel(props, { autoSelectLive: false });
const surface = ref<HTMLElement>();
const { navigate, pastButton } = useAgentsNavigation(activeView, surface);
const archiveMode = ref<'past' | 'history'>('past');
const historyQuery = ref('');
const archiveTab = ref<'Work' | 'Changes' | 'People'>('Work');

const wakeRules = injectRoomWakeRules();
const NO_RULES: never[] = [];
/** What an agent is waiting for; a quiet agent with rules is waiting, not stuck. */
function waitingRules(agentKey: string | null | undefined) {
  return (agentKey && wakeRules?.activeByAgentKey.value.get(agentKey)) || NO_RULES;
}

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
const nativeById = computed(() => new Map(inspectorTruthfulAgents.value.map(agent => [agent.entryId, agent])));
const legacyAgents = computed(() => [...legacyReachableAgents.value, ...legacyWorkingAgents.value]);
const rosterRows = computed<AgentRosterRow[]>(() => [
  ...inspectorTruthfulAgents.value.map(agent => {
    const signal = agentInspectorSignal(agent);
    return { id: agent.entryId, name: agent.displayName, provider: agentInspectorProviderLabel(agent.provider), model: agent.model, owner: agent.entry.createdBy || '', state: signal.label, detail: signal.detail, tone: signal.tone, working: ['responding', 'publishing', 'compacting'].includes(signal.state), attention: signal.state === 'needs_attention', moving: signal.moving };
  }),
  ...legacyAgents.value.map(agent => {
    const stale = agent.freshness === 'stale';
    const reachable = !stale && (agent.activityState === 'active' || agent.activityState === 'away');
    const working = reachable && (agent.status === 'working' || agent.status === 'reviewing');
    const attention = reachable && agent.status === 'blocked';
    return { id: agent.key, name: agent.label, provider: agent.ideLabel || agent.runtime || 'Agent', owner: agent.ownerLabel || '', state: stale ? 'Updates delayed' : attention ? 'Needs attention' : working ? 'Working' : reachable ? 'Online' : 'Offline', detail: stale ? 'Waiting for a fresh update from the host.' : agent.statusText || branchLabel(agent) || (reachable ? 'Ready for room work.' : 'Last shared update'), tone: stale || attention ? 'amber' as const : working ? 'blue' as const : reachable ? 'green' as const : 'neutral' as const, working, attention, moving: working };
  }),
]);
function rosterAgentKey(id: string) { return nativeById.value.get(id)?.agentKey || legacyAgents.value.find(agent => agent.key === id)?.agentKey; }
function selectRosterAgent(id: string) {
  const native = nativeById.value.get(id);
  if (native) selectInspectorAgent(native);
  else { const legacy = legacyAgents.value.find(agent => agent.key === id); if (legacy) selectParticipantAgent(legacy); }
}
const historyPeople = computed<AgentHistoryPerson[]>(() => props.recentActivity.map(entry => ({
  id: entry.id, name: entry.participantDisplayName, kind: entry.participantKind, provider: entry.participantIdeLabel || 'Agent', owner: entry.participantOwnerLabel || '', room: entry.room?.displayName || 'This room', branch: entry.repoBranch, firstSeen: entry.firstSeenAt, lastSeen: entry.lastRoomActivityAt,
  past: entry.activityState !== 'active' && entry.activityState !== 'away',
})));
const recordedWorkById = computed(() => new Map(props.roomAgentWork.map(work => [`record:${work.attemptId}:${work.agentKey}`, work])));
const historyWork = computed(() => mergeHistoryWork([
  ...props.recentActivity.flatMap(entry => [...entry.currentTasks, ...entry.completedTasks, ...entry.createdTasks].map(task => ({ id: `task:${task.id}`, title: task.title, people: [entry.id], byline: entry.participantDisplayName, state: task.status.replaceAll('_', ' '), time: task.updatedAt, links: task.workflowRefs }))),
  ...props.roomAgentWork.map(work => {
    const actor = props.presence.find(agent => agent.agentKey === work.agentKey)?.actorLabel || props.participants.find(agent => agent.agentKey === work.agentKey)?.actorLabel;
    return { id: `record:${work.attemptId}:${work.agentKey}`, title: recordedWorkTitle(work), people: props.recentActivity.filter(entry => entry.participantAgentKey === work.agentKey || (Boolean(actor) && entry.participantActorLabel === actor)).map(entry => entry.id), byline: recordedAgentName(work.agentKey), state: recordedWorkStateLabel(work), time: work.updatedAt, detail: recordedWorkDetail(work), links: [] };
  }),
]));
function filteredArtifacts(query: string) { return artifactTimeline.value.filter(item => `${item.title} ${item.metaLabel}`.toLowerCase().includes(query.trim().toLowerCase())); }
function selectInspectorAgent(agent: AgentInspectorProjection): void {
  selectedLiveKey.value = null;
  emit("open-agent-detail", supervisedAgentInspectorRequest(agent.entry, {
    ownerAttribution: ownerAttribution(agent.entry.createdBy),
  }));
}

/** A busy agent's live turn can take a correction now; a room message would wait. */
function canCorrect(agent: AgentInspectorProjection): boolean {
  return agent.turnControl?.status === "ready" && agent.turnControl.canCorrect;
}

function correctAgent(agent: AgentInspectorProjection): void {
  selectedLiveKey.value = null;
  emit("open-agent-correction", agent.entryId);
}

function selectParticipantAgent(agent: Parameters<typeof activityParticipantToAgentTarget>[0]): void {
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
  if (request > 0) { archiveMode.value = "history"; archiveTab.value = "Changes"; activeView.value = "history"; }
}, { immediate: true });

function refreshActivity(): void {
  emit("refresh-room");
}

function recordedWorkTitle(work: DesktopRoomAgentWork): string {
  const summary = readableContributionText('contribution' in work.summary ? work.summary.contribution?.summary : null);
  return summary?.split('\n').find(line => line.trim())?.replace(/^#{1,6}\s*/, '').slice(0, 120) || 'Room work';
}

function recordedWorkEvidenceIncomplete(work: DesktopRoomAgentWork): boolean {
  return !("availability" in work.summary) && work.summary.evidence_incomplete;
}

function recordedWorkStateLabel(work: DesktopRoomAgentWork): string {
  if ("availability" in work.summary) return "History cleared";
  return work.summary.recorded_state.replaceAll("_", " ");
}

function recordedWorkDetail(work: DesktopRoomAgentWork): string {
  if ("availability" in work.summary) return "The owner cleared this shared work history.";
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

<style scoped>
.room-agents-page { display: block; padding: 28px 32px; overflow-y: auto; min-height: 0; }
.agents-correct { display: flex; margin: -10px 32px 10px auto; }
.agents-changes { padding: 0 12px; }
.agents-ui :deep(.desktop-activity-mini-pill) { padding: 0; background: none; min-height: 20px; margin-right: 10px; font-size: 10px; font-weight: 400; color: var(--text-tertiary); }
.agents-ui :deep(.desktop-activity-artifact-marker) { box-shadow: none; }
.agents-ui :deep(.desktop-activity-artifact-marker::after) { display: none; }
.agents-ui :deep(.desktop-activity-artifact-event) { padding: 18px 0; border-top: 1px solid var(--agents-line); }
.agents-ui :deep(.desktop-activity-artifact-title-line strong), .agents-ui :deep(.desktop-activity-artifact-title-line a) { font-size: 14px; font-weight: 500; }
@media(max-width:640px) { .room-agents-page { padding: 22px 16px; } }
</style>
