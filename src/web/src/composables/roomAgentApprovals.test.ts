import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { effectScope, ref } from 'vue'
import type { ExecutionApprovalPublicationItem } from '../../../../shared/execution-approval-publication-item.mjs'
import {
  fetchRoomAgentApprovalEvidence,
  fetchRoomAgentApprovals,
  submitRoomAgentApprovalDecision,
} from './roomAgentApprovalApi.js'
import {
  useRoomAgentApprovals,
} from './roomAgentApprovals.js'
import { publishAgentApprovalInvalidation } from './roomAgentApprovalInvalidation.js'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function publication(overrides: Partial<ExecutionApprovalPublicationItem> = {}): ExecutionApprovalPublicationItem {
  return {
    publication_id: 'publication_1',
    room_id: 'room_1',
    agent_key: 'EmmyMay/gardenpoint',
    delegation_instance_id: 'delegation_1',
    delegation_revision: 3,
    request_id: 'request_1',
    request_version: 2,
    request_sha256: 'a'.repeat(64),
    projection_sha256: 'b'.repeat(64),
    published_at: '2026-09-03T10:00:00.000Z',
    expires_at: '2036-09-03T10:00:00.000Z',
    ...overrides,
  }
}

const projectionJson = JSON.stringify({
  version: 1,
  category: 'file_change',
  path_scope: 'workspace_relative',
  changes: [{
    path: 'src/a.ts',
    kind: 'update',
    move_path: null,
    added_lines: 4,
    removed_lines: 1,
    diff_bytes: 90,
  }],
  totals: { file_count: 1, added_lines: 4, removed_lines: 1, diff_bytes: 90 },
})

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('approval reads preserve and verify the exact served canonical bytes', async () => {
  const item = publication({ projection_sha256: digest(projectionJson) })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    return requests.length === 1
      ? jsonResponse({ publications: [item], next_cursor: null })
      : new Response(projectionJson, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const page = await fetchRoomAgentApprovals('room_1')
  const evidence = await fetchRoomAgentApprovalEvidence('room_1', page.publications[0])

  assert.equal(evidence.status, 'ready')
  assert.equal(evidence.status === 'ready' && evidence.projectionJson, projectionJson)
  assert.equal(evidence.status === 'ready' && evidence.projection.changes[0].path, 'src/a.ts')
  assert.deepEqual(requests, [
    '/rooms/room_1/agent-approvals',
    '/rooms/room_1/agent-approvals/publication_1/projection',
  ])
})

test('approval reads distinguish unsupported, tampered, and unavailable references', async () => {
  const futureJson = JSON.stringify({ version: 2, opaque: 'future' })
  const responses = [
    new Response(futureJson, { status: 200 }),
    new Response(projectionJson, { status: 200 }),
    jsonResponse({ error: 'not found' }, 404),
  ]
  globalThis.fetch = async () => responses.shift()!

  assert.deepEqual(
    await fetchRoomAgentApprovalEvidence('room_1', publication({ projection_sha256: digest(futureJson) })),
    { status: 'unsupported' },
  )
  assert.deepEqual(
    await fetchRoomAgentApprovalEvidence('room_1', publication({ projection_sha256: '0'.repeat(64) })),
    { status: 'invalid', message: 'Approval reference could not be verified.' },
  )
  assert.deepEqual(
    await fetchRoomAgentApprovalEvidence('room_1', publication()),
    { status: 'unavailable' },
  )
})

test('approval reads reject a byte-order mark and malformed UTF-8 after hashing raw bytes', async () => {
  const bomBytes = new Uint8Array([
    0xef, 0xbb, 0xbf,
    ...new TextEncoder().encode(projectionJson),
  ])
  const malformedBytes = new Uint8Array([0xc3, 0x28])
  const responses = [
    new Response(bomBytes, { status: 200 }),
    new Response(malformedBytes, { status: 200 }),
  ]
  globalThis.fetch = async () => responses.shift()!

  assert.deepEqual(
    await fetchRoomAgentApprovalEvidence(
      'room_1',
      publication({ projection_sha256: digest(bomBytes) }),
    ),
    { status: 'invalid', message: 'Approval reference must not contain a byte-order mark.' },
  )
  assert.deepEqual(
    await fetchRoomAgentApprovalEvidence(
      'room_1',
      publication({ projection_sha256: digest(malformedBytes) }),
    ),
    { status: 'invalid', message: 'Approval reference is not valid UTF-8.' },
  )
})

test('decision submission carries only the inventory identity and exact digests', async () => {
  let request: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    request = init
    return jsonResponse({ status: 'created' }, 201)
  }
  const item = publication()
  await submitRoomAgentApprovalDecision(item, 'allow_once', 'client_request_1')
  assert.equal(request?.method, 'POST')
  assert.deepEqual(JSON.parse(String(request?.body)), {
    expected_revision: 3,
    request_id: 'request_1',
    request_version: 2,
    request_sha256: 'a'.repeat(64),
    projection_sha256: 'b'.repeat(64),
    decision: 'allow_once',
    client_request_id: 'client_request_1',
  })
})

