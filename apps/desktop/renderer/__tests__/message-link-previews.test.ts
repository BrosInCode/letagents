import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, effectScope, h, nextTick, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer } from 'vite'
import { renderDesktopMarkdown } from '../src/components/desktop/content/formatting/markdown'
import { eligibleLinkPreviewReferences, linkPreviewPresentation } from '../../../../shared/message-link-previews.mjs'
const render = (text: string, onLink?: (url: string) => void) => renderDesktopMarkdown(text, { block: true, onLink })

const url = 'https://github.com/org/repo/pull/1'
const preview = { kind: 'pull' as const, number: 1, repository: 'org/repo', title: '<script>Title</script>', state: 'draft' as const, url }
test('existing markdown rendering collects links in message order and excludes code without changing HTML', () => {
  const text = [url, '[second](https://github.com/org/repo/issues/2)', '`https://github.com/org/repo/pull/3`', '```ts', 'https://github.com/org/repo/pull/4', '```', '> https://github.com/org/repo/issues/5'].join('\n')
  const urls: string[] = []
  const html = render(text, value => urls.push(value))
  assert.equal(html, render(text))
  assert.deepEqual(urls, [url, 'https://github.com/org/repo/issues/2', 'https://github.com/org/repo/issues/5'])
  assert.deepEqual(eligibleLinkPreviewReferences(urls, 'ORG/REPO'), [{ kind: 'pull', number: 1 }, { kind: 'issue', number: 2 }, { kind: 'issue', number: 5 }])
})

test('link collection preserves staging code-span rendering for a fencing regex', () => {
  const text = "Fencing regex: `/^```([A-Za-z0-9_+-]*)\\s*$/.`. Tag is sanitized and matched against `LANGUAGE_ALIASES` -> ..."
  const links: string[] = []
  assert.equal(render(text, link => links.push(link)), "<p>Fencing regex: <code>/^</code>`<code>([A-Za-z0-9_+-]*)\\s*$/.</code>. Tag is sanitized and matched against <code>LANGUAGE_ALIASES</code> -&gt; ...</p>")
  assert.deepEqual(links, [])
})

let Card: any, provider: any
before(async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  try {
    Card = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/desktop-chat-message/DesktopGitHubEventCard.vue')).default
    provider = await vite.ssrLoadModule('/renderer/src/composables/useRoomMessageLinkPreviews.ts')
  } finally { await vite.close() }
})
test('compact cards reuse event presentation, escape titles, and keep the GitHub link', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(Card, { event: linkPreviewPresentation(preview), compact: true }) }))
  assert.match(html, /is-preview/)
  assert.match(html, /#1 &lt;script&gt;Title&lt;\/script&gt;/)
  assert.match(html, /draft/)
  assert.match(html, /org\/repo/)
  assert.match(html, /href="https:\/\/github.com\/org\/repo\/pull\/1"/)
  assert.doesNotMatch(html, /<script>|View in Events/)
})

test('provider requests only eligible rendered references, refreshes matching streams, and clears on room changes', async (t) => {
  const requests: any[] = []
  let responsePreview = preview
  const room = ref('room'), repository = ref<string | null>('https://github.com/ORG/REPO'), scope = effectScope()
  const settle = () => new Promise(resolve => setTimeout(resolve, 70))
  const previousWindow = globalThis.window
  Object.assign(globalThis, { window: { letagentsDesktop: { room: { getMessageLinkPreviews: async (roomId: string, references: any) => {
    requests.push({ roomId, references }); return { room_id: roomId, previews: [responsePreview] }
  } } } } })
  try {
    let context: any
    scope.run(() => { context = provider.useRoomMessageLinkPreviews(room, repository) })
    context.track({ id: 'msg_1', urls: [url, url + '#comment', 'https://github.com/private/other/pull/1'] })
    context.track({ id: 'msg_2', urls: [] })
    await settle()
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].references, [{ kind: 'pull', number: 1 }])
    assert.equal(context.previewsFor('msg_1')[0].state, 'draft')
    provider.invalidateRoomMessageLinkPreviews('other'); await nextTick(); await settle(); assert.equal(requests.length, 1)
    provider.invalidateRoomMessageLinkPreviews('room'); await nextTick(); await settle(); assert.equal(requests.length, 2)
    responsePreview = { ...preview, repository: 'other/repo' }
    provider.invalidateRoomMessageLinkPreviews('room'); await nextTick(); await settle()
    assert.deepEqual(context.previewsFor('msg_1'), [])
    room.value = 'new'; assert.deepEqual(context.previewsFor('msg_1'), [])
  } finally { scope.stop(); Object.assign(globalThis, { window: previousWindow }); }
})
