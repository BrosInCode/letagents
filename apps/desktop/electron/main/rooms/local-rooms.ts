import type {
  DesktopLocalChatSyncResult,
  DesktopLocalRoomMutationResult,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
} from "../../ipc-types.js";
import { setRoomStorageMode } from "../chat-storage/settings.js";
import { importLocalChatMessages } from "./messages/local-store.js";
import {
  createLocalRoom,
  getLocalRoomByCloudRoom,
  importLocalTasks,
  resolveLocalAwareRoomStorageMode,
  setLocalAwareRoomStorageMode,
} from "./local-store.js";
import { getJoinedRoomInfo } from "./room-info.js";
import { syncDesktopLocalChatRoom } from "./messages.js";
import { fetchRoomSnapshot } from "./snapshot.js";
import { fetchRoomSnapshotData } from "./snapshot/fetch-data.js";
import { mapSnapshotData } from "./snapshot/mappers.js";
import { mapDesktopRoomInfoPayload } from "./room-info.js";

export async function getDesktopRoomStorage(
  roomIdentifier: string,
): Promise<DesktopRoomStorageState> {
  return resolveLocalAwareRoomStorageMode(roomIdentifier);
}

export async function setDesktopRoomStorageMode(
  roomIdentifier: string,
  mode: DesktopRoomStorageOverrideMode,
): Promise<DesktopRoomStorageState> {
  return setLocalAwareRoomStorageMode(roomIdentifier, mode);
}

export async function createDesktopLocalRoom(
  input: { displayName?: string | null } = {},
): Promise<DesktopLocalRoomMutationResult> {
  const localRoom = await createLocalRoom({
    displayName: input.displayName || "Local room",
  });
  await setRoomStorageMode(localRoom.roomIdentifier, "local");
  return {
    roomIdentifier: localRoom.roomIdentifier,
    snapshot: await fetchRoomSnapshot(localRoom.roomIdentifier),
  };
}

export async function forkDesktopRoomToLocal(
  roomIdentifier: string,
): Promise<DesktopLocalRoomMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before making a local copy.");
  }
  const joined = await getJoinedRoomInfo(trimmedRoomIdentifier);
  const room = mapDesktopRoomInfoPayload(trimmedRoomIdentifier, joined);
  const data = await fetchRoomSnapshotData(room.identifier, {
    forceCloudMessages: true,
  });
  const mapped = mapSnapshotData(data);
  const localRoom = await getLocalRoomByCloudRoom(room.identifier) ||
    await createLocalRoom({
      displayName: room.displayName,
      cloudRoomIdentifier: room.identifier,
    });
  await importLocalChatMessages(localRoom.roomIdentifier, data.messagesData.messages || []);
  await importLocalTasks(localRoom.roomIdentifier, mapped.tasks);
  await setRoomStorageMode(localRoom.roomIdentifier, "inherit");
  await setRoomStorageMode(room.identifier, "local");
  return {
    roomIdentifier: room.identifier,
    snapshot: await fetchRoomSnapshot(room.identifier),
  };
}

export async function publishDesktopLocalRoom(
  roomIdentifier: string,
): Promise<DesktopLocalChatSyncResult> {
  return syncDesktopLocalChatRoom(roomIdentifier);
}
