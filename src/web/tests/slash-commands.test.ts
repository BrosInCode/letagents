import '../../../shared/slash-commands.test.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
function mount(t: { after: (fn: () => void) => void }, overrides: { inlineThread?: boolean; threadRootId?: string } = {}) {
  const events: any[] = [], tasks: string[] = [], sent: any[] = [], searches: string[] = [];
  let vm: any, header: any;
  const headerProps = reactive({ title: 'Room', subtitle: '', activeTab: 'chat', connectionState: 'live', searchQuery: '', matchCount: 0 });
  const props = reactive({ senderName: 'Ada', roomIdentifier: 'room-a', isSignedIn: true, disabled: false, attachmentsEnabled: true, replyTo: null as any, messages: [], presence: [], presenceReady: true, participants: [],
    openSearch: (query: string) => { searches.push(query); return header.openSearch(); },
    createTask: async (title: string) => { tasks.push(title); return true; },
    submitMessage: async (...args: any[]) => { sent.push(args); return true; },
    ...overrides,
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

test('composer plus menu supports arrows, Home/End and Escape without losing the draft', async t => {
  const { vm, props, sent } = mount(t);
  const focused: string[] = [];
  const item = (name: string) => ({ focus() { focused.push(name); (document as any).activeElement = this; } });
  const attach = item('attach'), poll = item('poll'), trigger = item('trigger');
  vm.addTriggerEl.value = trigger;
  vm.addMenuEl.value = { querySelectorAll: () => props.attachmentsEnabled ? [attach, poll] : [poll] };
  vm.text.value = '/task Keep draft';
  assert.equal(vm.suggestionsOpen.value, true);
  props.attachmentsEnabled = false;
  vm.handleAddTriggerKey(key('ArrowDown'));
  await flush();
  assert.equal(vm.menuOpen.value, true);
  assert.equal(vm.animateAddMenu.value, false, 'keyboard opening does not animate');
  assert.equal(focused.at(-1), 'poll', 'unavailable attachment row is skipped');
  assert.equal(vm.suggestionsOpen.value, false, 'one suggestion surface at a time');
  props.attachmentsEnabled = true;
  vm.handleAddMenuKey(key('ArrowDown'));
  assert.equal(focused.at(-1), 'attach', 'arrow selection wraps');
  vm.handleAddMenuKey(key('ArrowDown'));
  assert.equal(focused.at(-1), 'poll');
  vm.handleAddMenuKey(key('End'));
  assert.equal(focused.at(-1), 'poll');
  vm.handleAddMenuKey(key('Home'));
  assert.equal(focused.at(-1), 'attach');
  let stopped = false;
  vm.handleAddMenuKey(key('Escape', { stopPropagation() { stopped = true; } }));
  assert.equal(stopped, true, 'Escape does not close the containing thread');
  assert.equal(vm.menuOpen.value, false);
  assert.equal(focused.at(-1), 'trigger');
  assert.equal(vm.text.value, '/task Keep draft');
  assert.equal(vm.suggestionsOpen.value, true);
  assert.deepEqual(sent, []);
  vm.handleAddTriggerKey(key('ArrowUp'));
  await flush();
  assert.equal(focused.at(-1), 'poll');
  vm.handleAddMenuKey(key('Tab'));
  assert.equal(vm.menuOpen.value, false);
  assert.equal(focused.at(-1), 'trigger', 'Tab resumes the composer tab order');
});

test('composer keyboard navigation reveals rows within a short menu without scrolling the page', async t => {
  const { vm } = mount(t);
  const item = (offsetTop: number) => ({
    offsetTop, offsetHeight: 44,
    focus(options: { preventScroll: boolean }) {
      assert.equal(options.preventScroll, true, 'native focus must leave the page still');
      (document as any).activeElement = this;
    },
  });
  const items = [item(8), item(120)];
  const menu = { scrollTop: 0, clientHeight: 72, querySelectorAll: () => items };
  vm.addMenuEl.value = menu;
  const assertVisible = (index: number) => {
    const selected = items[index];
    assert.equal((document as any).activeElement, selected);
    assert.ok(selected.offsetTop >= menu.scrollTop, 'selected row starts within the menu viewport');
    assert.ok(selected.offsetTop + selected.offsetHeight <= menu.scrollTop + menu.clientHeight, 'selected row ends within the menu viewport');
  };
  vm.handleAddTriggerKey(key('ArrowUp'));
  await flush();
  assertVisible(1);
  assert.equal(menu.scrollTop, 92, 'opening on the last item scrolls the menu');
  vm.handleAddMenuKey(key('ArrowDown'));
  assertVisible(0);
  vm.handleAddMenuKey(key('ArrowDown'));
  assertVisible(1);
  vm.handleAddMenuKey(key('End'));
  assertVisible(1);
  vm.handleAddMenuKey(key('Home'));
  assertVisible(0);
});

test('composer plus attachment action preserves picker activation, availability guards and room dismissal', async t => {
  const { vm, props } = mount(t);
  let picked = 0;
  vm.fileInputEl.value = { click() { picked++; } };
  vm.addTriggerEl.value = { focus() {} };
  vm.text.value = 'Draft with files';
  vm.menuOpen.value = true;
  vm.chooseAttachment();
  assert.equal(picked, 1, 'picker opens synchronously within the user action');
  assert.equal(vm.menuOpen.value, false);
  assert.equal(vm.text.value, 'Draft with files');
  props.attachmentsEnabled = false;
  vm.chooseAttachment();
  assert.equal(picked, 1);
  props.attachmentsEnabled = true;
  props.disabled = true;
  vm.openAddMenu();
  assert.equal(vm.menuOpen.value, false);
  props.disabled = false;
  vm.openAddMenu();
  await flush();
  assert.equal(vm.menuOpen.value, true);
  props.roomIdentifier = 'room-b';
  await flush();
  assert.equal(vm.menuOpen.value, false, 'the old room menu closes on navigation');
});

test('composer bottom bar retains browser sign-in and exposes accessible plus and send controls', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(Composer, {
    roomIdentifier: 'room-a', senderName: 'guest', isSignedIn: false,
  }) }));
  assert.match(html, /class="composer-add-btn"[^>]*aria-label="Add to message"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-label="Sending as guest"/);
  assert.match(html, /class="composer-signin-btn"[^>]*>Sign in/);
  assert.match(html, /aria-busy="false" aria-label="Send message"/);
  assert.doesNotMatch(html, /composer-pills-row|prompt-trigger|class="attachment-btn"/);
  const reply = await renderToString(createSSRApp({ render: () => h(Composer, { inlineThread: true, threadRootId: 'root-a' }) }));
  assert.match(reply, /aria-label="Send reply"/);
  assert.doesNotMatch(reply, /composer-signin-btn|composer-sender-label|Agent prompts/);
});

