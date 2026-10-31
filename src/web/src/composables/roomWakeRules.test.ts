import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { effectScope, ref } from 'vue'
import type { WakeRule } from '../../../../shared/wake-rules.mjs'
import {
  cancelRoomWakeRule,
  fetchRoomWakeRules,
  groupWakeRulesByAgent,
  restoreRoomWakeRule,
  useRoomWakeRules,
  wakeRulesForAgent,
} from './roomWakeRules.js'
import {
  lastWakeRuleInvalidation,
  publishWakeRuleInvalidation,
} from './roomWakeRuleInvalidation.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  lastWakeRuleInvalidation.value = null
})

function rule(overrides: Partial<WakeRule> = {}): WakeRule {
  return {
    id: 'wake_1',
    room_id: 'room_1',
    agent_key: 'EmmyMay/fable',
    agent_name: 'Fable',
    event: 'github.check_completed',
    arguments: { branch: 'feature/billing' },
    repeat: false,
    expires_at: '2036-09-30T12:00:00.000Z',
    note: null,
    status: 'active',
    created_at: '2026-09-30T10:00:00.000Z',
    updated_at: '2026-09-30T10:00:00.000Z',
    fire_count: 0,
    last_fired_at: null,
    wake_message_id: null,
    cancelled_by: null,
    ended_reason: null,
    ...overrides,
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function page(roomId: string, active: WakeRule[], recent: WakeRule[] = []) {
  return { room_id: roomId, active, recent }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for wake-rule state')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test('wake rules group by agent key in the order the server sent them', () => {
  const first = rule({ id: 'wake_a', agent_key: 'EmmyMay/fable' })
  const other = rule({ id: 'wake_b', agent_key: 'EmmyMay/ridge' })
  const second = rule({ id: 'wake_c', agent_key: 'EmmyMay/fable' })
  const grouped = groupWakeRulesByAgent([first, other, second])

  assert.deepEqual([...grouped.keys()], ['EmmyMay/fable', 'EmmyMay/ridge'])
  assert.deepEqual(grouped.get('EmmyMay/fable')?.map((item) => item.id), ['wake_a', 'wake_c'])
  assert.deepEqual(wakeRulesForAgent(grouped, 'EmmyMay/ridge').map((item) => item.id), ['wake_b'])
  assert.deepEqual(wakeRulesForAgent(grouped, 'EmmyMay/unknown'), [])
  assert.deepEqual(wakeRulesForAgent(grouped, null), [])
  assert.deepEqual(wakeRulesForAgent(null, 'EmmyMay/fable'), [])
})

test('wake-rule reads use the encoded room path and drop rules the app cannot read', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return jsonResponse(page('room_canonical', [rule(), { id: 'wake_2' } as unknown as WakeRule], [rule({ id: 'wake_3', status: 'fired' })]))
  }

  const result = await fetchRoomWakeRules('github.com/example/project')

  assert.equal(requests[0].url, '/rooms/github.com%2Fexample%2Fproject/wake-rules')
  assert.equal(requests[0].init?.credentials, 'same-origin')
  assert.equal(requests[0].init?.method, undefined)
  assert.deepEqual(result.active.map((item) => item.id), ['wake_1'])
  assert.deepEqual(result.recent.map((item) => item.id), ['wake_3'])

  globalThis.fetch = async () => jsonResponse({ rules: [] })
  await assert.rejects(fetchRoomWakeRules('room_1'), /Wake rules could not be loaded/)
})

test('cancel and restore post to the rule and surface the server sentence', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const responses = [
    jsonResponse({ rule: rule({ status: 'cancelled' }) }),
    jsonResponse({ rule: rule() }),
    jsonResponse({ error: 'This wake rule can no longer be restored.' }, 409),
    new Response('<html>Cannot POST</html>', { status: 502 }),
  ]
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return responses.shift()!
  }

  assert.equal((await cancelRoomWakeRule('room_1', 'wake_1')).status, 'cancelled')
  assert.equal((await restoreRoomWakeRule('room_1', 'wake_1')).status, 'active')
  assert.deepEqual(requests.map((request) => request.url), [
    '/rooms/room_1/wake-rules/wake_1/cancel',
    '/rooms/room_1/wake-rules/wake_1/restore',
  ])
  assert.equal(requests[0].init?.method, 'POST')
  assert.equal(requests[0].init?.body, '{}')
  await assert.rejects(restoreRoomWakeRule('room_1', 'wake_1'), /can no longer be restored/)
  await assert.rejects(cancelRoomWakeRule('room_1', 'wake_1'), /^Error: Couldn't cancel this wake rule\. Try again\.$/)

  const before = requests.length
  await assert.rejects(cancelRoomWakeRule('room_1', '../tasks'), /Couldn't cancel/)
  assert.equal(requests.length, before, 'a malformed rule id never reaches the network')
})

