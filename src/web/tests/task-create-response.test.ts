import assert from 'node:assert/strict'
import test from 'node:test'

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
})

const { mergeCreatedTask, taskFromCreateTaskResponse } = await import('../src/composables/useRoom')

const task = {
  id: 'task_123',
  title: 'Refresh board after create',
  status: 'proposed',
}

test('taskFromCreateTaskResponse accepts legacy nested task payloads', () => {
  assert.equal(taskFromCreateTaskResponse({ task }), task)
})

test('taskFromCreateTaskResponse accepts current top-level task payloads', () => {
  assert.equal(taskFromCreateTaskResponse(task), task)
})

test('taskFromCreateTaskResponse rejects non-task payloads', () => {
  assert.equal(taskFromCreateTaskResponse({ ok: true }), null)
})

test('mergeCreatedTask preserves a created task after stale refresh results', () => {
  assert.deepEqual(
    mergeCreatedTask([], task),
    [task],
  )
})

test('mergeCreatedTask replaces the optimistic task without duplicating it', () => {
  const optimisticTask = { ...task, title: 'Optimistic title' }

  assert.deepEqual(
    mergeCreatedTask([optimisticTask], task),
    [task],
  )
})


test('board task loading drains all pages with encoded cursors and no duplicates', async t => {
  const { fetchTasks } = await import('../src/composables/room/data')
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    paths.push(path)
    return new Response(JSON.stringify(paths.length === 1
      ? { tasks: [{ ...task, id: 'task_1' }, { ...task, id: 'task_2' }], has_more: true }
      : { tasks: [{ ...task, id: 'task_2' }, { ...task, id: 'task_3', status: 'done' }], has_more: false }), { status: 200 })
  })
  assert.deepEqual((await fetchTasks('github.com/org/repo')).map(task => task.id), ['task_1', 'task_2', 'task_3'])
  assert.deepEqual(paths, ['/rooms/github.com%2Forg%2Frepo/tasks?limit=200', '/rooms/github.com%2Forg%2Frepo/tasks?limit=200&after=task_2'])
})

test('board task loading refuses to present a partial list when pagination does not advance', async t => {
  const { fetchTasks } = await import('../src/composables/room/data')
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1
    return new Response(JSON.stringify({ tasks: [task], has_more: true }), { status: 200 })
  })
  assert.deepEqual(await fetchTasks('room_1'), [])
  assert.equal(requests, 2)
})

test('board planning writes preserve room encoding, authentication and compare-and-set revision', async t => {
  const { saveBoardPlanning } = await import('../src/composables/room/boardPlanning')
  const { defaultBoardPlanning } = await import('../../../shared/board-planning.mjs')
  let observed: unknown
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    observed = { path, method: init.method, credentials: init.credentials, body: JSON.parse(String(init.body)) }
    return new Response(JSON.stringify({ revision: 8 }), { status: 200 })
  })
  const document = defaultBoardPlanning()
  assert.deepEqual(await saveBoardPlanning('github.com/org/repo', { expectedRevision: 7, document }), { revision: 8 })
  assert.deepEqual(observed, { path: '/rooms/github.com%2Forg%2Frepo/board-planning', method: 'PATCH', credentials: 'same-origin', body: { expectedRevision: 7, document } })
})