test('legacy Inject preferences cannot affect ordinary sends while auto-poll preferences still work', async t => {
  const originalStorage = globalThis.localStorage;
  const saved = new Map([
    ['lac-prompt-prefs:room-a', JSON.stringify({ autoKeepPolling: false, injectPrompt: true })],
    ['lac-prompt-prefs:room-b', JSON.stringify({ autoKeepPolling: true, injectPrompt: true })],
  ]);
  globalThis.localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } as any;
  t.after(() => { globalThis.localStorage = originalStorage; });
  const { vm, props, sent } = mount(t);
  assert.equal(vm.autoKeepPolling.value, false);
  vm.text.value = 'Ordinary message';
  await vm.handleSend();
  assert.deepEqual(sent[0], ['Ordinary message', null, null, []]);

  props.roomIdentifier = 'room-b';
  await flush();
  assert.equal(vm.autoKeepPolling.value, true, 'saved auto-poll remains available after switching rooms');
  assert.equal(sent.length, 1, 'restoring auto-poll does not send an immediate reminder');
  vm.text.value = 'Another ordinary message';
  await vm.handleSend();
  assert.deepEqual(sent.at(-1), ['Another ordinary message', null, null, []]);
  vm.toggleAutoKeepPolling();
  assert.deepEqual(JSON.parse(saved.get('lac-prompt-prefs:room-b')!), { autoKeepPolling: false });
  vm.toggleAutoKeepPolling();
  await flush();
  assert.deepEqual(sent.at(-1), ['', 'auto', null, []], 'the retained setting sends its quiet auto-poll reminder');
  assert.deepEqual(JSON.parse(saved.get('lac-prompt-prefs:room-b')!), { autoKeepPolling: true }, 'preference writes do not retain the removed Inject flag');
  vm.toggleAutoKeepPolling();
  props.roomIdentifier = 'room-a';
  await flush();
  props.replyTo = { id: 'msg_1', sender: 'Ada', text: 'reply' };
  vm.text.value = 'Reply without injection';
  await vm.handleSend();
  assert.deepEqual(sent.at(-1), ['Reply without injection', null, 'msg_1', []]);
});

test('open composer menu exposes Attach and Auto read + poll without an Inject option', async () => {
  const OpenComposer = { ...Composer, setup(props: any, context: any) {
    const vm = Composer.setup(props, context);
    vm.menuOpen.value = true;
    return vm;
  } };
  const html = await renderToString(createSSRApp({ render: () => h(OpenComposer, { roomIdentifier: 'room-a' }) }));
  assert.match(html, /Attach files…/);
  assert.match(html, /Auto read \+ poll/);
  assert.equal((html.match(/role="menuitemcheckbox"/g) || []).length, 1);
  assert.doesNotMatch(html, /Attach room prompt|stay-in-room|Inject/i);
});

test('Send preserves input focus on primary pointer press and submits only through form activation', async t => {
  const source = readFileSync(new URL('../src/components/room/Composer.vue', import.meta.url), 'utf8');
  assert.match(source, /<button\b[^>]*class="send-btn"[^>]*@pointerdown="preserveSendFocus"[^>]*>/s, 'the actual submit control binds the focus-preserving pointer handler');
  const main = mount(t);
  const thread = mount(t, { inlineThread: true, threadRootId: 'msg_1' });
  main.vm.text.value = 'Keep the main draft';
  thread.vm.text.value = 'Send the thread reply';
  for (const pointerType of ['touch', 'pen', 'mouse']) {
    for (const composer of [main, thread]) {
      const press = Object.assign(new Event('pointerdown', { cancelable: true }), { button: 0, pointerType });
      composer.vm.preserveSendFocus(press);
      assert.equal(press.defaultPrevented, true, `${pointerType} must not transfer focus and collapse the keyboard before click`);
      assert.deepEqual(composer.sent, [], 'pressing alone must not submit; a cancelled gesture remains safe');
    }
  }
  const secondary = Object.assign(new Event('pointerdown', { cancelable: true }), { button: 2, pointerType: 'mouse' });
  thread.vm.preserveSendFocus(secondary);
  assert.equal(secondary.defaultPrevented, false, 'secondary clicks retain native behavior');
  await thread.vm.handleSend();
  assert.deepEqual(thread.sent, [['Send the thread reply', null, null, []]]);
  assert.equal(thread.vm.text.value, '');
  assert.equal(main.vm.text.value, 'Keep the main draft');
  assert.deepEqual(main.sent, []);
  main.vm.handleKeyDown(key('Enter'));
  await flush();
  assert.deepEqual(main.sent, [['Keep the main draft', null, null, []]], 'keyboard submission remains independent of pointer events');
});
