import type { DesktopRoomAccess, DesktopRoomInfo } from "../../ipc-types.js";
import { apiFetch } from "../auth.js";

export type RoomInfoPayload = {
  room_id?: string;
  code?: string;
  name?: string | null;
  display_name?: string | null;
  role?: string;
  authenticated?: boolean;
  kind?: "main" | "focus";
  parent_room_id?: string | null;
  focus_key?: string | null;
  source_task_id?: string | null;
  focus_status?: "active" | "concluded" | null;
};

const joinedRoomInfoCache = new Map<string, RoomInfoPayload>();

export function createRoomAccess(
  input: Partial<DesktopRoomAccess>,
): DesktopRoomAccess {
  return {
    status: input.status || "ready",
    title: input.title || "Room ready",
    message: input.message || "",
    roomIdentifier: input.roomIdentifier || null,
    deviceFlowUrl: input.deviceFlowUrl || null,
    code: input.code || null,
    httpStatus: input.httpStatus || null,
  };
}

function roomInfoCacheKey(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function rememberJoinedRoomInfo(
  requestedRoomIdentifier: string,
  payload: RoomInfoPayload,
): void {
  const keys = [
    requestedRoomIdentifier,
    payload.room_id,
    payload.name,
    payload.code,
  ]
    .map(roomInfoCacheKey)
    .filter((key): key is string => Boolean(key));
  for (const key of keys) {
    joinedRoomInfoCache.set(key, payload);
  }
}

export async function getJoinedRoomInfo(
  roomIdentifier: string,
): Promise<RoomInfoPayload> {
  const cacheKey = roomInfoCacheKey(roomIdentifier);
  const cached = cacheKey ? joinedRoomInfoCache.get(cacheKey) : null;
  if (cached) return cached;

  const joined = await apiFetch<RoomInfoPayload>(
    `/rooms/${encodeURIComponent(roomIdentifier)}/join`,
    {
      method: "POST",
    },
  );
  rememberJoinedRoomInfo(roomIdentifier, joined);
  return joined;
}

export function mapDesktopRoomInfoPayload(
  requestedRoomIdentifier: string,
  payload: RoomInfoPayload,
): DesktopRoomInfo {
  const canonicalIdentifier = payload.room_id || requestedRoomIdentifier;
  return {
    identifier: canonicalIdentifier,
    code: payload.code || "",
    name: payload.name || canonicalIdentifier,
    displayName: payload.display_name || payload.name || canonicalIdentifier,
    role: payload.role || "participant",
    authenticated: Boolean(payload.authenticated),
    kind: payload.kind || "main",
    parentRoomId: payload.parent_room_id || null,
    focusKey: payload.focus_key || null,
    sourceTaskId: payload.source_task_id || null,
    focusStatus: payload.focus_status || null,
  };
}

export function clearJoinedRoomInfoCache(): void {
  joinedRoomInfoCache.clear();
}