test('room wake rules load, group, and refresh on invalidations for their room only', async () => {
  let calls = 0
  const pages = [
    page('room_1', [rule({ id: 'wake_1' })], [rule({ id: 'wake_9', status: 'fired', wake_message_id: 'msg_4' })]),
    page('room_1', [rule({ id: 'wake_1' }), rule({ id: 'wake_2', agent_key: 'EmmyMay/ridge' })]),
  ]
  globalThis.fetch = async () => {
    calls += 1
    return jsonResponse(pages[Math.min(calls, pages.length) - 1])
  }

  const scope = effectScope()
  const controller = scope.run(() => useRoomWakeRules(ref('room_1')))!
  try {
    await waitFor(() => controller.page.value !== null)
    assert.deepEqual(controller.activeByAgentKey.value.get('EmmyMay/fable')?.map((item) => item.id), ['wake_1'])
    assert.deepEqual(controller.recentByAgentKey.value.get('EmmyMay/fable')?.map((item) => item.id), ['wake_9'])

    publishWakeRuleInvalidation('room_other')
    await settle()
    assert.equal(calls, 1, 'another room\'s pointer is not this room\'s change')

    publishWakeRuleInvalidation('room_1')
    await waitFor(() => controller.activeByAgentKey.value.has('EmmyMay/ridge'))
    assert.equal(calls, 2)
    assert.equal(controller.recentByAgentKey.value.size, 0)
  } finally {
    scope.stop()
  }
})

test('a failed refresh keeps the last known rules; lost access clears them', async () => {
  const responses = [
    () => jsonResponse(page('room_1', [rule()])),
    () => { throw new TypeError('network down') },
    () => jsonResponse({ error: 'Unable to save or load wake rules. Please retry.' }, 500),
    () => jsonResponse({ error: 'Not a participant' }, 403),
  ]
  let calls = 0
  globalThis.fetch = async () => responses[calls++]!()

  const scope = effectScope()
  const controller = scope.run(() => useRoomWakeRules(ref('room_1')))!
  try {
    await waitFor(() => calls === 1 && controller.page.value !== null)
    for (const expectedCalls of [2, 3]) {
      assert.equal(await controller.refresh(), false)
      assert.equal(calls, expectedCalls)
      assert.deepEqual(
        controller.activeByAgentKey.value.get('EmmyMay/fable')?.map((item) => item.id),
        ['wake_1'],
        'an agent must not look like it stopped waiting because a read failed',
      )
    }
    assert.equal(await controller.refresh(), true)
    assert.equal(controller.page.value, null)
    assert.equal(controller.activeByAgentKey.value.size, 0)
  } finally {
    scope.stop()
  }
})

test('switching rooms clears the old rules at once and fences the old response', async () => {
  let releaseOld!: () => void
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  let newCalls = 0
  globalThis.fetch = async (input) => {
    if (String(input).includes('/room_old/')) {
      await oldGate
      return jsonResponse(page('room_old', [rule({ id: 'wake_old', room_id: 'room_old' })]))
    }
    newCalls += 1
    return newCalls === 1
      ? jsonResponse(page('room_new', [rule({ id: 'wake_new', room_id: 'room_new' })]))
      : jsonResponse(page('room_new', []))
  }

  const roomId = ref('room_old')
  const scope = effectScope()
  const controller = scope.run(() => useRoomWakeRules(roomId))!
  try {
    roomId.value = 'room_new'
    await waitFor(() => controller.page.value?.room_id === 'room_new')
    releaseOld()
    await settle()
    assert.deepEqual(controller.page.value?.active.map((item) => item.id), ['wake_new'])

    roomId.value = 'room_old_again'
    await Promise.resolve()
    assert.equal(controller.page.value, null, 'the previous room\'s rules never show under the next room')
  } finally {
    scope.stop()
  }
})

test('cancel and restore through the panel API re-read the room; bursts coalesce', async () => {
  let reads = 0
  let releaseSecondRead!: () => void
  const secondReadGate = new Promise<void>((resolve) => { releaseSecondRead = resolve })
  const posts: string[] = []
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(String(input))
      return jsonResponse({ rule: rule({ status: String(input).endsWith('/cancel') ? 'cancelled' : 'active' }) })
    }
    reads += 1
    if (reads === 2) await secondReadGate
    return jsonResponse(page('room_1', reads === 1 ? [rule()] : []))
  }

  const scope = effectScope()
  const controller = scope.run(() => useRoomWakeRules(ref('room_1')))!
  try {
    await waitFor(() => reads === 1 && controller.page.value !== null)
    const cancelled = await controller.api.cancel('room_1', 'wake_1')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(lastWakeRuleInvalidation.value?.roomId, 'room_1')
    await waitFor(() => reads === 2)

    // Undo and a stream pointer land while the read is in flight: one trailing read.
    await controller.api.restore('room_1', 'wake_1')
    publishWakeRuleInvalidation('room_1')
    releaseSecondRead()
    await waitFor(() => reads === 3)
    await settle()
    assert.equal(reads, 3, 'one initial read plus one active and one trailing refresh')
    assert.deepEqual(posts, ['/rooms/room_1/wake-rules/wake_1/cancel', '/rooms/room_1/wake-rules/wake_1/restore'])
  } finally {
    scope.stop()
  }
})
