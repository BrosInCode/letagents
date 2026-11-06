import { isDeepStrictEqual } from "node:util";
import { defaultBoardPlanning, type BoardPlanningSnapshot, type BoardPlanningUpdate } from "../../../../../shared/board-planning.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, getLocalTaskCloudId, listLocalTasks, localRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";
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

/** Copy native planning once after task publication. Existing cloud planning always wins. */
export async function publishLocalBoardPlanning(localRoomId: string, cloudRoomId: string): Promise<string | null> {
  try {
    const local = await getLocalBoardPlanning(localRoomId);
    if (isDeepStrictEqual(local.document, defaultBoardPlanning())) return null;
    const path = `/rooms/${encodeURIComponent(cloudRoomId)}/board-planning`;
    const cloud = await apiFetch<BoardPlanningSnapshot>(path);
    if (!cloud.canEdit) return "Board planning is still local. A room admin can publish it.";

    // Only persisted native metadata crosses rooms. Tracker imports are fetched
    // independently by the cloud connector and are never copied from a cache.
    const document = structuredClone(local.document);
    const localTaskIds = new Set((await listLocalTasks(localRoomId)).map(task => task.id));
    const cloudTaskIds = new Set(cloud.taskFacts.map(task => task.id));
    document.tasks = {};
    for (const [localTaskId, planning] of Object.entries(local.document.tasks)) {
      const cloudTaskId = localTaskIds.has(localTaskId)
        ? await getLocalTaskCloudId({ roomId: localRoomId, taskId: localTaskId }) : null;
      if (!cloudTaskId || !cloudTaskIds.has(cloudTaskId) || Object.hasOwn(document.tasks, cloudTaskId)) {
        return "Board planning is still local because some planned tasks have not been published. Try Publish again after those tasks are available online.";
      }
      document.tasks[cloudTaskId] = planning;
    }
    if (isDeepStrictEqual(cloud.document, document)) return null;
    if (cloud.revision !== 0) return "The cloud board already has its own planning. It was kept unchanged; your local planning is still on this device.";
    await apiFetch<BoardPlanningSnapshot>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, document }),
    });
    return null;
  } catch {
    return "Board planning could not be published. It is still on this device. Try Publish again.";
  }
}
