import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildReadRangePayloads,
  compressSequencesToRanges,
  createReadEvidenceReporter,
  loadReadOutbox,
  saveReadOutbox,
  type ReadRangePayload,
} from '../src/components/room/readEvidence'

function mapStorage() {
  const backing = new Map<string, string>()
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  }
}

function recordingFetch(calls: Array<{ url: string; ranges: ReadRangePayload[] }>) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ranges: JSON.parse(String(init?.body)).ranges })
    return { ok: true } as Response
  }) as typeof fetch
}

test('qualified reads compress into contiguous ranges and never bridge gaps', () => {
  assert.deepEqual(compressSequencesToRanges([]), [])
  assert.deepEqual(compressSequencesToRanges([5]), [{ first: 5, last: 5 }])
  assert.deepEqual(compressSequencesToRanges([3, 1, 2]), [{ first: 1, last: 3 }])
  assert.deepEqual(compressSequencesToRanges([1, 2, 3, 7, 8, 12]), [
    { first: 1, last: 3 },
    { first: 7, last: 8 },
    { first: 12, last: 12 },
  ])
  assert.deepEqual(compressSequencesToRanges([4, 4, 5]), [{ first: 4, last: 5 }], 'duplicates collapse')
})

test('read payloads carry one batch id per contiguous range', () => {
  let batch = 0
  const payloads = buildReadRangePayloads(
    [10, 11, 20].map((seq) => ({ seq, threadRootSeq: null })),
    () => `b${++batch}`,
  )
  assert.deepEqual(payloads, [
    { scope_kind: 'timeline', first_message_id: 'msg_10', last_message_id: 'msg_11', client_batch_id: 'b1' },
    { scope_kind: 'timeline', first_message_id: 'msg_20', last_message_id: 'msg_20', client_batch_id: 'b2' },
  ])
})

test('read payloads group by scope: thread replies report thread evidence, never timeline', () => {
  let batch = 0
  const payloads = buildReadRangePayloads(
    [
      { seq: 10, threadRootSeq: null },
      { seq: 11, threadRootSeq: 5 },
      { seq: 12, threadRootSeq: 5 },
      { seq: 13, threadRootSeq: null },
      { seq: 30, threadRootSeq: 7 },
    ],
    () => `b${++batch}`,
  )
  assert.deepEqual(payloads.filter((p) => p.scope_kind === 'timeline'), [
    { scope_kind: 'timeline', first_message_id: 'msg_10', last_message_id: 'msg_10', client_batch_id: 'b1' },
    { scope_kind: 'timeline', first_message_id: 'msg_13', last_message_id: 'msg_13', client_batch_id: 'b2' },
  ], 'timeline evidence never absorbs thread replies between its rows')
  assert.deepEqual(payloads.filter((p) => p.scope_kind === 'thread'), [
    { scope_kind: 'thread', thread_root_id: 'msg_5', first_message_id: 'msg_11', last_message_id: 'msg_12', client_batch_id: 'b3' },
    { scope_kind: 'thread', thread_root_id: 'msg_7', first_message_id: 'msg_30', last_message_id: 'msg_30', client_batch_id: 'b4' },
  ])
})

test('the read outbox round-trips, caps its size, and tolerates corrupt storage', () => {
  const backing = new Map<string, string>()
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  }
  const entry = (n: number): ReadRangePayload => ({
    scope_kind: 'timeline',
    first_message_id: `msg_${n}`,
    last_message_id: `msg_${n}`,
    client_batch_id: `b${n}`,
  })

  assert.deepEqual(loadReadOutbox(storage, 'room_a'), [])
  saveReadOutbox(storage, 'room_a', [entry(1), entry(2)])
  assert.deepEqual(loadReadOutbox(storage, 'room_a').map((e) => e.client_batch_id), ['b1', 'b2'])

  saveReadOutbox(storage, 'room_a', Array.from({ length: 30 }, (_, i) => entry(i)))
  assert.equal(loadReadOutbox(storage, 'room_a').length, 20, 'outbox keeps at most 20 entries')

  saveReadOutbox(storage, 'room_a', [])
  assert.deepEqual(loadReadOutbox(storage, 'room_a'), [])

  backing.set('letagents:read-outbox:room_a', '{corrupt')
  assert.deepEqual(loadReadOutbox(storage, 'room_a'), [], 'corrupt storage reads as empty')
})

test('room switch: evidence flushes against its captured room and never leaks into the next', async () => {
  const calls: Array<{ url: string; ranges: ReadRangePayload[] }> = []
  let batch = 0
  const shared = {
    fetchFn: recordingFetch(calls),
    storage: mapStorage(),
    scheduleFlush: () => () => {},
    makeBatchId: () => `b${++batch}`,
  }

  const roomA = createReadEvidenceReporter({ roomIdentifier: 'room_a', ...shared })
  roomA.qualify(5, null)
  roomA.qualify(6, null)

  // The user switches rooms before the debounce fires: the new reporter is
  // created first (as the component does), then the old one is retired.
  const roomB = createReadEvidenceReporter({ roomIdentifier: 'room_b', ...shared })
  await roomA.dispose()

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /rooms\/room_a\/messages\/read/, 'pending Room A evidence is submitted to Room A')
  assert.deepEqual(
    calls[0].ranges.map((r) => [r.first_message_id, r.last_message_id]),
    [['msg_5', 'msg_6']],
  )

  // Room B has its own reported-set: matching message numbers still report.
  roomB.qualify(5, null)
  await roomB.flush()
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /rooms\/room_b\/messages\/read/)
  assert.deepEqual(calls[1].ranges.map((r) => r.first_message_id), ['msg_5'])

  // The retired reporter refuses new evidence entirely.
  roomA.qualify(7, null)
  await roomA.flush()
  assert.equal(calls.length, 2, 'a disposed reporter never submits again')
})

test('a reporter reports each message at most once within its room', async () => {
  const calls: Array<{ url: string; ranges: ReadRangePayload[] }> = []
  let batch = 0
  const reporter = createReadEvidenceReporter({
    roomIdentifier: 'room_a',
    fetchFn: recordingFetch(calls),
    storage: mapStorage(),
    scheduleFlush: () => () => {},
    makeBatchId: () => `b${++batch}`,
  })
  reporter.qualify(9, null)
  reporter.qualify(9, null)
  await reporter.flush()
  reporter.qualify(9, null)
  await reporter.flush()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].ranges.map((r) => r.first_message_id), ['msg_9'])
})
