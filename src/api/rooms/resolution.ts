import type { Response } from "express";

import {
  getFocusRoomByKey,
  getOrCreateCanonicalRoom,
  getProjectByCode,
  getProjectById,
  type Project,
} from "../db.js";
import { getOrCreateGitHubRefRoomFromLocator } from "../github/git-room-routing.js";
import { classifyRoomLocator, isFocusRoomIdShape, isJoinCodeShape, parseFocusRoomLocator } from "./room-nature.js";
import { normalizeRoomId } from "./routing.js";

export function isReservedRoomId(roomId: string): boolean {
  return isFocusRoomIdShape(roomId);
}

export async function resolveExistingRoomRequest(roomId: string): Promise<Project | undefined> {
  const normalizedRoomId = normalizeRoomId(roomId);
  const locator = parseFocusRoomLocator(normalizedRoomId);
  if (!locator) return getProjectById(normalizedRoomId);

  const parent = await getProjectById(normalizeRoomId(locator.parentRoomId));
  return parent ? getFocusRoomByKey(parent.id, locator.focusKey) : undefined;
}

export async function resolveRoomOrReply(
  roomId: string,
  res: Response,
  { allowCreate }: { allowCreate: boolean } = { allowCreate: false }
): Promise<Project | null> {
  const locator = classifyRoomLocator(roomId);
  if (locator.type === "focus_locator") {
    const focusLocator = locator;
    const parentRoomId = await resolveCanonicalRoomRequestId(
      normalizeRoomId(focusLocator.parentRoomId)
    );
    const parent = await getProjectById(parentRoomId);
    if (!parent) {
      const createdGitRefRoom = allowCreate
        ? await getOrCreateGitHubRefRoomFromLocator(roomId)
        : null;
      if (createdGitRefRoom) {
        return createdGitRefRoom;
      }
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }

    const focusRoom = await getFocusRoomByKey(parent.id, focusLocator.focusKey)
      ?? (allowCreate ? await getOrCreateGitHubRefRoomFromLocator(roomId) : null);
    if (!focusRoom) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return focusRoom;
  }

  // Handle invite codes (e.g., JA0E-4NYO or JA0E-4NYO-L2QP)
  if (locator.type === "join_code") {
    const project = await getProjectByCode(roomId);
    if (!project) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return project;
  }

  if (allowCreate) {
    if (locator.type === "reserved") {
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
  if (isJoinCodeShape(roomId)) {
    return roomId;
  }

  const existing = await getProjectById(roomId);
  return existing?.id ?? roomId;
}
