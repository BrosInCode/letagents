import { apiFetch, roomPath } from './api'
import type {
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomSettingsPatch,
  RoomInfo,
} from './types'

export function upsertFocusRoomList(
  focusRooms: readonly FocusRoomInfo[],
  focusRoom: FocusRoomInfo,
): FocusRoomInfo[] {
  const idx = focusRooms.findIndex((item) => item.room_id === focusRoom.room_id)
  if (idx < 0) return [...focusRooms, focusRoom]

  const updated = [...focusRooms]
  updated[idx] = focusRoom
  return updated
}

export async function createTaskFocusRoom(
  roomIdentifier: string,
  taskId: string,
): Promise<FocusRoomInfo | null> {
  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/tasks/${encodeURIComponent(taskId)}/focus-room`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  )
  return data.focus_room || null
}

export async function createStandaloneFocusRoom(
  roomIdentifier: string,
  title: string,
): Promise<FocusRoomInfo | null> {
  const data = await apiFetch(`${roomPath(roomIdentifier)}/focus-rooms`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
  return data.focus_room || null
}

export async function concludeFocusRoom(
  parentRoomId: string,
  focusKey: string,
  summary: string,
  conclusionDetails: FocusRoomConclusionDetails | null,
): Promise<{ focusRoom: FocusRoomInfo | null; parentMessagePosted: boolean }> {
  const data = await apiFetch(
    `${roomPath(parentRoomId)}/focus/${encodeURIComponent(focusKey)}/conclude`,
    {
      method: 'POST',
      body: JSON.stringify({
        summary,
        conclusion_details: conclusionDetails,
      }),
    },
  )
  return {
    focusRoom: data.focus_room || data.room || null,
    parentMessagePosted: Boolean(data.message),
  }
}

export async function patchFocusRoomSettings(
  parentRoomId: string,
  focusKey: string,
  settings: FocusRoomSettingsPatch,
): Promise<FocusRoomInfo | null> {
  const data = await apiFetch(
    `${roomPath(parentRoomId)}/focus/${encodeURIComponent(focusKey)}/settings`,
    {
      method: 'PATCH',
      body: JSON.stringify(settings),
    },
  )
  return data.focus_room || null
}

export function applyFocusRoomConclusion(
  room: RoomInfo,
  focusRoom: FocusRoomInfo,
  summary: string,
  conclusionDetails: FocusRoomConclusionDetails | null,
): RoomInfo {
  return {
    ...room,
    displayName: focusRoom.display_name || room.displayName,
    attachmentsEnabled: focusRoom.attachments_enabled ?? room.attachmentsEnabled,
    focusStatus: focusRoom.focus_status || room.focusStatus,
    focusParentVisibility:
      focusRoom.focus_parent_visibility || room.focusParentVisibility,
    focusActivityScope: focusRoom.focus_activity_scope || room.focusActivityScope,
    focusGitHubEventRouting:
      focusRoom.focus_github_event_routing || room.focusGitHubEventRouting,
    concludedAt: focusRoom.concluded_at || room.concludedAt,
    conclusionSummary: focusRoom.conclusion_summary || summary,
    conclusionDetails: focusRoom.conclusion_details || conclusionDetails,
  }
}

export function applyFocusRoomSettings(
  room: RoomInfo,
  focusRoom: FocusRoomInfo,
): RoomInfo {
  return {
    ...room,
    attachmentsEnabled: focusRoom.attachments_enabled ?? room.attachmentsEnabled,
    focusParentVisibility: focusRoom.focus_parent_visibility,
    focusActivityScope: focusRoom.focus_activity_scope,
    focusGitHubEventRouting: focusRoom.focus_github_event_routing,
  }
}
