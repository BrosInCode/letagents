import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { ModuleKind, transpileModule } from 'typescript'
import * as Vue from 'vue'
import { createServer, type ViteDevServer } from 'vite'
import { createActivityUnread } from '../../../shared/ui/activity/unread'
import type { ActivityEvent } from '../../../shared/ui/activity/model'

let vite: ViteDevServer
let Feed: any
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  const path = fileURLToPath(new URL('../../../shared/ui/activity/ActivityFeed.vue', import.meta.url))
  Feed = (await vite.ssrLoadModule(path)).default
  const descriptor = parse(await readFile(path, 'utf8')).descriptor
  const script = compileScript(descriptor, { id: path })
  const template = compileTemplate({ source: descriptor.template!.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const code = transpileModule(template.code, { compilerOptions: { module: ModuleKind.ESNext } }).outputText
    .replace(/import \{([\s\S]*?)\} from "vue";/g, (_all, names: string) => `const {${names.replace(/\s+as\s+/g, ': ')}} = vue;`)
    .replace('export function render', 'function render')
  Feed.render = Function('vue', code + '\nreturn render;')(Vue)
})
after(async () => { await vite?.close() })

function event(id: string, number: number, minute: number): ActivityEvent {
  return { id, event_type: 'pull_request', action: 'opened', github_object_id: String(number),
    github_object_url: `https://github.com/octo/repo/pull/${number}`, title: `PR ${number}`, state: 'open',
    actor_login: 'octo', created_at: `2026-11-07T10:${String(minute).padStart(2, '0')}:00Z`, metadata: {}, linked_task_id: null }
}

test('real Activity feed acknowledges only presented rows after success, visibility and modal gates', async () => {
  const previousDocument = globalThis.document
  const documentStub = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.document = documentStub as unknown as Document
  const unread = createActivityUnread()
  unread.setScope('viewer')
  const props = Vue.reactive({ roomIdentifier: 'room', events: [event('pr-1', 1, 1)], loading: true, loadingOlder: false, available: true, readable: true, error: null as string | null })
  unread.receive('room', ['pr-1'])
  type Node = { tag: string; props: Record<string, any>; children: Node[]; text?: string; parent?: Node }
  const node = (tag = ''): Node => ({ tag, props: {}, children: [], addEventListener() {}, removeEventListener() {} } as Node)
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: tag => node(tag), createText: text => ({ ...node(), text }), createComment: () => node(),
    setText(n, text) { n.text = text }, setElementText(n, text) { n.children = []; n.text = text },
    patchProp(n, key, _old, value) { n.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) { const i = child.parent.children.indexOf(child); if (i >= 0) child.parent.children.splice(i, 1) }; child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, child) },
    remove(n) { const i = n.parent?.children.indexOf(n) ?? -1; if (i >= 0) n.parent!.children.splice(i, 1) },
    parentNode: n => n.parent || null, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  })
  const root = node('root')
  const app = renderer.createApp({ render: () => Vue.h(Feed, { ...props, onPresented: (ids: string[]) => unread.acknowledge('room', ids) }) })
  app.provide(Vue.ssrContextKey, { modules: new Set() })
  const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)]
  const text = (n: Node): string => (n.text || '') + n.children.map(text).join('')
  function click(label: string) {
    const button = all(root).find(n => n.tag === 'button' && text(n).trim() === label)
    assert.ok(button, label)
    button.props.onClick({ detail: 0 })
  }
  try {
    app.mount(root)
    await Vue.nextTick()
    assert.equal(unread.count('room'), 1, 'loading rows are not read')
    props.loading = false; props.error = 'Could not load'
    await Vue.nextTick()
    assert.equal(unread.count('room'), 1, 'failed load cannot clear the badge')
    props.error = null; props.readable = false
    await Vue.nextTick()
    assert.equal(unread.count('room'), 1, 'a covering modal prevents acknowledgement')
    props.readable = true; documentStub.visibilityState = 'hidden'; documentStub.dispatchEvent(new Event('visibilitychange'))
    await Vue.nextTick()
    assert.equal(unread.count('room'), 1, 'a hidden window is not a read')
    documentStub.visibilityState = 'visible'; documentStub.dispatchEvent(new Event('visibilitychange'))
    await Vue.nextTick()
    assert.equal(unread.count('room'), 0)
    click('Merged'); await Vue.nextTick()
    unread.receive('room', ['pr-1-update'])
    props.events = [...props.events, event('pr-1-update', 1, 2)]
    await Vue.nextTick()
    assert.equal(unread.count('room'), 1, 'a filtered-out group remains unread')
    click('All activity'); await Vue.nextTick()
    assert.equal(unread.count('room'), 0)
    unread.receive('room', ['pr-2'])
    props.events = [...props.events, event('pr-2', 2, 3)]
    await Vue.nextTick()
    assert.equal(unread.count('room'), 1, 'a new group held behind Show updates is not yet presented')
    click('Show 1 update ↑'); await Vue.nextTick()
    assert.equal(unread.count('room'), 0)
  } finally { app.unmount(); globalThis.document = previousDocument }
})
