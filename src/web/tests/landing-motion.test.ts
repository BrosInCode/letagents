import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { before, test, type TestContext } from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as Vue from 'vue'
import * as Three from 'three'
import * as bridge from '../src/components/landing/symbiosisData'

let canvasSource: string
let narrativeSource: string
before(async () => {
  async function compile(name: string) {
    const filename = fileURLToPath(new URL(`../src/components/landing/${name}.vue`, import.meta.url))
    const descriptor = parse(await readFile(filename, 'utf8'), { filename }).descriptor
    const script = compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
    return transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  }
  canvasSource = await compile('SymbiosisCanvas')
  narrativeSource = await compile('SymbiosisSection')
})

function environment(t: TestContext, { mobile = false, failWebGL = false } = {}) {
  const originals = new Map(['window', 'document', 'ResizeObserver', 'IntersectionObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  class Events {
    listeners = new Map<string, Set<Function>>()
    addEventListener(type: string, fn: Function) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn) }
    removeEventListener(type: string, fn: Function) { this.listeners.get(type)?.delete(fn) }
    emit(type: string, event: any = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event) }
    count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) }
  }
  class Media extends Events {
    constructor(public matches: boolean) { super() }
    change(matches: boolean) { this.matches = matches; this.emit('change', { matches }) }
  }
  const media = {
    reduced: new Media(false),
    compact: new Media(mobile),
    fine: new Media(!mobile),
  }
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const win = Object.assign(new Events(), {
    innerWidth: mobile ? 390 : 1440, innerHeight: mobile ? 844 : 900, devicePixelRatio: 3, scrollY: 0,
    matchMedia(query: string) { return query.includes('reduced-motion') ? media.reduced : query.includes('max-width') ? media.compact : media.fine },
    requestAnimationFrame(fn: FrameRequestCallback) { frames.set(++nextFrame, fn); return nextFrame },
    cancelAnimationFrame(id: number) { frames.delete(id) },
  })
  const doc = Object.assign(new Events(), { hidden: false, documentElement: { scrollHeight: 3000 } })
  const resizeObservers: Observer[] = []
  const intersectionObservers: Observer[] = []
  class Observer {
    targets: any[] = []
    disconnected = false
    constructor(public callback: Function) {}
    observe(target: any) { this.targets.push(target) }
    disconnect() { this.disconnected = true }
    emit(entries: any[]) { this.callback(entries) }
  }
  Object.assign(globalThis, {
    window: win, document: doc,
    ResizeObserver: class extends Observer { constructor(callback: Function) { super(callback); resizeObservers.push(this) } },
    IntersectionObserver: class extends Observer { constructor(callback: Function) { super(callback); intersectionObservers.push(this) } },
  })
  const cleanups: (() => void)[] = []
  t.after(() => {
    for (const cleanup of cleanups) cleanup()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    bridge.setHemisphereFocus('fused')
  })
  const renderers: FakeRenderer[] = []
  class FakeRenderer {
    renders: { scene: Three.Scene; camera: Three.PerspectiveCamera; light: number; coreX: number }[] = []
    dpr = 0
    width = 0
    height = 0
    disposals = 0
    constructor() { if (failWebGL) throw new Error('WebGL unavailable'); renderers.push(this) }
    setPixelRatio(dpr: number) { this.dpr = dpr }
    setSize(width: number, height: number) { this.width = width; this.height = height }
    setClearColor() {}
    render(scene: Three.Scene, camera: Three.PerspectiveCamera) {
      const root = scene.children[0]
      const core = root.children[0]
      const material = (core.children[0] as Three.Mesh).material as Three.ShaderMaterial
      this.renders.push({ scene, camera, light: material.uniforms.uLightMode.value, coreX: core.position.x })
    }
    dispose() { this.disposals++ }
  }
  function component(source: string) {
    const exports: any = {}
    Function('require', 'exports', source)((name: string) => {
      if (name === 'vue') return Vue
      if (name === 'three') return { ...Three, WebGLRenderer: FakeRenderer }
      if (name === './symbiosisData') return bridge
      if (name.startsWith('@/components/icons/')) return { default: { render: () => Vue.h('svg') } }
      throw new Error(`Unexpected component import: ${name}`)
    }, exports)
    return exports.default
  }
  class HostNode extends Events {
    props: Record<string, any> = {}
    children: HostNode[] = []
    parent: HostNode | null = null
    text = ''
    constructor(public tag = '') { super() }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: win.innerHeight, width: win.innerWidth, height: win.innerHeight } }
    closest() { return hero }
  }
  const hero = new HostNode('hero')
  const host = Vue.createRenderer<HostNode, HostNode>({
    createElement: tag => new HostNode(tag), createText: text => Object.assign(new HostNode(), { text }), createComment: () => new HostNode(),
    setText(n, text) { n.text = text }, setElementText(n, text) { n.children = []; n.text = text },
    patchProp(n, key, _old, value) { n.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) { const i = child.parent.children.indexOf(child); if (i >= 0) child.parent.children.splice(i, 1) }; child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, child) },
    remove(n) { const i = n.parent?.children.indexOf(n) ?? -1; if (i >= 0) n.parent!.children.splice(i, 1) },
    parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  })
  function mount(source: string, props = Vue.reactive<Record<string, any>>({})) {
    const root = new HostNode('root')
    const Component = component(source)
    const app = host.createApp({ render: () => Vue.h(Component, props) })
    app.mount(root)
    let mounted = true
    function unmount() { if (mounted) { app.unmount(); mounted = false } }
    cleanups.push(unmount)
    const all = (n: HostNode): HostNode[] => [n, ...n.children.flatMap(all)]
    return { unmount, props, nodes: () => all(root) }
  }
  function frame(now: number) { const pending = [...frames.entries()]; for (const [id, fn] of pending) { frames.delete(id); fn(now) } }
  function disposalCounts() {
    const counts = { geometries: 0, materials: 0 }
    renderers[0].renders[0].scene.traverse(object => {
      if (!(object instanceof Three.Mesh || object instanceof Three.Points || object instanceof Three.LineSegments)) return
      object.geometry.addEventListener('dispose', () => { counts.geometries++ })
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.addEventListener('dispose', () => { counts.materials++ })
    })
    return counts
  }
  return { mount, frame, disposalCounts, win, doc, media, frames, resizeObservers, intersectionObservers, renderers, hero }
}

