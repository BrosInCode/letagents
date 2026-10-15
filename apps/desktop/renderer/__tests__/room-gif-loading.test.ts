import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { roomGifPageUrl } from '../../../../shared/room-expressions.mjs';

type Host = { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, any> };
const node = (tag = '', text = ''): Host => Vue.markRaw({ tag, text, children: [], parent: null, props: {} });
const renderer = Vue.createRenderer<Host, Host>({
  createElement: tag => node(tag), createText: text => node('', text), createComment: () => node(),
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; n.children = []; },
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
  insert(n, parent, anchor) { n.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; if (at < 0) parent.children.push(n); else parent.children.splice(at, 0, n); },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
});
const all = (root: Host): Host[] => [root, ...root.children.flatMap(all)];
const text = (root: Host) => all(root).map(n => n.text).join(' ');
const image = (root: Host) => all(root).find(n => n.props.class?.includes('room-gif-media'))!;
const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await Vue.nextTick(); } };
const item = { provider: 'giphy', id: 'first', title: 'A celebration', image_url: 'https://media.giphy.com/first.gif', still_url: 'https://media.giphy.com/first-still.gif' };

async function mount(resolveGif: (...args: any[]) => Promise<any>, reducedMotion = false) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: reducedMotion }) } });
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(private callback: (entries: any[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  } });
  const path = new URL('../src/components/desktop/content/room-chat/RoomGif.vue', import.meta.url);
  const compiled = compileScript(parse(await readFile(path, 'utf8'), { filename: path.pathname }).descriptor, { id: 'gif-loading-test', inlineTemplate: true });
  const modules: Record<string, any> = {
    vue: Vue,
    '../../../../../../../../shared/room-expressions.mjs': { roomGifPageUrl },
    '../../../../../../../../shared/ui/assets/powered-by-giphy.png': { default: 'attribution.png' },
    '../../../../ipc/index': { desktopIpc: { room: { resolveGif } } },
  };
  const js = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?/g, (_all, names: string, name: string) => {
      assert.ok(modules[name], `unexpected dependency ${name}`);
      return `const {${names.replace(/\s+as\s+/g, ': ')}} = modules[${JSON.stringify(name)}];`;
    }).replace(/import\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, (_all, binding: string, name: string) => {
      assert.ok(modules[name], `unexpected dependency ${name}`);
      return `const ${binding} = modules[${JSON.stringify(name)}].default;`;
    }).replace('export default', 'return');
  const component = Function('modules', js)(modules);
  const props = Vue.reactive({ roomIdentifier: 'room-a', gif: { provider: 'giphy', id: 'first', title: 'A celebration' } });
  const states: string[] = [];
  const root = node();
  const app = renderer.createApp({ render: () => Vue.h(component, { ...props, onState: (state: string) => states.push(state) }) });
  app.mount(root);
  return { root, props, states, close() {
    app.unmount();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousObserver) Object.defineProperty(globalThis, 'IntersectionObserver', previousObserver); else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  } };
}

test('slow metadata and media keep a loading frame until the image actually loads', async () => {
  let resolve!: (result: any) => void;
  const view = await mount(() => new Promise(done => { resolve = done; }));
  try {
    assert.equal(view.states.at(-1), 'loading');
    assert.ok(all(view.root).some(n => n.props.class === 'room-gif-placeholder'));
    assert.doesNotMatch(text(view.root), /A celebration|unavailable/);
    resolve({ ok: true, items: [item] }); await flush();
    const img = image(view.root);
    assert.equal(img.props['aria-hidden'], true);
    assert.equal(view.states.at(-1), 'loading');
    img.props.onLoad({ target: img }); await flush();
    assert.equal(view.states.at(-1), 'ready');
    assert.equal(img.props['aria-hidden'], false);
    assert.doesNotMatch(text(view.root), /Loading GIF|unavailable/);
  } finally { view.close(); }
});

test('actual provider or image failures expose the unavailable fallback', async () => {
  for (const failMetadata of [true, false]) {
    const view = await mount(async () => failMetadata ? { ok: false } : { ok: true, items: [item] });
    try {
      await flush();
      if (!failMetadata) { const img = image(view.root); img.props.onError({ target: img }); await flush(); }
      assert.equal(view.states.at(-1), 'unavailable');
      assert.match(text(view.root), /A celebration · Preview unavailable/);
      assert.doesNotMatch(text(view.root), /Loading GIF/);
    } finally { view.close(); }
  }
});

