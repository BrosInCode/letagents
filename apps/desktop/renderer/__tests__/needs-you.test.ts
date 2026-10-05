import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp, effectScope, nextTick, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import { useNeedsYou } from '../src/composables/useNeedsYou';
import { useNeedsYouSignal } from '../src/composables/useNeedsYouSignal';
import { roomNotificationPreferences } from '../src/composables/useRoomNotificationPreferences';
import { createKnowledgeRecord } from '../../../../shared/room-knowledge.mjs';
import type { DesktopNeedsYou } from '../../electron/ipc-types/knowledge.js';

const record = createKnowledgeRecord('room', 'attention', { client_id: 'request-0001', category: 'decision', title: 'Choose a launch audience', body: '<script>malicious()</script>', recommendation: 'Small product teams', unblocks: 'Onboarding copy' }, { id: 'worker', label: 'Research agent', kind: 'agent' });
const data: DesktopNeedsYou = { rooms: [{ roomIdentifier: 'room', displayName: 'Product launch', records: [record], tasks: [], truncated: false }], failures: [], limited: false, signedOut: false, cloudUnavailable: false };

test('the header signal acknowledges requests without resolving them and detects same-count replacements', async () => {
  const scope = effectScope();
  const current = ref<DesktopNeedsYou | null>(null);
  const activeRoom = ref<string | null>('room');
  const inboxRooms = ref<string[] | null>(null);
  const account = ref('first-account');
  let plays = 0;
  let disposed = false;
  const signal = scope.run(() => useNeedsYouSignal(current, ref([]), {
    ready: () => true, account: () => account.value, activeRoom: () => activeRoom.value, inboxRooms: () => inboxRooms.value,
  }, { play: () => { plays++; }, stop() {}, dispose: () => { disposed = true; } }))!;
  try {
    current.value = structuredClone(data); await nextTick();
    assert.deepEqual(signal.value, { count: 1, pulse: true });
    assert.equal(plays, 0, 'startup backlog is silent');
    inboxRooms.value = ['room']; activeRoom.value = null; await nextTick();
    inboxRooms.value = null; activeRoom.value = 'room'; await nextTick();
    assert.deepEqual(signal.value, { count: 1, pulse: false }, 'opening Inbox acknowledges, but does not answer');
    activeRoom.value = 'elsewhere'; await nextTick(); activeRoom.value = 'room'; await nextTick();
    assert.equal(plays, 0); assert.equal(signal.value.pulse, false);
    current.value!.rooms[0].records = [{ ...record, id: 'replacement' }]; await nextTick();
    assert.deepEqual(signal.value, { count: 1, pulse: true });
    assert.equal(plays, 1, 'a different request alerts even with the same count');
    current.value = structuredClone({ ...data, rooms: [{ ...data.rooms[0], records: [{ ...record, id: 'replacement' }] }] }); await nextTick();
    assert.equal(plays, 1, 'polling the same request does not chime again');
    current.value!.rooms[0].records = []; await nextTick();
    assert.deepEqual(signal.value, { count: 0, pulse: false });
    current.value = structuredClone(data); await nextTick();
    assert.deepEqual(signal.value, { count: 1, pulse: false }, 'a transiently missing request retains acknowledgement');
    account.value = 'second-account'; current.value = null; await nextTick();
    current.value = structuredClone(data); await nextTick();
    assert.deepEqual(signal.value, { count: 1, pulse: true }, 'acknowledgements are account scoped');
    assert.equal(plays, 1, 'switching accounts establishes a silent baseline');
  } finally { scope.stop(); }
  assert.equal(disposed, true);
});

