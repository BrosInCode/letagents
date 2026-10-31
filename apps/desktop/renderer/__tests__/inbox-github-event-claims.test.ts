import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import type { DesktopGitHubRoomEvent } from '../../electron/ipc-types';
import type { DesktopAttentionRoom, DesktopNeedsYou } from '../../electron/ipc-types/knowledge.js';
import { claimGitHubEvents } from '../src/components/desktop/content/room-inbox/github-event-claims';
import { buildUniversalInbox, filterUniversalInbox, inboxNavigationIntent } from '../src/components/desktop/content/room-inbox/universal';
import { useNeedsYou } from '../src/composables/useNeedsYou';

const REPO = 'github.com/acme/app';

function failedCheck(id: string, title = 'build', createdAt = '2026-10-14T08:00:00.000Z'): DesktopGitHubRoomEvent {
  return { id, eventType: 'check_run', action: 'completed', githubObjectId: '77', githubObjectUrl: 'https://github.com/acme/app/actions/runs/77',
    title, state: 'failure', actorLogin: 'github-actions', metadata: { app_name: 'CI', conclusion: 'failure' }, linkedTaskId: null, createdAt };
}

function room(roomIdentifier: string, events: DesktopGitHubRoomEvent[], parentRoomIdentifier?: string): DesktopAttentionRoom {
  return { roomIdentifier, displayName: roomIdentifier === REPO ? 'App' : `Focus ${roomIdentifier}`, records: [], truncated: false, tasks: [],
    ...(parentRoomIdentifier ? { parentRoomIdentifier } : {}),
    updates: { threads: { threads: [], hasMore: false, unreadThreadCount: 0 }, tasks: [], reasoningSessions: [], presence: [], unavailable: [], limited: false,
      githubEvents: { roomIdentifier, githubRoomIdentifier: REPO, events, hasMore: false } } };
}

function needsYou(rooms: DesktopAttentionRoom[], updatesIncluded = true): DesktopNeedsYou {
  return { rooms, failures: [], limited: false, cloudUnavailable: false, signedOut: false, updatesIncluded };
}

const checkRows = (data: DesktopNeedsYou) => filterUniversalInbox(buildUniversalInbox(data), 'updates', [], {}).filter(item => item.category === 'github_failure');

test('focus rooms that read their repo room\'s lane show a shared failed check once, in the repo room', () => {
  // The repo room comes last and sorts after the focus rooms, yet it keeps the event.
  const data = needsYou([room('focus_1', [failedCheck('evt_1')], REPO), room('focus_2', [failedCheck('evt_1')], REPO), room(REPO, [failedCheck('evt_1')])]);
  const rows = checkRows(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roomIdentifier, REPO);
  assert.equal(rows[0].roomName, 'App');
  assert.deepEqual(inboxNavigationIntent(rows[0], 'room'), { roomIdentifier: REPO }, 'Open room opens the room that kept the event');
  assert.deepEqual([...claimGitHubEvents(data.rooms)].map(([id, events]) => [id, events.map(event => event.id)]),
    [['focus_1', []], ['focus_2', []], [REPO, ['evt_1']]]);
});

test('a focus room keeps an event its repo room does not carry', () => {
  const rows = checkRows(needsYou([room(REPO, [failedCheck('evt_1')]), room('focus_1', [failedCheck('evt_1'), failedCheck('evt_9', 'deploy')], REPO)]));
  assert.deepEqual(rows.map(row => [row.roomIdentifier, row.title]).sort(), [['focus_1', 'deploy'], [REPO, 'build']]);
});

test('without the repo room in the list, the first carrier by room identifier keeps a shared event', () => {
  const data = needsYou([room('focus_b', [failedCheck('evt_1')], REPO), room('focus_a', [failedCheck('evt_1')], REPO)]);
  const rows = checkRows(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roomIdentifier, 'focus_a');
  assert.deepEqual([...claimGitHubEvents([room('another', [failedCheck('evt_1')]), room('ad-hoc', [failedCheck('evt_1')])])].map(([id, events]) => [id, events.map(event => event.id)]),
    [['another', []], ['ad-hoc', ['evt_1']]], 'rooms with no parent also fall back to the identifier order');
});

