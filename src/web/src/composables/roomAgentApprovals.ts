import {
  computed,
  onScopeDispose,
  ref,
  watch,
  type Ref,
} from 'vue'
import type { ExecutionApprovalPublicationItem } from '../../../../shared/execution-approval-publication-item.mjs'
import type { ExecutionDelegationDecisionChoice } from '../../../../shared/execution-delegation-decision.mjs'
import {
  RoomAgentApprovalHttpError,
  fetchRoomAgentApprovalEvidence,
  fetchRoomAgentApprovals,
  submitRoomAgentApprovalDecision,
} from './roomAgentApprovalApi'
import { lastAgentApprovalInvalidation } from './roomAgentApprovalInvalidation'
import type { RoomAgentApprovalEntry } from './roomAgentApprovalTypes'

const MIN_EXPIRY_REFRESH_DELAY_MS = 30_000

interface ApprovalRefreshFlight {
  generation: number
  trailing: boolean
  promise: Promise<boolean>
}

function emptyEntry(publication: ExecutionApprovalPublicationItem): RoomAgentApprovalEntry {
  return {
    publication,
    evidenceStatus: 'idle',
    projectionJson: null,
    projection: null,
    evidenceError: '',
    decisionBusy: false,
    decisionError: '',
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isConcealed(error: unknown): boolean {
  return error instanceof RoomAgentApprovalHttpError && [401, 403, 404].includes(error.status)
}

export function useRoomAgentApprovals(roomIdentifier: Ref<string>) {
  const entries = ref<RoomAgentApprovalEntry[]>([])
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  const nextCursor = ref<string | null>(null)
  let generation = 0
  let refreshFlight: ApprovalRefreshFlight | null = null
  let expiryTimer: ReturnType<typeof setTimeout> | null = null
  let serverClockOffsetMs: number | null = null
  const decisionRequestIds = new Map<string, string>()

  function clearExpiryTimer(): void {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
  }

  function scheduleExpiryRefresh(): void {
    clearExpiryTimer()
    const earliest = entries.value.reduce<number | null>((result, entry) => {
      const expiresAt = Date.parse(entry.publication.expires_at)
      return Number.isFinite(expiresAt) && (result === null || expiresAt < result)
        ? expiresAt
        : result
    }, null)
    if (earliest === null) return
    const serverNow = Date.now() + (serverClockOffsetMs ?? 0)
    const delay = Math.min(
      Math.max(earliest - serverNow + 25, MIN_EXPIRY_REFRESH_DELAY_MS),
      2_147_483_647,
    )
    expiryTimer = setTimeout(() => { void refresh() }, delay)
  }

  function replaceEntries(publications: ExecutionApprovalPublicationItem[]): void {
    const previous = new Map(entries.value.map((entry) => [
      `${entry.publication.publication_id}\u0000${entry.publication.projection_sha256}`,
      entry,
    ]))
    entries.value = publications.map((publication) => previous.get(
      `${publication.publication_id}\u0000${publication.projection_sha256}`,
    ) ?? emptyEntry(publication))
    scheduleExpiryRefresh()
  }

  function updateEntry(
    publicationId: string,
    update: (entry: RoomAgentApprovalEntry) => RoomAgentApprovalEntry,
  ): void {
    entries.value = entries.value.map((entry) =>
      entry.publication.publication_id === publicationId ? update(entry) : entry)
  }

  async function refreshOnce(): Promise<boolean> {
    const roomId = roomIdentifier.value
    const requestGeneration = generation
    if (!roomId) return false
    if (!entries.value.length) loading.value = true
    try {
      const page = await fetchRoomAgentApprovals(roomId)
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return false
      serverClockOffsetMs = page.serverNow === null ? null : page.serverNow - Date.now()
      replaceEntries(page.publications)
      nextCursor.value = page.nextCursor
      error.value = ''
      return true
    } catch (cause) {
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return false
      if (isConcealed(cause)) {
        replaceEntries([])
        nextCursor.value = null
        error.value = ''
        return true
      }
      error.value = message(cause, 'Approval requests could not be loaded.')
      return false
    } finally {
      if (requestGeneration === generation) loading.value = false
    }
  }

  async function refresh(): Promise<boolean> {
    if (refreshFlight?.generation === generation) {
      refreshFlight.trailing = true
      return refreshFlight.promise
    }
    const flight: ApprovalRefreshFlight = {
      generation,
      trailing: false,
      promise: Promise.resolve(false),
    }
    flight.promise = (async () => {
      let success = true
      do {
        flight.trailing = false
        success = await refreshOnce() && success
      } while (flight.trailing && flight.generation === generation)
      return success
    })().finally(() => {
      if (refreshFlight === flight) refreshFlight = null
    })
    refreshFlight = flight
    return flight.promise
  }

  async function loadMore(): Promise<void> {
    const roomId = roomIdentifier.value
    const cursor = nextCursor.value
    const requestGeneration = generation
    if (!roomId || !cursor || loadingMore.value) return
    loadingMore.value = true
    try {
      const page = await fetchRoomAgentApprovals(roomId, cursor)
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return
      serverClockOffsetMs = page.serverNow === null ? null : page.serverNow - Date.now()
      const known = new Set(entries.value.map((entry) => entry.publication.publication_id))
      entries.value = [
        ...entries.value,
        ...page.publications.filter((publication) => !known.has(publication.publication_id))
          .map(emptyEntry),
      ]
      nextCursor.value = page.nextCursor
      error.value = ''
      scheduleExpiryRefresh()
    } catch (cause) {
      if (requestGeneration !== generation) return
      if (isConcealed(cause)) {
        replaceEntries([])
        nextCursor.value = null
        error.value = ''
      } else {
        error.value = message(cause, 'More approval requests could not be loaded.')
      }
    } finally {
      if (requestGeneration === generation) loadingMore.value = false
    }
  }

  async function loadEvidence(publicationId: string): Promise<void> {
    const entry = entries.value.find((item) => item.publication.publication_id === publicationId)
    const roomId = roomIdentifier.value
    const requestGeneration = generation
    if (!entry || !roomId || entry.evidenceStatus === 'loading') return
    updateEntry(publicationId, (current) => ({
      ...current,
      evidenceStatus: 'loading',
      evidenceError: '',
    }))
    try {
      const evidence = await fetchRoomAgentApprovalEvidence(roomId, entry.publication)
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return
      updateEntry(publicationId, (current) => ({
        ...current,
        evidenceStatus: evidence.status,
        projectionJson: evidence.status === 'ready' ? evidence.projectionJson : null,
        projection: evidence.status === 'ready' ? evidence.projection : null,
        evidenceError: evidence.status === 'invalid' ? evidence.message : '',
      }))
      if (evidence.status === 'unavailable') void refresh()
    } catch (cause) {
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return
      updateEntry(publicationId, (current) => ({
        ...current,
        evidenceStatus: 'error',
        evidenceError: message(cause, 'Approval reference could not be loaded.'),
      }))
    }
  }

  async function decide(
    publicationId: string,
    decision: ExecutionDelegationDecisionChoice,
  ): Promise<void> {
    const entry = entries.value.find((item) => item.publication.publication_id === publicationId)
    const requestGeneration = generation
    if (!entry || entry.evidenceStatus !== 'ready' || entry.decisionBusy) return
    const requestKey = `${publicationId}\u0000${decision}`
    const clientRequestId = decisionRequestIds.get(requestKey) ?? crypto.randomUUID()
    decisionRequestIds.set(requestKey, clientRequestId)
    updateEntry(publicationId, (current) => ({
      ...current,
      decisionBusy: true,
      decisionError: '',
    }))
    try {
      await submitRoomAgentApprovalDecision(entry.publication, decision, clientRequestId)
      if (requestGeneration !== generation) return
      await refresh()
    } catch (cause) {
      if (requestGeneration !== generation) return
      if (cause instanceof RoomAgentApprovalHttpError && [404, 409].includes(cause.status)) {
        await refresh()
      } else {
        updateEntry(publicationId, (current) => ({
          ...current,
          decisionError: message(cause, 'The decision could not be confirmed.'),
        }))
      }
    } finally {
      if (requestGeneration === generation) {
        updateEntry(publicationId, (current) => ({ ...current, decisionBusy: false }))
      }
    }
  }

  watch(roomIdentifier, () => {
    generation += 1
    clearExpiryTimer()
    loading.value = false
    loadingMore.value = false
    serverClockOffsetMs = null
    entries.value = []
    nextCursor.value = null
    error.value = ''
    decisionRequestIds.clear()
    if (roomIdentifier.value) void refresh()
  }, { immediate: true })

  watch(lastAgentApprovalInvalidation, (invalidation) => {
    if (invalidation?.roomId === roomIdentifier.value) void refresh()
  })

  onScopeDispose(() => {
    generation += 1
    clearExpiryTimer()
  })

  return {
    entries,
    loading,
    loadingMore,
    error,
    hasMore: computed(() => nextCursor.value !== null),
    refresh,
    loadMore,
    loadEvidence,
    decide,
  }
}