test('the signal respects sound mute, room snooze, visibility, and the actual Inbox filter', async () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  let muted = false;
  const page = Object.assign(new EventTarget(), { hidden: false });
  Object.assign(globalThis, { document: page, window: { localStorage: { getItem: () => muted ? 'off' : null } } });
  const scope = effectScope();
  const current = ref<DesktopNeedsYou | null>(structuredClone(data));
  const activeRoom = ref<string | null>('room');
  const inboxRooms = ref<string[] | null>(null);
  let plays = 0; let stops = 0;
  const signal = scope.run(() => useNeedsYouSignal(current, ref([]), {
    ready: () => true, account: () => 'account', activeRoom: () => activeRoom.value, inboxRooms: () => inboxRooms.value,
  }, { play: () => { plays++; }, stop: () => { stops++; }, dispose() {} }))!;
  const replace = async (id: string) => { current.value!.rooms[0].records = [{ ...record, id }]; await nextTick(); };
  try {
    muted = true; await replace('sound-muted'); assert.equal(plays, 0); assert.equal(signal.value.pulse, true);
    muted = false;
    roomNotificationPreferences.state('room').preference = { level: 'muted', snoozed_until: null };
    await replace('room-muted'); assert.equal(plays, 0);
    roomNotificationPreferences.state('room').preference = { level: 'all', snoozed_until: new Date(Date.now() + 60_000).toISOString() };
    await replace('room-snoozed'); assert.equal(plays, 0);
    roomNotificationPreferences.state('room').preference = { level: 'all', snoozed_until: null };
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); await nextTick();
    await replace('while-hidden'); assert.equal(plays, 0); assert.equal(signal.value.pulse, false);
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); await nextTick();
    assert.equal(plays, 0, 'returning does not play a queued chime'); assert.equal(signal.value.pulse, true);
    inboxRooms.value = ['elsewhere']; activeRoom.value = null; await nextTick();
    inboxRooms.value = null; activeRoom.value = 'room'; await nextTick();
    assert.equal(signal.value.pulse, true, 'an Inbox filter excluding this room does not acknowledge it');
    inboxRooms.value = []; activeRoom.value = null; await nextTick();
    inboxRooms.value = null; activeRoom.value = 'room'; await nextTick();
    assert.equal(signal.value.pulse, false);
    await replace('new-visible'); assert.equal(plays, 1);
    assert.ok(stops > 0, 'leaving or hiding stops in-flight sound');
  } finally {
    scope.stop();
    roomNotificationPreferences.state('room').preference = { level: 'all', snoozed_until: null };
    Object.assign(globalThis, { window: priorWindow, document: priorDocument });
  }
});

