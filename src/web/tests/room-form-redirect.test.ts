import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryHistory, createRouter } from 'vue-router'
import { roomFormRedirect } from '../src/roomFormRedirect'

test('old links to the landing room form reach /new, also from the landing page itself', async () => {
  const page = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: page }, { path: '/new', component: page }, { path: '/docs', component: page },
  ] })
  router.beforeEach(to => roomFormRedirect(to))
  const go = async (from: string, to: string) => { await router.push(from); await router.push(to); return router.currentRoute.value.fullPath }
  assert.equal(await go('/docs', '/?new=blank#start'), '/new?new=blank')
  assert.equal(await go('/docs', '/#start'), '/new')
  assert.equal(await go('/', '/#start'), '/new')
  assert.equal(await go('/', '/?new=blank'), '/new?new=blank')
  assert.equal(await go('/docs', '/'), '/')
  assert.equal(await go('/docs', '/docs#start'), '/docs#start')
})
