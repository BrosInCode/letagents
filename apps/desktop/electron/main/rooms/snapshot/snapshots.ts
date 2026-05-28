import type { DesktopRoomSnapshot } from "../../../ipc-types.js";
import type { DesktopApiError } from "../../auth.js";
import {
  createRoomAccess,
  mapDesktopRoomInfoPayload,
} from "../room-info.js";
import { mapSnapshotData } from "./mappers.js";
import type { RoomSnapshotData } from "./payloads.js";

type JoinedRoomInfoPayload = Parameters<typeof mapDesktopRoomInfoPayload>[1];

const emptySnapshotCollections = {
  focusRooms: [],
  tasks: [],
  participants: [],
  participantHiddenCount: 0,
  presence: [],
  reasoningSessions: [],
  recentActivity: [],
  messages: [],
};

export function createMissingRoomSnapshot(): DesktopRoomSnapshot {
  return {
    roomIdentifier: null,
    access: createRoomAccess({
      status: "missing_room",
      title: "Choose a room to begin",
      message:
        "LetAgents could not find a room from this folder yet. Create or join a room to continue.",
    }),
    room: null,
    ...emptySnapshotCollections,
  };
}

export function createReadyRoomSnapshot(
  roomIdentifier: string,
  joined: JoinedRoomInfoPayload,
  data: RoomSnapshotData,
): DesktopRoomSnapshot {
  return {
    roomIdentifier,
    access: createRoomAccess({
      status: "ready",
      roomIdentifier,
    }),
    room: mapDesktopRoomInfoPayload(roomIdentifier, joined),
    ...mapSnapshotData(data),
  };
}

export function createApiErrorRoomSnapshot(
  roomIdentifier: string,
  error: DesktopApiError,
): DesktopRoomSnapshot {
  const payload = error.payload;
  const accessStatus =
    payload?.error === "auth_required"
      ? "auth_required"
      : payload?.error === "private_repo_no_access"
        ? "forbidden"
        : "unavailable";

  return {
    roomIdentifier,
    access: createRoomAccess({
      status: accessStatus,
      title:
        accessStatus === "auth_required"
          ? "Connect GitHub to open this room"
          : accessStatus === "forbidden"
            ? "This account cannot open the room"
            : "Room unavailable",
      message: payload?.message || error.message,
      roomIdentifier: payload?.room_id || roomIdentifier,
      deviceFlowUrl: payload?.device_flow_url || null,
      code: payload?.code || null,
      httpStatus: error.status,
    }),
    room: null,
    ...emptySnapshotCollections,
  };
}

export function createUnavailableRoomSnapshot(
  roomIdentifier: string,
  error: unknown,
): DesktopRoomSnapshot {
  return {
    roomIdentifier,
    access: createRoomAccess({
      status: "unavailable",
      title: "Room unavailable",
      message:
        error instanceof Error
          ? error.message
          : "LetAgents could not load this room.",
      roomIdentifier,
    }),
    room: null,
    ...emptySnapshotCollections,
  };
}