test('new approval identities and new blocked-agent episodes rearm the signal', async () => {
  const scope = effectScope();
  const current = ref<DesktopNeedsYou | null>({ ...data, rooms: [{ ...data.rooms[0], records: [] }] });
  const agents = ref<import('../src/components/desktop/content/room-inbox/agent-attention').AgentAttentionItem[]>([]);
  const inboxRooms = ref<string[] | null>(null);
  let plays = 0;
  const signal = scope.run(() => useNeedsYouSignal(current, agents, {
    ready: () => true, account: () => 'account', activeRoom: () => 'room', inboxRooms: () => inboxRooms.value,
  }, { play: () => { plays++; }, stop() {}, dispose() {} }))!;
  try {
    // The signal needs only the identity, room and attention episode timestamp.
    agents.value = [{ key: 'agent-1', kind: 'agent_attention', roomIdentifier: 'room', timestamp: 'first' } as typeof agents.value[number]];
    await nextTick(); assert.equal(plays, 1);
    inboxRooms.value = ['room']; await nextTick(); inboxRooms.value = null; await nextTick();
    assert.equal(signal.value.pulse, false);
    agents.value[0].timestamp = 'recovered-then-stuck-again'; await nextTick();
    assert.equal(plays, 2); assert.equal(signal.value.pulse, true);
    agents.value = [{ key: 'approval-1', kind: 'tool_approval', roomIdentifier: 'room', timestamp: 'first' } as typeof agents.value[number]];
    await nextTick(); assert.equal(plays, 3);
    agents.value[0].timestamp = 'refreshed'; await nextTick();
    assert.equal(plays, 3, 'the same approval is not replayed when its listing refreshes');
  } finally { scope.stop(); }
});
test('Needs you presents a human decision with context and escapes agent content', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const header = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-shell/DesktopRoomHeader.vue')).default;
    const headerProps = { sidebarMode: 'expanded', room: { displayName: 'Product launch' }, storage: { effectiveMode: 'cloud' }, tabs: [], activeTab: 'chat', searchOpen: false, actionPanelOpen: false };
    const alertHtml = await renderToString(createSSRApp(header, { ...headerProps, attention: { count: 1, pulse: true } }));
    assert.match(alertHtml, /data-pulse="true"/); assert.match(alertHtml, /Open Inbox for Product launch, 1 request needs you/);
    assert.equal((alertHtml.match(/class="desktop-room-needs-you-wave"/g) ?? []).length, 2);
    const acknowledgedHtml = await renderToString(createSSRApp(header, { ...headerProps, attention: { count: 1, pulse: false } }));
    assert.match(acknowledgedHtml, /data-pulse="false"/); assert.match(acknowledgedHtml, /room-inbox-shortcut/);
    const resolvedHtml = await renderToString(createSSRApp(header, { ...headerProps, attention: { count: 0, pulse: false } }));
    assert.doesNotMatch(resolvedHtml, /room-inbox-shortcut/);
    const component = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/InboxView.vue')).default;
    const html = await renderToString(createSSRApp(component, { data, loading: false, error: '' }));
    assert.match(html, /Choose a launch audience/); assert.match(html, /Small product teams/); assert.match(html, /Onboarding copy/); assert.match(html, /Your response/);
    assert.match(html, /&lt;script&gt;malicious/); assert.doesNotMatch(html, /<script>malicious/);
    const eventsView = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/RoomEventsView.vue')).default;
    const event = { id: 'check-1', eventType: 'check_run', action: 'completed', state: 'failure', title: 'Build', createdAt: '2026-09-14T12:00:00Z', metadata: {}, githubObjectId: '123', githubObjectUrl: 'https://github.com/a/b/actions/runs/123', actorLogin: 'bot', linkedTaskId: null };
    const eventHtml = await renderToString(createSSRApp(eventsView, { roomIdentifier: 'room', repository: 'a/b', currentBranch: 'main', githubConnected: true, githubLoading: false, githubBusy: false, githubError: null, loading: false, loadingOlder: false, error: null, linkedTaskId: null, selectedEventId: event.id, eventsPage: { roomIdentifier: 'room', githubRoomIdentifier: null, events: [event], hasMore: false } }));
    assert.match(eventHtml, /GitHub event details for Build/, 'cross-view navigation opens the selected check on the first mount');
    const unavailable = await renderToString(createSSRApp(component, { data: { ...data, rooms: [], failures: [{ roomIdentifier: 'room', displayName: 'Product launch' }] }, loading: false, error: '' }));
    assert.match(unavailable, /Dismiss loading notice/); assert.match(unavailable, /Some updates couldn’t be loaded/);
    assert.match(unavailable, /Some inbox data is unavailable/); assert.match(unavailable, /<details class="inbox-source-notice"/); assert.match(unavailable, /Couldn’t load all inbox data for Product launch/); assert.doesNotMatch(unavailable, /You’re clear for now/);
    const emptyUpdates = await renderToString(createSSRApp(component, { data: { ...data, rooms: [], failures: [{ roomIdentifier: 'room', displayName: 'Product launch' }] }, section: 'updates', loading: false, error: '' }));
    assert.match(emptyUpdates, /No unread updates to show/); assert.match(emptyUpdates, /Some room data is still unavailable/); assert.doesNotMatch(emptyUpdates, /You’re caught up/);
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

test('bulk read clears a large backlog, preserves requests, and allows new activity to return', async () => {
  const { buildUniversalInbox, filterUniversalInbox, markInboxUpdatesRead, undoInboxRead } = await import('../src/components/desktop/content/room-inbox/universal');
  const backlog = { ...data, rooms: [{ ...data.rooms[0], tasks: Array.from({ length: 1400 }, (_, i) => ({ id: `task_${i}`, title: `Completed work ${i}`, status: 'done', description: null, updated_at: '2026-09-14T12:00:00Z' })) }] };
  const items = buildUniversalInbox(backlog);
  const read = markInboxUpdatesRead(items, {});
  assert.equal(read.changes.length, 1400);
  const persisted = JSON.parse(JSON.stringify(read.dismissals));
  assert.equal(filterUniversalInbox(items, 'updates', [], persisted).length, 0);
  assert.equal(filterUniversalInbox(items, 'needs-you', [], persisted).length, 1);
  backlog.rooms[0].tasks[0].updated_at = '2026-09-15T12:00:00Z';
  assert.equal(filterUniversalInbox(buildUniversalInbox(backlog), 'updates', [], persisted).length, 1);
  assert.equal(filterUniversalInbox(items, 'updates', [], undoInboxRead(read.changes, persisted)).length, 1400);
});

test('loading notices distinguish same-name rooms and stay dismissed when source order changes', async () => {
  const { inboxSourceFailureKey } = await import('../src/components/desktop/content/room-inbox/universal');
  const first = { ...data, failures: [{ roomIdentifier: 'first', displayName: 'Same name' }] };
  const second = { ...data, failures: [{ roomIdentifier: 'second', displayName: 'Same name' }] };
  assert.notEqual(inboxSourceFailureKey(first, [], ''), inboxSourceFailureKey(second, [], ''));
  const failed = { ...data, failures: [...first.failures, ...second.failures] };
  assert.equal(inboxSourceFailureKey(failed, [], ''), inboxSourceFailureKey({ ...failed, failures: [...failed.failures].reverse() }, [], ''));
  const updates = { tasks: [], threads: { roomIdentifier: 'first', threads: [], hasMore: false, unreadThreadCount: 0 }, githubEvents: null, presence: [], reasoningSessions: [], unavailable: ['threads', 'tasks'], limited: false };
  const partial = { ...data, rooms: [{ ...data.rooms[0], roomIdentifier: 'first', updates }, { ...data.rooms[0], roomIdentifier: 'second', updates }] } as DesktopNeedsYou;
  assert.notEqual(inboxSourceFailureKey(partial, ['first'], ''), inboxSourceFailureKey(partial, ['second'], ''));
  const reversed = { ...partial, rooms: [...partial.rooms].reverse().map(room => ({ ...room, updates: { ...room.updates!, unavailable: [...room.updates!.unavailable].reverse() } })) };
  assert.equal(inboxSourceFailureKey(partial, [], ''), inboxSourceFailureKey(reversed, [], ''));
  assert.notEqual(inboxSourceFailureKey(partial, [], ''), inboxSourceFailureKey({ ...partial, managedSessionsUnavailable: true }, [], ''));
});

test('bulk read follows the room filter and undo preserves earlier and later read versions', async () => {
  const { buildUniversalInbox, filterUniversalInbox, markInboxUpdatesRead, undoInboxRead } = await import('../src/components/desktop/content/room-inbox/universal');
  const task = { id: 'same_id', title: 'Work ready', status: 'in_review', description: null, updated_at: '2026-09-14T12:00:00Z' };
  const items = buildUniversalInbox({ ...data, rooms: [{ ...data.rooms[0], tasks: [task] }, { ...data.rooms[0], roomIdentifier: 'second', tasks: [task] }] });
  const selected = filterUniversalInbox(items, 'updates', ['room'], {});
  const previous = { [selected[0].key]: 'earlier-version', unrelated: 'keep' };
  const read = markInboxUpdatesRead(selected, previous);
  assert.equal(filterUniversalInbox(items, 'updates', [], read.dismissals)[0].roomIdentifier, 'second');
  assert.deepEqual(undoInboxRead(read.changes, read.dismissals), previous);
  const newerRead = { ...read.dismissals, [selected[0].key]: 'later-version' };
  assert.deepEqual(undoInboxRead(read.changes, newerRead), newerRead);
  assert.equal(markInboxUpdatesRead(selected, read.dismissals).changes.length, 0);
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

test('Needs you lists the newest request first across rooms, and updates never interleave with requests', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const answered = (id: string, at: string) => ({ ...record, id, response: { body: 'Done', actor: { id: 'human', label: 'Emmy', kind: 'human' as const }, at } });
  const items = buildUniversalInbox({ ...data, rooms: [
    { ...data.rooms[0], records: [{ ...record, created_at: '2026-09-01T00:00:00Z' }, answered('answered-older', '2026-09-05T00:00:00Z')],
      tasks: [{ id: 'task_1', title: 'Between requests', status: 'blocked', description: null, updated_at: '2026-09-02T00:00:00Z' }] },
    { ...data.rooms[0], roomIdentifier: 'second-room', records: [{ ...record, created_at: '2026-09-03T00:00:00Z' }, answered('answered-newer', '2026-09-06T00:00:00Z')],
      tasks: [{ id: 'task_2', title: 'Later work', status: 'blocked', description: null, updated_at: '2026-09-04T00:00:00Z' }] },
  ] });
  assert.deepEqual(filterUniversalInbox(items, 'needs-you', [], {}).map(item => item.timestamp), ['2026-09-03T00:00:00Z', '2026-09-01T00:00:00Z'],
    'a 12-day-old request from another room no longer sits above a new one');
  assert.deepEqual(filterUniversalInbox(items, 'updates', [], {}).map(item => item.timestamp), ['2026-09-04T00:00:00Z', '2026-09-02T00:00:00Z'], 'Updates read newest-first');
  assert.deepEqual(filterUniversalInbox(items, 'answered', [], {}).map(item => item.timestamp), ['2026-09-06T00:00:00Z', '2026-09-05T00:00:00Z'], 'Answered reads newest-first');
});

test('items with a missing or unreadable time keep a fixed place: after dated requests, before dated blocked work', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const { buildAgentAttentionItems } = await import('../src/components/desktop/content/room-inbox/agent-attention');
  const approval = (id: string) => ({ id, status: 'pending' as const, detail: null, retryDecision: null, dismissKey: null,
    presentation: { agentId: 'agent', displayName: 'CopperRidge', provider: 'open-model' as const, title: 'Run a command' as const, details: '{}', denyScope: 'session_pending' as const } });
  const records = [
    { ...record, id: 'dated-newer', created_at: '2026-09-03T00:00:00Z' }, { ...record, id: 'a-no-time', created_at: '' },
    { ...record, id: 'dated-older', created_at: '2026-09-01T00:00:00Z' }, { ...record, id: 'b-bad-time', created_at: 'not a date' },
  ];
  const approvals = [approval('dated-approval'), approval('undated-approval')];
  const order = (shuffle: <T>(list: T[]) => T[]) => {
    const attention = buildAgentAttentionItems({ nowMs: Date.parse('2026-09-30T00:00:00Z'), approvalRooms: new Map([['room', { stale: false,
      approvals: shuffle(approvals), firstSeenAt: { 'dated-approval': '2026-09-02T00:00:00Z' } }]]) });
    return filterUniversalInbox(buildUniversalInbox({ ...data, rooms: [{ ...data.rooms[0], records: shuffle(records) }] }, [], shuffle(attention)), 'needs-you', [], {})
      .map(item => item.attention?.kind === 'tool_approval' ? item.attention.approval.id : item.record!.id);
  };
  const expected = ['undated-approval', 'dated-approval', 'dated-newer', 'dated-older', 'a-no-time', 'b-bad-time'];
  assert.deepEqual(order(list => [...list]), expected);
  assert.deepEqual(order(list => [...list].reverse()), expected, 'the input order does not matter');
  assert.deepEqual(order(list => [...list.slice(1), list[0]]), expected);
});

test('blocked agent work leads Needs you longest-waiting first, then requests newest-first', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const { buildAgentAttentionItems } = await import('../src/components/desktop/content/room-inbox/agent-attention');
  const now = Date.parse('2026-09-30T16:30:00Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const approval = (id: string) => ({ id, status: 'pending' as const, detail: null, retryDecision: null, dismissKey: null,
    presentation: { agentId: 'agent', displayName: 'CopperRidge', provider: 'open-model' as const, title: 'Run a command' as const, details: '{}', denyScope: 'session_pending' as const } });
  const attention = buildAgentAttentionItems({ nowMs: now, approvalRooms: new Map([['room', { stale: false,
    approvals: [approval('waiting-2m'), approval('waiting-20m')], firstSeenAt: { 'waiting-2m': ago(2), 'waiting-20m': ago(20) } }]]) });
  const items = buildUniversalInbox({ ...data, rooms: [{ ...data.rooms[0], records: [
    { ...record, id: 'fresh-question', created_at: ago(1) }, { ...record, id: 'older-question', created_at: ago(30) },
  ] }] }, [], attention);
  const order = filterUniversalInbox(items, 'needs-you', [], {}).map(item => item.attention?.kind === 'tool_approval' ? item.attention.approval.id : item.record!.id);
  assert.deepEqual(order, ['waiting-20m', 'waiting-2m', 'fresh-question', 'older-question'],
    'a fresh question sits below an older pending tool approval, and below a newer one too');
});

