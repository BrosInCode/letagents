import type {
  DesktopLocalRoomInfo,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopTaskSummary,
} from "../../../ipc-types.js";
import type { DesktopApiError } from "../../auth.js";
import {
  localChatDatabasePath,
  localFilesPath,
} from "../../chat-storage/settings.js";
import {
  createRoomAccess,
  mapDesktopRoomInfoPayload,
  type RoomInfoPayload,
} from "../room-info.js";
import type { RoomMessagePayload } from "../messages/mappers.js";
import { mapRoomMessagePayload } from "../messages/mappers.js";
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
  roomArtifacts: [],
  messages: [],
  githubEvents: null,
};

function cloudStorageState(roomIdentifier: string | null): DesktopRoomStorageState {
  return {
    roomIdentifier,
    defaultMode: "cloud",
    overrideMode: "inherit",
    effectiveMode: "cloud",
    isLocalRoom: false,
    localRoom: null,
    databasePath: localChatDatabasePath,
    localFilesPath,
  };
}

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
    storage: cloudStorageState(null),
    ...emptySnapshotCollections,
  };
}

export function createReadyRoomSnapshot(
  roomIdentifier: string,
  joined: JoinedRoomInfoPayload,
  data: RoomSnapshotData,
  storage: DesktopRoomStorageState = cloudStorageState(roomIdentifier),
): DesktopRoomSnapshot {
  return {
    roomIdentifier,
    access: createRoomAccess({
      status: "ready",
      roomIdentifier,
    }),
    room: mapDesktopRoomInfoPayload(roomIdentifier, joined),
    storage,
    ...mapSnapshotData(data),
  };
}

export function createLocalReadyRoomSnapshot(input: {
  roomIdentifier: string;
  room: DesktopLocalRoomInfo;
  storage: DesktopRoomStorageState;
  tasks: DesktopTaskSummary[];
  messages: RoomMessagePayload[];
}): DesktopRoomSnapshot {
  const joined: RoomInfoPayload = {
    room_id: input.roomIdentifier,
    code: "",
    name: input.room.displayName,
    display_name: input.room.displayName,
    role: "local",
    authenticated: false,
    kind: "main",
    git_room: input.room.gitRoom,
  };
  return {
    roomIdentifier: input.roomIdentifier,
    access: createRoomAccess({
      status: "ready",
      roomIdentifier: input.roomIdentifier,
    }),
    room: mapDesktopRoomInfoPayload(input.roomIdentifier, joined),
    storage: input.storage,
    focusRooms: [],
    tasks: input.tasks,
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    roomArtifacts: [],
    messages: input.messages
      .sort((left, right) =>
        Date.parse(left.timestamp || "") - Date.parse(right.timestamp || "")
      )
      .map(mapRoomMessagePayload),
    githubEvents: null,
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
    storage: cloudStorageState(roomIdentifier),
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
    storage: cloudStorageState(roomIdentifier),
    ...emptySnapshotCollections,
  };
}
