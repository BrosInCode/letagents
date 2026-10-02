import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transpileModule, ModuleKind } from 'typescript';
import * as Vue from 'vue';
import { createServer, type ViteDevServer } from 'vite';

// A small host tree executes the actual component's handlers. This is component
// testing; window placement and native keyboard behavior still need live QA.
let focused: Host | null = null;
class Host {
  children: Host[] = []; parent: Host | null = null; props: Record<string, any> = {}; text = ''; isConnected = true;
  constructor(public type = '') { Vue.markRaw(this); }
  focus() { focused = this; }
  contains(child: Host) { return descendants(this).includes(child); }
  querySelectorAll() { return descendants(this).filter(n => n.type === 'button' && !n.props.disabled); }
  querySelector() { return this.querySelectorAll()[0] ?? null; }
  getBoundingClientRect() { return { left: 10, right: 210, top: 20, width: 200, height: 200 }; }
}
const descendants = (node: Host): Host[] => [node, ...node.children.flatMap(descendants)];
const body = new Host('body');
const events = new Map<string, Function>();
const renderer = Vue.createRenderer<Host, Host>({
  patchProp: (node, key, _old, next) => { node.props[key] = next; },
  insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); const i = anchor ? parent.children.indexOf(anchor) : -1; if (i >= 0) parent.children.splice(i, 0, child); else parent.children.push(child); child.parent = parent; },
  remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  createElement: type => new Host(type), createText: text => Object.assign(new Host(), { text }), createComment: text => Object.assign(new Host(), { text }),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  querySelector: () => body,
});
let vite: ViteDevServer, Menu: any, Settings: any, preferences: any, notificationState: any, notificationsMuted: any;
async function loadComponent(path: string) {
  const component = (await vite.ssrLoadModule(path)).default;
  const source = await readFile(fileURLToPath(new URL(`../../${path.slice(1)}`, import.meta.url)), 'utf8');
  const descriptor = parse(source).descriptor;
  const script = compileScript(descriptor, { id: path });
  const template = compileTemplate({ source: descriptor.template!.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const code = transpileModule(template.code, { compilerOptions: { module: ModuleKind.ESNext } }).outputText
    .replace(/import \{([\s\S]*?)\} from "vue";/g, (_all, names: string) => `const {${names.replace(/\s+as\s+/g, ': ')}} = vue;`)
    .replace('export function render', 'function render');
  component.render = Function('vue', code + '\nreturn render;')(Vue);
  return component;
}
before(async () => {
  Object.assign(globalThis, { HTMLElement: Host, document: { get activeElement() { return focused; }, body }, window: { innerWidth: 1200, innerHeight: 800, addEventListener: (name: string, handler: Function) => events.set(name, handler), removeEventListener: (name: string) => events.delete(name) } });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Menu = await loadComponent('/renderer/src/components/desktop/controls/DesktopContextMenu.vue');
  Settings = await loadComponent('/renderer/src/components/desktop/content/room-shell/RoomNotificationSettings.vue');
  const store = await vite.ssrLoadModule('/renderer/src/composables/useRoomNotificationPreferences.ts');
  preferences = store.roomNotificationPreferences;
  notificationState = store.roomNotificationState;
  notificationsMuted = store.roomNotificationsMuted;
});
after(async () => { await vite?.close(); });
const settle = async () => { await Vue.nextTick(); await Vue.nextTick(); };
const byId = (id: string) => descendants(body).find(n => n.props['data-testid'] === `menu-item-${id}`)!;
const key = (node: Host, name: string) => {
  const handlers = node.props.onKeydown ? [node.props.onKeydown].flat() : [];
  for (const handler of handlers) handler({ key: name, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
};
async function mount(groups: any[][]) {
  body.children = []; events.clear(); const invoker = new Host('button'); invoker.focus();
  const selected: string[] = []; let closed = 0;
  const props = Vue.reactive({ itemGroups: groups, position: { x: 10, y: 20 }, testid: 'menu' });
  const app = renderer.createApp({ render: () => Vue.h(Menu, { ...props, onSelect: (item: any) => selected.push(item.id), onClose: () => closed++ }) });
  app.provide(Vue.ssrContextKey, { modules: new Set() }); app.mount(new Host('root')); await settle();
  return { app, props, selected, invoker, closed: () => closed };
}

test('flat menus retain focus movement, disabled items, selection, dismissal and focus return', async () => {
  const m = await mount([[{ id: 'first', label: 'First' }, { id: 'disabled', label: 'Disabled', disabled: true }, { id: 'last', label: 'Last' }]]);
  try {
    assert.equal(focused, byId('first'));
    assert.equal(byId('first').props.role, 'menuitem');
    const menu = descendants(body).find(n => n.props.role === 'menu')!;
    key(menu, 'ArrowDown'); assert.equal(focused, byId('last'));
    key(menu, 'ArrowDown'); assert.equal(focused, byId('first'));
    byId('disabled').props.onClick({ currentTarget: byId('disabled') }); assert.deepEqual(m.selected, []);
    byId('last').props.onClick({ currentTarget: byId('last') }); assert.deepEqual(m.selected, ['last']); assert.equal(m.closed(), 1);
    events.get('keydown')!({ key: 'Escape' }); assert.equal(m.closed(), 2);
  } finally { m.app.unmount(); }
  assert.equal(focused, m.invoker); assert.equal(events.size, 0);
});

test('one-level submenu has checked radio items, opens and closes with focus, and selects a leaf', async () => {
  const m = await mount([[{ id: 'notifications', label: 'Notifications', children: [{ id: 'all', label: 'All', role: 'menuitemradio', checked: true }, { id: 'muted', label: 'Muted', role: 'menuitemradio', checked: false }] }]]);
  try {
    const parent = byId('notifications');
    key(parent, 'ArrowRight'); await settle();
    assert.equal(parent.props['aria-expanded'], true); assert.equal(focused, byId('all'));
    assert.equal(byId('all').props.role, 'menuitemradio'); assert.equal(byId('all').props['aria-checked'], true);
    assert.equal(byId('muted').props['aria-checked'], false);
    let submenu = descendants(body).find(n => n.props['aria-label'] === 'Notifications')!;
    key(submenu, 'ArrowDown'); assert.equal(focused, byId('muted'));
    key(submenu, 'ArrowLeft'); await settle(); assert.equal(focused, parent); assert.equal(m.closed(), 0);
    // Native Enter on a button dispatches its click handler.
    parent.props.onClick({ currentTarget: parent }); await settle();
    events.get('keydown')!({ key: 'Escape', preventDefault() {} }); await settle(); assert.equal(focused, parent); assert.equal(m.closed(), 0);
    parent.props.onClick({ currentTarget: parent }); await settle();
    m.props.itemGroups = [[{ id: 'notifications', label: 'Notifications', children: [{ id: 'all', label: 'All', role: 'menuitemradio', checked: false }, { id: 'muted', label: 'Muted', role: 'menuitemradio', checked: true }] }]];
    await settle(); assert.equal(byId('muted').props['aria-checked'], true, 'async preference updates reach the open submenu');
    byId('muted').props.onClick(); assert.deepEqual(m.selected, ['muted']); assert.equal(m.closed(), 1);
  } finally { m.app.unmount(); }
  assert.equal(focused, m.invoker);
});

const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settleIpc = async () => { await new Promise(resolve => setImmediate(resolve)); await settle(); };

test('actual Settings observes async reads, saved values, busy states and error/retry through the real cache', async () => {
  const reads = [deferred(), deferred(), deferred()], write = deferred();
  const changes: unknown[] = []; let n = 0;
  const bridge = (window as any).letagentsDesktop;
  (window as any).letagentsDesktop = { room: {
    getNotificationPreference: () => reads[n++].promise,
    setNotificationPreference: (_room: string, change: unknown) => { changes.push(change); return write.promise; },
  } };
  preferences.setViewer({ id: 'settings-person', login: 'ada' });
  const root = new Host('root');
  const app = renderer.createApp(Settings, { roomIdentifier: 'r', localOnly: false });
  app.provide(Vue.ssrContextKey, { modules: new Set() }); app.mount(root);
  const selects = () => descendants(root).filter(node => node.type === 'select');
  const alert = () => descendants(root).find(node => node.props.role === 'alert');
  const until = new Date(Date.now() + 3600000).toISOString();
  try {
    await settle();
    assert.equal(selects()[0]!.props.value, 'all');
    assert.ok(selects().every(node => node.props.disabled));
    reads[0].resolve({ room_id: 'r', level: 'muted', snoozed_until: until }); await settleIpc();
    assert.equal(selects()[0]!.props.value, 'muted');
    assert.ok(selects().every(node => !node.props.disabled));
    assert.ok(descendants(root).some(node => node.text.startsWith('Snoozed until')));
    selects()[0]!.props.onChange({ target: { value: 'mentions' } }); await settle();
    assert.deepEqual(changes, [{ level: 'mentions' }]);
    assert.ok(selects().every(node => node.props.disabled));
    write.resolve({ room_id: 'r', level: 'mentions', snoozed_until: until }); await settleIpc();
    assert.equal(selects()[0]!.props.value, 'mentions');
    assert.ok(selects().every(node => !node.props.disabled));
    const failed = preferences.refresh('r'); await settle();
    assert.ok(selects().every(node => node.props.disabled));
    reads[1].reject(new Error('offline')); await failed; await settleIpc();
    assert.equal(selects()[0]!.props.value, 'mentions');
    assert.ok(selects().every(node => !node.props.disabled));
    assert.match(descendants(alert()!).map(node => node.text).join(''), /offline/);
    descendants(alert()!).find(node => node.type === 'button')!.props.onClick(); await settle();
    assert.ok(selects().every(node => node.props.disabled));
    reads[2].resolve({ room_id: 'r', level: 'all', snoozed_until: null }); await settleIpc();
    assert.equal(selects()[0]!.props.value, 'all');
    assert.ok(selects().every(node => !node.props.disabled));
    assert.equal(alert(), undefined);
    assert.ok(!descendants(root).some(node => node.text.startsWith('Snoozed until')));
  } finally { app.unmount(); preferences.setViewer(null); (window as any).letagentsDesktop = bridge; }
});

test('real sidebar entries and the desktop cache share normalized bulk, single and mutation keys', async () => {
  const { buildSidebarProjectGroups } = await vite.ssrLoadModule('/renderer/src/domain/sidebar-rooms.ts');
  const groups = buildSidebarProjectGroups({ currentParentRoom: { id: 'parent', title: 'Repo', roomIdentifier: 'github.com/Owner/Repo', meta: 'Room', kind: 'room' }, accountRooms: [], focusRooms: [] });
  const entry = groups[0].parent;
  assert.equal(entry.roomIdentifier, 'github.com/Owner/Repo');
  const canonical = 'github.com/owner/repo', calls: unknown[] = [];
  const read = deferred(), bridge = (window as any).letagentsDesktop;
  (window as any).letagentsDesktop = { room: {
    listNotificationPreferences: async () => ({ preferences: [{ room_id: canonical, level: 'muted', snoozed_until: null }], truncated: false }),
    getNotificationPreference: (id: string) => { calls.push(['get', id]); return read.promise; },
    setNotificationPreference: async (id: string, change: any) => { calls.push(['put', id, change]); return { room_id: canonical, level: change.level, snoozed_until: null }; },
  } };
  preferences.setViewer({ id: 'sidebar-person', login: 'ada' });
  try {
    // Like the sidebar, access the entry before the sign-in bulk request returns.
    notificationState(entry.roomIdentifier);
    await preferences.refreshAll();
    assert.equal(notificationsMuted(entry.roomIdentifier), true);
    assert.equal(notificationState(entry.roomIdentifier).preference.level, 'muted');
    preferences.setViewer({ id: 'sidebar-person-2', login: 'ada' });
    const pending = preferences.refresh(` ${entry.roomIdentifier} `);
    const held = preferences.allowsAfterRead(canonical, 'hello');
    read.resolve({ room_id: canonical, level: 'muted', snoozed_until: null }); await pending;
    assert.equal(await held, false);
    await preferences.update(entry.roomIdentifier, { level: 'all' });
    assert.equal(notificationsMuted(canonical), false);
    assert.equal(notificationState(entry.roomIdentifier).preference.level, 'all');
    assert.deepEqual(calls, [['get', canonical], ['put', canonical, { level: 'all' }]]);
  } finally { preferences.setViewer(null); (window as any).letagentsDesktop = bridge; }
});
