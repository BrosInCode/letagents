import {
  applyFocusRoomConclusion,
  applyFocusRoomSettings,
  concludeFocusRoom,
  createStandaloneFocusRoom,
  createTaskFocusRoom,
  patchFocusRoomSettings,
} from './focusRooms'
import { room, upsertFocusRoom } from './state'
import type {
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomSettingsPatch,
} from './types'

export function createRoomFocusActions() {
  async function createFocusRoom(
    taskId: string,
  ): Promise<FocusRoomInfo | null> {
    if (!room.value) return null
    try {
      const focusRoom = await createTaskFocusRoom(room.value.identifier, taskId)
      if (!focusRoom?.room_id) return null
      upsertFocusRoom(focusRoom)
      return focusRoom
    } catch {
      return null
    }
  }

  async function createAdHocFocusRoom(
    title: string,
  ): Promise<FocusRoomInfo | null> {
    if (!room.value) return null
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return null

    try {
      const focusRoom = await createStandaloneFocusRoom(
        room.value.identifier,
        trimmedTitle,
      )
      if (!focusRoom?.room_id) return null
      upsertFocusRoom(focusRoom)
      return focusRoom
    } catch {
      return null
    }
  }

  async function shareFocusRoomResult(
    summary: string,
    conclusionDetails: FocusRoomConclusionDetails | null = null,
  ): Promise<{ focusRoom: FocusRoomInfo; parentMessagePosted: boolean } | null> {
    if (!room.value || room.value.kind !== 'focus') return null
    const trimmedSummary = summary.trim()
    const parentRoomId = room.value.parentRoomId
    const focusKey = room.value.focusKey || room.value.sourceTaskId
    if (!trimmedSummary || !parentRoomId || !focusKey) return null

    try {
      const result = await concludeFocusRoom(
        parentRoomId,
        focusKey,
        trimmedSummary,
        conclusionDetails,
      )
      const focusRoom = result.focusRoom
      if (!focusRoom?.room_id) return null

      upsertFocusRoom(focusRoom)
      room.value = applyFocusRoomConclusion(
        room.value,
        focusRoom,
        trimmedSummary,
        conclusionDetails,
      )

      return {
        focusRoom,
        parentMessagePosted: result.parentMessagePosted,
      }
    } catch {
      return null
    }
  }

  async function updateFocusRoomSettings(
    focusKey: string,
    settings: FocusRoomSettingsPatch,
  ): Promise<FocusRoomInfo | null> {
    if (!room.value) return null
    const parentRoomId =
      room.value.kind === 'focus'
        ? room.value.parentRoomId
        : room.value.identifier
    if (!parentRoomId || !focusKey) return null

    try {
      const focusRoom = await patchFocusRoomSettings(
        parentRoomId,
        focusKey,
        settings,
      )
      if (!focusRoom?.room_id) return null

      upsertFocusRoom(focusRoom)
      if (
        room.value.kind === 'focus' &&
        room.value.projectId === focusRoom.room_id
      ) {
        room.value = applyFocusRoomSettings(room.value, focusRoom)
      }

      return focusRoom
    } catch {
      return null
    }
  }

  return {
    createAdHocFocusRoom,
    createFocusRoom,
    shareFocusRoomResult,
    updateFocusRoomSettings,
  }
}
