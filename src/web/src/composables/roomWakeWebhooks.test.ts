import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { WakeRule } from '../../../../shared/wake-rules.mjs'
import { fetchRoomWakeRules } from './roomWakeRules.js'
import { lastWakeRuleInvalidation } from './roomWakeRuleInvalidation.js'
import {
  addRoomWakeWebhookRule,
  fetchOwnedWakeAgents,
  roomWakeWebhookApi,
  testRoomWakeRule,
} from './roomWakeWebhooks.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  lastWakeRuleInvalidation.value = null
})

function rule(overrides: Partial<WakeRule> = {}): WakeRule {
  return {
    id: 'wake_1',
    room_id: 'sky-owl',
    agent_key: 'ada/grokbot',
    agent_name: 'GrokBot',
    event: 'room.message',
    arguments: { mentions_me: true },
    repeat: true,
    expires_at: '2026-12-04T10:00:00.000Z',
    note: null,
    status: 'active',
    created_at: '2026-11-04T10:00:00.000Z',
    updated_at: '2026-11-04T10:00:00.000Z',
    fire_count: 0,
    last_fired_at: null,
    wake_message_id: null,
    cancelled_by: null,
    ended_reason: null,
    delivery: { kind: 'webhook', paused: false, has_bearer: true, delivered_count: 0, consecutive_failures: 0 },
    ...overrides,
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Read through a function: an assignment of null to the ref must not narrow later reads to never. */
function invalidatedRoom(): string | null {
  return lastWakeRuleInvalidation.value?.roomId ?? null
}

function capture(responses: Response[]) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return responses.shift()!
  }
  return requests
}

test('the agent picker reads the encoded my-agents path and keeps only well-formed agents', async () => {
  const requests = capture([jsonResponse({
    room_id: 'github.com/example/project',
    agents: [
      { agent_key: 'ada/grokbot', agent_name: 'GrokBot', live: true, last_seen_at: '2026-11-04T10:00:00.000Z' },
      { agent_key: '', agent_name: 'broken', live: true, last_seen_at: '2026-11-04T10:00:00.000Z' },
      { agent_name: 'no key' },
    ],
  })])
  const agents = await fetchOwnedWakeAgents('github.com/example/project')
  assert.equal(requests[0].url, '/rooms/github.com%2Fexample%2Fproject/wake-rules/my-agents')
  assert.equal(requests[0].init?.credentials, 'same-origin')
  assert.deepEqual(agents.map((agent) => agent.agent_key), ['ada/grokbot'])

  capture([jsonResponse({ error: 'Only a signed-in person can do this for an agent they own.' }, 403)])
  await assert.rejects(fetchOwnedWakeAgents('sky-owl'), /signed-in person/)
})

test('adding posts the agent key and the rule shape the server reads, and never keeps the secret or key', async () => {
  const requests = capture([jsonResponse({ rule: rule({ id: 'wake_new' }), created: true }, 201)])
  const result = await addRoomWakeWebhookRule('sky-owl', 'ada/grokbot', {
    url: 'https://hooks.example/grok/abc', secret: 's'.repeat(32), bearer: 'crsr_key_0001', note: 'wake my routine',
  })
  assert.equal(requests[0].url, '/rooms/sky-owl/wake-rules')
  assert.equal(requests[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    agent_key: 'ada/grokbot',
    rule: { event: 'room.message', note: 'wake my routine', webhook: { url: 'https://hooks.example/grok/abc', secret: 's'.repeat(32), bearer: 'crsr_key_0001' } },
  })
  assert.deepEqual(result, { rule: rule({ id: 'wake_new' }), created: true })

  const bare = capture([jsonResponse({ rule: rule(), created: false })])
  await addRoomWakeWebhookRule('sky-owl', 'ada/grokbot', { url: 'https://hooks.example/grok/abc', secret: 's'.repeat(32), note: null })
  assert.deepEqual(JSON.parse(String(bare[0].init?.body)).rule, { event: 'room.message', webhook: { url: 'https://hooks.example/grok/abc', secret: 's'.repeat(32) } }, 'no key, no note: neither is sent')

  capture([jsonResponse({ error: 'The URL is not allowed. Use a public https URL on port 443.' }, 400)])
  await assert.rejects(addRoomWakeWebhookRule('sky-owl', 'ada/grokbot', { url: 'https://10.0.0.8/x', secret: 's'.repeat(32) }), /not allowed/)
  capture([jsonResponse({ rule: { id: 'wake_x' } })])
  await assert.rejects(addRoomWakeWebhookRule('sky-owl', 'ada/grokbot', { url: 'https://hooks.example/x', secret: 's'.repeat(32) }), /could not be saved/)
})