test('repeated failures of one check still group into one row with their occurrence count', () => {
  const events = () => [failedCheck('evt_1', 'build', '2026-10-14T08:00:00.000Z'), failedCheck('evt_2', 'build', '2026-10-14T09:00:00.000Z'), failedCheck('evt_3', 'build', '2026-10-14T10:00:00.000Z')];
  const rows = checkRows(needsYou([room('focus_1', events(), REPO), room(REPO, events()), room('focus_2', events(), REPO)]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roomIdentifier, REPO);
  const activity = rows[0].activity;
  assert.ok(activity?.kind === 'github_failure');
  assert.equal(activity.occurrenceCount, 3);
  assert.deepEqual(activity.activity.map(entry => entry.id), ['github:evt_3', 'github:evt_2', 'github:evt_1']);
});

test('the Updates count appears only once a read has loaded updates', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/InboxView.vue')).default;
    const blocked = { ...room(REPO, []), updates: undefined, tasks: [{ id: 'task_1', title: 'Fix the build', status: 'blocked', description: null, updated_at: '2026-10-14T08:00:00.000Z' }] };
    const render = (data: DesktopNeedsYou, section: string, loading = false) => renderToString(createSSRApp(component, { data, section, loading, error: '' }));

    const early = await render(needsYou([blocked], false), 'needs-you', true);
    assert.match(early, /Needs you<span>0<\/span>/, 'the Needs you count is unchanged');
    assert.doesNotMatch(early, /Updates<span>/, 'no Updates number before updates load');
    const loaded = await render(needsYou([blocked], true), 'needs-you');
    assert.match(loaded, /Updates<span>1<\/span>/);

    const earlyUpdates = await render(needsYou([blocked], false), 'updates', true);
    assert.doesNotMatch(earlyUpdates, /class="knowledge-total"/, 'the Updates heading has no number either');
    assert.match(earlyUpdates, /Fix the build/, 'rows already known still show');
    assert.match(earlyUpdates, /<button class="knowledge-button" disabled title="Available once updates load\.">/, 'Mark all updates read waits for updates');
    const loadedUpdates = await render(needsYou([blocked], true), 'updates');
    assert.match(loadedUpdates, /class="knowledge-total">1</);
    assert.match(loadedUpdates, /title="Mark the 1 displayed updates read\. New activity will still appear\."/);

    assert.match(await render(needsYou([], false), 'updates', true), /Checking your rooms/, 'an empty list reads as loading while the read runs');
    const notLoaded = await render(needsYou([], false), 'updates');
    assert.match(notLoaded, /Updates aren’t loaded/); assert.doesNotMatch(notLoaded, /No unread updates to show/);
    assert.match(await render(needsYou([], true), 'updates'), /No unread updates to show/);
  } finally { await vite.close(); }
});

test('a single-room re-read keeps updatesIncluded from the full read', async () => {
  const priorWindow = globalThis.window;
  Object.assign(globalThis, { window: { letagentsDesktop: { room: {
    getNeedsYou: async () => needsYou([room(REPO, [failedCheck('evt_1')])], true),
    getNeedsYouRoom: async () => ({ records: [], truncated: false, tasks: [], boardIntents: undefined }),
  }, workers: { listManagedAgentSessions: async () => [] } } } });
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  let inbox!: ReturnType<typeof useNeedsYou>;
  const app = renderer.createApp({ setup() { inbox = useNeedsYou(); return () => null; } }); app.mount({});
  try {
    await inbox.refresh(true);
    assert.equal(inbox.data.value?.updatesIncluded, true);
    await inbox.refreshRoom(REPO);
    assert.equal(inbox.data.value?.updatesIncluded, true);
    assert.equal(inbox.data.value?.rooms[0].updates?.githubEvents?.events.length, 1, 'the room keeps its updates too');
  } finally { app.unmount(); Object.assign(globalThis, { window: priorWindow }); }
});
