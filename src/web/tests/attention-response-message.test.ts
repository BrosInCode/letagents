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
} from '../src/components/room/chat-message/formatting'

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
})

after(async () => {
  await vite?.close()
})

test('a Needs-you answer names the agent and hides its handle and request id', () => {
  assert.equal(messageDisplayText(message(), names), '@SummitMisty Noted. Post each verdict as a PR comment.')
  assert.equal(messageDisplayText(message()), 'Noted. Post each verdict as a PR comment.')
  // Only a person's answer is rewritten, and a server display line always wins.
  assert.equal(messageDisplayText(message({ source: 'agent' }), names), answerText)
  assert.equal(messageDisplayText(message({ display_text: 'Server line' }), names), 'Server line')
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
