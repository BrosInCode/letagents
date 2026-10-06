import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LETAGENTS_ROOM_ORIGIN,
  MESSAGE_ID_PATTERN,
  isValidMessageId,
  isLocalRoomIdentifier,
  buildLetAgentsMessageUrl,
  parseLetAgentsMessageUrl,
  resolveSameRoomMessageReference,
} from '../src/domain/roomRoutes'

test('isValidMessageId strictly validates ^msg_[1-9]\\d*$', () => {
  assert.equal(isValidMessageId('msg_1'), true)
  assert.equal(isValidMessageId('msg_42'), true)
  assert.equal(isValidMessageId('msg_99999'), true)

  assert.equal(isValidMessageId(''), false)
  assert.equal(isValidMessageId('msg_0'), false)
  assert.equal(isValidMessageId('msg_01'), false)
  assert.equal(isValidMessageId('msg_'), false)
  assert.equal(isValidMessageId('msg_-1'), false)
  assert.equal(isValidMessageId('msg_abc'), false)
  assert.equal(isValidMessageId('task_1'), false)
  assert.equal(isValidMessageId('123'), false)
  assert.equal(isValidMessageId('msg_1 '), false)
  assert.equal(isValidMessageId(' msg_1'), false)
  assert.equal(isValidMessageId(null), false)
  assert.equal(isValidMessageId(undefined), false)
})

test('buildLetAgentsMessageUrl and parseLetAgentsMessageUrl test table', () => {
  const table = [
    {
      room: 'focus_90',
      msgId: 'msg_157',
      expected: 'https://letagents.chat/in/focus_90?message=msg_157',
    },
    {
      room: 'github.com/BrosInCode/letagents',
      msgId: 'msg_42',
      expected: 'https://letagents.chat/in/github.com/BrosInCode/letagents?message=msg_42',
    },
    {
      room: 'github.com/Bros In Code/letagents#staging',
      msgId: 'msg_1',
      expected: 'https://letagents.chat/in/github.com/Bros%20In%20Code/letagents%23staging?message=msg_1',
    },
  ]

  for (const row of table) {
    const built = buildLetAgentsMessageUrl(row.room, row.msgId)
    assert.equal(built, row.expected)

    const parsed = parseLetAgentsMessageUrl(built)
    assert.deepEqual(parsed, {
      roomIdentifier: row.room,
      messageId: row.msgId,
    })
  }

  // Foreign origin is rejected
  assert.equal(
    parseLetAgentsMessageUrl('https://evil.com/in/room?message=msg_1', LETAGENTS_ROOM_ORIGIN),
    null,
  )

  // One URL form only: ?m= is ignored
  assert.deepEqual(
    parseLetAgentsMessageUrl('https://letagents.chat/in/room?m=msg_1'),
    { roomIdentifier: 'room', messageId: null },
  )

  // Hash alias is ignored
  assert.deepEqual(
    parseLetAgentsMessageUrl('https://letagents.chat/in/room#msg_1'),
    { roomIdentifier: 'room', messageId: null },
  )
})

test('resolveSameRoomMessageReference intercepts only same-room message links', () => {
  const currentRoom = 'github.com/BrosInCode/letagents'
  const sameRoomUrl = 'https://letagents.chat/in/github.com/BrosInCode/letagents?message=msg_12'
  const otherRoomUrl = 'https://letagents.chat/in/focus_90?message=msg_12'
  const nonMessageUrl = 'https://letagents.chat/in/github.com/BrosInCode/letagents'
  const externalUrl = 'https://github.com/BrosInCode/letagents/pull/1500'

  // Same room message permalink -> returns message ID
  assert.equal(
    resolveSameRoomMessageReference(sameRoomUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    'msg_12',
  )

  // Another room message permalink -> returns null (not intercepted)
  assert.equal(
    resolveSameRoomMessageReference(otherRoomUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    null,
  )

  // Same room non-message link -> returns null
  assert.equal(
    resolveSameRoomMessageReference(nonMessageUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    null,
  )

  // External link -> returns null
  assert.equal(
    resolveSameRoomMessageReference(externalUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    null,
  )
})


// Execute the component's actual handler with deferred I/O, not a reimplementation
// of the permalink decision. AST selection keeps this independent of formatting.
async function permalinkFixture(withWatcher = false) {
  const { reactive, ref, watch, effectScope } = await import('vue')
  const { readFileSync } = await import('node:fs')
  const ts = (await import('typescript')).default
  const { runInNewContext } = await import('node:vm')
  const source = readFileSync(new URL('../src/pages/Room.vue', import.meta.url), 'utf8')
  const marker = '<script setup lang="ts">'
  const script = source.slice(source.indexOf(marker) + marker.length, source.indexOf('</script>'))
  const ast = ts.createSourceFile('Room.ts', script, ts.ScriptTarget.Latest, true)
  const selected = ast.statements.filter(statement =>
    (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast).startsWith('messagePermalink')))
    || (ts.isFunctionDeclaration(statement) && statement.name?.text === 'handleMessagePermalink')
    || (withWatcher && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === 'watch' && statement.getText(ast).includes('handleMessagePermalink')),
  ).map(statement => statement.getText(ast)).join('\n')
  const room = ref<{ identifier: string; requestedIdentifier?: string }>({ identifier: 'room-a' })
  const route = reactive({ params: { roomId: 'room-a' }, query: { message: 'msg_50' as string | undefined, view: 'chat' } })
  const effects: unknown[] = []
  const lookups: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
  const scope = effectScope()
  const handle = scope.run(() => runInNewContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nhandleMessagePermalink', {
    room, route, watch, isConnected: ref(true), messagesLoaded: ref(true), isValidMessageId, isVisibleRoomMessage: () => true,
    roomPath: (id: string) => `/rooms/${id}`,
    apiFetch: () => new Promise((resolve, reject) => lookups.push({ resolve, reject })),
    toast: { info: (text: string) => effects.push({ notice: text }) },
    router: { replace: (input: unknown) => effects.push({ replace: input }) },
    setActiveTab: (tab: string) => effects.push({ tab }),
    roomTabPanelsRef: { value: { openMessageInChat: (message: string) => effects.push({ message, room: room.value.identifier }) } },
  })) as (id: string) => Promise<void>
  return { handle, room, route, effects, lookups, stop: () => scope.stop() }
}

