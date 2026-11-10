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
let Settings: any, TaskPlanning: any, ReleaseWidget: any, ReleaseList: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const load = (file: string) => vite.ssrLoadModule(fileURLToPath(new URL(`../../../../shared/ui/board/${file}`, import.meta.url)));
  model = await load('model.ts') as typeof model;
  ({ useBoardWorkspace } = await load('useBoardWorkspace.ts'));
  Settings = (await load('BoardSettings.vue')).default;
  TaskPlanning = (await load('BoardTaskPlanning.vue')).default;
  ReleaseWidget = (await load('ReleaseQueueWidget.vue')).default;
  ReleaseList = (await load('ReleaseQueue.vue')).default;
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
    if (vm.dialog) vm.dialog.value = markRaw({ showModal() {}, close() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
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

test('release widget fences room changes, accepts canonical aliases, and retains data after refresh errors', async t => {
  const originalDocument = globalThis.document;
  (globalThis as any).document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const old = deferred<BoardPlanningSnapshot>(), current = deferred<BoardPlanningSnapshot>();
  const props = reactive({ roomId: 'old-room', load: () => old.promise, openExternal() {} });
  const vm = component(t, ReleaseWidget, props);
  t.after(() => { (globalThis as any).document = originalDocument; });
  props.roomId = 'local-alias'; props.load = () => current.promise;
  await settle();
  const state = snapshot('canonical-cloud-room'); state.document.releaseRule = { kind: 'column', columnId: 'done' };
  state.releases = { sources: [], items: [], unavailable: 0 };
  current.resolve(state); await settle();
  assert.equal(vm.snapshot.value.roomId, 'canonical-cloud-room');
  old.resolve(snapshot('old-room')); await settle();
  assert.equal(vm.snapshot.value.roomId, 'canonical-cloud-room');
  props.load = async () => { throw new Error('offline'); };
  await vm.refresh(); assert.match(vm.error.value, /last loaded/);
  assert.equal(vm.snapshot.value.roomId, 'canonical-cloud-room');
  vm.show(); await settle();
  props.load = async () => snapshot('canonical-cloud-room'); await vm.refresh();
  assert.equal(vm.open.value, false, 'disabling the rule closes the open panel');
});

test('release rows distinguish recorded draft and failed PRs from merged work without inventing a release state', t => {
  const vm = component(t, ReleaseList, { items: [], unavailable: 0, description: '' });
  const item = { taskId: 'task_1', title: 'Release work', owner: null, ticketKey: null, ticketUrl: null, checkedAt: null,
    pullRequests: [{ url: 'https://github.com/acme/app/pull/7', state: 'draft', draft: null, merged: null, check_summary: { failure: 1 } }] };
  assert.deepEqual(vm.exceptions(item), ['Checks failed', 'Draft PR']);
  item.pullRequests[0].state = 'merged'; item.pullRequests[0].check_summary.failure = 0;
  assert.deepEqual(vm.exceptions(item), []);
  assert.deepEqual(vm.exceptions({ ...item, pullRequests: [] }), ['No PR linked']);
});

test('removing the release column turns the queue off and cancelling settings keeps the saved rule', async t => {
  const state = snapshot(); state.document.releaseRule = { kind: 'column', columnId: 'review' };
  const props = reactive({ open: true, snapshot: state, save: async () => true });
  const vm = component(t, Settings, props); await settle();
  vm.removing.value = 'review'; vm.destination.value = 'progress'; vm.removeColumn();
  assert.equal(vm.draft.value.releaseRule, null);
  assert.deepEqual(state.document.releaseRule, { kind: 'column', columnId: 'review' });
  props.open = false; await settle(); props.open = true; await settle();
  assert.deepEqual(vm.draft.value.releaseRule, state.document.releaseRule);
});

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

test('removing a column respects the visible fallback after a task lifecycle change', async t => {
  const state = snapshot();
  state.taskFacts = [{ id: 'task_1', title: 'Task', status: 'accepted', assignee: null, assigneeAgentKey: null, provider: null, prUrl: null, externalRef: null, ticketUrl: null, updatedAt: '' }];
  state.document.tasks.task_1 = { columnId: 'progress', estimate: 3 };
  state.document.columns.push({ id: 'another-todo', name: 'Other accepted', statuses: ['accepted'] }, { id: 'destination', name: 'Destination', statuses: ['in_progress'] });
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle(); vm.removing.value = 'todo'; vm.destination.value = 'destination'; vm.removeColumn();
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[0]), 'destination');
  assert.equal(state.taskFacts[0].status, 'accepted');
  assert.equal(vm.draft.value.tasks.task_1.estimate, 3);
});

