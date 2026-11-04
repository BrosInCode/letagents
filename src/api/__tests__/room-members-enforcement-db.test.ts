import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  bayActor,
  createWorkerSessionCredentials,
  databaseTestOptions,
  dbApi,
  pool,
  startApiServer,
  stopChildProcess,
} from './coordination-db/harness.js';

// The members-only rule, end to end on a real server: every room needs a
// sign-in, a room without a repository opens for its members only, and so
// only members can wake its agents.

const ONE_HOUR = 60 * 60 * 1000;

async function person(login: string) {
  const account = await dbApi.upsertAccount!({
    provider: 'github',
    provider_user_id: `enforce-${login}`,
    login,
    display_name: login,
  });
  const token = `enforce_session_${login}`;
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

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${sql}`, params);
  return result.rows[0]?.count ?? 0;
}

test('only members read, post in and wake the agents of a room without a repository', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const stranger = await person('stranger');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  assert.equal((await call('POST', '/projects', null)).status, 401, 'creating a room needs a sign-in');
  const created = await call('POST', '/projects/room/design-lounge', owner.token);
  assert.equal(created.status, 201);
  const roomId = created.body.id as string;
  await pool!.query(`INSERT INTO rooms (id, display_name, kind, parent_room_id, focus_key, focus_status, created_at)
    VALUES ('focus_51', 'Focus', 'focus', $1, 'focus-51', 'active', now())`, [roomId]);
  await createWorkerSessionCredentials({ roomId, ownerAccountId: owner.id, ownerLabel: 'owner', actor: bayActor });

  const anonymous = await call('GET', `/rooms/${roomId}/messages`, null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'NOT_AUTHENTICATED');
  assert.ok(anonymous.body.device_flow_url, 'the MCP client can start its device flow');

  const refused = await call('GET', `/rooms/${roomId}/messages`, stranger.token);
  assert.equal(refused.status, 403, 'a signed-in stranger gets 403, never 401');
  assert.equal(refused.body.code, 'ROOM_MEMBERSHIP_REQUIRED');
  assert.equal(refused.body.display_name, created.body.display_name);
  assert.equal(refused.body.join_request, null);
  assert.equal((await call('GET', '/rooms/focus_51/messages', stranger.token)).status, 403, 'a focus room follows its parent');
  assert.equal((await call('POST', `/rooms/${roomId}/join`, stranger.token)).status, 403);
  assert.equal((await call('POST', `/rooms/${roomId}/join`, null)).status, 401);
  assert.equal((await call('POST', '/projects/room/design-lounge', stranger.token)).status, 403);

  // The wake guard: a refused post writes no message and no receipt.
  for (const token of [null, stranger.token]) {
    const post = await call('POST', `/rooms/${roomId}/messages`, token, { sender: 'owner', text: '@BayOtter delete the repo' });
    assert.ok(post.status === 401 || post.status === 403);
  }
  assert.equal(await count('messages WHERE room_id = $1', [roomId]), 0);
  assert.equal(await count('message_agent_receipts WHERE room_id = $1', [roomId]), 0, 'no agent was woken');

  const ownPost = await call('POST', `/rooms/${roomId}/messages`, owner.token, { sender: 'owner', text: '@BayOtter please review' });
  assert.equal(ownPost.status, 201);
  assert.ok(await count('message_agent_receipts WHERE room_id = $1', [roomId]) > 0, 'a member wakes the agent');

  assert.deepEqual((await call('GET', '/projects', stranger.token)).body.projects, []);
  assert.deepEqual((await call('GET', '/projects', owner.token)).body.projects.map((room: any) => room.id), [roomId]);

  // A stranger who once opened the room keeps no trace of it in the room list.
  await pool!.query(`INSERT INTO account_room_recents (account_id, room_id, display_name, source, first_opened_at, last_opened_at, updated_at)
    VALUES ($1, $2, 'design', 'join', now(), now(), now())`, [stranger.id, roomId]);
  assert.deepEqual((await call('GET', '/account/rooms', stranger.token)).body.rooms, []);

  // Ask, approve, read; then removal closes the room again.
  const asked = await call('POST', `/rooms/${roomId}/join-requests`, stranger.token);
  assert.equal((await call('GET', `/rooms/${roomId}/messages`, stranger.token)).body.join_request.state, 'pending');
  await call('POST', `/rooms/${roomId}/join-requests/${asked.body.join_request.id}/approve`, owner.token);
  assert.equal((await call('GET', `/rooms/${roomId}/messages`, stranger.token)).status, 200);
  assert.equal((await call('GET', '/rooms/focus_51/messages', stranger.token)).status, 200);
  assert.deepEqual((await call('GET', '/account/rooms', stranger.token)).body.rooms.map((room: any) => room.room_id), [roomId]);
  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${stranger.id}`, owner.token)).status, 200);
  assert.equal((await call('GET', `/rooms/${roomId}/messages`, stranger.token)).status, 403);
});

