export interface ReadRangePayload {
  scope_kind: 'timeline' | 'thread'
  thread_root_id?: string
  first_message_id: string
  last_message_id: string
  client_batch_id: string
}

export interface QualifiedRead {
  seq: number
  /** Root sequence when the row is a thread reply; null for timeline rows. */
  threadRootSeq: number | null
}

/**
 * Compress qualified message numbers into contiguous ranges. Reads are
 * evidence per message: a gap in the qualified set must never be collapsed
 * into one min/max range that claims unseen messages were read.
 */
export function compressSequencesToRanges(sequences: Iterable<number>): Array<{ first: number; last: number }> {
  const sorted = [...new Set(sequences)].sort((a, b) => a - b)
  const ranges: Array<{ first: number; last: number }> = []
  for (const seq of sorted) {
    const current = ranges[ranges.length - 1]
    if (current && seq === current.last + 1) {
      current.last = seq
    } else {
      ranges.push({ first: seq, last: seq })
    }
  }
  return ranges
}

/**
 * Evidence is scope-safe: timeline rows and each thread's replies compress
 * into separate ranges, so a timeline range can never claim thread replies
 * were read (and vice versa) — the server only accepts matching scopes.
 */
export function buildReadRangePayloads(
  reads: Iterable<QualifiedRead>,
  makeBatchId: () => string,
): ReadRangePayload[] {
  const byScope = new Map<string, { threadRootSeq: number | null; seqs: number[] }>()
  for (const read of reads) {
    const key = read.threadRootSeq === null ? 'timeline' : `thread:${read.threadRootSeq}`
    const scope = byScope.get(key) ?? { threadRootSeq: read.threadRootSeq, seqs: [] }
    scope.seqs.push(read.seq)
    byScope.set(key, scope)
  }
  const payloads: ReadRangePayload[] = []
  for (const scope of byScope.values()) {
    for (const range of compressSequencesToRanges(scope.seqs)) {
      payloads.push({
        scope_kind: scope.threadRootSeq === null ? 'timeline' : 'thread',
        ...(scope.threadRootSeq === null ? {} : { thread_root_id: `msg_${scope.threadRootSeq}` }),
        first_message_id: `msg_${range.first}`,
        last_message_id: `msg_${range.last}`,
        client_batch_id: makeBatchId(),
      })
    }
  }
  return payloads
}

export interface ReadEvidenceReporter {
  readonly roomIdentifier: string
  /** Record one qualified row. Dedupes per room; no-ops after dispose. */
  qualify(seq: number, threadRootSeq: number | null): void
  flush(): Promise<void>
  /** Cancel scheduling and flush remaining evidence against THIS room. */
  dispose(): Promise<void>
}

/**
 * Read evidence is room-scoped state. One reporter is created per room and
 * captures its room identifier at creation, so evidence gathered in Room A
 * can never be submitted to Room B after a switch — and Room B gets its own
 * reported-set, so B's messages with the same numbers still report.
 */
export function createReadEvidenceReporter(options: {
  roomIdentifier: string
  fetchFn?: typeof fetch
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Returns a cancel function. Defaults to a 1s debounce timer. */
  scheduleFlush?: (run: () => void) => () => void
  makeBatchId?: () => string
}): ReadEvidenceReporter {
  const roomIdentifier = options.roomIdentifier
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const storage = options.storage ?? window.localStorage
  const makeBatchId = options.makeBatchId
    ?? (() => `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  const scheduleFlush = options.scheduleFlush ?? ((run) => {
    const timer = setTimeout(run, 1000)
    return () => clearTimeout(timer)
  })

  const pending = new Map<number, number | null>()
  const reported = new Set<number>()
  let cancelScheduled: (() => void) | null = null
  let disposed = false
  let chain: Promise<void> = Promise.resolve()

  async function performFlush(): Promise<void> {
    const reads = [...pending.entries()].map(([seq, threadRootSeq]) => ({ seq, threadRootSeq }))
    pending.clear()
    const fresh = buildReadRangePayloads(reads, makeBatchId)
    const queue = [...loadReadOutbox(storage, roomIdentifier), ...fresh]
    if (queue.length === 0) return
    try {
      const res = await fetchFn(`/api/rooms/${encodeURIComponent(roomIdentifier)}/messages/read`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ranges: queue }),
      })
      saveReadOutbox(storage, roomIdentifier, res.ok ? [] : queue)
    } catch {
      // Offline or transient failure: the durable outbox replays idempotently
      // (same client_batch_id) on the next flush.
      saveReadOutbox(storage, roomIdentifier, queue)
    }
  }

  function flush(): Promise<void> {
    cancelScheduled?.()
    cancelScheduled = null
    if (!roomIdentifier) return chain
    chain = chain.then(performFlush)
    return chain
  }

  return {
    roomIdentifier,
    qualify(seq, threadRootSeq) {
      if (disposed || !roomIdentifier || reported.has(seq)) return
      reported.add(seq)
      pending.set(seq, threadRootSeq)
      if (!cancelScheduled) {
        cancelScheduled = scheduleFlush(() => {
          cancelScheduled = null
          void flush()
        })
      }
    },
    flush,
    dispose() {
      if (disposed) return chain
      disposed = true
      return flush()
    },
  }
}

const OUTBOX_CAP = 20

function outboxKey(roomIdentifier: string): string {
  return `letagents:read-outbox:${roomIdentifier}`
}

/** Failed batches wait in a small durable outbox and replay idempotently. */
export function loadReadOutbox(storage: Pick<Storage, 'getItem'>, roomIdentifier: string): ReadRangePayload[] {
  try {
    const raw = storage.getItem(outboxKey(roomIdentifier))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.slice(0, OUTBOX_CAP) : []
  } catch {
    return []
  }
}

export function saveReadOutbox(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  roomIdentifier: string,
  entries: ReadRangePayload[],
): void {
  try {
    if (entries.length === 0) {
      storage.removeItem(outboxKey(roomIdentifier))
      return
    }
    storage.setItem(outboxKey(roomIdentifier), JSON.stringify(entries.slice(-OUTBOX_CAP)))
  } catch {
    // Storage may be unavailable (private mode, quota); reads stay best-effort.
  }
}