test('settings add a column from its name without changing task states or requiring a new mapping', async t => {
  const state = snapshot();
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle(); vm.startAdd(); vm.columnName.value = ' Ready for testing '; vm.addColumn();
  const added = vm.draft.value.columns.at(-1);
  assert.equal(added.name, 'Ready for testing');
  assert.deepEqual(added.statuses, ['in_progress']);
  assert.equal(vm.adding.value, false);
  assert.equal(vm.dirty.value, true);
  assert.doesNotThrow(() => validateBoardPlanningUpdate({ expectedRevision: 0, document: vm.draft.value }));
  vm.columnName.value = 'ready FOR testing'; vm.addColumn();
  assert.equal(vm.draft.value.columns.length, state.document.columns.length + 1);
  assert.match(vm.error.value, /already exists/);
  await settle();
});

test('settings rename restores an empty or cancelled name and keyboard reorder preserves column mappings', async t => {
  const state = snapshot();
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle();
  const column = vm.draft.value.columns[0], original = column.name, statuses = [...column.statuses];
  vm.startRename(column); column.name = ''; vm.finishRename(column);
  assert.equal(column.name, original);
  vm.startRename(column); column.name = 'Not saved'; vm.cancelRename(column);
  assert.equal(column.name, original);
  vm.shift(0, -1, true);
  assert.equal(vm.draft.value.columns[0].id, column.id);
  vm.shift(0, 1, true);
  assert.equal(vm.draft.value.columns[1].id, column.id);
  assert.deepEqual(vm.draft.value.columns[1].statuses, statuses);
  assert.equal(vm.keyboard.value, true);
  assert.match(vm.announcement.value, /position 2/);
  await settle();
});

test('column pointer drag commits the draft order only after a drag and can be cancelled', async t => {
  const vm = component(t, Settings, reactive({ open: true, snapshot: snapshot(), save: async () => true }));
  await settle();
  const before = vm.draft.value.columns.map((column: any) => column.id);
  let captured = false;
  const target = { setPointerCapture() { captured = true; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; } };
  vm.beginDrag({ button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, currentTarget: target }, before[0]);
  vm.moveDrag({ pointerId: 1, clientX: 0, clientY: 3 });
  vm.endDrag({ pointerId: 1 });
  assert.deepEqual(vm.draft.value.columns.map((column: any) => column.id), before);
  vm.beginDrag({ button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, currentTarget: target }, before[0]);
  vm.moveDrag({ pointerId: 1, clientX: 0, clientY: 100 });
  vm.cancelDrag();
  assert.deepEqual(vm.draft.value.columns.map((column: any) => column.id), before);
  vm.beginDrag({ button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, currentTarget: target }, before[0]);
  vm.moveDrag({ pointerId: 1, clientX: 0, clientY: 100 });
  vm.endDrag({ pointerId: 1 });
  assert.deepEqual(vm.draft.value.columns.map((column: any) => column.id), [...before.slice(1), before[0]]);
  assert.equal(captured, false);
  await settle();
});

test('reordering a name-only column preserves implicit cards and explicit placements', async t => {
  const state = snapshot();
  state.taskFacts = ['in_progress', 'in_progress', 'blocked', 'proposed'].map((status, i) => ({ id: `task_${i + 1}`, title: `Task ${i}`, status, assignee: null, assigneeAgentKey: null, provider: null, prUrl: null, externalRef: null, ticketUrl: null, updatedAt: '' }));
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle(); vm.columnName.value = 'Verification'; vm.addColumn();
  const added = vm.draft.value.columns.at(-1);
  vm.draft.value.tasks.task_2 = { columnId: added.id, estimate: 5 };
  vm.draft.value.tasks.task_1 = { estimate: 3 };
  const before = state.taskFacts.map(task => boardTaskColumn(vm.draft.value, task));
  // Keyboard path moves the new lane ahead of the original In progress lane.
  vm.shift(4, -1, true); vm.shift(3, -1, true); vm.shift(2, -1, true);
  assert.deepEqual(state.taskFacts.map(task => boardTaskColumn(vm.draft.value, task)), before);
  assert.deepEqual(vm.draft.value.tasks.task_1, { estimate: 3, columnId: 'progress' });
  assert.deepEqual(vm.draft.value.tasks.task_2, { estimate: 5, columnId: added.id });
  assert.equal(vm.draft.value.tasks.task_3, undefined, 'unaffected work does not need an override');
  assert.equal(vm.draft.value.tasks.task_4, undefined, 'proposed work stays outside columns');
  // Board header and pointer paths use the same placement-preserving replacement.
  model.replaceBoardColumns(vm.draft.value, [...vm.draft.value.columns].reverse(), state.taskFacts);
  assert.deepEqual(state.taskFacts.map(task => boardTaskColumn(vm.draft.value, task)), before);
  assert.deepEqual(state.taskFacts.map(task => task.status), ['in_progress', 'in_progress', 'blocked', 'proposed']);
  assert.doesNotThrow(() => validateBoardPlanningUpdate({ expectedRevision: 0, document: vm.draft.value }));
  await settle();
});

