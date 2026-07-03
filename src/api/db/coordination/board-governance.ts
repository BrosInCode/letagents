import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { board_intents, board_manager_assignments, room_agent_sessions } from "../schema.js";
import { toBoardIntent, toBoardManagerAssignment, toCoordinationEvent } from "../mappers.js";
import type {
  BoardGovernanceAuditEntry,
  BoardGovernanceCapabilities,
  BoardGovernanceSnapshot,
  BoardGovernanceWarning,
  BoardIntentRow,
  BoardManagerAssignment,
  BoardManagerAssignmentRow,
  BoardManagerCandidate,
  BoardManagerMode,
  CoordinationEvent,
  CoordinationEventRow,
  RoomAgentSessionRow,
  RoomBoardSettings,
} from "../types.js";
import { createCoordinationEvent } from "./events.js";
import {
  countBoardIntents,
  getActiveBoardManager,
  getRoomBoardSettings,
  inferBoardManagerRuntimeSource,
  listBoardIntents,
  shouldRequireBoardIntent,
} from "./board-intents.js";
import { coordination_events } from "../schema.js";

const BOARD_GOVERNANCE_AUDIT_EVENT_TYPES = [
  "board_manager_assigned",
  "board_manager_released",
  "board_manager_mode_changed",
] as const;

export async function listActiveBoardManagerCandidates(
  roomId: string,
  activeManager: BoardManagerAssignment | null
): Promise<BoardManagerCandidate[]> {
  const rows = (await db
    .select()
    .from(room_agent_sessions)
    .where(
      and(
        eq(room_agent_sessions.room_id, roomId),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        sql`${room_agent_sessions.ended_at} IS NULL`
      )
    )
    .orderBy(desc(room_agent_sessions.last_seen_at))) as RoomAgentSessionRow[];

  return rows.map((session) => ({
    agent_session_id: session.session_id,
    agent_key: session.agent_key,
    actor_label: session.actor_label,
    display_name: session.display_name,
    runtime: session.runtime,
    runtime_source: inferBoardManagerRuntimeSource(session),
    last_seen_at: session.last_seen_at,
    is_active_manager: activeManager?.agent_session_id === session.session_id,
  }));
}

export async function listBoardGovernanceAudit(
  roomId: string,
  limit = 50
): Promise<BoardGovernanceAuditEntry[]> {
  const [coordinationRows, assignmentRows, intentRows] = await Promise.all([
    db
      .select()
      .from(coordination_events)
      .where(
        and(
          eq(coordination_events.room_id, roomId),
          inArray(coordination_events.event_type, [...BOARD_GOVERNANCE_AUDIT_EVENT_TYPES])
        )
      )
      .orderBy(desc(coordination_events.created_at))
      .limit(limit) as Promise<CoordinationEventRow[]>,
    db
      .select()
      .from(board_manager_assignments)
      .where(eq(board_manager_assignments.room_id, roomId))
      .orderBy(desc(board_manager_assignments.updated_at))
      .limit(limit) as Promise<BoardManagerAssignmentRow[]>,
    db
      .select()
      .from(board_intents)
      .where(
        and(
          eq(board_intents.room_id, roomId),
          inArray(board_intents.status, ["approved", "denied"])
        )
      )
      .orderBy(desc(board_intents.decided_at))
      .limit(limit) as Promise<BoardIntentRow[]>,
  ]);

  const entries: BoardGovernanceAuditEntry[] = [];
  const coveredAssignmentEvents = new Set(
    coordinationRows
      .map((row) => {
        const assignmentId = row.metadata?.assignment_id;
        return typeof assignmentId === "string"
          ? `${row.event_type}:${assignmentId}`
          : null;
      })
      .filter((key): key is string => Boolean(key))
  );

  for (const row of coordinationRows) {
    const event = toCoordinationEvent(row);
    entries.push({
      id: event.id,
      kind: "coordination_event",
      event_type: event.event_type,
      actor_label: event.actor_label,
      reason: event.reason,
      created_at: event.created_at,
      metadata: event.metadata ?? null,
    });
  }

  for (const row of assignmentRows) {
    const assignment = toBoardManagerAssignment(row);
    const fallbackEventType = assignment.status === "active"
      ? "board_manager_assigned"
      : "board_manager_released";
    if (coveredAssignmentEvents.has(`${fallbackEventType}:${assignment.id}`)) {
      continue;
    }
    entries.push({
      id: assignment.id,
      kind: "manager_assignment",
      event_type: assignment.status === "active" ? "board_manager_assigned" : "board_manager_released",
      actor_label: assignment.status === "active" ? assignment.assigned_by : assignment.released_by,
      reason: assignment.release_reason,
      created_at: assignment.status === "active"
        ? assignment.created_at
        : assignment.released_at ?? assignment.updated_at,
      metadata: {
        agent_session_id: assignment.agent_session_id,
        actor_label: assignment.actor_label,
        runtime_source: assignment.runtime_source,
        status: assignment.status,
      },
    });
  }

  for (const row of intentRows) {
    const intent = toBoardIntent(row);
    entries.push({
      id: intent.id,
      kind: "board_intent_decision",
      event_type: intent.status === "approved" ? "board_intent_approved" : "board_intent_denied",
      actor_label: intent.decision_by,
      reason: intent.decision_reason,
      created_at: intent.decided_at ?? intent.updated_at,
      metadata: {
        action_type: intent.action_type,
        task_id: intent.task_id,
        proposer_actor_label: intent.proposer_actor_label,
      },
    });
  }

  return entries
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, limit);
}