test('queue ages read in minutes under an hour', async () => {
  const { inboxRelativeTime } = await import('../src/components/desktop/content/room-inbox/universal');
  const now = Date.parse('2026-09-30T16:30:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.deepEqual([30_000, 6 * 60_000, 59 * 60_000, 60 * 60_000, 25 * 3_600_000, 12 * 86_400_000].map(ms => inboxRelativeTime(ago(ms), now)),
    ['Just now', '6m', '59m', '1h', '1d', '12d']);
  assert.equal(inboxRelativeTime(ago(-60_000), now), 'Just now', 'clock skew never shows a negative age');
  assert.equal(inboxRelativeTime('not a date', now), '');
});

test('the room filter is searchable and remembered per account; a room chip scopes one visit without replacing it', async () => {
  const { searchInboxRooms } = await import('../src/components/desktop/content/room-inbox/universal');
  const { readInboxRoomFilter, useInboxRoomFilter } = await import('../src/composables/useInboxRoomFilter');
  const rooms = [{ roomIdentifier: 'github.com/EmmyMay/year-dots', displayName: 'fern-reef' }, { roomIdentifier: 'maple', displayName: 'Maple River' }];
  assert.deepEqual(searchInboxRooms(rooms, '  MAPLE ').map(room => room.roomIdentifier), ['maple']);
  assert.deepEqual(searchInboxRooms(rooms, 'year-dots').map(room => room.displayName), ['fern-reef'], 'a room is also found by its repository');
  assert.equal(searchInboxRooms(rooms, '').length, 2);
  const priorWindow = globalThis.window;
  const stored = new Map<string, string>();
  Object.assign(globalThis, { window: { localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } } } });
  try {
    let account = 'account-1';
    const filter = useInboxRoomFilter(() => account);
    filter.choose(['maple']);
    filter.open('github.com/EmmyMay/year-dots');
    assert.deepEqual(filter.rooms.value, ['github.com/EmmyMay/year-dots'], 'the chip opens its own room');
    assert.deepEqual(readInboxRoomFilter('account-1'), ['maple'], 'a chip-scoped visit does not replace the saved choice');
    filter.open();
    assert.deepEqual(filter.rooms.value, ['maple'], 'the next plain visit restores the saved choice');
    account = 'account-2'; filter.reload();
    assert.deepEqual(filter.rooms.value, [], 'another account keeps its own filter');
    account = 'account-1'; filter.reload();
    assert.deepEqual(filter.rooms.value, ['maple']);

    filter.choose(['maple', 'gone', 'local_7f3a']);
    filter.prune({ ...data, limited: true, rooms: [{ ...data.rooms[0], roomIdentifier: 'maple' }] });
    assert.deepEqual(readInboxRoomFilter('account-1'), ['maple', 'gone', 'local_7f3a'], 'a capped room list proves nothing is gone');
    filter.prune({ ...data, rooms: [{ ...data.rooms[0], roomIdentifier: 'maple' }] });
    assert.deepEqual(readInboxRoomFilter('account-1'), ['maple', 'local_7f3a'], 'a room that no longer exists leaves the filter; local rooms stay');
    assert.deepEqual(filter.rooms.value, ['maple', 'local_7f3a']);

    filter.choose([]);
    assert.equal(stored.has('letagents-desktop:inbox-rooms:account-1'), false);
    stored.set('letagents-desktop:inbox-rooms:account-1', '{"broken"');
    assert.deepEqual(readInboxRoomFilter('account-1'), []);
    Object.assign(globalThis, { window: {} });
    assert.doesNotThrow(() => filter.choose(['maple']), 'storage is optional');
    assert.deepEqual(readInboxRoomFilter('account-1'), []);
  } finally { Object.assign(globalThis, { window: priorWindow }); }
});

