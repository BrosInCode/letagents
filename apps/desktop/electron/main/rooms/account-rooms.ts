import type {
  DesktopAccountFocusRoomEntry,
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
} from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { setRoomStorageMode } from "../chat-storage/settings.js";
import { desktopSmokeAccountRooms, isDesktopSmokeCheck } from "../smoke.js";
import {
  archiveLocalRoom,
  getLocalRoom,
  getLocalRoomByCloudRoom,
  getLocalRoomByCloudRoomIncludingArchived,
  getLocalRoomIncludingArchived,
  listLocalRoomEntries,
  setLocalRoomArchived,
  setLocalRoomPinned,
} from "./local-store.js";
import { mergeDesktopAccountRoomEntries } from "./account-room-list.js";
import { mapDesktopGitRoomPayload } from "./git-room.js";

type AccountLocalRoom = {
  roomIdentifier: string;
  cloudRoomIdentifier?: string | null;
};

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
    gitRoom: mapDesktopGitRoomPayload(payload.git_room),
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
    gitRoom: mapDesktopGitRoomPayload(payload.git_room),
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

async function fetchDesktopAccountRooms(input: {
  includeArchived: boolean;
  limit: number;
}): Promise<DesktopAccountRoomEntry[]> {
  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.min(input.limit, 100))));
  params.set("include_archived", input.includeArchived ? "true" : "false");

  const response = await apiFetch<{ rooms?: unknown[] }>(
    `/account/rooms?${params}`,
  ).catch((error) => {
    if (error instanceof DesktopApiError && error.status === 401)
      return { rooms: [] };
    throw error;
  });
  const cloudRooms = (response.rooms || [])
    .filter(
      (room): room is Record<string, unknown> =>
        Boolean(room) && typeof room === "object",
    )
    .map(mapDesktopAccountRoomEntry)
    .filter((room) => Boolean(room.roomIdentifier));
  // The server is authoritative for cloud rooms' pinned/archived flags, so we
  // display cloud entries verbatim (no local-store overlay). Only rooms with no
  // server copy — local-only rooms not present in the cloud list — are appended
  // from the local store.
  const localRooms = await listLocalRoomEntries({ linkedIdentity: "cloud" });
  const seen = new Set(cloudRooms.map((room) => room.roomIdentifier));
  const visibleLocalRooms: DesktopAccountRoomEntry[] = [];
  for (const room of localRooms) {
    if (seen.has(room.roomIdentifier)) continue;
    seen.add(room.roomIdentifier);
    visibleLocalRooms.push(room);
  }
  return [
    ...visibleLocalRooms,
    ...cloudRooms,
  ];
}

