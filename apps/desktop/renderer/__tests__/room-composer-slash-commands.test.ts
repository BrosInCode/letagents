import '../../../../shared/slash-commands.test.mjs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, nextTick, reactive, ref, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer, Composer: any, searchModule: any, ipc: any, toasts: any;
const originals = { window: globalThis.window };
before(async () => {
  ipc = { room: {} };
  Object.assign(globalThis, { window: Object.assign(new EventTarget(), { letagentsDesktop: ipc, setTimeout: () => 0 }) });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Composer = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/RoomComposer.vue')).default;
  searchModule = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-shell/useDesktopRoomSearch.ts');
  toasts = (await vite.ssrLoadModule('/renderer/src/composables/useDesktopActionToasts.ts')).useDesktopActionToasts();
});
after(async () => { await vite?.close(); Object.assign(globalThis, originals); });
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
let sequence = 0;
const key = (name: string, extra = {}) => ({ key: name, preventDefault() {}, isComposing: false, ...extra });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
function mount(t: { after: (fn: () => void) => void }) {
  const events: any[] = [], tasks: any[] = [];
  const props = reactive({ attaching: false, attachmentDrafts: [] as any[], attachmentError: null, eventPreviews: [], messageNamespace: `slash-${++sequence}`, participants: [], pendingAttachmentDrafts: [] as any[], permissionApprovals: [], permissionError: null, replyTo: null as any, resolvingPermissionIds: {}, roomIdentifier: 'room-a', roomLoading: false, sendError: null, sending: false });
  let vm: any, search: any;
  const originalAddTask = ipc.room.addTask;
  ipc.room.addTask = async (...args: any[]) => { tasks.push(args); return { task: { id: 'task_1' } }; };
  const child = { setup() { vm = Composer.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div'); } };
  const app = renderer.createApp({ setup() { search = searchModule.useDesktopRoomSearch(ref([{ id: 'msg_1', sender: 'Ada', text: 'release notes', attachments: [] }])); return () => h(child); } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  t.after(() => { app.unmount(); ipc.room.addTask = originalAddTask; });
  return { vm, props, events, tasks, search, stop: () => app.unmount() };
}

test('desktop actual submit path creates tasks, searches through the scoped composable, and opens Add agent without sending', async t => {
  const { vm, tasks, events, search } = mount(t);
  vm.draft.value = '/task Prepare release';
  await vm.submitMessage();
  assert.deepEqual(tasks, [['room-a', { title: 'Prepare release', description: null }]]);
  assert.equal(vm.draft.value, '');
  assert.equal(toasts.actionToasts.value.at(-1).message, 'Task created');
  vm.draft.value = '/search release notes';
  vm.handleComposerKey(key('Enter'));
  await flush();
  assert.equal(search.searchOpen.value, true);
  assert.equal(search.searchQuery.value, 'release notes');
  assert.equal(search.activeSearchMessageId.value, 'msg_1');
  vm.draft.value = '/agent';
  await vm.submitMessage();
  assert.deepEqual(events, [['open-add-agent']]);
});

test('desktop one suggestion model supports arrows, partial Enter, Tab, hints and Escape-to-send', async t => {
  const { vm, events, tasks } = mount(t);
  vm.draft.value = '/';
  assert.equal(vm.suggestionsOpen.value, true);
  assert.deepEqual(vm.suggestions.value.map((item: any) => item.key), ['slash-task', 'slash-search', 'slash-agent']);
  vm.handleComposerKey(key('ArrowUp'));
  assert.equal(vm.suggestionIndex.value, 2);
  vm.handleComposerKey(key('Tab'));
  assert.equal(vm.draft.value, '/agent');
  vm.draft.value = '/t';
  vm.handleComposerKey(key('Enter'));
  await flush();
  assert.equal(vm.draft.value, '/task ');
  assert.equal(vm.slash.hint.value, 'Add a task title');
  await vm.submitMessage();
  assert.deepEqual(tasks, []);
  assert.deepEqual(events, []);
  vm.handleComposerKey(key('Escape'));
  assert.equal(vm.suggestionsOpen.value, false);
  await vm.submitMessage();
  assert.equal(events[0][0], 'send-message');
  assert.equal(events[0][1], '/task');
  vm.draft.value = '/agent extra';
  await vm.submitMessage();
  assert.equal(vm.slash.hint.value, '/agent does not take arguments');
  assert.equal(events.length, 1);
});

test('desktop unknown text, newline, pending/staged attachments and replies keep the normal send path', async t => {
  const { vm, props, events, tasks } = mount(t);
  for (const scenario of ['unknown', 'newline', 'pending', 'staged', 'reply']) {
    props.pendingAttachmentDrafts = scenario === 'pending' ? [{}] : [];
    props.attachmentDrafts = scenario === 'staged' ? [{ uploadId: 'upload_1' }] : [];
    props.replyTo = scenario === 'reply' ? { id: 'msg_1', sender: 'Ada', text: 'hi' } : null;
    vm.draft.value = scenario === 'unknown' ? '/usr/bin' : scenario === 'newline' ? '/task Title\nmore' : '/task Title';
    assert.equal(vm.slash.open.value, false);
    await vm.submitMessage();
    assert.equal(events.at(-1)[0], 'send-message', scenario);
  }
  assert.equal(events.length, 5);
  assert.deepEqual(tasks, []);
});

test('desktop task failures keep the draft and in-flight requests cannot repeat or clear later edits', async t => {
  const { vm, props, events } = mount(t);
  ipc.room.addTask = async () => { throw new Error('refused'); };
  vm.draft.value = '/task Keep me';
  await vm.submitMessage();
  assert.equal(vm.draft.value, '/task Keep me');
  assert.equal(toasts.actionToasts.value.at(-1).state, 'error');
  let finish!: (value: any) => void, calls = 0;
  ipc.room.addTask = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = vm.submitMessage();
  await vm.submitMessage();
  assert.equal(calls, 1);
  vm.draft.value = 'New draft';
  finish({ task: { id: 'task_2' } });
  await pending;
  assert.equal(vm.draft.value, 'New draft');
  vm.draft.value = '/task Another';
  const switched = vm.submitMessage();
  props.roomIdentifier = 'room-b';
  props.messageNamespace = 'room-b';
  await nextTick();
  vm.draft.value = 'Other room draft';
  finish({ task: { id: 'task_3' } });
  await switched;
  assert.equal(vm.draft.value, 'Other room draft');
  assert.deepEqual(events, []);
});

test('desktop IME and modified Enter do not execute commands', async t => {
  const { vm, events, tasks } = mount(t);
  vm.draft.value = '/task Title';
  vm.handleComposerKey(key('Enter', { isComposing: true }));
  vm.handleComposerKey(key('Enter', { shiftKey: true }));
  await flush();
  assert.equal(vm.draft.value, '/task Title\n');
  assert.deepEqual(tasks, []);
  assert.deepEqual(events, []);
});

test('desktop keeps mention selection working in the same popup', async t => {
  const { vm, events } = mount(t);
  vm.draft.value = '@every';
  vm.handleDraftInput();
  assert.equal(vm.slash.open.value, false);
  assert.equal(vm.suggestionsOpen.value, true);
  vm.selectSuggestion(0);
  await flush();
  assert.equal(vm.draft.value, '@everyone ');
  assert.deepEqual(events, []);
});

test('disposing the desktop composer prevents a late task response from clearing its saved draft', async t => {
  const { vm, stop } = mount(t);
  let finish!: (value: any) => void;
  ipc.room.addTask = () => new Promise(resolve => { finish = resolve; });
  vm.draft.value = '/task Pending';
  const pending = vm.submitMessage();
  stop();
  vm.draft.value = 'Saved draft after leaving';
  finish({ task: { id: 'task_1' } });
  await pending;
  assert.equal(vm.draft.value, 'Saved draft after leaving');
});

test('S1 desktop equal-value attachment refresh keeps Escape dismissal and selection', t => {
  const { vm, props } = mount(t);
  vm.draft.value = '/';
  vm.handleComposerKey(key('ArrowDown'));
  props.attachmentDrafts = [];
  assert.equal(vm.slash.activeIndex.value, 1);
  vm.handleComposerKey(key('Escape'));
  props.pendingAttachmentDrafts = [];
  assert.equal(vm.slash.open.value, false);
});

test('S1 desktop successful task clears its unchanged draft after an equal-value refresh', async t => {
  const { vm, props } = mount(t);
  let finish!: (value: any) => void;
  ipc.room.addTask = () => new Promise(resolve => { finish = resolve; });
  vm.draft.value = '/task Once';
  const pending = vm.submitMessage();
  props.attachmentDrafts = [];
  finish({ task: { id: 'task_1' } });
  await pending;
  assert.equal(vm.draft.value, '');
});

test('S2 desktop real input handler never reports local command typing and stops an ordinary typing signal', async t => {
  const typing = await vite.ssrLoadModule('/renderer/src/composables/useRoomTyping.ts');
  const reports: any[] = [];
  ipc.room.reportTyping = (_room: string, input: any) => { reports.push(input.typing); };
  typing.setTypingAccount('account-test');
  const { vm } = mount(t);
  t.after(() => { typing.setTypingAccount(null); delete ipc.room.reportTyping; });
  for (const text of ['/', '/ta', '/task Title', '/search fox', '/agent']) {
    vm.draft.value = text;
    vm.handleDraftInput();
  }
  assert.deepEqual(reports, []);
  vm.draft.value = '/usr/bin';
  vm.handleDraftInput();
  assert.deepEqual(reports, [true]);
  vm.draft.value = '/task Title';
  vm.handleDraftInput();
  assert.deepEqual(reports, [true, false]);
  for (const action of ['empty', 'send']) {
    const { vm: ordinary, events } = mount(t);
    const before = reports.length;
    ordinary.draft.value = 'Ordinary draft';
    await nextTick();
    assert.equal(reports.length, before, 'programmatic changes do not report typing');
    ordinary.handleDraftInput();
    assert.deepEqual(reports.slice(before), [true]);
    if (action === 'empty') {
      ordinary.draft.value = '';
      await nextTick();
    } else {
      await ordinary.submitMessage();
      assert.equal(events.at(-1)[0], 'send-message');
      events.at(-1)[4](true);
    }
    assert.deepEqual(reports.slice(before), [true, false], action);
  }
});
