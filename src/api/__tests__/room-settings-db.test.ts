import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { GITHUB_ROOM_CHAT_EVENT_KINDS, ROOM_AGENT_GUIDELINES_MAX_BYTES, normalizeRoomAgentGuidelines } from '../../../shared/room-settings.mjs';
import type { RepoRoomEvent } from '../repo-workflow.js';

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import('../db/client.js') : null;
const store = url ? await import('../db/room-settings.js') : null;
const rooms = url ? await import('../db.js') : null;
const delivery = url ? await import('../github/room-event-projection/message-delivery.js') : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve('drizzle') }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? 'Set TEST_DB_URL to run PostgreSQL integration tests.' : false };
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

const base = { provider: 'github' as const, repositoryFullName: 'org/repo', senderLogin: 'emmy' };
const pullRequestOpened: RepoRoomEvent = { ...base, kind: 'pull_request', action: 'opened',
  pullRequest: { number: 7, title: 'Add room settings', url: 'https://github.com/org/repo/pull/7' } };
const issueOpened: RepoRoomEvent = { ...base, kind: 'issue', action: 'opened',
  issue: { number: 8, title: 'Settings are hard to find', url: 'https://github.com/org/repo/issues/8' } };

async function post(project: any, roomEvent: RepoRoomEvent, eventProject: any = project) {
  await delivery!.emitRepoRoomEventProjectionMessage({
    project, eventProject, roomEvent, linkedTask: undefined,
    taskProjection: { task: undefined, authoritative: false },
    isolatedFocusRoom: null, githubRoutingContext: {}, messageIdBase: unique('github-event'),
  });
}
const githubMessages = async (roomId: string) =>
  (await rooms!.getMessages(roomId)).messages.filter(message => message.source === 'github').map(message => message.text);

test('a room with no choice posts every kind; a choice is stored and replaced', options, async () => {
  const room = await rooms!.createProjectWithName(unique('settings-kinds'));
  assert.deepEqual(await store!.resolveGitHubRoomChatEventKinds([room.id]), { enabled_kinds: [...GITHUB_ROOM_CHAT_EVENT_KINDS], source_room_id: null });
  await store!.setGitHubRoomChatEventKinds(room.id, ['pull_request', 'review']);
  await store!.setGitHubRoomChatEventKinds(room.id, ['issue']);
  assert.deepEqual(await store!.resolveGitHubRoomChatEventKinds([room.id]), { enabled_kinds: ['issue'], source_room_id: room.id });
  await store!.setGitHubRoomChatEventKinds(room.id, []);
  assert.deepEqual(await store!.resolveGitHubRoomChatEventKinds([room.id]), { enabled_kinds: [], source_room_id: room.id });
});

test('the first candidate that has chosen decides', options, async () => {
  const child = await rooms!.createProjectWithName(unique('settings-child'));
  const parent = await rooms!.createProjectWithName(unique('settings-parent'));
  await store!.setGitHubRoomChatEventKinds(parent.id, ['review']);
  assert.deepEqual(await store!.resolveGitHubRoomChatEventKinds([child.id, parent.id]), { enabled_kinds: ['review'], source_room_id: parent.id });
  await store!.setGitHubRoomChatEventKinds(child.id, ['comment']);
  assert.deepEqual(await store!.resolveGitHubRoomChatEventKinds([child.id, parent.id]), { enabled_kinds: ['comment'], source_room_id: child.id });
  // Saving guidelines creates the row without choosing kinds, so the room still inherits.
  const other = await rooms!.createProjectWithName(unique('settings-other'));
  await store!.setRoomAgentGuidelines(other.id, 'Keep pull requests small.', 'Emmy');
  assert.deepEqual(await store!.resolveGitHubRoomChatEventKinds([other.id, parent.id]), { enabled_kinds: ['review'], source_room_id: parent.id });
});