export async function listDesktopAccountRooms(
  options: DesktopAccountRoomListOptions = {},
): Promise<DesktopAccountRoomEntry[]> {
  if (isDesktopSmokeCheck()) {
    return desktopSmokeAccountRooms().filter((room) => options.includeArchived || !room.archived);
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  // A single fetch honoring the requested include_archived. The former
  // fetch-twice-and-splice-archived dance only existed to reconcile the local
  // overlay; with the server authoritative for cloud rooms there is nothing to
  // reconcile.
  const cloudRooms = await fetchDesktopAccountRooms({
    includeArchived: options.includeArchived === true,
    limit,
  });
  const localRooms = await listLocalRoomEntries({
    includeArchived: options.includeArchived,
    linkedIdentity: "cloud",
  });
  return mergeDesktopAccountRoomEntries(cloudRooms, localRooms, options);
}

export async function updateDesktopAccountRoom(
  roomIdentifier: string,
  updates: { pinned?: boolean; archived?: boolean },
): Promise<DesktopAccountRoomActionResult> {
  if (updates.pinned === undefined && updates.archived === undefined) {
    throw new Error("No supported room update was requested.");
  }
  const exactLocalRoom = await getLocalRoomIncludingArchived(roomIdentifier);
  const linkedLocalRoom =
    exactLocalRoom ||
    await getLocalRoomByCloudRoomIncludingArchived(roomIdentifier);

  async function updateLocalRoom(): Promise<DesktopAccountRoomActionResult | null> {
    if (!linkedLocalRoom) return null;
    const localRoomIdentifier = linkedLocalRoom.roomIdentifier;
    let updated = false;
    if (updates.pinned !== undefined) {
      updated = await setLocalRoomPinned(localRoomIdentifier, updates.pinned) || updated;
    }
    if (updates.archived !== undefined) {
      updated = await setAccountLocalRoomArchived(
        localRoomIdentifier,
        updates.archived,
        linkedLocalRoom,
      ) || updated;
    }
    if (!updated) return null;
    return {
      roomIdentifier: linkedLocalRoom.cloudRoomIdentifier || linkedLocalRoom.roomIdentifier || roomIdentifier,
      ...(updates.pinned !== undefined ? { pinned: updates.pinned } : {}),
      ...(updates.archived !== undefined ? { archived: updates.archived } : {}),
    };
  }
  // Pure local-only room (a local record with no cloud link): there is no
  // server copy, so the local store is the single source of truth.
  if (exactLocalRoom && !exactLocalRoom.cloudRoomIdentifier) {
    const localResult = await updateLocalRoom();
    return (
      localResult ?? {
        roomIdentifier: exactLocalRoom.roomIdentifier,
        ...(updates.pinned !== undefined ? { pinned: updates.pinned } : {}),
        ...(updates.archived !== undefined ? { archived: updates.archived } : {}),
      }
    );
  }

  // Cloud room or cloud-linked local room: the server is authoritative. PATCH
  // is the real write and its failure propagates — no silent local-only
  // fallback that would let the two copies drift. A linked room may be
  // addressed by its LOCAL id; the server only knows the cloud id, so resolve
  // through the link before PATCHing.
  const cloudRoomIdentifier =
    linkedLocalRoom?.cloudRoomIdentifier || roomIdentifier;
  const response = await apiFetch<Record<string, unknown>>(
    `/account/rooms/${encodeURIComponent(cloudRoomIdentifier)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    },
  );
  // Mirror the server's flags into the linked local record AFTER a successful
  // PATCH. This is not a second source of truth: when signed out/offline the
  // cloud fetch returns nothing and linked rooms surface purely from
  // listLocalRoomEntries, so the mirror keeps that offline list showing the
  // last-known server flags instead of stale ones. Online, the merge always
  // prefers the cloud entry, so the mirror is never consulted.
  if (linkedLocalRoom) {
    if (updates.archived !== undefined) {
      await setAccountLocalRoomArchived(
        linkedLocalRoom.roomIdentifier,
        updates.archived,
        linkedLocalRoom,
      );
    }
    if (updates.pinned !== undefined) {
      await setLocalRoomPinned(linkedLocalRoom.roomIdentifier, updates.pinned);
    }
  }
  return mapDesktopAccountRoomActionResult(response);
}

export async function leaveDesktopAccountRoom(
  roomIdentifier: string,
): Promise<DesktopAccountRoomActionResult> {
  const localRoom = await getLocalRoom(roomIdentifier)
    || await getLocalRoomByCloudRoom(roomIdentifier);
  if (localRoom) {
    await archiveAccountLocalRoom(localRoom);
    return {
      roomIdentifier: localRoom.cloudRoomIdentifier || localRoom.roomIdentifier,
      archived: true,
    };
  }
  const response = await apiFetch<Record<string, unknown>>(
    `/account/rooms/${encodeURIComponent(roomIdentifier)}/leave`,
    { method: "POST" },
  );
  return mapDesktopAccountRoomActionResult(response);
}

export async function deleteDesktopAccountRoom(
  roomIdentifier: string,
): Promise<DesktopAccountRoomActionResult> {
  const localRoom = await getLocalRoom(roomIdentifier)
    || await getLocalRoomByCloudRoom(roomIdentifier);
  if (localRoom) {
    await archiveAccountLocalRoom(localRoom);
    return {
      roomIdentifier: localRoom.cloudRoomIdentifier || localRoom.roomIdentifier,
      archived: true,
      deleted: true,
    };
  }
  const response = await apiFetch<Record<string, unknown>>(
    `/account/rooms/${encodeURIComponent(roomIdentifier)}`,
    { method: "DELETE" },
  );
  return mapDesktopAccountRoomActionResult(response);
}

async function setAccountLocalRoomArchived(
  roomIdentifier: string,
  archived: boolean,
  localRoom: AccountLocalRoom | null,
): Promise<boolean> {
  const updated = await setLocalRoomArchived(roomIdentifier, archived);
  if (updated && archived && localRoom) await clearArchivedLinkedLocalOverrides(localRoom);
  return updated;
}

async function archiveAccountLocalRoom(localRoom: AccountLocalRoom): Promise<void> {
  await archiveLocalRoom(localRoom.roomIdentifier);
  await clearArchivedLinkedLocalOverrides(localRoom);
}

async function clearArchivedLinkedLocalOverrides(localRoom: AccountLocalRoom): Promise<void> {
  await setRoomStorageMode(localRoom.roomIdentifier, "inherit");
  if (localRoom.cloudRoomIdentifier) {
    await setRoomStorageMode(localRoom.cloudRoomIdentifier, "cloud");
  }
}
