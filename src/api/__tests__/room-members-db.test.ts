import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  databaseTestOptions,
  dbApi,
  pool,
  startApiServer,
  stopChildProcess,
} from './coordination-db/harness.js';

const ONE_HOUR = 60 * 60 * 1000;

async function person(login: string) {
  const account = await dbApi.upsertAccount!({
    provider: 'github',
    provider_user_id: `members-${login}`,
    login,
    display_name: login,
  });
  const token = `members_session_${login}`;
  await dbApi.createSession!(account.id, token, new Date(Date.now() + ONE_HOUR).toISOString());
  return { id: account.id, login, token };
}

function client(port: number) {
  return async (method: string, route: string, token: string | null, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
}

async function insertFocusRoom(id: string, parentRoomId: string): Promise<void> {
  await pool!.query(`INSERT INTO rooms (id, display_name, kind, parent_room_id, focus_key, focus_status, created_at)
    VALUES ($1, $1, 'focus', $2, $1, 'active', now())`, [id, parentRoomId]);
}

async function insertMessage(input: {
  roomId: string;
  number: number;
  accountId: string | null;
  agentSessionId?: string | null;
  at: string;
}): Promise<void> {
  await pool!.query(`INSERT INTO messages (room_id, number, sender, text, timestamp, publisher_account_id, publisher_agent_session_id)
    VALUES ($1, $2, 'someone', 'hello', $3, $4, $5)`,
  [input.roomId, input.number, input.at, input.accountId, input.agentSessionId ?? null]);
}

async function agentSession(roomId: string, ownerAccountId: string, name: string) {
  return dbApi.createRoomAgentSession!({
    room_id: roomId,
    session_kind: 'worker',
    runtime: 'codex',
    actor_label: `${name} | Agent`,
    agent_key: `owner/${name}`,
    agent_instance_id: `instance:${name}`,
    display_name: name,
    owner_account_id: ownerAccountId,
    owner_label: 'Owner',
    ide_label: 'Codex',
  } as any);
}

async function seedStatements(): Promise<string[]> {
  const sql = await readFile(path.resolve(process.cwd(), 'drizzle/0133_room_members.sql'), 'utf8');
  return sql.split('--> statement-breakpoint').map((part) => part.trim()).filter((part) => part.startsWith('WITH'));
}

async function members(): Promise<string[]> {
  const result = await pool!.query<{ room_id: string; login: string; added_via: string }>(`SELECT m.room_id, a.login, m.added_via
    FROM room_members m JOIN accounts a ON a.id = m.account_id ORDER BY m.room_id, a.login`);
  return result.rows.map((row) => `${row.room_id}:${row.login}:${row.added_via}`);
}

async function admins(): Promise<string[]> {
  const result = await pool!.query<{ project_id: string; login: string }>(`SELECT p.project_id, a.login
    FROM project_admins p JOIN accounts a ON a.id = p.account_id ORDER BY p.project_id, a.login`);
  return result.rows.map((row) => `${row.project_id}:${row.login}`);
}

test('a room creator, a join request and an admin decision, through the real server', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const alice = await person('alice');
  const bob = await person('bob');
  await dbApi.createOwnerToken!({ accountId: alice.id, githubUserId: 'members-alice', token: 'alice_owner_token', providerAccessToken: null } as any);

  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const created = await call('POST', '/projects/room/design-lounge', owner.token);
  assert.equal(created.status, 201);
  const roomId = created.body.id as string;
  assert.deepEqual(await members(), [`${roomId}:owner:creator`], 'the creator is the first member');
  assert.deepEqual(await admins(), [`${roomId}:owner`], 'and the first admin');

  const ownerState = await call('GET', `/rooms/${roomId}/membership`, owner.token);
  assert.equal(ownerState.body.role, 'admin');

  assert.equal((await call('GET', `/rooms/${roomId}/membership`, null)).status, 401);
  const aliceState = await call('GET', `/rooms/${roomId}/membership`, alice.token);
  assert.equal(aliceState.status, 200);
  assert.equal(aliceState.body.member, false);
  assert.equal(aliceState.body.join_request, null);
  const refused = await call('GET', `/rooms/${roomId}/members`, alice.token);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'ROOM_MEMBERSHIP_REQUIRED');

  // Alice asks from her own MCP client (owner token). A second ask returns the same request.
  const asked = await call('POST', `/rooms/${roomId}/join-requests`, 'alice_owner_token');
  assert.equal(asked.status, 201);
  assert.equal(asked.body.join_request.state, 'pending');
  const askedAgain = await call('POST', `/rooms/${roomId}/join-requests`, alice.token);
  assert.equal(askedAgain.status, 200);
  assert.equal(askedAgain.body.join_request.id, asked.body.join_request.id);
  assert.equal((await call('GET', `/rooms/${roomId}/members`, alice.token)).body.join_request.state, 'pending');

  const inbox = await call('GET', '/account/room-join-requests', owner.token);
  assert.equal(inbox.body.join_requests.length, 1);
  assert.equal(inbox.body.join_requests[0].login, 'alice');
  assert.equal(inbox.body.join_requests[0].room_display_name, created.body.display_name);
  assert.deepEqual((await call('GET', '/account/room-join-requests', alice.token)).body.join_requests, []);

  const requestId = asked.body.join_request.id as string;
  assert.equal((await call('POST', `/rooms/${roomId}/join-requests/${requestId}/approve`, alice.token)).status, 403,
    'a person who is not an admin cannot decide a request');
  for (const route of [`/rooms/${roomId}/members`, `/rooms/${roomId}/join-requests`, '/account/room-join-requests']) {
    assert.equal((await call('GET', route, 'alice_owner_token')).body.code, 'PERSON_REQUIRED', `${route} is for a person in the app`);
  }
  const declined = await call('POST', `/rooms/${roomId}/join-requests/${requestId}/decline`, owner.token);
  assert.equal(declined.status, 200);
  assert.equal(declined.body.join_request.state, 'declined');
  assert.equal(declined.body.join_request.decided_by_login, 'owner');
  const cooldown = await call('POST', `/rooms/${roomId}/join-requests`, alice.token);
  assert.equal(cooldown.status, 429);
  assert.equal(cooldown.body.code, 'ROOM_JOIN_REQUEST_COOLDOWN');
  assert.ok(Date.parse(cooldown.body.retry_after) > Date.now() + 23 * ONE_HOUR);
  const lateApproval = await call('POST', `/rooms/${roomId}/join-requests/${requestId}/approve`, owner.token);
  assert.equal(lateApproval.status, 409);
  assert.equal(lateApproval.body.code, 'ROOM_JOIN_REQUEST_NOT_PENDING');

  // Bob asks, is let in, and then sees the room's members.
  const bobAsked = await call('POST', `/rooms/${roomId}/join-requests`, bob.token);
  const approved = await call('POST', `/rooms/${roomId}/join-requests/${bobAsked.body.join_request.id}/approve`, owner.token);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.member.login, 'bob');
  assert.equal(approved.body.member.added_via, 'approved_request');
  assert.equal((await call('POST', `/rooms/${roomId}/join-requests/${bobAsked.body.join_request.id}/approve`, owner.token)).status, 200,
    'the same decision again is done, not an error');
  assert.equal((await call('POST', `/rooms/${roomId}/join-requests`, bob.token)).body.code, 'ROOM_ALREADY_MEMBER');
  const list = await call('GET', `/rooms/${roomId}/members`, bob.token);
  assert.deepEqual(list.body.members.map((m: any) => `${m.login}:${m.role}`), ['owner:admin', 'bob:member']);
  assert.equal(list.body.can_manage, false);

  // A focus room uses the members of its parent room.
  await insertFocusRoom('focus_41', roomId);
  const focus = await call('GET', '/rooms/focus_41/membership', bob.token);
  assert.equal(focus.body.access_room_id, roomId);
  assert.equal(focus.body.member, true);
  assert.equal((await call('GET', '/rooms/focus_41/members', alice.token)).status, 403);

  // The last admin can neither leave nor step down; with a second admin, both work.
  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${owner.id}`, owner.token)).body.code, 'ROOM_LAST_ADMIN');
  assert.equal((await call('PUT', `/rooms/${roomId}/members/${owner.id}/role`, owner.token, { role: 'member' })).body.code, 'ROOM_LAST_ADMIN');
  const promoted = await call('PUT', `/rooms/${roomId}/members/${bob.id}/role`, owner.token, { role: 'admin' });
  assert.equal(promoted.body.member.role, 'admin');
  const left = await call('DELETE', `/rooms/${roomId}/members/${owner.id}`, owner.token);
  assert.deepEqual(left.body, { removed: true, account_id: owner.id, ended_agent_sessions: 0, ended_agent_asks: 0 });
  assert.equal((await call('GET', `/rooms/${roomId}/membership`, owner.token)).body.member, false);
  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${alice.id}`, bob.token)).status, 404);
});

