import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { computed, effectScope, nextTick, reactive, ref } from 'vue'
import { createServer, type ViteDevServer } from 'vite'
import {
  filterRooms,
  roomDisplayTitle,
  type DirectoryRoom,
} from '../../../shared/rooms/directory'

let vite: ViteDevServer
let useModel: any, useNavigation: any, actions: any, state: any
const settings = {
  parent_visibility: 'summary_only',
  activity_scope: 'task_and_branch',
  github_event_routing: 'task_and_branch',
}
const focus = (id = 'focus_1') => ({
  room_id: id,
  display_name: 'Focus: Release planning',
  kind: 'focus',
  parent_room_id: 'main',
  focus_key: 'topic_release',
  source_task_id: null,
  focus_status: 'active',
  focus_settings: { ...settings },
  focus_parent_visibility: 'summary_only',
  created_at: '2026-09-16T10:00:00Z',
})
const originalFetch = globalThis.fetch
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  useModel = (
    await vite.ssrLoadModule(
      '/src/components/room/focus-rooms/useFocusRoomsViewModel.ts',
    )
  ).useFocusRoomsViewModel
  useNavigation = (
    await vite.ssrLoadModule('/src/pages/room/useFocusRoomNavigation.ts')
  ).useFocusRoomNavigation
  actions = (
    await vite.ssrLoadModule('/src/composables/room/focusRoomActions.ts')
  ).createRoomFocusActions
  state = await vite.ssrLoadModule('/src/composables/room/state.ts')
})
after(async () => {
  globalThis.fetch = originalFetch
  await vite?.close()
})