test('loading issues follow the room filter and Retry sources stays available during a refresh', async () => {
  const { inboxSourceFailureKey, inboxSourceFailures } = await import('../src/components/desktop/content/room-inbox/universal');
  const failed: DesktopNeedsYou = { ...data, rooms: [data.rooms[0], { ...data.rooms[0], roomIdentifier: 'other', displayName: 'amber-owl' }], failures: [{ roomIdentifier: 'other', displayName: 'amber-owl' }] };
  assert.deepEqual(inboxSourceFailures(failed, ['room']), []);
  assert.equal(inboxSourceFailures(failed, []).length, 1);
  assert.equal(inboxSourceFailureKey(failed, ['room'], ''), inboxSourceFailureKey(data, ['room'], ''), 'a failure outside the filter is not a new notice');
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/InboxView.vue')).default;
    const scoped = await renderToString(createSSRApp(component, { data: failed, rooms: ['room'], rentalError: 'Rental requests are unavailable.', loading: false, error: '' }));
    assert.doesNotMatch(scoped, /amber-owl\./); assert.doesNotMatch(scoped, /Some updates couldn’t be loaded/); assert.doesNotMatch(scoped, /Rental requests are unavailable/);
    const all = await renderToString(createSSRApp(component, { data: failed, loading: true, error: '' }));
    assert.match(all, /Couldn’t load all inbox data for amber-owl\./);
    const retry = /<button class="knowledge-button"([^>]*)>(?:(?!<\/button>).)*Retry sources<\/button>/s.exec(all);
    assert.ok(retry, 'Retry sources is shown');
    assert.doesNotMatch(retry[1], /disabled/, 'a retry can be queued while the current load finishes');
    assert.match(retry[0], /knowledge-spin/);
    assert.match(all, /placeholder="Find a room"/);
    const noRooms = await renderToString(createSSRApp(component, { data: { ...data, rooms: [] }, loading: false, error: '' }));
    assert.doesNotMatch(noRooms, /No rooms match/, 'an empty search never reports a miss');

    const hidden = await renderToString(createSSRApp(component, { data, rooms: ['elsewhere'], loading: false, error: '' }));
    assert.match(hidden, /1 hidden by the room filter/);
    assert.match(hidden, /Nothing here in the selected rooms/); assert.doesNotMatch(hidden, /You’re clear for now/);
  } finally { await vite.close(); }
});

