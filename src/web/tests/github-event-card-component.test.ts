import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let GitHubEventCard: unknown

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  GitHubEventCard = (await vite.ssrLoadModule('/src/components/room/GitHubEventCard.vue')).default
})

after(async () => {
  await vite?.close()
})

test('GitHub event task chips expose the Board navigation contract', async () => {
  const app = createSSRApp({
    render: () => h(GitHubEventCard as object, {
      event: {
        kind: 'pull-request',
        tone: 'violet',
        kindLabel: 'Pull request',
        statusLabel: 'opened',
        headline: 'PR #800 opened',
        detail: 'Link task mentions',
        repository: 'BrosInCode/letagents',
        taskId: 'task_42',
        url: 'https://github.com/BrosInCode/letagents/pull/800',
        urlLabel: 'Open pull request',
      },
      taskLinkEnabled: true,
    }),
  })

  const html = await renderToString(app)
  assert.match(html, /<button[^>]*data-task-reference-id="task_42"/)
  assert.match(html, /title="Open task_42 on the Board"/)
})
