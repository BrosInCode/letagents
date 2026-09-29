import { computed, ref, watch } from 'vue'
import {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  focusRoomSettingsFrom,
  type FocusRoomConclusionDetails,
  type FocusRoomSettings,
} from '@/composables/room/types/focus'
import {
  roomDisplayTitle,
  type DirectoryRoom,
  type DirectoryTask,
} from '../../../../../../shared/rooms/directory'
import {
  createEmptyCloseoutDetails,
  focusRoomOpenKey,
  gitRoomRefLabel,
  gitRoomRefTypeLabel,
} from './options'
import type { FocusRoomsViewEmit, FocusRoomsViewProps } from './types'

export function useFocusRoomsViewModel(
  props: FocusRoomsViewProps,
  emit: FocusRoomsViewEmit,
) {
  const resultSummary = ref('')
  const shareAttempted = ref(false)
  const settingsDraft = ref<FocusRoomSettings>({
    ...DEFAULT_FOCUS_ROOM_SETTINGS,
  })
  const closeoutDetails = ref<FocusRoomConclusionDetails>(
    createEmptyCloseoutDetails(),
  )
  const selectedFocusRoomId = ref<string | null>(null)
  const selectedFocusRoom = computed(
    () =>
      props.focusRooms.find(
        (room) => room.room_id === selectedFocusRoomId.value,
      ) ?? null,
  )
  const directoryRooms = computed<DirectoryRoom[]>(() =>
    props.focusRooms
      .filter((room) => room.kind === 'focus')
      .map((room) => ({
        id: room.room_id,
        title: roomDisplayTitle(room.display_name),
        kind: room.git_room ? 'branch' : room.source_task_id ? 'task' : 'topic',
        kindLabel: room.git_room
          ? gitRoomRefTypeLabel(room.git_room)
          : undefined,
        closed: room.focus_status === 'concluded',
        description:
          room.focus_status === 'concluded'
            ? room.conclusion_summary || ''
            : room.git_room
              ? gitRoomRefLabel(room.git_room)
              : props.tasks.find((task) => task.id === room.source_task_id)
                  ?.title || '',
        createdAt: room.created_at,
        closedAt: room.concluded_at,
        searchText: `${room.source_task_id || ''} ${room.git_room?.repository.full_name || ''}`,
      })),
  )
  const directoryTasks = computed<DirectoryTask[]>(() =>
    props.tasks
      .filter((task) => !['done', 'cancelled'].includes(task.status))
      .map((task) => {
        const existing =
          props.focusRooms.find(
            (room) =>
              room.source_task_id === task.id &&
              room.focus_status !== 'concluded',
          ) || props.focusRooms.find((room) => room.source_task_id === task.id)
        return {
          id: task.id,
          title: task.title,
          description: task.description || '',
          status: task.status,
          roomId: existing?.room_id,
          roomClosed: existing?.focus_status === 'concluded',
        }
      }),
  )
  const settingsTarget = computed(() => {
    if (props.isFocusRoom)
      return {
        focusKey: props.focusKey || props.sourceTaskId,
        settings: props.focusSettings,
      }
    const selected = selectedFocusRoom.value
    return selected
      ? {
          focusKey: selected.focus_key || selected.source_task_id,
          settings: focusRoomSettingsFrom(selected),
        }
      : null
  })
  const isConcluded = computed(() => props.focusStatus === 'concluded')
  const requiresCloseoutDetails = computed(
    () => props.isFocusRoom && Boolean(props.sourceTaskId),
  )
  const showCloseoutDetails = computed(() =>
    isConcluded.value
      ? Boolean(props.conclusionDetails)
      : requiresCloseoutDetails.value || Boolean(props.conclusionDetails),
  )
  const closeoutDetailsComplete = computed(() =>
    Boolean(
      closeoutDetails.value.artifact.trim() &&
        closeoutDetails.value.next_owner.trim(),
    ),
  )
  const focusStatusLabel = computed(() =>
    isConcluded.value ? 'Closed' : 'Open',
  )
  const focusContextCopy = computed(() =>
    isConcluded.value
      ? 'This conversation is closed. Its history and outcome are still available.'
      : props.gitRoom
        ? 'A conversation for this Git branch. Keep its work and decisions together.'
        : 'Work together here. Record the outcome when it is ready.',
  )
  const sharePlaceholder = computed(() =>
    isConcluded.value
      ? 'No outcome recorded.'
      : 'What changed, what was decided, and what happens next?',
  )
  const canShareResults = computed(
    () =>
      !isConcluded.value &&
      !props.isSharingFocusResult &&
      Boolean(resultSummary.value.trim()) &&
      (!requiresCloseoutDetails.value || closeoutDetailsComplete.value),
  )
  // Closing uses saved server settings, never the unsaved settings draft.
  const shareButtonLabel = computed(() =>
    isConcluded.value
      ? 'Room closed'
      : props.isSharingFocusResult
        ? 'Closing…'
        : props.focusSettings.parent_visibility === 'silent'
          ? 'Save outcome and close'
          : 'Share outcome and close',
  )
  const shareHelpText = computed(() => {
    if (isConcluded.value)
      return 'You can return to this conversation at any time.'
    if (shareAttempted.value && !resultSummary.value.trim())
      return 'Write a short outcome before closing.'
    if (
      shareAttempted.value &&
      requiresCloseoutDetails.value &&
      !closeoutDetailsComplete.value
    )
      return 'Add the result and next owner before closing this task room.'
    const consequence =
      props.focusSettings.parent_visibility === 'silent'
        ? 'Closes this room and saves the outcome here without posting it to the main room.'
        : 'Closes this room and shares the outcome with the main room.'
    return (
      consequence +
      (requiresCloseoutDetails.value
        ? ' The task next step is a recommendation; its status will not change automatically.'
        : '')
    )
  })
  const hasSettingsChanges = computed(() =>
    Boolean(
      settingsTarget.value &&
        JSON.stringify(settingsDraft.value) !==
          JSON.stringify(settingsTarget.value.settings),
    ),
  )
  const canSaveSettings = computed(
    () =>
      Boolean(settingsTarget.value?.focusKey) &&
      hasSettingsChanges.value &&
      !props.isUpdatingFocusSettings,
  )
  const settingsButtonLabel = computed(() =>
    props.isUpdatingFocusSettings
      ? 'Saving…'
      : hasSettingsChanges.value
        ? 'Save settings'
        : 'Saved',
  )
  const parentVisibilityDescription = computed(() => {
    switch (settingsDraft.value.parent_visibility) {
      case 'silent':
        return 'Save the outcome in this room without posting it to the main room.'
      case 'all_activity':
        return 'Let every update appear in the main room.'
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
        return 'Hide code activity from this room.'
      case 'focus_owned_only':
        return 'Keep matching PRs, reviews, and checks here without echoing them to the parent.'
      case 'all_parent_repo':
        return 'Show every code update from the main repository here.'
      case 'task_only':
        return 'Show only code updates that name this task.'
      case 'task_and_branch':
        return 'Show code updates for this task and its linked code.'
    }
  })

  const roomIdentity = computed(
    () =>
      `${props.roomAddress}:${props.isFocusRoom ? props.focusKey || props.sourceTaskId || props.roomLabel : ''}`,
  )
  watch(
    () =>
      [
        roomIdentity.value,
        props.conclusionSummary || '',
        props.focusStatus,
      ] as const,
    ([id, summary, status], previous) => {
      if (
        status === 'concluded' ||
        !previous ||
        id !== previous[0] ||
        resultSummary.value === previous[1]
      )
        resultSummary.value = summary
      if (!previous || id !== previous[0]) shareAttempted.value = false
    },
    { immediate: true },
  )
  watch(
    () =>
      [
        roomIdentity.value,
        JSON.stringify(props.conclusionDetails || createEmptyCloseoutDetails()),
        props.focusStatus,
      ] as const,
    ([id, details, status], previous) => {
      if (
        status === 'concluded' ||
        !previous ||
        id !== previous[0] ||
        JSON.stringify(closeoutDetails.value) === previous[1]
      )
        closeoutDetails.value = JSON.parse(details)
    },
    { immediate: true },
  )
  watch(
    () =>
      [
        roomIdentity.value,
        settingsTarget.value?.focusKey,
        JSON.stringify(
          settingsTarget.value?.settings || DEFAULT_FOCUS_ROOM_SETTINGS,
        ),
      ] as const,
    ([id, key, settings], previous) => {
      if (
        !previous ||
        id !== previous[0] ||
        key !== previous[1] ||
        JSON.stringify(settingsDraft.value) === previous[2]
      )
        settingsDraft.value = JSON.parse(settings)
    },
    { immediate: true },
  )
  watch(roomIdentity, () => {
    selectedFocusRoomId.value = null
  })
  function submitShareResults() {
    shareAttempted.value = true
    if (!canShareResults.value) return
    const details = requiresCloseoutDetails.value
      ? {
          ...closeoutDetails.value,
          artifact: closeoutDetails.value.artifact.trim(),
          next_owner: closeoutDetails.value.next_owner.trim(),
        }
      : null
    emit('shareResults', resultSummary.value.trim(), details)
  }
  function submitFocusSettings() {
    const target = settingsTarget.value
    if (target?.focusKey && canSaveSettings.value)
      emit('updateFocusSettings', target.focusKey, { ...settingsDraft.value })
  }
  function openDirectoryRoom(id: string) {
    const room = props.focusRooms.find((room) => room.room_id === id)
    if (room) emit('openFocusRoom', focusRoomOpenKey(room))
  }
  return {
    resultSummary,
    settingsDraft,
    closeoutDetails,
    selectedFocusRoomId,
    directoryRooms,
    directoryTasks,
    selectedFocusRoom,
    settingsTarget,
    isConcluded,
    showCloseoutDetails,
    focusStatusLabel,
    focusContextCopy,
    sharePlaceholder,
    canShareResults,
    shareButtonLabel,
    shareHelpText,
    hasSettingsChanges,
    canSaveSettings,
    settingsButtonLabel,
    parentVisibilityDescription,
    activityScopeDescription,
    githubEventRoutingDescription,
    submitShareResults,
    submitFocusSettings,
    openDirectoryRoom,
  }
}