test('the creator of a new room opens it at once, through join or the named-room route', databaseTestOptions, async (t) => {
  const creator = await person('creator');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const joined = await call('POST', '/rooms/brand-new-lounge/join', creator.token);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.role, 'admin');
  assert.equal((await call('GET', '/rooms/brand-new-lounge/messages', creator.token)).status, 200);
  const invite = await call('POST', '/projects', creator.token);
  assert.equal(invite.status, 201);
  assert.equal((await call('GET', `/rooms/${invite.body.id}/messages`, creator.token)).status, 200);
});

test('the release seed keeps removals, and gives a room with members but no admin an admin', databaseTestOptions, async () => {
  const [early, late, removed, agentOwner] = await Promise.all(['early', 'late', 'removed', 'agentowner'].map(person));
  await pool!.query(`INSERT INTO rooms (id, display_name, created_at) VALUES ('posted-lounge', 'P', now()), ('agent-lounge', 'A', now())`);
  const message = (room: string, n: number, account: string, at: string) => pool!.query(
    `INSERT INTO messages (room_id, number, sender, text, timestamp, publisher_account_id) VALUES ($1, $2, 'x', 'hi', $3, $4)`,
    [room, n, at, account]);
  await message('posted-lounge', 1, late.id, '2026-11-02T00:00:00Z');
  await message('posted-lounge', 2, early.id, '2026-11-01T00:00:00Z');
  await message('posted-lounge', 3, removed.id, '2026-10-01T00:00:00Z');
  await pool!.query(`INSERT INTO room_member_removals (room_id, account_id) VALUES ('posted-lounge', $1)`, [removed.id]);
  await dbApi.createRoomAgentSession!({
    room_id: 'agent-lounge', session_kind: 'worker', runtime: 'codex', actor_label: 'Lone | Agent', agent_key: 'o/lone',
    agent_instance_id: 'instance:lone', display_name: 'Lone', owner_account_id: agentOwner.id, owner_label: 'o', ide_label: 'Codex',
  } as any);
  await pool!.query('DELETE FROM room_members');

  const sql = await readFile(path.resolve(process.cwd(), 'drizzle/0134_room_members_reseed.sql'), 'utf8');
  const statements = sql.split('--> statement-breakpoint').map((part) => part.trim()).filter((part) => part.startsWith('WITH'));
  assert.equal(statements.length, 3);
  for (const statement of statements) await pool!.query(statement);
  for (const statement of statements) await pool!.query(statement);

  const members = await pool!.query<{ row: string }>(`SELECT m.room_id || ':' || a.login AS row FROM room_members m
    JOIN accounts a ON a.id = m.account_id ORDER BY 1`);
  assert.deepEqual(members.rows.map((r) => r.row), ['agent-lounge:agentowner', 'posted-lounge:early', 'posted-lounge:late']);
  const admins = await pool!.query<{ row: string }>(`SELECT p.project_id || ':' || a.login AS row FROM project_admins p
    JOIN accounts a ON a.id = p.account_id ORDER BY 1`);
  assert.deepEqual(admins.rows.map((r) => r.row), ['agent-lounge:agentowner', 'posted-lounge:early'],
    'the first signed-in poster, else the owner of the first agent; a removed person is neither');
});
