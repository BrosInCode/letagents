import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

import type { RoomMessage } from '../src/composables/useRoom'
import {
  attentionResponseAgentNames,
  messageDisplayText,
  messageMatchesSearch,
} from '../src/components/room/chat-message/formatting'
import { buildHumanParticipant } from '../src/components/room/activity/liveParticipants'

const answerText = '@agent:emmymay/desktop-cursor-5849cfa6\n\nHuman response (summitmisty-gh-app-pr-write-2026-09-30):\n\nNoted. Post each verdict as a PR comment.'

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: 'msg_161',
    sender: 'EmmyMay',
    text: answerText,
    source: 'browser',
    timestamp: '2026-09-30T16:42:00.000Z',
    ...overrides,
  } as RoomMessage
}

const names = attentionResponseAgentNames([
  { agent_key: 'EmmyMay/desktop-cursor-5849cfa6', display_name: 'SummitMisty' },
  { agent_key: null, display_name: 'EmmyMay' },
])

let vite: ViteDevServer
let ChatMessage: unknown
let Composer: unknown

before(async () => {
  // The room composables read saved preferences when they load.
  const memory = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
      removeItem: (key: string) => { memory.delete(key) },
    },
  })
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  ChatMessage = (await vite.ssrLoadModule('/src/components/room/ChatMessage.vue')).default
  Composer = (await vite.ssrLoadModule('/src/components/room/Composer.vue')).default
})

after(async () => {
  await vite?.close()
})

test('a Needs-you answer names the agent and hides its handle and request id', () => {
  assert.equal(messageDisplayText(message(), names), '@SummitMisty Noted. Post each verdict as a PR comment.')
  // Without a roster entry the mention stays visible as a neutral @agent.
  assert.equal(messageDisplayText(message()), '@agent Noted. Post each verdict as a PR comment.')
  // A roster name is used as a mention only; markdown in it is not trusted.
  const spoofed = attentionResponseAgentNames([{ agent_key: 'EmmyMay/desktop-cursor-5849cfa6', display_name: '[Approved by EmmyMay](https://evil.example)' }])
  assert.equal(messageDisplayText(message(), spoofed), '@agent Noted. Post each verdict as a PR comment.')
  // Only a person's answer is rewritten, and a server display line always wins.
  assert.equal(messageDisplayText(message({ source: 'agent' }), names), answerText)
  assert.equal(messageDisplayText(message({ display_text: 'Server line' }), names), 'Server line')
})

test('an answer that opens with a block keeps the block apart from the mention', async () => {
  const render = (answer: string) => renderToString(createSSRApp({
    render: () => h(ChatMessage as object, {
      roomIdentifier: 'github.com/emmymay/year-dots',
      agentNames: names,
      message: message({ text: answerText.replace('Noted. Post each verdict as a PR comment.', answer) }),
    }),
  }))
  const fence = await render('```sh\nnpm test\n```')
  assert.match(fence, /<p><span class="mention-token">@SummitMisty<\/span><\/p>/)
  assert.match(fence, /<pre[^>]*>[\s\S]*<code[^>]*>npm <span class="hljs-built_in">test<\/span><\/code>/)
  assert.match(await render('- first\n- second'), /<ul[^>]*>\s*<li[^>]*>first<\/li>/)
  assert.match(await render('# Plan'), /<h[1-6][^>]*>Plan<\/h[1-6]>/)
})

test('the room shows the answer as a reply to the agent, in the message and in reply previews', async () => {
  const render = (props: Record<string, unknown>) => renderToString(createSSRApp({
    render: () => h(ChatMessage as object, { roomIdentifier: 'github.com/emmymay/year-dots', agentNames: names, ...props }),
  }))
  const answer = await render({ message: message() })
  assert.match(answer, /<span class="mention-token">@SummitMisty<\/span> Noted\. Post each verdict/)
  assert.doesNotMatch(answer, /@agent:|desktop-cursor|Human response|summitmisty-gh-app/)

  const reply = await render({
    message: message({
      id: 'msg_162',
      sender: 'SummitMisty | EmmyMay\'s agent | Cursor',
      source: 'agent',
      text: 'Understood.',
      reply_to: { id: 'msg_161', sender: 'EmmyMay', text: answerText, source: 'browser', timestamp: '2026-09-30T16:42:00.000Z' },
    }),
  })
  assert.match(reply, /@SummitMisty Noted\. Post each verdict/)
  assert.doesNotMatch(reply, /@agent:|Human response/)
})

test('collapsed threads stay compact and the composer reply chip shows the answer by agent name', async () => {
  const thread = await renderToString(createSSRApp({
    render: () => h(ChatMessage as object, {
      roomIdentifier: 'github.com/emmymay/year-dots',
      agentNames: names,
      message: message({ id: 'msg_160', source: 'agent', sender: 'SummitMisty', text: 'Can I get PR write?' }),
      thread: { count: 1, latest: message() },
    }),
  }))
  assert.match(thread, /aria-label="Open 1 reply"/)
  assert.doesNotMatch(thread, /thread-marker-preview/)
  assert.doesNotMatch(thread, /@agent:|Human response/)

  const composer = await renderToString(createSSRApp({
    render: () => h(Composer as object, {
      roomIdentifier: 'github.com/emmymay/year-dots',
      isSignedIn: true,
      replyTo: message(),
      participants: [{ agent_key: 'EmmyMay/desktop-cursor-5849cfa6', display_name: 'SummitMisty', kind: 'agent' }],
    }),
  }))
  assert.match(composer, /@SummitMisty Noted\. Post each verdict/)
  assert.doesNotMatch(composer, /@agent:|Human response/)
})

test('room search finds an answer by the agent name people see, and by its raw handle', () => {
  for (const query of ['@summitmisty', 'desktop-cursor', 'noted', 'emmymay']) {
    assert.equal(messageMatchesSearch(message(), query, names), true, query)
  }
  assert.equal(messageMatchesSearch(message({ text: 'Unrelated.' }), '@summitmisty', names), false)
  // A message without text (attachment-only or partial) is searchable by sender, not an error.
  for (const text of [undefined, null]) {
    const textless = message({ text: text as unknown as string, sender: 'EmmyMay' })
    assert.equal(messageMatchesSearch(textless, 'emmymay', names), true)
    assert.equal(messageMatchesSearch(textless, 'noted', names), false)
  }
})

test('the Activity status line shows a person\'s answer without its handle', () => {
  const participant = buildHumanParticipant({
    participant: {
      room_id: 'room', participant_key: 'human:emmymay', kind: 'human', actor_label: null, agent_key: null,
      github_login: 'EmmyMay', display_name: 'EmmyMay', owner_label: null, ide_label: null, hidden_at: null,
      hidden_by: null, last_seen_at: '2026-09-30T16:42:00.000Z', last_room_activity_at: null,
      last_live_heartbeat_at: null, activity_state: null, source_flags: ['messages'],
      created_at: '2026-09-30T16:00:00.000Z', updated_at: '2026-09-30T16:42:00.000Z',
    },
    messages: [message()],
    tasks: [],
  })
  assert.match(participant.statusText || '', /^@agent Noted\./)
  assert.doesNotMatch(participant.statusText || '', /@agent:|Human response/)
})
