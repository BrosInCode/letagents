import { computed, type Ref } from 'vue'

import {
  type ConnectionState,
  type FocusRoomSettings,
  type RoomInfo,
  type RoomJoinError,
  type RoomTask,
  type StalePromptTaskState,
} from '@/composables/useRoom'

interface AuthUser {
  login: string
}

export function useRoomPresentation(input: {
  room: Readonly<Ref<RoomInfo | null>>
  tasks: Readonly<Ref<readonly RoomTask[]>>
  joinError: Readonly<Ref<RoomJoinError | null>>
  connectionState: Readonly<Ref<ConnectionState>>
  authUser: Readonly<Ref<AuthUser | null>>
}) {
  const senderName = computed(() => input.authUser.value?.login || 'anonymous')
  const roomTitle = computed(() => input.room.value?.displayName || 'Connecting...')

  const rulesBoardAvailable = computed(() => {
    const identifiers = [
      input.room.value?.projectId,
      input.room.value?.name,
      input.room.value?.parentRoomId,
    ]
    return identifiers.some(value => value?.startsWith('github.com/'))
  })

  const roomSubtitle = computed(() => {
    const currentRoom = input.room.value
    if (currentRoom?.kind === 'focus') {
      return `Focus Room: ${currentRoom.parentRoomId || 'parent'}${currentRoom.sourceTaskId ? ` / ${currentRoom.sourceTaskId}` : ''}`
    }

    if (currentRoom) {
      return `Room: ${currentRoom.name}`
    }

    return input.connectionState.value === 'connecting'
      ? 'Joining room...'
      : 'Create a new room or join one.'
  })

  const focusParentAddress = computed(() => {
    const currentRoom = input.room.value
    return currentRoom?.kind === 'focus' && currentRoom.parentRoomId
      ? currentRoom.parentRoomId
      : currentRoom?.identifier || currentRoom?.name || ''
  })

  const githubEventsRepository = computed(() => {
    const currentRoom = input.room.value
    return currentRoom?.kind === 'focus' && currentRoom.parentRoomId
      ? currentRoom.parentRoomId
      : currentRoom?.name || currentRoom?.identifier || null
  })

  const focusSettings = computed<FocusRoomSettings>(() => ({
    parent_visibility: input.room.value?.focusParentVisibility || 'summary_only',
    activity_scope: input.room.value?.focusActivityScope || 'task_and_branch',
    github_event_routing: input.room.value?.focusGitHubEventRouting || 'task_and_branch',
  }))

  const showGitHubSignIn = computed(() => input.joinError.value?.code === 'NOT_AUTHENTICATED')

  const joinErrorTitle = computed(() => {
    if (input.joinError.value?.code === 'NOT_AUTHENTICATED') {
      return 'GitHub sign-in required'
    }
    if (input.joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
      return 'No repo access'
    }
    return 'Could not connect to room.'
  })

  const joinErrorBody = computed(() => {
    if (input.joinError.value?.code === 'NOT_AUTHENTICATED') {
      return 'This repo-backed room requires GitHub sign-in before you can join.'
    }
    if (input.joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
      const login = input.authUser.value?.login
      return login
        ? `Signed in as ${login}, but that account does not have access to this private repo room.`
        : 'Your current account does not have access to this private repo room.'
    }
    return input.joinError.value?.message || 'Could not connect to room.'
  })

  const stalePromptTaskStates = computed<Record<string, StalePromptTaskState>>(() =>
    Object.fromEntries(
      input.tasks.value.map(task => [
        task.id,
        {
          isStale: Boolean(task.stale_prompt_state?.is_stale),
          muted: Boolean(task.stale_prompt_state?.muted),
          taskUpdatedAt: task.updated_at,
        },
      ])
    )
  )

  return {
    senderName,
    roomTitle,
    rulesBoardAvailable,
    roomSubtitle,
    focusParentAddress,
    githubEventsRepository,
    focusSettings,
    showGitHubSignIn,
    joinErrorTitle,
    joinErrorBody,
    stalePromptTaskStates,
  }
}