test('room approval controller removes a decided request through authoritative refresh', async () => {
  const item = publication({ projection_sha256: digest(projectionJson) })
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [
    jsonResponse({ publications: [item], next_cursor: null }),
    new Response(projectionJson, { status: 200 }),
    jsonResponse({ status: 'created' }, 201),
    jsonResponse({ publications: [], next_cursor: null }),
  ]
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return responses.shift()!
  }

  const scope = effectScope()
  const controller = scope.run(() => useRoomAgentApprovals(ref('room_1')))!
  try {
    await waitFor(() => controller.entries.value.length === 1)
    await controller.loadEvidence('publication_1')
    assert.equal(controller.entries.value[0].evidenceStatus, 'ready')
    await controller.decide('publication_1', 'deny')
    assert.equal(controller.entries.value.length, 0)
    assert.equal(calls[2].url, '/execution-delegations/delegation_1/decisions')
    assert.equal(JSON.parse(String(calls[2].init?.body)).projection_sha256, digest(projectionJson))
  } finally {
    scope.stop()
  }
})

test('room approval controller fences a retired room response', async () => {
  let releaseOld!: () => void
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  const oldItem = publication({ room_id: 'room_old', publication_id: 'publication_old' })
  const newItem = publication({ room_id: 'room_new', publication_id: 'publication_new' })
  globalThis.fetch = async (input) => {
    if (String(input).includes('/room_old/')) {
      await oldGate
      return jsonResponse({ publications: [oldItem], next_cursor: null })
    }
    return jsonResponse({ publications: [newItem], next_cursor: null })
  }

  const roomId = ref('room_old')
  const scope = effectScope()
  const controller = scope.run(() => useRoomAgentApprovals(roomId))!
  try {
    roomId.value = 'room_new'
    await waitFor(() => controller.entries.value[0]?.publication.publication_id === 'publication_new')
    assert.equal(controller.entries.value.length, 1)
    releaseOld()
  } finally {
    scope.stop()
  }
})

test('room switching releases pagination owned by the previous room', async () => {
  let releaseOldPage!: () => void
  const oldPageGate = new Promise<void>((resolve) => { releaseOldPage = resolve })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === '/rooms/room_old/agent-approvals') {
      return jsonResponse({
        publications: [publication({ room_id: 'room_old', publication_id: 'publication_old' })],
        next_cursor: 'old_cursor',
      })
    }
    if (url.includes('/room_old/') && url.includes('?after=')) {
      await oldPageGate
      return jsonResponse({ publications: [], next_cursor: null })
    }
    if (url === '/rooms/room_new/agent-approvals') {
      return jsonResponse({
        publications: [publication({ room_id: 'room_new', publication_id: 'publication_new' })],
        next_cursor: 'new_cursor',
      })
    }
    return jsonResponse({ publications: [], next_cursor: null })
  }

  const roomId = ref('room_old')
  const scope = effectScope()
  const controller = scope.run(() => useRoomAgentApprovals(roomId))!
  try {
    await waitFor(() => controller.hasMore.value)
    const oldPage = controller.loadMore()
    await waitFor(() => controller.loadingMore.value)
    roomId.value = 'room_new'
    await waitFor(() => controller.entries.value[0]?.publication.room_id === 'room_new')
    releaseOldPage()
    await oldPage
    assert.equal(controller.loadingMore.value, false)
    await controller.loadMore()
    assert.ok(requests.includes('/rooms/room_new/agent-approvals?after=new_cursor'))
  } finally {
    scope.stop()
  }
})

