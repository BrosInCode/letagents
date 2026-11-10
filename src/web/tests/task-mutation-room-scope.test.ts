import assert from 'node:assert/strict'
import test from 'node:test'

Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })
const state = await import('../src/composables/room/state')
const { createRoomTaskMutations } = await import('../src/composables/room/taskMutations')
const { createRoomRefreshController } = await import('../src/composables/room/refresh')
const task = (title: string) => ({ id: 'task_1', title, status: 'proposed' as const })
function join(identifier: string, title: string) {
  state.resetRoomState({ activityHistoryLoading: false, githubEventsLoading: false, connectionState: 'idle' })
  state.room.value = { identifier } as typeof state.room.value
  state.tasks.value = [task(title)] as typeof state.tasks.value
}

for (const destination of ['room-b', 'room-a']) {
  test(`task acceptance ignores a stale response after joining a new session of ${destination}`, async t => {
    join('room-a', 'Original proposal')
    let respond!: (response: Response) => void
    const paths: string[] = [], refreshes: string[] = []
    t.mock.method(globalThis, 'fetch', async (path: string) => {
      paths.push(path)
      return new Promise<Response>(resolve => { respond = resolve })
    })
    const mutations = createRoomTaskMutations({ refreshRoomBoard: async () => true, refreshTasksAndPresence: async id => { refreshes.push(id) } })
    const pending = mutations.updateTask('task_1', { status: 'accepted' })
    join(destination, 'New session proposal')
    respond(new Response(JSON.stringify({ task: { ...task('Original proposal'), status: 'accepted' } }), { status: 200 }))
    assert.equal(await pending, false)
    assert.deepEqual(paths, ['/rooms/room-a/tasks/task_1'])
    assert.deepEqual(state.tasks.value, [task('New session proposal')])
    assert.deepEqual(refreshes, [])
  })
}

test('current-room acceptance updates its task and refreshes the originating room', async t => {
  join('room-a', 'Original proposal')
  const accepted = { ...task('Original proposal'), status: 'accepted' }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ task: accepted }), { status: 200 }))
  const refreshes: string[] = []
  const mutations = createRoomTaskMutations({ refreshRoomBoard: async () => true, refreshTasksAndPresence: async id => { refreshes.push(id) } })
  assert.equal(await mutations.updateTask('task_1', { status: 'accepted' }), true)
  assert.deepEqual(state.tasks.value, [accepted])
  assert.deepEqual(refreshes, ['room-a'])
})

test('task refresh cannot overwrite a new session of the same room', async t => {
  join('room-a', 'Original proposal')
  const pendingResponses: Array<() => void> = []
  t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => {
    pendingResponses.push(() => resolve(new Response(JSON.stringify({ tasks: [task('Stale proposal')], presence: [], artifacts: [] }), { status: 200 })))
  }))
  const refresh = createRoomRefreshController({ refreshParticipants: async () => {}, refreshPresence: async () => {} })
  const pending = refresh.refreshTasksAndPresence('room-a')
  join('room-a', 'New session proposal')
  pendingResponses.forEach(respond => respond())
  await pending
  assert.deepEqual(state.tasks.value, [task('New session proposal')])
})
