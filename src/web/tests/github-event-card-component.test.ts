import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let GitHubEventCard: unknown
let Group: any
let Disclosure: any
let ThreadTransition: any

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  GitHubEventCard = (await vite.ssrLoadModule('/src/components/room/GitHubEventCard.vue')).default
  Disclosure = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/DisclosurePanel.vue', import.meta.url)))).default
  ThreadTransition = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/ThreadTransition.vue', import.meta.url)))).default
  Group = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/RoomGitHubUpdates.vue', import.meta.url)))).default
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

const historyEvent = { kind: 'pull-request', tone: 'violet', kindLabel: 'Pull request', statusLabel: 'opened',
  headline: 'PR #800 opened by Ada', detail: 'A readable room', repository: 'BrosInCode/letagents', taskId: null,
  url: 'https://github.com/BrosInCode/letagents/pull/800', urlLabel: 'Open pull request' }

test('history rows show the original event and its time inline, with secondary actions disclosed on demand', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(GitHubEventCard as object, {
    event: historyEvent, history: true, room: true, timestamp: '2026-10-12T02:41:15Z',
  }) }))
  assert.match(html, /PR #800 opened by Ada/)
  assert.match(html, /<time[^>]*datetime="2026-10-12T02:41:15Z"/)
  assert.match(html, /github-history-toggle[^>]*aria-expanded="false"/)
  assert.doesNotMatch(html, /class="github-event-actions"/)
  assert.doesNotMatch(html, /A readable room/)
})

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
test('whole-group collapse retains individual history state; revealing a hidden original opens both levels', async () => {
  const messages = [{ id: 'msg_1', timestamp: '2026-10-12T02:41:15Z' }]
  const props = { grouped: true, messages, parseEvent: () => historyEvent }
  const html = await renderToString(createSSRApp({ render: () => h(Group, props) }))
  assert.match(html, /<button[^>]*class="[^"]*github-updates-heading[^"]*"[^>]*aria-expanded="true"[^>]*aria-controls=/)
  let vm: any
  const events: string[] = []
  const app = renderer.createApp({ setup() {
    vm = Group.setup(props, { expose() {}, emit: (name: string) => events.push(name) })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  try {
    const key = vm.rows.value[0].key
    await vm.toggle(key, { detail: 0 })
    assert.equal(vm.open.value.has(key), true)
    await vm.toggleGroup({ detail: 0 })
    assert.equal(vm.collapsed.value, true)
    assert.equal(vm.open.value.has(key), true)
    assert.equal(vm.instant.value, true, 'keyboard toggles have no motion')
    vm.open.value.clear()
    let ready = false
    vm.reveal({ detail: { id: 'msg_1', ready: () => { ready = true } }, stopPropagation() {} })
    await nextTick()
    assert.equal(vm.collapsed.value, false)
    assert.equal(vm.open.value.has(key), true)
    assert.equal(ready, true)
    assert.equal(events.filter(name => name === 'layoutStart').length, 2)
  } finally { app.unmount() }
})

for (const atBottom of [false, true]) {
  test(`collapsed groups retain ${atBottom ? 'latest intent' : 'older history'} across incoming updates`, async () => {
    const props = reactive({ grouped: true, messages: [{ id: 'msg_1', timestamp: '2026-10-12T02:41:15Z' }], parseEvent: () => historyEvent })
    let vm: any
    const app = renderer.createApp({ setup() { vm = Group.setup(props, { expose() {}, emit() {} }); return () => h('div') } })
    app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
    try {
      const key = vm.rows.value[0].key
      let top = atBottom ? 400 : 120, height = 500
      const el: any = { get scrollTop() { return top }, set scrollTop(value) { top = Math.min(value, height - 100) },
        get clientHeight() { return vm.collapsed.value ? 0 : 100 }, get scrollHeight() { return vm.collapsed.value ? 0 : height },
        getBoundingClientRect: () => ({ top: 0 }), children: [] }
      el.children = [{ dataset: { messageId: 'msg_1' }, getBoundingClientRect: () => ({ top: 120 - top, bottom: 164 - top }) }]
      vm.scrollers.set(key, el); vm.open.value.add(key); vm.rememberScroll(key)
      await vm.toggleGroup({ detail: 0 })
      height = 700
      props.messages.push({ id: 'msg_2', timestamp: '2026-10-12T02:42:15Z' })
      await nextTick(); await nextTick()
      vm.rememberScroll(key) // A delayed browser scroll event from hiding the element.
      await vm.toggleGroup({ detail: 0 })
      assert.equal(top, atBottom ? 600 : 120)
      assert.equal(vm.unseen.value.has(key), !atBottom)
    } finally { app.unmount() }
  })
}


test('shared disclosures give each trigger a unique controlled panel and hide collapsed actions', async () => {
  const html = await renderToString(createSSRApp({ render: () => h('div', [false, true].map(open =>
    h(Disclosure, { open }, { summary: () => 'Updates', default: () => h('button', 'View history') }),
  )) }))
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1])
  assert.equal(controls.length, 2)
  assert.notEqual(controls[0], controls[1])
  assert.match(html, new RegExp(`id="${controls[0]}"[^>]*inert[^>]*aria-hidden="true"[^>]*display:none`))
  assert.match(html, new RegExp(`id="${controls[1]}"[^>]*aria-hidden="false"`))
})

test('disclosure transition preserves collapsed inertness, reverses from current progress, and settles keyboard changes immediately', async () => {
  const props = reactive({ instant: false })
  let vm: any
  let settled = 0, measurements = 0, reducedMotion = false
  const app = renderer.createApp({ setup() {
    vm = ThreadTransition.setup(props, { expose() {}, emit: () => settled++ })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
  const originalStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  const originalMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ opacity: '1' }) })
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: reducedMotion }) })
  const animations: any[] = []
  const element: any = { style: {}, inert: false, firstElementChild: null,
    getBoundingClientRect: () => { measurements++; return { height: 100 } },
    animate(frames: unknown) {
      const animation = { frames, cancelled: false, effect: { getComputedTiming: () => ({ progress: .5 }) }, cancel() { this.cancelled = true }, onfinish: null }
      animations.push(animation); return animation
    },
  }
  try {
    vm.leave(element, () => {})
    assert.equal(element.inert, true)
    vm.interrupt(element)
    vm.enter(element, () => {})
    assert.equal(animations[1].frames[0].height, '50px', 'reopening starts at the interrupted visual height')
    animations[1].onfinish()
    assert.equal(element.inert, false)
    vm.leave(element, () => {})
    animations[2].onfinish()
    assert.equal(element.inert, true, 'a retained v-show panel stays inert after closing')
    props.instant = true
    await nextTick()
    const before = measurements
    vm.enter(element, () => {})
    assert.equal(element.inert, false)
    assert.equal(animations.length, 3)
    assert.equal(measurements, before, 'keyboard opening needs no layout measurement or animation')
    assert.equal(settled, 3)
    props.instant = false
    await nextTick()
    vm.enter(element, () => {})
    props.instant = true
    await nextTick()
    assert.equal(animations.at(-1).cancelled, true, 'switching to instant cancels an active effect')
    assert.equal(element.style.height, '')
    assert.equal(element.style.overflow, '')
    assert.equal(settled, 4)
    props.instant = false
    await nextTick()
    reducedMotion = true
    const animationCount = animations.length
    const reducedMeasurements = measurements
    vm.enter(element, () => {})
    assert.equal(animations.length, animationCount, 'reduced motion opens without an animation')
    assert.equal(measurements, reducedMeasurements)
    assert.equal(element.style.height, '')
    assert.equal(element.style.overflow, '')
    assert.equal(element.inert, false)
    assert.equal(settled, 5)
  } finally {
    app.unmount()
    for (const [key, descriptor] of [['getComputedStyle', originalStyle], ['matchMedia', originalMedia]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('reentrant thread opening cancels stale fill effects and releases height after asynchronous replies grow', () => {
  let vm: any, settled = 0, done = 0, naturalHeight = 250.797, unmounted = false
  const app = renderer.createApp({ setup() {
    vm = ThreadTransition.setup({ instant: false }, { expose() {}, emit: () => settled++ })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
  const originals = ['getComputedStyle', 'matchMedia', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const observers: Array<{ callback: () => void; disconnected: boolean }> = []
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ opacity: '1', marginTop: '6px', marginBottom: '0px' }) })
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    disconnected = false
    constructor(public callback: () => void) { observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  } })
  const animations: any[] = []
  const active = () => animations.filter(animation => !animation.cancelled)
  const element: any = { style: {}, inert: false,
    firstElementChild: { getBoundingClientRect: () => ({ height: naturalHeight - 6 }) },
    getBoundingClientRect: () => {
      // A fill:both effect wins over inline height:auto until it is cancelled.
      const filling = active().at(-1)
      return { height: filling ? parseFloat(filling.frames[1].height) : element.style.height && element.style.height !== 'auto' ? parseFloat(element.style.height) : naturalHeight }
    },
    animate(frames: any[]) {
      const animation = { frames, cancelled: false, currentTime: 120, effect: { getComputedTiming: () => ({ progress: .5 }) },
        cancel() { this.cancelled = true }, onfinish: null }
      animations.push(animation); return animation
    },
  }
  try {
    vm.enter(element, () => done++)
    vm.enter(element, () => done++) // Vue mount and v-show can both invoke enter.
    assert.equal(animations[0].cancelled, true, 'a replacement must not orphan the first fill:both effect')
    assert.equal(observers[0].disconnected, true)
    assert.equal(active().length, 1)
    naturalHeight = 334.195 // Fetched replies and the composer arrive during opening.
    observers.at(-1)!.callback()
    assert.equal(active().length, 1)
    assert.equal(animations.at(-1).frames[1].height, '334.195px', 'growth targets natural content height, not stale animation height')
    const count = animations.length
    observers[0].callback() // A queued callback from a cancelled observer is harmless.
    observers.at(-1)!.callback()
    assert.equal(animations.length, count, 'stable content cannot restart the animation forever')
    animations.at(-1).onfinish()
    assert.equal(active().length, 0)
    assert.equal(element.style.height, '')
    assert.equal(element.style.opacity, '')
    assert.equal(element.style.overflow, '')
    assert.equal(element.inert, false)
    assert.equal(done, 1)
    assert.equal(settled, 1)
    naturalHeight = 420
    assert.equal(element.getBoundingClientRect().height, 420, 'later draft growth remains unconstrained')
    vm.enter(element, () => done++)
    app.unmount()
    unmounted = true
    assert.equal(active().length, 0, 'unmount cancels the active animation')
    assert.equal(observers.every(observer => observer.disconnected), true)
    observers.at(-1)!.callback()
    assert.equal(animations.length, count + 1, 'unmounted observers cannot restart work')
  } finally {
    if (!unmounted) app.unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
