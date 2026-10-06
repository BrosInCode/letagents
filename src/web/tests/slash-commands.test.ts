import '../../../shared/slash-commands.test.mjs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp, h, nextTick, reactive, ssrContextKey } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer, Composer: any, Header: any, Panel: any, toasts: any;
const originals = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
before(async () => {
  Object.assign(globalThis, { window: new EventTarget(), document: new EventTarget(), localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Composer = (await vite.ssrLoadModule('/src/components/room/Composer.vue')).default;
  Header = (await vite.ssrLoadModule('/src/components/room/RoomHeader.vue')).default;
  Panel = (await vite.ssrLoadModule('/src/components/room/composer/MentionPanel.vue')).default;
  toasts = (await vite.ssrLoadModule('/src/composables/useToast.ts')).useToast();
});
after(async () => { await vite?.close(); Object.assign(globalThis, originals); });
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const key = (name: string, extra = {}) => ({ key: name, preventDefault() {}, isComposing: false, ...extra });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
function mount(t: { after: (fn: () => void) => void }) {
  const events: any[] = [], tasks: string[] = [], sent: any[] = [], searches: string[] = [];
  let vm: any, header: any;
  const headerProps = reactive({ title: 'Room', subtitle: '', activeTab: 'chat', connectionState: 'live', searchQuery: '', matchCount: 0 });
  const props = reactive({ senderName: 'Ada', roomIdentifier: 'room-a', isSignedIn: true, disabled: false, attachmentsEnabled: true, replyTo: null as any, messages: [], presence: [], presenceReady: true, participants: [],
    openSearch: (query: string) => { searches.push(query); return header.openSearch(); },
    createTask: async (title: string) => { tasks.push(title); return true; },
    submitMessage: async (...args: any[]) => { sent.push(args); return true; },
  });
  const app = renderer.createApp({ setup() {
    header = Header.setup(headerProps, { expose() {}, emit() {} });
    vm = Composer.setup(props, { expose() {}, emit: (...args: any[]) => { events.push(args); } });
    return () => h('div');
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  t.after(() => app.unmount());
  return { vm, props, events, tasks, sent, header, headerProps, searches };
}

test('web actual send handler creates a task and opens existing search without calling room send', async t => {
  const { vm, tasks, sent, searches, header } = mount(t);
  vm.text.value = '/task Prepare release';
  await vm.handleSend();
  assert.deepEqual(tasks, ['Prepare release']);
  assert.equal(vm.text.value, '');
  assert.equal(toasts.toasts.value.at(-1).type, 'success');
  vm.text.value = '/search release notes';
  vm.handleKeyDown(key('Enter'));
  await flush();
  assert.deepEqual(searches, ['release notes']);
  assert.equal(header.searchActive.value, true);
  assert.deepEqual(sent, []);
});

test('web reuses the mention panel with accessible command options, hints and keyboard selection', async t => {
  const { vm, sent, tasks } = mount(t);
  vm.text.value = '/';
  assert.deepEqual(vm.suggestions.value.map((item: any) => item.key), ['slash-task', 'slash-search']);
  vm.handleKeyDown(key('ArrowDown'));
  assert.equal(vm.suggestionIndex.value, 1);
  vm.handleKeyDown(key('Tab'));
  assert.equal(vm.text.value, '/search ');
  const html = await renderToString(createSSRApp({ render: () => h(Panel, { candidates: vm.suggestions.value, activeIndex: vm.suggestionIndex.value, hint: vm.slash.hint.value, ariaLabel: 'Command suggestions' }) }));
  assert.match(html, /role="listbox" aria-label="Command suggestions"/);
  assert.match(html, /id="composer-mention-option-slash-search"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /role="status"[^>]*>Add a search query/);
  await vm.handleSend();
  assert.deepEqual(sent, []);
  assert.deepEqual(tasks, []);
  vm.text.value = '/t';
  vm.handleKeyDown(key('Enter'));
  await flush();
  assert.equal(vm.text.value, '/task ');
  vm.handleKeyDown(key('Escape'));
  assert.equal(vm.suggestionsOpen.value, false);
  await vm.handleSend();
  assert.equal(sent[0][0], '/task');
});

test('web unknown slash text, desktop-only agent, multiline, attachments and replies remain ordinary messages', async t => {
  const { vm, props, sent, tasks } = mount(t);
  for (const text of ['/usr/bin', '/agent', '/task Title\nmore', ' /task Title']) {
    vm.text.value = text;
    await vm.handleSend();
    assert.equal(sent.at(-1)[0], text.trim());
  }
  props.replyTo = { id: 'msg_1', sender: 'Ada', text: 'reply' };
  vm.text.value = '/task Reply';
  await vm.handleSend();
  assert.equal(sent.at(-1)[0], '/task Reply');
  assert.equal(sent.at(-1)[2], 'msg_1');
  props.replyTo = null;
  vm.attachmentDrafts.value = [{ id: 'a', uploadState: 'uploading' }];
  vm.text.value = '/task Upload';
  assert.equal(vm.slash.open.value, false);
  await vm.handleSend();
  assert.equal(sent.length, 5, 'uploading attachments retain the ordinary send guard');
  vm.attachmentDrafts.value = [{ id: 'a', uploadState: 'uploaded', uploadId: 'upload_1', name: 'note.txt', type: 'file' }];
  await vm.handleSend();
  assert.equal(sent.at(-1)[0], '/task Upload');
  assert.deepEqual(tasks, []);
});

test('web failed task creation keeps text; repeated submit and late success cannot erase edits or a room switch', async t => {
  const { vm, props, sent } = mount(t);
  props.createTask = async () => false;
  vm.text.value = '/task Keep me';
  await vm.handleSend();
  assert.equal(vm.text.value, '/task Keep me');
  assert.equal(toasts.toasts.value.at(-1).type, 'error');
  let finish!: (success: boolean) => void, calls = 0;
  props.createTask = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = vm.handleSend();
  await vm.handleSend();
  assert.equal(calls, 1);
  vm.text.value = 'Edited draft';
  finish(true);
  await pending;
  assert.equal(vm.text.value, 'Edited draft');
  vm.text.value = '/task Switch';
  const switched = vm.handleSend();
  props.roomIdentifier = 'room-b';
  vm.text.value = 'Other room draft';
  finish(true);
  await switched;
  assert.equal(vm.text.value, 'Other room draft');
  assert.deepEqual(sent, []);
});

test('web IME, Shift+Enter and disabled composer never execute commands', async t => {
  const { vm, props, tasks, sent } = mount(t);
  vm.text.value = '/task Title';
  vm.handleKeyDown(key('Enter', { isComposing: true }));
  vm.handleKeyDown(key('Enter', { shiftKey: true }));
  props.disabled = true;
  await vm.handleSend();
  await flush();
  assert.deepEqual(tasks, []);
  assert.deepEqual(sent, []);
});

test('web keeps ordinary mention completion in the shared popup', async t => {
  const { vm, props, sent } = mount(t);
  props.participants = [{ kind: 'human', display_name: 'Bob' }] as any;
  vm.textareaEl.value = { selectionStart: 3, focus() {}, setSelectionRange() {}, style: {} };
  vm.text.value = '@Bo';
  vm.syncMentionContext();
  assert.equal(vm.slash.open.value, false);
  assert.equal(vm.suggestionsOpen.value, true);
  vm.selectSuggestion(vm.suggestions.value[0]);
  await flush();
  assert.equal(vm.text.value, '@Bob ');
  assert.deepEqual(sent, []);
});

test('S1 web equal-value attachment refresh keeps Escape dismissal and selection', t => {
  const { vm } = mount(t);
  vm.text.value = '/';
  vm.handleKeyDown(key('ArrowDown'));
  vm.attachmentDrafts.value = [];
  assert.equal(vm.slash.activeIndex.value, 1);
  vm.handleKeyDown(key('Escape'));
  vm.attachmentDrafts.value = [];
  assert.equal(vm.slash.open.value, false);
});

test('S1 web successful task clears its unchanged draft after an equal-value refresh', async t => {
  const { vm, props } = mount(t);
  let finish!: (value: boolean) => void;
  props.createTask = () => new Promise(resolve => { finish = resolve; });
  vm.text.value = '/task Once';
  const pending = vm.handleSend();
  vm.attachmentDrafts.value = [];
  finish(true);
  await pending;
  assert.equal(vm.text.value, '');
});

test('S2 web real input handler never posts local command typing and stops an ordinary typing signal', async t => {
  const originalFetch = globalThis.fetch;
  const reports: boolean[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === '/auth/session') return new Response(JSON.stringify({ authenticated: true, account: { id: 'test-account' } }));
    assert.match(String(url), /\/typing$/);
    reports.push(JSON.parse(String(init?.body)).typing);
    return new Response('{}');
  };
  const auth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth();
  await auth.checkSession();
  const { vm } = mount(t);
  t.after(async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ authenticated: false }));
    await auth.checkSession();
    globalThis.fetch = originalFetch;
  });
  for (const text of ['/', '/ta', '/task Title', '/search fox']) {
    vm.text.value = text;
    vm.handleTypingInput();
  }
  assert.deepEqual(reports, []);
  vm.text.value = '/usr/bin';
  vm.handleTypingInput();
  assert.deepEqual(reports, [true]);
  vm.text.value = '/task Title';
  vm.handleTypingInput();
  assert.deepEqual(reports, [true, false]);
  for (const action of ['empty', 'send']) {
    const { vm: ordinary } = mount(t);
    const before = reports.length;
    ordinary.text.value = 'Ordinary draft';
    await nextTick();
    assert.equal(reports.length, before, 'programmatic changes do not report typing');
    ordinary.handleTypingInput();
    assert.deepEqual(reports.slice(before), [true]);
    if (action === 'empty') {
      ordinary.text.value = '';
      await nextTick();
    } else await ordinary.handleSend();
    assert.deepEqual(reports.slice(before), [true, false], action);
  }
});

