import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import { useNeedsYou } from '../src/composables/useNeedsYou';
import { createKnowledgeRecord } from '../../../../shared/room-knowledge.mjs';
import type { DesktopNeedsYou } from '../../electron/ipc-types/knowledge.js';

const record = createKnowledgeRecord('room', 'attention', { client_id: 'request-0001', category: 'decision', title: 'Choose a launch audience', body: '<script>malicious()</script>', recommendation: 'Small product teams', unblocks: 'Onboarding copy' }, { id: 'worker', label: 'Research agent', kind: 'agent' });
const data: DesktopNeedsYou = { rooms: [{ roomIdentifier: 'room', displayName: 'Product launch', records: [record], tasks: [], truncated: false }], failures: [], limited: false, signedOut: false, cloudUnavailable: false };
test('Needs you presents a human decision with context and escapes agent content', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/InboxView.vue')).default;
    const html = await renderToString(createSSRApp(component, { data, loading: false, error: '' }));
    assert.match(html, /Choose a launch audience/); assert.match(html, /Small product teams/); assert.match(html, /Onboarding copy/); assert.match(html, /Your response/);
    assert.match(html, /&lt;script&gt;malicious/); assert.doesNotMatch(html, /<script>malicious/);
    const eventsView = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/RoomEventsView.vue')).default;
    const event = { id: 'check-1', eventType: 'check_run', action: 'completed', state: 'failure', title: 'Build', createdAt: '2026-09-14T12:00:00Z', metadata: {}, githubObjectId: '123', githubObjectUrl: 'https://github.com/a/b/actions/runs/123', actorLogin: 'bot', linkedTaskId: null };
    const eventHtml = await renderToString(createSSRApp(eventsView, { roomIdentifier: 'room', repository: 'a/b', currentBranch: 'main', githubConnected: true, githubLoading: false, githubBusy: false, githubError: null, loading: false, loadingOlder: false, error: null, linkedTaskId: null, selectedEventId: event.id, eventsPage: { roomIdentifier: 'room', githubRoomIdentifier: null, events: [event], hasMore: false } }));
    assert.match(eventHtml, /GitHub event details for Build/, 'cross-view navigation opens the selected check on the first mount');
    const unavailable = await renderToString(createSSRApp(component, { data: { ...data, rooms: [], failures: [{ roomIdentifier: 'room', displayName: 'Product launch' }] }, loading: false, error: '' }));
    assert.match(unavailable, /Some sources still need checking/); assert.match(unavailable, /<details class="inbox-source-notice"/); assert.match(unavailable, /Couldn’t fully check Product launch/); assert.doesNotMatch(unavailable, /You’re clear for now/);
  } finally { await vite.close(); }
});
test('account reset rejects old in-flight inbox reads and clears private cached content', async () => {
  const priorWindow = globalThis.window;
  const pending: Array<(value: DesktopNeedsYou) => void> = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { room: { getNeedsYou: () => new Promise(resolve => pending.push(resolve)) } } } });
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  let inbox!: ReturnType<typeof useNeedsYou>;
  const app = renderer.createApp({ setup() { inbox = useNeedsYou(); return () => null; } }); app.mount({});
  try {
    const old = inbox.refresh(); inbox.reset();
    const current = inbox.refresh();
    pending[0](data); await old;
    assert.equal(inbox.data.value, null); assert.equal(inbox.loading.value, true);
    pending[1]({ ...data, rooms: [] }); await current;
    assert.equal(inbox.count.value, 0); assert.equal(inbox.loading.value, false);
    inbox.reset(); assert.equal(inbox.data.value, null);
  } finally { app.unmount(); Object.assign(globalThis, { window: priorWindow }); }
});

