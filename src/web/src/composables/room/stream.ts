import { roomPath } from './api'
import { isPromptOnlyRoomMessage } from './identity'
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
  onTaskLifecycleMessage: () => void
  onAgentActivityMessage: () => void
  onParticipantActivityMessage: () => void
  upsertTask: (task: RoomTask) => void
  upsertReasoningSession: (
    session: RoomReasoningSession,
    update?: RoomReasoningUpdate | null,
  ) => void
  removeReasoningSession: (sessionId: string) => void
}

export function createRoomStream(handlers: RoomStreamHandlers) {
  let eventSource: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1200

  function stop() {
    eventSource?.close()
    eventSource = null
    handlers.setStreaming(false)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function start(roomIdentifier: string) {
    stop()
    handlers.setConnectionState('connecting')

    eventSource = new EventSource(`${roomPath(roomIdentifier)}/messages/stream`)

    eventSource.onopen = () => {
      handlers.setConnectionState('live')
      handlers.setStreaming(true)
      reconnectDelay = 1200
    }

    eventSource.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data) as RoomMessage
        if (isPromptOnlyRoomMessage(message)) return
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
      } catch {
        // Ignore malformed SSE payloads.
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
