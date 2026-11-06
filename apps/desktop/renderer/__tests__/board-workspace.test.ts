import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, h, markRaw, nextTick, reactive, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';
import { boardTaskColumn, boardTaskPlanning, defaultBoardPlanning, validateBoardPlanningUpdate, type BoardPlanningDocument, type BoardPlanningSnapshot, type BoardSprint } from '../../../../shared/board-planning.mjs';
import type { BoardTask, BoardServices } from '../../../../shared/ui/board/types';

let vite: ViteDevServer;
let model: typeof import('../../../../shared/ui/board/model');
let useBoardWorkspace: typeof import('../../../../shared/ui/board/useBoardWorkspace').useBoardWorkspace;
let Settings: any, TaskPlanning: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const load = (file: string) => vite.ssrLoadModule(fileURLToPath(new URL(`../../../../shared/ui/board/${file}`, import.meta.url)));
  model = await load('model.ts') as typeof model;
  ({ useBoardWorkspace } = await load('useBoardWorkspace.ts'));
  Settings = (await load('BoardSettings.vue')).default;
  TaskPlanning = (await load('BoardTaskPlanning.vue')).default;
});
after(async () => { await vite?.close(); });

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
function mount<T>(t: any, setup: () => T): T {
  let vm!: T;
  const app = renderer.createApp({ setup() { vm = setup(); return () => h('div'); } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  t.after(() => app.unmount());
  return vm;
}
function component(t: any, definition: any, props: any) {
  return mount<any>(t, () => {
    const vm = definition.setup(props, { expose() {}, emit() {} });
    if (vm.dialog) vm.dialog.value = markRaw({ showModal() {}, close() {} });
    return vm;
  });
}
async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(roomId = 'room-one'): BoardPlanningSnapshot {
  return { roomId, revision: 0, document: defaultBoardPlanning(), imported: { sprints: [], tasks: {} }, taskFacts: [], canEdit: true };
}
function task(id: string, status = 'in_progress'): BoardTask {
  return { id, title: `Task ${id}`, status, assigneeKey: 'agent:brook', assigneeLabel: 'BrookCopper', provider: 'codex', updatedAt: '2026-11-06T12:00:00Z', allowedTransitions: [] };
}
function sprint(state: BoardSprint['state'] = 'active'): BoardSprint {
  return { id: 'sprint-one', name: 'Sprint one', state, startDate: '2026-11-02', endDate: '2026-11-13', goal: null };
}
function services(input: Partial<BoardServices> = {}): BoardServices {
  return { loadPlanning: async () => snapshot(), savePlanning: async (_, document) => ({ ...snapshot(), revision: 1, document }), moveTask: async () => false, openExternal() {}, ...input };
}

test('imported sprint history remains visible until an explicit native override or no-sprint choice', () => {
  const state = snapshot(), item = task('task_1');
  state.imported.tasks[item.id] = { sprintId: 'imported:active', sprintIds: ['imported:closed', 'imported:active'] };
  assert.equal(model.matchesSprint(item, state, 'imported:closed'), true);
  assert.equal(model.matchesSprint(item, state, 'none'), false);
  state.document.tasks[item.id] = { sprintId: 'native-next' };
  assert.equal(model.matchesSprint(item, state, 'imported:active'), false);
  assert.equal(model.matchesSprint(item, state, 'native-next'), true);
  state.document.tasks[item.id] = { sprintId: null };
  assert.equal(model.matchesSprint(item, state, 'none'), true);
  assert.equal(model.matchesSprint(item, state, 'imported:closed'), false);
  assert.equal(model.matchesSprint(item, state, 'all'), true);
});

test('tracker assignee, photo and completion describe the ticket independently of its execution worker', () => {
  const state = snapshot(), item = task('task_1', 'done');
  state.imported.tasks[item.id] = { assigneeId: 'jira:site:person', assigneeName: 'Ada', assigneeAvatarUrl: 'https://avatar.example/ada.png', ticketState: 'in_review', done: false };
  assert.deepEqual(model.taskOwner(item, state), { key: 'jira:site:person', name: 'Ada', provider: null, agent: false, avatarUrl: 'https://avatar.example/ada.png' });
  assert.equal(model.completedTask(item, state), false);
  assert.match(model.taskStoryStatus(item, state), /review/i);
  state.imported.tasks[item.id].done = true;
  item.status = 'proposed';
  assert.equal(model.completedTask(item, state), true);
  delete state.imported.tasks[item.id];
  assert.equal(model.completedTask(item, state), false);
  assert.equal(model.taskOwner(item, state).provider, 'codex');
});

test('16 SP sprint story compares completed estimates with weekday pace, without treating review as done', () => {
  const state = snapshot(), done = task('task_1', 'done'), review = task('task_2', 'proposed');
  state.document.tasks[done.id] = { estimate: 8 };
  state.imported.tasks[review.id] = { estimate: 3, ticketState: 'in_review', done: false };
  const halfway = model.assigneeStories([done, review], [review], state, sprint(), '2026-11-06')[0];
  assert.equal(halfway.target, 16);
  assert.equal(halfway.completed, 8);
  assert.equal(halfway.planned, 11);
  assert.equal(halfway.label, 'On pace');
  assert.match(halfway.summary, /3 SP in review/);
  assert.equal(halfway.items.length, 1, 'a filter changes shown rows, not the complete sprint totals');
  assert.equal(model.assigneeStories([done, review], [review], state, sprint(), '2026-11-09')[0].label, 'Behind pace');
  state.document.tasks[done.id].estimate = 13;
  assert.equal(model.assigneeStories([done], [done], state, sprint(), '2026-11-06')[0].label, 'Close to target');
  state.document.tasks[done.id].estimate = 16;
  assert.equal(model.assigneeStories([done], [done], state, sprint(), '2026-11-13')[0].label, 'Target met');
});

test('unknown estimates stay unknown, zero is estimated, and cancelled work contributes no points', () => {
  const state = snapshot(), zero = task('task_1', 'done'), unknown = task('task_2'), cancelled = task('task_3', 'cancelled');
  state.document.tasks = { task_1: { estimate: 0 }, task_2: { estimate: null }, task_3: { estimate: 100 } };
  const result = model.assigneeStories([zero, unknown, cancelled], [zero, unknown], state, sprint(), '2026-11-06')[0];
  assert.equal(result.unknown, 1);
  assert.equal(result.planned, 0);
  assert.equal(result.label, 'Estimates missing');
  assert.match(result.summary, /1 unestimated/);
  unknown.assigneeKey = null; unknown.assigneeLabel = null;
  assert.equal(model.assigneeStories([unknown], [unknown], state, sprint())[0].hasTarget, false);
});

test('future, closed and all-work stories avoid presenting a completed sprint forecast', () => {
  const state = snapshot(), item = task('task_1');
  state.document.tasks[item.id] = { estimate: 16 };
  const future = model.assigneeStories([item], [item], state, sprint('future'), '2026-11-01')[0];
  assert.equal(future.label, 'Fully planned'); assert.equal(future.value, 16); assert.equal(future.completed, 0); assert.equal(future.pace, null);
  const closed = model.assigneeStories([item], [item], state, sprint('closed'))[0];
  assert.equal(closed.hasTarget, false); assert.match(closed.summary, /no sprint-end snapshot/);
  const all = model.assigneeStories([item], [item], state)[0];
  assert.equal(all.hasTarget, false); assert.equal(all.target, 0); assert.equal(all.label, 'Current work');
  assert.deepEqual(model.sprintClock(sprint(), '2026-11-01'), { total: 10, elapsed: 0, left: 10, fraction: 0 });
  assert.deepEqual(model.sprintClock(sprint(), '2026-11-14'), { total: 10, elapsed: 10, left: 0, fraction: 1 });
});

test('settings retain an edited draft but refuse to save it against a refreshed revision', async t => {
  let writes = 0;
  const props = reactive({ open: true, snapshot: snapshot(), save: async () => { writes++; return true; } });
  const vm = component(t, Settings, props);
  await settle(); vm.draft.value.defaultTargetPoints = 24;
  props.snapshot = { ...snapshot(), revision: 1 };
  await settle(); await vm.submit();
  assert.equal(writes, 0);
  assert.equal(vm.draft.value.defaultTargetPoints, 24);
  assert.match(vm.error.value, /changed while you were editing/);
});

test('removing a populated column moves its cards and state coverage without changing tasks', async t => {
  const state = snapshot();
  state.taskFacts = ['in_review', 'in_review', 'done'].map((status, i) => ({ id: `task_${i + 1}`, title: `Task ${i}`, status, assignee: null, assigneeAgentKey: null, provider: null, prUrl: null, externalRef: null, ticketUrl: null, updatedAt: '' }));
  state.document.columns.push({ id: 'testing', name: 'Testing', statuses: ['in_review'] });
  state.document.tasks.task_2 = { columnId: 'testing', estimate: 3 };
  const before = structuredClone(state.taskFacts);
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle(); vm.removing.value = 'review'; vm.destination.value = 'todo'; vm.removeColumn();
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[0]), 'todo');
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[1]), 'testing');
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[2]), 'done');
  assert.deepEqual(state.taskFacts, before);
  assert.equal(vm.draft.value.tasks.task_2.estimate, 3);
  assert.doesNotThrow(() => validateBoardPlanningUpdate({ expectedRevision: 0, document: vm.draft.value }));
});