test('a dismissed loading notice is kept per room filter, so switching filters never erases it', async () => {
  const { inboxSourceFailureKey } = await import('../src/components/desktop/content/room-inbox/universal');
  const failed: DesktopNeedsYou = { ...data, failures: [{ roomIdentifier: 'room', displayName: 'Product launch' }] };
  const priorWindow = globalThis.window;
  const stored = new Map<string, string>([['letagents-desktop:inbox-hidden-notice:local', JSON.stringify({ '["room"]': inboxSourceFailureKey(failed, ['room'], '') })]]);
  Object.assign(globalThis, { window: { localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } } } });
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/InboxView.vue')).default;
    const filtered = await renderToString(createSSRApp(component, { data: failed, rooms: ['room'], loading: false, error: '' }));
    assert.match(filtered, /Show loading issues/); assert.doesNotMatch(filtered, /<details class="inbox-source-notice"/);
    const unfiltered = await renderToString(createSSRApp(component, { data: failed, loading: false, error: '' }));
    assert.match(unfiltered, /<details class="inbox-source-notice"/, 'the unfiltered view has its own notice');
    assert.ok(JSON.parse(stored.get('letagents-desktop:inbox-hidden-notice:local')!)['["room"]'], 'viewing another filter keeps the dismissal');
    stored.set('letagents-desktop:inbox-hidden-notice:local', inboxSourceFailureKey(failed, [], ''));
    const legacy = await renderToString(createSSRApp(component, { data: failed, loading: false, error: '' }));
    assert.match(legacy, /Show loading issues/, 'an earlier unscoped dismissal still covers the unfiltered view');
  } finally { await vite.close(); Object.assign(globalThis, { window: priorWindow }); }
});

