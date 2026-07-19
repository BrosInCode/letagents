import type {
  DesktopRoomLiveMetadata,
  DesktopSnapshotSourceState,
} from "../../../ipc-types.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "../local-store.js";
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
 * Local rooms carry no cloud presence/participants/focus/activity/board data —
 * the full local snapshot returns empties for exactly these sections — so the
 * metadata fetch returns the same empties, keeping the renderer's periodic-tick
 * path uniform (no local/cloud branching) while leaving the local room's
 * already-loaded messages and tasks untouched by the apply.
 */
export async function fetchRoomLiveMetadata(
  roomIdentifier: string,
): Promise<DesktopRoomLiveMetadata> {
  if (isDesktopSmokeCheck()) {
    return emptyRoomLiveMetadata(roomIdentifier.trim() || null);
  }

  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return emptyRoomLiveMetadata(null);

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    return emptyRoomLiveMetadata(trimmedRoomIdentifier);
  }

  const apiRoomIdentifier = cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);
  const [focusRooms, participants, presence, activityHistory, boardSettings] = await Promise.all([
    loadFocusRooms(apiRoomIdentifier),
    loadParticipants(apiRoomIdentifier),
    loadPresence(apiRoomIdentifier),
    loadActivityHistory(apiRoomIdentifier),
    loadBoardSettings(apiRoomIdentifier),
  ]);

  return buildRoomLiveMetadata(apiRoomIdentifier, {
    focusRooms,
    participants,
    presence,
    activityHistory,
    boardSettings,
  });
}

/**
 * Pure assembly of the poll-only metadata from already-loaded sources. Reuses
 * the exact snapshot mappers so a section maps identically to a full snapshot
 * rebuild, and preserves each source's per-source `state` verbatim so one
 * degraded section (fallback data + "error" state) is reported honestly to the
 * renderer instead of being silently dropped.
 */
export function buildRoomLiveMetadata(
  roomIdentifier: string | null,
  sources: RoomLiveMetadataSources,
): DesktopRoomLiveMetadata {
  return {
    roomIdentifier,
    focusRooms: mapFocusRooms(sources.focusRooms.data),
    participants: mapParticipants(sources.participants.data),
    participantHiddenCount: Number(sources.participants.data.hidden_count || 0),
    presence: mapPresence(sources.presence.data),
    recentActivity: mapRecentActivity(sources.activityHistory.data),
    boardSettings: mapBoardSettings(sources.boardSettings.data),
    sourceStates: {
      focusRooms: sources.focusRooms.state,
      participants: sources.participants.state,
      presence: sources.presence.state,
      activityHistory: sources.activityHistory.state,
      boardSettings: sources.boardSettings.state,
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