const hasClass = (node: any, name: string) => String(node.props.class).split(' ').includes(name)

test('mobile Venom preserves the 3D scene without animation or touch tracking and redraws theme/size once', async t => {
  const env = environment(t, { mobile: true })
  const view = env.mount(canvasSource, Vue.reactive({ theme: 'dark' }))
  const renderer = env.renderers[0]
  assert.equal(renderer.renders.length, 1)
  assert.equal(renderer.dpr, 1.5)
  assert.equal(Math.abs(renderer.renders[0].coreX), 0)
  assert.ok(renderer.renders[0].camera.position.z > 20, 'portrait camera fits the core within the screen')
  assert.equal(env.frames.size, 0)
  assert.equal(env.win.count(), 0, 'static mobile canvas does not listen to touch or scrolling')
  env.frame(1000)
  assert.equal(renderer.renders.length, 1)
  view.props.theme = 'light'
  await Vue.nextTick()
  assert.equal(renderer.renders.length, 2)
  assert.equal(renderer.renders.at(-1)!.light, 1, 'static theme redraw uses the final palette')
  env.doc.hidden = true
  view.props.theme = 'dark'
  await Vue.nextTick()
  assert.equal(renderer.renders.length, 2, 'hidden theme updates wait until visible')
  env.doc.hidden = false
  env.doc.emit('visibilitychange')
  assert.equal(renderer.renders.at(-1)!.light, 0)
  const before = renderer.renders.length
  env.resizeObservers[0].emit([{ contentRect: { width: 390, height: 844 } }])
  assert.equal(renderer.renders.length, before, 'unchanged dimensions do not repaint')
  env.resizeObservers[0].emit([{ contentRect: { width: 844, height: 390 } }])
  assert.equal(renderer.renders.length, before + 1)
  assert.equal(env.frames.size, 0)
})

test('desktop canvas bounds frame rate and pauses on hero exit, hidden tab, live motion changes, and unmount', async t => {
  const env = environment(t)
  const view = env.mount(canvasSource)
  const renderer = env.renderers[0]
  const disposed = env.disposalCounts()
  assert.equal(env.intersectionObservers[0].targets[0], env.hero, 'observe the hero, not the fixed canvas')
  env.frame(100)
  const before = renderer.renders.length
  env.frame(108); env.frame(116); env.frame(124)
  assert.equal(renderer.renders.length, before, '120Hz events do not redraw more than 30fps')
  env.frame(134)
  assert.equal(renderer.renders.length, before + 1)
  env.intersectionObservers[0].emit([{ isIntersecting: false }])
  assert.equal(env.frames.size, 0)
  assert.equal(env.win.count(), 0)
  env.intersectionObservers[0].emit([{ isIntersecting: true }])
  assert.equal(env.frames.size, 1)
  env.doc.hidden = true; env.doc.emit('visibilitychange')
  assert.equal(env.frames.size, 0)
  env.doc.hidden = false; env.doc.emit('visibilitychange')
  assert.equal(env.frames.size, 1)
  env.media.reduced.change(true)
  assert.equal(env.frames.size, 0)
  env.media.reduced.change(false)
  assert.equal(env.frames.size, 1)
  env.media.fine.change(false)
  assert.equal(env.frames.size, 0)
  const canvas = view.nodes().find(n => n.tag === 'canvas')!
  view.unmount()
  assert.equal(env.frames.size, 0)
  assert.equal(env.win.count() + env.doc.count() + canvas.count(), 0)
  assert.ok(Object.values(env.media).every(media => media.count() === 0))
  assert.ok([...env.resizeObservers, ...env.intersectionObservers].every(observer => observer.disconnected))
  assert.deepEqual(disposed, { geometries: 3, materials: 3 })
  assert.equal(renderer.disposals, 1)
})