test('stalled metadata ends the loading frame and ignores a late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (result: any) => void;
  const view = await mount(() => new Promise(done => { resolve = done; }));
  try {
    t.mock.timers.tick(14_999); await flush();
    assert.equal(view.states.at(-1), 'loading');
    t.mock.timers.tick(1); await flush();
    assert.equal(view.states.at(-1), 'unavailable');
    assert.match(text(view.root), /Preview unavailable/);
    assert.ok(all(view.root).some(n => n.tag === 'a'), 'the provider link remains usable');
    resolve({ ok: true, items: [item] }); await flush();
    assert.equal(view.states.at(-1), 'unavailable');
    assert.equal(image(view.root), undefined);
  } finally { view.close(); }
});

test('stalled media ends gracefully while a later GIF gets its own loading deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const view = await mount(async (_room, id) => { calls++; return { ok: true, items: [{ ...item, id, image_url: `https://media.giphy.com/${id}.gif` }] }; });
  try {
    await flush(); const stalled = image(view.root);
    t.mock.timers.tick(15_000); await flush();
    assert.equal(view.states.at(-1), 'unavailable');
    stalled.props.onLoad({ target: stalled }); await flush();
    assert.equal(view.states.at(-1), 'unavailable', 'a late old image cannot revive the expired preview');
    view.props.gif.id = 'second'; await flush();
    assert.equal(view.states.at(-1), 'loading');
    t.mock.timers.tick(14_999); await flush();
    const current = image(view.root); current.props.onLoad({ target: current }); await flush();
    assert.equal(view.states.at(-1), 'ready');
    t.mock.timers.tick(15_000); await flush();
    assert.equal(view.states.at(-1), 'ready', 'successful loading cancels the deadline');
    assert.equal(calls, 2, 'timeouts do not automatically retry provider calls');
  } finally { view.close(); }
});

test('changing GIF ignores an old image event and an old metadata response', async () => {
  const pending = new Map<string, (result: any) => void>();
  const view = await mount((_room, id) => new Promise(resolve => pending.set(id, resolve)));
  try {
    view.props.gif.id = 'second'; await flush();
    pending.get('first')!({ ok: false }); await flush();
    assert.equal(view.states.at(-1), 'loading');
    pending.get('second')!({ ok: true, items: [{ ...item, id: 'second' }] }); await flush();
    const oldImage = image(view.root);
    view.props.gif.id = 'third'; await flush();
    oldImage.props.onError({ target: oldImage }); await flush();
    assert.equal(view.states.at(-1), 'loading');
    pending.get('third')!({ ok: true, items: [{ ...item, id: 'third', image_url: 'https://media.giphy.com/third.gif' }] }); await flush();
    const current = image(view.root); current.props.onLoad({ target: current }); await flush();
    assert.equal(view.states.at(-1), 'ready');
  } finally { view.close(); }
});

test('reduced motion starts with a still image and playback changes keep the current image visible', async () => {
  const view = await mount(async () => ({ ok: true, items: [item] }), true);
  try {
    await flush(); const still = image(view.root);
    assert.equal(still.props.src, item.still_url);
    still.props.onLoad({ target: still }); await flush();
    all(view.root).find(n => n.tag === 'button')!.props.onClick(); await flush();
    assert.equal(image(view.root).props.src, item.image_url);
    assert.equal(image(view.root), still, 'preserve the image element through playback changes');
    assert.equal(view.states.at(-1), 'ready');
    const playing = image(view.root); playing.props.onLoad({ target: playing }); await flush();
    assert.equal(view.states.at(-1), 'ready');
  } finally { view.close(); }
});

test('replacing a GIF object with the same identity does not refetch or reset its visible state', async () => {
  for (const fails of [false, true]) {
    let calls = 0;
    const view = await mount(async () => { calls++; return fails ? { ok: false } : { ok: true, items: [item] }; });
    try {
      await flush();
      if (!fails) { const img = image(view.root); img.props.onLoad({ target: img }); await flush(); }
      const previousState = view.states.at(-1);
      view.props.gif = { ...view.props.gif }; await flush();
      assert.equal(calls, 1);
      assert.equal(view.states.at(-1), previousState);
      if (fails) assert.match(text(view.root), /Preview unavailable/);
      else assert.equal(image(view.root).props['aria-hidden'], false);
    } finally { view.close(); }
  }
});
