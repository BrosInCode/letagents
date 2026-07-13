import { roomPath } from './api'
import { isVisibleRoomMessage } from './identity'
import { playNotificationSound } from './sound'
import type {
  RoomMessage,
  RoomReasoningSession,
  RoomReasoningUpdate,
  RoomTask,
} from './types'

interface RoomStreamHandlers {
  setConnectionState: (state: 'connecting' | 'live' | 'error') => void
  setStreaming: (streaming: boolean) => void
  appendMessage: (message: RoomMessage) => boolean
  onGitHubMessage: () => void
  onGitHubEvent: (roomIdentifier?: string | null) => void
  onTaskLifecycleMessage: () => void
  onArtifactUpdate: (roomIdentifier?: string | null) => void
  onAgentActivityMessage: () => void
  onParticipantActivityMessage: () => void
  upsertTask: (task: RoomTask) => void
  upsertReasoningSession: (
    session: RoomReasoningSession,
    update?: RoomReasoningUpdate | null,
  ) => void
  removeReasoningSession: (sessionId: string) => void
  getMessageCursor: () => string | null
  resyncMessages: (
    roomIdentifier: string,
    after: string | null,
  ) => Promise<{ success: boolean; cursor: string | null }>
}

const MESSAGE_RESYNC_INTERVAL_MS = 15_000

export function createRoomStream(
  handlers: RoomStreamHandlers,
  options?: { resyncIntervalMs?: number },
) {
  let eventSource: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let resyncTimer: ReturnType<typeof setInterval> | null = null
  let resyncRoomInFlight: string | null = null
  let activeRoomIdentifier: string | null = null
  let historyCursor: string | null = null
  let reconnectDelay = 1200

  function resync(roomIdentifier: string) {
    if (resyncRoomInFlight === roomIdentifier) return
    resyncRoomInFlight = roomIdentifier
    void handlers.resyncMessages(roomIdentifier, historyCursor)
      .then((result) => {
        if (result.success && activeRoomIdentifier === roomIdentifier) {
          historyCursor = result.cursor
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (resyncRoomInFlight === roomIdentifier) {
          resyncRoomInFlight = null
        }
      })
  }

  function stop() {
    eventSource?.close()
    eventSource = null
    activeRoomIdentifier = null
    handlers.setStreaming(false)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (resyncTimer) {
      clearInterval(resyncTimer)
      resyncTimer = null
    }
  }

  function start(roomIdentifier: string) {
    const previousRoomIdentifier = activeRoomIdentifier
    stop()
    activeRoomIdentifier = roomIdentifier
    if (previousRoomIdentifier !== roomIdentifier) {
      historyCursor = handlers.getMessageCursor()
    }
    handlers.setConnectionState('connecting')

    eventSource = new EventSource(`${roomPath(roomIdentifier)}/messages/stream`)

    eventSource.onopen = () => {
      handlers.setConnectionState('live')
      handlers.setStreaming(true)
      reconnectDelay = 1200
      // SSE is a best-effort wake-up channel; history is the durable source
      // of truth. Reconcile immediately and periodically so both reconnect
      // gaps and silently dropped cross-instance reference events recover.
      resync(roomIdentifier)
      resyncTimer = setInterval(
        () => resync(roomIdentifier),
        options?.resyncIntervalMs ?? MESSAGE_RESYNC_INTERVAL_MS,
      )
    }

    eventSource.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data) as RoomMessage
        if (!isVisibleRoomMessage(message)) return
        if (!handlers.appendMessage(message)) return

        playNotificationSound()
        const source = (message.source || '').toLowerCase()
        const sender = (message.sender || '').toLowerCase()

        if (source === 'github' || sender === 'github') {
          handlers.onGitHubMessage()
        }
        if (message.sender === 'letagents' && message.text?.includes('task_')) {
          handlers.onTaskLifecycleMessage()
        }
        if (source === 'agent' || message.sender === 'letagents') {
          handlers.onAgentActivityMessage()
        }
        if (source === 'agent' || source === 'browser') {
          handlers.onParticipantActivityMessage()
        }
      } catch {
        // Ignore malformed SSE payloads.
      }
    })

    eventSource.addEventListener('task_update', (event) => {
      try {
        handlers.upsertTask(JSON.parse(event.data) as RoomTask)
        handlers.onArtifactUpdate(roomIdentifier)
      } catch {
        // Ignore malformed SSE payloads.
      }
    })

    eventSource.addEventListener('github_event', (event) => {
      try {
        const payload = JSON.parse(event.data)
        handlers.onGitHubEvent(
          typeof payload?.room_id === 'string' ? payload.room_id : roomIdentifier,
        )
      } catch {
        handlers.onGitHubEvent(roomIdentifier)
      }
    })

    eventSource.addEventListener('artifact_update', (event) => {
      try {
        const payload = JSON.parse(event.data)
        handlers.onArtifactUpdate(
          typeof payload?.room_id === 'string' ? payload.room_id : roomIdentifier,
        )
      } catch {
        handlers.onArtifactUpdate(roomIdentifier)
      }
    })

    eventSource.addEventListener('reasoning_update', (event) => {
      try {
        const payload = JSON.parse(event.data)
        const session = payload?.session || payload
        const update =
          payload?.update && typeof payload.update.id === 'string'
            ? (payload.update as RoomReasoningUpdate)
            : null
        if (session?.id) {
          handlers.upsertReasoningSession(session, update)
        }
      } catch {
        // Ignore malformed SSE payloads.
      }
    })

    eventSource.addEventListener('reasoning_remove', (event) => {
      try {
        const payload = JSON.parse(event.data)
        const sessionId =
          typeof payload?.session_id === 'string'
            ? payload.session_id
            : typeof payload?.id === 'string'
              ? payload.id
              : ''
        if (sessionId) {
          handlers.removeReasoningSession(sessionId)
        }
      } catch {
        // Ignore malformed SSE payloads.
      }
    })

    eventSource.onerror = () => {
      handlers.setConnectionState('error')
      handlers.setStreaming(false)
      eventSource?.close()
      eventSource = null

      reconnectTimer = setTimeout(() => {
        start(roomIdentifier)
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
    }
  }

  return { start, stop }
}