export function buildBoardGovernanceCapabilities(input: {
  is_admin: boolean;
  active_manager: BoardManagerAssignment | null;
  viewer_agent_session_id?: string | null;
}): BoardGovernanceCapabilities {
  const isActiveManager = Boolean(
    input.active_manager?.agent_session_id
    && input.viewer_agent_session_id
    && input.active_manager.agent_session_id === input.viewer_agent_session_id
  );

  return {
    can_view_governance: true,
    can_assign_manager: input.is_admin,
    can_release_manager: input.is_admin,
    can_set_manager_mode: input.is_admin,
    can_decide_intents: input.is_admin || isActiveManager,
  };
}

export function buildBoardGovernanceWarnings(input: {
  settings: RoomBoardSettings;
  active_manager: BoardManagerAssignment | null;
  pending_intent_count: number;
  intents_required: boolean;
}): BoardGovernanceWarning[] {
  const warnings: BoardGovernanceWarning[] = [];

  if (input.settings.manager_mode === "intent_required" && !input.active_manager) {
    warnings.push({
      code: "intent_required_without_manager",
      severity: "error",
      message: "Board Manager mode requires approval, but no active manager is assigned.",
    });
  }

  if (input.settings.manager_mode === "off" && input.active_manager) {
    warnings.push({
      code: "manager_assigned_while_mode_off",
      severity: "info",
      message: "A Board Manager is assigned, but manager mode is off so intents are not enforced.",
    });
  }

  if (input.pending_intent_count > 0 && input.intents_required && !input.active_manager && input.settings.manager_mode !== "off") {
    warnings.push({
      code: "pending_intents_without_manager",
      severity: "warning",
      message: "Pending board intents need a manager assignment or room admin to decide them.",
    });
  }

  if (input.pending_intent_count > 0 && input.active_manager) {
    warnings.push({
      code: "pending_intents_awaiting_decision",
      severity: "info",
      message: input.pending_intent_count === 1
        ? "1 board intent is waiting for a manager decision."
        : `${input.pending_intent_count} board intents are waiting for a manager decision.`,
    });
  }

  return warnings;
}

export async function getBoardGovernanceSnapshot(input: {
  room_id: string;
  is_admin: boolean;
  viewer_agent_session_id?: string | null;
}): Promise<BoardGovernanceSnapshot> {
  const [settings, activeManager, pendingIntentCount, pendingIntents, audit, intentsRequired] =
    await Promise.all([
      getRoomBoardSettings(input.room_id),
      getActiveBoardManager(input.room_id),
      countBoardIntents({ room_id: input.room_id, status: "pending" }),
      listBoardIntents({ room_id: input.room_id, status: "pending", limit: 100 }),
      listBoardGovernanceAudit(input.room_id),
      shouldRequireBoardIntent({ room_id: input.room_id }),
    ]);
  const candidates = await listActiveBoardManagerCandidates(input.room_id, activeManager);

  const warnings = buildBoardGovernanceWarnings({
    settings,
    active_manager: activeManager,
    pending_intent_count: pendingIntentCount,
    intents_required: intentsRequired,
  });

  return {
    room_id: input.room_id,
    settings,
    active_manager: activeManager,
    candidates,
    pending_intents: pendingIntents,
    pending_intent_count: pendingIntentCount,
    audit,
    warnings,
    capabilities: buildBoardGovernanceCapabilities({
      is_admin: input.is_admin,
      active_manager: activeManager,
      viewer_agent_session_id: input.viewer_agent_session_id,
    }),
  };
}

export async function recordBoardManagerAssignedEvent(input: {
  room_id: string;
  assigned_by: string;
  manager: BoardManagerAssignment;
}): Promise<CoordinationEvent> {
  return createCoordinationEvent({
    room_id: input.room_id,
    event_type: "board_manager_assigned",
    actor_label: input.assigned_by,
    metadata: {
      agent_session_id: input.manager.agent_session_id,
      actor_label: input.manager.actor_label,
      runtime_source: input.manager.runtime_source,
      assignment_id: input.manager.id,
    },
  });
}

export async function recordBoardManagerReleasedEvent(input: {
  room_id: string;
  released_by: string;
  manager: BoardManagerAssignment;
  reason?: string | null;
}): Promise<CoordinationEvent> {
  return createCoordinationEvent({
    room_id: input.room_id,
    event_type: "board_manager_released",
    actor_label: input.released_by,
    reason: input.reason ?? input.manager.release_reason,
    metadata: {
      agent_session_id: input.manager.agent_session_id,
      actor_label: input.manager.actor_label,
      runtime_source: input.manager.runtime_source,
      assignment_id: input.manager.id,
    },
  });
}

export async function recordBoardManagerModeChangedEvent(input: {
  room_id: string;
  updated_by: string;
  manager_mode: BoardManagerMode;
}): Promise<CoordinationEvent> {
  return createCoordinationEvent({
    room_id: input.room_id,
    event_type: "board_manager_mode_changed",
    actor_label: input.updated_by,
    metadata: {
      manager_mode: input.manager_mode,
    },
  });
}
