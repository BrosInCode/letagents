import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { computed, createSSRApp, h, shallowRef } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import type { MessageReaction } from '../../../shared/message-reactions.mjs'
import type { RoomMessageReactionContext } from '../src/composables/roomMessageReactions'

let vite: ViteDevServer
let ChatMessage: object
let provideRoomMessageReactions: (context: RoomMessageReactionContext) => void

before(async () => {
  // ChatMessage imports useRoom, whose sound preference reads localStorage on load.
  ;(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} }
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  // Both come through the same loader, so they share one injection key.
  ChatMessage = (await vite.ssrLoadModule('/src/components/room/ChatMessage.vue')).default
  ;({ provideRoomMessageReactions } = await vite.ssrLoadModule('/src/composables/roomMessageReactions.ts'))
})

after(async () => {
  await vite?.close()
})

const ada = { login: 'ada', name: 'Ada', avatar_url: null }
const emmy = { login: 'emmy', name: 'Emmy', avatar_url: null }

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_12',
    sender: 'Ada',
    text: 'Shall we ship it?',
    source: 'browser',
    timestamp: '2026-10-02T12:00:00.000Z',
    reactions: [],
    ...overrides,
  }
}

async function render(options: {
  message: Record<string, unknown>
  reactions?: MessageReaction[]
  canReact?: boolean
  provide?: boolean
}) {
  const tracked: string[] = []
  const context: RoomMessageReactionContext = {
    revision: shallowRef(0),
    canReact: computed(() => options.canReact ?? true),
    viewerLogin: computed(() => 'emmy'),
    reactionsFor: () => options.reactions ?? [],
    viewerReacted: (_messageId, emoji) =>
      Boolean(options.reactions?.find((reaction) => reaction.emoji === emoji)?.reactors.some((reactor) => reactor.login === 'emmy')),
    toggle() {},
    track(tracking) {
      tracked.push(tracking.id)
      return () => {}
    },
  }
  const app = createSSRApp({
    setup() {
      if (options.provide !== false) provideRoomMessageReactions(context)
      return () => h(ChatMessage, { message: options.message, roomIdentifier: 'room_1' })
    },
  })
  return { html: await renderToString(app), tracked }
}

test('a message shows its reactions, marks the viewer\'s own, and offers to add one', async () => {
  const { html, tracked } = await render({
    message: message(),
    reactions: [
      { emoji: '👍', count: 2, reactors: [ada, emmy] },
      { emoji: '🚀', count: 1, reactors: [ada] },
    ],
  })
  assert.deepEqual(tracked, ['msg_12'])
  assert.match(html, /role="group" aria-label="Reactions"/)
  assert.match(html, /<button[^>]*class="message-reaction"[^>]*aria-pressed="true"[^>]*aria-label="You and Ada reacted with 👍"/)
  assert.match(html, /<button[^>]*class="message-reaction"[^>]*aria-pressed="false"[^>]*aria-label="Ada reacted with 🚀"/)
  assert.match(html, /class="message-reaction message-reaction-add"[^>]*aria-expanded="false"/)
  assert.match(html, /class="reply-action react-action"[^>]*aria-expanded="false"/)
  assert.match(html, /react-action/, 'the hover actions offer the picker too')
})

test('a signed-out visitor sees the reactions without any control', async () => {
  const { html } = await render({
    message: message(),
    reactions: [{ emoji: '👍', count: 1, reactors: [ada] }],
    canReact: false,
  })
  assert.match(html, /<span[^>]*class="message-reaction"[^>]*role="img"[^>]*aria-label="Ada reacted with 👍"/)
  assert.doesNotMatch(html, /<button[^>]*class="message-reaction/)
  assert.doesNotMatch(html, /react-action|message-reaction-add/)
})

test('a message from a server without reactions, and a wake notice, cannot be reacted to', async () => {
  const withoutField = message()
  delete (withoutField as Record<string, unknown>).reactions
  for (const candidate of [withoutField, message({ source: 'wake_rule' })]) {
    const { html } = await render({ message: candidate })
    assert.doesNotMatch(html, /react-action|message-reaction-add/)
  }
})

test('outside a room that provides reactions the message renders as before', async () => {
  const { html, tracked } = await render({ message: message(), provide: false })
  assert.deepEqual(tracked, [])
  assert.doesNotMatch(html, /message-reaction|react-action/)
  assert.match(html, /aria-label="Reply to message"/)
})


test('the web reaction opener exposes open and closed picker state', async () => {
  const Meta = (await vite.ssrLoadModule('/src/components/room/chat-message/MessageMeta.vue')).default
  for (const pickerOpen of [false, true]) {
    const html = await renderToString(createSSRApp({ render: () => h(Meta, {
      displayName: 'Ada', inlinePromptInjection: false, formattedTime: '12:00', canReact: true, pickerOpen,
    }) }))
    assert.match(html, new RegExp(`class="reply-action react-action"[^>]*aria-expanded="${pickerOpen}"`))
  }
})

test('the web message passes live anchors and picker state to both openers and restores focus', () => {
  const source = readFileSync(new URL('../src/components/room/ChatMessage.vue', import.meta.url), 'utf8')
  assert.equal(source.match(/:picker-open="reactionPickerAnchor !== null"/g)?.length, 2)
  assert.match(source, /showReactionPicker\(\{ element: trigger \}/)
  assert.match(source, /element: messageElement\.value, point: \{ x, y \}/)
  assert.match(source, /if \(restoreFocus && invoker\?\.isConnected\) invoker\.focus\(\{ preventScroll: true \}\)/)
})