test('removing a member ends their agents in the room and its focus rooms, but not a lent agent', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const bob = await person('bob');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const roomId = (await call('POST', '/projects/room/build-lounge', owner.token)).body.id as string;
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, bob.id]);
  await insertFocusRoom('focus_42', roomId);
  const inRoom = await agentSession(roomId, bob.id, 'bayotter');
  const inFocus = await agentSession('focus_42', bob.id, 'dawnwinter');
  const lent = await agentSession(roomId, bob.id, 'lentfox');
  await pool!.query(`INSERT INTO supervisor_host_grants (grant_id, owner_account_id, host_id, installation_id, scope_key,
      token_hash, allowed_room_ids, allowed_agent_keys, issued_at, expires_at, created_at, updated_at)
    VALUES ('grant_ask', $1, 'host', 'install', 'ask:ask_1', 'grant-hash', ARRAY[$2], ARRAY['owner/lentfox'],
      now(), now() + interval '1 hour', now(), now())`, [bob.id, roomId]);
  await pool!.query(`UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_ask' WHERE session_id = $1`, [lent.session_id]);
  // An agent someone else gave bob through an agent ask, restarted once under its grant.
  const giver = await person('giver');
  await pool!.query(`INSERT INTO supervisor_host_grants (grant_id, owner_account_id, host_id, installation_id, scope_key,
      token_hash, allowed_room_ids, allowed_agent_keys, issued_at, expires_at, created_at, updated_at)
    VALUES ('grant_given', $1, 'host2', 'install2', 'ask:ask_given', 'given-hash', ARRAY[$2], ARRAY['owner/givenfox'],
      now(), now() + interval '1 hour', now(), now())`, [giver.id, roomId]);
  const firstGiven = await agentSession(roomId, giver.id, 'givenfox');
  await pool!.query(`UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_given', ended_at = now() WHERE session_id = $1`,
    [firstGiven.session_id]);
  const restartedGiven = await agentSession(roomId, giver.id, 'givenfox2');
  await pool!.query(`UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_given' WHERE session_id = $1`, [restartedGiven.session_id]);
  await pool!.query(`INSERT INTO agent_asks (id, link_token_hash, room_id, asker_account_id, provider_id, model_label, state,
      expires_at, giver_account_id, grant_id, room_agent_session_id)
    VALUES ('ask_given', 'given-link', $1, $2, 'claude', 'Claude', 'active', now() + interval '1 day', $3, 'grant_given', $4)`,
  [roomId, bob.id, giver.id, firstGiven.session_id]);

  const removed = await call('DELETE', `/rooms/${roomId}/members/${bob.id}`, owner.token);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ended_agent_sessions, 2);
  assert.equal(removed.body.ended_agent_asks, 1);
  const ask = await pool!.query<{ state: string }>(`SELECT state FROM agent_asks WHERE id = 'ask_given'`);
  assert.equal(ask.rows[0]?.state, 'ended', 'the ask made by the removed person ends');
  const grant = await pool!.query<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM supervisor_host_grants WHERE grant_id = 'grant_given'`);
  assert.equal(grant.rows[0]?.revoked, true, 'and its grant is revoked, so the agent cannot start again');
  const sessions = await pool!.query<{ session_id: string; ended: boolean; end_reason: string | null }>(
    `SELECT session_id, ended_at IS NOT NULL AS ended, end_reason FROM room_agent_sessions`);
  const byId = new Map(sessions.rows.map((row) => [row.session_id, row]));
  assert.equal(byId.get(inRoom.session_id)?.ended, true);
  assert.equal(byId.get(inRoom.session_id)?.end_reason, 'room_admin');
  assert.equal(byId.get(inFocus.session_id)?.ended, true);
  assert.equal(byId.get(lent.session_id)?.ended, false, 'an agent bob lent to someone else keeps working under its grant');
  assert.equal(byId.get(restartedGiven.session_id)?.ended, true, 'the restarted agent of bob\'s ask ends too');
});

test('the seed adds people with proof and nobody else, changes no admin, and is safe to run again', databaseTestOptions, async () => {
  const [admin, poster, agentOwner, lender, focusPoster, repoPoster, early, late, onlyAgent, focusAdmin, removedPoster, giver, asker] =
    await Promise.all(['admin', 'poster', 'agentowner', 'lender', 'focusposter', 'repoposter', 'early', 'late', 'onlyagent',
      'focusadmin', 'removedposter', 'giver', 'asker'].map(person));
  await pool!.query(`INSERT INTO rooms (id, display_name, created_at) VALUES
    ('lounge-a', 'A', now()), ('lounge-b', 'B', now()), ('lounge-c', 'C', now()), ('github.com/acme/app', 'acme/app', now()),
    ('gitlab.com/group/sub/project', 'project', now()), ('bound-lounge', 'Bound', now())`);
  await insertFocusRoom('focus_43', 'lounge-a');
  await dbApi.assignProjectAdmin!('lounge-a', admin.id);
  // A focus-room admin row alone is not proof: the first joiner of a focus room got one.
  await dbApi.assignProjectAdmin!('focus_43', focusAdmin.id);
  // A person removed from the room is never added back by a seed.
  await insertMessage({ roomId: 'lounge-a', number: 10, accountId: removedPoster.id, at: '2026-08-01T00:05:00Z' });
  await pool!.query(`INSERT INTO room_member_removals (room_id, account_id) VALUES ('lounge-a', $1)`, [removedPoster.id]);
  // An agent given through an agent ask: its owner (the giver) is not a member.
  const given = await agentSession('lounge-a', giver.id, 'givenagent');
  await pool!.query(`INSERT INTO agent_asks (id, link_token_hash, room_id, asker_account_id, provider_id, model_label,
      expires_at, room_agent_session_id) VALUES ('ask_seed', 'ask-hash', 'lounge-a', $1, 'claude', 'Claude', now() + interval '1 day', $2)`,
  [asker.id, given.session_id]);
  // Rooms whose GitHub role decides get no member rows.
  await insertMessage({ roomId: 'gitlab.com/group/sub/project', number: 1, accountId: repoPoster.id, at: '2026-08-01T00:00:00Z' });
  await insertMessage({ roomId: 'bound-lounge', number: 1, accountId: repoPoster.id, at: '2026-08-01T00:00:00Z' });
  await pool!.query(`INSERT INTO room_git_bindings (room_id, provider, host, repository_full_name, repository_owner,
      repository_name, ref_type, ref_name, source, created_at, updated_at)
    VALUES ('bound-lounge', 'github', 'github.com', 'acme/app', 'acme', 'app', 'branch', 'main', 'manual', now(), now())`);

  // Room A: a signed-in poster, an anonymous poster, an agent owner, a lent agent whose
  // own messages carry the lender's account, and a poster in a focus room.
  await insertMessage({ roomId: 'lounge-a', number: 1, accountId: poster.id, at: '2026-08-01T00:00:00Z' });
  await insertMessage({ roomId: 'lounge-a', number: 2, accountId: null, at: '2026-08-01T00:01:00Z' });
  await agentSession('lounge-a', agentOwner.id, 'ownagent');
  const lent = await agentSession('lounge-a', lender.id, 'lentagent');
  await pool!.query(`INSERT INTO supervisor_host_grants (grant_id, owner_account_id, host_id, installation_id, scope_key,
      token_hash, allowed_room_ids, allowed_agent_keys, issued_at, expires_at, created_at, updated_at, rental_session_id)
    VALUES ('grant_rent', $1, 'host', 'install', 'owner', 'rent-hash', ARRAY['lounge-a'], ARRAY['owner/lentagent'],
      now(), now() + interval '1 hour', now(), now(), 'rental_1')`, [lender.id]);
  await pool!.query(`UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_rent' WHERE session_id = $1`, [lent.session_id]);
  await insertMessage({ roomId: 'lounge-a', number: 3, accountId: lender.id, agentSessionId: lent.session_id, at: '2026-08-01T00:02:00Z' });
  await insertMessage({ roomId: 'focus_43', number: 1, accountId: focusPoster.id, at: '2026-08-01T00:03:00Z' });
  // A repo room gets no member rows: the GitHub role decides there.
  await insertMessage({ roomId: 'github.com/acme/app', number: 1, accountId: repoPoster.id, at: '2026-08-01T00:00:00Z' });
  // Rooms B and C have no admin. The seed leaves them so; the release that
  // turns the members-only rule on gives each one an admin.
  await insertMessage({ roomId: 'lounge-b', number: 1, accountId: late.id, at: '2026-08-02T00:00:00Z' });
  await insertMessage({ roomId: 'lounge-b', number: 2, accountId: early.id, at: '2026-08-01T00:00:00Z' });
  await agentSession('lounge-c', onlyAgent.id, 'loneagent');

  await pool!.query('DELETE FROM room_members');
  await pool!.query(`DELETE FROM project_admins WHERE project_id NOT IN ('lounge-a', 'focus_43')`);
  const statements = await seedStatements();
  assert.equal(statements.length, 1);
  for (const statement of statements) await pool!.query(statement);

  const expectedMembers = [
    'lounge-a:admin:seed',
    'lounge-a:agentowner:seed',
    'lounge-a:focusposter:seed',
    'lounge-a:poster:seed',
    'lounge-b:early:seed',
    'lounge-b:late:seed',
    'lounge-c:onlyagent:seed',
  ];
  assert.deepEqual(await members(), expectedMembers);
  const expectedAdmins = ['focus_43:focusadmin', 'lounge-a:admin'];
  assert.deepEqual(await admins(), expectedAdmins);

  for (const statement of statements) await pool!.query(statement);
  assert.deepEqual(await members(), expectedMembers, 'a second run adds nothing');
  assert.deepEqual(await admins(), expectedAdmins);
});

