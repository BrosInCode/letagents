import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';
import { createKnowledgeRecord, reviseKnowledgeRecord } from '../../../../shared/room-knowledge.mjs';

let vite: ViteDevServer;
let RoomMemory: any;
const original = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
const author = { id: 'human_1', label: 'Emmy', kind: 'human' as const };
const goal = createKnowledgeRecord('room-a', 'memory', { client_id: 'memory_goal', category: 'goal', title: 'Ship the desktop release', body: 'Keep agent progress understandable.' }, author);
const decision = createKnowledgeRecord('room-a', 'memory', { client_id: 'memory_decision', category: 'decision', title: 'One inbox', body: 'Combine requests across every room.' }, author);
const archived = { ...goal, id: 'memory_archived', title: 'Previous release goal', archived: true };
const renderer = createRenderer<any, any>({
  patchProp() {}, insert(child, parent) { parent.children.push(child); child.parent = parent; }, remove() {},
  createElement: () => ({ children: [] }), createText: () => ({ children: [] }), createComment: () => ({ children: [] }),
  setText() {}, setElementText() {}, parentNode: node => node.parent, nextSibling: () => null,
});
function mount(methods: Record<string, unknown> = {}) {
  Object.assign(globalThis, { window: { letagentsDesktop: { room: { getKnowledge: async () => ({ records: [goal, decision, archived], truncated: false }), ...methods } } }, document: { activeElement: null, body: null }, HTMLElement: class {} });
  const props = reactive({ roomIdentifier: 'room-a' });
  let vm: any;
  const app = renderer.createApp({ setup() { vm = RoomMemory.setup(props, { expose() {}, emit() {} }); return () => h('div'); } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({ children: [] });
  return { vm, props, stop: () => app.unmount() };
}
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  RoomMemory = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/RoomMemoryView.vue')).default;
});
after(async () => { Object.assign(globalThis, original); await vite?.close(); });

test('search matches titles and details across brief sections, preserving saved entries after no matches', async () => {
  const { vm, stop } = mount(); await vm.refresh();
  assert.deepEqual(vm.groups.value.map((g: any) => g.kind), ['goal', 'decision']);
  vm.search.value = '  DESKTOP  ';
  assert.deepEqual(vm.filtered.value.map((r: any) => r.id), [goal.id]);
  vm.search.value = 'across every';
  assert.deepEqual(vm.filtered.value.map((r: any) => r.id), [decision.id]);
  vm.category.value = 'goal';
  assert.equal(vm.filtered.value.length, 0);
  assert.equal(vm.page.value.records.length, 3, 'no results must not replace the saved-memory toolbar with onboarding');
  vm.clearFilters(); await nextTick();
  assert.equal(vm.filtered.value.length, 2);
  stop();
});

test('archive search stays separate from active memories, including an archive-only room', async () => {
  const { vm, stop } = mount({ getKnowledge: async () => ({ records: [archived], truncated: false }) }); await vm.refresh();
  assert.equal(vm.activeCount.value, 0);
  assert.equal(vm.page.value.records.length, 1);
  assert.equal(vm.filtered.value.length, 0);
  vm.showArchived.value = true;
  vm.search.value = 'previous';
  assert.equal(vm.filtered.value[0].id, archived.id);
  vm.search.value = 'missing';
  assert.equal(vm.filtered.value.length, 0);
  assert.equal(vm.showArchived.value, true);
  stop();
});

test('changing rooms clears filters and ignores a late response from the previous room', async () => {
  let complete!: (value: any) => void;
  const oldRoom = new Promise(resolve => { complete = resolve; });
  const { vm, props, stop } = mount({ getKnowledge: (room: string) => room === 'room-a' ? oldRoom : Promise.resolve({ records: [decision], truncated: false }) });
  vm.search.value = 'previous'; vm.category.value = 'goal'; vm.showArchived.value = true;
  props.roomIdentifier = 'room-b'; await nextTick(); await vm.refresh();
  complete({ records: [archived], truncated: false }); await nextTick();
  assert.equal(vm.search.value, ''); assert.equal(vm.category.value, ''); assert.equal(vm.showArchived.value, false);
  assert.equal(vm.filtered.value[0].id, decision.id);
  stop();
});

test('saving after a filtered search reveals the saved memory and preserves version checks', async () => {
  let records = [goal, decision, archived]; let revision: any;
  const { vm, stop } = mount({
    getKnowledge: async () => ({ records, truncated: false }),
    reviseKnowledge: async (_room: string, _type: string, id: string, input: any) => {
      revision = input;
      records = records.map(record => record.id === id ? reviseKnowledgeRecord(record, input, author) : record);
    },
  });
  await vm.refresh(); vm.search.value = 'desktop'; vm.category.value = 'goal'; vm.edit(goal);
  vm.editor.value.input.title = 'Explain work clearly'; vm.editor.value.input.category = 'constraint';
  await vm.save();
  assert.equal(revision.expected_version, goal.version);
  assert.equal(vm.editor.value, null);
  assert.equal(vm.search.value, ''); assert.equal(vm.category.value, '');
  assert.ok(vm.filtered.value.some((r: any) => r.title === 'Explain work clearly'));
  vm.edit(vm.filtered.value.find((r: any) => r.id === goal.id));
  await vm.save(true);
  assert.equal(vm.showArchived.value, true);
  assert.ok(vm.filtered.value.some((r: any) => r.id === goal.id));
  vm.edit(vm.filtered.value.find((r: any) => r.id === goal.id));
  vm.editor.value.input.title = 'Revised archived memory';
  await vm.save();
  assert.equal(vm.showArchived.value, true, 'editing archived content must keep the saved record visible');
  assert.ok(vm.filtered.value.some((r: any) => r.title === 'Revised archived memory'));
  vm.edit(vm.filtered.value.find((r: any) => r.id === goal.id));
  await vm.save(false);
  assert.equal(vm.showArchived.value, false);
  assert.ok(vm.filtered.value.some((r: any) => r.id === goal.id));
  stop();
});


test('failed source links report errors inside history while its background is inert', async () => {
  const { vm, stop } = mount();
  Object.assign(window.letagentsDesktop!, { app: { openExternalUrl: async () => { throw new Error('Unable to open this source.'); } } });
  await vm.refresh();
  vm.edit(goal); vm.historyMode.value = true;
  await vm.openSource('https://letagents.chat');
  assert.equal(vm.editError.value, 'Unable to open this source.');
  assert.equal(vm.error.value, '');
  vm.closeEditor(); await nextTick();
  await vm.openSource('https://letagents.chat');
  assert.equal(vm.error.value, 'Unable to open this source.');
  stop();
});
