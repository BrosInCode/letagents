import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let ChatMessage: unknown

before(async () => {
  // ChatMessage imports useRoom, whose sound preference reads localStorage on load.
  ;(globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
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

async function renderRow(rowClasses: Record<string, boolean>) {
  const app = createSSRApp({
    render: () => h(ChatMessage as object, {
      message: {
        id: 'msg_1',
        sender: 'CreekHarbor',
        text: 'Pushed the fix.',
        source: 'agent',
        timestamp: '2026-09-30T10:00:00.000Z',
      },
      class: rowClasses,
    }),
  })
  const html = await renderToString(app)
  const row = html.match(/<div[^>]*data-msg-id="msg_1"[^>]*>/)?.[0] ?? ''
  const rowClass = row.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []
  return { html, rowClass }
}

// MessageList sets these on <ChatMessage>; they only reach the row while the
// component has a single root element.
test('arrival and search-match classes from MessageList land on the message row', async () => {
  const { html, rowClass } = await renderRow({ 'animate-arrival': true, 'search-match': true })
  // The server renderer wraps a multi-root (fragment) component in <!--[-->.
  assert.ok(html.startsWith('<div'), `ChatMessage should render a single root element: ${html.slice(0, 40)}`)
  assert.ok(rowClass.includes('message'), `row element not found or missing .message: ${rowClass.join(' ')}`)
  assert.ok(rowClass.includes('animate-arrival'))
  assert.ok(rowClass.includes('search-match'))
})

test('search-dim from MessageList lands on the message row', async () => {
  const { rowClass } = await renderRow({ 'animate-arrival': false, 'search-dim': true })
  assert.ok(rowClass.includes('search-dim'))
  assert.ok(!rowClass.includes('animate-arrival'))
})