test('editing only priority preserves imported planning so a later tracker estimate still updates', async t => {
  const state = snapshot();
  state.imported.tasks.task_1 = { sprintId: 'imported:one', estimate: 3 };
  const writes: BoardPlanningDocument[] = [];
  const props = reactive({ taskId: 'task_1', snapshot: state, save: async (document: BoardPlanningDocument) => {
    writes.push(document); props.snapshot = { ...props.snapshot, revision: props.snapshot.revision + 1, document }; return true;
  } });
  const vm = component(t, TaskPlanning, props);
  vm.priority.value = 'high'; await vm.submit();
  assert.deepEqual(writes[0].tasks.task_1, { priority: 'high' });
  props.snapshot = { ...props.snapshot, imported: { sprints: [], tasks: { task_1: { sprintId: 'imported:two', estimate: 8 } } } };
  await settle();
  assert.equal(vm.estimate.value, 8); assert.equal(vm.sprintId.value, 'imported:two');
  assert.equal(boardTaskPlanning(props.snapshot, 'task_1').estimate, 8);
});

test('task planning draft also refuses a stale revision without invoking persistence', async t => {
  let writes = 0;
  const props = reactive({ taskId: 'task_1', snapshot: snapshot(), save: async () => { writes++; return true; } });
  const vm = component(t, TaskPlanning, props);
  vm.estimate.value = 8;
  props.snapshot = { ...snapshot(), revision: 1 }; await settle(); await vm.submit();
  assert.equal(writes, 0); assert.equal(vm.estimate.value, 8); assert.match(vm.error.value, /changed while you were editing/);
});