test('guidelines are stored, replaced, cleared and bounded by the database', options, async () => {
  const room = await rooms!.createProjectWithName(unique('settings-guidelines'));
  assert.deepEqual(await store!.getRoomAgentGuidelines(room.id), { guidelines: null, updated_by: null, updated_at: null });
  await store!.setGitHubRoomChatEventKinds(room.id, ['issue']);
  const saved = await store!.setRoomAgentGuidelines(room.id, 'Branch from staging.', 'Emmy');
  assert.equal(saved.guidelines, 'Branch from staging.');
  assert.equal(saved.updated_by, 'Emmy');
  assert.ok(saved.updated_at);
  assert.equal((await store!.setRoomAgentGuidelines(room.id, 'x'.repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES), 'Ada')).updated_by, 'Ada');
  await assert.rejects(store!.setRoomAgentGuidelines(room.id, 'x'.repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES + 1), 'Ada'));
  // The database counts bytes too: 2,667 Chinese characters are 8,001 bytes.
  await assert.rejects(store!.setRoomAgentGuidelines(room.id, '规'.repeat(2667), 'Ada'));
  assert.equal((await store!.setRoomAgentGuidelines(room.id, '规'.repeat(2666), 'Ada')).guidelines!.length, 2666);
  assert.equal((await store!.setRoomAgentGuidelines(room.id, 'x'.repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES), 'Ada')).guidelines!.length, ROOM_AGENT_GUIDELINES_MAX_BYTES);
  // Normalized text is always storable, whatever was pasted or imported.
  const hostile = normalizeRoomAgentGuidelines('a\u0000b \uD83D c 😀 规则\r\n\u0007done');
  assert.equal((await store!.setRoomAgentGuidelines(room.id, hostile, 'Ada')).guidelines, hostile);
  await store!.setRoomAgentGuidelines(room.id, 'x'.repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES), 'Ada');
  assert.equal((await store!.getRoomAgentGuidelines(room.id)).guidelines!.length, ROOM_AGENT_GUIDELINES_MAX_BYTES);
  assert.equal((await store!.setRoomAgentGuidelines(room.id, '', 'Ada')).guidelines, null);
  // Clearing guidelines leaves the room's chosen kinds alone.
  assert.deepEqual((await store!.resolveGitHubRoomChatEventKinds([room.id])).enabled_kinds, ['issue']);
});

test('guidelines come from the first candidate that has them', options, async () => {
  const focus = await rooms!.createProjectWithName(unique('settings-focus'));
  const parent = await rooms!.createProjectWithName(unique('settings-focus-parent'));
  assert.equal((await store!.resolveRoomAgentGuidelines([focus.id, parent.id])).source_room_id, null);
  await store!.setRoomAgentGuidelines(parent.id, 'Branch from staging.', 'Ada');
  // A row that only chose event kinds has no guidelines, so the parent still decides.
  await store!.setGitHubRoomChatEventKinds(focus.id, ['issue']);
  const inherited = await store!.resolveRoomAgentGuidelines([focus.id, parent.id]);
  assert.equal(inherited.guidelines, 'Branch from staging.');
  assert.equal(inherited.source_room_id, parent.id);
  await store!.setRoomAgentGuidelines(focus.id, 'Touch only billing.', 'Emmy');
  assert.equal((await store!.resolveRoomAgentGuidelines([focus.id, parent.id])).source_room_id, focus.id);
  await store!.setRoomAgentGuidelines(focus.id, '', 'Emmy');
  assert.equal((await store!.resolveRoomAgentGuidelines([focus.id, parent.id])).source_room_id, parent.id);
});

test('settings follow a room that is renamed and leave with a room that is deleted', options, async () => {
  const room = await rooms!.createProjectWithName(unique('settings-rename'));
  await store!.setRoomAgentGuidelines(room.id, 'No self-review.', 'Emmy');
  const renamed = `${room.id}-renamed`;
  await client!.pool.query('UPDATE rooms SET id = $1 WHERE id = $2', [renamed, room.id]);
  assert.equal((await store!.getRoomAgentGuidelines(renamed)).guidelines, 'No self-review.');
  await client!.pool.query('DELETE FROM rooms WHERE id = $1', [renamed]);
  assert.equal((await client!.pool.query('SELECT 1 FROM room_settings WHERE room_id = $1', [renamed])).rowCount, 0);
});

