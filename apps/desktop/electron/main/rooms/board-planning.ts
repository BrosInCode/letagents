import type { BoardPlanningSnapshot, BoardPlanningUpdate } from "../../../../../shared/board-planning.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, localRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";
import { getLocalBoardPlanning, updateLocalBoardPlanning } from "./local-board-planning.js";

export async function getDesktopBoardPlanning(roomIdentifier: string): Promise<BoardPlanningSnapshot> {
  if (!roomIdentifier?.trim()) throw new Error("Choose a room before opening its board.");
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  if (storage.effectiveMode === "local") return getLocalBoardPlanning(localRoomIdentifierForStorage(storage, roomIdentifier));
  return apiFetch<BoardPlanningSnapshot>(`/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, roomIdentifier))}/board-planning`);
}

export async function updateDesktopBoardPlanning(roomIdentifier: string, input: BoardPlanningUpdate): Promise<BoardPlanningSnapshot> {
  if (!roomIdentifier?.trim()) throw new Error("Choose a room before changing its board.");
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  if (storage.effectiveMode === "local") return updateLocalBoardPlanning(localRoomIdentifierForStorage(storage, roomIdentifier), input);
  return apiFetch<BoardPlanningSnapshot>(`/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, roomIdentifier))}/board-planning`, {
    method: "PATCH", body: JSON.stringify(input),
  });
}
