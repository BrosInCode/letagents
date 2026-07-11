import { readonly } from 'vue'
import {
  discardAttachmentUpload,
  stageAttachmentUpload,
} from './room/attachments'
import {
  fetchTasks,
  getGitHubEventsIdentifier,
} from './room/data'
import { createRoomFocusActions } from './room/focusRoomActions'
import {
  getReplyPreviewText,
  getSenderColor,
  hasInlinePromptInjection,
  isHumanSender,
  isPromptOnlyRoomMessage,
  normalizeAgentPromptKind,
  parseAgentIdentity,
  resolveAgentIdentity,
} from './room/identity'
import { createRoomLifecycle } from './room/lifecycle'
import { createRoomMessageActions } from './room/messageActions'
import { createPresenceController } from './room/presence'
import { createRoomRefreshController } from './room/refresh'
import { soundEnabled, toggleSound } from './room/sound'
import {
  activityHistory,
  activityHistoryError,
  activityHistoryLoading,
  activityLoading,
  boardHandoffPresence,
  boardLoading,
  connectionState,
  focusRooms,
  focusRoomsLoading,
  githubEvents,
  githubEventsAvailable,
  githubEventsError,
  githubEventsHasMore,
  githubEventsLoading,
  githubEventsSupported,
  isConnected,
  isLoadingOlderMessages,
  isStreaming,
  joinError,
  lastSendError,
  messages,
  messagesHasOlder,
  participantHiddenCount,
  participants,
  presence,
  reasoningSessions,
  removeReasoningSession,
  room,
  roomArtifacts,
  taskGithubStatus,
  tasks,
  upsertReasoningSession,
  upsertTask,
} from './room/state'
import { createRoomStream } from './room/stream'
import { createRoomTaskMutations } from './room/taskMutations'

export type * from './room/types'
export type { ConnectionState } from './room/state'
export {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  focusRoomSettingsFrom,
} from './room/types'
export type { ParsedIdentity } from './room/identity'
export {
  getReplyPreviewText,
  getSenderColor,
  hasInlinePromptInjection,
  isHumanSender,
  isPromptOnlyRoomMessage,
  normalizeAgentPromptKind,
  parseAgentIdentity,
  resolveAgentIdentity,
} from './room/identity'
export { mergeCreatedTask, taskFromCreateTaskResponse } from './room/taskActions'

const {
  refreshPresence,
  refreshParticipants,
  refreshRoomPresence,
  refreshRoomReachability,
  schedulePresenceRefresh,
  scheduleParticipantRefresh,
  startPresenceRefreshLoop,
  startParticipantRefreshLoop,
  stop: stopPresenceControllers,
} = createPresenceController({
  getRoomIdentifier: () => room.value?.identifier || null,
  isCurrentRoom: (roomIdentifier) => room.value?.identifier === roomIdentifier,
  setPresence: (nextPresence) => {
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
  },
  setParticipants: (nextParticipants, hiddenCount) => {
    participants.value = nextParticipants
    participantHiddenCount.value = hiddenCount
  },
})

const {
  clearDisconnectedParticipants,
  loadActivityHistory,
  refreshFocusRooms,
  refreshReasoningSessions,
  refreshRoomActivity,
  refreshRoomBoard,
  refreshRoomFocusRooms,
  refreshRoomGitHubEvents,
  refreshRoomMessages,
  refreshTaskGithubStatus,
  refreshTasksAndPresence,
  scheduleGitHubEventsRefresh,
  scheduleRoomArtifactsRefresh,
  stopGitHubEventsRefresh,
  stopRoomArtifactsRefresh,
} = createRoomRefreshController({
  refreshParticipants,
  refreshPresence,
})

function scheduleGitHubRoomUpdates(roomIdentifier?: string | null) {
  if (room.value && githubEventsSupported.value) {
    scheduleGitHubEventsRefresh(
      getGitHubEventsIdentifier(room.value),
      githubEventsSupported.value,
    )
  }
  if (room.value) {
    void refreshTaskGithubStatus()
  }
  const targetRoomIdentifier = roomIdentifier || room.value?.identifier
  if (targetRoomIdentifier) {
    scheduleRoomArtifactsRefresh(targetRoomIdentifier)
  }
}

