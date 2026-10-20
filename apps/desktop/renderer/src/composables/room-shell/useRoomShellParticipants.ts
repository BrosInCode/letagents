import { mergeRoomResponseParticipants } from "../../domain/room-response-participants";
import { useRoomResponseParticipants } from "../useRoomResponseParticipants";
import { computed } from "vue";
import { useNow } from "../useNow";
import {
  managedAgentRepoStatusForRoom,
  mergeDesktopSupervisorAgentParticipants,
  mergeReachableAgentPresenceParticipants,
  supervisedAgentWorkIndicators, remoteAgentWorkIndicators,
  managedAgentRootPathForRoom,
} from "../../domain/managed-agents";
import { attentionResponseAgentNames } from "../../domain/attention-response";
import { waitingAgentIndicators } from "../../domain/scheduled-retry";
import { roomMentionCandidates } from "../../domain/participants";
import { supervisorEntriesResourceFreshness } from "../../domain/supervisor-entries-resource";
import type { RoomShellContextOf } from "./context";

/** Environment and repo state, participants, mentions, and agent work indicators. */
export function useRoomShellParticipants(context: unknown) {
  const {
    actionPanelOpen, activeTab, props, refreshedEnvironmentRepoStatus, searchOpen, showEventsTab,
    supervisorEntries, supervisorEntriesState,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellConversation"
    | "useRoomShellIntegrations"
    | "useRoomShellState"
  >;
  const app = context as object;
  const githubEventsAvailable = showEventsTab;
  const showEnvironmentPanelWidget = computed(() =>
    activeTab.value === "chat" && Boolean(props.room.gitRoom) && !actionPanelOpen.value && !searchOpen.value
  );
  const effectiveEnvironmentRepoStatus = computed(() => {
    const refreshed = refreshedEnvironmentRepoStatus.value;
    if (!refreshed || refreshed.rootPath !== props.repoStatus.rootPath) return props.repoStatus;
    return refreshed;
  });
  const managedAgentRepoStatus = computed(() =>
    managedAgentRepoStatusForRoom(props.repoStatus, props.room, props.gitRoomMatchesActiveRepo)
  );
  const managedAgentRepoRootPath = computed(() =>
    managedAgentRootPathForRoom({
      room: props.room,
      repoStatus: managedAgentRepoStatus.value,
      gitRoomMatchesActiveRepo: props.gitRoomMatchesActiveRepo,
      durableProjectRootPath: props.durableProjectRootPath,
    })
  );
  // Room agents by Needs-you answer handle, for surfaces outside the chat view.
  const roomAttentionResponseNames = computed(() =>
    attentionResponseAgentNames([...roomParticipants.value, ...props.presence])
  );
  Object.assign(app, { roomAttentionResponseNames });
  const roomParticipants = computed(() =>
    mergeDesktopSupervisorAgentParticipants(
      // Message history can lack canonical agent keys. Enrich its identities
      // before adding local projections, otherwise one agent becomes two rows.
      mergeReachableAgentPresenceParticipants(props.participants, props.presence, props.room.identifier),
      supervisorEntries.value,
      props.room.identifier,
    )
  );
  const agentMentionInsertTextByEntryId = computed(() => {
    const result = new Map<string, string>();
    for (const entry of supervisorEntries.value) {
      const expectedAgentKey = entry.agentKey?.trim();
      if (!expectedAgentKey) continue;
      const participant = roomParticipants.value.find((candidate) =>
        candidate.kind === "agent"
        && candidate.participantKey === `desktop-supervisor-agent:${entry.id}`
        && candidate.agentKey === expectedAgentKey);
      const candidate = participant
        ? roomMentionCandidates(
            roomParticipants.value,
            participant.displayName,
            roomParticipants.value.length + 1,
          ).find((mention) => mention.participantKey === participant.participantKey)
        : null;
      if (candidate?.kind === "agent") {
        result.set(entry.id, candidate.insertText);
      }
    }
    return result;
  });
  Object.assign(app, { agentMentionInsertTextByEntryId });
  const pendingResponseParticipants = useRoomResponseParticipants(() => ({
    roomIdentifier: props.room.identifier, loading: props.roomLoading, messages: props.messages,
    entries: supervisorEntries.value, presence: props.presence,
    fresh: supervisorEntriesResourceFreshness(supervisorEntriesState.value) === "fresh",
  }));
  // The 90 s "recently working" window needs the clock, not only new presence data.
  const workWindowNow = useNow(30_000);
  const localAgentWork = computed(() =>
    mergeRoomResponseParticipants([
      ...waitingAgentIndicators(supervisorEntries.value, props.room.identifier),
      ...supervisedAgentWorkIndicators(supervisorEntries.value, props.presence, props.room.identifier,
        supervisorEntriesResourceFreshness(supervisorEntriesState.value)),
    ], [...pendingResponseParticipants.value, /* other members' agents, last */ ...remoteAgentWorkIndicators(props.presence,
      supervisorEntries.value, [], workWindowNow.value)], props.messages)
  );
  return {
    githubEventsAvailable, showEnvironmentPanelWidget, effectiveEnvironmentRepoStatus,
    managedAgentRepoStatus, managedAgentRepoRootPath, roomAttentionResponseNames, roomParticipants,
    agentMentionInsertTextByEntryId, pendingResponseParticipants, workWindowNow, localAgentWork,
  };
}
