import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/components/desktop/content/${path}`, import.meta.url)), "utf8");

test("a new room made by a failed ask is reused on retry, and forgotten when the sheet reopens", () => {
  const dialog = source("asks/AskAgentDialog.vue");
  assert.match(dialog, /if \(!createdRoomId\.value\) \{\s*const room = await desktopIpc\.room\.createInviteRoom\(\);/);
  assert.match(dialog, /roomId = createdRoomId\.value;/);
  assert.match(dialog, /createdRoomId\.value = null;/);
});

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
let vite: any, Give: any, Panel: any, Dropdown: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
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