test('a removed person is not added back by a later seed run; an approved request lets them in again', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const mallory = await person('mallory');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const roomId = (await call('POST', '/projects/room/watch-lounge', owner.token)).body.id as string;
  // A signed-in post from before the rule was on is proof for the seed.
  await insertMessage({ roomId, number: 1, accountId: mallory.id, at: '2026-10-01T00:00:00Z' });
  const [seed] = await seedStatements();
  await pool!.query(seed!);
  assert.equal((await call('GET', `/rooms/${roomId}/membership`, mallory.token)).body.member, true);

  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${mallory.id}`, owner.token)).status, 200);
  assert.equal((await call('POST', `/rooms/${roomId}/messages`, mallory.token, { sender: 'mallory', text: 'back' })).status, 403,
    'a removed person can no longer post');
  await pool!.query(seed!);
  assert.equal((await call('GET', `/rooms/${roomId}/membership`, mallory.token)).body.member, false, 'the removal stands');

  const asked = await call('POST', `/rooms/${roomId}/join-requests`, mallory.token);
  assert.equal((await call('POST', `/rooms/${roomId}/join-requests/${asked.body.join_request.id}/approve`, owner.token)).status, 200);
  assert.equal((await call('GET', `/rooms/${roomId}/membership`, mallory.token)).body.member, true);
  const removals = await pool!.query('SELECT 1 FROM room_member_removals WHERE room_id = $1 AND account_id = $2', [roomId, mallory.id]);
  assert.equal(removals.rowCount, 0, 'the approval clears the removal record');
});

test('admin changes: demotion drops focus-room admin rows, and two admins cannot remove each other at once', databaseTestOptions, async (t) => {
  const ada = await person('ada');
  const ben = await person('ben');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const roomId = (await call('POST', '/projects/room/admin-lounge', ada.token)).body.id as string;
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, ben.id]);
  await insertFocusRoom('focus_44', roomId);
  await dbApi.assignProjectAdmin!('focus_44', ben.id);
  assert.equal((await call('PUT', `/rooms/${roomId}/members/${ben.id}/role`, ada.token, { role: 'admin' })).status, 200);
  assert.equal((await call('PUT', `/rooms/${roomId}/members/${ben.id}/role`, ada.token, { role: 'member' })).status, 200);
  assert.deepEqual(await admins(), [`${roomId}:ada`], 'the demoted admin keeps no admin row in the focus room');

  assert.equal((await call('PUT', `/rooms/${roomId}/members/${ben.id}/role`, ada.token, { role: 'admin' })).status, 200);
  // Hold the room's admin lock, so that both removals pass every check made
  // before it and must decide under it.
  const store = await import('../db/room-members.js');
  const holder = await pool!.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`project_admin:${roomId}`]);
    const both = Promise.all([
      store.removeRoomMember(roomId, ben.id, ada.id),
      store.removeRoomMember(roomId, ada.id, ben.id),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await holder.query('COMMIT');
    const outcomes = (await both).map((outcome) => outcome.kind).sort();
    assert.deepEqual(outcomes, ['forbidden', 'removed'], 'the second removal sees that its caller is no longer an admin');
  } finally {
    holder.release();
  }
  assert.equal((await admins()).length, 1, 'the room keeps one admin');
});

test('opening a room makes nobody an admin: a stranger is refused, a member stays a member', databaseTestOptions, async (t) => {
  const seeded = await person('seeded');
  const stranger = await person('stranger');
  await pool!.query(`INSERT INTO rooms (id, display_name, created_at) VALUES ('old-lounge', 'Old', now())`);
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ('old-lounge', $1, 'seed')`, [seeded.id]);
  await insertFocusRoom('focus_45', 'old-lounge');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  assert.equal((await call('POST', '/rooms/old-lounge/join', stranger.token)).status, 403);
  assert.equal((await call('POST', '/rooms/focus_45/join', seeded.token)).body.role, 'participant');
  assert.equal((await call('POST', '/rooms/old-lounge/join', seeded.token)).body.role, 'participant');
  assert.deepEqual(await members(), ['old-lounge:seeded:seed'], 'the stranger got no member row');
  assert.deepEqual(await admins(), [], 'and nobody became an admin by opening a room; the release seed names one');
});
