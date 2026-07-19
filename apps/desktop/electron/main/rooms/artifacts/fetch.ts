import type { DesktopRoomSharedArtifact } from "../../../ipc-types.js";
import { apiFetch } from "../../auth.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "../local-store.js";
import { mapRoomArtifacts } from "../snapshot/mappers.js";
import type { RoomArtifactsResponse } from "../snapshot/payloads.js";
import { getLocalRoomArtifacts } from "./local-store.js";

/**
 * Narrow artifacts-only refetch used to reconcile after an `artifact_update`
 * SSE frame, which carries only an identity-key pointer. Mirrors the artifacts
 * source in `fetchRoomSnapshotData` (local branch via `getLocalRoomArtifacts`,
 * cloud branch via the `/artifacts` endpoint) and reuses `mapRoomArtifacts` so
 * the result is identical to what a full snapshot rebuild would produce — but
 * without the ~10 parallel requests of a full room-snapshot fetch.
 */
export async function getDesktopRoomArtifacts(
  roomIdentifier: string,
): Promise<DesktopRoomSharedArtifact[]> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return [];

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  const response: RoomArtifactsResponse = storage.effectiveMode === "local"
    ? await getLocalRoomArtifacts(
        localRoomIdentifierForStorage(storage, trimmedRoomIdentifier),
        { limit: 100 },
      )
    : await apiFetch<RoomArtifactsResponse>(
        `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier))}/artifacts?limit=100`,
      );
  return mapRoomArtifacts(response);
}
