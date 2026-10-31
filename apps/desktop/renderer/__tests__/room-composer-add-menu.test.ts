import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer, Composer: any, Menu: any, suggested: any, ipc: any;
const originals = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
let reducedMotion = false;
const fakeDocument = Object.assign(new EventTarget(), { activeElement: null as unknown, visibilityState: 'visible' });
before(async () => {
  ipc = { room: { getExpressions: async () => ({ enabled: true, gif_provider_configured: true }) } };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), {
    letagentsDesktop: ipc, setTimeout: () => 0, matchMedia: (query: string) => ({ matches: query.includes('reduced-motion') && reducedMotion }),
  }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  Composer = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/RoomComposer.vue')).default;
  Menu = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/RoomComposerAddMenu.vue')).default;
  suggested = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/composer-suggested-reply.ts');
});
after(async () => {
  await vite?.close();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
const key = (name: string, extra: Record<string, unknown> = {}) => {
  const event = { key: name, isComposing: false, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, target: null as unknown,
    preventDefault() { event.defaultPrevented = true; }, stopPropagation() {}, ...extra };
  return event;
};

function setup(component: any, props: any, t: { after: (fn: () => void) => void }, provides: Array<[unknown, unknown]> = []) {
  const events: any[] = [];
  let vm: any;
  const child = { setup() { vm = component.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div'); } };
  const app = renderer.createApp({ render: () => h(child) });
  app.provide(ssrContextKey, { modules: new Set() });
  for (const [k, value] of provides) app.provide(k as any, value);
  app.mount({});
  t.after(() => app.unmount());
  return { vm, events, stop: () => app.unmount() };
}

/* ---------- the "+" menu ---------- */

function fakeItems(ids: string[]) {
  return ids.map(id => {
    const item: any = { dataset: { item: id }, disabled: false, focus() { fakeDocument.activeElement = item; } };
    return item;
  });
}

function mountMenu(t: any, overrides: Record<string, unknown> = {}) {
  const props = reactive({ disabled: false, attachDisabled: false, gifAvailable: true, gifDisabled: false, ...overrides });
  const mounted = setup(Menu, props, t);
  const items = fakeItems(['attach', 'gif', 'task', 'agent']);
  const inside = { name: 'inside' };
  mounted.vm.root.value = { contains: (node: unknown) => node === inside || items.includes(node) };
  mounted.vm.menu.value = { querySelectorAll: () => items.filter((item: any) => !item.disabled), contains: (node: unknown) => items.includes(node),
    querySelector: (selector: string) => items.find((item: any) => selector.includes(`"${item.dataset.item}"`)) ?? null };
  return { ...mounted, props, items, inside };
}

test('"+" opens only on click; a pointer-opened menu animates and a keyboard-opened one does not', async t => {
  const { vm, items } = mountMenu(t);
  assert.equal(vm.open.value, false);
  vm.toggle({ detail: 1 });
  assert.equal(vm.open.value, true);
  assert.equal(vm.animate.value, true, 'pointer click grows out of "+"');
  await flush();
  assert.equal(fakeDocument.activeElement, items[0], 'first item takes focus');
  vm.toggle({ detail: 1 });
  assert.equal(vm.open.value, false, 'a second click closes it');

  vm.toggle({ detail: 0 });
  assert.equal(vm.open.value, true);
  assert.equal(vm.animate.value, false, 'Enter or Space on "+" opens at once');
  vm.closeMenu();

  reducedMotion = true;
  t.after(() => { reducedMotion = false; });
  vm.toggle({ detail: 1 });
  assert.equal(vm.animate.value, false, 'reduced motion never animates');

  const source = readFileSync(new URL('../src/components/desktop/content/room-chat/RoomComposerAddMenu.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@(pointerenter|mouseenter|mouseover|pointerover)=/, 'hover never opens the menu');
});

test('arrow keys on "+" open the menu at the first or last item', async t => {
  const { vm, items } = mountMenu(t);
  vm.handleTriggerKey(key('ArrowUp'));
  await flush();
  assert.equal(vm.open.value, true);
  assert.equal(vm.animate.value, false);
  assert.equal(fakeDocument.activeElement, items[3]);
});

test('the menu closes only on a click outside or Escape; Tab and clicks inside keep it open', async t => {
  const { vm, events, inside, items } = mountMenu(t);
  vm.toggle({ detail: 1 });
  await flush();
  vm.handleMenuKey(key('Tab', { target: items[0] }));
  assert.equal(vm.open.value, true, 'Tab moves focus without closing');
  fakeDocument.dispatchEvent(Object.assign(new Event('pointerdown'), {}));
  assert.equal(vm.open.value, false, 'a click on the document outside closes it');

  vm.toggle({ detail: 1 });
  await flush();
  vm.closeOnOutsidePointer({ target: inside });
  assert.equal(vm.open.value, true, 'a click inside the menu keeps it open');

  const outsideEscape = key('Escape', { target: { name: 'textarea' } });
  vm.closeOnEscape(outsideEscape);
  assert.equal(vm.open.value, false, 'Escape anywhere closes it');
  assert.equal(outsideEscape.defaultPrevented, true, 'that Escape does nothing else');

  vm.toggle({ detail: 0 });
  await flush();
  vm.handleMenuKey(key('Escape', { target: items[1] }));
  assert.equal(vm.open.value, false);
  assert.deepEqual(events.at(-1), ['dismiss'], 'Escape inside hands focus back to the composer');
});

test('arrow keys, Home and End move one highlight through enabled items; Enter and Right choose', async t => {
  const { vm, events, items, props } = mountMenu(t);
  vm.toggle({ detail: 0 });
  await flush();
  vm.handleMenuKey(key('ArrowUp', { target: items[0] }));
  assert.equal(fakeDocument.activeElement, items[3], 'Up from the first wraps to the last');
  vm.handleMenuKey(key('ArrowDown', { target: items[3] }));
  assert.equal(fakeDocument.activeElement, items[0]);
  vm.handleMenuKey(key('End', { target: items[0] }));
  assert.equal(fakeDocument.activeElement, items[3]);
  vm.handleMenuKey(key('Home', { target: items[3] }));
  assert.equal(fakeDocument.activeElement, items[0]);
  items[1].disabled = true;
  vm.handleMenuKey(key('ArrowDown', { target: items[0] }));
  assert.equal(fakeDocument.activeElement, items[2], 'disabled items are skipped');
  vm.focusItem(items[3]);
  assert.equal(fakeDocument.activeElement, items[3], 'the pointer moves the one highlight');

  vm.handleMenuKey(key('ArrowRight', { target: items[3] }));
  assert.deepEqual(events.at(-1), ['select', 'agent']);
  assert.equal(vm.open.value, false);

  vm.toggle({ detail: 0 });
  vm.choose(vm.items.value.find((item: any) => item.id === 'task'));
  assert.deepEqual(events.at(-1), ['select', 'task']);
  assert.equal(vm.open.value, false);

  props.attachDisabled = true;
  vm.toggle({ detail: 0 });
  const count = events.length;
  vm.choose(vm.items.value.find((item: any) => item.id === 'attach'));
  assert.equal(events.length, count, 'a disabled item does nothing');
});

test('the menu lists Attach files, GIF, Create task, Add agent and Ask someone for an agent; GIF only when GIPHY is set up', t => {
  const { vm, props } = mountMenu(t);
  assert.deepEqual(vm.items.value.map((item: any) => item.label), ['Attach files…', 'GIF', 'Create task…', 'Add agent', 'Ask someone for an agent…']);
  props.gifAvailable = false;
  assert.deepEqual(vm.items.value.map((item: any) => item.id), ['attach', 'task', 'agent', 'ask']);
});

test('disabling "+" closes an open menu and keeps it closed', async t => {
  const { vm, props } = mountMenu(t);
  vm.toggle({ detail: 1 });
  props.disabled = true;
  await flush();
  assert.equal(vm.open.value, false);
  vm.toggle({ detail: 1 });
  assert.equal(vm.open.value, false);
});

/* ---------- the composer ---------- */

let sequence = 0;
function mountComposer(t: any, suggestion: any = null, overrides: Record<string, unknown> = {}) {
  const props = reactive({ attaching: false, attachmentDrafts: [] as any[], attachmentError: null, eventPreviews: [], messageNamespace: `add-menu-${++sequence}`,
    participants: [], pendingAttachmentDrafts: [] as any[], replyTo: null as any, roomIdentifier: 'room-a', roomLabel: 'letagents', roomLoading: false,
    sendError: null, sending: false, ...overrides });
  const reads: Array<string | null> = [];
  const read = (room: string | null) => { reads.push(room); return suggestion; };
  const mounted = setup(Composer, props, t, [[suggested.composerSuggestedReplyKey, read]]);
  return { ...mounted, props, reads };
}

test('placeholder and label name the room; loading and no-room keep their labels', t => {
  const { vm, props } = mountComposer(t);
  assert.equal(vm.composerPlaceholder.value, 'Message #letagents · @ to mention · / for commands');
  assert.equal(vm.composerInputLabel.value, 'Message #letagents');
  props.roomLabel = '#general';
  assert.equal(vm.composerPlaceholder.value, 'Message #general · @ to mention · / for commands');
  props.roomLoading = true;
  assert.equal(vm.composerInputLabel.value, 'Room messages are loading');
  assert.equal(vm.composerPlaceholder.value, undefined);
  props.roomLoading = false;
  props.roomIdentifier = null;
  assert.equal(vm.composerInputLabel.value, 'Choose a room before writing');
});

test('pasted files are staged like dropped files; pasted text stays text', t => {
  const { vm, events, props } = mountComposer(t);
  const image = { name: 'image.png', type: 'image/png', size: 10 };
  const paste = (files: unknown[], data: Record<string, string> = {}) => {
    const event = { clipboardData: { files, getData: (type: string) => data[type] ?? '' }, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
    vm.handlePaste(event);
    return event;
  };
  const withImage = paste([image]);
  assert.equal(withImage.defaultPrevented, true);
  assert.deepEqual(events, [['stage-attachments', [image]]]);
  const textOnly = paste([]);
  assert.equal(textOnly.defaultPrevented, false, 'the browser pastes text as usual');
  assert.equal(events.length, 1);
  const webImage = paste([image], { 'text/html': '<img src="x">' });
  assert.equal(webImage.defaultPrevented, true, 'a copied web image has no text, so it attaches');
  const spreadsheet = paste([image], { 'text/plain': 'a\tb', 'text/html': '<table></table>' });
  assert.equal(spreadsheet.defaultPrevented, false, 'a spreadsheet range pastes as text, not as its picture');
  assert.equal(events.length, 2);
  props.roomIdentifier = null;
  paste([image]);
  assert.equal(events.length, 2, 'no room, nothing staged');
});

test('⌘U (Ctrl+U off macOS) and the menu attach files only when attaching is possible', t => {
  const { vm, events, props } = mountComposer(t);
  const shortcut = vm.mac ? { metaKey: true } : { ctrlKey: true };
  const event = key('u', shortcut);
  vm.handleComposerKey(event);
  assert.equal(event.defaultPrevented, true);
  vm.handleAddMenuSelect('attach');
  assert.deepEqual(events, [['pick-attachments'], ['pick-attachments']]);
  vm.handleComposerKey(key('u', vm.mac ? { ctrlKey: true } : { metaKey: true }));
  vm.handleComposerKey(key('U', { ...shortcut, shiftKey: true }));
  assert.equal(events.length, 2, 'other modifiers do not attach');
  props.attaching = true;
  vm.handleComposerKey(key('u', shortcut));
  vm.handleAddMenuSelect('attach');
  assert.equal(events.length, 2, 'no second picker while one is attaching');
});

test('Create task starts a /task command and keeps any draft as its title; Add agent opens the modal', async t => {
  const { vm, events } = mountComposer(t);
  vm.handleAddMenuSelect('task');
  assert.equal(vm.draft.value, '/task ');
  assert.equal(vm.slash.hint.value, 'Add a task title');
  vm.draft.value = 'Fix the flaky test';
  vm.handleAddMenuSelect('task');
  assert.equal(vm.draft.value, '/task Fix the flaky test');
  vm.handleAddMenuSelect('task');
  assert.equal(vm.draft.value, '/task Fix the flaky test', 'never doubled');
  vm.handleAddMenuSelect('agent');
  assert.deepEqual(events, [['open-add-agent']]);
});

test('GIF opens a panel beside the menu; the menu stays open and Back returns to the GIF row', async t => {
  const { vm, events, items } = mountMenu(t);
  vm.toggle({ detail: 1 });
  await flush();
  vm.choose(vm.items.value.find((item: any) => item.id === 'gif'), true);
  await flush();
  assert.equal(vm.open.value, true, 'the menu stays open');
  assert.equal(vm.flyout.value, 'gif');
  assert.equal(vm.flyoutQuery.value, '');
  assert.equal(vm.flyoutAnimate.value, true, 'a click grows the panel out of its row');
  assert.equal(events.length, 0, 'GIF is handled inside the menu');

  const search = { name: 'gif search' };
  vm.flyoutElement.value = { contains: (node: unknown) => node === search, querySelector: () => null };
  const escape = key('Escape', { target: search });
  vm.closeOnEscape(escape);
  assert.equal(vm.open.value, true, 'Escape inside the panel is the panel\'s to handle');
  assert.equal(escape.defaultPrevented, false);

  vm.backToMenu();
  await flush();
  assert.equal(vm.flyout.value, null);
  assert.equal(vm.open.value, true);
  assert.equal(fakeDocument.activeElement, items[1], 'focus returns to the GIF row');

  vm.handleMenuKey(key('ArrowRight', { target: items[1] }));
  await flush();
  assert.equal(vm.flyout.value, 'gif', 'Right opens it again');
  assert.equal(vm.flyoutAnimate.value, false, 'a keyboard-opened panel appears at once');
  vm.closeMenu();
  assert.equal(vm.flyout.value, null, 'closing the menu closes the panel');
});

test('with the GIF panel open, the pointer over the menu keeps focus in the panel; a stray Escape there goes back', async t => {
  const { vm, items } = mountMenu(t);
  vm.openGif('');
  await flush();
  const search = { name: 'gif search' };
  fakeDocument.activeElement = search;
  vm.focusItem(items[1]);
  assert.equal(fakeDocument.activeElement, search, 'moving over the GIF row does not steal the search box focus');

  const chipEscape = key('Escape', { target: { name: 'quick search chip' } });
  vm.handleFlyoutKey(chipEscape);
  assert.equal(chipEscape.defaultPrevented, true);
  assert.equal(vm.flyout.value, null, 'Escape on a quick search, Back or the GIPHY link goes back to the menu');
  assert.equal(vm.open.value, true);
  const usedEscape = key('Escape', { defaultPrevented: true });
  vm.openGif('');
  await flush();
  vm.handleFlyoutKey(usedEscape);
  assert.equal(vm.flyout.value, 'gif', 'an Escape the panel already used does nothing more');

  vm.closeMenu();
  vm.focusItem(items[2]);
  assert.equal(fakeDocument.activeElement, items[2], 'without a panel the pointer highlights rows as before');
});

test('a GIF availability check that fails while the panel is open leaves the panel open', async t => {
  const { vm, props } = mountMenu(t);
  vm.openGif('ship');
  await flush();
  props.gifAvailable = false;
  props.gifDisabled = true;
  await flush();
  assert.equal(vm.flyout.value, 'gif');
});

test('openGif opens the menu and the panel with a search; it does nothing when GIFs are off', async t => {
  const { vm, props } = mountMenu(t);
  vm.openGif('lgtm');
  await flush();
  assert.equal(vm.open.value, true);
  assert.equal(vm.animate.value, false);
  assert.equal(vm.flyout.value, 'gif');
  assert.equal(vm.flyoutQuery.value, 'lgtm');
  vm.closeMenu();
  props.gifAvailable = false;
  vm.openGif('lgtm');
  await flush();
  assert.equal(vm.open.value, false);
  props.gifAvailable = true;
  props.gifDisabled = true;
  vm.openGif('lgtm');
  await flush();
  assert.equal(vm.open.value, false);
});

test('/gif <query> and Enter open the GIF panel with that search instead of sending', async t => {
  const { vm, events } = mountComposer(t);
  await flush();
  assert.equal(vm.gifAvailable.value, true);
  const opened: string[] = [];
  vm.addMenu.value = { openGif: (query: string) => opened.push(query), close() {}, isOpen: () => false };
  vm.draft.value = '/gif lgtm';
  vm.handleComposerKey(key('Enter'));
  await flush();
  assert.deepEqual(opened, ['lgtm']);
  assert.equal(vm.draft.value, '', 'the command leaves the draft');
  assert.equal(events.filter((event: any) => event[0] === 'send-message').length, 0, 'nothing is sent');

  vm.draft.value = '/gif';
  await vm.submitMessage();
  assert.deepEqual(opened, ['lgtm', ''], 'a bare /gif opens the quick searches');
});

test('/gif in a room without GIFs keeps the draft and says why', async t => {
  ipc.room.getExpressions = async () => ({ enabled: false, gif_provider_configured: true });
  t.after(() => { ipc.room.getExpressions = async () => ({ enabled: true, gif_provider_configured: true }); });
  const { vm, events } = mountComposer(t);
  await flush();
  const opened: string[] = [];
  vm.addMenu.value = { openGif: (query: string) => opened.push(query), close() {}, isOpen: () => false };
  vm.draft.value = '/gif lgtm';
  await vm.submitMessage();
  assert.deepEqual(opened, []);
  assert.equal(vm.draft.value, '/gif lgtm');
  assert.equal(events.filter((event: any) => event[0] === 'send-message').length, 0);
});

test('a picked GIF goes into the draft with its preview, still under reduced motion; sending carries only id and title', async t => {
  const { vm, events } = mountComposer(t);
  let closed = 0;
  vm.addMenu.value = { openGif() {}, close: () => { closed++; }, isOpen: () => false };
  const item = { provider: 'giphy', id: 'g1', title: 'Ship it', page_url: 'https://giphy.com/gifs/g1', preview_url: 'https://media.giphy.com/g1.gif', still_url: 'https://media.giphy.com/g1_s.gif', image_url: null };
  vm.pickGif(item);
  assert.equal(closed, 1, 'one click adds it and closes the panel');
  assert.deepEqual(vm.selectedGif.value, { provider: 'giphy', id: 'g1', title: 'Ship it' });
  assert.equal(vm.selectedGifPreview.value, item.preview_url);
  reducedMotion = true;
  t.after(() => { reducedMotion = false; });
  vm.selectedGifItem.value = { ...item };
  assert.equal(vm.selectedGifPreview.value, item.still_url);
  assert.equal(vm.canSend.value, true, 'a GIF alone can be sent');
  vm.sendRoomMessage();
  const sent = events.find((event: any) => event[0] === 'send-message');
  assert.deepEqual(sent.at(-1), { provider: 'giphy', id: 'g1', title: 'Ship it' }, 'preview URLs never leave the draft');
  vm.removeSelectedGif();
  assert.equal(vm.selectedGif.value, null);
  assert.equal(vm.selectedGifPreview.value, null);
});

test('Enter while a file uploads sends once it finishes, with the file; a failed upload sends nothing', async t => {
  const props = reactive({ attaching: false, attachmentDrafts: [] as any[], attachmentError: null, eventPreviews: [], messageNamespace: `upload-${++sequence}`,
    participants: [], pendingAttachmentDrafts: [{ localId: 'p1', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 3, previewDataUrl: null }] as any[],
    replyTo: null, roomIdentifier: 'room-a', roomLoading: false, sendError: null, sending: false });
  const { vm, events } = setup(Composer, props, t);
  vm.draft.value = 'see this';
  assert.equal(vm.canSend.value, true, 'a file still uploading counts as something to send');
  await vm.submitMessage();
  assert.equal(events.filter((event: any) => event[0] === 'send-message').length, 0, 'it waits for the upload');
  assert.equal(vm.sendLabel.value, 'Sends when the files finish uploading');
  props.attachmentDrafts = [{ uploadId: 'up1', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 3, previewDataUrl: null }];
  props.pendingAttachmentDrafts = [];
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 0));
  const sent = events.find((event: any) => event[0] === 'send-message');
  assert.ok(sent, 'it sends when the upload finishes');
  assert.equal(sent[1], 'see this');
  assert.deepEqual(sent[3], [{ upload_id: 'up1' }]);

  // A failed upload: the chip goes away without becoming an attachment, so nothing is sent.
  const failing = reactive({ ...props, attachmentDrafts: [] as any[], messageNamespace: `upload-${++sequence}`,
    pendingAttachmentDrafts: [{ localId: 'p2', fileName: 'b.txt', mimeType: 'text/plain', sizeBytes: 3, previewDataUrl: null }] as any[] });
  const second = setup(Composer, failing, t);
  second.vm.draft.value = 'with file';
  await second.vm.submitMessage();
  failing.pendingAttachmentDrafts = [];
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(second.events.filter((event: any) => event[0] === 'send-message').length, 0);
  assert.equal(second.vm.draft.value, 'with file', 'the draft stays');
});

const suggestionFor = (recordId: string) => ({ recordId, from: 'Ada', text: 'Ship the small fixes now.' });

test('Tab fills the suggested reply once, only into an empty input with no menu or list open', async t => {
  const { vm, reads } = mountComposer(t, suggestionFor(`tab-${sequence}`));
  assert.equal(vm.suggestionVisible.value, true);
  assert.equal(reads.at(-1), 'room-a', 'the suggestion is read for this room');

  vm.addMenu.value = { isOpen: () => true };
  const blockedByMenu = key('Tab');
  vm.handleComposerKey(blockedByMenu);
  assert.equal(blockedByMenu.defaultPrevented, false, 'with the menu open Tab moves focus');
  vm.addMenu.value = { isOpen: () => false };

  const shifted = key('Tab', { shiftKey: true });
  vm.handleComposerKey(shifted);
  assert.equal(shifted.defaultPrevented, false, 'Shift+Tab still moves focus back');

  const tab = key('Tab');
  vm.handleComposerKey(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(vm.draft.value, 'Ship the small fixes now.');
  assert.equal(vm.suggestionVisible.value, false, 'typing or filling hides the ghost');

  vm.draft.value = '';
  await flush();
  assert.equal(vm.suggestionVisible.value, false, 'used once, it does not come back');
  const again = key('Tab');
  vm.handleComposerKey(again);
  assert.equal(again.defaultPrevented, false);
  assert.equal(vm.draft.value, '');
});

test('typed text or a reply hides the suggestion, and Tab then does not replace the draft', async t => {
  const { vm, props } = mountComposer(t, suggestionFor(`typed-${sequence}`));
  vm.draft.value = 'my own words';
  assert.equal(vm.suggestionVisible.value, false);
  vm.handleComposerKey(key('Tab'));
  assert.equal(vm.draft.value, 'my own words');
  vm.draft.value = '';
  assert.equal(vm.suggestionVisible.value, true, 'an emptied input shows it again until used or dismissed');
  props.replyTo = { id: 'msg_1', sender: 'Orin', text: 'hi' };
  assert.equal(vm.suggestionVisible.value, false, 'a reply to another message hides it');
});

test('Escape dismisses the suggestion; an Escape spent closing the menu does not', t => {
  const { vm } = mountComposer(t, suggestionFor(`esc-${sequence}`));
  const spent = key('Escape');
  spent.preventDefault();
  vm.handleComposerKey(spent);
  assert.equal(vm.suggestionVisible.value, true);
  vm.handleComposerKey(key('Escape'));
  assert.equal(vm.suggestionVisible.value, false);
  const tab = key('Tab');
  vm.handleComposerKey(tab);
  assert.equal(tab.defaultPrevented, false);
});

test('an Escape that closed the "+" menu leaves an open command list alone', t => {
  const { vm } = mountComposer(t);
  vm.draft.value = '/';
  assert.equal(vm.slash.open.value, true);
  const spent = key('Escape');
  spent.preventDefault();
  vm.handleComposerKey(spent);
  assert.equal(vm.slash.open.value, true);
  vm.handleComposerKey(key('Escape'));
  assert.equal(vm.slash.open.value, false);
});

test('a paste or drop while the picker is open still shows its chip at once', async t => {
  const { useRoomAttachments } = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/useRoomAttachments.ts');
  let attachments: any;
  const app = renderer.createApp({ setup() { attachments = useRoomAttachments({ roomIdentifier: { value: 'room-a' }, discardAttachment() {} }); return () => h('div'); } });
  app.mount({});
  t.after(() => app.unmount());
  attachments.attaching.value = true;
  void attachments.stageDroppedAttachments([{ name: 'notes.txt', type: 'text/plain', size: 10 }]);
  assert.equal(attachments.attachmentProblem.value, null);
  assert.deepEqual(attachments.pendingAttachmentDrafts.value.map((draft: any) => draft.fileName), ['notes.txt']);
});

test('no Needs you provider means no suggestion', t => {
  const props = reactive({ attaching: false, attachmentDrafts: [], attachmentError: null, eventPreviews: [], messageNamespace: `bare-${++sequence}`,
    participants: [], pendingAttachmentDrafts: [], replyTo: null, roomIdentifier: 'room-a', roomLoading: false, sendError: null, sending: false });
  const { vm } = setup(Composer, props, t);
  assert.equal(vm.suggestionVisible.value, false);
});

/* ---------- where the suggestion comes from ---------- */

const record = (overrides: Record<string, any> = {}) => ({
  id: 'rec_1', room_id: 'room', type: 'attention', version: 1, category: 'question', title: 'Ship now?', body: 'Open the PR now?',
  recommendation: 'Ship the small fixes now.', unblocks: '', source_url: '', source_message_id: '',
  author: { id: 'agent_1', label: 'Ada', kind: 'agent' }, updated_by: { id: 'agent_1', label: 'Ada', kind: 'agent' },
  created_at: '2026-10-26T10:00:00.000Z', updated_at: '2026-10-26T10:00:00.000Z', archived: false, response: null, ...overrides,
});
const needsYou = (rooms: Array<{ roomIdentifier: string; records: any[] }>) => ({ rooms: rooms.map(room => ({ ...room, displayName: 'x', truncated: false, tasks: [] })),
  failures: [], limited: false, cloudUnavailable: false, signedOut: false, updatesIncluded: false });

test('the suggestion is the newest open agent request in this room that carries a recommendation', () => {
  const data = needsYou([
    { roomIdentifier: 'github.com/BrosInCode/letagents', records: [
      record({ id: 'old', updated_at: '2026-10-26T09:00:00.000Z', recommendation: 'Older' }),
      record({ id: 'new', updated_at: '2026-10-26T11:00:00.000Z', recommendation: '  Newer  ' }),
      record({ id: 'answered', updated_at: '2026-10-26T12:00:00.000Z', response: { body: 'done', actor: { id: 'h', label: 'Em', kind: 'human' }, at: 'x' } }),
      record({ id: 'archived', updated_at: '2026-10-26T12:00:00.000Z', archived: true }),
      record({ id: 'by-person', updated_at: '2026-10-26T12:00:00.000Z', author: { id: 'h', label: 'Em', kind: 'human' } }),
      record({ id: 'no-recommendation', updated_at: '2026-10-26T12:00:00.000Z', recommendation: '   ' }),
    ] },
    { roomIdentifier: 'other-room', records: [record({ id: 'elsewhere', updated_at: '2026-10-26T13:00:00.000Z' })] },
  ]);
  assert.deepEqual(suggested.roomSuggestedReply(data, 'github.com/brosincode/letagents'), { recordId: 'new', from: 'Ada', text: 'Newer' });
  assert.equal(suggested.roomSuggestedReply(data, 'missing-room'), null);
  assert.equal(suggested.roomSuggestedReply(data, null), null);
  assert.equal(suggested.roomSuggestedReply(null, 'other-room'), null);
});

test('App provides the suggestion from the Needs you data', () => {
  const inbox = readFileSync(new URL('../src/composables/app/useAppInbox.ts', import.meta.url), 'utf8');
  assert.match(inbox, /provide\(composerSuggestedReplyKey, \(roomIdentifier\) => roomSuggestedReply\(needsYouData\.value, roomIdentifier\)\)/);
});
