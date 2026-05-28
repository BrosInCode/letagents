import type { DesktopRoomSnapshot } from "../../ipc-types.js";
import { resolveRoomIdentifier } from "../../repo-status.js";
import { DesktopApiError } from "../auth.js";
import { workspaceRoot } from "../paths.js";
import { getJoinedRoomInfo } from "./room-info.js";
import { fetchRoomSnapshotData } from "./snapshot/fetch-data.js";
import {
  createApiErrorRoomSnapshot,
  createMissingRoomSnapshot,
  createReadyRoomSnapshot,
  createUnavailableRoomSnapshot,
} from "./snapshot/snapshots.js";

export async function fetchRoomSnapshot(
  requestedRoomIdentifier?: string | null,
): Promise<DesktopRoomSnapshot> {
  const roomIdentifier =
    requestedRoomIdentifier?.trim() ||
    (await resolveRoomIdentifier(workspaceRoot));

  if (!roomIdentifier) {
    return createMissingRoomSnapshot();
  }

  try {
    const joined = await getJoinedRoomInfo(roomIdentifier);
    const snapshotData = await fetchRoomSnapshotData(roomIdentifier);
    return createReadyRoomSnapshot(roomIdentifier, joined, snapshotData);
  } catch (error) {
    if (error instanceof DesktopApiError) {
      return createApiErrorRoomSnapshot(roomIdentifier, error);
    }
    return createUnavailableRoomSnapshot(roomIdentifier, error);
  }
}
