import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';

interface Node {
  type: string; text: string; props: Record<string, any>; children: Node[]; parent: Node | null;
  value: string; focus(): void; setSelectionRange(start: number, end: number): void;
  addEventListener(): void; removeEventListener(): void; getRootNode(): { activeElement: Node | null };
  querySelector(selector: string): Node | null; querySelectorAll(selector: string): Node[];
  dataset: Record<string, string>; clientWidth: number; scrollTop: number; open: boolean;
}
let focused: Node | null = null;
let selection: [number, number] | null = null;
function node(type = '', text = ''): Node {
  const result: Node = { type, text, props: {}, children: [], parent: null, value: '', dataset: {}, clientWidth: 1000, scrollTop: 0, open: false,
    focus() { focused = result; }, setSelectionRange(start, end) { selection = [start, end]; },
    addEventListener() {}, removeEventListener() {}, getRootNode() { return { activeElement: focused }; },
    querySelector(selector) { return result.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return result.children.flatMap(nodes).filter(item => matches(item, selector)); },
  };
  return result;
}
function matches(node: Node, selector: string) {
  if (selector.startsWith('.')) return String(node.props.class || '').split(' ').includes(selector.slice(1));
  if (selector.startsWith('[')) return [...selector.matchAll(/\[([^=]+)="([^"]+)"\]/g)].every(([, key, value]) => String(node.props[key!]) === value);
  return node.type === selector;
}
const renderer = createRenderer<Node, Node>({
  patchProp(node, key, _before, value) { node.props[key] = value; if (key === 'value') node.value = value as string; if (key === 'data-inbox-key') node.dataset.inboxKey = value as string; },
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child); child.parent = parent;
  },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  createElement: type => node(type), createText: text => node('', text), createComment: text => node('', text),
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.children = []; node.text = text; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
});
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
const text = (node: Node): string => node.text + node.children.map(text).join('');
let vite: ViteDevServer, Response: any, Layout: any;
const originalDocument = globalThis.document;
before(async () => {
  Object.assign(globalThis, { document: { addEventListener() {}, removeEventListener() {} } });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Response = await loadComponent('InboxResponse'); Layout = await loadComponent('InboxLayout');
});
async function loadComponent(name: string) {
  const path = fileURLToPath(new URL(`../../../../shared/ui/inbox/${name}.vue`, import.meta.url));
  const component = (await vite.ssrLoadModule(path)).default;
  const descriptor = parse(await readFile(path, 'utf8'), { filename: path }).descriptor;
  const script = compileScript(descriptor, { id: path });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(compiled.errors, []);
  const code = compiled.code.replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ': ')}} = vue\n`).replace('export function render', 'function render');
  component.render = Function('vue', `${code}\nreturn render;`)(Vue); return component;
}
after(async () => { await vite?.close(); if (originalDocument) globalThis.document = originalDocument; else Reflect.deleteProperty(globalThis, 'document'); });
function mount(t: TestContext, options: Partial<{ id: string; modelValue: string | undefined; suggestion: string; disabled: boolean }> = {}) {
  const props = reactive({ id: 'first', modelValue: undefined as string | undefined, suggestion: 'Use the existing auth flow.', disabled: false, recipient: 'CopperRidge', ...options });
  const events: string[] = [];
  const root = node('root');
  const app = renderer.createApp(() => h(Response, { ...props, 'onUpdate:modelValue': (value: string) => { props.modelValue = value; }, onSubmit: () => events.push('submit'), onClose: () => events.push('close') }));
  app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); t.after(() => app.unmount());
  const textarea = () => nodes(root).find(node => node.type === 'textarea')!;
  const button = (label: string) => nodes(root).find(node => node.type === 'button' && text(node) === label)!;
  const form = () => nodes(root).find(node => node.type === 'form')!;
  const type = async (value: string) => { const input = textarea(); input.value = value; input.props.onInput({ target: input }); await nextTick(); };
  const key = async (name: string, modifiers: Record<string, boolean> = {}) => {
    let prevented = false;
    textarea().props.onKeydown({ key: name, target: textarea(), preventDefault() { prevented = true; }, stopPropagation() {}, ...modifiers });
    await nextTick(); return prevented;
  };
  return { props, events, root, textarea, button, form, type, key };
}

test('a ghost response is only a placeholder and cannot be submitted before acceptance', async t => {
  const { textarea, button, form, events, key } = mount(t);
  assert.equal(textarea().props.value, '');
  assert.equal(textarea().props.placeholder, 'Use the existing auth flow.');
  assert.equal(button('Send response').props.disabled, true);
  form().props.onSubmit({ preventDefault() {} });
  await key('Enter', { metaKey: true });
  assert.deepEqual(events, []);
});

test('Tab accepts once, preserves focus and then returns to normal keyboard navigation', async t => {
  const { props, textarea, button, key, form, events } = mount(t);
  assert.equal(await key('Tab'), true);
  assert.equal(props.modelValue, props.suggestion);
  assert.equal(focused, textarea());
  assert.deepEqual(selection, [props.suggestion.length, props.suggestion.length]);
  assert.equal(button('Send response').props.disabled, false);
  assert.equal(await key('Tab'), false);
  assert.deepEqual(events, [], 'acceptance never sends');
  form().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(events, ['submit']);
});

test('modified Tab and composition leave the suggestion unaccepted', async t => {
  const { props, key } = mount(t);
  for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey', 'isComposing']) assert.equal(await key('Tab', { [modifier]: true }), false);
  assert.equal(props.modelValue, undefined);
});

test('typing, deleting and Escape dismiss suggestions without resurrecting an intentionally empty draft', async t => {
  const { props, textarea, button, type, key } = mount(t);
  await type('My own decision');
  assert.equal(await key('Tab'), false);
  await type('');
  assert.equal(props.modelValue, '');
  assert.notEqual(textarea().props.placeholder, props.suggestion);
  assert.equal(button('Send response').props.disabled, true);
  props.id = 'second'; props.modelValue = undefined; await nextTick();
  assert.equal(await key('Escape'), true);
  assert.equal(props.modelValue, '');
  assert.equal(await key('Tab'), false);
  props.id = 'first'; props.modelValue = ''; await nextTick();
  assert.notEqual(textarea().props.placeholder, props.suggestion);
});

test('pointer acceptance uses the same explicit action and disabled requests ignore shortcuts', async t => {
  const { props, root, events, key } = mount(t);
  const accept = nodes(root).find(node => node.props['aria-label'] === 'Accept suggested response')!;
  await accept.props.onClick(); await nextTick();
  assert.equal(props.modelValue, props.suggestion);
  assert.deepEqual(events, []);
  props.disabled = true; await nextTick();
  await key('Enter', { ctrlKey: true });
  assert.deepEqual(events, []);
});

test('closing is confirmed separately and never submits a typed response', async t => {
  const { button, type, events, props, root } = mount(t);
  await type('A draft that must not be sent.');
  await button('Close without answering').props.onClick(); await nextTick();
  assert.deepEqual(events, []);
  assert.equal(focused, button('Keep open'));
  button('Close request').props.onClick();
  assert.deepEqual(events, ['close']);
  props.id = 'next'; await nextTick();
  assert.ok(!nodes(root).some(node => node.type === 'button' && text(node) === 'Close request'));
});

test('whitespace drafts and suggestions above the input limit cannot become accidental sends', async t => {
  const { props, textarea, form, key, events, type } = mount(t, { suggestion: 'x'.repeat(8001) });
  assert.notEqual(textarea().props.placeholder, props.suggestion);
  assert.equal(await key('Tab'), false);
  await type('   '); form().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(events, []);
});

function mountLayout(t: TestContext) {
  const props = reactive({ section: 'needs-you', counts: { 'needs-you': 2, updates: 1, answered: 0 }, updatesLoaded: true, loading: false,
    items: [{ key: 'one', title: 'First request', actor: 'Copper', roomName: 'Project' }, { key: 'two', title: 'Second request', actor: 'Stone', roomName: 'Project' }],
    selectedKey: 'one', rooms: [{ id: 'project', label: 'Project' }, { id: 'notes', label: 'Notes' }], selectedRooms: [] as string[], query: '' });
  const root = node('root');
  const app = renderer.createApp(() => h(Layout, { ...props,
    'onUpdate:section': (section: string) => { props.section = section; },
    'onUpdate:rooms': (rooms: string[]) => { props.selectedRooms = rooms; },
    'onUpdate:query': (query: string) => { props.query = query; },
    onSelect: (key: string) => { props.selectedKey = key; },
  }, { detail: () => h('h2', { tabindex: -1 }, props.selectedKey) }));
  app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); t.after(() => app.unmount());
  const byClass = (name: string) => nodes(root).find(item => matches(item, `.${name}`))!;
  const row = (key: string) => nodes(root).find(item => item.props['data-inbox-key'] === key)!;
  const tab = (name: string) => nodes(root).find(item => item.props.role === 'tab' && text(item).startsWith(name))!;
  const press = async (node: Node, key: string) => { let prevented = false; await node.props.onKeydown({ key, target: node, preventDefault() { prevented = true; } }); await nextTick(); return prevented; };
  return { root, props, byClass, row, tab, press };
}

test('narrow queue opens one detail and Back returns focus without losing its reading position', async t => {
  const { root, props, byClass, row } = mountLayout(t);
  byClass('inbox-layout').clientWidth = 600;
  await row('one').props.onClick(); await nextTick();
  assert.match(byClass('inbox-workspace').props.class, /inbox-show-detail/);
  assert.equal(focused?.type, 'h2');
  byClass('inbox-detail-pane').scrollTop = 240;
  await byClass('inbox-mobile-back').props.onClick(); await nextTick();
  assert.doesNotMatch(byClass('inbox-workspace').props.class, /inbox-show-detail/);
  assert.equal(focused, row('one'));
  await row('one').props.onClick(); await nextTick();
  assert.equal(byClass('inbox-detail-pane').scrollTop, 240, 'reopening the same item keeps its position');
  props.items.push({ key: 'arrival', title: 'Incoming request', actor: 'New agent', roomName: 'Project' }); await nextTick();
  assert.equal(props.selectedKey, 'one');
  assert.equal(byClass('inbox-detail-pane').scrollTop, 240, 'a new item leaves the open detail still');
  await row('two').props.onClick(); await nextTick();
  assert.equal(props.selectedKey, 'two');
  assert.equal(byClass('inbox-detail-pane').scrollTop, 0, 'a different item starts at the top');
  assert.ok(nodes(root).some(item => item.type === 'h2' && text(item) === 'two'));
});

test('arrow-key queue selection resets only the new detail and leaves focus in the list', async t => {
  const { props, row, byClass } = mountLayout(t);
  byClass('inbox-detail-pane').scrollTop = 250;
  byClass('inbox-queue').props.onKeydown({ key: 'ArrowDown', target: row('one'), preventDefault() {} });
  await nextTick(); await nextTick();
  assert.equal(props.selectedKey, 'two'); assert.equal(focused, row('two'));
  assert.equal(byClass('inbox-detail-pane').scrollTop, 0);
});

test('tabs use one keyboard stop and arrow/Home/End navigation', async t => {
  const { props, tab, press, byClass } = mountLayout(t);
  assert.equal(tab('Needs you').props.tabindex, 0); assert.equal(tab('Updates').props.tabindex, -1);
  assert.equal(await press(tab('Needs you'), 'ArrowRight'), true);
  assert.equal(props.section, 'updates'); assert.equal(focused, tab('Updates'));
  assert.equal(tab('Updates').props['aria-selected'], true);
  await press(tab('Updates'), 'End'); assert.equal(props.section, 'answered');
  await press(tab('Answered'), 'Home'); assert.equal(props.section, 'needs-you');
  assert.doesNotMatch(byClass('inbox-workspace').props.class, /inbox-show-detail/);
});

test('room selections can be combined or cleared and return the narrow layout to its queue', async t => {
  const { root, props, byClass, row } = mountLayout(t);
  await row('one').props.onClick();
  const option = (label: string) => nodes(root).find(item => matches(item, '.inbox-room-option') && text(item).startsWith(label))!;
  option('Project').props.onClick(); await nextTick();
  assert.deepEqual(props.selectedRooms, ['project']);
  assert.doesNotMatch(byClass('inbox-workspace').props.class, /inbox-show-detail/);
  option('Notes').props.onClick(); await nextTick(); assert.deepEqual(props.selectedRooms, ['project', 'notes']);
  option('All rooms').props.onClick(); await nextTick(); assert.deepEqual(props.selectedRooms, []);
  assert.equal(option('All rooms').props['aria-pressed'], true);
});
