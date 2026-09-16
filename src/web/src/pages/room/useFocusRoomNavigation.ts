import { ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Router } from 'vue-router'
import type {
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomSettingsPatch,
  RoomInfo,
} from '@/composables/useRoom'
import {
  buildDirectRoomPath,
  buildFocusRoomPath,
  buildRoomSharePath,
} from '../../domain/roomRoutes'
import { roomDisplayTitle } from '../../../../../shared/rooms/directory'
interface RoomToast {
  error(message: string): void
  info(message: string): void
  success(message: string): void
}

export function useFocusRoomNavigation(input: {
  router: Router
  room: Readonly<Ref<RoomInfo | null>>
  focusParentAddress: ComputedRef<string>
  toast: RoomToast
  showRoomsTab(): void
  createFocusRoom(taskId: string): Promise<FocusRoomInfo | null>
  createAdHocFocusRoom(title: string): Promise<FocusRoomInfo | null>
  shareFocusRoomResult(
    summary: string,
    conclusionDetails: FocusRoomConclusionDetails | null,
  ): Promise<{ parentMessagePosted: boolean } | null>
  updateFocusRoomSettings(
    focusKey: string,
    settings: FocusRoomSettingsPatch,
  ): Promise<FocusRoomInfo | null>
}) {
  const focusDraftTaskId = ref<string | null>(null)
  const creatingFocusRoomTaskId = ref<string | null>(null)
  const creatingAdHocFocusRoom = ref(false)
  const sharingFocusResult = ref(false)
  const updatingFocusSettings = ref(false)
  const creationError = ref<string | null>(null)
  const createdRoom = ref<{ id: string; title: string } | null>(null)
  let pendingCreation: { key: string; path: string } | null = null
  let generation = 0
  watch(
    () => input.room.value?.identifier,
    () => {
      generation++
      focusDraftTaskId.value = null
      creatingFocusRoomTaskId.value = null
      creatingAdHocFocusRoom.value = false
      sharingFocusResult.value = false
      updatingFocusSettings.value = false
      creationError.value = null
      createdRoom.value = null
      pendingCreation = null
    },
    { flush: 'sync' },
  )

  function roomPath(room: FocusRoomInfo): string {
    return buildRoomSharePath({
      identifier: room.room_id,
      kind: 'focus',
      parentRoomId: room.parent_room_id || input.focusParentAddress.value,
      focusKey: room.focus_key,
      sourceTaskId: room.source_task_id,
    })
  }
  async function openPath(path: string): Promise<boolean> {
    if (!path) return false
    try {
      // Vue Router resolves aborted navigations with a failure value.
      return !(await input.router.push(path))
    } catch {
      return false
    }
  }
  async function handleOpenFocusRoom(focusKey: string): Promise<boolean> {
    const version = generation
    const path = focusKey.startsWith('focus_')
      ? buildDirectRoomPath(focusKey)
      : buildFocusRoomPath({
          parentRoomId: input.focusParentAddress.value,
          focusKey,
        })
    const opened = await openPath(path)
    if (!opened && generation === version)
      input.toast.error('Could not open the room. Try again.')
    return opened
  }
  async function handleOpenParentRoom() {
    if (!input.focusParentAddress.value) return
    const opened = await openPath(
      buildDirectRoomPath(input.focusParentAddress.value),
    )
    if (!opened) input.toast.error('Could not open the main room. Try again.')
  }
  async function retryCreatedRoom() {
    if (
      !pendingCreation ||
      creatingAdHocFocusRoom.value ||
      creatingFocusRoomTaskId.value
    )
      return
    const version = generation
    creatingAdHocFocusRoom.value = true
    const opened = await openPath(pendingCreation.path)
    if (version !== generation) return
    creatingAdHocFocusRoom.value = false
    creationError.value = opened
      ? null
      : 'Your room was created, but could not be opened. Try opening it again.'
  }
  async function createAndOpen(kind: 'task' | 'topic', value: string) {
    if (creatingAdHocFocusRoom.value || creatingFocusRoomTaskId.value) return
    if (!input.room.value || input.room.value.kind === 'focus') {
      input.toast.info('Create new rooms from the main room.')
      return
    }
    const key = `${kind}:${value}`
    if (pendingCreation?.key === key) {
      await retryCreatedRoom()
      return
    }
    const version = generation
    creationError.value = null
    createdRoom.value = null
    pendingCreation = null
    if (kind === 'task') {
      focusDraftTaskId.value = value
      creatingFocusRoomTaskId.value = value
    } else creatingAdHocFocusRoom.value = true
    let saved = false
    try {
      const result =
        kind === 'task'
          ? await input.createFocusRoom(value)
          : await input.createAdHocFocusRoom(value)
      if (version !== generation) return
      if (!result) throw new Error('Room creation failed')
      saved = true
      createdRoom.value = {
        id: result.room_id,
        title: roomDisplayTitle(result.display_name),
      }
      pendingCreation = { key, path: roomPath(result) }
      const opened = await openPath(pendingCreation.path)
      if (version !== generation) return
      if (!opened) {
        creationError.value =
          'Your room was created, but could not be opened. Try opening it again.'
        input.showRoomsTab()
      }
    } catch {
      if (version !== generation) return
      creationError.value = saved
        ? 'Your room was created, but could not be opened. Try opening it again.'
        : 'Could not create the room. Your choice is still here; try again.'
      input.showRoomsTab()
    } finally {
      if (version === generation) {
        creatingFocusRoomTaskId.value = null
        creatingAdHocFocusRoom.value = false
      }
    }
  }
  async function handleFocusTask(taskId: string) {
    if (taskId) await createAndOpen('task', taskId)
  }
  async function handleCreateAdHocFocusRoom(title: string) {
    if (title.trim()) await createAndOpen('topic', title.trim())
  }
  async function handleShareFocusResults(
    summary: string,
    conclusionDetails: FocusRoomConclusionDetails | null,
  ) {
    if (!summary.trim() || sharingFocusResult.value) return
    const version = generation
    sharingFocusResult.value = true
    try {
      const result = await input.shareFocusRoomResult(
        summary.trim(),
        conclusionDetails,
      )
      if (version !== generation) return
      if (!result)
        input.toast.error(
          'Could not close the room. Your outcome is still here; try again.',
        )
      else
        input.toast.success(
          result.parentMessagePosted
            ? 'Room closed. Outcome shared with the main room.'
            : 'Room closed. Outcome saved here.',
        )
    } catch {
      if (version === generation)
        input.toast.error('Could not close the room. Try again.')
    } finally {
      if (version === generation) sharingFocusResult.value = false
    }
  }
  async function handleUpdateFocusSettings(
    focusKey: string,
    settings: FocusRoomSettingsPatch,
  ) {
    if (!focusKey || updatingFocusSettings.value) return
    const version = generation
    updatingFocusSettings.value = true
    try {
      const result = await input.updateFocusRoomSettings(focusKey, settings)
      if (version !== generation) return
      if (!result)
        input.toast.error('Room settings could not be saved. Try again.')
      else input.toast.success('Room settings saved.')
    } catch {
      if (version === generation)
        input.toast.error('Room settings could not be saved. Try again.')
    } finally {
      if (version === generation) updatingFocusSettings.value = false
    }
  }
  return {
    focusDraftTaskId,
    creatingFocusRoomTaskId,
    creatingAdHocFocusRoom,
    sharingFocusResult,
    updatingFocusSettings,
    creationError,
    createdRoom,
    retryCreatedRoom,
    handleFocusTask,
    handleCreateAdHocFocusRoom,
    handleOpenFocusRoom,
    handleOpenParentRoom,
    handleShareFocusResults,
    handleUpdateFocusSettings,
  }
}
