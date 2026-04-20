import type { Response } from "express";

import {
  getFocusRoomByKey,
  getOrCreateCanonicalRoom,
  getProjectByCode,
  getProjectById,
  type Project,
} from "./db.js";
import { isInviteCode, normalizeRoomId } from "./room-routing.js";

export function parseFocusRoomLocator(
  roomId: string
): { parentRoomId: string; focusKey: string } | null {
  const marker = "/focus/";
  const index = roomId.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }

  const parentRoomId = roomId.slice(0, index);
  const focusKey = roomId.slice(index + marker.length);
  if (!parentRoomId || !focusKey || focusKey.includes("/")) {
    return null;
  }

  return { parentRoomId, focusKey };
}

export function isReservedRoomId(roomId: string): boolean {
  return /^focus_\d+$/.test(roomId);
}

export async function resolveRoomOrReply(
  roomId: string,
  res: Response,
  { allowCreate }: { allowCreate: boolean } = { allowCreate: false }
): Promise<Project | null> {
  const focusLocator = parseFocusRoomLocator(roomId);
  if (focusLocator) {
    const parentRoomId = await resolveCanonicalRoomRequestId(
      normalizeRoomId(focusLocator.parentRoomId)
    );
    const parent = await getProjectById(parentRoomId);
    if (!parent) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }

    const focusRoom = await getFocusRoomByKey(parent.id, focusLocator.focusKey);
    if (!focusRoom) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return focusRoom;
  }

  // Handle invite codes (e.g., JA0E-4NYO or JA0E-4NYO-L2QP)
  if (isInviteCode(roomId)) {
    const project = await getProjectByCode(roomId);
    if (!project) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return project;
  }

  if (allowCreate) {
    if (isReservedRoomId(roomId)) {
      const found = await getProjectById(roomId);
      if (!found) {
        res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
        return null;
      }
      return found;
    }

    const { room } = await getOrCreateCanonicalRoom(roomId);
    return room;
  }

  const found = await getProjectById(roomId);
  if (!found) {
    res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
    return null;
  }
  return found;
}

export async function resolveCanonicalRoomRequestId(roomId: string): Promise<string> {
  if (isInviteCode(roomId)) {
    return roomId;
  }

  const existing = await getProjectById(roomId);
  return existing?.id ?? roomId;
}
