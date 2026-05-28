import { computed, ref, watch } from "vue";
import type {
  DesktopActivityEntry,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import { normalizeAgentKey } from "../../../../domain/agents";
import { reasoningStatus, reasoningSummary, reasoningTitle } from "../../../../domain/reasoning";
import { formatRelativeTime, timestampValue } from "../../../../domain/time";
import {
  activityEntryForAgent,
  buildAgentParticipant,
  buildHumanParticipant,
} from "./participantBuilders";
import { activityIconPath } from "./icons";
import {
  connectionLabel,
  hasAgentSignal,
  hasDeliverySignal,
  hasRecentLivenessObservation,
  isReachableParticipant,
  isReachablePresence,
  participantSubtitle,
  signalLabel,
  sourceBadges,
} from "./signals";
import { initials, livenessCapabilityLabel, taskStatusLabel } from "./formatters";
import { isHumanMessage } from "./matching";
import type {
  ActivityParticipant,
  ActivitySummaryCard,
  RoomActivityViewModelInput,
} from "./types";

export type { RoomActivityViewModelInput } from "./types";

export function useRoomActivityViewModel(props: RoomActivityViewModelInput) {
  const activeView = ref<"live" | "history">("live");
  const selectedLiveKey = ref<string | null>(null);
  const selectedHistoryKey = ref<string | null>(null);

  const hiddenAgentActors = computed(() => new Set(
    props.participants
      .filter((participant) => participant.kind === "agent" && participant.hiddenAt && participant.actorLabel)
      .map((participant) => participant.actorLabel as string),
  ));
  const participantsByActor = computed(() => new Map(
    props.participants
      .filter((participant) => participant.kind === "agent" && !participant.hiddenAt && participant.actorLabel)
      .map((participant) => [participant.actorLabel as string, participant]),
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
      const activityEntry = activityEntryForAgent(
        presence.actorLabel,
        participant?.displayName || presence.displayName || null,
        activityEntriesByActor.value,
        normalizeAgentKey,
      );
      agents.set(key, buildAgentParticipant({
        key,
        actorLabel: presence.actorLabel,
        participant,
        presence,
        messages: agentMessagesByActor.value.get(presence.actorLabel) || [],
        reasoningSessions: props.reasoningSessions,
        tasks: props.tasks,
        workers: props.workers,
        activityEntry,
      }));
    }

    return [
      ...[...agents.values()].sort(compareActivityParticipants),
      ...props.participants
        .filter((participant) => participant.kind === "human" && !participant.hiddenAt)
        .map((participant) => buildHumanParticipant(participant, props.messages, props.tasks))
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

  const activeReasoningSessions = computed(() =>
    liveParticipants.value.flatMap((participant) => participant.activeReasoning)
  );
  const liveClearedCount = computed(() => props.liveClearedCount || 0);
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

  return {
    activeView,
    selectedLiveKey,
    selectedHistoryKey,
    summaryCards,
    toolbarNote,
    reachableAgents,
    agentSignalAgents,
    disconnectedAgents,
    humans,
    selectedLiveParticipant,
    selectedHistoryEntry,
    liveClearedCount,
    activityIconPath,
    initials,
    connectionLabel,
    formatRelativeTime,
    signalLabel,
    hasRecentLivenessObservation,
    isReachableParticipant,
    participantSubtitle,
    reasoningStatus,
    reasoningTitle,
    reasoningSummary,
    livenessCapabilityLabel,
    sourceBadges,
    taskStatusLabel,
  };
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
