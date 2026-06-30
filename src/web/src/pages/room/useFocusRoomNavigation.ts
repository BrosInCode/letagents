import { ref, type ComputedRef, type Ref } from 'vue'
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

interface RoomToast {
  error(message: string): void
  info(message: string): void
  success(message: string): void
}

function openBlankFocusRoomTab(): Window | null {
  try {
    const target = window.open('about:blank', '_blank')
    if (target) {
      target.opener = null
    }
    return target
  } catch {
    return null
  }
}

function closeFocusTargetWindow(targetWindow?: Window | null) {
  if (targetWindow && !targetWindow.closed) {
    targetWindow.close()
  }
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

  function buildCurrentFocusRoomPath(focusKey: string): string {
    return buildFocusRoomPath({
      parentRoomId: input.focusParentAddress.value,
      focusKey,
    })
  }

  function buildFocusRoomInfoPath(focusRoom: FocusRoomInfo): string {
    return buildRoomSharePath({
      identifier: focusRoom.room_id,
      kind: 'focus',
      parentRoomId: focusRoom.parent_room_id || input.focusParentAddress.value,
      focusKey: focusRoom.focus_key,
      sourceTaskId: focusRoom.source_task_id,
    })
  }

  async function openFocusRoomPath(path: string, targetWindow?: Window | null): Promise<boolean> {
    if (!path) return false
    const absoluteUrl = new URL(path, window.location.origin).toString()

    if (targetWindow && !targetWindow.closed) {
      try {
        targetWindow.location.replace(absoluteUrl)
        targetWindow.focus()
        return true
      } catch {
        closeFocusTargetWindow(targetWindow)
      }
    } else {
      const openedWindow = openBlankFocusRoomTab()
      if (openedWindow && !openedWindow.closed) {
        try {
          openedWindow.location.replace(absoluteUrl)
          openedWindow.focus()
          return true
        } catch {
          closeFocusTargetWindow(openedWindow)
        }
      }
    }

    try {
      await input.router.push(path)
      return true
    } catch {
      return false
    }
  }

  async function handleOpenFocusRoom(focusKey: string, targetWindow?: Window | null): Promise<boolean> {
    const path = focusKey.startsWith('focus_')
      ? buildDirectRoomPath(focusKey)
      : buildCurrentFocusRoomPath(focusKey)
    if (!path) {
      closeFocusTargetWindow(targetWindow)
      return false
    }
    return openFocusRoomPath(path, targetWindow)
  }

  async function handleOpenParentRoom() {
    const parent = input.focusParentAddress.value
    if (!parent) return
    await input.router.push(buildDirectRoomPath(parent))
  }

  async function handleFocusTask(taskId: string) {
    focusDraftTaskId.value = taskId
    if (input.room.value?.kind === 'focus') {
      input.toast.info('Open new Focus Rooms from the parent room.')
      return
    }

    const focusWindow = openBlankFocusRoomTab()
    creatingFocusRoomTaskId.value = taskId
    try {
      const focusRoom = await input.createFocusRoom(taskId)
      if (!focusRoom) {
        closeFocusTargetWindow(focusWindow)
        input.showRoomsTab()
        input.toast.error('Focus Room could not be opened.')
        return
      }

      const path = buildFocusRoomInfoPath(focusRoom) || buildCurrentFocusRoomPath(taskId)
      const opened = await openFocusRoomPath(path, focusWindow)
      if (!opened) {
        input.toast.error('Focus Room could not be opened.')
      }
    } finally {
      creatingFocusRoomTaskId.value = null
    }
  }

  async function handleCreateAdHocFocusRoom(title: string) {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      input.toast.error('Name the Focus Room first.')
      return
    }
    if (input.room.value?.kind === 'focus') {
      input.toast.info('Open new Focus Rooms from the parent room.')
      return
    }

    const focusWindow = openBlankFocusRoomTab()
    creatingAdHocFocusRoom.value = true
    try {
      const focusRoom = await input.createAdHocFocusRoom(trimmedTitle)
      if (!focusRoom) {
        closeFocusTargetWindow(focusWindow)
        input.showRoomsTab()
        input.toast.error('Focus Room could not be opened.')
        return
      }

      const opened = await openFocusRoomPath(buildFocusRoomInfoPath(focusRoom), focusWindow)
      if (!opened) {
        input.toast.error('Focus Room could not be opened.')
      }
    } finally {
      creatingAdHocFocusRoom.value = false
    }
  }

  async function handleShareFocusResults(
    summary: string,
    conclusionDetails: FocusRoomConclusionDetails | null,
  ) {
    const trimmedSummary = summary.trim()
    if (!trimmedSummary) {
      input.toast.error('Write a result summary first.')
      return
    }

    sharingFocusResult.value = true
    try {
      const result = await input.shareFocusRoomResult(trimmedSummary, conclusionDetails)
      if (!result) {
        input.toast.error('Result could not be shared.')
        return
      }
      input.toast.success(result.parentMessagePosted ? 'Result shared with the parent room.' : 'Focus Room result saved.')
    } finally {
      sharingFocusResult.value = false
    }
  }

  async function handleUpdateFocusSettings(focusKey: string, settings: FocusRoomSettingsPatch) {
    if (!focusKey) {
      input.toast.error('Focus Room settings could not be saved.')
      return
    }

    updatingFocusSettings.value = true
    try {
      const focusRoom = await input.updateFocusRoomSettings(focusKey, settings)
      if (!focusRoom) {
        input.toast.error('Focus Room settings could not be saved.')
        return
      }
      input.toast.success('Focus Room settings saved.')
    } finally {
      updatingFocusSettings.value = false
    }
  }

  return {
    focusDraftTaskId,
    creatingFocusRoomTaskId,
    creatingAdHocFocusRoom,
    sharingFocusResult,
    updatingFocusSettings,
    handleFocusTask,
    handleCreateAdHocFocusRoom,
    handleOpenFocusRoom,
    handleOpenParentRoom,
    handleShareFocusResults,
    handleUpdateFocusSettings,
  }
}