test('expiry scheduling uses the server clock and never collapses into a skew loop', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const delays: number[] = []
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    delays.push(timeout ?? 0)
    return originalSetTimeout(handler, 2_147_483_647, ...args)
  }) as typeof setTimeout
  globalThis.fetch = async () => jsonResponse({
    publications: [publication({
      published_at: '2016-09-03T09:59:00.000Z',
      expires_at: '2016-09-03T10:01:00.000Z',
    })],
    next_cursor: null,
  }, 200, { Date: 'Sat, 03 Sep 2016 10:00:00 GMT' })

  const scope = effectScope()
  const controller = scope.run(() => useRoomAgentApprovals(ref('room_skew')))!
  try {
    await waitFor(() => controller.entries.value.length === 1)
    assert.ok(delays.some((delay) => delay >= 60_000), 'expiry delay follows server time')
  } finally {
    scope.stop()
    globalThis.setTimeout = originalSetTimeout
  }
})

test('scope disposal fences an unresolved refresh before it can restore state or timers', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const scheduledDelays: number[] = []
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
  let requests = 0
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    scheduledDelays.push(timeout ?? 0)
    return originalSetTimeout(handler, 2_147_483_647, ...args)
  }) as typeof setTimeout
  globalThis.fetch = async () => {
    requests += 1
    await responseGate
    return jsonResponse({ publications: [publication()], next_cursor: null })
  }

  const scope = effectScope()
  const controller = scope.run(() => useRoomAgentApprovals(ref('room_disposed')))!
  try {
    await waitFor(() => requests === 1)
    scope.stop()
    releaseResponse()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(controller.entries.value.length, 0)
    assert.deepEqual(scheduledDelays, [])
    assert.equal(requests, 1)
  } finally {
    scope.stop()
    globalThis.setTimeout = originalSetTimeout
  }
})

test('a concealed approval inventory clears previously visible references', async () => {
  const item = publication()
  const responses = [
    jsonResponse({ publications: [item], next_cursor: null }),
    jsonResponse({ error: 'not found' }, 404),
  ]
  globalThis.fetch = async () => responses.shift()!

  const scope = effectScope()
  const controller = scope.run(() => useRoomAgentApprovals(ref('room_1')))!
  try {
    await waitFor(() => controller.entries.value.length === 1)
    assert.equal(await controller.refresh(), true)
    assert.equal(controller.entries.value.length, 0)
    assert.equal(controller.error.value, '')
  } finally {
    scope.stop()
  }
})

test('approval invalidations coalesce an in-flight burst into one trailing refresh', async () => {
  let calls = 0
  let releaseFirstInvalidation!: () => void
  const firstInvalidationGate = new Promise<void>((resolve) => { releaseFirstInvalidation = resolve })
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 2) await firstInvalidationGate
    return jsonResponse({ publications: [], next_cursor: null })
  }

  const scope = effectScope()
  scope.run(() => useRoomAgentApprovals(ref('room_burst')))
  try {
    await waitFor(() => calls === 1)
    publishAgentApprovalInvalidation('room_burst')
    await waitFor(() => calls === 2)
    publishAgentApprovalInvalidation('room_burst')
    publishAgentApprovalInvalidation('room_burst')
    releaseFirstInvalidation()
    await waitFor(() => calls === 3)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls, 3, 'one initial read plus one active and one trailing refresh')
  } finally {
    scope.stop()
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for approval state')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
