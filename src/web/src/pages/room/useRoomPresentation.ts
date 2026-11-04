import { computed, type Ref } from 'vue'

import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
} from '../../../../../shared/room-membership.mjs'

import { REPO_ACCESS_UNAVAILABLE } from '@/composables/room/membership'
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
  // The room is known even when it does not open: refused, or GitHub did not answer.
  const namesRoom = (error: RoomJoinError | null) => Boolean(error?.refusal || error?.code === REPO_ACCESS_UNAVAILABLE)
  const roomTitle = computed(() => input.room.value?.displayName
    || (namesRoom(input.joinError.value) ? input.joinError.value!.displayName || input.joinError.value!.roomId : null)
    || 'Connecting...')

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

    const refusedRoom = namesRoom(input.joinError.value) ? input.joinError.value!.roomId : null
    if (refusedRoom) return `Room: ${refusedRoom}`

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

  /** Signed in but not let in: the room page shows the ask-to-join screen instead of an error. */
  const accessRefusal = computed(() => input.joinError.value?.refusal ?? null)

  /** GitHub gave no answer to the role check: not a refusal, so the room page retries. */
  const accessCheckUnavailable = computed(() => input.joinError.value?.code === REPO_ACCESS_UNAVAILABLE)

  const joinErrorTitle = computed(() => {
    if (input.joinError.value?.code === 'NOT_AUTHENTICATED') {
      return 'GitHub sign-in required'
    }
    if (input.joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
      return 'No repo access'
    }
    if (accessCheckUnavailable.value) return 'GitHub is not answering'
    if (accessRefusal.value === 'membership_required') return 'Members only'
    if (accessRefusal.value === 'repo_collaborator_required') return 'GitHub role required'
    return 'Could not connect to room.'
  })

  const joinErrorBody = computed(() => {
    if (input.joinError.value?.code === 'NOT_AUTHENTICATED') {
      return 'This room requires GitHub sign-in before you can join.'
    }
    if (accessCheckUnavailable.value) {
      return 'LetAgents could not check your role on this repository with GitHub. This is not a refusal.'
    }
    if (accessRefusal.value === 'membership_required') return ROOM_MEMBERSHIP_REQUIRED_MESSAGE
    if (accessRefusal.value === 'repo_collaborator_required') return REPO_COLLABORATOR_REQUIRED_MESSAGE
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
    accessRefusal,
    accessCheckUnavailable,
    joinErrorTitle,
    joinErrorBody,
    stalePromptTaskStates,
  }
}