test('a load for a previous room cannot overwrite the newly selected room', async t => {
  const first = deferred<BoardPlanningSnapshot>(), second = deferred<BoardPlanningSnapshot>();
  const props = reactive({ roomId: 'first', tasks: [] as BoardTask[], services: services({ loadPlanning: () => props.roomId === 'first' ? first.promise : second.promise }) });
  const vm = mount(t, () => useBoardWorkspace(props));
  props.roomId = 'second'; await settle();
  second.resolve(snapshot('second')); await settle();
  first.resolve(snapshot('first')); await settle();
  assert.equal(vm.snapshot.value?.roomId, 'second'); assert.equal(vm.loading.value, false);
});

test('a save finishing after room navigation cannot overwrite new data or show the old error', async t => {
  const pending = deferred<BoardPlanningSnapshot>();
  const props = reactive({ roomId: 'first', tasks: [] as BoardTask[], services: services({ loadPlanning: async () => snapshot(props.roomId), savePlanning: () => pending.promise }) });
  const vm = mount(t, () => useBoardWorkspace(props)); await settle();
  const save = vm.save(defaultBoardPlanning());
  props.roomId = 'second'; await settle();
  pending.reject(new Error('old room conflict'));
  assert.equal(await save, false);
  assert.equal(vm.snapshot.value?.roomId, 'second'); assert.equal(vm.saving.value, false); assert.equal(vm.error.value, '');
});

