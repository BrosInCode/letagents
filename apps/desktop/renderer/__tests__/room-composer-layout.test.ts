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

async function mountInputRow(t: { after: (fn: () => void) => void }, gifEnabled: boolean, provides: Array<[unknown, unknown]> = []) {
  ipc.room.getExpressions = async () => ({ enabled: gifEnabled, gif_provider_configured: true });
  const props = reactive({ attaching: false, attachmentDrafts: [], attachmentError: null, eventPreviews: [], messageNamespace: `layout-${gifEnabled}`, participants: [], pendingAttachmentDrafts: [], replyTo: null, roomIdentifier: 'room-a', roomLoading: false, sendError: null, sending: false });
  const root = node('root');
  const app = renderer.createApp({ render: () => h(Composer, props) });
  for (const [key, value] of provides) app.provide(key as any, value);
  app.mount(root);
  t.after(() => app.unmount());
  await flush();
  const row = all(root).find(n => classOf(n).split(/\s+/).includes('desktop-composer-input-row'));
  assert.ok(row, 'input row rendered');
  return row;
}

function gridAreas(): string[] {
  const css = readFileSync(new URL('../src/styles/composer-agent-reasoning/composer-controls.css', import.meta.url), 'utf8');
  const rule = css.match(/\.desktop-composer-input-row\s*\{([^}]*)\}/)?.[1] ?? '';
  return (rule.match(/grid-template-areas:([^;]+);/)?.[1] ?? '').match(/"[^"]*"/g)?.map(row => row.slice(1, -1).trim()) ?? [];
}

for (const gifEnabled of [true, false]) {
  test(`room composer bar holds only "+", the input and send with the GIF switch ${gifEnabled ? 'on' : 'off'}`, async t => {
    const row = await mountInputRow(t, gifEnabled);
    const children = elements(row);
    assert.deepEqual(children.map(child => child.props['data-testid'] ?? classOf(child)), ['desktop-composer-add-agent', 'desktop-composer-field', 'desktop-composer-send']);
    assert.deepEqual(gridAreas(), ['field field field', 'add under send'], 'the input spans the top; "+", access and send share the bar under it');
    const field = elements(children[1]).map(child => child.props['data-testid']);
    assert.deepEqual(field, ['desktop-composer-input']);
    assert.equal(all(row).some(n => classOf(n).includes('room-gif-trigger') || n.props['data-testid'] === 'desktop-composer-attach'), false,
      'GIF and attach live in the "+" menu');
  });
}

test('the suggested reply is faint text under the input, described to screen readers, with no label or key chip', async t => {
  const { composerSuggestedReplyKey } = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/composer-suggested-reply.ts');
  const row = await mountInputRow(t, false, [[composerSuggestedReplyKey, () => ({ recordId: 'layout-ghost', from: 'Ada', text: 'Ship it now.' })]]);
  const field = elements(row)[1];
  const [ghost, input, description] = elements(field);
  assert.equal(ghost.props['data-testid'], 'desktop-composer-suggestion');
  assert.equal(ghost.props['aria-hidden'], 'true');
  assert.equal(all(ghost).map(n => n.text).join(''), 'Ship it now.');
  assert.equal(elements(ghost).length, 0, 'no label, no Tab chip');
  assert.equal(input.props.placeholder, undefined, 'the placeholder gives way to the suggestion');
  assert.equal(input.props['aria-describedby'], description.props.id);
  assert.match(all(description).map(n => n.text).join(''), /^Suggested reply to Ada: Ship it now\. Press Tab to use it, or Escape to dismiss it\.$/);
});

test('"+" and send are the same round size in the bar under the input', () => {
  const css = readFileSync(new URL('../src/styles/composer-agent-reasoning/composer-controls.css', import.meta.url), 'utf8');
  const agent = readFileSync(new URL('../src/styles/agent-management.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-columns:\s*32px minmax\(0, 1fr\) 32px;/);
  const send = css.match(/\n\.desktop-composer-send\s*\{([^}]*)\}/)?.[1] ?? '';
  const plus = agent.match(/\n\.desktop-composer-add-agent\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const rule of [send, plus]) {
    assert.match(rule, /width:\s*32px;/);
    assert.match(rule, /height:\s*32px;/);
    assert.match(rule, /border-radius:\s*50%;/);
  }
});

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