for (const result of ['found', 'missing', 'offline'] as const) {
  test(`late ${result} permalink lookup cannot affect another room`, async () => {
    const f = await permalinkFixture()
    const pending = f.handle('msg_50')
    f.room.value.identifier = 'room-b'
    f.route.params.roomId = 'room-b'
    f.route.query.message = 'msg_99'
    if (result === 'found') f.lookups[0]!.resolve({ message: { id: 'msg_50' } })
    else f.lookups[0]!.reject(result === 'missing' ? { status: 404 } : new Error('offline'))
    await pending
    assert.deepEqual(f.effects, [])
  })
}

test('only the latest permalink request can reveal, including repeated targets', async () => {
  const f = await permalinkFixture()
  const first = f.handle('msg_50')
  f.route.query.message = 'msg_99'
  const second = f.handle('msg_99')
  f.route.query.message = 'msg_50'
  const latest = f.handle('msg_50')
  assert.equal(f.lookups.length, 3)
  f.lookups[0]!.resolve({ message: { id: 'msg_50' } })
  f.lookups[1]!.reject({ status: 404 })
  await Promise.all([first, second])
  assert.deepEqual(f.effects, [])
  f.lookups[2]!.resolve({ message: { id: 'msg_50' } })
  await latest
  assert.deepEqual(f.effects.slice(0, 2), [{ tab: 'chat' }, { message: 'msg_50', room: 'room-a' }])
  assert.equal(f.effects.length, 3)
})

test('a removed permalink query invalidates the pending lookup', async () => {
  const f = await permalinkFixture()
  const pending = f.handle('msg_50')
  f.route.query.message = undefined
  f.lookups[0]!.resolve({ message: { id: 'msg_50' } })
  await pending
  assert.deepEqual(f.effects, [])
})

test('permalink watcher ignores unrelated query changes while a lookup is pending', async () => {
  const f = await permalinkFixture(true)
  try {
    assert.equal(f.lookups.length, 1)
    f.route.query = { ...f.route.query, view: 'board' }
    assert.equal(f.lookups.length, 1, 'an unchanged room/message must not restart the lookup')
    f.route.query = { ...f.route.query, message: 'msg_99' }
    assert.equal(f.lookups.length, 2, 'a new target still starts its own lookup')
  } finally { f.stop() }
})

test('permalink lookup waits until the loaded room belongs to the route', async () => {
  const f = await permalinkFixture()
  f.route.params.roomId = 'room-b'
  const pending = f.handle('msg_50')
  f.lookups[0]?.resolve({ message: { id: 'msg_50' } })
  await pending
  assert.equal(f.lookups.length, 0, 'do not ask room A for a target from room B')
  assert.deepEqual(f.effects, [])
})

test('joined canonical room retains its route alias for permalink ownership', async t => {
  const { joinRoomSession } = await import('../src/composables/room/join')
  const alias = 'github.com/Org/Repo/focus/task_7'
  t.mock.method(globalThis, 'fetch', async () => Response.json({ room_id: 'focus_90', kind: 'focus' }))
  const joined = await joinRoomSession(alias)
  assert.equal(joined.identifier, 'focus_90')
  assert.equal(joined.requestedIdentifier, alias)
  const f = await permalinkFixture()
  f.room.value = joined
  f.route.params.roomId = alias
  const pending = f.handle('msg_50')
  assert.equal(f.lookups.length, 1, 'a resolved alias still belongs to its joined room')
  f.lookups[0]!.resolve({ message: { id: 'msg_50' } })
  await pending
  assert.deepEqual(f.effects.slice(0, 2), [{ tab: 'chat' }, { message: 'msg_50', room: 'focus_90' }])
})
