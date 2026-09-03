import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ActivityApprovalEvidence: any

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  ActivityApprovalEvidence = (
    await vite.ssrLoadModule('/src/components/room/activity/ActivityApprovalEvidence.vue')
  ).default
})

after(async () => {
  await vite?.close()
})

const projectionJson = JSON.stringify({
  version: 1,
  category: 'file_change',
  path_scope: 'workspace_relative',
  changes: [{
    path: 'src/a.ts', kind: 'update', move_path: null,
    added_lines: 4, removed_lines: 1, diff_bytes: 90,
  }],
  totals: { file_count: 1, added_lines: 4, removed_lines: 1, diff_bytes: 90 },
})

const publication = {
  publication_id: 'publication_1', room_id: 'room_1', agent_key: 'EmmyMay/gardenpoint',
  delegation_instance_id: 'delegation_1', delegation_revision: 3,
  request_id: 'request_1', request_version: 2,
  request_sha256: 'a'.repeat(64), projection_sha256: 'b'.repeat(64),
  published_at: '2026-09-03T10:00:00.000Z', expires_at: '2036-09-03T10:00:00.000Z',
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    publication,
    evidenceStatus: 'ready',
    projectionJson,
    projection: JSON.parse(projectionJson),
    evidenceError: '',
    decisionBusy: false,
    decisionError: '',
    ...overrides,
  }
}

async function render(entries: unknown[]): Promise<string> {
  return renderToString(createSSRApp(ActivityApprovalEvidence, {
    entries, loading: false, loadingMore: false, error: '', hasMore: false,
  }))
}

test('approval card renders verified changes, exact bytes, and decision controls', async () => {
  const html = await render([entry()])
  assert.ok(html.includes('EmmyMay/gardenpoint needs approval'))
  assert.ok(html.includes('src/a.ts'))
  assert.ok(html.includes('Exact approval reference'))
  assert.ok(html.includes('&quot;version&quot;:1'), 'the exact JSON is present without client reserialization')
  assert.ok(html.includes('Allow once'))
  assert.ok(html.includes('Deny'))
})

test('unsupported and invalid references stay visible and non-actionable', async () => {
  for (const [candidate, label] of [
    [entry({ evidenceStatus: 'unsupported', projectionJson: null, projection: null }), 'Unsupported reference'],
    [entry({ evidenceStatus: 'invalid', projectionJson: null, projection: null, evidenceError: 'bad digest' }), 'Reference could not be verified'],
  ] as const) {
    const html = await render([candidate])
    assert.ok(html.includes(label))
    assert.ok(!html.includes('Allow once'))
    assert.ok(!html.includes('>Deny<'))
  }
})

test('approval panel stays absent when there is no actionable or failed state', async () => {
  assert.equal(await render([]), '<!---->')
})
