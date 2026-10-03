import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, effectScope, h, nextTick, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer } from 'vite'
import { renderMessageContent } from '../src/components/room/chat-message/formatting'
import { eligibleLinkPreviewReferences, excludeGitHubEventLink, linkPreviewPresentation } from '../../../shared/message-link-previews.mjs'
const render = (text: string, onLink?: (url: string) => void) => renderMessageContent(text, undefined, onLink)

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

const previousStorage = globalThis.localStorage
after(() => { Object.assign(globalThis, { localStorage: previousStorage }) })
let Card: any, Message: any, provider: any
before(async () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
  const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  try {
    Card = (await vite.ssrLoadModule('/src/components/room/GitHubEventCard.vue')).default
    provider = await vite.ssrLoadModule('/src/composables/roomMessageLinkPreviews.ts')
    Message = (await vite.ssrLoadModule('/src/components/room/ChatMessage.vue')).default
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
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
  t.mock.method(globalThis, 'fetch', async (url: any, init?: RequestInit) => {
    requests.push({ url, ...JSON.parse(String(init?.body || '{}')) })
    return new Response(JSON.stringify({ room_id: 'room', previews: [responsePreview] }))
  })
  try {
    let context: any
    scope.run(() => { context = provider.useRoomMessageLinkPreviews(room, repository) })
    context.track({ id: 'msg_1', urls: [url, url + '#comment', 'https://github.com/private/other/pull/1'] })
    context.track({ id: 'msg_2', urls: [] })
    await settle()
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].references, [{ kind: 'pull', number: 1 }])
    assert.equal(context.previewsFor('msg_1')[0].state, 'draft')
    provider.publishMessageLinkPreviewInvalidation('other'); await nextTick(); await settle(); assert.equal(requests.length, 1)
    provider.publishMessageLinkPreviewInvalidation('room'); await nextTick(); await settle(); assert.equal(requests.length, 2)
    responsePreview = { ...preview, repository: 'other/repo' }
    provider.publishMessageLinkPreviewInvalidation('room'); await nextTick(); await settle()
    assert.deepEqual(context.previewsFor('msg_1'), [])
    room.value = 'new'; assert.deepEqual(context.previewsFor('msg_1'), [])
  } finally { scope.stop(); }
})

test('event links are excluded canonically without hiding other PRs, issues, or human links', () => {
  const variant = 'https://github.com/ORG/REPO/pull/1/?source=chat#discussion'
  const issue = 'https://github.com/org/repo/issues/1'
  const otherRepo = 'https://github.com/other/repo/pull/1'
  assert.deepEqual(excludeGitHubEventLink([url, variant, issue, otherRepo], url), [issue, otherRepo])
  assert.deepEqual(excludeGitHubEventLink([url, variant], null), [url, variant])
  assert.deepEqual(excludeGitHubEventLink([url], 'https://github.com/org/repo/actions/runs/1'), [url])
})

test('room messages show one event card while retaining other link previews and human previews', async () => {
  const second = { ...preview, number: 2, url: 'https://github.com/org/repo/pull/2', title: 'Another change' }
  for (const source of ['github', 'browser']) {
    let tracked: string[] = []
    const app = createSSRApp({
      setup() {
        provider.provideRoomMessageLinkPreviews({
          contextKey: ref('room'),
          previewsFor: () => [preview, second].filter(item => tracked.includes(item.url)),
          track: (message: { urls: string[] }) => { tracked = message.urls; return () => {} },
        })
        return () => h(Message, {
          message: {
            id: 'msg_12', sender: source === 'github' ? 'github' : 'EmmyMay', source,
            text: `PR #1 opened by EmmyMay in org/repo: Related ${second.url} ${url}`,
            attachments: [], timestamp: '2026-10-03T16:43:00Z',
          },
          threadSummary: { count: 0, unreadCount: 0, participants: [], latest: null, hasPartialHistory: false, loadingEarlier: false },
          activeThreadRoot: false, highlightQuery: '', searchActive: false,
        })
      },
    })
    const html = await renderToString(app)
    assert.equal((html.match(/class="github-event-card/g) || []).length, 2)
    assert.equal((html.match(/is-preview/g) || []).length, source === 'github' ? 1 : 2)
    assert.equal(tracked.includes(url), source !== 'github')
    assert.ok(tracked.includes(second.url))
  }
})
