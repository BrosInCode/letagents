import type {
  DesktopBoardGovernanceAuditEntry,
  DesktopBoardGovernanceCapabilities,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardGovernanceWarning,
  DesktopBoardIntentSummary,
  DesktopBoardManagerCandidate,
} from "../../../ipc-types/board-governance.js";
import type { BoardGovernanceApiResponse } from "./payloads.js";

export function mapDesktopBoardGovernanceSnapshot(
  data: BoardGovernanceApiResponse,
): DesktopBoardGovernanceSnapshot {
  return {
    roomId: data.room_id,
    managerMode: data.settings.manager_mode,
    activeManager: data.active_manager
      ? {
          assignmentId: data.active_manager.id,
          agentSessionId: data.active_manager.agent_session_id,
          agentKey: data.active_manager.agent_key,
          actorLabel: data.active_manager.actor_label,
          runtimeSource: data.active_manager.runtime_source,
          assignedBy: data.active_manager.assigned_by,
          lastHeartbeatAt: data.active_manager.last_heartbeat_at,
        }
      : null,
    candidates: data.candidates.map((candidate): DesktopBoardManagerCandidate => ({
      agentSessionId: candidate.agent_session_id,
      agentKey: candidate.agent_key,
      actorLabel: candidate.actor_label,
      displayName: candidate.display_name,
      runtime: candidate.runtime,
      runtimeSource: candidate.runtime_source,
      lastSeenAt: candidate.last_seen_at,
      isActiveManager: candidate.is_active_manager,
    })),
    pendingIntents: data.pending_intents.map((intent): DesktopBoardIntentSummary => ({
      id: intent.id,
      taskId: intent.task_id,
      actionType: intent.action_type,
      status: intent.status,
      proposerActorLabel: intent.proposer_actor_label,
      payload: intent.payload,
      createdAt: intent.created_at,
      expiresAt: intent.expires_at,
    })),
    pendingIntentCount: data.pending_intent_count,
    audit: data.audit.map((entry): DesktopBoardGovernanceAuditEntry => ({
      id: entry.id,
      kind: entry.kind,
      eventType: entry.event_type,
      actorLabel: entry.actor_label,
      reason: entry.reason,
      createdAt: entry.created_at,
      metadata: entry.metadata,
    })),
    warnings: data.warnings.map((warning): DesktopBoardGovernanceWarning => ({
      code: warning.code,
      severity: warning.severity,
      message: warning.message,
    })),
    capabilities: mapCapabilities(data.capabilities),
  };
}

function mapCapabilities(
  capabilities: BoardGovernanceApiResponse["capabilities"],
): DesktopBoardGovernanceCapabilities {
  return {
    canViewGovernance: capabilities.can_view_governance,
    canAssignManager: capabilities.can_assign_manager,
    canReleaseManager: capabilities.can_release_manager,
    canSetManagerMode: capabilities.can_set_manager_mode,
    canDecideIntents: capabilities.can_decide_intents,
  };
}