test('a kind that is turned off is not posted to the room; the others still are', options, async () => {
  const room = await rooms!.createProjectWithName(unique('settings-delivery'));
  await post(room, pullRequestOpened);
  assert.equal((await githubMessages(room.id)).length, 1, 'posted before the room chose');
  await store!.setGitHubRoomChatEventKinds(room.id, ['issue', 'review']);
  await post(room, pullRequestOpened);
  assert.equal((await githubMessages(room.id)).length, 1, 'pull requests are off for this room');
  await post(room, issueOpened);
  const posted = await githubMessages(room.id);
  assert.equal(posted.length, 2);
  assert.match(posted[1], /Issue #8/);
  await store!.setGitHubRoomChatEventKinds(room.id, []);
  await post(room, issueOpened);
  assert.equal((await githubMessages(room.id)).length, 2, 'nothing is posted when every kind is off');
});

test('a branch room follows its repository room until it chooses for itself', options, async () => {
  const repoRoom = await rooms!.createProjectWithName(unique('settings-repo'));
  const branchRoom = await rooms!.createProjectWithName(unique('settings-branch'));
  await store!.setGitHubRoomChatEventKinds(repoRoom.id, ['issue']);
  await post(repoRoom, pullRequestOpened, branchRoom);
  assert.equal((await githubMessages(branchRoom.id)).length, 0, 'inherits the repository room\'s choice');
  await store!.setGitHubRoomChatEventKinds(branchRoom.id, ['pull_request']);
  await post(repoRoom, pullRequestOpened, branchRoom);
  assert.equal((await githubMessages(branchRoom.id)).length, 1, 'its own choice wins');
  assert.equal((await githubMessages(repoRoom.id)).length, 0, 'the repository room is a different room and got nothing');
});

async function taskWithFocusRoom(label: string) {
  const parent = await rooms!.createProjectWithName(unique(label));
  const task = await rooms!.createTask(parent.id, 'Add room settings', 'emmy');
  const focus = (await rooms!.createFocusRoomForTask(parent.id, task.id))!.room;
  return { parent, task, focus };
}
async function postForTask(parent: any, task: any) {
  await delivery!.emitRepoRoomEventProjectionMessage({
    project: parent, eventProject: parent, roomEvent: pullRequestOpened, linkedTask: task,
    taskProjection: { task, authoritative: true }, isolatedFocusRoom: null,
    githubRoutingContext: { matched_task_reference: true }, messageIdBase: unique('github-task-event'),
  });
}
const allMessages = async (roomId: string) => (await rooms!.getMessages(roomId)).messages.map(message => message.source ?? message.sender);

test('an event for a task is filtered by the focus room it lands in', options, async () => {
  const unfiltered = await taskWithFocusRoom('settings-task-open');
  await postForTask(unfiltered.parent, unfiltered.task);
  assert.equal((await githubMessages(unfiltered.focus.id)).length, 1, 'with no choice anywhere it lands in the focus room');

  const muted = await taskWithFocusRoom('settings-task-muted');
  await store!.setGitHubRoomChatEventKinds(muted.focus.id, []);
  await postForTask(muted.parent, muted.task);
  assert.equal((await githubMessages(muted.focus.id)).length, 0, 'the focus room turned every kind off');
  assert.deepEqual(await allMessages(muted.parent.id), [], 'and the parent is not pointed at activity that was not posted');
});

test('a focus room\'s own choice wins over its parent\'s, in both directions', options, async () => {
  const own = await taskWithFocusRoom('settings-task-own');
  await store!.setGitHubRoomChatEventKinds(own.parent.id, []);
  await store!.setGitHubRoomChatEventKinds(own.focus.id, ['pull_request']);
  await postForTask(own.parent, own.task);
  assert.equal((await githubMessages(own.focus.id)).length, 1, 'the focus room chose pull requests for itself');
  assert.equal((await githubMessages(own.parent.id)).length, 0);

  const inherited = await taskWithFocusRoom('settings-task-inherited');
  await store!.setGitHubRoomChatEventKinds(inherited.parent.id, ['issue']);
  await postForTask(inherited.parent, inherited.task);
  assert.equal((await githubMessages(inherited.focus.id)).length, 0, 'a focus room with no choice follows its parent');
});

test('events are still delivered, and the process survives, when settings cannot be read', options, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const loadChatEventKinds = async () => { throw new Error('relation "room_settings" does not exist'); };
  try {
    const room = await rooms!.createProjectWithName(unique('settings-lookup-fails'));
    await delivery!.emitRepoRoomEventProjectionMessage({
      project: room, eventProject: room, roomEvent: pullRequestOpened, linkedTask: undefined,
      taskProjection: { task: undefined, authoritative: false }, isolatedFocusRoom: null,
      githubRoutingContext: {}, messageIdBase: unique('github-event'), loadChatEventKinds,
    });
    assert.equal((await githubMessages(room.id)).length, 1);

    // A task with a focus room asks about several rooms at once.
    const { parent, task, focus } = await taskWithFocusRoom('settings-lookup-fails-task');
    await delivery!.emitRepoRoomEventProjectionMessage({
      project: parent, eventProject: parent, roomEvent: pullRequestOpened, linkedTask: task,
      taskProjection: { task, authoritative: true }, isolatedFocusRoom: null,
      githubRoutingContext: { matched_task_reference: true }, messageIdBase: unique('github-task-event'), loadChatEventKinds,
    });
    assert.equal((await githubMessages(focus.id)).length, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
});
