import type { DesktopRoomSnapshot } from "../../ipc-types.js";
import { resolveRoomIdentifier } from "../../repo-status.js";
import { DesktopApiError } from "../auth.js";
import { workspaceRoot } from "../paths.js";
import {
  createLocalRoom,
  cloudRoomIdentifierForStorage,
  listLocalTasks,
  resolveLocalAwareRoomStorageMode,
} from "./local-store.js";
import { getJoinedRoomInfo } from "./room-info.js";
import { desktopSmokeRoomSnapshot, isDesktopSmokeCheck } from "../smoke.js";
import { getLatestLocalChatMessages } from "./messages/local-store.js";
import { fetchRoomSnapshotData } from "./snapshot/fetch-data.js";
import {
  createApiErrorRoomSnapshot,
  createLocalReadyRoomSnapshot,
  createMissingRoomSnapshot,
  createReadyRoomSnapshot,
  createUnavailableRoomSnapshot,
} from "./snapshot/snapshots.js";

export async function fetchRoomSnapshot(
  requestedRoomIdentifier?: string | null,
): Promise<DesktopRoomSnapshot> {
  if (isDesktopSmokeCheck()) {
    return desktopSmokeRoomSnapshot();
  }

  const roomIdentifier =
    requestedRoomIdentifier?.trim() ||
    (await resolveRoomIdentifier(workspaceRoot));

  if (!roomIdentifier) {
    return createMissingRoomSnapshot();
  }

  try {
    const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
    if (storage.effectiveMode === "local") {
      const localRoom = storage.localRoom || await createLocalRoom({
        roomIdentifier,
        displayName: roomIdentifier,
      });
      const visibleRoomIdentifier =
        localRoom.cloudRoomIdentifier || localRoom.roomIdentifier;
      const nextStorage = await resolveLocalAwareRoomStorageMode(
        visibleRoomIdentifier,
      );
      const [tasks, messages] = await Promise.all([
        listLocalTasks(localRoom.roomIdentifier),
        getLatestLocalChatMessages(localRoom.roomIdentifier, {
          limit: 150,
        }).then((page) => page.messages),
      ]);
      return createLocalReadyRoomSnapshot({
        roomIdentifier: visibleRoomIdentifier,
        room: localRoom,
        storage: nextStorage,
        tasks,
        messages,
      });
    }

    const cloudRoomIdentifier = cloudRoomIdentifierForStorage(storage, roomIdentifier);
    const joined = await getJoinedRoomInfo(cloudRoomIdentifier);
    const snapshotData = await fetchRoomSnapshotData(cloudRoomIdentifier);
    return createReadyRoomSnapshot(cloudRoomIdentifier, joined, snapshotData, storage);
  } catch (error) {
    if (error instanceof DesktopApiError) {
      return createApiErrorRoomSnapshot(roomIdentifier, error);
    }
    return createUnavailableRoomSnapshot(roomIdentifier, error);
  }
}
