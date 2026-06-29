import { computed, ref, watch } from 'vue'
import {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  focusRoomSettingsFrom,
  type FocusRoomConclusionDetails,
  type FocusRoomSettings,
} from '@/composables/useRoom'
import {
  createEmptyCloseoutDetails,
  focusRoomOpenKey,
  taskStatusLabel,
} from './options'
import type {
  FocusRoomsViewEmit,
  FocusRoomsViewProps,
} from './types'

export function useFocusRoomsViewModel(
  props: FocusRoomsViewProps,
  emit: FocusRoomsViewEmit,
) {
  const resultSummary = ref('')
  const shareAttempted = ref(false)
  const settingsDraft = ref<FocusRoomSettings>({ ...DEFAULT_FOCUS_ROOM_SETTINGS })
  const closeoutDetails = ref<FocusRoomConclusionDetails>(createEmptyCloseoutDetails())
  const adHocTitle = ref('')
  const adHocAttempted = ref(false)
  const selectedFocusRoomId = ref<string | null>(null)

  const candidateTasks = computed(() =>
    props.tasks.filter(task => !['done', 'cancelled'].includes(task.status))
  )

  const openFocusRooms = computed(() =>
    props.focusRooms.filter(room => room.kind === 'focus' && room.focus_status !== 'concluded')
  )

  const concludedFocusRooms = computed(() =>
    props.focusRooms.filter(room => room.kind === 'focus' && room.focus_status === 'concluded')
  )

  const selectedFocusRoom = computed(() =>
    selectedFocusRoomId.value
      ? props.focusRooms.find(room => room.room_id === selectedFocusRoomId.value) ?? null
      : null
  )

  const selectedFocusRoomSettings = computed(() =>
    selectedFocusRoom.value
      ? focusRoomSettingsFrom(selectedFocusRoom.value)
      : DEFAULT_FOCUS_ROOM_SETTINGS
  )

  const selectedFocusRoomDetailCopy = computed(() => {
    const room = selectedFocusRoom.value
    if (!room) return ''
    if (room.focus_status === 'concluded') {
      return 'This Focus Room is closed; review the outcome before relying on the parent-room summary.'
    }
    return 'This Focus Room is still active; inspect the record first, then enter the room when you need the live thread.'
  })

  const focusRoomByTask = computed(() => {
    const entries = props.focusRooms
      .filter(room => room.source_task_id)
      .map(room => [room.source_task_id as string, room] as const)
    return new Map(entries)
  })

  const currentTask = computed(() => {
    const selected = props.selectedTaskId
      ? candidateTasks.value.find(task => task.id === props.selectedTaskId)
      : null
    return selected ?? candidateTasks.value[0] ?? null
  })

  const currentFocusRoom = computed(() => {
    const taskId = currentTask.value?.id
    return taskId ? focusRoomByTask.value.get(taskId) ?? null : null
  })

  const settingsTarget = computed(() => {
    if (props.isFocusRoom) {
      return {
        focusKey: props.focusKey || props.sourceTaskId,
        settings: props.focusSettings,
      }
    }
    if (!currentFocusRoom.value) return null
    return {
      focusKey: currentFocusRoom.value.focus_key || currentFocusRoom.value.source_task_id,
      settings: focusRoomSettingsFrom(currentFocusRoom.value),
    }
  })

  const isConcluded = computed(() => props.focusStatus === 'concluded')
  const conclusionSummaryText = computed(() => props.conclusionSummary?.trim() || '')
  const requiresCloseoutDetails = computed(() => props.isFocusRoom && Boolean(props.sourceTaskId))
  const showCloseoutDetails = computed(() => requiresCloseoutDetails.value || Boolean(props.conclusionDetails))
  const closeoutDetailsComplete = computed(() =>
    closeoutDetails.value.artifact.trim().length > 0 &&
    closeoutDetails.value.next_owner.trim().length > 0
  )
  const focusStatusLabel = computed(() =>
    props.focusStatus ? taskStatusLabel(props.focusStatus) : 'active'
  )
  const focusContextCopy = computed(() =>
    props.gitRoom
      ? isConcluded.value
        ? 'Git work has been closed; review the branch outcome before reopening it.'
        : 'Keep branch-specific planning, code activity, and artifacts here.'
      : isConcluded.value
        ? 'Result shared with the parent room.'
        : 'Keep task-specific work here, then bring the outcome back to the parent room.'
  )
  const sharePlaceholder = computed(() =>
    isConcluded.value
      ? 'Result already shared.'
      : 'Summarize the decision, implementation, blocker, or next action for the parent room.'
  )
  const canShareResults = computed(() =>
    !isConcluded.value &&
    !props.isSharingFocusResult &&
    resultSummary.value.trim().length > 0 &&
    (!requiresCloseoutDetails.value || closeoutDetailsComplete.value)
  )
  const shareButtonLabel = computed(() => {
    if (isConcluded.value) return 'Results shared'
    if (props.isSharingFocusResult) return 'Sharing...'
    if (settingsDraft.value.parent_visibility === 'silent') return 'Save result'
    return 'Share results'
  })
  const shareHelpText = computed(() => {
    if (isConcluded.value) {
      return conclusionSummaryText.value || 'The parent room has the outcome.'
    }
    if (shareAttempted.value && !resultSummary.value.trim()) {
      return 'Write a short outcome before sharing.'
    }
    if (shareAttempted.value && requiresCloseoutDetails.value && !closeoutDetailsComplete.value) {
      return 'Add the artifact and next owner before concluding this task room.'
    }
    if (settingsDraft.value.parent_visibility === 'silent') {
      return 'Conclude this Focus Room without posting the summary into the parent room.'
    }
    return requiresCloseoutDetails.value
      ? 'Close the loop with artifact, review state, blocker state, parent task next step, and next owner.'
      : 'Send a concise outcome to the parent room.'
  })
  const canCreateAdHocFocusRoom = computed(() =>
    !props.isCreatingAdHocFocusRoom && adHocTitle.value.trim().length > 0
  )
  const adHocButtonLabel = computed(() =>
    props.isCreatingAdHocFocusRoom ? 'Opening...' : 'Branch room'
  )
  const shareBackLabel = computed(() => {
    if (!currentFocusRoom.value) return 'Outcome summary'
    return currentFocusRoom.value.focus_status === 'concluded' ? 'Shared' : 'Ready'
  })
  const actionLabel = computed(() => {
    if (props.isFocusRoom) return 'Focus Room active'
    if (currentFocusRoom.value?.focus_status === 'concluded') return 'View shared result'
    if (currentFocusRoom.value) return 'Open Focus Room'
    if (props.isCreatingFocusRoom) return 'Opening...'
    return 'Focus on this'
  })
  const actionNote = computed(() => {
    if (props.isFocusRoom) return 'Open new Focus Rooms from the parent room.'
    if (currentFocusRoom.value?.focus_status === 'concluded') return 'This task already has a shared result.'
    if (currentFocusRoom.value) return 'This task already has a Focus Room.'
    return 'This opens a dedicated room for task-level execution.'
  })
  const hasSettingsChanges = computed(() => {
    const target = settingsTarget.value
    if (!target) return false
    const current = target.settings
    return (
      settingsDraft.value.parent_visibility !== current.parent_visibility ||
      settingsDraft.value.activity_scope !== current.activity_scope ||
      settingsDraft.value.github_event_routing !== current.github_event_routing
    )
  })
  const canSaveSettings = computed(() =>
    Boolean(settingsTarget.value?.focusKey) &&
    hasSettingsChanges.value &&
    !props.isUpdatingFocusSettings
  )
  const settingsButtonLabel = computed(() =>
    props.isUpdatingFocusSettings ? 'Saving...' : hasSettingsChanges.value ? 'Save settings' : 'Saved'
  )
  const parentVisibilityDescription = computed(() => {
    switch (settingsDraft.value.parent_visibility) {
      case 'silent':
        return 'Keep the parent quiet unless you share an outcome yourself.'
      case 'all_activity':
        return 'Let every update appear in the parent room.'
      case 'major_activity':
        return 'Share only task, pull request, and completion milestones.'
      case 'summary_only':
        return 'Share only the outcome you write when the room is done.'
    }
  })
  const activityScopeDescription = computed(() => {
    switch (settingsDraft.value.activity_scope) {
      case 'room':
        return 'Use the whole room conversation to decide what belongs here.'
      case 'task_only':
        return 'Use only the source task to decide what belongs here.'
      case 'task_and_branch':
        return 'Use the task plus linked branches, PRs, reviews, and checks.'
    }
  })
  const githubEventRoutingDescription = computed(() => {
    switch (settingsDraft.value.github_event_routing) {
      case 'off':
        return 'Hide code activity from this Focus Room.'
      case 'focus_owned_only':
        return 'Keep matching PRs, reviews, and checks here without echoing them to the parent.'
      case 'all_parent_repo':
        return 'Show every code update from the parent repository here.'
      case 'task_only':
        return 'Show only code updates that name this task.'
      case 'task_and_branch':
        return 'Show code updates for this task and its linked code.'
    }
  })

  watch(
    conclusionSummaryText,
    (summary) => {
      if (summary) {
        resultSummary.value = summary
      }
    },
    { immediate: true },
  )

  watch(
    () => props.conclusionDetails,
    (details) => {
      closeoutDetails.value = details ? { ...details } : createEmptyCloseoutDetails()
    },
    { immediate: true },
  )

  watch(
    settingsTarget,
    (target) => {
      settingsDraft.value = target
        ? { ...target.settings }
        : { ...DEFAULT_FOCUS_ROOM_SETTINGS }
    },
    { immediate: true },
  )

  watch(
    () => props.focusRooms,
    (rooms) => {
      if (selectedFocusRoomId.value && !rooms.some(room => room.room_id === selectedFocusRoomId.value)) {
        selectedFocusRoomId.value = null
      }
    },
  )

  function submitShareResults() {
    shareAttempted.value = true
    const trimmedSummary = resultSummary.value.trim()
    if (
      !trimmedSummary ||
      isConcluded.value ||
      props.isSharingFocusResult ||
      (requiresCloseoutDetails.value && !closeoutDetailsComplete.value)
    ) return
    const details = requiresCloseoutDetails.value
      ? {
          ...closeoutDetails.value,
          artifact: closeoutDetails.value.artifact.trim(),
          next_owner: closeoutDetails.value.next_owner.trim(),
        }
      : null
    emit('shareResults', trimmedSummary, details)
  }

  function submitFocusSettings() {
    const target = settingsTarget.value
    if (!target?.focusKey || !canSaveSettings.value) return
    emit('updateFocusSettings', target.focusKey, { ...settingsDraft.value })
  }

  function submitAdHocFocusRoom() {
    adHocAttempted.value = true
    const trimmedTitle = adHocTitle.value.trim()
    if (!trimmedTitle || props.isCreatingAdHocFocusRoom) return
    emit('createAdHocFocusRoom', trimmedTitle)
  }

  function selectFocusRoomById(roomId: string) {
    selectedFocusRoomId.value = roomId
  }

  function selectTask(taskId: string) {
    selectedFocusRoomId.value = null
    emit('selectTask', taskId)
  }

  function openSelectedFocusRoom() {
    if (!selectedFocusRoom.value) return
    emit('openFocusRoom', focusRoomOpenKey(selectedFocusRoom.value))
  }

  function openCurrentTaskFocusRoom() {
    if (!currentTask.value) return
    if (currentFocusRoom.value) {
      emit('openFocusRoom', focusRoomOpenKey(currentFocusRoom.value))
      return
    }
    emit('createFocusRoom', currentTask.value.id)
  }

  return {
    resultSummary,
    settingsDraft,
    closeoutDetails,
    adHocTitle,
    adHocAttempted,
    selectedFocusRoomId,
    candidateTasks,
    openFocusRooms,
    concludedFocusRooms,
    selectedFocusRoom,
    selectedFocusRoomSettings,
    selectedFocusRoomDetailCopy,
    currentTask,
    currentFocusRoom,
    settingsTarget,
    isConcluded,
    requiresCloseoutDetails,
    showCloseoutDetails,
    focusStatusLabel,
    focusContextCopy,
    sharePlaceholder,
    canShareResults,
    shareButtonLabel,
    shareHelpText,
    canCreateAdHocFocusRoom,
    adHocButtonLabel,
    shareBackLabel,
    actionLabel,
    actionNote,
    canSaveSettings,
    settingsButtonLabel,
    parentVisibilityDescription,
    activityScopeDescription,
    githubEventRoutingDescription,
    submitShareResults,
    submitFocusSettings,
    submitAdHocFocusRoom,
    selectFocusRoomById,
    selectTask,
    openSelectedFocusRoom,
    openCurrentTaskFocusRoom,
  }
}
