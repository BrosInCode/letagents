import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, createRenderer, h, nextTick, ref } from 'vue'

import type { RoomReasoningSession } from '../src/composables/useRoom'

// The room module reads localStorage when it loads.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { useReasoningTracePresentation } = await import('../src/components/room/reasoning-trace/useReasoningTracePresentation')

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}),
  createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
})

test('the open modal turns a silent live stream Stale on its own, and the clock stops when it closes or unmounts', async (t) => {
  const start = Date.parse('2026-11-19T10:00:00.000Z')
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: start })
  const session = ref<RoomReasoningSession | null>({
    id: 'rs_1', actor_label: 'RiverFox | Ada\'s agent | Codex', status: 'working', summary: 'Working',
    created_at: new Date(start).toISOString(), updated_at: new Date(start).toISOString(),
  } as RoomReasoningSession)
  const open = ref(true)
  let presentation!: ReturnType<typeof useReasoningTracePresentation>
  const app = renderer.createApp({
    setup() {
      presentation = useReasoningTracePresentation(computed(() => session.value), () => open.value)
      return () => h('div')
    },
  })
  app.mount({})
  await nextTick()
  assert.equal(presentation.streamState.value, 'live')

  // Three minutes and a half later the 30 s clock has ticked and the stream reads Stale.
  t.mock.timers.tick(210_000)
  await nextTick()
  assert.deepEqual([presentation.streamState.value, presentation.streamLabel.value], ['recent', 'Stale'])

  // A new update while open makes it live again.
  session.value = { ...session.value!, updated_at: new Date(Date.now()).toISOString() }
  await nextTick()
  assert.equal(presentation.streamState.value, 'live')

  // Closed: the clock stops, so time passing changes nothing.
  open.value = false
  await nextTick()
  t.mock.timers.tick(600_000)
  await nextTick()
  assert.equal(presentation.streamState.value, 'live')

  app.unmount()
  t.mock.timers.tick(600_000)
})