test('S3 web unavailable search keeps the command draft and reports an error without sending', async t => {
  const { vm, headerProps, header, sent } = mount(t);
  headerProps.activeTab = 'board';
  vm.text.value = '/search fox';
  await vm.handleSend();
  assert.equal(header.searchActive.value, false);
  assert.equal(vm.text.value, '/search fox');
  assert.equal(toasts.toasts.value.at(-1).type, 'error');
  assert.deepEqual(sent, []);
});

test('P2 web successful command with a mention argument cannot leave a popup that inserts or sends text', async t => {
  const { vm, props, tasks, sent } = mount(t);
  props.participants = [{ kind: 'human', display_name: 'Bob' }] as any;
  vm.text.value = '/task Ask @Bo';
  vm.textareaEl.value = { selectionStart: vm.text.value.length, focus() {}, setSelectionRange() {}, style: {} };
  vm.handleTypingInput();
  await vm.handleSend();
  assert.deepEqual(tasks, ['Ask @Bo']);
  assert.equal(vm.text.value, '');
  assert.equal(vm.suggestionsOpen.value, false);
  vm.handleKeyDown(key('Enter'));
  vm.handleKeyDown(key('Enter'));
  await flush();
  assert.equal(vm.text.value, '');
  assert.deepEqual(sent, []);
});