function modelProps() {
  return reactive({
    tasks: [],
    focusRooms: [focus()],
    selectedTaskId: null,
    roomLabel: 'Main room',
    roomAddress: 'main',
    isFocusRoom: false,
    gitRoom: null,
    sourceTaskId: null,
    focusKey: null,
    focusStatus: null,
    focusSettings: { ...settings },
    conclusionSummary: null,
    conclusionDetails: null,
    isCreatingFocusRoom: false,
    isCreatingAdHocFocusRoom: false,
    isSharingFocusResult: false,
    isUpdatingFocusSettings: false,
  } as any)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
function navigation(overrides: Record<string, unknown> = {}) {
  const room = ref<any>({ identifier: 'main', kind: 'main' })
  const scope = effectScope()
  const notices: string[] = []
  const input = {
    room,
    router: { push: async () => undefined },
    focusParentAddress: computed(() => 'main'),
    toast: {
      error: (s: string) => notices.push(s),
      info: (s: string) => notices.push(s),
      success: (s: string) => notices.push(s),
    },
    showRoomsTab() {},
    createFocusRoom: async () => focus(),
    createAdHocFocusRoom: async () => focus(),
    shareFocusRoomResult: async () => ({ parentMessagePosted: true }),
    updateFocusRoomSettings: async () => focus(),
    ...overrides,
  }
  const vm = scope.run(() => useNavigation(input))
  return { vm, room, scope, notices }
}

test('directory keeps branches distinct, finds outcomes, and sorts without changing the input', () => {
  const rooms: DirectoryRoom[] = [
    {
      id: 'older',
      title: 'Branch room',
      kind: 'branch',
      closed: false,
      description: 'feature/reader',
      createdAt: '2026-09-01',
      closedAt: null,
    },
    {
      id: 'newer',
      title: 'Launch plan',
      kind: 'topic',
      closed: false,
      description: '',
      createdAt: '2026-09-16',
      closedAt: null,
    },
    {
      id: 'done',
      title: 'Release',
      kind: 'task',
      closed: true,
      description: 'Fixed login',
      createdAt: '2026-08-01',
      closedAt: '2026-09-15',
    },
  ]
  assert.deepEqual(
    filterRooms(rooms, false, '').map((r) => r.id),
    ['newer', 'older'],
  )
  assert.deepEqual(
    filterRooms(rooms, false, 'branch reader').map((r) => r.id),
    ['older'],
  )
  assert.deepEqual(
    filterRooms(rooms, true, 'login').map((r) => r.id),
    ['done'],
  )
  assert.equal(rooms[0].id, 'older')
  assert.equal(roomDisplayTitle('Focus: Launch plan'), 'Launch plan')
})

test('settings edit the selected room and survive snapshot refreshes', async () => {
  const scope = effectScope()
  const props = modelProps()
  const events: unknown[] = []
  const vm = scope.run(() =>
    useModel(props, (...args: unknown[]) => events.push(args)),
  )
  vm.selectedFocusRoomId.value = 'focus_1'
  await nextTick()
  vm.settingsDraft.value.parent_visibility = 'silent'
  props.focusRooms = [{ ...focus(), focus_settings: { ...settings } }]
  await nextTick()
  assert.equal(vm.settingsDraft.value.parent_visibility, 'silent')
  vm.submitFocusSettings()
  assert.deepEqual(events, [
    [
      'updateFocusSettings',
      'topic_release',
      { ...settings, parent_visibility: 'silent' },
    ],
  ])
  props.focusRooms[0].focus_settings = {
    ...settings,
    parent_visibility: 'silent',
  }
  await nextTick()
  assert.equal(vm.hasSettingsChanges.value, false)
  scope.stop()
})

test('closeout describes persisted visibility and keeps drafts through refresh, but resets for another room', async () => {
  const scope = effectScope()
  const props = modelProps()
  Object.assign(props, {
    isFocusRoom: true,
    focusKey: 'topic_a',
    roomLabel: 'Room A',
  })
  const vm = scope.run(() => useModel(props, () => undefined))
  vm.resultSummary.value = 'Unsaved outcome'
  vm.closeoutDetails.value.artifact = 'PR #42'
  vm.settingsDraft.value.parent_visibility = 'silent'
  props.focusSettings = { ...settings }
  props.conclusionDetails = null
  await nextTick()
  assert.equal(vm.resultSummary.value, 'Unsaved outcome')
  assert.equal(vm.closeoutDetails.value.artifact, 'PR #42')
  assert.equal(vm.shareButtonLabel.value, 'Share outcome and close')
  assert.match(vm.shareHelpText.value, /shares the outcome with the main room/)
  props.focusSettings = { ...settings, parent_visibility: 'silent' }
  await nextTick()
  assert.equal(vm.shareButtonLabel.value, 'Save outcome and close')
  props.focusKey = 'topic_b'
  props.roomLabel = 'Room B'
  await nextTick()
  assert.equal(vm.resultSummary.value, '')
  assert.equal(vm.closeoutDetails.value.artifact, '')
  scope.stop()
})

test('duplicate creation is guarded and a failed navigation retries opening without another POST', async () => {
  const result = deferred<any>()
  let posts = 0
  const paths: string[] = []
  let blocked = true
  const { vm, scope } = navigation({
    createAdHocFocusRoom: () => {
      posts++
      return result.promise
    },
    router: {
      push: async (path: string) => {
        paths.push(path)
        return blocked ? { type: 4 } : undefined
      },
    },
  })
  const first = vm.handleCreateAdHocFocusRoom('Release planning')
  await vm.handleCreateAdHocFocusRoom('Release planning')
  await vm.handleFocusTask('task_1')
  assert.equal(posts, 1)
  result.resolve(focus())
  await first
  assert.match(vm.creationError.value, /was created/)
  assert.equal(vm.createdRoom.value.id, 'focus_1')
  blocked = false
  await vm.handleCreateAdHocFocusRoom('Release planning')
  assert.equal(posts, 1)
  assert.equal(paths.length, 2)
  assert.equal(paths[0], paths[1])
  assert.equal(vm.creationError.value, null)
  scope.stop()
})

test('rejected creation is retryable and a late response cannot navigate away from a new room', async () => {
  let posts = 0
  const { vm, scope } = navigation({
    createAdHocFocusRoom: async () => {
      posts++
      throw new Error('offline')
    },
  })
  await vm.handleCreateAdHocFocusRoom('Room')
  assert.match(vm.creationError.value, /Could not create/)
  assert.equal(vm.creatingAdHocFocusRoom.value, false)
  await vm.handleCreateAdHocFocusRoom('Room')
  assert.equal(posts, 2)
  scope.stop()
  const result = deferred<any>()
  const paths: string[] = []
  const late = navigation({
    createAdHocFocusRoom: () => result.promise,
    router: {
      push: async (path: string) => {
        paths.push(path)
      },
    },
  })
  const pending = late.vm.handleCreateAdHocFocusRoom('Room')
  late.room.value = { identifier: 'different', kind: 'main' }
  result.resolve(focus())
  await pending
  assert.deepEqual(paths, [])
  assert.equal(late.vm.createdRoom.value, null)
  late.scope.stop()
})

for (const operation of ['create', 'task', 'settings', 'close'] as const) {
  test(`late ${operation} response cannot mutate a different room session`, async () => {
    state.resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
    state.room.value = {
      identifier: 'focus_1',
      projectId: 'focus_1',
      kind: operation === 'close' ? 'focus' : 'main',
      parentRoomId: 'main',
      focusKey: 'topic_release',
      displayName: 'Original',
    }
    const request = deferred<Response>()
    globalThis.fetch = () => request.promise
    const api = actions()
    const pending =
      operation === 'create'
        ? api.createAdHocFocusRoom('New')
        : operation === 'task'
          ? api.createFocusRoom('task_1')
          : operation === 'settings'
            ? api.updateFocusRoomSettings('topic_release', {
                parent_visibility: 'silent',
              })
            : api.shareFocusRoomResult('Done', null)
    // Leave and return to the same identifier: session identity still differs.
    state.resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
    state.room.value = {
      identifier: 'focus_1',
      projectId: 'focus_1',
      kind: 'focus',
      displayName: 'Rejoined room',
      focusStatus: 'active',
    }
    request.resolve(
      new Response(
        JSON.stringify({
          focus_room: {
            ...focus(),
            focus_status: 'concluded',
            conclusion_summary: 'Old outcome',
          },
        }),
        { status: 200 },
      ),
    )
    assert.ok(await pending)
    assert.deepEqual(state.focusRooms.value, [])
    assert.equal(state.room.value.displayName, 'Rejoined room')
    assert.equal(state.room.value.focusStatus, 'active')
    globalThis.fetch = originalFetch
  })
}
