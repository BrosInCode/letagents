import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubRoomChatEventKind } from '../../../shared/room-settings.mjs';
import type { Message, Project } from '../db.js';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { createGitHubChatEventGate } = await import('../github/room-event-projection/chat-event-gate.js');
const { createTaskActivityMessageEmitters } = await import('../tasks/activity-messages.js');

const room = (id: string, overrides: Partial<Project> = {}): Project => ({
  id, code: null, display_name: id, kind: 'main', parent_room_id: null, focus_key: null, source_task_id: null,
  focus_status: null, focus_parent_visibility: null, focus_activity_scope: null, focus_github_event_routing: null,
  focus_archived_at: null, git_lifecycle_event_order_at: null, concluded_at: null, conclusion_summary: null,
  conclusion_details: null, created_at: '2026-09-30T00:00:00.000Z', ...overrides,
} as Project);
const focusRoom = (id: string, parent: string, overrides: Partial<Project> = {}) => room(id, {
  kind: 'focus', parent_room_id: parent, focus_key: 'task_1', source_task_id: 'task_1', focus_status: 'active',
  focus_parent_visibility: 'major_activity', focus_activity_scope: 'task_and_branch', focus_github_event_routing: 'all_parent_repo',
  ...overrides,
});

function chosen(entries: Record<string, GitHubRoomChatEventKind[]>) {
  const queries: string[][] = [];
  const load = async (ids: readonly string[]) => {
    queries.push([...ids]);
    return new Map(ids.filter(id => id in entries).map(id => [id, entries[id]] as const));
  };
  return { load, queries };
}

test('a room with no choice follows its parent, then the repository room, then takes everything', async () => {
  const gate = (entries: Record<string, GitHubRoomChatEventKind[]>) =>
    createGitHubChatEventGate({ eventKind: 'pull_request', repoRoomId: 'repo', load: chosen(entries).load });
  const focus = focusRoom('focus_1', 'branch');
  assert.equal(await gate({}).accepts(focus), true);
  assert.equal(await gate({ repo: ['issue'] }).accepts(focus), false);
  assert.equal(await gate({ repo: ['issue'], branch: ['pull_request'] }).accepts(focus), true);
  assert.equal(await gate({ repo: ['pull_request'], branch: ['pull_request'], focus_1: [] }).accepts(focus), false);
  assert.equal(await gate({ repo: [], focus_1: ['pull_request'] }).accepts(focus), true);
});

test('an event with no kind is never filtered and costs no query', async () => {
  const settings = chosen({ repo: [] });
  const gate = createGitHubChatEventGate({ eventKind: null, repoRoomId: 'repo', load: settings.load });
  assert.equal(await gate.accepts(room('repo')), true);
  assert.deepEqual(await gate.filter([focusRoom('focus_1', 'repo')]), [focusRoom('focus_1', 'repo')]);
  assert.deepEqual(settings.queries, []);
});

test('many rooms are asked about in one query, and no room is asked about twice', async () => {
  const settings = chosen({ focus_2: [], repo: ['pull_request'] });
  const gate = createGitHubChatEventGate({ eventKind: 'pull_request', repoRoomId: 'repo', load: settings.load });
  const rooms = [1, 2, 3, 4].map(n => focusRoom(`focus_${n}`, 'repo'));
  assert.deepEqual((await gate.filter(rooms)).map(r => r.id), ['focus_1', 'focus_3', 'focus_4']);
  assert.equal(settings.queries.length, 1);
  assert.deepEqual([...settings.queries[0]].sort(), ['focus_1', 'focus_2', 'focus_3', 'focus_4', 'repo']);
  assert.equal(await gate.accepts(rooms[1]), false);
  assert.equal(await gate.accepts(room('repo')), true);
  assert.equal(settings.queries.length, 1, 'answers already loaded are reused');
});

/** Runs with a settings lookup that fails, and reports what was logged and what was left unhandled. */
async function withUnreadableSettings(
  load: () => Promise<Map<string, GitHubRoomChatEventKind[]>>,
  run: (gate: ReturnType<typeof createGitHubChatEventGate>) => Promise<void>,
) {
  const logged: unknown[] = []; const unhandled: unknown[] = [];
  const original = console.error;
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  console.error = (...args: unknown[]) => { logged.push(args); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run(createGitHubChatEventGate({ eventKind: 'pull_request', repoRoomId: 'repo', load }));
    // An unhandled rejection is reported after the current turn of the event loop.
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    console.error = original;
    process.off('unhandledRejection', onUnhandled);
  }
  return { logged, unhandled };
}
const unreadable = async () => { throw new Error('relation "room_settings" does not exist'); };

test('when settings cannot be read the event is delivered, as it always was', async () => {
  const result = await withUnreadableSettings(unreadable, async gate => {
    assert.equal(await gate.accepts(room('repo')), true);
  });
  assert.equal(result.logged.length, 1, 'the failure is logged once');
  assert.deepEqual(result.unhandled, []);
});

test('a failed lookup for a room with several candidates leaves nothing unhandled', async () => {
  // A focus room is asked about together with its parent and the repository
  // room. A rejection left on any of them would end the API process.
  const result = await withUnreadableSettings(unreadable, async gate => {
    assert.equal(await gate.accepts(focusRoom('focus_1', 'branch')), true);
    assert.deepEqual((await gate.filter([focusRoom('focus_2', 'repo'), focusRoom('focus_3', 'repo')])).map(r => r.id), ['focus_2', 'focus_3']);
    assert.equal(await gate.accepts(room('repo')), true, 'a room whose lookup already failed still delivers');
  });
  assert.deepEqual(result.unhandled, []);
  assert.equal(result.logged.length, 2, 'once for each lookup that failed, not once for each room');
});

