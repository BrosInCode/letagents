import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp, h, markRaw, ssrContextKey } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer;
let Reader: any;
let LongMessage: any;
let preference: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Reader = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/MessageReader.vue', import.meta.url)))).default;
  preference = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/message-reader.ts', import.meta.url)))).selectedReaderTextSize;
  LongMessage = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/DesktopLongMessageContent.vue')).default;
});
after(async () => { await vite?.close(); });

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
function mountReader(t: any) {
  const globals = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  let focusReturns = 0;
  class Element { isConnected = true; focus() { focusReturns++; } }
  Object.assign(globalThis, { document: { activeElement: new Element() }, HTMLElement: Element,
    window: { matchMedia: () => ({ matches: true }) } });
  let vm: any;
  let modalOpened = 0;
  let modalClosed = 0;
  let toggleFocused = 0;
  const events: string[] = [];
  const dialog = markRaw({ dataset: { textSize: 'default' }, style: { height: '', removeProperty() { this.height = ''; } },
    getBoundingClientRect: () => ({ height: 400, left: 20, right: 840, top: 20, bottom: 420 }), showModal() { modalOpened++; }, close() { modalClosed++; }, focus() {} });
  const scroll = markRaw({ scrollTop: 0 });
  preference.value = 'default';
  const app = renderer.createApp({ setup() {
    vm = Reader.setup({ text: 'Original **source**', html: '<p>Original <strong>source</strong></p>' }, { expose() {}, emit: (name: string) => events.push(name) });
    vm.dialog.value = dialog;
    vm.scroll.value = scroll;
    vm.content.value = markRaw({});
    vm.typeToggle.value = markRaw({ focus() { toggleFocused++; } });
    return () => h('div');
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  let mounted = true;
  function unmount() { if (mounted) { app.unmount(); mounted = false; } }
  t.after(() => { unmount(); preference.value = 'default'; Object.assign(globalThis, globals); });
  return { vm, dialog, scroll, events, unmount, counts: () => ({ modalOpened, modalClosed, focusReturns, toggleFocused }) };
}

test('hover previews never change the chosen size, restore scroll, and keep the controls fixed', t => {
  const { vm, dialog, scroll } = mountReader(t);
  vm.toggleOptions();
  assert.equal(dialog.style.height, '400px');
  vm.previewPointer({ pointerType: 'mouse' }, 'large');
  assert.equal(dialog.dataset.textSize, 'large');
  assert.equal(preference.value, 'default');
  scroll.scrollTop = 42; // Layout may clamp/change scroll while the font reflows.
  vm.restorePreview();
  assert.equal(dialog.dataset.textSize, 'default');
  assert.equal(scroll.scrollTop, 0);
  assert.equal(vm.preview.value, null);
  vm.previewSize('small');
  vm.closeOptions();
  assert.equal(dialog.dataset.textSize, 'default');
  assert.equal(dialog.style.height, '');
  assert.equal(vm.optionsOpen.value, false);
});

test('click commits a preview for later messages; cancelling subsequent previews retains that choice', t => {
  const { vm, dialog, counts } = mountReader(t);
  vm.toggleOptions();
  vm.previewSize('large');
  vm.commitSize('large');
  assert.equal(preference.value, 'large');
  assert.equal(dialog.dataset.textSize, 'large');
  assert.equal(vm.optionsOpen.value, false);
  assert.equal(counts().toggleFocused, 1);
  vm.toggleOptions();
  vm.previewSize('small');
  vm.cancel();
  assert.equal(dialog.dataset.textSize, 'large');
  assert.equal(preference.value, 'large');
});

test('keyboard focus previews; Escape dismisses options before reader, and closing restores its opener', t => {
  const { vm, dialog, events, unmount, counts } = mountReader(t);
  assert.equal(counts().modalOpened, 1);
  vm.toggleOptions();
  vm.previewFocus({ target: { matches: () => true } }, 'small');
  assert.equal(dialog.dataset.textSize, 'small');
  vm.cancel();
  assert.deepEqual(events, []);
  assert.equal(dialog.dataset.textSize, 'default');
  vm.cancel();
  assert.deepEqual(events, ['close']);
  unmount();
  assert.equal(counts().modalClosed, 1);
  assert.equal(counts().focusReturns, 1);
});

test('touch does not trigger a speculative preview, but choosing a size still applies it', t => {
  const { vm, dialog } = mountReader(t);
  vm.toggleOptions();
  vm.previewPointer({ pointerType: 'touch' }, 'large');
  assert.equal(vm.preview.value, null);
  assert.equal(dialog.dataset.textSize, 'default');
  vm.commitSize('large');
  assert.equal(preference.value, 'large');
});

test('copy uses original text and reports denied clipboard access instead of false success', async t => {
  const { vm } = mountReader(t);
  let copied = '';
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator'); });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text; } } } });
  await vm.copyText();
  assert.equal(copied, 'Original **source**');
  assert.equal(vm.copyStatus.value, 'Message copied');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('denied'); } } } });
  await vm.copyText();
  assert.equal(vm.copied.value, false);
  assert.match(vm.copyStatus.value, /Could not copy/);
});

test('desktop reader has sender, avatar and room context without duplicate close actions or counters', async () => {
  const OpenMessage = { ...LongMessage, setup(props: any, context: any) {
    const vm = LongMessage.setup(props, context); vm.openReader(); return vm;
  } };
  const context: any = {};
  await renderToString(createSSRApp({ render: () => h(OpenMessage, { text: 'Message body', html: '<p>Message body</p>', messageId: 'msg_1',
    roomIdentifier: 'github.com/BrosInCode/letagents', sender: { name: 'Ada', context: 'Human', avatarUrl: 'https://avatars.githubusercontent.com/u/2', timestamp: '2026-10-17T12:00:00Z' } }) }), context);
  const html = context.teleports.body;
  assert.match(html, /<dialog[^>]*message-reader/);
  assert.match(html, /Ada/);
  assert.match(html, /Human/);
  assert.match(html, /avatars.githubusercontent.com\/u\/2/);
  assert.match(html, /BrosInCode\/letagents/);
  assert.match(html, /Copy message/);
  assert.match(html, /Reading text size/);
  assert.equal((html.match(/aria-label="Close reader"/g) || []).length, 1);
  assert.doesNotMatch(html, /Copy text|>Done<|chars/);
});