test('removing an overlapping empty column does not pull unrelated cards into its destination', async t => {
  const state = snapshot();
  state.document.columns.push({ id: 'verification', name: 'Verification', statuses: ['in_progress'] });
  state.taskFacts = [{ id: 'task_1', title: 'Task', status: 'in_progress', assignee: null, assigneeAgentKey: null, provider: null, prUrl: null, externalRef: null, ticketUrl: null, updatedAt: '' }];
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle(); vm.removing.value = 'verification'; vm.destination.value = 'todo'; vm.removeColumn();
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[0]), 'progress');
  assert.equal(state.taskFacts[0].status, 'in_progress');
  assert.doesNotThrow(() => validateBoardPlanningUpdate({ expectedRevision: 0, document: vm.draft.value }));
  await settle();
});

test('removing a populated overlapping column honors the chosen destination without relocating other cards', async t => {
  const state = snapshot();
  state.document.columns.push({ id: 'qa', name: 'QA', statuses: ['in_progress'] });
  state.taskFacts = ['in_progress', 'in_progress', 'accepted', 'proposed'].map((status, i) => ({ id: `task_${i + 1}`, title: `Task ${i}`, status, assignee: null, assigneeAgentKey: null, provider: null, prUrl: null, externalRef: null, ticketUrl: null, updatedAt: '' }));
  state.document.tasks = { task_1: { columnId: 'qa', estimate: 5 }, task_3: { columnId: 'qa' }, task_4: { columnId: 'qa' } };
  const before = structuredClone(state.taskFacts);
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => true }));
  await settle(); vm.removing.value = 'qa'; vm.destination.value = 'todo'; vm.removeColumn();
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[0]), 'todo', 'the QA card goes to the chosen destination');
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[1]), 'progress', 'unrelated work stays in Progress');
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[2]), 'todo', 'stale QA metadata does not move accepted work');
  assert.equal(boardTaskColumn(vm.draft.value, state.taskFacts[3]), null, 'proposed work remains outside the columns');
  assert.deepEqual(vm.draft.value.tasks.task_1, { columnId: 'todo', estimate: 5 });
  assert.deepEqual(state.taskFacts, before);
  assert.doesNotThrow(() => validateBoardPlanningUpdate({ expectedRevision: 0, document: vm.draft.value }));
  await settle();
});

test('the add-column transition focuses its newly mounted control, and never focuses a closed dialog', async t => {
  const props = reactive({ open: true, snapshot: snapshot(), save: async () => true });
  const vm = component(t, Settings, props);
  await settle(); let focused = '';
  vm.dialog.value = markRaw({ showModal() {}, close() {}, querySelector(selector: string) { return { focus() { focused = selector; } }; } });
  vm.adding.value = true; vm.focusAddControl(); await settle();
  assert.match(focused, /-new-column/);
  vm.adding.value = false; vm.focusAddControl(); await settle();
  assert.match(focused, /-add-column/);
  focused = ''; props.open = false; vm.focusAddControl(); await settle();
  assert.equal(focused, '');
});

test('read-only settings refuse draft mutations and persistence', async t => {
  let writes = 0;
  const state = snapshot(); state.canEdit = false;
  const vm = component(t, Settings, reactive({ open: true, snapshot: state, save: async () => { writes++; return true; } }));
  await settle(); const before = structuredClone(state.document);
  vm.columnName.value = 'Testing'; vm.addColumn(); vm.shift(0, 1); vm.startRename(vm.draft.value.columns[0]);
  vm.removing.value = before.columns[0].id; vm.destination.value = before.columns[1].id; vm.removeColumn();
  vm.overrideTarget('sprint-one'); await vm.submit();
  assert.deepEqual(vm.draft.value, before); assert.equal(vm.editing.value, ''); assert.equal(writes, 0);
  await settle();
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