test('a test posts to the rule and parses the receiver answer; the id is checked first', async () => {
  const requests = capture([
    jsonResponse({ status: 200, error_class: null, delivery_id: 'whd_1' }),
    jsonResponse({ status: 401, error_class: 'http_4xx', delivery_id: 'whd_2' }),
    jsonResponse({ status: 200, error_class: null, delivery_id: 'whd_3', resumed: true }),
    jsonResponse({ error: 'You sent 5 tests in the last 10 minutes. Wait a few minutes, then try again.' }, 429),
  ])
  assert.deepEqual(await testRoomWakeRule('sky-owl', 'wake_1'), { status: 200, error_class: null, delivery_id: 'whd_1', resumed: false })
  assert.equal(requests[0].url, '/rooms/sky-owl/wake-rules/wake_1/test')
  assert.equal(requests[0].init?.method, 'POST')
  assert.deepEqual(await testRoomWakeRule('sky-owl', 'wake_1'), { status: 401, error_class: 'http_4xx', delivery_id: 'whd_2', resumed: false })
  assert.equal((await testRoomWakeRule('sky-owl', 'wake_1')).resumed, true, 'an accepted test that resumed the rule says so')
  await assert.rejects(testRoomWakeRule('sky-owl', 'wake_1'), /5 tests/)
  await assert.rejects(testRoomWakeRule('sky-owl', '../evil'), /could not be sent/)
  assert.equal(requests.length, 4, 'a bad id never reaches the server')
})

test('the web transport tells the room to re-read its rules after each change', async () => {
  capture([
    jsonResponse({ rule: rule({ id: 'wake_new' }), created: true }, 201),
    jsonResponse({ status: 200, error_class: null, delivery_id: 'whd_1' }),
    jsonResponse({ rule: rule({ status: 'cancelled' }) }),
    jsonResponse({ agents: [] }),
  ])
  await roomWakeWebhookApi.add('sky-owl', 'ada/grokbot', { url: 'https://hooks.example/x', secret: 's'.repeat(32) })
  assert.equal(invalidatedRoom(), 'sky-owl')
  lastWakeRuleInvalidation.value = null
  await roomWakeWebhookApi.test('sky-owl', 'wake_new')
  assert.equal(invalidatedRoom(), 'sky-owl')
  lastWakeRuleInvalidation.value = null
  assert.equal((await roomWakeWebhookApi.cancel('sky-owl', 'wake_1')).status, 'cancelled')
  assert.equal(invalidatedRoom(), 'sky-owl')
  lastWakeRuleInvalidation.value = null
  assert.deepEqual(await roomWakeWebhookApi.listAgents('sky-owl'), [])
  assert.equal(invalidatedRoom(), null, 'a read changes nothing')
})

test('the rules the drawer reads keep the owner-only test mark, and the cancelled ones arrive in the recent list', async () => {
  const delivery = { kind: 'webhook' as const, paused: false, has_bearer: true, delivered_count: 3, consecutive_failures: 0, last_status: 200, last_error: null, last_attempt_at: '2026-11-04T11:00:00.000Z' }
  capture([jsonResponse({
    room_id: 'sky-owl',
    active: [
      rule({ id: 'wake_1', delivery: { ...delivery, last_attempt_was_test: true } }),
      rule({ id: 'wake_2', delivery: { ...delivery, last_attempt_was_test: false } }),
      rule({ id: 'wake_4', delivery: { ...delivery } }),
    ],
    recent: [rule({ id: 'wake_3', status: 'cancelled', cancelled_by: { kind: 'human', id: 'acct_1', label: 'ada' } })],
  })])
  const page = await fetchRoomWakeRules('sky-owl')
  // The shared row words the mark as "last test 200" (see the desktop suite, which runs the shared code).
  assert.deepEqual(page.active.map((item) => item.delivery?.last_attempt_was_test), [true, false, undefined], 'the mark passes through the read; an older server sends none')
  assert.deepEqual(page.recent.map((item) => [item.id, item.status]), [['wake_3', 'cancelled']])
})
