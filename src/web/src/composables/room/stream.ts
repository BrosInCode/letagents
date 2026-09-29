import {
  ROOM_RESOURCE_AGENT_APPROVAL,
  ROOM_RESOURCE_INVALIDATION_CAPABILITY,
  parseRoomResourceInvalidation,
} from '../../../../../shared/room-resource-invalidation.mjs'
import { publishMessageInfoInvalidation } from '../../components/room/messageInfoInvalidation'
import { publishAgentApprovalInvalidation } from '../roomAgentApprovalInvalidation'
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
    authoritativeGap: boolean,
    isCurrent: () => boolean,
  ) => Promise<{ success: boolean; cursor: string | null; complete?: boolean }>
  reconcileFullState: (
    roomIdentifier: string,
    isCurrent: () => boolean,
  ) => Promise<boolean>
}

const MESSAGE_RESYNC_INTERVAL_MS = 15_000
const MAX_REMEMBERED_ROOM_EVENT_CURSORS = 32
const MAX_BUFFERED_GAP_EVENTS = 256
const MAX_BUFFERED_GAP_BYTES = 1024 * 1024
const GAP_REPAIR_RETRY_MS = 500
const MAX_GAP_REPAIR_RETRY_MS = 15_000
const STREAM_BOOTSTRAP_BARRIER_TIMEOUT_MS = 5_000