test('the universal inbox scopes colliding room IDs and reserves Needs you for explicit requests', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const rooms: DesktopNeedsYou = { ...data, rooms: [data.rooms[0], { ...data.rooms[0], roomIdentifier: 'second-room', displayName: 'Design', records: [{ ...record, room_id: 'second-room' }], tasks: [{ id: 'task_1', title: 'Agent can recover this', description: 'A retry is pending', status: 'blocked', updated_at: '2026-09-14T12:00:00Z' }] }] };
  const items = buildUniversalInbox(rooms);
  assert.equal(new Set(items.map(item => item.key)).size, 3);
  assert.equal(filterUniversalInbox(items, 'needs-you', [], {}).length, 2);
  assert.equal(filterUniversalInbox(items, 'needs-you', ['second-room'], {})[0].roomIdentifier, 'second-room');
  assert.equal(filterUniversalInbox(items, 'needs-you', ['room', 'second-room'], {}).length, 2);
  const update = filterUniversalInbox(items, 'updates', [], {})[0];
  assert.equal(update.taskId, 'task_1');
  assert.equal(filterUniversalInbox(items, 'updates', [], { [update.key]: update.fingerprint }).length, 0);
  rooms.rooms[1].tasks[0].updated_at = '2026-09-14T13:00:00Z';
  assert.equal(filterUniversalInbox(buildUniversalInbox(rooms), 'updates', [], { [update.key]: update.fingerprint }).length, 1, 'new activity resurfaces a dismissed item');
  assert.equal(filterUniversalInbox(items, 'needs-you', [], { [items[0].key]: items[0].fingerprint }).length, 2, 'requests cannot be silently dismissed');
});

test('answered requests move out of Needs you and remain attached to their room', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const answered = { ...record, response: { body: 'Start with product teams', actor: { id: 'human', label: 'Emmy', kind: 'human' as const }, at: '2026-09-14T14:00:00Z' } };
  const items = buildUniversalInbox({ ...data, rooms: [{ ...data.rooms[0], records: [answered] }] });
  assert.equal(filterUniversalInbox(items, 'needs-you', [], {}).length, 0);
  assert.equal(filterUniversalInbox(items, 'answered', ['room'], {})[0].record?.response?.body, 'Start with product teams');
});

test('opening Inbox during a badge refresh queues its update sources instead of losing the request', async () => {
  const priorWindow = globalThis.window;
  const pending: Array<(value: DesktopNeedsYou) => void> = [];
  const calls: boolean[] = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { room: { getNeedsYou: (includeUpdates: boolean) => { calls.push(includeUpdates); return new Promise(resolve => pending.push(resolve)); } } } } });
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  let inbox!: ReturnType<typeof useNeedsYou>;
  const app = renderer.createApp({ setup() { inbox = useNeedsYou(); return () => null; } }); app.mount({});
  try {
    const badge = inbox.refresh(false);
    await inbox.refresh(true);
    pending[0](data); await badge;
    assert.deepEqual(calls, [false, true]);
    assert.equal(inbox.loading.value, true);
    pending[1]({ ...data, rooms: [{ ...data.rooms[0], tasks: [{ id: 'task_1', title: 'Blocked task', description: null, status: 'blocked', updated_at: '' }] }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inbox.count.value, 1, 'automatic task states do not inflate the human-request badge');
  } finally { app.unmount(); Object.assign(globalThis, { window: priorWindow }); }
});

test('mixed-room updates never reorder human requests ahead of older requests', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const items = buildUniversalInbox({ ...data, rooms: [
    { ...data.rooms[0], records: [{ ...record, created_at: '2026-09-01T00:00:00Z' }], tasks: [{ id: 'task_1', title: 'Between requests', status: 'blocked', description: null, updated_at: '2026-09-02T00:00:00Z' }] },
    { ...data.rooms[0], roomIdentifier: 'second-room', records: [{ ...record, created_at: '2026-09-03T00:00:00Z' }] },
  ] });
  assert.deepEqual(filterUniversalInbox(items, 'needs-you', [], {}).map(item => item.timestamp), ['2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z']);
});

test('unknown local managed agents remain visible in Updates only in their own room', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const session = { id: 'managed_1', providerId: 'codex', runtime: 'codex', roomIdentifier: 'room', status: 'unknown', canStop: true, agentSessionId: 'agent_1', agentKey: 'desktop/codex/maple', actorLabel: 'Maple', displayName: 'Maple', startedAt: '2026-09-14T12:00:00Z', updatedAt: '2026-09-14T12:00:00Z', pendingPermissionRequests: [] } as any;
  const updates = { tasks: [], threads: { threads: [], hasMore: false, unreadThreadCount: 0 }, githubEvents: null, presence: [], reasoningSessions: [], unavailable: [], limited: false };
  const items = buildUniversalInbox({ ...data, managedSessions: [session], rooms: [{ ...data.rooms[0], updates }, { ...data.rooms[0], roomIdentifier: 'other-room', updates }] });
  assert.equal(filterUniversalInbox(items, 'updates', ['room'], {})[0].category, 'agent_offline');
  assert.equal(filterUniversalInbox(items, 'updates', ['other-room'], {}).length, 0);
});