test('refresh during a save cannot displace the saved revision or start a stale request', async t => {
  const pending = deferred<BoardPlanningSnapshot>(); let reads = 0;
  const props = reactive({ roomId: 'room-one', tasks: [] as BoardTask[], services: services({ loadPlanning: async () => { reads++; return snapshot(); }, savePlanning: () => pending.promise }) });
  const vm = mount(t, () => useBoardWorkspace(props)); await settle();
  const save = vm.save(defaultBoardPlanning());
  assert.equal(await vm.load(), false); assert.equal(reads, 1);
  pending.resolve({ ...snapshot(), revision: 1 }); assert.equal(await save, true);
  assert.equal(vm.snapshot.value?.revision, 1); assert.equal(vm.saving.value, false);
});

test('newer complete facts include off-screen finished work and revoke stale task actions', async t => {
  const state = snapshot();
  state.taskFacts = [1, 2].map(number => ({ id: `task_${number}`, title: `Finished ${number}`, status: 'done', assignee: 'BrookCopper', assigneeAgentKey: 'agent:brook', provider: 'codex', prUrl: `https://github.com/example/repo/pull/${number}`, externalRef: null, ticketUrl: null, updatedAt: '2026-11-06T13:00:00Z' }));
  const loaded = task('task_1'); loaded.allowedTransitions = [{ id: 'submit', label: 'Submit', targetStatus: 'in_review' }];
  const props = reactive({ roomId: 'room-one', tasks: [loaded], services: services({ loadPlanning: async () => state }) });
  const vm = mount(t, () => useBoardWorkspace(props)); await settle();
  assert.equal(vm.allTasks.value.length, 2);
  assert.equal(vm.allTasks.value[0].status, 'done'); assert.deepEqual(vm.allTasks.value[0].allowedTransitions, []);
  assert.equal(vm.allTasks.value[1].provider, 'codex'); assert.equal(vm.allTasks.value[1].pr?.number, 2);
});

test('stale imported sprint metadata never presents a pace or target claim', () => {
  const state = snapshot(), item = task('task_1', 'done');
  state.document.tasks[item.id] = { estimate: 16 };
  const imported = { ...sprint(), source: { provider: 'jira', id: '42', connectionId: 'site-one', stale: true, checkedAt: '2026-10-01T00:00:00Z' } };
  const result = model.assigneeStories([item], [item], state, imported, '2026-11-06')[0];
  assert.equal(result.hasTarget, false);
  assert.equal(result.pace, null);
  assert.notEqual(result.label, 'Target met');
});

test('identical tracker names on different sites remain separate sprint stories', () => {
  const state = snapshot(), first = task('task_1'), second = task('task_2'), native = task('task_3');
  first.assigneeLabel = second.assigneeLabel = native.assigneeLabel = 'Ada';
  state.imported.tasks = {
    task_1: { assigneeId: 'jira:site-one:ada', assigneeName: 'Ada', estimate: 3 },
    task_2: { assigneeId: 'jira:site-two:ada', assigneeName: 'Ada', estimate: 8 },
  };
  const stories = model.assigneeStories([first, second, native], [first, second, native], state, sprint());
  assert.equal(stories.length, 3);
  assert.deepEqual(stories.map(story => story.key).sort(), ['agent:brook', 'jira:site-one:ada', 'jira:site-two:ada']);
  assert.equal(stories.find(story => story.key === 'jira:site-one:ada')?.planned, 3);
  assert.equal(stories.find(story => story.key === 'jira:site-two:ada')?.planned, 8);
  assert.equal(stories.find(story => story.key === 'agent:brook')?.owner.agent, true);
});
