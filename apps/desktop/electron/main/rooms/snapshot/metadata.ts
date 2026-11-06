import { readLocalSupervisorPresence } from "../local-supervision-authority.js";
import type {
  DesktopRoomLiveMetadata,
  DesktopRoomLiveMetadataOptions,
  DesktopRoomLiveMetadataSourceKey,
  DesktopSnapshotSourceState,
} from "../../../ipc-types.js";
import { localRoomIdentifierForStorage, cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "../local-store.js";
import { isDesktopSmokeCheck } from "../../smoke.js";
import {
  loadActivityHistory,
  loadBoardSettings,
  loadFocusRooms,
  loadParticipants,
  loadPresence,
} from "./fetch-data.js";
import {
  mapBoardSettings,
  mapFocusRooms,
  mapParticipants,
  mapPresence,
  mapRecentActivity,
} from "./mappers.js";
import type {
  ActivityHistoryResponse,
  BoardSettingsResponse,
  FocusRoomsResponse,
  ParticipantsResponse,
  PresenceResponse,
} from "./payloads.js";

type LoadedSource<T> = { data: T; state: DesktopSnapshotSourceState };

export interface RoomLiveMetadataSources {
  focusRooms: LoadedSource<FocusRoomsResponse>;
  participants: LoadedSource<ParticipantsResponse>;
  presence: LoadedSource<PresenceResponse>;
  activityHistory: LoadedSource<ActivityHistoryResponse>;
  boardSettings: LoadedSource<BoardSettingsResponse>;
}

/**
 * Fetch the poll-only room metadata — focus rooms, participants, presence,
 * recent activity, and board settings. This is the lightweight counterpart to
 * `fetchRoomSnapshotData`: it hits only the five endpoints the server pushes no
 * events for, skipping the ~10 requests (150 messages + thread expansion,
 * unbounded task drain, reasoning, artifacts, GitHub events) a full snapshot
 * rebuild pulls. Every other room section is event-fed after PR #823, so the
 * periodic refresh no longer needs to re-download it.
 *
 * Local rooms read the daemon's local agent observations. No cloud authority
 * is needed, and messages and tasks stay untouched by this metadata refresh.
 *
 * A caller that needs only some of the five can name them in `options.include`.
 * The other sources are then not requested; their sections keep the empty values
 * and ready states of `emptyRoomLiveMetadata`, so the result shape is the same.
 * No option, or no known source name in it, fetches all five.
 */
export async function fetchRoomLiveMetadata(
  roomIdentifier: string,
  options?: DesktopRoomLiveMetadataOptions,
): Promise<DesktopRoomLiveMetadata> {
  if (isDesktopSmokeCheck()) {
    return emptyRoomLiveMetadata(roomIdentifier.trim() || null);
  }

  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return emptyRoomLiveMetadata(null);

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    return { ...emptyRoomLiveMetadata(trimmedRoomIdentifier),
      ...await readLocalSupervisorPresence(localRoomIdentifierForStorage(storage, trimmedRoomIdentifier)) };
  }

  const apiRoomIdentifier = cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);
  const included = requestedLiveMetadataSources(options);
  const wants = (source: DesktopRoomLiveMetadataSourceKey) => included.has(source);
  const [focusRooms, participants, presence, activityHistory, boardSettings] = await Promise.all([
    wants("focusRooms") ? loadFocusRooms(apiRoomIdentifier) : undefined,
    wants("participants") ? loadParticipants(apiRoomIdentifier) : undefined,
    wants("presence") ? loadPresence(apiRoomIdentifier) : undefined,
    wants("activityHistory") ? loadActivityHistory(apiRoomIdentifier) : undefined,
    wants("boardSettings") ? loadBoardSettings(apiRoomIdentifier) : undefined,
  ]);

  return buildRoomLiveMetadata(apiRoomIdentifier, {
    focusRooms,
    participants,
    presence,
    activityHistory,
    boardSettings,
  });
}

const ALL_LIVE_METADATA_SOURCES: readonly DesktopRoomLiveMetadataSourceKey[] = [
  "focusRooms",
  "participants",
  "presence",
  "activityHistory",
  "boardSettings",
];

/** The renderer sends this option over IPC, so read it as untrusted input. */
function requestedLiveMetadataSources(
  options: DesktopRoomLiveMetadataOptions | undefined,
): ReadonlySet<DesktopRoomLiveMetadataSourceKey> {
  const include = Array.isArray(options?.include) ? options.include : [];
  const known = ALL_LIVE_METADATA_SOURCES.filter((source) => include.includes(source));
  return new Set(known.length ? known : ALL_LIVE_METADATA_SOURCES);
}

/**
 * Pure assembly of the poll-only metadata from already-loaded sources. Reuses
 * the exact snapshot mappers so a section maps identically to a full snapshot
 * rebuild, and preserves each source's per-source `state` verbatim so one
 * degraded section (fallback data + "error" state) is reported honestly to the
 * renderer instead of being silently dropped. A source that was not loaded
 * keeps the empty section and ready state of `emptyRoomLiveMetadata`.
 */
export function buildRoomLiveMetadata(
  roomIdentifier: string | null,
  sources: Partial<RoomLiveMetadataSources>,
): DesktopRoomLiveMetadata {
  const empty = emptyRoomLiveMetadata(roomIdentifier);
  return {
    roomIdentifier,
    focusRooms: sources.focusRooms ? mapFocusRooms(sources.focusRooms.data) : empty.focusRooms,
    participants: sources.participants ? mapParticipants(sources.participants.data) : empty.participants,
    participantHiddenCount: sources.participants
      ? Number(sources.participants.data.hidden_count || 0)
      : empty.participantHiddenCount,
    presence: sources.presence ? mapPresence(sources.presence.data) : empty.presence,
    recentActivity: sources.activityHistory ? mapRecentActivity(sources.activityHistory.data) : empty.recentActivity,
    boardSettings: sources.boardSettings ? mapBoardSettings(sources.boardSettings.data) : empty.boardSettings,
    sourceStates: {
      focusRooms: sources.focusRooms?.state ?? empty.sourceStates.focusRooms,
      participants: sources.participants?.state ?? empty.sourceStates.participants,
      presence: sources.presence?.state ?? empty.sourceStates.presence,
      activityHistory: sources.activityHistory?.state ?? empty.sourceStates.activityHistory,
      boardSettings: sources.boardSettings?.state ?? empty.sourceStates.boardSettings,
    },
  };
}

function ready(): DesktopSnapshotSourceState {
  return { status: "ready", error: null };
}

/**
 * Empty poll-only metadata with all-ready source states — used for local rooms
 * and blank identifiers, mirroring the empty poll-only sections a local room's
 * full snapshot produces. Applying this over an existing snapshot is a no-op
 * for those sections (they were already empty) and never blanks event-fed data.
 */
export function emptyRoomLiveMetadata(roomIdentifier: string | null): DesktopRoomLiveMetadata {
  return {
    roomIdentifier,
    focusRooms: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    recentActivity: [],
    boardSettings: {
      managerMode: "manager_optional",
      activeManager: null,
      pendingIntentCount: 0,
    },
    sourceStates: {
      focusRooms: ready(),
      participants: ready(),
      presence: ready(),
      activityHistory: ready(),
      boardSettings: ready(),
    },
  };
}