test('unknown local managed agents remain visible in Updates only in their own room', async () => {
  const { buildUniversalInbox, filterUniversalInbox } = await import('../src/components/desktop/content/room-inbox/universal');
  const session = { id: 'managed_1', providerId: 'codex', runtime: 'codex', roomIdentifier: 'room', status: 'unknown', canStop: true, agentSessionId: 'agent_1', agentKey: 'desktop/codex/maple', actorLabel: 'Maple', displayName: 'Maple', startedAt: '2026-09-14T12:00:00Z', updatedAt: '2026-09-14T12:00:00Z', pendingPermissionRequests: [] } as any;
  const updates = { tasks: [], threads: { threads: [], hasMore: false, unreadThreadCount: 0 }, githubEvents: null, presence: [], reasoningSessions: [], unavailable: [], limited: false };
  const items = buildUniversalInbox({ ...data, managedSessions: [session], rooms: [{ ...data.rooms[0], updates }, { ...data.rooms[0], roomIdentifier: 'other-room', updates }] });
  assert.equal(filterUniversalInbox(items, 'updates', ['room'], {})[0].category, 'agent_offline');
  assert.equal(filterUniversalInbox(items, 'updates', ['other-room'], {}).length, 0);
});

test('a room read on its own activity replaces that room until a newer full read, and a slower older read never undoes it', async () => {
  const priorWindow = globalThis.window;
  const fullReads: Array<(value: DesktopNeedsYou) => void> = [];
  const roomReads: Array<{ room: string; includeBoardIntents: boolean; resolve: (value: unknown) => void }> = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { room: {
    getNeedsYou: () => new Promise(resolve => fullReads.push(resolve)),
    getNeedsYouRoom: (room: string, includeBoardIntents: boolean) => new Promise(resolve => roomReads.push({ room, includeBoardIntents, resolve })),
  } } } });
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  let inbox!: ReturnType<typeof useNeedsYou>;
  const app = renderer.createApp({ setup() { inbox = useNeedsYou(); return () => null; } }); app.mount({});
  const pendingIntent = { id: 'bi_1', taskId: 'task_1', actionType: 'task_close', status: 'pending', proposerActorLabel: 'LunarAmber', payload: { task_id: 'task_1', status: 'done' }, createdAt: '2026-09-30T05:30:00Z', expiresAt: null };
  const withRoom = (records: typeof data.rooms[0]['records'], boardIntents = [pendingIntent]): DesktopNeedsYou => ({ ...data, rooms: [{ ...data.rooms[0], records, boardIntents }] });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    const first = inbox.refresh(); fullReads[0](withRoom([record])); await first;
    assert.equal(inbox.count.value, 1);
    const stale = inbox.refresh();
    // The manager approves the intent and the room's activity triggers a read of that room.
    const roomRead = inbox.refreshRoom('ROOM');
    await settle();
    assert.deepEqual(roomReads.map(read => [read.room, read.includeBoardIntents]), [['room', true]], 'the room is found by any spelling of its identifier');
    void inbox.refreshRoom('room');
    roomReads[0].resolve({ records: [], truncated: false, tasks: [], boardIntents: [] });
    await roomRead; await settle();
    assert.equal(inbox.count.value, 0); assert.deepEqual(inbox.data.value?.rooms[0].boardIntents, []);
    assert.equal(roomReads.length, 2, 'an activity during a read runs one more read afterwards');
    roomReads[1].resolve({ records: [], truncated: false, tasks: [], boardIntents: [] }); await settle();
    fullReads[1](withRoom([record])); await stale;
    assert.equal(inbox.count.value, 0, 'a full read that started before the room read does not bring the request back');
    assert.deepEqual(inbox.data.value?.rooms[0].boardIntents, []);
    const newer = inbox.refresh(); fullReads[2](withRoom([record])); await newer;
    assert.equal(inbox.count.value, 1, 'a full read that started later is newer');
  } finally { app.unmount(); Object.assign(globalThis, { window: priorWindow }); }
});

