import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  PROVIDER_USAGE_LIMIT_SOURCE,
  providerUsageLimitNoticeText,
} from '../../../shared/provider-usage-limit.mjs'
import {
  formatUsageLimitResetTime,
  usageLimitNoticePresentation,
} from '../src/components/room/chat-message/usageLimitNotice'

const NOW = Date.parse('2026-10-09T10:00:00Z')
const US = { locale: 'en-US', timeZone: 'UTC' }
const plain = (value: string | undefined) => value?.replace(/[  ]/g, ' ')

function notice(input: { phase: 'start' | 'turn'; resetsAt: string | null; provider?: string; agentName?: string }) {
  return {
    sender: 'letagents',
    source: PROVIDER_USAGE_LIMIT_SOURCE,
    text: providerUsageLimitNoticeText({ agentName: input.agentName ?? 'CalmLake', provider: input.provider ?? 'claude', resetsAt: input.resetsAt, phase: input.phase }),
  }
}

test('a stopped agent leads with what happened, then when it continues, in the viewer\'s time', () => {
  const view = usageLimitNoticePresentation(notice({ phase: 'turn', resetsAt: '2026-10-09T15:00:00.000Z' }), NOW, US)
  assert.equal(view?.title, "CalmLake stopped: Claude's usage limit was reached")
  assert.equal(plain(view?.detail), 'Continues after the limit resets at 3:00 PM')
})

test('an agent that could not start says when it starts; another day names the day', () => {
  const message = notice({ phase: 'start', provider: 'codex', agentName: 'SunlitLantern', resetsAt: '2026-10-10T15:00:00.000Z' })
  const view = usageLimitNoticePresentation(message, NOW, US)
  assert.equal(view?.title, "SunlitLantern couldn't start: Codex's usage limit was reached")
  assert.equal(plain(view?.detail), 'Starts after the limit resets at Sat, Oct 10, 3:00 PM')
  assert.equal(plain(usageLimitNoticePresentation(message, NOW, { locale: 'en-GB', timeZone: 'UTC' })?.detail),
    'Starts after the limit resets at Sat 10 Oct, 15:00')
})

test('the reset time and its day follow the viewer\'s time zone', () => {
  // 23:30 UTC on the 9th is 08:30 on the 10th in Tokyo.
  assert.equal(plain(formatUsageLimitResetTime(Date.parse('2026-10-09T23:30:00Z'), NOW, { locale: 'en-US', timeZone: 'Asia/Tokyo' })), 'Sat, Oct 10, 8:30 AM')
  assert.equal(plain(formatUsageLimitResetTime(Date.parse('2026-10-09T23:30:00Z'), NOW, US)), '11:30 PM')
})

test('a reset already past says the limit reset', () => {
  const view = usageLimitNoticePresentation(notice({ phase: 'turn', resetsAt: '2026-10-09T09:00:00.000Z' }), NOW, US)
  assert.equal(plain(view?.detail), 'The limit reset at 9:00 AM')
})

test('without a reset time the notice says what ends the wait', () => {
  assert.equal(usageLimitNoticePresentation(notice({ phase: 'turn', resetsAt: null, provider: 'open-model' }), NOW, US)?.detail,
    'Continues when the limit allows, or after the owner changes the account')
  const start = usageLimitNoticePresentation(notice({ phase: 'start', resetsAt: null, provider: 'open-model' }), NOW, US)
  assert.equal(start?.title, "CalmLake couldn't start: The model provider's usage limit was reached")
  assert.equal(start?.detail, 'Starts when the limit allows, or after the owner changes the account')
})

test('only a LetAgents notice with the usage-limit source and its exact text is a notice', () => {
  const message = notice({ phase: 'turn', resetsAt: '2026-10-09T15:00:00.000Z' })
  assert.ok(usageLimitNoticePresentation({ ...message, sender: 'System' }, NOW, US))
  assert.equal(usageLimitNoticePresentation({ ...message, source: 'browser' }, NOW, US), null, 'a person typing the same words')
  assert.equal(usageLimitNoticePresentation({ ...message, sender: 'alice' }, NOW, US), null)
  assert.equal(usageLimitNoticePresentation({ ...message, text: 'CalmLake stopped for a while.' }, NOW, US), null,
    'unparsed text falls back to a normal system message')
})

test('the room row shows the notice as a quiet line without Reply or reactions', () => {
  const component = readFileSync(new URL('../src/components/room/ChatMessage.vue', import.meta.url), 'utf8')
  assert.match(component, /usageLimitNoticePresentation\(props\.message\)/)
  assert.match(component, /<button v-if="!isQuietNotice" type="button" role="menuitem" @click="replyFromMenu">/)
  assert.match(component, /&& !isQuietNotice\.value/)
})
