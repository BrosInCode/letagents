import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/components/desktop/content/${path}`, import.meta.url)), "utf8");

test("the composer's + menu closes on a click elsewhere or Escape, and drops its listeners on unmount", () => {
  // Behaviour: room-composer-add-menu.test.ts. This keeps the listener cleanup in place.
  const menu = source("room-chat/RoomComposerAddMenu.vue");
  assert.match(menu, /document\[method\]\("pointerdown", closeOnOutsidePointer as EventListener, true\)/);
  assert.match(menu, /document\[method\]\("keydown", closeOnEscape as EventListener, true\)/);
  assert.match(menu, /onBeforeUnmount\(\(\) => setDocumentListeners\(false\)\)/);
});

test("the giving screen shows why \"Can't right now\" did not go through, and stays open", () => {
  const give = source("asks/GiveAgentDialog.vue");
  assert.match(give, /if \(!result\?\.ok\) \{ error\.value = /);
});

test("the giving screen offers only models on the current list, never one built from the ask", () => {
  const give = source("asks/GiveAgentDialog.vue");
  assert.doesNotMatch(give, /label: preview\.value\.ask\.model_label/);
  assert.match(give, /model\.model === preview\.value\.ask\.model\) \?\? null;/);
});

// Exercise the real Vue controllers with IPC isolated from the installed app.
const { before, after } = await import('node:test');
const { createServer } = await import('vite');
const { createRenderer, createSSRApp, h, reactive, nextTick, ssrContextKey } = await import('vue');
const { renderToString } = await import('@vue/server-renderer');
let vite: any, Give: any, Panel: any, Dropdown: any, Ask: any, AskPanel: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Ask = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/asks/AskAgentDialog.vue')).default;
  AskPanel = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/ask-agent/AskAgentPanel.vue', import.meta.url)))).default;
  Give = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/asks/GiveAgentDialog.vue')).default;
  Panel = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/give-agent/GiveAgentPanel.vue', import.meta.url)))).default;
  Dropdown = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/FilterDropdown.vue', import.meta.url)))).default;
});
after(async () => { await vite?.close(); });
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const receiver = { id: 'ask-one', asker: 'Recipient', asker_avatar_url: 'https://avatars.githubusercontent.com/u/42', provider_id: 'claude-code', model: 'current-model', model_label: 'Requested model', amount_percent: 15, note: 'Please review this.', room_display_name: 'Room' };
const models = [{ providerId: 'claude-code', model: 'current-model', label: 'Requested model' }, { providerId: 'codex', model: null, label: 'Codex' }];
const ok = (value: any) => ({ ok: true, value });
const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } };
function deferred() { let resolve!: (value: any) => void; const promise = new Promise(resolvePromise => { resolve = resolvePromise; }); return { promise, resolve }; }
function mount(t: any, component: any, props: any) {
  let vm: any; const events: any[] = [];
  const app = renderer.createApp({ setup() { vm = component.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div'); } });
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({});
  t.after(() => app.unmount()); return { vm, events };
}
function controller(t: any, overrides: any = {}) {
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage };
  const gives: any[] = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { asks: {
    preview: async () => ok({ ask: receiver, unavailable: null }), listModels: async () => ok(models), canGive: async () => true,
    give: async (input: any) => { gives.push(input); return ok({ state: 'active' }); }, cantHelp: async () => ok({}), ...overrides,
  } } }, localStorage: { getItem: () => '20', setItem() {} } });
  t.after(() => Object.assign(globalThis, saved));
  const props = reactive({ token: 'first' }); return { ...mount(t, Give, props), props, gives };
}

test('receiver profile, message and requested quota reach the real giving panel', async t => {
  const { vm } = controller(t); await settle();
  assert.equal(vm.ask.value.asker_avatar_url, receiver.asker_avatar_url);
  assert.equal(vm.initialAmount.value, 15);
  assert.equal(vm.options.value[0].requested, true);
  const html = await renderToString(createSSRApp(Panel, { request: receiver, options: vm.options.value, selected: vm.selected.value, initialAmount: 15 }));
  assert.match(html, /src="https:\/\/avatars.githubusercontent.com\/u\/42"/);
  assert.match(html, /Message<\/p>/);
  assert.match(html, /<blockquote>Please review this\.<\/blockquote>/);
  assert.match(html, /give-secondary[^>]*data-testid="agent-give-cant"/);
  assert.match(html, /value="15"/);
});

test('quota validation prevents invalid submission and provider changes are emitted without giving', async t => {
  const props = reactive({ request: receiver, options: [{ key: 'one', model: models[0], requested: true, canGive: true }], selected: 'one', initialAmount: 10, busy: null });
  const { vm, events } = mount(t, Panel, props);
  await vm.openCustom(); vm.customText.value = '101'; vm.submit();
  assert.equal(vm.amount.value, null); assert.deepEqual(events, []);
  vm.customText.value = '12.5'; vm.submit(); assert.deepEqual(events, []);
  vm.customText.value = '15%'; vm.submit(); assert.deepEqual(events, [['give', 15]]);
  vm.select('two'); assert.deepEqual(events[1], ['update:selected', 'two']);
  Object.assign(props, { busy: 'give' }); vm.submit(); vm.select('one'); assert.equal(events.length, 2);
});

test('giving uses only an available current model, suppresses duplicate submits and preserves offer outcome', async t => {
  const pending = deferred(); const inputs: any[] = [];
  const { vm, events } = controller(t, { give: (input: any) => { inputs.push(input); return pending.promise; } }); await settle();
  vm.selected.value = 'codex:';
  const first = vm.give(20); await vm.give(20); vm.close();
  assert.equal(inputs.length, 1); assert.equal(inputs[0].providerId, 'codex'); assert.equal(inputs[0].amountPercent, 20);
  assert.deepEqual(events, []);
  pending.resolve(ok({ state: 'on_hold' })); await first;
  assert.equal(vm.offered.value, true); assert.match(vm.done.value, /asked to accept Codex/);
  assert.deepEqual(events, [['given', 'Room']]);
});

test('failed give and decline stay open, clear busy state, and allow retry', async t => {
  let calls = 0;
  const { vm, events } = controller(t, { give: async () => ++calls === 1 ? { ok: false, error: 'Could not start this agent.' } : ok({ state: 'active' }), cantHelp: async () => { throw new Error('offline'); } }); await settle();
  await vm.give(10); assert.equal(vm.giveFailed.value, true); assert.equal(vm.busy.value, null); assert.equal(vm.done.value, null);
  await vm.give(10); assert.equal(vm.giveFailed.value, false); assert.match(vm.done.value, /Your agent is in Recipient/);
  await vm.cantHelp(); assert.match(vm.error.value, /Couldn't reach/); assert.equal(vm.busy.value, null); assert.ok(!events.some((event: any[]) => event[0] === 'close'));
});

test('late previews and giving results cannot overwrite a different request', async t => {
  const oldPreview = deferred(), oldGive = deferred();
  const { vm, props, events } = controller(t, { preview: (token: string) => token === 'first' ? oldPreview.promise : Promise.resolve(ok({ ask: { ...receiver, id: token, asker: token }, unavailable: null })), give: () => oldGive.promise });
  props.token = 'second'; await settle(); oldPreview.resolve(ok({ ask: receiver, unavailable: null })); await settle();
  assert.equal(vm.ask.value.asker, 'second');
  const giving = vm.give(10); props.token = 'third'; await settle(); oldGive.resolve(ok({ state: 'active' })); await giving;
  assert.equal(vm.ask.value.asker, 'third'); assert.equal(vm.done.value, null); assert.deepEqual(events, []);
});

test('unsafe/missing receiver images fall back to initials; unavailable agents remain disabled in the picker', async () => {
  const html = await renderToString(createSSRApp(Panel, { request: { ...receiver, asker_avatar_url: 'javascript:alert(1)' }, options: [{ key: 'no', model: models[0], requested: true, canGive: false }], selected: null }));
  assert.doesNotMatch(html, /src="javascript:/); assert.match(html, /aria-label="Recipient"/);
  assert.match(html, /disabled[^>]*data-testid="agent-give-add"/);
  const picker = await renderToString(createSSRApp(Dropdown, { modelValue: 'no', label: 'Agent', options: [{ id: 'no', label: 'Not available', disabled: true }] }));
  assert.match(picker, /role="option"[^>]*disabled/);
});

test('both model pickers find a model by name, provider or id, word by word, and name the provider on each row', async t => {
  const catalog = [{ providerId: 'claude-code', model: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { providerId: 'cursor', model: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5' }, { providerId: 'codex', model: 'gpt-6-astra', label: 'GPT-6-Astra' }];
  const ask = mount(t, AskPanel, reactive({ models: catalog, rooms: [], loading: false }));
  // The dropdown drops its window listeners on unmount; the restore is registered after it, so it runs after.
  const saved = globalThis.window;
  Object.assign(globalThis, { window: { addEventListener() {}, removeEventListener() {} } });
  const { vm } = mount(t, Dropdown, reactive({ modelValue: '0', label: 'Agent', searchable: true, options: ask.vm.modelOptions.value }));
  t.after(() => Object.assign(globalThis, { window: saved }));
  const found = (query: string) => { vm.query.value = query; return vm.visible.value.map((option: any) => catalog[Number(option.id)].providerId); };
  assert.deepEqual(found('opus'), ['claude-code', 'cursor']);
  assert.deepEqual(found('cursor opus'), ['cursor']);
  assert.deepEqual(found('  OPUS   claude code '), ['claude-code']);
  assert.deepEqual(found('gpt-6'), ['codex']);
  assert.deepEqual(found('gemini 9'), []);
  const html = await renderToString(createSSRApp(AskPanel, { models: catalog, rooms: [], loading: false }));
  assert.match(html, /placeholder="Find a model…"/);
  assert.match(html, /Claude Opus 5\.5<small>Cursor<\/small>/);
  assert.match(html, /No matches found\.|role="listbox"/);
  const give = mount(t, Panel, reactive({ request: receiver, options: catalog.map((model, index) => ({ key: String(index), model, requested: index === 1, canGive: true })), selected: '1' }));
  assert.deepEqual(give.vm.dropdownOptions.value.map((option: any) => option.keywords), ['Claude Code claude-opus-5-5', 'Cursor claude-opus-5-5-medium', 'Codex gpt-6-astra']);
  const giving = await renderToString(createSSRApp(Panel, { request: receiver, options: catalog.map((model, index) => ({ key: String(index), model, requested: index === 1, canGive: true })), selected: '1' }));
  assert.match(giving, /placeholder="Find a model…"/);
  assert.match(giving, /GPT-6-Astra<small>Codex<\/small>/);
});

function askController(t: any, overrides: any = {}) {
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage };
  const inputs: any[] = [], rooms: any[] = [];
  Object.assign(globalThis, { window: { letagentsDesktop: {
    asks: { listModels: async () => ok(models), create: async (input: any) => { inputs.push(input); return ok({ ask: { id: 'ask-one' }, link: 'https://letagents.chat/ask/created' }); }, ...overrides.asks },
    room: { createInviteRoom: async () => { rooms.push('created'); return { roomIdentifier: 'new-room' }; }, rename: async () => {}, ...overrides.room },
  } }, localStorage: { getItem: () => '{}', setItem() {} } });
  t.after(() => Object.assign(globalThis, saved));
  const props = reactive({ open: true, roomIdentifier: 'room-one', rooms: [{ roomIdentifier: 'room-one', name: 'Room one', focusRooms: [] }] });
  return { ...mount(t, Ask, props), props, inputs, rooms };
}
const askInput = { roomId: '__new__', newRoomName: 'Review', providerId: 'codex', model: null, amountPercent: null, note: 'Please help.' };

test('Ask shares the Give visual controls and preserves optional Any usage and model presets', async t => {
  const props = reactive({ models, rooms: [{ id: 'room-one', label: 'Room one' }], initialRoom: 'room-one', presetModelLabel: 'Codex', busy: false, loading: false, createdLink: null });
  const { vm, events } = mount(t, AskPanel, props);
  assert.equal(vm.selectedModel.value.providerId, 'codex');
  vm.note.value = 'Review this'; vm.submit();
  assert.deepEqual(events[0], ['create', { ...askInput, roomId: 'room-one', newRoomName: '', note: 'Review this' }]);
  const html = await renderToString(createSSRApp(AskPanel, props));
  assert.match(html, /give-agent-panel ask-agent-panel/);
  assert.match(html, /aria-label="Room: Room one"/);
  assert.match(html, /aria-label="Agent: Codex"/);
  assert.match(html, /harness-icons\/codex\.png/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /Message/);
  await vm.openCustom(); vm.customText.value = '0'; vm.submit();
  vm.customText.value = '101'; vm.submit(); vm.customText.value = '2.5'; vm.submit();
  assert.equal(events.length, 1);
  vm.customText.value = '15'; vm.submit(); assert.equal(events[1][1].amountPercent, 15);
  props.busy = true; vm.submit(); assert.equal(events.length, 2);
  props.busy = false; props.createdLink = 'https://letagents.chat/ask/one'; vm.submit(); assert.equal(events.length, 2);
});

test('Ask reuses a newly created room after failure, suppresses duplicate submits and resets on reopen', async t => {
  const pending = deferred(); let calls = 0;
  const { vm, events, props, rooms } = askController(t, { asks: { create: () => ++calls === 1 ? pending.promise : Promise.resolve(ok({ ask: { id: 'ask-one' }, link: 'https://letagents.chat/ask/one' })) } });
  await settle();
  const first = vm.submit(askInput); await settle(); await vm.submit(askInput); vm.close();
  assert.equal(calls, 1); assert.equal(rooms.length, 1); assert.deepEqual(events, []);
  pending.resolve({ ok: false, error: 'Try again' }); await first;
  assert.equal(vm.busy.value, false); assert.equal(vm.error.value, 'Try again');
  await vm.submit(askInput); assert.equal(rooms.length, 1); assert.equal(vm.created.value.link, 'https://letagents.chat/ask/one');
  assert.deepEqual(events, [['created', 'new-room']]);
  props.open = false; await settle(); props.open = true; await settle();
  assert.equal(vm.createdRoomId.value, null); assert.equal(vm.created.value, null);
});

test('Ask can retry a model load failure and ignores results after closing', async t => {
  let calls = 0; const pending = deferred();
  const { vm, props } = askController(t, { asks: { listModels: () => ++calls === 1 ? Promise.reject(new Error('offline')) : pending.promise } });
  await settle(); assert.match(vm.error.value, /Couldn't load/); assert.equal(vm.loading.value, false);
  const retry = vm.loadModels(); props.open = false; await settle();
  pending.resolve(ok(models)); await retry;
  assert.deepEqual(vm.models.value, []); assert.equal(vm.error.value, null); assert.equal(vm.loading.value, false);
});

test('Ask does not create a request if its room creation finishes after the dialog closes', async t => {
  const pending = deferred();
  const { vm, props, inputs, events } = askController(t, { room: { createInviteRoom: () => pending.promise } });
  await settle(); const creating = vm.submit(askInput); props.open = false; await settle();
  pending.resolve({ roomIdentifier: 'late-room' }); await creating;
  assert.deepEqual(inputs, []); assert.deepEqual(events, []); assert.equal(vm.created.value, null);
});


test('Ask keeps the current room when account rooms are still loading and when the catalog arrives', async t => {
  const props = reactive({ models: [], rooms: [], initialRoom: 'room-one', loading: true });
  const { vm, events } = mount(t, AskPanel, props);
  assert.equal(vm.roomChoice.value, 'room-one');
  Object.assign(props, { rooms: [{ id: 'other', label: 'Other' }, { id: 'room-one', label: 'Current' }], models, loading: false });
  await settle(); vm.submit(); assert.equal(events[0][1].roomId, 'room-one');
  const desktop = askController(t); desktop.props.rooms = []; await settle();
  assert.deepEqual(desktop.vm.roomOptions.value, [{ id: 'room-one', label: 'room-one' }]);
});
