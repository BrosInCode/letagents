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
} from "./participantBuilders";
import {
  connectionLabel,
  connectionTone,
  hasAgentSignal,
  isReachableParticipant,
  isReachablePresence,
  signalLabel,
  sourceBadges,
} from "./signals";
import { initials, livenessCapabilityLabel, taskStatusLabel } from "./formatters";
import { isHumanMessage } from "./matching";
import type {
  ActivityParticipant,
  RoomActivityViewModelInput,
} from "./types";

export type { RoomActivityViewModelInput } from "./types";

export function useRoomActivityViewModel(
  props: RoomActivityViewModelInput,
  options: { autoSelectLive?: boolean } = {},
) {
  const autoSelectLive = options.autoSelectLive ?? true;
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
      const messages = grouped.get(actor);
      if (messages) messages.push(message);
      else grouped.set(actor, [message]);
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

    return [...agents.values()].sort(compareActivityParticipants);
  });

  const reachableAgents = computed(() =>
    liveParticipants.value.filter((participant) =>
      participant.kind === "agent" && (participant.activityState === "active" || participant.activityState === "away")
    )
  );
  const workingAgents = computed(() =>
    liveParticipants.value
      .filter((participant) => participant.kind === "agent" && hasAgentSignal(participant) && !isReachableParticipant(participant))
      .sort(compareSignalParticipants)
  );
  const liveRosterAgents = computed(() => {
    const participants = new Map<string, ActivityParticipant>();
    for (const participant of [
      ...reachableAgents.value,
      ...workingAgents.value,
    ]) {
      participants.set(participant.key, participant);
    }
    return [...participants.values()];
  });
  const selectedLiveParticipant = computed(() =>
    liveRosterAgents.value.find((participant) => participant.key === selectedLiveKey.value)
      || (autoSelectLive ? liveRosterAgents.value[0] : null)
      || null
  );
  const selectedHistoryEntry = computed(() =>
    props.recentActivity.find((entry) => entry.id === selectedHistoryKey.value) || props.recentActivity[0] || null
  );

  watch(liveRosterAgents, (next) => {
    if (!next.length) {
      selectedLiveKey.value = null;
      return;
    }
    if (selectedLiveKey.value && !next.some((participant) => participant.key === selectedLiveKey.value)) {
      selectedLiveKey.value = null;
    }
    if (autoSelectLive && !selectedLiveKey.value) {
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