test('Needs you re-reads a room a moment after its activity, at most once per gap per room', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-30T06:00:00Z') });
  const { useNeedsYouRoomActivity } = await import('../src/composables/useNeedsYou');
  const { effectScope, nextTick, ref } = await import('vue');
  const reads: string[] = [];
  const activity = ref({ connected: true, rooms: { room_1: { roomId: 'github.com/acme/app', latestMessageId: 'msg_10', latestMessageAt: null, working: [] } } as Record<string, { roomId: string; latestMessageId: string | null; latestMessageAt: string | null; working: Array<{ displayName: string }> }> });
  const scope = effectScope();
  scope.run(() => useNeedsYouRoomActivity(activity, async (room) => { reads.push(room); }, 3_000));
  const post = async (id: string) => { activity.value = { ...activity.value, rooms: { room_1: { ...activity.value.rooms.room_1, latestMessageId: id } } }; await nextTick(); };
  try {
    await post('msg_11');
    context.mock.timers.tick(0);
    assert.deepEqual(reads, ['github.com/acme/app'], 'a new message re-reads its room at once');
    await post('msg_12'); await post('msg_13');
    context.mock.timers.tick(2_999);
    assert.equal(reads.length, 1, 'a busy room waits out the gap');
    context.mock.timers.tick(1);
    assert.equal(reads.length, 2, 'and is read once for the burst');
    activity.value = { ...activity.value, connected: false };
    await nextTick(); context.mock.timers.tick(10_000);
    assert.equal(reads.length, 2, 'an unchanged latest message reads nothing');
  } finally { scope.stop(); }
});

test('Open room from the Inbox switches at once for a room the sidebar lists', async () => {
  const { openInboxRoom } = await import('../src/domain/desktop-navigation');
  const calls: string[] = [];
  let snapshotDone!: () => void;
  const navigation = {
    findEntry: (room: string) => room === 'github.com/acme/app' ? { id: 'room:acme' } : null,
    selectEntry: (entry: { id: string }) => { calls.push(`select ${entry.id}`); },
    openBySnapshot: (room: string) => { calls.push(`snapshot ${room}`); return new Promise<void>(resolve => { snapshotDone = resolve; }); },
  };
  const opened = openInboxRoom('github.com/acme/app', navigation);
  assert.deepEqual(calls, ['select room:acme'], 'the view changes before any room data loads');
  await opened;
  const unlisted = openInboxRoom('github.com/acme/archived', navigation);
  assert.deepEqual(calls, ['select room:acme', 'snapshot github.com/acme/archived']);
  snapshotDone(); await unlisted;
});

test('room re-reads pause while the window is hidden and catch up when it returns', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-30T06:00:00Z') });
  const { useNeedsYouRoomActivity } = await import('../src/composables/useNeedsYou');
  const { effectScope, nextTick, ref } = await import('vue');
  const priorDocument = globalThis.document;
  const listeners = new Set<() => void>();
  const page = { hidden: true, addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener) };
  Object.assign(globalThis, { document: page });
  const reads: string[] = [];
  const activity = ref({ connected: true, rooms: { room_1: { roomId: 'github.com/acme/app', latestMessageId: 'msg_10', latestMessageAt: null, working: [] as Array<{ displayName: string }> } } });
  const scope = effectScope();
  scope.run(() => useNeedsYouRoomActivity(activity, async (room) => { reads.push(room); }, 3_000));
  try {
    activity.value = { ...activity.value, rooms: { room_1: { ...activity.value.rooms.room_1, latestMessageId: 'msg_11' } } };
    await nextTick(); context.mock.timers.tick(10_000);
    assert.deepEqual(reads, [], 'nothing is read while hidden');
    page.hidden = false;
    for (const listener of listeners) listener();
    context.mock.timers.tick(0);
    assert.deepEqual(reads, ['github.com/acme/app'], 'the room is read once the window is back');
  } finally {
    scope.stop();
    assert.equal(listeners.size, 0, 'the visibility listener ends with the scope');
    Object.assign(globalThis, { document: priorDocument });
  }
});

test('a room an Inbox item opened reports a failed load once; other loads stay quiet', async () => {
  const { inboxRoomOpenReporter } = await import('../src/domain/desktop-navigation');
  const reported: unknown[] = [];
  const opens = inboxRoomOpenReporter((error) => reported.push(error));
  const fail = () => Promise.reject(new Error('room unavailable'));
  opens.opened('room:a');
  await assert.rejects(opens.load('room:a', fail), /room unavailable/, 'the failure still reaches its caller');
  assert.deepEqual(reported.map(error => (error as Error).message), ['room unavailable']);
  await assert.rejects(opens.load('room:a', fail));
  await assert.rejects(opens.load('room:b', fail));
  assert.equal(reported.length, 1, 'only the load the Inbox started is reported');
  opens.opened('room:c');
  assert.equal(await opens.load('room:c', async () => 'loaded'), 'loaded');
  await assert.rejects(opens.load('room:c', fail));
  assert.equal(reported.length, 1, 'a later load of the same room is not the Inbox\'s');
});
