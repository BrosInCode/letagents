import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, markRaw, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer } from 'vite'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('typing stays out of prompt insertion and the thread composer', () => {
  for (const path of ['../src/components/room/composer/useComposerPrompts.ts',
    '../../../apps/desktop/renderer/src/components/desktop/content/room-chat/RoomThreadPanel.vue']) {
    assert.doesNotMatch(read(path), /useRoomTyping|TypingIndicator/)
  }
})

test('the shared indicator escapes names, announces a plain sentence and respects reduced motion', () => {
  const component = read('../../../shared/ui/TypingIndicator.vue')
  assert.doesNotMatch(component, /v-html|innerHTML/)
  assert.match(component, /<strong v-if="part\.name">\{\{ part\.text \}\}<\/strong>/)
  // Assistive technology gets the sentence only; the animated row is decoration.
  assert.match(component, /class="room-typing-status" role="status" aria-live="polite" aria-atomic="true">\{\{ label \}\}/)
  assert.match(component, /class="room-typing-clip" aria-hidden="true"/)
  assert.match(component, /\.room-typing-row \{[\s\S]*?pointer-events: none;/)
  assert.match(component, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.room-typing-wave i \{ animation: none;/)
  assert.match(component, /\.room-typing-fold:not\(\.is-in\) \.room-typing-wave i \{ animation-play-state: paused; \}/)
})

test('typing renders in the pinned live strip, outside the scrolling list and outside the composer', () => {
  for (const path of ['../src/components/room/Composer.vue',
    '../../../apps/desktop/renderer/src/components/desktop/content/room-chat/RoomComposer.vue']) {
    assert.doesNotMatch(read(path), /TypingIndicator/)
  }
  for (const [path, list] of [['../src/components/room/MessageList.vue', 'ref="messagesEl"'],
    ['../../../apps/desktop/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue', 'ref="messagesElement"']] as const) {
    const template = read(path).split('</template>\n\n<script')[0]
    const strip = template.indexOf('class="room-live-strip"')
    assert.ok(strip > template.indexOf(list), path)
    // The desktop strip is its activity line: typing is its lowest-priority pill, beside the working agents.
    const typingAt = path.includes('apps/desktop') ? template.indexOf(':typing-names=', strip) : template.indexOf('<TypingIndicator', strip)
    assert.ok(typingAt > strip, path)
    const workAt = path.includes('apps/desktop') ? template.indexOf(':work=', strip) : template.indexOf('<RoomWorkActivity', strip)
    assert.ok(workAt > strip, 'working agents share the strip')
    // The strip is a sibling of the scroll container, so no list ancestor is still open at that point.
    const before = template.slice(0, template.lastIndexOf('<div', strip))
    const open = (before.match(/<div\b/g) || []).length - (before.match(/<\/div>/g) || []).length
    assert.equal(open, 1, `${path}: only the root is open around the strip`)
  }
})

test('both clients use the shared expiry scheduler instead of a standing composer interval', () => {
  for (const path of ['../src/composables/roomTyping.ts',
    '../../../apps/desktop/renderer/src/composables/useRoomTyping.ts']) {
    const source = read(path)
    assert.match(source, /createTypingDisplay\(\(value: string\) =>/)
    assert.match(source, /export function useRoomTypingNames/)
    assert.doesNotMatch(source, /setInterval|clearInterval/)
    assert.match(source, /onScopeDispose\(\(\) => \{ leave\(\)/)
  }
})

let vite: any, Activity: any
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Activity = (await vite.ssrLoadModule('/src/components/room/RoomWorkActivity.vue')).default
})
after(async () => { await vite?.close() })
const work = (id: string) => ({ id, session: id, key: `agent/${id}`, name: `Agent ${id}`, summary: 'Reviewing <script> & changes', after: 'msg_1', retired: false })

test('compact thinking exposes every agent and keeps one reply-flight anchor per agent', async () => {
  const original = globalThis.document
  Object.assign(globalThis, { document: new EventTarget() })
  try {
    for (const count of [1, 5]) for (const expanded of [false, true]) {
      const component = { ...Activity, setup(props: any, context: any) {
        const vm = Activity.setup(props, context)
        vm.expanded.value = expanded
        return vm
      } }
      const html = await renderToString(createSSRApp({ render: () => h(component, { work: Array.from({ length: count }, (_, i) => work(String(i))) }) }))
      assert.equal((html.match(/data-motion-work/g) || []).length, count)
      for (let i = 0; i < count; i++) assert.equal((html.match(new RegExp(`data-motion-session="${i}"`, 'g')) || []).length, count === 1 && expanded ? 2 : 1)
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`))
      assert.equal((html.match(/class="web-work-row"/g) || []).length, expanded ? count : 0)
      assert.equal((html.match(/<canvas/g) || []).length, expanded ? count + 1 : 1, 'collapsed activity animates one orb regardless of agent count')
      assert.doesNotMatch(html, /<script>/)
      if (count === 1 || expanded) assert.match(html, /&lt;script&gt;/)
    }
  } finally { Object.assign(globalThis, { document: original }) }
})

test('thinking disclosure dismisses without stealing outside focus and removes idle listeners', () => {
  const original = { document: globalThis.document, Node: globalThis.Node }
  class ElementStub {}
  const listeners = new Set<unknown>()
  const doc = { addEventListener: (_: string, callback: unknown) => listeners.add(callback), removeEventListener: (_: string, callback: unknown) => listeners.delete(callback) }
  Object.assign(globalThis, { document: doc, Node: ElementStub })
  let vm: any, focused = 0
  const inside = new ElementStub(), outside = new ElementStub()
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp({ setup() {
    vm = Activity.setup(reactive({ work: [work('one')] }), { expose() {} })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  try {
    app.mount({})
    vm.root.value = markRaw({ contains: (node: unknown) => node === inside })
    vm.trigger.value = markRaw({ focus: () => focused++ })
    assert.equal(listeners.size, 0)
    vm.expanded.value = true
    assert.equal(listeners.size, 1)
    vm.onOutsidePress({ target: inside })
    assert.equal(vm.expanded.value, true)
    vm.close(true)
    assert.equal(focused, 1)
    assert.equal(listeners.size, 0)
    vm.expanded.value = true
    vm.onFocusOut({ relatedTarget: inside })
    assert.equal(vm.expanded.value, true)
    vm.onFocusOut({ relatedTarget: outside })
    assert.equal(vm.expanded.value, false)
    vm.expanded.value = true
    vm.onOutsidePress({ target: outside })
    assert.equal(vm.expanded.value, false)
    assert.equal(focused, 1, 'outside focus remains where the user put it')
    vm.expanded.value = true
  } finally { app.unmount(); Object.assign(globalThis, original) }
  assert.equal(listeners.size, 0)
})