test('P2 web late command success preserves a newer draft and its active mention popup', async t => {
  const { vm, props, sent } = mount(t);
  props.participants = [{ kind: 'human', display_name: 'Bob' }] as any;
  let finish!: (value: boolean) => void;
  props.createTask = () => new Promise(resolve => { finish = resolve; });
  vm.text.value = '/task Ask @Bo';
  vm.textareaEl.value = { selectionStart: vm.text.value.length, focus() {}, setSelectionRange() {}, style: {} };
  vm.handleTypingInput();
  const pending = vm.handleSend();
  vm.text.value = '@Bo';
  vm.textareaEl.value.selectionStart = 3;
  vm.handleTypingInput();
  finish(true);
  await pending;
  assert.equal(vm.text.value, '@Bo');
  assert.equal(vm.mentionMenuOpen.value, true);
  vm.handleKeyDown(key('Enter'));
  await flush();
  assert.equal(vm.text.value, '@Bob ');
  assert.deepEqual(sent, []);
});

test('room header exposes Find and Settings while keeping room navigation and rename', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(Header, {
    title: 'sky-lake', subtitle: 'Room: sky-lake', activeTab: 'chat', connectionState: 'live',
    searchQuery: '', matchCount: 0, canRename: true, showEventsTab: true,
  }) }));
  assert.match(html, /aria-label="Find in room"/);
  assert.match(html, /aria-label="Room settings"/);
  assert.match(html, /aria-label="Rename room"/);
  assert.match(html, /aria-label="Room navigation"/);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(html, /role="tab"|in this room|Open menu/);
});