test('an answer of the wrong shape is a failed read, not a crash', async () => {
  const result = await withUnreadableSettings((async () => ({ repo: ['issue'] })) as never, async gate => {
    assert.equal(await gate.accepts(focusRoom('focus_1', 'repo')), true);
    assert.deepEqual((await gate.filter([focusRoom('focus_2', 'repo')])).map(r => r.id), ['focus_2']);
  });
  assert.deepEqual(result.unhandled, []);
  assert.equal(result.logged.length, 2);
});

test('a lookup that throws before it returns a promise is handled the same way', async () => {
  const result = await withUnreadableSettings((() => { throw new Error('pool is closed'); }) as never, async gate => {
    assert.equal(await gate.accepts(focusRoom('focus_1', 'repo')), true);
  });
  assert.deepEqual(result.unhandled, []);
});

function emitters(focus: Project | null) {
  const posted: Array<{ room: string; sender: string; id: string | null }> = [];
  const parent = room('repo');
  const made = createTaskActivityMessageEmitters({
    getProjectById: async id => id === parent.id ? parent : null,
    getActiveFocusRoomForTask: async () => focus,
    getFocusRoomsForParent: async () => focus ? [focus] : [],
    emitProjectMessage: async (projectId, sender, _text, options) => {
      posted.push({ room: projectId, sender, id: options?.client_message_id ?? null });
      return { id: `msg_${posted.length}` } as Message;
    },
  });
  return { ...made, posted };
}
const task = { id: 'task_1', title: 'Add room settings' };
const github = { source: 'github', event_kind: 'github' as const, parent_event_kind: 'major_activity' as const,
  github_routing_context: { matched_task_reference: true }, client_message_id: 'e:task-event', parent_client_message_id: 'e:task-event-anchor' };
const only = (...accepted: string[]) => async (candidate: { id: string }) => accepted.includes(candidate.id);

test('without a filter a task message is posted exactly as before', async () => {
  const withFocus = emitters(focusRoom('focus_1', 'repo'));
  assert.ok(await withFocus.emitTaskAnchoredMessage('repo', 'github', 'PR #7 opened', task, github));
  assert.deepEqual(withFocus.posted, [
    { room: 'focus_1', sender: 'github', id: 'e:task-event' },
    { room: 'repo', sender: 'letagents', id: 'e:task-event-anchor' },
  ]);
  const withoutFocus = emitters(null);
  await withoutFocus.emitTaskAnchoredMessage('repo', 'github', 'PR #7 opened', task, github);
  assert.deepEqual(withoutFocus.posted, [{ room: 'repo', sender: 'github', id: 'e:task-event' }]);
});

test('the filter is asked about the focus room the message lands in, not the task\'s room', async () => {
  const mutedFocus = emitters(focusRoom('focus_1', 'repo'));
  assert.equal(await mutedFocus.emitTaskAnchoredMessage('repo', 'github', 'PR #7 opened', task, { ...github, shouldDeliverToRoom: only('repo') }), null);
  assert.deepEqual(mutedFocus.posted, [], 'nothing in the focus room, so nothing for the parent to point at');

  const mutedParent = emitters(focusRoom('focus_1', 'repo'));
  assert.ok(await mutedParent.emitTaskAnchoredMessage('repo', 'github', 'PR #7 opened', task, { ...github, shouldDeliverToRoom: only('focus_1') }));
  assert.deepEqual(mutedParent.posted, [{ room: 'focus_1', sender: 'github', id: 'e:task-event' }], 'the parent muted this kind, so it gets no pointer either');
});

test('a task with no focus room is filtered by its own room', async () => {
  const muted = emitters(null);
  assert.equal(await muted.emitTaskAnchoredMessage('repo', 'github', 'PR #7 opened', task, { ...github, shouldDeliverToRoom: only() }), null);
  assert.deepEqual(muted.posted, []);
  // A focus room that does not take this task's GitHub events leaves the message in the task's room.
  const unrouted = emitters(focusRoom('focus_1', 'repo', { focus_github_event_routing: 'off' }));
  await unrouted.emitTaskAnchoredMessage('repo', 'github', 'PR #7 opened', task, { ...github, shouldDeliverToRoom: only('repo') });
  assert.deepEqual(unrouted.posted, [{ room: 'repo', sender: 'github', id: 'e:task-event' }]);
});

test('the fan-out to focus rooms posts only to the rooms the filter keeps', async () => {
  const fanOut = emitters(focusRoom('focus_1', 'repo'));
  await fanOut.emitGitHubEventToAllParentRepoFocusRooms('repo', 'github', 'PR #7 opened', {
    client_message_id_base: 'e', filterRooms: async rooms => rooms.filter(r => r.id !== 'focus_1'),
  });
  assert.deepEqual(fanOut.posted, []);
  await fanOut.emitGitHubEventToAllParentRepoFocusRooms('repo', 'github', 'PR #7 opened', { client_message_id_base: 'e' });
  assert.deepEqual(fanOut.posted, [{ room: 'focus_1', sender: 'github', id: 'e:focus-broadcast' }]);
});