test('WebGL failure and context loss render a fallback without scheduling work', async t => {
  for (const failWebGL of [true, false]) {
    await t.test(failWebGL ? 'blocked creation' : 'lost context', async t => {
      const env = environment(t, { failWebGL })
      const view = env.mount(canvasSource)
      const disposed = failWebGL ? null : env.disposalCounts()
      if (!failWebGL) view.nodes().find(n => n.tag === 'canvas')!.emit('webglcontextlost', { preventDefault() {} })
      await Vue.nextTick()
      assert.ok(view.nodes().some(n => hasClass(n, 'symbiosis-fallback')))
      assert.equal(env.frames.size, 0)
      assert.equal(env.win.count(), 0)
      env.media.reduced.change(true)
      env.doc.emit('visibilitychange')
      assert.equal(env.frames.size, 0)
      if (disposed) assert.deepEqual(disposed, { geometries: 3, materials: 3 })
    })
  }
})

test('mobile walkthrough uses explicit steps with no hidden SVG or animation loop', async t => {
  const env = environment(t, { mobile: true })
  const view = env.mount(narrativeSource)
  env.intersectionObservers[0].emit([{ isIntersecting: true }])
  await Vue.nextTick()
  assert.equal(env.frames.size, 0)
  assert.ok(!view.nodes().some(n => hasClass(n, 'paths-svg')))
  assert.ok(!view.nodes().some(n => hasClass(n, 'playback-button')))
  const steps = view.nodes().filter(n => hasClass(n, 'scrubber-tab'))
  assert.equal(steps.length, 4)
  assert.equal(steps[2].props.onPointerenter, undefined)
  steps[2].props.onClick()
  await Vue.nextTick()
  assert.equal(steps[2].props['aria-pressed'], true)
  assert.ok(view.nodes().some(n => n.text.includes('Codex and Claude review')))
  assert.equal(env.frames.size, 0)
  view.unmount()
  assert.ok(Object.values(env.media).every(media => media.count() === 0))
  assert.equal(env.doc.count(), 0)
})

test('desktop walkthrough offers explicit pause/resume and obeys visibility and live reduced motion', async t => {
  const env = environment(t)
  const view = env.mount(narrativeSource)
  const playback = () => view.nodes().find(n => hasClass(n, 'playback-button'))!
  env.intersectionObservers[0].emit([{ isIntersecting: true }])
  await Vue.nextTick()
  assert.equal(env.frames.size, 1)
  playback().props.onClick()
  await Vue.nextTick()
  assert.equal(env.frames.size, 0)
  assert.equal(playback().text, 'Play walkthrough')
  playback().props.onClick()
  await Vue.nextTick()
  assert.equal(env.frames.size, 1)
  view.nodes().filter(n => hasClass(n, 'scrubber-tab'))[3].props.onClick()
  await Vue.nextTick()
  assert.equal(env.frames.size, 0, 'manual step selection cancels scheduled work')
  assert.equal(playback().text, 'Play walkthrough')
  playback().props.onClick()
  env.doc.hidden = true; env.doc.emit('visibilitychange')
  assert.equal(env.frames.size, 0)
  env.doc.hidden = false; env.doc.emit('visibilitychange')
  assert.equal(env.frames.size, 1)
  env.intersectionObservers[0].emit([{ isIntersecting: false }])
  assert.equal(env.frames.size, 0)
  env.intersectionObservers[0].emit([{ isIntersecting: true }])
  env.media.reduced.change(true)
  await Vue.nextTick()
  assert.equal(env.frames.size, 0)
  assert.equal(playback(), undefined)
  env.media.reduced.change(false)
  await Vue.nextTick()
  assert.equal(env.frames.size, 1)
  view.unmount()
  assert.equal(env.frames.size, 0)
  assert.ok(Object.values(env.media).every(media => media.count() === 0))
})
