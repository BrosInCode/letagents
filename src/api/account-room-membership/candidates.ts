import { rooms } from "../db/schema.js";
import { isInviteCode } from "../rooms/routing.js";
import type {
  AccountRoomCandidate,
  AccountRoomListFocusRoom,
  AccountRoomMembershipRole,
  AccountRoomProject,
  AccountRoomProjectRow,
  FocusRoomStatus,
  RoomKind,
} from "./types.js";

export const roomSelectColumns = {
  id: rooms.id,
  display_name: rooms.display_name,
  kind: rooms.kind,
  parent_room_id: rooms.parent_room_id,
  focus_key: rooms.focus_key,
  source_task_id: rooms.source_task_id,
  focus_status: rooms.focus_status,
  created_at: rooms.created_at,
};

export function toAccountRoomProject(row: AccountRoomProjectRow): AccountRoomProject {
  return {
    id: row.id,
    display_name: row.display_name,
    kind: row.kind as RoomKind,
    parent_room_id: row.parent_room_id,
    focus_key: row.focus_key,
    source_task_id: row.source_task_id,
    focus_status: row.focus_status as FocusRoomStatus | null,
    created_at: row.created_at,
  };
}

function earlierTimestamp(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next) return current;
  return next < current ? next : current;
}

function laterTimestamp(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next) return current;
  return next > current ? next : current;
}

function mergeAccountRoomSource(current: string | null, next: string | null): string | null {
  if (current === "create_invite" || next === "create_invite") {
    return "create_invite";
  }
  return current || next;
}

export function mergeAccountRoomCandidate(
  existing: AccountRoomCandidate,
  next: AccountRoomCandidate
): AccountRoomCandidate {
  return {
    project: existing.project,
    role: existing.role === "admin" || next.role === "admin" ? "admin" : "participant",
    source: mergeAccountRoomSource(existing.source, next.source),
    pinned: existing.pinned || next.pinned,
    archived: existing.archived || next.archived,
    canDelete: existing.canDelete || next.canDelete,
    directParentAccess: existing.directParentAccess || next.directParentAccess,
    first_opened_at: earlierTimestamp(existing.first_opened_at, next.first_opened_at),
    last_opened_at: laterTimestamp(existing.last_opened_at, next.last_opened_at),
  };
}

export function normalizeAccountRoomCandidate(
  project: AccountRoomProject,
  options: {
    role: AccountRoomMembershipRole;
    source?: string | null;
    pinned?: boolean;
    archived?: boolean;
    canDelete?: boolean;
    directParentAccess?: boolean;
    firstOpenedAt?: string | null;
    lastOpenedAt?: string | null;
  }
): AccountRoomCandidate {
  const firstOpenedAt = options.firstOpenedAt ?? options.lastOpenedAt ?? project.created_at;
  const lastOpenedAt = options.lastOpenedAt ?? options.firstOpenedAt ?? project.created_at;
  return {
    project,
    role: options.role,
    source: options.source ?? null,
    pinned: Boolean(options.pinned),
    archived: Boolean(options.archived),
    canDelete: Boolean(options.canDelete),
    directParentAccess: Boolean(options.directParentAccess),
    first_opened_at: firstOpenedAt,
    last_opened_at: lastOpenedAt,
  };
}

export function recentSourceHasDirectParentAccess(source: string | null): boolean {
  return source === "create_invite"
    || source === "open_room"
    || source === "join"
    || source === "recent";
}

export function accountRoomDeleteReason(candidate: AccountRoomCandidate): string | null {
  if (candidate.role !== "admin") {
    return "Only room admins can delete this room.";
  }
  if (!candidate.canDelete || !isInviteCode(candidate.project.id)) {
    return "Deletion is available only for invite rooms this account created in LetAgents.";
  }
  return null;
}

export function toAccountRoomListFocusRoom(
  focusRoom: AccountRoomProject,
  parentCandidate: AccountRoomCandidate,
  focusCandidate: AccountRoomCandidate | undefined
): AccountRoomListFocusRoom {
  return {
    room_id: focusRoom.id,
    display_name: focusRoom.display_name,
    kind: "focus",
    parent_room_id: focusRoom.parent_room_id ?? parentCandidate.project.id,
    focus_key: focusRoom.focus_key,
    source_task_id: focusRoom.source_task_id,
    focus_status: focusRoom.focus_status,
    role: focusCandidate?.role ?? parentCandidate.role,
    source: focusCandidate?.source ?? null,
    first_opened_at: focusCandidate?.first_opened_at ?? null,
    last_opened_at: focusCandidate?.last_opened_at ?? null,
  };
}
