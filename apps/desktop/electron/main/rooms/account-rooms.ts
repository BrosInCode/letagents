import type {
  DesktopAccountFocusRoomEntry,
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
} from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { desktopSmokeAccountRooms, isDesktopSmokeCheck } from "../smoke.js";

function mapDesktopAccountFocusRoomEntry(
  payload: Record<string, unknown>,
): DesktopAccountFocusRoomEntry {
  const roomIdentifier =
    typeof payload.room_id === "string"
      ? payload.room_id
      : typeof payload.id === "string"
        ? payload.id
        : "";
  return {
    roomIdentifier,
    displayName:
      typeof payload.display_name === "string" && payload.display_name.trim()
        ? payload.display_name
        : roomIdentifier,
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name
        : roomIdentifier,
    kind: "focus",
    parentRoomId:
      typeof payload.parent_room_id === "string"
        ? payload.parent_room_id
        : null,
    focusKey: typeof payload.focus_key === "string" ? payload.focus_key : null,
    sourceTaskId:
      typeof payload.source_task_id === "string"
        ? payload.source_task_id
        : null,
    focusStatus:
      payload.focus_status === "active" || payload.focus_status === "concluded"
        ? payload.focus_status
        : null,
    role: payload.role === "admin" ? "admin" : "participant",
    source: typeof payload.source === "string" ? payload.source : null,
    firstOpenedAt:
      typeof payload.first_opened_at === "string"
        ? payload.first_opened_at
        : null,
    lastOpenedAt:
      typeof payload.last_opened_at === "string"
        ? payload.last_opened_at
        : null,
    latestMessageId:
      typeof payload.latest_message_id === "string"
        ? payload.latest_message_id
        : null,
    latestMessageAt:
      typeof payload.latest_message_at === "string"
        ? payload.latest_message_at
        : null,
  };
}

function mapDesktopAccountRoomEntry(
  payload: Record<string, unknown>,
): DesktopAccountRoomEntry {
  const roomIdentifier =
    typeof payload.room_id === "string"
      ? payload.room_id
      : typeof payload.id === "string"
        ? payload.id
        : "";
  const focusRooms = Array.isArray(payload.focus_rooms)
    ? payload.focus_rooms
        .filter(
          (room): room is Record<string, unknown> =>
            Boolean(room) && typeof room === "object",
        )
        .map(mapDesktopAccountFocusRoomEntry)
        .filter((room) => Boolean(room.roomIdentifier))
    : [];
  return {
    roomIdentifier,
    displayName:
      typeof payload.display_name === "string" && payload.display_name.trim()
        ? payload.display_name
        : roomIdentifier,
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name
        : roomIdentifier,
    kind: "main",
    parentRoomId:
      typeof payload.parent_room_id === "string"
        ? payload.parent_room_id
        : null,
    focusKey: typeof payload.focus_key === "string" ? payload.focus_key : null,
    sourceTaskId:
      typeof payload.source_task_id === "string"
        ? payload.source_task_id
        : null,
    focusStatus:
      payload.focus_status === "active" || payload.focus_status === "concluded"
        ? payload.focus_status
        : null,
    role: payload.role === "admin" ? "admin" : "participant",
    source: typeof payload.source === "string" ? payload.source : null,
    pinned: payload.pinned === true,
    archived: payload.archived === true,
    canLeave: payload.can_leave !== false,
    canDelete: payload.can_delete === true,
    deleteReason:
      typeof payload.delete_reason === "string" ? payload.delete_reason : null,
    firstOpenedAt:
      typeof payload.first_opened_at === "string"
        ? payload.first_opened_at
        : null,
    lastOpenedAt:
      typeof payload.last_opened_at === "string"
        ? payload.last_opened_at
        : null,
    latestMessageId:
      typeof payload.latest_message_id === "string"
        ? payload.latest_message_id
        : null,
    latestMessageAt:
      typeof payload.latest_message_at === "string"
        ? payload.latest_message_at
        : null,
    focusRooms,
  };
}

function mapDesktopAccountRoomActionResult(
  payload: Record<string, unknown>,
): DesktopAccountRoomActionResult {
  const roomIdentifier =
    typeof payload.room_id === "string"
      ? payload.room_id
      : typeof payload.id === "string"
        ? payload.id
        : "";
  return {
    roomIdentifier,
    pinned:
      payload.pinned === true
        ? true
        : payload.pinned === false
          ? false
          : undefined,
    archived:
      payload.archived === true
        ? true
        : payload.archived === false
          ? false
          : undefined,
    deleted: payload.deleted === true ? true : undefined,
  };
}

export async function listDesktopAccountRooms(
  options: DesktopAccountRoomListOptions = {},
): Promise<DesktopAccountRoomEntry[]> {
  if (isDesktopSmokeCheck()) {
    return desktopSmokeAccountRooms().filter((room) => options.includeArchived || !room.archived);
  }

  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.min(options.limit ?? 50, 100))));
  if (options.includeArchived) {
    params.set("include_archived", "true");
  }

  const response = await apiFetch<{ rooms?: unknown[] }>(
    `/account/rooms?${params}`,
  ).catch((error) => {
    if (error instanceof DesktopApiError && error.status === 401)
      return { rooms: [] };
    throw error;
  });
  return (response.rooms || [])
    .filter(
      (room): room is Record<string, unknown> =>
        Boolean(room) && typeof room === "object",
    )
    .map(mapDesktopAccountRoomEntry)
    .filter((room) => Boolean(room.roomIdentifier));
}

export async function updateDesktopAccountRoom(
  roomIdentifier: string,
  updates: { pinned?: boolean; archived?: boolean },
): Promise<DesktopAccountRoomActionResult> {
  const response = await apiFetch<Record<string, unknown>>(
    `/account/rooms/${encodeURIComponent(roomIdentifier)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    },
  );
  return mapDesktopAccountRoomActionResult(response);
}

export async function leaveDesktopAccountRoom(
  roomIdentifier: string,
): Promise<DesktopAccountRoomActionResult> {
  const response = await apiFetch<Record<string, unknown>>(
    `/account/rooms/${encodeURIComponent(roomIdentifier)}/leave`,
    { method: "POST" },
  );
  return mapDesktopAccountRoomActionResult(response);
}

export async function deleteDesktopAccountRoom(
  roomIdentifier: string,
): Promise<DesktopAccountRoomActionResult> {
  const response = await apiFetch<Record<string, unknown>>(
    `/account/rooms/${encodeURIComponent(roomIdentifier)}`,
    { method: "DELETE" },
  );
  return mapDesktopAccountRoomActionResult(response);
}
