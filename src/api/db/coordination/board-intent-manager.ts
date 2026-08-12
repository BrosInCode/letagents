import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_manager_assignments, room_agent_sessions, room_board_settings } from "../schema.js";
import { toBoardManagerAssignment, toRoomBoardSettings } from "../mappers.js";
import { coordinationId } from "../utils.js";
import { DEFAULT_BOARD_MANAGER_FAILOVER } from "../../../shared/board-manager-failover.js";
import type { RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import type {
  BoardManagerAssignment,
  BoardManagerAssignmentRow,
  BoardManagerFailoverMode,
  BoardManagerMode,
  BoardManagerRuntimeSource,
  RoomAgentSessionRow,
  RoomBoardSettings,
  RoomBoardSettingsRow,
} from "../types.js";

export const DEFAULT_BOARD_MANAGER_MODE: BoardManagerMode = "manager_optional";

function isValidBoardManagerMode(value: string): value is BoardManagerMode {
  return value === "off" || value === "manager_optional" || value === "intent_required";
}

function isValidRuntimeSource(value: string): value is BoardManagerRuntimeSource {
  return value === "desktop_managed" || value === "open_model" || value === "external" || value === "unknown";
}

export function normalizeBoardManagerMode(value: string | null | undefined): BoardManagerMode {
  const normalized = value?.trim();
  return normalized && isValidBoardManagerMode(normalized)
    ? normalized
    : DEFAULT_BOARD_MANAGER_MODE;
}

export function normalizeBoardManagerRuntimeSource(
  value: string | null | undefined
): BoardManagerRuntimeSource {
  const normalized = value?.trim();
  return normalized && isValidRuntimeSource(normalized) ? normalized : "unknown";
}

export async function getRoomBoardSettings(roomId: string): Promise<RoomBoardSettings> {
  const [row] = (await db
    .select()
    .from(room_board_settings)
    .where(eq(room_board_settings.room_id, roomId))
    .limit(1)) as RoomBoardSettingsRow[];

  if (row) return toRoomBoardSettings(row);
  const now = new Date().toISOString();
  return {
    room_id: roomId,
    manager_mode: DEFAULT_BOARD_MANAGER_MODE,
    manager_failover: DEFAULT_BOARD_MANAGER_FAILOVER,
    stall_nudged_at: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  };
}

export async function setRoomBoardManagerMode(input: {
  room_id: string;
  manager_mode: BoardManagerMode;
  manager_failover?: BoardManagerFailoverMode | null;
  updated_by: string;
}): Promise<RoomBoardSettings> {
  const now = new Date().toISOString();
  const failoverUpdate = input.manager_failover ? { manager_failover: input.manager_failover } : {};
  const [row] = (await db
    .insert(room_board_settings)
    .values({
      room_id: input.room_id,
      manager_mode: input.manager_mode,
      manager_failover: input.manager_failover ?? DEFAULT_BOARD_MANAGER_FAILOVER,
      updated_by: input.updated_by,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: room_board_settings.room_id,
      set: {
        manager_mode: input.manager_mode,
        ...failoverUpdate,
        updated_by: input.updated_by,
        updated_at: now,
      },
    })
    .returning()) as RoomBoardSettingsRow[];

  const settings = toRoomBoardSettings(row);
  const { recordBoardManagerModeChangedEvent } = await import("./board-governance.js");
  await recordBoardManagerModeChangedEvent({
    room_id: input.room_id,
    updated_by: input.updated_by,
    manager_mode: input.manager_mode,
  });
  return settings;
}

export async function getActiveBoardManager(
  roomId: string
): Promise<BoardManagerAssignment | null> {
  const [row] = await db
    .select({ assignment: board_manager_assignments })
    .from(board_manager_assignments)
    .innerJoin(
      room_agent_sessions,
      and(
        eq(room_agent_sessions.room_id, board_manager_assignments.room_id),
        eq(room_agent_sessions.session_id, board_manager_assignments.agent_session_id),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        sql`${room_agent_sessions.ended_at} IS NULL`
      )
    )
    .where(
      and(
        eq(board_manager_assignments.room_id, roomId),
        eq(board_manager_assignments.status, "active")
      )
    )
    .orderBy(asc(board_manager_assignments.created_at))
    .limit(1);

  return row?.assignment
    ? toBoardManagerAssignment(row.assignment as BoardManagerAssignmentRow)
    : null;
}

export function inferBoardManagerRuntimeSource(
  session: {
    runtime: string;
    ide_label: string | null;
    liveness_capability: string | null;
    tool_bridge_id: string | null;
  }
): BoardManagerRuntimeSource {
  const signal = [
    session.runtime,
    session.ide_label,
    session.liveness_capability,
    session.tool_bridge_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    signal.includes("open-model")
    || signal.includes("open_model")
    || signal.includes("open model")
    || signal.includes("letagents_open_model")
  ) {
    return "open_model";
  }
  return "desktop_managed";
}

export async function assignBoardManager(input: {
  room_id: string;
  agent_session_id: string;
  assigned_by: string;
  runtime_source?: BoardManagerRuntimeSource | null;
}): Promise<BoardManagerAssignment | null> {
  const [session] = (await db
    .select()
    .from(room_agent_sessions)
    .where(
      and(
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.session_id, input.agent_session_id),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        sql`${room_agent_sessions.ended_at} IS NULL`
      )
    )
    .limit(1)) as RoomAgentSessionRow[];
  if (!session) return null;

  const now = new Date().toISOString();
  const replacedRows = (await db
    .update(board_manager_assignments)
    .set({
      status: "released",
      released_by: input.assigned_by,
      release_reason: "Replaced by a new Board Manager assignment.",
      released_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(board_manager_assignments.room_id, input.room_id),
        eq(board_manager_assignments.status, "active")
      )
    )
    .returning()) as BoardManagerAssignmentRow[];

  const runtimeSource = input.runtime_source ?? inferBoardManagerRuntimeSource(session);
  const [row] = (await db
    .insert(board_manager_assignments)
    .values({
      id: coordinationId("bm"),
      room_id: input.room_id,
      agent_session_id: session.session_id,
      agent_key: session.agent_key,
      actor_label: session.actor_label,
      runtime_source: runtimeSource,
      assigned_by: input.assigned_by,
      status: "active",
      last_heartbeat_at: session.last_seen_at,
      released_by: null,
      release_reason: null,
      released_at: null,
      created_at: now,
      updated_at: now,
    })
    .returning()) as BoardManagerAssignmentRow[];

  const assignment = toBoardManagerAssignment(row);
  const { recordBoardManagerAssignedEvent, recordBoardManagerReleasedEvent } = await import("./board-governance.js");
  for (const replacedRow of replacedRows) {
    await recordBoardManagerReleasedEvent({
      room_id: input.room_id,
      released_by: input.assigned_by,
      manager: toBoardManagerAssignment(replacedRow),
      reason: "Replaced by a new Board Manager assignment.",
    });
  }
  await recordBoardManagerAssignedEvent({
    room_id: input.room_id,
    assigned_by: input.assigned_by,
    manager: assignment,
  });
  return assignment;
}

export async function releaseBoardManager(input: {
  room_id: string;
  released_by: string;
  reason?: string | null;
}): Promise<BoardManagerAssignment | null> {
  const now = new Date().toISOString();
  const [row] = (await db
    .update(board_manager_assignments)
    .set({
      status: "released",
      released_by: input.released_by,
      release_reason: input.reason ?? "Board Manager released.",
      released_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(board_manager_assignments.room_id, input.room_id),
        eq(board_manager_assignments.status, "active")
      )
    )
    .returning()) as BoardManagerAssignmentRow[];

  if (!row) return null;
  const assignment = toBoardManagerAssignment(row);
  const { recordBoardManagerReleasedEvent } = await import("./board-governance.js");
  await recordBoardManagerReleasedEvent({
    room_id: input.room_id,
    released_by: input.released_by,
    manager: assignment,
    reason: input.reason,
  });
  return assignment;
}
