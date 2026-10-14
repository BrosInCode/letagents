import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, markRaw, nextTick, reactive } from 'vue';
import vue from '@vitejs/plugin-vue';
import { createServer, type Plugin, type ViteDevServer } from 'vite';

// Load the real SFCs through Vite, but with client templates so a host renderer can inspect the tree.
function clientTemplateVue(): Plugin {
  const inner = vue() as Plugin & Record<string, any>;
  const wrapped: Record<string, any> = { ...inner, name: 'client-template-vue' };
  for (const hook of ['load', 'transform'] as const) {
    const original = inner[hook];
    if (!original) continue;
    const handler = typeof original === 'function' ? original : original.handler;
    const call = function (this: unknown, ...args: any[]) { args[args.length - 1] = { ...(args[args.length - 1] ?? {}), ssr: false }; return handler.apply(this, args); };
    wrapped[hook] = typeof original === 'function' ? call : { ...original, handler: call };
  }
  return wrapped as Plugin;
}

type Host = { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, any> };
const noop = () => {};
const node = (tag = '', text = ''): Host => markRaw({ tag, text, children: [], parent: null, props: {}, style: {}, addEventListener: noop, removeEventListener: noop, focus: noop, blur: noop } as Host);
const body = node('body');
const renderer = createRenderer<Host, Host>({
  createElement: tag => node(tag), createText: text => node('', text), createComment: () => node('#comment'),
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; n.children = []; },
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
  insert(n, parent, anchor) { n.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; if (at < 0) parent.children.push(n); else parent.children.splice(at, 0, n); },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  querySelector: selector => (selector === 'body' ? body : null),
});
const all = (root: Host): Host[] => [root, ...root.children.flatMap(all)];
const elements = (n: Host) => n.children.filter(child => child.tag && child.tag !== '#comment');
const classOf = (n: Host) => String(n.props.class ?? '');
const flush = async () => { for (let i = 0; i < 5; i++) { await nextTick(); await new Promise(resolve => setImmediate(resolve)); } };

let vite: ViteDevServer, Composer: any, ipc: any;
const originals = { window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
before(async () => {
  ipc = { room: {} };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), { letagentsDesktop: ipc, setTimeout: () => 0, matchMedia: () => ({ matches: false }) }) });
  vite = await createServer({
    root: fileURLToPath(new URL('../..', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'silent',
    plugins: [clientTemplateVue()], resolve: { dedupe: ['vue'] }, server: { middlewareMode: true, hmr: false },
  });
  Composer = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/RoomComposer.vue')).default;
});
after(async () => {
  await vite?.close();
  if (originals.window) Object.defineProperty(globalThis, 'window', originals.window); else Reflect.deleteProperty(globalThis, 'window');
});

async function mountInputRow(t: { after: (fn: () => void) => void }, gifEnabled: boolean) {
  ipc.room.getExpressions = async () => ({ enabled: gifEnabled, gif_provider_configured: true });
  const props = reactive({ attaching: false, attachmentDrafts: [], attachmentError: null, eventPreviews: [], messageNamespace: `layout-${gifEnabled}`, participants: [], pendingAttachmentDrafts: [], permissionApprovals: [], permissionError: null, replyTo: null, resolvingPermissionIds: {}, roomIdentifier: 'room-a', roomLoading: false, sendError: null, sending: false });
  const root = node('root');
  const app = renderer.createApp({ render: () => h(Composer, props) });
  app.mount(root);
  t.after(() => app.unmount());
  await flush();
  const row = all(root).find(n => classOf(n).split(/\s+/).includes('desktop-composer-input-row'));
  assert.ok(row, 'input row rendered');
  return row;
}

function gridTrackCount(): number {
  const css = readFileSync(new URL('../src/styles/composer-agent-reasoning/composer-controls.css', import.meta.url), 'utf8');
  const rule = css.match(/\.desktop-composer-input-row\s*\{([^}]*)\}/)?.[1] ?? '';
  const columns = rule.match(/grid-template-columns:\s*([^;]+);/)?.[1] ?? '';
  return columns.replace(/minmax\([^)]*\)/g, 'track').trim().split(/\s+/).length;
}

for (const gifEnabled of [true, false]) {
  test(`room composer input row keeps one grid row with the GIF switch ${gifEnabled ? 'on' : 'off'}`, async t => {
    const row = await mountInputRow(t, gifEnabled);
    const children = elements(row);
    assert.deepEqual(children.map(child => child.props['data-testid']), ['desktop-composer-add-agent', 'desktop-composer-input', 'desktop-composer-actions']);
    assert.equal(children.length, gridTrackCount(), 'each input-row child has its own grid track');

    const actions = elements(children[2]).map(child => child.props['data-testid'] ?? classOf(child));
    assert.deepEqual(actions, gifEnabled
      ? ['desktop-composer-attach', 'room-gif-trigger', 'desktop-composer-send']
      : ['desktop-composer-attach', 'desktop-composer-send']);
  });
}

test('GIF trigger matches the attach button box and has no stray margin', () => {
  const picker = readFileSync(new URL('../src/components/desktop/content/room-chat/RoomGifPicker.vue', import.meta.url), 'utf8');
  const trigger = picker.match(/\n\.room-gif-trigger\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(trigger, /width:\s*var\(--room-gif-trigger-size,\s*30px\)/);
  assert.match(trigger, /height:\s*var\(--room-gif-trigger-size,\s*30px\)/);
  assert.match(trigger, /border-radius:\s*var\(--room-gif-trigger-radius,\s*9px\)/);
  assert.match(trigger, /color:\s*var\(--text-secondary\)/);
  assert.match(trigger, /margin:\s*0;/);
  assert.doesNotMatch(picker, /margin:\s*0 5px/);
  assert.doesNotMatch(picker, /^button, input\s*\{/m, 'dialog button rules must not leak onto the trigger');
});
