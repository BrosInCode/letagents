import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, markRaw, nextTick, reactive, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer, Preview: any, DesktopMessage: any, WebMessage: any, previewKey: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const shared = fileURLToPath(new URL('../../../../shared/ui/board/', import.meta.url));
  Preview = (await vite.ssrLoadModule(`${shared}/TaskLinkPreview.vue`)).default;
  previewKey = (await vite.ssrLoadModule(`${shared}/task-link-preview.ts`)).taskLinkPreviewKey;
  DesktopMessage = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/DesktopLongMessageContent.vue')).default;
  WebMessage = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../src/web/src/components/room/LongMessageContent.vue', import.meta.url)))).default;
});
after(async () => { await vite?.close(); });

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const proposal = () => ({ id: 'task_1', title: 'Proposed work', status: 'proposed', allowedTransitions: [{ id: 'accept', label: 'Accept', targetStatus: 'accepted' }] });
function mountPreview(t: any, accept: (id: string) => Promise<boolean> = async () => true) {
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { innerWidth: 600, innerHeight: 700, addEventListener() {}, removeEventListener() {} } });
  const props = reactive({ roomId: 'room-a', tasks: [proposal()], active: true, accept, openExternal: async () => {} });
  const events: unknown[][] = [];
  let vm: any, shown = 0, hidden = 0, focused = 0;
  const anchor = markRaw({ isConnected: true, closest: () => null, getBoundingClientRect: () => ({ left: 500, top: 500, bottom: 520 }), focus() { focused++; } });
  const app = renderer.createApp({ setup() {
    vm = Preview.setup(props, { expose() {}, emit: (...args: unknown[]) => events.push(args) });
    vm.panel.value = markRaw({ isConnected: true, showPopover() { shown++; }, hidePopover() { hidden++; } });
    vm.closeButton.value = markRaw({ focus() {} });
    return () => h('div');
  } });
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({});
  t.after(() => { app.unmount(); Object.assign(globalThis, { window: previousWindow }); });
  return { vm, props, events, anchor, counts: () => ({ shown, hidden, focused }) };
}

test('preview fences duplicate accepts and permits retry after a failed request', async t => {
  let settle!: (result: boolean) => void, calls = 0;
  const { vm, anchor } = mountPreview(t, () => { calls++; return new Promise(resolve => { settle = resolve; }); });
  await vm.show('task_1', anchor, false);
  const first = vm.acceptTask();
  await vm.acceptTask();
  assert.equal(calls, 1);
  assert.equal(vm.busy.value, true);
  settle(false); await first;
  assert.match(vm.error.value, /could not be accepted/);
  assert.equal(vm.canAccept.value, true);
  const retry = vm.acceptTask(); settle(true); await retry;
  assert.equal(calls, 2);
  assert.equal(vm.notice.value, 'Task accepted.');
  assert.equal(vm.canAccept.value, false, 'do not allow a second accept while waiting for refreshed host data');
});

test('room change closes preview and ignores an old-room acceptance result', async t => {
  let settle!: (result: boolean) => void;
  const { vm, props, anchor, counts } = mountPreview(t, () => new Promise(resolve => { settle = resolve; }));
  await vm.show('task_1', anchor, false);
  const pending = vm.acceptTask();
  props.roomId = 'room-b'; await nextTick();
  assert.equal(vm.open.value, false);
  assert.equal(vm.selectedId.value, null);
  assert.equal(vm.busy.value, false);
  settle(true); await pending;
  assert.equal(vm.notice.value, '');
  assert.equal(vm.error.value, '');
  assert.ok(counts().hidden > 0);
});

test('accept requires a live proposal and host permission; missing tasks keep only board navigation', async t => {
  let calls = 0;
  const { vm, props, anchor, events } = mountPreview(t, async () => { calls++; return true; });
  await vm.show('task_1', anchor, true);
  props.tasks[0].allowedTransitions = [];
  assert.equal(vm.canAccept.value, false);
  await vm.acceptTask();
  props.tasks = [{ ...proposal(), status: 'accepted' }];
  await vm.acceptTask();
  assert.equal(calls, 0);
  await vm.show('task_999', anchor, false);
  assert.equal(vm.task.value, undefined);
  await vm.acceptTask(); vm.openBoard();
  assert.deepEqual(events, [['openBoard', 'task_999']]);
});

test('reader navigation is deferred, keyboard dismissal returns focus, and inactive views cannot open previews', async t => {
  const { vm, props, anchor, counts, events } = mountPreview(t);
  let readerClosed = 0;
  const dialog = markRaw({}); anchor.closest = () => dialog;
  await vm.show('task_1', anchor, true, () => { readerClosed++; });
  assert.equal(vm.portalTarget.value, dialog);
  assert.equal(vm.instant.value, true);
  assert.equal(readerClosed, 0);
  vm.close(true);
  assert.equal(counts().focused, 1);
  assert.equal(readerClosed, 0);
  await vm.show('task_1', anchor, false, () => { readerClosed++; }); vm.openBoard();
  assert.equal(readerClosed, 1);
  assert.deepEqual(events, [['openBoard', 'task_1']]);
  props.active = false; await nextTick();
  const shown = counts().shown;
  await vm.show('task_1', anchor, false);
  assert.equal(counts().shown, shown);
});

for (const platform of ['desktop', 'web']) {
  test(`${platform} task-link preview leaves reader open until full-board navigation; fallback still works`, t => {
    const previous = { Element: globalThis.Element, window: globalThis.window };
    class Element { dataset = { taskReferenceId: 'task_1' }; closest(selector: string) { return selector === '[data-task-reference-id]' ? this : null; } }
    Object.assign(globalThis, { Element, window: { getSelection: () => ({ toString: () => '' }) } });
    const Component = platform === 'desktop' ? DesktopMessage : WebMessage;
    const calls: any[][] = [], events: any[][] = [];
    let vm: any;
    const makeApp = (provided: boolean) => {
      const app = renderer.createApp({ setup() { vm = Component.setup({ text: 'task_1', html: '', messageId: 'msg_1' }, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div'); } });
      if (provided) app.provide(previewKey, (...args: any[]) => calls.push(args));
      app.provide(ssrContextKey, { modules: new Set() }); app.mount({}); return app;
    };
    const anchor = new Element(), event = { target: anchor, detail: 0, preventDefault() {}, stopPropagation() {} };
    const app = makeApp(true); vm.openReader(); vm.handleInlineReferenceClick(event);
    assert.equal(vm.readerOpen.value, true);
    assert.equal(calls[0][0], 'task_1'); assert.equal(calls[0][1], anchor); assert.equal(calls[0][2], true);
    assert.deepEqual(events, []); calls[0][3](); assert.equal(vm.readerOpen.value, false); app.unmount();
    const fallback = makeApp(false); vm.openReader(); vm.handleInlineReferenceClick(event);
    assert.equal(vm.readerOpen.value, false); assert.equal(events.at(-1)?.[1], 'task_1'); fallback.unmount();
    t.after(() => Object.assign(globalThis, previous));
  });
}
