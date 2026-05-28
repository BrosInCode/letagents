import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopFocusRoomInfo,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
} from "../../../ipc-types.js";
import { mapRoomMessagePayload } from "../messages.js";
import { mapDesktopReasoningSessionPayload } from "../reasoning.js";
import { mapDesktopTaskSummaryPayload } from "../tasks.js";
import type {
  ActivityHistoryResponse,
  ActivityTaskPayload,
  FocusRoomsResponse,
  MessagesResponse,
  ParticipantsResponse,
  PresenceResponse,
  ReasoningResponse,
  RoomSnapshotData,
} from "./payloads.js";

export function mapSnapshotData(data: RoomSnapshotData) {
  return {
    focusRooms: mapFocusRooms(data.focusRoomsData),
    tasks: mapTasks(data.tasksData),
    participants: mapParticipants(data.participantsData),
    participantHiddenCount: Number(data.participantsData.hidden_count || 0),
    presence: mapPresence(data.presenceData),
    reasoningSessions: mapReasoningSessions(data.reasoningData),
    recentActivity: mapRecentActivity(data.activityHistoryData),
    messages: mapMessages(data.messagesData),
  };
}

function mapFocusRooms(data: FocusRoomsResponse): DesktopFocusRoomInfo[] {
  return (data.focus_rooms || []).map((focusRoom) => ({
    roomId: focusRoom.room_id,
    identifier: focusRoom.room_id,
    displayName: focusRoom.display_name,
    code: focusRoom.code || null,
    sourceTaskId: focusRoom.source_task_id || null,
    focusStatus: focusRoom.focus_status || null,
    createdAt: focusRoom.created_at,
  }));
}

function mapTasks(
  data: RoomSnapshotData["tasksData"],
): DesktopTaskSummary[] {
  return (data.tasks || []).map(mapDesktopTaskSummaryPayload);
}

function mapParticipants(data: ParticipantsResponse): DesktopParticipantSummary[] {
  return (data.participants || []).map((participant) => ({
    participantKey: participant.participant_key,
    kind: participant.kind,
    displayName: participant.display_name,
    actorLabel: participant.actor_label || null,
    agentKey: participant.agent_key || null,
    githubLogin: participant.github_login || null,
    ownerLabel: participant.owner_label || null,
    ideLabel: participant.ide_label || null,
    hiddenAt: participant.hidden_at || null,
    activityState: participant.activity_state || null,
    lastSeenAt: participant.last_seen_at,
    lastRoomActivityAt: participant.last_room_activity_at || null,
    lastLiveHeartbeatAt: participant.last_live_heartbeat_at || null,
    sourceFlags: participant.source_flags || [],
  }));
}

function mapPresence(data: PresenceResponse): DesktopAgentPresence[] {
  return (data.presence || []).map((entry) => ({
    roomId: entry.room_id,
    actorLabel: entry.actor_label,
    agentKey: entry.agent_key || null,
    agentInstanceId: entry.agent_instance_id || null,
    agentSessionId: entry.agent_session_id || null,
    sessionKind: entry.session_kind,
    runtime: entry.runtime,
    displayName: entry.display_name,
    ownerLabel: entry.owner_label || null,
    ideLabel: entry.ide_label || null,
    status: entry.status,
    statusText: entry.status_text || null,
    lastHeartbeatAt: entry.last_heartbeat_at,
    freshness: entry.freshness,
    activityState: entry.activity_state,
    sourceFlags: entry.source_flags || [],
    livenessObservation: entry.liveness_observation
      ? {
          roomId: entry.liveness_observation.room_id,
          agentSessionId: entry.liveness_observation.agent_session_id,
          source: entry.liveness_observation.source,
          hostId: entry.liveness_observation.host_id,
          hostKind: entry.liveness_observation.host_kind,
          hostLabel: entry.liveness_observation.host_label,
          livenessCapability: entry.liveness_observation.liveness_capability,
          toolBridgeId: entry.liveness_observation.tool_bridge_id,
          lastObservedAt: entry.liveness_observation.last_observed_at,
          lastToolCallAt: entry.liveness_observation.last_tool_call_at,
          detail: entry.liveness_observation.detail,
          createdAt: entry.liveness_observation.created_at,
          updatedAt: entry.liveness_observation.updated_at,
        }
      : null,
  }));
}

function mapReasoningSessions(data: ReasoningResponse): DesktopReasoningSession[] {
  return [
    ...(data.sessions || data.reasoning_sessions || []),
  ]
    .map(mapDesktopReasoningSessionPayload)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
      const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
      return (
        (Number.isFinite(rightTime) ? rightTime : -1) -
        (Number.isFinite(leftTime) ? leftTime : -1)
      );
    });
}

function mapRecentActivity(data: ActivityHistoryResponse): DesktopActivityEntry[] {
  return (data.entries || []).map((entry) => ({
    id: entry.id,
    room: entry.room
      ? {
          id: entry.room.id,
          displayName: entry.room.display_name,
          kind: entry.room.kind,
          focusStatus: entry.room.focus_status,
          sourceTaskId: entry.room.source_task_id,
        }
      : null,
    participantDisplayName: entry.participant.display_name,
    participantKind: entry.participant.kind,
    participantActorLabel: entry.participant.actor_label || null,
    participantOwnerLabel: entry.participant.owner_label || null,
    participantIdeLabel: entry.participant.ide_label || null,
    activityState: entry.participant.activity_state || null,
    firstSeenAt: entry.first_seen_at || null,
    lastSeenAt: entry.last_seen_at || null,
    lastRoomActivityAt: entry.last_room_activity_at,
    messageCount: Number(entry.message_count || 0),
    reasoningSessionCount: Number(entry.reasoning_session_count || 0),
    currentTasks: (entry.current_tasks || []).map(mapActivityTask),
    completedTasks: (entry.completed_tasks || []).map(mapActivityTask),
    createdTasks: (entry.created_tasks || []).map(mapActivityTask),
  }));
}

function mapActivityTask(task: ActivityTaskPayload): DesktopActivityEntry["currentTasks"][number] {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updated_at || null,
    workflowRefs: (task.workflow_refs || []).map((ref) => ({
      provider: ref.provider,
      kind: ref.kind,
      label: ref.label,
      url: ref.url,
    })),
  };
}

function mapMessages(data: MessagesResponse): DesktopRoomMessage[] {
  return [...(data.messages || [])]
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp || "");
      const rightTime = Date.parse(right.timestamp || "");
      return leftTime - rightTime;
    })
    .map(mapRoomMessagePayload);
}