const roomStream = createRoomStream({
  setConnectionState: (state) => {
    connectionState.value = state
  },
  setStreaming: (streaming) => {
    isStreaming.value = streaming
  },
  appendMessage: (message) => {
    if (messages.value.some((item) => item.id === message.id)) return false
    messages.value = [...messages.value, message]
    return true
  },
  onGitHubMessage: () => {
    scheduleGitHubRoomUpdates()
  },
  onGitHubEvent: (roomIdentifier) => {
    scheduleGitHubRoomUpdates(roomIdentifier)
  },
  onTaskLifecycleMessage: () => {
    if (!room.value) return
    const roomIdentifier = room.value.identifier
    scheduleRoomArtifactsRefresh(roomIdentifier)
    fetchTasks(roomIdentifier).then((nextTasks) => {
      if (room.value?.identifier !== roomIdentifier) return
      tasks.value = nextTasks
    })
  },
  onArtifactUpdate: (roomIdentifier) => {
    const targetRoomIdentifier = roomIdentifier || room.value?.identifier
    if (targetRoomIdentifier) {
      scheduleRoomArtifactsRefresh(targetRoomIdentifier)
    }
  },
  onAgentActivityMessage: () => {
    if (room.value) {
      schedulePresenceRefresh(room.value.identifier)
    }
  },
  onParticipantActivityMessage: () => {
    if (room.value) {
      scheduleParticipantRefresh(room.value.identifier)
    }
  },
  upsertTask,
  upsertReasoningSession,
  removeReasoningSession,
  getMessageCursor: () => messages.value[messages.value.length - 1]?.id ?? null,
  resyncMessages: async (roomIdentifier, after) => {
    if (room.value?.identifier !== roomIdentifier) {
      return { success: false, cursor: after }
    }
    return refreshRoomMessages(after)
  },
})

function startStreaming(roomIdentifier: string) {
  roomStream.start(roomIdentifier)
}

function stopStreaming() {
  roomStream.stop()
  stopGitHubEventsRefresh()
  stopRoomArtifactsRefresh()
  stopPresenceControllers()
}

const {
  joinRoom,
  leaveRoom,
  renameRoom,
  restoreSession,
} = createRoomLifecycle({
  startParticipantRefreshLoop,
  startPresenceRefreshLoop,
  startStreaming,
  stopStreaming,
})

const {
  loadOlderMessages,
  sendMessage,
} = createRoomMessageActions()

const {
  createAdHocFocusRoom,
  createFocusRoom,
  shareFocusRoomResult,
  updateFocusRoomSettings,
} = createRoomFocusActions()

const {
  addTask,
  setTaskStalePromptMute,
  updateTask,
  updateTaskLease,
  updateTaskReviewLease,
} = createRoomTaskMutations({
  refreshRoomBoard,
  refreshTasksAndPresence,
})

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopStreaming()
  })
}

export function useRoom() {
  return {
    messages: readonly(messages),
    messagesHasOlder: readonly(messagesHasOlder),
    isLoadingOlderMessages: readonly(isLoadingOlderMessages),
    tasks: readonly(tasks),
    focusRooms: readonly(focusRooms),
    presence: readonly(presence),
    boardHandoffPresence: readonly(boardHandoffPresence),
    participants: readonly(participants),
    participantHiddenCount: readonly(participantHiddenCount),
    activityHistory: readonly(activityHistory),
    activityHistoryLoading: readonly(activityHistoryLoading),
    activityHistoryError: readonly(activityHistoryError),
    reasoningSessions: readonly(reasoningSessions),
    roomArtifacts: readonly(roomArtifacts),
    taskGithubStatus: readonly(taskGithubStatus),
    githubEvents: readonly(githubEvents),
    githubEventsAvailable: readonly(githubEventsAvailable),
    githubEventsHasMore: readonly(githubEventsHasMore),
    githubEventsError: readonly(githubEventsError),
    githubEventsSupported,
    githubEventsLoading: readonly(githubEventsLoading),
    boardLoading: readonly(boardLoading),
    activityLoading: readonly(activityLoading),
    focusRoomsLoading: readonly(focusRoomsLoading),
    room: readonly(room),
    lastSendError: readonly(lastSendError),
    isConnected: readonly(isConnected),
    isStreaming: readonly(isStreaming),
    connectionState: readonly(connectionState),
    joinError: readonly(joinError),
    soundEnabled: readonly(soundEnabled),

    joinRoom,
    leaveRoom,
    sendMessage,
    stageAttachmentUpload,
    discardAttachmentUpload,
    addTask,
    updateTask,
    updateTaskLease,
    updateTaskReviewLease,
    setTaskStalePromptMute,
    createFocusRoom,
    createAdHocFocusRoom,
    shareFocusRoomResult,
    updateFocusRoomSettings,
    refreshFocusRooms,
    refreshRoomMessages,
    refreshRoomPresence,
    refreshRoomReachability,
    loadActivityHistory,
    clearDisconnectedParticipants,
    refreshReasoningSessions,
    refreshRoomActivity,
    refreshRoomBoard,
    refreshRoomFocusRooms,
    refreshTaskGithubStatus,
    refreshRoomGitHubEvents,
    renameRoom,
    loadOlderMessages,
    restoreSession,
    toggleSound,

    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
  }
}
