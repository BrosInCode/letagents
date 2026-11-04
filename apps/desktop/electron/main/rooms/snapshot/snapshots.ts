import { roomAccessRefusal } from "../../../../../../shared/room-membership.mjs";
import type {
  DesktopBoardSettingsSummary,
  DesktopLocalRoomInfo,
  DesktopRoomAccess,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopSnapshotSourceStates,
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
import { readRoomJoinRequestSummary } from "../join-request-summary.js";
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
  liveActivitySessions: [],
  recentActivity: [],
  roomArtifacts: [],
  boardSettings: defaultBoardSettings(),
  messages: [],
  githubEvents: null,
  sourceStates: readySourceStates(),
};

function defaultBoardSettings(): DesktopBoardSettingsSummary {
  return {
    managerMode: "manager_optional",
    activeManager: null,
    pendingIntentCount: 0,
  };
}

/**
 * All-ready source states, used for snapshots that are not built from a live
 * fetch (missing/error/unavailable placeholders and local rooms). Consumers
 * treat these as "nothing failed to load".
 */
export function readySourceStates(): DesktopSnapshotSourceStates {
  const ready = () => ({ status: "ready" as const, error: null });
  return {
    focusRooms: ready(),
    tasks: ready(),
    participants: ready(),
    presence: ready(),
    reasoning: ready(),
    activityHistory: ready(),
    roomArtifacts: ready(),
    boardSettings: ready(),
    messages: ready(),
    githubEvents: ready(),
  };
}

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
  participants?: DesktopRoomSnapshot["participants"];
  presence?: DesktopRoomSnapshot["presence"];
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
    participants: input.participants ?? [],
    participantHiddenCount: 0,
    presence: input.presence ?? [],
    reasoningSessions: [],
    liveActivitySessions: [],
    recentActivity: [],
    roomArtifacts: [],
    boardSettings: defaultBoardSettings(),
    messages: input.messages
      .sort((left, right) =>
        Date.parse(left.timestamp || "") - Date.parse(right.timestamp || "")
      )
      .map(mapRoomMessagePayload),
    githubEvents: null,
    sourceStates: readySourceStates(),
  };
}

const API_ERROR_ACCESS_TITLES: Record<DesktopRoomAccess["status"], string> = {
  ready: "Room ready",
  missing_room: "Room unavailable",
  auth_required: "Connect GitHub to open this room",
  forbidden: "This account cannot open the room",
  membership_required: "Ask to join this room",
  repo_collaborator_required: "Only people with a role on the repository can open this room",
  unavailable: "Room unavailable",
};

function apiErrorAccessStatus(error: DesktopApiError): DesktopRoomAccess["status"] {
  const payload = error.payload;
  if (payload?.error === "auth_required") return "auth_required";
  // A signed-in person who is not let in: the card says how to get in.
  const refusal = roomAccessRefusal(payload);
  if (refusal === "membership_required") return "membership_required";
  if (refusal === "repo_collaborator_required") return "repo_collaborator_required";
  if (payload?.error === "private_repo_no_access") return "forbidden";
  return "unavailable";
}

export function createApiErrorRoomSnapshot(
  roomIdentifier: string,
  error: DesktopApiError,
): DesktopRoomSnapshot {
  const payload = error.payload;
  const accessStatus = apiErrorAccessStatus(error);

  return {
    roomIdentifier,
    access: createRoomAccess({
      status: accessStatus,
      // GitHub gave no answer to the role check (503): the app checks again.
      title: payload?.code === "REPO_ACCESS_UNAVAILABLE" ? "GitHub is not answering" : API_ERROR_ACCESS_TITLES[accessStatus],
      message: payload?.message || error.message,
      roomIdentifier: payload?.room_id || roomIdentifier,
      deviceFlowUrl: payload?.device_flow_url || null,
      code: payload?.code || null,
      httpStatus: error.status,
      displayName: accessStatus === "membership_required" ? payload?.display_name || null : null,
      joinRequest: accessStatus === "membership_required" ? readRoomJoinRequestSummary(payload?.join_request) : null,
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
