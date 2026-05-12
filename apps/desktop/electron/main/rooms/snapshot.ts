import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopFocusRoomInfo,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomSnapshot,
  DesktopTaskSummary,
} from "../../ipc-types.js";
import { resolveRoomIdentifier } from "../../repo-status.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { mapRoomMessageAttachmentPayload } from "../attachments.js";
import { roomMessageHistoryPageSize, workspaceRoot } from "../paths.js";
import { mapRoomMessagePayload } from "./messages.js";
import {
  createRoomAccess,
  getJoinedRoomInfo,
  mapDesktopRoomInfoPayload,
} from "./room-info.js";
import { mapDesktopReasoningSessionPayload } from "./reasoning.js";
import { mapDesktopTaskSummaryPayload } from "./tasks.js";

export async function fetchRoomSnapshot(
  requestedRoomIdentifier?: string | null,
): Promise<DesktopRoomSnapshot> {
  const roomIdentifier =
    requestedRoomIdentifier?.trim() ||
    (await resolveRoomIdentifier(workspaceRoot));
  if (!roomIdentifier) {
    return {
      roomIdentifier: null,
      access: createRoomAccess({
        status: "missing_room",
        title: "Choose a room to begin",
        message:
          "LetAgents could not find a room from this folder yet. Create or join a room to continue.",
      }),
      room: null,
      focusRooms: [],
      tasks: [],
      participants: [],
      participantHiddenCount: 0,
      presence: [],
      reasoningSessions: [],
      recentActivity: [],
      messages: [],
    };
  }

  try {
    const joined = await getJoinedRoomInfo(roomIdentifier);

    const [
      focusRoomsData,
      tasksData,
      participantsData,
      presenceData,
      reasoningData,
      activityHistoryData,
      messagesData,
    ] = await Promise.all([
      apiFetch<{
        focus_rooms?: Array<{
          room_id: string;
          name: string | null;
          display_name: string;
          code: string | null;
          source_task_id: string | null;
          focus_status: "active" | "concluded" | null;
          created_at: string;
        }>;
      }>(`/rooms/${encodeURIComponent(roomIdentifier)}/focus-rooms`).catch(
        () => ({ focus_rooms: [] }),
      ),
      apiFetch<{
        tasks?: Array<{
          id: string;
          title: string;
          description?: string | null;
          status: string;
          assignee: string | null;
          created_by?: string | null;
          pr_url?: string | null;
          workflow_refs?: Array<{
            provider?: string;
            kind?: string;
            label?: string;
            url?: string;
          }> | null;
          active_leases?: Array<{
            id?: string;
            kind?: string;
            holder_label?: string | null;
            agent_label?: string | null;
            agent_key?: string | null;
            agent_session_id?: string | null;
            status?: string;
            updated_at?: string | null;
          }>;
          active_locks?: Array<{
            id?: string;
            scope?: string;
            reason?: string | null;
            message?: string | null;
            created_by?: string | null;
          }>;
          created_at?: string | null;
          updated_at: string;
        }>;
      }>(`/rooms/${encodeURIComponent(roomIdentifier)}/tasks`).catch(() => ({
        tasks: [],
      })),
      apiFetch<{
        participants?: Array<{
          participant_key: string;
          kind: "human" | "agent";
          display_name: string;
          actor_label: string | null;
          agent_key?: string | null;
          github_login?: string | null;
          owner_label?: string | null;
          ide_label?: string | null;
          hidden_at?: string | null;
          activity_state: "active" | "away" | "offline" | null;
          last_seen_at: string;
          last_room_activity_at?: string | null;
          last_live_heartbeat_at?: string | null;
          source_flags?: Array<"delivery" | "presence" | "messages" | "tasks">;
        }>;
        hidden_count?: number;
      }>(`/rooms/${encodeURIComponent(roomIdentifier)}/participants`).catch(
        () => ({ participants: [], hidden_count: 0 }),
      ),
      apiFetch<{
        presence?: Array<{
          room_id: string;
          actor_label: string;
          agent_key: string | null;
          agent_instance_id: string | null;
          agent_session_id: string | null;
          session_kind: "controller" | "worker";
          runtime: string;
          display_name: string;
          owner_label: string | null;
          ide_label: string | null;
          status: "idle" | "working" | "reviewing" | "blocked";
          status_text: string | null;
          last_heartbeat_at: string;
          freshness: "active" | "stale";
          activity_state: "active" | "away" | "offline";
          source_flags?: Array<"delivery" | "presence" | "messages" | "tasks">;
          liveness_observation?: {
            room_id: string;
            agent_session_id: string;
            source: string;
            host_id: string | null;
            host_kind: string | null;
            host_label: string | null;
            liveness_capability: string;
            tool_bridge_id: string | null;
            last_observed_at: string;
            last_tool_call_at: string | null;
            detail: string | null;
            created_at: string;
            updated_at: string;
          } | null;
        }>;
      }>(
        `/rooms/${encodeURIComponent(roomIdentifier)}/presence?limit=100&scope=snapshot`,
      ).catch(() => ({ presence: [] })),
      apiFetch<{
        sessions?: Array<{
          id: string;
          room_id?: string | null;
          actor_label?: string | null;
          agent_key?: string | null;
          task_id?: string | null;
          title?: string | null;
          status?: string | null;
          summary?: string | null;
          latest_payload?: DesktopReasoningSession["latestPayload"];
          goal?: string | null;
          checking?: string | null;
          hypothesis?: string | null;
          blocker?: string | null;
          next_action?: string | null;
          milestone?: string | null;
          confidence?: number | null;
          closed_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        }>;
        reasoning_sessions?: Array<{
          id: string;
          room_id?: string | null;
          actor_label?: string | null;
          agent_key?: string | null;
          task_id?: string | null;
          title?: string | null;
          status?: string | null;
          summary?: string | null;
          latest_payload?: DesktopReasoningSession["latestPayload"];
          goal?: string | null;
          checking?: string | null;
          hypothesis?: string | null;
          blocker?: string | null;
          next_action?: string | null;
          milestone?: string | null;
          confidence?: number | null;
          closed_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        }>;
      }>(
        `/rooms/${encodeURIComponent(roomIdentifier)}/reasoning-sessions`,
      ).catch(() => ({ sessions: [], reasoning_sessions: [] })),
      apiFetch<{
        entries?: Array<{
          id: string;
          room?: {
            id: string;
            display_name: string;
            kind: "main" | "focus";
            focus_status: "active" | "concluded" | null;
            source_task_id: string | null;
          };
          participant: {
            display_name: string;
            kind: "human" | "agent";
            actor_label?: string | null;
            owner_label?: string | null;
            ide_label?: string | null;
            activity_state: "active" | "away" | "offline" | null;
          };
          first_seen_at?: string | null;
          last_seen_at?: string | null;
          last_room_activity_at: string;
          message_count?: number | null;
          reasoning_session_count?: number | null;
          current_tasks: Array<{
            id: string;
            title: string;
            status: string;
            updated_at?: string | null;
            workflow_refs?: Array<{
              provider: string;
              kind: string;
              label: string;
              url: string;
            }>;
          }>;
          completed_tasks: Array<{
            id: string;
            title: string;
            status: string;
            updated_at?: string | null;
            workflow_refs?: Array<{
              provider: string;
              kind: string;
              label: string;
              url: string;
            }>;
          }>;
          created_tasks?: Array<{
            id: string;
            title: string;
            status: string;
            updated_at?: string | null;
            workflow_refs?: Array<{
              provider: string;
              kind: string;
              label: string;
              url: string;
            }>;
          }>;
        }>;
      }>(
        `/rooms/${encodeURIComponent(roomIdentifier)}/activity-history?page_size=50`,
      ).catch(() => ({ entries: [] })),
      apiFetch<{
        messages?: Array<{
          id: string;
          sender: string;
          text: string;
          attachments?:
            | Parameters<typeof mapRoomMessageAttachmentPayload>[0][]
            | null;
          agent_prompt_kind?: string | null;
          source: string | null;
          timestamp: string;
          reply_to?: {
            id: string;
            sender: string;
            text: string;
            source?: string | null;
            timestamp: string;
          } | null;
          agent_identity?: {
            name?: string | null;
            display_name?: string | null;
            owner_label?: string | null;
            owner_attribution?: string | null;
            ide_label?: string | null;
            actor_label?: string | null;
          } | null;
        }>;
      }>(
        `/rooms/${encodeURIComponent(roomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`,
      ).catch(() => ({ messages: [] })),
    ]);

    const room = mapDesktopRoomInfoPayload(roomIdentifier, joined);

    const focusRooms: DesktopFocusRoomInfo[] = (
      focusRoomsData.focus_rooms || []
    ).map((focusRoom) => ({
      roomId: focusRoom.room_id,
      identifier: focusRoom.room_id,
      displayName: focusRoom.display_name,
      code: focusRoom.code || null,
      sourceTaskId: focusRoom.source_task_id || null,
      focusStatus: focusRoom.focus_status || null,
      createdAt: focusRoom.created_at,
    }));

    const tasks: DesktopTaskSummary[] = (tasksData.tasks || []).map(
      mapDesktopTaskSummaryPayload,
    );

    const participants: DesktopParticipantSummary[] = (
      participantsData.participants || []
    ).map((participant) => ({
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
    const participantHiddenCount = Number(participantsData.hidden_count || 0);

    const presence: DesktopAgentPresence[] = (presenceData.presence || []).map(
      (entry) => ({
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
              livenessCapability:
                entry.liveness_observation.liveness_capability,
              toolBridgeId: entry.liveness_observation.tool_bridge_id,
              lastObservedAt: entry.liveness_observation.last_observed_at,
              lastToolCallAt: entry.liveness_observation.last_tool_call_at,
              detail: entry.liveness_observation.detail,
              createdAt: entry.liveness_observation.created_at,
              updatedAt: entry.liveness_observation.updated_at,
            }
          : null,
      }),
    );

    const reasoningSessions: DesktopReasoningSession[] = [
      ...(reasoningData.sessions || reasoningData.reasoning_sessions || []),
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

    const mapActivityTask = (task: {
      id: string;
      title: string;
      status: string;
      updated_at?: string | null;
      workflow_refs?: Array<{
        provider: string;
        kind: string;
        label: string;
        url: string;
      }>;
    }) => ({
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
    });

    const recentActivity: DesktopActivityEntry[] = (
      activityHistoryData.entries || []
    ).map((entry) => ({
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

    const messages: DesktopRoomMessage[] = [...(messagesData.messages || [])]
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp || "");
        const rightTime = Date.parse(right.timestamp || "");
        return leftTime - rightTime;
      })
      .map(mapRoomMessagePayload);

    return {
      roomIdentifier,
      access: createRoomAccess({
        status: "ready",
        roomIdentifier,
      }),
      room,
      focusRooms,
      tasks,
      participants,
      participantHiddenCount,
      presence,
      reasoningSessions,
      recentActivity,
      messages,
    };
  } catch (error) {
    if (error instanceof DesktopApiError) {
      const payload = error.payload;
      const accessStatus =
        payload?.error === "auth_required"
          ? "auth_required"
          : payload?.error === "private_repo_no_access"
            ? "forbidden"
            : "unavailable";

      return {
        roomIdentifier,
        access: createRoomAccess({
          status: accessStatus,
          title:
            accessStatus === "auth_required"
              ? "Connect GitHub to open this room"
              : accessStatus === "forbidden"
                ? "This account cannot open the room"
                : "Room unavailable",
          message: payload?.message || error.message,
          roomIdentifier: payload?.room_id || roomIdentifier,
          deviceFlowUrl: payload?.device_flow_url || null,
          code: payload?.code || null,
          httpStatus: error.status,
        }),
        room: null,
        focusRooms: [],
        tasks: [],
        participants: [],
        participantHiddenCount: 0,
        presence: [],
        reasoningSessions: [],
        recentActivity: [],
        messages: [],
      };
    }

    return {
      roomIdentifier,
      access: createRoomAccess({
        status: "unavailable",
        title: "Room unavailable",
        message:
          error instanceof Error
            ? error.message
            : "LetAgents could not load this room.",
        roomIdentifier,
      }),
      room: null,
      focusRooms: [],
      tasks: [],
      participants: [],
      participantHiddenCount: 0,
      presence: [],
      reasoningSessions: [],
      recentActivity: [],
      messages: [],
    };
  }
}