test('room underline redirects from its visible position and skips keyboard and reduced motion', async t => {
  const { header, headerProps } = mount(t);
  const calls: Array<{ frames: any[]; cancelled: boolean }> = [];
  const visible = { left: 180, top: 62, width: 80 };
  const positions: Record<string, number> = { chat: 0, board: 160, rooms: 320 };
  const indicator = {
    style: {} as Record<string, string>,
    getBoundingClientRect: () => visible,
    animate(frames: any[]) {
      const call = { frames, cancelled: false }; calls.push(call);
      return { cancel() { call.cancelled = true; } };
    },
  };
  header.indicatorElement.value = indicator;
  header.tabsElement.value = {
    scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 20, top: 20 }),
    querySelector: () => ({ offsetLeft: positions[headerProps.activeTab], offsetTop: 0, offsetWidth: 80, offsetHeight: 44 }),
  };
  headerProps.activeTab = 'board'; await nextTick();
  assert.equal(indicator.style.transform, 'translate(160px, 42px)');
  assert.equal(calls.length, 0, 'initial placement is immediate');
  header.prepareTabChange({ detail: 1 }, 'rooms');
  headerProps.activeTab = 'rooms'; await nextTick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].frames[0].transform, 'translate(160px, 42px) scaleX(1)');
  visible.left = 237; visible.width = 90;
  header.prepareTabChange({ detail: 1 }, 'chat');
  headerProps.activeTab = 'chat'; await nextTick();
  assert.equal(calls[0].cancelled, true);
  assert.equal(calls[1].frames[0].transform, 'translate(217px, 42px) scaleX(1.125)', 'redirect from the rendered underline, not the last tab target');
  header.prepareTabChange({ detail: 0 }, 'board');
  headerProps.activeTab = 'board'; await nextTick();
  assert.equal(calls[1].cancelled, true);
  assert.equal(calls.length, 2, 'keyboard changes snap');

  const priorMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as any;
  t.after(() => { window.matchMedia = priorMatchMedia; });
  const reduced = mount(t);
  reduced.header.indicatorElement.value = indicator;
  reduced.header.tabsElement.value = {
    scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 20, top: 20 }),
    querySelector: () => ({ offsetLeft: positions[reduced.headerProps.activeTab], offsetTop: 0, offsetWidth: 80, offsetHeight: 44 }),
  };
  reduced.headerProps.activeTab = 'board'; await nextTick();
  reduced.header.prepareTabChange({ detail: 1 }, 'rooms');
  reduced.headerProps.activeTab = 'rooms'; await nextTick();
  assert.equal(calls.length, 2, 'reduced motion does not animate');
  assert.equal(indicator.style.transform, 'translate(320px, 42px)');
});