export function createRoomStream(
  handlers: RoomStreamHandlers,
  options?: {
    resyncIntervalMs?: number
    gapRepairRetryMs?: number
    gapBufferMaxEvents?: number
    gapBufferMaxBytes?: number
    bootstrapBarrierTimeoutMs?: number
  },
) {
  let eventSource: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let resyncTimer: ReturnType<typeof setInterval> | null = null
  const resyncPromises = new Map<string, Promise<boolean>>()
  let streamGeneration = 0
  let activeRoomIdentifier: string | null = null
  let historyCursor: string | null = null
  const eventCursors = new Map<string, string>()
  const pendingGapCursors = new Map<string, { present: boolean; cursor: string | null }>()
  let fullReconcileRequestedGeneration = 0
  let fullReconcileCompletedGeneration = 0
  let fullReconcileRequestedRoom: string | null = null
  let fullReconcileRequestedStreamGeneration = 0
  let fullReconcileDrain: Promise<void> | null = null
  let gapRepairRetryTimer: ReturnType<typeof setTimeout> | null = null
  let gapRepairRetryDelay = options?.gapRepairRetryMs ?? GAP_REPAIR_RETRY_MS
  let bufferedGapRoom: string | null = null
  let bufferedGapEvents: Array<() => void> = []
  let bufferedGapBytes = 0
  let bufferedGapOverflow = false
  let reconnectDelay = 1200
  let bootstrapRoom: string | null = null
  let bootstrapGeneration = 0
  let bootstrapSnapshotCommitted = false
  let bootstrapNeedsFullRepair = false
  let bootstrapCheckpointReceived = false
  let bootstrapBarrierTimer: ReturnType<typeof setTimeout> | null = null
  let resolveBootstrapBarrier: (() => void) | null = null
  let openRoomIdentifier: string | null = null
  let deferredBootstrapRepairRoom: string | null = null

  function clearBootstrapBarrierTimer() {
    if (bootstrapBarrierTimer) clearTimeout(bootstrapBarrierTimer)
    bootstrapBarrierTimer = null
  }

  function releaseBootstrapBarrier() {
    clearBootstrapBarrierTimer()
    resolveBootstrapBarrier?.()
    resolveBootstrapBarrier = null
  }

  function resetBootstrapState() {
    clearBootstrapBarrierTimer()
    resolveBootstrapBarrier?.()
    resolveBootstrapBarrier = null
    bootstrapRoom = null
    bootstrapGeneration = 0
    bootstrapSnapshotCommitted = false
    bootstrapNeedsFullRepair = false
    bootstrapCheckpointReceived = false
  }

  function resync(
    roomIdentifier: string,
    generation = streamGeneration,
  ): Promise<boolean> {
    const key = `${generation}\u0000${roomIdentifier}`
    const existing = resyncPromises.get(key)
    if (existing) return existing
    const pending = handlers.resyncMessages(
      roomIdentifier,
      historyCursor,
      pendingGapCursors.has(roomIdentifier),
      () => streamGeneration === generation && activeRoomIdentifier === roomIdentifier,
    )
      .then((result) => {
        if (
          result.success
          && activeRoomIdentifier === roomIdentifier
          && streamGeneration === generation
        ) {
          historyCursor = result.cursor
        }
        return streamGeneration === generation
          && result.success
          && result.complete !== false
      })
      .catch(() => false)
      .finally(() => {
        if (resyncPromises.get(key) === pending) resyncPromises.delete(key)
      })
    resyncPromises.set(key, pending)
    return pending
  }

  function reconcileFullState(
    roomIdentifier: string,
    generation = streamGeneration,
  ) {
    fullReconcileRequestedGeneration += 1
    fullReconcileRequestedRoom = roomIdentifier
    fullReconcileRequestedStreamGeneration = generation
    ensureFullReconcileDrain()
  }

  function clearGapRepairRetry() {
    if (gapRepairRetryTimer) clearTimeout(gapRepairRetryTimer)
    gapRepairRetryTimer = null
    gapRepairRetryDelay = options?.gapRepairRetryMs ?? GAP_REPAIR_RETRY_MS
  }

  function scheduleGapRepairRetry(roomIdentifier: string) {
    if (
      gapRepairRetryTimer
      || activeRoomIdentifier !== roomIdentifier
      || !pendingGapCursors.has(roomIdentifier)
    ) return
    const delay = gapRepairRetryDelay
    gapRepairRetryTimer = setTimeout(() => {
      gapRepairRetryTimer = null
      if (
        activeRoomIdentifier === roomIdentifier
        && pendingGapCursors.has(roomIdentifier)
      ) reconcileFullState(roomIdentifier)
    }, delay)
    gapRepairRetryDelay = Math.min(delay * 2, MAX_GAP_REPAIR_RETRY_MS)
  }

  function resetBufferedGapEvents(roomIdentifier?: string) {
    if (roomIdentifier && bufferedGapRoom !== roomIdentifier) return
    bufferedGapRoom = null
    bufferedGapEvents = []
    bufferedGapBytes = 0
    bufferedGapOverflow = false
  }

  function bufferOrApplyRoomEvent(
    roomIdentifier: string,
    apply: () => void,
    serializedBytes = 0,
  ) {
    if (!pendingGapCursors.has(roomIdentifier)) {
      apply()
      return
    }
    if (bufferedGapRoom !== roomIdentifier) {
      bufferedGapRoom = roomIdentifier
      bufferedGapEvents = []
      bufferedGapBytes = 0
      bufferedGapOverflow = false
    }
    if (bufferedGapOverflow) return
    if (
      bufferedGapEvents.length >= (options?.gapBufferMaxEvents ?? MAX_BUFFERED_GAP_EVENTS)
      || bufferedGapBytes + serializedBytes > (options?.gapBufferMaxBytes ?? MAX_BUFFERED_GAP_BYTES)
    ) {
      bufferedGapEvents = []
      bufferedGapBytes = 0
      bufferedGapOverflow = true
      return
    }
    bufferedGapEvents.push(apply)
    bufferedGapBytes += serializedBytes
  }

  function streamEventBytes(event: Event): number {
    const data = String((event as MessageEvent).data ?? '')
    return new TextEncoder().encode(data).byteLength
  }

  function replayBufferedGapEvents(roomIdentifier: string): boolean {
    if (bufferedGapRoom !== roomIdentifier) return true
    if (bufferedGapOverflow) {
      resetBufferedGapEvents(roomIdentifier)
      return false
    }
    try {
      for (const apply of bufferedGapEvents) apply()
      resetBufferedGapEvents(roomIdentifier)
      return true
    } catch {
      return false
    }
  }

  function ensureFullReconcileDrain() {
    if (fullReconcileDrain) return
    const drain = async () => {
      while (fullReconcileCompletedGeneration < fullReconcileRequestedGeneration) {
        const passGeneration = fullReconcileRequestedGeneration
        const passRoom = fullReconcileRequestedRoom
        const passStreamGeneration = fullReconcileRequestedStreamGeneration
        if (
          passRoom
          && activeRoomIdentifier === passRoom
          && streamGeneration === passStreamGeneration
        ) {
          const [messagesRepaired, fullStateRepaired] = await Promise.all([
            resync(passRoom, passStreamGeneration),
            handlers.reconcileFullState(
              passRoom,
              () => streamGeneration === passStreamGeneration
                && activeRoomIdentifier === passRoom,
            ).catch(() => false),
          ])
          if (
            messagesRepaired
            && fullStateRepaired
            && activeRoomIdentifier === passRoom
            && streamGeneration === passStreamGeneration
            && passGeneration === fullReconcileRequestedGeneration
          ) {
            publishAgentApprovalInvalidation(passRoom)
            if (replayBufferedGapEvents(passRoom)) {
              clearGapRepairRetry()
              commitPendingGapCursor(passRoom)
            } else {
              scheduleGapRepairRetry(passRoom)
            }
          } else if (
            activeRoomIdentifier === passRoom
            && streamGeneration === passStreamGeneration
            && passGeneration === fullReconcileRequestedGeneration
          ) {
            scheduleGapRepairRetry(passRoom)
          }
        }
        fullReconcileCompletedGeneration = passGeneration
      }
    }
    fullReconcileDrain = drain().finally(() => {
      fullReconcileDrain = null
      if (fullReconcileCompletedGeneration < fullReconcileRequestedGeneration) {
        ensureFullReconcileDrain()
      }
    })
  }

  function rememberEventCursor(roomIdentifier: string, event: Event, fallback?: unknown) {
    const eventCursor = typeof (event as MessageEvent).lastEventId === 'string'
      ? (event as MessageEvent).lastEventId
      : ''
    const cursor = eventCursor || (typeof fallback === 'string' ? fallback : '')
    if (!cursor) return
    if (pendingGapCursors.has(roomIdentifier)) {
      pendingGapCursors.delete(roomIdentifier)
      pendingGapCursors.set(roomIdentifier, { present: true, cursor })
      return
    }
    applyEventCursor(roomIdentifier, cursor)
  }

  function repairMalformedTypedEvent(roomIdentifier: string, _event: Event) {
    // The typed frame was not applied, so its lastEventId cannot become a
    // reconnect boundary. Full reconciliation starts from the last good id.
    if (!pendingGapCursors.has(roomIdentifier)) stageGapCursor(roomIdentifier, false, null)
    reconcileFullState(roomIdentifier)
  }

  function applyEventCursor(roomIdentifier: string, cursor: string) {
    eventCursors.delete(roomIdentifier)
    eventCursors.set(roomIdentifier, cursor)
    while (eventCursors.size > MAX_REMEMBERED_ROOM_EVENT_CURSORS) {
      const oldestRoomIdentifier = eventCursors.keys().next().value
      if (!oldestRoomIdentifier) break
      eventCursors.delete(oldestRoomIdentifier)
    }
  }

  function clearEventCursor(roomIdentifier: string) {
    eventCursors.delete(roomIdentifier)
  }

  function stageGapCursor(roomIdentifier: string, present: boolean, cursor: string | null) {
    const alreadyPending = pendingGapCursors.has(roomIdentifier)
    pendingGapCursors.delete(roomIdentifier)
    pendingGapCursors.set(roomIdentifier, { present, cursor })
    if (!alreadyPending || bufferedGapRoom !== roomIdentifier) {
      resetBufferedGapEvents()
      bufferedGapRoom = roomIdentifier
    }
    while (pendingGapCursors.size > MAX_REMEMBERED_ROOM_EVENT_CURSORS) {
      const oldestRoomIdentifier = pendingGapCursors.keys().next().value
      if (!oldestRoomIdentifier) break
      pendingGapCursors.delete(oldestRoomIdentifier)
    }
  }

  function stageOrApplySyncCursor(
    roomIdentifier: string,
    present: boolean,
    cursor: string | null,
  ) {
    if (!present) return
    if (pendingGapCursors.has(roomIdentifier)) {
      stageGapCursor(roomIdentifier, true, cursor)
    } else if (cursor) {
      applyEventCursor(roomIdentifier, cursor)
    } else {
      clearEventCursor(roomIdentifier)
    }
  }

  function commitPendingGapCursor(roomIdentifier: string) {
    const pending = pendingGapCursors.get(roomIdentifier)
    if (!pending) return
    pendingGapCursors.delete(roomIdentifier)
    resetBufferedGapEvents(roomIdentifier)
    if (!pending.present) return
    if (pending.cursor) applyEventCursor(roomIdentifier, pending.cursor)
    else clearEventCursor(roomIdentifier)
  }

  function startResyncLoop(roomIdentifier: string, immediate: boolean) {
    const generation = streamGeneration
    if (resyncTimer) clearInterval(resyncTimer)
    if (immediate) void resync(roomIdentifier, generation)
    resyncTimer = setInterval(
      () => resync(roomIdentifier, generation),
      options?.resyncIntervalMs ?? MESSAGE_RESYNC_INTERVAL_MS,
    )
  }

  function stop(preserveStartupState = false) {
    streamGeneration += 1
    resyncPromises.clear()
    eventSource?.close()
    eventSource = null
    openRoomIdentifier = null
    activeRoomIdentifier = null
    if (!preserveStartupState) {
      resetBootstrapState()
      deferredBootstrapRepairRoom = null
    }
    clearGapRepairRetry()
    if (!preserveStartupState) resetBufferedGapEvents()
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

  function start(
    roomIdentifier: string,
    bootstrap = false,
    preserveStartupState = false,
  ): Promise<void> {
    const previousRoomIdentifier = activeRoomIdentifier
    stop(preserveStartupState)
    const generation = streamGeneration
    activeRoomIdentifier = roomIdentifier
    if (preserveStartupState && bootstrapRoom === roomIdentifier) {
      bootstrapGeneration = generation
    }
    let bootstrapBarrier = Promise.resolve()
    if (bootstrap && !preserveStartupState) {
      bootstrapRoom = roomIdentifier
      bootstrapGeneration = generation
      bootstrapSnapshotCommitted = false
      bootstrapNeedsFullRepair = false
      bootstrapCheckpointReceived = false
      // Subscribe before reading any of the room snapshots. Typed events are
      // retained behind this boundary until the initial broker checkpoint and
      // every snapshot resource have both landed.
      stageGapCursor(roomIdentifier, false, null)
      bootstrapBarrier = new Promise<void>((resolve) => {
        resolveBootstrapBarrier = resolve
        bootstrapBarrierTimer = setTimeout(() => {
          bootstrapBarrierTimer = null
          bootstrapNeedsFullRepair = true
          resolveBootstrapBarrier = null
          resolve()
        }, options?.bootstrapBarrierTimeoutMs ?? STREAM_BOOTSTRAP_BARRIER_TIMEOUT_MS)
      })
    }
    if (previousRoomIdentifier !== roomIdentifier) {
      historyCursor = handlers.getMessageCursor()
      reconnectDelay = 1200
    }
    handlers.setConnectionState('connecting')

    const eventCursor = eventCursors.get(roomIdentifier)
    const streamParams = new URLSearchParams()
    if (eventCursor) streamParams.set('event_cursor', eventCursor)
    streamParams.append('stream_capability', ROOM_RESOURCE_INVALIDATION_CAPABILITY)
    const source = new EventSource(
      `${roomPath(roomIdentifier)}/messages/stream?${streamParams.toString()}`,
    )
    eventSource = source
    const isCurrentSource = () => eventSource === source
      && activeRoomIdentifier === roomIdentifier
      && streamGeneration === generation

    if (pendingGapCursors.has(roomIdentifier) && bootstrapRoom !== roomIdentifier) {
      reconcileFullState(roomIdentifier)
    }

    source.onopen = () => {
      if (!isCurrentSource()) return
      openRoomIdentifier = roomIdentifier
      handlers.setConnectionState('live')
      handlers.setStreaming(true)
      reconnectDelay = 1200
      // SSE is a best-effort wake-up channel; history is the durable source
      // of truth. Reconcile immediately and periodically so both reconnect
      // gaps and silently dropped cross-instance reference events recover.
      if (deferredBootstrapRepairRoom === roomIdentifier) {
        deferredBootstrapRepairRoom = null
        reconcileFullState(roomIdentifier)
      }
      if (bootstrapRoom !== roomIdentifier) startResyncLoop(roomIdentifier, true)
    }

    source.addEventListener('message', (event) => {
      if (!isCurrentSource()) return
      try {
        const message = JSON.parse(event.data) as RoomMessage
        if (!message || typeof message.id !== 'string' || !message.id) {
          repairMalformedTypedEvent(roomIdentifier, event)
          return
        }
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
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
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('task_update', (event) => {
      if (!isCurrentSource()) return
      try {
        const task = JSON.parse(event.data) as RoomTask
        if (!task || typeof task.id !== 'string' || !task.id) {
          repairMalformedTypedEvent(roomIdentifier, event)
          return
        }
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
          handlers.upsertTask(task)
          handlers.onArtifactUpdate(roomIdentifier)
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('github_event', (event) => {
      if (!isCurrentSource()) return
      try {
        const payload = JSON.parse(event.data)
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
          handlers.onGitHubEvent(
            typeof payload?.room_id === 'string' ? payload.room_id : roomIdentifier,
          )
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('artifact_update', (event) => {
      if (!isCurrentSource()) return
      try {
        const payload = JSON.parse(event.data)
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
          handlers.onArtifactUpdate(
            typeof payload?.room_id === 'string' ? payload.room_id : roomIdentifier,
          )
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('reasoning_update', (event) => {
      if (!isCurrentSource()) return
      try {
        const payload = JSON.parse(event.data)
        const session = payload?.session || payload
        const update =
          payload?.update && typeof payload.update.id === 'string'
            ? (payload.update as RoomReasoningUpdate)
            : null
        if (typeof session?.id !== 'string' || !session.id) {
          repairMalformedTypedEvent(roomIdentifier, event)
          return
        }
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
          handlers.upsertReasoningSession(session, update)
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('reasoning_remove', (event) => {
      if (!isCurrentSource()) return
      try {
        const payload = JSON.parse(event.data)
        const sessionId =
          typeof payload?.session_id === 'string'
            ? payload.session_id
            : typeof payload?.id === 'string'
              ? payload.id
              : ''
        if (!sessionId) {
          repairMalformedTypedEvent(roomIdentifier, event)
          return
        }
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
          handlers.removeReasoningSession(sessionId)
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('message_info_updated', (event) => {
      if (!isCurrentSource()) return
      try {
        const payload = JSON.parse(event.data)
        const roomId = typeof payload?.room_id === 'string' ? payload.room_id : roomIdentifier
        const messageIds = payload?.message_ids
        if (messageIds !== null && (!Array.isArray(messageIds) || messageIds.some(
          (id: unknown) => typeof id !== 'string' || !id,
        ))) {
          repairMalformedTypedEvent(roomIdentifier, event)
          return
        }
        rememberEventCursor(roomIdentifier, event)
        bufferOrApplyRoomEvent(roomIdentifier, () => {
          // Null deliberately conceals message identities. The open info card
          // refreshes through its authorized GET, without inventing per-id scope.
          publishMessageInfoInvalidation(roomId, messageIds)
        }, streamEventBytes(event))
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener(ROOM_RESOURCE_INVALIDATION_CAPABILITY, (event) => {
      if (!isCurrentSource()) return
      try {
        const result = parseRoomResourceInvalidation(JSON.parse(event.data))
        if (result.status === 'malformed' || result.pointer.room_id !== roomIdentifier) {
          repairMalformedTypedEvent(roomIdentifier, event)
          return
        }
        rememberEventCursor(roomIdentifier, event)
        if (
          result.status === 'supported'
          && result.pointer.resource === ROOM_RESOURCE_AGENT_APPROVAL
        ) {
          bufferOrApplyRoomEvent(roomIdentifier, () => {
            publishAgentApprovalInvalidation(roomIdentifier)
          }, streamEventBytes(event))
        }
      } catch {
        repairMalformedTypedEvent(roomIdentifier, event)
      }
    })

    source.addEventListener('room_sync', (event) => {
      if (!isCurrentSource()) return
      if (bootstrapRoom === roomIdentifier) bootstrapCheckpointReceived = true
      try {
        const payload = JSON.parse(event.data)
        const eventCursor = typeof (event as MessageEvent).lastEventId === 'string'
          ? (event as MessageEvent).lastEventId
          : ''
        const cursorPresent = Object.prototype.hasOwnProperty.call(payload, 'event_cursor')
          || Boolean(eventCursor)
        const cursor = typeof payload?.event_cursor === 'string'
          ? payload.event_cursor
          : payload?.event_cursor === null
            ? null
            : eventCursor || null
        if (payload?.gap === true) {
          stageGapCursor(roomIdentifier, cursorPresent, cursor)
          if (bootstrapRoom === roomIdentifier && !bootstrapSnapshotCommitted) {
            bootstrapNeedsFullRepair = true
          } else {
            reconcileFullState(roomIdentifier)
          }
        } else {
          stageOrApplySyncCursor(roomIdentifier, cursorPresent, cursor)
        }
        if (bootstrapRoom === roomIdentifier && !bootstrapSnapshotCommitted) {
          releaseBootstrapBarrier()
        }
      } catch {
        stageGapCursor(roomIdentifier, false, null)
        if (bootstrapRoom === roomIdentifier && !bootstrapSnapshotCommitted) {
          bootstrapNeedsFullRepair = true
          releaseBootstrapBarrier()
        } else {
          reconcileFullState(roomIdentifier)
        }
      }
    })

    source.onerror = () => {
      if (!isCurrentSource()) return
      handlers.setConnectionState('error')
      handlers.setStreaming(false)
      source.close()
      if (eventSource === source) eventSource = null
      openRoomIdentifier = null
      const preserveStartupState = bootstrapRoom === roomIdentifier
        || deferredBootstrapRepairRoom === roomIdentifier
      const reconnectBootstrap = bootstrapRoom === roomIdentifier && !bootstrapSnapshotCommitted
      if (reconnectBootstrap) {
        bootstrapNeedsFullRepair = true
        releaseBootstrapBarrier()
      }

      if (reconnectTimer) return

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void start(roomIdentifier, false, preserveStartupState)
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
    }

    return bootstrapBarrier
  }

  function finishBootstrap(roomIdentifier: string, snapshotCommitted: boolean) {
    if (
      bootstrapRoom !== roomIdentifier
      || activeRoomIdentifier !== roomIdentifier
      || bootstrapGeneration !== streamGeneration
    ) return
    bootstrapSnapshotCommitted = snapshotCommitted
    releaseBootstrapBarrier()
    const needsRepair = !snapshotCommitted || bootstrapNeedsFullRepair || bufferedGapOverflow
    const canRepairAuthoritatively = openRoomIdentifier === roomIdentifier
      || bootstrapCheckpointReceived
    bootstrapRoom = null
    bootstrapGeneration = 0
    bootstrapSnapshotCommitted = false
    bootstrapNeedsFullRepair = false
    bootstrapCheckpointReceived = false
    if (needsRepair) {
      if (canRepairAuthoritatively) reconcileFullState(roomIdentifier)
      else deferredBootstrapRepairRoom = roomIdentifier
      if (openRoomIdentifier === roomIdentifier) startResyncLoop(roomIdentifier, false)
      return
    }
    if (replayBufferedGapEvents(roomIdentifier)) {
      commitPendingGapCursor(roomIdentifier)
    } else {
      reconcileFullState(roomIdentifier)
    }
    if (openRoomIdentifier === roomIdentifier) startResyncLoop(roomIdentifier, false)
  }

  return {
    start: (roomIdentifier: string, bootstrap = false) => start(roomIdentifier, bootstrap),
    finishBootstrap,
    stop: () => stop(),
  }
}
